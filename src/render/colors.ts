// Stateful key-color computation. Reads tuning state (live bindings).
// Pure data tables (colorTable, hueC, hueCycle, whiteSet, hueCycleOrder,
// hueIdx, equalHueCycle) live in src/shared/colors.ts — re-exported here so
// existing callers continue to import from '../render/colors.js'.

import { bandOf } from '../layout/coords.js';
import { tuning } from '../state/tuning.js';
import { regionInfo } from '../tuning/regions.js';
import {
  type Hue, type HueColors,
  colorTable, hueC, hueCycle, whiteSet, hueCycleOrder, hueIdx, equalHueCycle,
} from '../shared/colors.js';

export type { Hue, HueColors };
export { colorTable, hueC, hueCycle, whiteSet, hueCycleOrder, hueIdx, equalHueCycle };

export function lookupHue(q: number, r: number): Hue {
  return colorTable[((q % 3) + 3) % 3][((r % 12) + 12) % 12];
}

/* Hue from `floor(midi/12) - bandOf(q)` modulo 7. The uniform septimal mode's
   region rule is purely qmod3-based and shares hues with the underlying 5-limit
   layout, so no pair-shift correction is needed — B-vs-A coloring is handled at
   draw time via `keyColorHex` consulting `regionInfo`. */
export function computeHue(q: number, r: number): Hue {
  const midi = 57 + 4 * q + 7 * r;
  if (tuning.equalEnabled) return equalHueCycle[((Math.floor(midi / 12) % 3) + 3) % 3];
  const b = bandOf(q);
  return hueCycleOrder[(((Math.floor(midi / 12) - b - 4) % 7) + 7) % 7];
}

/* returns hex color string for key at lattice (q,r) under current tuning state */
export function keyColorHex(q: number, r: number): string {
  const midi = 57 + 4 * q + 7 * r;
  const pc = ((midi % 12) + 12) % 12;
  const isW = whiteSet.has(pc);
  const mh = computeHue(q, r);
  const inB = tuning.septimalEnabled && regionInfo(q, r).type === 'B';
  return inB ? (isW ? hueC[mh].sl! : hueC[mh].sd!) : (isW ? hueC[mh].l : hueC[mh].d);
}
