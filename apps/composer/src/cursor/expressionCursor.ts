// Expression-layer cursor. A virtual "fifth voice" that navigates a sorted
// moment list and supports selection of dynam/hairpin elements anchored to
// the current moment.
//
// Moment list = union of:
//   - Every note/chord ONSET across all four voices (tie-initial only; tied
//     continuations are not new moments).
//   - Every <dynam>'s tstamp.
//   - Every <hairpin>'s tstamp AND endpoint moment (so existing hairpin
//     endpoints are always reachable, even when they don't coincide with a
//     note onset).
// Deduplicated by (measureIdx, tstamp) with float epsilon.
//
// The cursor is stateless w.r.t. the doc: callers build a fresh moment list
// after any structural change and either snap to the previous moment or
// reset to 0.

import {
  type Moment, momentCompare, momentEqual, dynamAt, dirAt, hairpinsAt, readMeter,
  tempoMoments, parseTstamp2,
} from '../expressions.js';
import { pedalMoments } from '../pedal.js';
import { realTicks } from '../model/ticks.js';

export interface ExpressionCursor {
  index: number;
  moments: ReadonlyArray<Moment>;
}

export interface ExpressionSelection {
  dynam: Element | null;
  dir: Element | null;
  hairpins: Element[];
}

/* ── moment list construction ────────────────────────────────────────────── */

function noteOnsetMoments(doc: Document, staffFilter?: ReadonlyArray<number>): Moment[] {
  const out: Moment[] = [];
  const measures = Array.from(doc.querySelectorAll('measure'));
  const { unit } = readMeter(doc);
  const ticksPerBeat = 64 / unit;

  for (let mi = 0; mi < measures.length; mi++) {
    const measure = measures[mi];
    /* Scan staves directly (not by voice number) so the walk is instrument-
       agnostic. `staffFilter` (when given) restricts onsets to one
       instrument's staves — used by the per-instrument expression/pedal
       layers; undefined = all staves (score-global tempo + the historic
       single-instrument behavior). */
    for (const staff of Array.from(measure.querySelectorAll('staff'))) {
      const sn = parseInt(staff.getAttribute('n') ?? '0', 10);
      if (staffFilter && !staffFilter.includes(sn)) continue;
      for (const layer of Array.from(staff.querySelectorAll('layer'))) {
        let cumTicks = 0;
        for (const child of flatLayerChildren(layer)) {
          const local = child.localName;
          const ticks = elementDurationTicks(child);
          if (local === 'note' || local === 'chord') {
            /* Skip tie-terminal continuations — they are not new onsets. */
            if (!isTieTerminalOnly(child)) {
              out.push({ measureIdx: mi, tstamp: 1 + cumTicks / ticksPerBeat });
            }
          }
          cumTicks += ticks;
        }
      }
    }
  }
  return out;
}

function flatLayerChildren(layer: Element): Element[] {
  const out: Element[] = [];
  for (const c of Array.from(layer.children)) {
    const ln = c.localName;
    if (ln === 'chord' || ln === 'note' || ln === 'rest' || ln === 'space') {
      out.push(c);
    } else if (ln === 'beam') {
      for (const cc of Array.from(c.children)) {
        const ln2 = cc.localName;
        if (ln2 === 'chord' || ln2 === 'note' || ln2 === 'rest' || ln2 === 'space') out.push(cc);
      }
    } else if (ln === 'tuplet') {
      /* Descend into tuplets so tuplet-internal notes contribute onset
         moments at fractional tstamps. realTicks() scales each child's
         duration by numbase/num automatically. */
      for (const cc of Array.from(c.children)) {
        const ln2 = cc.localName;
        if (ln2 === 'chord' || ln2 === 'note' || ln2 === 'rest' || ln2 === 'space') out.push(cc);
      }
    }
  }
  return out;
}

function elementDurationTicks(el: Element): number {
  return realTicks(el);
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

/* ── public API ──────────────────────────────────────────────────────────── */

const TS_EPSILON = 1e-6;

function approxEqMoment(a: Moment, b: Moment): boolean {
  return a.measureIdx === b.measureIdx && Math.abs(a.tstamp - b.tstamp) < TS_EPSILON;
}

/** Build the sorted, deduplicated moment list. `staffFilter` (when given)
 *  restricts onsets + dynam/dir/hairpin marks to one instrument's staves (the
 *  per-instrument expression layer); undefined = all staves. */
export function buildMomentList(doc: Document, staffFilter?: ReadonlyArray<number>): Moment[] {
  const onsets = noteOnsetMoments(doc, staffFilter);
  const measures = Array.from(doc.querySelectorAll('measure'));
  const inFilter = (el: Element): boolean =>
    !staffFilter || staffFilter.includes(parseInt(el.getAttribute('staff') ?? '0', 10));

  /* Dynam/dir/hairpin marks (point + span expression marks). Tempo is its own
     top-level layer (above V1), not part of the expression layer. */
  onsets.push(...layerElementMoments(doc, 'expr', staffFilter));
  return dedupSorted(onsets);
}

/** Element-anchor moments for ONE virtual layer — the moments at which a real
 *  mark exists (skipping bare note onsets). For `'expr'`: every <dynam>/<dir>
 *  tstamp plus every <hairpin> start AND end. For `'pedal'`/`'tempo'`: the
 *  corresponding mark moments. `staffFilter` scopes expr/pedal to one
 *  instrument's staves (tempo is score-global). Sorted ascending, deduped.
 *
 *  Used by Ctrl+←/→ to jump mark-to-mark and by layer entry to snap to the
 *  nearest existing mark. */
export function layerElementMoments(
  doc: Document,
  mode: 'expr' | 'pedal' | 'tempo',
  staffFilter?: ReadonlyArray<number>,
  includeHairpinEnd = true,
): Moment[] {
  if (mode === 'pedal') return dedupSorted(pedalMoments(doc, staffFilter));
  if (mode === 'tempo') return dedupSorted(tempoMoments(doc));
  const measures = Array.from(doc.querySelectorAll('measure'));
  const inFilter = (el: Element): boolean =>
    !staffFilter || staffFilter.includes(parseInt(el.getAttribute('staff') ?? '0', 10));
  const out: Moment[] = [];
  for (const d of Array.from(doc.querySelectorAll('dynam, dir'))) {
    if (!inFilter(d)) continue;
    const m = d.closest('measure');
    if (!m) continue;
    const idx = measures.indexOf(m);
    if (idx < 0) continue;
    const t = parseFloat(d.getAttribute('tstamp') ?? '');
    if (isFinite(t)) out.push({ measureIdx: idx, tstamp: t });
  }
  for (const h of Array.from(doc.querySelectorAll('hairpin'))) {
    if (!inFilter(h)) continue;
    const m = h.closest('measure');
    if (!m) continue;
    const idx = measures.indexOf(m);
    if (idx < 0) continue;
    const t = parseFloat(h.getAttribute('tstamp') ?? '');
    if (isFinite(t)) out.push({ measureIdx: idx, tstamp: t });
    /* The hairpin END is a navigable moment (plain ←/→) but NOT a distinct
       selectable item — Ctrl-jump and entry-snap exclude it so each stop lands
       on a real mark (the hairpin is reached via its start). */
    if (includeHairpinEnd) {
      const end = parseTstamp2(h.getAttribute('tstamp2') ?? '', idx);
      if (end) out.push(end);
    }
  }
  return dedupSorted(out);
}

/** Step to the next (`dir=1`) or previous (`dir=-1`) EXISTING mark in the
 *  layer, relative to the cursor's current moment. Returns the snapped cursor,
 *  or the cursor unchanged when there is no mark in that direction. */
export function stepToElement(
  c: ExpressionCursor,
  doc: Document,
  mode: 'expr' | 'pedal' | 'tempo',
  dir: -1 | 1,
  staffFilter?: ReadonlyArray<number>,
): ExpressionCursor {
  const cur = currentMoment(c);
  const elems = layerElementMoments(doc, mode, staffFilter, false /* item anchors only */);
  if (elems.length === 0) return c;
  if (!cur) return snapTo(c, dir > 0 ? elems[0] : elems[elems.length - 1]);
  let target: Moment | null = null;
  if (dir > 0) {
    for (const m of elems) { if (momentCompare(m, cur) > 0) { target = m; break; } }
  } else {
    for (let i = elems.length - 1; i >= 0; i--) {
      if (momentCompare(elems[i], cur) < 0) { target = elems[i]; break; }
    }
  }
  if (!target) return c;
  return snapTo(c, target);
}

/** Snap a freshly-built cursor to the nearest existing mark in the layer (used
 *  on layer entry). If the layer has no marks, snaps to `prefer` (the
 *  carried-over moment) instead, falling back to the cursor as built. */
export function snapToNearestElement(
  c: ExpressionCursor,
  doc: Document,
  mode: 'expr' | 'pedal' | 'tempo',
  prefer: Moment | null,
  staffFilter?: ReadonlyArray<number>,
): ExpressionCursor {
  const elems = layerElementMoments(doc, mode, staffFilter, false /* item anchors only */);
  if (elems.length === 0) return prefer ? snapTo(c, prefer) : c;
  const anchor = prefer ?? currentMoment(c);
  if (!anchor) return snapTo(c, elems[0]);
  /* Closest mark to the anchor moment. */
  let best = elems[0];
  let bestD = absDistance(best, anchor);
  for (const m of elems) {
    const d = absDistance(m, anchor);
    if (d < bestD) { best = m; bestD = d; }
  }
  return snapTo(c, best);
}

/** Sort ascending and drop adjacent duplicates (by measure+tstamp epsilon). */
function dedupSorted(moments: Moment[]): Moment[] {
  moments.sort(momentCompare);
  const out: Moment[] = [];
  for (const m of moments) {
    if (out.length > 0 && approxEqMoment(out[out.length - 1], m)) continue;
    out.push(m);
  }
  return out;
}

/** Pedal-layer moment list: note onsets ∪ <pedal> mark moments. Constructed
 *  exactly like buildMomentList (the expression layer), substituting pedal
 *  marks for dynam/hairpin moments. */
export function buildPedalMomentList(doc: Document, staffFilter?: ReadonlyArray<number>): Moment[] {
  return dedupSorted([...noteOnsetMoments(doc, staffFilter), ...pedalMoments(doc, staffFilter)]);
}

/** Build a cursor over an explicit moment list, snapping to the moment closest
 *  to `prevMoment` (lower-bound binary search). Shared by the expression and
 *  pedal layers. */
function cursorFromMoments(moments: Moment[], prevMoment?: Moment | null): ExpressionCursor {
  if (moments.length === 0) return { index: 0, moments };
  if (!prevMoment) return { index: 0, moments };
  /* Lower-bound binary search. */
  let lo = 0, hi = moments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (momentCompare(moments[mid], prevMoment) < 0) lo = mid + 1;
    else hi = mid;
  }
  /* Clamp to the last index if past end. */
  const index = Math.min(lo, moments.length - 1);
  return { index, moments };
}

/** Build a fresh expression cursor. If `prevMoment` is given, the cursor snaps
 *  to the closest surviving moment. */
export function rebuildCursor(doc: Document, prevMoment?: Moment | null, staffFilter?: ReadonlyArray<number>): ExpressionCursor {
  return cursorFromMoments(buildMomentList(doc, staffFilter), prevMoment);
}

/** Build a fresh pedal-layer cursor (same snapping as rebuildCursor). */
export function rebuildPedalCursor(doc: Document, prevMoment?: Moment | null, staffFilter?: ReadonlyArray<number>): ExpressionCursor {
  return cursorFromMoments(buildPedalMomentList(doc, staffFilter), prevMoment);
}

/** Tempo-layer moment list: note onsets ∪ <tempo> mark moments. Same
 *  construction as the expression/pedal layers; tempo is a top-level layer
 *  above V1 because it applies to all instruments, not one staff. */
export function buildTempoMomentList(doc: Document): Moment[] {
  return dedupSorted([...noteOnsetMoments(doc), ...tempoMoments(doc)]);
}

/** Build a fresh tempo-layer cursor (same snapping as rebuildCursor). */
export function rebuildTempoCursor(doc: Document, prevMoment?: Moment | null): ExpressionCursor {
  return cursorFromMoments(buildTempoMomentList(doc), prevMoment);
}

export function currentMoment(c: ExpressionCursor): Moment | null {
  if (c.moments.length === 0) return null;
  if (c.index < 0 || c.index >= c.moments.length) return null;
  return c.moments[c.index];
}

export function step(c: ExpressionCursor, dir: -1 | 1): ExpressionCursor {
  if (c.moments.length === 0) return c;
  const next = Math.max(0, Math.min(c.moments.length - 1, c.index + dir));
  if (next === c.index) return c;
  return { index: next, moments: c.moments };
}

export function moveToStart(c: ExpressionCursor): ExpressionCursor {
  if (c.moments.length === 0) return c;
  if (c.index === 0) return c;
  return { index: 0, moments: c.moments };
}

export function moveToEnd(c: ExpressionCursor): ExpressionCursor {
  if (c.moments.length === 0) return c;
  const last = c.moments.length - 1;
  if (c.index === last) return c;
  return { index: last, moments: c.moments };
}

/** Snap the cursor to a specific moment (closest by binary search). */
export function snapTo(c: ExpressionCursor, target: Moment): ExpressionCursor {
  if (c.moments.length === 0) return c;
  let lo = 0, hi = c.moments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (momentCompare(c.moments[mid], target) < 0) lo = mid + 1;
    else hi = mid;
  }
  /* Prefer the EXACT match if present; else the closer of [lo-1, lo]. */
  if (lo < c.moments.length && momentEqual(c.moments[lo], target)) {
    return { index: lo, moments: c.moments };
  }
  /* Otherwise lo points to the first moment > target. Compare with lo-1. */
  if (lo === 0) return { index: 0, moments: c.moments };
  if (lo >= c.moments.length) return { index: c.moments.length - 1, moments: c.moments };
  const before = c.moments[lo - 1];
  const after = c.moments[lo];
  const dBefore = absDistance(before, target);
  const dAfter = absDistance(after, target);
  return { index: dBefore <= dAfter ? lo - 1 : lo, moments: c.moments };
}

function absDistance(a: Moment, b: Moment): number {
  /* Distance in "measure beats", treating each measure as 1000 beats apart
     so cross-measure comparisons strongly prefer same-measure neighbors. */
  return Math.abs((a.measureIdx - b.measureIdx) * 1000 + (a.tstamp - b.tstamp));
}

/* ── selection ───────────────────────────────────────────────────────────── */

export function selectionAt(doc: Document, m: Moment, staffFilter?: ReadonlyArray<number>): ExpressionSelection {
  return {
    dynam: dynamAt(doc, m, staffFilter),
    dir: dirAt(doc, m, staffFilter),
    hairpins: hairpinsAt(doc, m, staffFilter),
  };
}
