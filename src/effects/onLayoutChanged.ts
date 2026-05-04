// Layout (tuning.curLayout) changed — fan-out: rebuild the (note, channel) →
// "q,r" reverse lookup for MIDI input, push device colors, and sync output
// (audio + MIDI). The view animation runs in parallel via the raf scheduled
// by setLayout (color push is intentionally fired BEFORE the animation so
// it runs in parallel with the 500 ms tween).

import { syncLumatoneColors } from '../lumatone/sync.js';
import { buildMidiReverse, syncOutput } from '../midi/engine.js';

export function onLayoutChanged(): void {
  syncLumatoneColors();
  buildMidiReverse();
  syncOutput();
}
