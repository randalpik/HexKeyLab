// Key profiles: what it takes to play in a key, for evaluating layouts and for
// the Scales page (./scalePage.ts).
//
// A scale is not the whole of a key. A profile holds the harmony played in it:
// a triad and a seventh chord on every note of its scale, the secondary
// dominants, the borrowed chords. From those follows the key's footprint:
// every pitch the chords need, as exact ratios from the tonic. The footprint
// is larger than the scale, and that is the point (Max, 2026-11-19): in
// 5-limit major the A of ii is not the A of IV, and a septimal dominant on V
// needs an F that is no scale degree, so the notes a key requires are only
// found by building its chords.
//
// The chords are not declared key by key: they are generated from the key's
// scales by a few rules (Max, 2026-11-20; `voice`, below). A chord takes the
// scale's own notes, except:
//   1. Every perfect fifth inside a chord is 3:2: root to fifth, and third to
//      seventh in a major, minor or half-diminished seventh. This is the
//      immutable rule, and the main way a key gets notes beyond its scale.
//   2. A major triad, and a seventh chord built on one, has a 5:4 third. On a
//      septimal root or in a Pythagorean key that is 81:64, and nothing else
//      is acceptable (not 9:7). Where a 5:4 third displaces the tonic by a
//      comma, it still stands. An augmented triad is exempt: the scale's notes.
//   3. A dominant seventh's seventh is 7:4 in a Septimal key, 16:9 elsewhere.
//   4. In a Ptolemaic key a minor third is 6:5 above its lower note wherever
//      that stays within one syntonic comma of the Pythagorean spelling: the
//      third of a minor or diminished chord, and a half-diminished seventh's
//      fifth above its third.
//   5. A half-diminished seventh's fifth is the key's minor third above its
//      third (rule 4 in Ptolemaic, the scale's note elsewhere), so it may
//      differ from the diminished triad's on the same root.
//   6. In a Septimal key a diminished fifth is 7:6 above the chord's third.
// A diminished seventh adds the scale's own note to its triad.
//
// What is declared is which chords a key has (`MAJOR`, `MINOR`: a numeral, a
// scale degree and a kind of chord) and the scales of each flavor. A minor
// key stands on its natural, harmonic and melodic scales together (Max,
// 2026-11-19): nine roots, and every triad and seventh chord any of the three
// has on a note, but for the minor-major and augmented-major sevenths. The
// build checks that each chord really is thirds stacked in one of the key's
// scales.
//
// Chords come in tiers, most essential first, so a result can be read tier by
// tier without weighing one chord against another:
//   1  the diatonic triads
//   2  the diatonic sevenths
//   3  the secondary dominants: a major triad and a dominant seventh a pure
//      fifth above every root but the tonic that holds a diatonic major or
//      minor triad, by rules 1 to 3. Whether a layout can play one is a
//      result, not a reason to move it
//   4  the borrowed chords. A major key borrows iv, ♭VI, ♭VII and vii°7 from
//      its parallel minor: that key's chords, on that key's notes. A minor key
//      borrows the major tonic and the Neapolitan, a major triad whose third
//      is scale degree 4. Both borrow the three augmented sixth chords, the
//      catalog's, on 8/5, wherever ♭VI itself sits; a Pythagorean key has none
//      (their 225:128 needs two factors of 5).
// A chord the catalog (./catalog.ts) has is named for it; one it lacks is
// called what HKL calls its keys (`chordName`). A footprint is of pitch
// classes, so inversions add nothing to it.
//
// Pure: no DOM and no state, so Node tools (test/shapes/) import it.

import { coordExps } from '@hkl/shared/freq.js';
import { KEY_PROFILE_IDS, KEY_PROFILE_LABELS, type KeyProfileId } from '@hkl/shared/keyProfiles.js';
import { posInBandOf } from '@hkl/shared/mapping.js';
import { fifthIndex, fifthName } from '@hkl/shared/notes.js';
import { baseKeys } from '../layout/baseKeys.js';
import { analyzeChord } from '../tuning/chords.js';
import { OCTAVE, STRUCTURES, UNISON, addExps, centsOf, expsKey, expsOf, pitchClass, subExps, type Exps } from './catalog.js';
import { reach, span, tightestFrom, voicings, type Reach, type Voicing } from './reach.js';
import { keyDistance, seamsAcross, solve, type Cell, type Shape, type ShapeLayout } from './solve.js';

export { pitchClass };
export type Tier = 1 | 2 | 3 | 4;
export const TIERS: ReadonlyArray<Tier> = [1, 2, 3, 4];
export const TIER_NAMES: Readonly<Record<Tier, string>> = { 1: 'diatonic triads', 2: 'diatonic sevenths', 3: 'secondary dominants', 4: 'borrowed chords' };

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

/* ── the rules ── */

type Flavor = 'ptolemaic' | 'semiditonal' | 'pythagorean' | 'septimal';
type Triad = 'M' | 'm' | 'd' | 'A';
type Seventh = 'M7' | '7' | 'm7' | 'ø7' | '°7';
type Kind = Triad | Seventh;

/** A kind of chord as semitones above its root. */
const PATTERN: Readonly<Record<Kind, ReadonlyArray<number>>> = {
  M: [4, 7], m: [3, 7], d: [3, 6], A: [4, 8], M7: [4, 7, 11], 7: [4, 7, 10], m7: [3, 7, 10], 'ø7': [3, 6, 10], '°7': [3, 6, 9],
};
const R = expsOf;
const FIFTH = R(3, 2), MAJOR_THIRD = R(5, 4), PYTHAGOREAN_THIRD = R(81, 64), MINOR_THIRD = R(6, 5), SEPTIMAL_THIRD = R(7, 6);
const HARMONIC_SEVENTH = R(7, 4), MINOR_SEVENTH = R(16, 9);
/* a pitch class's place in the octave, in semitones from the tonic: what a scale degree is found by.
   Rounding is safe for what is looked up here, roots and thirds, which lie within 49 cents of their
   semitone; a note with two septimal factors (62 cents off) is only ever a chord's result */
const semitone = (e: Exps): number => ((Math.round(centsOf(pitchClass(e)) / 100) % 12) + 12) % 12;
const above = (e: Exps, by: Exps): Exps => pitchClass(addExps(e, by));

/** The notes of a chord of `kind` on `root`, as pitch classes from the tonic
 *  in chord order, by the rules at the top of this file. `scale` is the scale
 *  the chord takes its default notes from. */
function voice(flavor: Flavor, scale: ReadonlyArray<Exps>, root: Exps, kind: Kind): Exps[] {
  const at = (lower: Exps, semitones: number): Exps => {
    const want = (semitone(lower) + semitones) % 12, e = scale.find((x) => semitone(x) === want);
    if (!e) throw new Error(`profile: the scale has no note ${semitones} semitones above the one at ${centsOf(lower).toFixed(1)} cents`);
    return e;
  };
  /* rule 4: Ptolemaic's 6:5 while it stays within one comma; otherwise the scale's note */
  const minorThird = (lower: Exps): Exps => {
    const pure = above(lower, MINOR_THIRD);
    return flavor === 'ptolemaic' && Math.abs(pure[2]) <= 1 && pure[3] === 0 ? pure : at(lower, 3);
  };
  if (kind === 'A') return [root, at(root, 4), at(root, 8)];
  const [third, fifth, seventh] = PATTERN[kind];
  if (third === 4) {
    /* rules 2 and 3: a major triad and the sevenths built on it */
    const t = above(root, flavor === 'pythagorean' || root[3] !== 0 ? PYTHAGOREAN_THIRD : MAJOR_THIRD);
    const tones = [root, t, above(root, FIFTH)];
    if (seventh === 11) tones.push(above(t, FIFTH));
    if (seventh === 10) tones.push(above(root, flavor === 'septimal' ? HARMONIC_SEVENTH : MINOR_SEVENTH));
    return tones;
  }
  const t = minorThird(root);
  if (fifth === 7) return seventh === undefined ? [root, t, above(root, FIFTH)] : [root, t, above(root, FIFTH), above(t, FIFTH)];
  /* a diminished fifth: rule 6 in Septimal; a half-diminished seventh's by rule 5; otherwise the scale's */
  const f = flavor === 'septimal' ? above(t, SEPTIMAL_THIRD) : seventh === 10 ? minorThird(t) : at(root, 6);
  if (seventh === undefined) return [root, t, f];
  return [root, t, f, seventh === 10 ? above(t, FIFTH) : at(root, 9)];
}

/* ── the keys ── */

/** The catalog scales of each flavor: one for its major key, the natural,
 *  harmonic and melodic for its minor. Ptolemaic, Semiditonal and Septimal
 *  major share a scale and differ in their rules. */
const SCALES: Readonly<Record<Flavor, { major: ReadonlyArray<string>; minor: ReadonlyArray<string> }>> = {
  ptolemaic: { major: ['Ptolemaic major scale'], minor: ['Ptolemaic natural minor scale', 'Ptolemaic harmonic minor scale', 'Ptolemaic melodic minor scale'] },
  semiditonal: { major: ['Ptolemaic major scale'], minor: ['Pythagorean natural minor scale', 'Semiditonal harmonic minor scale', 'Semiditonal melodic minor scale'] },
  pythagorean: { major: ['Pythagorean major scale'], minor: ['Pythagorean natural minor scale', 'Pythagorean harmonic minor scale', 'Pythagorean melodic minor scale'] },
  septimal: { major: ['Ptolemaic major scale'], minor: ['septimal natural minor scale', 'septimal harmonic minor scale', 'septimal melodic minor scale'] },
};

/** A key's diatonic chords: a triad's numeral, its root as semitones above the
 *  tonic, its kind, and the kinds of seventh chord built on it. Where a root
 *  has two triads the commoner comes first: it names the root's secondary
 *  dominant ("V/iv", "V/V"). */
type Slot = readonly [numeral: string, degree: number, triad: Triad, ...sevenths: Seventh[]];
const MAJOR: ReadonlyArray<Slot> = [
  ['I', 0, 'M', 'M7'], ['ii', 2, 'm', 'm7'], ['iii', 4, 'm', 'm7'], ['IV', 5, 'M', 'M7'], ['V', 7, 'M', '7'], ['vi', 9, 'm', 'm7'], ['vii°', 11, 'd', 'ø7'],
];
const MINOR: ReadonlyArray<Slot> = [
  ['i', 0, 'm', 'm7'], ['ii°', 2, 'd', 'ø7'], ['ii', 2, 'm', 'm7'], ['♭III', 3, 'M', 'M7'], ['♭III+', 3, 'A'], ['iv', 5, 'm', 'm7'], ['IV', 5, 'M', '7'],
  ['V', 7, 'M', '7'], ['v', 7, 'm', 'm7'], ['♭VI', 8, 'M', 'M7'], ['vi°', 9, 'd', 'ø7'], ['♭VII', 10, 'M', '7'], ['vii°', 11, 'd', '°7', 'ø7'],
];
/** What a major key borrows from its parallel minor: a label, a degree of that key, a kind. */
const FROM_MINOR: ReadonlyArray<readonly [string, number, Kind]> = [['iv', 5, 'm'], ['♭VI', 8, 'M'], ['♭VII', 10, 'M'], ['vii°7', 11, '°7']];
const SIXTHS: ReadonlyArray<readonly [string, string]> = [
  ['It+6', 'Italian augmented sixth chord'], ['Fr+6', 'French augmented sixth chord'], ['Ger+6', 'German augmented sixth chord'],
];

const structureOf = (name: string): ReadonlyArray<Exps> => {
  const s = STRUCTURES.find((x) => x.name === name);
  if (!s) throw new Error(`profile: no catalog structure named "${name}"`);
  return s.members;
};
/* the catalog's name for a chord in root position, by its notes from its root */
const catalogName = (members: ReadonlyArray<Exps>): string | null =>
  STRUCTURES.find((x) => x.kind === 'chord' && x.inversion === 0 && x.members.length === members.length && x.members.every((m, i) => expsKey(m) === expsKey(members[i]!)))?.name ?? null;
/* a set of scales as one: their notes together, ascending from the tonic */
const notesOf = (names: ReadonlyArray<string>): Exps[] =>
  [...new Map(names.flatMap((n) => structureOf(n).slice(0, 7)).map((e) => [expsKey(e), e])).values()].sort((a, b) => centsOf(a) - centsOf(b));
/* a seventh chord's label, from its triad's numeral and its kind */
const seventhLabel = (numeral: string, kind: Seventh): string => numeral.replace('°', '') + (kind === 'm7' ? '7' : kind);

function build(id: KeyProfileId): KeyProfile {
  const [flavor, mode] = id.split('-') as [Flavor, 'major' | 'minor'];
  const names = SCALES[flavor][mode], scale = notesOf(names), minor = notesOf(SCALES[flavor].minor);
  const inScale = new Set(scale.map(expsKey));
  const chords: ProfileChord[] = [];
  const add = (tier: Tier, label: string, root: Exps, tones: ReadonlyArray<Exps>): void => {
    const members = tones.map((t) => pitchClass(subExps(t, root)));
    if (members.some((m, i) => (i === 0 ? centsOf(m) !== 0 : centsOf(m) <= centsOf(members[i - 1]!)))) throw new Error(`profile ${id}: ${label} is not in root position, closed`);
    chords.push({ tier, label, chord: catalogName(members), members, root: pitchClass(root), tones: tones.map(pitchClass) });
  };
  const degree = (notes: ReadonlyArray<Exps>, semitones: number, what: string): Exps => {
    const e = notes.find((x) => semitone(x) === semitones);
    if (!e) throw new Error(`profile ${id}: no scale note for ${what}`);
    return e;
  };
  /* a chord is thirds stacked in one of the key's scales: root, and every second note above it */
  const stacked = (semitones: number, kind: Kind): boolean => names.some((n) => {
    const s = structureOf(n).slice(0, 7), i = s.findIndex((e) => semitone(e) === semitones);
    return i >= 0 && PATTERN[kind].every((step, k) => (semitone(s[(i + 2 * (k + 1)) % 7]!) - semitones + 12) % 12 === step);
  });
  const slots = mode === 'major' ? MAJOR : MINOR;
  for (const [numeral, semitones, triad, ...sevenths] of slots) for (const kind of [triad, ...sevenths]) {
    if (!stacked(semitones, kind)) throw new Error(`profile ${id}: ${numeral} ${kind} is not thirds stacked in one of its scales`);
  }
  for (const e of scale) for (const want of ['triad', 'seventh'] as const) {
    if (!slots.some((g) => g[1] === semitone(e) && (want === 'triad' || g.length > 3))) throw new Error(`profile ${id}: a scale note has no ${want}`);
  }
  for (const [numeral, semitones, triad] of slots) { const root = degree(scale, semitones, numeral); add(1, numeral, root, voice(flavor, scale, root, triad)); }
  for (const [numeral, semitones, , ...sevenths] of slots) for (const kind of sevenths) {
    const root = degree(scale, semitones, numeral);
    add(2, seventhLabel(numeral, kind), root, voice(flavor, scale, root, kind));
  }
  /* the secondary dominants: a pure fifth above every root but the tonic that holds a major or minor triad */
  const led = new Set([0]);
  for (const [numeral, semitones, triad] of slots) {
    if (led.has(semitones) || (triad !== 'M' && triad !== 'm')) continue;
    led.add(semitones);
    const root = above(degree(scale, semitones, numeral), FIFTH);
    add(3, 'V/' + numeral, root, voice(flavor, scale, root, 'M'));
    add(3, 'V7/' + numeral, root, voice(flavor, scale, root, '7'));
  }
  /* the borrowed chords */
  if (mode === 'major') {
    for (const [label, semitones, kind] of FROM_MINOR) { const root = degree(minor, semitones, label); add(4, label, root, voice(flavor, minor, root, kind)); }
  } else {
    add(4, 'I', UNISON, voice(flavor, scale, UNISON, 'M'));
    /* the Neapolitan: a major triad whose third is scale degree 4 */
    const fourth = degree(scale, 5, '♭II'), root = pitchClass(subExps(fourth, flavor === 'pythagorean' ? PYTHAGOREAN_THIRD : MAJOR_THIRD));
    add(4, '♭II', root, [root, fourth, above(root, FIFTH)]);
  }
  if (flavor !== 'pythagorean') for (const [label, name] of SIXTHS) { const root = R(8, 5); add(4, label, root, structureOf(name).map((m) => above(root, m))); }
  const labels = chords.map((c) => c.label);
  if (new Set(labels).size !== labels.length) throw new Error(`profile ${id}: two chords share a label`);

  const pitches = new Map<string, FootprintPitch>();
  for (const c of chords) for (const t of c.tones) {
    const at = pitches.get(expsKey(t));
    if (at) { if (!at.chords.includes(c.label)) at.chords.push(c.label); } else pitches.set(expsKey(t), { exps: t, tier: c.tier, inScale: inScale.has(expsKey(t)), chords: [c.label] });
  }
  return { id, name: KEY_PROFILE_LABELS[id], scales: names.map((name) => ({ name, members: structureOf(name) })), scale, chords, footprint: [...pitches.values()].sort((a, b) => centsOf(a.exps) - centsOf(b.exps)) };
}

export const PROFILES: ReadonlyArray<KeyProfile> = KEY_PROFILE_IDS.map(build);
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
 *  the keyboard does not hold the chord from there. Where a pitch has several
 *  keys, the chord is on those with the smallest diameter (./reach.ts), which
 *  is the correct arrangement; where the keys the guide would choose (the
 *  nearest the bass: ./solve.ts) are as small, it stays on those. Inversions
 *  are the Layouts tab's to show. */
export function chordShape(c: ProfileChord, layout: ShapeLayout, ref: Cell, place: KeyPlace, tonic = 'C'): Shape | null {
  const start = place.keyOf(c.root), nearest = start && solve(c.members, layout, tonic, ref, start);
  if (!start || !nearest) return null;
  const keys = tightestFrom(start, c.members, layout, ref)!;
  return span(keys) < span(nearest.cells) - 1e-9 ? solve(c.members, layout, tonic, ref, start, keys) : nearest;
}

/** A chord of a profile in every voicing, each as far as the hands must reach
 *  for it (./reach.ts): free on the keyboard, on its own bass note in any
 *  octave. Not the Scales page's chord, which `chordShape` is. `reach` is
 *  null for a voicing the keyboard holds nowhere. */
export function chordReach(c: ProfileChord, layout: ShapeLayout, ref: Cell): Array<Voicing & { reach: Reach | null }> {
  return voicings(c.members).map((v) => ({ ...v, reach: reach(v.members, addExps(c.root, c.members[v.inversion]!), layout, ref) }));
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
