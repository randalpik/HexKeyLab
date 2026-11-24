// Velocity calibration: the house curve, the per-key press-time scale and the
// Lumatone velocity curve.
//
// One audio-stage transform applied at audio-engine entry, so every source
// (MIDI input, QWERTY, mouse, playback) benefits:
//   1. Audio-stage curve — replaces the prior hardcoded `0.10 + 0.90·(v/127)²`
//      in velocityBaseVol with `floor + (ceiling - floor) · (v/127)^gamma`.
//
// Plus two Lumatone-input-stage transforms applied at midi/handler.ts before
// the velocity lands in audio.keyVelocity[key]:
//   2. Per-key press-time scale — one multiplier per key on the press time in
//      ticks that the raw velocity stands for (default 1.0; a tick is one scan
//      of the board, and the press time is the device's count plus one: see
//      `pressTicks`), returned as the
//      velocity that scaled press time would have read, fraction kept. For the
//      same touch a key's press time follows its timing window in sensor counts
//      (docs/lessons.md → "Press time follows the timing window"), so a key
//      differs from its neighbors by a factor on time; a factor on velocity is
//      right at one dynamic only. Keyed by the PHYSICAL key ("ch,note"), not
//      the lattice cell under it, so a ref change that slides the lattice
//      leaves each correction on its key.
//   3. Lumatone curve — the piano's law in the device's units, run up to full,
//      with the corner where they meet rounded. `(F / ticks)^gamma` is the
//      piano line (amplitude proportional to hammer velocity; gamma 1 is the
//      measurement), with `F` the press time of the input velocity set as
//      `full`; above full the gain is 1; `corner` says how many dB under their
//      meeting point the curve passes (0 = a hard corner) and changes nothing
//      away from it. The gain is turned into the musical velocity that plays at
//      it under the house curve, so everything downstream — audio, recording,
//      MIDI export — sees a device-neutral velocity. Applied ONLY to Lumatone-
//      source MIDI velocity; QWERTY/mouse paths are untouched.
//
// Recording captures the velocity noteOn received (both input stages already
// applied), so playback reproduces it and only the audio-stage curve re-runs.
//
// The scales are made from the calibration the device holds: the median timing
// window over each key's own, read over SysEx (lumatone/keyscales.ts). What is
// kept here, and saved, is the last table read.

import { savePrefs, loadPrefs, type VelocityCalPrefs } from '../state/persistence.js';
import { HOUSE_VELOCITY_CURVE } from '@hkl/shared/velocity.js';
import type { KeyId, LumatoneKeyId } from '../types.js';

export interface VelocityCalState {
  /** Audio gain at velocity = 1 (smallest non-zero). 0..1. */
  floor: number;
  /** Audio gain at velocity = 127. 0..1. */
  ceiling: number;
  /** Curve exponent. This is the device-INDEPENDENT "house" curve: a canonical
   *  musical velocity (0..127, normalized per device at input) → audio gain.
   *  Gentle (≈1.5) so it matches how a normal synth maps velocity to loudness
   *  and so a played velocity round-trips out to an external synth unchanged.
   *  (Device-specific compensation — e.g. the Lumatone's compressed range —
   *  lives in the per-device input curve below, NOT here.) */
  gamma: number;
  /** Press-time multiplier per physical key. Absent entries default to 1.0. */
  keyScale: Record<LumatoneKeyId, number>;
}

/** Lumatone TARGET-GAIN curve: the gain (0..1) a Lumatone press SHOULD sound at,
 *  as a function of its press time in ticks (after the key's own scale):
 *
 *    line = (F / ticks)^gamma
 *    gain = line / (1 + line^k)^(1/k),   k = 6.02 / corner
 *
 *  `F` is the press time of the `full` input velocity. With `corner` 0 the gain
 *  is `min(1, line)`.
 *
 *  The line is the piano's own law in the device's units. On a piano the peak
 *  amplitude of a tone is linearly proportional to the hammer's velocity
 *  (Palmer & Brown, "Investigations in the amplitude of sounded piano tones",
 *  JASA 1991), and on the Lumatone the speed of a press is 1 / its press time,
 *  so the amplitude is proportional to 1 / ticks: `gamma` 1, 6.02 dB per
 *  doubling of press time, and no floor. The ticks are the scans the press
 *  took, which is the count the device sends plus one (`pressTicks`); the law
 *  on the bare count would be too steep at the loud end, 6.0 dB where it is 3.5
 *  between counts of 1 and 2. The device has no hammer, so one
 *  constant places the line: `full`, the INPUT velocity (the hardware velocity
 *  after the key's scale, the unit the Diagnostics overlay shows and the curve
 *  is tuned in) at which the line reaches full loudness. Faster than that is
 *  full too. `gamma` other than 1 bends the line for a wider or narrower range.
 *
 *  `corner` rounds the point where the line meets the ceiling, and only that
 *  point: it is how many dB under it the curve passes. The formula is the line
 *  where the line is well under 1 and 1 where it is well over (within 0.12 dB of
 *  `min(1, line)` once the press time is half again longer or shorter than `F`,
 *  at the default 1 dB), so the ramp below and the ceiling above are not moved. This is what
 *  Max asked for on 2026-11-23: "round the corner, not reshape the whole curve.
 *  I mean the actual corner." Two attempts that day rounded far too much of it
 *  (decisions.md).
 *
 *  The handler turns the gain into the canonical musical velocity that
 *  reproduces it through the inverse of the gentle house curve
 *  (`musical = houseCurve⁻¹(targetGain)`), so `houseCurve(musicalForTicks(t))`
 *  equals this curve within the rounding of a whole velocity, while keyVelocity
 *  is still a musical velocity that round-trips to external synths. A gain under
 *  the house curve's floor plays as its quietest note (velocity 1, −25.9 dB),
 *  which is the bottom of the range. */
export interface InputCurveState {
  /** Input velocity of full loudness (on the default table, 128 − its ticks). */
  full: number;
  /** Exponent on the piano law. 1 = the measured piano. */
  gamma: number;
  /** How many dB under the point where the line meets full the curve passes.
   *  0 = a hard corner. */
  corner: number;
}

/* House (musical velocity → gain) curve. Gentle: floor 0.05, ceiling 1.0,
   gamma 1.5 — the former piano-feel curve, now the single device-independent
   audio curve. The floor/ceiling/gamma come from @hkl/shared so the orchestrator
   bakes per-layer gains against the exact same curve HKL plays back with. */
export const DEFAULT_CAL: VelocityCalState = {
  ...HOUSE_VELOCITY_CURVE,
  keyScale: {},
};

/* Lumatone target-gain curve default: the piano's gamma, the piano line
   reaching full at input velocity 125.0 (3 ticks), and a corner 1 dB under
   that meeting point. The line then reaches the house curve's quietest note at
   59 ticks (input velocity 69). 125.0 is where Max settled on the SP-250 curve
   instrument (2026-11-24); until then the default was 125.6 (2.4 ticks), the
   value that put a 48-tick press on the quietest note. On his unit with
   `min lo` 3 (2026-11-22) his ppp, p and f were device counts of about 48, 23
   and 5: 49, 24 and 6 ticks, input velocities 79 (−24.3 dB here), 104
   (−18.1 dB) and 122 (−6.0 dB). The user tunes `full`, the corner and, if
   wanted, gamma in lumadiag. */
export const DEFAULT_INPUT_CURVE: InputCurveState = {
  full: 125.0,
  gamma: 1.0,
  corner: 1.0,
};

/** The velocity-interval table HKL keeps on the device (CMD 0x20), sent with
 *  every setup (lumatone/sync.ts): thresholds 0…126, one device count per
 *  velocity (velocity = 127 − count under the identity LUT), which is every bit
 *  of timing the device measures. The firmware bins each press by comparing the
 *  board's count with the thresholds. The count starts at 0, so the press time is
 *  count + 1 ticks and the velocity is 128 − ticks. A table that starts at 1
 *  gives counts 0 and 1 (one scan and two) the same velocity; a wider span skips
 *  counts and a narrower one repeats thresholds. It is not a setting: the per-key
 *  scale and the Lumatone curve read a velocity back as press time through this
 *  table (`pressTicks`). The Terpstra factory table (1…58 in single counts, then
 *  widening to 310) is what a preset file holds and what the device runs when
 *  HKL has not sent this one. */
const INTERVAL_TABLE: readonly number[] = Array.from({ length: 127 }, (_, i) => i);

const state: VelocityCalState = {
  floor: DEFAULT_CAL.floor,
  ceiling: DEFAULT_CAL.ceiling,
  gamma: DEFAULT_CAL.gamma,
  keyScale: {},
};

const inputCurve: InputCurveState = { ...DEFAULT_INPUT_CURVE };

/* Each key's latest Lumatone strike: the raw velocity the device sent, the input
   velocity (the raw one after the key's press-time scale: what goes INTO the
   Lumatone curve, and the Calibration graph's x-axis), and the musical
   velocity it became. Session-only; the Diagnostics overlay shows the input
   velocity and the press time from it (a voice carries only the musical one). */
const lastStrike: Map<KeyId, { raw: number; input: number; musical: number }> = new Map();

/* A key's press-time scale is held to this range. The 2026-11-16 calibration's
   own values run from 0.63 to 3.8. */
export const KEY_SCALE_MIN = 0.1;
export const KEY_SCALE_MAX = 10;
const KEY_ID = /^[1-5],(?:[0-9]|[1-4][0-9]|5[0-5])$/;
const validScale = (g: unknown): g is number =>
  typeof g === 'number' && g >= KEY_SCALE_MIN && g <= KEY_SCALE_MAX;

/* Clamp + integer-snap. Velocity is a 7-bit MIDI value with no fractional
   meaning; `noteOn` callers expect integers. */
function clampVel(v: number): number {
  if (v <= 0) return 0;
  if (v >= 127) return 127;
  return Math.max(1, Math.round(v));
}

function persist(): void {
  savePrefs({ velocityCal: {
    version: 9,
    floor: state.floor,
    ceiling: state.ceiling,
    gamma: state.gamma,
    keyScale: { ...state.keyScale },
    inputCurve: { ...inputCurve },
  }});
}

function loadFromPrefs(): void {
  const prefs = loadPrefs();
  const v = prefs.velocityCal;
  if (!v) return;
  if (typeof v.floor === 'number') state.floor = v.floor;
  if (typeof v.ceiling === 'number') state.ceiling = v.ceiling;
  if (typeof v.gamma === 'number') state.gamma = v.gamma;
  if (v.keyScale && typeof v.keyScale === 'object') {
    state.keyScale = {};
    for (const k of Object.keys(v.keyScale)) {
      const g = v.keyScale[k];
      if (KEY_ID.test(k) && validScale(g)) state.keyScale[k] = g;
    }
  }
  if (v.inputCurve && typeof v.inputCurve === 'object') {
    if (typeof v.inputCurve.full === 'number') inputCurve.full = v.inputCurve.full;
    if (typeof v.inputCurve.gamma === 'number') inputCurve.gamma = v.inputCurve.gamma;
    if (typeof v.inputCurve.corner === 'number') inputCurve.corner = v.inputCurve.corner;
  }

  /* Migration to v3 (canonical musical velocity): before it, state.{floor,
     ceiling,gamma} held the user's tuned Lumatone AUDIO curve, where the gentle
     house curve lives now; reset the house curve. (v3 also carried that tuned
     curve over as the Lumatone curve; v7, below, replaces it.) One-time. */
  const migrateCurve = (v.version ?? 0) < 3;
  if (migrateCurve) {
    state.floor = DEFAULT_CAL.floor;
    state.ceiling = DEFAULT_CAL.ceiling;
    state.gamma = DEFAULT_CAL.gamma;
  }

  /* Migration to v5: the per-key gain (`perKey`, a multiplier on velocity) is
     gone, replaced by the press-time scale (`keyScale`). A gain is not carried
     over: it corrects one dynamic, and every saved one was captured while the
     device ran its preset's velocity tables (docs/lessons.md). The prefs loader
     no longer reads it; saving here drops it from storage. One-time. */
  const migrateScale = (v.version ?? 0) < 5;

  /* Migration to v7: the Lumatone curve is the piano law, `full` and `gamma`
     (v6 was floor + (ceiling − floor) · (top / ticks)^gamma; before v6 the
     exponent was on the velocity number). No saved setting of an earlier curve
     means anything in this one, so both scalars take their defaults. One-time. */
  const migratePiano = (v.version ?? 0) < 7;
  if (migratePiano) {
    inputCurve.full = DEFAULT_INPUT_CURVE.full;
    inputCurve.gamma = DEFAULT_INPUT_CURVE.gamma;
    inputCurve.corner = DEFAULT_INPUT_CURVE.corner;
  }

  /* Migration to v9: the interval table is the constant 0…126, and the per-key
     statistics are gone. Saving drops a stored table and the stored statistics. */
  const migrateTable = (v.version ?? 0) < 9;
  if (migrateCurve || migrateScale || migratePiano || migrateTable) persist();
}

export const velocityCal = {
  /* Read-only views for UI. */
  get floor(): number { return state.floor; },
  get ceiling(): number { return state.ceiling; },
  get gamma(): number { return state.gamma; },
  get keyScale(): Readonly<Record<LumatoneKeyId, number>> { return state.keyScale; },
  get calibratedKeyCount(): number { return Object.keys(state.keyScale).length; },

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

  /** Replace the per-key scales with a table made from the device's calibration
   *  (lumatone/keyscales.ts), by physical key ("ch,note"). An entry that is not
   *  a physical key id, or whose scale is outside KEY_SCALE_MIN…KEY_SCALE_MAX,
   *  is left out, and its key plays unscaled. */
  setKeyScales(scales: Readonly<Record<LumatoneKeyId, number>>): void {
    const next: Record<LumatoneKeyId, number> = {};
    for (const [k, g] of Object.entries(scales)) if (KEY_ID.test(k) && validScale(g)) next[k] = g;
    state.keyScale = next;
    persist();
  },

  /* ── Lumatone velocity curve ──────────────────────────────────────────────
     Applied at midi/handler.ts before storage (lumatoneVelocity). Its output is
     a whole musical velocity 0..127, not audio gain. */
  get inputCurveFull(): number { return inputCurve.full; },
  get inputCurveGamma(): number { return inputCurve.gamma; },
  get inputCurveCorner(): number { return inputCurve.corner; },

  setInputCurveFull(v: number): void { inputCurve.full = v; persist(); },
  setInputCurveGamma(v: number): void { inputCurve.gamma = v; persist(); },
  setInputCurveCorner(v: number): void { inputCurve.corner = v < 0 ? 0 : v; persist(); },

  resetInputCurve(): void {
    inputCurve.full = DEFAULT_INPUT_CURVE.full;
    inputCurve.gamma = DEFAULT_INPUT_CURVE.gamma;
    inputCurve.corner = DEFAULT_INPUT_CURVE.corner;
    persist();
  },

  /** The gain the Lumatone curve asks for at a press time in ticks: the piano
   *  line `(F / ticks)^gamma` (`F` the press time of the `full` input velocity)
   *  up to a ceiling of 1, with the corner between them rounded so that the
   *  curve passes `corner` dB under it: `line / (1 + line^k)^(1/k)` with
   *  `k = 6.02 / corner`, and `min(1, line)` when `corner` is 0. A press too fast
   *  to time (0 ticks) is full. */
  targetGainForTicks(ticks: number): number {
    if (!(ticks > 0)) return 1;
    const line = Math.pow(this.ticksForVelocity(inputCurve.full) / ticks, inputCurve.gamma);
    if (!(inputCurve.corner > 0)) return line < 1 ? line : 1;
    const k = 20 * Math.LOG10E * Math.LN2 / inputCurve.corner;
    /* The same expression, written for each side so a large k cannot overflow. */
    return line < 1 ? line / Math.pow(1 + Math.pow(line, k), 1 / k)
                    : 1 / Math.pow(1 + Math.pow(line, -k), 1 / k);
  },

  /** The canonical musical velocity (a whole 1..127) for a press time in ticks:
   *  the curve's gain, through the inverse of the gentle house curve
   *  (state.floor/ceiling/gamma), so `curveGain(musicalForTicks(t))` is the
   *  curve's gain within the rounding of a whole velocity. A gain at or under
   *  the house floor is the softest audible velocity. */
  musicalForTicks(ticks: number): number {
    const den = state.ceiling - state.floor;
    if (den <= 0) return 1;
    const num = this.targetGainForTicks(ticks) - state.floor;
    if (num <= 0) return 1;
    const musical = 127 * Math.pow(num / den, 1 / state.gamma);
    if (musical >= 127) return 127;
    return Math.max(1, Math.round(musical));
  },

  /** A Lumatone strike → its musical velocity: the raw velocity read back as
   *  the key's press time, scaled by the key's own number, and put through the
   *  curve. This is the note-on path (midi/handler.ts). Raw 0 → 0 (a note-off). */
  lumatoneVelocity(key: LumatoneKeyId, raw: number): number {
    if (raw <= 0) return 0;
    const ticks = this.keyTicks(key, raw);
    return ticks === null ? 1 : this.musicalForTicks(ticks);
  },

  /** The press time a device velocity stands for, fractions included: `ticksOf`
   *  at whole velocities, linear between them. */
  ticksForVelocity(v: number): number {
    const c = v < 1 ? 1 : v > 127 ? 127 : v;
    const lo = Math.floor(c), hi = Math.min(127, lo + 1);
    const a = this.ticksOf(lo) ?? 0, b = this.ticksOf(hi) ?? 0;
    return a + (b - a) * (c - lo);
  },

  /** The same curve for a device velocity (raw, or the scaled one
   *  `applyKeyScale` returns), which is the Calibration graph's x-axis:
   *  the velocity's press time, through the curve. At a whole raw velocity it is
   *  exactly an unscaled key's `lumatoneVelocity`. v ≤ 0 → 0 (note-off). */
  applyInputCurve(v: number): number {
    if (v <= 0) return 0;
    return this.musicalForTicks(this.ticksForVelocity(v));
  },

  /** The velocity-interval table HKL keeps on the device (CMD 0x20): the
   *  one-count table, thresholds 0…126 (INTERVAL_TABLE). */
  buildIntervalTable(): number[] { return INTERVAL_TABLE.slice(); },

  /** The velocity LUT HKL keeps on the device (CMD 0x08), in natural order
   *  (`lut[i]` = the velocity for input i, 127 = the shortest press): identity,
   *  with the slowest bin at 1, because a note-on at velocity 0 is a note-off to
   *  every receiver. With it the firmware's bin is `127 - velocity`. */
  buildIdentityLut(): number[] {
    const lut: number[] = new Array(128);
    for (let i = 0; i < 128; i++) lut[i] = i === 0 ? 1 : i;
    return lut;
  },

  /** The press times, in whole ticks, that the firmware turns into this raw
   *  velocity under the identity LUT and the interval table: `lo`…`hi`
   *  inclusive, `hi` null when open-ended.
   *
   *  A tick is one scan of the board, and the press time is the device's count
   *  plus one. The board sets a key's counter to 0 on the first scan that finds
   *  it between its two thresholds, adds one on each later scan there, and sends
   *  the counter as it stands when the key passes the upper one, so a press seen
   *  in the zone on n scans sends n − 1 (docs/lessons.md → "A tick is one scan
   *  of the board"). This function and `velocityForTicks` are the only two
   *  places that know it: everything else works in ticks.
   *
   *  On thresholds 0…126 the firmware's bin is the count, and the velocity is
   *  127 − the count, so every velocity from 2 up is one press time, 128 − the
   *  velocity; velocity 1 is every count from 126 up. Null only for a velocity
   *  below 1. True only while the device holds the tables HKL pushed
   *  (lumatone/sync.ts sends both with the connect-time setup). */
  pressTicks(raw: number): { lo: number; hi: number | null } | null {
    if (!(raw >= 1)) return null;
    const v = raw >= 127 ? 127 : Math.max(1, Math.round(raw));
    return { lo: 128 - v, hi: v === 1 ? null : 128 - v };
  },

  /** `pressTicks` as the overlay prints it: "16", "65–66", "≥127". */
  pressTicksLabel(raw: number): string {
    const r = this.pressTicks(raw);
    if (!r) return '?';
    if (r.hi === null) return '≥' + r.lo;
    return r.lo === r.hi ? String(r.lo) : r.lo + '–' + r.hi;
  },

  /** Called from the Lumatone note-on path: the strike's raw velocity, its input
   *  velocity (`applyKeyScale` of it) and the musical velocity it became, by
   *  lattice key. */
  noteStrike(key: KeyId, raw: number, input: number, musical: number): void {
    lastStrike.set(key, { raw, input, musical });
  },

  /** The Lumatone strike that gave this key this musical velocity: its raw and
   *  input velocities. Undefined when the key's voice came from anything else. */
  strikeOf(key: KeyId, musical: number): { raw: number; input: number } | undefined {
    const s = lastStrike.get(key);
    return s && s.musical === musical ? { raw: s.raw, input: s.input } : undefined;
  },

  /** An input velocity as the overlay prints it: whole when it is whole (an
   *  unscaled key's always is), one decimal otherwise. */
  inputVelocityLabel(v: number): string {
    const r = Math.round(v * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  },

  /** The press time, in ticks, a raw velocity stands for: 128 − the velocity,
   *  and the first tick of the open bin at the slow end (127) for velocity 1.
   *  Null for a velocity no press time produces. */
  ticksOf(raw: number): number | null {
    const r = this.pressTicks(raw);
    return r ? r.lo : null;
  },

  /** The velocity a press time reads as: the firmware's own map on whole ticks
   *  (its count is the ticks less one, see `pressTicks`; velocity = 127 − the
   *  count), and the same line between them, so a scaled press time keeps its
   *  fraction. 127 for one tick or less, 1 from 127 ticks on. */
  velocityForTicks(ticks: number): number {
    const count = ticks - 1;
    if (!(count > 0)) return 127;
    return count >= 126 ? 1 : 127 - count;
  },

  /* Stage 1: per-key press-time scale. A key's press time for a raw velocity:
     the ticks the velocity stands for, times the key's scale (1 when it has
     none). Null for a velocity below 1. */
  keyTicks(key: LumatoneKeyId, raw: number): number | null {
    const ticks = this.ticksOf(raw);
    return ticks === null ? null : ticks * (state.keyScale[key] ?? 1);
  },

  /* The same, as a device velocity: the velocity that scaled press time reads as
     (1..127, not rounded). A key with no scale, or a scale of 1, passes through
     exactly. The note-on path does not use it (it feeds the curve the ticks);
     this is the key's position on the Calibration graph's x-axis. */
  applyKeyScale(key: LumatoneKeyId, raw: number): number {
    if (raw <= 0) return 0;
    const g = state.keyScale[key];
    if (g === undefined || g === 1) return raw;
    const ticks = this.ticksOf(raw);
    return ticks === null ? raw : this.velocityForTicks(ticks * g);
  },

  /* Stage 2: curve. Returns audio gain 0..1. */
  curveGain(v: number): number {
    if (v <= 0) return 0;
    const vn = clampVel(v) / 127;
    return state.floor + (state.ceiling - state.floor) * Math.pow(vn, state.gamma);
  },

};

loadFromPrefs();

/* Re-export the persistence type so callers don't have to dual-import. */
export type { VelocityCalPrefs };
