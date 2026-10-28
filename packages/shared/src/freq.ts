// Pure frequency math: (q, r, mode, mapping) → Hz. Self-contained so the
// Composer side can compute pitches without pulling in HKL's live tuning state.
//
// A3 = 220 Hz sits at (q=0, r=0). The reference note itself doesn't appear
// here: it only shifts which physical key maps to which (q, r) during input.
// What it does decide, in Syntonic ('S') and Polysyntonic ('Y'), is the
// `anchor` — the home band, the one band left unaltered — so every pitch
// function takes the anchor explicitly (`anchorOf`). Only S and Y read it.
// Coordinates are in `mapping`'s frame (mapping.ts); Wicki-Hayden and chromatic
// cells resolve through their Euler-equivalent.

import { eulerOf, bandOfCell, pitchBandOf, COLUMN_STEP, type Mapping } from './mapping.js';

export type TuningMode = 'E' | '5' | 'P' | 'D' | '7' | 'V' | 'S' | 'Y';

export const TUNING_MODES: ReadonlyArray<TuningMode> = ['E', '5', 'P', 'D', '7', 'V', 'S', 'Y'];

/** The anchor (home band) for a reference cell: its band in its own frame.
 *  Syntonic / Polysyntonic leave this band unaltered (Pythagorean) and shift
 *  every other band by whole syntonic commas (`bandOffset`). */
export function anchorOf(refQ: number, mapping: Mapping): number {
  return bandOfCell(refQ, mapping);
}

/** Syntonic-comma offset (+ = raised ×81/80) of a band `d` bands from the
 *  anchor. Syntonic returns home every 4 bands (0, +1, 0, −1); Polysyntonic
 *  stacks without bound. Every other mode is band-uniform: 0. */
export function bandOffset(mode: TuningMode, d: number): number {
  if (mode === 'S') return [0, 1, 0, -1][((d % 4) + 4) % 4];
  if (mode === 'Y') return d;
  return 0;
}

/** 2·PM3 + M3 − octave. The comma that distinguishes the Pythagorean dim4
 *  (8192:6561, ~384c) from a pure 5-limit M3 (5:4, ~386c). In Schismatic
 *  ('V') mode every band sums to octave + schisma (~1201.95c): within a band
 *  the layout is (PM3, M3) and the band-crossing M3 is spelled d4 — its
 *  ratio is the pure 81:64 PM3 instead of the Pythagorean 8192:6561 dim4,
 *  with the schisma absorbed into the octave. The mode name reflects this
 *  schisma stacking — distinct from the classical schismatic temperament
 *  of fifths. */
export const SCHISMA = 32805 / 32768;

export const MIDI_LOW = 21;
export const MIDI_HIGH = 108;

/** Nominal 12-TET MIDI note number for the lattice cell. Origin: A3 (MIDI 57)
 *  at (0, 0). Used to bound the retune search and to validate cells. A column
 *  step is COLUMN_STEP semitones (4 Euler, 2 Wicki-Hayden, 1 chromatic); a
 *  row step is a fifth in every mapping. */
export function coordToMidi(q: number, r: number, mapping: Mapping): number {
  return 57 + COLUMN_STEP[mapping] * q + 7 * r;
}

/** Prime-exponent vector [e2, e3, e5, e7] of (q, r)'s frequency under a JI
 *  `mode`, relative to 220 Hz (A3). This is the canonical tuning quantity:
 *  both `freqAt` (multiply once into Hz) and the interval analyzer (subtract
 *  two vectors → exact JI ratio) derive from it, so the per-mode region math
 *  lives in exactly one place. NOT valid for mode 'E' (12-TET is not rational);
 *  callers in Equal take a separate path and never request exps.
 *
 *  Base layout: 220 · 2^b · (5/4)^(p−1) · (3/2)^r where b = band, p = position
 *  in band. Per-mode region shift by qm column (Ptolemaic = none; the rest
 *  shift by a syntonic comma and, for Septimal, a septimal comma; Schismatic
 *  adds schisma^b octave stacking — see SCHISMA above).
 *
 *  Two modes add a per-band term on top of a band-uniform base mode:
 *  - Schismatic is Semiditonal × schisma^band, the band being the cell's own
 *    (spatial) band in its frame (`bandOfCell`).
 *  - Syntonic / Polysyntonic are Pythagorean shifted by
 *    `bandOffset(mode, band − anchor)` syntonic commas, the band being the one
 *    whose offset the cell carries (`pitchBandOf`: a chromatic column copied
 *    from the band to its left keeps that band's offset). `anchor` is ignored
 *    by every other mode.
 *
 *  Every other cell takes its Euler-equivalent's vector. */
export function coordExps(q: number, r: number, mode: TuningMode, mapping: Mapping, anchor: number): [number, number, number, number] {
  const c = eulerOf(q, r, mapping);
  const e = eulerExps(c.q, c.r, mode === 'V' ? 'D' : mode === 'S' || mode === 'Y' ? 'P' : mode);
  if (mode === 'V') {                                               /* ×schisma^band = (3⁸·5/2¹⁵)^band */
    const b = bandOfCell(q, mapping);
    e[0] += -15 * b; e[1] += 8 * b; e[2] += b;
  }
  const k = bandOffset(mode, pitchBandOf(q, mapping) - anchor);
  if (k) { e[0] += -4 * k; e[1] += 4 * k; e[2] += -k; }             /* ×(81/80)^k */
  return e;
}

/** Prime exponents of Euler cell (q, r) under a band-uniform `mode` (5/P/D/7). */
function eulerExps(q: number, r: number, mode: TuningMode): [number, number, number, number] {
  const b = Math.floor((q + 1) / 3);
  const p = ((q + 1) % 3 + 3) % 3;
  /* 2^b·(5/4)^(p−1)·(3/2)^r decomposed: (5/4)=5·2⁻², (3/2)=3·2⁻¹ */
  let e2 = b - 2 * (p - 1) - r, e3 = r, e5 = p - 1, e7 = 0;
  const qm = ((q % 3) + 3) % 3;
  if (mode === 'D') {
    if (qm === 2) { e2 += 4; e3 += -4; e5 += 1; }              /* A-d1 upper: −SC (80/81) */
  } else if (mode === 'P') {
    if (qm === 1) { e2 += -4; e3 += 4; e5 += -1; }             /* A-d1 lower: +SC (81/80) */
    else if (qm === 2) { e2 += 4; e3 += -4; e5 += 1; }         /* A-d1 upper: −SC (80/81) */
  } else if (mode === '7') {
    if (qm === 2) { e2 += 4 - 6; e3 += -4 + 2; e5 += 1; e7 += 1; } /* −SC·septimal (80/81·63/64) */
  }
  return [e2, e3, e5, e7];
}

/** Frequency in Hz of (q, r) under `mode` (and, for S/Y, `anchor`).
 *  JI modes multiply the canonical exponent vector (`coordExps`) into Hz once;
 *  Equal is 12-TET and returns directly. */
export function freqAt(q: number, r: number, mode: TuningMode, mapping: Mapping, anchor: number): number {
  if (mode === 'E') return 220 * Math.pow(2, (coordToMidi(q, r, mapping) - 57) / 12);
  const [e2, e3, e5, e7] = coordExps(q, r, mode, mapping, anchor);
  return 220 * Math.pow(2, e2) * Math.pow(3, e3) * Math.pow(5, e5) * Math.pow(7, e7);
}

/* solve difference vector for comma counts: s(syntonic) z(septimal) h(schisma)
   syntonic=(-4,4,-1,0) septimal=(6,-2,0,-1) schisma=(-15,8,1,0) */
export function solveCommas(de: ReadonlyArray<number>): [number, number, number] | null {
  const z = -de[3], hN = de[1] + 4 * de[2] - 2 * de[3];
  if (hN % 12 !== 0) return null;
  const h = hN / 12, s = h - de[2];
  if (de[0] !== -4 * s + 6 * z - 15 * h) return null;
  return [s, z, h];
}

/** Octave-reduce + complement-reduce a prime-exponent vector. Returns the
 *  exponent vector for the equivalent ratio in [1, √2]:
 *  - Octave-reduce: subtract floor(log₂ratio) from e₂ so ratio ∈ [1, 2).
 *  - Complement-reduce: if ratio > √2, flip to 2/ratio so ratio ∈ [1, √2].
 *  This collapses octave- and complement-equivalent intervals to a single
 *  exp vector, which is what Tenney-Height-based ranking should be invariant
 *  under (otherwise canonical spellings flip across octaves). */
export function reduceExps(e: ReadonlyArray<number>): readonly [number, number, number, number] {
  const e7 = e[3] ?? 0;
  const log2r = e[0] + e[1] * Math.log2(3) + e[2] * Math.log2(5) + e7 * Math.log2(7);
  const oct = Math.floor(log2r);
  let r0 = e[0] - oct, r1 = e[1], r2 = e[2], r3 = e7;
  if (log2r - oct > 0.5) {
    /* complement: new ratio = 2/ratio → new exps = (1 − e₂, −e₃, −e₅, −e₇) */
    r0 = 1 - r0; r1 = -r1; r2 = -r2; r3 = -r3;
  }
  return [r0, r1, r2, r3];
}

/** Exact Tenney Height from a prime-exponent vector [e₂, e₃, e₅, e₇], with
 *  octave + complement reduction. Octave and complement equivalents (e.g.
 *  5/4 ↔ 5/2 ↔ 8/5) all produce the same TH. Preferred when the ratio's
 *  num/den may exceed 2^53. */
export function tenneyHeightFromExps(e: ReadonlyArray<number>): number {
  const r = reduceExps(e);
  return Math.abs(r[0])
    + Math.abs(r[1]) * Math.log2(3)
    + Math.abs(r[2]) * Math.log2(5)
    + Math.abs(r[3]) * Math.log2(7);
}
