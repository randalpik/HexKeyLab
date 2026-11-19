// The shape guide printed by Firefox, the maintainer's browser: page breaks are the browser's, so
// the PDF Chromium makes (page.mjs --pdf) says nothing about Firefox's.
//
// Needs `pnpm dev`. Headless Firefox over its built-in WebDriver BiDi agent, as
// test/hkl-inspect/console-scan-firefox.mjs launches it: a throwaway profile with
// media.volume_scale "0.0" (Firefox has no mute flag), its own port, and only the process this
// script started is stopped. Loads /shapes.html, waits for the page to finish, and prints it to
// a Letter PDF. Fails on a console or JavaScript error, or if the page does not finish.
//
//   node test/shapes/print-firefox.mjs <out.pdf>

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2];
if (!out) { console.error('usage: node test/shapes/print-firefox.mjs <out.pdf>'); process.exit(2); }
const URL = process.env.SHAPES_URL ?? 'http://localhost:5170/shapes.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const port = 9500 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), 'hkl-ff-shapes-'));
  writeFileSync(join(profile, 'user.js'), 'user_pref("media.volume_scale", "0.0");\n');
  const proc = spawn('firefox', ['--headless', '--no-remote', '--new-instance', '--profile', profile, `--remote-debugging-port=${port}`],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const cleanup = () => {
    try { proc.kill('SIGTERM'); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  };
  try {
    let bidiUrl = null;
    const gotUrl = new Promise((res) => {
      proc.stderr.on('data', (d) => {
        const m = String(d).match(/WebDriver BiDi listening on (ws:\/\/\S+)/);
        if (m && !bidiUrl) { bidiUrl = m[1]; res(bidiUrl); }
      });
    });
    const base = await Promise.race([gotUrl, sleep(15000).then(() => null)]);
    if (!base) throw new Error('Firefox never announced a BiDi endpoint');

    const ws = new WebSocket(base + '/session');
    let id = 0;
    const pending = new Map(), errors = [];
    const send = (method, params = {}) => {
      const myId = ++id;
      ws.send(JSON.stringify({ id: myId, method, params }));
      return new Promise((res, rej) => pending.set(myId, { res, rej }));
    };
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('BiDi WebSocket error')), { once: true });
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.type === 'error') rej(new Error(JSON.stringify(msg))); else res(msg.result);
        return;
      }
      if (msg.type === 'event' && msg.method === 'log.entryAdded' && msg.params.level === 'error' && !/favicon/i.test(msg.params.text ?? '')) {
        errors.push(msg.params.text ?? '');
      }
    });

    await send('session.new', { capabilities: {} });
    const ctx = (await send('browsingContext.getTree', {})).contexts[0].context;
    await send('session.subscribe', { events: ['log.entryAdded'] });
    await send('browsingContext.navigate', { context: ctx, url: URL, wait: 'complete' });
    let ready = null;
    for (let i = 0; i < 100 && !ready && !errors.length; i++) {
      const r = await send('script.evaluate', { expression: 'document.body.dataset.ready ?? null', target: { context: ctx }, awaitPromise: true });
      ready = r?.result?.value ?? null;
      if (!ready) await sleep(150);
    }
    const info = await send('script.evaluate', {
      expression: `JSON.stringify({ entries: document.querySelectorAll('article.entry').length,
        pictures: [...document.querySelectorAll('img.diagram')].filter((i) => i.complete && i.naturalWidth > 0).length })`,
      target: { context: ctx }, awaitPromise: true,
    });
    console.log(`Firefox: page finished with ${ready ?? 'nothing'} entries; ${info?.result?.value}`);
    /* US Letter in cm, the page's own 0.6 in margins */
    const pdf = await send('browsingContext.print', {
      context: ctx, background: true, shrinkToFit: false,
      page: { width: 21.59, height: 27.94 }, margin: { top: 1.524, bottom: 1.524, left: 1.524, right: 1.524 },
    });
    writeFileSync(out, Buffer.from(pdf.data, 'base64'));
    console.log(`pdf → ${out}`);
    if (errors.length) console.log('CONSOLE ERRORS:\n  ' + errors.join('\n  '));
    ws.close();
    return ready === '129' && !errors.length ? 0 : 1;
  } finally {
    cleanup();
  }
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
