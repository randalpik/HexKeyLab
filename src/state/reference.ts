// Reference-note state. Defines the lattice cell that piano-keyboard 12-TET
// input is resolved against, and that the piano outline / dashed marker
// center on.
//
// Three tiers, first one set wins:
//   1. selection — most recently set by user Ctrl+click or by Composer's
//      "previous note in voice" broadcast. Last writer wins; the two sources
//      coexist in one slot, distinguished only by `source` (for composer-bye
//      semantics — manual selections survive a Composer disconnect).
//   2. songKey — set by Composer when the key signature changes. Independent
//      of cursor movement.
//   3. default — A3 at (0, 0).
//
// Composer never broadcasts clear-* messages — its cursor moving past an
// empty stretch does NOT clear the selection. Tier-clearing happens only via
// user Ctrl+click (clears selection) or `composer-bye` (clears songKey and
// composer-set selection).
//
// `referenceNote: { q, r }` is the effective coord — kept in sync with the
// tiers on every mutation so existing read-only consumers (src/render/draw.ts,
// src/midi/piano.ts, src/ui/controls.ts) don't need to change.

interface RefSelection {
  q: number;
  r: number;
  source: 'manual' | 'composer';
}
interface RefSongKey {
  q: number;
  r: number;
}

let selection: RefSelection | null = null;
let songKey: RefSongKey | null = null;

/** The effective reference note. Mutated by recompute() after any tier
 *  change. Consumers should read .q / .r and never mutate. */
export const referenceNote: { q: number; r: number } = { q: 0, r: 0 };

/** Recompute the effective ref from tiers. Mutates `referenceNote` in place.
 *  Returns true iff the effective coord changed. */
function recompute(): boolean {
  const tQ = selection ? selection.q : (songKey ? songKey.q : 0);
  const tR = selection ? selection.r : (songKey ? songKey.r : 0);
  if (tQ === referenceNote.q && tR === referenceNote.r) return false;
  referenceNote.q = tQ;
  referenceNote.r = tR;
  return true;
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

export function setSongKey(q: number, r: number): boolean {
  if (songKey && songKey.q === q && songKey.r === r) return false;
  songKey = { q, r };
  return recompute();
}

export function clearSongKey(): boolean {
  if (songKey === null) return false;
  songKey = null;
  return recompute();
}

/** Apply composer-bye semantics: drop the song-key tier, and drop the
 *  selection tier iff it was composer-set. A manual selection persists. */
export function onComposerBye(): boolean {
  let changed = false;
  if (songKey !== null) { songKey = null; changed = true; }
  if (selection !== null && selection.source === 'composer') { selection = null; changed = true; }
  if (!changed) return false;
  return recompute();
}
