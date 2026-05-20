// Selection mode for HKL Composer. Pure helpers — no DOM mutation, no
// statusline / overlay side effects (those live in input.ts and
// selectionOverlay.ts respectively).
//
// Two granularities:
//   - beat:    one voice, anchored at beat boundaries (powered by tstamp
//              alignment + tuplet atomicity).
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

export type SelectionState =
  | {
      kind: 'beat';
      voice: Voice;
      anchor: number;   // flat index, immutable for lifetime
      movable: number;  // flat index, manipulated by shift+arrow
    }
  | {
      kind: 'measure';
      originVoice: Voice;   // cursor's voice before entry; preserved on exit
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

/** Returns the set of flat indices in `voice` that are beat boundaries.
 *  Sorted ascending; always includes 0 and `flatChildren.length` (past-end).
 *
 *  A flat index `c` qualifies iff:
 *    (a) `getTickPositionAt(voice, c)` is beat-aligned within its measure
 *        (i.e. `inMeasureTicks % beatTicks(timeSig) === 0`), AND
 *    (b) `c` is NOT a strictly-interior in-tuplet stop (tuplet atomicity:
 *        only the entry stop (tuplet wrapper at flat-level) and exit stop
 *        (interpreted by locateCursor as layer-level past the tuplet) are
 *        eligible; in-tuplet stops report `inTuplet=true` via
 *        `getFlatStopInfo`).
 *  Past-end (c === flat.length) is always included.
 *
 *  Dedupe: when two cursor positions share a tstamp (e.g. "past last content
 *  of full M_k" and "past wrapper of M_{k+1}"), keep the LATER one — that's
 *  the measure-aligned position. This ensures selection bounds land on
 *  measure boundaries instead of on the prior measure's last-content stop.
 */
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
      if (info.inTuplet) continue; // tuplet atomicity
      t = model.getTickPositionAt(voice, c);
      const inMeas = ((t % measureT) + measureT) % measureT;
      const rem = inMeas % bt;
      if (!(rem < TICK_EPS || bt - rem < TICK_EPS)) continue;
    }
    candidates.push({ c, t });
  }
  /* Dedupe by tstamp: keep the highest c at each tstamp. Iterating in
   * ascending c, overwrite on collision. */
  const byT = new Map<number, number>();
  for (const { c, t } of candidates) {
    const key = Math.round(t * 1e6);
    byT.set(key, c);
  }
  return Array.from(byT.values()).sort((a, b) => a - b);
}

/** Returns the set of flat indices in `voice` that are measure boundaries
 *  (starts of measures plus past-end). Sorted ascending. */
export function measureBoundariesInVoice(model: ComposerModel, voice: Voice): number[] {
  const measures = model.allMeasures();
  const out: number[] = [];
  for (let mi = 0; mi < measures.length; mi++) {
    out.push(model.getMeasureStartCursor(voice, mi));
  }
  out.push(model.getVoiceLength(voice));
  // Deduplicate (an empty trailing measure could repeat) and sort.
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

/** Snap `from` to the nearest beat boundary in `dir`:
 *    - 'right': smallest boundary `b` with `b >= from`.
 *    - 'left':  largest boundary `b` with `b <= from`.
 *  Returns `from` itself if it's already a boundary. Returns null if no
 *  boundary exists in the requested direction (shouldn't happen — 0 and
 *  past-end are always boundaries).
 */
export function snapBeatBoundary(
  model: ComposerModel,
  voice: Voice,
  from: number,
  dir: Dir,
): number | null {
  const bs = beatBoundariesInVoice(model, voice);
  if (bs.length === 0) return null;
  if (dir === 'right') {
    for (const b of bs) if (b >= from) return b;
    return null;
  } else {
    let best: number | null = null;
    for (const b of bs) {
      if (b <= from) best = b;
      else break;
    }
    return best;
  }
}

/** Step one beat boundary in `dir` from `from`. Returns null when no further
 *  boundary exists (clamp). */
export function stepBeatBoundary(
  model: ComposerModel,
  voice: Voice,
  from: number,
  dir: Dir,
): number | null {
  const bs = beatBoundariesInVoice(model, voice);
  if (dir === 'right') {
    for (const b of bs) if (b > from) return b;
    return null;
  } else {
    let prev: number | null = null;
    for (const b of bs) {
      if (b < from) prev = b;
      else break;
    }
    return prev;
  }
}

/** Step to the first MEASURE boundary strictly in `dir` from `from`. Used by
 *  Ctrl+Shift+arrow in beat selection mode. */
export function stepMeasureBoundary(
  model: ComposerModel,
  voice: Voice,
  from: number,
  dir: Dir,
): number | null {
  const ms = measureBoundariesInVoice(model, voice);
  if (dir === 'right') {
    for (const b of ms) if (b > from) return b;
    return null;
  } else {
    let prev: number | null = null;
    for (const b of ms) {
      if (b < from) prev = b;
      else break;
    }
    return prev;
  }
}

/** Entry from voice mode via Shift+arrow. Snap cursor to the beat boundary
 *  toward `dir`'s anchor side, then place the movable bound one beat further
 *  in `dir`.
 *
 *    Shift+Left  → dir='left'.  anchor = snap('right'), movable = step('left').
 *    Shift+Right → dir='right'. anchor = snap('left'),  movable = step('right').
 *
 *  Returns null on impossible boundary (single-stop voice with no neighbor).
 */
export function enterBeatSelection(
  model: ComposerModel,
  voice: Voice,
  fromFlat: number,
  dir: Dir,
): SelectionState | null {
  // Anchor side opposes the arrow direction; movable goes in the arrow's dir.
  const anchorSnap = snapBeatBoundary(model, voice, fromFlat, dir === 'left' ? 'right' : 'left');
  if (anchorSnap === null) return null;
  const movable = stepBeatBoundary(model, voice, anchorSnap, dir);
  if (movable === null) return null;
  return { kind: 'beat', voice, anchor: anchorSnap, movable };
}

/** Entry from voice mode via Shift+Up or Shift+Down. Selects the current
 *  measure on the cursor's staff, with movableSide = 'unset'. */
export function enterMeasureSelection(
  model: ComposerModel,
  voice: Voice,
  fromMeasureIdx: number,
): SelectionState {
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

/** Move the movable bound of a beat selection by one beat in `dir`. If the
 *  resulting position equals the anchor, returns null (signals "exit
 *  selection mode at convergence"). */
export function moveBeatMovable(
  model: ComposerModel,
  sel: Extract<SelectionState, { kind: 'beat' }>,
  dir: Dir,
): { sel: SelectionState; exited: boolean } | null {
  const next = stepBeatBoundary(model, sel.voice, sel.movable, dir);
  if (next === null) return { sel, exited: false }; // clamp
  if (next === sel.anchor) {
    return { sel: { ...sel, movable: next }, exited: true };
  }
  return { sel: { ...sel, movable: next }, exited: false };
}

/** Ctrl+Shift+arrow in beat selection mode: step one MEASURE boundary in
 *  `dir`. Same convergence-exit rule as moveBeatMovable. */
export function moveBeatMovableByMeasure(
  model: ComposerModel,
  sel: Extract<SelectionState, { kind: 'beat' }>,
  dir: Dir,
): { sel: SelectionState; exited: boolean } | null {
  const next = stepMeasureBoundary(model, sel.voice, sel.movable, dir);
  if (next === null) return { sel, exited: false };
  if (next === sel.anchor) {
    return { sel: { ...sel, movable: next }, exited: true };
  }
  return { sel: { ...sel, movable: next }, exited: false };
}

/** Shift+arrow in measure selection mode: move the movable bound by one
 *  measure in `dir`. Handles `movableSide` transitions:
 *
 *  Shift+Left:
 *    'unset' → 'left', movableMeasure-- (clamp ≥ 0)
 *    'left'  → movableMeasure--          (clamp ≥ 0)
 *    'right' → movableMeasure--          → if hits anchor, reset to 'unset'
 *
 *  Shift+Right (mirror):
 *    'unset' → 'right', movableMeasure++ (clamp ≤ allMeasures.length - 1)
 *    'right' → movableMeasure++          (clamp ≤ last)
 *    'left'  → movableMeasure++          → if hits anchor, reset to 'unset'
 */
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
      if (target === sel.anchorMeasure) return sel; // clamped at 0
      return { ...sel, movableSide: 'left', movableMeasure: target };
    }
    if (sel.movableSide === 'left') {
      const target = Math.max(0, sel.movableMeasure - 1);
      return { ...sel, movableMeasure: target };
    }
    // 'right' — shrink right bound leftward
    const target = sel.movableMeasure - 1;
    if (target === sel.anchorMeasure) {
      return { ...sel, movableMeasure: target, movableSide: 'unset' };
    }
    if (target < sel.anchorMeasure) {
      // Defensive: shouldn't happen since movable ≥ anchor when side='right'.
      return { ...sel, movableMeasure: sel.anchorMeasure, movableSide: 'unset' };
    }
    return { ...sel, movableMeasure: target };
  }

  // dir === 'right'
  if (sel.movableSide === 'unset') {
    const target = Math.min(last, sel.anchorMeasure + 1);
    if (target === sel.anchorMeasure) return sel; // clamped at last
    return { ...sel, movableSide: 'right', movableMeasure: target };
  }
  if (sel.movableSide === 'right') {
    const target = Math.min(last, sel.movableMeasure + 1);
    return { ...sel, movableMeasure: target };
  }
  // 'left' — shrink left bound rightward
  const target = sel.movableMeasure + 1;
  if (target === sel.anchorMeasure) {
    return { ...sel, movableMeasure: target, movableSide: 'unset' };
  }
  if (target > sel.anchorMeasure) {
    return { ...sel, movableMeasure: sel.anchorMeasure, movableSide: 'unset' };
  }
  return { ...sel, movableMeasure: target };
}

/** Shift+Up/Down in measure mode: adjust the staff range symmetrically
 *  around originStaff.
 *
 *  Shift+Down:
 *    firstStaff == origin AND lastStaff < maxStaff → lastStaff++
 *    firstStaff < origin → firstStaff++ (shrink from top)
 *
 *  Shift+Up:
 *    lastStaff == origin AND firstStaff > 1 → firstStaff--
 *    lastStaff > origin → lastStaff-- (shrink from bottom)
 *
 *  Currently maxStaff = 2 (single grand staff); the logic is N-staff-ready.
 */
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
    return sel; // nothing to do
  }
  // up
  if (sel.lastStaff === sel.originStaff && sel.firstStaff > 1) {
    return { ...sel, firstStaff: (sel.firstStaff - 1) as Staff };
  }
  if (sel.lastStaff > sel.originStaff) {
    return { ...sel, lastStaff: (sel.lastStaff - 1) as Staff };
  }
  return sel;
}

/** Promote a beat selection to a measure selection. Origin = cursor's voice's
 *  staff. movableSide derives from beat-mode growth direction: grew right →
 *  'right', grew left → 'left'. Single-measure selection → 'unset'.
 */
export function promoteBeatToMeasure(
  model: ComposerModel,
  sel: Extract<SelectionState, { kind: 'beat' }>,
): SelectionState {
  const a = sel.anchor;
  const m = sel.movable;
  const leftFlat = Math.min(a, m);
  const rightFlat = Math.max(a, m);

  // Determine touched measure range. The flat positions are inclusive of the
  // boundary stops; for measure containment, use getFlatStopInfo for each.
  const leftInfo = model.getFlatStopInfo(sel.voice, leftFlat);
  const rightInfo = model.getFlatStopInfo(sel.voice, rightFlat);
  if (!leftInfo || !rightInfo) {
    // Defensive fallback: single-measure selection on current measure.
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
  // The right boundary, if it sits exactly at the start of measure M+1 (the
  // bar line), conceptually "touches" measure M as its right edge. To avoid
  // selecting M+1 when the boundary is just-past M, treat a rightFlat that is
  // the measure-start of (rightM) as actually touching (rightM - 1).
  // Detection: rightFlat equals the wrapper-stop start of measure rightM AND
  // rightM > leftM. (Past-end → rightM = measures.length; we treat that as
  // last measure for selection.)
  const numMeasures = model.allMeasures().length;
  if (rightInfo.measureIdx >= numMeasures) {
    rightM = numMeasures - 1;
  } else if (rightM > leftM) {
    const startOfRightM = model.getMeasureStartCursor(sel.voice, rightM);
    if (rightFlat === startOfRightM) {
      rightM = rightM - 1;
    }
  }

  const grewRight = m > a;
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

/** Visual bounds for rendering. For beat: range in voice's flat list and a
 *  single-staff strip. For measure: range of measures × range of staves. */
export interface SelectionBounds {
  kind: 'beat' | 'measure';
  voice?: Voice;           // beat only
  firstFlat?: number;      // beat only
  lastFlat?: number;       // beat only
  measureFirst: number;    // inclusive
  measureLast: number;     // inclusive
  firstStaff: Staff;
  lastStaff: Staff;
}

export function selectionBounds(model: ComposerModel, sel: SelectionState): SelectionBounds {
  if (sel.kind === 'beat') {
    const lo = Math.min(sel.anchor, sel.movable);
    const hi = Math.max(sel.anchor, sel.movable);
    const loInfo = model.getFlatStopInfo(sel.voice, lo);
    const hiInfo = model.getFlatStopInfo(sel.voice, hi);
    const staff = staffForVoice(sel.voice);
    const numMeasures = model.allMeasures().length;
    const mLast = hiInfo
      ? Math.min(numMeasures - 1, hiInfo.measureIdx)
      : numMeasures - 1;
    // If hi sits at the start of measure (mLast+1)'s wrapper, the right edge
    // of the selection is the barline of mLast — same logic as in promote.
    let measureLast = mLast;
    if (hiInfo && hiInfo.measureIdx > (loInfo?.measureIdx ?? 0)
        && hiInfo.measureIdx < numMeasures) {
      const startOfRightM = model.getMeasureStartCursor(sel.voice, hiInfo.measureIdx);
      if (hi === startOfRightM) measureLast = hiInfo.measureIdx - 1;
    }
    return {
      kind: 'beat',
      voice: sel.voice,
      firstFlat: lo,
      lastFlat: hi,
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

/** Cursor position corresponding to the movable end of the selection — the
 *  "user's perceived current position". For exit-to-movable on Ctrl+C,
 *  Ctrl+X, Escape, or a non-selection key.
 *
 *    beat:    { voice: sel.voice, flatIndex: sel.movable }
 *    measure: { voice: sel.originVoice, flatIndex: derived from movableSide }
 *
 *  Measure-mode mapping:
 *    'unset' → start of anchorMeasure (single-measure selection)
 *    'left'  → start of movableMeasure (the left bound is what user just moved)
 *    'right' → start of movableMeasure + 1 (the bar line to the right), or
 *              past-end voice length when movableMeasure is the last measure.
 */
export function cursorAtMovable(
  model: ComposerModel,
  sel: SelectionState,
): { voice: Voice; flatIndex: number } {
  if (sel.kind === 'beat') {
    return { voice: sel.voice, flatIndex: sel.movable };
  }
  const v = sel.originVoice;
  if (sel.movableSide === 'unset') {
    return { voice: v, flatIndex: model.getMeasureStartCursor(v, sel.anchorMeasure) };
  }
  if (sel.movableSide === 'left') {
    return { voice: v, flatIndex: model.getMeasureStartCursor(v, sel.movableMeasure) };
  }
  // 'right'
  const numMeasures = model.allMeasures().length;
  const target = sel.movableMeasure + 1;
  if (target >= numMeasures) {
    return { voice: v, flatIndex: model.getVoiceLength(v) };
  }
  return { voice: v, flatIndex: model.getMeasureStartCursor(v, target) };
}
