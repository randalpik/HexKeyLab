// Velocity calibration: global curve + per-key press-time scale + auto-capture +
// per-key velocity statistics + Lumatone input-velocity curve.
//
// One audio-stage transform applied at audio-engine entry, so every source
// (MIDI input, QWERTY, mouse, playback) benefits:
//   1. Audio-stage curve — replaces the prior hardcoded `0.10 + 0.90·(v/127)²`
//      in velocityBaseVol with `floor + (ceiling - floor) · (v/127)^gamma`.
//
// Plus two Lumatone-input-stage transforms applied at midi/handler.ts before
// the velocity lands in audio.keyVelocity[key]:
//   2. Per-key press-time scale — one multiplier per key on the press time in
//      ticks that the raw velocity stands for (default 1.0), returned as the
//      velocity that scaled press time would have read, fraction kept. For the
//      same touch a key's press time follows its timing window in sensor counts
//      (docs/lessons.md → "Press time follows the timing window"), so a key
//      differs from its neighbors by a factor on time; a factor on velocity is
//      right at one dynamic only. Keyed by the PHYSICAL key ("ch,note"), not
//      the lattice cell under it, so a ref change that slides the lattice
//      leaves each correction on its key; auto-capture and the per-key stats
//      key the same way.
//   3. Lumatone curve — the piano's law in the device's units, run up to full,
//      with the corner where they meet rounded. `(F / ticks)^gamma` is the
//      piano line (amplitude proportional to hammer velocity; gamma 1 is the
//      measurement), with `F` the press time of the input velocity set as
//      `full`; above full the gain is 1; `corner` says how many dB under their
//      meeting point the curve passes (0 = a hard corner) and changes nothing
//      away from it. The gain is turned into the musical velocity that plays at
//      it under the house curve, so everything downstream — audio, recording,
//      MIDI export — sees a device-neutral velocity. Applied ONLY to Lumatone-
//      source MIDI velocity; QWERTY/mouse paths are untouched. Lumadiag stats
//      keep sampling RAW velocity so they remain diagnostic of the firmware's
//      natural output.
//
// Recording captures the velocity noteOn received (both input stages already
// applied), so playback reproduces it and only the audio-stage curve re-runs.
//
// The scales come from a table (tools/lumatone-cal/keydata-compare.py --scales:
// the median timing window over each key's own) or from auto-capture: while
// capturing, every note-on velocity is appended to a per-key list, and on stop
// a key's scale = the target's press time / the median press time captured.
//
// Per-key velocity statistics: separate from auto-capture. When statsEnabled,
// every real MIDI note-on velocity feeds a ring buffer (KEY_HISTORY_CAP per
// key). We compute mean / stddev / CV and p5 / p95 on demand. A key whose
// range sits apart from its neighbors' has a different timing window and is a
// per-key scale candidate; its thresholds are not the fix (docs/lessons.md).
// Snapshot stats persist to localStorage; raw samples are session-only.

import { savePrefs, loadPrefs, type VelocityCalPrefs, type KeyStatsSnapshot } from '../state/persistence.js';
import { HOUSE_VELOCITY_CURVE } from '@hkl/shared/velocity.js';
import { baseKeys } from '../layout/baseKeys.js';
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
 *  doubling of press time, and no floor. The device has no hammer, so one
 *  constant places the line: `full`, the INPUT velocity (the hardware velocity
 *  after the key's scale, the unit the Diagnostics overlay shows and the curve
 *  is tuned in) at which the line reaches full loudness. Faster than that is
 *  full too. `gamma` other than 1 bends the line for a wider or narrower range.
 *
 *  `corner` rounds the point where the line meets the ceiling, and only that
 *  point: it is how many dB under it the curve passes. The formula is the line
 *  where the line is well under 1 and 1 where it is well over (within 0.1 dB of
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
  /** Input velocity of full loudness (on the one-tick table, 128 − its ticks). */
  full: number;
  /** Exponent on the piano law. 1 = the measured piano. */
  gamma: number;
  /** How many dB under the point where the line meets full the curve passes.
   *  0 = a hard corner. */
  corner: number;
}

/** Lumatone firmware velocity-interval curve (CMD 0x20). Generates a 127-entry
 *  table of press-time tick thresholds via the parametric map
 *    thresh[i] = low + (high - low) · (i/126)^gamma
 *  HKL sends the resolved table to the firmware with every setup
 *  (lumatone/sync.ts); the firmware then bins press time into 128 velocity bins
 *  by comparison. The per-key scale and the Lumatone curve read a velocity back
 *  as press time through this same table (`pressTicks`), so they follow
 *  whatever it is set to. */
export interface IntervalCurveState {
  low: number;
  high: number;
  gamma: number;
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
   reaching full at input velocity 125.6 (2.4 ticks), which puts input velocity
   80 (48 ticks) on the house curve's quietest note, and a corner 1 dB under
   that meeting point. On Max's unit with `min lo` 3 (2026-11-22) his ppp sits
   just under 80, his p at 105 (−19.6 dB here) and his f at 123 (−6.4 dB). The
   user tunes `full`, the corner and, if wanted, gamma in lumadiag. */
export const DEFAULT_INPUT_CURVE: InputCurveState = {
  full: 125.6,
  gamma: 1.0,
  corner: 1.0,
};

/** The one-tick table: low=1, high=127, gamma=1.0 gives thresholds 1..127, one
 *  tick of press time per velocity (velocity = 128 − ticks under the identity
 *  LUT), which is every bit of timing the device measures. 127 entries hold
 *  low..low+126; a wider span skips ticks, a narrower one repeats thresholds.
 *  The Terpstra factory table (1..58 in single ticks, then widening to 310) is
 *  what a preset file holds and what the device runs when HKL has not sent
 *  this one. */
export const DEFAULT_INTERVAL_CURVE: IntervalCurveState = {
  low: 1,
  high: 127,
  gamma: 1.0,
};

const state: VelocityCalState = {
  floor: DEFAULT_CAL.floor,
  ceiling: DEFAULT_CAL.ceiling,
  gamma: DEFAULT_CAL.gamma,
  keyScale: {},
};

const inputCurve: InputCurveState = { ...DEFAULT_INPUT_CURVE };
const intervalCurve: IntervalCurveState = { ...DEFAULT_INTERVAL_CURVE };

/* Session-only counter of distinct MIDI velocities emitted by the firmware
   since the last reset. Populated from midi/handler.ts on every real
   keypress. Useful for verifying the expected count: under identity CMD 0x08
   + CMD 0x20 with integer `low..high` thresholds, the count converges to
   roughly `high - low + 2` (one bin per integer threshold, plus bin 0 for
   sub-low presses and bin 127 for above-high). */
const observedVelocities: Set<number> = new Set();

/* Each key's latest Lumatone strike: the raw velocity the device sent, the input
   velocity (the raw one after the key's press-time scale: what goes INTO the
   Lumatone curve, and the Calibrate Keys graph's x-axis), and the musical
   velocity it became. Session-only; the Diagnostics overlay shows the input
   velocity and the press time from it (a voice carries only the musical one). */
const lastStrike: Map<KeyId, { raw: number; input: number; musical: number }> = new Map();

/* Capture session state — lives in-module, not persisted. */
let capturing = false;
const captures: Map<LumatoneKeyId, number[]> = new Map();

/* A key's press-time scale is held to this range, imported or captured. The
   2026-11-16 calibration's own values run from 0.63 to 3.8. */
export const KEY_SCALE_MIN = 0.1;
export const KEY_SCALE_MAX = 10;
const KEY_ID = /^[1-5],(?:[0-9]|[1-4][0-9]|5[0-5])$/;
const validScale = (g: unknown): g is number =>
  typeof g === 'number' && g >= KEY_SCALE_MIN && g <= KEY_SCALE_MAX;

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
let snapshots: Record<LumatoneKeyId, KeyStatsSnapshot> = {};
const samples: Map<LumatoneKeyId, number[]> = new Map();
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
    version: 7,
    floor: state.floor,
    ceiling: state.ceiling,
    gamma: state.gamma,
    keyScale: { ...state.keyScale },
    statsEnabled,
    stats: Object.keys(snapshots).length > 0 ? { ...snapshots } : undefined,
    inputCurve: { ...inputCurve },
    intervalCurve: { ...intervalCurve },
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
  if (typeof v.statsEnabled === 'boolean') statsEnabled = v.statsEnabled;
  if (v.stats && typeof v.stats === 'object') {
    snapshots = { ...v.stats };
  }
  if (v.inputCurve && typeof v.inputCurve === 'object') {
    if (typeof v.inputCurve.full === 'number') inputCurve.full = v.inputCurve.full;
    if (typeof v.inputCurve.gamma === 'number') inputCurve.gamma = v.inputCurve.gamma;
    if (typeof v.inputCurve.corner === 'number') inputCurve.corner = v.inputCurve.corner;
  }
  if (v.intervalCurve && typeof v.intervalCurve === 'object') {
    intervalCurve.low = v.intervalCurve.low;
    intervalCurve.high = v.intervalCurve.high;
    intervalCurve.gamma = v.intervalCurve.gamma;
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

  /* Migration to v4: per-key stats keyed by physical key ("ch,note"). Before
     v4 they were keyed by the lattice cell the key struck, baseKeys[i] + the
     kbAnchor at capture time, which was not stored. The map is read back under
     the anchor its cells prove (rekeyByAnchor). One-time. */
  const migrateKeys = (v.version ?? 0) < 4;
  if (migrateKeys) snapshots = rekeyByAnchor(snapshots, 'per-key stats');

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
  if (migrateCurve || migrateKeys || migrateScale || migratePiano) persist();
}

/* Pre-v4 per-key data → physical keys. Saved cells are baseKeys[i] + one
   capture-time anchor: A3's (0,0) when every cell lands on a key there, else
   the one shift that lands them all (a large capture has the keyboard's shape,
   so only its own anchor fits). A map no single anchor explains — captures
   under different refs, or too few cells to tell — is dropped with a warning
   rather than handed to the wrong keys. */
function rekeyByAnchor<T>(rec: Record<string, T>, what: string): Record<LumatoneKeyId, T> {
  const cells = Object.keys(rec).map((k) => k.split(',').map(Number));
  if (cells.length === 0) return {};
  const index = new Map<string, number>();
  baseKeys.forEach(([q, r], i) => { index.set(q + ',' + r, i); });
  const fits = ([aq, ar]: readonly number[]): boolean =>
    cells.every(([q, r]) => index.has((q - aq) + ',' + (r - ar)));
  const [q0, r0] = cells[0];
  const found = fits([0, 0]) ? [[0, 0]] : baseKeys.map(([q, r]) => [q0 - q, r0 - r]).filter(fits);
  if (found.length !== 1) {
    console.warn('[velocityCal] v4 migration dropped ' + cells.length + ' ' + what + ': '
      + (found.length === 0 ? 'no single ref anchor puts them all on Lumatone keys'
                            : found.length + ' ref anchors fit them'));
    return {};
  }
  const anchor = found[0];
  const out: Record<LumatoneKeyId, T> = {};
  Object.keys(rec).forEach((k, n) => {
    const i = index.get((cells[n][0] - anchor[0]) + ',' + (cells[n][1] - anchor[1]))!;
    out[(Math.floor(i / 56) + 1) + ',' + (i % 56)] = rec[k];
  });
  return out;
}

export const velocityCal = {
  /* Read-only views for UI. */
  get floor(): number { return state.floor; },
  get ceiling(): number { return state.ceiling; },
  get gamma(): number { return state.gamma; },
  get keyScale(): Readonly<Record<LumatoneKeyId, number>> { return state.keyScale; },
  get capturing(): boolean { return capturing; },
  get capturedKeyCount(): number { return captures.size; },
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

  clearKeyScale(): void {
    state.keyScale = {};
    persist();
  },

  /** Replace the per-key scales with a table written by
   *  `tools/lumatone-cal/keydata-compare.py --scales`:
   *  `{ format: "hkl-key-scales", version: 1, scales: { "ch,note": number } }`.
   *  All or nothing: a file with a key that is not a physical key id, or a
   *  scale outside KEY_SCALE_MIN…KEY_SCALE_MAX, is some other file, and the
   *  table in use stays as it was. */
  importKeyScales(data: unknown): { ok: true; count: number } | { ok: false; error: string } {
    const bad = (error: string) => ({ ok: false as const, error });
    if (!data || typeof data !== 'object') return bad('not a key-scale file');
    const d = data as Record<string, unknown>;
    if (d.format !== 'hkl-key-scales') return bad('not a key-scale file (format is not "hkl-key-scales")');
    if (d.version !== 1) return bad('key-scale file version ' + String(d.version) + ' is not supported');
    if (!d.scales || typeof d.scales !== 'object') return bad('the file has no scales');
    const entries = Object.entries(d.scales as Record<string, unknown>);
    if (entries.length === 0) return bad('the file has no scales');
    const next: Record<LumatoneKeyId, number> = {};
    for (const [k, g] of entries) {
      if (!KEY_ID.test(k)) return bad('"' + k + '" is not a Lumatone key (board 1–5, key 0–55)');
      if (!validScale(g)) return bad('the scale for key ' + k + ' is not a number from ' + KEY_SCALE_MIN + ' to ' + KEY_SCALE_MAX);
      next[k] = g;
    }
    state.keyScale = next;
    persist();
    return { ok: true, count: entries.length };
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
   *  `applyKeyScale` returns), which is the Calibrate Keys graph's x-axis:
   *  the velocity's press time, through the curve. At a whole raw velocity it is
   *  exactly an unscaled key's `lumatoneVelocity`. v ≤ 0 → 0 (note-off). */
  applyInputCurve(v: number): number {
    if (v <= 0) return 0;
    return this.musicalForTicks(this.ticksForVelocity(v));
  },

  /* ── Lumatone firmware velocity-interval table (CMD 0x20) ────────────────
     127 press-time tick thresholds shape which press-times merge into which
     bins. Built parametrically: thresh[i] = low + (high - low) · (i/126)^gamma.
     buildIntervalTable() produces the integer array to push via SysEx 0x20. */
  get intervalCurveLow(): number { return intervalCurve.low; },
  get intervalCurveHigh(): number { return intervalCurve.high; },
  get intervalCurveGamma(): number { return intervalCurve.gamma; },

  setIntervalCurveLow(v: number): void {
    intervalCurve.low = Math.max(0, Math.min(4094, Math.round(v)));
    if (intervalCurve.low >= intervalCurve.high) intervalCurve.high = intervalCurve.low + 1;
    persist();
  },
  setIntervalCurveHigh(v: number): void {
    intervalCurve.high = Math.max(1, Math.min(4095, Math.round(v)));
    if (intervalCurve.high <= intervalCurve.low) intervalCurve.low = intervalCurve.high - 1;
    persist();
  },
  setIntervalCurveGamma(v: number): void {
    intervalCurve.gamma = Math.max(0.1, Math.min(10, v));
    persist();
  },

  resetIntervalCurve(): void {
    intervalCurve.low = DEFAULT_INTERVAL_CURVE.low;
    intervalCurve.high = DEFAULT_INTERVAL_CURVE.high;
    intervalCurve.gamma = DEFAULT_INTERVAL_CURVE.gamma;
    persist();
  },

  /** Build the 127-entry interval table from the parametric curve. Each entry
   *  is an integer in [0, 4095] (12-bit). Monotonic non-decreasing — the
   *  parametric form is naturally monotonic for gamma > 0, but rounding can
   *  produce equal adjacent values, which the firmware accepts. */
  buildIntervalTable(): number[] {
    const { low, high, gamma } = intervalCurve;
    const span = high - low;
    const out: number[] = new Array(127);
    for (let i = 0; i < 127; i++) {
      const t = i / 126;
      const v = low + span * Math.pow(t, gamma);
      const clamped = Math.max(0, Math.min(4095, Math.round(v)));
      out[i] = clamped;
    }
    return out;
  },

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
   *  velocity under the identity LUT and the current interval table: `lo`…`hi`
   *  inclusive, `hi` null when open-ended. The firmware's bin b holds the press
   *  times above the threshold before `table[b]` and up to `table[b]`; velocity 1
   *  is bins 126 and 127 together. Where thresholds repeat, the firmware's
   *  bisection puts a press that equals them in some bin of the run, not the
   *  first (docs/lessons.md → "binary_search on duplicates"), so the lower bound
   *  is the last threshold that DIFFERS, and every bin of a run decodes alike.
   *  Null only for a velocity below 1. True only while the device holds the
   *  tables HKL pushed (lumatone/sync.ts sends both with the connect-time setup). */
  pressTicks(raw: number): { lo: number; hi: number | null } | null {
    if (!(raw >= 1)) return null;
    const table = this.buildIntervalTable();
    const bin = raw >= 127 ? 0 : Math.min(126, 127 - Math.round(raw));
    let before = bin - 1;
    while (before >= 0 && table[before] === table[bin]) before--;
    const lo = before < 0 ? 0 : table[before] + 1;
    return { lo, hi: bin >= 126 ? null : table[bin] };
  },

  /** `pressTicks` as the overlay prints it: "16", "64–65", "≤1", "≥127". */
  pressTicksLabel(raw: number): string {
    const r = this.pressTicks(raw);
    if (!r) return '?';
    if (r.hi === null) return '≥' + r.lo;
    if (r.lo === 0) return '≤' + r.hi;
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

  /* ── Distinct-velocity counter (session-only) ────────────────────────────
     Populated by midi/handler.ts on every real Lumatone keypress. Useful for
     verifying the BBB's binary_search produces the expected number of
     distinct outputs (one per integer in `intervalCurve.[low, high]`, plus
     the two open-ended early-return bins at the extremes). */
  recordObservedVelocity(v: number): void {
    if (v > 0 && v <= 127) observedVelocities.add(v);
  },
  getObservedVelocityCount(): number { return observedVelocities.size; },
  getObservedVelocities(): ReadonlySet<number> { return observedVelocities; },
  clearObservedVelocities(): void { observedVelocities.clear(); },

  /** The press time, in ticks, a raw velocity stands for: its bin's own tick,
   *  the middle of a bin several ticks wide, the threshold of the open bin at
   *  either end. Null for a velocity no press time produces. */
  ticksOf(raw: number): number | null {
    const r = this.pressTicks(raw);
    if (!r) return null;
    if (r.hi === null) return r.lo;
    if (r.lo === 0) return r.hi;
    return (r.lo + r.hi) / 2;
  },

  /** The velocity a press time reads as: the firmware's own map on whole ticks
   *  (bin = the first threshold not exceeded, velocity = 127 − bin), linear
   *  between thresholds, so a scaled press time keeps its fraction. 127 at or
   *  under the first threshold, 1 past the last. Where thresholds repeat, a
   *  press time lands in the first bin of the run, the firmware's own in one
   *  inside it: on such a table a scaled key can sit a bin or two from an
   *  unscaled one. The one-tick table (low to low + 126) has no repeats. */
  velocityForTicks(ticks: number): number {
    const table = this.buildIntervalTable();
    if (!(ticks > table[0])) return 127;
    for (let i = 1; i < 127; i++) {
      if (ticks <= table[i]) {
        const bin = i - 1 + (ticks - table[i - 1]) / (table[i] - table[i - 1]);
        return Math.max(1, 127 - bin);
      }
    }
    return 1;
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
     this is the key's position on the Calibrate Keys graph's x-axis. */
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
  recordSample(key: LumatoneKeyId, rawVelocity: number): void {
    if (!capturing) return;
    if (rawVelocity <= 0) return;
    let arr = captures.get(key);
    if (!arr) { arr = []; captures.set(key, arr); }
    arr.push(rawVelocity);
  },

  /* Stops capture, computes each captured key's scale from its median press
     time, and merges into state: scale = the target velocity's press time / the
     key's median press time, so the touch that was captured reads as the target.
     Returns the number of keys for which a scale was assigned (or revised). */
  stopCaptureAndCompute(targetVel: number): number {
    if (!capturing) return 0;
    capturing = false;
    const targetTicks = this.ticksOf(targetVel);
    let count = 0;
    for (const [key, capSamples] of captures) {
      const ticks: number[] = [];
      for (const raw of capSamples) { const t = this.ticksOf(raw); if (t !== null && t > 0) ticks.push(t); }
      if (ticks.length === 0 || targetTicks === null) continue;
      ticks.sort((a, b) => a - b);
      const median = ticks[Math.floor(ticks.length / 2)];
      const g = targetTicks / median;
      state.keyScale[key] = g < KEY_SCALE_MIN ? KEY_SCALE_MIN : g > KEY_SCALE_MAX ? KEY_SCALE_MAX : g;
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
  recordForStats(key: LumatoneKeyId, rawVelocity: number): void {
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
  getKeyStats(key: LumatoneKeyId): KeyStats | undefined {
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
  getKeyHistogram(key: LumatoneKeyId, bins: number = 32): Int32Array {
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
  getAllStats(): { key: LumatoneKeyId; stats: KeyStats }[] {
    const out: { key: LumatoneKeyId; stats: KeyStats }[] = [];
    const seen = new Set<LumatoneKeyId>();
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
    const next: Record<LumatoneKeyId, KeyStatsSnapshot> = {};
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
