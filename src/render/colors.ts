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
//   Schismatic ('V')   — Semiditonal coloring in the central band (the band
//                        containing refSpine), rotated by 5 hue indices
//                        (≡ −2 mod 7) per (band − centralBand). The central
//                        band reads identically to Semiditonal so the in-band
//                        M3 relationship (qm=2 and qm=0 share a hue at r=0)
//                        carries over directly. Other bands carry the same
//                        relationship internally but rotated, signaling
//                        schisma accumulation — color becomes the sole
//                        indicator that the spelled octave has been altered.
//                        The +5 cadence preserves the old V mode's hues for
//                        qm=0 and qm=2 cells across bands; only qm=1 cells
//                        change (they now align with Semiditonal's qm=1).

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
  /* V mode: Semiditonal coloring in band 0 (the band containing the lattice
     origin / default-ref A3), rotated by +5 hue indices per band offset
     from band 0. Band 0 thus matches Semiditonal exactly — the in-band M3
     relationship (qm=2 and qm=0 share a hue) carries straight over. Other
     bands carry the same internal relationships but rotated, so the
     "same letter, next band" cell gets a different hue, signaling that
     the spelled octave has been altered by a schisma. The +5 (≡ −2 mod 7)
     cadence preserves the old V mode's qm=0/qm=2 hues across bands —
     only qm=1 cells change to align with Semiditonal's qm=1. Anchoring
     on band 0 (not the current ref's band) makes the per-cell color a
     pure function of (q, r): a ref change slides the lattice underneath
     the outline but does NOT rotate the cell hues. */
  if (tuning.mode === 'V') {
    const qm = ((q % 3) + 3) % 3;
    /* Semiditonal-style: qm=2 cells redirect to the SC sibling at
       (q+7, r−4); qm=0 / qm=1 use the cell's own coords. */
    const sq = qm === 2 ? q + 7 : q;
    const sr = qm === 2 ? r - 4 : r;
    const isShifted = qm === 2;
    const semHue = computeHue(sq, sr);
    const db = bandOf(q);
    const idx = (((hueIdx[semHue] + 5 * db) % 7) + 7) % 7;
    return { hue: hueCycleOrder[idx], isW, isB: false, isShifted };
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
