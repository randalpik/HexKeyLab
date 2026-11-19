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
/** The guide's sections of structures. */
export type Family = 'triad' | 'seventh' | 'augmented sixth' | 'scale';

export interface Structure {
  kind: StructureKind;
  family: Family;
  /** Spelled out in full: "minor triad in first inversion". A chord in root
   *  position is just "minor triad". */
  name: string;
  /** The name without the position: "minor triad". A scale's is its name. */
  title: string;
  /** The chord it is listed under, which its inversions share: its title. A
   *  scale's is its name. */
  chord: string;
  /** The members from the bass, ascending; the first is the unison. A scale
   *  ends on the octave. */
  members: ReadonlyArray<Exps>;
  /** How many times the chord it is listed under was turned, 0 for that chord
   *  itself: the position its name states, as an index into POSITION. */
  inversion: number;
}

type R = readonly [number, number];
const stack = (rs: ReadonlyArray<R>): Exps[] => [UNISON, ...rs.map(([n, d]) => expsOf(n, d))];

/* Root positions, as the ratios above the root. The third decides the triad;
   a minor third is 6/5 unless the name says Pythagorean (32/27) or septimal
   (7/6), a major third 5/4 unless it says Pythagorean (81/64). A structure's
   retunings sit next to it: the 5-limit one, the Pythagorean, the septimal.

   What is listed (Max, 2026-11-18 and -19): shapes that gain from just
   intonation and have a function in tonal harmony, and, for every tuning, the
   structures it takes to play in it. The second is why each chord and the
   major scale has a Pythagorean tuning here, 3-limit throughout: leaving them
   out would say that Pythagorean tuning cannot be played. Every lattice has
   3-limit keys, so every layout's guide holds these; only a layout with
   7-limit keys holds a septimal one. */
const TRIADS: ReadonlyArray<readonly [string, ReadonlyArray<R>]> = [
  ['major triad', [[5, 4], [3, 2]]],
  /* 64:81:96 */
  ['Pythagorean major triad', [[81, 64], [3, 2]]],
  ['minor triad', [[6, 5], [3, 2]]],
  ['Pythagorean minor triad', [[32, 27], [3, 2]]],
  /* 6:7:9 */
  ['septimal minor triad', [[7, 6], [3, 2]]],
  /* minor 3rd + Pythagorean minor 3rd */
  ['diminished triad', [[6, 5], [64, 45]]],
  /* 729:864:1024, two Pythagorean minor 3rds */
  ['Pythagorean diminished triad', [[32, 27], [1024, 729]]],
  /* 5:6:7, minor 3rd + septimal minor 3rd */
  ['septimal diminished triad', [[6, 5], [7, 5]]],
  /* 16:20:25, two major 3rds */
  ['augmented triad', [[5, 4], [25, 16]]],
  /* 4096:5184:6561, two Pythagorean major 3rds */
  ['Pythagorean augmented triad', [[81, 64], [6561, 4096]]],
];
/* The suspended chords, each listed by itself with no inversions (Max, 2026-11-19): the
   suspended fourth, 6:8:9, and the suspended second, 8:9:12. Each is the other turned, and
   HKL's chord namer (tuning/chords.ts), which the names here follow, gives each its own name in
   root position; their remaining inversion, 9:12:16, is left out. */
const SUSPENDED: ReadonlyArray<readonly [string, ReadonlyArray<R>]> = [
  ['suspended fourth chord', [[4, 3], [3, 2]]],
  ['suspended second chord', [[9, 8], [3, 2]]],
];
const SEVENTHS: ReadonlyArray<readonly [string, ReadonlyArray<R>]> = [
  /* major triad + Pythagorean minor 3rd */
  ['dominant seventh', [[5, 4], [3, 2], [16, 9]]],
  ['Pythagorean dominant seventh', [[81, 64], [3, 2], [16, 9]]],
  /* 4:5:6:7: the septimal dominant seventh chord holds a harmonic 7th interval (HKL's two
     names, kept apart: Max, 2026-11-18) */
  ['septimal dominant seventh', [[5, 4], [3, 2], [7, 4]]],
  ['minor seventh', [[6, 5], [3, 2], [9, 5]]],
  ['Pythagorean minor seventh', [[32, 27], [3, 2], [16, 9]]],
  /* 12:14:18:21, the septimal minor triad with a harmonic 7th */
  ['septimal minor seventh', [[7, 6], [3, 2], [7, 4]]],
  ['major seventh', [[5, 4], [3, 2], [15, 8]]],
  ['Pythagorean major seventh', [[81, 64], [3, 2], [243, 128]]],
  /* minor 3rd + Pythagorean minor 3rd + minor 3rd */
  ['diminished seventh', [[6, 5], [64, 45], [128, 75]]],
  /* three Pythagorean minor 3rds */
  ['Pythagorean diminished seventh', [[32, 27], [1024, 729], [32768, 19683]]],
  /* 135:162:189:224, minor 3rd + septimal minor 3rd + Pythagorean minor 3rd */
  ['septimal diminished seventh', [[6, 5], [7, 5], [224, 135]]],
  /* Pythagorean minor 3rd + minor 3rd + major 3rd */
  ['half-diminished seventh', [[32, 27], [64, 45], [16, 9]]],
  /* two Pythagorean minor 3rds + Pythagorean major 3rd */
  ['Pythagorean half-diminished seventh', [[32, 27], [1024, 729], [16, 9]]],
  /* 5:6:7:9, minor 3rd + septimal minor 3rd + septimal major 3rd */
  ['septimal half-diminished seventh', [[6, 5], [7, 5], [9, 5]]],
];
/* The augmented sixth chords, 5-limit: a major 3rd and an augmented 6th (225/128, which is
   7.7 cents above the harmonic 7th) over the bass. The Italian is those two; the French adds
   the augmented 4th between them (45/32, a major 3rd under the 6th) and the German the perfect
   5th. A sixth is a sixth here: none of them is a chord with a seventh spelled another way
   (Max, 2026-11-18). */
const AUGMENTED_SIXTHS: ReadonlyArray<readonly [string, ReadonlyArray<R>]> = [
  /* 128:160:225 */
  ['Italian augmented sixth chord', [[5, 4], [225, 128]]],
  /* 128:160:180:225 */
  ['French augmented sixth chord', [[5, 4], [45, 32], [225, 128]]],
  /* 128:160:192:225 */
  ['German augmented sixth chord', [[5, 4], [3, 2], [225, 128]]],
];
/* Every scale has the same root, second (9/8), fourth, fifth and octave. What
   its name says (Max, 2026-11-19):
     Ptolemaic     5-limit throughout: major 5/4, 5/3, 15/8; minor 6/5, 8/5, 9/5.
     Pythagorean   3-limit throughout, and nothing else: the scales Pythagorean
                   tuning plays. 81/64, 27/16, 243/128; 32/27, 128/81, 16/9.
     Semiditonal   the Pythagorean minor third (32/27) in a scale that is not
                   3-limit throughout: its minor sixth is Pythagorean too
                   (128/81), its major sixth and its leading tone 5-limit (5/3,
                   15/8). (Until 2026-11-19 the melodic one was called
                   Pythagorean, which broke the rule above.)
     septimal      the minor third and minor sixth septimal (7/6, 14/9), the rest
                   as the Semiditonal scale of its kind, or, for the natural
                   minor, the Pythagorean one (16/9).
   The harmonic minor has a minor sixth and a leading tone; the melodic minor is
   the ascending form, a major sixth and a leading tone. The minors are grouped
   by kind, so a scale sits next to its retunings. */
const SCALES: ReadonlyArray<readonly [string, ReadonlyArray<R>]> = [
  ['Ptolemaic major scale', [[9, 8], [5, 4], [4, 3], [3, 2], [5, 3], [15, 8], [2, 1]]],
  ['Pythagorean major scale', [[9, 8], [81, 64], [4, 3], [3, 2], [27, 16], [243, 128], [2, 1]]],
  ['Ptolemaic natural minor scale', [[9, 8], [6, 5], [4, 3], [3, 2], [8, 5], [9, 5], [2, 1]]],
  ['Pythagorean natural minor scale', [[9, 8], [32, 27], [4, 3], [3, 2], [128, 81], [16, 9], [2, 1]]],
  ['septimal natural minor scale', [[9, 8], [7, 6], [4, 3], [3, 2], [14, 9], [16, 9], [2, 1]]],
  ['Ptolemaic harmonic minor scale', [[9, 8], [6, 5], [4, 3], [3, 2], [8, 5], [15, 8], [2, 1]]],
  ['Semiditonal harmonic minor scale', [[9, 8], [32, 27], [4, 3], [3, 2], [128, 81], [15, 8], [2, 1]]],
  ['Pythagorean harmonic minor scale', [[9, 8], [32, 27], [4, 3], [3, 2], [128, 81], [243, 128], [2, 1]]],
  ['septimal harmonic minor scale', [[9, 8], [7, 6], [4, 3], [3, 2], [14, 9], [15, 8], [2, 1]]],
  ['Ptolemaic melodic minor scale', [[9, 8], [6, 5], [4, 3], [3, 2], [5, 3], [15, 8], [2, 1]]],
  ['Semiditonal melodic minor scale', [[9, 8], [32, 27], [4, 3], [3, 2], [5, 3], [15, 8], [2, 1]]],
  ['Pythagorean melodic minor scale', [[9, 8], [32, 27], [4, 3], [3, 2], [27, 16], [243, 128], [2, 1]]],
  ['septimal melodic minor scale', [[9, 8], [7, 6], [4, 3], [3, 2], [5, 3], [15, 8], [2, 1]]],
];

/** A chord's position in words, by inversion. From the first inversion on
 *  these are the words HKL's chord namer uses (tuning/chords.ts invNames; the
 *  oracle holds the two together); it says nothing for root position, and
 *  neither does a chord's full name. */
export const POSITION: ReadonlyArray<string> = ['in root position', 'in first inversion', 'in second inversion', 'in third inversion'];

/** A chord and each of its inversions: the bass moves up an octave and the
 *  next member becomes the bass. */
function withInversions(family: Family, name: string, root: ReadonlyArray<Exps>): Structure[] {
  const out: Structure[] = [];
  let members = root.slice();
  for (let inversion = 0; inversion < root.length; inversion++) {
    out.push({ kind: 'chord', family, name: inversion ? name + ' ' + POSITION[inversion] : name, title: name, chord: name, members, inversion });
    const [, next, ...rest] = members;
    members = [next, ...rest, OCTAVE].map((e) => subExps(e, next));
  }
  return out;
}

/** Every chord and scale, in guide order: the triads, each followed by its
 *  inversions, and the two suspended chords; the sevenths and the augmented
 *  sixths, each followed by its inversions; then the scales. */
export const STRUCTURES: ReadonlyArray<Structure> = [
  ...TRIADS.flatMap(([name, rs]) => withInversions('triad', name, stack(rs))),
  ...SUSPENDED.map(([name, rs]): Structure => ({ kind: 'chord', family: 'triad', name, title: name, chord: name, members: stack(rs), inversion: 0 })),
  ...SEVENTHS.flatMap(([name, rs]) => withInversions('seventh', name, stack(rs))),
  ...AUGMENTED_SIXTHS.flatMap(([name, rs]) => withInversions('augmented sixth', name, stack(rs))),
  ...SCALES.map(([name, rs]): Structure => ({ kind: 'scale', family: 'scale', name, title: name, chord: name, members: stack(rs), inversion: 0 })),
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
