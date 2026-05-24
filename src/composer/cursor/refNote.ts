// Compute the reference-note coordinates Composer publishes to HKL.
//
// The previous single-message protocol entangled two facts: the most-recent-
// prior-note in the cursor's voice (cursor-dependent) AND the song's key-sig
// tonic (a global fallback). HKL now tracks them as separate tiers — see
// src/state/reference.ts — so Composer publishes them as two messages,
// `set-reference-note` (selection tier) and `set-song-key` (song-key tier).
//
// Composer is purely additive: it broadcasts only when it has a fresh fact
// to publish. When the cursor's voice has no prior note, Composer stays
// silent rather than sending a "clear" — otherwise an unrelated trigger
// (e.g. a key-sig change firing the broadcast cycle) would blow away a
// manual Ctrl+click selection the user just made on HKL.

import type { ComposerModel } from '../model/index.js';
import { keySigToTonic } from '../notation/accidentals.js';
import { noteName, parseNote, accToVal } from '../../tuning/notes.js';

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

/** Find the most-recent-prior-to-cursor note in the current voice. Returns
 *  null if the voice has no prior note (cursor at start, or empty voice).
 *  Composer's call site sends `set-reference-note` only when this is
 *  non-null — see module header for why. */
export function computePrevNoteRef(model: ComposerModel): RefCoord | null {
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
  return null;
}

/** Major-key tonic of the current key signature, as a lattice coord. Used
 *  to populate HKL's song-key tier. */
export function computeSongKeyRef(model: ComposerModel): RefCoord {
  const sig = model.getKeySig();
  const tonic = keySigToTonic(sig);
  return findTonicCoord(tonic);
}

/* ── diff filters: skip redundant broadcasts of unchanged values ─────────── */

const lastRefBroadcast: RefCoord | null & { q?: number; r?: number } = { q: NaN, r: NaN } as RefCoord;
let lastRefWasNull = true;

/** Returns true iff `coord` differs from what was last broadcast for the
 *  reference-note (selection-tier) channel. Updates the snapshot. Passing
 *  null indicates "no prior note to publish"; never returns true for null
 *  (Composer doesn't broadcast a clear — see module header). */
export function refNoteChanged(coord: RefCoord | null): boolean {
  if (coord === null) {
    /* Mark that we currently have nothing to publish. Next non-null coord
       must broadcast even if it equals the previously broadcast value,
       because HKL's selection tier may have been cleared by a Ctrl+click
       in between. */
    lastRefWasNull = true;
    return false;
  }
  if (!lastRefWasNull && lastRefBroadcast.q === coord.q && lastRefBroadcast.r === coord.r) {
    return false;
  }
  lastRefBroadcast.q = coord.q;
  lastRefBroadcast.r = coord.r;
  lastRefWasNull = false;
  return true;
}

/** Force the next refNoteChanged() check to broadcast (e.g., after a
 *  composer-hello / connection event). */
export function invalidateRefNoteCache(): void {
  lastRefBroadcast.q = NaN;
  lastRefBroadcast.r = NaN;
  lastRefWasNull = true;
}

const lastSongKey: RefCoord = { q: NaN, r: NaN };

/** Returns true iff `coord` differs from the last-broadcast song-key.
 *  Updates the snapshot. */
export function songKeyChanged(coord: RefCoord): boolean {
  if (lastSongKey.q === coord.q && lastSongKey.r === coord.r) return false;
  lastSongKey.q = coord.q;
  lastSongKey.r = coord.r;
  return true;
}

/** Force the next songKeyChanged() check to broadcast. */
export function invalidateSongKeyCache(): void {
  lastSongKey.q = NaN;
  lastSongKey.r = NaN;
}

/* Re-export for callers that want the tonic helper without importing from
   accidentals directly. */
export { keySigToTonic };
