// Stateful key-color computation. Reads tuning state (live bindings).
// Pure data tables (hueC, hueCycle, whiteSet, hueCycleOrder, hueIdx,
// equalHueCycle) live in src/shared/colors.ts — re-exported here so
// existing callers continue to import from '../render/colors.js'.
//
// Four coloring regimes selected by tuning mode:
//   Equal ('E')        — 3-hue octave cycle (equalHueCycle), aesthetic choice.
//   Ptolemaic/Septimal — base 7-hue cycle (computeHue at (q, r)), with
//   ('5','7')            Septimal qm=2 cells drawn from the warm-shifted
//                        .sl/.sd variants to signal B-region tuning.
//   Pythagorean/        — same 7-hue cycle, but SC-shifted cells (qm=1 and/or
//   Semiditonal          qm=2) take the hue of their SC sibling at (q∓7, r±4),
//   ('P','D')            because the SC shift makes them enharmonic with that
//                        5-limit cell.
//   Schismatic ('V')   — M3-chain coloring: chainStep = floor((2q+1)/3),
//                        idx = (5 − midiOct − 2·chainStep) mod 7 in hueCycle.
//                        Tracks the M3 chain (qm=1 of band b paired with qm=2
//                        of band b+1) across MIDI octaves. No octave invariance
//                        because +3Q = octave + schisma in V mode.

import { bandOf } from '../layout/coords.js';
import { tuning } from '../state/tuning.js';
import { regionInfo } from '../tuning/regions.js';
import {
  type Hue, type HueColors,
  hueC, hueCycle, whiteSet, hueCycleOrder, hueIdx, equalHueCycle,
} from '../shared/colors.js';

export type { Hue, HueColors };
export { hueC, hueCycle, whiteSet, hueCycleOrder, hueIdx, equalHueCycle };

/* Hue from `floor(midi/12) - bandOf(q)` modulo 7. Equal mode collapses to a
   3-hue octave cycle; everything else uses the 7-hue lineage. */
export function computeHue(q: number, r: number): Hue {
  const midi = 57 + 4 * q + 7 * r;
  if (tuning.equalEnabled) return equalHueCycle[((Math.floor(midi / 12) % 3) + 3) % 3];
  const b = bandOf(q);
  return hueCycleOrder[(((Math.floor(midi / 12) - b - 4) % 7) + 7) % 7];
}

/** Color variant for a cell, accounting for mode-driven SC shifts. Three
 *  branches:
 *   1. Septimal qm=2 (region B): keep the existing warm-shifted .sl/.sd
 *      variant — the half-lerp toward the next hue signals septimal flavor.
 *   2. Pure-SC-shift cells (Pythagorean/Semiditonal, type='A' with aDepth>0):
 *      look up the hue at the SC-shifted sibling coords. Because SC shift
 *      preserves MIDI (7 * 4 − 4 * 7 = 0), the cell's pitch class — and
 *      therefore white/black classification — is unchanged; only the hue
 *      lineage rotates (e.g. purple → teal for −SC).
 *   3. Base 5-limit / Equal: untouched .l/.d.
 *
 *  Returns the picked Hue + variant key so callers can also choose between
 *  fill (.l/.sl) and outline (.d/.sd) consistently. */
export function keyColorVariant(q: number, r: number): { hue: Hue; isW: boolean; isB: boolean; isShifted: boolean } {
  const midi = 57 + 4 * q + 7 * r;
  const pc = ((midi % 12) + 12) % 12;
  const isW = whiteSet.has(pc);
  /* V mode: M3-chain coloring. Octave invariance is broken (+3Q = octave +
     schisma), so color tracks position along the M3 chain (chainStep) and
     MIDI octave. The M3 chain crosses band boundaries: qm=1 of band b shares
     a chain with qm=2 of band b+1 — flat across the M3 step, +1 across each
     PM3 step. Same chain + same MIDI octave = same color. */
  if (tuning.mode === 'V') {
    const midiOct = Math.floor(midi / 12);
    const chainStep = Math.floor((2 * q + 1) / 3);
    const idx = (((5 - midiOct - 2 * chainStep) % 7) + 7) % 7;
    return { hue: hueCycle[idx], isW, isB: false, isShifted: false };
  }
  const ri = regionInfo(q, r);
  if (ri.type === 'B') {
    return { hue: computeHue(q, r), isW, isB: true, isShifted: false };
  }
  if (ri.aDepth > 0) {
    /* −SC = (+7, −4); +SC = (−7, +4). Multiply by aDepth for future-proofing
       against d>1 modes. */
    const sgn = ri.aUpper ? +1 : -1;
    const sq = q + sgn * 7 * ri.aDepth;
    const sr = r - sgn * 4 * ri.aDepth;
    return { hue: computeHue(sq, sr), isW, isB: false, isShifted: true };
  }
  return { hue: computeHue(q, r), isW, isB: false, isShifted: false };
}

/* returns hex color string for key at lattice (q,r) under current tuning state */
export function keyColorHex(q: number, r: number): string {
  const v = keyColorVariant(q, r);
  if (v.isB) return v.isW ? hueC[v.hue].sl! : hueC[v.hue].sd!;
  return v.isW ? hueC[v.hue].l : hueC[v.hue].d;
}
