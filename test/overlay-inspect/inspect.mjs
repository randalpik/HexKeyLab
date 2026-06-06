#!/usr/bin/env node
// Headless check of the HKL OBS-overlay render (?overlay). Verifies the three
// things the OBS Browser Source relies on:
//   • the lattice canvas is TRANSPARENT where there's no hex (corner alpha 0),
//   • it's actually PAINTED (center pixel opaque) — not a blank transparent canvas,
//   • UI chrome is hidden (.ctrls toolbar display:none, html.overlay set).
//
// Also writes a transparent PNG (CDP background override α=0) for eyeballing.
//
// Usage:
//   node test/overlay-inspect/inspect.mjs [--screenshot <out.png>]
// Env: HKL_URL (default http://localhost:5170/?overlay), WAIT_MS (default 1500).
// Requires: Node 22+ (native WebSocket), chromium in PATH, dev server up.
// Exits non-zero on assertion failure (usable as a gate).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.HKL_URL ?? 'http://localhost:5170/?overlay';
const waitMs = Number(process.env.WAIT_MS ?? 1500);
let screenshotPath = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) if (args[i] === '--screenshot') screenshotPath = args[++i];

const DEBUG_PORT = 9222 + Math.floor(Math.random() * 1000);
const profileDir = mkdtempSync(join(tmpdir(), 'hkl-overlay-'));
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
    try { const r = await fetch(`http://localhost:${DEBUG_PORT}/json/version`); if (r.ok) return; } catch {}
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
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  close() { try { this.ws.close(); } catch {} }
}

try {
  await waitForEndpoint();
  const cdp = new CDP(await newTab());
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  /* Transparent screenshot background so the PNG actually shows alpha. */
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await cdp.send('Page.navigate', { url });
  await new Promise((res) => {
    cdp.ws.addEventListener('message', (ev) => { if (JSON.parse(ev.data).method === 'Page.loadEventFired') res(); });
  });
  await new Promise((res) => setTimeout(res, waitMs));

  const result = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const cv = document.getElementById('cv');
      const g = cv.getContext('2d');
      /* Scan a coarse grid: an opaque #111 background fill would leave ZERO
         fully-transparent pixels; the overlay's clearRect leaves many. We also
         want some opaque pixels (the painted hexes) — a blank cleared canvas
         would be all-transparent. The semi-transparent keyboard backing shows
         up as partial-alpha pixels. */
      const img = g.getImageData(0, 0, cv.width, cv.height).data;
      let transparent = 0, opaque = 0, partial = 0, total = 0;
      const step = 8 * 4; // every 8th pixel, RGBA stride
      for (let i = 3; i < img.length; i += step) {
        const a = img[i]; total++;
        if (a === 0) transparent++;
        else if (a === 255) opaque++;
        else partial++;
      }
      const ctrls = document.querySelector('.ctrls');
      return JSON.stringify({
        transparentPx: transparent,
        opaquePx: opaque,
        partialPx: partial,
        sampledPx: total,
        toolbarHidden: ctrls ? getComputedStyle(ctrls).display === 'none' : true,
        overlayClass: document.documentElement.classList.contains('overlay'),
      });
    })()`,
    returnByValue: true,
  });
  const r = JSON.parse(result.result.value);

  if (screenshotPath) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
  }
  cdp.close();

  /* With extend off (the floating-keyboard overlay), the out-of-outline area is
     erased to transparent (destination-out), so a healthy fraction of the
     canvas is alpha-0 — an opaque #111 background fill would leave ZERO. The
     keyboard itself stays opaque (hexes + #111 seams). Assumes the mirrored
     layout has Extend pattern off; with it on the canvas is full-bleed tiling
     and this transparency check doesn't apply. */
  const transparentFrac = r.transparentPx / Math.max(1, r.sampledPx);
  const checks = [
    ['html.overlay set', r.overlayClass === true],
    ['toolbar hidden', r.toolbarHidden === true],
    ['outside-keyboard transparent (alpha-0 region exists)', transparentFrac > 0.05],
    ['keyboard painted (opaque hex pixels exist)', r.opaquePx > 0],
  ];
  let ok = true;
  for (const [name, pass] of checks) { console.log((pass ? '✓ ' : '✗ ') + name); if (!pass) ok = false; }
  console.log('\n' + JSON.stringify(r));
  if (screenshotPath) console.log('saved screenshot: ' + screenshotPath);
  cleanup(ok ? 0 : 1);
} catch (e) {
  console.error('overlay-inspect failed:', e?.message ?? e);
  cleanup(1);
}
