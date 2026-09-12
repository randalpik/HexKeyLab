/* Empty-cell flags (2026-09-11): `hide-empty` and `multirest` are per
 * (measure, staff) booleans stored as attributes on the `<staff>` element
 * inside `<measure>` — the same attribute family as `data-hkl-section-title`,
 * no namespace, round-trips through .hkc untouched.
 *
 * Only an EMPTY cell may carry a flag, and content entering the cell drops
 * both: placeholders.ts strips them in the same pass that rebuilds the cell's
 * trailing placeholders, so no edit path needs to know about them. What a flag
 * MEANS is the render's business (see docs/architecture/composer.md):
 *   - hide-empty: page view omits a staff from a system when every measure on
 *     that system carries the flag for it (scroll view always shows all);
 *   - multirest: a single-staff view collapses a run of ≥2 flagged measures
 *     into one <multiRest>.
 * Neither touches playback or the cursor's flat index.
 *
 * Empty = every <layer> of the staff has no content child (chord | note | rest
 * | tuplet | fTrem | bTrem — <space> placeholders and an imported <mRest> both
 * count as empty) and no <clef>. */

import type { ComposerModel } from './index.js';

export type EmptyFlag = 'hide-empty' | 'multirest';
export const HIDE_EMPTY_ATTR = 'data-hkl-hide-empty';
export const MULTIREST_ATTR = 'data-hkl-multirest';
export const EMPTY_FLAG_ATTRS: readonly string[] = [HIDE_EMPTY_ATTR, MULTIREST_ATTR];

export function flagAttr(flag: EmptyFlag): string {
  return flag === 'hide-empty' ? HIDE_EMPTY_ATTR : MULTIREST_ATTR;
}

/** One (measure, staff) cell. `staffN` is the global `<staff @n>`. */
export interface Cell {
  measureIdx: number;
  staffN: number;
}

/** The `<staff n=staffN>` direct child of `measure`, or null. */
export function staffInMeasure(measure: Element, staffN: number): Element | null {
  const want = String(staffN);
  for (let c = measure.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName === 'staff' && c.getAttribute('n') === want) return c;
  }
  return null;
}

const CONTENT_NAMES: ReadonlySet<string> = new Set(['chord', 'note', 'rest', 'tuplet', 'fTrem', 'bTrem']);

/** Content in the sense of model.contentChildren, plus <clef>: anything that
 *  makes a layer NOT empty for flag purposes. */
export function isCellContent(localName: string): boolean {
  return CONTENT_NAMES.has(localName) || localName === 'clef';
}

/** True iff the layer holds no musical content: only placeholders / spaces /
 *  an <mRest>, and no <clef>. */
export function layerIsEmpty(layer: Element): boolean {
  for (let c = layer.firstElementChild; c; c = c.nextElementSibling) {
    if (isCellContent(c.localName)) return false;
  }
  return true;
}

export function staffCellIsEmpty(staff: Element): boolean {
  for (let c = staff.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName === 'layer' && !layerIsEmpty(c)) return false;
  }
  return true;
}

export function cellIsEmpty(measure: Element, staffN: number): boolean {
  const st = staffInMeasure(measure, staffN);
  return st !== null && staffCellIsEmpty(st);
}

export function staffHasFlag(staff: Element, flag: EmptyFlag): boolean {
  return staff.getAttribute(flagAttr(flag)) === 'true';
}

export function cellHasFlag(measure: Element, staffN: number, flag: EmptyFlag): boolean {
  const st = staffInMeasure(measure, staffN);
  return st !== null && staffHasFlag(st, flag);
}

/** Strip both flags from a staff element (content entered the cell). Returns
 *  true when anything was removed. */
export function clearEmptyFlags(staff: Element): boolean {
  let any = false;
  for (const a of EMPTY_FLAG_ATTRS) {
    if (staff.hasAttribute(a)) { staff.removeAttribute(a); any = true; }
  }
  return any;
}

/** Empty cells in the inclusive rectangle [mLo..mHi] × [sLo..sHi], in
 *  document order (measure-major). */
export function emptyCellsIn(
  model: ComposerModel, mLo: number, mHi: number, sLo: number, sHi: number,
): Cell[] {
  const measures = model.allMeasures();
  const out: Cell[] = [];
  const a = Math.max(0, Math.min(mLo, mHi));
  const b = Math.min(measures.length - 1, Math.max(mLo, mHi));
  const s0 = Math.min(sLo, sHi), s1 = Math.max(sLo, sHi);
  for (let mi = a; mi <= b; mi++) {
    for (let s = s0; s <= s1; s++) {
      if (cellIsEmpty(measures[mi], s)) out.push({ measureIdx: mi, staffN: s });
    }
  }
  return out;
}

export interface FlagToggleResult {
  /** The state every target cell now holds. */
  on: boolean;
  count: number;
  measureLo: number;
  measureHi: number;
}

/** The toggle rule (Max, 2026-09-11): count the cells already carrying `flag`
 *  and set EVERY cell to the state held by the FEWER of them (tie → on), so
 *  repeated presses over the same target cycle 10001 → 11111 → 00000 and a
 *  single cell simply toggles. Cells are assumed empty (emptyCellsIn); a cell
 *  whose staff is missing is skipped. Returns null when nothing was written. */
export function toggleEmptyFlagOnCells(
  model: ComposerModel, cells: readonly Cell[], flag: EmptyFlag,
): FlagToggleResult | null {
  if (!cells.length) return null;
  const measures = model.allMeasures();
  const attr = flagAttr(flag);
  const staffEls: Element[] = [];
  let on = 0, lo = Infinity, hi = -Infinity;
  for (const c of cells) {
    const m = measures[c.measureIdx];
    const st = m ? staffInMeasure(m, c.staffN) : null;
    if (!st) continue;
    staffEls.push(st);
    if (st.getAttribute(attr) === 'true') on++;
    lo = Math.min(lo, c.measureIdx);
    hi = Math.max(hi, c.measureIdx);
  }
  if (!staffEls.length) return null;
  const target = on <= staffEls.length - on;
  for (const st of staffEls) {
    if (target) st.setAttribute(attr, 'true');
    else st.removeAttribute(attr);
  }
  return { on: target, count: staffEls.length, measureLo: lo, measureHi: hi };
}
