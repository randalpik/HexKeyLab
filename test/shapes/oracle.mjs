// Shape-guide oracle (docs/architecture/hkl.md → Lattice shapes).
//
// Pure Node gate — no dev server, no browser, no audio. Imports the REAL catalog, solver and guide
// (apps/hkl/src/shapes/) and HKL's namers through the repo's TS loader, and checks:
//   A  the catalog: 75 chord entries (triads, sevenths, augmented sixths) and 9 scales in guide
//      order, an inversion that is a chord in its own right under its own name (the suspended
//      second chord, the suspended fourth chord's first inversion), a septimal structure next to
//      the one it retunes; every inversion is its root position turned (the bass up an octave);
//      members ascend; a scale runs unison to octave over 9/8, 4/3 and 3/2; a septimal minor
//      scale is the minor scale of its kind with 7/6 for its minor third and 14/9 for its minor
//      sixth, and nothing else moved
//   B  the interval set: 53 (35 without a 7, 18 with), each one between two members of a
//      structure or, for a scale (which repeats at the octave), the octave complement of one;
//      closed under octave complement
//   C  Randal in Ptolemaic, banded — every entry is on the lattice; each key sounds its member's
//      ratio from the bass exactly; the bass is the C of its position (purple left, spring green
//      center, pink right), the three pinned; the valid positions equal the closed form
//      −lo … 2 − hi over the members' 5-exponents; center is drawn whenever it is valid
//   D  HKL's chord namer (analyzeChord) gives every chord entry the catalog's name, position
//      and the ratio of the chord it is named as, in Randal in Ptolemaic and again in Randal in
//      Septimal (section H): the guide follows the namer, with no exceptions
//   E  path keys: every one-turn path between any two members is built here from the six
//      directions. The solver's path keys link every member; no smaller subset of the candidate
//      keys does (every subset is tried); and of the equally small subsets (all tried, where
//      there are at most 400,000) it has the most edges between a path key and a member, and
//      of those it reaches highest in pitch. An interval takes the path through its higher corner
//   F  seams: none when the bass can start anywhere or the keys sit in one band; otherwise one per
//      band boundary the keys cross, each segment between adjacent keys of neighboring bands. A
//      seam runs along R for as far as the keys reach along R, edge to edge, and one segment past
//      that at either end: checked in whole numbers (a key at q + 2r, half key widths), so every
//      seam of a shape starts level and ends level and is one unbroken run
//   G  the guide: 94 entries (Randal in Ptolemaic holds exactly what has no 7 in it: 59
//      structures and 31 intervals), structures then intervals by number and size; full and short interval
//      names all distinct; every pair of keys in every structure is named by HKL exactly as the
//      guide's interval of that ratio; an entry lists its steps, then every other interval between
//      two of its own keys, lower to upper, a scale's less the octave (11, 11, 8, 12, 12 and 13 for the
//      four scales); an interval's one step is itself; the short forms the guide quotes (an octave
//      shortens as a 4th or 5th does: P8, <d8, WP8)
//   R  rows (rows.ts), over every sequence of up to seven entries: each entry once and in order;
//      a row never gives an entry less room than it needs, and holds no more entries than its
//      columns; the whole width only for an entry that needs it; a short row of thirds only at
//      the end; an entry alone on a half only when last or before a whole-width entry; three
//      thirds are never split; two thirds before two halves share their row as halves
//   H  any layout: under each of the eight presets in every mode the guide is made for
//      (SHAPE_GUIDE_MODES: not Equal, not Schismatic; 48 layouts), every shape the solver returns
//      is exact (the counts are printed, not pinned), and the bass and the arrangement follow the
//      solver's order, each rule re-derived here from the lattice. A shape may start from any
//      key named C in reach of the reference. Nearness is real space, not key steps: the
//      lattice as a regular hexagonal grid, computed here from the keys' places on it (and the
//      solver's keyDistance is held to that, and to within 1% of HKL's own screen geometry).
//      Each key is as near the bass as any key of its pitch; of equally near keys, none chosen otherwise lies closer together, and of those
//      none stands higher on the page. Then, in order: (1) no C that holds the shape is plainer
//      than the one drawn (a plain C before a C with an arrow or a hook); (2) of the plainest,
//      none holds it nearer its bass; (3) of those, none starts nearer the spine column; (4) of
//      those, no other arrangement stands higher above its bass; (5) of level ones, and of one
//      shape from two columns, none is written with fewer HEJI arrows; (6) the left one. Of the
//      Cs of one column that hold the shape alike, the nearest the reference. What rule 1 costs
//      rule 2 is measured and pinned: the shapes some marked C would hold nearer than the plain
//      C drawn (9 of them, all in Syntonic, by at most 0.54 key widths in all). The
//      positions listed are exactly the columns where the same keys, moved with a C of that
//      column, sound the members. No choice is left to scan order (`undecided` is empty on
//      every shape). Pinned: Wicki-Hayden in Syntonic draws its wolf 5th four steps and three
//      (√37 key widths), not six and one (√43), which are as many steps. "Higher on the page" is measured on HKL's
//      real screen geometry (layout/geometry.ts) in the guide's pose, not by the solver's
//      2q + 7r; marks are counted as the 5- and 7-exponents of a key's pitch, and every drawn
//      key's exponents are held to the arrows and hooks HKL's label function gives it. Pinned:
//      Park plays its major 2nd from the plain C of column 4, not the C↓ of column 2, and in
//      Septimal its Pythagorean minor 3rd from a C with no hook; Randal in Pythagorean plays its
//      minor 2nd, two adjacent keys, from center or right; a band of another width numbers its
//      columns ("column 3 or 4 or 5")
// Run: node --import ./test/orchestrator-smoke/register-ts.mjs test/shapes/oracle.mjs

import {
  STRUCTURES, POSITION, UNISON, OCTAVE, intervalSet, intervalsWithin, combinedRatio, expsKey, expsOf, addExps, subExps, centsOf, ratioOf,
} from '../../apps/hkl/src/shapes/catalog.ts';
import { solve, hexDistance, keyDistance, positionLabel, GUIDE_ROTATION, GUIDE_ALIGNMENT } from '../../apps/hkl/src/shapes/solve.ts';
import { setHexSize, setRotation, hexToScreen, dxH } from '../../apps/hkl/src/layout/geometry.ts';
import { buildGuide } from '../../apps/hkl/src/shapes/guide.ts';
import { rowsOf } from '../../apps/hkl/src/shapes/rows.ts';
import { analyzeChord } from '../../apps/hkl/src/tuning/chords.ts';
import { intervalNameFromCoords, shortenInterval } from '../../apps/hkl/src/tuning/intervals.ts';
import { coordExps, coordToMidi, freqAt, anchorOf, SHAPE_GUIDE_MODES } from '../../packages/shared/src/freq.ts';
import { MAPPINGS, bandOfCell, posInBandOf, bandWidth, layoutOf as matrixOf } from '../../packages/shared/src/mapping.ts';
import { noteName } from '../../packages/shared/src/notes.ts';
import { keyColor } from '../../packages/shared/src/keycolor.ts';
import { hejiCommasFor } from '../../packages/shared/src/heji.ts';

let checks = 0, fails = 0;
function check(label, got, want) {
  checks++;
  if (got !== want) { fails++; if (fails <= 40) console.log(`FAIL ${label}: got ${got}, want ${want}`); }
}
const layoutOf = (mapping, mode) => ({ mode, mapping, anchor: anchorOf(0, 0, mapping), banded: true });
const stateOf = (l) => ({ ...l, equalEnabled: false, septimalEnabled: l.mode === '7', septimalW: 1 });
const exps = (c, l) => coordExps(c[0], c[1], l.mode, l.mapping, l.anchor, l.banded);
const freq = (c, l) => freqAt(c[0], c[1], l.mode, l.mapping, l.anchor, l.banded);
const keys = (cells) => cells.map(String).sort().join(' ');

/* ── A. the catalog ── */
const chords = STRUCTURES.filter((s) => s.kind === 'chord'), scales = STRUCTURES.filter((s) => s.kind === 'scale');
check('A chord entries', chords.length, 75);
check('A chord entries by family', ['triad', 'seventh', 'augmented sixth'].map((f) => chords.filter((x) => x.family === f).length).join(' '), '24 40 11');
check('A families in order', [...new Set(STRUCTURES.map((x) => x.family))].join(' > '), 'triad > seventh > augmented sixth > scale');
check('A scales', scales.length, 9);
check('A order: chords first', STRUCTURES.findIndex((s) => s.kind === 'scale'), 75);
check('A names', STRUCTURES.filter((s) => s.inversion === 0).map((s) => s.name).join('; '),
  'major triad; minor triad; Pythagorean minor triad; septimal minor triad; diminished triad; septimal diminished triad; '
  + 'augmented triad; suspended fourth chord; '
  + 'dominant seventh; septimal dominant seventh; minor seventh; Pythagorean minor seventh; septimal minor seventh; major seventh; '
  + 'diminished seventh; septimal diminished seventh; half-diminished seventh; septimal half-diminished seventh; '
  + 'Italian augmented sixth chord; French augmented sixth chord; German augmented sixth chord; '
  + 'Ptolemaic major scale; Ptolemaic natural minor scale; Pythagorean natural minor scale; septimal natural minor scale; '
  + 'Ptolemaic harmonic minor scale; septimal harmonic minor scale; '
  + 'Ptolemaic melodic minor scale; Pythagorean melodic minor scale; septimal melodic minor scale');
check('A the chords added 2026-11-18', ['septimal dominant seventh', 'septimal minor seventh', 'augmented triad', 'suspended fourth chord',
  'Italian augmented sixth chord', 'French augmented sixth chord', 'German augmented sixth chord']
  .map((n) => combinedRatio(STRUCTURES.find((x) => x.name === n).members)).join(' '), '4:5:6:7 12:14:18:21 16:20:25 6:8:9 128:160:225 128:160:180:225 128:160:192:225');
/* the augmented sixths: a major 3rd and the augmented 6th 225/128 over the bass; the French adds
   the augmented 4th a major 3rd under the 6th, the German the perfect 5th (Max, 2026-11-18) */
{
  const of = (n) => STRUCTURES.find((x) => x.name === n).members.map(expsKey).join(' '), k = (...rs) => [[1, 1], ...rs].map(([n, d]) => expsKey(expsOf(n, d))).join(' ');
  check('A Italian sixth', of('Italian augmented sixth chord'), k([5, 4], [225, 128]));
  check('A French sixth', of('French augmented sixth chord'), k([5, 4], [45, 32], [225, 128]));
  check('A German sixth', of('German augmented sixth chord'), k([5, 4], [3, 2], [225, 128]));
  check('A the French sixth\'s 4th is a major 3rd under its 6th', expsKey(subExps(expsOf(225, 128), expsOf(45, 32))), expsKey(expsOf(5, 4)));
}
/* the melodic minors differ in their third alone: 6/5, 32/27, 7/6 */
check('A the melodic minors', ['Ptolemaic', 'Pythagorean', 'septimal'].map((n) => { const m = STRUCTURES.find((x) => x.name === n + ' melodic minor scale').members;
  return [ratioOf(m[2]).join('/'), m.filter((_, i) => i !== 2).map(expsKey).join(' ') === STRUCTURES.find((x) => x.name === 'Pythagorean melodic minor scale').members.filter((_, i) => i !== 2).map(expsKey).join(' ')].join(' '); }).join('; '),
  '6/5 true; 32/27 true; 7/6 true');
check('A the Ptolemaic natural minor', combinedRatio(STRUCTURES.find((x) => x.name === 'Ptolemaic natural minor scale').members.slice(0, 7)),
  combinedRatio([[1, 1], [9, 8], [6, 5], [4, 3], [3, 2], [8, 5], [9, 5]].map(([n, d]) => expsOf(n, d))));
/* the septimal chords, by their proportions (Max, 2026-11-18) */
check('A septimal chords', ['septimal minor triad', 'septimal diminished triad', 'septimal half-diminished seventh', 'septimal diminished seventh']
  .map((n) => combinedRatio(STRUCTURES.find((x) => x.name === n).members)).join(' '), '6:7:9 5:6:7 5:6:7:9 135:162:189:224');
/* a septimal minor scale: the minor scale of its kind, its minor third and minor sixth septimal */
for (const [septimal, plain] of [['septimal natural minor scale', 'Pythagorean natural minor scale'], ['septimal harmonic minor scale', 'Ptolemaic harmonic minor scale'],
  ['septimal melodic minor scale', 'Pythagorean melodic minor scale']]) {
  const a = STRUCTURES.find((x) => x.name === septimal).members, b = STRUCTURES.find((x) => x.name === plain).members;
  const minor3 = new Set([expsOf(6, 5), expsOf(32, 27)].map(expsKey)), minor6 = new Set([expsOf(8, 5), expsOf(128, 81)].map(expsKey));
  const want = b.map((e) => (minor3.has(expsKey(e)) ? expsOf(7, 6) : minor6.has(expsKey(e)) ? expsOf(14, 9) : e));
  check(`A ${septimal}: ${plain} with septimal minor third and sixth`, a.map(expsKey).join(' '), want.map(expsKey).join(' '));
}
check('A names are distinct', new Set(STRUCTURES.map((s) => s.name)).size, STRUCTURES.length);
let root = null;
const renamedAll = [];
for (const s of STRUCTURES) {
  check(`A ${s.name}: starts on the unison`, expsKey(s.members[0]), expsKey(UNISON));
  for (let i = 1; i < s.members.length; i++) check(`A ${s.name}: member ${i} ascends`, centsOf(s.members[i]) > centsOf(s.members[i - 1]), true);
  if (s.kind === 'scale') {
    check(`A ${s.name}: its title is its name`, s.title, s.name);
    check(`A ${s.name}: 8 notes`, s.members.length, 8);
    check(`A ${s.name}: ends on the octave`, expsKey(s.members[7]), expsKey(OCTAVE));
    check(`A ${s.name}: 9/8, 4/3, 3/2`, [1, 3, 4].map((i) => expsKey(s.members[i])).join(' '), [expsOf(9, 8), expsOf(4, 3), expsOf(3, 2)].map(expsKey).join(' '));
    continue;
  }
  if (s.inversion === 0) root = s;
  /* an inversion that is a chord in its own right has its own title and is in root position */
  const renamed = s.title !== root.name;
  if (renamed) renamedAll.push(`${s.name} = ${root.name}, inversion ${s.inversion}`);
  check(`A ${s.name}: position`, s.position, renamed ? 0 : s.inversion);
  check(`A ${s.name}: family`, s.family, root.family);
  check(`A ${s.name}: name is the title and, when not in root position, its position`, s.name, s.position ? `${s.title} ${POSITION[s.position]}` : s.title);
  check(`A ${s.name}: within an octave`, centsOf(s.members[s.members.length - 1]) < 1200, true);
  /* the root position's members from the `inversion`-th up, then the rest an octave higher */
  const k = s.inversion, turned = [...root.members.slice(k), ...root.members.slice(0, k).map((e) => addExps(e, OCTAVE))].map((e) => subExps(e, root.members[k]));
  check(`A ${s.name}: is ${root.name} turned ${k}`, s.members.map(expsKey).join(' '), turned.map(expsKey).join(' '));
}

check('A inversions that are chords in their own right', renamedAll.join('; '), 'suspended second chord = suspended fourth chord, inversion 1');
/* the chord an entry is named as: itself when it is in root position, otherwise the chord it is
   an inversion of. HKL's chord namer prints that chord's ratio */
const namedAs = (name) => { const i = STRUCTURES.findIndex((x) => x.name === name); return STRUCTURES[i].position === 0 ? STRUCTURES[i] : STRUCTURES.slice(0, i + 1).reverse().find((x) => x.inversion === 0); };

/* ── B. the interval set ── */
const SET = intervalSet(), setKeys = new Set(SET.map(expsKey));
check('B size', SET.length, 53);
check('B without a 7, with one', `${SET.filter((e) => e[3] === 0).length} ${SET.filter((e) => e[3] !== 0).length}`, '35 18');
for (const e of SET) {
  if (expsKey(e) === expsKey(OCTAVE)) continue;
  check(`B complement of ${expsKey(e)}`, setKeys.has(expsKey(subExps(OCTAVE, e))), true);
}
const realized = new Set();
for (const s of STRUCTURES) {
  for (let i = 0; i < s.members.length; i++) for (let j = i + 1; j < s.members.length; j++) {
    const k = expsKey(subExps(s.members[j], s.members[i]));
    realized.add(k);
    check(`B ${s.name} pair ${i}-${j} in the set`, setKeys.has(k), true);
  }
  if (s.kind === 'scale') for (const e of intervalsWithin(s)) realized.add(expsKey(subExps(OCTAVE, e)));   /* a scale repeats at the octave */
}
check('B nothing in the set is unused', SET.every((e) => realized.has(expsKey(e))), true);

/* ── C–G. Randal in Ptolemaic ── */
const L = layoutOf('randal', '5'), ST = stateOf(L);
const guide = buildGuide(L);
const HUE = { 0: 'PU', 1: 'SG', 2: 'PK' }, BASS = { 0: '2,-1', 1: '-3,3', 2: '-5,7' };
const DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
/* the keys strictly between a and b on each shortest path that turns at most once, with its corner */
function oneTurnPaths(a, b) {
  const d = hexDistance(a, b), out = [];
  for (const u of DIRS) for (const w of DIRS) for (let m = 1; m <= d; m++) {
    const n = d - m;
    if (n === 0 ? w !== DIRS[0] : u === w) continue;
    if (a[0] + m * u[0] + n * w[0] !== b[0] || a[1] + m * u[1] + n * w[1] !== b[1]) continue;
    const between = [];
    for (let i = 1; i <= m; i++) between.push([a[0] + i * u[0], a[1] + i * u[1]]);
    for (let i = 1; i <= n; i++) between.push([a[0] + m * u[0] + i * w[0], a[1] + m * u[1] + i * w[1]]);
    between.pop();
    out.push({ corner: n ? [a[0] + m * u[0], a[1] + m * u[1]] : null, between });
  }
  return out;
}
check('G entries', guide.length, 94);
/* Randal in Ptolemaic has no 7-limit keys: it holds the structures without a 7, all of them */
const FIVE = STRUCTURES.filter((x) => x.members.every((e) => e[3] === 0));
check('G the structures without a 7', FIVE.length, 59);
check('G positions', POSITION.join('; '), 'in root position; in first inversion; in second inversion; in third inversion');
for (const [i, g] of guide.entries()) {
  const s = FIVE[i];
  check(`G ${g.name}: title`, g.title, s ? s.title : g.name);
  check(`G ${g.name}: subtitle`, g.subtitle, s && s.kind === 'chord' ? POSITION[s.position] : '');
  check(`G ${g.name}: family`, g.family, s ? s.family : 'interval');
  /* an interval's cents, from its printed ratio: one decimal and the cent sign, as the info panel has it */
  const [num, den] = g.ratio.split(':').map(Number);
  check(`G ${g.name}: cents`, g.cents, s ? '' : (1200 * Math.log2(num / den)).toFixed(1) + '¢');
}
check('G structures first, in catalog order', guide.slice(0, 59).map((g) => g.name).join(';'), FIVE.map((s) => s.name).join(';'));
let sameDirection = 0, seamed = 0;
let exhaustive = 0, pathKeyTotal = 0;
const tied = [], byTouch = [];
for (const g of guide) {
  const sh = g.shape;
  /* C: exact members, the bass, the positions */
  g.members.forEach((m, i) => check(`C ${g.name}: member ${i} exact`, expsKey(subExps(exps(sh.cells[i], L), exps(sh.bass, L))), expsKey(m)));
  check(`C ${g.name}: bass first`, String(sh.cells[0]), String(sh.bass));
  check(`C ${g.name}: bass is C`, noteName(sh.bass[0], sh.bass[1], L.mapping, L.anchor, L.banded), 'C');
  check(`C ${g.name}: bass in its position`, posInBandOf(sh.bass[0], sh.bass[1], L.mapping), sh.position);
  check(`C ${g.name}: bass cell`, String(sh.bass), BASS[sh.position]);
  check(`C ${g.name}: bass hue`, keyColor(sh.bass[0], sh.bass[1], L.mode, L.mapping, L.anchor, L.banded).hue, HUE[sh.position]);
  const fives = g.members.map((e) => e[2]), lo = Math.min(...fives), hi = Math.max(...fives);
  const want = [0, 1, 2].filter((p) => p >= -lo && p <= 2 - hi);
  check(`C ${g.name}: positions`, sh.positions.join(), want.join());
  check(`C ${g.name}: draws center when valid`, sh.position, want.includes(1) ? 1 : want[0]);
  check(`C ${g.name}: start label`, g.start, want.length === 3 ? 'any' : want.map((p) => ['left', 'center', 'right'][p]).join(' or '));
  check(`C ${g.name}: keys are distinct`, new Set([...sh.cells, ...sh.path].map(String)).size, sh.cells.length + sh.path.length);

  /* D: HKL's chord namer */
  if (g.kind === 'chord') {
    const res = analyzeChord(sh.cells.map(([q, r]) => ({ q, r, name: '', col: '' })), ST);
    check(`D ${g.name}: HKL name`, res ? res.quality + (res.invName ? ' ' + res.invName : '') : 'none', g.name);
    check(`D ${g.name}: HKL ratio`, res ? res.ratio : 'none', combinedRatio(namedAs(g.name).members));
  }

  /* E: the path keys */
  const members = new Set(sh.cells.map(String)), links = [], cellOf = new Map();
  for (let i = 0; i < sh.cells.length; i++) for (let j = i + 1; j < sh.cells.length; j++) {
    const paths = oneTurnPaths(sh.cells[i], sh.cells[j]);
    check(`E ${g.name}: ${i}-${j} has 1 or 2 one-turn paths`, paths.length === 1 || paths.length === 2, true);
    for (const p of paths) {
      const extra = p.between.filter((c) => !members.has(String(c)));
      extra.forEach((c) => cellOf.set(String(c), c));
      links.push({ i, j, keys: extra.map(String) });
    }
  }
  /* whether drawing `shown` puts a one-turn path between enough pairs of members to link them all */
  const linksAll = (shown) => {
    const parent = sh.cells.map((_, i) => i), find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (const l of links) if (l.keys.every((k) => shown.has(k))) parent[find(l.i)] = find(l.j);
    return sh.cells.every((_, i) => find(i) === find(0));
  };
  const drawn = new Set(sh.path.map(String));
  check(`E ${g.name}: path keys are not members`, sh.path.some((c) => members.has(String(c))), false);
  check(`E ${g.name}: path keys link every member`, linksAll(drawn), true);
  /* every set of the candidate keys of a given size that links the members */
  const pool = [...cellOf.keys()];
  const linkingSets = (size) => {
    const found = [], pick = [];
    const visit = (from) => {
      if (pick.length === size) { if (linksAll(new Set(pick))) found.push([...pick]); return; }
      for (let k = from; k < pool.length; k++) { pick.push(pool[k]); visit(k + 1); pick.pop(); }
    };
    visit(0);
    return found;
  };
  let smaller = 0;
  for (let size = 0; size < sh.path.length; size++) smaller += linkingSets(size).length;
  check(`E ${g.name}: no smaller set links them`, smaller, 0);
  /* of the equally small sets: the most edges where a path key touches a member, then the one
     that reaches highest, by its highest key and then the next */
  const highFirst = (set) => set.map((k) => freq(cellOf.get(k), L)).sort((a, b) => b - a);
  const touches = (set) => set.reduce((n, k) => n + sh.cells.filter((m) => hexDistance(cellOf.get(k), m) === 1).length, 0);
  const mine = highFirst([...drawn]), myTouches = touches([...drawn]);
  const binom = (n, k) => { let b = 1; for (let i = 0; i < k; i++) b = b * (n - i) / (i + 1); return b; };
  if (binom(pool.length, sh.path.length) <= 400000) {
    const equals = linkingSets(sh.path.length);
    exhaustive++;
    if (equals.length > 1) tied.push(g.name);
    const most = Math.max(...equals.map(touches));
    check(`E ${g.name}: touches its members along the most edges`, myTouches, most);
    if (equals.some((e) => touches(e) < most)) byTouch.push(g.name);
    for (const other of equals.filter((e) => touches(e) === most)) {
      const theirs = highFirst(other), at = mine.findIndex((f, i) => f !== theirs[i]);
      check(`E ${g.name}: reaches higher than ${other.join(' ')}`, at < 0 || mine[at] > theirs[at], true);
    }
  }
  if (g.kind === 'interval') {
    /* one pair: the path through the higher corner (two legs in one direction: the larger step first) */
    const paths = oneTurnPaths(sh.cells[0], sh.cells[1]);
    if (paths.length === 2) {
      const [f0, f1] = paths.map((p) => freq(p.corner, L));
      check(`E ${g.name}: takes the higher corner`, keys(sh.path), keys((f1 > f0 ? paths[1] : paths[0]).between));
      const from = freq(sh.cells[0], L), to = freq(sh.cells[1], L);
      if (paths.every((p) => freq(p.corner, L) > from && freq(p.corner, L) < to)) sameDirection++;
    }
  } else pathKeyTotal += sh.path.length;

  /* F: the seams. Randal's run along R, where a key at (q, r) sits at q + 2r in half key widths
     and reaches 1 to either side; a seam segment between two adjacent keys covers the half key
     width between their two positions. */
  const along = (c) => c[0] + 2 * c[1];
  const shown = [...sh.cells, ...sh.path], bands = shown.map((c) => bandOfCell(c[0], c[1], L.mapping));
  const tLo = Math.min(...shown.map(along)), tHi = Math.max(...shown.map(along));
  const crossed = sh.positions.length === 3 ? 0 : Math.max(...bands) - Math.min(...bands);
  if (crossed) seamed++;
  /* the keys reach from tLo − 1 to tHi + 1: that many segments, and one past either end */
  const perSeam = tHi - tLo + 4;
  check(`F ${g.name}: seam segments`, sh.seams.length, crossed * perSeam);
  check(`F ${g.name}: seam segments are distinct`, new Set(sh.seams.map(String)).size, sh.seams.length);
  const starts = new Map();
  for (const [a, b] of sh.seams) {
    const ba = bandOfCell(a[0], a[1], L.mapping), bb = bandOfCell(b[0], b[1], L.mapping);
    check(`F ${g.name}: seam ${a}|${b} between neighbors`, hexDistance(a, b), 1);
    check(`F ${g.name}: seam ${a}|${b} between bands`, Math.abs(ba - bb), 1);
    check(`F ${g.name}: seam ${a}|${b} covers one half key width along R`, Math.abs(along(a) - along(b)), 1);
    check(`F ${g.name}: seam ${a}|${b} starts no lower than one segment below the keys`, Math.min(along(a), along(b)) >= tLo - 2, true);
    check(`F ${g.name}: seam ${a}|${b} ends no higher than one segment above the keys`, Math.max(along(a), along(b)) <= tHi + 2, true);
    const seam = Math.min(ba, bb);
    starts.set(seam, (starts.get(seam) ?? new Set()).add(Math.min(along(a), along(b))));
  }
  check(`F ${g.name}: seams`, starts.size, crossed);
  /* each seam is one unbroken run, so all of a shape's seams start level and end level */
  for (const [seam, set] of starts) check(`F ${g.name}: seam ${seam} is the whole run`, set.size, perSeam);

  /* G: every pair of keys is named as the guide names that ratio */
  if (g.kind !== 'interval') {
    check(`G ${g.name}: steps`, g.steps.length, g.members.length - 1);
    check(`G ${g.name}: steps and inner intervals do not overlap`, g.others.some((o) => g.steps.includes(o)), false);
    for (let i = 0; i < sh.cells.length; i++) for (let j = i + 1; j < sh.cells.length; j++) {
      const e = subExps(g.members[j], g.members[i]);
      const entry = guide.find((x) => x.kind === 'interval' && expsKey(x.members[1]) === expsKey(e));
      check(`G ${g.name}: pair ${i}-${j} name`, intervalNameFromCoords(...sh.cells[i], ...sh.cells[j], ST), entry.name);
    }
  }
}
const ivs = guide.filter((g) => g.kind === 'interval');
check('G intervals', ivs.length, 35);
check('G interval names are distinct', new Set(ivs.map((g) => g.name)).size, 35);
check('G short interval names are distinct', new Set(ivs.map((g) => g.steps[0])).size, 35);
check('G an interval has one step, itself', ivs.every((g) => g.steps.length === 1 && g.others.length === 0), true);
const shortOf = new Map(ivs.map((g) => [expsKey(g.members[1]), g.steps[0]]));
for (const g of guide.filter((x) => x.kind !== 'interval')) {
  /* the intervals between the entry's own keys, lower to upper: its steps, and the rest less the octave */
  const pairs = new Set();
  for (let i = 0; i < g.members.length; i++) for (let j = i + 1; j < g.members.length; j++) pairs.add(shortOf.get(expsKey(subExps(g.members[j], g.members[i]))));
  check(`G ${g.name}: steps`, g.steps.join(), g.members.slice(1).map((m, i) => shortOf.get(expsKey(subExps(m, g.members[i])))).join());
  check(`G ${g.name}: other intervals`, [...g.others].sort().join(), [...pairs].filter((x) => !g.steps.includes(x) && x !== 'P8').sort().join());
}
const listed = guide.filter((g) => g.kind === 'scale').map((g) => g.others.length).join();
check('G scales list 11, 11, 8, 12, 12 and 13 other intervals', listed, '11,11,8,12,12,13');
for (let i = 1; i < ivs.length; i++) {
  const num = (g) => { const [[q1, r1], [q2, r2]] = g.shape.cells; return noteLetters(q1, r1, q2, r2); };
  const a = ivs[i - 1], b = ivs[i];
  check(`G interval order ${a.name} < ${b.name}`, num(a) < num(b) || (num(a) === num(b) && centsOf(a.members[1]) < centsOf(b.members[1])), true);
}
/* an interval's number, from the two keys' letters and spelled octaves */
function noteLetters(q1, r1, q2, r2) {
  const at = (q, r) => 'CDEFGAB'.indexOf(noteName(q, r, L.mapping, L.anchor, L.banded)[0]);
  const semis = Math.round(12 * Math.log2(freq([q2, r2], L) / freq([q1, r1], L)));
  let n = ((at(q2, r2) - at(q1, r1)) % 7 + 7) % 7 + 1;
  if (n === 1 && semis > 6) n = 8;
  return n;
}
/* the short forms the guide quotes: an octave named as an interval is the ordinal 8, a bare one P8 */
for (const [long, short] of [
  ['perfect octave', 'P8'], ['perfect octave + schisma', 'P8 + Sc'], ['perfect octave − syntonic comma', 'P8 − SC'],
  ['perfect 15th', 'P15'], ['octave + syntonic comma', 'P8 + SC'], ['2 octaves + syntonic comma', '2×P8 + SC'],
  ['perfect unison', 'P1'], ['perfect 4th', 'P4'], ['Pythagorean minor 3rd', 'Pm3'], ['wolf 5th', 'WP5'],
  /* an octave shortens by the rules of a 4th or 5th: quality + number, and P after a bare 7 or W */
  ['diminished octave', 'd8'], ['lesser diminished octave', '&lt;d8'], ['greater diminished octave', '&gt;d8'],
  ['greater augmented octave', '&gt;A8'], ['lesser augmented octave', '&lt;A8'], ['septimal diminished octave', '7d8'],
  ['Pythagorean diminished octave', 'Pd8'], ['greater augmented 4th', '&gt;A4'], ['lesser diminished 5th', '&lt;d5'],
  ['wolf octave', 'WP8'], ['septimal 4th', '7P4'],
]) check(`G short form of "${long}"`, shortenInterval(long, true), short);
console.log(`Randal, Ptolemaic: ${guide.length} entries; ${seamed} show a seam; ${sameDirection} steps walk two legs in one direction`);
console.log(`  the 40 structures show ${pathKeyTotal} path keys in all; ${tied.length} of the ${exhaustive} entries counted exhaustively have equally small sets; in ${byTouch.length} of those the sets differ in how many edges touch a member`);

/* ── R. rows ── */
/* every sequence of up to seven entries, each fitting a third (3), a half (2) or the whole width (1) */
const seqs = [[]];
for (let from = 0; from < seqs.length; from++) if (seqs[from].length < 7) for (const f of [1, 2, 3]) seqs.push([...seqs[from], f]);
for (const fits of seqs) {
  const rows = rowsOf(fits), tag = `R [${fits}]`;
  check(`${tag}: rows hold every entry once, in order`, rows.flatMap((r) => Array.from({ length: r.count }, (_, k) => r.start + k)).join(), fits.map((_, i) => i).join());
  for (const r of rows) {
    const mine = fits.slice(r.start, r.start + r.count), next = fits[r.start + r.count], last = r.start + r.count === fits.length;
    check(`${tag}: row ${r.start} has an entry, and no more than its columns`, r.count >= 1 && r.count <= r.columns, true);
    check(`${tag}: row ${r.start} gives no entry less room than it needs`, mine.every((f) => r.columns <= f), true);
    check(`${tag}: row ${r.start} uses the whole width only for an entry that needs it`, r.columns === 1, mine[0] === 1);
    if (r.columns === 3 && r.count < 3) check(`${tag}: row ${r.start}, a short row of thirds, ends the section`, last, true);
    if (r.columns === 2 && r.count === 1) check(`${tag}: row ${r.start}, alone on a half, is last or before a whole-width entry`, last || next === 1, true);
    /* three that all fit a third are never split into halves */
    if (r.columns === 2) check(`${tag}: row ${r.start} is not three thirds`, fits.slice(r.start, r.start + 3).length === 3 && fits.slice(r.start, r.start + 3).every((f) => f === 3), false);
  }
}
/* Max's case: two that fit a third, before two that need a half, share their row as halves */
check('R thirds before halves pair up as halves', JSON.stringify(rowsOf([3, 3, 2, 2])), JSON.stringify([{ start: 0, count: 2, columns: 2 }, { start: 2, count: 2, columns: 2 }]));
check('R twelve thirds', rowsOf(Array(12).fill(3)).map((r) => r.count + '/' + r.columns).join(' '), '3/3 3/3 3/3 3/3');
check('R four halves (the scales)', rowsOf([2, 2, 2, 2]).map((r) => r.count + '/' + r.columns).join(' '), '2/2 2/2');

/* ── H. any layout ── */
check('H the guide\'s modes', SHAPE_GUIDE_MODES.join(' '), '5 P D 7 S Y');
const LAYOUTS = SHAPE_GUIDE_MODES.flatMap((mode) => MAPPINGS.map((m) => layoutOf(m, mode)));
/* how high a key stands on the page, in px, on HKL's own screen geometry in the guide's pose
   (sy grows downward); two heights within a thousandth of a px are level */
setHexSize('medium');
const up = (c) => -hexToScreen(c[0], c[1]).sy;
const ups = (cells) => cells.reduce((n, c) => n + up(c), 0);
const LEVEL = 1e-3;
/* how far apart two keys are in real space, in key widths: from their places on a regular
   hexagonal grid; two lengths within a millionth of a key width are the same */
const real = (a, b) => Math.hypot((b[0] - a[0]) + (b[1] - a[1]) / 2, ((b[1] - a[1]) * Math.sqrt(3)) / 2);
const SAME = 1e-6;
{
  let worst = 0, off = 0;
  for (let q = -9; q <= 9; q++) for (let r = -9; r <= 9; r++) {
    if (!q && !r) continue;
    off = Math.max(off, Math.abs(keyDistance([0, 0], [q, r]) - real([0, 0], [q, r])));
    const s0 = hexToScreen(0, 0), s1 = hexToScreen(q, r), onScreen = Math.hypot(s1.sx - s0.sx, s1.sy - s0.sy) / dxH;
    worst = Math.max(worst, Math.abs(onScreen / real([0, 0], [q, r]) - 1));
  }
  check('H keyDistance is the distance on a regular hexagonal grid', off < 1e-12, true);
  check('H HKL\'s screen geometry is that grid to within 1%', worst < 0.01, true);
}
const undecidedAll = {}, undecidedWhere = [];
/* the shapes a marked C would hold nearer than the plain C drawn, by layout, and the most it costs */
const plainCosts = {};
let plainCostMost = 0;
let decidedByArrows = 0, markedAll = 0, solvedAll = 0;
/* how far the solver looks from a bass: four bands along q, nine rows along r */
const REACH_BANDS = 4, REACH_ROWS = 9;
for (const l of LAYOUTS) {
  let solved = 0, repeats = 0, marked = 0;
  const left = {};
  setRotation(GUIDE_ROTATION, l.mapping, GUIDE_ALIGNMENT);
  const tag = `H ${l.mapping} ${l.mode}`;
  const width = bandWidth(l.mapping), reachQ = REACH_BANDS * width, spine = Math.floor(4 / matrixOf(l.mapping).c);
  /* the basses a shape may start from: every key named C in reach of (0, 0), each with its
     column, its marks (its pitch's 5- and 7-exponents) and how near (0, 0) it is: by distance,
     then in pitch, then lower, then higher on the page */
  const midi = (c) => coordToMidi(c[0], c[1], l.mapping);
  const marksOf = (c) => Math.abs(exps(c, l)[2]) + Math.abs(exps(c, l)[3]);
  const basses = [];
  for (let q = -reachQ; q <= reachQ; q++) for (let r = -REACH_ROWS; r <= REACH_ROWS; r++) {
    if (noteName(q, r, l.mapping, l.anchor, l.banded) !== 'C') continue;
    const cell = [q, r];
    basses.push({ p: posInBandOf(q, r, l.mapping), marks: marksOf(cell), cell, near: [hexDistance([0, 0], cell), Math.abs(midi(cell) - midi([0, 0])), midi(cell), -up(cell)] });
  }
  const nearer = (a, b) => a.near[0] - b.near[0] || a.near[1] - b.near[1] || a.near[2] - b.near[2] || (Math.abs(a.near[3] - b.near[3]) < LEVEL ? 0 : a.near[3] - b.near[3]);
  /* every key in reach of a bass that sounds `m` above it (the keys around a bass, by pitch, kept) */
  const around = new Map();
  const keysOf = (bass, m) => {
    let index = around.get(String(bass));
    if (!index) {
      index = new Map();
      for (let q = bass[0] - reachQ; q <= bass[0] + reachQ; q++) for (let r = bass[1] - REACH_ROWS; r <= bass[1] + REACH_ROWS; r++) {
        const k = expsKey(exps([q, r], l)), at = index.get(k);
        if (at) at.push([q, r]); else index.set(k, [[q, r]]);
      }
      around.set(String(bass), index);
    }
    return index.get(expsKey(addExps(exps(bass, l), m))) ?? [];
  };
  const apart = (cells) => { let n = 0; for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) n += real(cells[i], cells[j]); return n; };
  const all = [...STRUCTURES.map((s) => s.members), ...SET.map((e) => [UNISON, e])];
  for (const members of all) {
    const sh = solve(members, l);
    /* a position's arrangement: each member on a key of its pitch nearest the bass; of equally
       near keys the choices closest together; of those the ones that stand highest (one, unless
       two are level) */
    const arrange = (bass) => {
      const options = members.map((m) => {
        const at = keysOf(bass, m), d = Math.min(...at.map((c) => real(bass, c)));
        return at.filter((c) => real(bass, c) - d < SAME);
      });
      if (options.some((o) => !o.length)) return null;
      let combos = [[]];
      for (const o of options) combos = combos.flatMap((c) => o.map((k) => [...c, k]));
      const least = Math.min(...combos.map(apart)), close = combos.filter((c) => apart(c) - least < SAME);
      const top = Math.max(...close.map(ups));
      return { options, best: close.filter((c) => top - ups(c) < LEVEL), spread: close[0].reduce((n, c) => n + real(bass, c), 0) };
    };
    const arranged = basses.map((b) => ({ ...b, a: arrange(b.cell) })).filter((x) => x.a);
    check(`${tag}: solved exactly when some C holds every member`, !!sh, arranged.length > 0);
    if (!sh) continue;
    solved++;
    members.forEach((m, i) => check(`${tag}: member ${i} exact`, expsKey(subExps(exps(sh.cells[i], l), exps(sh.bass, l))), expsKey(m)));
    /* a key's HEJI arrows are its pitch's 5-exponent, each 5 being a syntonic comma off the
       Pythagorean spelling, and its hooks the 7-exponent; held to what HKL's labels draw */
    for (const c of [...sh.cells, ...sh.path]) {
      const h = hejiCommasFor(l.mode, c[0], c[1], l.mapping, l.anchor, l.banded);
      check(`${tag}: a key's arrows are its 5-exponent`, Math.abs(h.syn5), Math.abs(exps(c, l)[2]));
      check(`${tag}: a key's hooks are its 7-exponent`, Math.abs(h.sept7), Math.abs(exps(c, l)[3]));
    }
    const here = arranged.find((x) => String(x.cell) === String(sh.bass));
    check(`${tag}: the bass is a C, in the position drawn`, !!here && here.p === sh.position, true);
    if (!here) continue;
    /* 1: no C that holds the members is plainer */
    check(`${tag}: 1, the plainest C that holds it`, here.marks, Math.min(...arranged.map((x) => x.marks)));
    if (here.marks > 0) marked++;
    /* each key as near the bass as any of its pitch; of equally near keys, the choice closest
       together, and of those the one that stands highest */
    members.forEach((m, i) => check(`${tag}: member ${i} is a key of its pitch nearest the bass`, here.a.options[i].some((c) => String(c) === String(sh.cells[i])), true));
    if (here.a.options.some((o) => o.length > 1)) repeats++;
    check(`${tag}: of equally near keys, the closest together and then the highest`, here.a.best.some((c) => keys(c) === keys(sh.cells)), true);
    check(`${tag}: "keys" is undecided exactly when two such choices are level`, sh.undecided.includes('keys'), here.a.best.length > 1);
    /* 2: of the plainest, none holds the members nearer its bass; and nor does any C at all, so
       rules 1 and 2 never pull apart */
    const plain = arranged.filter((x) => x.marks === here.marks);
    check(`${tag}: 2, the closest arrangement`, here.a.spread - Math.min(...plain.map((x) => x.a.spread)) < SAME, true);
    const looser = here.a.spread - Math.min(...arranged.map((x) => x.a.spread));
    if (looser > SAME) { plainCosts[`${l.mapping} ${l.mode}`] = (plainCosts[`${l.mapping} ${l.mode}`] ?? 0) + 1; plainCostMost = Math.max(plainCostMost, looser); }
    /* 3: of those, none starts nearer the spine column */
    const close = plain.filter((x) => x.a.spread - here.a.spread < SAME);
    check(`${tag}: 3, from nearest the spine column`, Math.abs(sh.position - spine), Math.min(...close.map((x) => Math.abs(x.p - spine))));
    /* 4, 5, 6: of those, another arrangement never stands higher above its bass; of level ones,
       and of one shape from two columns, none is written with fewer arrows; then the left */
    const rise = (cells, bass) => ups(cells) - cells.length * up(bass);
    const offsets = (cells, bass) => cells.map((c) => [c[0] - bass[0], c[1] - bass[1]]).join(' ');
    const arrows = (cells) => cells.reduce((n, c) => n + Math.abs(exps(c, l)[2]), 0);
    let levelOther = false, levelSame = false, levelBass = false;
    for (const x of close) {
      if (x === here || Math.abs(x.p - spine) !== Math.abs(sh.position - spine)) continue;
      const other = x.a.best[0], fewer = arrows(other) - arrows(sh.cells);
      if (offsets(other, x.cell) === offsets(sh.cells, sh.bass)) {
        if (x.p === sh.position) {
          /* the same shape from another C of the column: the drawn one is the nearer the reference */
          check(`${tag}: of the Cs of a column that hold the shape alike, the nearest the reference`, nearer(here, x) <= 0, true);
          if (nearer(here, x) === 0) levelBass = true;
          continue;
        }
        check(`${tag}: 5, one shape from two columns is drawn from the one with no more arrows`, fewer >= 0, true);
        if (fewer === 0) { levelSame = true; check(`${tag}: 6, with as many arrows, from the left`, sh.position < x.p, true); }
        else decidedByArrows++;
        continue;
      }
      const d = rise(sh.cells, sh.bass) - rise(other, x.cell);
      check(`${tag}: 4, no equally close arrangement stands higher above its bass`, d > -LEVEL, true);
      if (Math.abs(d) < LEVEL) { check(`${tag}: 5, of level arrangements, none with fewer arrows`, fewer >= 0, true); if (fewer === 0) levelOther = true; }
    }
    check(`${tag}: "position" is undecided exactly when two such arrangements are level`, sh.undecided.includes('position'), levelOther);
    check(`${tag}: "column" is undecided exactly when the shape starts from two such columns with as many arrows`, sh.undecided.includes('column'), levelSame);
    check(`${tag}: "bass" is undecided exactly when two Cs of the column are as near the reference`, sh.undecided.includes('bass'), levelBass);
    for (const u of sh.undecided) undecidedWhere.push(`${l.mapping} ${l.mode} ${ratioOf(members[members.length - 1]).join(':')} ${u}`);
    for (const u of sh.undecided) { left[u] = (left[u] ?? 0) + 1; undecidedAll[u] = (undecidedAll[u] ?? 0) + 1; }
    /* the positions: the columns where the same keys, moved with a C of that column, sound the members */
    const same = [...new Set(basses.filter((b) => members.every((m, i) =>
      expsKey(subExps(exps([b.cell[0] + sh.cells[i][0] - sh.bass[0], b.cell[1] + sh.cells[i][1] - sh.bass[1]], l), exps(b.cell, l))) === expsKey(m)))
      .map((b) => b.p))].sort((a, b) => a - b);
    check(`${tag}: positions are where the same keys work`, sh.positions.join(), same.join());
    check(`${tag}: drawn from one of its positions`, same.includes(sh.position), true);
    check(`${tag}: label`, positionLabel(sh.positions, width),
      sh.positions.length === width ? 'any' : width === 3 ? sh.positions.map((p) => ['left', 'center', 'right'][p]).join(' or ') : 'column ' + sh.positions.map((p) => p + 1).join(' or '));
  }
  console.log(`  ${l.mapping.padEnd(12)} ${l.mode}  ${String(solved).padStart(2)} of ${all.length} on the lattice, ${String(repeats).padStart(2)} with equally near keys, ${String(marked).padStart(2)} from a marked C${Object.keys(left).length ? ', undecided: ' + JSON.stringify(left) : ''}`);
  /* a layout's guide is exactly the shapes it holds, in catalog order, then the intervals it holds */
  const g = buildGuide(l);
  check(`H ${l.mapping} ${l.mode}: the guide holds what the layout holds`, g.length, solved);
  check(`H ${l.mapping} ${l.mode}: structures in catalog order`, g.filter((e) => e.kind !== 'interval').map((e) => e.name).join(';'),
    STRUCTURES.filter((s) => solve(s.members, l)).map((s) => s.name).join(';'));
  check(`H ${l.mapping} ${l.mode}: every entry has its keys`, g.every((e) => e.shape && e.shape.cells.length === e.members.length), true);
  /* a ratio has one name in a guide, and a name one ratio, in full and in short */
  const ivs = g.filter((e) => e.kind === 'interval');
  check(`H ${l.mapping} ${l.mode}: interval names are distinct`, new Set(ivs.map((e) => e.name)).size, ivs.length);
  check(`H ${l.mapping} ${l.mode}: short interval names are distinct`, new Set(ivs.map((e) => e.steps[0])).size, ivs.length);
  /* Septimal holds the whole catalog but for what its retuned column takes away, and every
     septimal structure and interval, on every mapping */
  if (l.mode === '7') {
    check(`H ${l.mapping} 7: entries`, g.length, 109);
    check(`H ${l.mapping} 7: every structure and interval with a 7 is held`, all.filter((m) => m.some((e) => e[3] !== 0)).every((m) => solve(m, l)), true);
  } else check(`H ${l.mapping} ${l.mode}: nothing with a 7 is held`, all.filter((m) => m.some((e) => e[3] !== 0)).some((m) => solve(m, l)), false);
  markedAll += marked; solvedAll += solved;
}
/* Max, 2026-11-18: the plain C before a marked one; an exact tie between different keys to the
   one visually higher; between two equally plain columns for one shape, to the one with the
   fewest HEJI arrows. Over the 48 layouts nothing else is left to scan order */
check('H no choice is left to scan order', undecidedWhere.join('; '), '');
/* rule 1 before rule 2 (Max, 2026-11-18): the plain C is the example even where a marked C would
   hold the shape a little nearer. Where that happens, and by how much at most, is pinned */
check('H shapes a marked C would hold nearer than the plain C drawn', Object.entries(plainCosts).map(([k, n]) => `${k} ×${n}`).join('; '), 'accordion S ×7; park S ×2');
check('H the most the plain C costs, in key widths summed over a shape', plainCostMost.toFixed(2), '0.54');
/* Max's case: two arrangements of the wolf 5th as many steps apart and as high, one turning after
   four steps and one after six; the nearer in real space is the shape */
{
  const l = layoutOf('wickiHayden', 'S'), e = buildGuide(l).find((x) => x.ratio === '40:27'), [a, b] = e?.shape.cells ?? [[0, 0], [0, 0]];
  check('H Wicki-Hayden in Syntonic, wolf 5th', `${e?.name} | ${hexDistance(a, b)} steps | ${Math.round(real(a, b) ** 2)} key widths squared`, 'wolf 5th | 7 steps | 37 key widths squared');
}
console.log(`  ${solvedAll} shapes over the ${LAYOUTS.length} layouts: ${markedAll} start on a marked C (no plain C holds them); two columns for one shape: ${decidedByArrows} decided by arrows; undecided: ${JSON.stringify(undecidedAll)}`);
/* D again, in Randal in Septimal, where the septimal chords are: HKL's chord namer gives every
   chord entry the catalog's name and ratio (the septimal diminished seventh by its ratio, since
   its terms are past the namer's gate) */
{
  const l = layoutOf('randal', '7'), st = stateOf(l);
  let seen = 0;
  for (const e of buildGuide(l)) {
    if (e.kind !== 'chord') continue;
    seen++;
    const res = analyzeChord(e.shape.cells.map(([q, r]) => ({ q, r, name: '', col: '' })), st);
    check(`H Randal 7, ${e.name}: HKL name`, res ? res.quality + (res.invName ? ' ' + res.invName : '') : 'none', e.name);
    check(`H Randal 7, ${e.name}: HKL ratio`, res?.ratio, combinedRatio(namedAs(e.name).members));
  }
  /* the 75, less the diminished seventh's four, the augmented triad's three and the augmented
     sixths' eleven, none of which Septimal can hold */
  check('H Randal 7: chord entries', seen, 57);
}
/* Max's case: on Park the C of column 2 is a C↓ in Ptolemaic and a hooked C in Septimal, and the
   C of column 4 is plain; both hold these shapes, and the plain one is the example */
const marksAt = (c, l) => { const h = hejiCommasFor(l.mode, c[0], c[1], l.mapping, l.anchor, l.banded); return Math.abs(h.syn5) + Math.abs(h.sept7); };
for (const [mode, ratio, want] of [['5', '10:9', 'major 2nd | column 2 or 4 | from column 4, 0 marks on its C'], ['5', '40:27', 'wolf 5th | column 2 or 4 | from column 4, 0 marks on its C'],
  ['7', '32:27', 'Pythagorean minor 3rd | column 2 or 4 or 6 | from column 4, 0 marks on its C']]) {
  const l = layoutOf('park', mode), e = buildGuide(l).find((x) => x.ratio === ratio);
  check(`H Park ${mode}, ${ratio}`, e ? `${e.name} | ${e.start} | from column ${e.shape.position + 1}, ${marksAt(e.shape.bass, l)} marks on its C` : null, want);
}
/* Max's case: in Pythagorean the left C has its minor 2nd only on a far key, so the two adjacent
   keys are played from center or right (drawn from center, they sit in one band: no seam) */
const m2 = buildGuide(layoutOf('randal', 'P')).find((e) => e.ratio === '256:243');
check('H Randal in Pythagorean, minor 2nd', `${m2?.name} | ${m2?.start} | ${m2 ? hexDistance(...m2.shape.cells) : ''} | ${m2?.shape.seams.length} seam segments`,
  'Pythagorean minor 2nd | center or right | 1 | 0 seam segments');
check('H label, three columns', [positionLabel([0, 1, 2], 3), positionLabel([1, 2], 3), positionLabel([0], 3)].join('; '), 'any; center or right; left');
check('H label, other widths', [positionLabel([2, 3, 4], 6), positionLabel([0], 6), positionLabel([0, 1, 2, 3, 4, 5], 6), positionLabel([0, 1], 2)].join('; '),
  'column 3 or 4 or 5; column 1; any; any');

console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
