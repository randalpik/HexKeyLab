// The shape guide's entries for a layout: the catalog's structures, then the
// catalog's intervals (every interval between two members of a structure),
// each with its shape on the lattice (./solve.ts) and the text an entry shows.
// A structure or an interval the layout cannot hold is simply not in its
// guide, so the catalog can list shapes that only some layouts have.
//
// A guide has a root, its starting note: C or another of the fifteen major-key
// tonics. The reference is put on the root's own key, where Composer puts a
// key's reference (findTonicCoord: on the spine column, at the octave nearest
// C4), and the anchor on that key's band; the Lumatone's 280 keys around it
// are what a shape may use. A shape starts on any key that holds it, and on
// the root wherever the root holds it as close as any note does (./solve.ts).
// A step along the pure line, or a band over with the anchor following, keeps
// every interval a key has to its reference, so a root's guide is C's with
// other names on the keys, and other colors, which go with pitch
// (test/shapes/roots.mjs).
//
// Names come from HKL's interval namer (tuning/intervals.ts), read off the
// solved keys. An interval is named once, from the bass, and a structure's step
// and inner intervals quote that name, so a ratio reads the same everywhere in
// the guide.
//
// Pure: no DOM and no live state, so the Node oracle (test/shapes/) imports it.

import { anchorOf } from '@hkl/shared/freq.js';
import { bandWidth } from '@hkl/shared/mapping.js';
import { findTonicCoord } from '@hkl/shared/tonic.js';
import { classifyDiatonic, intervalNameFromCoords, shortenInterval } from '../tuning/intervals.js';
import type { TuningStateLike } from '../tuning/regions.js';
import {
  OCTAVE, POSITION, STRUCTURES, UNISON, centsOf, combinedRatio, expsKey, intervalSet, intervalsWithin, ratioOf, subExps,
  type Exps, type Family, type Structure,
} from './catalog.js';
import { positionLabel, solve, type Cell, type Shape, type ShapeLayout } from './solve.js';

export interface GuideEntry {
  /** Its number in the guide (Max, 2026-11-19). A chord and its inversions
   *  share one number, with a count after a point from the second on: "7",
   *  "7.1", "7.2". The count is of what the layout holds, so where it holds
   *  only a chord's first and third inversions they are "7" and "7.1". A
   *  scale and an interval have a number each. Numbers run from 1. */
  number: string;
  /** What that number is listed as in the contents: the chord, the scale or
   *  the interval. A chord's inversions share it. */
  listed: string;
  kind: 'chord' | 'scale' | 'interval';
  /** The section it is listed in. */
  family: Family | 'interval';
  /** Spelled out in full: "minor triad in first inversion". */
  name: string;
  /** The entry's heading, "minor triad", and what goes under it: a chord's
   *  position, "in root position" or "in first inversion"; otherwise empty. */
  title: string;
  subtitle: string;
  /** The members' proportions, low to high ("4:5:6"); an interval's as HKL
   *  prints one, upper to lower ("5:4"). */
  ratio: string;
  /** An interval's size as the info panel prints it, "386.3¢"; empty for a
   *  chord or a scale. */
  cents: string;
  /** The members from the bass; an interval's are the unison and itself. */
  members: ReadonlyArray<Exps>;
  /** The intervals from each member to the next, in short form. An interval's
   *  one step is itself. */
  steps: string[];
  /** Every other interval that occurs between two of the members, each once,
   *  in short form, by number and then size. A scale's leaves out the octave. */
  others: string[];
  /** Where the bass can start: "left or center", "any". */
  start: string;
  /** The keys. */
  shape: Shape;
}

interface Named {
  exps: Exps;
  name: string;
  short: string;
  /** The interval's number as spelled: 3 for a third, 8 for an octave. */
  number: number;
  shape: Shape | null;
}

const fraction = (e: Exps): string => ratioOf(e).join(':');

/** `shortenInterval` writes for innerHTML; the guide wants the text. */
const shortText = (name: string): string =>
  shortenInterval(name, true).replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Every interval of the catalog under `layout`, by number and then size. One
 *  the layout cannot hold keeps its ratio as its name and sorts by size alone. */
/** What a guide is asked for: a mapping, a tuning, banded or not. The anchor
 *  is not the asker's to give: it follows the root (`rootedLayout`). */
export type GuideLayout = Pick<ShapeLayout, 'mode' | 'mapping' | 'banded'>;

/** The layout a root's guide is solved and drawn in, and its reference: the
 *  root's tonic key, with the anchor on that key's band. */
export function rootedLayout(at: GuideLayout, root = 'C'): { layout: ShapeLayout; ref: Cell } {
  const t = findTonicCoord(root, at.mapping);
  return { layout: { mode: at.mode, mapping: at.mapping, banded: at.banded, anchor: anchorOf(t.q, t.r, at.mapping) }, ref: [t.q, t.r] };
}

function nameIntervals(layout: ShapeLayout, root: string, ref: Cell): Named[] {
  const state: TuningStateLike = { ...layout, equalEnabled: false, septimalEnabled: layout.mode === '7', septimalW: 1 };
  const named = intervalSet().map((exps): Named => {
    const shape = solve([UNISON, exps], layout, root, ref);
    if (!shape) return { exps, name: fraction(exps), short: fraction(exps), number: 0, shape };
    const [[q1, r1], [q2, r2]] = shape.cells;
    const cls = classifyDiatonic(q1, r1, q2, r2, state);
    const name = intervalNameFromCoords(q1, r1, q2, r2, state);
    return { exps, name, short: shortText(name), number: cls.ord + 7 * cls.extraOct, shape };
  });
  return named.sort((a, b) => a.number - b.number || centsOf(a.exps) - centsOf(b.exps));
}

/** The guide for a layout and a root, in order: the catalog's chords and
 *  scales, then the intervals; only those the layout holds. */
export function buildGuide(at: GuideLayout, root = 'C'): GuideEntry[] {
  const { layout, ref } = rootedLayout(at, root);
  const width = bandWidth(layout.mapping);
  const intervals = nameIntervals(layout, root, ref);
  const order = new Map(intervals.map((n, i) => [expsKey(n.exps), i]));
  const short = (e: Exps): string => intervals[order.get(expsKey(e))!].short;

  const structure = (s: Structure): GuideEntry | null => {
    const steps = s.members.slice(1).map((m, i) => subExps(m, s.members[i]));
    const stepKeys = new Set(steps.map(expsKey));
    const others = intervalsWithin(s)
      .filter((e) => !stepKeys.has(expsKey(e)) && expsKey(e) !== expsKey(OCTAVE))
      .sort((a, b) => order.get(expsKey(a))! - order.get(expsKey(b))!);
    const shape = solve(s.members, layout, root, ref);
    if (!shape) return null;
    return {
      number: '', listed: s.chord,
      kind: s.kind, family: s.family, name: s.name, title: s.title, subtitle: s.kind === 'chord' ? POSITION[s.inversion] : '',
      ratio: combinedRatio(s.members), cents: '', members: s.members,
      steps: steps.map(short), others: others.map(short), start: positionLabel(shape.positions, width), shape,
    };
  };
  const interval = (n: Named, shape: Shape): GuideEntry => ({
    number: '', listed: n.name,
    kind: 'interval', family: 'interval', name: n.name, title: n.name, subtitle: '', ratio: fraction(n.exps),
    cents: centsOf(n.exps).toFixed(1) + '¢', members: [UNISON, n.exps],
    steps: [n.short], others: [], start: positionLabel(shape.positions, width), shape,
  });
  const held = <T>(x: T | null): x is T => x !== null;
  const guide = [...STRUCTURES.map(structure), ...intervals.map((n) => (n.shape ? interval(n, n.shape) : null))].filter(held);
  /* the numbers: a new one wherever the entry is not another position of the chord before it,
     and otherwise that chord's number and how many of its positions came before */
  let count = 0, positions = 0;
  guide.forEach((g, i) => {
    const before = guide[i - 1];
    if (before && g.kind === 'chord' && before.kind === 'chord' && before.listed === g.listed) g.number = count + '.' + ++positions;
    else { g.number = String(++count); positions = 0; }
  });
  return guide;
}
