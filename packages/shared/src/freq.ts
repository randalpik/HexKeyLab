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
