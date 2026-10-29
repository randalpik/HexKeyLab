// Ref-change fan-out — the ONE listener state/reference.ts runs, synchronously,
// whenever the effective reference note or the keyboard anchor moves. Every
// path that changes a ref tier (Ctrl+click, Composer's score-ref / cursor note
// / bye, Sync enable, a tuning change that invalidates the ref, an outline
// switch) lands here, so none can leave the lattice centered on an old ref or a
// held voice on the wrong cell.
//
// (dq, dr) = the keyboard-anchor delta: the lattice slid under the static
// Lumatone/QWERTY/none outlines by that much. Voices originating from PHYSICAL
// inputs (Lumatone MIDI, QWERTY keys) follow their physical key — they migrate
// from the old lattice cell to the new one so a held key keeps sounding the
// right relative pitch. Voices originating from MOUSE CLICKS stay anchored to
// the lattice cell they were clicked on.
//
// The view snaps to the active outline's center; a Ctrl+click slides there
// instead (withRefSlide).

import { migrateHeldQwertyVoices } from '../input/keyboard-notes.js';
import { migrateHeldLumatoneVoices } from '../midi/handler.js';
import { syncLumatoneColors } from '../lumatone/sync.js';
import { broadcastAllToComposer } from '../bridge/hkl-side.js';
import { draw, invalidatePianoOutline } from '../render/draw.js';
import { syncViewToOutline, outlineFromDom } from '../render/controls-core.js';
import { onSelectionChanged } from './onSelectionChanged.js';

let slide = false;

/** Run a ref mutation whose re-center should slide rather than snap (the
 *  user's Ctrl+click). Returns the mutation's result. */
export function withRefSlide<T>(mutate: () => T): T {
  slide = true;
  try { return mutate(); } finally { slide = false; }
}

/** A different lattice cell now sits under each physical key — the anchor
 *  moved, or the alignment re-posed the layout (layout/physical.ts). Each held
 *  Lumatone / QWERTY input re-resolves through the current map and its voice
 *  follows the key (input/held.ts migrateHeld), one selection sync for both
 *  sources; then a Lumatone color diff so the LEDs follow the cells (self-gates
 *  on autoSyncEnabled + midiOut). */
export function remapPhysicalInputs(): void {
  const moved = migrateHeldQwertyVoices() + migrateHeldLumatoneVoices();
  if (moved) onSelectionChanged();
  syncLumatoneColors();
}

export function onRefChanged(dq: number, dr: number): void {
  /* kbAnchor is already advanced. */
  if (dq !== 0 || dr !== 0) remapPhysicalInputs();
  /* The piano footprint tracks the ref; the view centers on the ref (piano)
     or the keyboard anchor (every other outline). */
  invalidatePianoOutline();
  syncViewToOutline(outlineFromDom(), !slide);
  draw();
  /* Resolved spelling/oct/midi of every held key changes when the lattice
     slides, and the footprint + layout-state track the ref even when the
     keyboard anchor didn't move (different refs share a spine). Sig-diff
     cached, so redundant calls are free. */
  broadcastAllToComposer();
}
