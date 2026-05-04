// Tuning state changed — fan-out: ramp active voices to new frequencies, mark
// the hex layer dirty (re-coloring), redraw, and (optionally) re-push device
// colors to the Lumatone.
//
// `colorSync: false` is used by shiftSeams's auto-fire repeat handler — it
// defers the (expensive) color push until the user releases the button, then
// fires one final syncLumatoneColors() on mouseup.

import { view } from '../state/view.js';
import { rampActiveFreqs } from '../audio/engine.js';
import { draw } from '../render/draw.js';
import { syncLumatoneColors } from '../lumatone/sync.js';

export interface TuningChangedOpts {
  rampSec?: number;
  colorSync?: boolean;
}

export function onTuningChanged(opts?: TuningChangedOpts): void {
  const rampSec = opts && opts.rampSec !== undefined ? opts.rampSec : 0.15;
  const colorSync = !opts || opts.colorSync !== false;
  rampActiveFreqs(rampSec);
  view.hexDirty = true;
  draw();
  if (colorSync) syncLumatoneColors();
}
