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
import { isPresetMapping, specOf, convertCell, bandOfCell, bandWidth, type Mapping, type PresetMapping } from '@hkl/shared/mapping.js';

/** The recording in a frame a score can hold. A score's mapping is one of the
 *  presets (Composer cannot build or store a custom layout), so a recording
 *  made on a custom layout is re-expressed in the finest preset of its
 *  orientation: Chromatic for a plain layout, Park for an inverted one. Best
 *  effort (docs/decisions.md, "Composer converts from custom layouts"): a
 *  plain layout converts exactly in every tuning; an inverted one exactly from
 *  division 3 or 6, and from division 4 or 12 only in the banded tunings with
 *  pure octave bands. A preset recording is returned as it is. */
function inScoreFrame(session: HkrSession): HkrSession {
  const from = session.snapshot.mapping;
  if (isPresetMapping(from)) return session;
  const to: PresetMapping = specOf(from).invert ? 'park' : 'chromatic';
  const cell = <E extends { q: number; r: number }>(e: E): E => {
    const [q, r] = convertCell(e.q, e.r, from, to);
    return { ...e, q, r };
  };
  return {
    ...session,
    snapshot: { ...session.snapshot, mapping: to, anchor: anchorIn(session.snapshot.anchor, from, to) },
    events: session.events.map((e) => {
      if (e.k === 'on') return e.a === undefined ? cell(e) : { ...cell(e), a: anchorIn(e.a, from, to) };
      return e.k === 'off' || e.k === 'pa' ? cell(e) : e;
    }),
  };
}

/** Home band `anchor` of layout `from`, as a band of layout `to`: the band its
 *  first row-0 cell converts into. */
function anchorIn(anchor: number, from: Mapping, to: Mapping): number {
  const W = bandWidth(from);
  let q = (anchor - 1) * W;
  while (bandOfCell(q, 0, from) < anchor) q++;
  const [q2, r2] = convertCell(q, 0, from, to);
  return bandOfCell(q2, r2, to);
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
