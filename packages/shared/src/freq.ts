// Pure frequency math: (q, r, mode, mapping) → Hz. Self-contained so the
// Composer side can compute pitches without pulling in HKL's live tuning state.
//
// A3 = 220 Hz sits at (q=0, r=0). The reference note itself doesn't appear
// here: it only shifts which physical key maps to which (q, r) during input.
// What it does decide, in Syntonic ('S') and Polysyntonic ('Y'), is the
// `anchor` — the home band, the one band left unaltered — so every pitch
// function takes the anchor explicitly (`anchorOf`). Banded, only S and Y read
// it; unbanded (`banded` false, `UNBANDED` below), every mode counts its bands
// from it. Coordinates are in `mapping`'s frame (mapping.ts); Wicki-Hayden and
// chromatic cells resolve through their Euler-equivalent.

import { eulerOf, bandOfCell, pitchBandOf, COLUMN_STEP, type Mapping } from './mapping.js';

export type TuningMode = 'E' | '5' | 'P' | 'D' | '7' | 'V' | 'S' | 'Y';

export const TUNING_MODES: ReadonlyArray<TuningMode> = ['E', '5', 'P', 'D', '7', 'V', 'S', 'Y'];

/** The anchor (home band) for a reference cell: its band in its own frame.
 *  Syntonic / Polysyntonic leave this band unaltered (Pythagorean) and shift
 *  every other band by whole syntonic commas (`bandOffset`). */
export function anchorOf(refQ: number, mapping: Mapping): number {
  return bandOfCell(refQ, mapping);
}

/** Whether a layout's pitch or spelling depends on the anchor: Syntonic /
 *  Polysyntonic, and every mode unbanded. Everything that tracks or compares
 *  anchors gates on this. */
export function readsAnchor(mode: TuningMode, banded: boolean): boolean {
  return !banded || mode === 'S' || mode === 'Y';
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

type Exps = [number, number, number, number];

/** The unbanded layout (Banded layout off): octave bands no longer exist.
 *  Every band seam is retuned to one of the mode's own in-band q-steps, so no
 *  interval occurs only at a seam, and each band carries `comma` once more
 *  than the band to its left, counted from the anchor (the reference's band).
 *  `base` is the band-uniform mode the seams are retuned from. Seams, Euler:
 *  - P (S, Y alike: their definition is the seam): d4 8192:6561 → PM3 81:64,
 *    +Pythagorean comma. Steps 81:64 ×3.
 *  - 5: d4 32:25 → M3 5:4, ×125/128. Steps 5:4 ×3.
 *  - D: 512:405 → 5:4, ×2025/2048. Steps 81:64, 5:4, 5:4.
 *  - 7: 56:45 → 5:4, ×225/224. Steps 9:7, 5:4, 5:4.
 *  - V keeps its tuning per key (its seam d4 already sounds as a PM3):
 *    Semiditonal × schisma per spatial band, counted from the anchor.
 *  Every other mode carries the comma by `pitchBandOf`, so a chromatic borrowed
 *  column stays an exact octave above its source. Equal sounds 12-TET either
 *  way; its exps are its JI reading (ratios, the piano picker), Ptolemaic's,
 *  banded and unbanded alike. The spelling side is notes.ts. */
const UNBANDED: Readonly<Record<TuningMode, { base: TuningMode; comma: Readonly<Exps>; spatial: boolean }>> = {
  E: { base: 'E', comma: [-7, 0, 3, 0], spatial: false },
  '5': { base: '5', comma: [-7, 0, 3, 0], spatial: false },
  P: { base: 'P', comma: [-19, 12, 0, 0], spatial: false },
  D: { base: 'D', comma: [-11, 4, 2, 0], spatial: false },
  '7': { base: '7', comma: [-5, 2, 2, -1], spatial: false },
  V: { base: 'D', comma: [-15, 8, 1, 0], spatial: true },
  S: { base: 'P', comma: [-19, 12, 0, 0], spatial: false },
  Y: { base: 'P', comma: [-19, 12, 0, 0], spatial: false },
};

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
 *  Every other cell takes its Euler-equivalent's vector.
 *
 *  Unbanded (`banded` false) replaces both band terms with `UNBANDED`'s per-band
 *  comma, counted from `anchor` in every mode. */
export function coordExps(q: number, r: number, mode: TuningMode, mapping: Mapping, anchor: number, banded: boolean): Exps {
  const c = eulerOf(q, r, mapping);
  if (!banded) {
    const u = UNBANDED[mode];
    const e = eulerExps(c.q, c.r, u.base);
    const d = (u.spatial ? bandOfCell(q, mapping) : pitchBandOf(q, mapping)) - anchor;
    for (let i = 0; i < 4; i++) e[i] += d * u.comma[i];
    return e;
  }
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
function eulerExps(q: number, r: number, mode: TuningMode): Exps {
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

/** Frequency in Hz of (q, r) under `mode` (and `anchor`, `banded`: see
 *  `coordExps`). JI modes multiply the canonical exponent vector into Hz once;
 *  Equal is 12-TET, banded or not, and returns directly. */
export function freqAt(q: number, r: number, mode: TuningMode, mapping: Mapping, anchor: number, banded: boolean): number {
  if (mode === 'E') return 220 * Math.pow(2, (coordToMidi(q, r, mapping) - 57) / 12);
  const [e2, e3, e5, e7] = coordExps(q, r, mode, mapping, anchor, banded);
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
