#!/usr/bin/env node
// Phase C probe runner: load composer, import the sonata via the test hook,
// wait for the (deferred) render to settle, then eval a probe file's contents
// as an async IIFE in the page and print its JSON result.
//
// Usage: node probe-runner.mjs <probe-file.js> [--no-sonata]
//                              [--arg <value>]  → window.__probeArg in the page
//                              [--screenshot <path>] → PNG of the page AFTER
//                                the probe returns (probes that rearrange
//                                #score can hand Max a real picture)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const probeFile = process.argv[2];
const noSonata = process.argv.includes('--no-sonata');
const argIdx = process.argv.indexOf('--arg');
const probeArg = argIdx >= 0 ? process.argv[argIdx + 1] : null;
const shotIdx = process.argv.indexOf('--screenshot');
const shotPath = shotIdx >= 0 ? process.argv[shotIdx + 1] : null;
const probeSrc = readFileSync(probeFile, 'utf8');
const url = process.env.COMPOSER_URL ?? 'http://localhost:5170/composer/';
const SONATA = process.env.SONATA ?? '/home/max/Documents/sonataBr1.musicxml';

const DEBUG_PORT = 9222 + Math.floor(Math.random() * 1000);
const profileDir = mkdtempSync(join(tmpdir(), 'hkl-probe-'));
const chromium = spawn('chromium', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profileDir}`,
  '--window-size=1600,1200', 'about:blank',
], { stdio: 'pipe' });
const cleanup = (code = 0) => {
  try { chromium.kill('SIGTERM'); } catch {}
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
class CDP {
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
        if (msg.error) reject(new Error(msg.error.message));
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

async function evalIn(cdp, expr, timeoutMs = 300_000) {
  const result = await Promise.race([
    cdp.send('Runtime.evaluate', {
      expression: `(async () => { try { return JSON.stringify(await Promise.resolve(${expr})); } catch (e) { return JSON.stringify({ __error: String(e && e.stack || e) }); } })()`,
      returnByValue: true, awaitPromise: true,
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout')), timeoutMs)),
  ]);
  return result.result.value;
}

try {
  await waitForEndpoint();
  const cdp = new CDP(await newTab());
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url });
  await new Promise((res) => {
    cdp.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Page.loadEventFired') res();
    });
  });
  // Wait for the app handle + first render.
  for (let i = 0; i < 200; i++) {
    const v = await evalIn(cdp, `!!(window.__hkl_composer && window.__hkl_composer.renderer && document.querySelector('#score svg'))`);
    if (v === 'true') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!noSonata) {
    const xml = readFileSync(SONATA, 'utf8');
    await evalIn(cdp, `(window.__sonataXml = ${JSON.stringify(xml)}, true)`);
    await evalIn(cdp, `(window.__composerImportMusicXml(window.__sonataXml), true)`);
    // Import triggers a deferred heavy render behind the busy badge; wait it out.
    for (let i = 0; i < 400; i++) {
      const v = await evalIn(cdp, `(() => { const b = document.getElementById('renderBusy'); return !!document.querySelector('.score-page svg') && (!b || b.hidden); })()`);
      if (v === 'true') break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (probeArg !== null) {
    await evalIn(cdp, `(window.__probeArg = ${JSON.stringify(probeArg)}, true)`);
  }
  const out = await evalIn(cdp, `(async () => { ${probeSrc}\n })()`);
  try { console.log(JSON.stringify(JSON.parse(out), null, 2)); }
  catch { console.log(out); }
  if (shotPath) {
    /* Fit the viewport to the content so an inner scroller's overflow actually
       rasterizes (see lessons.md on CDP captures inside #score). */
    const dims = JSON.parse(await evalIn(cdp, `(() => {
      const el = document.querySelector('#score');
      const r = el ? el.scrollWidth : 1600, h = el ? el.scrollHeight : 1200;
      return { w: Math.min(3000, Math.ceil(r) + 40), h: Math.min(4000, Math.ceil(h) + 40) };
    })()`));
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: dims.w, height: dims.h, deviceScaleFactor: 1, mobile: false,
    });
    await new Promise((res) => setTimeout(res, 600));
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    console.error('screenshot → ' + shotPath);
  }
  cdp.close();
  cleanup(0);
} catch (e) {
  console.error('probe failed:', e?.message ?? e);
  cleanup(1);
}
