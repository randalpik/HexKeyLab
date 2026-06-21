// HKL core-app console scanner — FIREFOX variant (Max's primary browser).
//
// Drives headless Firefox via its built-in WebDriver BiDi remote agent (no
// geckodriver needed) and captures console output, which differs from Chromium:
// Firefox phrases errors differently and surfaces some Firefox-only JS errors.
//
// SCOPE / LIMITATION — read this before expecting font/WASM/source-map warnings:
// WebDriver BiDi's `log.entryAdded` exposes ONLY console-API calls and JS
// exceptions. The "downloadable font" warnings, the WASM 'try' note, and
// "source map" messages you see in the Firefox Web Console are emitted by
// Firefox's font/JS-engine subsystems straight to the DevTools console UI —
// they never pass through the console API, so neither this harness nor the
// Chromium CDP one can capture them. (Source maps aren't even fetched unless
// DevTools is open.) Those must be fixed from pasted console text instead.
// What this DOES catch: console.warn/error and uncaught exceptions — e.g. the
// MEI "No header" warning and the empty-OscillatorType error.
//
// Requires `pnpm dev` running (umbrella proxy at :5170) in another terminal.
//
// Usage:
//   node test/hkl-inspect/console-scan-firefox.mjs          # warn+error+exceptions
//   ALL=1 node test/hkl-inspect/console-scan-firefox.mjs    # include info/debug too
//   HKL_URL=http://localhost:5170/ pnpm scan:hkl:firefox

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HR, printConsole } from './report.mjs';

const URL = process.env.HKL_URL ?? 'http://localhost:5170/';
const WAIT_MS = Number(process.env.WAIT_MS ?? 2500);
const VEROVIO_MS = Number(process.env.VEROVIO_MS ?? 6000);
const SHOW_ALL = process.env.ALL === '1';

const ALLOW = [/favicon\.ico/i];
const isAllowed = (t) => ALLOW.some((re) => re.test(t));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const port = 9500 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), 'hkl-ff-scan-'));
  const proc = spawn('firefox', [
    '--headless', '--no-remote', '--new-instance',
    '--profile', profile, `--remote-debugging-port=${port}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const cleanup = () => {
    try { proc.kill('SIGTERM'); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  };

  /* The BiDi WebSocket URL is announced on stderr (not via /json/version). */
  let bidiUrl = null;
  const gotUrl = new Promise((res) => {
    proc.stderr.on('data', (d) => {
      const m = String(d).match(/WebDriver BiDi listening on (ws:\/\/\S+)/);
      if (m && !bidiUrl) { bidiUrl = m[1]; res(bidiUrl); }
    });
  });

  const base = await Promise.race([gotUrl, sleep(15000).then(() => null)]);
  if (!base) { cleanup(); throw new Error('Firefox never announced a BiDi endpoint'); }

  const ws = new WebSocket(base + '/session');
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => {
    const myId = ++id;
    ws.send(JSON.stringify({ id: myId, method, params }));
    return new Promise((res, rej) => pending.set(myId, { res, rej }));
  };

  const records = [];
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('BiDi WebSocket error')), { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.type === 'error') rej(new Error(JSON.stringify(msg)));
      else res(msg.result);
      return;
    }
    if (msg.type === 'event' && msg.method === 'log.entryAdded') {
      const e = msg.params;
      /* BiDi log entry: type 'console'|'javascript', level debug|info|warn|error. */
      const keep = SHOW_ALL || e.level === 'warn' || e.level === 'error';
      if (!keep) return;
      const text = e.text ?? '';
      if (isAllowed(text)) return;
      const kind = e.type === 'javascript' ? 'javascript' : 'console';
      records.push({ source: kind + '.' + e.level, text });
    }
  });

  await send('session.new', { capabilities: {} });
  const tree = await send('browsingContext.getTree', {});
  const ctx = tree.contexts[0].context;
  await send('session.subscribe', { events: ['log.entryAdded'] });
  await send('browsingContext.navigate', { context: ctx, url: URL, wait: 'complete' });
  await sleep(WAIT_MS);

  /* Enable staff inset + HEJI, then hold a 3-note chord via synthetic keydown
   * (HKL's handler keys off e.code; no keyup => notes stay selected => Verovio
   * renders). */
  const evalRes = await send('script.evaluate', {
    expression: `(() => {
      const found = {};
      for (const id of ['cbStaff','cbHeji']) {
        const cb = document.getElementById(id);
        found[id] = !!cb;
        if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change',{bubbles:true})); }
      }
      for (const [code,key] of [['KeyA','a'],['KeyS','s'],['KeyD','d']])
        window.dispatchEvent(new KeyboardEvent('keydown',{code,key,bubbles:true,cancelable:true}));
      return found;
    })()`,
    target: { context: ctx }, awaitPromise: true,
  });
  const cbStaffFound = evalRes?.result?.value?.cbStaff?.value === true
    || evalRes?.result?.type === 'object'; /* tolerant: BiDi serializes objects verbosely */

  await sleep(VEROVIO_MS); /* first render downloads + inits Verovio WASM */

  const inset = await send('script.evaluate', {
    expression: `document.getElementById('staffInset')?.innerHTML.slice(0,80) ?? null`,
    target: { context: ctx }, awaitPromise: true,
  });
  const insetHtml = inset?.result?.value ?? null;
  const rendered = typeof insetHtml === 'string' && insetHtml.includes('<svg');

  await sleep(300);

  console.log('\n' + HR);
  console.log('HKL console scan (Firefox / WebDriver BiDi) — ' + URL);
  console.log(HR);
  console.log('staff inset rendered: ' + (rendered ? 'yes (SVG present)' : 'NO — Verovio did not render; warnings may be incomplete'));
  if (!cbStaffFound) console.log('WARNING: #cbStaff not found — is this the HKL core app?');
  printConsole(records);
  console.log('\nNote: BiDi captures console-API + JS errors only. Firefox\'s font /');
  console.log('WASM-\'try\' / source-map warnings are DevTools-console-internal and do NOT');
  console.log('appear here — fix those from pasted console text. ' + (SHOW_ALL ? '' : '(ALL=1 adds info/debug.)'));
  console.log(HR + '\n');

  ws.close();
  cleanup();
}

main().catch((e) => { console.error(e); process.exit(1); });
