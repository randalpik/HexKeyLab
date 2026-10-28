// Reference-note state. Defines the lattice cell that piano-keyboard 12-TET
// input is resolved against, and that the piano outline / dashed marker
// center on — and DERIVES the two anchors that follow it.
//
// Three tiers, first one set wins:
//   1. selection — two slots:
//        • manual: the user's Ctrl+click. Persists (prefs.manualRef) and
//          survives composer-bye.
//        • cursor: Composer's "previous note in voice" broadcast. Only
//          relevant in the piano outline; cleared on composer-bye.
//      In the piano outline the more recently set of the two is the
//      selection (last writer wins). In every other outline only the manual
//      slot applies, so a cursor move never displaces a Ctrl+click.
//   2. scoreRef — the score's cursor-independent fallback ref, set by Composer
//      from the key at its position (set-score-ref). When HKL's "Sync to
//      Composer" toggle is on, a scoreRef update also clears the selection
//      (so the lattice matches the score exactly); sync off leaves it alone.
//   3. default — A3 at (0, 0).
//
// Composer never broadcasts clear-* messages — its cursor moving past an
// empty stretch does NOT clear the selection. Tier-clearing happens only via
// user Ctrl+click (clears the selection), the sync-gated scoreRef path, or
// `composer-bye` (clears scoreRef and the cursor slot).
//
// `referenceNote: { q, r }` is the effective coord — kept in sync with the
// tiers on every mutation so read-only consumers (render/draw.ts, midi/piano.ts,
// ui/controls.ts) just read it.
//
// The HOME ref is manual ?? scoreRef ?? A3 — the effective ref minus the
// cursor slot. Two anchors are derived from it here and nowhere else:
//   • the keyboard anchor `view.kbAnchorQ/R` = refSpine(home): where the
//     Lumatone / QWERTY layout sits, and the center of every non-piano
//     outline's view. The cursor's prior note never moves it — entering a
//     note must not shift the physical layout.
//   • `tuning.anchor`, the Syntonic / Polysyntonic home band = the band of
//     home. Recording playback and the OBS-overlay mirror pin it to a given
//     value (setAnchorOverride). A change notifies the anchor listener once, in
//     a microtask after the synchronous fan-out below has run.
// Every mutation recomputes the effective ref and the keyboard anchor; if
// either moved, the ref listener (effects/onRefChanged) runs once,
// synchronously, with the keyboard-anchor delta — voice migration, view
// re-centering, redraw and broadcasts all hang off that one call, so no caller
// can move a ref without them (2026-10-26: two Composer handlers moved the ref
// and left the lattice centered on the old one).

import { tuning } from './tuning.js';
import { view } from './view.js';
import { anchorOf } from '@hkl/shared/freq.js';
import { refSpine } from '../tuning/refspine.js';

interface RefCoord {
  q: number;
  r: number;
}

const A3: RefCoord = { q: 0, r: 0 };

let manual: RefCoord | null = null;
let cursor: RefCoord | null = null;
/** Piano outline: the cursor slot is the selection iff it was set after the
 *  manual slot. */
let cursorNewer = false;
let scoreRef: RefCoord | null = null;
let anchorOverride: number | null = null;
let anchorListener: (() => void) | null = null;
let anchorNotifyQueued = false;
let refListener: ((dq: number, dr: number) => void) | null = null;

/** The effective reference note. Mutated by recompute() after any tier
 *  change. Consumers should read .q / .r and never mutate. */
export const referenceNote: { q: number; r: number } = { q: 0, r: 0 };

function readOutlineMode(): string {
  const sel = document.getElementById('selOutline') as HTMLSelectElement | null;
  return sel?.value ?? 'lumatone';
}

function homeRef(): RefCoord {
  return manual ?? scoreRef ?? A3;
}

function effectiveRef(): RefCoord {
  if (cursor !== null && (cursorNewer || manual === null) && readOutlineMode() === 'piano') return cursor;
  return homeRef();
}

/** Recompute the effective ref, the keyboard anchor and the S/Y anchor from
 *  the tiers. Returns true iff the effective ref or the keyboard anchor
 *  changed; then (unless `notify` is false) runs the ref listener. */
function recompute(notify = true): boolean {
  recomputeAnchor();
  const home = homeRef();
  const sp = refSpine(home.q, home.r, tuning.mapping);
  const dq = sp.q - view.kbAnchorQ, dr = sp.r - view.kbAnchorR;
  const eff = effectiveRef();
  if (eff.q === referenceNote.q && eff.r === referenceNote.r && dq === 0 && dr === 0) return false;
  referenceNote.q = eff.q;
  referenceNote.r = eff.r;
  view.kbAnchorQ = sp.q;
  view.kbAnchorR = sp.r;
  if (notify) refListener?.(dq, dr);
  return true;
}

function recomputeAnchor(): void {
  const a = anchorOverride ?? anchorOf(homeRef().q, tuning.mapping);
  if (a === tuning.anchor) return;
  tuning.anchor = a;
  if (anchorListener === null || anchorNotifyQueued) return;
  anchorNotifyQueued = true;
  queueMicrotask(() => { anchorNotifyQueued = false; anchorListener?.(); });
}

/** Register the ref-change fan-out (ui/init.ts → onRefChanged), called with
 *  the keyboard-anchor delta whenever the effective ref or the keyboard
 *  anchor moves. */
export function setRefListener(fn: (dq: number, dr: number) => void): void {
  refListener = fn;
}

/** Register the anchor-change fan-out (ui/init.ts → onAnchorChanged). */
export function setAnchorListener(fn: () => void): void {
  anchorListener = fn;
}

/** Pin the anchor to a given value — recording playback (the anchor a note was
 *  recorded under) and the overlay mirror (the publisher's anchor). null
 *  releases it back to the tiers. */
export function setAnchorOverride(a: number | null): void {
  anchorOverride = a;
  recomputeAnchor();
}

/** Called by setOutline() when the outline mode changes — the cursor slot
 *  applies only in the piano outline, so the effective ref may change. */
export function recomputeReferenceForOutline(): boolean {
  return recompute();
}

/** Set the manual slot from a user Ctrl+click. Survives composer-bye. */
export function setSelectionFromManual(q: number, r: number): boolean {
  if (manual && manual.q === q && manual.r === r && !cursorNewer) return false;
  manual = { q, r };
  cursorNewer = false;
  return recompute();
}

/** Set the cursor slot from a Composer "previous note in voice" broadcast.
 *  Cleared on composer-bye. */
export function setSelectionFromComposer(q: number, r: number): boolean {
  if (cursor && cursor.q === q && cursor.r === r) return false;
  cursor = { q, r };
  cursorNewer = true;
  return recompute();
}

/** Clear the selection (both slots). Used by Ctrl+click on the current
 *  effective ref-note, the Sync-to-Composer paths, and a tuning / layout change
 *  that invalidates the ref. Returns whether the effective ref or the keyboard
 *  anchor changed. */
export function clearSelection(): boolean {
  if (manual === null && cursor === null) return false;
  manual = null;
  cursor = null;
  cursorNewer = false;
  return recompute();
}

/** True if the manual slot (a user Ctrl+click) is set. */
export function isSelectionManual(): boolean {
  return manual !== null;
}

/** The manual slot's coord (what prefs.manualRef persists), or null. */
export function manualSelection(): RefCoord | null {
  return manual;
}

/** Set the score-ref tier. `clearSelection` (Sync to Composer on) drops both
 *  selection slots in the same step, so the change fans out once. */
export function setScoreRef(q: number, r: number, opts?: { clearSelection?: boolean }): boolean {
  const clear = opts?.clearSelection === true && (manual !== null || cursor !== null);
  if (!clear && scoreRef && scoreRef.q === q && scoreRef.r === r) return false;
  if (clear) { manual = null; cursor = null; cursorNewer = false; }
  scoreRef = { q, r };
  return recompute();
}

export function clearScoreRef(): boolean {
  if (scoreRef === null) return false;
  scoreRef = null;
  return recompute();
}

/** True iff a selection slot is set whose coords differ from the current
 *  scoreRef tier (or scoreRef is unset). Used by the "Sync to Composer" enable
 *  path to decide whether to clear the selection so the lattice snaps to the
 *  score's ref. */
export function selectionDiffersFromScoreRef(): boolean {
  const differs = (c: RefCoord | null): boolean =>
    c !== null && (scoreRef === null || c.q !== scoreRef.q || c.r !== scoreRef.r);
  return differs(manual) || differs(cursor);
}

/** Re-express every tier in a new coordinate frame (mapping switch): `convert`
 *  maps a cell of the old frame to its cell in the new one; a tier whose new
 *  cell fails `isValid` is dropped. Silent — the ref listener does NOT run
 *  (held physical voices keep their (q, r) across a mapping switch); the
 *  caller re-renders. The default A3 is (0, 0) in every frame. */
export function convertReferenceFrame(
  convert: (q: number, r: number) => [number, number],
  isValid: (q: number, r: number) => boolean,
): void {
  const conv = (c: RefCoord | null): RefCoord | null => {
    if (c === null) return null;
    const [q, r] = convert(c.q, c.r);
    return isValid(q, r) ? { q, r } : null;
  };
  manual = conv(manual);
  cursor = conv(cursor);
  scoreRef = conv(scoreRef);
  if (cursor === null) cursorNewer = false;
  recompute(false);
}

/** Apply composer-bye semantics: drop the score-ref tier and the cursor slot.
 *  A manual selection persists. */
export function onComposerBye(): boolean {
  if (scoreRef === null && cursor === null) return false;
  scoreRef = null;
  cursor = null;
  cursorNewer = false;
  return recompute();
}
