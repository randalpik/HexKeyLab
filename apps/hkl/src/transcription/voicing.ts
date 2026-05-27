// Middle-C (MIDI 60) threshold split, per-chord. Both staves carry the full
// timing skeleton; pitches < 60 go to bass, pitches ≥ 60 go to treble, and
// the off-hand staff fills with rests of identical duration.
//
// After splitting, consecutive rests in each voice are consolidated — merged
// into a single duration, sliced at bar boundaries, and re-run through the
// duration DP. That way a bar with no notes in one staff renders as a single
// whole rest instead of mirroring the other staff's note shapes, and a
// partial run of rest renders as the tightest possible engraving (e.g.
// quarter + half rather than six 8ths).

import type { QNote, QNoteAtom, VoicedScore, Meter } from './types.js';
import { precomputeWeights, splitDuration } from './quantize.js';

const SPLIT_MIDI = 60;

function clearTies(atoms: QNoteAtom[]): QNoteAtom[] {
  return atoms.map((a) => ({
    durTicks: a.durTicks,
    notation: { base: a.notation.base, dots: a.notation.dots, tied: false },
  }));
}

function asRest(q: QNote): QNote {
  return {
    startTick: q.startTick,
    durTicks: q.durTicks,
    atoms: clearTies(q.atoms),
    pitches: [],
    colors: [],
    lyPitches: [],
    sourceOnsetIds: [],
    isRest: true,
  };
}

interface SubsetIdx {
  pitches: number[];
  colors: string[];
  lyPitches: string[];
  sourceOnsetIds: number[];
}

function pick(q: QNote, indices: number[]): SubsetIdx {
  return {
    pitches: indices.map((i) => q.pitches[i]),
    colors: indices.map((i) => q.colors[i]),
    lyPitches: indices.map((i) => q.lyPitches[i]),
    sourceOnsetIds: indices.map((i) => q.sourceOnsetIds[i]),
  };
}

function consolidateRests(
  voice: QNote[],
  meter: Meter,
  weights: Float32Array,
): QNote[] {
  const out: QNote[] = [];
  const barTicks = meter.subdivisions * meter.numerator;
  let i = 0;
  while (i < voice.length) {
    if (!voice[i].isRest) {
      out.push(voice[i]);
      i++;
      continue;
    }
    /* Sum a consecutive run of rests. */
    const startTick = voice[i].startTick;
    let totalDur = 0;
    let j = i;
    while (j < voice.length && voice[j].isRest) {
      totalDur += voice[j].durTicks;
      j++;
    }
    /* Slice at bar boundaries and re-DP each slice. The DP treats each slice
       as a fresh duration, so longer/cleaner atoms (dotted halves, whole bars)
       emerge naturally. */
    let pos = startTick;
    let remaining = totalDur;
    while (remaining > 0) {
      const barEnd = (Math.floor(pos / barTicks) + 1) * barTicks;
      const sliceLen = Math.min(remaining, barEnd - pos);
      const atoms = splitDuration(pos, sliceLen, weights, true);
      out.push({
        startTick: pos,
        durTicks: sliceLen,
        atoms,
        pitches: [],
        colors: [],
        lyPitches: [],
        sourceOnsetIds: [],
        isRest: true,
      });
      pos += sliceLen;
      remaining -= sliceLen;
    }
    i = j;
  }
  return out;
}

export function splitVoices(qnotes: QNote[], meter: Meter): VoicedScore {
  const treble: QNote[] = [];
  const bass: QNote[] = [];

  for (const q of qnotes) {
    if (q.isRest) {
      treble.push(q);
      bass.push(q);
      continue;
    }

    const hi: number[] = [];
    const lo: number[] = [];
    for (let i = 0; i < q.pitches.length; i++) {
      if (q.pitches[i] >= SPLIT_MIDI) hi.push(i);
      else lo.push(i);
    }

    if (hi.length > 0 && lo.length > 0) {
      const t = pick(q, hi);
      const b = pick(q, lo);
      treble.push({ ...q, atoms: q.atoms, ...t });
      bass.push({ ...q, atoms: q.atoms, ...b });
    } else if (hi.length > 0) {
      treble.push(q);
      bass.push(asRest(q));
    } else {
      treble.push(asRest(q));
      bass.push(q);
    }
  }

  const weights = precomputeWeights(meter);
  return {
    treble: consolidateRests(treble, meter, weights),
    bass: consolidateRests(bass, meter, weights),
  };
}
