// SC transposition for a single note — either a chord-child note OR a bare
// `<note>`. "SC" = enharmonic-axis hop ±(7, −4) in lattice (q, r), which
// preserves 12-TET pitch class but changes the lattice cell (and usually
// the spelling). Always changes the note's lattice color/hue; sometimes
// changes letter + accidental.
//
// Blocked when the resulting spelling would need ≥ 4 accidentals (a
// quadruple sharp / flat) — Verovio can't render those legibly.
//
// Chord-child: after mutation, the chord's note children are re-sorted
// ascending by MIDI to preserve the chord-sort invariant. The selected
// note's xml:id stays stable (sel.noteId still points at the same element).
// Bare note: no resort needed.

import type { ComposerModel, Voice } from '../model/index.js';
import type { InputHooks, ChordInternalSel } from '../input.js';
import type { CoordRef } from '@hkl/bridge/protocol.js';
import { noteName, parseNote, accToVal, keyOctave } from '@hkl/shared/notes.js';
import { tokenFromAlter } from '@hkl/notation/accidentals.js';
import { coordToMidi } from '@hkl/shared/freq.js';
import { realTicks } from '../model/ticks.js';

/** Cached HKL footprint passed in from main.ts. Keys are "q,r"; values are
 *  the fresh per-cell color. `null` means "no footprint cached yet" — no
 *  constraint enforced, no color update. Empty Map means HKL's outline is
 *  'none' — also no constraint, no color update. */
export type FootprintColorMap = Map<string, string> | null;

/** Outcome of an SC-transpose attempt. */
export interface SCResult {
  ok: boolean;
  /** When ok, notes sounding at the (post-shift) chord's start moment across
   *  all voices — for a one-shot playback preview that lets the user hear how
   *  the shift changed the tuning. Empty when !ok. */
  previewNotes: ReadonlyArray<CoordRef>;
  /** When ok, the chord's own sounding duration in ticks (caller multiplies
   *  by tickMs to get a sensible preview event length). */
  previewTicks: number;
}

function chordNotes(chord: Element): Element[] {
  const out: Element[] = [];
  for (const c of Array.from(chord.children)) {
    if (c.localName === 'note') out.push(c);
  }
  return out;
}

/** Locate the `<note>` element with `noteId` in `voice`'s flat stream
 *  (whether bare or inside a `<chord>`). Returns null when missing. */
function findNoteById(model: ComposerModel, voice: Voice, noteId: string): Element | null {
  const flat = model.flatChildren(voice);
  for (const el of flat) {
    if (el.localName === 'note' && el.getAttribute('xml:id') === noteId) return el;
    if (el.localName === 'chord') {
      for (const c of Array.from(el.children)) {
        if (c.localName === 'note' && c.getAttribute('xml:id') === noteId) return c;
      }
    }
  }
  return null;
}

function noteCoord(note: Element): { q: number; r: number } | null {
  const q = parseInt(note.getAttribute('data-q') ?? '', 10);
  const r = parseInt(note.getAttribute('data-r') ?? '', 10);
  if (!Number.isFinite(q) || !Number.isFinite(r)) return null;
  return { q, r };
}

function noteMidiSortKey(note: Element): number {
  const c = noteCoord(note);
  if (!c) return 0;
  return coordToMidi(c.q, c.r);
}

/** Find the flat-index of `target` (a top-level element) in `voice`. Returns
 *  -1 when not found. */
function findFlatIdx(model: ComposerModel, voice: Voice, target: Element): number {
  const flat = model.flatChildren(voice);
  for (let i = 0; i < flat.length; i++) {
    if (flat[i] === target) return i;
  }
  return -1;
}

/** Walk every voice's flat content; collect (q, r) for any note or chord
 *  whose sounding range [start, start+realTicks) contains `atTick`. This
 *  captures the full vertical slice at `atTick` — notes that begin at that
 *  moment AND notes from earlier in any voice that are still sustaining. */
function gatherSoundingAt(model: ComposerModel, atTick: number): CoordRef[] {
  const out: CoordRef[] = [];
  const EPS = 1e-6;
  for (let v: Voice = 1; v <= 4; v = (v + 1) as Voice) {
    const flat = model.flatChildren(v);
    for (let c = 0; c < flat.length; c++) {
      const elem = flat[c];
      if (elem.localName !== 'note' && elem.localName !== 'chord') continue;
      /* Start of flat[c] = tick at cursor c-1 (cursor c is past flat[c]).
         flat[0] is always the M_1 wrapper (realTicks=0); real notes/chords
         are always at c >= 1. */
      const startTick = c === 0 ? 0 : model.getTickPositionAt(v, c - 1);
      const dur = realTicks(elem);
      if (startTick <= atTick + EPS && atTick + EPS < startTick + dur) {
        if (elem.localName === 'note') {
          const coord = noteCoord(elem);
          if (coord) out.push(coord);
        } else {
          for (const n of Array.from(elem.children)) {
            if (n.localName !== 'note') continue;
            const coord = noteCoord(n);
            if (coord) out.push(coord);
          }
        }
      }
    }
    if (v === 4) break;
  }
  return out;
}

const FAILED_SC: SCResult = { ok: false, previewNotes: [], previewTicks: 0 };

/** Apply enharmonic-axis hop (±(7, −4)) to the note identified by sel.noteId.
 *  Handles both chord-child notes (parent is `<chord>`) and bare notes
 *  (parent is `<layer>`). On success, also collects the post-shift vertical
 *  slice (every note from every voice that's sounding at the element's start
 *  tick) for the caller to feed into a one-shot playback preview. Blocked
 *  by quadruple-accidental clamp, by the layout-outline constraint (when a
 *  non-empty footprint is passed), or by a missing target. */
export function scTransposeChordNote(
  model: ComposerModel,
  hooks: InputHooks,
  sel: ChordInternalSel,
  dir: 1 | -1,
  footprint: FootprintColorMap,
): SCResult {
  const note = findNoteById(model, sel.voice, sel.noteId);
  if (!note) {
    hooks.setStatus?.('Selected note no longer exists.', 'error');
    return FAILED_SC;
  }
  const oldCoord = noteCoord(note);
  if (!oldCoord) {
    hooks.setStatus?.('Note missing lattice coordinates.', 'error');
    return FAILED_SC;
  }
  const newQ = oldCoord.q + 7 * dir;
  const newR = oldCoord.r - 4 * dir;
  const newKey = newQ + ',' + newR;
  /* Layout-outline constraint: when HKL has broadcast a non-empty footprint,
     reject SC shifts that would land outside it. Empty footprint or null
     (= outline 'none' or pre-handshake) → no constraint. */
  if (footprint && footprint.size > 0 && !footprint.has(newKey)) {
    hooks.setStatus?.('SC blocked — target (' + newQ + ',' + newR + ') outside HKL layout outline.', 'error');
    return FAILED_SC;
  }
  const newName = noteName(newQ, newR);
  const parsed = parseNote(newName);
  const alter = accToVal(parsed.acc);
  const oct = keyOctave(newQ, newR);
  /* @accid is a display cache only (clamped to a valid MEI token); (newQ, newR)
     is the source of truth and the render pipeline stacks accidentals beyond
     ±3 from it (heji-render.ts). */
  const accidStr = tokenFromAlter(alter) ?? '';
  /* Apply pitch + color attributes. The chord's @dur / @dots / @tie remain
     on the chord wrapper or per-note; we touch only spelling + lattice +
     color attrs. Color update is critical: HKL's notehead color is derived
     from (q, r) via darkColorHex — without rewriting @color, the rendered
     notehead stays the old hue and visibly desyncs from the new pitch. */
  note.setAttribute('data-q', String(newQ));
  note.setAttribute('data-r', String(newR));
  note.setAttribute('pname', parsed.letter.toLowerCase());
  note.setAttribute('oct', String(oct));
  note.removeAttribute('accid.ges');
  if (accidStr) note.setAttribute('accid', accidStr);
  else note.removeAttribute('accid');
  const newColor = footprint?.get(newKey);
  if (newColor) note.setAttribute('color', newColor);

  /* Re-sort the parent chord's children by MIDI ascending (chord-sort
     invariant). Skipped for bare notes (only one note in the layer). The
     note's xml:id is stable — sel.noteId still points at the same element. */
  const parent = note.parentElement;
  const isInChord = parent?.localName === 'chord';
  const startElement = isInChord ? parent! : note;
  if (isInChord) {
    const chord = parent!;
    const before = chordNotes(chord);
    const after = before.slice().sort((a, b) => noteMidiSortKey(a) - noteMidiSortKey(b));
    /* Re-append in sorted order. The chord may have non-<note> children
       (verse/syl/lyric tags etc.) — preserve them in original order at the
       end. */
    const nonNotes = Array.from(chord.children).filter((c) => c.localName !== 'note');
    for (const n of before) chord.removeChild(n);
    for (const n of after) chord.appendChild(n);
    for (const o of nonNotes) chord.appendChild(o);
  }

  /* Gather the post-shift vertical slice for an audible preview. Use the
     element's start tick (cursor at flatIdx - 1 == past it). For a bare note
     the element IS the note; for a chord child it's the chord wrapper. */
  const elemIdx = findFlatIdx(model, sel.voice, startElement);
  let startTick = 0;
  if (elemIdx > 0) startTick = model.getTickPositionAt(sel.voice, elemIdx - 1);
  const previewNotes = gatherSoundingAt(model, startTick);
  const previewTicks = realTicks(startElement);
  return { ok: true, previewNotes, previewTicks };
}
