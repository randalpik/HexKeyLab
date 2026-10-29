// Pure accidental helpers shared between HKL Composer's notation pipeline and
// HKL's live-chord staff inset. No MEI-document or measure-context logic lives
// here (that stays Composer-side in notation/accidental-display.ts) — only the
// token<->integer conversions and the (q, r)-derived true alteration.
//
// Count-form accidental string (HKL bridge format):
//   ''     no accidental         'n'     explicit natural sign
//   's'    +1     'f'    -1
//   'ss'   +2     'ff'   -2
//   'sss'  +3     'fff'  -3

import { noteName, parseNote, accToVal } from '@hkl/shared/notes.js';
import type { Mapping } from '@hkl/shared/mapping.js';

/** Convert a single MEI accidental token to signed integer alteration. */
export function alterFromToken(t: string): number {
  switch (t) {
    case 's': return 1;
    case 'f': return -1;
    case 'n': case '': return 0;
    case 'ss': case 'x': return 2;
    case 'ff': return -2;
    case 'ts': case 'xs': case 'sx': return 3;
    case 'tf': return -3;
    default: return 0;
  }
}

/** Parse a count-form accidental string (HKL bridge format) to integer.
 *  '' / 'n' → 0; 's' → 1; 'ss' → 2; 'sss' → 3; same negative for 'f'.
 *  Values outside ±3 are still parsed correctly; the caller's entry filter
 *  decides what to do with them. */
export function alterFromCount(s: string): number {
  if (!s || s === 'n') return 0;
  let n = 0;
  for (const c of s) {
    if (c === 's') n++;
    else if (c === 'f') n--;
  }
  return n;
}

/** Return the canonical MEI single-glyph token for a given alteration in
 *  ±3 range. For 0 returns null (no accidental written; caller decides
 *  whether to emit 'n' for explicit cancellation). For |alter|>3, clamps
 *  to ±3 to keep the function total. */
export function tokenFromAlter(alter: number): string | null {
  if (alter === 0) return null;
  const sign = alter > 0 ? 1 : -1;
  const n = Math.min(Math.abs(alter), 3);
  if (n === 1) return sign > 0 ? 's' : 'f';
  if (n === 2) return sign > 0 ? 'x' : 'ff';
  return sign > 0 ? 'ts' : 'tf';
}

/** The @accid.ges token for an alteration. Same as `tokenFromAlter` except
 *  the double sharp: MEI's data.ACCIDENTAL.GESTURAL has `ss` and no `x` (`x`
 *  is a WRITTEN glyph choice, × rather than ##; a gestural value draws
 *  nothing). Writing `x` here made Verovio warn "Unsupported value 'x' for
 *  data.ACCIDENTAL.GESTURAL" on every hidden double sharp (2026-10-20). */
export function gesturalTokenFromAlter(alter: number): string | null {
  const t = tokenFromAlter(alter);
  return t === 'x' ? 'ss' : t;
}

/** True alteration for a note, derived from its lattice coordinate (q, r) —
 *  in the score's `mapping` frame, spelled under `anchor` / `banded` (see
 *  noteName) — so any magnitude is represented (the @accid token caps at ±3).
 *  Falls back to the @accid token when no coordinate is present (e.g.
 *  MusicXML-imported notes). */
export function noteAlter(note: Element, mapping: Mapping, anchor: number, banded: boolean): number {
  const qs = note.getAttribute('data-q');
  const rs = note.getAttribute('data-r');
  if (qs !== null && rs !== null) {
    const q = parseInt(qs, 10);
    const r = parseInt(rs, 10);
    if (Number.isFinite(q) && Number.isFinite(r)) {
      return accToVal(parseNote(noteName(q, r, mapping, anchor, banded)).acc);
    }
  }
  return getNoteAlter(note);
}

/** Net alteration on a note, reading from @accid then @accid.ges. */
export function getNoteAlter(note: Element): number {
  const a = note.getAttribute('accid');
  if (a !== null) return alterFromToken(a);
  const g = note.getAttribute('accid.ges');
  if (g !== null) return alterFromToken(g);
  return 0;
}
