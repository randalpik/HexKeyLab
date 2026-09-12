/* Manual line breaks (2026-09-11/12) — the two commands, shared by the
 * keyboard (Alt+Shift+↓) and the lock-glyph click so both paths run the same
 * code. Backlog: "force a line break … logically split the section … lock
 * symbol … clickable to revert".
 *
 * A lock is a plain `<sb>` in the document (model.setLineLockAt) and NOTHING
 * ELSE (Max's ruling, 2026-09-12): the layout must never hold state the
 * document cannot reproduce after a reload, so there is no side channel that
 * dissolves a soft start or keeps a line over-tight. The page line-break
 * owner splits the line at the lock and then reflows exactly like a measure
 * insert — carry, repair, section balance (render/linebreaks.ts). Every
 * command lands as one history entry carrying the layout it changed, so undo
 * puts the partition back exactly (history.ts LayoutSnapshot).
 *
 * Cursor measure m in system [a, b):
 *   lock (↓): lock before m. The line splits there; [m, b) is under-filled and
 *             pulls from below, [a, m) is now section-final and the balancer
 *             redistributes its section if it is too sparse (a one-bar
 *             remainder folds into the previous system when it fits). At a
 *             system start (m === a) the existing boundary is simply locked.
 *   unlock:   the `<sb>` goes; the partition stays (pin removed only).
 * The backlog's Alt+Shift+↑ ("pull onto the previous system") was dropped
 * 2026-09-12: under this rule it was exactly ↓ at m+1 plus an unlock — the
 * document can say where a break MUST be, never where one must NOT be. */

import type { ComposerModel } from './model/index.js';
import type { LayoutSnapshot } from './history.js';

export interface SystemSpan { lineIdx: number; startIdx: number; endIdx: number }

export interface LineBreakCtx {
  model: ComposerModel;
  /** The cursor's measure (voice-mode visual anchor). */
  cursorMeasureIdx(): number;
  isPageView(): boolean;
  /** The owned system holding measure `mi`, or null when the layout is not
   *  owned (scroll view, single-line score, still engraving). */
  systemOf(mi: number): SystemSpan | null;
  withHistory(label: string, fn: () => boolean | void, opts?: { layoutBefore?: LayoutSnapshot }): boolean;
  captureLayout(): LayoutSnapshot | null;
  annotateLayoutAfter(snap: LayoutSnapshot | null): void;
  afterRender(cb: () => void): void;
  setStatus(msg: string, kind?: 'info' | 'error' | 'state' | 'action'): void;
  onStateChange(): void;
  onChange(): void;
}

function requireSystem(ctx: LineBreakCtx, mi: number): SystemSpan | null {
  if (!ctx.isPageView()) { ctx.setStatus('Line breaks are a page-view command.', 'error'); return null; }
  const sys = ctx.systemOf(mi);
  if (!sys) { ctx.setStatus('Layout not owned yet (single-line score, or still engraving) — try again.', 'error'); return null; }
  return sys;
}

/** Snapshot the layout, run the mutation as one history entry, render, and
 *  record the settled layout on the entry. */
function commit(ctx: LineBreakCtx, label: string, mutate: () => boolean, status: string): boolean {
  const layoutBefore = ctx.captureLayout();
  const ok = ctx.withHistory(label, mutate, layoutBefore ? { layoutBefore } : {});
  if (!ok) { ctx.setStatus('Nothing to change.', 'info'); return false; }
  ctx.setStatus(status, 'action');
  ctx.onStateChange();
  ctx.onChange();
  ctx.afterRender(() => ctx.annotateLayoutAfter(ctx.captureLayout()));
  return true;
}

/** Alt+Shift+↓: lock the line break before the cursor measure; it and what
 *  follows it in its system start the next system. */
export function pushToNextSystem(ctx: LineBreakCtx): void {
  const m = ctx.cursorMeasureIdx();
  const sys = requireSystem(ctx, m);
  if (!sys) return;
  if (m <= 0) { ctx.setStatus('Can’t break before the first measure.', 'error'); return; }
  const hb = ctx.model.hardBreakBefore(m);
  if (hb === 'lock') { ctx.setStatus('The line break before m' + (m + 1) + ' is already locked.', 'info'); return; }
  if (hb) { ctx.setStatus((hb === 'page' ? 'A page break' : 'A section') + ' already starts at m' + (m + 1) + '.', 'info'); return; }
  commit(ctx, 'line-lock', () => ctx.model.setLineLockAt(m, true), 'Line break before m' + (m + 1) + ' locked.');
}

/** Lock-glyph click: remove the manual break before measure `mi`. The
 *  partition is left as it is (pin removed only — Max, 2026-09-11); the
 *  boundary is merely soft again. */
export function unlockAt(ctx: LineBreakCtx, mi: number): void {
  if (ctx.model.hardBreakBefore(mi) !== 'lock') { ctx.setStatus('No manual line break before m' + (mi + 1) + '.', 'info'); return; }
  commit(ctx, 'unlock', () => ctx.model.setLineLockAt(mi, false), 'Line break before m' + (mi + 1) + ' unlocked.');
}
