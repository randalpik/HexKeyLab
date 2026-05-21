// Compute accidental display visibility per engraving convention.
//
// HKL emits a count-form accidental string per note via the bridge:
//   ''     no accidental         'n'     explicit natural sign
//   's'    +1     'f'    -1
//   'ss'   +2     'ff'   -2
//   'sss'  +3     'fff'  -3
//
// The bridge passes values for ±4+ too, but Composer's entry path
// (input.ts:commitDuration) filters those out — Verovio's multi-<accid>
// rendering doesn't allocate horizontal space and the glyphs overlap.
// Effectively the supported range is ±3, expressed as a single MEI
// accidental token (s/f/x/ff/ts/tf, or n for explicit natural).
//
// This pass operates on the rendered clone (not the live doc). Per note,
// it reads the net integer alteration from either @accid attribute or
// @accid.ges attribute, decides visibility against carry-state + key
// signature, and writes the canonical form back to the clone:
//
//   visible → @accid attribute set to the canonical glyph token
//   hidden  → @accid.ges holds the gestural token; @accid removed
//
// Engraving rules:
//   1. Within a measure, alteration at (pname, oct) carries forward across
//      voices on the same staff.
//   2. At a bar line, state resets to the key signature.
//   3. Tie destinations (@tie="t" or "m") are always hidden, but they DO
//      update carry state.

import { realTicks } from './ticks.js';

const SHARP_ORDER: ReadonlyArray<string> = ['f', 'c', 'g', 'd', 'a', 'e', 'b'];
const FLAT_ORDER:  ReadonlyArray<string> = ['b', 'e', 'a', 'd', 'g', 'c', 'f'];

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
 *  (input.ts:commitDuration) decides what to do with them. */
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
 *  to ±3 — Composer's entry filter should prevent this from ever reaching
 *  here, but the clamp keeps the function total. */
export function tokenFromAlter(alter: number): string | null {
  if (alter === 0) return null;
  const sign = alter > 0 ? 1 : -1;
  const n = Math.min(Math.abs(alter), 3);
  if (n === 1) return sign > 0 ? 's' : 'f';
  if (n === 2) return sign > 0 ? 'x' : 'ff';
  return sign > 0 ? 'ts' : 'tf';
}

/** Net alteration on a note, reading from @accid then @accid.ges. */
export function getNoteAlter(note: Element): number {
  const a = note.getAttribute('accid');
  if (a !== null) return alterFromToken(a);
  const g = note.getAttribute('accid.ges');
  if (g !== null) return alterFromToken(g);
  return 0;
}

/** Major-key tonic for a key-signature attribute. Returns the tonic spelled
 *  in HKL's note-name domain (capital letter + '#'/'b' suffix).
 *
 *    sharps:  0→A?  no — convention is 0→C  1→G  2→D  3→A  4→E  5→B  6→F#  7→C#
 *    flats:   1→F   2→Bb  3→Eb  4→Ab  5→Db  6→Gb  7→Cb
 *
 *  Returns 'C' for an unparseable sig (caller can treat as "no info"). */
export function keySigToTonic(sig: string): string {
  if (!sig || sig === '0') return 'C';
  const n = parseInt(sig.slice(0, -1), 10);
  if (!Number.isFinite(n) || n < 1 || n > 7) return 'C';
  if (sig.endsWith('s')) {
    return ['G', 'D', 'A', 'E', 'B', 'F#', 'C#'][n - 1];
  }
  if (sig.endsWith('f')) {
    return ['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'][n - 1];
  }
  return 'C';
}

/** Decode a key-signature attribute into a map of pitch letter → ±1. */
function keySigToAlter(sig: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!sig || sig === '0') return out;
  const n = parseInt(sig.slice(0, -1), 10);
  if (!Number.isFinite(n) || n <= 0) return out;
  const order = sig.endsWith('s') ? SHARP_ORDER : FLAT_ORDER;
  const v = sig.endsWith('s') ? 1 : -1;
  for (let i = 0; i < Math.min(n, 7); i++) out[order[i]] = v;
  return out;
}

/** Strip the visible @accid and gestural @accid.ges attributes. */
function clearAccidals(note: Element): void {
  note.removeAttribute('accid');
  note.removeAttribute('accid.ges');
}

/** Write the visible form of the given alter to @accid. alter=0 with a
 *  caller-supplied "need cancellation" intent writes 'n' (natural sign);
 *  alter=0 with no cancellation is handled by the caller before this. */
function showAlter(note: Element, alter: number): void {
  clearAccidals(note);
  if (alter === 0) {
    note.setAttribute('accid', 'n');
    return;
  }
  const token = tokenFromAlter(alter);
  if (token) note.setAttribute('accid', token);
}

/** Hide the accidental: move alter into @accid.ges so Verovio doesn't
 *  draw it but the gestural pitch is preserved. alter=0 leaves the note
 *  with no accidental representation. */
function hideAlter(note: Element, alter: number): void {
  clearAccidals(note);
  if (alter === 0) return;
  const token = tokenFromAlter(alter);
  if (token) note.setAttribute('accid.ges', token);
}

function elementDurationTicks(el: Element): number {
  return realTicks(el);
}

function notesInLayer(layer: Element): Array<{ note: Element; startTick: number; layerN: number }> {
  const layerN = parseInt(layer.getAttribute('n') ?? '1', 10);
  const out: Array<{ note: Element; startTick: number; layerN: number }> = [];
  let t = 0;
  for (const child of Array.from(layer.children)) {
    const ln = child.localName;
    if (ln === 'rest') {
      t += elementDurationTicks(child);
    } else if (ln === 'note') {
      out.push({ note: child, startTick: t, layerN });
      t += elementDurationTicks(child);
    } else if (ln === 'chord') {
      const chordTicks = elementDurationTicks(child);
      for (const n of Array.from(child.children)) {
        if (n.localName === 'note') out.push({ note: n, startTick: t, layerN });
      }
      t += chordTicks;
    } else if (ln === 'tuplet') {
      /* Descend into the tuplet, accumulating real-time ticks per child.
         realTicks() on a tuplet child returns its scaled (sounding) ticks
         automatically, so layer-relative startTicks come out correct. */
      for (const tChild of Array.from(child.children)) {
        const tln = tChild.localName;
        if (tln === 'rest' || tln === 'space') {
          t += elementDurationTicks(tChild);
        } else if (tln === 'note') {
          out.push({ note: tChild, startTick: t, layerN });
          t += elementDurationTicks(tChild);
        } else if (tln === 'chord') {
          const cTicks = elementDurationTicks(tChild);
          for (const n of Array.from(tChild.children)) {
            if (n.localName === 'note') out.push({ note: n, startTick: t, layerN });
          }
          t += cTicks;
        }
      }
    }
  }
  return out;
}

export function computeAccidentalDisplay(doc: Document, keySig: string): void {
  const keyAlters = keySigToAlter(keySig);
  const measures = doc.querySelectorAll('measure');
  for (const measure of Array.from(measures)) {
    for (const staffN of [1, 2]) {
      const staff = Array.from(measure.querySelectorAll('staff'))
        .find((s) => s.getAttribute('n') === String(staffN));
      if (!staff) continue;
      const layers = Array.from(staff.querySelectorAll('layer'));
      const allNotes: Array<{ note: Element; startTick: number; layerN: number }> = [];
      for (const layer of layers) allNotes.push(...notesInLayer(layer));
      allNotes.sort((a, b) =>
        a.startTick !== b.startTick ? a.startTick - b.startTick : a.layerN - b.layerN);

      /* (pname:oct) → currently-implied integer alteration for this measure-staff. */
      const local: Record<string, number> = {};

      for (const { note } of allNotes) {
        const pname = note.getAttribute('pname');
        const oct = note.getAttribute('oct');
        if (!pname || !oct) continue;
        const key = pname + ':' + oct;
        const alter = getNoteAlter(note);
        const expected = (key in local) ? local[key] : (keyAlters[pname] ?? 0);
        const tie = note.getAttribute('tie');
        const isTieDestination = tie === 't' || tie === 'm';

        if (isTieDestination) {
          /* Hide (chain initiator already showed it). Update state to the
             carried pitch so subsequent notes see it. */
          hideAlter(note, alter);
          local[key] = alter;
          continue;
        }

        if (alter === expected) {
          hideAlter(note, alter);
        } else {
          showAlter(note, alter);
          local[key] = alter;
        }
      }
    }
  }
}
