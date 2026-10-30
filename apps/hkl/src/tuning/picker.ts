// The 88-cell piano footprint: for each MIDI 21..108, the lattice cell piano
// input resolves to (and the piano outline draws). Pure — takes the tuning
// state — so HKL (render/draw.ts compute88PianoCoords, the canvas height in
// render/canvas.ts) and the gates (test/picker/) run this one implementation.
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
// Candidates for a MIDI N are the layout's whole family of cells with that MIDI,
// (q_N + ρk, r_N − c·k): c the band step and ρ the row step in semitones
// (c·q + ρ·r = N − 57; ρ = 7 in the fifths layouts; gcd(c, ρ) = 1). The window is
// centered on the member nearest the ref's row and spans ±80 rows, comfortably
// wider than any sensible enharmonic excursion — centered on the ref, not the
// origin, because a ref can sit anywhere along the enharmonic axis. At the ref's
// MIDI the ref itself wins (TH 0, distance 0), so the ref never falls outside its
// own footprint.
//
// The footprint relative to its ref depends only on the layout, the mode, the
// banding and the ref's position in its band (a step along the pure line, or one
// band over with the anchor following, preserves every relative interval; the
// ref's MIDI only slides the 88-note window). footprintExtents builds the one
// stitched footprint per position that every ref's footprint is a window of; the
// canvas sizes the piano outline from it (render/canvas.ts). test/picker/ gates
// the reduction.
//
// Banded Schismatic ('V') ranks under Semiditonal ('D') ratios — same column shifts,
// no schisma exponent. V's per-band schisma inflates the TH of every cell an
// octave-band away (TH grows linearly with the band distance), and the picker
// would prefer diaschisma spellings (e.g. Euler MIDI 69 → (−4, 4) over
// (3, 0)). Playback still uses V's pitches; this only decides which cell each
// MIDI resolves to. Banded only: the conflict is banded V's spelling (the same
// letter in every band) against its schisma-stacked pitch. Unbanded V respells
// each band to match its pitch, so it ranks under its own ratios like any mode.

import { anchorOf, coordToMidi, tenneyHeightFromExps } from '@hkl/shared/freq.js';
import { LAYOUT, bandWidth } from '@hkl/shared/mapping.js';
import { noteName } from '@hkl/shared/notes.js';
import { jiRatioWithState } from './ratios.js';
import type { TuningStateLike } from './regions.js';

export function pianoFootprint(refQ: number, refR: number, state: TuningStateLike): Array<[number, number]> {
  return pickRange(refQ, refR, state, 21, 108);
}

/** For each position in band (refs (q, 0), q ∈ [0, W)): the cells picked for
 *  MIDI ref−87 … ref+87, relative to the ref, the ref ranked as `anchorOffset`
 *  bands from the anchor (0: its own home band, as a Ctrl+click makes it). Every
 *  such ref's 88-cell footprint is the window of its position's extent at
 *  [21 − refMidi, 108 − refMidi]; index i holds relative MIDI i − 87. */
export function footprintExtents(state: TuningStateLike, anchorOffset = 0): Array<Array<[number, number]>> {
  const mapping = state.mapping;
  const out: Array<Array<[number, number]>> = [];
  for (let q = 0; q < bandWidth(mapping); q++) {
    const refMidi = coordToMidi(q, 0, mapping);
    const anchor = anchorOf(q, 0, mapping) - anchorOffset;
    out.push(pickRange(q, 0, { ...state, anchor }, refMidi - 87, refMidi + 87).map(([cq, cr]) => [cq - q, cr]));
  }
  return out;
}

/** The ref-to-anchor band offsets whose footprints can differ. Under the Piano
 *  outline the ref can sit d bands from the anchor (Composer's cursor note,
 *  recording playback, the overlay mirror). Banded Syntonic's band offset is
 *  periodic in d ([0, +1, 0, −1][d mod 4]); every other band offset is linear
 *  in the band distance (Polysyntonic, Schismatic) or absent, so d drops out. */
export function footprintAnchorOffsets(state: TuningStateLike): number[] {
  return state.mode === 'S' && state.banded ? [0, 1, 2, 3] : [0];
}

/** The largest |sy(cell) − sy(MIDI 64's cell)| over every ref's footprint, sy
 *  a linear screen projection: the piano view centers MIDI 64's cell vertically
 *  (render/canvas.ts), so twice this, plus padding, is a canvas height that fits
 *  every ref. */
export function footprintHalfHeight(extents: ReadonlyArray<ReadonlyArray<readonly [number, number]>>, sy: (q: number, r: number) => number): number {
  let m = 0;
  for (const ext of extents) {
    const ys = ext.map(([q, r]) => sy(q, r));
    for (let refMidi = 21; refMidi <= 108; refMidi++) {
      const o = 87 - refMidi; /* ys[midi + o] is MIDI midi's cell */
      const y64 = ys[64 + o];
      for (let midi = 21; midi <= 108; midi++) {
        const d = Math.abs(ys[midi + o] - y64);
        if (d > m) m = d;
      }
    }
  }
  return m;
}

function pickRange(refQ: number, refR: number, state: TuningStateLike, lo: number, hi: number): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  const mapping = state.mapping;
  /* Octave step is (W, 0) = (12/c, 0): (+3, 0) Euler, (+6, 0) Wicki-Hayden,
     (+12, 0) chromatic. The isotone projection ρ(q−refQ) − c(r−refR) shifts by
     ρ·W per octave. */
  const c = LAYOUT[mapping].c;
  const rho = coordToMidi(0, 1, mapping) - 57;
  let inv = 0; /* ρ·inv ≡ 1 (mod c) */
  while ((rho * inv) % c !== 1 % c) inv++;
  const K = Math.ceil(80 / c);
  const PROJ_PER_OCT = rho * bandWidth(mapping);
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
  for (let midi = lo; midi <= hi; midi++) {
    const N = midi - 57;
    /* one member of the family c·q + ρ·r = N (r_N ≡ inv·N mod c), then the
       member nearest the ref's row */
    const rN = (((inv * N) % c) + c) % c;
    const qN = (N - rho * rN) / c;
    const k0 = Math.round((rN - refR) / c);
    const projTarget = PROJ_PER_OCT * Math.round((midi - refMidi) / 12);
    /* rule 1: the lowest-TH cells */
    let top: Array<{ q: number; r: number; e: ReadonlyArray<number>; d: number; line: number }> = [];
    let minTh = Infinity;
    for (let k = k0 - K; k <= k0 + K; k++) {
      const q = qN + rho * k;
      const r = rN - c * k;
      const ratio = jiRatioWithState(refQ, refR, q, r, pickerState);
      const th = tenneyHeightFromExps(ratio.e);
      if (th > minTh) continue;
      if (th < minTh) { minTh = th; top = []; }
      top.push({ q, r, e: ratio.e, d: steps(q, r), line: Math.abs(rho * (q - refQ) - c * (r - refR) - projTarget) });
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
