// Pure HEJI (Extended Helmholtz-Ellis JI) glyph + comma math, shared between
// HKL's lattice renderer (src/tuning/heji.ts wraps this) and the shared score
// renderer (src/notation/heji-render.ts, used by both Composer and HKL's live
// staff inset). No runtime state, no DOM, no Web Audio — pure data, per the
// src/shared/ contract.
//
// Two responsibilities:
//   1. hejiCommasFor(mode, q, r) — the signed syntonic/septimal comma counts
//      for a lattice cell under a tuning mode. Mirrors the region rules in
//      src/tuning/regions.ts (kept in lockstep — the rules are documented in
//      CLAUDE.md "Tuning modes").
//   2. hejiChain(accVal, syn5, sept7) — the ordered SMuFL glyph chain that
//      follows the letter: stacked accidentals carrying syntonic-comma arrows,
//      then an optional standalone septimal hook. This is hejiLabel() steps
//      1-4 with the readability "collapse" step removed (Composer always draws
//      the full chain).
//
// Sign convention (matches src/tuning/heji.ts):
//   syn5 > 0 → cell is BELOW its Pythagorean nominal → down-arrows.
//   syn5 < 0 → up-arrows.
//   sept7 > 0 → down-hooks; sept7 < 0 → up-hooks.

import type { TuningMode } from './freq.js';

/* ── glyph tables ──────────────────────────────────────────────────────────
 * Each row indexed by [bare, 1-down, 1-up, 2-down, 2-up]. Column 0 is the
 * standard accidental (U+E260–E26F); columns 1-4 are the "Extended
 * Helmholtz-Ellis accidentals (just intonation)" combined glyphs (U+E2C0–E2FF).
 * Confirmed against w3c/smufl glyphnames.json. */
const CODES_FLAT      = [0xE260, 0xE2C1, 0xE2C6, 0xE2CB, 0xE2D0] as const;
const CODES_NATURAL   = [0xE261, 0xE2C2, 0xE2C7, 0xE2CC, 0xE2D1] as const;
const CODES_SHARP     = [0xE262, 0xE2C3, 0xE2C8, 0xE2CD, 0xE2D2] as const;
const CODES_DBL_SHARP = [0xE263, 0xE2C4, 0xE2C9, 0xE2CE, 0xE2D3] as const;
const CODES_DBL_FLAT  = [0xE264, 0xE2C0, 0xE2C5, 0xE2CA, 0xE2CF] as const;

/* Standalone septimal hooks (no Pythagorean carrier). Current HKL layouts
 * only produce |sept7| ≤ 1, so only the single-hook codes are used. */
export const SEPT_DOWN_1 = 0xE2DE; // accidentalLowerOneSeptimalComma
export const SEPT_UP_1   = 0xE2DF; // accidentalRaiseOneSeptimalComma

export type HejiGlyphFamily =
  | 'flat' | 'natural' | 'sharp' | 'doubleSharp' | 'doubleFlat' | 'septimal';
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

/** Combined-glyph codepoint for an accidental + signed arrow count.
 *  `arrows` positive = down arrows, negative = up arrows; ±2 max per glyph. */
export function combinedCode(kind: AccKind, arrows: number): number {
  const t = accTable(kind);
  if (arrows === 0) return t[0];
  if (arrows === 1) return t[1];
  if (arrows === -1) return t[2];
  if (arrows === 2) return t[3];
  if (arrows === -2) return t[4];
  return t[0];
}

/** A single Bravura glyph in the chain after the letter. `family` carries the
 *  underlying accidental kind (or 'septimal') so renderers can apply per-family
 *  vertical offsets. */
export interface HejiGlyphInfo {
  ch: string;
  family: HejiGlyphFamily;
}

/* ── comma math ─────────────────────────────────────────────────────────── */

function posInBand(q: number): number { return ((q + 1) % 3 + 3) % 3; }

export function modeHasShifts(mode: TuningMode): boolean {
  return mode === 'P' || mode === 'D' || mode === '7' || mode === 'V';
}

interface RegionShift { aDepth: number; aUpper: boolean; isB: boolean; }

/** Per-cell shift profile for HEJI comma purposes — the (mode, qmod3) table
 *  from src/tuning/regions.ts, reduced to what comma counting needs. aUpper
 *  true → −SC (lowering); aDepth is the SC count; isB → +63/64 septimal. */
function regionShiftFor(mode: TuningMode, q: number): RegionShift {
  const qm = ((q % 3) + 3) % 3;
  switch (mode) {
    case 'E':
    case '5':
      return { aDepth: 0, aUpper: false, isB: false };
    case 'D':
    case 'V':
      return qm === 2 ? { aDepth: 1, aUpper: true, isB: false }
                      : { aDepth: 0, aUpper: false, isB: false };
    case 'P':
      return qm === 2 ? { aDepth: 1, aUpper: true,  isB: false }
           : qm === 1 ? { aDepth: 1, aUpper: false, isB: false }
                      : { aDepth: 0, aUpper: false, isB: false };
    case '7':
      return qm === 2 ? { aDepth: 1, aUpper: true, isB: true }
                      : { aDepth: 0, aUpper: false, isB: false };
  }
}

export interface HejiCommas {
  syn5: number;
  sept7: number;
}

/** HEJI comma counts for cell (q, r) relative to the A3 origin under `mode`.
 *  Pure; mirrors src/tuning/heji.ts hejiCommas exactly (that function now
 *  delegates here). Equal mode and the Pythagorean spine return {0, 0}. */
export function hejiCommasFor(mode: TuningMode, q: number, _r: number): HejiCommas {
  if (mode === 'E') return { syn5: 0, sept7: 0 };
  const dp = posInBand(q) - posInBand(0);
  let e5 = dp, e7 = 0;
  if (modeHasShifts(mode)) {
    const apply = (ri: RegionShift, sign: number): void => {
      if (ri.aDepth > 0) e5 += sign * (ri.aUpper ? ri.aDepth : -ri.aDepth);
      if (ri.isB) e7 += sign;
    };
    apply(regionShiftFor(mode, q), +1);
    apply(regionShiftFor(mode, 0), -1);
  }
  return { syn5: e5, sept7: e7 };
}

/* ── glyph chain ────────────────────────────────────────────────────────── */

/** Build the ordered glyph chain (left to right, as drawn after the letter)
 *  for a conventional alteration `accVal` plus HEJI commas. No collapse — the
 *  full chain is always returned, so this also serves plain accidental stacks
 *  of arbitrary size when syn5 = sept7 = 0.
 *
 *  Rules (HKL design, src/tuning/heji.ts steps 1-4):
 *   1. Stack double accidentals, single accidental prepended if odd:
 *      accVal=+3 → [#, x]; accVal=+4 → [x, x].
 *   2. Distribute syntonic commas across the chain, ≤2 per glyph, balanced
 *      (one pass of singles left-to-right, then a second pass).
 *   3. Overflow spills onto natural-sign carriers (≤2 arrows each).
 *   4. A septimal hook (sept7 ≠ 0) appends one standalone glyph at the end. */
export function hejiChain(accVal: number, syn5: number, sept7: number): HejiGlyphInfo[] {
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

  const arrowSign = syn5 > 0 ? +1 : -1;
  let remaining = Math.abs(syn5);
  for (let pass = 0; pass < 2 && remaining > 0; pass++) {
    for (let i = 0; i < chain.length && remaining > 0; i++) {
      chain[i].arrows += arrowSign;
      remaining -= 1;
    }
  }
  while (remaining > 0) {
    const here = Math.min(remaining, 2);
    chain.push({ kind: 'natural', arrows: here * arrowSign });
    remaining -= here;
  }

  const glyphs: HejiGlyphInfo[] = chain.map(c => ({
    ch: String.fromCodePoint(combinedCode(c.kind, c.arrows)),
    family: c.kind,
  }));

  if (sept7 !== 0) {
    const code = sept7 > 0 ? SEPT_DOWN_1 : SEPT_UP_1;
    glyphs.push({ ch: String.fromCodePoint(code), family: 'septimal' });
  }

  return glyphs;
}
