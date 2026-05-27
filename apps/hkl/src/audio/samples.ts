// Barrel: assembles the legacy SampleEngine surface from the HKL instrument
// registry (samples-data) + the standalone playback engine (@hkl/engine).
// Consumers (engine.ts, ui/controls.ts, input/keyboard-notes.ts,
// diagnostics/loopOverlay.ts) import SampleEngine from here and call it via the
// same shape the v0.9 IIFE returned. The engine is instrument-agnostic now:
// loadInstrument takes the instrument definition, so this barrel injects
// INSTRUMENTS[key] (the HKL-side Proxy that merges shipped + imported bundles).

import * as engine from '@hkl/engine/samples-engine.js';
import { INSTRUMENTS } from './samples-data.js';

export { inflightExpRampValue } from '@hkl/engine/samples-engine.js';
export type { PaRampState, SeamEvent, SampleEngineConfig } from '@hkl/engine/samples-engine.js';

export const SampleEngine = {
  INSTRUMENTS,
  init: engine.init,
  loadInstrument: (key: string, onProgress?: (loaded: number, total: number, name: string) => void) =>
    engine.loadInstrument(key, INSTRUMENTS[key], onProgress),
  noteOn: engine.sNoteOn,
  noteOff: engine.sNoteOff,
  rampFreq: engine.sRampFreq,
  slideAndFadeOut: engine.sSlideAndFadeOut,
  noteOnFaded: engine.sNoteOnFaded,
  hardStop: engine.sHardStop,
  hardStopAll: engine.sHardStopAll,
  stopAll: engine.sStopAll,
  setAftertouch: engine.sSetAftertouch,
  setVoiceDamperDepth: engine.sSetVoiceDamperDepth,
  getActiveVoices: engine.getActiveVoices,
  isLoaded: engine.isLoaded,
  setInstrument: engine.setInstrument,
  isInstrumentLoaded: engine.isInstrumentLoaded,
  unloadInstrument: engine.unloadInstrument,
  tapMaster: engine.tapMaster,
};
