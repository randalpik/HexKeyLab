#!/usr/bin/env node
// Verifies the orchestrator persists config + bins to localStorage and restores
// them across a reload (the Vite-HMR data-loss fix). Drives headless Chromium:
// mutate session → wait for the debounced save → reload → assert restored.
//
//   node test/orchestrator-smoke/persist-test.mjs    (dev server on :5176)

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.HKLO_URL ?? 'http://localhost:5176/orchestrator/';
const DEBUG_PORT = 9522 + Math.floor(Math.random() * 400);
const profileDir = mkdtempSync(join(tmpdir(), 'hklo-persist-'));
const chromium = spawn('chromium', ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profileDir}`, 'about:blank'], { stdio: 'pipe' });
const cleanup = (c) => { try { chromium.kill('SIGTERM'); } catch {} try { rmSync(profileDir, { recursive: true, force: true }); } catch {} process.exit(c); };
process.on('SIGINT', () => cleanup(130));

async function waitEndpoint() {
  const dl = Date.now() + 10000;
  while (Date.now() < dl) { try { const r = await fetch(`http://localhost:${DEBUG_PORT}/json/version`); if (r.ok) return; } catch {} await new Promise(r => setTimeout(r, 80)); }
  throw new Error('debug endpoint never came up');
}
class CDP {
  constructor(ws) { this.ws = new WebSocket(ws); this.id = 0; this.p = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res, { once: true }); this.ws.addEventListener('error', rej, { once: true }); });
    this.ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id != null && this.p.has(m.id)) { const { resolve, reject } = this.p.get(m.id); this.p.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.p.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
}
const evalJson = async (cdp, expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: `(async()=>{try{return JSON.stringify(await (${expr}))}catch(e){return JSON.stringify({__error:String(e)})}})()`, returnByValue: true, awaitPromise: true });
  return JSON.parse(r.result.value);
};
const load = async (cdp) => {
  await cdp.send('Page.navigate', { url });
  await new Promise(res => { const h = e => { const m = JSON.parse(e.data); if (m.method === 'Page.loadEventFired') { cdp.ws.removeEventListener('message', h); res(); } }; cdp.ws.addEventListener('message', h); });
  await new Promise(r => setTimeout(r, 400)); // let main() run
};

try {
  await waitEndpoint();
  const r = await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' });
  const cdp = new CDP((await r.json()).webSocketDebuggerUrl);
  await cdp.ready; await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

  // Load #1: clear any prior state, set a distinctive config + bins, wait for save.
  await load(cdp);
  const set = await evalJson(cdp, `(() => {
    localStorage.clear();
    window.__hklo.updateConfig({ instrumentKey: 'persist-probe', displayName: 'Persist Probe', lowMidi: 0, highMidi: 127, semitoneStride: 5 });
    window.__hklo.setBins([{lo:1,hi:8,sampleVel:4},{lo:9,hi:20,sampleVel:12},{lo:21,hi:127,sampleVel:64}]);
    return new Promise(res => setTimeout(() => res({ saved: localStorage.getItem('hkl-orchestrator-session-v1') }), 400));
  })()`);
  if (set.__error) { console.error('FAIL set: ' + set.__error); cleanup(1); }
  const savedOk = set.saved && set.saved.includes('persist-probe') && set.saved.includes('"sampleVel":12');
  console.log('after set, localStorage:', savedOk ? 'written ✓' : 'MISSING');
  if (!savedOk) { console.error('FAIL — config/bins not written to localStorage: ' + set.saved); cleanup(1); }

  // Load #2: reload the page; config + bins must come back from localStorage.
  await load(cdp);
  const restored = await evalJson(cdp, `(() => { const s = window.__hklo.getSession(); return { key: s.config.instrumentKey, lo: s.config.lowMidi, hi: s.config.highMidi, stride: s.config.semitoneStride, bins: s.bins.map(b => b.sampleVel) }; })()`);
  if (restored.__error) { console.error('FAIL restore: ' + restored.__error); cleanup(1); }
  console.log('after reload, session:', JSON.stringify(restored));
  const ok = restored.key === 'persist-probe' && restored.lo === 0 && restored.hi === 127 && restored.stride === 5
    && JSON.stringify(restored.bins) === JSON.stringify([4, 12, 64]);
  if (ok) { console.log('OK — config + bins survived reload (HMR data-loss fixed).'); cleanup(0); }
  else { console.error('FAIL — session did not restore from localStorage.'); cleanup(1); }
} catch (e) { console.error('persist-test error:', e.message); cleanup(1); }
