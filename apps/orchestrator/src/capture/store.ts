// In-memory lossless capture store, keyed by captureId. This is the lossless
// intermediate (raw Float32 PCM) the analysis stage consumes — deliberately NOT
// in the observable session state or localStorage (a full keyboard × layers of
// PCM is tens to hundreds of MB). Lives for the page session.

import type { CaptureRecord } from '../device/types.js';
import type { JobOutcome } from './loop.js';   // type-only — erased, no runtime cycle

const store = new Map<string, CaptureRecord>();
const outcomes = new Map<string, JobOutcome>();

export function putCapture(id: string, rec: CaptureRecord): void { store.set(id, rec); }
export function getCapture(id: string): CaptureRecord | undefined { return store.get(id); }
export function hasCapture(id: string): boolean { return store.has(id); }
export function deleteCapture(id: string): void { store.delete(id); }
export function captureIds(): string[] { return [...store.keys()]; }
export function clearCaptures(): void { store.clear(); }

/** Total captured PCM bytes (Float32 = 4 bytes/sample across channels). */
export function totalBytes(): number {
  let n = 0;
  for (const rec of store.values()) for (const ch of rec.channels) n += ch.length * 4;
  return n;
}

// Gate outcomes, kept alongside the PCM so the Export step can read what Capture
// produced (the PCM alone has no gate/job context).
export function putOutcome(o: JobOutcome): void { outcomes.set(o.job.captureId, o); }
export function listOutcomes(): JobOutcome[] { return [...outcomes.values()]; }
export function clearOutcomes(): void { outcomes.clear(); }
