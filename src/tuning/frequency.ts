// Frequency calculation per tuning system. A3 = 220 Hz is the central reference.

import { bandOf, posInBand } from '../layout/coords.js';
import { regionInfo } from './regions.js';
import { tuning } from '../state/tuning.js';

export function keyFreq(q: number, r: number): number {
  if (tuning.equalEnabled) return 220 * Math.pow(2, (4 * q + 7 * r) / 12);
  const b = bandOf(q), p = posInBand(q);
  let f = 220 * Math.pow(2, b) * Math.pow(5 / 4, p - 1) * Math.pow(3 / 2, r);
  if (tuning.septimalEnabled) {
    const ri = regionInfo(q, r);
    /* syntonic adjustment from corresponding A's depth — direction cancels
       the natural 5-limit comma: upper A bands get ×80/81 (lower to match center),
       lower A bands get ×81/80 (raise to match center) */
    if (ri.aDepth > 0) f *= Math.pow(ri.aUpper ? 80 / 81 : 81 / 80, ri.aDepth);
    /* B bands additionally get septimal comma */
    if (ri.type === 'B') f *= 63 / 64;
    /* global syntonic tempering: 1/6 comma per shift step smooths the mod-42 boundary */
    if (tuning.septimalShift !== 0) f *= Math.pow(80 / 81, tuning.septimalShift / 6);
  }
  return f;
}
