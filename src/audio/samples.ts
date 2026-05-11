// Barrel: assembles the legacy SampleEngine surface from samples-data + samples-engine.
// Consumers (engine.ts, ui/controls.ts, input/keyboard-notes.ts, diagnostics/loopOverlay.ts)
// import SampleEngine from here and call it via the same shape the v0.9 IIFE returned.

import * as engine from './samples-engine.js';
import { INSTRUMENTS } from './samples-data.js';

export const SampleEngine = {
  INSTRUMENTS,
  init: engine.init,
  loadInstrument: engine.loadInstrument,
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
