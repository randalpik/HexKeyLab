// Visual overlay for selection mode. Attaches to an SVG layer over the
// rendered score and draws one semi-transparent rect per staff-system that
// the selection touches: adjacent measures on the same system coalesce into
// a single rect, so we never see overlapping rectangles at bar lines.
//
// Boundary x semantics: cursor c is "past flat[c]", which visually sits at
// the START of the NEXT element's playing space (= flat[c+1]'s left edge).
// Each element in a layer occupies a horizontal interval representing its
// duration, from its own left edge to the next element's left edge. A
// selection [a, b) covers playing-time intervals of flat[a+1] .. flat[b],
// rendered as a rect from xAtCursorPos(a) to xAtCursorPos(b).
//
// Rules:
//   - Past-end (c >= flat.length): right edge of last measure.
//   - flat[c] is a <measure> wrapper (cursor at start of measure content):
//     left edge of that measure.
//   - The cursor position is the start of a measure (per
//     getMeasureStartCursor — covers the wrapper-collapsed case where
//     flat[c] is the first content element of a new measure): left edge
//     of that measure (= bar-line snap).
//   - Otherwise: left edge of flat[c+1]. If flat[c+1] is itself a
//     <measure> wrapper, that resolves to the measure's left edge; for
//     any other element type it's the element's own left edge.

import type { ComposerModel, Voice } from './model.js';
import type { SelectionState, Staff } from './selection.js';
import { renderer } from './render.js';

const SELECTION_FILL = '#3b82f6';
const SELECTION_OPACITY = '0.18';

function staffIdForMeasure(model: ComposerModel, measureIdx: number, staff: Staff): string | null {
  const measures = model.allMeasures();
  if (measureIdx < 0 || measureIdx >= measures.length) return null;
  const m = measures[measureIdx];
  const staffEl = Array.from(m.querySelectorAll('staff')).find(
    (s) => s.getAttribute('n') === String(staff),
  );
  return staffEl?.getAttribute('xml:id') ?? null;
}

function measureIdForIdx(model: ComposerModel, measureIdx: number): string | null {
  const measures = model.allMeasures();
  if (measureIdx < 0 || measureIdx >= measures.length) return null;
  return measures[measureIdx].getAttribute('xml:id');
}

const TICK_EPS = 1e-6;

/** Left edge x-coord of an element, in container-local px. */
function elementLeft(el: Element): number | null {
  const id = el.getAttribute('xml:id');
  if (!id) return null;
  const r = renderer.rectForId(id);
  return r ? r.left : null;
}

/** Right edge of the last measure (= end barline) — the visual position
 *  of past-end. */
function endOfScoreX(measures: Element[]): number | null {
  const last = measures[measures.length - 1];
  if (!last) return null;
  const mid = last.getAttribute('xml:id');
  if (!mid) return null;
  const r = renderer.rectForId(mid);
  return r ? r.right : null;
}

/** Left edge of measure `measureIdx`'s content — past any leading clef /
 *  key / meter sig block. Sig blocks live at the start of systems (and at
 *  sig-change boundaries), and they belong to the staff being rendered,
 *  so we look up the target measure's own staff to query findSigEndXForStaff. */
function measureContentLeft(
  model: ComposerModel,
  measureIdx: number,
  staff: Staff,
): number | null {
  const measures = model.allMeasures();
  if (measureIdx < 0 || measureIdx >= measures.length) return null;
  const staffMeiId = staffIdForMeasure(model, measureIdx, staff);
  if (staffMeiId) {
    const sigEnd = renderer.findSigEndXForStaff(staffMeiId);
    if (sigEnd !== null) return sigEnd;
  }
  const mid = measures[measureIdx].getAttribute('xml:id');
  if (!mid) return null;
  const r = renderer.rectForId(mid);
  return r ? r.left : null;
}

/** Right edge of measure `measureIdx` — the visual position of "end of
 *  measure M_k" = the barline between M_k and M_{k+1} as drawn on M_k's
 *  system. */
function measureRightEdge(model: ComposerModel, measureIdx: number): number | null {
  const measures = model.allMeasures();
  if (measureIdx < 0 || measureIdx >= measures.length) return null;
  const mid = measures[measureIdx].getAttribute('xml:id');
  if (!mid) return null;
  const r = renderer.rectForId(mid);
  return r ? r.right : null;
}

/** Visual x of the cursor at position `c` in `voice`. Cursor c is "past
 *  flat[c]"; visually it sits at the START of the next element's
 *  playing-time interval (= left edge of flat[c+1]) for interior positions.
 *
 *  Special cases:
 *    - Past-end (c >= flat.length): right edge of last measure.
 *    - Cursor tstamp aligns with a measure-start barline (between M_{k-1}
 *      and M_k): a single point in score-time but two visual positions
 *      when the barline straddles a system break. The `kind` parameter
 *      disambiguates:
 *        - 'start': use M_k's content-left (= start of next measure).
 *          For a selection's LEFT edge, this is what you want.
 *        - 'end': use M_{k-1}'s right edge (= end of previous measure).
 *          For a selection's RIGHT edge, this is what you want.
 *
 *  `staff` is needed for sig-block-aware snapping when `kind === 'start'`. */
function xAtCursorPos(
  model: ComposerModel,
  voice: Voice,
  c: number,
  staff: Staff,
  kind: 'start' | 'end',
): number | null {
  const flat = model.flatChildren(voice);
  const measures = model.allMeasures();
  if (measures.length === 0) return null;

  // Past-end: right edge of last measure.
  if (c >= flat.length) return endOfScoreX(measures);

  // Measure-boundary disambiguation: if the cursor's tstamp is exactly a
  // multiple of measureTicks, the cursor sits at a barline.
  const t = model.getTickPositionAt(voice, c);
  const measureT = model.measureTicks();
  const measureIdx = Math.round(t / measureT);
  if (Math.abs(measureIdx * measureT - t) < TICK_EPS) {
    if (kind === 'start') {
      // Use M_{measureIdx}'s content-left.
      if (measureIdx >= measures.length) return endOfScoreX(measures);
      if (measureIdx >= 0) {
        const x = measureContentLeft(model, measureIdx, staff);
        if (x !== null) return x;
      }
    } else {
      // Use M_{measureIdx - 1}'s right edge. For measureIdx === 0 (start
      // of score), there's no previous measure — fall back to M_0's left.
      if (measureIdx === 0) {
        const x = measureContentLeft(model, 0, staff);
        if (x !== null) return x;
      } else if (measureIdx - 1 < measures.length) {
        const x = measureRightEdge(model, measureIdx - 1);
        if (x !== null) return x;
      }
    }
  }

  // Default: LEFT edge of flat[c+1].
  if (c + 1 >= flat.length) return endOfScoreX(measures);
  const next = flat[c + 1];
  if (next.localName === 'measure') {
    const mid = next.getAttribute('xml:id');
    if (!mid) return null;
    const r = renderer.rectForId(mid);
    return r ? r.left : null;
  }
  return elementLeft(next);
}

interface DrawRect {
  x: number; y: number; w: number; h: number;
}

/** Measure range the selection's playing-time content touches (inclusive).
 *  For beat mode: scans flat[a+1..b] (the elements between anchor and
 *  movable cursors), skipping wrappers, and takes min/max measureIdx.
 *  Returns null when the selection contains no content (degenerate). */
function selectionMeasureRange(model: ComposerModel, sel: SelectionState): { mLo: number; mHi: number } | null {
  const measures = model.allMeasures();
  if (measures.length === 0) return null;
  if (sel.kind === 'measure') {
    return {
      mLo: Math.min(sel.anchorMeasure, sel.movableMeasure),
      mHi: Math.max(sel.anchorMeasure, sel.movableMeasure),
    };
  }
  const flat = model.flatChildren(sel.voice);
  const a = Math.min(sel.anchor, sel.movable);
  const b = Math.max(sel.anchor, sel.movable);
  let mLo = Infinity;
  let mHi = -Infinity;
  for (let i = a + 1; i <= b && i < flat.length; i++) {
    /* Skip wrappers — they sit at measure starts and have no playing time. */
    if (flat[i].localName === 'measure') continue;
    const info = model.getFlatStopInfo(sel.voice, i);
    if (!info || info.measureIdx < 0 || info.measureIdx >= measures.length) continue;
    if (info.measureIdx < mLo) mLo = info.measureIdx;
    if (info.measureIdx > mHi) mHi = info.measureIdx;
  }
  if (!isFinite(mLo)) return null;
  return { mLo, mHi };
}

/** Find the rendered `<g class="system">` ancestor of the given measure's
 *  rendered group. Two measures share a system iff this returns the same
 *  element for both. Returns null if the measure isn't rendered yet. */
function systemAncestor(measureMeiId: string): Element | null {
  const node = document.getElementById(measureMeiId);
  if (!node) return null;
  return node.closest('g.system');
}

/** Y range of the staff(es) covered by the selection. Uses one representative
 *  measure on the relevant system — all measures on the same system render
 *  with identical staff y, so we only need one sample. */
function staffYRangeForMeasure(
  model: ComposerModel,
  sel: SelectionState,
  measureIdx: number,
): { top: number; bottom: number } | null {
  const firstStaff: Staff = sel.kind === 'beat'
    ? (sel.voice <= 2 ? 1 : 2)
    : sel.firstStaff;
  const lastStaff: Staff = sel.kind === 'beat'
    ? firstStaff
    : sel.lastStaff;
  const firstId = staffIdForMeasure(model, measureIdx, firstStaff);
  const lastId = staffIdForMeasure(model, measureIdx, lastStaff);
  if (!firstId || !lastId) return null;
  const firstRect = renderer.rectForId(firstId);
  const lastRect = renderer.rectForId(lastId);
  if (!firstRect || !lastRect) return null;
  return {
    top: Math.min(firstRect.top, lastRect.top),
    bottom: Math.max(firstRect.bottom, lastRect.bottom),
  };
}

/** Compute the screen rectangles to render for the given selection. One
 *  rect per visual system that the selection touches: the rect spans from
 *  the selection's leftmost-x within the system to its rightmost-x, and
 *  its y range is the system's relevant staff(es) y range. */
function computeRects(model: ComposerModel, sel: SelectionState): DrawRect[] {
  const range = selectionMeasureRange(model, sel);
  if (!range) return [];

  /* Group selected measures by their rendered <g class="system"> ancestor.
   * Same ancestor → same system → one rect. */
  type Group = {
    systemNode: Element | null;
    measureIdxs: number[];
    minLeft: number;
    maxRight: number;
    y: { top: number; bottom: number } | null;
  };
  const groups: Group[] = [];
  let current: Group | null = null;

  /* Staff used for sig-block-snap queries. For beat mode it's the voice's
   * own staff. For measure mode all selected staves on a given system share
   * the same sig-block x, so the first staff is sufficient. */
  const staffForSnap: Staff = sel.kind === 'beat'
    ? (sel.voice <= 2 ? 1 : 2)
    : sel.firstStaff;

  for (let mi = range.mLo; mi <= range.mHi; mi++) {
    const measureEl = model.allMeasures()[mi];
    const mid = measureEl?.getAttribute('xml:id') ?? null;
    if (!mid) continue;
    const measureRect = renderer.rectForId(mid);
    if (!measureRect) continue;
    const systemNode = systemAncestor(mid);

    const isFirst = mi === range.mLo;
    const isLast = mi === range.mHi;
    /* Default x bounds: measure content-left (past sig block) to measure
     * right edge. Cursor-derived bounds override these for the first/last
     * selected measure in beat mode. */
    const defaultLeft = measureContentLeft(model, mi, staffForSnap);
    let xLeft = defaultLeft !== null ? defaultLeft : measureRect.left;
    let xRight = measureRect.right;
    if (isFirst && sel.kind === 'beat') {
      const lo = Math.min(sel.anchor, sel.movable);
      const x = xAtCursorPos(model, sel.voice, lo, staffForSnap, 'start');
      if (x !== null) xLeft = x;
    }
    if (isLast && sel.kind === 'beat') {
      const hi = Math.max(sel.anchor, sel.movable);
      const x = xAtCursorPos(model, sel.voice, hi, staffForSnap, 'end');
      if (x !== null) xRight = x;
    }
    if (xRight <= xLeft) continue;

    /* Open a new group when the system ancestor changes (or on first). */
    if (!current || current.systemNode !== systemNode) {
      current = {
        systemNode,
        measureIdxs: [mi],
        minLeft: xLeft,
        maxRight: xRight,
        y: staffYRangeForMeasure(model, sel, mi),
      };
      groups.push(current);
    } else {
      current.measureIdxs.push(mi);
      if (xLeft < current.minLeft) current.minLeft = xLeft;
      if (xRight > current.maxRight) current.maxRight = xRight;
      /* Y range stays the same — all measures on one system share staff y. */
    }
  }

  const out: DrawRect[] = [];
  for (const g of groups) {
    if (!g.y) continue;
    out.push({
      x: g.minLeft,
      y: g.y.top,
      w: g.maxRight - g.minLeft,
      h: g.y.bottom - g.y.top,
    });
  }
  return out;
}

export class SelectionOverlay {
  private svg: SVGSVGElement | null = null;
  private rects: SVGRectElement[] = [];

  attach(svg: SVGSVGElement): void {
    this.svg = svg;
    this.rects = [];
  }

  update(model: ComposerModel, sel: SelectionState | null): void {
    if (!this.svg) return;
    for (const r of this.rects) r.remove();
    this.rects = [];
    if (!sel) return;
    const draws = computeRects(model, sel);
    for (const d of draws) {
      if (d.w <= 0 || d.h <= 0) continue;
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(d.x));
      rect.setAttribute('y', String(d.y));
      rect.setAttribute('width', String(d.w));
      rect.setAttribute('height', String(d.h));
      rect.setAttribute('fill', SELECTION_FILL);
      rect.setAttribute('opacity', SELECTION_OPACITY);
      rect.setAttribute('data-selection-rect', 'true');
      rect.setAttribute('pointer-events', 'none');
      this.svg.insertBefore(rect, this.svg.firstChild);
      this.rects.push(rect);
    }
  }
}

export const selectionOverlay = new SelectionOverlay();
