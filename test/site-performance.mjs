import { mkdir, writeFile } from 'node:fs/promises';
import { launchBrowser } from './support/browser.mjs';
import { previewSite } from './support/site.mjs';

const site = await previewSite(), browser = await launchBrowser();
const profiles = [
  { name: 'mobile', viewport: { width: 390, height: 844 }, latency: 150, download: 200000, upload: 93750, cpu: 4 },
  { name: 'desktop', viewport: { width: 1280, height: 900 }, latency: 20, download: 2500000, upload: 625000, cpu: 1 },
];
const report = { windowMs: 10000, notes: 'Cold Chromium loads of the local static preview, with Google Fonts blocked for repeatability and a ten-second observation window, are lab measurements rather than field Core Web Vitals.', profiles: [] };
try {
  for (const profile of profiles) {
    const samples = [];
    for (let run = 0; run < 3; run++) {
      const context = await browser.newContext({ viewport: profile.viewport });
      await context.route('https://fonts.googleapis.com/**', route => route.abort());
      await context.addInitScript(() => {
        window.siteMetrics = { lcpMs: 0, cls: 0, longTaskMs: 0 };
        new PerformanceObserver(list => { for (const entry of list.getEntries()) window.siteMetrics.lcpMs = entry.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver(list => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.siteMetrics.cls += entry.value; }).observe({ type: 'layout-shift', buffered: true });
        new PerformanceObserver(list => { for (const entry of list.getEntries()) window.siteMetrics.longTaskMs += entry.duration; }).observe({ type: 'longtask', buffered: true });
      });
      const page = await context.newPage(), client = await context.newCDPSession(page);
      await client.send('Network.enable');
      await client.send('Network.setCacheDisabled', { cacheDisabled: true });
      await client.send('Network.emulateNetworkConditions', { offline: false, latency: profile.latency, downloadThroughput: profile.download, uploadThroughput: profile.upload });
      await client.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
      const requests = new Map();
      client.on('Network.requestWillBeSent', event => { requests.set(event.requestId, { url: event.request.url, bytes: 0 }); });
      client.on('Network.responseReceived', event => { const request = requests.get(event.requestId); if (request) request.length = Number(event.response.headers['Content-Length'] || event.response.headers['content-length']) || 0; });
      client.on('Network.dataReceived', event => { const request = requests.get(event.requestId); if (request) request.bytes += event.encodedDataLength; });
      client.on('Network.loadingFinished', event => { const request = requests.get(event.requestId); if (request) request.bytes = event.encodedDataLength || request.length || request.bytes; });
      await page.goto(site.origin, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(report.windowMs);
      const metrics = await page.evaluate(() => window.siteMetrics);
      const local = [...requests.values()].filter(request => request.url.startsWith(site.origin));
      const sample = { ...metrics, localRequests: local.length, receivedBytes: local.reduce((sum, request) => sum + request.bytes, 0), demoRequests: local.filter(request => /\/(?:app\.html|terminal\.html|assets\/|repo\/)/.test(new URL(request.url).pathname)).length };
      samples.push(sample);
      console.log(JSON.stringify({ profile: profile.name, run: run + 1, ...sample }));
      await context.close();
    }
    const median = key => [...samples].sort((a, b) => a[key] - b[key])[1][key];
    report.profiles.push({ ...profile, samples, median: Object.fromEntries(Object.keys(samples[0]).map(key => [key, median(key)])) });
  }
  const directory = new URL('../.test-artifacts/site/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const destination = new URL(process.env.SITE_PERFORMANCE_REPORT || 'performance.json', directory);
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  console.log('Site performance report: ' + destination.pathname);
} finally {
  await browser.close();
  await site.close();
}
