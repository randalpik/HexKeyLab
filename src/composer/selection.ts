// Selection mode for HKL Composer. Pure helpers — no DOM mutation, no
// statusline / overlay side effects (those live in input.ts and
// selectionOverlay.ts respectively).
//
// Two granularities:
//   - beat:    one voice, anchored at beat boundaries (powered by tstamp
//              alignment + tuplet atomicity). The state stores BEAT INDICES
//              (origin/first/last); conversion to/from cursor positions
//              happens at the API boundary via beatBoundariesInVoice().
//   - measure: one or more 2-voice staves, anchored at measure boundaries,
//              with a designated origin staff so multi-staff growth is
//              symmetric.
//
// See /home/max/.claude/plans/it-s-time-to-add-unified-barto.md.

import type { ComposerModel, Voice } from './model.js';
import { readTimeSig } from './beams.js';
import { beatTicks } from './restfill.js';

export type Staff = 1 | 2;
export type MovableSide = 'left' | 'right' | 'unset';
export type Dir = 'left' | 'right';
export type BeatSide = 'first' | 'last';

export type SelectionState =
  | {
      kind: 'beat';
      voice: Voice;
      origin: number;          // beat index where selection started; invariant: first ≤ origin ≤ last
      first: number;           // leftmost selected beat index
      last: number;            // rightmost selected beat index
      lastMoved: BeatSide;     // which side was last shifted; used for exit-cursor placement
    }
  | {
      kind: 'measure';
      originVoice: Voice;
      originStaff: Staff;
      firstStaff: Staff;
      lastStaff: Staff;
      anchorMeasure: number;
      movableMeasure: number;
      movableSide: MovableSide;
    };

const TICK_EPS = 1e-6;

function staffForVoice(voice: Voice): Staff {
  return voice <= 2 ? 1 : 2;
}

/** Returns the set of cursor positions in `voice` that are beat boundaries.
 *  Sorted ascending. Always includes 0 and the past-end position.
 *
 *  Boundary criteria:
 *    (a) `getTickPositionAt(voice, c)` is beat-aligned within its measure
 *        (i.e. `inMeasureTicks % beatTicks(timeSig) === 0`), AND
 *    (b) `c` is NOT a strictly-interior in-tuplet stop (tuplet atomicity).
 *
 *  Dedupe: when two cursor positions share a tstamp (e.g. "past last content
 *  of full M_k" and "past wrapper of M_{k+1}"), keep the LATER one — that's
 *  the measure-aligned position. */
export function beatBoundariesInVoice(model: ComposerModel, voice: Voice): number[] {
  const flat = model.flatChildren(voice);
  const ts = readTimeSig(model.getDoc());
  const bt = beatTicks(ts);
  const measureT = model.measureTicks();
  const candidates: Array<{ c: number; t: number }> = [];
  for (let c = 0; c <= flat.length; c++) {
    let t: number;
    if (c === flat.length) {
      t = model.allMeasures().length * measureT;
    } else {
      const info = model.getFlatStopInfo(voice, c);
      if (!info) continue;
      if (info.inTuplet) continue;
      t = model.getTickPositionAt(voice, c);
      const inMeas = ((t % measureT) + measureT) % measureT;
      const rem = inMeas % bt;
      if (!(rem < TICK_EPS || bt - rem < TICK_EPS)) continue;
    }
    candidates.push({ c, t });
  }
  const byT = new Map<number, number>();
  for (const { c, t } of candidates) {
    const key = Math.round(t * 1e6);
    byT.set(key, c);
  }
  return Array.from(byT.values()).sort((a, b) => a - b);
}

/** Cursor positions that fall exactly on a measure barline (tstamp is a
 *  multiple of measureTicks). Used by Ctrl+Shift+arrow to decide where to
 *  stop. Note: this is tstamp-based — distinct from `getMeasureStartCursor`,
 *  which returns the navigation-stop position (= past the first content of
 *  the measure in the wrapper-collapsed case, which is one cursor INSIDE
 *  the measure, not at the barline). */
export function measureBoundariesInVoice(model: ComposerModel, voice: Voice): number[] {
  const flat = model.flatChildren(voice);
  const measureT = model.measureTicks();
  const candidates: Array<{ c: number; t: number }> = [];
  for (let c = 0; c <= flat.length; c++) {
    let t: number;
    if (c === flat.length) {
      t = model.allMeasures().length * measureT;
    } else {
      const info = model.getFlatStopInfo(voice, c);
      if (!info) continue;
      if (info.inTuplet) continue;
      t = model.getTickPositionAt(voice, c);
    }
    const inMeas = ((t % measureT) + measureT) % measureT;
    if (inMeas < TICK_EPS || measureT - inMeas < TICK_EPS) {
      candidates.push({ c, t });
    }
  }
  const byT = new Map<number, number>();
  for (const { c, t } of candidates) {
    const key = Math.round(t * 1e6);
    byT.set(key, c);
  }
  return Array.from(byT.values()).sort((a, b) => a - b);
}

/** Which beat (= index into beatBoundariesInVoice) the cursor is "currently
 *  in". Edge cases:
 *    - At the very start of the score (cursor ≤ boundaries[0]): beat 0.
 *    - At the very end (cursor ≥ last boundary): the last beat.
 *    - At a mid-score boundary `boundaries[k]` (k > 0): beat k − 1 (= "just
 *      past" that boundary's beat).
 *    - Strictly between `boundaries[k]` and `boundaries[k+1]`: beat k. */
export function currentBeatAt(model: ComposerModel, voice: Voice, cursor: number): number {
  const boundaries = beatBoundariesInVoice(model, voice);
  if (boundaries.length <= 1) return 0;
  const numBeats = boundaries.length - 1;
  let k = 0;
  for (let i = 0; i < boundaries.length; i++) {
    if (boundaries[i] <= cursor) k = i;
    else break;
  }
  if (boundaries[k] === cursor && k > 0) return Math.min(k - 1, numBeats - 1);
  return Math.min(k, numBeats - 1);
}

/** Entry from voice mode via Shift+arrow. Both directions select the
 *  cursor's current beat (single-beat selection). `lastMoved` is set from
 *  the entry direction: Shift+Left → 'first' (so an immediate exit lands
 *  the cursor at the beat's LEFT edge), Shift+Right → 'last' (right edge).
 *  This makes exit-cursor placement match the user's last-perceived
 *  direction even when they bail immediately after entering. */
export function enterBeatSelection(
  model: ComposerModel,
  voice: Voice,
  fromCursor: number,
  dir: Dir = 'right',
): Extract<SelectionState, { kind: 'beat' }> | null {
  const boundaries = beatBoundariesInVoice(model, voice);
  if (boundaries.length <= 1) return null;
  const k = currentBeatAt(model, voice, fromCursor);
  return {
    kind: 'beat',
    voice,
    origin: k,
    first: k,
    last: k,
    lastMoved: dir === 'left' ? 'first' : 'last',
  };
}

/** Entry from voice mode via Shift+Up or Shift+Down. */
export function enterMeasureSelection(
  model: ComposerModel,
  voice: Voice,
  fromMeasureIdx: number,
): Extract<SelectionState, { kind: 'measure' }> {
  const originStaff = staffForVoice(voice);
  return {
    kind: 'measure',
    originVoice: voice,
    originStaff,
    firstStaff: originStaff,
    lastStaff: originStaff,
    anchorMeasure: fromMeasureIdx,
    movableMeasure: fromMeasureIdx,
    movableSide: 'unset',
  };
}

/** Shift+arrow in beat selection mode. Origin stays fixed; the active side
 *  is determined by the current state shape:
 *    - origin == last (single-beat OR expanded left): Shift+Left expands
 *      first leftward; Shift+Right shrinks first rightward toward origin,
 *      OR if origin == first (state A or C), expands last rightward.
 *    - origin == first (expanded right): Shift+Left shrinks last leftward;
 *      Shift+Right expands last rightward.
 *  The invariant first ≤ origin ≤ last AND the rule that only one side
 *  diverges from origin at a time means either origin == first OR
 *  origin == last (or both) — never both first < origin AND last > origin.
 *  Clamped at score edges (returns sel unchanged when clamped). */
export function moveBeatRange(
  model: ComposerModel,
  sel: Extract<SelectionState, { kind: 'beat' }>,
  dir: Dir,
): Extract<SelectionState, { kind: 'beat' }> {
  const boundaries = beatBoundariesInVoice(model, sel.voice);
  const numBeats = boundaries.length - 1;
  if (dir === 'left') {
    if (sel.origin === sel.last) {
      // States A (single-beat) and B (expanded left): expand first leftward.
      if (sel.first === 0) return sel;
      return { ...sel, first: sel.first - 1, lastMoved: 'first' };
    }
    // State C (expanded right): shrink last leftward toward origin.
    return { ...sel, last: sel.last - 1, lastMoved: 'last' };
  }
  // dir === 'right'
  if (sel.origin === sel.first) {
    // States A and C: expand last rightward.
    if (sel.last >= numBeats - 1) return sel;
    return { ...sel, last: sel.last + 1, lastMoved: 'last' };
  }
  // State B: shrink first rightward toward origin.
  return { ...sel, first: sel.first + 1, lastMoved: 'first' };
}

/** Ctrl+Shift+arrow: repeat moveBeatRange until the just-moved edge lands
 *  on a measure-aligned beat boundary, or we clamp. Minimum of one step. */
export function moveBeatRangeByMeasure(
  model: ComposerModel,
  sel: Extract<SelectionState, { kind: 'beat' }>,
  dir: Dir,
): Extract<SelectionState, { kind: 'beat' }> {
  const boundaries = beatBoundariesInVoice(model, sel.voice);
  const measureBoundarySet = new Set(measureBoundariesInVoice(model, sel.voice));
  let cur = sel;
  while (true) {
    const next = moveBeatRange(model, cur, dir);
    if (next.first === cur.first && next.last === cur.last) break; // clamped
    cur = next;
    const justMovedCursor = cur.lastMoved === 'first'
      ? boundaries[cur.first]
      : boundaries[cur.last + 1];
    if (measureBoundarySet.has(justMovedCursor)) break;
  }
  return cur;
}

/** Shift+arrow in measure selection mode. Unchanged from prior design. */
export function moveMeasureMovable(
  model: ComposerModel,
  sel: Extract<SelectionState, { kind: 'measure' }>,
  dir: Dir,
): SelectionState {
  const numMeasures = model.allMeasures().length;
  const last = numMeasures - 1;

  if (dir === 'left') {
    if (sel.movableSide === 'unset') {
      const target = Math.max(0, sel.anchorMeasure - 1);
      if (target === sel.anchorMeasure) return sel;
      return { ...sel, movableSide: 'left', movableMeasure: target };
    }
    if (sel.movableSide === 'left') {
      const target = Math.max(0, sel.movableMeasure - 1);
      return { ...sel, movableMeasure: target };
    }
    const target = sel.movableMeasure - 1;
    if (target === sel.anchorMeasure) {
      return { ...sel, movableMeasure: target, movableSide: 'unset' };
    }
    if (target < sel.anchorMeasure) {
      return { ...sel, movableMeasure: sel.anchorMeasure, movableSide: 'unset' };
    }
    return { ...sel, movableMeasure: target };
  }

  if (sel.movableSide === 'unset') {
    const target = Math.min(last, sel.anchorMeasure + 1);
    if (target === sel.anchorMeasure) return sel;
    return { ...sel, movableSide: 'right', movableMeasure: target };
  }
  if (sel.movableSide === 'right') {
    const target = Math.min(last, sel.movableMeasure + 1);
    return { ...sel, movableMeasure: target };
  }
  const target = sel.movableMeasure + 1;
  if (target === sel.anchorMeasure) {
    return { ...sel, movableMeasure: target, movableSide: 'unset' };
  }
  if (target > sel.anchorMeasure) {
    return { ...sel, movableMeasure: sel.anchorMeasure, movableSide: 'unset' };
  }
  return { ...sel, movableMeasure: target };
}

/** Shift+Up/Down in measure mode. Unchanged. */
export function adjustStaffRange(
  sel: Extract<SelectionState, { kind: 'measure' }>,
  dir: 'up' | 'down',
  maxStaff: Staff = 2,
): SelectionState {
  if (dir === 'down') {
    if (sel.firstStaff === sel.originStaff && sel.lastStaff < maxStaff) {
      return { ...sel, lastStaff: (sel.lastStaff + 1) as Staff };
    }
    if (sel.firstStaff < sel.originStaff) {
      return { ...sel, firstStaff: (sel.firstStaff + 1) as Staff };
    }
    return sel;
  }
  if (sel.lastStaff === sel.originStaff && sel.firstStaff > 1) {
    return { ...sel, firstStaff: (sel.firstStaff - 1) as Staff };
  }
  if (sel.lastStaff > sel.originStaff) {
    return { ...sel, lastStaff: (sel.lastStaff - 1) as Staff };
  }
  return sel;
}

/** Promote a beat selection to a measure selection. `lastMoved` maps to
 *  `movableSide`: 'first' → 'left', 'last' → 'right', single-measure
 *  selections → 'unset'. */
export function promoteBeatToMeasure(
  model: ComposerModel,
  sel: Extract<SelectionState, { kind: 'beat' }>,
): SelectionState {
  const boundaries = beatBoundariesInVoice(model, sel.voice);
  const leftCursor = boundaries[sel.first];
  const rightCursor = boundaries[sel.last + 1];
  const leftInfo = model.getFlatStopInfo(sel.voice, leftCursor);
  const rightInfo = model.getFlatStopInfo(sel.voice, rightCursor);
  if (!leftInfo || !rightInfo) {
    const fallbackM = model.getCursorMeasureIdx(sel.voice);
    const staff = staffForVoice(sel.voice);
    return {
      kind: 'measure',
      originVoice: sel.voice,
      originStaff: staff,
      firstStaff: staff,
      lastStaff: staff,
      anchorMeasure: Math.max(0, fallbackM),
      movableMeasure: Math.max(0, fallbackM),
      movableSide: 'unset',
    };
  }
  let leftM = leftInfo.measureIdx;
  let rightM = rightInfo.measureIdx;
  const numMeasures = model.allMeasures().length;
  if (rightInfo.measureIdx >= numMeasures) {
    rightM = numMeasures - 1;
  } else if (rightM > leftM) {
    const startOfRightM = model.getMeasureStartCursor(sel.voice, rightM);
    if (rightCursor === startOfRightM) rightM = rightM - 1;
  }
  const grewRight = sel.lastMoved === 'last';
  const originStaff = staffForVoice(sel.voice);
  let anchorMeasure: number;
  let movableMeasure: number;
  let movableSide: MovableSide;
  if (leftM === rightM) {
    anchorMeasure = leftM;
    movableMeasure = leftM;
    movableSide = 'unset';
  } else if (grewRight) {
    anchorMeasure = leftM;
    movableMeasure = rightM;
    movableSide = 'right';
  } else {
    anchorMeasure = rightM;
    movableMeasure = leftM;
    movableSide = 'left';
  }
  return {
    kind: 'measure',
    originVoice: sel.voice,
    originStaff,
    firstStaff: originStaff,
    lastStaff: originStaff,
    anchorMeasure,
    movableMeasure,
    movableSide,
  };
}

/** Visual bounds for rendering. For beat: cursor positions of the left/right
 *  edges + the measure range touched. For measure: measure range + staff
 *  range. */
export interface SelectionBounds {
  kind: 'beat' | 'measure';
  voice?: Voice;
  firstCursor?: number;    // beat only — boundaries[first]
  lastCursor?: number;     // beat only — boundaries[last + 1]
  measureFirst: number;
  measureLast: number;
  firstStaff: Staff;
  lastStaff: Staff;
}

export function selectionBounds(model: ComposerModel, sel: SelectionState): SelectionBounds {
  if (sel.kind === 'beat') {
    const boundaries = beatBoundariesInVoice(model, sel.voice);
    const lo = boundaries[sel.first];
    const hi = boundaries[sel.last + 1];
    const loInfo = model.getFlatStopInfo(sel.voice, lo);
    const hiInfo = model.getFlatStopInfo(sel.voice, hi);
    const staff = staffForVoice(sel.voice);
    const numMeasures = model.allMeasures().length;
    const mLast = hiInfo
      ? Math.min(numMeasures - 1, hiInfo.measureIdx)
      : numMeasures - 1;
    let measureLast = mLast;
    if (hiInfo && hiInfo.measureIdx > (loInfo?.measureIdx ?? 0)
        && hiInfo.measureIdx < numMeasures) {
      const startOfRightM = model.getMeasureStartCursor(sel.voice, hiInfo.measureIdx);
      if (hi === startOfRightM) measureLast = hiInfo.measureIdx - 1;
    }
    return {
      kind: 'beat',
      voice: sel.voice,
      firstCursor: lo,
      lastCursor: hi,
      measureFirst: loInfo?.measureIdx ?? 0,
      measureLast,
      firstStaff: staff,
      lastStaff: staff,
    };
  }
  const mLo = Math.min(sel.anchorMeasure, sel.movableMeasure);
  const mHi = Math.max(sel.anchorMeasure, sel.movableMeasure);
  return {
    kind: 'measure',
    measureFirst: mLo,
    measureLast: mHi,
    firstStaff: sel.firstStaff,
    lastStaff: sel.lastStaff,
  };
}

/** Cursor position corresponding to the "user's perceived current
 *  position" — used by exit-to-movable on Ctrl+X, Escape, or a
 *  non-selection key. (Ctrl+C does not exit and does not reposition.)
 *
 *    beat:    `boundaries[lastMoved === 'first' ? first : last + 1]`.
 *    measure: per movableSide, unchanged from prior design. */
export function cursorAtMovable(
  model: ComposerModel,
  sel: SelectionState,
): { voice: Voice; flatIndex: number } {
  if (sel.kind === 'beat') {
    const boundaries = beatBoundariesInVoice(model, sel.voice);
    const flatIndex = sel.lastMoved === 'first'
      ? boundaries[sel.first]
      : boundaries[sel.last + 1];
    return { voice: sel.voice, flatIndex };
  }
  const v = sel.originVoice;
  if (sel.movableSide === 'unset') {
    return { voice: v, flatIndex: model.getMeasureStartCursor(v, sel.anchorMeasure) };
  }
  if (sel.movableSide === 'left') {
    return { voice: v, flatIndex: model.getMeasureStartCursor(v, sel.movableMeasure) };
  }
  const numMeasures = model.allMeasures().length;
  const target = sel.movableMeasure + 1;
  if (target >= numMeasures) {
    return { voice: v, flatIndex: model.getVoiceLength(v) };
  }
  return { voice: v, flatIndex: model.getMeasureStartCursor(v, target) };
}
