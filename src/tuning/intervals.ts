// Interval naming via reference table + comma decomposition, plus Equal-mode
// interval naming from note spelling.

import { gcd } from './ratios.js';
import { noteName, parseNote, keyOctave } from './notes.js';

type PrimeExp = [number, number, number, number];
type CommaItem = [number, string]; /* [sign, name] */

interface RefEntry {
  n: number;
  d: number;
  name: string;
  e: PrimeExp;
  ord: number;
  comma: number;
  th: number;
}

/* factor integer into 2^a × 3^b × 5^c × 7^d */
export function factor7(n: number): PrimeExp | null {
  const e: PrimeExp = [0, 0, 0, 0];
  const p = [2, 3, 5, 7];
  for (let i = 0; i < 4; i++) while (n % p[i] === 0) { e[i]++; n /= p[i]; }
  return n === 1 ? e : null;
}

/* reference table: each entry is {n, d, name, e:[e2,e3,e5,e7], ord, comma, th} */
export const REF: RefEntry[] = [];
(function () {
  function add(n: number, d: number, name: string, ord: number, comma: number): void {
    const fn = factor7(n), fd = factor7(d);
    if (!fn || !fd) throw new Error('REF entry not 7-limit: ' + n + '/' + d);
    REF.push({
      n, d, name,
      e: [fn[0] - fd[0], fn[1] - fd[1], fn[2] - fd[2], fn[3] - fd[3]],
      ord, comma, th: Math.log2(n * d),
    });
  }
  /* commas */
  add(32805, 32768, 'schisma', 0, 1); add(2048, 2025, 'diaschisma', 0, 1);
  add(81, 80, 'syntonic comma', 0, 1); add(531441, 524288, 'Pythagorean comma', 0, 1);
  add(64, 63, 'septimal comma', 0, 1); add(36, 35, 'septimal diesis', 0, 1);
  /* non-ordinal intervals */
  add(1, 1, 'perfect unison', 1, 0); add(128, 125, 'diesis', 0, 0); add(2187, 2048, 'apotome', 0, 0);
  add(25, 24, 'lesser chromatic semitone', 0, 0); add(135, 128, 'greater chromatic semitone', 0, 0);
  add(15, 14, 'septimal chromatic semitone', 0, 0);
  add(7, 5, 'lesser septimal tritone', 0, 0); add(10, 7, 'greater septimal tritone', 0, 0);
  /* 2nds */
  add(256, 243, 'Pythagorean minor 2nd', 2, 0);
  add(21, 20, 'septimal minor 2nd', 2, 0); add(16, 15, 'lesser minor 2nd', 2, 0); add(27, 25, 'greater minor 2nd', 2, 0);
  add(10, 9, 'lesser major 2nd', 2, 0); add(9, 8, 'greater major 2nd', 2, 0); add(8, 7, 'septimal major 2nd', 2, 0);
  add(75, 64, 'augmented 2nd', 2, 0); add(25, 21, 'septimal augmented 2nd', 2, 0);
  /* 3rds */
  add(256, 225, 'diminished 3rd', 3, 0);
  add(7, 6, 'septimal minor 3rd', 3, 0); add(32, 27, 'Pythagorean minor 3rd', 3, 0); add(6, 5, 'minor 3rd', 3, 0);
  add(5, 4, 'major 3rd', 3, 0); add(81, 64, 'Pythagorean major 3rd', 3, 0); add(9, 7, 'septimal major 3rd', 3, 0);
  /* 4ths */
  add(32, 25, 'diminished 4th', 4, 0);
  add(21, 16, 'septimal 4th', 4, 0); add(4, 3, 'perfect 4th', 4, 0); add(27, 20, 'wolf 4th', 4, 0);
  add(25, 18, 'lesser augmented 4th', 4, 0); add(45, 32, 'greater augmented 4th', 4, 0);
  /* 5ths */
  add(64, 45, 'lesser diminished 5th', 5, 0); add(36, 25, 'greater diminished 5th', 5, 0);
  add(40, 27, 'wolf 5th', 5, 0); add(3, 2, 'perfect 5th', 5, 0); add(32, 21, 'septimal 5th', 5, 0);
  add(25, 16, 'augmented 5th', 5, 0);
  /* 6ths */
  add(14, 9, 'septimal minor 6th', 6, 0); add(128, 81, 'Pythagorean minor 6th', 6, 0); add(8, 5, 'minor 6th', 6, 0);
  add(5, 3, 'major 6th', 6, 0); add(27, 16, 'Pythagorean major 6th', 6, 0); add(12, 7, 'septimal major 6th', 6, 0);
  add(225, 128, 'augmented 6th', 6, 0);
  /* 7ths */
  add(128, 75, 'diminished 7th', 7, 0); add(42, 25, 'septimal diminished 7th', 7, 0);
  add(7, 4, 'harmonic 7th', 7, 0); add(16, 9, 'lesser minor 7th', 7, 0); add(9, 5, 'greater minor 7th', 7, 0);
  add(50, 27, 'lesser major 7th', 7, 0); add(15, 8, 'greater major 7th', 7, 0); add(243, 128, 'Pythagorean major 7th', 7, 0); add(40, 21, 'septimal major 7th', 7, 0);
  /* octave-class */
  add(256, 135, 'lesser diminished octave', 8, 0); add(48, 25, 'greater diminished octave', 8, 0); add(28, 15, 'septimal diminished octave', 8, 0);
})();

/* solve difference vector for comma counts: s(syntonic) z(septimal) h(schisma)
   syntonic=(-4,4,-1,0) septimal=(6,-2,0,-1) schisma=(-15,8,1,0) */
export function solveCommas(de: PrimeExp): [number, number, number] | null {
  const z = -de[3], hN = de[1] + 4 * de[2] - 2 * de[3];
  if (hN % 12 !== 0) return null;
  const h = hN / 12, s = h - de[2];
  if (de[0] !== -4 * s + 6 * z - 15 * h) return null;
  return [s, z, h];
}

/* substitute derived commas to minimize displayed count
   Pythagorean = syntonic+schisma, diaschisma = syntonic-schisma, sept.diesis = syntonic+septimal */
export function optimizeCommas(s: number, z: number, h: number): CommaItem[] {
  /* try all 6 orderings of 3 substitution rules to minimize display groups */
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  let bestItems: CommaItem[] | null = null;
  let bestGrps = 99;
  for (let oi = 0; oi < 6; oi++) {
    let cs = s, cz = z, ch = h;
    const items: CommaItem[] = [];
    for (let si = 0; si < 3; si++) {
      const rule = orders[oi][si];
      if (rule === 0) {/* septimal diesis: syn+sept same sign */
        while (cs > 0 && cz > 0) { items.push([1, 'septimal diesis']); cs--; cz--; }
        while (cs < 0 && cz < 0) { items.push([-1, 'septimal diesis']); cs++; cz++; }
      } else if (rule === 1) {/* Pythagorean: syn+sch same sign */
        while (cs > 0 && ch > 0) { items.push([1, 'Pythagorean comma']); cs--; ch--; }
        while (cs < 0 && ch < 0) { items.push([-1, 'Pythagorean comma']); cs++; ch++; }
      } else {/* diaschisma: syn and sch opposite sign */
        while (cs > 0 && ch < 0) { items.push([1, 'diaschisma']); cs--; ch++; }
        while (cs < 0 && ch > 0) { items.push([-1, 'diaschisma']); cs++; ch--; }
      }
    }
    while (cs > 0) { items.push([1, 'syntonic comma']); cs--; }
    while (cs < 0) { items.push([-1, 'syntonic comma']); cs++; }
    while (cz > 0) { items.push([1, 'septimal comma']); cz--; }
    while (cz < 0) { items.push([-1, 'septimal comma']); cz++; }
    while (ch > 0) { items.push([1, 'schisma']); ch--; }
    while (ch < 0) { items.push([-1, 'schisma']); ch++; }
    /* count display groups (distinct sign+name pairs) */
    const gk: Record<string, true> = {};
    items.forEach(c => { gk[c[0] + '|' + c[1]] = true; });
    const ng = Object.keys(gk).length;
    if (ng < bestGrps || (ng === bestGrps && items.length < (bestItems?.length ?? Infinity))) {
      bestGrps = ng;
      bestItems = items.slice();
    }
  }
  return bestItems ?? [];
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

/* compound ordinal: "minor 3rd" + 1 oct → "minor 10th" */
export function compoundOrd(name: string, ord: number, extraOct: number): string {
  if (!extraOct) return name;
  return name.replace(ordSuffix(ord), ordSuffix(ord + 7 * extraOct));
}

interface RefShape { name: string; ord: number; comma: number; }

/* format final interval name from decomposition result */
export function fmtInterval(ref: RefShape, commaItems: CommaItem[], extraOct: number, isComp: boolean): string {
  /* if ref is a comma, fold it into comma list and use perfect unison as effective ref */
  if (ref.comma) {
    commaItems = ([[1, ref.name] as CommaItem]).concat(commaItems);
    ref = { name: 'perfect unison', ord: 1, comma: 0 };
  }
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
  if (isComp) {
    grps.forEach(g => { g.s *= -1; });
    const totOct = extraOct + 1;
    if (isU && !grps.length) return octStr(totOct);
    if (isU) return octStr(totOct) + ' ' + grps.map(g => fmtC(g, false)).join(' ');
    const base = octStr(totOct) + ' − ' + ref.name;
    if (!grps.length) return base;
    return base + ' ' + grps.map(g => fmtC(g, false)).join(' ');
  }
  /* direct match */
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

export function intervalName(num: number, den: number, preE?: PrimeExp): string {
  let e: PrimeExp;
  if (preE) {
    /* exponents passed in directly (from jiRatio) — exact even when num/den
       have overflowed float precision */
    e = [preE[0], preE[1], preE[2], preE[3]];
  } else {
    const fn = factor7(num), fd = factor7(den);
    if (!fn || !fd) return num + ':' + den;
    e = [fn[0] - fd[0], fn[1] - fd[1], fn[2] - fd[2], fn[3] - fd[3]];
  }
  /* octave-reduce to [1,2) using log2(ratio) computed from exponents —
     robust for extreme exponents where num/den may be imprecise or overflow */
  const log2R = e[0] + e[1] * Math.log2(3) + e[2] * Math.log2(5) + e[3] * Math.log2(7);
  const extraOct = Math.max(0, Math.floor(log2R + 1e-9));
  const re: PrimeExp = [e[0] - extraOct, e[1], e[2], e[3]];
  /* count display groups for scoring */
  function cScore(items: CommaItem[], isComp: boolean): number {
    const gk: Record<string, true> = {};
    items.forEach(c => { gk[c[0] + '|' + c[1]] = true; });
    return Object.keys(gk).length * 100 + items.length + (isComp ? 0.5 : 0);
  }
  /* try direct decomposition against all references */
  let best: { ref: RefEntry; items: CommaItem[]; score: number; comp: boolean } | null = null;
  for (let i = 0; i < REF.length; i++) {
    const ref = REF[i];
    const de: PrimeExp = [re[0] - ref.e[0], re[1] - ref.e[1], re[2] - ref.e[2], re[3] - ref.e[3]];
    const sol = solveCommas(de);
    if (!sol) continue;
    const items = optimizeCommas(sol[0], sol[1], sol[2]);
    const score = cScore(items, false);
    if (!best || score < best.score || (score === best.score && ref.th < best.ref.th))
      best = { ref, items, score, comp: false };
  }
  /* try complement decomposition (handles V=12 edge cases and octave-minus forms) */
  const ce: PrimeExp = [1 - re[0], -re[1], -re[2], -re[3]];
  for (let i = 0; i < REF.length; i++) {
    const ref = REF[i];
    const de: PrimeExp = [ce[0] - ref.e[0], ce[1] - ref.e[1], ce[2] - ref.e[2], ce[3] - ref.e[3]];
    const sol = solveCommas(de);
    if (!sol) continue;
    const items = optimizeCommas(sol[0], sol[1], sol[2]);
    const score = cScore(items, true);
    if (!best || score < best.score || (score === best.score && ref.th < best.ref.th))
      best = { ref, items, score, comp: true };
  }
  if (!best) return num + ':' + den;
  return fmtInterval(best.ref, best.items, extraOct, best.comp);
}

/* abbreviate interval name for compact display.
   `short` is the user's "Short intervals" preference (was: read directly from
   document.getElementById('cbShortIvl').checked). */
export function shortenInterval(name: string, short: boolean): string {
  if (!short) return name;
  /* phase 1: full-phrase special cases */
  name = name.replace(/lesser septimal tritone/g, '7d5');
  name = name.replace(/greater septimal tritone/g, '7A4');
  /* multi-word comma/interval phrases (before word-by-word) */
  name = name.replace(/syntonic comma/g, 'SC');
  name = name.replace(/septimal comma/g, '7C');
  name = name.replace(/Pythagorean comma/g, 'PC');
  name = name.replace(/septimal diesis/g, '7D');
  name = name.replace(/chromatic semitone/g, 'A1');
  /* Pythagorean → P (no collision with 'perfect → P' since ordinals differ:
     Pm3/PM3/Pm6/PM6/Pm2/PM7 vs P1/P4/P5/P8) */
  name = name.replace(/\bPythagorean\b/g, 'P');
  /* phase 2: word-by-word */
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
  /* phase 3: structural cleanup */
  name = name.replace(/ /g, '');
  name = name.replace(/\+/g, ' + ').replace(/−/g, ' − ');
  name = name.replace(/× /g, '×');
  name = name.replace(/([7W])([45])(?!\d)/g, '$1P$2');
  return name;
}

export const letterIdx: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

/* Equal mode interval naming (from note spelling, no ratios) */
export function equalIntervalName(q1: number, r1: number, q2: number, r2: number): string {
  let semis = 4 * (q2 - q1) + 7 * (r2 - r1);
  /* compute letter distance from actual note names + octaves */
  const nn1 = noteName(q1, r1), nn2 = noteName(q2, r2);
  const li1 = letterIdx[parseNote(nn1).letter], li2 = letterIdx[parseNote(nn2).letter];
  const o1 = keyOctave(q1, r1), o2 = keyOctave(q2, r2);
  let p1 = li1 + 7 * o1, p2 = li2 + 7 * o2;
  /* ensure ascending */
  if (p2 < p1) { const tmp = p1; p1 = p2; p2 = tmp; semis = -semis; }
  if (semis < 0) semis = -semis;
  const letters = p2 - p1;
  if (letters === 0 && semis === 0) return 'perfect unison';
  const ordinal = letters + 1;
  const generic = letters % 7;
  const extraOct = Math.floor(letters / 7);
  const nat = [0, 2, 4, 5, 7, 9, 11];
  const expected = nat[generic] + 12 * extraOct;
  const diff = semis - expected;
  const isPerfect = generic === 0 || generic === 3 || generic === 4;
  const ord = ordSuffix(ordinal);
  if (isPerfect) {
    if (diff === 0) return 'perfect ' + ord;
    if (diff === 1) return 'augmented ' + ord;
    if (diff === 2) return 'doubly augmented ' + ord;
    if (diff === -1) return 'diminished ' + ord;
    if (diff === -2) return 'doubly diminished ' + ord;
    return (diff > 0 ? '' : 'doubly ') + (Math.abs(diff) > 2 ? Math.abs(diff) - 1 + '× ' : '') + (diff > 0 ? 'augmented ' : 'diminished ') + ord;
  }
  if (diff === 0) return 'major ' + ord;
  if (diff === -1) return 'minor ' + ord;
  if (diff === 1) return 'augmented ' + ord;
  if (diff === -2) return 'diminished ' + ord;
  if (diff === 2) return 'doubly augmented ' + ord;
  if (diff === -3) return 'doubly diminished ' + ord;
  return (diff > 0 ? '' : 'doubly ') + (Math.abs(diff) > 2 ? Math.abs(diff) - (diff > 0 ? 1 : 2) + '× ' : '') + (diff > 0 ? 'augmented ' : 'diminished ') + ord;
}
