// Converting a note from one layout to another: a pitch search.
//
// A note that is converted between two layouts, which may differ in mapping,
// tuning or both, lands on the key that sounds the same MIDI note at the pitch
// closest to the one it had
// (Max, 2026-11-19): closest in cents, however far away that key is, and of
// keys equally close in pitch the one nearest where the note was. Enharmonics
// are allowed: only the nominal MIDI note is kept, not the spelling.
//
// Schismatic is the exception (Max, 2026-11-19): "its whole idea is being
// inexact", so where either layout is Schismatic, pitches within a schisma of
// the closest count as equally close, and the nearest of those is taken. A
// note a schisma off stays beside where it was, where the exact pitch may lie
// dozens of keys away under a triple sharp.
//
// Where it was, in the new frame, is its structural counterpart (`convertCell`,
// mapping.ts: same chromatic cell, or the Euler-equivalent's), which keeps the
// MIDI note. Every other cell of that MIDI note lies on one line through it:
// a step along the line (`sameNoteStep`) changes the pitch by a comma and the
// note not at all, and the pitch drifts steadily along it, so there is a
// closest one and it is found by walking the line both ways.
//
// A caller with a live Lumatone outline passes `within`, and only keys of the
// outline are candidates; without one the whole lattice is. With `within` the
// result is null when no key of the outline holds the MIDI note, and what to
// do then is the caller's: HKL drops the note, Composer never drops one and
// searches the whole lattice instead.
//
// Who converts: HKL's mapping switch, score notes played through HKL, the
// recording export, and Composer's retune, paste and view of HKL's keys.
// HKL's tuning selector and its Banded layout toggle do not: there every note
// keeps its key and retunes in place (Max, 2026-11-20: left as it is).
//
// Pure: no DOM and no state.

import { SCHISMA, coordToMidi, freqAt, type TuningMode } from './freq.js';
import { bandOfCell, bandWidth, convertCell, layoutOf, type Mapping } from './mapping.js';

/** The layout a cell's pitch is read in. `anchor` is the home band (Syntonic,
 *  Polysyntonic, and every tuning unbanded: `coordExps`). */
export interface NoteFrame {
  mode: TuningMode;
  mapping: Mapping;
  anchor: number;
  banded: boolean;
}

/** Home band `anchor` of layout `from`, as a band of layout `to`: the band its
 *  first row-0 cell converts into. Two frames that describe one keyboard have
 *  their home bands so related. */
export function anchorIn(anchor: number, from: Mapping, to: Mapping): number {
  if (from === to) return anchor;
  const W = bandWidth(from);
  let q = (anchor - 1) * W;
  while (bandOfCell(q, 0, from) < anchor) q++;
  const [q2, r2] = convertCell(q, 0, from, to);
  return bandOfCell(q2, r2, to);
}

/* pitches this close are the same pitch (rounding of the frequency math) */
const SAME_CENTS = 0.001;
/* and in Schismatic, pitches within a schisma of each other (about 1.95 cents) */
const SCHISMA_CENTS = 1200 * Math.log2(SCHISMA);
/* how far along the line to look. The pitch drifts at least a Pythagorean comma for every twelve
   fifths along it (twelve steps on a twelve-wide band, three on a three-wide one), so 64 steps
   either way pass any pitch within a semitone of the note many times over, and cover any outline */
const REACH = 64;

const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));

/** The step from a cell to the next cell of the same MIDI note in `mapping`:
 *  (7, −4) Euler, (7, −2) Wicki-Hayden, (7, −1) Chromatic, (5, −4) Randal. */
export function sameNoteStep(mapping: Mapping): [number, number] {
  const { c, s, invert } = layoutOf(mapping), row = s + (invert ? 5 : 7), g = gcd(c, row);
  return [row / g, 0 - c / g];
}

/** The cell of `to` that note (q, r) of `from` converts to: the same MIDI
 *  note at the closest pitch, nearest its structural counterpart among equally
 *  close ones (of two equally near, the one down the line); equally close is
 *  within a schisma where either layout is Schismatic. `within` limits the
 *  candidates (a live outline); null when it admits no cell of the note. */
export function convertNote(
  q: number, r: number, from: NoteFrame, to: NoteFrame,
  within?: (q: number, r: number) => boolean,
): [number, number] | null {
  const [sq, sr] = convertCell(q, r, from.mapping, to.mapping);
  if (coordToMidi(sq, sr, to.mapping) !== coordToMidi(q, r, from.mapping)) throw new Error(`convertNote: ${from.mapping} → ${to.mapping} moved the MIDI note of (${q},${r})`);
  const was = freqAt(q, r, from.mode, from.mapping, from.anchor, from.banded);
  const [dq, dr] = sameNoteStep(to.mapping);
  /* the candidates nearest first: 0, −1, +1, −2, +2, … with how far off each is in pitch */
  const found: Array<{ cell: [number, number]; off: number }> = [];
  for (let i = 0; i <= 2 * REACH; i++) {
    const k = i % 2 ? 0 - (i + 1) / 2 : i / 2, cq = sq + k * dq, cr = sr + k * dr;
    if (within && !within(cq, cr)) continue;
    const off = Math.abs(1200 * Math.log2(freqAt(cq, cr, to.mode, to.mapping, to.anchor, to.banded) / was));
    /* far along the line Schismatic's stacked schismas overflow the frequency math: no pitch to compare */
    if (Number.isFinite(off)) found.push({ cell: [cq, cr], off });
  }
  if (!found.length) return null;
  /* the closest pitch, and the nearest key that is as close */
  const least = Math.min(...found.map((c) => c.off));
  const same = SAME_CENTS + (from.mode === 'V' || to.mode === 'V' ? SCHISMA_CENTS : 0);
  return found.find((c) => c.off <= least + same)!.cell;
}
