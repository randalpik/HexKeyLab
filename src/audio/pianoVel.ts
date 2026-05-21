// Piano-keyboard velocity normalization.
//
// HKL's audio-stage curve `gain(v) = floor + (ceiling − floor) · (v/127)^gamma`
// is tuned for Lumatone — gamma can run very high (e.g. ≈15) to expand the
// firmware's compressed ~60–127 velocity range. A piano keyboard sends a
// natural 0–127 distribution; through that audio curve, a piano mezzo-forte
// (raw 80) would collapse to near-floor gain.
//
// Resolution: keep ONE audio curve and ONE stored velocity domain. The piano
// input handler live-inverts the audio curve so the velocity it writes to
// audio.keyVelocity[key] is the value that — through the existing audio
// curve — produces the gain a piano-feel curve says the raw velocity should
// produce. Once stored, the velocity is indistinguishable from a Lumatone
// hit; recording/playback/MIDI-export need no source tracking.

import { velocityCal } from './velocityCal.js';

/** Piano-side "desired gain" curve. Defines what audio gain (0..1) an incoming
 *  raw piano velocity should produce. The handler inverts the live audio
 *  curve to find the velocity that yields that gain. */
export interface PianoGainCurveState {
  floor: number;
  ceiling: number;
  gamma: number;
}

/** Sensible defaults for a standard weighted-action MIDI keyboard:
 *  floor 0.05 so pp passages stay audible, ceiling 1.0 (no compression),
 *  gamma 1.5 for mild expansion that feels expressive. */
export const DEFAULT_PIANO_GAIN_CURVE: PianoGainCurveState = {
  floor: 0.05,
  ceiling: 1.0,
  gamma: 1.5,
};

const state: PianoGainCurveState = { ...DEFAULT_PIANO_GAIN_CURVE };

export const pianoGainCurve = {
  get floor(): number { return state.floor; },
  get ceiling(): number { return state.ceiling; },
  get gamma(): number { return state.gamma; },
  setFloor(v: number): void { state.floor = v; },
  setCeiling(v: number): void { state.ceiling = v; },
  setGamma(v: number): void { state.gamma = v; },
  setAll(s: PianoGainCurveState): void {
    state.floor = s.floor;
    state.ceiling = s.ceiling;
    state.gamma = s.gamma;
  },
  snapshot(): PianoGainCurveState {
    return { floor: state.floor, ceiling: state.ceiling, gamma: state.gamma };
  },
  reset(): void {
    state.floor = DEFAULT_PIANO_GAIN_CURVE.floor;
    state.ceiling = DEFAULT_PIANO_GAIN_CURVE.ceiling;
    state.gamma = DEFAULT_PIANO_GAIN_CURVE.gamma;
  },
};

/** Map a raw piano MIDI velocity (0..127) to the integer velocity that, when
 *  fed through the current audio-stage curve in velocityCal, produces the
 *  desired piano-feel gain. The audio curve is monotonic non-decreasing for
 *  gamma > 0 and ceiling > floor, so the inverse is well-defined.
 *
 *  Edge cases (audio floor ≥ desired gain, etc.) clamp to 0 / 127. */
export function normalizePianoVelocity(vRaw: number): number {
  const x = Math.max(0, Math.min(127, vRaw)) / 127;
  const want = state.floor + (state.ceiling - state.floor) * Math.pow(x, state.gamma);
  const af = velocityCal.floor;
  const ac = velocityCal.ceiling;
  const ag = velocityCal.gamma;
  if (want <= af || ac <= af) return 0;
  if (want >= ac) return 127;
  const y = (want - af) / (ac - af);
  const v = 127 * Math.pow(y, 1 / ag);
  return Math.round(Math.max(0, Math.min(127, v)));
}
