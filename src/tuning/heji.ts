// Extended Helmholtz-Ellis JI Pitch Notation (HEJI) accidentals — lattice
// display layer.
//
// HEJI sits ON TOP of the conventional Pythagorean letter+accidental spelling
// produced by noteName() / noteNameV(). It adds two further glyph families:
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

import { bandOf, posInBand } from '../layout/coords.js';
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
  const db = bandOf(q) - bandOf(0);
  const dp = posInBand(q) - posInBand(0);
  const dr = r - 0;
  let e3 = dr, e5 = dp, e7 = 0;
  /* e2 not needed for HEJI; commas don't care about octave */
  if (modeHasShifts(state.mode)) {
    const ri1 = regionInfoWithState(0, 0, state);
    const ri2 = regionInfoWithState(q, r, state);
    const apply = (ri: RegionInfo, sign: number): void => {
      if (ri.aDepth > 0) {
        const d = ri.aDepth;
        if (ri.aUpper) { e5 += sign * d; e3 += sign * (-4) * d; }
        else { e3 += sign * 4 * d; e5 += sign * (-d); }
      }
      if (ri.type === 'B') { e7 += sign; e3 += sign * 2; }
    };
    apply(ri2, +1);
    apply(ri1, -1);
  }
  if (state.mode === 'V' && db !== 0) {
    e3 += db * 8;
    e5 += db * 1;
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

/** Result of HEJI label assembly. `letter` renders in sans-serif (always
 *  A–G); `glyphs` is the chain of SMuFL codepoints (rendered in Bravura)
 *  that follows the letter, left to right. Empty `glyphs` means the cell is
 *  on the Pythagorean spine with no commas — render the bare letter. */
export interface HejiLabel {
  letter: string;
  glyphs: HejiGlyphInfo[];
}

/** Build the HEJI label for a cell given its conventional spelling and JI
 *  commas. Rules (per HKL design, src/tuning/heji.ts):
 *
 *   1. Stack double accidentals (with a single accidental prepended if the
 *      accidental count is odd): e.g. accVal=+3 → [#, 𝄪]; accVal=−5 → [♭, 𝄫, 𝄫].
 *   2. Distribute syntonic commas across that chain, up to 2 per glyph,
 *      filling left to right. Each accidental glyph becomes its combined
 *      "accidental + N arrows" Bravura variant.
 *   3. Extra commas (when |syn5| exceeds the chain's 2/glyph capacity) get
 *      appended as natural-sign carriers, each holding up to 2 arrows.
 *   4. A septimal hook (sept7 ≠ 0) appends one standalone glyph at the end.
 *
 *  The only case that produces an empty `glyphs` array is the trivial bare-
 *  letter case: accVal=0 AND syn5=0 AND sept7=0. */
export function hejiLabel(noteNameStr: string, commas: HejiCommas): HejiLabel {
  const p = parseNote(noteNameStr);
  const accVal = accToVal(p.acc);
  const { syn5, sept7 } = commas;

  if (accVal === 0 && syn5 === 0 && sept7 === 0) {
    return { letter: p.letter, glyphs: [] };
  }

  /* Step 1: build the conventional accidental chain. */
  type ChainItem = { kind: AccKind; arrows: number };
  const chain: ChainItem[] = [];
  if (accVal !== 0) {
    const n = Math.abs(accVal);
    const isSharp = accVal > 0;
    if (n % 2 === 1) chain.push({ kind: isSharp ? 'sharp' : 'flat', arrows: 0 });
    const doubles = Math.floor(n / 2);
    for (let i = 0; i < doubles; i++) {
      chain.push({ kind: isSharp ? 'doubleSharp' : 'doubleFlat', arrows: 0 });
    }
  }

  /* Step 2: distribute arrows over the chain, up to 2 per glyph,
   * filling left to right. Sign carries through `combinedCode`. */
  const arrowSign = syn5 > 0 ? +1 : -1;
  let remaining = Math.abs(syn5);
  for (let i = 0; i < chain.length && remaining > 0; i++) {
    const here = Math.min(remaining, 2);
    chain[i].arrows = here * arrowSign;
    remaining -= here;
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

  return { letter: p.letter, glyphs };
}
