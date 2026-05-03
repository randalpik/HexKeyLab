// @ts-nocheck
// JI ratio computation and harmonic-tier classification.

import { bandOf, posInBand } from '../layout/coords.js';
import { regionInfo } from './regions.js';
import { septimalEnabled } from '../state/tuning.js';

export function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

export function jiRatio(q1, r1, q2, r2) {
  const db = bandOf(q2) - bandOf(q1), dp = posInBand(q2) - posInBand(q1), dr = r2 - r1;
  let e2 = db - 2 * dp - dr, e3 = dr, e5 = dp, e7 = 0;
  if (septimalEnabled) {
    const ri1 = regionInfo(q1, r1), ri2 = regionInfo(q2, r2);
    /* apply region adjustments: ratio gets adj2/adj1 */
    function applyAdj(ri, sign) {
      /* syntonic from corresponding A: upper ×(80/81)^d, lower ×(81/80)^d */
      if (ri.aDepth > 0) {
        const d = ri.aDepth;
        if (ri.aUpper) { e2 += sign * 4 * d; e5 += sign * d; e3 += sign * (-4) * d; }
        else { e3 += sign * 4 * d; e2 += sign * (-4) * d; e5 += sign * (-d); }
      }
      /* septimal: ×63/64 = ×(7·3²/2^6) */
      if (ri.type === 'B') { e7 += sign; e3 += sign * 2; e2 += sign * (-6); }
    }
    applyAdj(ri2, +1);
    applyAdj(ri1, -1);
  }
  let num = 1, den = 1;
  function apply(base, exp) {
    if (exp > 0) num *= Math.pow(base, exp);
    else if (exp < 0) den *= Math.pow(base, -exp);
  }
  apply(2, e2); apply(3, e3); apply(5, e5); apply(7, e7);
  /* ensure num ≥ den (ascending interval); negate exponents on swap so the
     returned exponent vector stays consistent with num:den direction */
  if (num < den) { const t = num; num = den; den = t; e2 = -e2; e3 = -e3; e5 = -e5; e7 = -e7; }
  num = Math.round(num);
  den = Math.round(den);
  const g = gcd(num, den);
  /* num/den may be imprecise for large exponents (e.g. 3^36 / 2^57 from stacked
     Pythagorean commas exceeds 2^53); the exponent vector is always exact and
     should be preferred by consumers that need to factor the interval. */
  return { num: num / g, den: den / g, e: [e2, e3, e5, e7] };
}

export function intervalTier(num, den) {
  /* octave-reduce the ratio to [1, 2) */
  let n = num, d = den;
  while (n > 2 * d) d *= 2;
  while (n < d) n *= 2;
  const g2 = gcd(n, d);
  n /= g2;
  d /= g2;
  /* complement-reduce to [1, sqrt(2)] so interval and complement share same tier */
  if (n * n > 2 * d * d) { const t = n; n = 2 * d; d = t; const g3 = gcd(n, d); n /= g3; d /= g3; }
  const th = Math.log2(n * d);
  if (th < 8) return 'green';
  if (th < 12.5) return 'yellow';
  return 'red';
}
