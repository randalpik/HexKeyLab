// Recording domain types. The .hkr file format is the canonical recording —
// JSON, version-stamped, contains a layout snapshot taken at record-start
// plus a flat list of timestamped events. Coordinates `(q, r)` are the source
// of identity; MIDI export is derived from this via midi-io/export.ts.

import type { TuningMode, PedalMode } from '../state/persistence.js';

/* Frozen layout state needed to interpret events. Captured at record-start;
   playback re-applies these fields before scheduling. The recording is
   anchored against refHz (currently always 220) so future exporters
   (Lilypond) and the MIDI round-trip have an explicit pitch reference. */
export interface LayoutSnapshot {
  tuning: TuningMode;
  septimalEnabled: boolean;
  equalEnabled: boolean;
  septimalW: number;
  instrument: string;
  pedalMode: PedalMode;
  refHz: number;
}

/* All events carry a `t` in seconds from `epoch=0`. Unit matches the audio
   engine clock (audioCtxSec) — that's the same clock the capture hook reads.
   `warn` is informational only (e.g. layout changed mid-record); playback
   ignores it. */
export type HkrEventOn   = { t: number; k: 'on';   q: number; r: number; v: number };
export type HkrEventOff  = { t: number; k: 'off';  q: number; r: number };
export type HkrEventPa   = { t: number; k: 'pa';   q: number; r: number; p: number };
export type HkrEventCc4  = { t: number; k: 'cc4';  v: number };
export type HkrEventCc64 = { t: number; k: 'cc64'; v: number };
export type HkrEventWarn = { t: number; k: 'warn'; msg: string };
export type HkrEvent =
  | HkrEventOn | HkrEventOff | HkrEventPa
  | HkrEventCc4 | HkrEventCc64 | HkrEventWarn;

export interface HkrSession {
  format: 'hkr';
  version: 1;
  createdAt: string;
  durationSec: number;
  timing: { unit: 'audioCtxSec'; epoch: 0 };
  snapshot: LayoutSnapshot;
  events: HkrEvent[];
}

export type TransportMode = 'idle' | 'recording' | 'playing';
