#!/usr/bin/env node
// Batch MusicXML import + probe (2026-10-20, partition F's Phase 0 over the
// MuseScore corpus). One headless Chromium, one Composer page: for each file
// the bytes go through the app's own decoder (__composerImportMusicXmlBytes),
// the render is waited out, the probe runs (default partition-inputs.js), and
// <outDir>/<name>.json records the import outcome, the status line, the
// console (errors / warnings / exceptions) since that file's import, timings
// and the probe's JSON. The page reloads every --reload-every files and after
// any timeout, so one pathological score cannot poison the rest.
//
//   node test/corpus/batch-import.mjs <list.txt> <outDir> [--probe <file.js>] [--reload-every 20] [--timeout 120]
// <list.txt>: one .musicxml path per line. Requires `pnpm dev`. Files already
// in <outDir> are skipped (resumable).
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const [listPath, outDir] = process.argv.slice(2);
if (!listPath || !outDir) { console.error('usage: batch-import.mjs <list.txt> <outDir> [--probe f.js] [--reload-every N] [--timeout s]'); process.exit(2); }
const opt = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const probeSrc = readFileSync(opt('--probe', join(fileURLToPath(new URL('.', import.meta.url)), '../composer-inspect/sonata-probes/partition-inputs.js')), 'utf8');
const RELOAD_EVERY = Number(opt('--reload-every', 20));
const TIMEOUT = Number(opt('--timeout', 120)) * 1000;
const files = readFileSync(listPath, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
mkdirSync(outDir, { recursive: true });
const url = process.env.COMPOSER_URL ?? 'http://localhost:5170/composer/';

const DEBUG_PORT = 9222 + Math.floor(Math.random() * 1000);
const profileDir = mkdtempSync(join(tmpdir(), 'hkl-batch-'));
const chromium = spawn('chromium', ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profileDir}`, '--window-size=1600,1200', 'about:blank'], { stdio: 'pipe' });
const cleanup = (code = 0) => { try { chromium.kill('SIGTERM'); } catch {} try { rmSync(profileDir, { recursive: true, force: true }); } catch {} process.exit(code); };
process.on('SIGINT', () => cleanup(130)); process.on('SIGTERM', () => cleanup(143));
async function waitForEndpoint() { const dl = Date.now() + 10_000; while (Date.now() < dl) { try { const r = await fetch(`http://localhost:${DEBUG_PORT}/json/version`); if (r.ok) return r.json(); } catch {} await new Promise((r) => setTimeout(r, 80)); } throw new Error('no debug endpoint'); }
async function newTab() { const r = await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' }); return (await r.json()).webSocketDebuggerUrl; }
class CDP { constructor(ws) { this.ws = new WebSocket(ws); this.id = 0; this.pending = new Map(); this.listeners = [];
  this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res, { once: true }); this.ws.addEventListener('error', rej, { once: true }); });
  this.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id != null && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } else for (const l of this.listeners) l(m); }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  close() { try { this.ws.close(); } catch {} } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evalIn(cdp, expr, timeoutMs) {
  const result = await Promise.race([cdp.send('Runtime.evaluate', { expression: `(async () => { try { return JSON.stringify(await Promise.resolve(${expr})); } catch (e) { return JSON.stringify({ __error: String(e && e.stack || e) }); } })()`, returnByValue: true, awaitPromise: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout')), timeoutMs))]);
  return result.result.value;
}
async function loadPage(cdp) {
  await cdp.send('Page.navigate', { url });
  for (let i = 0; i < 240; i++) { try { if (await evalIn(cdp, `!!(window.__hkl_composer && window.__hkl_composer.renderer && document.querySelector('#score svg'))`, 5000) === 'true') return; } catch {} await sleep(250); }
  throw new Error('Composer never came up');
}

let msgs = [];
try {
  await waitForEndpoint();
  const cdp = new CDP(await newTab()); await cdp.ready;
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  cdp.listeners.push((m) => {
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) msgs.push(`${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    else if (m.method === 'Runtime.exceptionThrown') msgs.push('exception: ' + String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).split('\n')[0].slice(0, 300));
  });
  await loadPage(cdp);
  let sinceReload = 0, done = 0, failed = 0;
  for (const f of files) {
    const name = basename(f).replace(/\.(musicxml|xml)$/i, '');
    const outPath = join(outDir, name + '.json');
    if (existsSync(outPath)) continue;
    if (sinceReload >= RELOAD_EVERY) { await loadPage(cdp); sinceReload = 0; }
    sinceReload++;
    msgs = [];
    const rec = { file: f, import: null, status: null, ms: {}, console: null, dump: null };
    const t0 = Date.now();
    try {
      await evalIn(cdp, `(window.__batchB64 = ${JSON.stringify(readFileSync(f).toString('base64'))}, true)`, 30000);
      const imp = JSON.parse(await evalIn(cdp, `(window.__composerImportMusicXmlBytes(Uint8Array.from(atob(window.__batchB64), (ch) => ch.charCodeAt(0))), true)`, TIMEOUT));
      rec.import = imp && imp.__error ? { ok: false, error: String(imp.__error).split('\n').slice(0, 3).join(' | ') } : { ok: true };
      rec.ms.import = Date.now() - t0;
      rec.status = JSON.parse(await evalIn(cdp, `document.getElementById('composerStatus')?.textContent ?? ''`, 5000));
      if (rec.import.ok) {
        const t1 = Date.now();
        const out = await evalIn(cdp, `(async () => { ${probeSrc}\n })()`, TIMEOUT);
        rec.ms.probe = Date.now() - t1;
        try { rec.dump = JSON.parse(out); } catch { rec.dump = { __unparsed: String(out).slice(0, 300) }; }
      }
    } catch (e) {
      rec.timeout = String(e?.message ?? e);
      failed++;
      try { await loadPage(cdp); sinceReload = 0; } catch {}
    }
    rec.ms.total = Date.now() - t0;
    const counts = new Map(); for (const m of msgs) counts.set(m, (counts.get(m) ?? 0) + 1);
    rec.console = { errors: msgs.filter((m) => m.startsWith('error')).length, warnings: msgs.filter((m) => m.startsWith('warning')).length,
      exceptions: msgs.filter((m) => m.startsWith('exception')).length, top: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([m, n]) => `${n}× ${m}`) };
    writeFileSync(outPath, JSON.stringify(rec));
    done++;
    if (done % 10 === 0) console.error(`${done}/${files.length} (${failed} timed out)`);
  }
  console.error(`done: ${done} written, ${failed} timed out`);
  cdp.close(); cleanup(0);
} catch (e) { console.error('batch failed:', e?.message ?? e); cleanup(1); }
