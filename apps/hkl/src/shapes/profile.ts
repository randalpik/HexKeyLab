// Key profiles: what it takes to play in a key, for evaluating layouts and for
// the Scales page (./scalePage.ts).
//
// A scale is not the whole of a key. A profile declares the harmony played in
// it: a native triad and seventh chord on every note of its scale, the
// secondary dominants, the borrowed chords. From those follows the key's
// footprint: every pitch the chords need, as exact ratios from the tonic. The
// footprint is larger than the scale, and that is the point (Max, 2026-11-19):
// in 5-limit major the A of ii is not the A of IV, and a septimal dominant on V
// needs an F that is no scale degree, so the notes a key requires are only
// found by building its chords. Two keys can share a scale and differ in their
// chords: Ptolemaic and Semiditonal major are one scale and two profiles.
//
// Chords come in tiers, most essential first, so a result can be read tier by
// tier without weighing one chord against another:
//   1  the diatonic triads: at least one on every scale note
//   2  the diatonic sevenths: at least one on every scale note
//   3  the secondary dominants: the profile's dominant, as a triad and as a
//      seventh, a pure fifth above every root but the tonic that holds a
//      diatonic major or minor triad. Whether a layout can play one is a
//      result, not a reason to move it: a dominant on another root is not
//      that chord's
//   4  the borrowed chords, each on a stated root
// A minor profile stands on its natural, harmonic and melodic scales together
// (Max, 2026-11-19): nine roots, two sixths and two sevenths, and every triad
// and seventh chord any of the three scales has on a note, as far as the
// catalog has the kind of chord (it has no minor-major or augmented-major
// seventh). So a root may hold two triads (ii° and ii, iv and IV, V and v).
// Every chord is one of the catalog's (./catalog.ts), in root position, but
// for the diminished ii of a minor key (Max, 2026-11-19): it is always the
// upper three notes of the key's diminished seventh on vii, and the
// half-diminished seventh on ii is that triad with the tonic above it. Where
// those are not catalog chords they stay out of the catalog and get no name
// of their own: they are called what HKL calls their keys (`chordName`). A
// footprint is of pitch classes, so inversions add nothing to it.
//
// Pure: no DOM and no state, so Node tools (test/shapes/) import it.

import { coordExps } from '@hkl/shared/freq.js';
import { KEY_PROFILE_IDS, KEY_PROFILE_LABELS, type KeyProfileId } from '@hkl/shared/keyProfiles.js';
import { posInBandOf } from '@hkl/shared/mapping.js';
import { fifthIndex, fifthName } from '@hkl/shared/notes.js';
import { baseKeys } from '../layout/baseKeys.js';
import { analyzeChord } from '../tuning/chords.js';
import { OCTAVE, STRUCTURES, UNISON, addExps, centsOf, expsKey, expsOf, pitchClass, subExps, type Exps } from './catalog.js';
import { keyDistance, seamsAcross, solve, type Cell, type Shape, type ShapeLayout } from './solve.js';

export { pitchClass };
export type Tier = 1 | 2 | 3 | 4;
export const TIERS: ReadonlyArray<Tier> = [1, 2, 3, 4];
export const TIER_NAMES: Readonly<Record<Tier, string>> = { 1: 'diatonic triads', 2: 'diatonic sevenths', 3: 'secondary dominants', 4: 'borrowed chords' };

type R = readonly [number, number];

/** A profile as it is declared. */
interface ProfileSpec {
  id: KeyProfileId;
  /** The catalog scales whose notes it stands on, taken together. */
  scales: ReadonlyArray<string>;
  /** The diatonic chords: a triad's numeral, its root as a ratio from the
   *  tonic (a scale note), the catalog triad, and the catalog seventh chords
   *  built on it. Where a root has two triads the commoner comes first: it
   *  names the root's secondary dominant ("V/iv", "V/V"). */
  degrees: ReadonlyArray<readonly [numeral: string, root: R, triad: string, ...sevenths: string[]]>;
  /** The dominant, as a triad and as a seventh: what a secondary dominant is. */
  dominant: readonly [string, string];
  /** The borrowed chords: a label, the root as a ratio from the tonic, the catalog chord. */
  borrowed: ReadonlyArray<readonly [label: string, root: R, chord: string]>;
}

export interface ProfileChord {
  tier: Tier;
  /** "ii", "V7", "V7/vi", "♭VI". */
  label: string;
  /** The catalog's name for the chord, or null where the catalog has no such
   *  chord (the derived ii° chords may not be in it: see `chordName`); and its
   *  members from its root, in root position. */
  chord: string | null;
  members: ReadonlyArray<Exps>;
  /** Its root, as a pitch class from the tonic. */
  root: Exps;
  /** Its tones in chord order, as pitch classes from the tonic. */
  tones: Exps[];
}

export interface FootprintPitch {
  /** The pitch class, from the tonic: at least a unison, less than an octave. */
  exps: Exps;
  /** The first tier that needs it. */
  tier: Tier;
  /** Whether it is a note of the profile's scale. */
  inScale: boolean;
  /** The chords that need it, by label, in the profile's order. */
  chords: string[];
}

export interface KeyProfile {
  id: KeyProfileId;
  name: string;
  /** The catalog scales it stands on: one for a major key, three for a minor. */
  scales: ReadonlyArray<{ name: string; members: ReadonlyArray<Exps> }>;
  /** Their notes together, as pitch classes from the tonic, ascending. */
  scale: Exps[];
  chords: ProfileChord[];
  /** Every pitch class the chords need, ascending from the tonic. */
  footprint: FootprintPitch[];
}

/** A pitch class's name in a key, as the lattice labels it: its place on the
 *  line of fifths (a factor of 5 is four fifths less a syntonic comma, a 7 two
 *  fifths down less a septimal comma), an arrow for each syntonic comma, and a
 *  "7" mark for each septimal one. */
export function pitchName(e: Exps, tonic = 'C'): string {
  const name = fifthName(fifthIndex(tonic) + e[1] + 4 * e[2] - 2 * e[3]);
  const arrows = e[2] > 0 ? '↓'.repeat(e[2]) : '↑'.repeat(-e[2]);
  const hooks = e[3] > 0 ? '⁷'.repeat(e[3]) : '₇'.repeat(-e[3]);
  return name + arrows + hooks;
}

const structureOf = (name: string): ReadonlyArray<Exps> => {
  const s = STRUCTURES.find((x) => x.name === name);
  if (!s) throw new Error(`profile: no catalog structure named "${name}"`);
  return s.members;
};
const FIFTH = expsOf(3, 2);
/* the two derived chords of a minor key, as a spec names them */
const II_DIM = 'ii° of vii°7', II_HALF = 'iiø7 on that';
/* a seventh chord's label, from its numeral and what kind of seventh it is */
const seventhLabel = (numeral: string, chord: string): string =>
  numeral.replace('°', '') + (/half-diminished/.test(chord) ? 'ø7' : /diminished/.test(chord) ? '°7' : /major seventh/.test(chord) ? 'M7' : '7');

function build(spec: ProfileSpec): KeyProfile {
  const scale = [...new Map(spec.scales.flatMap((n) => structureOf(n).slice(0, 7)).map((e) => [expsKey(e), e])).values()].sort((a, b) => centsOf(a) - centsOf(b));
  const inScale = new Set(scale.map(expsKey));
  const chords: ProfileChord[] = [];
  /* a chord by the name a spec gives it: the catalog's, or one of the two derived from vii°7 */
  const chordOf = (chord: string, root: Exps): Pick<ProfileChord, 'chord' | 'members'> => {
    if (chord !== II_DIM && chord !== II_HALF) return { chord, members: structureOf(chord) };
    const vii = spec.degrees.find((g) => g[0] === 'vii°'), seventh = vii?.slice(3).find((c) => / diminished seventh$|^diminished seventh$/.test(c as string) && !/half/.test(c as string)) as string | undefined;
    if (!vii || !seventh) throw new Error(`profile ${spec.id}: no diminished seventh on vii to take ii° from`);
    const of = structureOf(seventh), viiRoot = expsOf(vii[1][0], vii[1][1]);
    if (expsKey(pitchClass(addExps(viiRoot, of[1]!))) !== expsKey(pitchClass(root))) throw new Error(`profile ${spec.id}: ii° is not on the second note of vii°7`);
    const triad = of.slice(1).map((e) => subExps(e, of[1]!));
    const members = chord === II_DIM ? triad : [...triad, subExps(OCTAVE, pitchClass(root))];
    const known = STRUCTURES.find((x) => x.kind === 'chord' && x.inversion === 0 && x.members.length === members.length && x.members.every((m, i) => expsKey(m) === expsKey(members[i]!)));
    return { chord: known?.name ?? null, members };
  };
  const add = (tier: Tier, label: string, chord: string, root: Exps): void => {
    const c = chordOf(chord, root);
    chords.push({ tier, label, ...c, root: pitchClass(root), tones: c.members.map((m) => pitchClass(addExps(root, m))) });
  };
  const degrees = spec.degrees.map(([numeral, [n, d], triad, ...sevenths]) => ({ numeral, root: expsOf(n, d), triad, sevenths }));
  for (const g of degrees) if (!inScale.has(expsKey(g.root))) throw new Error(`profile ${spec.id}: ${g.numeral} is not a note of its scale`);
  for (const e of scale) for (const kind of ['triad', 'seventh'] as const) {
    if (!degrees.some((g) => expsKey(g.root) === expsKey(e) && (kind === 'triad' || g.sevenths.length))) throw new Error(`profile ${spec.id}: a scale note has no ${kind}`);
  }
  for (const g of degrees) add(1, g.numeral, g.triad, g.root);
  for (const g of degrees) for (const seventh of g.sevenths) add(2, seventhLabel(g.numeral, seventh === II_HALF ? 'half-diminished' : seventh), seventh, g.root);
  const led = new Set([expsKey(UNISON)]);
  for (const g of degrees) {
    if (led.has(expsKey(g.root)) || !/(major|minor) triad$/.test(g.triad)) continue;
    led.add(expsKey(g.root));
    const root = addExps(g.root, FIFTH);
    add(3, 'V/' + g.numeral, spec.dominant[0], root);
    add(3, 'V7/' + g.numeral, spec.dominant[1], root);
  }
  for (const [label, [n, d], chord] of spec.borrowed) add(4, label, chord, expsOf(n, d));
  const labels = chords.map((c) => c.label);
  if (new Set(labels).size !== labels.length) throw new Error(`profile ${spec.id}: two chords share a label`);

  const pitches = new Map<string, FootprintPitch>();
  for (const c of chords) for (const t of c.tones) {
    const at = pitches.get(expsKey(t));
    if (at) { if (!at.chords.includes(c.label)) at.chords.push(c.label); } else pitches.set(expsKey(t), { exps: t, tier: c.tier, inScale: inScale.has(expsKey(t)), chords: [c.label] });
  }
  return { id: spec.id, name: KEY_PROFILE_LABELS[spec.id], scales: spec.scales.map((name) => ({ name, members: structureOf(name) })), scale, chords, footprint: [...pitches.values()].sort((a, b) => centsOf(a.exps) - centsOf(b.exps)) };
}

/* The catalog's chords, by the short names the tables below use. */
const M = 'major triad', m = 'minor triad', d = 'diminished triad';
const PM = 'Pythagorean major triad', Pm = 'Pythagorean minor triad', Pd = 'Pythagorean diminished triad';
const sm = 'septimal minor triad', sd = 'septimal diminished triad';
const A = 'augmented triad', PA = 'Pythagorean augmented triad';
const M7 = 'major seventh', m7 = 'minor seventh', D7 = 'dominant seventh', h7 = 'half-diminished seventh', d7 = 'diminished seventh';
const PM7 = 'Pythagorean major seventh', Pm7 = 'Pythagorean minor seventh', PD7 = 'Pythagorean dominant seventh', Ph7 = 'Pythagorean half-diminished seventh', Pd7 = 'Pythagorean diminished seventh';
const sm7 = 'septimal minor seventh', sD7 = 'septimal dominant seventh', sh7 = 'septimal half-diminished seventh', sd7 = 'septimal diminished seventh';
const SIXTHS: ReadonlyArray<readonly [string, R, string]> = [
  ['It+6', [8, 5], 'Italian augmented sixth chord'], ['Fr+6', [8, 5], 'French augmented sixth chord'], ['Ger+6', [8, 5], 'German augmented sixth chord'],
];
const PTOLEMAIC_MAJOR = ['Ptolemaic major scale'];

/* The eight profiles. What Max ruled (2026-11-19) and what is a reading of his
   rules, for him to go through, is told apart in docs/decisions.md.
   - A flavor names its chords: Ptolemaic is 5-limit on every note; Pythagorean
     3-limit on every note; Semiditonal is the Ptolemaic key with Pythagorean
     chords where the Pythagorean minor third is (ii in major; in minor the
     tonic, ii, iv, v and the chords on the lowered degrees); Septimal is the
     Semiditonal key with a septimal minor chord wherever Semiditonal has a
     Pythagorean minor one, the septimal dominant seventh for every dominant,
     the septimal diminished chords, and Pythagorean major triads on the
     septimal third and sixth.
   - A chord is the flavor's form on its root whether or not its notes are the
     scale's: only the Pythagorean scales hold all their own chords, and what
     the others' chords add is what the footprint is for.
   - The diminished ii of a minor key and its half-diminished seventh are
     taken from the key's vii°7 (above), whatever the flavor: Pythagorean's
     come out as its catalog chords; Ptolemaic's and Semiditonal's triad
     (135:160:192) and Septimal's two (162:189:224, and with 288) are in no
     catalog.
   - The augmented triad of the harmonic and melodic minors takes the form of
     the major triad on the same root: 5-limit in Ptolemaic, Pythagorean in
     the others.
   - In major, borrowed are iv, ♭VI and ♭VII of the minor, the diminished
     seventh on vii and, where the flavor has 5-limit chords, the augmented
     sixths on 8/5. In minor: the major tonic, the Neapolitan a pure fifth
     below ♭VI, and the augmented sixths. */
const SPECS: ReadonlyArray<ProfileSpec> = [
  { id: 'ptolemaic-major', scales: PTOLEMAIC_MAJOR, dominant: [M, D7],
    degrees: [['I', [1, 1], M, M7], ['ii', [9, 8], m, m7], ['iii', [5, 4], m, m7], ['IV', [4, 3], M, M7], ['V', [3, 2], M, D7], ['vi', [5, 3], m, m7], ['vii°', [15, 8], d, h7]],
    borrowed: [['iv', [4, 3], m], ['♭VI', [8, 5], M], ['♭VII', [9, 5], M], ['vii°7', [15, 8], d7], ...SIXTHS] },
  { id: 'semiditonal-major', scales: PTOLEMAIC_MAJOR, dominant: [M, D7],
    degrees: [['I', [1, 1], M, M7], ['ii', [9, 8], Pm, Pm7], ['iii', [5, 4], m, m7], ['IV', [4, 3], M, M7], ['V', [3, 2], M, D7], ['vi', [5, 3], m, m7], ['vii°', [15, 8], d, h7]],
    borrowed: [['iv', [4, 3], Pm], ['♭VI', [8, 5], M], ['♭VII', [16, 9], PM], ['vii°7', [15, 8], d7], ...SIXTHS] },
  { id: 'pythagorean-major', scales: ['Pythagorean major scale'], dominant: [PM, PD7],
    degrees: [['I', [1, 1], PM, PM7], ['ii', [9, 8], Pm, Pm7], ['iii', [81, 64], Pm, Pm7], ['IV', [4, 3], PM, PM7], ['V', [3, 2], PM, PD7], ['vi', [27, 16], Pm, Pm7], ['vii°', [243, 128], Pd, Ph7]],
    borrowed: [['iv', [4, 3], Pm], ['♭VI', [128, 81], PM], ['♭VII', [16, 9], PM], ['vii°7', [243, 128], Pd7]] },
  { id: 'septimal-major', scales: PTOLEMAIC_MAJOR, dominant: [M, sD7],
    degrees: [['I', [1, 1], M, M7], ['ii', [9, 8], sm, sm7], ['iii', [5, 4], m, m7], ['IV', [4, 3], M, M7], ['V', [3, 2], M, sD7], ['vi', [5, 3], m, m7], ['vii°', [15, 8], sd, sh7]],
    borrowed: [['iv', [4, 3], sm], ['♭VI', [14, 9], PM], ['♭VII', [16, 9], M], ['vii°7', [15, 8], sd7], ...SIXTHS] },
  { id: 'ptolemaic-minor', scales: ['Ptolemaic natural minor scale', 'Ptolemaic harmonic minor scale', 'Ptolemaic melodic minor scale'], dominant: [M, D7],
    degrees: [['i', [1, 1], m, m7], ['ii°', [9, 8], II_DIM, II_HALF], ['ii', [9, 8], m, m7], ['♭III', [6, 5], M, M7], ['♭III+', [6, 5], A], ['iv', [4, 3], m, m7], ['IV', [4, 3], M, D7], ['V', [3, 2], M, D7], ['v', [3, 2], m, m7],
      ['♭VI', [8, 5], M, M7], ['vi°', [5, 3], d, h7], ['♭VII', [9, 5], M, D7], ['vii°', [15, 8], d, d7, h7]],
    borrowed: [['I', [1, 1], M], ['♭II', [16, 15], M], ...SIXTHS] },
  { id: 'semiditonal-minor', scales: ['Pythagorean natural minor scale', 'Semiditonal harmonic minor scale', 'Semiditonal melodic minor scale'], dominant: [M, D7],
    degrees: [['i', [1, 1], Pm, Pm7], ['ii°', [9, 8], II_DIM, II_HALF], ['ii', [9, 8], Pm, Pm7], ['♭III', [32, 27], PM, PM7], ['♭III+', [32, 27], PA], ['iv', [4, 3], Pm, Pm7], ['IV', [4, 3], M, D7], ['V', [3, 2], M, D7], ['v', [3, 2], Pm, Pm7],
      ['♭VI', [128, 81], PM, PM7], ['vi°', [5, 3], d, h7], ['♭VII', [16, 9], PM, PD7], ['vii°', [15, 8], d, d7, h7]],
    borrowed: [['I', [1, 1], M], ['♭II', [256, 243], PM], ...SIXTHS] },
  { id: 'pythagorean-minor', scales: ['Pythagorean natural minor scale', 'Pythagorean harmonic minor scale', 'Pythagorean melodic minor scale'], dominant: [PM, PD7],
    degrees: [['i', [1, 1], Pm, Pm7], ['ii°', [9, 8], II_DIM, II_HALF], ['ii', [9, 8], Pm, Pm7], ['♭III', [32, 27], PM, PM7], ['♭III+', [32, 27], PA], ['iv', [4, 3], Pm, Pm7], ['IV', [4, 3], PM, PD7], ['V', [3, 2], PM, PD7], ['v', [3, 2], Pm, Pm7],
      ['♭VI', [128, 81], PM, PM7], ['vi°', [27, 16], Pd, Ph7], ['♭VII', [16, 9], PM, PD7], ['vii°', [243, 128], Pd, Pd7, Ph7]],
    borrowed: [['I', [1, 1], PM], ['♭II', [256, 243], PM]] },
  { id: 'septimal-minor', scales: ['septimal natural minor scale', 'septimal harmonic minor scale', 'septimal melodic minor scale'], dominant: [M, sD7],
    degrees: [['i', [1, 1], sm, sm7], ['ii°', [9, 8], II_DIM, II_HALF], ['ii', [9, 8], sm, sm7], ['♭III', [7, 6], PM, PM7], ['♭III+', [7, 6], PA], ['iv', [4, 3], sm, sm7], ['IV', [4, 3], M, sD7], ['V', [3, 2], M, sD7], ['v', [3, 2], sm, sm7],
      ['♭VI', [14, 9], PM, PM7], ['vi°', [5, 3], sd, sh7], ['♭VII', [16, 9], M, sD7], ['vii°', [15, 8], sd, sd7, sh7]],
    borrowed: [['I', [1, 1], M], ['♭II', [28, 27], PM], ...SIXTHS] },
];

export const PROFILES: ReadonlyArray<KeyProfile> = KEY_PROFILE_IDS.map((id) => build(SPECS.find((x) => x.id === id)!));
export const profileOf = (id: string | null): KeyProfile | null => PROFILES.find((p) => p.id === id) ?? null;

/* ── a profile on a keyboard ── */

/** A key on the keyboard around `ref`, the tonic's unaltered key: each of its
 *  scales as a run from the reference key, as the guide draws a scale (null:
 *  the scale is no shape from there); and the one key each of its pitches is
 *  played on (`keyOf`: a pitch from the tonic up to its octave; null where the
 *  keyboard has no key for it there). */
export interface KeyPlace { runs: Array<Shape | null>; keyOf: (e: Exps) => Cell | null }

/** Whether a tuning lists a key at all, whatever it could play of it (Max,
 *  2026-11-19): Pythagorean tuning lists the Pythagorean keys only, and a
 *  Septimal key is listed in Septimal tuning only. */
export function listsKey(p: KeyProfile, mode: ShapeLayout['mode']): boolean {
  const flavor = p.id.split('-')[0];
  return (mode !== 'P' || flavor === 'pythagorean') && (flavor !== 'septimal' || mode === '7');
}

/** A key's place on a keyboard, or null when the layout does not offer the
 *  key (Max, 2026-11-19): a key is offered when the tuning lists it
 *  (`listsKey`) and its scale plays as a run from the reference key; for a
 *  minor key, one of its three. No other octave is
 *  looked in: how many octaves a layout holds a key in is another count, and
 *  not this page's.
 *
 *  A note of a scale is on the key its run plays it on (of two runs, the
 *  first's). Any other pitch the chords need is on its key nearest the
 *  reference key, among the keys that sound it in the octave above that key
 *  (of equally near keys, the first found). `tonic` is the tonic's name. */
export function keyPlace(p: KeyProfile, layout: ShapeLayout, ref: Cell, tonic = 'C'): KeyPlace | null {
  if (!listsKey(p, layout.mode)) return null;
  const runs = p.scales.map((s) => solve(s.members, layout, tonic, ref, ref));
  if (!runs.some((r) => r !== null)) return null;
  const exps = (c: Cell): Exps => coordExps(c[0], c[1], layout.mode, layout.mapping, layout.anchor, layout.banded);
  const home = exps(ref);
  const onRun = new Map<string, Cell>(), byPitch = new Map<string, Cell[]>();
  runs.forEach((run, i) => run && p.scales[i]!.members.forEach((m, j) => { if (!onRun.has(expsKey(m))) onRun.set(expsKey(m), run.cells[j]!); }));
  for (const [u, v] of baseKeys) {
    const key: Cell = [ref[0] + u, ref[1] + v], k = expsKey(subExps(exps(key), home));
    const at = byPitch.get(k);
    if (at) at.push(key); else byPitch.set(k, [key]);
  }
  const nearest = (cells: ReadonlyArray<Cell> | undefined): Cell | null => (cells ?? []).reduce<Cell | null>((best, c) => (!best || keyDistance(ref, c) < keyDistance(ref, best) - 1e-9 ? c : best), null);
  return { runs, keyOf: (e) => onRun.get(expsKey(e)) ?? nearest(byPitch.get(expsKey(e))) };
}

/** A chord of a profile on a keyboard (Max, 2026-11-19): in root position
 *  and closed, starting on its root's key (`KeyPlace.keyOf`: for a chord on a
 *  scale note, the literal key the scale's run plays that note on); null when
 *  the keyboard does not hold the chord from there. Inversions are the Layouts
 *  tab's to show. */
export function chordShape(c: ProfileChord, layout: ShapeLayout, ref: Cell, place: KeyPlace, tonic = 'C'): Shape | null {
  const start = place.keyOf(c.root);
  return start ? solve(c.members, layout, tonic, ref, start) : null;
}

/** A chord's name on a page: the catalog's, or for a chord the catalog lacks
 *  what HKL calls the keys it is drawn on (tuning/chords.ts), which is how
 *  the lattice names it when it is played (Max, 2026-11-19); '' where HKL
 *  names nothing. */
export function chordName(c: ProfileChord, shape: Shape, layout: ShapeLayout): string {
  if (c.chord !== null) return c.chord;
  const named = analyzeChord(shape.cells.map(([q, r]) => ({ q, r, name: '', col: '' })), { ...layout, equalEnabled: false, septimalEnabled: layout.mode === '7', septimalW: 1 });
  return named ? named.quality + (named.invName ? ' ' + named.invName : '') : '';
}

/* ── a footprint on a keyboard ── */

/** A step of a footprint: 0 is the scale alone, a tier is the scale with the
 *  pitches of the chords up to that tier. */
export type Step = 0 | Tier;

export interface FootprintStep {
  /** The steps this picture stands for: consecutive ones that draw the same keys are one. */
  steps: Step[];
  shape: Shape;
  /** The pitches the last of its steps needs, and how many of them the keyboard has a key for (`KeyPlace.keyOf`). */
  pitches: number;
  drawn: number;
}

/** A footprint as scale diagrams, from the reference key: the scale, then the
 *  scale with each tier's pitches added, each pitch on its key
 *  (`KeyPlace.keyOf`). A pitch with no key in the octave above the reference
 *  key is not drawn, wherever else the keyboard has it. No path keys: a
 *  picture shows where the notes are, not a way through them. */
export function footprintSteps(profile: KeyProfile, layout: ShapeLayout, ref: Cell, place: KeyPlace): FootprintStep[] {
  const top = place.keyOf(OCTAVE);
  const position = posInBandOf(ref[0], ref[1], layout.mapping);
  const out: FootprintStep[] = [];
  let before = '';
  for (const step of [0, ...TIERS] as Step[]) {
    const wanted = profile.footprint.filter((p) => p.inScale || p.tier <= step);
    const cells = wanted.map((p) => place.keyOf(p.exps)).filter((c): c is Cell => c !== null);
    const drawn = cells.length, same = cells.map((c) => c.join(',')).sort().join(' ');
    const last = out[out.length - 1];
    if (last && same === before) { last.steps.push(step); last.pitches = wanted.length; continue; }
    before = same;
    if (top) cells.push(top);
    out.push({ steps: [step], shape: { positions: [position], position, bass: ref, cells, path: [], seams: seamsAcross(cells, layout), undecided: [] }, pitches: wanted.length, drawn });
  }
  return out;
}
