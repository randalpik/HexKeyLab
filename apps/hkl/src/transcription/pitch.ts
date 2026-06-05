// Color helpers for transcription: darken a lattice hex color for ink-on-paper
// notehead readability. Reuses the codebase's lattice-driven note naming
// elsewhere; spelling itself lives in @hkl/shared. The screen palette (tuned for
// a dark UI) is remapped per-hue here so noteheads read on white paper.

import { keyColorHex } from '../render/colors.js';
import { hexToRgb, rgbToHsl, hslToRgb, rgbToHex, profileForHue } from '@hkl/shared/colors.js';

/** Lattice color, remapped per-hue for ink-on-white-paper readability. The
 *  per-hue profiles + hsl/rgb helpers live in @hkl/shared so the sanctioned
 *  ink↔light reverse-map there keys on the exact same outputs. */
export function darkColorHex(q: number, r: number): string {
  const hex = keyColorHex(q, r);
  const [r0, g0, b0] = hexToRgb(hex);
  const [h] = rgbToHsl(r0, g0, b0);
  const p = profileForHue(h);
  const [r1, g1, b1] = hslToRgb(p.H / 360, p.S, p.L);
  return rgbToHex(r1, g1, b1);
}
