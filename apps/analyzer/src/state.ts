// Analyzer UI state shape — the single mutable AnalyzerState plus per-sample
// SampleSlot. All view modules read this via stage.ts and dispatch updates
// through stage.setState / updateSample helpers.

import type { NoteStyle } from '@hkl/shared/cdnConfig.js';
import type { SampleSlot, GateOpts } from '@hkl/analysis/types.js';

// DSP types now live in @hkl/analysis (shared with the orchestrator). Re-export
// them here so existing analyzer modules keep importing from './state.js'.
export type { Tier, AnalysisResult, SampleSlot, GateOpts } from '@hkl/analysis/types.js';

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
