// Tuning state changed — fan-out: ramp active voices to new frequencies, mark
// the hex layer dirty (re-coloring), redraw, and (optionally) re-push device
// colors to the Lumatone.
//
// `colorSync: false` skips the (expensive) color push — reserved for repeat
// handlers that fire many tuning-state mutations in quick succession and want
// to defer color sync to a single fire on release.

import { view } from '../state/view.js';
import { rampActiveFreqs } from '../audio/engine.js';
import { cv, draw, invalidatePianoOutline, snapViewForOutline } from '../render/draw.js';
import { recomputeCanvasBounds } from '../render/canvas.js';
import { syncLumatoneColors } from '../lumatone/sync.js';
import { broadcastAllToComposer } from '../bridge/hkl-side.js';
import type { OutlineMode } from '../state/persistence.js';

export interface TuningChangedOpts {
  rampSec?: number;
  colorSync?: boolean;
}

export function onTuningChanged(opts?: TuningChangedOpts): void {
  const rampSec = opts && opts.rampSec !== undefined ? opts.rampSec : 0.15;
  const colorSync = !opts || opts.colorSync !== false;
  rampActiveFreqs(rampSec);
  view.hexDirty = true;
  /* Tenney-Height ranking in compute88PianoCoords depends on tuning mode
     via jiRatio — invalidate so the next draw regenerates the 88-cell
     footprint with up-to-date region adjustments. */
  invalidatePianoOutline();
  /* Switching tuning mode (5 ↔ 7 ↔ E) can change the required CH/kbMinW
     AND can shift MIDI 64's cell in 7-limit, so we also re-snap the
     viewport — the stale viewQ/viewR would otherwise leave the polygon
     and dark-overlay rect off-center. */
  recomputeCanvasBounds();
  cv.style.height = view.CH + 'px';
  const sel = document.getElementById('selOutline') as HTMLSelectElement | null;
  const outline: OutlineMode = (sel?.value === 'qwerty' || sel?.value === 'piano' || sel?.value === 'none')
    ? sel.value : 'lumatone';
  snapViewForOutline(outline);
  draw();
  if (colorSync) syncLumatoneColors();
  /* Tuning shifts spelling/color for the same coords and can change which
     cells the active outline considers valid; Composer needs all three
     payloads refreshed. */
  broadcastAllToComposer();
}
