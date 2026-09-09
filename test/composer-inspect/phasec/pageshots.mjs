#!/usr/bin/env node
// Sonata page screenshots + an optional in-page probe (2026-09-05).
//
// Loads Composer, imports the sonata via the test hook, waits out the deferred
// render, optionally evals a probe file (async IIFE body, `window.__probeArg`
// from --arg) BEFORE the shots, then mounts each requested page and saves a
// clipped PNG of it. Prints the probe's JSON. Unlike runner.mjs --screenshot
// (one viewport capture) this hands Max — or the Read tool — one full page per
// file, so layout items that name a page ("p. 17, m. 35") can be looked at
// directly.
//
//   node test/composer-inspect/phasec/pageshots.mjs <outDir> <pages> [probe.js] [--arg <v>] [--no-sonata]
//   e.g. node test/composer-inspect/phasec/pageshots.mjs /tmp/shots 1,16,17,21
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2];
const PAGES = (process.argv[3] ?? '1').split(',').map(Number).filter((n) => n > 0);
const probeFile = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : null;
const argIdx = process.argv.indexOf('--arg');
const probeArg = argIdx >= 0 ? process.argv[argIdx + 1] : null;
const noSonata = process.argv.includes('--no-sonata');
if (!OUT) { console.error('usage: pageshots.mjs <outDir> <pages> [probe.js] [--arg v] [--no-sonata]'); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const url = process.env.COMPOSER_URL ?? 'http://localhost:5170/composer/';
const SONATA = process.env.SONATA ?? '/home/max/Documents/sonataBr1.musicxml';
const DEBUG_PORT = 9222 + Math.floor(Math.random() * 1000);
const profileDir = mkdtempSync(join(tmpdir(), 'hkl-shots-'));
const chromium = spawn('chromium', ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profileDir}`, '--window-size=1600,1200', 'about:blank'], { stdio: 'pipe' });
const cleanup = (code = 0) => { try { chromium.kill('SIGTERM'); } catch {} try { rmSync(profileDir, { recursive: true, force: true }); } catch {} process.exit(code); };
process.on('SIGINT', () => cleanup(130)); process.on('SIGTERM', () => cleanup(143));
async function waitForEndpoint() { const dl = Date.now() + 10_000; while (Date.now() < dl) { try { const r = await fetch(`http://localhost:${DEBUG_PORT}/json/version`); if (r.ok) return r.json(); } catch {} await new Promise((r) => setTimeout(r, 80)); } throw new Error('no debug endpoint'); }
async function newTab() { const r = await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' }); return (await r.json()).webSocketDebuggerUrl; }
class CDP { constructor(ws) { this.ws = new WebSocket(ws); this.id = 0; this.pending = new Map();
  this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res, { once: true }); this.ws.addEventListener('error', rej, { once: true }); });
  this.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id != null && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  close() { try { this.ws.close(); } catch {} } }
async function evalIn(cdp, expr, timeoutMs = 300_000) {
  const result = await Promise.race([cdp.send('Runtime.evaluate', { expression: `(async () => { try { return JSON.stringify(await Promise.resolve(${expr})); } catch (e) { return JSON.stringify({ __error: String(e && e.stack || e) }); } })()`, returnByValue: true, awaitPromise: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout')), timeoutMs))]);
  return result.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitIdle = async (cdp) => {
  for (let i = 0; i < 400; i++) { if (await evalIn(cdp, `(() => { const b = document.getElementById('renderBusy'); return !!document.querySelector('.score-page svg') && (!b || b.hidden); })()`) === 'true') break; await sleep(250); }
  /* …and then wait for the PARTITION to stop changing. `renderBusy` hidden is
     not settled: balanceJobActive() is false before the job is armed, and the
     sonata's partition is still 31 pages / 115 lines at t=0, reaching its final
     30 / 113 only at ~5.7 s. Screenshots taken before that are of a layout that
     is about to change. See lessons.md "Wait for the PARTITION to stop
     changing". */
  let last = null, stable = 0;
  for (let i = 0; i < 240; i++) {
    const sig = await evalIn(cdp, `(() => { const r = window.__hkl_composer.renderer, pb = r['pageBreaks'];
      const b = document.getElementById('renderBusy');
      const idle = (!b || b.hidden) && !pb.balanceJobActive() && r.extentsJobState() === null;
      return (pb['pageStartIds'] || []).join(',') + '|' + pb.lineStarts().length + '|' + idle; })()`);
    if (sig === last) { stable++; if (stable >= 16 && /\|true$/.test(String(sig))) return; }
    else { last = sig; stable = 0; }
    await sleep(250);
  }
};
try {
  await waitForEndpoint();
  const cdp = new CDP(await newTab()); await cdp.ready;
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url });
  await new Promise((res) => cdp.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Page.loadEventFired') res(); }));
  for (let i = 0; i < 200; i++) { if (await evalIn(cdp, `!!(window.__hkl_composer && window.__hkl_composer.renderer && document.querySelector('#score svg'))`) === 'true') break; await sleep(250); }
  if (!noSonata) {
    const xml = readFileSync(SONATA, 'utf8');
    await evalIn(cdp, `(window.__sonataXml = ${JSON.stringify(xml)}, true)`);
    await evalIn(cdp, `(window.__composerImportMusicXml(window.__sonataXml), true)`);
    await waitIdle(cdp);
  }
  if (probeArg !== null) await evalIn(cdp, `(window.__probeArg = ${JSON.stringify(probeArg)}, true)`);
  if (probeFile) {
    const src = readFileSync(probeFile, 'utf8');
    const out = await evalIn(cdp, `(async () => { ${src}\n })()`);
    try { console.log(JSON.stringify(JSON.parse(out), null, 2)); } catch { console.log(out); }
    await waitIdle(cdp);
  }
  /* Mount every requested page (the lazy window would evict pages far from the
     cursor) and size the viewport past one page box. */
  const dims = JSON.parse(await evalIn(cdp, `(() => {
    const r = window.__hkl_composer.renderer;
    if (typeof r.setMountWindowEnabled === 'function') r.setMountWindowEnabled(false);
    for (const n of ${JSON.stringify(PAGES)}) { try { r['mountPage'](n); } catch (e) {} }
    const svg = document.querySelector('#score .score-page > svg');
    const b = svg ? svg.getBoundingClientRect() : { width: 1600, height: 1200 };
    return { w: Math.ceil(b.width), h: Math.ceil(b.height), pages: document.querySelectorAll('#score .score-page').length };
  })()`));
  console.error(`pages: ${dims.pages}; page box ${dims.w}×${dims.h}`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: dims.w + 300, height: dims.h + 300, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  for (const n of PAGES) {
    await evalIn(cdp, `(() => { const d = document.querySelector('#score .score-page[data-page="${n}"]'); if (d) d.scrollIntoView({ block: 'start' }); return !!d; })()`);
    await sleep(500);
    const rect = JSON.parse(await evalIn(cdp, `(() => { const el = document.querySelector('#score .score-page[data-page="${n}"] > svg'); if (!el) return null; el.scrollIntoView({ block: 'start' }); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`));
    if (!rect) { console.error('page ' + n + ' not found / not mounted'); continue; }
    await sleep(200);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 } });
    writeFileSync(join(OUT, `p${n}.png`), Buffer.from(shot.data, 'base64'));
    console.error(`page ${n} → ${join(OUT, `p${n}.png`)}`);
  }
  cdp.close(); cleanup(0);
} catch (e) { console.error('probe failed:', e?.message ?? e); cleanup(1); }
