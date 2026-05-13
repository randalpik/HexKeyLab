// Frequency calculation per tuning system. A3 = 220 Hz is the central reference.

import { bandOf, posInBand } from '../layout/coords.js';
import { regionInfoWithState, type TuningStateLike } from './regions.js';
import { tuning } from '../state/tuning.js';

/** Compute frequency under an arbitrary tuning state — used by the recording
 *  layer to resolve coordinates against a stored snapshot without mutating
 *  live `tuning`. The zero-arg `keyFreq` is a wrapper that passes live state. */
export function keyFreqWithState(q: number, r: number, s: TuningStateLike): number {
  if (s.equalEnabled) return 220 * Math.pow(2, (4 * q + 7 * r) / 12);
  const b = bandOf(q), p = posInBand(q);
  let f = 220 * Math.pow(2, b) * Math.pow(5 / 4, p - 1) * Math.pow(3 / 2, r);
  if (s.septimalEnabled) {
    const ri = regionInfoWithState(q, r, s);
    /* syntonic adjustment from corresponding A's depth — direction cancels
       the natural 5-limit comma: upper A bands get ×80/81 (lower to match center),
       lower A bands get ×81/80 (raise to match center) */
    if (ri.aDepth > 0) f *= Math.pow(ri.aUpper ? 80 / 81 : 81 / 80, ri.aDepth);
    /* B bands additionally get septimal comma */
    if (ri.type === 'B') f *= 63 / 64;
    /* global syntonic tempering: 1/6 comma per shift step smooths the mod-42 boundary */
    if (s.septimalShift !== 0) f *= Math.pow(80 / 81, s.septimalShift / 6);
  }
  return f;
}

export function keyFreq(q: number, r: number): number {
  return keyFreqWithState(q, r, tuning);
}
