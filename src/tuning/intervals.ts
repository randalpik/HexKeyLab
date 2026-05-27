// Interval naming via diatonic spelling + Pythagorean reference + comma decomposition.
//
// Algorithm:
//   1. Classify the (q1,r1)→(q2,r2) spelling into (ord, qual, extraOct).
//   2. Look up the Pythagorean reference exponent vector for (ord, qual).
//   3. Get the actual exponent vector via jiRatioWithState (mode-aware).
//   4. Decompose actual − pythagRef into (s, z, h) syntonic/septimal/schisma counts.
//   5. Look up an override name for (ord, qual, s, z), else use the algorithmic
//      "Pythagorean <bare>" default (perfect intervals never carry the prefix).
//   6. Schisma count h always renders as a suffix item.
//
// Complement symmetry is preserved by data shape: overrides are declared per
// complement pair; the second half is auto-mirrored (sign-flipped s/z, swapped
// M↔m/A↔d/ord↔9-ord and lesser↔greater) with an explicit `mirror:` escape
// hatch for class-specific names (apotome, harmonic 7th, chromatic semitone,
// diminished octave).

import { jiRatioWithState } from './ratios.js';
import type { TuningStateLike } from './regions.js';
import { noteName, parseNote, keyOctave } from '@hkl/shared/notes.js';

type PrimeExp = [number, number, number, number];
type CommaItem = [number, string]; /* [sign, name] */

/* factor integer into 2^a × 3^b × 5^c × 7^d */
export function factor7(n: number): PrimeExp | null {
  const e: PrimeExp = [0, 0, 0, 0];
  const p = [2, 3, 5, 7];
  for (let i = 0; i < 4; i++) while (n % p[i] === 0) { e[i]++; n /= p[i]; }
  return n === 1 ? e : null;
}

/* solve difference vector for comma counts: s(syntonic) z(septimal) h(schisma)
   syntonic=(-4,4,-1,0) septimal=(6,-2,0,-1) schisma=(-15,8,1,0) */
export function solveCommas(de: PrimeExp): [number, number, number] | null {
  const z = -de[3], hN = de[1] + 4 * de[2] - 2 * de[3];
  if (hN % 12 !== 0) return null;
  const h = hN / 12, s = h - de[2];
  if (de[0] !== -4 * s + 6 * z - 15 * h) return null;
  return [s, z, h];
}

/* Convert raw comma counts to displayable items. Each item corresponds to one
   HEJI glyph (arrow, hook, schisma marker). */
export function optimizeCommas(s: number, z: number, h: number): CommaItem[] {
  const items: CommaItem[] = [];
  for (let i = 0; i < Math.abs(s); i++) items.push([Math.sign(s), 'syntonic comma']);
  for (let i = 0; i < Math.abs(z); i++) items.push([Math.sign(z), 'septimal comma']);
  for (let i = 0; i < Math.abs(h); i++) items.push([Math.sign(h), 'schisma']);
  return items;
}

/* ordinal suffix for compound intervals */
export function ordSuffix(n: number): string {
  if (n === 1) return 'unison';
  if (n === 8) return 'octave';
  let s = '' + n;
  const lt = n % 100, l = n % 10;
  if (lt >= 11 && lt <= 13) s += 'th';
  else s += (l === 1 ? 'st' : l === 2 ? 'nd' : l === 3 ? 'rd' : 'th');
  return s;
}

export function octStr(n: number): string { return n === 1 ? 'octave' : n + ' octaves'; }

/* compound ordinal: "minor 3rd" + 1 oct → "minor 10th"; "perfect octave" + 1 oct → "perfect 15th" */
export function compoundOrd(name: string, ord: number, extraOct: number): string {
  if (!extraOct) return name;
  return name.replace(ordSuffix(ord), ordSuffix(ord + 7 * extraOct));
}

interface RefShape { name: string; ord: number; comma: number; }

/* format final interval name from base + comma items + extra octaves */
export function fmtInterval(ref: RefShape, commaItems: CommaItem[], extraOct: number): string {
  /* group same-sign same-name commas */
  interface CommaGroup { s: number; n: string; c: number; }
  const grps: CommaGroup[] = [];
  commaItems.forEach(c => {
    const last = grps.length ? grps[grps.length - 1] : null;
    if (last && last.s === c[0] && last.n === c[1]) last.c++;
    else grps.push({ s: c[0], n: c[1], c: 1 });
  });
  function fmtC(g: CommaGroup, first: boolean): string {
    const cnt = g.c > 1 ? g.c + '× ' : '';
    if (first) return cnt + g.n;
    return (g.s > 0 ? '+ ' : '− ') + cnt + g.n;
  }
  const isU = ref.name === 'perfect unison';
  if (isU) {
    if (!grps.length) return extraOct ? 'perfect ' + ordSuffix(7 * extraOct + 1) : 'perfect unison';
    const cs = grps.map((g, i) => fmtC(g, i === 0)).join(' ');
    return extraOct ? octStr(extraOct) + ' + ' + cs : cs;
  }
  let base: string;
  if (ref.ord > 0 && extraOct > 0) base = compoundOrd(ref.name, ref.ord, extraOct);
  else if (extraOct > 0) base = octStr(extraOct) + ' + ' + ref.name;
  else base = ref.name;
  if (!grps.length) return base;
  return base + ' ' + grps.map(g => fmtC(g, false)).join(' ');
}

/* ───── Diatonic classification ───── */

export interface DiatonicClass {
  ord: number;       // 1..8 (lookup ord)
  qual: string;      // 'P' | 'M' | 'm' | 'A' | 'd' | 'AA' | 'dd' | 'AAA' | 'ddd' | ...
  extraOct: number;  // extra octaves above (ord ∈ {1..8}) — compound intervals
}

export const letterIdx: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

/* Classify the diatonic interval implied by (q1,r1)→(q2,r2). Normalizes to
   ascending. Mirrors the equalIntervalName logic. */
export function classifyDiatonic(q1: number, r1: number, q2: number, r2: number): DiatonicClass {
  let semis = 4 * (q2 - q1) + 7 * (r2 - r1);
  const nn1 = noteName(q1, r1), nn2 = noteName(q2, r2);
  const li1 = letterIdx[parseNote(nn1).letter], li2 = letterIdx[parseNote(nn2).letter];
  const o1 = keyOctave(q1, r1), o2 = keyOctave(q2, r2);
  let p1 = li1 + 7 * o1, p2 = li2 + 7 * o2;
  if (p2 < p1) { const tmp = p1; p1 = p2; p2 = tmp; semis = -semis; }
  if (semis < 0) semis = -semis;
  const letters = p2 - p1;
  let ord: number, extraOct: number;
  if (letters === 0) { ord = 1; extraOct = 0; }
  else { ord = ((letters - 1) % 7) + 2; extraOct = Math.floor((letters - 1) / 7); }
  const generic = (ord - 1) % 7;
  /* index by ord so ord=8 (perfect octave) gets +12 semitones, not 0 */
  const nat = [0, 2, 4, 5, 7, 9, 11, 12];
  const expected = nat[ord - 1] + 12 * extraOct;
  const diff = semis - expected;
  const isPerfect = generic === 0 || generic === 3 || generic === 4;
  let qual: string;
  if (isPerfect) {
    if (diff === 0) qual = 'P';
    else if (diff > 0) qual = 'A'.repeat(diff);
    else qual = 'd'.repeat(-diff);
  } else {
    if (diff === 0) qual = 'M';
    else if (diff === -1) qual = 'm';
    else if (diff > 0) qual = 'A'.repeat(diff);
    else qual = 'd'.repeat(-diff - 1);
  }
  return { ord, qual, extraOct };
}

/* Pythagorean reference exponent vector for (ord, qual). For ord ∈ {1..7} the
   ratio is in [1, 2); for ord = 8 it's near 2 (octave class). Quality offsets
   are apotome-stacks: A = +7r, d (perfect) = -7r, d (major) = -14r. */
export function pythagRefExp(ord: number, qual: string): PrimeExp {
  const generic = (ord - 1) % 7;
  const isPerfect = generic === 0 || generic === 3 || generic === 4;
  const NATURAL_R = [0, 2, 4, -1, 1, 3, 5];
  let r = NATURAL_R[generic];
  let qualShift: number;
  if (qual === 'P' || qual === 'M') qualShift = 0;
  else if (qual === 'm') qualShift = -1;
  else if (qual[0] === 'A') qualShift = qual.length;
  else qualShift = isPerfect ? -qual.length : -(qual.length + 1);
  r += qualShift * 7;
  const log3 = Math.log2(3);
  /* Pick e2 so the ratio's cents lands near the spelled ordinal's expected cents.
     Otherwise a near-octave interval like d2 (which spans 23¢ ascending, i.e.
     letters=1, semis=0, exp 20·2 − 12·3 = 4096:531441 = ~24¢) gets octave-
     reduced into [1,2) at ~1176¢, and the Pythagorean comma (~24¢) then
     decomposes against it with a spurious 2× SC + 2× schisma shift. The target
     anchors per ord: P1=0, m2/M2=~100..200, m3/M3=~300..400, P4=500, P5=700,
     m6/M6=~800..900, m7/M7=~1000..1100, P8=1200. */
  const targetCents = [0, 100, 300, 500, 700, 800, 1000, 1200][ord - 1];
  const targetLog2 = targetCents / 1200;
  const rLog2 = r * log3;
  const e2 = Math.round(targetLog2 - rLog2);
  return [e2, r, 0, 0];
}

/* ───── Bare name + algorithmic Pythagorean default ───── */

function bareName(ord: number, qual: string): string {
  const ord_str = ordSuffix(ord);
  if (qual === 'P') return 'perfect ' + ord_str;
  if (qual === 'M') return 'major ' + ord_str;
  if (qual === 'm') return 'minor ' + ord_str;
  const isAug = qual[0] === 'A';
  const n = qual.length;
  const word = isAug ? 'augmented' : 'diminished';
  if (n === 1) return word + ' ' + ord_str;
  if (n === 2) return 'doubly ' + word + ' ' + ord_str;
  return n + '× ' + word + ' ' + ord_str;
}

/* Algorithmic default name at (ord, qual). Perfect intervals never carry the
   "Pythagorean" prefix (they're identical in 5-limit and Pythagorean tunings). */
function defaultPythagName(ord: number, qual: string): string {
  if (qual === 'P') return bareName(ord, qual);
  return 'Pythagorean ' + bareName(ord, qual);
}

/* ───── Override table ───── */

type ClassKey = string; /* `${ord},${qual}` */
const ck = (ord: number, qual: string): ClassKey => ord + ',' + qual;
function parseCK(k: ClassKey): [number, string] { const i = k.indexOf(','); return [+k.slice(0, i), k.slice(i + 1)]; }

interface OverrideEntry {
  s?: number;     /* default 0 */
  z?: number;     /* default 0 */
  name: string;
  mirror?: string;
}

interface PairDecl {
  c1: ClassKey;
  c2?: ClassKey;      /* omit for a single-class declaration (no auto-mirror) */
  pythag1?: string;
  pythag2?: string;
  entries: OverrideEntry[];
}

/* Each pair declares c1's overrides; c2 is auto-mirrored unless explicit
   `mirror:` is supplied. ord is in {1..8} (lookup ord, not compound). */
const PAIRS: PairDecl[] = [
  { c1: '3,M', c2: '6,m', entries: [
    { s: -1, name: 'major 3rd' },
    { s: +1, name: 'acute major 3rd' },     /* 6561:5120 ≈ 430¢; auto → 'grave minor 6th' (10240:6561) */
    { z: +1, name: 'septimal major 3rd' },
  ]},
  { c1: '3,m', c2: '6,M', entries: [
    { s: +1, name: 'minor 3rd' },
    { s: -1, name: 'grave minor 3rd' },     /* 2560:2187 ≈ 272¢; auto → 'acute major 6th' (2187:1280) */
    { z: -1, name: 'septimal minor 3rd' },
  ]},
  { c1: '2,M', c2: '7,m', entries: [
    { s: -1, name: 'major 2nd' },
    { s: +1, name: 'acute major 2nd' },     /* 729:640 ≈ 226¢; auto → 'grave minor 7th' (1280:729) */
    { z: +1, name: 'septimal major 2nd', mirror: 'harmonic 7th' },
  ]},
  { c1: '2,m', c2: '7,M', entries: [
    { s: +1,        name: 'lesser minor 2nd' },
    { s: +2,        name: 'greater minor 2nd' },
    { s: +1, z: -1, name: 'septimal minor 2nd' },
    { s:  0, z: -1, name: 'septimal subminor 2nd', mirror: 'septimal supermajor 7th' },  /* 28:27 ≈ 63¢ ↔ 27:14 ≈ 1137¢ */
  ]},
  { c1: '4,P', c2: '5,P', entries: [
    { s: +1, name: 'wolf 4th' },     /* auto → 'wolf 5th' */
    { z: -1, name: 'septimal 4th' }, /* auto → 'septimal 5th' */
  ]},
  { c1: '4,A', c2: '5,d', entries: [
    { s: -1,        name: 'greater augmented 4th' },  /* auto → 'lesser diminished 5th' */
    { s: -2,        name: 'lesser augmented 4th'  },  /* auto → 'greater diminished 5th' */
    { s:  0, z: +1, name: 'septimal augmented 4th' }, /* 81:56 ≈ 638¢; auto → 'septimal diminished 5th' (112:81 ≈ 562¢). Most accessible septimal A4 on the Lumatone (dist=4 vs 10:7 at dist=7). */
  ]},
  { c1: '1,A', c2: '8,d',
    pythag1: 'apotome',
    entries: [
      { s: -1,        name: 'greater chromatic semitone', mirror: 'lesser diminished octave' },
      { s: -2,        name: 'lesser chromatic semitone',  mirror: 'greater diminished octave' },
      { s: -1, z: +1, name: 'septimal chromatic semitone', mirror: 'septimal diminished octave' },
    ]
  },
  { c1: '2,A', c2: '7,d', entries: [
    { s: -1,        name: 'greater augmented 2nd' },  /* auto → 'lesser diminished 7th' */
    { s: -2,        name: 'lesser augmented 2nd' },   /* auto → 'greater diminished 7th' */
    { s: -1, z: +1, name: 'septimal augmented 2nd' }, /* 135:112 ≈ 324¢; auto → 'septimal diminished 7th' (224:135 ≈ 876¢). Most accessible septimal A2 on the Lumatone (dist=2 vs 25:21 unreachable). */
  ]},
  { c1: '3,d', c2: '6,A', entries: [
    { s: +1,        name: 'lesser diminished 3rd' },   /* auto → 'greater augmented 6th' */
    { s: +2,        name: 'greater diminished 3rd' },  /* auto → 'lesser augmented 6th' */
    { s: +1, z: -1, name: 'septimal diminished 3rd' }, /* auto → 'septimal augmented 6th' */
  ]},
  { c1: '4,d', c2: '5,A', entries: [
    { s: +1,        name: 'lesser diminished 4th' },   /* auto → 'greater augmented 5th' */
    { s: +2,        name: 'greater diminished 4th' },  /* auto → 'lesser augmented 5th' */
    { s: +1, z: -1, name: 'septimal diminished 4th' }, /* auto → 'septimal augmented 5th' */
  ]},
  { c1: '3,A', c2: '6,d', entries: [
    { s: -1,        name: 'augmented 3rd' },           /* auto → 'diminished 6th' */
    { s: -1, z: +1, name: 'septimal augmented 3rd' },  /* auto → 'septimal diminished 6th' */
  ]},
  /* (8, A) is single-class: its complement (1, d) is structurally unreachable
     because classifyDiatonic normalizes to ascending direction, so qual='d'
     never occurs for letters=0. Declared without c2 to avoid populating dead
     overrides. */
  { c1: '8,A', entries: [
    { s: -1,        name: 'greater augmented octave' },  /* 135:64 ≈ 1292¢ */
    { s: -2,        name: 'lesser augmented octave' },   /* 25:12 ≈ 1271¢ */
    { s: -1, z: +1, name: 'septimal augmented octave' }, /* 15:7 ≈ 1319¢; compound of septimal chromatic semitone (15:14) */
  ]},
  /* (7, A) ↔ (2, d): the diminished-2nd side is reachable (letters=1, semis=0,
     e.g. C# → Db) — it's the Pythagorean-comma class. Pythag (2, d, s=0) gets
     the conventional name. */
  { c1: '7,A', c2: '2,d',
    pythag2: 'Pythagorean comma',
    entries: [
      { s: -1, name: 'greater augmented 7th' },   /* 32805:16384 ≈ 1202¢; auto → 'lesser diminished 2nd' (schisma class) */
      { s: -2, name: 'lesser augmented 7th'  },   /* 2025:1024 ≈ 1181¢; auto → 'greater diminished 2nd' */
    ]
  },
  { c1: '1,P', c2: '8,P', entries: [] },
];

/* Auto-mirror a name from c1 to c2: ord-swap, M↔m / A↔d, flip lesser↔greater.
   Used when an OverrideEntry omits `mirror:`. Class-specific phrases like
   "chromatic semitone" or "harmonic 7th" cannot be auto-mirrored and require
   explicit `mirror:`. */
function qualWord(qual: string): string {
  if (qual === 'P') return 'perfect';
  if (qual === 'M') return 'major';
  if (qual === 'm') return 'minor';
  if (qual[0] === 'A') return qual.length === 1 ? 'augmented' : qual.length === 2 ? 'doubly augmented' : qual.length + '× augmented';
  return qual.length === 1 ? 'diminished' : qual.length === 2 ? 'doubly diminished' : qual.length + '× diminished';
}

function autoMirror(name: string, ord1: number, qual1: string, ord2: number, qual2: string): string {
  let r = name;
  /* swap ordinal suffix */
  const sfx1 = ordSuffix(ord1), sfx2 = ordSuffix(ord2);
  if (sfx1 !== sfx2) r = r.replace(new RegExp('\\b' + sfx1 + '\\b'), sfx2);
  /* swap quality word */
  const w1 = qualWord(qual1), w2 = qualWord(qual2);
  if (w1 !== w2) r = r.replace(new RegExp('\\b' + w1 + '\\b'), w2);
  /* flip lesser ↔ greater */
  r = r.replace(/\blesser\b/g, '\0L\0').replace(/\bgreater\b/g, 'lesser').replace(/\0L\0/g, 'greater');
  /* flip acute ↔ grave (wider/narrower on the opposite side from the common 5-limit form) */
  r = r.replace(/\bacute\b/g, '\0A\0').replace(/\bgrave\b/g, 'acute').replace(/\0A\0/g, 'grave');
  return r;
}

type LookupKey = string; /* `${ord},${qual},${s},${z}` */
const lk = (ord: number, qual: string, s: number, z: number): LookupKey => ord + ',' + qual + ',' + s + ',' + z;

const OVERRIDES = new Map<LookupKey, string>();
const PYTHAG_OVERRIDES = new Map<ClassKey, string>();

(function buildLookup(): void {
  for (const pair of PAIRS) {
    if (pair.pythag1) PYTHAG_OVERRIDES.set(pair.c1, pair.pythag1);
    const [ord1, qual1] = parseCK(pair.c1);
    const mirror = pair.c2 !== undefined ? parseCK(pair.c2) : null;
    if (mirror && pair.pythag2) PYTHAG_OVERRIDES.set(pair.c2!, pair.pythag2);
    for (const e of pair.entries) {
      const s = e.s ?? 0, z = e.z ?? 0;
      OVERRIDES.set(lk(ord1, qual1, s, z), e.name);
      if (mirror) {
        const [ord2, qual2] = mirror;
        const mName = e.mirror ?? autoMirror(e.name, ord1, qual1, ord2, qual2);
        OVERRIDES.set(lk(ord2, qual2, -s, -z), mName);
      }
    }
  }
})();

/* Index OVERRIDES by (ord, qual) for nearest-match lookup. */
const OVERRIDES_BY_CLASS = new Map<ClassKey, Array<{ s: number; z: number; name: string }>>();
(function buildIndex(): void {
  for (const [k, name] of OVERRIDES) {
    const i1 = k.indexOf(','), i2 = k.indexOf(',', i1 + 1), i3 = k.indexOf(',', i2 + 1);
    const ord = +k.slice(0, i1), qual = k.slice(i1 + 1, i2);
    const s = +k.slice(i2 + 1, i3), z = +k.slice(i3 + 1);
    const key = ck(ord, qual);
    let list = OVERRIDES_BY_CLASS.get(key);
    if (!list) { list = []; OVERRIDES_BY_CLASS.set(key, list); }
    list.push({ s, z, name });
  }
})();

/* Find the base interval name and residual (s, z) commas. Picks the override
   entry that minimizes |s − s_o| + |z − z_o|; the Pythagorean default sits
   at (s_o=0, z_o=0). Ties prefer 5-limit overrides (z_o=0) over septimal,
   and any override over the Pythagorean default — so (3,M,−2,0) renders as
   "major 3rd − syntonic comma" instead of "Pythagorean major 3rd − 2× SC". */
function findBaseName(ord: number, qual: string, s: number, z: number):
  { name: string; sRes: number; zRes: number } {
  const pythagName = PYTHAG_OVERRIDES.get(ck(ord, qual)) ?? defaultPythagName(ord, qual);
  let bestDist = Math.abs(s) + Math.abs(z);
  let bestTier = 2; /* Pythag default tier (least preferred basis) */
  let bestName = pythagName;
  let bestSRes = s, bestZRes = z;
  const candidates = OVERRIDES_BY_CLASS.get(ck(ord, qual));
  if (candidates) {
    for (const c of candidates) {
      const dist = Math.abs(s - c.s) + Math.abs(z - c.z);
      const tier = c.z === 0 ? 0 : 1; /* 5-limit beats septimal in ties */
      if (dist < bestDist || (dist === bestDist && tier < bestTier)) {
        bestDist = dist;
        bestTier = tier;
        bestName = c.name;
        bestSRes = s - c.s;
        bestZRes = z - c.z;
      }
    }
  }
  return { name: bestName, sRes: bestSRes, zRes: bestZRes };
}

/* ───── Public entry point ───── */

/* Coord-aware interval naming. Drives base interval choice from the diatonic
   spelling of the endpoints (letter distance + accidental delta), then
   decomposes the residual against the Pythagorean reference into (syntonic,
   septimal, schisma) counts. */
export function intervalNameFromCoords(q1: number, r1: number, q2: number, r2: number, state: TuningStateLike): string {
  const cls = classifyDiatonic(q1, r1, q2, r2);
  /* Use lookup ord ∈ {1..8} for overrides; multi-step quals (AA, dd, AAA, …)
     always fall through to defaultPythagName. */
  const pRef = pythagRefExp(cls.ord, cls.qual);
  const { e: actual, num, den } = jiRatioWithState(q1, r1, q2, r2, state);

  /* Align actual to the same octave class as pRef. jiRatioWithState normalizes
     ratios to ascending-JI (num ≥ den), while classifyDiatonic normalizes to
     ascending-LETTER spelling. For enharmonics where letter and JI directions
     disagree (e.g. A#→Bb, Pythagorean comma class d2), these two layers point
     opposite ways. Try both sign orientations of `actual`; the spelling-aligned
     one decomposes with the smaller comma count. */
  const log3 = Math.log2(3), log5 = Math.log2(5), log7 = Math.log2(7);
  function decomp(act: PrimeExp): { sol: [number, number, number] | null; octs: number } {
    const lA = act[0] + act[1] * log3 + act[2] * log5 + act[3] * log7;
    const lR = pRef[0] + pRef[1] * log3;
    const octs = Math.round(lA - lR);
    const red: PrimeExp = [act[0] - octs, act[1], act[2], act[3]];
    const de: PrimeExp = [red[0] - pRef[0], red[1] - pRef[1], red[2] - pRef[2], red[3] - pRef[3]];
    return { sol: solveCommas(de), octs };
  }
  const negActual: PrimeExp = [-actual[0], -actual[1], -actual[2], -actual[3]];
  const d1 = decomp(actual);
  const d2 = decomp(negActual);
  function score(s: { sol: [number, number, number] | null; octs: number } | null): number {
    if (!s || !s.sol) return Infinity;
    return Math.abs(s.sol[0]) + Math.abs(s.sol[1]) + Math.abs(s.sol[2]);
  }
  const best = score(d1) <= score(d2) ? d1 : d2;
  if (!best.sol) return num + ':' + den;
  const [s, z, h] = best.sol;
  /* best.octs already counts the spelling-implied octaves (it's derived from the
     actual exp, which contains them); don't add cls.extraOct or compounds get
     double-counted ("major 9th" became "major 16th"). */
  const totalExtraOct = best.octs;

  /* Pick the closest override as the base; surface (s, z) residual + schisma
     h as commas. Exact-match overrides have zero residual so they keep their
     existing one-comma-or-less rendering. */
  const base = findBaseName(cls.ord, cls.qual, s, z);
  const baseName = base.name;
  const commaItems = optimizeCommas(base.sRes, base.zRes, h);

  return fmtInterval({ name: baseName, ord: cls.ord, comma: 0 }, commaItems, totalExtraOct);
}

/* ───── Equal-mode naming (unchanged) ───── */

export function equalIntervalName(q1: number, r1: number, q2: number, r2: number): string {
  const cls = classifyDiatonic(q1, r1, q2, r2);
  if (cls.ord === 1 && cls.qual === 'P' && cls.extraOct === 0) return 'perfect unison';
  const ordinal = cls.ord + 7 * cls.extraOct;
  const ord = ordSuffix(ordinal);
  const qual = cls.qual;
  if (qual === 'P') return 'perfect ' + ord;
  if (qual === 'M') return 'major ' + ord;
  if (qual === 'm') return 'minor ' + ord;
  if (qual[0] === 'A') {
    const n = qual.length;
    if (n === 1) return 'augmented ' + ord;
    if (n === 2) return 'doubly augmented ' + ord;
    return n + '× augmented ' + ord;
  }
  /* qual[0] === 'd' */
  const n = qual.length;
  if (n === 1) return 'diminished ' + ord;
  if (n === 2) return 'doubly diminished ' + ord;
  return n + '× diminished ' + ord;
}

/* ───── Abbreviation for compact display ───── */

export function shortenInterval(name: string, short: boolean): string {
  if (!short) return name;
  /* multi-word phrases (before word-by-word) */
  name = name.replace(/syntonic comma/g, 'SC');
  name = name.replace(/septimal comma/g, '7C');
  name = name.replace(/Pythagorean comma/g, 'PC');
  name = name.replace(/septimal diesis/g, '7D');
  name = name.replace(/chromatic semitone/g, 'A1');
  /* Pythagorean → P (no collision with 'perfect → P' since ordinals differ:
     Pm3/PM3/Pm6/PM6/Pm2/PM7 vs P1/P4/P5/P8) */
  name = name.replace(/\bPythagorean\b/g, 'P');
  /* word-by-word */
  name = name.replace(/\bperfect\b/g, 'P'); name = name.replace(/\bminor\b/g, 'm');
  name = name.replace(/\bmajor\b/g, 'M'); name = name.replace(/\bdiminished\b/g, 'd');
  name = name.replace(/\baugmented\b/g, 'A'); name = name.replace(/\bharmonic\b/g, '7m');
  name = name.replace(/\bseptimal\b/g, '7'); name = name.replace(/\blesser\b/g, '&lt;');
  name = name.replace(/\bgreater\b/g, '&gt;'); name = name.replace(/\bwolf\b/g, 'W');
  name = name.replace(/\bunison\b/g, '1');
  name = name.replace(/(\d+) octaves\b/g, '$1×P8');
  name = name.replace(/\boctave\b/g, 'P8');
  name = name.replace(/(\d+)(?:st|nd|rd|th)\b/g, '$1');
  name = name.replace(/\bdiaschisma\b/g, 'Ds'); name = name.replace(/\bschisma\b/g, 'Sc');
  name = name.replace(/\bdiesis\b/g, 'D'); name = name.replace(/\bapotome\b/g, 'A');
  name = name.replace(/\bcomma\b/g, 'C');
  /* structural cleanup */
  name = name.replace(/ /g, '');
  name = name.replace(/\+/g, ' + ').replace(/−/g, ' − ');
  name = name.replace(/× /g, '×');
  name = name.replace(/([7W])([45])(?!\d)/g, '$1P$2');
  return name;
}
