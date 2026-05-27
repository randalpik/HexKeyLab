#!/usr/bin/env node
// Headless inspection of the HKL Composer's rendered DOM.
//
// Launches Chromium with remote debugging, navigates to /composer/ (umbrella :5170) on
// the running Vite dev server, waits for Verovio to finish rendering, runs
// a JS expression in the page context, and prints the result as JSON.
//
// Usage:
//   node tools/composer-inspect/inspect.mjs '<js-expression>'
//   node tools/composer-inspect/inspect.mjs --screenshot <out.png> ['<js-expression>']
//   SCREENSHOT=<out.png> node tools/composer-inspect/inspect.mjs '<js-expression>'
//
// Modes:
//   • Eval only (no flags):     run the JS expression, print JSON to stdout.
//   • Screenshot only:          --screenshot path (omit expression to skip eval).
//   • Eval + screenshot:        --screenshot path '<expr>'  (or use SCREENSHOT env).
//
// When both eval and screenshot are requested, the eval runs first (allowing
// it to set up DOM state for the shot), then the screenshot is taken.
//
// Examples:
//   node tools/composer-inspect/inspect.mjs \
//     'Array.from(document.querySelectorAll("g.barLine")).map(e => e.getBoundingClientRect())'
//
//   node tools/composer-inspect/inspect.mjs --screenshot /tmp/composer.png
//
//   node tools/composer-inspect/inspect.mjs --screenshot /tmp/m1.png \
//     '(() => { const m = window.__hkl_composer.model; m.setCursor(0,1); m.insertRestAtCursor({duration:"4",dots:0}); return m.getCursor(1); })()'
//
// Optional env:
//   COMPOSER_URL  — default http://localhost:5170/composer/
//   WAIT_MS       — extra wait after page load for Verovio render (default 2500)
//   POST_EVAL_MS  — extra wait after the eval before screenshotting (default 250)
//   SCREENSHOT    — same as --screenshot flag
//
// Requires: Node 22+ (native WebSocket), chromium in PATH, dev server up.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_DEFAULT = 'http://localhost:5170/composer/';
const url = process.env.COMPOSER_URL ?? URL_DEFAULT;
const waitMs = Number(process.env.WAIT_MS ?? 2500);
const postEvalMs = Number(process.env.POST_EVAL_MS ?? 250);

/* Argv parsing: support --screenshot <path>, optional expression as last arg. */
let screenshotPath = process.env.SCREENSHOT ?? null;
let expr = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--screenshot') { screenshotPath = args[++i]; continue; }
  expr = args[i];
}

if (!expr && !screenshotPath) {
  console.error('Usage: inspect.mjs [--screenshot <out.png>] [<js-expression>]');
  process.exit(1);
}

const DEBUG_PORT = 9222 + Math.floor(Math.random() * 1000);
const profileDir = mkdtempSync(join(tmpdir(), 'hkl-inspect-'));

const chromium = spawn('chromium', [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-first-run',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profileDir}`,
  '--window-size=1600,1200',
  'about:blank',
], { stdio: 'pipe' });

const cleanup = (code = 0) => {
  try { chromium.kill('SIGTERM'); } catch {}
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  process.exit(code);
};
process.on('SIGINT', () => cleanup(130));
process.on('SIGTERM', () => cleanup(143));

/* Wait for the debugger HTTP endpoint to come up. */
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

/* Open a new tab and return the page-level WS URL. */
async function newTab() {
  const r = await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' });
  return (await r.json()).webSocketDebuggerUrl;
}

/* Minimal CDP client. */
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

try {
  await waitForEndpoint();
  const wsUrl = await newTab();
  const cdp = new CDP(wsUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url });
  /* Wait for load event. */
  await new Promise((res) => {
    cdp.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Page.loadEventFired') res();
    });
  });
  /* Verovio loads WASM from CDN and renders asynchronously after load. */
  await new Promise((res) => setTimeout(res, waitMs));

  /* Optional eval — run first so DOM state is set up for the screenshot. */
  let evalOutput = null;
  if (expr) {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        try { return JSON.stringify(await Promise.resolve(${expr})); }
        catch (e) { return JSON.stringify({ __error: String(e) }); }
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.result.type === 'string') {
      evalOutput = result.result.value;
    } else {
      evalOutput = JSON.stringify(result.result);
    }
  }

  /* Optional screenshot — runs after eval, so the page reflects whatever
     state the eval set up. Brief wait lets layout settle (cursor renderer
     is sync; Verovio re-renders may be async after model mutation). */
  if (screenshotPath) {
    await new Promise((res) => setTimeout(res, postEvalMs));
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
  }

  cdp.close();
  if (evalOutput !== null) {
    try { console.log(JSON.stringify(JSON.parse(evalOutput), null, 2)); }
    catch { console.log(evalOutput); }
  } else if (screenshotPath) {
    console.log('saved screenshot: ' + screenshotPath);
  }
  cleanup(0);
} catch (e) {
  console.error('inspect failed:', e?.message ?? e);
  cleanup(1);
}
