/* Measure-range / beat-range clearing operations.
 *
 * `clearBeatRange` clears [tLoAbs, tHiAbs) ticks in one voice's layers,
 * refilling the cleared span with beat-aligned rests — EXCEPT in a measure the
 * span covers entirely, which is left bare for `normalizePlaceholders` to turn
 * into the empty cell (Max, 2026-09-17: emptying a whole bar in beat mode must
 * leave it empty, same as emptying it from measure selection). Tuplets that
 * straddle the range must be handled by the caller — the caller is expected to
 * have already validated beat-boundary alignment.
 *
 * `clearMeasureRange` empties all layers of the staves in [firstStaff..
 * lastStaff] across measures [mLo..mHi] inclusive. Control events
 * (<dynam>/<hairpin>) anchored to those measures with matching staff are
 * also removed. */

import { readTimeSig } from '../notation/beams.js';
import { realTicks } from './ticks.js';
import { decomposeBeatAlignedRests } from './restfill.js';
import { normalizeTies } from './ties.js';
import { isPlaceholder } from './placeholders.js';
import { el, newId, type ComposerModel, type Voice } from './index.js';

export function clearBeatRange(
  model: ComposerModel,
  voice: Voice,
  tLoAbs: number,
  tHiAbs: number,
): void {
  if (tHiAbs <= tLoAbs) return;
  const measures = model.allMeasures();
  const doc = model.getDoc();
  const ts = readTimeSig(doc);
  for (let mi = 0; mi < measures.length; mi++) {
    const cap = model.measureTicksAt(mi);
    const measureStart = model.measureStartTick(mi);
    const measureEnd = measureStart + cap;
    if (measureEnd <= tLoAbs) continue;
    if (measureStart >= tHiAbs) break;
    const layer = model.layerInMeasure(measures[mi], voice);
    if (!layer) continue;
    const tLoIn = Math.max(0, tLoAbs - measureStart);
    const tHiIn = Math.min(cap, tHiAbs - measureStart);
    /* Does the cleared span cover this measure ENTIRELY for this voice? Then
       the cell reverts to the EMPTY PLACEHOLDER instead of being refilled with
       rests (Max, backlog Composer/Features — 2026-09-17): a bar the user just
       emptied should read as empty, exactly as it does when the same bar is
       cleared from MEASURE selection (`clearMeasureRange` has always left the
       layer bare for `normalizePlaceholders`). Selection MODE was deciding
       what the document says, which is the part that was wrong — beat mode is
       how you point at a bar, not a statement that you want rests in it.
       Partial spans still refill: rests are what a hole inside a bar means.
       The test is on TICKS, not on "did we remove everything", so a bar that
       was only part-full (one quarter plus trailing placeholder) also comes
       out empty rather than keeping a stray quarter rest at its head — the
       refill is sized by `removedTicks`, which counts only the content that
       was actually there. */
    const clearsWholeMeasure = tLoIn <= 1e-6 && tHiIn >= cap - 1e-6;
    /* Walk content children; collect those fully inside [tLoIn, tHiIn). */
    let cursor = 0;
    const toRemove: Element[] = [];
    for (const c of model.contentChildren(layer)) {
      const dur = realTicks(c);
      const cEnd = cursor + dur;
      if (cursor >= tLoIn - 1e-6 && cEnd <= tHiIn + 1e-6) {
        toRemove.push(c);
      }
      cursor = cEnd;
    }
    if (toRemove.length === 0) continue;
    const firstToRemove = toRemove[0];
    const cc = model.contentChildren(layer);
    const insertIdx = cc.indexOf(firstToRemove);
    /* Compute actual removed-range tick span. */
    let removedTicks = 0;
    for (const r of toRemove) {
      model.orphanTiePartners(r);
      removedTicks += realTicks(r);
    }
    for (const r of toRemove) {
      r.parentNode?.removeChild(r);
    }
    /* Refill removed span with beat-aligned rests — unless the whole measure
       went, in which case the layer is left bare and `normalizePlaceholders`
       below turns it into the empty cell. */
    if (!clearsWholeMeasure) {
      const rests = decomposeBeatAlignedRests(tLoIn, removedTicks, ts);
      const insertBefore = model.contentChildren(layer)[insertIdx] ?? null;
      for (const r of rests) {
        const restEl = el(doc, 'rest', {
          'xml:id': newId('r'),
          dur: r.dur,
          dots: r.dots > 0 ? r.dots : undefined,
        });
        if (insertBefore) layer.insertBefore(restEl, insertBefore);
        else layer.appendChild(restEl);
      }
    }
  }
  model.setBarlines();
  normalizeTies(model);
  model.normalizePlaceholdersAll();
  for (let vi = 1; vi <= model.totalVoices(); vi++) {
    model.setCursor(Math.min(model.getCursor(vi), model.getVoiceLength(vi)), vi);
  }
}

export function clearMeasureRange(
  model: ComposerModel,
  mLo: number,
  mHi: number,
  firstStaff: number,
  lastStaff: number,
): void {
  const measures = model.allMeasures();
  for (let mi = Math.max(0, mLo); mi <= mHi && mi < measures.length; mi++) {
    const m = measures[mi];
    /* Clear staves in range. */
    for (const staff of Array.from(m.querySelectorAll('staff'))) {
      const sn = parseInt(staff.getAttribute('n') ?? '0', 10);
      if (sn < firstStaff || sn > lastStaff) continue;
      for (const layer of Array.from(staff.querySelectorAll('layer'))) {
        for (const c of Array.from(layer.children)) {
          const ln = c.localName;
          if (
            ln === 'chord' ||
            ln === 'note' ||
            ln === 'rest' ||
            ln === 'tuplet' ||
            ln === 'space'
          ) {
            model.orphanTiePartners(c);
            layer.removeChild(c);
          }
        }
      }
    }
    /* Remove control events anchored to this measure for the staff range. */
    for (const ctrl of Array.from(m.children)) {
      const ln = ctrl.localName;
      if (ln !== 'dynam' && ln !== 'hairpin') continue;
      const sn = parseInt(ctrl.getAttribute('staff') ?? '0', 10);
      if (sn >= firstStaff && sn <= lastStaff) {
        m.removeChild(ctrl);
      }
    }
  }
  model.setBarlines();
  normalizeTies(model);
  model.normalizePlaceholdersAll();
  /* Clamp out-of-range cursors after wholesale measure-clearing. */
  for (let vi = 1; vi <= model.totalVoices(); vi++) {
    model.setCursor(Math.min(model.getCursor(vi), model.getVoiceLength(vi)), vi);
  }
}


/* ── move a voice's whole measures to its partner voice ────────────────────
 * Correcting notes entered into the wrong voice, which is easy to do (Max,
 * backlog Composer/Features — 2026-09-17). Driven from a BEAT selection: the
 * measures the selection covers ENTIRELY and that actually hold something move
 * to the other voice on the same staff, provided that voice is free in each of
 * them. Anything less is an error rather than a partial result — this exists to
 * undo a mistake, so it must not create a second, subtler one. */

export type VoiceMoveResult =
  | { ok: true; movedMeasures: number[]; toVoice: Voice }
  | { ok: false; reason: string };

/** True when a layer holds nothing but placeholder `<space>`s — the state
 *  `normalizePlaceholders` leaves an empty cell in. Stricter than
 *  `layerIsEmpty` (model/empty-flags.ts), which also calls a layer holding an
 *  `<mRest>` empty: an `<mRest>` is a written whole-measure rest, so moving
 *  notes on top of one would produce a measure with both. */
function holdsOnlyPlaceholders(layer: Element): boolean {
  for (let c = layer.firstElementChild; c; c = c.nextElementSibling) {
    if (!isPlaceholder(c)) return false;
  }
  return true;
}

/** Printed number of a measure, for error messages — `@n`, so a pickup reads
 *  as 0 and everything after it matches what the user sees. */
function measureLabel(measure: Element, idx: number): string {
  return measure.getAttribute('n') ?? String(idx + 1);
}

export function moveFullMeasuresToSiblingVoice(
  model: ComposerModel,
  voice: Voice,
  tLoAbs: number,
  tHiAbs: number,
): VoiceMoveResult {
  const target = model.siblingVoiceOf(voice);
  if (target === null) {
    return { ok: false, reason: 'Voice ' + voice + ' has no partner voice on its staff.' };
  }
  const measures = model.allMeasures();
  /* Measures the span covers in FULL — the same tick test `clearBeatRange`
     uses to decide that a bar was emptied outright. */
  const whole: number[] = [];
  for (let mi = 0; mi < measures.length; mi++) {
    const cap = model.measureTicksAt(mi);
    const start = model.measureStartTick(mi);
    if (start + cap <= tLoAbs) continue;
    if (start >= tHiAbs) break;
    if (start >= tLoAbs - 1e-6 && start + cap <= tHiAbs + 1e-6) whole.push(mi);
  }
  if (!whole.length) {
    return { ok: false, reason: 'Select at least one whole measure to move it to the other voice.' };
  }
  /* Only measures that actually carry something move; a fully-selected but
     empty bar is a no-op, not a failure, and must not make the destination
     check fail for a bar nothing would be written into. */
  const move: number[] = [];
  for (const mi of whole) {
    const src = model.layerInMeasure(measures[mi], voice);
    if (src && !holdsOnlyPlaceholders(src)) move.push(mi);
  }
  if (!move.length) {
    return { ok: false, reason: 'Nothing to move — voice ' + voice + ' is empty in the selected measures.' };
  }
  /* The destination must be free in every measure we would write into. */
  for (const mi of move) {
    const dst = model.layerInMeasure(measures[mi], target);
    if (!dst) {
      return { ok: false, reason: 'Voice ' + target + ' has no layer in measure ' + measureLabel(measures[mi], mi) + '.' };
    }
    if (!holdsOnlyPlaceholders(dst)) {
      return {
        ok: false,
        reason: 'Voice ' + target + ' already has content in measure ' + measureLabel(measures[mi], mi) + '.',
      };
    }
  }
  for (const mi of move) {
    const src = model.layerInMeasure(measures[mi], voice) as Element;
    const dst = model.layerInMeasure(measures[mi], target) as Element;
    /* Drop the destination's placeholders, then hand over the source's own
       children in order. The elements MOVE — same `xml:id`s — so ties, slurs
       and anything else addressing them by id stays resolved; only their layer
       changes. Placeholders on either side are dropped and rebuilt by
       `normalizePlaceholdersAll` below. */
    for (const c of Array.from(dst.children)) dst.removeChild(c);
    for (const c of Array.from(src.children)) {
      src.removeChild(c);
      if (!isPlaceholder(c)) dst.appendChild(c);
    }
  }
  model.setBarlines();
  normalizeTies(model);
  model.normalizePlaceholdersAll();
  for (let vi = 1; vi <= model.totalVoices(); vi++) {
    model.setCursor(Math.min(model.getCursor(vi), model.getVoiceLength(vi)), vi);
  }
  return { ok: true, movedMeasures: move, toVoice: target };
}
