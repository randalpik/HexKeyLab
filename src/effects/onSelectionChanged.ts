// Selection state changed — fan-out: sync output (audio + MIDI voices follow
// the new selection), redraw (info panel updates inside draw()).
//
// Called from: click handler, MIDI note-on/off, sustain-pedal release.

import { syncOutput } from '../midi/engine.js';
import { draw } from '../render/draw.js';

export function onSelectionChanged(): void {
  syncOutput();
  draw();
}
