/* Per-voice navigation/tick index — the "static, atomically modifiable" core.
 *
 * The model used to recompute cursor-stop enumeration and tick positions on
 * every query: `getTickPositionAt` rebuilt `flatChildren` (O(n)) and called
 * `locateCursor` (O(c)) per call, so `measureBoundaryCursors` was O(n²)
 * (46 s on a 446-bar score). This module builds, in ONE O(n) pass, everything
 * those queries need, cached and invalidated atomically with `meterCache`
 * (see ComposerModel.invalidateMeterCache). Navigation then reads O(1)/O(log n).
 *
 * The stop list is taken verbatim from `flatChildren` (the authoritative
 * enumeration) so cursor indices never shift; this module only annotates each
 * stop with its tick position / measure / tuplet-ness, computed incrementally
 * via per-measure prefix sums instead of one `locateCursor` per stop.
 */

import { realTicks } from './ticks.js';
import { flatChildren, tupletNavStops } from './cursor-location.js';
import type { ComposerModel, Voice } from './index.js';

export interface VoiceIndex {
  /** Cursor stops in document order — identical to `flatChildren(voice)`. */
  stops: Element[];
  /** Absolute tick of each cursor stop; length = stops.length + 1, where the
   *  final entry is the score's total tick length (the past-end position). */
  tickPos: Float64Array;
  /** Containing measure index of stop c (locate semantics). length stops.length. */
  measureIdx: Int32Array;
  /** 1 iff stop c is strictly inside a tuplet body. length stops.length. */
  inTuplet: Uint8Array;
  /** Sorted cursor indices that fall on a measure boundary (= measureBoundaryCursors). */
  boundaries: number[];
  /** Cumulative stop count before measure mi (= getMeasureStartCursor(mi)).
   *  length = measureCount + 1. */
  measureStopPrefix: Int32Array;
  /** First cursor index whose visual measure is mi, or -1 (= getFirstVisualCursorInMeasure). */
  firstVisual: Int32Array;
}

const TICK_EPS = 1e-6;

/** Build the full index for `voice` in one O(n) pass. */
export function buildVoiceIndex(model: ComposerModel, voice: Voice): VoiceIndex {
  const stops = flatChildren(model, voice);
  const n = stops.length;
  const measures = model.allMeasures();
  const measureCount = measures.length;

  const tickPos = new Float64Array(n + 1);
  const measureIdx = new Int32Array(n);
  const inTuplet = new Uint8Array(n);

  const measIdxMap = new Map<Element, number>();
  for (let mi = 0; mi < measureCount; mi++) measIdxMap.set(measures[mi], mi);

  /* Per-measure layer state, recomputed when the walk crosses into a new
     measure (stops are contiguous per measure, in document order). */
  let curMi = -1;
  let mStart = 0;
  let cc: Element[] = [];
  let ccPrefix: number[] = [0];        // ccPrefix[i] = ticks of cc[0..i-1]
  let ccIndex = new Map<Element, number>();

  const ensureMeasure = (mi: number): void => {
    if (mi === curMi) return;
    curMi = mi;
    mStart = model.measureStartTick(mi);
    const layer = model.layerInMeasure(measures[mi], voice);
    cc = layer ? model.contentChildren(layer) : [];
    ccPrefix = new Array(cc.length + 1);
    ccPrefix[0] = 0;
    for (let i = 0; i < cc.length; i++) ccPrefix[i + 1] = ccPrefix[i] + realTicks(cc[i]);
    ccIndex = new Map();
    for (let i = 0; i < cc.length; i++) ccIndex.set(cc[i], i);
  };

  for (let c = 0; c < n; c++) {
    const anchor = stops[c];
    const measureEl = anchor.localName === 'measure' ? anchor : anchor.closest('measure');
    const mi = measureEl ? (measIdxMap.get(measureEl) ?? 0) : 0;
    ensureMeasure(mi);
    measureIdx[c] = mi;

    if (anchor.localName === 'measure') {
      /* Measure-wrapper stop — cursor at measure start. */
      tickPos[c] = mStart;
      continue;
    }
    const parent = anchor.parentElement;
    if (parent && parent.localName === 'tuplet') {
      const tupCcIdx = ccIndex.get(parent) ?? cc.length;
      const cumBefore = ccPrefix[tupCcIdx];
      const navStops = tupletNavStops(parent);
      if (navStops.length > 0 && navStops[navStops.length - 1] === anchor) {
        /* Exit-tuplet stop — cursor past the whole tuplet. */
        tickPos[c] = mStart + ccPrefix[Math.min(tupCcIdx + 1, ccPrefix.length - 1)];
      } else {
        /* In-tuplet stop — cursor past this tuplet child. */
        const tChildren = Array.from(parent.children);
        const tIdx = tChildren.indexOf(anchor);
        let t = mStart + cumBefore;
        for (let i = 0; i <= tIdx; i++) t += realTicks(tChildren[i]);
        tickPos[c] = t;
        inTuplet[c] = 1;
      }
      continue;
    }
    if (anchor.localName === 'tuplet') {
      /* Entered-tuplet stop — cursor at the tuplet's first slot (its start).
         locateCursor reports this as inTuplet (tupletChildIdx 0), so flag it. */
      const idx = ccIndex.get(anchor) ?? cc.length;
      tickPos[c] = mStart + ccPrefix[idx];
      inTuplet[c] = 1;
      continue;
    }
    /* Top-level content stop — cursor past this element. */
    const idx = ccIndex.get(anchor);
    tickPos[c] = mStart + (idx !== undefined ? ccPrefix[idx + 1] : ccPrefix[ccPrefix.length - 1]);
  }

  tickPos[n] = model.measureStartTick(measureCount);

  /* measureStopPrefix + firstVisual (visual measure = measureIdx[c] for c<n). */
  const measureStopPrefix = new Int32Array(measureCount + 1);
  const firstVisual = new Int32Array(measureCount).fill(-1);
  {
    const countPerMeasure = new Int32Array(measureCount);
    for (let c = 0; c < n; c++) {
      const mi = measureIdx[c];
      if (mi >= 0 && mi < measureCount) {
        countPerMeasure[mi]++;
        if (firstVisual[mi] === -1) firstVisual[mi] = c;
      }
    }
    for (let mi = 0; mi < measureCount; mi++) measureStopPrefix[mi + 1] = measureStopPrefix[mi] + countPerMeasure[mi];
  }

  /* boundaries: stops (or past-end) whose tick coincides with a measure start
     or end, excluding tuplet-internal stops. Dedupe by tick keeping the LATER
     cursor index (matches the old Map-insert-last-wins). tickPos is monotonic
     non-decreasing, so walk the measure pointer forward in lockstep. */
  const boundaries: number[] = [];
  {
    const byT = new Map<number, number>();
    let mi = 0;
    const prefixOf = (k: number): number => model.measureStartTick(k);
    for (let c = 0; c <= n; c++) {
      if (c < n && inTuplet[c]) continue;
      const t = tickPos[c];
      while (mi + 1 <= measureCount && prefixOf(mi + 1) <= t + TICK_EPS) mi++;
      if (mi >= measureCount) mi = Math.max(0, measureCount - 1);
      const inMeas = t - prefixOf(mi);
      const budget = model.measureTicksAt(mi);
      if (inMeas < TICK_EPS || budget - inMeas < TICK_EPS) {
        byT.set(Math.round(t * 1e6), c);
      }
    }
    for (const c of byT.values()) boundaries.push(c);
    boundaries.sort((a, b) => a - b);
  }

  return { stops, tickPos, measureIdx, inTuplet, boundaries, measureStopPrefix, firstVisual };
}
