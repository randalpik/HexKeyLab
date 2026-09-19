/* Tuplet-specific entry points: cursor predicates and tuplet creation. */

import { realTicks, writtenTicks } from './ticks.js';
import { locateCursor, type CursorLocation } from './cursor-location.js';
import { buildTupletPlaceholder } from './note-elements.js';
import { planInsert, insertAt } from './insertion-plan.js';
import {
  el,
  newId,
  isTupletPlaceholder,
  ticksOf,
  type ComposerModel,
  type Voice,
  type Duration,
  type Dots,
} from './index.js';

/** True when the voice's cursor sits inside a <tuplet> per the "between" rule
 *  (insert-mode interpretation): cursor on a tuplet placeholder OR between
 *  two children of the same tuplet. The layer-edge position (visually
 *  anchored to pre-tuplet content) is NOT inside. */
export function isCursorInTuplet(model: ComposerModel, voice?: Voice): boolean {
  const v = voice ?? model.getCurrentVoice();
  const loc = locateCursor(model, v, model.getCursor(v));
  return !!(loc && loc.inTuplet);
}

/** Remaining written-ticks of trailing placeholders in the tuplet at the
 *  cursor. Null when the cursor is not in a tuplet. */
export function cursorTupletRemainingWrittenTicks(
  model: ComposerModel,
  voice?: Voice,
): number | null {
  const v = voice ?? model.getCurrentVoice();
  const loc = locateCursor(model, v, model.getCursor(v));
  if (!loc || !loc.inTuplet) return null;
  let total = 0;
  for (const c of Array.from(loc.inTuplet.tuplet.children)) {
    if (isTupletPlaceholder(c)) total += writtenTicks(c);
  }
  return total;
}

/** Pre-flight check for insertChordAtCursor / insertRestAtCursor that
 *  surfaces a specific rejection reason when the duration cannot fit:
 *    - "Doesn't fit in remaining tuplet space." — cursor inside a tuplet
 *      and duration exceeds trailing-placeholder budget.
 *    - "Insertion would push tuplet across bar line." — cursor at layer
 *      level, but a tuplet at/after the cursor would be displaced past
 *      the bar by the new note.
 *  Otherwise returns `{ ok: true }`. Callers should consult this first;
 *  the insert methods themselves still defensively reject on overflow. */
export function canInsertHere(
  model: ComposerModel,
  duration: Duration,
  dots: Dots = 0,
): { ok: true } | { ok: false; reason: string } {
  const v = model.getCurrentVoice();
  const cursor = model.getCursor(v);
  const loc = locateCursor(model, v, cursor);
  if (!loc) return { ok: false, reason: 'No layer at cursor.' };
  const totalTicks = ticksOf(duration, dots);

  if (loc.inTuplet) {
    let remaining = 0;
    for (const c of Array.from(loc.inTuplet.tuplet.children)) {
      if (isTupletPlaceholder(c)) remaining += writtenTicks(c);
    }
    if (totalTicks > remaining) {
      return { ok: false, reason: "Doesn't fit in remaining tuplet space." };
    }
    return { ok: true };
  }

  const plan = planInsert(
    model,
    { measureIdx: loc.measureIdx, layer: loc.layer, withinIdx: loc.withinIdx },
    totalTicks,
  );
  if (!plan.ok) return { ok: false, reason: plan.reason };
  return { ok: true };
}

/** Where an ATOMIC layer-level element (a <tuplet>) goes for a given cursor
 *  location, plus the tick budget at that spot.
 *
 *  Why this exists: the stop "past the last element of measure M" is
 *  AMBIGUOUS whenever M is full. `shouldEmitWrapper` suppresses M+1's
 *  wrapper stop exactly when M is full (cursor-location.ts), so that one
 *  stop denotes both "end of M" and "head of M+1" — pressing -> from it
 *  lands inside M+1's content. The M-side reading has ZERO remaining
 *  capacity and therefore can never host anything, so the M+1 reading is
 *  the only viable one and we re-read the location there.
 *
 *  This is a re-reading of an ambiguous cursor, NOT bar-line overflow: the
 *  spill happens only from the true end of a FULL measure. A partial
 *  measure still emits its own M+1 wrapper stop, so its end is not
 *  ambiguous — a tuplet that doesn't fit there is simply rejected, and the
 *  user steps to the next stop to place it in M+1. (Notes differ: they may
 *  be split and tied across the bar line, so `planInsert` gives them real
 *  bounded overflow. A tuplet is atomic and can never straddle a bar.)
 *
 *  `layer` is null when the target measure doesn't exist yet; the caller
 *  materializes it with `appendMeasure` AFTER the fit test passes, so a
 *  rejected tuplet never leaves a stray empty measure behind. */
export type TupletTarget = {
  measureIdx: number;
  layer: Element | null;
  withinIdx: number;
  /** Ticks already occupied before the insertion point in the target measure. */
  usedBefore: number;
  /** Ticks of target-measure content AT or AFTER the insertion point. */
  postTicks: number;
  /** The target measure's tick budget. */
  cap: number;
  /** True when the location was re-read as the head of the next measure. */
  spilled: boolean;
};

export function resolveTupletTarget(
  model: ComposerModel,
  voice: Voice,
  loc: CursorLocation,
): TupletTarget {
  const capM0 = model.measureTicksAt(loc.measureIdx);
  const cc0 = model.contentChildren(loc.layer);
  const usedBefore = model.timeWithinMeasure(voice, loc.measureIdx, loc.withinIdx);
  const atMeasureEnd = loc.withinIdx >= cc0.length;

  /* Unambiguous stop: stay put. Counting post-cursor content here is what
     keeps a mid-measure tuplet from silently overfilling the bar. */
  if (!atMeasureEnd || capM0 - usedBefore > 1e-6) {
    let postTicks = 0;
    for (let i = loc.withinIdx; i < cc0.length; i++) postTicks += realTicks(cc0[i]);
    return {
      measureIdx: loc.measureIdx,
      layer: loc.layer,
      withinIdx: loc.withinIdx,
      usedBefore,
      postTicks,
      cap: capM0,
      spilled: false,
    };
  }

  /* Truly past the last moment of a full measure → head of the next one. */
  const mi = loc.measureIdx + 1;
  const layers = model.allLayers(voice);
  const layer = mi < layers.length ? layers[mi] : null;
  let postTicks = 0;
  if (layer) {
    for (const c of model.contentChildren(layer)) postTicks += realTicks(c);
  }
  return {
    measureIdx: mi,
    layer,
    withinIdx: 0,
    usedBefore: 0,
    postTicks,
    cap: model.measureTicksAt(mi),
    spilled: true,
  };
}

/** Create a new <tuplet> at the cursor and step the cursor onto its first
 *  placeholder (the fill anchor). Builds `num` placeholder slots of
 *  `atomicDur`. Rejects if the tuplet's real-time span doesn't fit in the
 *  remaining ticks of the current measure, or if the cursor is already
 *  inside a tuplet (no nesting in v1). Returns the tuplet's xml:id on
 *  success, an error reason on rejection. */
export function createTupletAtCursor(
  model: ComposerModel,
  opts: {
    num: number;
    numbase: number;
    spanDur: Duration;
    spanDots: Dots;
    atomicDur: Duration;
  },
): { ok: true; id: string } | { ok: false; reason: string } {
  const { num, numbase, spanDur, spanDots, atomicDur } = opts;
  const v = model.getCurrentVoice();
  const cursor = model.getCursor(v);
  const loc = locateCursor(model, v, cursor);
  if (!loc) return { ok: false, reason: 'no layer at cursor' };
  if (loc.inTuplet) return { ok: false, reason: 'cannot nest tuplets' };

  const spanTicks = ticksOf(spanDur, spanDots);
  /* A tuplet is atomic: it lands whole in exactly ONE measure and needs free
     room there. The only subtlety is that the end-of-full-measure stop names
     two locations — see resolveTupletTarget. */
  const target = resolveTupletTarget(model, v, loc);
  if (target.usedBefore + spanTicks + target.postTicks > target.cap + 1e-6) {
    return {
      ok: false,
      reason: target.spilled
        ? "Tuplet doesn't fit in the next measure."
        : 'Tuplet span exceeds remaining measure space',
    };
  }

  /* Sanity check: num atomic written-ticks scaled by numbase/num must
     equal spanTicks. (Constructs a tuplet whose internal math is sound.) */
  const atomicWritten = ticksOf(atomicDur, 0);
  const computedSpan = (num * atomicWritten * numbase) / num;
  if (Math.abs(computedSpan - spanTicks) > 1e-6) {
    return { ok: false, reason: 'tuplet ratio/atomic mismatch with span' };
  }

  const doc = model.getDoc();
  const tuplet = el(doc, 'tuplet', {
    'xml:id': newId('t'),
    num: String(num),
    numbase: String(numbase),
    /* No `bracket.visible`: Verovio then draws the bracket only when the
       tuplet is not wholly under one beam — a beamed triplet gets its number
       alone (Max, 2026-09-05: no brackets on full beams). An explicit "true"
       forced the bracket onto beams; `replaceDocument` strips it from older
       files. */
    'num.visible': 'true',
    'num.format': 'count',
  });
  /* Record the atomic so that `regenTupletPlaceholders` can preserve
     the atomic structure across fill/delete (perfectly reversible). */
  tuplet.setAttribute('data-tuplet-atomic-dur', atomicDur);
  for (let i = 0; i < num; i++) {
    tuplet.appendChild(buildTupletPlaceholder(doc, atomicDur, 0));
  }

  /* Fit test passed — safe to materialize the target measure now. */
  let targetLayer = target.layer;
  if (!targetLayer) {
    while (model.allMeasures().length <= target.measureIdx) model.appendMeasure();
    targetLayer = model.allLayers(v)[target.measureIdx] ?? null;
    if (!targetLayer) return { ok: false, reason: 'no layer in target measure' };
  }

  insertAt(model, targetLayer, tuplet, target.withinIdx);
  model.normalizePlaceholdersAll();
  model.setBarlines();
  /* Seat the cursor on the "entered tuplet" stop (= past the tuplet wrapper).
     Resolved by id rather than +1: when the location was re-read into the
     next measure the wrapper is not simply the following stop. */
  const tupletId = tuplet.getAttribute('xml:id') ?? '';
  const flat = model.flatChildren(v);
  const idx = flat.findIndex((e) => e.getAttribute('xml:id') === tupletId);
  if (idx >= 0) model.setCursor(idx, v);
  else model.setCursor(Math.min(model.getCursor(v) + 1, model.getVoiceLength(v)), v);
  return { ok: true, id: tupletId };
}
