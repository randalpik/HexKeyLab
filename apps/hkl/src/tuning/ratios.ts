// JI ratio computation and harmonic-tier classification.

import { coordExps, reduceExps, tenneyHeightFromExps } from '@hkl/shared/freq.js';
import type { TuningStateLike } from './regions.js';
import { tuning } from '../state/tuning.js';
import type { JiRatio, IntervalTier } from '../types.js';

export function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

/** Like jiRatio() but takes the tuning state explicitly so callers can compute
 *  hypothetical ratios under non-live state (e.g. canvas-bounds enumeration
 *  across every septimalEnabled configuration). */
export function jiRatioWithState(
  q1: number, r1: number, q2: number, r2: number,
  state: TuningStateLike,
): JiRatio {
  /* Interval exps = vector difference of the two cells' canonical exponent
     vectors. coordExps (in @hkl/shared) owns the per-mode region/schisma math,
     so the frequency and interval paths can't drift. */
  const a = coordExps(q1, r1, state.mode), c = coordExps(q2, r2, state.mode);
  let e2 = c[0] - a[0], e3 = c[1] - a[1], e5 = c[2] - a[2], e7 = c[3] - a[3];
  let num = 1, den = 1;
  const apply = (base: number, exp: number): void => {
    if (exp > 0) num *= Math.pow(base, exp);
    else if (exp < 0) den *= Math.pow(base, -exp);
  };
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

export function jiRatio(q1: number, r1: number, q2: number, r2: number): JiRatio {
  return jiRatioWithState(q1, r1, q2, r2, tuning);
}

/* reduceExps + tenneyHeightFromExps now live in @hkl/shared/freq.ts (pure
   exp-vector math, shared with @hkl/notation's spelling picker). Re-exported
   here so existing callers (draw.ts etc.) keep their import site. */
export { reduceExps, tenneyHeightFromExps };

/** Tenney Height of the octave-and-complement-reduced ratio. Octave and
 *  complement equivalents (e.g. 5/4 ↔ 5/2 ↔ 8/5) all produce the same TH.
 *  This is what every TH-based ranking in the codebase needs — without
 *  reduction, |e₂| asymmetry across octaves picks different enharmonics for
 *  the same pitch class at different octaves. */
export function tenneyHeight(num: number, den: number): number {
  /* Reduce in ratio space (small inputs only; large exponents should go
     through tenneyHeightFromExps). */
  const g0 = gcd(num, den);
  let n = num / g0, d = den / g0;
  while (n > 2 * d) d *= 2;
  while (n < d) n *= 2;
  if (n * n > 2 * d * d) {
    const t = n; n = 2 * d; d = t;
  }
  const g1 = gcd(n, d);
  n /= g1; d /= g1;
  return Math.log2(n * d);
}

function tierOf(th: number): IntervalTier {
  if (th < 8) return 'green';
  if (th < 12.5) return 'yellow';
  return 'red';
}

export function intervalTier(num: number, den: number): IntervalTier {
  return tierOf(tenneyHeight(num, den));
}

/** Harmonic tier straight from the exponent vector — exact even when num/den
 *  overflow 2^53 (large Pythagorean stacks). Preferred in the analysis box. */
export function intervalTierFromExps(e: ReadonlyArray<number>): IntervalTier {
  return tierOf(tenneyHeightFromExps(e));
}

const SUP = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
function superscript(n: number): string {
  return String(n).split('').map((d) => SUP[+d] ?? d).join('');
}

/** Prime-power form of an interval's exponent vector, e.g. [−2,0,1,0] → "5:2²",
 *  [−6,2,−1,1] → "3²·7:2⁶·5". Positive exponents form the numerator, negative
 *  the denominator; exponent 1 prints bare; unison → "1:1". Used for the
 *  "Show factors" display and as the large-ratio fallback. The exponent vector
 *  is exact, so this never loses precision the way a rounded num:den can. */
export function fmtFactors(e: ReadonlyArray<number>): string {
  const primes = [2, 3, 5, 7];
  const nParts: string[] = [], dParts: string[] = [];
  for (let i = 0; i < 4; i++) {
    const pe = e[i] ?? 0;
    if (pe > 0) nParts.push(pe === 1 ? String(primes[i]) : primes[i] + superscript(pe));
    else if (pe < 0) dParts.push(-pe === 1 ? String(primes[i]) : primes[i] + superscript(-pe));
  }
  return (nParts.join('·') || '1') + ':' + (dParts.join('·') || '1');
}
