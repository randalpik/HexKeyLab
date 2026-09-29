// Browser client for the overlay host's local file bridge
// (apps/overlay-host/src/fs-bridge.mjs — the wire protocol is documented there).
//
// Firefox exposes neither a picked file's path nor any way to write outside
// Downloads; the host does both. This client is only ever called from a user
// action (Save / Load / Export): nothing probes localhost at page load, so a
// public visitor with no host running never pokes 127.0.0.1 unprompted.
//
// The host is the same process as the overlay relay, so it shares the relay's
// port resolution: ?obsrelay=PORT / localStorage.hklOverlayPort, else
// OVERLAY_RELAY_PORT.

import { OVERLAY_RELAY_PORT } from './overlay-protocol.js';
import { readPortOverride } from './overlay-ws.js';

export interface LocalFsStatus {
  version: number;
  /** Native dialog tool the host found (kdialog / zenity / yad), or null. */
  picker: string | null;
  home: string;
  roots: string[];
}

/** A file on disk as the host reports it. `dir` / `name` come from the host so
 *  the client never splits native paths itself. */
export interface LocalFileRef {
  path: string;
  dir: string;
  name: string;
}

export interface LocalFileText extends LocalFileRef {
  text: string;
  mtimeMs: number;
}

export interface LocalFileWritten extends LocalFileRef {
  mtimeMs: number;
}

export type OpenFilter = 'score' | 'musicxml';
export type SaveFilter = 'hkc' | 'pdf' | 'musicxmlOut';

/** How a write treats an existing target. `ifMtime`: must still carry the
 *  mtime we read (409 otherwise). `ifAbsent`: must not exist. `unique`: first
 *  free of `name.ext`, `name (1).ext`, … `overwrite`: unconditional (the user
 *  already confirmed, e.g. in the native save dialog). */
export type WriteCondition =
  | { kind: 'ifMtime'; mtimeMs: number }
  | { kind: 'ifAbsent' }
  | { kind: 'unique' }
  | { kind: 'overwrite' };

export class LocalFsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Present on a 409 conflict: the file's current mtime (null = gone). */
    readonly mtimeMs?: number | null,
  ) {
    super(message);
  }
}

/** The injectable surface Composer calls. `createLocalFs()` is the real one;
 *  tests substitute a mock. */
export interface LocalFs {
  /** null when no host answers (not running, or an old host without /fs). */
  status(): Promise<LocalFsStatus | null>;
  /** null on cancel. */
  pickOpen(filter: OpenFilter, startDir?: string | null): Promise<LocalFileRef | null>;
  /** null on cancel. `appended`: the host added the extension to a typed name,
   *  so the dialog's overwrite confirmation did not cover the final path. */
  pickSave(filter: SaveFilter, name: string, dir?: string | null): Promise<(LocalFileRef & { appended: boolean }) | null>;
  readText(path: string): Promise<LocalFileText>;
  write(path: string, data: Blob | string, cond: WriteCondition): Promise<LocalFileWritten>;
}

function hostBase(): string {
  return `http://127.0.0.1:${readPortOverride() ?? OVERLAY_RELAY_PORT}`;
}

async function call<T>(route: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(hostBase() + route, { ...init, cache: 'no-store' });
  } catch (e) {
    throw new LocalFsError(0, 'unreachable', 'local file host not reachable: ' + (e as Error).message);
  }
  let body: Record<string, unknown> | null = null;
  try { body = await res.json(); } catch { /* non-JSON (e.g. an old host's static 404) */ }
  if (!res.ok || !body) {
    throw new LocalFsError(res.status, String(body?.error ?? 'http-' + res.status),
      String(body?.message ?? res.statusText), body?.mtimeMs as number | null | undefined);
  }
  return body as T;
}

const postJson = <T>(route: string, payload: unknown): Promise<T> => call<T>(route, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

export function createLocalFs(): LocalFs {
  return {
    async status() {
      try {
        const s = await call<LocalFsStatus>('/fs/status', { method: 'GET', signal: AbortSignal.timeout(1500) });
        return typeof s.version === 'number' ? s : null;
      } catch {
        return null;
      }
    },
    async pickOpen(filter, startDir) {
      const r = await postJson<LocalFileRef | { cancelled: true }>('/fs/pick-open', { filter, startDir: startDir ?? undefined });
      return 'cancelled' in r ? null : r;
    },
    async pickSave(filter, name, dir) {
      const r = await postJson<(LocalFileRef & { appended: boolean }) | { cancelled: true }>(
        '/fs/pick-save', { filter, name, dir: dir ?? undefined });
      return 'cancelled' in r ? null : r;
    },
    readText(path) {
      return postJson<LocalFileText>('/fs/read', { path });
    },
    write(path, data, cond) {
      let q = '?path=' + encodeURIComponent(path);
      if (cond.kind === 'ifMtime') q += '&ifMtime=' + cond.mtimeMs;
      else if (cond.kind === 'ifAbsent') q += '&ifAbsent=1';
      else if (cond.kind === 'unique') q += '&unique=1';
      return call<LocalFileWritten>('/fs/write' + q, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: data,
      });
    },
  };
}
