// Single import point for the @hkl/analysis DSP the orchestrator reuses (gain
// normalization, loudness, buffer builders, fundamental refinement). The rest of
// the app imports from here so the dependency surface is in one place.

export {
  computeGain,
  measureDecay,
  measureRmsLoop,
  buildInterleavedStereo,
  buildMonoDownmix,
  type MeasureResult,
} from '@hkl/analysis/normalize.js';

// Untyped DOM-free DSP module (no .d.ts) — HKLAnalysis namespace object.
// @ts-ignore .js module with no types
import { HKLAnalysis } from '@hkl/analysis/analyzer-analysis.js';
export { HKLAnalysis };
