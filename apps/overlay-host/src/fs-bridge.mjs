// Local file bridge — lets a browser app (Composer, in Firefox) open a file by
// PATH and save it back in place. Firefox has no File System Access API, so a
// page can never learn where a picked file lives nor write anywhere but the
// Downloads folder; this host does both on the page's behalf.
//
// Every route lives under /fs/ on the overlay host's own port. It is a
// localhost server that WRITES FILES, reachable by any page the user visits, so
// every request passes four gates before any filesystem work:
//   1. Host header is 127.0.0.1/localhost:<port>   (defeats DNS rebinding)
//   2. Origin is in the allowlist                   (a random site gets 403;
//      a request with NO Origin is refused too — every browser fetch here is
//      cross-origin and so carries one)
//   3. The path resolves (symlinks followed) inside an allowed root, and no
//      component is a dot-file / dot-dir
//   4. The extension is on the read / write allowlist
//
// Files are picked with a NATIVE dialog the host spawns (kdialog → zenity → yad,
// first found; HKL_FS_PICKER overrides), so the page only ever sees paths the
// user chose. The tool named is only what is spawned: zenity 4 (GTK4) routes
// through the XDG FileChooser portal when one runs, so on KDE Plasma it shows
// the KDE dialog (drawn by xdg-desktop-portal-kde). Writes are atomic (temp + rename in the target's directory) and
// conditional: the client passes the mtime it read and gets a 409 if the file
// changed on disk since.
//
// Wire protocol (JSON unless noted; every success body carries {path,dir,name}):
//   GET  /fs/status                         → {version, picker, home, roots}
//   POST /fs/pick-open  {filter, startDir?} → {path,dir,name} | {cancelled:true}
//   POST /fs/pick-save  {filter, dir?, name}→ {path,dir,name,appended} | {cancelled:true}
//   POST /fs/read       {path}              → {path,dir,name,text,mtimeMs}
//   POST /fs/write?path=P[&ifMtime=N|&ifAbsent=1|&unique=1]   body = raw bytes
//                                           → {path,dir,name,mtimeMs}
//        409 {error:'conflict', mtimeMs|null} when the condition fails.
//   Errors: {error: <code>, message} with 4xx/5xx.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

export const FS_BRIDGE_VERSION = 1;

/* Production + dev origins of the HKL apps. HKL_FS_ORIGINS (comma-separated)
   adds more. */
const DEFAULT_ORIGINS = [
  'http://localhost:5170',
  'http://127.0.0.1:5170',
  'https://hexkeylab.com',
  'https://www.hexkeylab.com',
  'https://hexkeylab.maxrandalmusic.com',
];

/* Filters name the dialog's file filter AND the extensions a picked path may
   carry. `ext` is appended to a save name that has none of them. */
const FILTERS = {
  score:    { label: 'HKL scores',  exts: ['.hkc', '.mei', '.xml'] },
  musicxml: { label: 'MusicXML',    exts: ['.musicxml', '.xml'] },
  hkc:      { label: 'HKL score',   exts: ['.hkc'],      ext: '.hkc' },
  pdf:      { label: 'PDF',         exts: ['.pdf'],      ext: '.pdf' },
  musicxmlOut: { label: 'MusicXML', exts: ['.musicxml'], ext: '.musicxml' },
};

const READ_EXTS = new Set(['.hkc', '.mei', '.xml', '.musicxml']);
const WRITE_EXTS = new Set(['.hkc', '.mei', '.xml', '.musicxml', '.pdf']);

const MAX_JSON_BYTES = 64 * 1024;
const MAX_WRITE_BYTES = 128 * 1024 * 1024;
const MAX_READ_BYTES = 64 * 1024 * 1024;
const MAX_UNIQUE = 999;

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/* ── picker ─────────────────────────────────────────────────────────────── */

function which(cmd) {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Detect the native dialog tool. Returns null when none is available (the
 *  pick routes then answer 501 and the client falls back to its own picker). */
export function detectPicker(override = process.env.HKL_FS_PICKER) {
  if (override === 'none') return null;
  const order = override ? [override] : ['kdialog', 'zenity', 'yad'];
  for (const cmd of order) if (which(cmd)) return cmd;
  return null;
}

function pickerArgs(tool, mode, filter, start) {
  const f = FILTERS[filter];
  const globs = f.exts.map((e) => '*' + e).join(' ');
  const title = mode === 'open' ? 'Open — HKL Composer' : 'Save — HKL Composer';
  if (tool === 'kdialog') {
    return ['--title', title,
      mode === 'open' ? '--getopenfilename' : '--getsavefilename',
      start, `${globs}|${f.label}`];
  }
  if (tool === 'zenity') {
    /* zenity 4 (GTK4) confirms overwrite itself; --confirm-overwrite is gone. */
    return ['--file-selection', '--title', title, '--filename', start,
      '--file-filter', `${f.label} | ${globs}`,
      ...(mode === 'save' ? ['--save'] : [])];
  }
  if (tool === 'yad') {
    return ['--file', '--title', title, '--filename', start,
      '--file-filter', `${f.label} | ${globs}`,
      ...(mode === 'save' ? ['--save', '--confirm-overwrite'] : [])];
  }
  throw new HttpError(500, 'picker', 'unknown picker ' + tool);
}

/** Default picker: spawn the native dialog, resolve with the chosen path or
 *  null on cancel. `start` is a directory (open, trailing separator) or a full
 *  suggested path (save). */
export function nativePicker(tool) {
  return ({ mode, filter, start }) => new Promise((resolve, reject) => {
    const child = spawn(tool, pickerArgs(tool, mode, filter, start), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => reject(new HttpError(500, 'picker', e.message)));
    child.on('close', (code) => {
      const p = out.replace(/\r?\n$/, '');
      if (code === 0 && p) resolve(p);
      else if (code === 1) resolve(null);   // all three: 1 = cancelled
      else reject(new HttpError(500, 'picker', `${tool} exited ${code}: ${err.trim()}`));
    });
  });
}

/* ── path gate ──────────────────────────────────────────────────────────── */

function within(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function hasDotComponent(root, p) {
  return path.relative(root, p).split(path.sep).some((c) => c.startsWith('.') && c !== '.' && c !== '');
}

async function realRootOf(roots, real) {
  for (const r of roots) if (within(r, real) && !hasDotComponent(r, real)) return r;
  return null;
}

/** Resolve a client-supplied file path to its real location and check it
 *  against the roots + extension allowlist. A path that does not exist yet
 *  resolves through its (existing) parent directory. */
async function gatePath(roots, raw, exts) {
  if (typeof raw !== 'string' || !raw || !path.isAbsolute(raw) || raw.includes('\0')) {
    throw new HttpError(400, 'bad-path', 'path must be absolute');
  }
  const abs = path.resolve(raw);
  const ext = path.extname(abs).toLowerCase();
  if (!exts.has(ext)) throw new HttpError(403, 'bad-extension', `extension ${ext || '(none)'} not allowed`);
  let real;
  try {
    real = await fs.realpath(abs);
  } catch (e) {
    if (e.code !== 'ENOENT') throw new HttpError(400, 'bad-path', e.message);
    let dirReal;
    try { dirReal = await fs.realpath(path.dirname(abs)); } catch { throw new HttpError(404, 'no-dir', 'directory does not exist'); }
    real = path.join(dirReal, path.basename(abs));
  }
  /* The resolved target must keep an allowed extension too (a symlink named
     x.hkc pointing at ~/.bashrc resolves to a non-allowed name). */
  if (!exts.has(path.extname(real).toLowerCase())) throw new HttpError(403, 'bad-extension', 'resolved extension not allowed');
  if (!(await realRootOf(roots, real))) throw new HttpError(403, 'outside-roots', 'path is outside the allowed roots');
  return real;
}

async function gateDir(roots, raw) {
  if (typeof raw !== 'string' || !raw || !path.isAbsolute(raw)) return null;
  try {
    const real = await fs.realpath(raw);
    if (!(await fs.stat(real)).isDirectory()) return null;
    return (await realRootOf(roots, real)) ? real : null;
  } catch { return null; }
}

function describe(p) {
  return { path: p, dir: path.dirname(p), name: path.basename(p) };
}

/* ── writes ─────────────────────────────────────────────────────────────── */

async function statOrNull(p) {
  try { return await fs.stat(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/** Overwrite atomically: temp file in the same directory, fsync, rename over.
 *  Keeps the existing file's permission bits. */
async function atomicReplace(target, data) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.hkl-${crypto.randomBytes(4).toString('hex')}.tmp`);
  const prev = await statOrNull(target);
  const fh = await fs.open(tmp, 'wx', prev ? prev.mode & 0o777 : 0o644);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/** Create a file that must not exist yet (exclusive create). */
async function createExclusive(target, data) {
  const fh = await fs.open(target, 'wx', 0o644);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

function uniqueCandidate(target, n) {
  if (n === 0) return target;
  const ext = path.extname(target);
  return path.join(path.dirname(target), `${path.basename(target, ext)} (${n})${ext}`);
}

/* ── request plumbing ───────────────────────────────────────────────────── */

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'too-large', 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON_BYTES);
  if (buf.length === 0) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'bad-json', 'body is not JSON'); }
}

/**
 * Create the /fs/* handler.
 * @param {object} opts
 * @param {number} opts.port            the host's listen port (Host-header gate)
 * @param {string[]} [opts.roots]       allowed roots (default HKL_FS_ROOTS or $HOME)
 * @param {string[]} [opts.origins]     allowed Origins (default list + HKL_FS_ORIGINS)
 * @param {Function|null} [opts.picker] ({mode, filter, start}) => Promise<string|null>
 * @param {string|null} [opts.pickerName]
 */
export async function createFsBridge(opts) {
  const port = opts.port;
  const rootList = opts.roots
    ?? (process.env.HKL_FS_ROOTS ? process.env.HKL_FS_ROOTS.split(path.delimiter).filter(Boolean) : [os.homedir()]);
  const roots = [];
  for (const r of rootList) {
    try { roots.push(await fs.realpath(path.resolve(r))); } catch { console.warn(`[fs-bridge] root ${r} does not exist — skipped`); }
  }
  const origins = new Set(opts.origins
    ?? [...DEFAULT_ORIGINS, ...(process.env.HKL_FS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)]);
  let pickerName = opts.pickerName;
  let picker = opts.picker;
  if (picker === undefined) {
    pickerName = detectPicker();
    picker = pickerName ? nativePicker(pickerName) : null;
  }
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const home = roots[0] ?? os.homedir();
  let pickBusy = false;

  function cors(req, res) {
    const origin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    /* Chromium's Private Network Access preflight (public page → loopback). */
    if (req.headers['access-control-request-private-network']) {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
  }

  function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function pick(mode, filter, start) {
    if (!picker) throw new HttpError(501, 'no-picker', 'no native file dialog available (install kdialog or zenity)');
    if (pickBusy) throw new HttpError(409, 'picker-busy', 'a file dialog is already open');
    pickBusy = true;
    try { return await picker({ mode, filter, start }); } finally { pickBusy = false; }
  }

  const routes = {
    'GET /fs/status': async () => ({ version: FS_BRIDGE_VERSION, picker: pickerName ?? null, home, roots }),

    'POST /fs/pick-open': async (req) => {
      const { filter, startDir } = await readJson(req);
      if (filter !== 'score' && filter !== 'musicxml') throw new HttpError(400, 'bad-filter', 'filter must be score|musicxml');
      const dir = (await gateDir(roots, startDir)) ?? home;
      const chosen = await pick('open', filter, dir.endsWith(path.sep) ? dir : dir + path.sep);
      if (!chosen) return { cancelled: true };
      const real = await gatePath(roots, chosen, READ_EXTS);
      return describe(real);
    },

    'POST /fs/pick-save': async (req) => {
      const { filter, dir: rawDir, name } = await readJson(req);
      const f = FILTERS[filter];
      if (!f || !f.ext) throw new HttpError(400, 'bad-filter', 'filter must be hkc|pdf|musicxmlOut');
      if (typeof name !== 'string' || !name || name.includes('/') || name.includes(path.sep) || name.includes('\0')) {
        throw new HttpError(400, 'bad-name', 'name must be a bare file name');
      }
      const dir = (await gateDir(roots, rawDir)) ?? home;
      let chosen = await pick('save', filter, path.join(dir, name));
      if (!chosen) return { cancelled: true };
      /* A typed name without one of the filter's extensions gets the default
         one. The dialog's overwrite confirmation covered the TYPED name, not
         this one — `appended` tells the client to write exclusively. */
      let appended = false;
      if (!f.exts.includes(path.extname(chosen).toLowerCase())) { chosen += f.ext; appended = true; }
      const real = await gatePath(roots, chosen, WRITE_EXTS);
      return { ...describe(real), appended };
    },

    'POST /fs/read': async (req) => {
      const { path: raw } = await readJson(req);
      const real = await gatePath(roots, raw, READ_EXTS);
      const st = await statOrNull(real);
      if (!st || !st.isFile()) throw new HttpError(404, 'not-found', 'file not found');
      if (st.size > MAX_READ_BYTES) throw new HttpError(413, 'too-large', 'file too large');
      const text = await fs.readFile(real, 'utf8');
      return { ...describe(real), text, mtimeMs: st.mtimeMs };
    },

    'POST /fs/write': async (req, url) => {
      const q = url.searchParams;
      const ifMtime = q.has('ifMtime') ? Number(q.get('ifMtime')) : null;
      const ifAbsent = q.get('ifAbsent') === '1';
      const unique = q.get('unique') === '1';
      if ((ifMtime !== null) + ifAbsent + unique > 1) throw new HttpError(400, 'bad-condition', 'at most one of ifMtime/ifAbsent/unique');
      if (ifMtime !== null && !Number.isFinite(ifMtime)) throw new HttpError(400, 'bad-condition', 'ifMtime must be a number');
      const target = await gatePath(roots, q.get('path'), WRITE_EXTS);
      const data = await readBody(req, MAX_WRITE_BYTES);
      let written = target;
      if (unique) {
        let n = 0;
        for (;;) {
          const cand = uniqueCandidate(target, n);
          try { await createExclusive(cand, data); written = cand; break; } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            if (++n > MAX_UNIQUE) throw new HttpError(409, 'no-unique-name', 'no free numbered name');
          }
        }
      } else if (ifAbsent) {
        try { await createExclusive(target, data); } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          const st = await statOrNull(target);
          throw new HttpError(409, 'conflict', 'file already exists', { mtimeMs: st ? st.mtimeMs : null });
        }
      } else {
        if (ifMtime !== null) {
          const st = await statOrNull(target);
          /* Sub-millisecond mtimes survive JSON as doubles; compare exactly —
             the client echoes back the value this host sent. */
          if (!st || st.mtimeMs !== ifMtime) {
            throw new HttpError(409, 'conflict', st ? 'file changed on disk' : 'file no longer exists', { mtimeMs: st ? st.mtimeMs : null });
          }
        }
        await atomicReplace(target, data);
      }
      const st = await fs.stat(written);
      return { ...describe(written), mtimeMs: st.mtimeMs };
    },
  };

  return {
    owns: (url) => url === '/fs' || url.startsWith('/fs/') || url.startsWith('/fs?'),
    async handle(req, res) {
      const url = new URL(req.url, 'http://placeholder');
      if (!hosts.has(req.headers.host ?? '')) return send(res, 403, { error: 'bad-host', message: 'bad Host header' });
      const origin = req.headers.origin;
      if (!origin || !origins.has(origin)) return send(res, 403, { error: 'bad-origin', message: 'origin not allowed' });
      cors(req, res);
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return send(res, 404, { error: 'no-route', message: 'unknown route' });
      try {
        send(res, 200, await route(req, url));
      } catch (e) {
        if (e instanceof HttpError) send(res, e.status, { error: e.code, message: e.message, ...(e.extra ?? {}) });
        else { console.error('[fs-bridge]', e); send(res, 500, { error: 'internal', message: e.message }); }
      }
    },
    roots,
    pickerName: pickerName ?? null,
  };
}
