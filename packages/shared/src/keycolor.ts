// Key color — one function of the pitch.
//
// Color belongs to the pitch, not to the layout: a tuning mode or note-name
// mapping only decides which pitch sits on a cell, and the same pitch gets the
// same color wherever it appears. For the JI modes the hue is a function of the
// cell's prime-exponent vector e = [e2, e3, e5, e7] (coordExps):
//
//   hue = hueCycleOrder[ floor((57 + 7·e3 + 4·e5 + 10·e7) / 12) − 4   mod 7 ]
//
// Each prime is weighted by its 12-TET step reduced into the octave (3/2 = 7,
// 5/4 = 4, 7/4 = 10), so the hue is the pitch's 12-TET octave minus the octaves
// its prime factorization contains; e2 never enters. Steps per comma: syntonic 2,
// schisma 5, Pythagorean 7 ≡ 0, 35/36 0. On top of that, each septimal factor
// turns the hue half a step (warm for e7 > 0): odd e7 takes the half-step
// (.sl/.sd) variant, e7 = ±2 is a whole step. Banded layouts only reach
// e7 ∈ {0, 1}; the unbanded Septimal layout stacks them. White/black follows
// the cell's MIDI pitch class.
//
// Equal is the one separate rule: a 3-hue cycle by sounding octave.
//
// Pure: callers pass the layout. HKL wraps these with its live tuning state
// (apps/hkl/src/render/colors.ts); Composer can call them directly.

import { coordExps, coordToMidi, type TuningMode } from './freq.js';
import type { Mapping } from './mapping.js';
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
  /* hueCycleOrder walks the cycle backward, so warm is −1: e7 half-steps warm
     land on index − floor(e7/2), plus the half-step variant when e7 is odd */
  const hue = hueCycleOrder[mod(Math.floor((57 + 7 * e3 + 4 * e5 + 10 * e7) / 12) - 4 - Math.floor(e7 / 2), 7)];
  return { hue, isW, half: mod(e7, 2) === 1, isSept: e7 !== 0 };
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
