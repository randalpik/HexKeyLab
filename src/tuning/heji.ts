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

import { accToVal, parseNote } from './notes.js';
import type { TuningStateLike } from './regions.js';
import {
  combinedCode,
  hejiChain,
  hejiCommasFor,
  type HejiCommas,
  type HejiGlyphFamily,
  type HejiGlyphInfo,
} from '../shared/heji.js';

export type { HejiCommas, HejiGlyphFamily, HejiGlyphInfo };

/** HEJI comma counts for the cell (q, r) under the given tuning state.
 *  Delegates to the pure shared implementation, keyed on the state's mode. */
export function hejiCommas(q: number, r: number, state: TuningStateLike): HejiCommas {
  return hejiCommasFor(state.mode, q, r);
}

type AccKind = Exclude<HejiGlyphFamily, 'septimal'>;

/** Threshold above which a high accidental or syntonic count collapses into a
 *  single-glyph-with-exponent form (`#⁷`, `(#↑)⁵`, …) to keep the lattice
 *  label readable. Strict inequality: only |AD|≥5 or |SD|≥5 triggers collapse,
 *  so the common cases (a 𝄪, a 𝄫, F# with one arrow) keep their multi-glyph
 *  rendering. */
export const COLLAPSE_THRESHOLD = 4;

/** When a cell's accidental degree (AD) and/or syntonic degree (SD) is large
 *  enough to trigger collapse, the renderer draws a single accidental-form
 *  glyph carrying a small superscript count, with the remaining unabsorbed
 *  glyphs rendered as a normal chain on the side specified by `position`. The
 *  septimal hook, when present, is always part of the chain (last slot) and is
 *  never collapsed. */
export interface CollapseSpec {
  glyph: HejiGlyphInfo;
  count: number;
  position: 'before' | 'after';
}

/** Result of HEJI label assembly. `letter` renders in sans-serif (A–G);
 *  `glyphs` is the chain of SMuFL codepoints (rendered in Bravura) that follows
 *  the letter, left to right. When `collapse` is set, the renderer draws the
 *  collapse glyph + a small superscript count adjacent to the chain. Empty
 *  `glyphs` AND undefined `collapse` means the bare letter. */
export interface HejiLabel {
  letter: string;
  glyphs: HejiGlyphInfo[];
  collapse?: CollapseSpec;
}

/** Build the HEJI label for a cell given its conventional spelling and JI
 *  commas. Applies the collapse step (step 0) then builds the residual chain
 *  via the shared hejiChain (steps 1-4). See COLLAPSE_THRESHOLD. */
export function hejiLabel(noteNameStr: string, commas: HejiCommas): HejiLabel {
  const p = parseNote(noteNameStr);
  const accVal = accToVal(p.acc);
  const { syn5, sept7 } = commas;

  if (accVal === 0 && syn5 === 0 && sept7 === 0) {
    return { letter: p.letter, glyphs: [] };
  }

  /* Step 0: decide collapse and reduce the AD/SD the chain will see. */
  const a = Math.abs(accVal);
  const s = Math.abs(syn5);
  const sa = accVal >= 0 ? 1 : -1;
  const ss = syn5 >= 0 ? 1 : -1;
  let collapse: CollapseSpec | undefined;
  let accValRem = accVal;
  let syn5Rem = syn5;
  if (a > COLLAPSE_THRESHOLD && s > COLLAPSE_THRESHOLD) {
    /* Case A: both large. Each exponent unit consumes 1 accidental + 1 arrow. */
    const k = Math.min(a, s);
    const kind: AccKind = sa > 0 ? 'sharp' : 'flat';
    collapse = {
      glyph: { ch: String.fromCodePoint(combinedCode(kind, ss)), family: kind },
      count: k,
      position: 'before',
    };
    accValRem = (a - k) * sa;
    syn5Rem = (s - k) * ss;
  } else if (Math.abs(a - s) > COLLAPSE_THRESHOLD) {
    /* Case B: one significantly larger. Greedy — absorb the excess. */
    const k = Math.abs(a - s);
    if (s > a) {
      collapse = {
        glyph: { ch: String.fromCodePoint(combinedCode('natural', ss)), family: 'natural' },
        count: k,
        position: 'before',
      };
      syn5Rem = a * ss;
    } else {
      const kind: AccKind = sa > 0 ? 'sharp' : 'flat';
      collapse = {
        glyph: { ch: String.fromCodePoint(combinedCode(kind, 0)), family: kind },
        count: k,
        position: 'after',
      };
      accValRem = s * sa;
    }
  }

  /* Steps 1-4: residual chain + septimal hook (shared, no collapse). */
  const glyphs = hejiChain(accValRem, syn5Rem, sept7);

  return collapse ? { letter: p.letter, glyphs, collapse } : { letter: p.letter, glyphs };
}
