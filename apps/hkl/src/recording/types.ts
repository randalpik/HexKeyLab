// Recording domain types. The .hkr file format is the canonical recording —
// JSON, version-stamped, contains a layout snapshot taken at record-start
// plus a flat list of timestamped events. Coordinates `(q, r)` are the source
// of identity; MIDI export is derived from this via midi-io/export.ts.

import type { TuningMode, Mapping } from '../state/persistence.js';

/* How a take's two pedal streams are read. `cc4` is always a damper depth.
   'sostenuto': `cc64` is the sostenuto — every take recorded since the pedal
   jacks got roles of their own (2026-11-12), where `cc4` is the one damper depth
   from every source. 'sustain': an older take made with the single Pedals
   dropdown on Sustain, where `cc64` is a second, binary damper and the damper
   is the deeper of the two. Read from the take by playback; never applied to
   the live pedal settings. */
export type PedalMode = 'sustain' | 'sostenuto';

/* Frozen layout state needed to interpret events. Captured at record-start;
   playback re-applies these fields before scheduling. The recording is
   anchored against refHz (currently always 220) so future exporters
   (Lilypond) and the MIDI round-trip have an explicit pitch reference. */
export interface LayoutSnapshot {
  tuning: TuningMode;
  /** Coordinate frame of every event's (q, r). Absent in files recorded
   *  before mappings existed → 'euler'. */
  mapping: Mapping;
  /** Syntonic / Polysyntonic home band at record-start (anchorOf). Absent in
   *  older files → 0, which every mode before S/Y ignores. A note-on recorded
   *  after a mid-take re-anchor carries its own `a`. */
  anchor: number;
  /** Banded layout (tuning.banded). Absent in files recorded before the
   *  unbanded layout existed → true. */
  banded: boolean;
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
/* `a`: the anchor this note sounded under, present only when it differs from
   snapshot.anchor (a Syntonic / Polysyntonic re-anchor during the take). */
export type HkrEventOn   = { t: number; k: 'on';   q: number; r: number; v: number; a?: number };
export type HkrEventOff  = { t: number; k: 'off';  q: number; r: number };
export type HkrEventPa   = { t: number; k: 'pa';   q: number; r: number; p: number };
/* `cc4`: damper depth, 0..1. `cc64`: 0 or 1 — the sostenuto, or in a 'sustain'
   take a binary damper (PedalMode). Named for the jacks they once mirrored. */
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
