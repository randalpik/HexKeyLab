// The 88-cell piano footprint: for each MIDI 21..108, the lattice cell piano
// input resolves to (and the piano outline draws). Pure — takes the tuning
// state — so HKL (render/draw.ts compute88PianoCoords) and the offline bounds
// probes (test/bounds-probe/) run this one implementation.
//
// ONE ranking rule, the same in every mode and mapping:
//   1. lowest reduced Tenney Height of the JI ratio from (refQ, refR), under
//      the mode's own ratios (Syntonic / Polysyntonic included — 5-limit
//      wherever the bands offer it);
//   2. if the lowest-TH cells differ in pitch, the augmented 4th: the spelling a
//      fourth above the ref by letter (Max, 2026-10-26). TH is octave- and
//      complement-reduced, so this happens only where two spellings are
//      complements of each other — the tritone (729/512 vs 1024/729, 45/32 vs
//      64/45: A4 vs d5) — and a fixed choice is the same in every octave and
//      every mode. Any other tie (none is known) falls back to the ref's octave
//      line;
//   3. among cells of that pitch (a Wicki-Hayden copy and its original, P/D
//      comma siblings, Syntonic's equally-shifted bands, an in-band and a
//      cross-band octave in Pythagorean bands): the one fewest key steps from
//      the ref, so the footprint clusters on the ref's band.
// (2 picks a pitch before 3 picks a cell: a pairwise "same pitch → distance,
// else → line" comparison is not an order and flips with candidate order.)
// Spelling consistency across octaves comes from rules 1 and 2 (TH is octave-
// invariant; the A4 is a fixed choice); rule 3 only chooses WHERE an identical
// pitch is played.
//
// Candidates for a MIDI live on a 1-parameter family (q0+7k, r0−c·k), c the
// column step in semitones (4 Euler, 2 Wicki-Hayden, 1 chromatic); k ∈ [−20, 20]
// (Euler, scaled by 4/c in the other mappings) is comfortably wider than any
// sensible enharmonic excursion. At the ref's MIDI the ref itself wins (TH 0,
// distance 0), so the ref never falls outside its own footprint.
//
// Banded Schismatic ('V') ranks under Semiditonal ('D') ratios — same column shifts,
// no schisma exponent. V's per-band schisma inflates the TH of every cell an
// octave-band away (TH grows linearly with the band distance), and the picker
// would prefer diaschisma spellings (e.g. Euler MIDI 69 → (−4, 4) over
// (3, 0)). Playback still uses V's pitches; this only decides which cell each
// MIDI resolves to. Banded only: the conflict is banded V's spelling (the same
// letter in every band) against its schisma-stacked pitch. Unbanded V respells
// each band to match its pitch, so it ranks under its own ratios like any mode.

import { coordToMidi, tenneyHeightFromExps } from '@hkl/shared/freq.js';
import { COLUMN_STEP } from '@hkl/shared/mapping.js';
import { noteName } from '@hkl/shared/notes.js';
import { jiRatioWithState } from './ratios.js';
import type { TuningStateLike } from './regions.js';

export function pianoFootprint(refQ: number, refR: number, state: TuningStateLike): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  const mapping = state.mapping;
  /* Octave step is (12/c, 0): (+3, 0) Euler, (+6, 0) Wicki-Hayden, (+12, 0)
     chromatic. The isotone projection 7(q−refQ) − c(r−refR) shifts by 7·12/c
     per octave. */
  const c = COLUMN_STEP[mapping];
  let inv = 1; /* c·inv ≡ 1 (mod 7) */
  while ((c * inv) % 7 !== 1) inv++;
  const K = 80 / c;
  const PROJ_PER_OCT = 7 * (12 / c);
  const refMidi = coordToMidi(refQ, refR, mapping);
  const pickerState: TuningStateLike = state.mode === 'V' && state.banded ? { ...state, mode: 'D' } : state;
  /* key steps on the hex grid (axial: x = q + r/2) */
  const steps = (q: number, r: number): number => {
    const dq = q - refQ, dr = r - refR;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
  };
  const samePitch = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean =>
    a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
  /* letter steps above the ref, 0..6 (3 = a fourth) */
  const LETTERS = 'ABCDEFG';
  const refLetter = LETTERS.indexOf(noteName(refQ, refR, mapping, state.anchor, state.banded)[0]);
  const letterStep = (q: number, r: number): number =>
    (LETTERS.indexOf(noteName(q, r, mapping, state.anchor, state.banded)[0]) - refLetter + 7) % 7;
  for (let midi = 21; midi <= 108; midi++) {
    const N = midi - 57;
    /* q ≡ inv·N (mod 7); start there. */
    const q0 = (((inv * N) % 7) + 7) % 7;
    const projTarget = PROJ_PER_OCT * Math.round((midi - refMidi) / 12);
    /* rule 1: the lowest-TH cells */
    let top: Array<{ q: number; r: number; e: ReadonlyArray<number>; d: number; line: number }> = [];
    let minTh = Infinity;
    for (let k = -K; k <= K; k++) {
      const q = q0 + 7 * k;
      const r = (N - c * q) / 7;
      const ratio = jiRatioWithState(refQ, refR, q, r, pickerState);
      const th = tenneyHeightFromExps(ratio.e);
      if (th > minTh) continue;
      if (th < minTh) { minTh = th; top = []; }
      top.push({ q, r, e: ratio.e, d: steps(q, r), line: Math.abs(7 * (q - refQ) - c * (r - refR) - projTarget) });
    }
    /* rule 2: the pitch, when the lowest-TH cells disagree — the augmented 4th
       (a fourth above the ref by letter); the octave line otherwise */
    let pool = top;
    if (top.some((t) => !samePitch(t.e, top[0].e))) {
      const fourths = top.filter((t) => letterStep(t.q, t.r) === 3);
      if (fourths.length > 0) pool = fourths;
    }
    let pitch = pool[0];
    for (const t of pool) if (t.line < pitch.line) pitch = t;
    /* rule 3: the cell of that pitch nearest the ref (the line breaks a tie) */
    let best = pitch;
    for (const t of top) {
      if (samePitch(t.e, pitch.e) && (t.d < best.d || (t.d === best.d && t.line < best.line))) best = t;
    }
    cells.push([best.q, best.r]);
  }
  return cells;
}
