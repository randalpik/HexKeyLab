// Reference-note state. Defines the lattice cell that piano-keyboard 12-TET
// input is resolved against, and that the piano outline / dashed marker
// center on.
//
// Three tiers, first one set wins:
//   1. selection — most recently set by user Ctrl+click or by Composer's
//      "previous note in voice" broadcast. Last writer wins; the two sources
//      coexist in one slot, distinguished only by `source` (for composer-bye
//      semantics — manual selections survive a Composer disconnect). A
//      composer-source selection is gated on outline mode = 'piano' — the
//      cursor's prior note is only relevant when the piano outline is showing.
//      Manual selections apply regardless of outline mode.
//   2. scoreRef — the score's cursor-independent fallback ref, set by Composer
//      from the Setup-dialog ref coordinates (set-score-ref). Independent of
//      cursor movement. When HKL's "Sync to Composer" toggle is on, a
//      scoreRef update also clears the selection tier (so the lattice matches
//      the score exactly); sync off leaves the user's selection alone.
//   3. default — A3 at (0, 0).
//
// Composer never broadcasts clear-* messages — its cursor moving past an
// empty stretch does NOT clear the selection. Tier-clearing happens only via
// user Ctrl+click (clears selection), the sync-gated scoreRef path, or
// `composer-bye` (clears scoreRef and composer-set selection).
//
// `referenceNote: { q, r }` is the effective coord — kept in sync with the
// tiers on every mutation so existing read-only consumers (src/render/draw.ts,
// src/midi/piano.ts, src/ui/controls.ts) don't need to change.

interface RefSelection {
  q: number;
  r: number;
  source: 'manual' | 'composer';
}
interface RefScoreRef {
  q: number;
  r: number;
}

let selection: RefSelection | null = null;
let scoreRef: RefScoreRef | null = null;

/** The effective reference note. Mutated by recompute() after any tier
 *  change. Consumers should read .q / .r and never mutate. */
export const referenceNote: { q: number; r: number } = { q: 0, r: 0 };

function readOutlineMode(): string {
  const sel = document.getElementById('selOutline') as HTMLSelectElement | null;
  return sel?.value ?? 'lumatone';
}

function selectionActive(): boolean {
  if (selection === null) return false;
  if (selection.source === 'manual') return true;
  return readOutlineMode() === 'piano';
}

/** Recompute the effective ref from tiers. Mutates `referenceNote` in place.
 *  Returns true iff the effective coord changed. */
function recompute(): boolean {
  const sel = selectionActive() ? selection : null;
  const tQ = sel ? sel.q : (scoreRef ? scoreRef.q : 0);
  const tR = sel ? sel.r : (scoreRef ? scoreRef.r : 0);
  if (tQ === referenceNote.q && tR === referenceNote.r) return false;
  referenceNote.q = tQ;
  referenceNote.r = tR;
  return true;
}

/** Called by setOutline() when the outline mode changes — a composer-source
 *  selection may activate or deactivate, changing the effective ref. */
export function recomputeReferenceForOutline(): boolean {
  return recompute();
}

/** Set the selection tier from a user Ctrl+click. Survives composer-bye. */
export function setSelectionFromManual(q: number, r: number): boolean {
  if (selection && selection.q === q && selection.r === r && selection.source === 'manual') {
    return false;
  }
  selection = { q, r, source: 'manual' };
  return recompute();
}

/** Set the selection tier from a Composer "previous note in voice" broadcast.
 *  Cleared on composer-bye. */
export function setSelectionFromComposer(q: number, r: number): boolean {
  if (selection && selection.q === q && selection.r === r && selection.source === 'composer') {
    return false;
  }
  selection = { q, r, source: 'composer' };
  return recompute();
}

/** Clear the selection tier. Used by Ctrl+click when clicking the current
 *  effective ref-note, and as part of composer-bye for composer-set
 *  selections. Returns whether the effective coord changed (false if the
 *  selection was already null). */
export function clearSelection(): boolean {
  if (selection === null) return false;
  selection = null;
  return recompute();
}

/** True if the selection tier exists and was set by a user Ctrl+click.
 *  Consumed by persistence + composer-bye. */
export function isSelectionManual(): boolean {
  return selection !== null && selection.source === 'manual';
}

export function setScoreRef(q: number, r: number): boolean {
  if (scoreRef && scoreRef.q === q && scoreRef.r === r) return false;
  scoreRef = { q, r };
  return recompute();
}

export function clearScoreRef(): boolean {
  if (scoreRef === null) return false;
  scoreRef = null;
  return recompute();
}

/** True iff a selection exists whose coords differ from the current scoreRef
 *  tier (or scoreRef is unset). Used by the "Sync to Composer" enable path to
 *  decide whether to clear the selection so the lattice snaps to the score's
 *  ref. Returns false when there's no selection to reconcile. */
export function selectionDiffersFromScoreRef(): boolean {
  if (selection === null) return false;
  if (scoreRef === null) return true;
  return selection.q !== scoreRef.q || selection.r !== scoreRef.r;
}

/** Apply composer-bye semantics: drop the score-ref tier, and drop the
 *  selection tier iff it was composer-set. A manual selection persists. */
export function onComposerBye(): boolean {
  let changed = false;
  if (scoreRef !== null) { scoreRef = null; changed = true; }
  if (selection !== null && selection.source === 'composer') { selection = null; changed = true; }
  if (!changed) return false;
  return recompute();
}
