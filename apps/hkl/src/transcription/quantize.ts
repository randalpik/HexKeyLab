// Position and duration quantization. The load-bearing module.
//
// Stage A: snap chord onset times and release times to integer tick positions
//   on the 8th-note grid (16-tick multiples). The tick origin anchors at the
//   first chord, so the user's first onset = bar 1, beat 1, tick 0.
//   Merge chords landing on the same tick.
//
// Stage B: walk bar-by-bar. For each chord, the renderable duration is bounded
//   by the next onset and the chord's own release. A clear release gap before
//   the next onset becomes a rest. Durations that cross a bar boundary are
//   split at the bar so the DP runs strictly within a bar.
//
// Stage C: for each (startTick, durTicks, isRest) event, run a DP that
//   decomposes the duration into a sequence of (atom, notation) atoms. Cost
//   penalizes complexity, ties (prefer one note over many), and crossings of
//   stronger metric boundaries.
//
// v1 atom set is deliberately small: 8th, quarter, dotted-quarter, half,
// dotted-half, whole. No 16ths, no 32nds, no dotted-8ths. Anything shorter
// than an 8th in real time gets folded into its neighbors.

import type {
  ChordEvent, BeatGrid, Meter, QNote, QNoteAtom, NotationBase,
} from './types.js';

const TICK_GRID = 16;       /* snap to 8th-note grid */
const REST_MIN_TICKS = 16;  /* below this, fold silence into the preceding note */
const TIE_COST = 0.40;      /* per non-final atom; deters unnecessary fragmentation */
const BOUNDARY_WEIGHT = 0.05;

interface Atom {
  durTicks: number;
  base: NotationBase;
  dots: 0 | 1;
  complexity: number;
}

const ATOMS: Atom[] = [
  { durTicks: 16,  base: '8',  dots: 0, complexity: 0.10 },
  { durTicks: 32,  base: '4',  dots: 0, complexity: 0.00 },
  { durTicks: 48,  base: '4',  dots: 1, complexity: 0.30 },
  { durTicks: 64,  base: '2',  dots: 0, complexity: 0.05 },
  { durTicks: 96,  base: '2',  dots: 1, complexity: 0.35 },
  { durTicks: 128, base: '1',  dots: 0, complexity: 0.10 },
];

/* ── tick conversion ──────────────────────────────────────────────────────── */

function tickAtTime(t: number, beats: BeatGrid, meter: Meter): number {
  const B = beats.beats;
  if (B.length === 0) return 0;
  if (t <= B[0].t) {
    const offset = (t - B[0].t) / beats.periodSec;
    return Math.round(offset * meter.subdivisions);
  }
  for (let j = 0; j < B.length - 1; j++) {
    if (t < B[j + 1].t) {
      const localPeriod = B[j + 1].t - B[j].t;
      const frac = (t - B[j].t) / localPeriod;
      return Math.round((j + frac) * meter.subdivisions);
    }
  }
  const i = B.length - 1;
  const offset = (t - B[i].t) / beats.periodSec;
  return Math.round((i + offset) * meter.subdivisions);
}

function snapToGrid(tick: number): number {
  return Math.round(tick / TICK_GRID) * TICK_GRID;
}

/* ── metric weights and boundary penalty ──────────────────────────────────── */

function metricWeight(tickInBar: number, meter: Meter): number {
  const sub = meter.subdivisions;
  if (tickInBar === 0) return 100;
  if (tickInBar % sub === 0) {
    const beatIdx = tickInBar / sub;
    /* midpoint of an even-numerator bar is a strong secondary downbeat */
    if ((meter.numerator & 1) === 0 && beatIdx === meter.numerator / 2) return 50;
    return 25;
  }
  for (let level = 1; level <= 5; level++) {
    const unit = sub >> level;
    if (unit > 0 && tickInBar % unit === 0) return 10 - level * 2;
  }
  return 0;
}

export function precomputeWeights(meter: Meter): Float32Array {
  const barTicks = meter.subdivisions * meter.numerator;
  const w = new Float32Array(barTicks);
  for (let t = 0; t < barTicks; t++) w[t] = metricWeight(t, meter);
  return w;
}

function boundaryPenalty(
  startTick: number,
  durTicks: number,
  weights: Float32Array,
): number {
  const barTicks = weights.length;
  const startInBar = ((startTick % barTicks) + barTicks) % barTicks;
  const startW = weights[startInBar];
  let worst = 0;
  for (let i = 1; i < durTicks; i++) {
    const w = weights[(startInBar + i) % barTicks];
    if (w > worst) worst = w;
  }
  return Math.max(0, worst - startW) * BOUNDARY_WEIGHT;
}

/* ── duration → atom sequence (per-event DP) ──────────────────────────────── */

export function splitDuration(
  startTick: number,
  totalDur: number,
  weights: Float32Array,
  isRest: boolean,
): QNoteAtom[] {
  if (totalDur <= 0) return [];

  /* dp[i] = optimal cost to fill ticks (totalDur - i) starting at offset i. */
  const dp = new Float64Array(totalDur + 1).fill(Infinity);
  const choice: (Atom | null)[] = new Array(totalDur + 1).fill(null);
  dp[totalDur] = 0;

  for (let i = totalDur - 1; i >= 0; i--) {
    const pos = startTick + i;
    const remaining = totalDur - i;
    for (const a of ATOMS) {
      if (a.durTicks > remaining) break;
      const j = i + a.durTicks;
      const isLast = j === totalDur;
      const tieCost = isLast ? 0 : TIE_COST;
      const bndPen = boundaryPenalty(pos, a.durTicks, weights);
      const restPen = (isRest && a.dots > 0) ? 0.5 : 0;
      const cost = a.complexity + tieCost + bndPen + restPen + dp[j];
      if (cost < dp[i]) { dp[i] = cost; choice[i] = a; }
    }
  }

  if (!Number.isFinite(dp[0])) {
    /* Fallback: cover with the largest atom that fits, repeatedly. */
    return greedyFallback(totalDur);
  }

  const atoms: QNoteAtom[] = [];
  let i = 0;
  while (i < totalDur) {
    const a = choice[i];
    if (!a) break;
    const isLast = (i + a.durTicks) === totalDur;
    atoms.push({
      durTicks: a.durTicks,
      notation: { base: a.base, dots: a.dots, tied: !isLast },
    });
    i += a.durTicks;
  }
  return atoms;
}

function greedyFallback(totalDur: number): QNoteAtom[] {
  const atoms: QNoteAtom[] = [];
  let remaining = totalDur;
  const smallest = ATOMS[0].durTicks;
  while (remaining >= smallest) {
    let pick = ATOMS[0];
    for (const a of ATOMS) if (a.durTicks <= remaining) pick = a;
    atoms.push({
      durTicks: pick.durTicks,
      notation: { base: pick.base, dots: pick.dots, tied: remaining > pick.durTicks },
    });
    remaining -= pick.durTicks;
  }
  return atoms;
}

/* ── main entry ───────────────────────────────────────────────────────────── */

export function quantizeDurations(
  chords: ChordEvent[],
  beats: BeatGrid,
  meter: Meter,
): QNote[] {
  if (chords.length === 0 || beats.beats.length === 0) return [];

  const weights = precomputeWeights(meter);
  const barTicks = meter.subdivisions * meter.numerator;
  /* Tick origin = the latest downbeat candidate that is ≤ the first onset.
     Starting from the chosen phase's beat in beats[], extrapolate backwards
     by whole bars (periodSec * numerator) until at or before the first onset.
     This preserves the phase search's downbeat choice while guaranteeing no
     leading notes are dropped. */
  const phaseIdx = Math.min(meter.downbeatBeatIdx, Math.max(0, beats.beats.length - 1));
  const phaseT = beats.beats.length > 0 ? beats.beats[phaseIdx].t : 0;
  const firstOnsetT = chords[0].t;
  const barSec = beats.periodSec * meter.numerator;
  const k = barSec > 0 ? Math.floor((firstOnsetT - phaseT) / barSec) : 0;
  const downbeatT = phaseT + k * barSec;
  const tickShift = tickAtTime(downbeatT, beats, meter);

  /* Stage A: snap each chord to ticks. */
  interface SnappedChord {
    startTick: number;
    releaseTick: number;
    chord: ChordEvent;
  }
  const snapped: SnappedChord[] = [];
  for (const c of chords) {
    const tStart = Math.max(0, snapToGrid(tickAtTime(c.t, beats, meter) - tickShift));
    const tEndRaw = snapToGrid(tickAtTime(c.tOff, beats, meter) - tickShift);
    const tEnd = Math.max(tStart + TICK_GRID, tEndRaw);
    snapped.push({ startTick: tStart, releaseTick: tEnd, chord: c });
  }
  snapped.sort((a, b) => a.startTick - b.startTick);

  /* Merge chords landing on the same tick. */
  const merged: SnappedChord[] = [];
  for (const sc of snapped) {
    if (merged.length > 0 && merged[merged.length - 1].startTick === sc.startTick) {
      const m = merged[merged.length - 1];
      m.releaseTick = Math.max(m.releaseTick, sc.releaseTick);
      m.chord = {
        t: m.chord.t,
        tOff: Math.max(m.chord.tOff, sc.chord.tOff),
        onsets: [...m.chord.onsets, ...sc.chord.onsets],
      };
    } else {
      merged.push(sc);
    }
  }

  if (merged.length === 0) return [];

  /* Stage B: build a sequence of (startTick, durTicks, chord-or-rest) events,
     respecting bar boundaries. Split any event that crosses a bar at the bar
     into a tied pair (rest crossings split too — multiple rests in adjacent
     bars are fine for v1). */
  interface RawEvent {
    startTick: number;
    durTicks: number;
    chord: ChordEvent | null; /* null = rest */
  }
  const raw: RawEvent[] = [];
  const lastEnd = (() => {
    const last = merged[merged.length - 1];
    return Math.max(last.releaseTick, last.startTick + 4);
  })();
  /* Pad to next bar boundary so the final note can resolve cleanly. */
  const padTo = Math.ceil(lastEnd / barTicks) * barTicks;

  let cursor = 0;
  /* Leading rest if the first chord is past tick 0. */
  if (merged[0].startTick > 0) {
    raw.push({ startTick: 0, durTicks: merged[0].startTick, chord: null });
    cursor = merged[0].startTick;
  }

  for (let i = 0; i < merged.length; i++) {
    const cur = merged[i];
    const nextOnset = i + 1 < merged.length ? merged[i + 1].startTick : padTo;
    const noteEnd = Math.min(cur.releaseTick, nextOnset);
    const noteDur = Math.max(TICK_GRID, noteEnd - cur.startTick);
    raw.push({ startTick: cur.startTick, durTicks: noteDur, chord: cur.chord });
    cursor = cur.startTick + noteDur;
    if (cursor < nextOnset) {
      const restDur = nextOnset - cursor;
      if (restDur >= REST_MIN_TICKS) {
        raw.push({ startTick: cursor, durTicks: restDur, chord: null });
      } else {
        /* Tiny gap — fold into the preceding note. */
        const prev = raw[raw.length - 1];
        if (prev.chord !== null) prev.durTicks += restDur;
      }
      cursor = nextOnset;
    }
  }

  /* Split events at bar boundaries. Continuation slices of a chord become
     tied; rest slices are independent rests. */
  const split: RawEvent[] = [];
  for (const ev of raw) {
    let pos = ev.startTick;
    let remaining = ev.durTicks;
    while (remaining > 0) {
      const barEnd = (Math.floor(pos / barTicks) + 1) * barTicks;
      const sliceLen = Math.min(remaining, barEnd - pos);
      split.push({ startTick: pos, durTicks: sliceLen, chord: ev.chord });
      pos += sliceLen;
      remaining -= sliceLen;
    }
  }

  /* Stage C: split each event's duration into atoms and assemble QNotes. */
  const qnotes: QNote[] = [];
  for (let i = 0; i < split.length; i++) {
    const ev = split[i];
    const atoms = splitDuration(ev.startTick, ev.durTicks, weights, ev.chord === null);
    /* If this slice continues the same chord into a new bar (previous event
       had the same .chord), the first atom of this slice should be tied
       from the previous (a "leading" tie is rendered implicitly — LilyPond
       picks it up because the previous atom's last atom is tied). */
    const prev = i > 0 ? split[i - 1] : null;
    const continuesPrev = ev.chord !== null && prev !== null && prev.chord === ev.chord;

    if (ev.chord === null) {
      qnotes.push({
        startTick: ev.startTick,
        durTicks: ev.durTicks,
        atoms,
        pitches: [],
        colors: [],
        coords: [],
        sourceOnsetIds: [],
        isRest: true,
      });
    } else {
      const pitches: { midi: number; color: string; q: number; r: number; id: number }[] = [];
      for (const o of ev.chord.onsets) {
        pitches.push({
          midi: o.midi,
          color: o.colorHex,
          q: o.q,
          r: o.r,
          id: o.id,
        });
      }
      pitches.sort((a, b) => a.midi - b.midi);
      /* When this slice continues a previous slice, every atom's tied flag
         must already be true at the start. Force the first atom to render as
         tied-from (we mark the previous slice's last atom as `tied: true`). */
      if (continuesPrev && qnotes.length > 0) {
        const prevQ = qnotes[qnotes.length - 1];
        if (prevQ.atoms.length > 0) {
          prevQ.atoms[prevQ.atoms.length - 1].notation.tied = true;
        }
      }
      qnotes.push({
        startTick: ev.startTick,
        durTicks: ev.durTicks,
        atoms,
        pitches: pitches.map((p) => p.midi),
        colors: pitches.map((p) => p.color),
        coords: pitches.map((p) => ({ q: p.q, r: p.r })),
        sourceOnsetIds: pitches.map((p) => p.id),
        isRest: false,
      });
    }
  }

  return qnotes;
}
