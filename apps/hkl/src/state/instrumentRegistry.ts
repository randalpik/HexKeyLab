// IndexedDB-backed registry of imported `.hki` sample bundles.
//
// User imports a `.hki` file → registry stores the manifest (and its audio
// bytes) keyed by `instrumentKey`. The HKL dropdown reads `listImported()`
// synchronously after `init()` resolves; the sample engine pulls audio
// on-demand via `getAudio(key)` when the user actually selects an imported
// instrument.
//
// Persists across sessions. Replaces same-key on re-import (idempotent).

import { readHki, type HkiManifest, type HkiBundle } from '@hkl/shared/hki.js';

const DB_NAME = 'hkl-instrument-registry';
const DB_VERSION = 1;
const STORE_MANIFESTS = 'manifests';
const STORE_AUDIO = 'audio';

interface AudioRecord {
  /** Composite key: `${instrumentKey}/${sampleFile}` (e.g. 'mq-piano/samples/C4.opus'). */
  id: string;
  instrumentKey: string;
  file: string;
  bytes: Uint8Array;
}

interface ManifestRecord {
  instrumentKey: string;
  manifest: HkiManifest;
  importedAt: string;
  /** Total audio byte size — surfaced in the manage-imported UI. */
  audioBytes: number;
}

let db: IDBDatabase | null = null;
let manifestCache: Map<string, ManifestRecord> = new Map();
const changeListeners = new Set<() => void>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE_MANIFESTS)) {
        d.createObjectStore(STORE_MANIFESTS, { keyPath: 'instrumentKey' });
      }
      if (!d.objectStoreNames.contains(STORE_AUDIO)) {
        const s = d.createObjectStore(STORE_AUDIO, { keyPath: 'id' });
        s.createIndex('byInstrument', 'instrumentKey', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txStore<T = unknown>(storeName: string, mode: IDBTransactionMode): IDBObjectStore {
  if (!db) throw new Error('instrumentRegistry: init() must be called before use');
  return db.transaction(storeName, mode).objectStore(storeName);
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Open the database and warm the manifest cache. Call once at startup. */
export async function init(): Promise<void> {
  if (db) return;
  db = await openDb();
  const all = await req<ManifestRecord[]>(txStore(STORE_MANIFESTS, 'readonly').getAll() as IDBRequest<ManifestRecord[]>);
  manifestCache = new Map(all.map(r => [r.instrumentKey, r]));
}

/**
 * Re-read the manifest cache from IndexedDB. Used by the analyzer bridge
 * handler in HKL after the Analyzer tab writes a new bundle — the HKL tab's
 * in-memory cache is stale until reload picks up the cross-tab IDB write.
 * Fires onChange so the dropdown rebuilds. No-op if init() hasn't run yet.
 */
export async function reload(): Promise<void> {
  if (!db) return;
  const all = await req<ManifestRecord[]>(txStore(STORE_MANIFESTS, 'readonly').getAll() as IDBRequest<ManifestRecord[]>);
  manifestCache = new Map(all.map(r => [r.instrumentKey, r]));
  notify();
}

/** Synchronous listing for dropdown rendering. Requires `init()` to have resolved. */
export function listImported(): ManifestRecord[] {
  return [...manifestCache.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

export function getImportedManifest(key: string): HkiManifest | undefined {
  return manifestCache.get(key)?.manifest;
}

export function hasImported(key: string): boolean {
  return manifestCache.has(key);
}

/** Subscribe to add/remove notifications so UI can refresh. Returns unsubscribe. */
export function onChange(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function notify(): void {
  for (const fn of changeListeners) {
    try { fn(); } catch (e) { console.error('instrumentRegistry listener error', e); }
  }
}

/**
 * Import a .hki bundle from raw bytes (e.g. a File chosen by the user).
 * Validates the bundle, replaces any existing entry with the same
 * instrumentKey, and notifies listeners.
 */
export async function importBundle(bytes: Uint8Array): Promise<HkiManifest> {
  const bundle = readHki(bytes);
  const manifest = bundle.manifest;
  const audioBytes = sumAudioBytes(bundle);

  /* Stage 1: drop any previous audio rows for this key (replace-by-key). */
  const dropTx = db!.transaction([STORE_MANIFESTS, STORE_AUDIO], 'readwrite');
  const audioStore = dropTx.objectStore(STORE_AUDIO);
  const idx = audioStore.index('byInstrument');
  await new Promise<void>((resolve, reject) => {
    const c = idx.openCursor(IDBKeyRange.only(manifest.instrumentKey));
    c.onsuccess = () => {
      const cursor = c.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
      else resolve();
    };
    c.onerror = () => reject(c.error);
  });

  /* Stage 2: write the new manifest + audio rows. */
  const record: ManifestRecord = {
    instrumentKey: manifest.instrumentKey,
    manifest,
    importedAt: new Date().toISOString(),
    audioBytes,
  };
  dropTx.objectStore(STORE_MANIFESTS).put(record);
  for (const s of manifest.samples) {
    const audio = bundle.audio[s.file];
    if (!audio) continue;
    audioStore.put({
      id: `${manifest.instrumentKey}/${s.file}`,
      instrumentKey: manifest.instrumentKey,
      file: s.file,
      bytes: audio,
    } as AudioRecord);
  }
  await new Promise<void>((resolve, reject) => {
    dropTx.oncomplete = () => resolve();
    dropTx.onerror = () => reject(dropTx.error);
    dropTx.onabort = () => reject(dropTx.error);
  });

  manifestCache.set(manifest.instrumentKey, record);
  notify();
  return manifest;
}

/** Remove an imported bundle entirely. */
export async function removeBundle(key: string): Promise<void> {
  if (!manifestCache.has(key)) return;
  const tx = db!.transaction([STORE_MANIFESTS, STORE_AUDIO], 'readwrite');
  tx.objectStore(STORE_MANIFESTS).delete(key);
  const idx = tx.objectStore(STORE_AUDIO).index('byInstrument');
  await new Promise<void>((resolve, reject) => {
    const c = idx.openCursor(IDBKeyRange.only(key));
    c.onsuccess = () => {
      const cursor = c.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
      else resolve();
    };
    c.onerror = () => reject(c.error);
  });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  manifestCache.delete(key);
  notify();
}

/**
 * Fetch the audio bytes for an imported instrument. Used by the sample engine
 * at instrument-load time. Returns `null` if the instrument isn't imported.
 */
export async function getAudio(key: string): Promise<Record<string, Uint8Array> | null> {
  if (!manifestCache.has(key)) return null;
  const idx = txStore(STORE_AUDIO, 'readonly').index('byInstrument');
  const rows = await req<AudioRecord[]>(idx.getAll(IDBKeyRange.only(key)) as IDBRequest<AudioRecord[]>);
  const out: Record<string, Uint8Array> = {};
  for (const r of rows) out[r.file] = r.bytes;
  return out;
}

function sumAudioBytes(bundle: HkiBundle): number {
  let n = 0;
  for (const k in bundle.audio) n += bundle.audio[k].byteLength;
  return n;
}

export type { ManifestRecord };
