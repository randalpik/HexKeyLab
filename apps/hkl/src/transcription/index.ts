// Public surface for .hkr → LilyPond transcription. Thin orchestrator that
// runs the pipeline and returns both the rendered .ly and the intermediate
// representations (debug). v2's correction UI consumes the debug IRs.

import type { HkrSession, TranscribeOpts, TranscribeResult } from './types.js';
import { hkrToOnsets } from './onsets.js';
import { estimateTempo } from './tempo.js';
import { trackBeats } from './beats.js';
import { findDownbeatPhase } from './meter.js';
import { groupChords } from './chords.js';
import { quantizeDurations } from './quantize.js';
import { splitVoices } from './voicing.js';
import { emitLilypond } from './lyEmit.js';

export function sessionToLilypond(
  session: HkrSession,
  opts: TranscribeOpts,
): TranscribeResult {
  const onsets = hkrToOnsets(session);
  const tempo = estimateTempo(onsets, opts.bpmHint);
  const beats = trackBeats(onsets, tempo);
  const meter = findDownbeatPhase(onsets, beats, opts.numerator);
  const chords = groupChords(onsets);
  const qnotes = quantizeDurations(chords, beats, meter);
  const voiced = splitVoices(qnotes, meter);
  const ly = emitLilypond(voiced, {
    numerator: meter.numerator,
    bpm: tempo.bpm,
    title: opts.title,
  });
  return {
    ly,
    debug: { onsets, tempo, beats, meter, chords, qnotes, voiced },
  };
}

export type {
  TranscribeOpts, TranscribeResult, HkrSession,
} from './types.js';
