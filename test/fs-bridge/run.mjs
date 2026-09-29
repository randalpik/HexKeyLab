// Gate for the overlay host's local file bridge (apps/overlay-host/src/fs-bridge.mjs).
//
//   node test/fs-bridge/run.mjs            host checks + Composer end-to-end
//   node test/fs-bridge/run.mjs --host     host checks only (no dev server needed)
//
// Host phase: runs the bridge IN-PROCESS on a free port with temp roots and a
// stub picker (no real dialog ever opens), and drives it over HTTP exactly as a
// browser would — Origin + Host headers included. Covers the four request gates
// (Host, Origin, roots/symlinks/dot-dirs, extensions), conditional + atomic +
// exclusive + numbered writes, and the pick routes.
//
// E2E phase (needs `pnpm dev` on :5170): headless Chromium opens Composer with
// ?obsrelay=<port> so its real client dials THIS test host, then drives Load /
// Import / Ctrl+S / Save As / conflict through the real toolbar and keystrokes
// and checks the files on disk.
//
// Exit 0 = all pass, 1 = a check failed, 2 = infra failure.

import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFsBridge } from '../../apps/overlay-host/src/fs-bridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_ONLY = process.argv.includes('--host');
const ORIGIN = 'http://localhost:5170';

let failures = 0, passes = 0;
function check(name, cond, detail = '') {
  if (cond) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/* ── test host ──────────────────────────────────────────────────────────── */

/** Stub picker: each pick consumes the next queued answer (a path, null =
 *  cancel, or a function returning a Promise for the busy test). */
const pickQueue = [];
const pickLog = [];
const stubPicker = async (req) => {
  pickLog.push(req);
  if (!pickQueue.length) throw new Error('stub picker: no queued answer for ' + JSON.stringify(req));
  const a = pickQueue.shift();
  return typeof a === 'function' ? a() : a;
};

async function startHost(roots) {
  let bridge = null;
  const server = http.createServer((req, res) => {
    if (bridge.owns(req.url || '')) bridge.handle(req, res);
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  bridge = await createFsBridge({ port, roots, picker: stubPicker, pickerName: 'stub' });
  return { port, close: () => new Promise((r) => server.close(r)) };
}

/** Raw request so the Host/Origin headers are exactly what we say (fetch
 *  forbids setting both). */
function request(port, method, url, { origin = ORIGIN, host = `127.0.0.1:${port}`, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: host, ...headers };
    if (origin) h.Origin = origin;
    const data = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    if (data) h['Content-Length'] = data.length;
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const post = (port, url, body, o) => request(port, 'POST', url, { ...o, body });
const writeUrl = (p, cond = '') => `/fs/write?path=${encodeURIComponent(p)}${cond}`;

async function hostPhase() {
  console.log('\nfs-bridge host');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'hkl-fs-'));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  await fs.mkdir(path.join(root, 'scores'), { recursive: true });
  await fs.mkdir(path.join(root, '.hidden'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(root, 'scores', 'a.hkc'), 'AAA');
  await fs.writeFile(path.join(root, 'secret.txt'), 'nope');
  await fs.writeFile(path.join(root, '.hidden', 'h.hkc'), 'hidden');
  await fs.writeFile(path.join(outside, 'x.hkc'), 'outside');
  await fs.symlink(path.join(outside, 'x.hkc'), path.join(root, 'link-out.hkc'));
  await fs.symlink(path.join(root, 'secret.txt'), path.join(root, 'link-txt.hkc'));

  const host = await startHost([root]);
  const P = host.port;
  const rootReal = await fs.realpath(root);
  try {
    /* Gate 1 + 2: Host and Origin. */
    let r = await request(P, 'GET', '/fs/status', { host: `evil.example:${P}` });
    check('bad Host header → 403 bad-host', r.status === 403 && r.json?.error === 'bad-host', r.text);
    r = await request(P, 'GET', '/fs/status', { origin: null });
    check('no Origin → 403 bad-origin', r.status === 403 && r.json?.error === 'bad-origin', r.text);
    r = await request(P, 'GET', '/fs/status', { origin: 'https://evil.example' });
    check('foreign Origin → 403 bad-origin', r.status === 403 && r.json?.error === 'bad-origin', r.text);
    check('foreign Origin gets no CORS grant', !r.headers['access-control-allow-origin']);
    r = await request(P, 'OPTIONS', '/fs/write', { headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true' } });
    check('preflight → 204 + ACAO + private-network grant',
      r.status === 204 && r.headers['access-control-allow-origin'] === ORIGIN && r.headers['access-control-allow-private-network'] === 'true',
      JSON.stringify(r.headers));
    r = await request(P, 'GET', '/fs/status');
    check('status → version/picker/roots', r.status === 200 && r.json.version === 1 && r.json.picker === 'stub' && r.json.roots[0] === rootReal, r.text);
    r = await request(P, 'GET', '/fs/status', { host: `localhost:${P}` });
    check('Host localhost:<port> accepted', r.status === 200, r.text);

    /* Gate 3 + 4: paths and extensions. */
    r = await post(P, '/fs/read', { path: path.join(root, 'scores', 'a.hkc') });
    check('read inside root', r.status === 200 && r.json.text === 'AAA' && typeof r.json.mtimeMs === 'number' && r.json.name === 'a.hkc', r.text);
    r = await post(P, '/fs/read', { path: path.join(outside, 'x.hkc') });
    check('read outside root → 403 outside-roots', r.status === 403 && r.json.error === 'outside-roots', r.text);
    r = await post(P, '/fs/read', { path: root + '/../outside/x.hkc' });
    check('.. traversal → 403 outside-roots', r.status === 403 && r.json.error === 'outside-roots', r.text);
    r = await post(P, '/fs/read', { path: path.join(root, 'link-out.hkc') });
    check('symlink escaping root → 403 outside-roots', r.status === 403 && r.json.error === 'outside-roots', r.text);
    r = await post(P, '/fs/read', { path: path.join(root, 'link-txt.hkc') });
    check('x.hkc symlink to a .txt → 403 bad-extension', r.status === 403 && r.json.error === 'bad-extension', r.text);
    r = await post(P, '/fs/read', { path: path.join(root, '.hidden', 'h.hkc') });
    check('dot-dir component → 403 outside-roots', r.status === 403 && r.json.error === 'outside-roots', r.text);
    r = await post(P, '/fs/read', { path: path.join(root, 'secret.txt') });
    check('.txt read → 403 bad-extension', r.status === 403 && r.json.error === 'bad-extension', r.text);
    r = await post(P, '/fs/read', { path: 'scores/a.hkc' });
    check('relative path → 400 bad-path', r.status === 400 && r.json.error === 'bad-path', r.text);
    r = await post(P, writeUrl(path.join(root, 'nodir', 'n.hkc')), 'x');
    check('write into missing dir → 404 no-dir', r.status === 404 && r.json.error === 'no-dir', r.text);
    r = await post(P, writeUrl(path.join(root, 'evil.sh')), 'x');
    check('.sh write → 403 bad-extension', r.status === 403 && r.json.error === 'bad-extension', r.text);

    /* Conditional writes. */
    const a = path.join(root, 'scores', 'a.hkc');
    await fs.chmod(a, 0o600);
    const read = await post(P, '/fs/read', { path: a });
    r = await post(P, writeUrl(a, `&ifMtime=${read.json.mtimeMs}`), 'BBB');
    check('write ifMtime (fresh) → 200', r.status === 200 && (await fs.readFile(a, 'utf8')) === 'BBB', r.text);
    check('overwrite keeps permission bits', ((await fs.stat(a)).mode & 0o777) === 0o600, ((await fs.stat(a)).mode & 0o777).toString(8));
    const leftovers = (await fs.readdir(path.join(root, 'scores'))).filter((n) => n.endsWith('.tmp'));
    check('no temp files left behind', leftovers.length === 0, leftovers.join(','));
    r = await post(P, writeUrl(a, `&ifMtime=${read.json.mtimeMs}`), 'CCC');
    check('write ifMtime (stale) → 409 conflict + current mtime',
      r.status === 409 && r.json.error === 'conflict' && typeof r.json.mtimeMs === 'number' && (await fs.readFile(a, 'utf8')) === 'BBB', r.text);
    r = await post(P, writeUrl(a, '&ifAbsent=1'), 'DDD');
    check('write ifAbsent on existing → 409', r.status === 409 && r.json.error === 'conflict', r.text);
    const fresh = path.join(root, 'scores', 'fresh.hkc');
    r = await post(P, writeUrl(fresh, '&ifAbsent=1'), 'EEE');
    check('write ifAbsent on new → 200', r.status === 200 && (await fs.readFile(fresh, 'utf8')) === 'EEE', r.text);
    r = await post(P, writeUrl(a, '&ifAbsent=1&unique=1'), 'x');
    check('two conditions → 400', r.status === 400 && r.json.error === 'bad-condition', r.text);
    const gone = path.join(root, 'scores', 'gone.hkc');
    r = await post(P, writeUrl(gone, '&ifMtime=123'), 'x');
    check('ifMtime on a missing file → 409 mtimeMs null', r.status === 409 && r.json.mtimeMs === null, r.text);

    /* Numbered names. */
    const foo = path.join(root, 'scores', 'Foo.hkc');
    const u0 = await post(P, writeUrl(foo, '&unique=1'), '0');
    const u1 = await post(P, writeUrl(foo, '&unique=1'), '1');
    const u2 = await post(P, writeUrl(foo, '&unique=1'), '2');
    check('unique: Foo.hkc, Foo (1).hkc, Foo (2).hkc',
      u0.json?.name === 'Foo.hkc' && u1.json?.name === 'Foo (1).hkc' && u2.json?.name === 'Foo (2).hkc'
      && (await fs.readFile(path.join(root, 'scores', 'Foo (1).hkc'), 'utf8')) === '1',
      [u0, u1, u2].map((x) => x.text).join(' | '));
    const uni = path.join(root, 'scores', 'Sonate für Bratsche — Op. 12.hkc');
    r = await post(P, writeUrl(uni), 'ü');
    check('non-ASCII path round-trips', r.status === 200 && r.json.name === path.basename(uni) && (await fs.readFile(uni, 'utf8')) === 'ü', r.text);
    const bin = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x80]);
    const pdf = path.join(root, 'scores', 'b.pdf');
    r = await post(P, writeUrl(pdf), bin, { headers: { 'Content-Type': 'application/octet-stream' } });
    check('binary body written byte-exact', r.status === 200 && Buffer.compare(await fs.readFile(pdf), bin) === 0, r.text);

    /* Pick routes. */
    pickQueue.push(path.join(root, 'scores', 'a.hkc'));
    r = await post(P, '/fs/pick-open', { filter: 'score', startDir: path.join(root, 'scores') });
    check('pick-open → chosen path', r.status === 200 && r.json.path === path.join(rootReal, 'scores', 'a.hkc'), r.text);
    check('pick-open starts in startDir', pickLog.at(-1)?.start === path.join(rootReal, 'scores') + path.sep && pickLog.at(-1)?.mode === 'open', JSON.stringify(pickLog.at(-1)));
    pickQueue.push(path.join(root, 'scores', 'a.hkc'));
    await post(P, '/fs/pick-open', { filter: 'score', startDir: outside });
    check('pick-open startDir outside roots → falls back to root', pickLog.at(-1)?.start === rootReal + path.sep, JSON.stringify(pickLog.at(-1)));
    pickQueue.push(null);
    r = await post(P, '/fs/pick-open', { filter: 'score' });
    check('pick-open cancel → {cancelled}', r.status === 200 && r.json.cancelled === true, r.text);
    pickQueue.push(path.join(outside, 'x.hkc'));
    r = await post(P, '/fs/pick-open', { filter: 'score' });
    check('pick-open outside roots → 403', r.status === 403 && r.json.error === 'outside-roots', r.text);
    pickQueue.push(path.join(root, 'scores', 'typed'));
    r = await post(P, '/fs/pick-save', { filter: 'hkc', dir: path.join(root, 'scores'), name: 'My Song.hkc' });
    check('pick-save suggests dir/name', pickLog.at(-1)?.start === path.join(rootReal, 'scores', 'My Song.hkc') && pickLog.at(-1)?.mode === 'save', JSON.stringify(pickLog.at(-1)));
    check('pick-save appends missing extension', r.status === 200 && r.json.name === 'typed.hkc' && r.json.appended === true, r.text);
    pickQueue.push(path.join(root, 'scores', 'keep.hkc'));
    r = await post(P, '/fs/pick-save', { filter: 'hkc', name: 'x.hkc' });
    check('pick-save keeps a matching extension', r.status === 200 && r.json.name === 'keep.hkc' && r.json.appended === false, r.text);
    r = await post(P, '/fs/pick-save', { filter: 'hkc', name: '../x.hkc' });
    check('pick-save name with a separator → 400', r.status === 400 && r.json.error === 'bad-name', r.text);
    r = await post(P, '/fs/pick-save', { filter: 'score', name: 'x.hkc' });
    check('pick-save input-only filter → 400', r.status === 400 && r.json.error === 'bad-filter', r.text);
    let release;
    pickQueue.push(() => new Promise((res) => { release = () => res(path.join(root, 'scores', 'a.hkc')); }));
    const first = post(P, '/fs/pick-open', { filter: 'score' });
    await new Promise((res) => setTimeout(res, 50));
    r = await post(P, '/fs/pick-open', { filter: 'score' });
    check('second dialog while one is open → 409 picker-busy', r.status === 409 && r.json.error === 'picker-busy', r.text);
    release();
    r = await first;
    check('first dialog still resolves', r.status === 200 && r.json.name === 'a.hkc', r.text);
  } finally {
    await host.close();
    await fs.rm(base, { recursive: true, force: true });
  }
}

/* ── Composer end-to-end ────────────────────────────────────────────────── */

const COMPOSER_URL = 'http://localhost:5170/composer/';

async function e2ePhase() {
  console.log('\nComposer ↔ fs-bridge end-to-end');
  try {
    const r = await fetch(COMPOSER_URL);
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (e) {
    throw new Error(`Composer not reachable at ${COMPOSER_URL} (${e.message}) — run \`pnpm dev\`, or pass --host`);
  }
  const { launchChromium, newTabWsUrl } = await import('../composer-test/lib/chromium.mjs');
  const { openPage } = await import('../composer-test/lib/cdp.mjs');
  const { pressKey } = await import('../composer-test/lib/keystroke.mjs');
  const { attachConsoleCapture } = await import('../composer-test/lib/console-capture.mjs');

  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'hkl-fs-e2e-'));
  const root = await fs.realpath(base);
  await fs.mkdir(path.join(root, 'scores'));
  await fs.mkdir(path.join(root, 'in'));
  const host = await startHost([root]);
  const browser = await launchChromium();
  try {
    const cdp = await openPage(await newTabWsUrl(browser.port), `${COMPOSER_URL}?obsrelay=${host.port}`, { waitMs: 3000 });
    const cons = attachConsoleCapture(cdp);
    const ev = (expr) => cdp.evalJSON(expr);
    const until = async (fn, ms = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
      return null;
    };
    const readOr = (p) => fs.readFile(p, 'utf8').catch(() => null);
    const H = 'window.__hkl_composer';
    const ctrlS = async () => { await ev(`document.body.focus(), true`); await pressKey(cdp, 's', { ctrl: true }); };

    /* Load → bound → Ctrl+S overwrites in place. */
    const etude = path.join(root, 'scores', 'Etude.hkc');
    const etudeText = await ev(`(() => { ${H}.model.setTitle('E2E Etude'); const t = ${H}.model.serialize(); ${H}.model.setTitle('Scratch'); return t; })()`);
    await fs.writeFile(etude, etudeText);
    pickQueue.push(etude);
    await ev(`document.getElementById('btnLoad').click(), true`);
    const loaded = await until(() => ev(`${H}.model.getTitle() === 'E2E Etude' && ${H}.fileState().path`));
    check('Load through the host binds the real path', loaded === etude, String(loaded));
    check('first Load opens the dialog in the host default root (no last dir yet)', pickLog.at(-1)?.mode === 'open' && pickLog.at(-1)?.start === root + path.sep, JSON.stringify(pickLog.at(-1)));
    check('toolbar shows the file name', (await ev(`(() => { const e = document.getElementById('fileName'); return !e.hidden && e.textContent; })()`)) === 'Etude.hkc');
    await ev(`(() => { const m = ${H}.model; m.setCursor(0, 1); m.insertRestAtCursor({ duration: '4', dots: 0 }); ${H}.reRender(); return true; })()`);
    await ctrlS();
    const saved = await until(async () => { const t = await readOr(etude); return t && t !== etudeText && t.includes('<rest') ? t : null; });
    check('Ctrl+S (real keystroke) overwrote the file in place', !!saved);
    const status1 = await ev(`document.getElementById('composerStatus').textContent`);
    check('status names the saved path', status1.includes(etude), status1);
    const siblings = (await fs.readdir(path.join(root, 'scores'))).sort();
    check('no stray files beside it', JSON.stringify(siblings) === JSON.stringify(['Etude.hkc']), siblings.join(', '));

    /* Changed on disk → confirm. */
    await fs.writeFile(etude, 'external edit');
    await ev(`(window.__asked = [], window.confirm = (m) => { window.__asked.push(m); return false; }, true)`);
    await ctrlS();
    const asked = await until(() => ev(`window.__asked.length`));
    await new Promise((r) => setTimeout(r, 200));
    check('external change → confirm, declined leaves disk alone', asked === 1 && (await readOr(etude)) === 'external edit');
    await ev(`(window.confirm = (m) => { window.__asked.push(m); return true; }, true)`);
    await ctrlS();
    check('accepted → overwritten', !!(await until(async () => (await readOr(etude))?.includes('<rest'))));
    await ctrlS();
    await new Promise((r) => setTimeout(r, 300));
    check('next Ctrl+S is clean again (mtime re-read after the forced write)', (await ev(`window.__asked.length`)) === 2);

    /* MusicXML import → Save writes a numbered .hkc beside it. */
    const src = path.join(root, 'in', 'Foo.musicxml');
    const xml = await ev(`(() => { ${H}.model.setTitle('Foo'); return ${H}.exportMusicXml(${H}.model); })()`);
    await fs.writeFile(src, xml);
    await fs.writeFile(path.join(root, 'in', 'Foo.hkc'), 'older');
    pickQueue.push(src);
    await ev(`document.getElementById('btnImportXml').click(), true`);
    const t0 = Date.now();
    const importDir = await until(() => ev(`${H}.fileState().dir === ${JSON.stringify(path.join(root, 'in'))} && ${H}.fileState().dir`));
    check('Import through the host records the source dir', importDir === path.join(root, 'in'),
      `after ${Date.now() - t0}ms: dir=${await ev(`${H}.fileState().dir`)} status="${await ev(`document.getElementById('composerStatus').textContent`)}" picks=${pickLog.length}`);
    check('Import dialog started in the last-used dir', pickLog.at(-1)?.start === path.join(root, 'scores') + path.sep, JSON.stringify(pickLog.at(-1)));
    await ctrlS();
    const numbered = path.join(root, 'in', 'Foo (1).hkc');
    check('Save after import wrote Foo (1).hkc', !!(await until(async () => (await readOr(numbered))?.includes('<mei'))));
    check('source and older .hkc untouched', (await readOr(src)) === xml && (await readOr(path.join(root, 'in', 'Foo.hkc'))) === 'older');

    /* Export PDF through the save dialog. */
    const pdf = path.join(root, 'in', 'Foo.pdf');
    pickQueue.push(pdf);
    await ev(`document.getElementById('btnExportPdf').click(), true`);
    const pdfBytes = await until(async () => { try { const b = await fs.readFile(pdf); return b.length > 4 ? b : null; } catch { return null; } }, 20000);
    check('PDF export wrote %PDF- bytes to the chosen path', !!pdfBytes && pdfBytes.subarray(0, 5).toString('latin1') === '%PDF-');
    /* The file lands before the client sees the host's reply; the next action
       would bounce off the one-op-at-a-time guard until then. */
    const pdfStatus = await until(async () => { const t = await ev(`document.getElementById('composerStatus').textContent`); return t.startsWith('Exported') ? t : null; });
    check('PDF export reports the written path', pdfStatus === 'Exported ' + pdf, String(pdfStatus));
    check('PDF dialog suggested <base>.pdf beside the doc', pickLog.at(-2)?.start === path.join(root, 'in', 'Foo (1).pdf') || pickLog.at(-1)?.start === path.join(root, 'in', 'Foo (1).pdf'),
      JSON.stringify(pickLog.slice(-2)));

    /* Save As to a typed name without an extension. */
    pickQueue.push(path.join(root, 'scores', 'renamed'));
    await ev(`document.getElementById('btnSaveAs').click(), true`);
    const renamed = path.join(root, 'scores', 'renamed.hkc');
    check('Save As with a bare typed name → .hkc appended, rebound',
      !!(await until(async () => (await readOr(renamed))?.includes('<mei'))) && (await until(() => ev(`${H}.fileState().path`))) === renamed);

    /* Outside the roots → a readable error, nothing written. */
    pickQueue.push('/etc/evil.hkc');
    await ev(`document.getElementById('btnSaveAs').click(), true`);
    const err = await until(async () => { const t = await ev(`document.getElementById('composerStatus').textContent`); return /failed/.test(t) ? t : null; });
    check('dialog pick outside the roots → Save failed status', !!err && /outside/.test(err), String(err));

    /* Chromium logs every non-2xx fetch as "Failed to load resource". This
       flow provokes exactly two 409s (the declined and the accepted conflict)
       and one 403 (the pick outside the roots), plus Composer's own
       "[composer] Save failed" line for that 403. Anything else — a CORS
       rejection, a refused connection — is a real failure. */
    const recs = cons.drain().map((r) => r.text ?? JSON.stringify(r));
    const expected = recs.filter((t) => /status of (409|403)/.test(t) || /\[composer\] Save failed/.test(t));
    const unexpected = recs.filter((t) => !expected.includes(t));
    check('console: only the provoked 409/409/403, no CORS or network errors',
      unexpected.length === 0 && recs.filter((t) => /status of 409/.test(t)).length === 2 && recs.filter((t) => /status of 403/.test(t)).length === 1,
      JSON.stringify(recs.slice(0, 6)));
  } finally {
    await browser.stop();
    await host.close();
    await fs.rm(base, { recursive: true, force: true });
  }
}

async function main() {
  try {
    await hostPhase();
    if (!HOST_ONLY) await e2ePhase();
  } catch (e) {
    console.error('infra failure:', e);
    process.exit(2);
  }
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
