// IndexedDB-backed registry of runtime-imported CDN-source instrument configs.
//
// Sibling of src/state/instrumentRegistry.ts. Where instrumentRegistry stores
// .hki bundles (manifest + audio bytes), cdnConfigRegistry stores
// CdnInstrumentConfig JSON only — audio is fetched per-sample at playback
// time via the engine's existing CDN path (baseUrl + filePattern).
//
// User imports a config via the Analyzer's "Send to HKL" bridge or HKL's
// "+ JSON config" file picker → registry stores the config keyed by
// instrumentKey. The INSTRUMENTS proxy (src/audio/samples-data.ts) consults
// this registry as a fallback after the static map and HKI registry, so
// the engine sees imported CDN configs through the same surface as
// compile-time entries.

import type { CdnInstrumentConfig } from '@hkl/shared/cdnConfig.js';
import { parseCdnConfig } from '@hkl/shared/cdnConfig.js';

const DB_NAME = 'hkl-cdn-config-registry';
const DB_VERSION = 1;
const STORE = 'configs';

export interface ConfigRecord {
  instrumentKey: string;
  config: CdnInstrumentConfig;
  importedAt: string;
}

let db: IDBDatabase | null = null;
let cache: Map<string, ConfigRecord> = new Map();
const changeListeners = new Set<() => void>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) {
        d.createObjectStore(STORE, { keyPath: 'instrumentKey' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqAsync<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function readAllFromDb(): Promise<ConfigRecord[]> {
  if (!db) throw new Error('cdnConfigRegistry: init() must be called before use');
  return reqAsync<ConfigRecord[]>(
    db.transaction(STORE, 'readonly').objectStore(STORE).getAll() as IDBRequest<ConfigRecord[]>,
  );
}

/** Open the database and warm the cache. Call once at startup (init.ts). */
export async function init(): Promise<void> {
  if (db) return;
  db = await openDb();
  const all = await readAllFromDb();
  cache = new Map(all.map(r => [r.instrumentKey, r]));
}

/** Synchronous listing for dropdown rendering. Requires init() to have resolved. */
export function listImported(): ConfigRecord[] {
  return [...cache.values()].sort((a, b) => a.config.name.localeCompare(b.config.name));
}

export function getConfig(key: string): CdnInstrumentConfig | undefined {
  return cache.get(key)?.config;
}

export function getRecord(key: string): ConfigRecord | undefined {
  return cache.get(key);
}

export function hasConfig(key: string): boolean {
  return cache.has(key);
}

/** Subscribe to add/remove notifications so UI can refresh. Returns unsubscribe. */
export function onChange(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function notify(): void {
  for (const fn of changeListeners) {
    try { fn(); } catch (e) { console.error('cdnConfigRegistry listener error', e); }
  }
}

/**
 * Import a CDN config. Validates the config shape (via parseCdnConfig if a
 * string is passed; otherwise the object is assumed already validated by
 * the caller). Replace-by-key is idempotent. Fires onChange listeners.
 */
export async function importConfig(input: CdnInstrumentConfig | string): Promise<CdnInstrumentConfig> {
  const cfg = typeof input === 'string' ? parseCdnConfig(input) : input;
  if (!db) throw new Error('cdnConfigRegistry: init() must be called before use');
  const record: ConfigRecord = {
    instrumentKey: cfg.instrumentKey,
    config: cfg,
    importedAt: new Date().toISOString(),
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db!.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  cache.set(cfg.instrumentKey, record);
  notify();
  return cfg;
}

/** Remove an imported config. */
export async function removeConfig(key: string): Promise<void> {
  if (!cache.has(key)) return;
  if (!db) throw new Error('cdnConfigRegistry: init() must be called before use');
  await new Promise<void>((resolve, reject) => {
    const tx = db!.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  cache.delete(key);
  notify();
}

/**
 * Re-read the cache from IndexedDB. Used by the analyzer bridge handler in
 * HKL after the Analyzer tab writes a config — the HKL tab's in-memory
 * cache is stale until reload picks up the cross-tab IDB write. Fires
 * onChange so the dropdown rebuilds.
 */
export async function reload(): Promise<void> {
  if (!db) return;
  const all = await readAllFromDb();
  cache = new Map(all.map(r => [r.instrumentKey, r]));
  notify();
}
