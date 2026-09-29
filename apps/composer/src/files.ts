// Where Composer's documents live on disk.
//
// Two backends, chosen per action (never probed at page load):
//   - the overlay host's local file bridge (@hkl/bridge/local-fs.ts), when it
//     answers: files are opened by PATH through a native dialog the host spawns,
//     and Save writes back IN PLACE — the only way to do that in Firefox, which
//     has no File System Access API;
//   - otherwise the browser: <input type=file> to open, a download to save,
//     named after the file it came from or the score title.
//
// The document's binding (DocFile) is app state, never part of the MEI — a path
// is machine-local. It is reset by every document swap and set by whichever
// open/save produced the file:
//   host Load .hkc      → path + mtime (Save overwrites, mtime-conditioned)
//   host Import MusicXML→ dir + base   (first Save writes <dir>/<base>.hkc,
//                                        numbered if taken; the source is never
//                                        written)
//   browser Load/Import → base only    (download name)
//   new / transcription → nothing      (Save = Save As: dialog, <Title>.hkc)

import { createLocalFs, type LocalFs, type LocalFileWritten, type SaveFilter, type WriteCondition, type OpenFilter } from '@hkl/bridge/local-fs.js';
import type { ComposerModel } from './model/index.js';
import { downloadBlob, fileBaseFromTitle, hkcBlob } from './save.js';

export interface DocFile {
  /** The file Save overwrites (host-backed). */
  path: string | null;
  /** Its mtime as last read or written — the write condition. */
  mtimeMs: number | null;
  /** Directory the document came from (host-backed). */
  dir: string | null;
  /** Base name (no extension) to save under. */
  base: string | null;
}

export interface OpenedFile {
  text: string;
  name: string;
}

const EMPTY: DocFile = { path: null, mtimeMs: null, dir: null, base: null };
const LAST_DIR_KEY = 'hklComposerLastDir';

let fsImpl: LocalFs | null = createLocalFs();
let cur: DocFile = EMPTY;
/** One file operation at a time: a second Ctrl+S while a dialog is up would
 *  otherwise race the first. */
let inFlight = false;
let onChange: (f: DocFile) => void = () => {};

export function fileState(): DocFile { return { ...cur }; }

/** Test hook: substitute the LocalFs client; null disables the host path. */
export function setLocalFs(impl: LocalFs | null): void { fsImpl = impl; }

export function onFileChange(cb: (f: DocFile) => void): void { onChange = cb; }

function set(f: DocFile): void {
  cur = f;
  if (f.dir) {
    try { localStorage.setItem(LAST_DIR_KEY, f.dir); } catch { /* storage unavailable */ }
  }
  onChange(fileState());
}

/** A new document replaced the current one: forget its file. */
export function resetFile(): void { set(EMPTY); }

/** The browser picker loaded `name` — Save can only download, but under the
 *  same name. */
export function bindBrowserFile(name: string): void {
  set({ ...EMPTY, base: baseOf(name) });
}

function baseOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

function lastDir(): string | null {
  try { return localStorage.getItem(LAST_DIR_KEY); } catch { return null; }
}

/** Join a host-reported directory with a bare name, in the host's separator. */
function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

function errCode(e: unknown): string | undefined {
  return (e as { code?: string } | null)?.code;
}

interface Host { fs: LocalFs; picker: boolean }

async function probe(): Promise<Host | null> {
  if (!fsImpl) return null;
  const s = await fsImpl.status();
  return s ? { fs: fsImpl, picker: s.picker !== null } : null;
}

async function exclusive<T>(work: () => Promise<T>): Promise<T | 'busy'> {
  if (inFlight) return 'busy';
  inFlight = true;
  try { return await work(); } finally { inFlight = false; }
}

/* ── open ───────────────────────────────────────────────────────────────── */

/**
 * Open a file for Load (`score`) or Import (`musicxml`). Resolves:
 *   'browser' — no host (or no dialog on it): use the <input type=file> path;
 *   null      — the user cancelled the dialog;
 *   the text  — `load` has been called with it and the binding updated.
 * `load` does the document swap (which calls resetFile) — the binding is set
 * AFTER it, so the swap's reset cannot clobber it.
 */
export async function openFile(
  filter: OpenFilter,
  load: (f: OpenedFile) => Promise<void>,
): Promise<'browser' | 'busy' | null | OpenedFile> {
  return exclusive(async () => {
    const h = await probe();
    if (!h || !h.picker) return 'browser' as const;
    const ref = await h.fs.pickOpen(filter, cur.dir ?? lastDir());
    if (!ref) return null;
    const f = await h.fs.readText(ref.path);
    const opened = { text: f.text, name: f.name };
    await load(opened);
    set(filter === 'score'
      ? { path: f.path, mtimeMs: f.mtimeMs, dir: f.dir, base: baseOf(f.name) }
      : { path: null, mtimeMs: null, dir: f.dir, base: baseOf(f.name) });
    return opened;
  });
}

/* ── save ───────────────────────────────────────────────────────────────── */

/** Write with a conflict prompt: a 409 asks before overwriting unconditionally.
 *  Resolves null when the user declines. */
async function writeConfirmed(
  fs: LocalFs, path: string, blob: () => Blob, cond: WriteCondition, conflictMsg: (gone: boolean) => string,
): Promise<LocalFileWritten | null> {
  try {
    return await fs.write(path, blob(), cond);
  } catch (e) {
    if (errCode(e) !== 'conflict') throw e;
    const gone = (e as { mtimeMs?: number | null }).mtimeMs == null;
    if (!window.confirm(conflictMsg(gone))) return null;
    return fs.write(path, blob(), { kind: 'overwrite' });
  }
}

function baseName(): string {
  return cur.base ?? '';
}

/**
 * Save (`as` false) or Save As (`as` true). Resolves the status line to show.
 */
export async function saveDocument(model: ComposerModel, as: boolean): Promise<string> {
  const r = await exclusive(async () => {
    const base = baseName() || fileBaseFromTitle(model.getTitle());
    const h = await probe();
    const blob = (): Blob => hkcBlob(model);

    if (h && !as && cur.path) {
      const name = cur.path.slice(Math.max(cur.path.lastIndexOf('/'), cur.path.lastIndexOf('\\')) + 1);
      const w = await writeConfirmed(h.fs, cur.path, blob,
        cur.mtimeMs !== null ? { kind: 'ifMtime', mtimeMs: cur.mtimeMs } : { kind: 'overwrite' },
        (gone) => gone
          ? `${name} no longer exists on disk. Save it there anyway?`
          : `${name} changed on disk since it was opened or last saved. Overwrite it with this version?`);
      if (!w) return 'Save cancelled — the file on disk was left as it is.';
      set({ path: w.path, mtimeMs: w.mtimeMs, dir: w.dir, base: baseOf(w.name) });
      return 'Saved ' + w.path;
    }

    if (h && !as && cur.dir && cur.base) {
      /* Imported beside a source: <dir>/<base>.hkc, numbered when taken. */
      const w = await h.fs.write(joinPath(cur.dir, base + '.hkc'), blob(), { kind: 'unique' });
      set({ path: w.path, mtimeMs: w.mtimeMs, dir: w.dir, base: baseOf(w.name) });
      return 'Saved ' + w.path;
    }

    if (h && h.picker) {
      const chosen = await h.fs.pickSave('hkc', base + '.hkc', cur.dir ?? lastDir());
      if (!chosen) return 'Save cancelled.';
      /* The dialog confirmed overwriting the name it returned — unless the host
         had to add the extension, in which case the final name is unconfirmed. */
      const w = await writeConfirmed(h.fs, chosen.path, blob,
        chosen.appended ? { kind: 'ifAbsent' } : { kind: 'overwrite' },
        () => `${chosen.name} already exists. Replace it?`);
      if (!w) return 'Save cancelled.';
      set({ path: w.path, mtimeMs: w.mtimeMs, dir: w.dir, base: baseOf(w.name) });
      return 'Saved ' + w.path;
    }

    downloadBlob(base + '.hkc', blob());
    return 'Downloaded ' + base + '.hkc'
      + (h ? ' (the local host has no file dialog — install kdialog or zenity)' : '');
  });
  return r === 'busy' ? 'A file operation is already in progress.' : r;
}

/* ── export ─────────────────────────────────────────────────────────────── */

const EXPORT_EXT: Record<'pdf' | 'musicxml', { filter: SaveFilter; ext: string }> = {
  pdf: { filter: 'pdf', ext: '.pdf' },
  musicxml: { filter: 'musicxmlOut', ext: '.musicxml' },
};

/**
 * Export a derived file. With the host: a save dialog suggesting
 * <base>.<ext> beside the document, THEN `make` (so a cancel costs no render).
 * Never written silently — after a MusicXML import the suggested name is the
 * source's own, and a lossy export must not replace it unasked. Without the
 * host: `make`, then a download. Resolves the status line, or null on cancel.
 */
export async function exportDocument(
  model: ComposerModel, kind: 'pdf' | 'musicxml', make: () => Promise<Blob>,
): Promise<string | null> {
  const r = await exclusive(async () => {
    const { filter, ext } = EXPORT_EXT[kind];
    const base = baseName() || fileBaseFromTitle(model.getTitle());
    const h = await probe();
    if (h && h.picker) {
      const chosen = await h.fs.pickSave(filter, base + ext, cur.dir ?? lastDir());
      if (!chosen) return null;
      const data = await make();
      const w = await writeConfirmed(h.fs, chosen.path, () => data,
        chosen.appended ? { kind: 'ifAbsent' } : { kind: 'overwrite' },
        () => `${chosen.name} already exists. Replace it?`);
      if (!w) return null;
      try { localStorage.setItem(LAST_DIR_KEY, w.dir); } catch { /* storage unavailable */ }
      return 'Exported ' + w.path;
    }
    downloadBlob(base + ext, await make());
    return 'Exported ' + base + ext;
  });
  return r === 'busy' ? 'A file operation is already in progress.' : r;
}
