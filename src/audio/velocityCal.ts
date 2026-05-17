// Velocity calibration: global curve + per-key gain + auto-capture + per-key
// velocity statistics.
//
// Two stages, applied at audio-engine entry (noteOn) so MIDI input, QWERTY,
// mouse, and recording playback all benefit:
//   1. Per-key gain — multiplicative scalar on incoming velocity (default 1.0).
//      Smooths out per-key mechanical variance on the physical Lumatone, since
//      the firmware has no per-key threshold commands.
//   2. Global curve — replaces the prior hardcoded `0.10 + 0.90·(v/127)²` in
//      velocityBaseVol with `floor + (ceiling - floor) · (v/127)^gamma`.
//
// Raw velocity is preserved in audio.keyVelocity[key] — recording captures the
// raw value so playback can re-apply whatever transform is current at playback
// time. The transform is *not* applied at MIDI ingestion.
//
// Auto-capture: while capturing, every note-on velocity is appended to a
// per-key list. On stop, per-key gain = clamp(target / median(samples), 0.3..3.0)
// so a single hard press doesn't zero out the key.
//
// Per-key velocity statistics: separate from auto-capture. When statsEnabled,
// every real MIDI note-on velocity feeds a ring buffer (KEY_HISTORY_CAP per
// key). We compute mean / stddev / CV on demand. Surfaces "which keys are
// noisy in velocity output" (high CV → consider raising hardware MIN) and
// "which keys are loudness outliers" (mean drift → per-key gain candidate).
// Snapshot stats persist to localStorage; raw samples are session-only.

import { savePrefs, loadPrefs, type VelocityCalPrefs, type KeyStatsSnapshot } from '../state/persistence.js';
import type { KeyId } from '../types.js';

export interface VelocityCalState {
  /** Audio gain at velocity = 1 (smallest non-zero). 0..1. Default 0.10. */
  floor: number;
  /** Audio gain at velocity = 127. 0..1. Default 1.0. */
  ceiling: number;
  /** Curve exponent. > 1 = soft notes get quieter; default 2.0 (matches prior
   *  hardcoded quadratic curve). */
  gamma: number;
  /** Multiplicative velocity gain per key. Absent entries default to 1.0. */
  perKey: Record<KeyId, number>;
}

export const DEFAULT_CAL: VelocityCalState = {
  floor: 0.10,
  ceiling: 1.0,
  gamma: 2.0,
  perKey: {},
};

const state: VelocityCalState = {
  floor: DEFAULT_CAL.floor,
  ceiling: DEFAULT_CAL.ceiling,
  gamma: DEFAULT_CAL.gamma,
  perKey: {},
};

/* Capture session state — lives in-module, not persisted. */
let capturing = false;
const captures: Map<KeyId, number[]> = new Map();

const PER_KEY_GAIN_MIN = 0.3;
const PER_KEY_GAIN_MAX = 3.0;

/* Per-key velocity statistics.
   - `statsEnabled` and `snapshots` persist to localStorage.
   - `samples` (raw ring buffers) are session-only — too bulky to persist, and
     they're regenerated on the fly as the user plays.
   - `statsDirty` lets the lumadiag panel decide when to rebuild snapshots
     and re-persist (cheap in aggregate; we don't want a localStorage write
     per note-on). */
const KEY_HISTORY_CAP = 64;
export const STATS_MIN_N = 5;
export const STATS_HIGH_CV = 0.3;

let statsEnabled = false;
let snapshots: Record<KeyId, KeyStatsSnapshot> = {};
const samples: Map<KeyId, number[]> = new Map();
let statsDirty = false;

export interface KeyStats {
  n: number;
  mean: number;
  stddev: number;
  /** Coefficient of variation, stddev/mean. -1 when undefined (n < STATS_MIN_N or mean <= 0). */
  cv: number;
  min: number;
  max: number;
  /** 5th and 95th percentiles. Outlier-rejecting bounds on the realistic
   *  velocity range for normal play. For n < STATS_MIN_N, falls back to min/max. */
  p5: number;
  p95: number;
}

function computeStats(arr: number[]): KeyStats {
  const n = arr.length;
  if (n === 0) return { n: 0, mean: 0, stddev: 0, cv: -1, min: 0, max: 0, p5: 0, p95: 0 };
  let sum = 0, min = arr[0], max = arr[0];
  for (let i = 0; i < n; i++) {
    sum += arr[i];
    if (arr[i] < min) min = arr[i];
    if (arr[i] > max) max = arr[i];
  }
  const mean = sum / n;
  if (n < STATS_MIN_N) return { n, mean, stddev: 0, cv: -1, min, max, p5: min, p95: max };
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = arr[i] - mean;
    sumSq += d * d;
  }
  const stddev = Math.sqrt(sumSq / (n - 1));
  const cv = mean > 0 ? stddev / mean : -1;
  const sorted = arr.slice().sort((a, b) => a - b);
  const p5 = sorted[Math.round(0.05 * (n - 1))];
  const p95 = sorted[Math.round(0.95 * (n - 1))];
  return { n, mean, stddev, cv, min, max, p5, p95 };
}

/* Clamp + integer-snap. Velocity is a 7-bit MIDI value with no fractional
   meaning; `noteOn` callers expect integers. */
function clampVel(v: number): number {
  if (v <= 0) return 0;
  if (v >= 127) return 127;
  return Math.max(1, Math.round(v));
}

function persist(): void {
  savePrefs({ velocityCal: {
    floor: state.floor,
    ceiling: state.ceiling,
    gamma: state.gamma,
    perKey: { ...state.perKey },
    statsEnabled,
    stats: Object.keys(snapshots).length > 0 ? { ...snapshots } : undefined,
  }});
}

function loadFromPrefs(): void {
  const prefs = loadPrefs();
  const v = prefs.velocityCal;
  if (!v) return;
  if (typeof v.floor === 'number') state.floor = v.floor;
  if (typeof v.ceiling === 'number') state.ceiling = v.ceiling;
  if (typeof v.gamma === 'number') state.gamma = v.gamma;
  if (v.perKey && typeof v.perKey === 'object') {
    state.perKey = {};
    for (const k of Object.keys(v.perKey)) {
      const g = v.perKey[k];
      if (typeof g === 'number' && g > 0 && g < 10) state.perKey[k] = g;
    }
  }
  if (typeof v.statsEnabled === 'boolean') statsEnabled = v.statsEnabled;
  if (v.stats && typeof v.stats === 'object') {
    snapshots = { ...v.stats };
  }
}

export const velocityCal = {
  /* Read-only views for UI. */
  get floor(): number { return state.floor; },
  get ceiling(): number { return state.ceiling; },
  get gamma(): number { return state.gamma; },
  get perKey(): Readonly<Record<KeyId, number>> { return state.perKey; },
  get capturing(): boolean { return capturing; },
  get capturedKeyCount(): number { return captures.size; },
  get calibratedKeyCount(): number { return Object.keys(state.perKey).length; },

  /* Curve setters — caller is responsible for sensible ranges; the panel
     constrains via slider min/max. */
  setFloor(v: number): void { state.floor = v; persist(); },
  setCeiling(v: number): void { state.ceiling = v; persist(); },
  setGamma(v: number): void { state.gamma = v; persist(); },

  resetCurve(): void {
    state.floor = DEFAULT_CAL.floor;
    state.ceiling = DEFAULT_CAL.ceiling;
    state.gamma = DEFAULT_CAL.gamma;
    persist();
  },

  clearPerKey(): void {
    state.perKey = {};
    persist();
  },

  /* Stage 1: per-key gain. Returns adjusted velocity (clamped 0..127). */
  applyPerKeyGain(key: KeyId, v: number): number {
    if (v <= 0) return 0;
    const g = state.perKey[key];
    if (g === undefined || g === 1.0) return clampVel(v);
    return clampVel(v * g);
  },

  /* Stage 2: curve. Returns audio gain 0..1. */
  curveGain(v: number): number {
    if (v <= 0) return 0;
    const vn = clampVel(v) / 127;
    return state.floor + (state.ceiling - state.floor) * Math.pow(vn, state.gamma);
  },

  /* Capture controls. */
  startCapture(): void {
    capturing = true;
    captures.clear();
  },

  cancelCapture(): void {
    capturing = false;
    captures.clear();
  },

  /* Called from MIDI note-on path while capturing. No-op otherwise. */
  recordSample(key: KeyId, rawVelocity: number): void {
    if (!capturing) return;
    if (rawVelocity <= 0) return;
    let arr = captures.get(key);
    if (!arr) { arr = []; captures.set(key, arr); }
    arr.push(rawVelocity);
  },

  /* Stops capture, computes per-key gains from medians, and merges into state.
     Returns the number of keys for which a gain was assigned (or revised). */
  stopCaptureAndCompute(targetVel: number): number {
    if (!capturing) return 0;
    capturing = false;
    let count = 0;
    for (const [key, capSamples] of captures) {
      if (capSamples.length === 0) continue;
      const sorted = capSamples.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (median <= 0) continue;
      const raw = targetVel / median;
      const gain = raw < PER_KEY_GAIN_MIN ? PER_KEY_GAIN_MIN
                 : raw > PER_KEY_GAIN_MAX ? PER_KEY_GAIN_MAX
                 : raw;
      state.perKey[key] = gain;
      count++;
    }
    captures.clear();
    persist();
    return count;
  },

  /* ── Per-key velocity statistics ──────────────────────────────────────── */

  get statsEnabled(): boolean { return statsEnabled; },

  setStatsEnabled(on: boolean): void {
    statsEnabled = on;
    persist();
  },

  /* Called from MIDI note-on path alongside `recordSample`. No-op unless
     statsEnabled. Ring-buffer per key capped at KEY_HISTORY_CAP. */
  recordForStats(key: KeyId, rawVelocity: number): void {
    if (!statsEnabled) return;
    if (rawVelocity <= 0) return;
    let arr = samples.get(key);
    if (!arr) { arr = []; samples.set(key, arr); }
    arr.push(rawVelocity);
    if (arr.length > KEY_HISTORY_CAP) arr.shift();
    statsDirty = true;
  },

  /* Live stats for one key. Prefers session samples; falls back to persisted
     snapshot when the key hasn't been played this session. Returns undefined
     if no data anywhere. */
  getKeyStats(key: KeyId): KeyStats | undefined {
    const arr = samples.get(key);
    if (arr && arr.length > 0) return computeStats(arr);
    const snap = snapshots[key];
    if (snap) return {
      n: snap.n, mean: snap.mean, stddev: snap.stddev, cv: snap.cv,
      min: snap.p5, max: snap.p95, p5: snap.p5, p95: snap.p95,
    };
    return undefined;
  },

  /* Per-key histogram, `bins`-wide over 0..127. Returns live samples only —
     snapshots don't preserve sample arrays. */
  getKeyHistogram(key: KeyId, bins: number = 32): Int32Array {
    const out = new Int32Array(bins);
    const arr = samples.get(key);
    if (!arr) return out;
    const step = 128 / bins;
    for (let i = 0; i < arr.length; i++) {
      const idx = Math.min(bins - 1, Math.floor(arr[i] / step));
      out[idx]++;
    }
    return out;
  },

  /* Snapshot of all known keys' stats, live or persisted. Live shadows snapshot. */
  getAllStats(): { key: KeyId; stats: KeyStats }[] {
    const out: { key: KeyId; stats: KeyStats }[] = [];
    const seen = new Set<KeyId>();
    for (const [k, arr] of samples) {
      seen.add(k);
      out.push({ key: k, stats: computeStats(arr) });
    }
    for (const k of Object.keys(snapshots)) {
      if (seen.has(k)) continue;
      const s = snapshots[k];
      out.push({ key: k, stats: {
        n: s.n, mean: s.mean, stddev: s.stddev, cv: s.cv,
        min: s.p5, max: s.p95, p5: s.p5, p95: s.p95,
      }});
    }
    return out;
  },

  /* Keyboard-wide aggregate of per-key means. Used for "this key's mean
     deviates from the keyboard average by ≥ 1.5σ" mean-drift detection. */
  getGlobalStats(): { meanOfMeans: number; stddevOfMeans: number; nKeys: number } {
    const means: number[] = [];
    for (const [, arr] of samples) {
      if (arr.length >= STATS_MIN_N) {
        let sum = 0;
        for (let i = 0; i < arr.length; i++) sum += arr[i];
        means.push(sum / arr.length);
      }
    }
    for (const k of Object.keys(snapshots)) {
      if (samples.has(k)) continue;
      const s = snapshots[k];
      if (s.n >= STATS_MIN_N) means.push(s.mean);
    }
    if (means.length === 0) return { meanOfMeans: 0, stddevOfMeans: 0, nKeys: 0 };
    let sum = 0;
    for (let i = 0; i < means.length; i++) sum += means[i];
    const mom = sum / means.length;
    if (means.length < 2) return { meanOfMeans: mom, stddevOfMeans: 0, nKeys: means.length };
    let sumSq = 0;
    for (let i = 0; i < means.length; i++) { const d = means[i] - mom; sumSq += d * d; }
    return { meanOfMeans: mom, stddevOfMeans: Math.sqrt(sumSq / (means.length - 1)), nKeys: means.length };
  },

  /* Total raw samples currently held in session ring buffers. */
  getTotalSamples(): number {
    let total = 0;
    for (const arr of samples.values()) total += arr.length;
    return total;
  },

  /* Count of keys whose live OR snapshot stats meet the n >= STATS_MIN_N
     threshold (the bar for showing them on the scatter / in outlier lists). */
  getKeyCountWithEnoughSamples(): number {
    let count = 0;
    for (const arr of samples.values()) {
      if (arr.length >= STATS_MIN_N) count++;
    }
    for (const k of Object.keys(snapshots)) {
      if (samples.has(k)) continue;
      if (snapshots[k].n >= STATS_MIN_N) count++;
    }
    return count;
  },

  clearStats(): void {
    samples.clear();
    snapshots = {};
    statsDirty = false;
    persist();
  },

  /* Called by the panel on its refresh tick: if any new samples have arrived
     since last sync, recompute snapshots from live samples and persist.
     Cheap when idle, debounces the localStorage write rate. */
  syncStatsSnapshot(): void {
    if (!statsDirty) return;
    statsDirty = false;
    const next: Record<KeyId, KeyStatsSnapshot> = {};
    for (const [k, arr] of samples) {
      if (arr.length < STATS_MIN_N) continue;
      const s = computeStats(arr);
      next[k] = { n: s.n, mean: s.mean, stddev: s.stddev, cv: s.cv, p5: s.p5, p95: s.p95 };
    }
    /* Preserve snapshot entries for keys not played this session. */
    for (const k of Object.keys(snapshots)) {
      if (!(k in next)) next[k] = snapshots[k];
    }
    snapshots = next;
    persist();
  },
};

loadFromPrefs();

/* Re-export the persistence type so callers don't have to dual-import. */
export type { VelocityCalPrefs };
