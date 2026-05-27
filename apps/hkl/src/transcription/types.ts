// Transcription intermediate representations. The pipeline is
//   hkr → onsets → tempo → beats → meter → chords → qnotes → voiced → .hkc
// Each stage produces one of the types here; identity (Onset.id) flows
// end-to-end so a future correction UI can map back from a notehead to the
// raw events that produced it.

import type { HkrSession } from '../recording/types.js';

/* ── stage 1: paired onsets ──────────────────────────────────────────────── */

export interface Onset {
  /** stable identity through the pipeline */
  id: number;
  /** onset time in seconds (audioCtx clock, same as .hkr) */
  t: number;
  /** release time in seconds; null if never released in the recording */
  tOff: number | null;
  /** origin lattice coords (preserved end-to-end for color and v2 round-trip) */
  q: number;
  r: number;
  /** nominal 12-TET MIDI note number = 57 + 4q + 7r */
  midi: number;
  /** MIDI velocity 0..127 */
  v: number;
  /** onset weight used by beat tracker; (v / 127) + density bonus */
  strength: number;
  /** dark-luminance hex string ('#rrggbb') used as notehead color */
  colorHex: string;
}

/* ── stage 2: tempo estimate ─────────────────────────────────────────────── */

export interface TempoEstimate {
  bpm: number;
  periodSec: number;
  /** 0..1 — autocorrelation peak strength after prior weighting */
  confidence: number;
}

/* ── stage 3: beat grid ──────────────────────────────────────────────────── */

export interface Beat {
  /** absolute time in seconds */
  t: number;
  /** index along the beat sequence (0 = first beat) */
  idx: number;
}

export interface BeatGrid {
  beats: Beat[];
  periodSec: number;
}

/* ── stage 4: meter (downbeat phase + grid resolution) ───────────────────── */

export interface Meter {
  numerator: number;
  /** 4 = quarter beat unit, 8 = eighth beat unit (v1 only emits 4) */
  denominator: 4 | 8;
  /** index in BeatGrid.beats that is bar 1, beat 1 */
  downbeatBeatIdx: number;
  /** grid cells per beat (32 = 1/128-note resolution) */
  subdivisions: number;
}

/* ── stage 5: chord-grouped events ──────────────────────────────────────── */

export interface ChordEvent {
  /** representative onset time (median of cluster) */
  t: number;
  /** latest release time across cluster */
  tOff: number;
  /** member onsets, preserved for color, identity, and v2 edits */
  onsets: Onset[];
}

/* ── stage 6: quantized notes ────────────────────────────────────────────── */

export type NotationBase = '1' | '2' | '4' | '8' | '16' | '32';

export interface NotationSpec {
  base: NotationBase;
  /** 0 = plain, 1 = dotted (v1 stops at single dot) */
  dots: 0 | 1;
  /** true when this atom continues a tied chain (no timing-error cost) */
  tied: boolean;
}

export interface QNoteAtom {
  /** ticks (grid cells) consumed by this atom */
  durTicks: number;
  notation: NotationSpec;
}

export interface QNote {
  /** absolute grid position (subdivisions from t=0 / from beat 0) */
  startTick: number;
  /** total duration in ticks (sum of atoms) */
  durTicks: number;
  /** decomposition into renderable atoms (one element = no tie) */
  atoms: QNoteAtom[];
  /** sorted MIDI note numbers; empty array means a rest */
  pitches: number[];
  /** dark hex colors, parallel to pitches */
  colors: string[];
  /** origin lattice coords, parallel to pitches — the exact (q, r) the emitter
   *  spells from (MIDI alone can't disambiguate enharmonic lattice cells) */
  coords: { q: number; r: number }[];
  /** identity back-pointers */
  sourceOnsetIds: number[];
  /** true when this QNote represents a rest (pitches.length === 0) */
  isRest: boolean;
}

/* ── stage 7: voice-split ────────────────────────────────────────────────── */

export interface VoicedScore {
  treble: QNote[];
  bass: QNote[];
}

/* ── public API ──────────────────────────────────────────────────────────── */

export interface TranscribeOpts {
  /** numerator of the user-supplied time signature (denominator fixed at 4 in v1) */
  numerator: number;
  /** optional BPM hint; when supplied, tempo search is constrained to ±15% */
  bpmHint: number | null;
  /** score title (MEI fileDesc / titleStmt) */
  title: string;
}

export interface TranscribeDebug {
  onsets: Onset[];
  tempo: TempoEstimate;
  beats: BeatGrid;
  meter: Meter;
  chords: ChordEvent[];
  qnotes: QNote[];
  voiced: VoicedScore;
}

export interface TranscribeResult {
  /** complete `.hkc` (MEI 5) document string, ready to download or bridge */
  hkc: string;
  debug: TranscribeDebug;
}

export type { HkrSession };
