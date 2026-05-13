// Single source of timestamp truth for capture + playback. Audio-context time
// is preferred because it's what the audio engine ramps schedule against (so
// recorded times align with what the engine actually heard); falls back to
// performance.now() before AudioContext exists.

import { audio } from '../state/audio.js';

export function nowSec(): number {
  return audio.audioCtx ? audio.audioCtx.currentTime : performance.now() / 1000;
}
