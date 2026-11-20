// Public surface for .hkr → .hkc (Composer-native MEI) transcription. Thin
// orchestrator that runs the pipeline and returns both the emitted .hkc and the
// intermediate representations (debug). v2's correction UI consumes the debug IRs.

import type { HkrSession, TranscribeOpts, TranscribeResult } from './types.js';
import { hkrToOnsets } from './onsets.js';
import { estimateTempo } from './tempo.js';
import { trackBeats } from './beats.js';
import { findDownbeatPhase } from './meter.js';
import { groupChords } from './chords.js';
import { quantizeDurations } from './quantize.js';
import { splitVoices } from './voicing.js';
import { emitMei } from './meiEmit.js';
import { isPresetMapping, specOf, type Mapping, type PresetMapping } from '@hkl/shared/mapping.js';
import { anchorIn, convertNote, type NoteFrame } from '@hkl/shared/convert.js';

/** The recording in a frame a score can hold. A score's mapping is one of the
 *  presets (Composer cannot build or store a custom layout), so a recording
 *  made on a custom layout is re-expressed in the finest preset of its
 *  orientation: Chromatic for a plain layout, Park for an inverted one. Each
 *  note goes to the key of that preset with its MIDI note and the closest
 *  pitch (`convertNote`, the whole lattice: a recording has no outline), so
 *  it is exact wherever the preset holds the pitch: from every plain layout in
 *  every tuning; from an inverted one of division 3 or 6; from division 4 or 12
 *  in the banded tunings with pure octave bands (docs/decisions.md, "Composer
 *  converts from custom layouts"). A note-off and an aftertouch follow their
 *  note-on to its key. A preset recording is returned as it is. */
function inScoreFrame(session: HkrSession): HkrSession {
  const from = session.snapshot.mapping;
  if (isPresetMapping(from)) return session;
  const to: PresetMapping = specOf(from).invert ? 'park' : 'chromatic';
  const { tuning: mode, banded } = session.snapshot;
  const frame = (mapping: Mapping, anchor: number): NoteFrame => ({ mode, mapping, anchor, banded });
  /* where each sounding key went, so its note-off and aftertouch go there too */
  const sounding = new Map<string, [number, number]>();
  const struck = <E extends { q: number; r: number }>(e: E, anchor: number): E => {
    const [q, r] = convertNote(e.q, e.r, frame(from, anchor), frame(to, anchorIn(anchor, from, to)))!;
    sounding.set(e.q + ',' + e.r, [q, r]);
    return { ...e, q, r };
  };
  const follow = <E extends { q: number; r: number }>(e: E): E => {
    const [q, r] = sounding.get(e.q + ',' + e.r) ?? convertNote(e.q, e.r, frame(from, session.snapshot.anchor), frame(to, anchorIn(session.snapshot.anchor, from, to)))!;
    return { ...e, q, r };
  };
  return {
    ...session,
    snapshot: { ...session.snapshot, mapping: to, anchor: anchorIn(session.snapshot.anchor, from, to) },
    events: session.events.map((e) => {
      if (e.k === 'on') return e.a === undefined ? struck(e, session.snapshot.anchor) : { ...struck(e, e.a), a: anchorIn(e.a, from, to) };
      return e.k === 'off' || e.k === 'pa' ? follow(e) : e;
    }),
  };
}

export function sessionToHkc(
  recorded: HkrSession,
  opts: TranscribeOpts,
): TranscribeResult {
  const session = inScoreFrame(recorded);
  const onsets = hkrToOnsets(session);
  const tempo = estimateTempo(onsets, opts.bpmHint);
  const beats = trackBeats(onsets, tempo);
  const meter = findDownbeatPhase(onsets, beats, opts.numerator);
  const chords = groupChords(onsets);
  const qnotes = quantizeDurations(chords, beats, meter);
  const voiced = splitVoices(qnotes, meter);
  const hkc = emitMei(voiced, meter, tempo, {
    numerator: meter.numerator,
    title: opts.title,
  }, session.snapshot);
  return {
    hkc,
    debug: { onsets, tempo, beats, meter, chords, qnotes, voiced },
  };
}

export type {
  TranscribeOpts, TranscribeResult, HkrSession,
} from './types.js';
