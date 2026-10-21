#!/usr/bin/env node
// Sonata probe runner: load Composer in headless Chromium (or Firefox), load
// the sonata via the test hook, wait for the (deferred) render to settle, then
// eval a probe file's contents as an async IIFE in the page and print its JSON
// result.
//
// Usage: node run-probe.mjs <probe-file.js> [--no-sonata] [--firefox]
//                              [--firefox] → headless Firefox (Max's browser)
//                                over its built-in WebDriver BiDi agent, own
//                                profile; Chromium under-reports Firefox
//                                layout costs, so timings come from here
//                             [--window WxH] → browser window (default 1600x1200)
//                              [--arg <value>]  → window.__probeArg in the page
//                              [--screenshot <path>] → PNG of the page AFTER
//                                the probe returns (probes that rearrange
//                                #score can hand Max a real picture)
//                             [--console]  → console errors/warnings and
//                               uncaught exceptions from load through the
//                               probe, de-duplicated, on stderr
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const probeFile = process.argv[2];
const noSonata = process.argv.includes('--no-sonata');
const captureConsole = process.argv.includes('--console');
const argIdx = process.argv.indexOf('--arg');
const probeArg = argIdx >= 0 ? process.argv[argIdx + 1] : null;
const shotIdx = process.argv.indexOf('--screenshot');
const shotPath = shotIdx >= 0 ? process.argv[shotIdx + 1] : null;
const useFirefox = process.argv.includes('--firefox');
/* --window WxH: the browser window (default 1600x1200). A window narrower than
   the page card scrolls horizontally — in Firefox by fractional pixels, which
   moves the device phase the crisp right-edge snap lands on (2026-10-20). */
const winIdx = process.argv.indexOf('--window');
const [WIN_W, WIN_H] = (winIdx >= 0 ? process.argv[winIdx + 1] : '1600x1200').split('x').map(Number);
const probeSrc = readFileSync(probeFile, 'utf8');
const url = process.env.COMPOSER_URL ?? 'http://localhost:5170/composer/';
const SONATA = process.env.SONATA ?? '/home/max/Documents/sonata.hkc';   // Max's working copy (2026-09-30); SONATA=…musicxml imports instead

const DEBUG_PORT = (useFirefox ? 9500 : 9222) + Math.floor(Math.random() * 400);
const profileDir = mkdtempSync(join(tmpdir(), 'hkl-probe-'));
const browser = useFirefox
  ? spawn('firefox', ['--headless', '--no-remote', '--new-instance', '--profile', profileDir,
      `--window-size=${WIN_W},${WIN_H}`, `--remote-debugging-port=${DEBUG_PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn('chromium', [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profileDir}`,
      `--window-size=${WIN_W},${WIN_H}`, 'about:blank',
    ], { stdio: 'pipe' });
const cleanup = (code = 0) => {
  try { browser.kill('SIGTERM'); } catch {}    // only the browser this runner spawned
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  process.exit(code);
};
process.on('SIGINT', () => cleanup(130));
process.on('SIGTERM', () => cleanup(143));

async function waitForEndpoint() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${DEBUG_PORT}/json/version`);
      if (r.ok) return r.json();
    } catch {}
    await new Promise((res) => setTimeout(res, 80));
  }
  throw new Error('Chromium debug endpoint never came up');
}
async function newTab() {
  const r = await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' });
  return (await r.json()).webSocketDebuggerUrl;
}
/* One JSON-RPC socket: CDP replies carry `error`, BiDi replies `type: 'error'`. */
class RPC {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(typeof msg.error === 'string' ? msg.error + ': ' + (msg.message ?? '') : msg.error.message));
        else resolve(msg.result);
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
  close() { try { this.ws.close(); } catch {} }
}

const wrap = (expr) => `(async () => { try { return JSON.stringify(await Promise.resolve(${expr})); } catch (e) { return JSON.stringify({ __error: String(e && e.stack || e) }); } })()`;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout')), ms))]);

/* The driver the probe flow below uses: navigate, eval (a JSON string back),
   console capture, full-content screenshot, close. */
async function chromiumDriver() {
  await waitForEndpoint();
  const cdp = new RPC(await newTab());
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const consoleMsgs = [];
  cdp.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      consoleMsgs.push(`${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      consoleMsgs.push('exception: ' + String(d.exception?.description ?? d.text).split('\n')[0].slice(0, 300));
    }
  });
  return {
    consoleMsgs,
    async navigate(u) {
      const loaded = new Promise((res) => cdp.ws.addEventListener('message', (ev) => { if (JSON.parse(ev.data).method === 'Page.loadEventFired') res(); }));
      await cdp.send('Page.navigate', { url: u });
      await loaded;
    },
    async evalIn(expr, timeoutMs = 300_000) {
      const r = await withTimeout(cdp.send('Runtime.evaluate', { expression: wrap(expr), returnByValue: true, awaitPromise: true }), timeoutMs);
      return r.result.value;
    },
    async screenshot(w, h) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await new Promise((res) => setTimeout(res, 600));
      return (await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data;
    },
    close() { cdp.close(); },
  };
}

async function firefoxDriver() {
  /* The BiDi endpoint is announced on stderr, not via /json/version. */
  const base = await Promise.race([
    new Promise((res) => browser.stderr.on('data', (d) => { const m = String(d).match(/WebDriver BiDi listening on (ws:\/\/\S+)/); if (m) res(m[1]); })),
    new Promise((res) => setTimeout(() => res(null), 20_000)),
  ]);
  if (!base) throw new Error('Firefox never announced a BiDi endpoint');
  const bidi = new RPC(base + '/session');
  await bidi.ready;
  const consoleMsgs = [];
  bidi.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type !== 'event' || m.method !== 'log.entryAdded') return;
    const e = m.params;
    if (e.type === 'javascript') consoleMsgs.push('exception: ' + String(e.text ?? '').split('\n')[0].slice(0, 300));
    else if (e.level === 'error' || e.level === 'warn') consoleMsgs.push(`${e.level === 'warn' ? 'warning' : 'error'}: ` + String(e.text ?? '').slice(0, 300));
  });
  await bidi.send('session.new', { capabilities: {} });
  const ctx = (await bidi.send('browsingContext.getTree', {})).contexts[0].context;
  await bidi.send('session.subscribe', { events: ['log.entryAdded'] });
  /* No browsingContext.setViewport: Firefox 158 refuses it without
     -remote-allow-system-access, which this runner does not ask for; the
     window size is set at launch instead. */
  return {
    consoleMsgs,
    async navigate(u) { await bidi.send('browsingContext.navigate', { context: ctx, url: u, wait: 'complete' }); },
    async evalIn(expr, timeoutMs = 300_000) {
      const r = await withTimeout(bidi.send('script.evaluate', { expression: wrap(expr), target: { context: ctx }, awaitPromise: true }), timeoutMs);
      if (r.type === 'exception') return JSON.stringify({ __error: String(r.exceptionDetails?.text ?? 'exception') });
      return r.result?.value;
    },
    async screenshot() {
      /* Let #score grow to its content and capture the whole document (the
         viewport cannot be resized without system access, see above). */
      await this.evalIn(`(() => { const el = document.querySelector('#score'); if (el) { el.dataset.shotStyle = el.getAttribute('style') ?? ''; el.style.height = 'auto'; el.style.maxHeight = 'none'; el.style.overflow = 'visible'; } return true; })()`);
      await new Promise((res) => setTimeout(res, 600));
      const data = (await bidi.send('browsingContext.captureScreenshot', { context: ctx, origin: 'document' })).data;
      await this.evalIn(`(() => { const el = document.querySelector('#score'); if (el) el.setAttribute('style', el.dataset.shotStyle ?? ''); return true; })()`);
      return data;
    },
    close() { bidi.close(); },
  };
}

try {
  const drv = useFirefox ? await firefoxDriver() : await chromiumDriver();
  const evalIn = (expr, timeoutMs) => drv.evalIn(expr, timeoutMs);
  await drv.navigate(url);
  // Wait for the app handle + first render.
  for (let i = 0; i < 200; i++) {
    const v = await evalIn(`!!(window.__hkl_composer && window.__hkl_composer.renderer && document.querySelector('#score svg'))`);
    if (v === 'true') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!noSonata) {
    /* A MusicXML file goes in as BYTES through the app's own decoder
       (__composerImportMusicXmlBytes → xmlText.ts), so UTF-16 and declared
       encodings import exactly as the file input imports them. The import's
       result is checked: a throw inside the eval used to vanish, leaving the
       default document to be probed as if it were the score. */
    let imp;
    if (SONATA.endsWith('.hkc')) {
      await evalIn(`(window.__sonataXml = ${JSON.stringify(readFileSync(SONATA, 'utf8'))}, true)`);
      imp = await evalIn(`(window.__composerLoadHkc(window.__sonataXml), true)`);
    } else {
      await evalIn(`(window.__sonataB64 = ${JSON.stringify(readFileSync(SONATA).toString('base64'))}, true)`);
      imp = await evalIn(`(window.__composerImportMusicXmlBytes(Uint8Array.from(atob(window.__sonataB64), (ch) => ch.charCodeAt(0))), true)`);
    }
    try { const r = JSON.parse(imp); if (r && r.__error) console.error('import failed: ' + String(r.__error).split('\n').slice(0, 4).join(' | ')); } catch {}
    const status = await evalIn(`document.getElementById('composerStatus')?.textContent ?? ''`);
    try { console.error('status: ' + JSON.parse(status)); } catch {}
    // Import triggers a deferred heavy render behind the busy badge; wait it out.
    for (let i = 0; i < 400; i++) {
      const v = await evalIn(`(() => { const b = document.getElementById('renderBusy'); return !!document.querySelector('.score-page svg') && (!b || b.hidden); })()`);
      if (v === 'true') break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (probeArg !== null) {
    await evalIn(`(window.__probeArg = ${JSON.stringify(probeArg)}, true)`);
  }
  const out = await evalIn(`(async () => { ${probeSrc}\n })()`);
  try { console.log(JSON.stringify(JSON.parse(out), null, 2)); }
  catch { console.log(out); }
  if (shotPath) {
    /* Fit the viewport to the content so an inner scroller's overflow actually
       rasterizes (see lessons.md on CDP captures inside #score). */
    const dims = JSON.parse(await evalIn(`(() => {
      const el = document.querySelector('#score');
      const r = el ? el.scrollWidth : 1600, h = el ? el.scrollHeight : 1200;
      return { w: Math.min(3000, Math.ceil(r) + 40), h: Math.min(4000, Math.ceil(h) + 40) };
    })()`));
    writeFileSync(shotPath, Buffer.from(await drv.screenshot(dims.w, dims.h), 'base64'));
    console.error('screenshot → ' + shotPath);
  }
  if (captureConsole) {
    const consoleMsgs = drv.consoleMsgs;
    const counts = new Map(); for (const m of consoleMsgs) counts.set(m, (counts.get(m) ?? 0) + 1);
    console.error(`console: ${consoleMsgs.filter((m) => m.startsWith('error')).length} errors, ${consoleMsgs.filter((m) => m.startsWith('warning')).length} warnings, ${consoleMsgs.filter((m) => m.startsWith('exception')).length} exceptions`);
    for (const [m, n] of counts) console.error(`  ${n}× ${m}`);
  }
  drv.close();
  cleanup(0);
} catch (e) {
  console.error('probe failed:', e?.message ?? e);
  cleanup(1);
}
