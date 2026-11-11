// Key color — one function of the pitch and the layout's orientation: the
// spine rule (Max, 2026-11-09; the fourths cycle, 2026-11-10).
//
// The Pythagorean spine is the chain of pure fifths from A3 — of pure fourths
// in an inverted layout (`layoutOf(mapping).invert`). It holds one color per nominal octave,
// purple in octave 3: spine note n sits at MIDI 57 + 7n (57 + 5n on the fourths
// spine), and the hues step through the spine's cycle octave by octave, the
// other way round on the fourths spine. A cycle is as long as the spine step
// has semitones (`hueCycleOf`): N = 7 hues on fifths, 5 on fourths. A note
// reached from the spine by chaining 5:4 major thirds takes the spine's color
// at its own octave, a major third being 4 semitones; 2:1 carries no color. So
// for a cell's prime-exponent vector e = [e2, e3, e5, e7] (coordExps):
//
//   fifths   hue = FIFTHS_CYCLE[    floor((57 + 7·e3 + 4·e5) / 12) − 4   mod 7 ]
//   fourths  hue = FOURTHS_CYCLE[ −(floor((57 − 5·e3 + 4·e5) / 12) − 4)  mod 5 ]
//
// That is the whole rule for every JI mode and mapping, banded and unbanded:
// a mode or mapping only decides which pitch sits on a cell, and what a comma
// does to the hue follows from where it lands on the spine. There are no comma
// terms. Twelve spine steps span N octaves, a whole turn of the N hues, so a
// Pythagorean comma keeps the hue on either spine, and the hue shift between
// two enharmonic notes is twice their syntonic-comma difference, mod N.
// A pitch's color differs between a plain and an inverted layout, and agrees
// across the layouts of one orientation, copy columns included.
//
// Septimal: each factor of 7 is first replaced by the 5-limit note it stands
// for (×36/35, the Ptolemaic cell a septimal column replaces), which takes the
// spine color; each factor then turns the hue half a step (warm for e7 > 0):
// odd e7 takes the half-step (.sl/.sd) variant, e7 = ±2 is a whole step. Banded
// layouts only reach e7 ∈ {0, 1}; the unbanded Septimal layout stacks them.
// White/black follows the cell's MIDI pitch class.
//
// Equal is the one separate rule, since 12-TET has no place on the spine: the
// same cycle by the cell's own MIDI octave, purple in octave 3, in the spine's
// direction, whatever the anchor or banding.
//
// Pure: callers pass the layout. HKL wraps these with its live tuning state
// (apps/hkl/src/render/colors.ts); Composer can call them directly.

import { coordExps, coordToMidi, type TuningMode } from './freq.js';
import { layoutOf, type Mapping } from './mapping.js';
import { type Hue, type CycleStep, hueCycleOf, whiteSet } from './colors.js';

export interface KeyColor {
  hue: Hue;
  /** The hue's step in the layout's cycle: its light / dark and half-step hexes. */
  step: CycleStep;
  /** White key: the cell's MIDI pitch class is a natural. */
  isW: boolean;
  /** Odd septimal count: draws from the half-step (.sl/.sd) variants, halfway
   *  from `hue` to the next warm hue. */
  half: boolean;
  /** Septimal (e7 ≠ 0). */
  isSept: boolean;
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** Hue, white/black and septimal flags for (q, r) under `mode` / `mapping` /
 *  `anchor` / `banded` (see coordExps). */
export function keyColor(q: number, r: number, mode: TuningMode, mapping: Mapping, anchor: number, banded: boolean): KeyColor {
  const midi = coordToMidi(q, r, mapping);
  const isW = whiteSet.has(mod(midi, 12));
  const invert = layoutOf(mapping).invert;
  const cycle = hueCycleOf(invert);
  let idx: number, e7 = 0;
  if (mode === 'E') {
    const oct = Math.floor(midi / 12) - 4;
    idx = invert ? -oct : oct;
  } else {
    const e = coordExps(q, r, mode, mapping, anchor, banded);
    e7 = e[3];
    /* each septimal factor → the 5-limit note it stands for: ×36/35 = 2²·3²/(5·7) */
    const n = e[1] + 2 * e7, thirds = e[2] - e7;
    /* the octave of the pitch's place on the spine: fifths, or fourths (spine note −n) */
    const oct = Math.floor((57 + (invert ? -5 * n : 7 * n) + 4 * thirds) / 12) - 4;
    /* a cycle walks backward, so warm is −1: e7 half-steps warm land on
       index − floor(e7/2), plus the half-step variant when e7 is odd */
    idx = (invert ? -oct : oct) - Math.floor(e7 / 2);
  }
  const step = cycle[mod(idx, cycle.length)];
  return { hue: step.hue, step, isW, half: mod(e7, 2) === 1, isSept: e7 !== 0 };
}

/** Lattice key color: .l / .d by white/black, .sl / .sd on a half step. */
export function keyColorHex(q: number, r: number, mode: TuningMode, mapping: Mapping, anchor: number, banded: boolean): string {
  const v = keyColor(q, r, mode, mapping, anchor, banded);
  if (v.half) return v.isW ? v.step.sl : v.step.sd;
  return v.isW ? v.step.l : v.step.d;
}

/** Bright "light source" hue — always the light variant (.l / .sl), ignoring
 *  white/black. The notehead color on a DARK notation surface, where the .d
 *  black-key variant is too dark to read (the accidental glyph already conveys
 *  sharp/flat, so the notehead only needs to carry the hue). */
export function lightSourceHex(q: number, r: number, mode: TuningMode, mapping: Mapping, anchor: number, banded: boolean): string {
  const v = keyColor(q, r, mode, mapping, anchor, banded);
  return v.half ? v.step.sl : v.step.l;
}

/** Ink-on-white-paper notehead color: the hue's ink (`hueC[…].ink`), whatever
 *  the variant — a half step takes its hue's ink too. Outputs are exactly the
 *  sanctioned ink set that sanctionedLightForInk reverse-maps. */
export function inkColorHex(q: number, r: number, mode: TuningMode, mapping: Mapping, anchor: number, banded: boolean): string {
  return keyColor(q, r, mode, mapping, anchor, banded).step.ink;
}
