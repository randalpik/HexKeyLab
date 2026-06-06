// Tuning state changed — fan-out: ramp active voices to new frequencies, mark
// the hex layer dirty (re-coloring), redraw, and (optionally) re-push device
// colors to the Lumatone.
//
// `colorSync: false` skips the (expensive) color push — reserved for repeat
// handlers that fire many tuning-state mutations in quick succession and want
// to defer color sync to a single fire on release.

import { rampActiveFreqs } from '../audio/engine.js';
import { applyTuningRender } from '../render/controls-core.js';
import { syncLumatoneColors } from '../lumatone/sync.js';
import { broadcastAllToComposer, refreshComposerToolbar } from '../bridge/hkl-side.js';

export interface TuningChangedOpts {
  rampSec?: number;
  colorSync?: boolean;
}

export function onTuningChanged(opts?: TuningChangedOpts): void {
  const rampSec = opts && opts.rampSec !== undefined ? opts.rampSec : 0.15;
  const colorSync = !opts || opts.colorSync !== false;
  rampActiveFreqs(rampSec);
  /* Render fan-out (re-color/respell, regenerate 88-cell footprint, recompute
     bounds, re-snap, redraw) lives in render/controls-core so the engine-free
     overlay subscriber can reuse it. */
  applyTuningRender();
  if (colorSync) syncLumatoneColors();
  /* Tuning shifts spelling/color for the same coords and can change which
     cells the active outline considers valid; Composer needs all three
     payloads refreshed. */
  broadcastAllToComposer();
  refreshComposerToolbar();
}
