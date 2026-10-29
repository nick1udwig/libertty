import type { Notify } from './notice-model.ts';
interface Backend { id: string; name: string }
type API = <T>(id: string, name: string, data?: unknown) => Promise<T>;
const installed = () => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const decodeKey = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
const storageKey = (id: string) => 'libertty.notifications.' + id;

/** Permission is requested only from the enable button in the installed PWA. */
export class HerdrNotifications {
  private api: API;
  private changed: () => void;
  private devices = new Map<string, string>();
  private restoring = new Map<string, Promise<void>>();
  private registrations = new Map<string, ServiceWorkerRegistration>();
  private closedViews = new Set<string>();
  constructor(api: API, changed: () => void) { this.api = api; this.changed = changed; }
  get supported() { return isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  get installed() { return installed(); }
  device(id: string) { return this.devices.get(id); }
  private saved(id: string) { try { return localStorage.getItem(storageKey(id)); } catch { return null; } }
  private async registration(id: string) {
    if (this.registrations.has(id)) return this.registrations.get(id)!;
    const registration = await navigator.serviceWorker.register(new URL('push-sw.js', document.baseURI), { scope: new URL('notifications/' + encodeURIComponent(id) + '/', document.baseURI).pathname });
    const worker = registration.installing || registration.waiting;
    if (!registration.active && worker) await new Promise<void>((resolve, reject) => {
      const state = () => { if (worker.state === 'activated') { worker.removeEventListener('statechange', state); resolve(); } else if (worker.state === 'redundant') { worker.removeEventListener('statechange', state); reject(new Error('Notification worker could not start.')); } };
      worker.addEventListener('statechange', state); state();
    });
    this.registrations.set(id, registration); return registration;
  }
  private async subscribe(id: string) {
    const registration = await this.registration(id);
    const { publicKey } = await this.api<{ publicKey: string }>(id, 'api/notifications/key');
    let subscription = await registration.pushManager.getSubscription();
    const key = decodeKey(publicKey);
    if (subscription?.options.applicationServerKey && Array.from(new Uint8Array(subscription.options.applicationServerKey)).join() !== Array.from(key).join()) { await subscription.unsubscribe(); subscription = null; }
    subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const { device } = await this.api<{ device: string }>(id, 'api/notifications/subscribe', { subscription: subscription.toJSON() });
    this.devices.set(id, device); localStorage.setItem(storageKey(id), device); this.changed();
  }
  restore(id: string) {
    if (this.devices.has(id)) return Promise.resolve();
    if (!this.supported || Notification.permission !== 'granted' || !this.saved(id)) return Promise.resolve();
    let work = this.restoring.get(id);
    if (!work) { work = this.subscribe(id).finally(() => this.restoring.delete(id)); this.restoring.set(id, work); }
    return work;
  }
  async enable(id: string) {
    if (!this.supported) throw new Error('This browser does not support background notifications.');
    if (!installed()) throw new Error('Open the installed libertty app to enable notifications.');
    // Keep the permission call directly within the button's user gesture.
    if (await Notification.requestPermission() !== 'granted') throw new Error('Allow notifications in the app or device settings, then try again.');
    await this.subscribe(id);
  }
  async disable(id: string) {
    const device = this.devices.get(id) || this.saved(id);
    if (device) await this.api(id, 'api/notifications/unsubscribe', { device }).catch((error: any) => { if (error.status !== 400) throw error; });
    const registration = await this.registration(id); await (await registration.pushManager.getSubscription())?.unsubscribe();
    this.devices.delete(id); localStorage.removeItem(storageKey(id)); this.changed();
  }
  async forgetBackend(id: string) { if (this.device(id) || this.saved(id)) await this.disable(id); }
  async watch(id: string, tabId: string, session: string, source?: string) {
    if (this.closedViews.has(tabId)) return;
    await this.restore(id); const device = this.device(id); if (!device || this.closedViews.has(tabId)) return;
    await this.api(id, 'api/herdr/notifications?' + new URLSearchParams({ herdrSession: session, ...(source ? { herdrSource: source } : {}) }), { device, tabId });
  }
  async unwatch(id: string, tabId: string) {
    this.closedViews.add(tabId);
    if (this.closedViews.size > 1024) this.closedViews.delete(this.closedViews.values().next().value!);
    const device = this.device(id) || this.saved(id);
    try { if (device) await this.api(id, 'api/notifications/unwatch', { device, tabId }).catch((error: any) => { if (error.status !== 400) throw error; }); }
    catch (error) { this.closedViews.delete(tabId); throw error; }
  }
  render(element: HTMLElement, backends: Backend[], notice: Notify) {
    element.replaceChildren();
    const hint = document.createElement('p'); hint.className = 'hint';
    hint.textContent = !this.supported ? 'Background notifications need HTTPS and a browser with Web Push.'
      : !installed() ? 'Install libertty and open it from your home screen to enable background alerts.'
      : 'When libertty is in the background, alert when agents finish or need attention. ' +
        'Vibration follows your device settings.';
    element.append(hint);
    if (!this.supported) return;
    for (const backend of backends) {
      const button = document.createElement('button'); const enabled = !!(this.device(backend.id) || this.saved(backend.id));
      button.type = 'button'; button.textContent = (enabled ? 'Disable' : 'Enable') + ' notifications · ' + backend.name; button.disabled = !enabled && !installed();
      button.onclick = async () => {
        button.disabled = true;
        try { await (enabled ? this.disable(backend.id) : this.enable(backend.id)); notice(enabled ? 'Notifications disabled.' : 'Background notifications enabled.', 'done'); }
        catch (error: any) { notice(error.message); }
        finally { this.render(element, backends, notice); }
      };
      element.append(button);
    }
  }
}
