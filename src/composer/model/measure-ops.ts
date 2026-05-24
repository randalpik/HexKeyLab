/* Measure-range / beat-range clearing operations.
 *
 * `clearBeatRange` clears [tLoAbs, tHiAbs) ticks in one voice's layers,
 * refilling the cleared span with beat-aligned rests. Tuplets that straddle
 * the range must be handled by the caller — the caller is expected to have
 * already validated beat-boundary alignment.
 *
 * `clearMeasureRange` empties all layers of the staves in [firstStaff..
 * lastStaff] across measures [mLo..mHi] inclusive. Control events
 * (<dynam>/<hairpin>) anchored to those measures with matching staff are
 * also removed. */

import { readTimeSig } from '../notation/beams.js';
import { realTicks } from './ticks.js';
import { decomposeBeatAlignedRests } from './restfill.js';
import { normalizeTies } from './ties.js';
import { normalizePlaceholders } from './placeholders.js';
import { el, newId, type ComposerModel, type Voice } from './index.js';

export function clearBeatRange(
  model: ComposerModel,
  voice: Voice,
  tLoAbs: number,
  tHiAbs: number,
): void {
  if (tHiAbs <= tLoAbs) return;
  const measures = model.allMeasures();
  const cap = model.measureTicks();
  const doc = model.getDoc();
  const ts = readTimeSig(doc);
  for (let mi = 0; mi < measures.length; mi++) {
    const measureStart = mi * cap;
    const measureEnd = measureStart + cap;
    if (measureEnd <= tLoAbs) continue;
    if (measureStart >= tHiAbs) break;
    const layer = model.layerInMeasure(measures[mi], voice);
    if (!layer) continue;
    const tLoIn = Math.max(0, tLoAbs - measureStart);
    const tHiIn = Math.min(cap, tHiAbs - measureStart);
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
    /* Refill removed span with beat-aligned rests. */
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
  model.setBarlines();
  normalizeTies(model);
  normalizePlaceholders(doc, model.measureTicks());
  for (let vi: Voice = 1; vi <= 4; vi = (vi + 1) as Voice) {
    model.setCursor(Math.min(model.getCursor(vi), model.getVoiceLength(vi)), vi);
    if (vi === 4) break;
  }
}

export function clearMeasureRange(
  model: ComposerModel,
  mLo: number,
  mHi: number,
  firstStaff: 1 | 2,
  lastStaff: 1 | 2,
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
  normalizePlaceholders(model.getDoc(), model.measureTicks());
  /* Clamp out-of-range cursors after wholesale measure-clearing. */
  for (let vi: Voice = 1; vi <= 4; vi = (vi + 1) as Voice) {
    model.setCursor(Math.min(model.getCursor(vi), model.getVoiceLength(vi)), vi);
    if (vi === 4) break;
  }
}

