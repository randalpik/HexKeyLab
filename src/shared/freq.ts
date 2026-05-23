// Pure frequency math: (q, r, mode) → Hz. Self-contained so the Composer
// side can compute pitches without pulling in HKL's live tuning state.
//
// A3 = 220 Hz sits at (q=0, r=0). The reference note doesn't appear here on
// purpose: it doesn't affect (q, r) → Hz under any of HKL's tuning systems.
// It only shifts which physical key maps to which (q, r) during input.

export type TuningMode = 'E' | '5' | 'P' | 'D' | '7';

export const TUNING_MODES: ReadonlyArray<TuningMode> = ['E', '5', 'P', 'D', '7'];

export const MIDI_LOW = 21;
export const MIDI_HIGH = 108;

/** Nominal 12-TET MIDI note number for the lattice cell. Origin: A3 (MIDI 57)
 *  at (0, 0). Used to bound the retune search and to validate cells. */
export function coordToMidi(q: number, r: number): number {
  return 57 + 4 * q + 7 * r;
}

/** Frequency in Hz of (q, r) under `mode`. Independent of reference note. */
export function freqAt(q: number, r: number, mode: TuningMode): number {
  if (mode === 'E') return 220 * Math.pow(2, (4 * q + 7 * r) / 12);
  const b = Math.floor((q + 1) / 3);
  const p = ((q + 1) % 3 + 3) % 3;
  let f = 220 * Math.pow(2, b) * Math.pow(5 / 4, p - 1) * Math.pow(3 / 2, r);
  const qm = ((q % 3) + 3) % 3;
  /* Per-mode region adjustment (mirrors src/tuning/regions.ts). Only Pythagorean,
     Semiditonal, and Septimal have non-trivial regions; Equal already returned
     above and Ptolemaic returns the base 5-limit JI value. */
  if (mode === 'D') {
    if (qm === 2) f *= 80 / 81;          /* A-d1 upper: −SC */
  } else if (mode === 'P') {
    if (qm === 1) f *= 81 / 80;          /* A-d1 lower: +SC */
    else if (qm === 2) f *= 80 / 81;     /* A-d1 upper: −SC */
  } else if (mode === '7') {
    if (qm === 2) f *= (80 / 81) * (63 / 64); /* B-d1 upper: −SC + septimal */
  }
  return f;
}
