#!/usr/bin/env node
// Headless browser gate for the @hexkeylab/engine React consumer.
//
// Builds the app, serves it via `vite preview`, loads it in headless Chromium,
// and asserts window.__SMOKE_RESULT.pass (set by App.tsx after it runs the
// engine against a real AudioContext). Exits non-zero on failure.
//
// Prereq — the built engine must be installed first:
//   pnpm --filter @hkl/engine build && pnpm install
// Run:
//   node test/react-consumer/run.mjs      (or: pnpm --filter @hkl/react-consumer smoke)
//
// Only ever kills PIDs it spawned (its own vite preview + chromium), on a
// randomized port — never by name.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const viteBin = join(here, 'node_modules', '.bin', 'vite');
const PORT = 4300 + Math.floor(Math.random() * 500);

function runSync(cmd, args, cwd = here) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) { console.error(`✗ ${cmd} ${args.join(' ')} failed`); process.exit(1); }
}

async function waitHttp(url, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok || r.status === 426) return; } catch {}
    await new Promise((res) => setTimeout(res, 120));
  }
  throw new Error('timed out waiting for ' + url);
}

/* Minimal CDP client (mirrors test/composer-inspect/inspect.mjs). */
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
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
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

// 1. Build the engine artifact this consumer links to (dist/), then the
//    consumer. The `link:` symlink picks up the fresh dist with no reinstall.
runSync('pnpm', ['--filter', '@hkl/engine', 'build'], repoRoot);
runSync(viteBin, ['build']);

// 2. Serve it.
const preview = spawn(viteBin, ['preview', '--port', String(PORT), '--strictPort'],
  { cwd: here, stdio: 'pipe' });
let chromium = null;
const profileDir = mkdtempSync(join(tmpdir(), 'hkl-rc-'));
const cleanup = (code) => {
  try { chromium?.kill('SIGTERM'); } catch {}
  try { preview.kill('SIGTERM'); } catch {}
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  process.exit(code);
};
process.on('SIGINT', () => cleanup(130));
process.on('SIGTERM', () => cleanup(143));

try {
  const base = `http://localhost:${PORT}/`;
  await waitHttp(base, 15000);

  const DEBUG = 9300 + Math.floor(Math.random() * 500);
  chromium = spawn('chromium', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: 'pipe' });
  await waitHttp(`http://localhost:${DEBUG}/json/version`, 10000);

  const tab = await (await fetch(`http://localhost:${DEBUG}/json/new?about:blank`, { method: 'PUT' })).json();
  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: base });
  await new Promise((res) => cdp.ws.addEventListener('message', (ev) => {
    if (JSON.parse(ev.data).method === 'Page.loadEventFired') res();
  }));

  // Poll for the async smoke result.
  let result = null;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__SMOKE_RESULT ?? null)', returnByValue: true,
    });
    if (r.result.value && r.result.value !== 'null') { result = JSON.parse(r.result.value); break; }
    await new Promise((res) => setTimeout(res, 200));
  }
  cdp.close();

  if (!result) { console.error('✗ no __SMOKE_RESULT within timeout'); cleanup(1); }
  for (const s of result.steps) {
    console.log(`${s.ok ? '✓' : '✗'} ${s.label}${s.detail ? ` — ${s.detail}` : ''}`);
  }
  if (result.error) console.error('error:', result.error);
  console.log(result.pass
    ? '\nPASS — @hexkeylab/engine runs in a React app against a real AudioContext.'
    : '\nFAIL');
  cleanup(result.pass ? 0 : 1);
} catch (e) {
  console.error('runner failed:', e?.message ?? e);
  cleanup(1);
}
