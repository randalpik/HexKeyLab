// Compute accidental display visibility per engraving convention (Composer
// measure-context logic). The pure token<->integer + (q,r)-alteration helpers
// now live in src/notation/accidentals.ts; this module keeps the
// measure/key-signature carry-state pass and the key-signature helpers.
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

import { realTicks } from '../model/ticks.js';
import { hejiCommasFor } from '@hkl/shared/heji.js';
import type { TuningMode } from '@hkl/shared/freq.js';
import { tokenFromAlter, noteAlter, getNoteAlter } from '@hkl/notation/accidentals.js';

const SHARP_ORDER: ReadonlyArray<string> = ['f', 'c', 'g', 'd', 'a', 'e', 'b'];
const FLAT_ORDER:  ReadonlyArray<string> = ['b', 'e', 'a', 'd', 'g', 'c', 'f'];

/** Tonic for a key-signature attribute. Returns the tonic spelled in HKL's
 *  note-name domain (capital letter + '#'/'b' suffix).
 *
 *  Major (default):
 *    sharps:  0→C  1→G  2→D  3→A  4→E  5→B  6→F#  7→C#
 *    flats:   1→F   2→Bb  3→Eb  4→Ab  5→Db  6→Gb  7→Cb
 *
 *  Minor (relative — same key sig, tonic three fifths up):
 *    sharps:  0→A   1→E  2→B  3→F#  4→C#  5→G#  6→D#  7→A#
 *    flats:   1→D   2→G  3→C   4→F   5→Bb  6→Eb  7→Ab
 *
 *  Returns the major 'C' / minor 'A' for an unparseable sig (caller can treat
 *  as "no info"). */
export function keySigToTonic(sig: string, mode: 'major' | 'minor' = 'major'): string {
  const minor = mode === 'minor';
  if (!sig || sig === '0') return minor ? 'A' : 'C';
  const n = parseInt(sig.slice(0, -1), 10);
  if (!Number.isFinite(n) || n < 1 || n > 7) return minor ? 'A' : 'C';
  if (sig.endsWith('s')) {
    return (minor
      ? ['E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#']
      : ['G', 'D', 'A', 'E', 'B', 'F#', 'C#'])[n - 1];
  }
  if (sig.endsWith('f')) {
    return (minor
      ? ['D', 'G', 'C', 'F', 'Bb', 'Eb', 'Ab']
      : ['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'])[n - 1];
  }
  return minor ? 'A' : 'C';
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

/** Force the alter visible AS a `<accid enclose="paren">` CHILD of the note,
 *  not as the inline @accid attribute. Verovio reserves layout space for the
 *  parens around the child accid, which is what we need so the parens don't
 *  collide with the notehead. The post-render BravuraText pass swaps
 *  Verovio's paren `<use>` glyphs to BravuraText `<text>` at the same
 *  positions. alter=0 with paren-caut still draws a parenthesized natural. */
function showAlterAsParenChild(note: Element, alter: number): void {
  clearAccidals(note);
  /* Strip any prior <accid> children from a previous pass — idempotent. */
  for (const c of Array.from(note.children)) {
    if (c.localName === 'accid') note.removeChild(c);
  }
  const token = alter === 0 ? 'n' : tokenFromAlter(alter);
  if (!token) return;
  const accid = note.ownerDocument!.createElementNS(
    'http://www.music-encoding.org/ns/mei',
    'accid',
  );
  accid.setAttribute('accid', token);
  accid.setAttribute('enclose', 'paren');
  note.appendChild(accid);
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

/** HEJI render context for visibility. When `enabled`, two notes that share
 *  pname/oct/alter but differ in comma counts are distinct pitches and BOTH
 *  must show — so carry-state keys on the full identity (alter, syn5, sept7),
 *  and a comma-bearing natural (no conventional accidental) is forced visible.
 *  When absent, classic conventional-accidental visibility is used. */
export interface HejiDisplayCtx {
  mode: TuningMode;
  enabled: boolean;
}

interface AccidIdentity { alter: number; syn5: number; sept7: number; }
function identityEq(a: AccidIdentity, b: AccidIdentity): boolean {
  return a.alter === b.alter && a.syn5 === b.syn5 && a.sept7 === b.sept7;
}

export function computeAccidentalDisplay(doc: Document, keySig: string, heji?: HejiDisplayCtx): void {
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

      /* (pname:oct) → currently-implied accidental identity for this
         measure-staff. With HEJI off, syn5/sept7 stay 0 and this reduces to
         the conventional integer-alteration carry. */
      const local: Record<string, AccidIdentity> = {};

      const commasOf = (note: Element): { syn5: number; sept7: number } => {
        if (!heji?.enabled) return { syn5: 0, sept7: 0 };
        const qs = note.getAttribute('data-q');
        const rs = note.getAttribute('data-r');
        if (qs === null || rs === null) return { syn5: 0, sept7: 0 };
        const q = parseInt(qs, 10), r = parseInt(rs, 10);
        if (!Number.isFinite(q) || !Number.isFinite(r)) return { syn5: 0, sept7: 0 };
        return hejiCommasFor(heji.mode, q, r);
      };

      for (const { note } of allNotes) {
        const pname = note.getAttribute('pname');
        const oct = note.getAttribute('oct');
        if (!pname || !oct) continue;
        const key = pname + ':' + oct;
        const alter = heji ? noteAlter(note) : getNoteAlter(note);
        const { syn5, sept7 } = commasOf(note);
        const id: AccidIdentity = { alter, syn5, sept7 };
        const expected: AccidIdentity = (key in local)
          ? local[key]
          : { alter: keyAlters[pname] ?? 0, syn5: 0, sept7: 0 };
        const tie = note.getAttribute('tie');
        const isTieDestination = tie === 't' || tie === 'm';

        /* Parenthetical-cautionary intent set by the `P` toggle. Force the
           accidental visible and let HEJI injection decorate it as usual;
           a post-render pass wraps the resulting glyphs in parens. Carry
           state still updates so subsequent same-pitch notes elide. */
        if (note.getAttribute('hkl-paren-caut') === 'true') {
          /* For paren-caut: ALWAYS use the (q, r)-derived alter. When the
             note's accid lives ONLY on a child <accid enclose="paren"> (the
             form we wrote on a previous pass), `getNoteAlter` returns 0
             because it reads @accid from the note attribute only — without
             this override the second round of computeAccidentalDisplay
             would write `accid="n"` (natural) instead of the original
             sharp/flat, breaking serialize→load→serialize equality. */
          const parenAlter = noteAlter(note);
          showAlterAsParenChild(note, parenAlter);
          local[key] = id;
          continue;
        }

        if (isTieDestination) {
          /* Hide (chain initiator already showed it); update carry. */
          hideAlter(note, alter);
          local[key] = id;
          continue;
        }

        if (identityEq(id, expected)) {
          hideAlter(note, alter);
        } else {
          showAlter(note, alter);
          local[key] = id;
        }
      }
    }
  }
}
