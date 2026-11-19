// Shape-guide oracle (docs/architecture/hkl.md → Lattice shapes).
//
// Pure Node gate — no dev server, no browser, no audio. Imports the REAL catalog, solver and guide
// (apps/hkl/src/shapes/) and HKL's namers through the repo's TS loader, and checks:
//   A  the catalog: 99 chord entries (triads, sevenths, augmented sixths) and 13 scales in guide
//      order, the two suspended chords each by itself with no inversions (the suspended second
//      is the suspended fourth turned once; 9:12:16 is not listed), a septimal structure next to
//      the one it retunes; every inversion is its root position turned (the bass up an octave);
//      members ascend; a scale runs unison to octave over 9/8, 4/3 and 3/2; a septimal minor
//      scale is the minor scale of its kind with 7/6 for its minor third and 14/9 for its minor
//      sixth, and nothing else moved
//   B  the interval set: 59 (41 without a 7, 18 with; 17 are 3-limit), each one between two members of a
//      structure or, for a scale (which repeats at the octave), the octave complement of one;
//      closed under octave complement
//   C  Randal in Ptolemaic, banded — every entry is on the keyboard; each key sounds its member's
//      ratio from the bass exactly; every entry here starts on C, the C of its position (purple
//      left, spring green center, pink right), the three pinned, each the C nearest the reference,
//      which is C's tonic key (C4, where Composer puts a key's reference), or that C whole bands
//      over where the shape fits the keyboard from there (24 entries); the valid positions equal
//      the closed form −lo … 2 − hi over the members' 5-exponents, the keyboard's edge narrowing
//      none of them, since any key of a column may start the shape; center is drawn whenever valid
//   D  HKL's chord namer (analyzeChord) gives every chord entry the catalog's name, position
//      and the ratio of the chord it is named as, in Randal in Ptolemaic and again in Randal in
//      Septimal (section H): the guide follows the namer, with no exceptions
//   E  path keys: keys of the keyboard, not members, joining the members into one connected
//      patch, and present exactly when the members do not already touch. Up to five path keys,
//      every connecting set is grown here key by key from the members: none is smaller, and of
//      the equally small ones the solver's has the most edges between a path key and a member,
//      and of those reaches highest in pitch. A longer path of an interval is held to the
//      shortest walk on the keyboard. An interval's path is the higher one-turn walk (built
//      here from the six directions) wherever that walk lies on the keyboard
//   F  seams: none when the bass can start anywhere or the keys sit in one band; otherwise one per
//      band boundary the keys cross, each segment between adjacent keys of neighboring bands. A
//      seam runs along R for as far as the keys beside it reach along R (the keys in the two
//      columns on either side of it, not the whole shape), edge to edge, and one segment past
//      that at either end: checked in whole numbers (a key at q + 2r, half key widths), each
//      seam one unbroken run of exactly those segments
//   G  the guide: 128 entries (Randal in Ptolemaic holds exactly what has no 7 in it: 87
//      structures and 41 intervals), structures then intervals by number and size; full and short interval
//      names all distinct; every pair of keys in every structure is named by HKL exactly as the
//      guide's interval of that ratio; an entry lists its steps, then every other interval between
//      two of its own keys, lower to upper, a scale's less the octave (from 8 to 13 for the
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
//      solver's order, each rule re-derived here from the lattice. A layout has one keyboard:
//      a Lumatone's 280 keys with the reference on the unaltered C. A shape may start from any
//      key on it, whatever its name, and all its keys and path keys lie on it (path keys checked
//      as in E, every connecting set up to three keys). Nearness is real space, not key steps: the
//      lattice as a regular hexagonal grid, computed here from the keys' places on it (and the
//      solver's keyDistance is held to that, and to within 1% of HKL's own screen geometry).
//      Each key is as near the bass as any key of its pitch; of equally near keys, none chosen otherwise lies closer together, and of those
//      none stands higher on the page. Then, in order: (1) no key that holds the shape is plainer
//      than the bass drawn (a plain key before one with an arrow or a hook); (2) of the plainest,
//      none holds it nearer its bass; (3) of those, none starts on a note nearer C by fifths (the
//      note's place on the line of fifths read from its spelling here), so C itself wherever it
//      holds the shape as close; (4) of those, none starts nearer the spine column; (5) of
//      those, no other arrangement stands higher above its bass; (6) of level ones, and of one
//      shape from two columns, none is written with fewer HEJI arrows; (7) the one nearest the
//      reference; (8) the left one. What rule 1 costs
//      rule 2 is measured and pinned: the shapes some marked bass would hold nearer than the plain
//      one drawn (9 of them, all in Syntonic, by at most 0.54 key widths in all). The
//      pictures (diagram.ts's own measure, in the guide's pose and key size) all fit a sheet: one
//      wider than a row to itself is shown scaled down to it, and those are pinned by layout
//      (two each on Wicki-Hayden, to 88%, and eleven each on Chromatic, to 91%, in Ptolemaic
//      and in Septimal);
//      every other picture is shown as drawn; none is taller than a sheet. A picture has its
//      entry's whole width less the gutter: the hanging indent of the titles and text (a digit
//      wider from a hundred entries) takes nothing from it. The
//      positions listed are exactly the columns where the same keys, moved with any key of that
//      column, sound the members, on the keyboard. No choice is left to scan order (`undecided`
//      is empty in every layout). "Higher on the page" is measured on HKL's
//      real screen geometry (layout/geometry.ts) in the guide's pose, not by the solver's
//      2q + 7r; marks are counted as the 5- and 7-exponents of a key's pitch, and every drawn
//      key's exponents are held to the arrows and hooks HKL's label function gives it. Pinned:
//      209 shapes start on another note than C, at most 6 fifths from it; Randal in Ptolemaic
//      plays its Pythagorean diminished 4th from any column, with no seam; Chromatic in Syntonic
//      draws its Pythagorean diminished seventh in third inversion from B♭;
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
import { buildGuide, rootedLayout } from '../../apps/hkl/src/shapes/guide.ts';
import { rowsOf, room, shownSize, indentOf, contentsSplits, CONTENTS_KEEP, SHEET } from '../../apps/hkl/src/shapes/rows.ts';
import { diagramSize } from '../../apps/hkl/src/shapes/diagram.ts';
import { baseKeys } from '../../apps/hkl/src/layout/baseKeys.ts';
import { poseOffset } from '../../apps/hkl/src/layout/physical.ts';
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

/* how high a key stands on the page, in px, on HKL's own screen geometry in the guide's pose
   (sy grows downward); two heights within a thousandth of a px are level */
setHexSize('medium');
setRotation(GUIDE_ROTATION, 'randal', GUIDE_ALIGNMENT);
const up = (c) => -hexToScreen(c[0], c[1]).sy;
const ups = (cells) => cells.reduce((n, c) => n + up(c), 0);
const LEVEL = 1e-3;

/* ── A. the catalog ── */
const chords = STRUCTURES.filter((s) => s.kind === 'chord'), scales = STRUCTURES.filter((s) => s.kind === 'scale');
check('A chord entries', chords.length, 99);
check('A chord entries by family', ['triad', 'seventh', 'augmented sixth'].map((f) => chords.filter((x) => x.family === f).length).join(' '), '32 56 11');
check('A families in order', [...new Set(STRUCTURES.map((x) => x.family))].join(' > '), 'triad > seventh > augmented sixth > scale');
check('A scales', scales.length, 13);
check('A order: chords first', STRUCTURES.findIndex((s) => s.kind === 'scale'), 99);
check('A names', STRUCTURES.filter((s) => s.inversion === 0).map((s) => s.name).join('; '),
  'major triad; Pythagorean major triad; minor triad; Pythagorean minor triad; septimal minor triad; '
  + 'diminished triad; Pythagorean diminished triad; septimal diminished triad; augmented triad; Pythagorean augmented triad; suspended fourth chord; suspended second chord; '
  + 'dominant seventh; Pythagorean dominant seventh; septimal dominant seventh; minor seventh; Pythagorean minor seventh; septimal minor seventh; '
  + 'major seventh; Pythagorean major seventh; diminished seventh; Pythagorean diminished seventh; septimal diminished seventh; '
  + 'half-diminished seventh; Pythagorean half-diminished seventh; septimal half-diminished seventh; '
  + 'Italian augmented sixth chord; French augmented sixth chord; German augmented sixth chord; '
  + 'Ptolemaic major scale; Pythagorean major scale; Ptolemaic natural minor scale; Pythagorean natural minor scale; septimal natural minor scale; '
  + 'Ptolemaic harmonic minor scale; Semiditonal harmonic minor scale; Pythagorean harmonic minor scale; septimal harmonic minor scale; '
  + 'Ptolemaic melodic minor scale; Semiditonal melodic minor scale; Pythagorean melodic minor scale; septimal melodic minor scale');
/* the Pythagorean chords and major scale (Max, 2026-11-19): each the 5-limit one's shape in thirds,
   every third Pythagorean, so 3-limit throughout, and so playable in Pythagorean tuning */
{
  const P3 = expsOf(81, 64), p3 = expsOf(32, 27), named = (n) => STRUCTURES.find((x) => x.name === n).members;
  const stacked = (...thirds) => { const out = [UNISON]; for (const t of thirds) out.push(addExps(out[out.length - 1], t)); return out.map(expsKey).join(' '); };
  for (const [name, thirds] of [['Pythagorean major triad', [P3, p3]], ['Pythagorean minor triad', [p3, P3]], ['Pythagorean diminished triad', [p3, p3]], ['Pythagorean augmented triad', [P3, P3]],
    ['Pythagorean dominant seventh', [P3, p3, p3]], ['Pythagorean minor seventh', [p3, P3, p3]], ['Pythagorean major seventh', [P3, p3, P3]],
    ['Pythagorean diminished seventh', [p3, p3, p3]], ['Pythagorean half-diminished seventh', [p3, p3, P3]]]) {
    check(`A ${name}: Pythagorean thirds stacked`, named(name).map(expsKey).join(' '), stacked(...thirds));
  }
  check('A the Pythagorean major scale: fifths from the fourth below to the fifth five above', named('Pythagorean major scale').map(expsKey).join(' '),
    [[1, 1], [9, 8], [81, 64], [4, 3], [3, 2], [27, 16], [243, 128], [2, 1]].map(([n, d]) => expsKey(expsOf(n, d))).join(' '));
  const pure = STRUCTURES.filter((x) => x.members.every((e) => e[2] === 0 && e[3] === 0));
  check('A the 3-limit structures', [...new Set(pure.map((x) => x.title))].join('; '),
    'Pythagorean major triad; Pythagorean minor triad; Pythagorean diminished triad; Pythagorean augmented triad; suspended fourth chord; suspended second chord; '
    + 'Pythagorean dominant seventh; Pythagorean minor seventh; Pythagorean major seventh; Pythagorean diminished seventh; Pythagorean half-diminished seventh; '
    + 'Pythagorean major scale; Pythagorean natural minor scale; Pythagorean harmonic minor scale; Pythagorean melodic minor scale');
  /* what a name says (Max, 2026-11-19): Pythagorean is 3-limit and nothing else; a Semiditonal
     scale has the Pythagorean minor third and is not 3-limit throughout */
  check('A everything named Pythagorean is 3-limit', STRUCTURES.filter((x) => /Pythagorean/.test(x.name)).every((x) => x.members.every((e) => e[2] === 0 && e[3] === 0)), true);
  check('A everything 3-limit is named Pythagorean, but the suspended chords', pure.filter((x) => !/Pythagorean/.test(x.name)).map((x) => x.title).filter((t, i, a) => a.indexOf(t) === i).join('; '), 'suspended fourth chord; suspended second chord');
  const semi = STRUCTURES.filter((x) => /Semiditonal/.test(x.name));
  check('A the Semiditonal scales', semi.map((x) => x.name).join('; '), 'Semiditonal harmonic minor scale; Semiditonal melodic minor scale');
  check('A a Semiditonal scale has the Pythagorean minor third and is not 3-limit', semi.every((x) => expsKey(x.members[2]) === expsKey(p3) && x.members.some((e) => e[2] !== 0)), true);
  check('A the Semiditonal harmonic minor: Pythagorean third and sixth, 5-limit leading tone', named('Semiditonal harmonic minor scale').map(expsKey).join(' '),
    [[1, 1], [9, 8], [32, 27], [4, 3], [3, 2], [128, 81], [15, 8], [2, 1]].map(([n, d]) => expsKey(expsOf(n, d))).join(' '));
  check('A the Pythagorean harmonic and melodic minors', ['harmonic', 'melodic'].map((k) => named(`Pythagorean ${k} minor scale`).map((e) => ratioOf(e).join('/')).join(' ')).join(' | '),
    '1/1 9/8 32/27 4/3 3/2 128/81 243/128 2/1 | 1/1 9/8 32/27 4/3 3/2 27/16 243/128 2/1');
}
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
check('A the melodic minors but the Pythagorean', ['Ptolemaic', 'Semiditonal', 'septimal'].map((n) => { const m = STRUCTURES.find((x) => x.name === n + ' melodic minor scale').members;
  return [ratioOf(m[2]).join('/'), m.filter((_, i) => i !== 2).map(expsKey).join(' ') === STRUCTURES.find((x) => x.name === 'Semiditonal melodic minor scale').members.filter((_, i) => i !== 2).map(expsKey).join(' ')].join(' '); }).join('; '),
  '6/5 true; 32/27 true; 7/6 true');
check('A the Ptolemaic natural minor', combinedRatio(STRUCTURES.find((x) => x.name === 'Ptolemaic natural minor scale').members.slice(0, 7)),
  combinedRatio([[1, 1], [9, 8], [6, 5], [4, 3], [3, 2], [8, 5], [9, 5]].map(([n, d]) => expsOf(n, d))));
/* the septimal chords, by their proportions (Max, 2026-11-18) */
check('A septimal chords', ['septimal minor triad', 'septimal diminished triad', 'septimal half-diminished seventh', 'septimal diminished seventh']
  .map((n) => combinedRatio(STRUCTURES.find((x) => x.name === n).members)).join(' '), '6:7:9 5:6:7 5:6:7:9 135:162:189:224');
/* a septimal minor scale: the minor scale of its kind, its minor third and minor sixth septimal */
for (const [septimal, plain] of [['septimal natural minor scale', 'Pythagorean natural minor scale'], ['septimal harmonic minor scale', 'Ptolemaic harmonic minor scale'],
  ['septimal melodic minor scale', 'Semiditonal melodic minor scale']]) {
  const a = STRUCTURES.find((x) => x.name === septimal).members, b = STRUCTURES.find((x) => x.name === plain).members;
  const minor3 = new Set([expsOf(6, 5), expsOf(32, 27)].map(expsKey)), minor6 = new Set([expsOf(8, 5), expsOf(128, 81)].map(expsKey));
  const want = b.map((e) => (minor3.has(expsKey(e)) ? expsOf(7, 6) : minor6.has(expsKey(e)) ? expsOf(14, 9) : e));
  check(`A ${septimal}: ${plain} with septimal minor third and sixth`, a.map(expsKey).join(' '), want.map(expsKey).join(' '));
}
check('A names are distinct', new Set(STRUCTURES.map((s) => s.name)).size, STRUCTURES.length);
let root = null;
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
  check(`A ${s.name}: listed under its chord, whose title it has`, `${s.chord} | ${s.title}`, `${root.name} | ${root.name}`);
  check(`A ${s.name}: family`, s.family, root.family);
  check(`A ${s.name}: name is the title and, when not in root position, its position`, s.name, s.inversion ? `${s.title} ${POSITION[s.inversion]}` : s.title);
  check(`A ${s.name}: within an octave`, centsOf(s.members[s.members.length - 1]) < 1200, true);
  /* the root position's members from the `inversion`-th up, then the rest an octave higher */
  const k = s.inversion, turned = [...root.members.slice(k), ...root.members.slice(0, k).map((e) => addExps(e, OCTAVE))].map((e) => subExps(e, root.members[k]));
  check(`A ${s.name}: is ${root.name} turned ${k}`, s.members.map(expsKey).join(' '), turned.map(expsKey).join(' '));
}

/* the suspended chords stand alone, each in root position with no inversions (Max, 2026-11-19):
   the second is the fourth turned once, and their other inversion, 9:12:16, is not listed */
{
  const sus = STRUCTURES.filter((x) => /suspended/.test(x.name)), [four, two] = sus;
  check('A the suspended chords', sus.map((x) => `${x.name} ${combinedRatio(x.members)} inversion ${x.inversion}`).join('; '), 'suspended fourth chord 6:8:9 inversion 0; suspended second chord 8:9:12 inversion 0');
  check('A the suspended second is the suspended fourth turned once', two.members.map(expsKey).join(' '), [...four.members.slice(1), addExps(four.members[0], OCTAVE)].map((e) => expsKey(subExps(e, four.members[1]))).join(' '));
  check('A 9:12:16 is not listed', STRUCTURES.some((x) => x.kind === 'chord' && combinedRatio(x.members) === '9:12:16'), false);
}
/* the chord an entry is named as: itself when it is in root position, otherwise the chord it is
   an inversion of. HKL's chord namer prints that chord's ratio */
const namedAs = (name) => { const i = STRUCTURES.findIndex((x) => x.name === name); return STRUCTURES[i - STRUCTURES[i].inversion]; };

/* ── B. the interval set ── */
const SET = intervalSet(), setKeys = new Set(SET.map(expsKey));
check('B size', SET.length, 59);
check('B without a 7, with one', `${SET.filter((e) => e[3] === 0).length} ${SET.filter((e) => e[3] !== 0).length} ${SET.filter((e) => e[2] === 0 && e[3] === 0).length}`, '41 18 17');
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
/* the reference is C's tonic key, C4 at (-3, 3) (findTonicCoord, as Composer places a key's
   reference), and each position's C is the one nearest it: C3, C4, C5 */
const HUE = { 0: 'PU', 1: 'SG', 2: 'PK' }, BASS = { 0: '-1,-1', 1: '-3,3', 2: '-5,7' };
const REF = rootedLayout(L, 'C').ref;
check('C the reference', String(REF), '-3,3');
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
check('G entries', guide.length, 128);
check('G the major triad and its inversions', guide.filter((g) => g.listed === 'major triad').map((g) => `${g.number} ${g.name}`).join('; '), '1 major triad; 1.1 major triad in first inversion; 1.2 major triad in second inversion');
check('G the suspended chords have a number each', guide.filter((g) => /suspended/.test(g.name)).map((g) => `${g.number} ${g.name}, listed as ${g.listed}`).join('; '), '9 suspended fourth chord, listed as suspended fourth chord; 10 suspended second chord, listed as suspended second chord');
/* Randal in Ptolemaic has no 7-limit keys: it holds the structures without a 7, all of them */
const FIVE = STRUCTURES.filter((x) => x.members.every((e) => e[3] === 0));
check('G the structures without a 7', FIVE.length, 87);
check('G positions', POSITION.join('; '), 'in root position; in first inversion; in second inversion; in third inversion');
for (const [i, g] of guide.entries()) {
  const s = FIVE[i];
  check(`G ${g.name}: title`, g.title, s ? s.title : g.name);
  check(`G ${g.name}: subtitle`, g.subtitle, s && s.kind === 'chord' ? POSITION[s.inversion] : '');
  check(`G ${g.name}: family`, g.family, s ? s.family : 'interval');
  /* an interval's cents, from its printed ratio: one decimal and the cent sign, as the info panel has it */
  const [num, den] = g.ratio.split(':').map(Number);
  check(`G ${g.name}: cents`, g.cents, s ? '' : (1200 * Math.log2(num / den)).toFixed(1) + '¢');
}
check('G structures first, in catalog order', guide.slice(0, 87).map((g) => g.name).join(';'), FIVE.map((s) => s.name).join(';'));
/* The path keys of a shape, checked against the rule from the keyboard up (Max, 2026-11-19): keys
   of the keyboard, the fewest that join the members into one connected patch; of equally small
   sets the one touching the members along the most edges; of those the highest. Up to `prove`
   path keys every connecting set is found here by growing the patch a key at a time, each new
   key touching what is there, so "no smaller set" and "none better" are checked against all of
   them. Past that, an interval's count is held to the shortest walk on the keyboard. */
const pathStats = { shapes: 0, withPath: 0, proven: 0, byWalk: 0, unproven: 0, severalSmallest: 0, touchDecides: 0, oneTurn: 0, oneTurnHasRoom: 0, off: 0 };
function checkPath(tag, sh, l, ref, prove) {
  const board = new Set(baseKeys.map(([u, v]) => `${ref[0] + u},${ref[1] + v}`));
  const cellOf = (k) => k.split(',').map(Number);
  const around = (k) => { const [q, r] = cellOf(k); return DIRS.map(([dq, dr]) => `${q + dq},${r + dr}`).filter((x) => board.has(x)); };
  const members = sh.cells.map(String), isMember = new Set(members), drawn = sh.path.map(String);
  const connected = (extra) => {
    const all = new Set([...members, ...extra]), seen = new Set([members[0]]), stack = [members[0]];
    while (stack.length) for (const x of around(stack.pop())) if (all.has(x) && !seen.has(x)) { seen.add(x); stack.push(x); }
    return seen.size === all.size;
  };
  pathStats.shapes++;
  check(`${tag}: path keys are keys of the keyboard`, drawn.every((k) => board.has(k)), true);
  check(`${tag}: path keys are not members, and none twice`, drawn.some((k) => isMember.has(k)) || new Set(drawn).size !== drawn.length, false);
  check(`${tag}: the members and the path keys are one connected patch`, connected(drawn), true);
  check(`${tag}: path keys exactly when the members do not already touch`, drawn.length > 0, !connected([]));
  if (!drawn.length) return;
  pathStats.withPath++;
  const touches = (set) => set.reduce((n, k) => n + around(k).filter((x) => isMember.has(x)).length, 0);
  const highFirst = (set) => set.map((k) => [freq(cellOf(k), l), up(cellOf(k))]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const over = (x, y) => { for (let i = 0; i < x.length; i++) { const d = Math.abs(x[i][0] - y[i][0]) > 1e-9 * x[i][0] ? x[i][0] - y[i][0] : Math.abs(x[i][1] - y[i][1]) > LEVEL ? x[i][1] - y[i][1] : 0; if (d) return d; } return 0; };
  if (drawn.length <= prove) {
    /* every connecting set of at most that many keys, each once */
    const found = [];
    const grow = (chosen, barred, left) => {
      if (connected(chosen)) { found.push([...chosen]); return; }
      if (!left) return;
      const patch = new Set([...members, ...chosen]), frontier = new Set();
      for (const k of patch) for (const x of around(k)) if (!patch.has(x) && !barred.has(x)) frontier.add(x);
      const shut = new Set(barred);
      for (const f of frontier) { grow([...chosen, f], new Set(shut), left - 1); shut.add(f); }
    };
    grow([], new Set(), drawn.length);
    pathStats.proven++;
    check(`${tag}: no smaller set of keys joins them`, found.filter((f) => f.length < drawn.length).length, 0);
    const smallest = found.filter((f) => f.length === drawn.length);
    check(`${tag}: its set is one of the smallest`, smallest.some((f) => keys(f.map(cellOf)) === keys(sh.path)), true);
    if (smallest.length > 1) pathStats.severalSmallest++;
    const most = Math.max(...smallest.map(touches));
    check(`${tag}: touches its members along the most edges`, touches(drawn), most);
    if (smallest.some((f) => touches(f) < most)) pathStats.touchDecides++;
    const mine = highFirst(drawn);
    check(`${tag}: of those, none reaches higher`, smallest.filter((f) => touches(f) === most).every((f) => over(mine, highFirst(f)) >= 0), true);
  } else if (members.length === 2) {
    /* an interval: as many keys as the shortest walk on the keyboard between its two notes */
    const dist = new Map([[members[0], 0]]), queue = [members[0]];
    for (let i = 0; i < queue.length && !dist.has(members[1]); i++) for (const x of around(queue[i])) if (!dist.has(x)) { dist.set(x, dist.get(queue[i]) + 1); queue.push(x); }
    pathStats.byWalk++;
    check(`${tag}: as many path keys as the shortest walk on the keyboard`, drawn.length, dist.get(members[1]) - 1);
  } else pathStats.unproven++;
  /* Max's expectation: between two notes that is the one-turn walk, the higher of the two (by its
     highest key, then its next), wherever that walk lies on the keyboard. Where it runs off, the
     highest shortest walk that stays on is drawn, which may turn more than once */
  if (members.length === 2) {
    const walks = oneTurnPaths(sh.cells[0], sh.cells[1]).map((w) => w.between);
    const best = walks.reduce((a, b) => (over(highFirst(b.map(String)), highFirst(a.map(String))) > 0 ? b : a));
    if (best.every((c) => board.has(String(c)))) { pathStats.oneTurnHasRoom++; check(`${tag}: the higher one-turn walk, where it lies on the keyboard`, keys(sh.path), keys(best)); }
    else pathStats.off++;
  }
}
let sameDirection = 0, seamed = 0;
const seamStats = { segments: 0, whole: 0, shorter: 0 };
const octaveOver = [], narrowed = [];
const RANDAL_KEYS = baseKeys.map(([u, v]) => [REF[0] + u, REF[1] + v]), RANDAL_HAS = new Set(RANDAL_KEYS.map(String));
let pathKeyTotal = 0;
for (const g of guide) {
  const sh = g.shape;
  /* C: exact members, the bass, the positions */
  g.members.forEach((m, i) => check(`C ${g.name}: member ${i} exact`, expsKey(subExps(exps(sh.cells[i], L), exps(sh.bass, L))), expsKey(m)));
  check(`C ${g.name}: bass first`, String(sh.cells[0]), String(sh.bass));
  check(`C ${g.name}: bass is C`, noteName(sh.bass[0], sh.bass[1], L.mapping, L.anchor, L.banded), 'C');
  check(`C ${g.name}: bass in its position`, posInBandOf(sh.bass[0], sh.bass[1], L.mapping), sh.position);
  /* its position's C, or that key whole bands over (an octave): a wide shape starts where it fits the keyboard */
  { const [bq, br] = BASS[sh.position].split(',').map(Number); check(`C ${g.name}: bass cell`, sh.bass[1] === br && (sh.bass[0] - bq) % 3 === 0, true); if (String(sh.bass) !== BASS[sh.position]) octaveOver.push(g.name); }
  check(`C ${g.name}: bass hue`, keyColor(sh.bass[0], sh.bass[1], L.mode, L.mapping, L.anchor, L.banded).hue, HUE[sh.position]);
  const fives = g.members.map((e) => e[2]), lo = Math.min(...fives), hi = Math.max(...fives);
  /* by the tuning, the positions −lo … 2 − hi; on the keyboard, those of them where the same keys,
     moved with any key of that position, all lie on its 280 keys */
  const tuned = [0, 1, 2].filter((p) => p >= -lo && p <= 2 - hi);
  const want = tuned.filter((p) => RANDAL_KEYS.filter((c) => posInBandOf(c[0], c[1], L.mapping) === p)
    .some((c) => sh.cells.every((k) => RANDAL_HAS.has(`${c[0] + k[0] - sh.bass[0]},${c[1] + k[1] - sh.bass[1]}`))));
  if (want.length < tuned.length) narrowed.push(g.name);
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

  /* E: the path keys, every connecting set of up to five keys tried */
  checkPath(`E ${g.name}`, sh, L, REF, 5);
  if (g.kind !== 'interval') pathKeyTotal += sh.path.length;
  else if (sh.path.length) {
    const paths = oneTurnPaths(sh.cells[0], sh.cells[1]), from = freq(sh.cells[0], L), to = freq(sh.cells[1], L);
    if (paths.length === 2 && paths.every((p) => freq(p.corner, L) > from && freq(p.corner, L) < to)) sameDirection++;
  }

  /* F: the seams. Randal's run along R, where a key at (q, r) sits at q + 2r in half key widths
     and reaches 1 to either side; a seam segment between two adjacent keys covers the half key
     width between their two positions. A seam looks only at the keys beside it, those in the two
     columns on either side (Max, 2026-11-19): on a band of three, the center and right columns
     of the band before it and the left and center columns of the band after */
  const along = (c) => c[0] + 2 * c[1];
  const shown = [...sh.cells, ...sh.path], bandAt = (c) => bandOfCell(c[0], c[1], L.mapping), bands = shown.map(bandAt);
  const crossed = sh.positions.length === 3 ? 0 : Math.max(...bands) - Math.min(...bands);
  if (crossed) seamed++;
  check(`F ${g.name}: seam segments are distinct`, new Set(sh.seams.map(String)).size, sh.seams.length);
  const starts = new Map();
  for (const [a, b] of sh.seams) {
    const ba = bandAt(a), bb = bandAt(b);
    check(`F ${g.name}: seam ${a}|${b} between neighbors`, hexDistance(a, b), 1);
    check(`F ${g.name}: seam ${a}|${b} between bands`, Math.abs(ba - bb), 1);
    check(`F ${g.name}: seam ${a}|${b} covers one half key width along R`, Math.abs(along(a) - along(b)), 1);
    const seam = Math.min(ba, bb);
    starts.set(seam, (starts.get(seam) ?? new Set()).add(Math.min(along(a), along(b))));
  }
  check(`F ${g.name}: seams`, starts.size, crossed);
  let segments = 0;
  for (let seam = Math.min(...bands); crossed && seam < Math.max(...bands); seam++) {
    const beside = shown.filter((c) => (bandAt(c) === seam && posInBandOf(c[0], c[1], L.mapping) >= 1) || (bandAt(c) === seam + 1 && posInBandOf(c[0], c[1], L.mapping) <= 1));
    check(`F ${g.name}: seam ${seam} has keys beside it`, beside.length > 0, true);
    /* those keys reach from lo − 1 to hi + 1: that many segments, and one past either end, in one unbroken run */
    const lo = Math.min(...beside.map(along)), hi = Math.max(...beside.map(along));
    const run = []; for (let t = lo - 2; t <= hi + 1; t++) run.push(t);
    check(`F ${g.name}: seam ${seam} runs the reach of the keys beside it and one segment past either end`, [...(starts.get(seam) ?? [])].sort((x, y) => x - y).join(), run.join());
    segments += run.length;
  }
  check(`F ${g.name}: seam segments`, sh.seams.length, segments);
  /* what the seams would be if each ran the whole shape's reach, as they did before */
  if (crossed) { const whole = crossed * (Math.max(...shown.map(along)) - Math.min(...shown.map(along)) + 4); seamStats.segments += segments; seamStats.whole += whole; if (segments < whole) seamStats.shorter++; }

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
check('G intervals', ivs.length, 41);
check('G interval names are distinct', new Set(ivs.map((g) => g.name)).size, 41);
check('G short interval names are distinct', new Set(ivs.map((g) => g.steps[0])).size, 41);
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
check('G the scales\' other intervals, counted', listed, '11,9,11,8,12,13,11,12,13,9');
check('C entries that start on their position\'s C an octave over, to fit the keyboard', octaveOver.length, 24);
check('C entries whose positions the keyboard narrows (the tuning allows more): none, with any key to start on', narrowed.length, 0);
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
console.log(`Randal, Ptolemaic: ${guide.length} entries; ${seamed} show a seam, ${seamStats.shorter} of them shorter than the whole shape's reach (${seamStats.segments} segments where that reach would take ${seamStats.whole}); ${sameDirection} steps walk two legs in one direction`);
console.log(`  the structures show ${pathKeyTotal} path keys in all; of ${pathStats.withPath} entries with path keys ${pathStats.proven} are checked against every connecting set (${pathStats.severalSmallest} have several smallest sets, the touching rule deciding ${pathStats.touchDecides}), ${pathStats.byWalk} by the shortest walk, ${pathStats.unproven} not at all`);
const pathRandal = { ...pathStats };

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
/* each layout as the guide solves it: the reference on C's tonic key, the anchor on its band */
const LAYOUTS = SHAPE_GUIDE_MODES.flatMap((mode) => MAPPINGS.map((m) => rootedLayout({ mode, mapping: m, banded: true }, 'C')));
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
const STRUCTURE_AT = new Map(STRUCTURES.map((x, i) => [x.name, i])), numbersLast = {};
let countNotInversion = 0;
/* the pictures shown scaled down, the widest shown as drawn, and a sheet's height inside its margins (px) */
const scaledAll = [];
let widestAsDrawn = 0;
const SHEET_TALL = (11 - 1.2) * 96;
/* the shapes a marked bass would hold nearer than the plain one drawn, by layout, and the most it costs */
const plainCosts = {};
let plainCostMost = 0;
/* what rule 7, the nearest the reference, decides: shapes it parts from a rival alike through rule 6; a rival
   that is the same shape in the same column (another octave or band), the same shape in another column, or another arrangement */
const byRef = { shapes: 0, octave: 0, column: 0, other: 0 };
let decidedByArrows = 0, decidedByNearness = 0, decidedByFifths = 0, offC = 0, awayMost = 0, markedAll = 0, solvedAll = 0;
/* the keyboard: a Lumatone's 280 keys as lattice offsets from the reference at its center. In
   the guide's alignment a key's offset is its entry in baseKeys as it stands */
check('H the keyboard: 280 keys, the reference among them', `${baseKeys.length} ${baseKeys.some(([u, v]) => u === 0 && v === 0)} ${new Set(baseKeys.map(String)).size}`, '280 true 280');
check('H in the guide\'s alignment a key\'s offset is its entry as it stands', baseKeys.every(([u, v]) => String(poseOffset(GUIDE_ALIGNMENT, u, v)) === `${u},${v}`), true);
for (const { layout: l, ref } of LAYOUTS) {
  let solved = 0, repeats = 0, marked = 0;
  const left = {};
  setRotation(GUIDE_ROTATION, l.mapping, GUIDE_ALIGNMENT);
  const tag = `H ${l.mapping} ${l.mode}`;
  const width = bandWidth(l.mapping), spine = Math.floor(4 / matrixOf(l.mapping).c);
  const midi = (c) => coordToMidi(c[0], c[1], l.mapping);
  const marksOf = (c) => Math.abs(exps(c, l)[2]) + Math.abs(exps(c, l)[3]);
  /* a key's note on the line of fifths, from its spelling (F C G D A E B, seven more per sharp),
     as far from C, the starting note */
  const fifthsOf = (c) => { const n = noteName(c[0], c[1], l.mapping, l.anchor, l.banded); return Math.abs('FCGDAEB'.indexOf(n[0]) - 1 + 7 * [...n.slice(1)].reduce((k, x) => k + (x === '#' ? 1 : x === 'b' ? -1 : 0), 0)); };
  /* the keyboard: the 280 keys, centered on the reference, the unaltered C. One set of keys for
     the whole guide */
  check(`${tag}: the reference is an unaltered C`, `${noteName(ref[0], ref[1], l.mapping, l.anchor, l.banded)} ${marksOf(ref)}`, 'C 0');
  const boards = [ref].map(([q, r]) => {
    const cells = baseKeys.map(([u, v]) => [q + u, r + v]), byPitch = new Map();
    for (const c of cells) { const k = expsKey(exps(c, l)), at = byPitch.get(k); if (at) at.push(c); else byPitch.set(k, [c]); }
    return { center: [q, r], cells, has: new Set(cells.map(String)), byPitch };
  });
  /* the basses a shape may start from: every key of the keyboard, whatever its name, with
     its column, its marks (its pitch's 5- and 7-exponents), how many fifths its note is from C,
     and how near the reference it is: by distance, then in pitch, then lower, then higher on the page */
  const basses = boards.flatMap((board) => board.cells.map((cell) =>
    ({ p: posInBandOf(cell[0], cell[1], l.mapping), marks: marksOf(cell), fifths: fifthsOf(cell), cell, board, near: [hexDistance(ref, cell), Math.abs(midi(cell) - midi(ref)), midi(cell), -up(cell)] })));
  const nearer = (a, b) => a.near[0] - b.near[0] || a.near[1] - b.near[1] || a.near[2] - b.near[2] || (Math.abs(a.near[3] - b.near[3]) < LEVEL ? 0 : a.near[3] - b.near[3]);
  /* every key of a bass's keyboard that sounds `m` above it */
  const keysOf = (b, m) => b.board.byPitch.get(expsKey(addExps(exps(b.cell, l), m))) ?? [];
  const apart = (cells) => { let n = 0; for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) n += real(cells[i], cells[j]); return n; };
  const all = [...STRUCTURES.map((s) => s.members), ...SET.map((e) => [UNISON, e])];
  const nameOf = new Map([...STRUCTURES.map((s) => [s.members, s.name]), ...all.slice(STRUCTURES.length).map((m) => [m, ratioOf(m[1]).join(':')])]);
  for (const members of all) {
    const sh = solve(members, l, 'C', ref);
    /* a position's arrangement: each member on a key of its pitch nearest the bass; of equally
       near keys the choices closest together; of those the ones that stand highest (one, unless
       two are level) */
    const arrange = (b) => {
      const bass = b.cell;
      const options = members.map((m) => {
        const at = keysOf(b, m), d = Math.min(...at.map((c) => real(bass, c)));
        return at.filter((c) => real(bass, c) - d < SAME);
      });
      if (options.some((o) => !o.length)) return null;
      let combos = [[]];
      for (const o of options) combos = combos.flatMap((c) => o.map((k) => [...c, k]));
      const least = Math.min(...combos.map(apart)), close = combos.filter((c) => apart(c) - least < SAME);
      const top = Math.max(...close.map(ups));
      return { options, best: close.filter((c) => top - ups(c) < LEVEL), spread: close[0].reduce((n, c) => n + real(bass, c), 0) };
    };
    /* one arrangement found on two keyboards is one */
    const met = new Set();
    const arranged = basses.map((b) => ({ ...b, a: arrange(b) })).filter((x) => { if (!x.a) return false; const id = x.cell + '|' + x.a.best.map(keys).sort().join(';'); if (met.has(id)) return false; met.add(id); return true; });
    check(`${tag}: solved exactly when a key of the keyboard holds every member`, !!sh, arranged.length > 0);
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
    const here = arranged.find((x) => String(x.cell) === String(sh.bass) && x.a.best.some((c) => keys(c) === keys(sh.cells)));
    check(`${tag}: the bass is a key of the keyboard, in the position drawn`, !!here && here.p === sh.position, true);
    if (!here) continue;
    /* 1: no key that holds the members is plainer */
    check(`${tag}: 1, the plainest bass that holds it`, here.marks, Math.min(...arranged.map((x) => x.marks)));
    if (here.marks > 0) marked++;
    if (here.fifths > 0) { offC++; awayMost = Math.max(awayMost, here.fifths); }
    /* each key as near the bass as any of its pitch; of equally near keys, the choice closest
       together, and of those the one that stands highest */
    members.forEach((m, i) => check(`${tag}: member ${i} is a key of its pitch nearest the bass`, here.a.options[i].some((c) => String(c) === String(sh.cells[i])), true));
    if (here.a.options.some((o) => o.length > 1)) repeats++;
    check(`${tag}: of equally near keys, the closest together and then the highest`, here.a.best.some((c) => keys(c) === keys(sh.cells)), true);
    check(`${tag}: "keys" is undecided exactly when two such choices are level`, sh.undecided.includes('keys'), here.a.best.length > 1);
    /* 2: of the plainest, none holds the members nearer its bass. What a marked bass would hold
       nearer is counted (rule 1 before rule 2) */
    const plain = arranged.filter((x) => x.marks === here.marks);
    check(`${tag}: 2, the closest arrangement`, here.a.spread - Math.min(...plain.map((x) => x.a.spread)) < SAME, true);
    const looser = here.a.spread - Math.min(...arranged.map((x) => x.a.spread));
    if (looser > SAME) { plainCosts[`${l.mapping} ${l.mode}`] = (plainCosts[`${l.mapping} ${l.mode}`] ?? 0) + 1; plainCostMost = Math.max(plainCostMost, looser); }
    /* 3: of those, none starts on a note nearer C by fifths: C itself wherever it holds the shape as close */
    const asClose = plain.filter((x) => x.a.spread - here.a.spread < SAME);
    check(`${tag}: 3, on the note nearest C by fifths`, here.fifths, Math.min(...asClose.map((x) => x.fifths)));
    if (asClose.some((x) => x.fifths !== here.fifths)) decidedByFifths++;
    /* 4: of those, none starts nearer the spine column */
    const close = asClose.filter((x) => x.fifths === here.fifths);
    check(`${tag}: 4, from nearest the spine column`, Math.abs(sh.position - spine), Math.min(...close.map((x) => Math.abs(x.p - spine))));
    /* 5, 6, 7: of those, another arrangement never stands higher above its bass; of level ones,
       and of one shape from two columns, none is written with fewer arrows; then the nearest the reference; then the left */
    const rise = (cells, bass) => ups(cells) - cells.length * up(bass);
    const offsets = (cells, bass) => cells.map((c) => [c[0] - bass[0], c[1] - bass[1]]).join(' ');
    const arrows = (cells) => cells.reduce((n, c) => n + Math.abs(exps(c, l)[2]), 0);
    let levelOther = false, levelSame = false, levelBass = false, refOther = false, refOctave = false, refColumn = false;
    for (const x of close) {
      if (x === here || Math.abs(x.p - spine) !== Math.abs(sh.position - spine)) continue;
      const other = x.a.best[0], fewer = arrows(other) - arrows(sh.cells), alike = offsets(other, x.cell) === offsets(sh.cells, sh.bass);
      if (!alike) {
        const d = rise(sh.cells, sh.bass) - rise(other, x.cell);
        check(`${tag}: 5, no equally close arrangement stands higher above its bass`, d > -LEVEL, true);
        if (Math.abs(d) >= LEVEL) continue;
      }
      check(`${tag}: 6, of these, none is written with fewer arrows`, fewer >= 0, true);
      if (fewer !== 0) { if (alike) decidedByArrows++; continue; }
      /* 7: the one nearest the reference; 8: the left one, which is no ruling */
      const near = nearer(here, x);
      check(`${tag}: 7, of these, none is nearer the reference`, near <= 0, true);
      if (near !== 0) { if (alike && x.p !== sh.position) decidedByNearness++; if (!alike) refOther = true; else if (x.p === sh.position) refOctave = true; else refColumn = true; continue; }
      if (!alike) levelOther = true; else if (x.p === sh.position) levelBass = true; else { levelSame = true; check(`${tag}: 8, as near, from the left`, sh.position < x.p, true); }
    }
    if (refOther || refOctave || refColumn) byRef.shapes++;
    if (refOctave) byRef.octave++;
    if (refColumn) byRef.column++;
    if (refOther) byRef.other++;
    check(`${tag}: "position" is undecided exactly when two such arrangements are level`, sh.undecided.includes('position'), levelOther);
    check(`${tag}: "column" is undecided exactly when the shape starts from two such columns, as near the reference`, sh.undecided.includes('column'), levelSame);
    check(`${tag}: "bass" is undecided exactly when two such basses of the column are as near the reference`, sh.undecided.includes('bass'), levelBass);
    for (const u of sh.undecided) undecidedWhere.push(`${l.mapping} ${l.mode} ${nameOf.get(members)}: ${u}`);
    for (const u of sh.undecided) { left[u] = (left[u] ?? 0) + 1; undecidedAll[u] = (undecidedAll[u] ?? 0) + 1; }
    /* the positions: the columns where the same keys, moved with any key of that column, lie on the
       keyboard and sound the members */
    const same = [...new Set(basses.filter((b) => members.every((m, i) => {
      const at = [b.cell[0] + sh.cells[i][0] - sh.bass[0], b.cell[1] + sh.cells[i][1] - sh.bass[1]];
      return b.board.has.has(String(at)) && expsKey(subExps(exps(at, l), exps(b.cell, l))) === expsKey(m);
    })).map((b) => b.p))].sort((a, b) => a - b);
    check(`${tag}: every note of the shape is on the keyboard`, sh.cells.every((c) => boards[0].has.has(String(c))), true);
    checkPath(`${tag}, ${nameOf.get(members)}`, sh, l, ref, 3);
    check(`${tag}: positions are where the same keys work`, sh.positions.join(), same.join());
    check(`${tag}: drawn from one of its positions`, same.includes(sh.position), true);
    check(`${tag}: label`, positionLabel(sh.positions, width),
      sh.positions.length === width ? 'any' : width === 3 ? sh.positions.map((p) => ['left', 'center', 'right'][p]).join(' or ') : 'column ' + sh.positions.map((p) => p + 1).join(' or '));
  }
  console.log(`  ${l.mapping.padEnd(12)} ${l.mode}  ${String(solved).padStart(2)} of ${all.length} on the lattice, ${String(repeats).padStart(2)} with equally near keys, ${String(marked).padStart(2)} from a marked key${Object.keys(left).length ? ', undecided: ' + JSON.stringify(left) : ''}`);
  /* a layout's guide is exactly the shapes it holds, in catalog order, then the intervals it holds */
  const g = buildGuide(l);
  check(`H ${l.mapping} ${l.mode}: the guide holds what the layout holds`, g.length, solved);
  check(`H ${l.mapping} ${l.mode}: structures in catalog order`, g.filter((e) => e.kind !== 'interval').map((e) => e.name).join(';'),
    STRUCTURES.filter((s) => solve(s.members, l, 'C', ref)).map((s) => s.name).join(';'));
  check(`H ${l.mapping} ${l.mode}: every entry has its keys`, g.every((e) => e.shape && e.shape.cells.length === e.members.length), true);
  /* the numbers: a chord and its inversions share one, with a count after a point from the
     second of them the layout holds (7, 7.1, 7.2; the count is not the inversion: Max,
     2026-11-19); a scale and an interval have one each. A chord is found here from the
     catalog's order: a structure's chord starts `inversion` places before it */
  {
    let count = 0, last = -1, nth = 0;
    const want = g.map((e) => {
      const i = STRUCTURE_AT.get(e.name);
      if (i === undefined || STRUCTURES[i].kind !== 'chord') { count++; last = -1; return { number: String(count), listed: e.name }; }
      const chord = i - STRUCTURES[i].inversion;
      if (chord !== last) { count++; last = chord; nth = 0; } else nth++;
      if (nth && String(nth) !== String(STRUCTURES[i].inversion)) countNotInversion++;
      return { number: count + (nth ? '.' + nth : ''), listed: STRUCTURES[chord].name };
    });
    check(`H ${l.mapping} ${l.mode}: numbers`, g.map((e) => e.number).join(), want.map((w) => w.number).join());
    check(`H ${l.mapping} ${l.mode}: listed as`, g.map((e) => e.listed).join(';'), want.map((w) => w.listed).join(';'));
    check(`H ${l.mapping} ${l.mode}: numbers are distinct`, new Set(g.map((e) => e.number)).size, g.length);
    numbersLast[`${l.mapping} ${l.mode}`] = count;
  }
  /* every picture fits a sheet: as drawn, or, wider than a row to itself, scaled down to it. The
     style is the page's (memberBorder 1.5, seamWidth 4: shapes/page.ts STYLE) */
  for (const e of g) {
    const d = diagramSize(e.shape, { memberBorder: 1.5, seamWidth: 4 }), shown = shownSize(d.width, d.height);
    check(`H ${l.mapping} ${l.mode}, ${e.name}: its picture fits a row`, shown.width <= room(1), true);
    check(`H ${l.mapping} ${l.mode}, ${e.name}: its picture keeps its proportions`, Math.abs(shown.width / d.width - shown.height / d.height) < 0.005, true);
    check(`H ${l.mapping} ${l.mode}, ${e.name}: shown as drawn unless it is wider than a row`, shown.scale === 1, d.width <= room(1));
    check(`H ${l.mapping} ${l.mode}, ${e.name}: with its text it is shorter than a sheet`, shown.height + 120 < SHEET_TALL, true);
    if (shown.scale < 1) scaledAll.push({ layout: `${l.mapping} ${l.mode}`, name: e.name, drawn: d.width, scale: shown.scale });
    else widestAsDrawn = Math.max(widestAsDrawn, d.width);
  }
  /* a ratio has one name in a guide, and a name one ratio, in full and in short */
  const ivs = g.filter((e) => e.kind === 'interval');
  check(`H ${l.mapping} ${l.mode}: interval names are distinct`, new Set(ivs.map((e) => e.name)).size, ivs.length);
  check(`H ${l.mapping} ${l.mode}: short interval names are distinct`, new Set(ivs.map((e) => e.steps[0])).size, ivs.length);
  /* Septimal holds the whole catalog but for what its retuned column takes away, and every
     septimal structure and interval, on every mapping */
  if (l.mode === '7') {
    /* every mapping holds what Randal does, but for the shapes too wide for a Lumatone there:
       ten on Chromatic, whose 12-wide bands a chain of fifths crosses slowly, and one on Janko */
    check(`H ${l.mapping} 7: entries`, g.length, { chromatic: 133 }[l.mapping] ?? 143);
    check(`H ${l.mapping} 7: every structure and interval with a 7 is held`, all.filter((m) => m.some((e) => e[3] !== 0)).every((m) => solve(m, l, 'C', ref)), true);
  } else {
    if (l.mode === '5') check(`H ${l.mapping} 5: entries`, g.length, { chromatic: 118 }[l.mapping] ?? 128);
    if (l.mode === 'P') check(`H ${l.mapping} P: entries, all 3-limit`, `${g.length} ${g.every((e) => e.members.every((x) => x[2] === 0 && x[3] === 0))}`, '55 true');
    check(`H ${l.mapping} ${l.mode}: nothing with a 7 is held`, all.filter((m) => m.some((e) => e[3] !== 0)).some((m) => solve(m, l, 'C', ref)), false);
  }
  markedAll += marked; solvedAll += solved;
}
/* Max, 2026-11-18: the plain C before a marked one; an exact tie between different keys to the
   one visually higher; between two equally plain columns for one shape, to the one with the
   fewest HEJI arrows. Over the 48 layouts the only choice left to scan order is that last one
   when the arrows are as many, and it is drawn from the left: on Chromatic in Syntonic and in
   Polysyntonic, two Pythagorean shapes that start from columns 2 and 8, each three from the
   spine column */
check('H no choice is left to scan order', undecidedWhere.join('; '), '');
/* Max, 2026-11-18 and -19: a shape is in a layout's guide when a Lumatone holds it there; one
   too wide for a sheet is scaled down, not left out. What is left to scale are shapes of
   Pythagorean thirds on Wicki-Hayden and Chromatic, up to 782 px as drawn: a Lumatone is 39
   columns across, wider than a sheet at this key size */
{
  const by = {};
  for (const x of scaledAll) { const b = (by[x.layout] ??= { n: 0, least: 1 }); b.n++; b.least = Math.min(b.least, x.scale); }
  check('H the pictures scaled down to fit, by layout, and the smallest', Object.entries(by).map(([k, v]) => `${k} ×${v.n}, to ${Math.round(v.least * 100)}%`).join('; '),
    'wickiHayden 5 ×2, to 88%; chromatic 5 ×11, to 91%; wickiHayden 7 ×2, to 88%; chromatic 7 ×11, to 91%');
  check('H each of them has Pythagorean thirds', scaledAll.every((x) => /^(Pythagorean|Semiditonal) /.test(x.name)), true);
  check('H the widest drawn', Math.max(...scaledAll.map((x) => x.drawn)), 782);
}
check('H the sheet and a row\'s room, in px', `${Math.round(SHEET)} ${Math.floor(room(1))}`, '701 687');
/* the contents: a section may break across columns only when it is longer than an even third of
   the table (its lines, and two for its heading and the space under it), and has lines enough to
   leave three on either side of a break */
check('H contents: three lines are kept on either side of a break', CONTENTS_KEEP, 3);
check('H contents: Randal in Ptolemaic (10, 10, 3, 10 and 41 lines): only the intervals may break', contentsSplits([10, 10, 3, 10, 41]).join(), 'false,false,false,false,true');
check('H contents: even sections stay whole', contentsSplits([12, 12, 12]).join(), 'false,false,false');
check('H contents: a section just over a third breaks, one just under does not', `${contentsSplits([20, 8, 8, 8]).join()} | ${contentsSplits([14, 14, 14, 6]).join()}`, 'true,false,false,false | false,false,false,false');
check('H contents: a long section too short to leave three and three stays whole', contentsSplits([5, 1, 1]).join(), 'false,false,false');
check('H contents: two long sections may both break', contentsSplits([30, 2, 30]).join(), 'true,false,true');
/* the indent holds the widest number: two digits as it stands, a digit 8 px more, the point of an inversion 4 px */
check('H the indent, in px: 9, 94, 100, 9.1, 47.3, 104.2, and a guide of several', [['9'], ['94'], ['100'], ['9.1'], ['47.3'], ['104.2'], ['1', '9.2', '47', '47.3', '60']].map((n) => indentOf(n).toFixed(1)).join(' '), '20.4 20.4 28.4 24.4 32.4 40.4 32.4');
check('H the room of a third, a half and a row, in px (a picture has the entry\'s width less its gutter)', [3, 2, 1].map((n) => Math.floor(room(n))).join(' '), '220 337 687');
console.log(`  pictures: ${scaledAll.length} scaled down to a row (${Math.floor(room(1))} px); the widest shown as drawn is ${widestAsDrawn} px`);
/* rule 1 before rule 2 (Max, 2026-11-18): the plain C is the example even where a marked C would
   hold the shape a little nearer. Where that happens, and by how much at most, is pinned */
check('H shapes a marked bass would hold nearer than the plain one drawn', Object.entries(plainCosts).map(([k, n]) => `${k} ×${n}`).join('; '), 'accordion S ×7; park S ×2');
check('H the most the plain bass costs, in key widths summed over a shape', plainCostMost.toFixed(2), '0.54');
/* Max's case: two arrangements of the wolf 5th as many steps apart and as high, one turning after
   four steps and one after six; the nearer in real space is the shape */
{
  const l = layoutOf('wickiHayden', 'S'), e = buildGuide(l).find((x) => x.ratio === '40:27'), [a, b] = e?.shape.cells ?? [[0, 0], [0, 0]];
  check('H Wicki-Hayden in Syntonic, wolf 5th', `${e?.name} | ${hexDistance(a, b)} steps | ${Math.round(real(a, b) ** 2)} key widths squared`, 'wolf 5th | 7 steps | 37 key widths squared');
}
console.log(`  the last number of a guide: Randal in Ptolemaic ${numbersLast['randal 5']}, in Septimal ${numbersLast['randal 7']}; the most ${Math.max(...Object.values(numbersLast))}; ${countNotInversion} entries over the 48 layouts are numbered with a count that is not their inversion`);
console.log(`  ${solvedAll} shapes over the ${LAYOUTS.length} layouts: ${markedAll} start on a marked key (no plain key holds them); ${offC} start on another note than C (at most ${awayMost} fifths from it), and the fifths rule decides ${decidedByFifths}; the reference rule decides ${byRef.shapes} (the same shape in its column ${byRef.octave}, in another column ${byRef.column}, another arrangement ${byRef.other}); two columns for one shape: ${decidedByArrows} decided by arrows; undecided: ${JSON.stringify(undecidedAll)}`);
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
  /* the 99, less the diminished seventh's four, the augmented triad's three and the augmented
     sixths' eleven, none of which Septimal can hold */
  check('H Randal 7: chord entries', seen, 81);
}
/* Max's case: on Park the C of column 2 is a C↓ in Ptolemaic and a hooked C in Septimal, and the
   C of column 4 is plain; both hold these shapes, and the plain one is the example */
const marksAt = (c, l) => { const h = hejiCommasFor(l.mode, c[0], c[1], l.mapping, l.anchor, l.banded); return Math.abs(h.syn5) + Math.abs(h.sept7); };
for (const [mode, ratio, want] of [['5', '10:9', 'major 2nd | column 2 or 4 | from column 4, 0 marks on its C'], ['5', '40:27', 'wolf 5th | column 2 or 4 | from column 4, 0 marks on its C'],
  ['7', '32:27', 'Pythagorean minor 3rd | column 2 or 4 or 6 | from column 4, 0 marks on its C']]) {
  const l = layoutOf('park', mode), e = buildGuide(l).find((x) => x.ratio === ratio);
  check(`H Park ${mode}, ${ratio}`, e ? `${e.name} | ${e.start} | from column ${e.shape.position + 1}, ${marksAt(e.shape.bass, l)} marks on its C` : null, want);
}
/* Max's cases (2026-11-19): a shape starts on any key that holds it, so an isomorphic shape starts
   from every column it fits (on Randal in Ptolemaic the Pythagorean diminished 4th, which from C
   alone ran off the keyboard's edge in the right column and showed seams), and a shape is drawn
   from another note where that is closer (on Chromatic in Syntonic the Pythagorean diminished
   seventh in third inversion from B♭, two path keys; from C it lay 15 path keys apart) */
{
  const spelled = (e, l) => e.shape.cells.map((c) => noteName(c[0], c[1], l.mapping, l.anchor, l.banded)).join(' ');
  const lr = layoutOf('randal', '5'), d4 = buildGuide(lr).find((e) => e.ratio === '8192:6561');
  check('H Randal in Ptolemaic, Pythagorean diminished 4th', `${d4?.name} | ${d4 ? spelled(d4, lr) : ''} | ${d4?.start} | ${d4?.shape.seams.length} seam segments`, 'Pythagorean diminished 4th | C Fb | any | 0 seam segments');
  const lc = layoutOf('chromatic', 'S'), d7 = buildGuide(lc).find((e) => e.name === 'Pythagorean diminished seventh in third inversion');
  check('H Chromatic in Syntonic, Pythagorean diminished seventh in third inversion', `${d7 ? spelled(d7, lc) : ''} | ${d7?.shape.path.length} path keys`, 'Bb C# E G | 2 path keys');
}
check('H shapes that start on another note than C, over the 48 layouts, and the most fifths from it', `${offC}, ${awayMost}`, '209, 6');
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
