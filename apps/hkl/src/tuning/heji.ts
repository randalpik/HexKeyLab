// Extended Helmholtz-Ellis JI Pitch Notation (HEJI) accidentals — lattice
// display layer (HKL side).
//
// The pure glyph/comma math now lives in src/shared/heji.ts so HKL Composer can
// share it. This module is the HKL-side wrapper: it binds the comma math to the
// live/snapshot tuning state and adds the readability "collapse" step that the
// lattice label renderer (src/render/draw.ts) uses. Composer deliberately does
// NOT collapse — it draws the full chain via hejiChain() directly.
//
// HEJI sits ON TOP of the conventional Pythagorean letter+accidental spelling
// produced by noteName(). It adds syntonic-comma arrows (5-limit, 80:81) and
// septimal-comma hooks (7-limit, 63:64). See src/shared/heji.ts for the sign
// convention and SMuFL codepoint tables.

import { accToVal, parseNote } from '@hkl/shared/notes.js';
import type { TuningStateLike } from './regions.js';
import {
  combinedCode,
  hejiChain,
  hejiCommasFor,
  type HejiCommas,
  type HejiGlyphFamily,
  type HejiGlyphInfo,
} from '@hkl/shared/heji.js';

export type { HejiCommas, HejiGlyphFamily, HejiGlyphInfo };

/** HEJI comma counts for the cell (q, r) under the given tuning state.
 *  Delegates to the pure shared implementation, keyed on the state's mode. */
export function hejiCommas(q: number, r: number, state: TuningStateLike): HejiCommas {
  return hejiCommasFor(state.mode, q, r, state.mapping, state.anchor, state.banded);
}

type AccKind = Exclude<HejiGlyphFamily, 'septimal'>;

/** Threshold above which a high accidental or syntonic count collapses into a
 *  single-glyph-with-exponent form (`#⁷`, `(#↑)⁵`, …) to keep the lattice
 *  label readable. Strict inequality: only |AD|≥5 or |SD|≥5 triggers collapse,
 *  so the common cases (a 𝄪, a 𝄫, F# with one arrow) keep their multi-glyph
 *  rendering. */
export const COLLAPSE_THRESHOLD = 4;

/** Septimal hooks (|sept7|, stacked only by the unbanded Septimal layout)
 *  collapse to one hook with an exponent above this count. */
export const HOOK_COLLAPSE_THRESHOLD = 2;

/** One exponent group. When a cell's accidental degree (AD) and/or syntonic
 *  degree (SD) is large enough to trigger collapse, the renderer draws a
 *  single accidental-form glyph carrying a small superscript count, on the
 *  side of the remaining chain given by `position`. A label holds at most two
 *  groups (`hejiLabel` step 0). The septimal hooks are always the chain's last
 *  slots and collapse separately (`HejiLabel.hookCount`). */
export interface CollapseSpec {
  glyph: HejiGlyphInfo;
  count: number;
  position: 'before' | 'after';
}

/** Result of HEJI label assembly. `letter` renders in sans-serif (A–G);
 *  `glyphs` is the chain of SMuFL codepoints (rendered in Bravura) that follows
 *  the letter, left to right. Each entry of `collapses` is an exponent group:
 *  the renderer draws its glyph + a small superscript count, the 'before'
 *  groups ahead of the chain and the 'after' groups behind it, each side in
 *  array order. Empty `glyphs` AND empty `collapses` means the bare letter. */
export interface HejiLabel {
  letter: string;
  glyphs: HejiGlyphInfo[];
  collapses: CollapseSpec[];
  /** |sept7| when above HOOK_COLLAPSE_THRESHOLD: `glyphs` then ends in a
   *  single hook, which the renderer draws with this count as its exponent. */
  hookCount?: number;
}

/** Build the HEJI label for a cell given its conventional spelling and JI
 *  commas. Applies the collapse step (step 0) then builds the residual chain
 *  via the shared hejiChain (steps 1-4). See COLLAPSE_THRESHOLD. */
export function hejiLabel(noteNameStr: string, commas: HejiCommas): HejiLabel {
  const p = parseNote(noteNameStr);
  const accVal = accToVal(p.acc);
  const { syn5, sept7 } = commas;

  if (accVal === 0 && syn5 === 0 && sept7 === 0) {
    return { letter: p.letter, glyphs: [], collapses: [] };
  }

  /* Step 0: exponent groups, reducing the AD/SD the chain will see. `a` and
     `s` are what is still to be drawn. */
  let a = Math.abs(accVal);
  let s = Math.abs(syn5);
  const sa = accVal >= 0 ? 1 : -1;
  const ss = syn5 >= 0 ? 1 : -1;
  const single: AccKind = sa > 0 ? 'sharp' : 'flat';
  const collapses: CollapseSpec[] = [];
  const group = (kind: AccKind, arrows: number, count: number, position: CollapseSpec['position']): void => {
    collapses.push({
      glyph: { ch: String.fromCodePoint(combinedCode(kind, arrows * ss)), family: kind },
      count,
      position,
    });
  };
  if (a > COLLAPSE_THRESHOLD && s > COLLAPSE_THRESHOLD) {
    /* 0a: both large — pair them into one unit. The unit is 1 accidental + 1
       arrow unless that would strand an excess above the threshold on one
       side; that side then doubles in the unit (2 arrows per accidental, or a
       double accidental per arrow), which leaves a short chain where a 1:1
       unit would leave a second long run. */
    const accPer = a - s > COLLAPSE_THRESHOLD ? 2 : 1;
    const arrowsPer = s - a > COLLAPSE_THRESHOLD ? 2 : 1;
    const k = Math.min(Math.floor(a / accPer), Math.floor(s / arrowsPer));
    const double: AccKind = sa > 0 ? 'doubleSharp' : 'doubleFlat';
    group(accPer === 2 ? double : single, arrowsPer, k, 'before');
    a -= k * accPer;
    s -= k * arrowsPer;
  }
  if (Math.abs(a - s) > COLLAPSE_THRESHOLD) {
    /* 0b: one side still exceeds the other by more than the threshold (one
       side small from the start, or a ratio beyond 2:1 after 0a). Greedy —
       absorb the whole excess; the chain gets equal residual AD/SD. */
    const k = Math.abs(a - s);
    if (s > a) {
      group('natural', 1, k, 'before');
      s = a;
    } else {
      group(single, 0, k, 'after');
      a = s;
    }
  }

  /* Septimal hooks above the threshold reduce to one hook + exponent. */
  const hookCount = Math.abs(sept7) > HOOK_COLLAPSE_THRESHOLD ? Math.abs(sept7) : undefined;

  /* Steps 1-4: residual chain + septimal hooks (shared, no collapse). */
  const glyphs = hejiChain(a * sa, s * ss, hookCount ? Math.sign(sept7) : sept7);

  const label: HejiLabel = { letter: p.letter, glyphs, collapses };
  if (hookCount) label.hookCount = hookCount;
  return label;
}
