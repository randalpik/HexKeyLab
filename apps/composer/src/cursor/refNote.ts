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
import { fifthName } from '@hkl/shared/notes.js';
import { coordToMidi } from '@hkl/shared/freq.js';

export interface RefCoord { q: number; r: number; }

/** tonic → r on the qm=0 spine (fifth-chain from A). Derived once from
 *  fifthName() so the table stays in sync with the lattice naming algorithm.
 *  Major tonics span r ∈ [-10, 4] (C♭ … C♯); relative-minor tonics shift up by
 *  three fifths, so a♭…a♯ spans r ∈ [-7, 7]. The combined range is [-10, 7]. */
const TONIC_R: Map<string, number> = (() => {
  const m = new Map<string, number>();
  for (let r = -10; r <= 7; r++) m.set(fifthName(r), r);
  return m;
})();

const tonicCache: Map<string, RefCoord> = new Map();

/** Place the song-key tonic on the qm=0 spine at the lowest octave whose MIDI
 *  is at-or-above F3 (53). The spine *is* the fifth-chain, so r is fixed by
 *  tonic identity. Walk q by ±3 (one octave per step) into the window
 *  [53, 64]. Floors the broadcast ref so Composer never drags HKL's piano
 *  outline below F3 (e.g. C3 = MIDI 48 used to sneak through). */
function findTonicCoord(tonic: string): RefCoord {
  const cached = tonicCache.get(tonic);
  if (cached) return cached;
  const r = TONIC_R.get(tonic) ?? -3; /* fall back to C-spine coord if somehow off-table */
  let q = 0;
  while (coordToMidi(q, r) < 53) q += 3;
  while (coordToMidi(q, r) >= 65) q -= 3;
  const found: RefCoord = { q, r };
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

/** Tonic of the current key signature, as a lattice coord. Resolves to the
 *  major or relative-minor tonic based on model.getKeyMode(). Used to populate
 *  HKL's song-key tier. */
export function computeSongKeyRef(model: ComposerModel): RefCoord {
  const sig = model.getKeySig();
  const mode = model.getKeyMode();
  const tonic = keySigToTonic(sig, mode);
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
