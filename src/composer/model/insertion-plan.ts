/* Layer-level insertion with bounded measure-1 overflow.
 *
 * `planInsert` produces a sequence of {inserted, reuse} actions describing
 * how the inserted note's chunks and the displaced post-cursor content get
 * packed across M_0 (the cursor's measure) and M_1 (the next measure).
 * Never cascades past M_1.
 *
 * `insertWithSplit` is the entry point used by insertChordAtCursor and
 * insertRestAtCursor; it routes in-tuplet vs. layer-level inserts and
 * applies the plan from `planInsert`. */

import type { ResolvedNote } from '../../bridge/protocol.js';
import { realTicks, writtenTicks } from './ticks.js';
import { locateCursor } from './cursor-location.js';
import {
  buildChordElement,
  buildRestElement,
  regenTupletPlaceholders,
  extractNoteElements,
} from './note-elements.js';
import { setTieFlag } from './ties.js';
import {
  isTupletPlaceholder,
  ticksOf,
  decomposeTicks,
  type ComposerModel,
  type Duration,
  type Dots,
} from './index.js';

export type InsertAction =
  | {
      kind: 'inserted';
      dur: Duration;
      dots: Dots;
      targetMIdx: number;
      pieceIdx: number;
      pieceCount: number;
    }
  | { kind: 'reuse'; el: Element; targetMIdx: number };

/** Plan a layer-level insert with BOUNDED overflow into the immediate next
 *  measure only. See the comment block above for the placement rules. */
export function planInsert(
  model: ComposerModel,
  loc: { measureIdx: number; layer: Element; withinIdx: number },
  totalTicks: number,
):
  | { ok: true; actions: InsertAction[]; evicted: Map<number, Element[]> }
  | { ok: false; reason: string } {
  const v = model.getCurrentVoice();
  const cap = model.measureTicks();
  const layers = model.allLayers(v);
  const M0 = loc.measureIdx;
  const W0 = loc.withinIdx;
  const usedBefore = model.timeWithinMeasure(v, M0, W0);
  const postCursorM0 = model.contentChildren(loc.layer).slice(W0);

  let postCursorTicks = 0;
  for (const el of postCursorM0) postCursorTicks += realTicks(el);

  const evicted = new Map<number, Element[]>();
  const actions: InsertAction[] = [];

  /* Fast path: everything fits in M_0. */
  if (usedBefore + totalTicks + postCursorTicks <= cap) {
    const insertedRecorded: Array<Extract<InsertAction, { kind: 'inserted' }>> = [];
    for (const p of decomposeTicks(totalTicks)) {
      const a: Extract<InsertAction, { kind: 'inserted' }> = {
        kind: 'inserted',
        dur: p.dur,
        dots: p.dots,
        targetMIdx: M0,
        pieceIdx: insertedRecorded.length,
        pieceCount: 0,
      };
      insertedRecorded.push(a);
      actions.push(a);
    }
    for (const a of insertedRecorded) a.pieceCount = insertedRecorded.length;
    return { ok: true, actions, evicted };
  }

  /* Overflow path. Determine M_1 and its existing content (if any). */
  const M1 = M0 + 1;
  let postM1: Element[] = [];
  if (M1 < layers.length) {
    postM1 = model.contentChildren(layers[M1]);
  }
  let postM1Ticks = 0;
  for (const el of postM1) postM1Ticks += realTicks(el);

  if (usedBefore + totalTicks + postCursorTicks + postM1Ticks > 2 * cap) {
    return { ok: false, reason: "Doesn't fit in next measure." };
  }

  evicted.set(M0, postCursorM0);
  if (postM1.length > 0) evicted.set(M1, postM1);

  /* Place inserted-note pieces, splitting on the M_0/M_1 bar line. Never
     crosses into M_1+1 (block on overflow). */
  const insertedRecorded: Array<Extract<InsertAction, { kind: 'inserted' }>> = [];
  let mIdx = M0;
  let mOff = usedBefore;
  let insertedRemaining = totalTicks;
  while (insertedRemaining > 0) {
    const space = cap - mOff;
    const chunk = Math.min(insertedRemaining, space);
    if (chunk > 0) {
      for (const p of decomposeTicks(chunk)) {
        const a: Extract<InsertAction, { kind: 'inserted' }> = {
          kind: 'inserted',
          dur: p.dur,
          dots: p.dots,
          targetMIdx: mIdx,
          pieceIdx: insertedRecorded.length,
          pieceCount: 0,
        };
        insertedRecorded.push(a);
        actions.push(a);
      }
      mOff += chunk;
      insertedRemaining -= chunk;
    }
    if (insertedRemaining > 0) {
      if (mIdx >= M1) {
        return { ok: false, reason: "Doesn't fit in next measure." };
      }
      mIdx = M1;
      mOff = 0;
    }
  }
  for (const a of insertedRecorded) a.pieceCount = insertedRecorded.length;

  /* Pack the displaced stream (M_0 post-cursor + M_1 existing) wholesale.
     Tuplets are atomic — either fit in the current target measure or bump
     to M_1; bump beyond M_1 is the block condition. */
  const displaced = [...postCursorM0, ...postM1];
  for (const el of displaced) {
    const t = realTicks(el);
    if (t > cap) {
      return {
        ok: false,
        reason:
          el.localName === 'tuplet'
            ? 'Tuplet too large for measure.'
            : "Doesn't fit.",
      };
    }
    if (mOff + t > cap) {
      if (mIdx >= M1) {
        return { ok: false, reason: "Doesn't fit in next measure." };
      }
      mIdx = M1;
      mOff = 0;
    }
    actions.push({ kind: 'reuse', el, targetMIdx: mIdx });
    mOff += t;
  }

  return { ok: true, actions, evicted };
}

/** Insert a chord or rest at the current cursor. Handles in-tuplet inserts
 *  (consume trailing placeholders, never cross the tuplet boundary) and
 *  layer-level inserts (route through planInsert).
 *
 *  For chord inserts when input.notes.length > 0, splits notes-identical
 *  pieces with ties wired by setTieFlag (forward INTENT only; the
 *  data-tie-partner forward links are derived later by normalizeTies from
 *  flat-order adjacency).
 *
 *  Returns the first new element's xml:id, or null when an in-tuplet
 *  insert was rejected for overflow. */
export function insertWithSplit(
  model: ComposerModel,
  input: {
    duration: Duration;
    dots?: Dots;
    notes: ReadonlyArray<ResolvedNote>;
  },
  isRest: boolean,
): string | null {
  const v = model.getCurrentVoice();
  const cursor = model.getCursor(v);
  const loc = locateCursor(model, v, cursor);
  if (!loc) throw new Error('no layer at cursor');
  const doc = model.getDoc();

  /* In-tuplet branch: consume trailing placeholders to fit the new element.
     Never splits across measure boundaries — the tuplet's written-tick
     budget is fixed and any overflow rejects outright (returns null). */
  if (loc.inTuplet) {
    const totalTicks = ticksOf(input.duration, input.dots ?? 0);
    const { tuplet, tupletChildIdx } = loc.inTuplet;
    const tKids = Array.from(tuplet.children);
    /* Find the trailing placeholder run. Per the [filled*, placeholder*]
       invariant, placeholders are always contiguous at the tail. */
    let placeholderStart = tKids.length;
    for (let i = 0; i < tKids.length; i++) {
      if (isTupletPlaceholder(tKids[i])) {
        placeholderStart = i;
        break;
      }
    }
    let trailingTicks = 0;
    for (let i = placeholderStart; i < tKids.length; i++) {
      trailingTicks += writtenTicks(tKids[i]);
    }
    if (totalTicks > trailingTicks) return null; /* overflow — reject */

    const element = isRest
      ? buildRestElement(doc, { duration: input.duration, dots: input.dots })
      : buildChordElement(doc, {
          notes: input.notes,
          duration: input.duration,
          dots: input.dots,
        });

    /* Remove all trailing placeholders. */
    for (let i = tKids.length - 1; i >= placeholderStart; i--) {
      tuplet.removeChild(tKids[i]);
    }
    /* Insert position: if the cursor was on the fill anchor (placeholder),
       insertion happens at the tail (= placeholderStart). If the cursor
       was on a filled child, insertion happens before that child. */
    const insertPos = Math.min(tupletChildIdx, placeholderStart);
    const remainingKids = Array.from(tuplet.children);
    const insertBefore = remainingKids[insertPos] ?? null;
    if (insertBefore) tuplet.insertBefore(element, insertBefore);
    else tuplet.appendChild(element);

    /* Refill placeholder remainder, preferring atomic-sized rests. */
    for (const p of regenTupletPlaceholders(doc, tuplet, trailingTicks - totalTicks)) {
      tuplet.appendChild(p);
    }

    model.setCursor(Math.min(model.getCursor(v) + 1, model.getVoiceLength(v)), v);
    return element.getAttribute('xml:id') ?? '';
  }

  /* Layer-level branch. */
  const totalTicks = ticksOf(input.duration, input.dots ?? 0);
  const plan = planInsert(model, loc, totalTicks);
  if (!plan.ok) return null;

  /* Apply: lift evicted elements out of their source measures. */
  for (const [m, els] of plan.evicted) {
    const measures = model.allMeasures();
    if (m >= measures.length) continue;
    const sourceLayer = model.layerInMeasure(measures[m], v);
    if (!sourceLayer) continue;
    for (const e of els) sourceLayer.removeChild(e);
  }

  /* Walk the plan, building/reusing elements at their target positions. */
  const withinByMeasure = new Map<number, number>();
  const insertedElements: Element[] = [];
  let firstInsertedElement: Element | null = null;

  for (const action of plan.actions) {
    let measures = model.allMeasures();
    while (action.targetMIdx >= measures.length) {
      model.appendMeasure();
      measures = model.allMeasures();
    }
    const targetLayer = model.layerInMeasure(measures[action.targetMIdx], v);
    if (!targetLayer) throw new Error('layer not found in target measure');
    const widx =
      withinByMeasure.get(action.targetMIdx) ??
      (action.targetMIdx === loc.measureIdx ? loc.withinIdx : 0);

    let placed: Element;
    if (action.kind === 'inserted') {
      placed = isRest
        ? buildRestElement(doc, { duration: action.dur, dots: action.dots })
        : buildChordElement(doc, {
            notes: input.notes,
            duration: action.dur,
            dots: action.dots,
          });
      insertedElements.push(placed);
      if (firstInsertedElement === null) firstInsertedElement = placed;
    } else {
      placed = action.el;
    }
    insertAt(model, targetLayer, placed, widx);
    withinByMeasure.set(action.targetMIdx, widx + 1);
  }

  /* Tie wiring on the inserted note's pieces (skipped for rests). We only
   * set the @tie INTENT on each piece; the @data-tie-partner forward links
   * are derived by normalizeTies from flat-order adjacency. */
  if (!isRest && insertedElements.length > 1) {
    for (let pi = 0; pi < insertedElements.length; pi++) {
      const innerNotes = extractNoteElements(insertedElements[pi]);
      const flag: 'i' | 'm' | 't' =
        pi === 0 ? 'i' : pi === insertedElements.length - 1 ? 't' : 'm';
      for (const n of innerNotes) setTieFlag(n, flag);
    }
  }

  model.setBarlines();
  /* Position the cursor just past the last inserted-from-input element.
     Under the cursor-index convention (cursor c = past flat[c]), "past
     the last inserted element flat[idx]" is c = idx. */
  if (insertedElements.length > 0) {
    const lastInserted = insertedElements[insertedElements.length - 1];
    const lastId = lastInserted.getAttribute('xml:id');
    if (lastId) {
      const flat = model.flatChildren(v);
      const idx = flat.findIndex((e) => e.getAttribute('xml:id') === lastId);
      if (idx >= 0) model.setCursor(idx, v);
    }
  }
  return firstInsertedElement?.getAttribute('xml:id') ?? '';
}

/** Insert `child` at the content-child index `index` of `parent`. Uses
 *  contentChildren so the index excludes placeholders. */
export function insertAt(
  model: ComposerModel,
  parent: Element,
  child: Element,
  index: number,
): void {
  const kids = model.contentChildren(parent);
  if (index >= kids.length) parent.appendChild(child);
  else parent.insertBefore(child, kids[index]);
}
