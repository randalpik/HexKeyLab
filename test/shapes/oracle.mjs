// Shape-guide oracle (docs/architecture/hkl.md → Lattice shapes).
//
// Pure Node gate — no dev server, no browser, no audio. Imports the REAL catalog, solver and guide
// (apps/hkl/src/shapes/) and HKL's namers through the repo's TS loader, and checks:
//   A  the catalog: 36 chord entries and 4 scales in guide order; every inversion is its root
//      position turned (the bass up an octave); members ascend; a scale runs unison to octave
//      over 9/8, 4/3 and 3/2
//   B  the interval set: the 31, each one between two members of a structure or, for a scale
//      (which repeats at the octave), the octave complement of one; closed under octave complement
//   C  Randal in Ptolemaic, banded — every entry is on the lattice; each key sounds its member's
//      ratio from the bass exactly; the bass is the C of its position (purple left, spring green
//      center, pink right), the three pinned; the valid positions equal the closed form
//      −lo … 2 − hi over the members' 5-exponents; center is drawn whenever it is valid
//   D  HKL's chord namer (analyzeChord) gives every chord entry the catalog's name, inversion
//      and root-position ratio
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
//   G  the guide: 71 entries, structures then intervals by number and size; full and short interval
//      names all distinct; every pair of keys in every structure is named by HKL exactly as the
//      guide's interval of that ratio; an entry lists its steps, then every other interval between
//      two of its own keys, lower to upper, a scale's less the octave (11, 8, 12 and 13 for the
//      four scales); an interval's one step is itself; the short forms the guide quotes (an octave
//      shortens as a 4th or 5th does: P8, <d8, WP8)
//   R  rows (rows.ts), over every sequence of up to seven entries: each entry once and in order;
//      a row never gives an entry less room than it needs, and holds no more entries than its
//      columns; the whole width only for an entry that needs it; a short row of thirds only at
//      the end; an entry alone on a half only when last or before a whole-width entry; three
//      thirds are never split; two thirds before two halves share their row as halves
//   H  any layout: under each of the eight presets in Ptolemaic, and Randal in every JI mode,
//      every shape the solver returns is exact (the counts are printed, not pinned)
// Run: node --import ./test/orchestrator-smoke/register-ts.mjs test/shapes/oracle.mjs

import {
  STRUCTURES, POSITION, UNISON, OCTAVE, intervalSet, intervalsWithin, combinedRatio, expsKey, expsOf, addExps, subExps, centsOf,
} from '../../apps/hkl/src/shapes/catalog.ts';
import { solve, hexDistance, positionLabel } from '../../apps/hkl/src/shapes/solve.ts';
import { buildGuide } from '../../apps/hkl/src/shapes/guide.ts';
import { rowsOf } from '../../apps/hkl/src/shapes/rows.ts';
import { analyzeChord } from '../../apps/hkl/src/tuning/chords.ts';
import { intervalNameFromCoords, shortenInterval } from '../../apps/hkl/src/tuning/intervals.ts';
import { coordExps, freqAt, anchorOf, TUNING_MODES } from '../../packages/shared/src/freq.ts';
import { MAPPINGS, bandOfCell, posInBandOf, bandWidth } from '../../packages/shared/src/mapping.ts';
import { noteName } from '../../packages/shared/src/notes.ts';
import { keyColor } from '../../packages/shared/src/keycolor.ts';

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
check('A chord entries', chords.length, 36);
check('A scales', scales.length, 4);
check('A order: chords first', STRUCTURES.findIndex((s) => s.kind === 'scale'), 36);
check('A names', STRUCTURES.filter((s) => s.inversion === 0).map((s) => s.name).join('; '),
  'major triad; minor triad; Pythagorean minor triad; diminished triad; dominant seventh; minor seventh; '
  + 'Pythagorean minor seventh; major seventh; diminished seventh; half-diminished seventh; Ptolemaic major scale; '
  + 'Pythagorean natural minor scale; Ptolemaic harmonic minor scale; Pythagorean melodic minor scale');
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
  check(`A ${s.name}: title`, s.title, root.name);
  check(`A ${s.name}: name is the title and, when inverted, its position`, s.name, s.inversion ? `${s.title} ${POSITION[s.inversion]}` : s.title);
  check(`A ${s.name}: within an octave`, centsOf(s.members[s.members.length - 1]) < 1200, true);
  /* the root position's members from the `inversion`-th up, then the rest an octave higher */
  const k = s.inversion, turned = [...root.members.slice(k), ...root.members.slice(0, k).map((e) => addExps(e, OCTAVE))].map((e) => subExps(e, root.members[k]));
  check(`A ${s.name}: is ${root.name} turned ${k}`, s.members.map(expsKey).join(' '), turned.map(expsKey).join(' '));
}

/* ── B. the interval set ── */
const SET = intervalSet(), setKeys = new Set(SET.map(expsKey));
check('B size', SET.length, 31);
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
check('G entries', guide.length, 71);
check('G positions', POSITION.join('; '), 'in root position; in first inversion; in second inversion; in third inversion');
for (const [i, g] of guide.entries()) {
  const s = STRUCTURES[i];
  check(`G ${g.name}: title`, g.title, s ? s.title : g.name);
  check(`G ${g.name}: subtitle`, g.subtitle, s && s.kind === 'chord' ? POSITION[s.inversion] : '');
  /* an interval's cents, from its printed ratio: one decimal and the cent sign, as the info panel has it */
  const [num, den] = g.ratio.split(':').map(Number);
  check(`G ${g.name}: cents`, g.cents, s ? '' : (1200 * Math.log2(num / den)).toFixed(1) + '¢');
}
check('G structures first, in catalog order', guide.slice(0, 40).map((g) => g.name).join(';'), STRUCTURES.map((s) => s.name).join(';'));
let sameDirection = 0, seamed = 0;
let exhaustive = 0, pathKeyTotal = 0;
const tied = [], byTouch = [];
for (const g of guide) {
  const sh = g.shape;
  check(`C ${g.name}: on the lattice`, !!sh, true);
  if (!sh) continue;
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
    const s = STRUCTURES.find((x) => x.name === g.name);
    const rootOf = STRUCTURES.slice(0, STRUCTURES.indexOf(s) + 1).reverse().find((x) => x.inversion === 0);
    check(`D ${g.name}: HKL name`, res ? res.quality + (res.invName ? ' ' + res.invName : '') : 'none', g.name);
    check(`D ${g.name}: HKL ratio`, res ? res.ratio : 'none', combinedRatio(rootOf.members));
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
check('G intervals', ivs.length, 31);
check('G interval names are distinct', new Set(ivs.map((g) => g.name)).size, 31);
check('G short interval names are distinct', new Set(ivs.map((g) => g.steps[0])).size, 31);
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
check('G scales list 11, 8, 12 and 13 other intervals', listed, '11,8,12,13');
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
const LAYOUTS = [...MAPPINGS.map((m) => layoutOf(m, '5')), ...TUNING_MODES.filter((m) => m !== 'E' && m !== '5').map((m) => layoutOf('randal', m))];
for (const l of LAYOUTS) {
  let solved = 0;
  const all = [...STRUCTURES.map((s) => s.members), ...SET.map((e) => [UNISON, e])];
  for (const members of all) {
    const sh = solve(members, l);
    if (!sh) continue;
    solved++;
    members.forEach((m, i) => check(`H ${l.mapping} ${l.mode}: member ${i} exact`, expsKey(subExps(exps(sh.cells[i], l), exps(sh.bass, l))), expsKey(m)));
    check(`H ${l.mapping} ${l.mode}: label`, typeof positionLabel(sh.positions, bandWidth(l.mapping)), 'string');
  }
  console.log(`  ${l.mapping.padEnd(12)} ${l.mode}  ${String(solved).padStart(2)} of ${all.length} on the lattice`);
}

console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
