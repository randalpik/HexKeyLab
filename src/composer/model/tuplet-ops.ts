/* Tuplet-specific entry points: cursor predicates and tuplet creation. */

import { writtenTicks } from './ticks.js';
import { locateCursor } from './cursor-location.js';
import { normalizePlaceholders } from './placeholders.js';
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
  const usedBefore = model.timeWithinMeasure(v, loc.measureIdx, loc.withinIdx);
  const remaining = model.measureTicks() - usedBefore;
  if (spanTicks > remaining) {
    return {
      ok: false,
      reason: 'Tuplet span exceeds remaining measure space',
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
    'bracket.visible': 'true',
    'num.visible': 'true',
    'num.format': 'count',
  });
  /* Record the atomic so that `regenTupletPlaceholders` can preserve
     the atomic structure across fill/delete (perfectly reversible). */
  tuplet.setAttribute('data-tuplet-atomic-dur', atomicDur);
  for (let i = 0; i < num; i++) {
    tuplet.appendChild(buildTupletPlaceholder(doc, atomicDur, 0));
  }

  insertAt(model, loc.layer, tuplet, loc.withinIdx);
  normalizePlaceholders(doc, model.measureTicks());
  /* Advance cursor by +1 to land on the "entered tuplet" stop (= past
     the tuplet wrapper). */
  model.setCursor(Math.min(model.getCursor(v) + 1, model.getVoiceLength(v)), v);
  return { ok: true, id: tuplet.getAttribute('xml:id') ?? '' };
}
