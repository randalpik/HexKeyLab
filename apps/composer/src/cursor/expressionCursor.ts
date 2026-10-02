// Layer cursor for the expression / pedal / tempo layers. A virtual layer that
// steps through a sorted list of STOPS:
//   - one per mark: every <dynam>, <dir>, <pedal>, <tempo>; a <hairpin>
//     contributes two, its start and its end (`edge`).
//   - one PLACEHOLDER at every note/chord ONSET (tie-initial only; tied
//     continuations are not new onsets) whose moment carries no mark.
// Sorted by moment. Marks sharing a moment are ordered top to bottom as
// rendered (`orderStopsByRender`, applied before each navigation step); until
// they have rendered they keep type order: hairpin ends, dynamic, expressive
// text, hairpin starts (pedal: up, then down).
//
// A stop selects exactly its own mark — a placeholder inside a hairpin's span
// selects nothing, so concurrent marks inside a wedge don't multiply the stops.
// Onset tstamps use each measure's own beat unit (mid-piece meter changes).
//
// The cursor is stateless w.r.t. the doc: callers rebuild after any structural
// change and `relocate` the previous stop (same mark, else same moment).

import {
  type Moment, momentCompare, momentEqual, parseTstamp2, beatTicksByMeasure,
} from '../expressions.js';
import { realTicks } from '../model/ticks.js';

export type LayerMode = 'expr' | 'pedal' | 'tempo';
export type MarkKind = 'dynam' | 'dir' | 'hairpin' | 'pedal' | 'tempo';

export interface MarkRef {
  /** The mark's xml:id (its rendered `<g>` id). */
  id: string;
  kind: MarkKind;
  /** Hairpins only: which end of the wedge this stop is. */
  edge?: 'start' | 'end';
  /** The mark's @staff. */
  staff: number;
}

export interface LayerStop {
  moment: Moment;
  /** The mark this stop selects; null for a placeholder. */
  mark: MarkRef | null;
  /** xml:id of the first note/chord with an onset at this moment (top staff,
   *  top layer first), or null — a placeholder's x anchor. */
  onsetId: string | null;
}

export interface ExpressionCursor {
  index: number;
  stops: ReadonlyArray<LayerStop>;
}

export const EMPTY_LAYER_CURSOR: ExpressionCursor = { index: 0, stops: [] };

/* ── stop list construction ──────────────────────────────────────────────── */

interface Onset { moment: Moment; id: string }

/** Every note/chord onset (sorted, one per moment — the first in staff/layer
 *  order keeps its id). `staffFilter` restricts to one instrument's staves. */
function noteOnsets(doc: Document, staffFilter?: ReadonlyArray<number>): Onset[] {
  const out: Onset[] = [];
  const measures = Array.from(doc.querySelectorAll('measure'));
  const beatTicks = beatTicksByMeasure(doc);
  for (let mi = 0; mi < measures.length; mi++) {
    const ticksPerBeat = beatTicks[mi] ?? 16;
    /* Scan staves directly (not by voice number) so the walk is instrument-
       agnostic. */
    for (const staff of Array.from(measures[mi].querySelectorAll('staff'))) {
      const sn = parseInt(staff.getAttribute('n') ?? '0', 10);
      if (staffFilter && !staffFilter.includes(sn)) continue;
      for (const layer of Array.from(staff.querySelectorAll('layer'))) {
        let cumTicks = 0;
        for (const child of flatLayerChildren(layer)) {
          const local = child.localName;
          const id = child.getAttribute('xml:id');
          if ((local === 'note' || local === 'chord') && id && !isTieTerminalOnly(child)) {
            out.push({ moment: { measureIdx: mi, tstamp: 1 + cumTicks / ticksPerBeat }, id });
          }
          cumTicks += realTicks(child);
        }
      }
    }
  }
  /* Stable sort: within a moment the first-pushed (top staff, top layer) wins. */
  out.sort((a, b) => momentCompare(a.moment, b.moment));
  const dedup: Onset[] = [];
  for (const o of out) {
    if (dedup.length > 0 && momentEqual(dedup[dedup.length - 1].moment, o.moment)) continue;
    dedup.push(o);
  }
  return dedup;
}

function flatLayerChildren(layer: Element): Element[] {
  const out: Element[] = [];
  for (const c of Array.from(layer.children)) {
    const ln = c.localName;
    if (ln === 'chord' || ln === 'note' || ln === 'rest' || ln === 'space') {
      out.push(c);
    } else if (ln === 'beam' || ln === 'tuplet') {
      /* Descend one level: beamed notes, and tuplet-internal notes at
         fractional tstamps (realTicks scales each child by numbase/num). */
      for (const cc of Array.from(c.children)) {
        const ln2 = cc.localName;
        if (ln2 === 'chord' || ln2 === 'note' || ln2 === 'rest' || ln2 === 'space') out.push(cc);
      }
    }
  }
  return out;
}

/** True when this element is a tied continuation (terminal-only or medial)
 *  with no outgoing fresh attack. We treat MEDIAL ties as continuations too:
 *  the audible attack happened on the tie-INITIAL; @tie="m" means "incoming
 *  AND outgoing" so it's still a continuation from the user's perspective. */
function isTieTerminalOnly(el: Element): boolean {
  const notes = el.localName === 'note' ? [el]
    : Array.from(el.children).filter((c) => c.localName === 'note');
  if (notes.length === 0) return false;
  /* If ANY note in the element is a fresh onset (no incoming tie), the
     element as a whole counts as a new onset. */
  for (const n of notes) {
    const t = n.getAttribute('tie');
    if (t !== 't' && t !== 'm') return false;
  }
  return true;
}

const MARK_SELECTOR: Record<LayerMode, string> = { expr: 'dynam, dir, hairpin', pedal: 'pedal', tempo: 'tempo' };

/** Type order of marks sharing a moment, used until they have rendered: a
 *  wedge closing into the dynamic, the text, then the next wedge opening;
 *  a pedal change releases before it re-depresses. */
function typeRank(el: Element, edge?: 'start' | 'end'): number {
  switch (el.localName) {
    case 'hairpin': return edge === 'end' ? 0 : 3;
    case 'dynam': return 1;
    case 'dir': return 2;
    case 'pedal': return el.getAttribute('dir') === 'up' ? 0 : 1;
    default: return 0;
  }
}

/** Mark stops of one layer, sorted by moment then type order. `staffFilter`
 *  scopes expr/pedal to one instrument's staves; tempo is score-global. */
function markStops(doc: Document, mode: LayerMode, staffFilter?: ReadonlyArray<number>): LayerStop[] {
  const measureIdx = new Map<Element, number>();
  Array.from(doc.querySelectorAll('measure')).forEach((m, i) => measureIdx.set(m, i));
  const ranked: { stop: LayerStop; rank: number }[] = [];
  for (const el of Array.from(doc.querySelectorAll(MARK_SELECTOR[mode]))) {
    const staff = parseInt(el.getAttribute('staff') ?? '0', 10);
    if (mode !== 'tempo' && staffFilter && !staffFilter.includes(staff)) continue;
    const id = el.getAttribute('xml:id');
    const measure = el.closest('measure');
    const mi = measure ? measureIdx.get(measure) : undefined;
    const t = parseFloat(el.getAttribute('tstamp') ?? '');
    if (!id || mi === undefined || !isFinite(t)) continue;
    const kind = el.localName as MarkKind;
    const at: Moment = { measureIdx: mi, tstamp: t };
    if (kind === 'hairpin') {
      ranked.push({ stop: { moment: at, mark: { id, kind, edge: 'start', staff }, onsetId: null }, rank: typeRank(el, 'start') });
      const end = parseTstamp2(el.getAttribute('tstamp2') ?? '', mi);
      if (end) ranked.push({ stop: { moment: end, mark: { id, kind, edge: 'end', staff }, onsetId: null }, rank: typeRank(el, 'end') });
    } else {
      ranked.push({ stop: { moment: at, mark: { id, kind, staff }, onsetId: null }, rank: typeRank(el) });
    }
  }
  ranked.sort((a, b) => momentCompare(a.stop.moment, b.stop.moment) || a.rank - b.rank);
  return ranked.map((r) => r.stop);
}

/** The layer's stops: its marks, plus a placeholder at every onset moment that
 *  carries no mark. A mark stop records the onset at its moment too (the
 *  placeholder geometry's fallback when the mark itself isn't rendered). */
export function buildLayerStops(doc: Document, mode: LayerMode, staffFilter?: ReadonlyArray<number>): LayerStop[] {
  const onsets = noteOnsets(doc, mode === 'tempo' ? undefined : staffFilter);
  const marks = markStops(doc, mode, staffFilter);
  const out: LayerStop[] = [];
  let i = 0, j = 0;
  while (i < onsets.length || j < marks.length) {
    const o = onsets[i];
    const mk = marks[j];
    const c = !o ? 1 : !mk ? -1 : momentCompare(o.moment, mk.moment);
    if (c < 0) {
      out.push({ moment: o.moment, mark: null, onsetId: o.id });
      i++;
    } else if (c > 0) {
      out.push(mk);
      j++;
    } else {
      while (j < marks.length && momentCompare(marks[j].moment, o.moment) === 0) {
        out.push({ ...marks[j], onsetId: o.id });
        j++;
      }
      i++;
    }
  }
  return out;
}

/* ── cursor construction ─────────────────────────────────────────────────── */

const sameMark = (a: MarkRef | null, b: MarkRef | null): boolean =>
  !!a && !!b && a.id === b.id && a.edge === b.edge;

/** Lower bound: the first stop at or after `m`, clamped to the last. */
function lowerBound(stops: ReadonlyArray<LayerStop>, m: Moment): number {
  let lo = 0, hi = stops.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (momentCompare(stops[mid].moment, m) < 0) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, Math.max(0, stops.length - 1));
}

/** A cursor over `stops` at the first stop at (or after) `at`; index 0 when
 *  `at` is null. */
export function cursorAtMoment(stops: ReadonlyArray<LayerStop>, at: Moment | null): ExpressionCursor {
  if (stops.length === 0 || !at) return { index: 0, stops };
  return { index: lowerBound(stops, at), stops };
}

/** Re-find `prev`'s current stop in a freshly built list: the same mark (id +
 *  edge) if it survived; else the stop at the same moment holding the same
 *  position among that moment's stops (so deleting one of three coincident
 *  marks lands on its neighbour, not back at the first); else the first stop
 *  at or after the moment. */
export function relocate(prev: ExpressionCursor, stops: ReadonlyArray<LayerStop>): ExpressionCursor {
  const cur = currentStop(prev);
  if (!cur || stops.length === 0) return { index: 0, stops };
  if (cur.mark) {
    const same = stops.findIndex((s) => sameMark(s.mark, cur.mark));
    if (same >= 0) return { index: same, stops };
  }
  let first = prev.index;
  while (first > 0 && momentEqual(prev.stops[first - 1].moment, cur.moment)) first--;
  const ordinal = prev.index - first;
  const lo = lowerBound(stops, cur.moment);
  if (momentEqual(stops[lo].moment, cur.moment)) {
    let hi = lo;
    while (hi + 1 < stops.length && momentEqual(stops[hi + 1].moment, cur.moment)) hi++;
    return { index: Math.min(lo + ordinal, hi), stops };
  }
  return { index: lo, stops };
}

/* ── accessors ───────────────────────────────────────────────────────────── */

export function currentStop(c: ExpressionCursor): LayerStop | null {
  if (c.index < 0 || c.index >= c.stops.length) return null;
  return c.stops[c.index];
}

export function currentMoment(c: ExpressionCursor): Moment | null {
  return currentStop(c)?.moment ?? null;
}

export function currentMark(c: ExpressionCursor): MarkRef | null {
  return currentStop(c)?.mark ?? null;
}

/** The live MEI element a stop's mark refers to, or null once it's gone. */
export function markElement(doc: Document, mark: MarkRef): Element | null {
  for (const el of Array.from(doc.querySelectorAll(mark.kind))) {
    if (el.getAttribute('xml:id') === mark.id) return el;
  }
  return null;
}

/* ── navigation ──────────────────────────────────────────────────────────── */

export function step(c: ExpressionCursor, dir: -1 | 1): ExpressionCursor {
  if (c.stops.length === 0) return c;
  const next = Math.max(0, Math.min(c.stops.length - 1, c.index + dir));
  if (next === c.index) return c;
  return { index: next, stops: c.stops };
}

export function moveToStart(c: ExpressionCursor): ExpressionCursor {
  if (c.stops.length === 0 || c.index === 0) return c;
  return { index: 0, stops: c.stops };
}

export function moveToEnd(c: ExpressionCursor): ExpressionCursor {
  const last = c.stops.length - 1;
  if (last < 0 || c.index === last) return c;
  return { index: last, stops: c.stops };
}

/** Ctrl+←/→: the next (`dir=1`) or previous (`dir=-1`) MARK stop — skipping
 *  placeholders; each coincident mark and each hairpin end is its own stop.
 *  Returns the cursor unchanged when there is no mark in that direction. */
export function stepToMark(c: ExpressionCursor, dir: -1 | 1): ExpressionCursor {
  for (let i = c.index + dir; i >= 0 && i < c.stops.length; i += dir) {
    if (c.stops[i].mark) return { index: i, stops: c.stops };
  }
  return c;
}

/** Layer entry: the mark stop nearest `anchor` (the first of a moment's marks
 *  on a tie). With no marks, the cursor as given. */
export function snapToNearestMark(c: ExpressionCursor, anchor: Moment | null): ExpressionCursor {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < c.stops.length; i++) {
    if (!c.stops[i].mark) continue;
    const d = anchor ? absDistance(c.stops[i].moment, anchor) : i;
    if (d < bestD) { best = i; bestD = d; }
  }
  return best < 0 ? c : { index: best, stops: c.stops };
}

/** The stop selecting mark `id` (a hairpin's `edge`, start by default), or the
 *  cursor unchanged when no stop holds it. */
export function snapToMark(c: ExpressionCursor, id: string, edge?: 'start' | 'end'): ExpressionCursor {
  const want = edge ?? 'start';
  const i = c.stops.findIndex((s) => s.mark?.id === id && (s.mark.kind !== 'hairpin' || s.mark.edge === want));
  return i < 0 ? c : { index: i, stops: c.stops };
}

function absDistance(a: Moment, b: Moment): number {
  /* Distance in "measure beats", treating each measure as 1000 beats apart
     so cross-measure comparisons strongly prefer same-measure neighbors. */
  return Math.abs((a.measureIdx - b.measureIdx) * 1000 + (a.tstamp - b.tstamp));
}

/* ── render order ────────────────────────────────────────────────────────── */

/** Tops within this many px count as level; those order left to right. */
const ORDER_TOP_TOL = 2;

/** Re-sort each moment's run of marks top to bottom as rendered (level tops
 *  left to right, then type order), keeping the cursor on the same stop. A run
 *  with any unrendered mark keeps its type order. `rectOf` returns the mark's
 *  rendered box in any consistent frame. */
export function orderStopsByRender(
  c: ExpressionCursor,
  rectOf: (mark: MarkRef) => { top: number; left: number } | null,
): ExpressionCursor {
  let stops: LayerStop[] | null = null;
  for (let i = 0; i < c.stops.length;) {
    let j = i + 1;
    if (c.stops[i].mark) {
      while (j < c.stops.length && c.stops[j].mark && momentEqual(c.stops[j].moment, c.stops[i].moment)) j++;
    }
    if (j - i > 1) {
      const run = c.stops.slice(i, j);
      const geo = run.map((s) => rectOf(s.mark!));
      if (geo.every((g) => g !== null)) {
        const order = run.map((_, k) => k).sort((a, b) => {
          const ga = geo[a]!, gb = geo[b]!;
          if (Math.abs(ga.top - gb.top) > ORDER_TOP_TOL) return ga.top - gb.top;
          if (Math.abs(ga.left - gb.left) > 0.5) return ga.left - gb.left;
          return a - b;
        });
        if (order.some((v, k) => v !== k)) {
          stops ??= c.stops.slice();
          for (let k = 0; k < order.length; k++) stops[i + k] = run[order[k]];
        }
      }
    }
    i = j;
  }
  if (!stops) return c;
  const cur = c.stops[c.index];
  return { index: Math.max(0, stops.indexOf(cur)), stops };
}
