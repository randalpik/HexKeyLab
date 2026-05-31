// Shared DSP types for @hkl/analysis — consumer-agnostic shapes used by the
// loop/decay analysis, gain normalization, tier classifier, and auto-select.
// The analyzer app re-exports these from its src/state.ts alongside its own
// UI-state types; future consumers (e.g. the orchestrator) import them here.

export type Tier = 'green' | 'blue' | 'yellow' | 'red' | 'fail';

/** Per-sample analyzer output. Mirrors the shape of HkiSampleEntry / the
 *  per-sample object in samples-data.ts, plus diagnostic fields used by the
 *  tier classifier and per-row charts. */
export interface AnalysisResult {
  trimStart?: number;
  loopPts?: ReadonlyArray<number> | null;
  segments?: ReadonlyArray<{ a: number; b: number }>;
  freqActual?: number;
  trend?: ReadonlyArray<number>;
  trendHopMs?: number;
  trendStartSec?: number;
  stats?: Record<string, unknown>;
  diag?: Record<string, unknown>;
  failReason?: string;
}

/** Per-sample slot in the analyzer UI table. The DSP layer reads only the
 *  classification-relevant fields (name, midi, freq, tier, result); the
 *  remaining fields are owned by the analyzer UI. */
export interface SampleSlot {
  /** Note name (e.g. "C4"). */
  name: string;
  /** Labeled 12-TET frequency (Hz). */
  freq: number;
  /** 12-TET MIDI note number. */
  midi: number;
  /** CDN URL (cdn mode). */
  url?: string;
  /** Local file handle (local mode). */
  file?: File;
  /** Original local filename (used for provenance.originalFiles). */
  originalFileName?: string;
  /** Explicit filename override for CDN config emission (only when
   *  filePattern + name can't reconstruct the URL). */
  fileOverride?: string;
  /** Decoded buffer kept main-thread for audition + chart rendering. */
  audioBuffer?: AudioBuffer;
  /** Analyzer result from the worker. */
  result?: AnalysisResult;
  /** Per-sample gain factor normalizing to TARGET_DBFS. */
  gain?: number;
  /** Loudness measurement diagnostic (the RMS/loudness value that gain was
   *  computed from), in linear units. */
  measuredLevel?: number;
  /** Tier classification. */
  tier?: Tier;
  /** Status string (success diagnostic or failReason). */
  status?: string;
  /** User-picked (post-auto-select + manual override). */
  picked: boolean;
  /** Lifecycle state of this slot. */
  state: 'pending' | 'fetching' | 'decoding' | 'analyzing' | 'done' | 'failed';
}

/** Loose Record so future analyzer-opt additions don't break the form. */
export interface GateOpts {
  rmsStepThreshold?: number;
  slopeStepThreshold?: number;
  slopeStrideSec?: number;
  corrThreshold?: number;
  pitchStepThresholdCents?: number;
  tiltStepThreshold?: number;
  trustLabeledPitch?: boolean;
  /** Inclusive note range. Each entry is a note name like "E2". */
  keepAllGreenRange?: [string, string] | null;
}
