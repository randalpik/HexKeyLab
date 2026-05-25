// Extended Helmholtz-Ellis JI Pitch Notation (HEJI) accidentals — lattice
// display layer.
//
// HEJI sits ON TOP of the conventional Pythagorean letter+accidental spelling
// produced by noteName(). It adds two further glyph families:
//   - syntonic-comma arrows (5-limit), each 80:81 ≈ 21.5¢
//   - septimal-comma hooks (7-limit), each 63:64 ≈ 27.3¢
//
// Sign convention for the comma counts returned by hejiCommas():
//   e5 > 0 → cell is BELOW its Pythagorean nominal by |e5| syntonic commas
//     → render |e5| down-arrows. (5/4 = e=[−2,0,+1,0] is 21.5¢ below 81/64
//     = the Pythagorean major third.)
//   e5 < 0 → up-arrows.
//   e7 > 0 → down-hooks (7/4 = e=[−2,0,0,+1] is 27.3¢ below 16/9).
//   e7 < 0 → up-hooks. (Current HKL layouts only produce e7 ∈ {-0, 0, +1}.)
//
// Rendering strategy: use SMuFL combined "accidental + arrows" glyphs from
// Bravura's "Extended Helmholtz-Ellis accidentals (just intonation)" range
// U+E2C0–E2FF. Each Pythagorean accidental in the label is replaced by the
// combined glyph carrying that accidental plus up to 2 attached arrows.
// Arrows beyond the accidental chain's capacity (2 per glyph) get parked on
// natural-sign carriers appended after the chain. The septimal hook (when
// present) is a separate standalone glyph (no Pythagorean carrier — SMuFL
// provides accidentalLowerOneSeptimalComma / RaiseOne as bare hooks).
//
// SMuFL codepoints verified against w3c/smufl/gh-pages/metadata/glyphnames.json.

import { posInBand } from '../layout/coords.js';
import { regionInfoWithState, modeHasShifts } from './regions.js';
import { accToVal, parseNote } from './notes.js';
import type { TuningStateLike } from './regions.js';
import type { RegionInfo } from '../types.js';

export interface HejiCommas {
  syn5: number;
  sept7: number;
}

/** HEJI comma counts for the cell (q, r) relative to the A3 origin under the
 *  given tuning state. Returns {0, 0} for cells whose JI ratio sits exactly on
 *  the Pythagorean chain (Equal, Pythagorean spine, etc.).
 *
 *  Inlines the prime-exponent math from `jiRatioWithState` because that
 *  function swaps signs to keep the displayed ratio ascending — useful for
 *  interval analysis, but wrong for HEJI: a cell that sits BELOW A3 with
 *  +1 e5 (i.e., +1 syntonic-comma-up shift relative to its Pythagorean
 *  nominal) must keep its sign, not flip to make num/den look right. */
export function hejiCommas(q: number, r: number, state: TuningStateLike): HejiCommas {
  /* Equal mode is 12-TET — no JI semantics, so the base-formula e5 (which
     would otherwise pick up qm via posInBand) is conceptually meaningless.
     Suppress commas entirely. Without this, qm=1/qm=2 cells in Equal mode
     would carry phantom syntonic-comma arrows even though those cells are
     just enharmonic 12-TET pitches. */
  if (state.mode === 'E') return { syn5: 0, sept7: 0 };
  /* V (schismatic) mode intentionally does NOT add per-band schisma arrows
     here. The schisma is signaled by V's band-distinguishing coloring +
     band seam; making HEJI also indicate it would double-flag the same
     fact, and the schisma's syntonic component (~2c) is much smaller than
     a real syntonic comma arrow's nominal (~22c). The interval analyzer
     surfaces octave+schisma via jiRatioWithState's prime decomposition. */
  const dp = posInBand(q) - posInBand(0);
  let e5 = dp, e7 = 0;
  /* e2 / e3 not needed for HEJI; commas don't care about octave or pure
     Pythagorean stacking. */
  if (modeHasShifts(state.mode)) {
    const ri1 = regionInfoWithState(0, 0, state);
    const ri2 = regionInfoWithState(q, r, state);
    const apply = (ri: RegionInfo, sign: number): void => {
      if (ri.aDepth > 0) {
        const d = ri.aDepth;
        if (ri.aUpper) e5 += sign * d;
        else e5 += sign * (-d);
      }
      if (ri.type === 'B') e7 += sign;
    };
    apply(ri2, +1);
    apply(ri1, -1);
  }
  return { syn5: e5, sept7: e7 };
}

/* SMuFL combined "accidental + N arrows" glyphs. Each row indexed by
 *   [bare, 1-arrow-down, 1-arrow-up, 2-arrows-down, 2-arrows-up].
 * Bravura ships with all of these (the "Extended Helmholtz-Ellis accidentals
 * (just intonation)" range, U+E2C0–E2FF). The bare codepoints (column 0) are
 * the standard accidentals from the "Standard accidentals (12-EDO)" range
 * U+E260–E26F.
 * Confirmed against w3c/smufl glyphnames.json. */
const CODES_FLAT       = [0xE260, 0xE2C1, 0xE2C6, 0xE2CB, 0xE2D0] as const;
const CODES_NATURAL    = [0xE261, 0xE2C2, 0xE2C7, 0xE2CC, 0xE2D1] as const;
const CODES_SHARP      = [0xE262, 0xE2C3, 0xE2C8, 0xE2CD, 0xE2D2] as const;
const CODES_DBL_SHARP  = [0xE263, 0xE2C4, 0xE2C9, 0xE2CE, 0xE2D3] as const;
const CODES_DBL_FLAT   = [0xE264, 0xE2C0, 0xE2C5, 0xE2CA, 0xE2CF] as const;

/* Standalone septimal hooks (no Pythagorean carrier — these don't combine
 * with the syntonic-arrow glyphs above; they sit at the end of the label.
 * Bravura provides single and double hooks but current HKL layouts only
 * produce |e7| ≤ 1, so we use only the single-hook codes. */
const SEPT_DOWN_1 = 0xE2DE; // accidentalLowerOneSeptimalComma
const SEPT_UP_1   = 0xE2DF; // accidentalRaiseOneSeptimalComma

export type HejiGlyphFamily = 'flat' | 'natural' | 'sharp' | 'doubleSharp' | 'doubleFlat' | 'septimal';
type AccKind = Exclude<HejiGlyphFamily, 'septimal'>;

function accTable(kind: AccKind): readonly number[] {
  switch (kind) {
    case 'flat':        return CODES_FLAT;
    case 'natural':     return CODES_NATURAL;
    case 'sharp':       return CODES_SHARP;
    case 'doubleSharp': return CODES_DBL_SHARP;
    case 'doubleFlat':  return CODES_DBL_FLAT;
  }
}

/** Pick the combined-glyph codepoint for an accidental + signed arrow count.
 *  `arrows` is the signed count: positive = down arrows, negative = up arrows.
 *  Up to ±2 per glyph (Bravura also has ±3 variants, but the layout policy
 *  caps at 2 per glyph — extras spill onto natural carriers). */
function combinedCode(kind: AccKind, arrows: number): number {
  const t = accTable(kind);
  if (arrows === 0) return t[0];
  if (arrows === 1) return t[1];
  if (arrows === -1) return t[2];
  if (arrows === 2) return t[3];
  if (arrows === -2) return t[4];
  /* shouldn't happen — caller distributes arrows in ≤ 2 chunks */
  return t[0];
}

/** A single Bravura glyph in the chain after the letter. The `family` field
 *  carries the underlying Pythagorean accidental kind (or 'septimal' for the
 *  Tartini hook) so the renderer can apply per-family vertical offsets —
 *  needed because flat-family glyphs are asymmetric around the musical
 *  baseline (body below, stem above) and visually misalign with the
 *  symmetric natural/sharp/doubleSharp family otherwise. */
export interface HejiGlyphInfo {
  ch: string;
  family: HejiGlyphFamily;
}

/** Threshold above which a high accidental or syntonic count collapses into a
 *  single-glyph-with-exponent form (`#⁷`, `(#↑)⁵`, …) to keep the lattice
 *  label readable. Strict inequality matches docs/backlog.md: only |AD|≥5 or
 *  |SD|≥5 can trigger collapse, so the common cases (a 𝄪, a 𝄫, F# with one
 *  arrow) keep their existing multi-glyph rendering. */
export const COLLAPSE_THRESHOLD = 4;

/** When a cell's accidental degree (AD) and/or syntonic degree (SD) is large
 *  enough to trigger collapse, the renderer draws a single accidental-form
 *  glyph carrying a small superscript count, with the remaining unabsorbed
 *  glyphs rendered as a normal chain on the side specified by `position`:
 *
 *    'before' — collapse glyph carries an arrow, so it precedes the chain.
 *    'after'  — collapse glyph is a bare accidental, so the chain (which
 *               carries all the arrows) comes first and the collapse glyph
 *               trails it.
 *
 *  The septimal hook, when present, is always part of the chain (last slot)
 *  and is never collapsed; it stays at the very end of the label regardless. */
export interface CollapseSpec {
  glyph: HejiGlyphInfo;
  count: number;
  position: 'before' | 'after';
}

/** Result of HEJI label assembly. `letter` renders in sans-serif (always
 *  A–G); `glyphs` is the chain of SMuFL codepoints (rendered in Bravura)
 *  that follows the letter, left to right. When `collapse` is set, the
 *  renderer draws the collapse glyph + a small superscript count adjacent
 *  to the chain. `glyphs` can be empty even when `collapse` is set — that's
 *  the fully-absorbed case (e.g. Case A with |AD|=|SD|, or non-HEJI V mode
 *  with no leftover accidentals). Empty `glyphs` AND undefined `collapse`
 *  means the cell is on the Pythagorean spine with no commas — render the
 *  bare letter. */
export interface HejiLabel {
  letter: string;
  glyphs: HejiGlyphInfo[];
  collapse?: CollapseSpec;
}

/** Build the HEJI label for a cell given its conventional spelling and JI
 *  commas. Rules (per HKL design, src/tuning/heji.ts):
 *
 *   0. If |AD| > COLLAPSE_THRESHOLD or |SD| > COLLAPSE_THRESHOLD, collapse a
 *      slice of the label into a single accidental-form glyph + superscript
 *      count. Two cases (docs/backlog.md):
 *        Case A — both |AD|>T and |SD|>T: collapse target = accidental + 1
 *          arrow. Exponent k = min(|AD|, |SD|), absorbing one of each per
 *          unit. Leftover is whichever of AD/SD was larger.
 *        Case B — |AD−SD|>T, greedy: collapse target = bare accidental
 *          (if |AD|>|SD|) or natural + 1 arrow (if |SD|>|AD|). Exponent
 *          k = ||AD| − |SD||. Leftover is min(|AD|, |SD|) of EACH, fully
 *          paired so the existing distributor packs them efficiently.
 *      Step 4 (septimal hook) is unaffected.
 *   1. Stack double accidentals (with a single accidental prepended if the
 *      remaining accidental count is odd): e.g. accVal=+3 → [#, 𝄪].
 *   2. Distribute remaining syntonic commas across that chain, up to 2 per
 *      glyph, filling left to right.
 *   3. Extras (when the chain's 2/glyph capacity is exceeded) get appended
 *      as natural-sign carriers, each holding up to 2 arrows.
 *   4. A septimal hook (sept7 ≠ 0) appends one standalone glyph at the end.
 *
 *  Empty `glyphs` array + undefined `collapse` is the bare-letter case.
 *  Empty `glyphs` + defined `collapse` is the fully-absorbed case (e.g.
 *  AD=SD=5 → single (#↑)⁵ glyph). */
export function hejiLabel(noteNameStr: string, commas: HejiCommas): HejiLabel {
  const p = parseNote(noteNameStr);
  const accVal = accToVal(p.acc);
  const { syn5, sept7 } = commas;

  if (accVal === 0 && syn5 === 0 && sept7 === 0) {
    return { letter: p.letter, glyphs: [] };
  }

  /* Step 0: decide collapse and reduce AD/SD that the chain will see. */
  const a = Math.abs(accVal);
  const s = Math.abs(syn5);
  const sa = accVal >= 0 ? 1 : -1;
  const ss = syn5 >= 0 ? 1 : -1;
  let collapse: CollapseSpec | undefined;
  let accValRem = accVal;
  let syn5Rem = syn5;
  if (a > COLLAPSE_THRESHOLD && s > COLLAPSE_THRESHOLD) {
    /* Case A: both large. Each exponent unit consumes 1 accidental + 1 arrow,
       so k can be at most min(a, s) without running one type negative. */
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
    /* Case B: one significantly larger than the other. Greedy — absorb the
       entire excess into the exponent, leaving the smaller magnitude in BOTH
       counts so the leftover pairs perfectly (no nat-carrier spillover). */
    const k = Math.abs(a - s);
    if (s > a) {
      /* s-heavy: target is a natural + 1 arrow. AD untouched. */
      collapse = {
        glyph: { ch: String.fromCodePoint(combinedCode('natural', ss)), family: 'natural' },
        count: k,
        position: 'before',
      };
      syn5Rem = a * ss;
    } else {
      /* a-heavy: target is a bare single accidental. SD untouched. */
      const kind: AccKind = sa > 0 ? 'sharp' : 'flat';
      collapse = {
        glyph: { ch: String.fromCodePoint(combinedCode(kind, 0)), family: kind },
        count: k,
        position: 'after',
      };
      accValRem = s * sa;
    }
  }

  /* Step 1: build the conventional accidental chain on the remainder. */
  type ChainItem = { kind: AccKind; arrows: number };
  const chain: ChainItem[] = [];
  if (accValRem !== 0) {
    const n = Math.abs(accValRem);
    const isSharp = accValRem > 0;
    if (n % 2 === 1) chain.push({ kind: isSharp ? 'sharp' : 'flat', arrows: 0 });
    const doubles = Math.floor(n / 2);
    for (let i = 0; i < doubles; i++) {
      chain.push({ kind: isSharp ? 'doubleSharp' : 'doubleFlat', arrows: 0 });
    }
  }

  /* Step 2: balanced distribution — assign 1 arrow per glyph left to
   * right, then a second pass for the 2nd arrow (also left to right).
   * Visually uniform: F xx with one arrow renders as `x↓ x↓` rather than
   * `x↓↓ x`. Capacity stays 2 per glyph; overflow falls through to Step 3. */
  const arrowSign = syn5Rem > 0 ? +1 : -1;
  let remaining = Math.abs(syn5Rem);
  for (let pass = 0; pass < 2 && remaining > 0; pass++) {
    for (let i = 0; i < chain.length && remaining > 0; i++) {
      chain[i].arrows += arrowSign;
      remaining -= 1;
    }
  }

  /* Step 3: extras spill onto natural-sign carriers. */
  while (remaining > 0) {
    const here = Math.min(remaining, 2);
    chain.push({ kind: 'natural', arrows: here * arrowSign });
    remaining -= here;
  }

  const glyphs: HejiGlyphInfo[] = chain.map(c => ({
    ch: String.fromCodePoint(combinedCode(c.kind, c.arrows)),
    family: c.kind,
  }));

  /* Step 4: septimal hook (current layouts produce |sept7| ≤ 1). */
  if (sept7 !== 0) {
    const code = sept7 > 0 ? SEPT_DOWN_1 : SEPT_UP_1;
    glyphs.push({ ch: String.fromCodePoint(code), family: 'septimal' });
  }

  return collapse ? { letter: p.letter, glyphs, collapse } : { letter: p.letter, glyphs };
}
