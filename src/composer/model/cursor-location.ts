/* Cursor stop enumeration + linear-cursor ↔ insertion-point resolution.
 *
 * Cursor convention: cursor `c` means "past flat[c]" — the cursor sits to the
 * RIGHT of the element at index c. `flat.length` is the synthetic past-end
 * position used to append at the end of the document.
 *
 * The functions here are free-standing and take the model as their first
 * parameter so they can call back into its document-shape queries
 * (allMeasures, layerInMeasure, contentChildren, measureTicks). */

import { realTicks } from './ticks.js';
import {
  isTupletPlaceholder,
  MEI_NS,
  type ComposerModel,
  type Voice,
} from './index.js';

/** Total cursor stops contributed by a voice, in document order.
 *
 *  Stop emission rules:
 *    - Real content (chord/note/rest) at the layer level: each is a stop.
 *    - <tuplet> at the layer level: the wrapper is a stop (the "enter
 *      tuplet" position) PLUS each filled in-tuplet content child is a stop
 *      PLUS the first trailing placeholder (fill anchor) if any.
 *    - Measure wrapper: emitted as a stop iff the previous measure is
 *      incomplete (partial or empty) OR this is M_0. Wrapper for an empty
 *      measure is always emitted (it IS the empty measure's one stop). When
 *      the previous measure is FULL and this measure is non-empty, the
 *      wrapper is NOT emitted — cursor jumps directly from "past last
 *      element of prev" to "past first element of this". This is the
 *      intentional navigational-smoothness tradeoff.
 *
 *  Placeholders (data-placeholder spaces) are never emitted as stops here —
 *  they live entirely for Verovio layout and the fill-anchor concept is
 *  modeled implicitly via cursor-past-last-content of partial measures. */
export function flatChildren(model: ComposerModel, voice: Voice): Element[] {
  const out: Element[] = [];
  const measures = model.allMeasures();
  for (let mi = 0; mi < measures.length; mi++) {
    const measure = measures[mi];
    const layer = model.layerInMeasure(measure, voice);
    if (!layer) continue;
    if (shouldEmitWrapper(model, measures, voice, mi)) out.push(measure);
    out.push(...layerStops(model, layer));
  }
  return out;
}

/** Whether layer's content sums to a full measure (no trailing placeholder
 *  space). */
export function layerIsFull(model: ComposerModel, layer: Element): boolean {
  let total = 0;
  for (const c of model.contentChildren(layer)) total += realTicks(c);
  return total >= model.measureTicks();
}

/** Wrapper emission decision per measure. See flatChildren rules above. */
export function shouldEmitWrapper(
  model: ComposerModel,
  measures: Element[],
  voice: Voice,
  measureIdx: number,
): boolean {
  const thisLayer = model.layerInMeasure(measures[measureIdx], voice);
  if (!thisLayer) return false;
  if (model.contentChildren(thisLayer).length === 0) return true; /* rule 2 */
  if (measureIdx === 0) return true; /* rule 3, nonexistent prev */
  const prevLayer = model.layerInMeasure(measures[measureIdx - 1], voice);
  if (!prevLayer) return true; /* defensive */
  if (model.contentChildren(prevLayer).length === 0) return true; /* prev empty → incomplete → emit */
  if (layerIsFull(model, prevLayer)) return false; /* prev full → no wrapper */
  return true; /* prev partial → emit */
}

/** Cursor stops contributed by a layer: real content elements + tuplet
 *  internal stops. */
export function layerStops(model: ComposerModel, layer: Element): Element[] {
  const out: Element[] = [];
  for (const c of Array.from(layer.children)) {
    const ln = c.localName;
    if (ln === 'tuplet') {
      out.push(c);
      out.push(...tupletNavStops(c));
    } else if (ln === 'chord' || ln === 'note' || ln === 'rest') {
      out.push(c);
    }
  }
  return out;
}

/** In-tuplet nav-stops for a single tuplet:
 *    - Every filled content child (chord/note/rest) is a stop.
 *    - The first trailing placeholder (fill anchor) is a stop iff any
 *      trailing placeholders exist.
 *  Does NOT include the tuplet wrapper itself — that's emitted separately
 *  by `layerStops`. */
export function tupletNavStops(tuplet: Element): Element[] {
  const kids = Array.from(tuplet.children);
  const filled: Element[] = [];
  let firstTrailing: Element | null = null;
  for (const c of kids) {
    if (isTupletPlaceholder(c)) {
      if (firstTrailing === null) firstTrailing = c;
    } else if (
      c.localName === 'note' ||
      c.localName === 'chord' ||
      c.localName === 'rest'
    ) {
      filled.push(c);
    }
  }
  if (firstTrailing) return [...filled, firstTrailing];
  return filled;
}

export type CursorLocation = {
  measureIdx: number;
  layer: Element;
  withinIdx: number;
  inTuplet: { tuplet: Element; tupletChildIdx: number } | null;
};

/** Translate a linear cursor into an insertion point — (measureIdx, layer,
 *  withinIdx, inTuplet) — by anchoring on `flat[linearCursor]` (the element
 *  to the cursor's LEFT under the cursor convention; cursor `c` means
 *  "past flat[c]").
 *
 *  Past-end (cursor === flat.length): returns a synthetic "next-measure
 *  wrapper" location with a fresh empty `<layer>`. The applier in
 *  `insertWithSplit` lazily creates the measure via `appendMeasure` when
 *  the action's `targetMIdx` is beyond the existing measure count. */
export function locateCursor(
  model: ComposerModel,
  voice: Voice,
  linearCursor: number,
): CursorLocation | null {
  const measures = model.allMeasures();
  if (measures.length === 0) return null;
  const flat = flatChildren(model, voice);
  if (linearCursor >= flat.length) {
    return {
      measureIdx: measures.length,
      layer: model.getDoc().createElementNS(MEI_NS, 'layer'),
      withinIdx: 0,
      inTuplet: null,
    };
  }
  const anchor = flat[linearCursor];
  return locationForAnchor(model, anchor, voice, measures);
}

/** Compute insertion location for a given anchor element. Insertion is
 *  "immediately after the anchor" within its containing structure. */
export function locationForAnchor(
  model: ComposerModel,
  anchor: Element,
  voice: Voice,
  measures: Element[],
): CursorLocation | null {
  if (anchor.localName === 'measure') {
    const measureIdx = measures.indexOf(anchor);
    const layer = model.layerInMeasure(anchor, voice);
    if (!layer || measureIdx < 0) return null;
    return { measureIdx, layer, withinIdx: 0, inTuplet: null };
  }
  const tParent = anchor.parentElement;
  if (tParent && tParent.localName === 'tuplet') {
    const measure = tParent.closest('measure') as Element | null;
    if (!measure) return null;
    const measureIdx = measures.indexOf(measure);
    const layer = model.layerInMeasure(measure, voice);
    if (!layer || measureIdx < 0) return null;
    const cc = model.contentChildren(layer);
    /* Exit-tuplet stop: anchor is the LAST in-tuplet nav stop. Cursor's
       "exit-tuplet" position semantically means "past the tuplet" —
       insertion goes at LAYER level past the tuplet, not inside it. */
    const navStops = tupletNavStops(tParent);
    if (navStops.length > 0 && navStops[navStops.length - 1] === anchor) {
      const tIdxInCc = cc.indexOf(tParent);
      return {
        measureIdx,
        layer,
        withinIdx: tIdxInCc >= 0 ? tIdxInCc + 1 : cc.length,
        inTuplet: null,
      };
    }
    const withinIdx = cc.indexOf(tParent);
    const tChildren = Array.from(tParent.children);
    const tIdx = tChildren.indexOf(anchor);
    return {
      measureIdx,
      layer,
      withinIdx,
      inTuplet: { tuplet: tParent, tupletChildIdx: tIdx + 1 },
    };
  }
  /* Layer-level <tuplet> wrapper — the "entered tuplet" cursor stop.
     Insertion goes to the tuplet's first slot. */
  if (anchor.localName === 'tuplet') {
    const measure = anchor.closest('measure') as Element | null;
    if (!measure) return null;
    const measureIdx = measures.indexOf(measure);
    const layer = model.layerInMeasure(measure, voice);
    if (!layer || measureIdx < 0) return null;
    const cc = model.contentChildren(layer);
    const withinIdx = cc.indexOf(anchor);
    return {
      measureIdx,
      layer,
      withinIdx: withinIdx >= 0 ? withinIdx : cc.length,
      inTuplet: { tuplet: anchor, tupletChildIdx: 0 },
    };
  }
  /* Top-level content of some layer (chord/note/rest). */
  const measure = anchor.closest('measure') as Element | null;
  if (!measure) return null;
  const measureIdx = measures.indexOf(measure);
  const layer = model.layerInMeasure(measure, voice);
  if (!layer || measureIdx < 0) return null;
  const cc = model.contentChildren(layer);
  const idx = cc.indexOf(anchor);
  return {
    measureIdx,
    layer,
    withinIdx: idx >= 0 ? idx + 1 : cc.length,
    inTuplet: null,
  };
}

/** Total nav-stops contributed by one (voice, layer) when `emitWrapper`
 *  indicates whether the leading `<measure>` wrapper stop is included. */
export function measureStopCount(
  model: ComposerModel,
  _measures: Element[],
  _voice: Voice,
  _measureIdx: number,
  layer: Element,
  emitWrapper: boolean,
): number {
  let n = emitWrapper ? 1 : 0;
  n += layerStops(model, layer).length;
  return n;
}

/** Locate the navigable element at flat-index `flatIdx`. Returns null when
 *  out of range — no synthetic past-end fallback here. */
export function locateFlatElement(
  model: ComposerModel,
  voice: Voice,
  flatIdx: number,
): CursorLocation | null {
  if (flatIdx < 0) return null;
  const measures = model.allMeasures();
  const flat = flatChildren(model, voice);
  if (flatIdx >= flat.length) return null;
  return locationForAnchor(model, flat[flatIdx], voice, measures);
}
