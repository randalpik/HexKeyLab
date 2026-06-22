#!/usr/bin/env node
// THROWAWAY spike for Phase B2 (spot-splice). Validates, against the real
// sonata in a real Verovio render, the four claims in
// docs/composer-spot-splice-design.md → "The spike":
//   1. Spacer measures reproduce the full render's inter-staff gaps (dy ≈ 0).
//   2. The clearance-argmin propper finder picks measures that actually prop.
//   3. With dy = 0, a trivial x-translate splice reproduces full-render pixels.
//   4. Edit latency = sub-render + splice is tens of ms, not seconds.
//
// Not a permanent test. Run with the umbrella dev server up (pnpm dev):
//   node test/composer-inspect/spike-b2.mjs [phase]
// where phase ∈ { probe (default), spacer, splice, latency, all }.
//
// Requires: Node 22+ (native WebSocket), chromium in PATH, sonata at
// ~/Documents/sonataBr1.musicxml.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const URL_DEFAULT = 'http://localhost:5170/composer/';
const url = process.env.COMPOSER_URL ?? URL_DEFAULT;
const SONATA = process.env.SONATA ?? join(homedir(), 'Documents', 'sonataBr1.musicxml');
const phase = process.argv[2] ?? 'probe';

const sonataXml = readFileSync(SONATA, 'utf8');

const DEBUG_PORT = 9222 + Math.floor(Math.random() * 1000);
const profileDir = mkdtempSync(join(tmpdir(), 'hkl-spike-'));

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
    this.id = 0; this.pending = new Map();
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
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { try { return JSON.stringify(await Promise.resolve(${expression})); } catch (e) { return JSON.stringify({ __error: String(e && e.stack || e) }); } })()`,
      returnByValue: true, awaitPromise: true,
    });
    const raw = result.result.type === 'string' ? result.result.value : JSON.stringify(result.result);
    const parsed = JSON.parse(raw);
    if (parsed && parsed.__error) throw new Error('in-page: ' + parsed.__error);
    return parsed;
  }
  close() { try { this.ws.close(); } catch {} }
}

/* ── in-page program (string-injected; runs in the Composer page) ──────────── */
/* This is the spike's brain. It is sent once via Runtime.evaluate to define
   window.__spike on the page, then individual phases call its methods. */
const INPAGE = readFileSync(new URL('./spike-b2-inpage.js', import.meta.url), 'utf8');

try {
  await waitForEndpoint();
  const wsUrl = await newTab();
  const cdp = new CDP(wsUrl);
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
  /* Verovio WASM + boot render. */
  await new Promise((res) => setTimeout(res, 3000));

  /* Inject the spike module + the sonata XML. */
  await cdp.send('Runtime.evaluate', {
    expression: `window.__sonataXml = ${JSON.stringify(sonataXml)}; ${INPAGE}; 'ok'`,
    returnByValue: true,
  });

  /* Import the sonata + full scroll render (heavy; let it settle). */
  console.error('importing sonata + full scroll render…');
  const setup = await cdp.eval('window.__spike.setup()');
  console.error(`  ${setup.nMeasures} measures, ${setup.nStaves} staves, ${setup.gaps} gaps`);

  const out = await cdp.eval(`window.__spike.run(${JSON.stringify(phase)})`);
  console.log(JSON.stringify(out, null, 2));

  if (process.env.SHOT) {
    await new Promise((r) => setTimeout(r, 300));
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    (await import('node:fs')).writeFileSync(process.env.SHOT, Buffer.from(shot.data, 'base64'));
    console.error('saved screenshot: ' + process.env.SHOT);
  }

  cdp.close();
  cleanup(0);
} catch (e) {
  console.error('spike failed:', e?.message ?? e);
  cleanup(1);
}
