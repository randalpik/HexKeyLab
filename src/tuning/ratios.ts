// JI ratio computation and harmonic-tier classification.

import { bandOf, posInBand } from '../layout/coords.js';
import { regionInfoWithState } from './regions.js';
import type { TuningStateLike } from './regions.js';
import { tuning } from '../state/tuning.js';
import type { JiRatio, IntervalTier, RegionInfo } from '../types.js';

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
 *  across every (septimalShift × septimalEnabled) configuration). */
export function jiRatioWithState(
  q1: number, r1: number, q2: number, r2: number,
  state: TuningStateLike,
): JiRatio {
  const db = bandOf(q2) - bandOf(q1), dp = posInBand(q2) - posInBand(q1), dr = r2 - r1;
  let e2 = db - 2 * dp - dr, e3 = dr, e5 = dp, e7 = 0;
  if (state.septimalEnabled) {
    const ri1 = regionInfoWithState(q1, r1, state), ri2 = regionInfoWithState(q2, r2, state);
    /* apply region adjustments: ratio gets adj2/adj1 */
    const applyAdj = (ri: RegionInfo, sign: number): void => {
      /* syntonic from corresponding A: upper ×(80/81)^d, lower ×(81/80)^d */
      if (ri.aDepth > 0) {
        const d = ri.aDepth;
        if (ri.aUpper) { e2 += sign * 4 * d; e5 += sign * d; e3 += sign * (-4) * d; }
        else { e3 += sign * 4 * d; e2 += sign * (-4) * d; e5 += sign * (-d); }
      }
      /* septimal: ×63/64 = ×(7·3²/2^6) */
      if (ri.type === 'B') { e7 += sign; e3 += sign * 2; e2 += sign * (-6); }
    };
    applyAdj(ri2, +1);
    applyAdj(ri1, -1);
  }
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

/** Octave-reduce + complement-reduce a prime-exponent vector. Returns the
 *  exponent vector for the equivalent ratio in [1, √2]:
 *  - Octave-reduce: subtract floor(log₂ratio) from e₂ so ratio ∈ [1, 2).
 *  - Complement-reduce: if ratio > √2, flip to 2/ratio so ratio ∈ [1, √2].
 *  This collapses octave- and complement-equivalent intervals to a single
 *  exp vector, which is what Tenney-Height-based ranking should be invariant
 *  under (otherwise canonical spellings flip across octaves — see Octave
 *  consistency check in /tmp/hkl-octave-bug.mjs and lessons.md). */
function reduceExps(e: ReadonlyArray<number>): readonly [number, number, number, number] {
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

/** Exact Tenney Height from a prime-exponent vector [e₂, e₃, e₅, e₇], with
 *  octave + complement reduction. Preferred when the ratio's num/den may
 *  exceed 2^53 (jiRatio's docstring warns about this for large exponents). */
export function tenneyHeightFromExps(e: ReadonlyArray<number>): number {
  const r = reduceExps(e);
  return Math.abs(r[0])
    + Math.abs(r[1]) * Math.log2(3)
    + Math.abs(r[2]) * Math.log2(5)
    + Math.abs(r[3]) * Math.log2(7);
}

export function intervalTier(num: number, den: number): IntervalTier {
  const th = tenneyHeight(num, den);
  if (th < 8) return 'green';
  if (th < 12.5) return 'yellow';
  return 'red';
}
