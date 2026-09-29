// Clef slot addressing (2026-09-27).
//
// A `<clef>` is a zero-duration layer child with NO cursor stop of its own, so
// "the clef at this cursor" has to be derived from the cursor's insertion
// point. This module is the ONE place that derivation lives; every read,
// write and remove of an inline clef goes through `clefSlotAt`.
//
// The subtle position is the barline after a FULL measure M. Two cursors land
// there — "past the last content of M" (whose insertion overflows into M+1)
// and "M+1's wrapper stop" (emitted when M+1 is empty or M is partial) — and
// the clef can be spelled two ways: at the tail of M's layer (after any
// placeholders; what a reload or the old boundary write produced) or at the
// head of M+1's layer (what the wrapper write and the MusicXML importer
// produce; the form every downstream render pass keys on). Both cursors
// resolve to ONE slot whose `existing` lists BOTH spellings, and a fresh
// clef is written in the head-of-M+1 form. Nothing here adds, removes or
// moves a cursor stop.

import type { ComposerModel, Voice } from './index.js';
import { locateCursor, layerIsFull } from './cursor-location.js';

export type ClefSlot =
  | {
      kind: 'slot';
      /** Layer a NEW clef is written into. */
      layer: Element;
      /** Element the new clef goes immediately before; null = append. */
      ref: Element | null;
      /** Index of the measure holding `layer`. */
      measureIdx: number;
      /** Every clef already attached to this position, document order —
       *  at a barline both spellings (M's tail run, then M+1's head run). */
      existing: Element[];
      /** True when the slot is a barline (start of a measure after the first). */
      barline: boolean;
    }
  | {
      kind: 'inTuplet';
      measureIdx: number;
      /** The tuplet the cursor is inside — the walk limit for "clef in effect". */
      limit: Element;
    }
  | { kind: 'pastEnd' };

/** Consecutive `<clef>` siblings immediately before `ref` (or at the very end
 *  of `layer` when `ref` is null), in document order. */
function clefsBefore(layer: Element, ref: Element | null): Element[] {
  const out: Element[] = [];
  let c = ref ? ref.previousElementSibling : layer.lastElementChild;
  for (; c && c.localName === 'clef'; c = c.previousElementSibling) out.unshift(c);
  return out;
}

/** First child after `after` (or from the layer head) that is not a clef —
 *  the placeholder / mRest / content a cursor past `after` inserts before. */
function firstNonClefAfter(layer: Element, after: Element | null): Element | null {
  let c = after ? after.nextElementSibling : layer.firstElementChild;
  for (; c; c = c.nextElementSibling) if (c.localName !== 'clef') return c;
  return null;
}

/** Head-of-layer insertion point + the clefs already there, for a measure
 *  start; `prevLayer`'s trailing clef run is the same barline's other spelling. */
function headSlot(
  model: ComposerModel,
  layer: Element,
  measureIdx: number,
  prevLayer: Element | null,
): Extract<ClefSlot, { kind: 'slot' }> {
  const content = model.contentChildren(layer);
  const ref = content[0] ?? firstNonClefAfter(layer, null);
  const existing = [
    ...(prevLayer ? clefsBefore(prevLayer, null) : []),
    ...clefsBefore(layer, ref),
  ];
  return { kind: 'slot', layer, ref, measureIdx, existing, barline: prevLayer !== null };
}

/** Resolve the clef slot the cursor `cursor` of `voice` addresses. */
export function clefSlotAt(model: ComposerModel, voice: Voice, cursor: number): ClefSlot {
  const loc = locateCursor(model, voice, cursor);
  const measures = model.allMeasures();
  if (!loc || loc.measureIdx >= measures.length) return { kind: 'pastEnd' };
  if (loc.inTuplet) {
    const content = model.contentChildren(loc.layer);
    return { kind: 'inTuplet', measureIdx: loc.measureIdx, limit: content[loc.withinIdx] ?? loc.inTuplet.tuplet };
  }
  const layer = loc.layer;
  const content = model.contentChildren(layer);
  const prevLayer = (): Element | null =>
    loc.measureIdx > 0 ? model.layerInMeasure(measures[loc.measureIdx - 1], voice) : null;

  /* Measure start (the wrapper stop): the head of this layer, plus the
     previous layer's tail run — the other spelling of the same barline. */
  if (loc.withinIdx === 0) return headSlot(model, layer, loc.measureIdx, prevLayer());

  if (loc.withinIdx < content.length) {
    const ref = content[loc.withinIdx];
    return { kind: 'slot', layer, ref, measureIdx: loc.measureIdx, existing: clefsBefore(layer, ref), barline: false };
  }

  /* Past the last content of this layer. */
  const last = content[content.length - 1] ?? null;
  const ref = firstNonClefAfter(layer, last);
  if (ref !== null) {
    /* Partial measure (a placeholder follows): a mid-bar slot at the fill point. */
    return { kind: 'slot', layer, ref, measureIdx: loc.measureIdx, existing: clefsBefore(layer, ref), barline: false };
  }
  /* Nothing follows. A FULL measure's end IS the next barline: address the
     head of M+1 (the same slot its wrapper stop resolves to). With no next
     measure the tail of this layer is the only place a clef can live. */
  if (layerIsFull(model, layer) && loc.measureIdx + 1 < measures.length) {
    const nextLayer = model.layerInMeasure(measures[loc.measureIdx + 1], voice);
    if (nextLayer) return headSlot(model, nextLayer, loc.measureIdx + 1, layer);
  }
  return { kind: 'slot', layer, ref: null, measureIdx: loc.measureIdx, existing: clefsBefore(layer, null), barline: false };
}

/** Whether two resolved slots are the same position (same insertion point). */
export function sameClefSlot(a: ClefSlot, b: ClefSlot): boolean {
  if (a.kind !== 'slot' || b.kind !== 'slot') return false;
  return a.layer === b.layer && a.ref === b.ref;
}
