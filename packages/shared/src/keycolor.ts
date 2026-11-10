// Key color — one function of the pitch and the layout's orientation: the
// spine rule (Max, 2026-11-09).
//
// The Pythagorean spine is the chain of pure fifths from A3 — of pure fourths
// in an inverted layout (LAYOUT invert). It holds one color per nominal octave,
// purple in octave 3: spine note n sits at MIDI 57 + 7n (57 + 5n on the fourths
// spine), and the hues step through hueCycleOrder octave by octave, the other
// way round on the fourths spine. A note reached from the spine by chaining
// 5:4 major thirds takes the spine's color at its own octave, a major third
// being 4 semitones; 2:1 carries no color. So for a cell's prime-exponent
// vector e = [e2, e3, e5, e7] (coordExps):
//
//   fifths   hue = hueCycleOrder[   floor((57 + 7·e3 + 4·e5) / 12) − 4   mod 7 ]
//   fourths  hue = hueCycleOrder[ −(floor((57 − 5·e3 + 4·e5) / 12) − 4)  mod 7 ]
//
// That is the whole rule for every JI mode and mapping, banded and unbanded:
// a mode or mapping only decides which pitch sits on a cell, and what a comma
// does to the hue follows from where it lands on the spine. There are no comma
// terms. (12 fifths span 7 octaves, a whole turn of the 7 hues, so a
// Pythagorean comma keeps the hue on the fifths spine; 12 fourths span 5.)
// A pitch's color therefore differs between a plain and an inverted layout,
// and agrees across the layouts of one orientation, copy columns included.
//
// Septimal: each factor of 7 is first replaced by the 5-limit note it stands
// for (×36/35, the Ptolemaic cell a septimal column replaces), which takes the
// spine color; each factor then turns the hue half a step (warm for e7 > 0):
// odd e7 takes the half-step (.sl/.sd) variant, e7 = ±2 is a whole step. Banded
// layouts only reach e7 ∈ {0, 1}; the unbanded Septimal layout stacks them.
// White/black follows the cell's MIDI pitch class.
//
// Equal is the one separate rule: a 3-hue cycle by sounding octave.
//
// Pure: callers pass the layout. HKL wraps these with its live tuning state
// (apps/hkl/src/render/colors.ts); Composer can call them directly.

import { coordExps, coordToMidi, type TuningMode } from './freq.js';
import { LAYOUT, type Mapping } from './mapping.js';
import {
  type Hue, hueC, hueCycleOrder, whiteSet, equalHueCycle,
  hexToRgb, rgbToHsl, hslToRgb, rgbToHex, profileForHue,
} from './colors.js';

export interface KeyColor {
  hue: Hue;
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
  if (mode === 'E') return { hue: equalHueCycle[mod(Math.floor(midi / 12), 3)], isW, half: false, isSept: false };
  const [, e3, e5, e7] = coordExps(q, r, mode, mapping, anchor, banded);
  /* each septimal factor → the 5-limit note it stands for: ×36/35 = 2²·3²/(5·7) */
  const n = e3 + 2 * e7, thirds = e5 - e7;
  /* the octave of the pitch's place on the spine: fifths, or fourths (spine note −n) */
  const invert = LAYOUT[mapping].invert;
  const oct = Math.floor((57 + (invert ? -5 * n : 7 * n) + 4 * thirds) / 12) - 4;
  /* hueCycleOrder walks the cycle backward, so warm is −1: e7 half-steps warm
     land on index − floor(e7/2), plus the half-step variant when e7 is odd */
  const idx = (invert ? -oct : oct) - Math.floor(e7 / 2);
  return { hue: hueCycleOrder[mod(idx, 7)], isW, half: mod(e7, 2) === 1, isSept: e7 !== 0 };
}

/** Lattice key color: .l / .d by white/black, .sl / .sd on a half step. */
export function keyColorHex(q: number, r: number, mode: TuningMode, mapping: Mapping, anchor: number, banded: boolean): string {
  const v = keyColor(q, r, mode, mapping, anchor, banded);
  if (v.half) return v.isW ? hueC[v.hue].sl! : hueC[v.hue].sd!;
  return v.isW ? hueC[v.hue].l : hueC[v.hue].d;
}

/** Bright "light source" hue — always the light variant (.l / .sl), ignoring
 *  white/black. The notehead color on a DARK notation surface, where the .d
 *  black-key variant is too dark to read (the accidental glyph already conveys
 *  sharp/flat, so the notehead only needs to carry the hue). */
export function lightSourceHex(q: number, r: number, mode: TuningMode, mapping: Mapping, anchor: number, banded: boolean): string {
  const v = keyColor(q, r, mode, mapping, anchor, banded);
  return v.half ? hueC[v.hue].sl! : hueC[v.hue].l;
}

/** Ink-on-white-paper notehead color: the lattice color remapped to its
 *  per-hue ink profile (HUE_PROFILES), so outputs are exactly the sanctioned
 *  ink set that sanctionedLightForInk reverse-maps. */
export function inkColorHex(q: number, r: number, mode: TuningMode, mapping: Mapping, anchor: number, banded: boolean): string {
  const [r0, g0, b0] = hexToRgb(keyColorHex(q, r, mode, mapping, anchor, banded));
  const [h] = rgbToHsl(r0, g0, b0);
  const p = profileForHue(h);
  const [r1, g1, b1] = hslToRgb(p.H / 360, p.S, p.L);
  return rgbToHex(r1, g1, b1);
}
