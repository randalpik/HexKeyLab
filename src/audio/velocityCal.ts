// Velocity calibration: global curve + per-key gain + auto-capture.
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

import { savePrefs, loadPrefs, type VelocityCalPrefs } from '../state/persistence.js';
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
    for (const [key, samples] of captures) {
      if (samples.length === 0) continue;
      const sorted = samples.slice().sort((a, b) => a - b);
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
};

loadFromPrefs();

/* Re-export the persistence type so callers don't have to dual-import. */
export type { VelocityCalPrefs };
