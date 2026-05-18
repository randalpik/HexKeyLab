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
  type Moment, momentCompare, momentEqual, dynamAt, hairpinsAt, readMeter,
} from './expressions.js';
import { realTicks } from './ticks.js';

export interface ExpressionCursor {
  index: number;
  moments: ReadonlyArray<Moment>;
}

export interface ExpressionSelection {
  dynam: Element | null;
  hairpins: Element[];
}

/* ── moment list construction ────────────────────────────────────────────── */

function noteOnsetMoments(doc: Document): Moment[] {
  const out: Moment[] = [];
  const measures = Array.from(doc.querySelectorAll('measure'));
  const { unit } = readMeter(doc);
  const ticksPerBeat = 64 / unit;

  for (let mi = 0; mi < measures.length; mi++) {
    const measure = measures[mi];
    for (let voice = 1; voice <= 4; voice++) {
      const staffN = voice <= 2 ? 1 : 2;
      const layerN = (voice === 1 || voice === 3) ? 1 : 2;
      const layer = Array.from(measure.querySelectorAll(`staff[n="${staffN}"] layer[n="${layerN}"]`))[0];
      if (!layer) continue;
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

/** Build the sorted, deduplicated moment list. */
export function buildMomentList(doc: Document): Moment[] {
  const onsets = noteOnsetMoments(doc);
  const measures = Array.from(doc.querySelectorAll('measure'));

  /* Dynam moments. */
  for (const d of Array.from(doc.querySelectorAll('dynam'))) {
    const m = d.closest('measure');
    if (!m) continue;
    const idx = measures.indexOf(m);
    if (idx < 0) continue;
    const t = parseFloat(d.getAttribute('tstamp') ?? '');
    if (isFinite(t)) onsets.push({ measureIdx: idx, tstamp: t });
  }
  /* Hairpin start + end moments. */
  for (const h of Array.from(doc.querySelectorAll('hairpin'))) {
    const m = h.closest('measure');
    if (!m) continue;
    const idx = measures.indexOf(m);
    if (idx < 0) continue;
    const t = parseFloat(h.getAttribute('tstamp') ?? '');
    if (isFinite(t)) onsets.push({ measureIdx: idx, tstamp: t });
    const ts2 = h.getAttribute('tstamp2');
    if (ts2) {
      const match = ts2.match(/^(?:(\d+)m\+)?(\d+(?:\.\d+)?)$/);
      if (match) {
        const dm = match[1] !== undefined ? parseInt(match[1], 10) : 0;
        const beat = parseFloat(match[2]);
        if (isFinite(dm) && isFinite(beat)) {
          onsets.push({ measureIdx: idx + dm, tstamp: beat });
        }
      }
    }
  }

  /* Sort then dedup. */
  onsets.sort(momentCompare);
  const out: Moment[] = [];
  for (const m of onsets) {
    if (out.length > 0 && approxEqMoment(out[out.length - 1], m)) continue;
    out.push(m);
  }
  return out;
}

/** Build a fresh cursor. If `prevMoment` is given, the cursor snaps to the
 *  closest surviving moment (binary search for the first moment ≥ prev). */
export function rebuildCursor(doc: Document, prevMoment?: Moment | null): ExpressionCursor {
  const moments = buildMomentList(doc);
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

export function selectionAt(doc: Document, m: Moment): ExpressionSelection {
  return {
    dynam: dynamAt(doc, m),
    hairpins: hairpinsAt(doc, m),
  };
}
