// Frequency calculation per tuning system. A3 = 220 Hz is the central reference.

import { bandOf, posInBand } from '../layout/coords.js';
import { regionInfoWithState, modeHasShifts, type TuningStateLike } from './regions.js';
import { tuning } from '../state/tuning.js';

/** Compute frequency under an arbitrary tuning state — used by the recording
 *  layer to resolve coordinates against a stored snapshot without mutating
 *  live `tuning`. The zero-arg `keyFreq` is a wrapper that passes live state. */
export function keyFreqWithState(q: number, r: number, s: TuningStateLike): number {
  if (s.mode === 'E') return 220 * Math.pow(2, (4 * q + 7 * r) / 12);
  const b = bandOf(q), p = posInBand(q);
  let f = 220 * Math.pow(2, b) * Math.pow(5 / 4, p - 1) * Math.pow(3 / 2, r);
  if (modeHasShifts(s.mode)) {
    const ri = regionInfoWithState(q, r, s);
    /* syntonic adjustment per region: aUpper=true → ×(80/81)^d (lower pitch);
       aUpper=false → ×(81/80)^d (raise pitch). */
    if (ri.aDepth > 0) f *= Math.pow(ri.aUpper ? 80 / 81 : 81 / 80, ri.aDepth);
    /* B-region cells additionally get the septimal comma */
    if (ri.type === 'B') f *= 63 / 64;
  }
  return f;
}

export function keyFreq(q: number, r: number): number {
  return keyFreqWithState(q, r, tuning);
}
