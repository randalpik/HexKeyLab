// The lattice shape guide's catalog: which structures the guide shows, as exact
// just ratios. It knows no layout and no tuning mode — where a structure's keys
// sit on a lattice is the solver's job (./solve.ts), and what it is called
// there is HKL's namers' (./guide.ts).
//
// A structure is its members' ratios from the bass, ascending. Internally a
// ratio is its prime-exponent vector [e2, e3, e5, e7], the same form coordExps
// returns, so a member is compared with a lattice cell exactly.
//
// Pure: no DOM and no state, so the Node oracle (test/shapes/) imports it.

/** Prime exponents of 2, 3, 5 and 7. */
export type Exps = readonly [number, number, number, number];

const PRIMES = [2, 3, 5, 7] as const;
export const UNISON: Exps = [0, 0, 0, 0];
export const OCTAVE: Exps = [1, 0, 0, 0];

/** The exponent vector of `num/den`. Throws on a prime above 7. */
export function expsOf(num: number, den: number): Exps {
  const e = [0, 0, 0, 0];
  PRIMES.forEach((p, i) => {
    while (num % p === 0) { num /= p; e[i]++; }
    while (den % p === 0) { den /= p; e[i]--; }
  });
  if (num !== 1 || den !== 1) throw new Error('ratio has a prime above 7');
  return [e[0], e[1], e[2], e[3]];
}
export const addExps = (a: Exps, b: Exps): Exps => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
export const subExps = (a: Exps, b: Exps): Exps => [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
export const expsKey = (e: Exps): string => e.join(',');
export function centsOf(e: Exps): number {
  return 1200 * (e[0] + e[1] * Math.log2(3) + e[2] * Math.log2(5) + e[3] * Math.log2(7));
}
/** `e` as [numerator, denominator]. */
export function ratioOf(e: Exps): readonly [number, number] {
  let num = 1, den = 1;
  PRIMES.forEach((p, i) => { if (e[i] > 0) num *= p ** e[i]; else den *= p ** -e[i]; });
  return [num, den];
}
/** The smallest whole numbers in the members' proportions, low to high: "4:5:6". */
export function combinedRatio(members: ReadonlyArray<Exps>): string {
  const lo = PRIMES.map((_, i) => Math.min(...members.map((e) => e[i])));
  return members.map((e) => PRIMES.reduce((n, p, i) => n * p ** (e[i] - lo[i]), 1)).join(':');
}

export type StructureKind = 'chord' | 'scale';

export interface Structure {
  kind: StructureKind;
  /** Spelled out in full: "minor triad in first inversion". A chord in root
   *  position is just "minor triad". */
  name: string;
  /** The name without the inversion: "minor triad". A scale's is its name. */
  title: string;
  /** The members from the bass, ascending; the first is the unison. A scale
   *  ends on the octave. */
  members: ReadonlyArray<Exps>;
  /** A chord's inversion, 0 in root position. */
  inversion: number;
}

type R = readonly [number, number];
const stack = (rs: ReadonlyArray<R>): Exps[] => [UNISON, ...rs.map(([n, d]) => expsOf(n, d))];

/* Root positions, as the ratios above the root. The third decides the triad;
   a minor third is 6/5 unless the name says Pythagorean (32/27). */
const TRIADS: ReadonlyArray<readonly [string, ReadonlyArray<R>]> = [
  ['major triad', [[5, 4], [3, 2]]],
  ['minor triad', [[6, 5], [3, 2]]],
  ['Pythagorean minor triad', [[32, 27], [3, 2]]],
  /* minor 3rd + Pythagorean minor 3rd */
  ['diminished triad', [[6, 5], [64, 45]]],
];
const SEVENTHS: ReadonlyArray<readonly [string, ReadonlyArray<R>]> = [
  /* major triad + Pythagorean minor 3rd */
  ['dominant seventh', [[5, 4], [3, 2], [16, 9]]],
  ['minor seventh', [[6, 5], [3, 2], [9, 5]]],
  ['Pythagorean minor seventh', [[32, 27], [3, 2], [16, 9]]],
  ['major seventh', [[5, 4], [3, 2], [15, 8]]],
  /* minor 3rd + Pythagorean minor 3rd + minor 3rd */
  ['diminished seventh', [[6, 5], [64, 45], [128, 75]]],
  /* Pythagorean minor 3rd + minor 3rd + major 3rd */
  ['half-diminished seventh', [[32, 27], [64, 45], [16, 9]]],
];
/* Every scale has the same root, second (9/8), fourth, fifth and octave. A
   Pythagorean scale takes the Pythagorean third; a lowered seventh is always
   Pythagorean (16/9) and a leading tone always 5-limit (15/8). The melodic
   minor is the ascending form, with a 5/3 sixth. */
const SCALES: ReadonlyArray<readonly [string, ReadonlyArray<R>]> = [
  ['Ptolemaic major scale', [[9, 8], [5, 4], [4, 3], [3, 2], [5, 3], [15, 8], [2, 1]]],
  ['Pythagorean natural minor scale', [[9, 8], [32, 27], [4, 3], [3, 2], [128, 81], [16, 9], [2, 1]]],
  ['Ptolemaic harmonic minor scale', [[9, 8], [6, 5], [4, 3], [3, 2], [8, 5], [15, 8], [2, 1]]],
  ['Pythagorean melodic minor scale', [[9, 8], [32, 27], [4, 3], [3, 2], [5, 3], [15, 8], [2, 1]]],
];

/** A chord's position in words, by inversion. From the first inversion on
 *  these are the words HKL's chord namer uses (tuning/chords.ts invNames; the
 *  oracle holds the two together); it says nothing for root position, and
 *  neither does a chord's full name. */
export const POSITION: ReadonlyArray<string> = ['in root position', 'in first inversion', 'in second inversion', 'in third inversion'];

/** A chord and each of its inversions: the bass moves up an octave and the
 *  next member becomes the bass. */
function withInversions(name: string, root: ReadonlyArray<Exps>): Structure[] {
  const out: Structure[] = [];
  let members = root.slice();
  for (let inversion = 0; inversion < root.length; inversion++) {
    out.push({ kind: 'chord', name: inversion ? name + ' ' + POSITION[inversion] : name, title: name, members, inversion });
    const [, next, ...rest] = members;
    members = [next, ...rest, OCTAVE].map((e) => subExps(e, next));
  }
  return out;
}

/** Every chord and scale, in guide order: the triads, then the sevenths, each
 *  followed by its inversions; then the scales. */
export const STRUCTURES: ReadonlyArray<Structure> = [
  ...TRIADS.flatMap(([name, rs]) => withInversions(name, stack(rs))),
  ...SEVENTHS.flatMap(([name, rs]) => withInversions(name, stack(rs))),
  ...SCALES.map(([name, rs]): Structure => ({ kind: 'scale', name, title: name, members: stack(rs), inversion: 0 })),
];

/** The intervals that occur within a structure: between any two of its members
 *  as written, lower to upper, each once. */
export function intervalsWithin(s: Structure): Exps[] {
  const seen = new Map<string, Exps>();
  for (let i = 0; i < s.members.length; i++) for (let j = i + 1; j < s.members.length; j++) {
    const e = subExps(s.members[j], s.members[i]);
    if (!seen.has(expsKey(e))) seen.set(expsKey(e), e);
  }
  return [...seen.values()];
}

/** The intervals the guide enumerates, by size: every interval within any
 *  structure. A scale repeats at the octave, so each of its intervals also
 *  counts from its upper note up to the lower note's octave; with the chords'
 *  inversions, that closes the set under octave complement. */
export function intervalSet(): Exps[] {
  const seen = new Map<string, Exps>();
  const add = (e: Exps): void => { if (!seen.has(expsKey(e))) seen.set(expsKey(e), e); };
  for (const s of STRUCTURES) for (const e of intervalsWithin(s)) {
    add(e);
    if (s.kind === 'scale' && expsKey(e) !== expsKey(OCTAVE)) add(subExps(OCTAVE, e));
  }
  return [...seen.values()].sort((a, b) => centsOf(a) - centsOf(b));
}
