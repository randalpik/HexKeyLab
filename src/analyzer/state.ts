// Analyzer UI state shape — the single mutable AnalyzerState plus per-sample
// SampleSlot. All view modules read this via stage.ts and dispatch updates
// through stage.setState / updateSample helpers.

import type { NoteStyle } from '@hkl/shared/cdnConfig.js';

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

/** Per-sample slot in the UI table. */
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

export interface ConfigState {
  instrumentKey: string;
  displayName: string;
  noteStyle: NoteStyle;
  lowOct: number;
  highOct: number;
  /** Audio offset from filename label, in semitones (12 = octave, 100¢ each).
   *  0 = audio matches label. Negative = audio below label (Hammond convention:
   *  filename C4 sounds at C3 → transposeSemis = -12). Stored as an integer
   *  in the form; emitted at output as `transpose = 2^(-semis/12)` (the legacy
   *  ratio multiplier expected by samples-engine.ts:351). */
  transposeSemis: number;
  decays: boolean;
  vibrato: boolean;
  releaseTime: number;
  volume: number;
}

export interface CdnSourceState {
  mode: 'cdn';
  baseUrl: string;
  /** Ordered fallback pattern list. The primary pattern is filePatterns[0];
   *  the form's "Add fallback" button appends to this list. */
  filePatterns: string[];
}

export interface LocalSourceState {
  mode: 'local';
  /** Raw File handles dropped/selected by the user. */
  files: File[];
}

export type SourceState = CdnSourceState | LocalSourceState;

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

export interface AnalyzerState {
  config: ConfigState;
  source: SourceState;
  samples: SampleSlot[];
  opts: GateOpts;
  autoSelectEnabled: boolean;
  /** Status string shown in the analyze controls. */
  status: string;
  /** Progress 0..1 while analyzing. */
  progress: number;
}

export function initialConfig(): ConfigState {
  return {
    instrumentKey: '',
    displayName: '',
    noteStyle: 'flat',
    lowOct: 2,
    highOct: 6,
    transposeSemis: 0,
    decays: false,
    vibrato: true,
    releaseTime: 0.3,
    volume: 1.0,
  };
}

export function initialState(): AnalyzerState {
  return {
    config: initialConfig(),
    source: { mode: 'local', files: [] },
    samples: [],
    opts: {},
    autoSelectEnabled: true,
    status: 'Drop files or enter a CDN URL to begin.',
    progress: 0,
  };
}
