#!/usr/bin/env node
// Environment sweep (2026-09-08): the SAME document rendered under different
// browser-environment knobs, reporting each run's settled page partition.
//
// Written because Max's browsers and the headless harness settle on different
// partitions from the same .hkc, same Verovio (6.3.0-425dd7b), same 100 % page
// size, with page 1 identical — so the cause is in how the browser is run, not
// in the score. Knobs swept: device scale factor (DPR), window size, and
// headless mode. Anything that changes the partition is a cause.
//
//   node test/composer-inspect/phasec/envsweep.mjs            # default matrix
//   node test/composer-inspect/phasec/envsweep.mjs --dpr 1,2 --win 1600x1200,2560x1440
//   node test/composer-inspect/phasec/envsweep.mjs --headed    # real window (needs DISPLAY)
//
// Prints one line per config: pages, systems, and the mvt-IV tail of the
// partition, plus a diff against --expect if given.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const optOf = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const DPRS = optOf('--dpr', '1').split(',');
const WINS = optOf('--win', '1600x1200').split(',');
const MODES = args.includes('--headed') ? ['headed'] : optOf('--mode', 'new').split(',');
const SONATA = process.env.SONATA ?? '/home/max/Documents/sonataBr1.musicxml';
const URL_ = process.env.COMPOSER_URL ?? 'http://localhost:5170/composer/';
const xml = readFileSync(SONATA, 'utf8');

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res, { once: true }); this.ws.addEventListener('error', rej, { once: true }); });
    this.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
      if (m.id != null && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } });
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  close() { try { this.ws.close(); } catch {} }
}
const evalIn = async (cdp, expr, ms = 300000) => {
  const r = await Promise.race([
    cdp.send('Runtime.evaluate', { expression: `(async () => { try { return JSON.stringify(await Promise.resolve(${expr})); } catch (e) { return JSON.stringify({ __error: String(e && e.stack || e) }); } })()`, returnByValue: true, awaitPromise: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout')), ms)),
  ]);
  return r.result.value;
};

/* Settle on the PARTITION, not on a busy flag (lessons.md), then report it. */
const PARTITION = `(async () => {
  const H = window.__hkl_composer, r = H.renderer, pb = r['pageBreaks'];
  const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
  const sig = () => (pb['pageStartIds'] || []).join(',') + '|' + pb.lineStarts().length;
  const idle = () => { const b = document.getElementById('renderBusy'); return (!b || b.hidden) && !pb.balanceJobActive() && r.extentsJobState() === null; };
  let last = null, since = 0; const t0 = performance.now();
  while (performance.now() - t0 < 150000) { const s = sig(); if (s !== last) { last = s; since = performance.now(); } else if (idle() && performance.now() - since > 4000) break; await sleep(200); }
  const doc = H.model.getDoc(); const all = [...doc.querySelectorAll('measure')];
  const nOf = new Map(); let mv = 1; const mvOf = new Map();
  all.forEach((m, i) => { if (m.hasAttribute('data-hkl-section-title') && i > 0) mv++; nOf.set(m.getAttribute('xml:id'), m.getAttribute('n')); mvOf.set(m.getAttribute('xml:id'), mv); });
  const lines = pb.lineStarts(), ps = pb['pageStartIds'] || [];
  let pg = 0; const byPage = [];
  for (const id of lines) { if (ps.includes(id)) pg++; const p = Math.max(1, pg); (byPage[p - 1] = byPage[p - 1] || []).push(nOf.get(id) + (mvOf.get(id) !== mvOf.get(lines[0]) ? '' : '')); }
  return { settledMs: Math.round(performance.now() - t0), pages: ps.length, lines: lines.length,
           dpr: window.devicePixelRatio, vw: window.innerWidth, vh: window.innerHeight,
           version: (() => { try { return r['tk'].getVersion(); } catch (e) { return '?'; } })(),
           byPage: byPage.map((a) => a.join(',')) };
})()`;

const runOne = async (mode, win, dpr) => {
  const [w, h] = win.split('x');
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = mkdtempSync(join(tmpdir(), 'hkl-sweep-'));
  const flags = [
    '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--window-size=${w},${h}`, `--force-device-scale-factor=${dpr}`,
    'about:blank',
  ];
  if (mode !== 'headed') flags.unshift(`--headless=${mode}`);
  const child = spawn('chromium', flags, { stdio: 'pipe' });
  const cleanup = () => { try { child.kill('SIGTERM'); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
  try {
    const dl = Date.now() + 15000;
    let ok = false;
    while (Date.now() < dl) { try { const r = await fetch(`http://localhost:${port}/json/version`); if (r.ok) { ok = true; break; } } catch {} await new Promise((r) => setTimeout(r, 100)); }
    if (!ok) return { error: 'no debug endpoint' };
    const tab = await (await fetch(`http://localhost:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const cdp = new CDP(tab.webSocketDebuggerUrl); await cdp.ready;
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: URL_ });
    await new Promise((res) => cdp.ws.addEventListener('message', (ev) => { if (JSON.parse(ev.data).method === 'Page.loadEventFired') res(); }));
    for (let i = 0; i < 240; i++) { if (await evalIn(cdp, `!!(window.__hkl_composer && window.__hkl_composer.renderer && document.querySelector('#score svg'))`) === 'true') break; await new Promise((r) => setTimeout(r, 250)); }
    await evalIn(cdp, `(window.__sonataXml = ${JSON.stringify(xml)}, true)`);
    await evalIn(cdp, `(window.__composerImportMusicXml(window.__sonataXml), true)`);
    const out = JSON.parse(await evalIn(cdp, PARTITION));
    cdp.close();
    return out;
  } finally { cleanup(); }
};

const expect = optOf('--expect', null);
console.log(`sweep: modes=${MODES} wins=${WINS} dprs=${DPRS}\n`);
for (const mode of MODES) for (const win of WINS) for (const dpr of DPRS) {
  const tag = `mode=${mode} win=${win} dpr=${dpr}`;
  try {
    const o = await runOne(mode, win, dpr);
    if (o.error || o.__error) { console.log(`${tag}: ERROR ${o.error || o.__error}`); continue; }
    console.log(`${tag}: dpr=${o.dpr} vp=${o.vw}x${o.vh} v=${o.version} → ${o.pages} pages, ${o.lines} systems (settled ${o.settledMs}ms)`);
    console.log(`   tail: ${o.byPage.slice(-5).map((s, i) => `p${o.pages - 5 + i + 1}[${s}]`).join(' ')}`);
    if (expect) console.log(`   ${o.byPage.slice(-5).join(' | ') === expect ? 'MATCHES --expect' : 'differs from --expect'}`);
  } catch (e) { console.log(`${tag}: THREW ${e.message}`); }
}
