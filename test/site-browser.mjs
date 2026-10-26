import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { launchBrowser } from './support/browser.mjs';
import { previewSite } from './support/site.mjs';
import { normalizeSiteUrl } from '../site/urls.ts';

const root = new URL('../', import.meta.url).pathname;
const site = await previewSite(), { origin } = site;
let browser;
try {
  browser = await launchBrowser();
  await mkdir(root + '.test-artifacts/site', { recursive: true });
  const publicSite = normalizeSiteUrl(process.env.LIBERTTY_SITE_URL || 'https://libertty.sh/');
  const metadataContext = await browser.newContext();
  await metadataContext.route('https://fonts.googleapis.com/**', route => route.abort());
  const metadataPage = await metadataContext.newPage(), canonicals = [];
  for (const route of ['', 'setup/', 'usage/', 'herdr/', 'reference/']) {
    const response = await metadataPage.goto(origin + '/' + route);
    assert.equal(response.status(), 200);
    const canonical = new URL(route, publicSite).href;
    canonicals.push(canonical);
    assert.equal(await metadataPage.locator('link[rel=canonical]').getAttribute('href'), canonical);
    assert.equal(await metadataPage.locator('meta[property="og:url"]').getAttribute('content'), canonical);
    assert.equal(await metadataPage.locator('meta[property="og:image"]').getAttribute('content'), new URL('social.png', publicSite).href);
    assert.equal(await metadataPage.locator('meta[property="og:image:width"]').getAttribute('content'), '1200');
    assert.equal(await metadataPage.locator('meta[property="og:image:height"]').getAttribute('content'), '630');
    assert.ok(await metadataPage.locator('meta[name=description]').getAttribute('content'));
    assert.equal((await metadataPage.title()).match(/\blibertty\b/gi)?.length, 1);
    assert.equal(await metadataPage.locator('meta[name=robots][content*=noindex]').count(), 0);
    if (!route) {
      const schema = JSON.parse(await metadataPage.locator('script[type="application/ld+json"]').textContent());
      assert.equal(schema['@context'], 'https://schema.org');
      assert.equal(schema['@type'], 'SoftwareApplication');
      assert.equal(schema.url, canonical);
      assert.equal(schema.image, new URL('social.png', publicSite).href);
      assert.deepEqual(schema.operatingSystem, ['Linux', 'macOS']);
      assert.equal(schema.offers.price, 0);
      assert.equal(schema.offers.priceCurrency, 'USD');
    }
  }
  const sitemap = await (await fetch(origin + '/sitemap.xml')).text();
  const locations = await metadataPage.evaluate(xml => {
    const document = new DOMParser().parseFromString(xml, 'application/xml');
    if (document.querySelector('parsererror')) throw new Error('Invalid sitemap XML');
    return [...document.querySelectorAll('loc')].map(el => el.textContent);
  }, sitemap);
  assert.deepEqual(locations, canonicals);
  const robots = await (await fetch(origin + '/robots.txt')).text();
  assert.ok(robots.includes('Sitemap: ' + new URL('sitemap.xml', publicSite).href));
  assert.ok(robots.includes('Disallow: ' + new URL(publicSite).pathname + 'repo/'));
  for (const route of ['app.html', 'terminal.html']) {
    const html = await (await fetch(origin + '/' + route)).text();
    assert.match(html, /<meta name="robots" content="noindex">/);
  }
  const social = await readFile(root + 'dist-site/social.png');
  assert.equal(social.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(social.readUInt32BE(16), 1200);
  assert.equal(social.readUInt32BE(20), 630);
  await metadataContext.close();
  for (const width of [320, 390, 760, 1280]) {
    const mobile = width <= 760;
    const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
    await context.route('https://fonts.googleapis.com/**', route => route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#app').getAttribute('src'), null, 'Reading the landing page does not load the demo');
    assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => /\/(?:app\.html|assets\/|repo\/)/.test(new URL(entry.name).pathname))), false, 'The landing page does not request demo assets');
    assert.equal(await page.locator('html').evaluate(el => el.classList.contains('in-app')), false);
    for (const selector of ['#features-title', '#steps-title', '#platforms-title', '#docs-title', 'footer']) {
      await page.locator(selector).scrollIntoViewIfNeeded();
      assert.equal(await page.locator(selector).isVisible(), true, `${selector} is accessible at ${width}px`);
      assert.equal(await page.locator('html').evaluate(el => el.classList.contains('in-app')), false, 'Reading does not enter the demo');
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No horizontal page overflow at ${width}px`);
    await page.goto(origin + '/#platforms');
    await page.locator('#platforms-title').waitFor({ state: 'visible' });
    assert.ok(await page.locator('#platforms').evaluate(el => Math.abs(el.getBoundingClientRect().top) < 2), 'Section deep links land on the content');
    await page.goto(origin);
    if (mobile) await page.waitForFunction(() => document.querySelector('#demo').getBoundingClientRect().top >= innerHeight);
    await page.screenshot({ path: root + `.test-artifacts/site/landing-${width}.png` });
    if (mobile) {
      await page.locator('#cue').click();
      await page.waitForFunction(() => document.documentElement.classList.contains('in-app'));
      assert.equal(new URL(page.url()).hash, '#demo');
      assert.equal(await page.locator('#app').evaluate(el => el.inert), false);
      assert.equal(await page.locator('#app').getAttribute('src'), 'app.html');
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true);
      await page.goBack();
      await page.waitForFunction(() => !document.documentElement.classList.contains('in-app'));
      assert.equal(await page.locator('#app').evaluate(el => el.inert), true);
      assert.equal(await page.locator('#features-title').isVisible(), true);
      await page.goto(origin + '/#demo');
      await page.waitForFunction(() => document.documentElement.classList.contains('in-app'));
    } else {
      await page.locator('#start-demo').click();
      assert.equal(await page.locator('#app').getAttribute('src'), 'app.html');
      assert.equal(await page.locator('#app').evaluate(el => el.inert), false);
      assert.equal(await page.locator('#start-demo').isVisible(), false);
      await page.goto(origin + '/setup/');
      await page.getByRole('link', { name: 'Try the demo', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#app').getAttribute('src') === 'app.html');
    }
    assert.deepEqual(errors, [], `No browser errors at ${width}px`);
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(origin);
  assert.equal(await page.locator('#platforms-title').isVisible(), true, 'Product content is available without JavaScript');
  assert.equal(await page.locator('#docs-title').isVisible(), true, 'Documentation is available without JavaScript');
  await context.close();
  console.log('PASS: Page metadata, JSON-LD, sitemap, robots, preview image, mobile and desktop content, demo entry, Back and static HTML.');
} finally {
  await browser?.close();
  await site.close();
}
