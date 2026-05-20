// Minimal Chrome DevTools Protocol client over WebSocket. Adds an event-bus
// (on(method, handler)) on top of the request/response pattern, used by
// console-capture and any other event-driven consumer.

export class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        const handlers = this.listeners.get(msg.method);
        if (handlers) for (const h of handlers) h(msg.params);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    let set = this.listeners.get(method);
    if (!set) { set = new Set(); this.listeners.set(method, set); }
    set.add(handler);
    return () => set.delete(handler);
  }

  /** Evaluate a JS expression in the page context. Wraps in an async IIFE,
   *  awaits any returned promise, and JSON-stringifies. Returns the parsed
   *  result, or { __error: string } on exception. */
  async evalJSON(expr, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => {
        try { return JSON.stringify(await Promise.resolve(${expr})); }
        catch (e) { return JSON.stringify({ __error: String(e && e.stack || e) }); }
      })()`,
      returnByValue: true,
      awaitPromise,
    });
    const raw = result.result.type === 'string'
      ? result.result.value
      : JSON.stringify(result.result);
    try { return JSON.parse(raw); }
    catch { return { __error: 'non-JSON result: ' + raw }; }
  }

  close() { try { this.ws.close(); } catch {} }
}

/** Connect to a fresh tab, navigate to URL, wait for load + extra render time.
 *  Returns the connected CDP instance. */
export async function openPage(wsUrl, url, { waitMs = 2500 } = {}) {
  const cdp = new CDP(wsUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  /* Disable HTTP caching for the entire tab lifetime. Without this, the
   * headless Chromium will honor cache headers from the Vite dev server
   * (or any intermediate) and may serve a stale JS bundle on subsequent
   * loads in the same process. */
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  const loaded = new Promise((res) => {
    const off = cdp.on('Page.loadEventFired', () => { off(); res(); });
  });
  await cdp.send('Page.navigate', { url });
  await loaded;
  /* Verovio WASM loads asynchronously after page load — give it time. */
  await new Promise((res) => setTimeout(res, waitMs));
  return cdp;
}
