/* Hide empty staves (2026-09-11) — the render side of `data-hkl-hide-empty`
 * (model/empty-flags.ts).
 *
 * Rule: in PAGE view a staff is omitted from a system when EVERY measure of
 * that system carries the flag for it (and the cell is still empty — the flag
 * is necessary, emptiness is re-checked). Scroll view never hides; that is
 * the rescue path. Guard: a system never loses all of its staves — the top
 * one stays.
 *
 * Mechanism: Verovio's own optimizer is note-driven and score-global (a staff
 * hides on a system when no measure on it has a <note>; `condense` is pinned
 * to 'none' in render.ts for exactly that reason), so Composer does it per
 * system: a system with a non-empty hidden set is re-rendered ALONE from a
 * window MEI built with the single-part filter minus those staves
 * (`buildWindowMei(..., view ∖ H)` — the same recipe the page splicer uses for
 * edits, leader/trailer stubs included) and its `g.system` is swapped into the
 * page before Composer's own vertical placement runs (Renderer.
 * substituteHiddenStaffSystems). Verovio then draws barlines, braces, labels
 * and spacing for the reduced staff set natively; `alignStaffRows` /
 * `placeSystems` stack whatever staves exist. PDF export is the page DOM, so
 * print inherits the result. */

import type { ComposerModel } from '../model/index.js';
import { HIDE_EMPTY_ATTR, staffInMeasure, staffCellIsEmpty } from '../model/empty-flags.js';

/** Staves (global @n, ascending) hidden on a system whose measures are
 *  `measureIdxs`: flagged + empty in every one of them, within the view's
 *  staff set, minus the top-staff guard. Empty when nothing hides. */
export function hiddenStavesFor(
  model: ComposerModel, measureIdxs: readonly number[], viewStaves: readonly number[] | null,
): number[] {
  if (!measureIdxs.length) return [];
  const measures = model.allMeasures();
  const staves = (viewStaves ? viewStaves.slice() : model.instruments().flatMap((i) => i.staffNs))
    .sort((a, b) => a - b);
  if (staves.length < 2) return [];
  const hidden = staves.filter((s) => measureIdxs.every((mi) => {
    const m = measures[mi];
    const st = m ? staffInMeasure(m, s) : null;
    return !!st && st.getAttribute(HIDE_EMPTY_ATTR) === 'true' && staffCellIsEmpty(st);
  }));
  if (hidden.length === staves.length) hidden.shift();   // guard: the top staff stays
  return hidden;
}

/** Stable identity of a hidden set (cache / signature key). */
export function hiddenKey(h: readonly number[]): string {
  return h.join(',');
}

/** The staff set a system should be rendered with: the view minus `hidden`. */
export function visibleStavesFor(
  model: ComposerModel, viewStaves: readonly number[] | null, hidden: readonly number[],
): number[] {
  const staves = viewStaves ? viewStaves.slice() : model.instruments().flatMap((i) => i.staffNs);
  const drop = new Set(hidden);
  return staves.filter((s) => !drop.has(s)).sort((a, b) => a - b);
}

/** Model measure indices of a rendered system, in order; synthetic splice
 *  stubs (leader/trailer) resolve to -1 and are dropped. */
export function systemMeasureIdxs(model: ComposerModel, sys: Element): number[] {
  const out: number[] = [];
  for (const g of Array.from(sys.querySelectorAll('g.measure'))) {
    const mi = g.id ? model.getMeasureIdxForId(g.id) : -1;
    if (mi >= 0) out.push(mi);
  }
  return out;
}

/** The staff @n set a rendered system actually shows (first measure). */
export function renderedStaffNs(sys: Element): number[] {
  const first = sys.querySelector('g.measure');
  if (!first) return [];
  const out: number[] = [];
  for (const st of Array.from(first.children)) {
    if (!st.classList.contains('staff')) continue;
    const n = parseInt(st.getAttribute('data-n') ?? '', 10);
    if (Number.isFinite(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}
