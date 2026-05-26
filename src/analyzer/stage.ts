// Stage — owns the single mutable AnalyzerState + a pub/sub.
// View modules read via getState() and mutate via the helpers below, which
// notify all subscribers on change. Mirrors the instrumentRegistry.onChange
// pattern (src/state/instrumentRegistry.ts:90).

import type { AnalyzerState, ConfigState, SampleSlot, SourceState, GateOpts } from './state.js';
import { initialState } from './state.js';

let _state: AnalyzerState = initialState();
const listeners = new Set<() => void>();

/** Read-only snapshot of current state. */
export function getState(): Readonly<AnalyzerState> {
  return _state;
}

function notify(): void {
  for (const fn of listeners) {
    try { fn(); }
    catch (e) { console.error('analyzer stage listener error', e); }
  }
}

/** Subscribe to any state change. Returns unsubscribe. */
export function onChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Replace the entire state. Rare — prefer setConfig/setSource/etc. */
export function setState(patch: Partial<AnalyzerState>): void {
  _state = { ..._state, ...patch };
  notify();
}

export function setConfig(patch: Partial<ConfigState>): void {
  _state = { ..._state, config: { ..._state.config, ...patch } };
  notify();
}

export function setSource(source: SourceState): void {
  _state = { ..._state, source };
  notify();
}

export function setOpts(patch: Partial<GateOpts>): void {
  _state = { ..._state, opts: { ..._state.opts, ...patch } };
  notify();
}

export function setAutoSelectEnabled(v: boolean): void {
  _state = { ..._state, autoSelectEnabled: v };
  notify();
}

export function setStatus(text: string, progress?: number): void {
  _state = { ..._state, status: text, progress: progress ?? _state.progress };
  notify();
}

export function setProgress(p: number): void {
  _state = { ..._state, progress: p };
  notify();
}

/** Replace the entire samples array. Used when source changes. */
export function setSamples(samples: SampleSlot[]): void {
  _state = { ..._state, samples };
  notify();
}

/** Patch a single sample slot by index. No-op if index is OOB. */
export function updateSample(index: number, patch: Partial<SampleSlot>): void {
  if (index < 0 || index >= _state.samples.length) return;
  const next = _state.samples.slice();
  next[index] = { ...next[index], ...patch };
  _state = { ..._state, samples: next };
  notify();
}

/** Patch a sample slot by name. No-op if not found. */
export function updateSampleByName(name: string, patch: Partial<SampleSlot>): void {
  const idx = _state.samples.findIndex(s => s.name === name);
  if (idx >= 0) updateSample(idx, patch);
}

/** Batch-update many slots in one notify pass. */
export function updateSamples(updater: (s: SampleSlot, i: number) => Partial<SampleSlot> | null): void {
  const next = _state.samples.map((s, i) => {
    const p = updater(s, i);
    return p ? { ...s, ...p } : s;
  });
  _state = { ..._state, samples: next };
  notify();
}

/** Reset everything to defaults — used by the Source section's Clear button. */
export function reset(): void {
  _state = initialState();
  notify();
}

/** Replace the entire state with a loaded draft. Called once at boot, BEFORE
 *  any view subscribes, so listeners fire just once at the end. */
export function hydrate(state: AnalyzerState): void {
  _state = state;
  notify();
}
