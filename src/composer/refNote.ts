// Compute the reference note (q, r) that drives HKL's 12-TET piano-input
// resolution. Broadcast over the bridge whenever it changes.
//
// Algorithm (per the user's design):
//   1. Walk backward through the current voice's flat children from the
//      cursor. If a <note> is found, return its (data-q, data-r).
//   2. If a <chord> is found, return the bass note's (q, r) — chord children
//      are sorted ascending by MIDI (model.ts maintains this invariant), so
//      the first <note> child is the bass.
//   3. If neither (empty voice before cursor), interpret the current key
//      signature as a major-key tonic and return the (q, r) on the lattice
//      whose noteName matches that tonic and is closest to (0, 0) by taxicab.

import type { ComposerModel } from './model.js';
import { keySigToTonic } from './accidentals.js';
import { noteName, parseNote, accToVal } from '../tuning/notes.js';

export interface RefCoord { q: number; r: number; }

/** Cache of "tonic name → closest-to-origin (q, r) by taxicab". The lattice
 *  is deterministic, so this is a one-time computation per process. */
const tonicCache: Map<string, RefCoord> = new Map();

/** Search a small bounded grid for the (q, r) where noteName(q, r) parses to
 *  the same letter and same alteration as the target tonic. */
function findTonicCoord(tonic: string): RefCoord {
  const cached = tonicCache.get(tonic);
  if (cached) return cached;
  const parsed = parseNote(tonic);
  const targetLetter = parsed.letter;
  const targetAlter = accToVal(parsed.acc);
  let bestQ = 0, bestR = 0;
  let bestTax = Infinity;
  /* Lattice scan: enharmonic-axis hop is (+7, -4), so all canonical tonics
     (≤ ±7 sharps/flats) sit well within this range. */
  for (let q = -5; q <= 5; q++) {
    for (let r = -10; r <= 10; r++) {
      const nm = noteName(q, r);
      const p = parseNote(nm);
      if (p.letter !== targetLetter) continue;
      if (accToVal(p.acc) !== targetAlter) continue;
      const tax = Math.abs(q) + Math.abs(r);
      if (tax < bestTax) {
        bestTax = tax;
        bestQ = q;
        bestR = r;
      }
    }
  }
  const found: RefCoord = { q: bestQ, r: bestR };
  tonicCache.set(tonic, found);
  return found;
}

/** Parse a note element's (data-q, data-r) attributes. Returns null when
 *  either is missing or non-numeric — defensive but should not happen for
 *  well-formed Composer documents. */
function noteCoord(note: Element): RefCoord | null {
  const q = note.getAttribute('data-q');
  const r = note.getAttribute('data-r');
  if (q === null || r === null) return null;
  const qn = parseInt(q, 10);
  const rn = parseInt(r, 10);
  if (!Number.isFinite(qn) || !Number.isFinite(rn)) return null;
  return { q: qn, r: rn };
}

/** The first <note> child of a <chord>. Chord children are sorted ascending
 *  by MIDI (chord re-sort invariant in model.ts), so this is the bass. */
function chordBass(chord: Element): Element | null {
  for (const ch of Array.from(chord.children)) {
    if (ch.localName === 'note') return ch;
  }
  return null;
}

/** Compute the reference note for the current voice + cursor + key sig. */
export function computeReferenceNote(model: ComposerModel): RefCoord {
  const voice = model.getCurrentVoice();
  const cursor = model.getCursor(voice);
  const flat = model.flatChildren(voice);
  /* Walk backward: under the cursor convention "cursor c means past flat[c]",
     flat[cursor] is the element to the cursor's LEFT — i.e., the most
     recent prior element. Past-end (cursor === flat.length) has no flat[c],
     so clamp the start to flat.length - 1. */
  const start = Math.min(cursor, flat.length - 1);
  for (let i = start; i >= 0; i--) {
    const e = flat[i];
    if (!e) continue;
    const ln = e.localName;
    if (ln === 'note') {
      const c = noteCoord(e);
      if (c) return c;
    } else if (ln === 'chord') {
      const bass = chordBass(e);
      if (bass) {
        const c = noteCoord(bass);
        if (c) return c;
      }
    }
    /* <measure> wrappers, <rest>, <space>, <tuplet> have no pitch — keep walking. */
  }
  /* Empty voice before cursor: fall back to major-key tonic of current sig. */
  const sig = model.getKeySig();
  const tonic = keySigToTonic(sig);
  return findTonicCoord(tonic);
}

/* Internal mutable last-broadcast snapshot — diff filter for noisy callers. */
const lastBroadcast: RefCoord = { q: NaN, r: NaN };

/** True iff the reference note differs from what was last broadcast. Resets
 *  the snapshot. Caller should send only when this returns true. */
export function refNoteChanged(coord: RefCoord): boolean {
  if (lastBroadcast.q === coord.q && lastBroadcast.r === coord.r) return false;
  lastBroadcast.q = coord.q;
  lastBroadcast.r = coord.r;
  return true;
}

/** Force the next refNoteChanged() check to broadcast (e.g., after a
 *  composer-hello / connection event). */
export function invalidateRefNoteCache(): void {
  lastBroadcast.q = NaN;
  lastBroadcast.r = NaN;
}

/* Re-export for callers that want the tonic helper without importing from
   accidentals directly. */
export { keySigToTonic };
