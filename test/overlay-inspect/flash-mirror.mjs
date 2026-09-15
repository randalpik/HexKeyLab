#!/usr/bin/env node
// Proves the re-strike blink reaches the OBS overlay, end to end and VISUALLY.
//
// The blink is a modifier on the lit-key set, not a change to it (a re-struck
// key stays in selection.selectedKeys throughout), so it travels as its own
// `flash` message rather than as a `keys` delta. That makes it exactly the kind
// of thing a model-state assertion would pass while the pixels did nothing —
// which is how it went unnoticed in the first place. So this samples the actual
// canvas, per frame, and asserts the lattice changes and then changes back.
//
// Isolated by construction: spawns its OWN overlay-host on a throwaway port
// (HKL_OVERLAY_PORT) and its own Chromium. Never touches :5190 or :5170, and so
// never overwrites the retained state a live OBS source is reading.
//
// Requires a built overlay bundle (`pnpm overlay:dist`) — it tests what ships,
// not the dev sources.
//
//   node test/overlay-inspect/flash-mirror.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const EMBEDDED = join(ROOT, 'apps/overlay-host/embedded/index.html');
const HOST_PORT = 5600 + Math.floor(Math.random() * 300);
const DEBUG_PORT = 9600 + Math.floor(Math.random() * 300);
const FLASH_MS = 60; /* render/key-flash.ts KEY_FLASH_MS */

if (!existsSync(EMBEDDED)) {
  console.error(`no overlay build at ${EMBEDDED} — run: pnpm overlay:dist`);
  process.exit(1);
}

const profileDir = mkdtempSync(join(tmpdir(), 'hkl-flash-'));
const procs = [];
let exiting = false;
function cleanup(code) {
  if (exiting) return; exiting = true;
  /* Only PIDs this script spawned. */
  for (const p of procs) { try { p.kill('SIGTERM'); } catch {} }
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  process.exit(code);
}
process.on('SIGINT', () => cleanup(130));
const fail = (m) => { console.error(`✗ ${m}`); cleanup(1); };

const waitFor = async (fn, ms, what) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (await fn()) return true; } catch {}
    await new Promise((r) => setTimeout(r, 80));
  }
  fail(`timed out waiting for ${what}`);
};

class CDP {
  constructor(u) {
    this.ws = new WebSocket(u); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id != null && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
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
}
const evaluate = async (cdp, expr) => {
  const r = await cdp.send('Runtime.evaluate', {
    expression: `(async () => { try { return JSON.stringify(await Promise.resolve(${expr})); }
                 catch (e) { return JSON.stringify({ __error: String(e) }); } })()`,
    returnByValue: true, awaitPromise: true,
  });
  const v = JSON.parse(r.result.value);
  if (v && v.__error) fail(`page eval: ${v.__error}`);
  return v;
};

const SNAPSHOT = {
  tuning: '5', heji: false, refQ: 0, refR: 0,
  outline: 'lumatone', rotation: 'lumatone', hexSize: 'medium',
  showNotes: true, showBands: true, extendPattern: true,
  composerView: false, staffDark: false,
  kbAnchorQ: 0, kbAnchorR: 0, kbOffY: 0, viewQ: 0, viewR: 0,
  litKeys: ['0,0', '1,1'],
};

try {
  /* 1. Our own overlay host (serves the built overlay AND hosts the relay). */
  const host = spawn(process.execPath, [join(ROOT, 'apps/overlay-host/src/server.mjs')],
    { env: { ...process.env, HKL_OVERLAY_PORT: String(HOST_PORT) }, stdio: 'pipe' });
  procs.push(host);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${HOST_PORT}/`)).ok, 10000, 'overlay host');

  /* 2. Our own Chromium, loading the overlay the host itself serves (so it
        dials the same-origin relay on our throwaway port, not 5190). */
  const chromium = spawn('chromium', ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--no-first-run', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profileDir}`,
    '--window-size=1400,900', 'about:blank'], { stdio: 'pipe' });
  procs.push(chromium);
  await waitFor(async () => (await fetch(`http://localhost:${DEBUG_PORT}/json/version`)).ok, 10000, 'chromium');
  const tab = await (await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const cdp = new CDP(tab.webSocketDebuggerUrl); await cdp.ready;
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${HOST_PORT}/?overlay` });
  await new Promise((res) => cdp.ws.addEventListener('message', (ev) => {
    if (JSON.parse(ev.data).method === 'Page.loadEventFired') res();
  }));
  await new Promise((r) => setTimeout(r, 800));

  /* 3. Publish a lattice with two lit keys and let it paint. */
  const pub = new WebSocket(`ws://127.0.0.1:${HOST_PORT}/overlay-ws`);
  await new Promise((res, rej) => {
    pub.addEventListener('open', res, { once: true });
    pub.addEventListener('error', rej, { once: true });
  });
  pub.send(JSON.stringify({ t: 'snapshot', data: SNAPSHOT }));
  await new Promise((r) => setTimeout(r, 600));

  const lit = await evaluate(cdp, `document.getElementById('cv').toDataURL().length`);
  if (!lit) fail('overlay canvas produced nothing');

  /* 4. Sample the canvas every frame across the flash. toDataURL is an exact
        pixel signature — no coordinate knowledge needed, and a blink that only
        moved model state would show an unbroken run of identical frames. */
  await evaluate(cdp, `(() => {
    const cv = document.getElementById('cv');
    window.__s = [];
    window.__go = true;
    (function loop() {
      if (!window.__go) return;
      window.__s.push([performance.now(), cv.toDataURL()]);
      requestAnimationFrame(loop);
    })();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 120));
  const t0 = await evaluate(cdp, `performance.now()`);
  pub.send(JSON.stringify({ t: 'flash', keys: ['0,0'] }));
  await new Promise((r) => setTimeout(r, 400));

  const res = await evaluate(cdp, `(() => {
    window.__go = false;
    const s = window.__s;
    const base = s[0][1];
    const diff = s.map(([t, d]) => [t, d !== base]);
    const changed = diff.filter(([, c]) => c);
    return {
      frames: s.length,
      changedFrames: changed.length,
      firstChangeAt: changed.length ? changed[0][0] : null,
      lastChangeAt: changed.length ? changed[changed.length - 1][0] : null,
      restored: s[s.length - 1][1] === base,
      distinctStates: new Set(s.map(([, d]) => d)).size,
    };
  })()`);

  /* 5. Assertions. */
  if (res.frames < 10) fail(`only ${res.frames} frames sampled — page not animating`);
  if (res.changedFrames === 0) {
    fail('canvas NEVER changed after the flash message — the blink did not reach the overlay');
  }
  if (!res.restored) fail('canvas did not return to the lit state after the flash expired');
  if (res.distinctStates < 2) fail(`only ${res.distinctStates} distinct canvas state(s) — no blink`);

  const dur = res.lastChangeAt - res.firstChangeAt;
  const latency = res.firstChangeAt - t0;
  /* Generous: one frame of rAF granularity at each end, plus relay hop. */
  if (dur > FLASH_MS * 3) fail(`blink lasted ${dur.toFixed(0)}ms, expected ~${FLASH_MS}ms`);

  console.log(`✓ blink mirrored: ${res.changedFrames}/${res.frames} frames differ, ` +
              `~${dur.toFixed(0)}ms long (expected ~${FLASH_MS}ms), ` +
              `${latency.toFixed(0)}ms after publish, canvas restored`);
  console.log('✓ flash-mirror OK');
  cleanup(0);
} catch (e) {
  fail(String(e && e.stack ? e.stack : e));
}
