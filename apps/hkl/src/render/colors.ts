// Key color under HKL's live tuning state. The color function itself is pure
// and lives in @hkl/shared/keycolor.js — color is one function of the pitch
// and the layout's orientation; see that module. These wrappers only supply
// the current layout. The palette lives in @hkl/shared/colors.js.

import { tuning } from '../state/tuning.js';
import {
  type KeyColor,
  keyColor, keyColorHex as sharedKeyColorHex, lightSourceHex as sharedLightSourceHex,
} from '@hkl/shared/keycolor.js';
import { whiteSet } from '@hkl/shared/colors.js';

export type { KeyColor };
export { whiteSet };

/** Hue, white/black and septimal flags for a cell under the current layout. */
export function keyColorVariant(q: number, r: number): KeyColor {
  return keyColor(q, r, tuning.mode, tuning.mapping, tuning.anchor, tuning.banded);
}

/* returns hex color string for key at lattice (q,r) under current tuning state */
export function keyColorHex(q: number, r: number): string {
  return sharedKeyColorHex(q, r, tuning.mode, tuning.mapping, tuning.anchor, tuning.banded);
}

/* Bright "light source" hue for a key — the notehead color on a DARK notation
   surface (see @hkl/shared/keycolor.js). */
export function lightSourceHex(q: number, r: number): string {
  return sharedLightSourceHex(q, r, tuning.mode, tuning.mapping, tuning.anchor, tuning.banded);
}

/* How much the key under the pointer is lightened — on the canvas (render/draw.ts)
   and, with Hover on, on the Lumatone (lumatone/sync.ts), so both change alike. */
export const HOVER_LIGHTEN = 30;

/* Add `amt` to each RGB channel (clamped). */
export function lightenHex(hex: string, amt: number): string {
  let r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  r = Math.min(255, r + amt); g = Math.min(255, g + amt); b = Math.min(255, b + amt);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
