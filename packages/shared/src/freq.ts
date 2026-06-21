// Pure frequency math: (q, r, mode) → Hz. Self-contained so the Composer
// side can compute pitches without pulling in HKL's live tuning state.
//
// A3 = 220 Hz sits at (q=0, r=0). The reference note doesn't appear here on
// purpose: it doesn't affect (q, r) → Hz under any of HKL's tuning systems.
// It only shifts which physical key maps to which (q, r) during input.

export type TuningMode = 'E' | '5' | 'P' | 'D' | '7' | 'V';

export const TUNING_MODES: ReadonlyArray<TuningMode> = ['E', '5', 'P', 'D', '7', 'V'];

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
 *  at (0, 0). Used to bound the retune search and to validate cells. */
export function coordToMidi(q: number, r: number): number {
  return 57 + 4 * q + 7 * r;
}

/** Prime-exponent vector [e2, e3, e5, e7] of (q, r)'s frequency under a JI
 *  `mode`, relative to 220 Hz (A3). This is the canonical tuning quantity:
 *  both `freqAt` (multiply once into Hz) and the interval analyzer (subtract
 *  two vectors → exact JI ratio) derive from it, so the per-mode region math
 *  lives in exactly one place. NOT valid for mode 'E' (12-TET is not rational);
 *  callers in Equal take a separate path and never request exps.
 *
 *  Base layout: 220 · 2^b · (5/4)^(p−1) · (3/2)^r where b = band, p = position
 *  in band. Per-mode region shift mirrors the qm column rules in
 *  src/tuning/regions.ts (Ptolemaic = none; the rest shift by a syntonic comma
 *  and, for Septimal, a septimal comma; Schismatic adds schisma^b octave
 *  stacking — see SCHISMA above). */
export function coordExps(q: number, r: number, mode: TuningMode): [number, number, number, number] {
  const b = Math.floor((q + 1) / 3);
  const p = ((q + 1) % 3 + 3) % 3;
  /* 2^b·(5/4)^(p−1)·(3/2)^r decomposed: (5/4)=5·2⁻², (3/2)=3·2⁻¹ */
  let e2 = b - 2 * (p - 1) - r, e3 = r, e5 = p - 1, e7 = 0;
  const qm = ((q % 3) + 3) % 3;
  /* Schismatic: schisma^b = (3⁸·5/2¹⁵)^b on top of the Pythagorean octave. */
  if (mode === 'V') { e2 += -15 * b; e3 += 8 * b; e5 += b; }
  if (mode === 'D' || mode === 'V') {
    if (qm === 2) { e2 += 4; e3 += -4; e5 += 1; }              /* A-d1 upper: −SC (80/81) */
  } else if (mode === 'P') {
    if (qm === 1) { e2 += -4; e3 += 4; e5 += -1; }             /* A-d1 lower: +SC (81/80) */
    else if (qm === 2) { e2 += 4; e3 += -4; e5 += 1; }         /* A-d1 upper: −SC (80/81) */
  } else if (mode === '7') {
    if (qm === 2) { e2 += 4 - 6; e3 += -4 + 2; e5 += 1; e7 += 1; } /* −SC·septimal (80/81·63/64) */
  }
  return [e2, e3, e5, e7];
}

/** Frequency in Hz of (q, r) under `mode`. Independent of reference note.
 *  JI modes multiply the canonical exponent vector (`coordExps`) into Hz once;
 *  Equal is 12-TET and returns directly. */
export function freqAt(q: number, r: number, mode: TuningMode): number {
  if (mode === 'E') return 220 * Math.pow(2, (4 * q + 7 * r) / 12);
  const [e2, e3, e5, e7] = coordExps(q, r, mode);
  return 220 * Math.pow(2, e2) * Math.pow(3, e3) * Math.pow(5, e5) * Math.pow(7, e7);
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
