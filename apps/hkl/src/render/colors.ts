// Key color under HKL's live tuning state. The color function itself is pure
// and lives in @hkl/shared/keycolor.js — color is one function of the pitch,
// identical across every JI mode and mapping (Equal keeps its own octave
// cycle); see that module. These wrappers only supply the current layout.
// Pure data tables (hueC, hueCycle, whiteSet, hueCycleOrder, hueIdx,
// equalHueCycle) live in @hkl/shared/colors.js — re-exported here so existing
// callers continue to import from '../render/colors.js'.

import { tuning } from '../state/tuning.js';
import {
  type KeyColor,
  keyColor, keyColorHex as sharedKeyColorHex, lightSourceHex as sharedLightSourceHex,
} from '@hkl/shared/keycolor.js';
import {
  type Hue, type HueColors,
  hueC, hueCycle, whiteSet, hueCycleOrder, hueIdx, equalHueCycle,
} from '@hkl/shared/colors.js';

export type { Hue, HueColors, KeyColor };
export { hueC, hueCycle, whiteSet, hueCycleOrder, hueIdx, equalHueCycle };

/** Hue, white/black and septimal flag for a cell under the current layout. */
export function keyColorVariant(q: number, r: number): KeyColor {
  return keyColor(q, r, tuning.mode, tuning.mapping, tuning.anchor);
}

/* returns hex color string for key at lattice (q,r) under current tuning state */
export function keyColorHex(q: number, r: number): string {
  return sharedKeyColorHex(q, r, tuning.mode, tuning.mapping, tuning.anchor);
}

/* Bright "light source" hue for a key — the notehead color on a DARK notation
   surface (see @hkl/shared/keycolor.js). */
export function lightSourceHex(q: number, r: number): string {
  return sharedLightSourceHex(q, r, tuning.mode, tuning.mapping, tuning.anchor);
}
