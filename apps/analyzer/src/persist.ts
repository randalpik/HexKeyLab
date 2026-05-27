// IndexedDB-backed draft persistence for the analyzer.
//
// Stores the full AnalyzerState (minus AudioBuffer references — those aren't
// structured-cloneable, so the audioBuffer field is stripped at save time
// and rehydrated on demand). File objects ARE structured-cloneable (Blob
// data rides along), so local-source File handles round-trip intact —
// reload and the user's dropped files are still there with their bytes.
//
// One row per origin under key 'current'. Single-tab assumption; if the
// user opens multiple analyzer tabs, last-write wins.

import type { AnalyzerState, SampleSlot } from './state.js';

const DB_NAME = 'hkl-analyzer-drafts';
const STORE = 'drafts';
const VERSION = 2;
const SINGLE_KEY = 'current';

let _db: IDBDatabase | null = null;

function open(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      /* Drop any previous-version store contents — schema changed (used to
         store JSON strings under arbitrary keys; now stores AnalyzerState
         objects under SINGLE_KEY). */
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      db.createObjectStore(STORE);
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

/** Strip non-cloneable fields from each sample. AudioBuffer is the offender;
 *  everything else (File handles, result objects, Float32Array trend data)
 *  survives structured clone. */
function sanitizeForPersist(state: AnalyzerState): AnalyzerState {
  const samples: SampleSlot[] = state.samples.map(s => ({
    ...s,
    audioBuffer: undefined,
  }));
  return { ...state, samples };
}

/** Save the current state. Idempotent — overwrites any existing draft. */
export async function saveDraft(state: AnalyzerState): Promise<void> {
  try {
    const db = await open();
    const sanitized = sanitizeForPersist(state);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(sanitized, SINGLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    /* Persistence is best-effort — don't crash the app if IDB is unavailable
       (private browsing, quota exceeded, etc.). */
    console.warn('analyzer draft save failed:', e);
  }
}

/** Load the persisted state, or null if none. */
export async function loadDraft(): Promise<AnalyzerState | null> {
  try {
    const db = await open();
    return await new Promise<AnalyzerState | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(SINGLE_KEY);
      req.onsuccess = () => resolve((req.result as AnalyzerState | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('analyzer draft load failed:', e);
    return null;
  }
}

/** Wipe the persisted draft (called by the Clear button). */
export async function clearDraft(): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(SINGLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('analyzer draft clear failed:', e);
  }
}
