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

/* Unified hue computation from three rules:
   Rule 1 (octave congruence): hue(q,r)=hue(q+3,r) → bandOf(q) cancels midi shift
   Rule 2 (merge matching): syntonic partners in same pair share hue → 2*pair term
   Rule 3 (octave rule in cells): floor(midi/12) determines hue within each 3×6 cell
   Formula: hueCycle[(floor(midi/12) - bandOf(q) - 2*pairOf(r-septimalShift) - 4) % 7]
   Pairs shift with septimalShift. Reduces to lookupHue when septimal disabled (pair=0).

   Experimental mode ('7x'): regions are per-hex (not uniform bands), so the
   global pair-shift doesn't apply — A-d0 cells should display their pure
   5-limit hue, and B-d0 cells get the existing B-vs-A saturation flip at
   draw time (via the inB selector that consults regionInfo). Set p=0 here
   to disable the pair-baked syntonic rotation. */
export function computeHue(q: number, r: number): Hue {
  const midi = 57 + 4 * q + 7 * r;
  if (tuning.equalEnabled) return equalHueCycle[((Math.floor(midi / 12) % 3) + 3) % 3];
  const b = bandOf(q);
  const isUniform = tuning.septimalMode === 'uniform';
  const p = (tuning.septimalEnabled && !isUniform) ? Math.floor((r - tuning.septimalShift + 3.5) / 6) : 0;
  return hueCycleOrder[(((Math.floor(midi / 12) - b - 2 * p - 4) % 7) + 7) % 7];
}

/* returns hex color string for key at lattice (q,r) under current tuning/layout state */
export function keyColorHex(q: number, r: number): string {
  const midi = 57 + 4 * q + 7 * r;
  const pc = ((midi % 12) + 12) % 12;
  const isW = whiteSet.has(pc);
  const mh = computeHue(q, r);
  /* In '7x' mode, B vs A is decided per-hex via regionInfo (which consults
     the experimental pattern lookup) rather than the uniform alternating
     formula. Calls into regionInfo to stay in sync with frequency math. */
  const inB = tuning.septimalEnabled && regionInfo(q, r).type === 'B';
  return inB ? (isW ? hueC[mh].sl! : hueC[mh].sd!) : (isW ? hueC[mh].l : hueC[mh].d);
}
