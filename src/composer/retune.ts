// Retune existing score content when the user changes the score's required
// tuning mode in Setup. Frequency is the invariant: each note's old freq
// (computed under the previous tuning mode at its (q, r)) is preserved as
// closely as possible by relocating the note to a different (q, r) under
// the new mode.
//
// Search procedure per note:
//   - Search space: lattice cells (q, r) such that coordToMidi(q, r) is in
//     the playable MIDI range [21, 108]. Practically bounded by a radius
//     around the original (q, r); cells outside the radius are guaranteed
//     to be octaves away — never optimal.
//   - Score: |1200 · log2(newFreq / oldFreq)| cents.
//   - Tiebreak: taxicab distance |Δq| + |Δr| from the original (q, r), so
//     octave / SC-equivalent matches stay in the original neighborhood.
//
// Edge cases:
//   - Chord collapse: two notes in the same <chord> retune to the same
//     (q, r). The lower-MIDI one (in the OLD mode) survives; the higher
//     is dropped. Dropped count is reported in the plan.
//   - Tie partner of a dropped note: data-tie-partner reference is cleared;
//     @tie="i" loses its endpoint and is removed; @tie="m" downgrades to "t".

import type { ComposerModel } from './model.js';
import { freqAt, coordToMidi, MIDI_LOW, MIDI_HIGH, type TuningMode } from '../shared/freq.js';
import { noteName, parseNote, accToVal, keyOctave } from '../tuning/notes.js';

export interface RetuneNoteEntry {
  noteEl: Element;
  oldQ: number;
  oldR: number;
  newQ: number;
  newR: number;
  /** Absolute cents deviation between old freq and new freq. 0 = exact match. */
  cents: number;
  /** True iff this note will be dropped due to a chord-internal collision
   *  with a same-target sibling. */
  drop: boolean;
}

export interface RetunePlan {
  fromMode: TuningMode;
  toMode: TuningMode;
  notes: ReadonlyArray<RetuneNoteEntry>;
  /** Notes within 0.001¢ of their original frequency. */
  exactCount: number;
  /** Worst-case cents deviation across all (non-dropped) notes. */
  maxCents: number;
  /** Number of notes dropped due to chord collapse. */
  dropCount: number;
}

const CENTS_EPS = 0.001;
/** Search window around each note's original (q, r). 15 covers ≥7 octaves
 *  worth of relocation plus a generous spelling neighborhood — enough to find
 *  any exact match that exists, and any reasonable approximation otherwise. */
const SEARCH_RADIUS = 15;

/** Compute the retune plan for changing this document's tuning mode. Pure
 *  inspection — does not mutate the doc. */
export function planRetune(doc: Document, fromMode: TuningMode, toMode: TuningMode): RetunePlan {
  const noteEls = Array.from(doc.querySelectorAll('note'));
  const entries: RetuneNoteEntry[] = [];
  let exactCount = 0;
  let maxCents = 0;

  for (const noteEl of noteEls) {
    const qStr = noteEl.getAttribute('data-q');
    const rStr = noteEl.getAttribute('data-r');
    if (qStr === null || rStr === null) continue;
    const oldQ = parseInt(qStr, 10);
    const oldR = parseInt(rStr, 10);
    if (!Number.isFinite(oldQ) || !Number.isFinite(oldR)) continue;
    const oldFreq = freqAt(oldQ, oldR, fromMode);
    const best = findBestCell(oldQ, oldR, oldFreq, toMode);
    if (best.cents <= CENTS_EPS) exactCount++;
    if (best.cents > maxCents) maxCents = best.cents;
    entries.push({
      noteEl, oldQ, oldR, newQ: best.q, newR: best.r,
      cents: best.cents, drop: false,
    });
  }

  /* Chord collapse detection — group entries by their containing <chord> and
     mark all-but-the-lowest-original-MIDI dupes for drop. Top-level <note>s
     (single-note "chords") never collapse with each other. */
  const byChord = new Map<Element, RetuneNoteEntry[]>();
  for (const e of entries) {
    const parent = e.noteEl.parentElement;
    if (!parent || parent.localName !== 'chord') continue;
    const arr = byChord.get(parent);
    if (arr) arr.push(e);
    else byChord.set(parent, [e]);
  }
  let dropCount = 0;
  for (const arr of byChord.values()) {
    const sorted = arr.slice().sort(
      (a, b) => coordToMidi(a.oldQ, a.oldR) - coordToMidi(b.oldQ, b.oldR),
    );
    const seen = new Set<string>();
    for (const e of sorted) {
      const key = e.newQ + ',' + e.newR;
      if (seen.has(key)) {
        e.drop = true;
        dropCount++;
      } else {
        seen.add(key);
      }
    }
  }

  return { fromMode, toMode, notes: entries, exactCount, maxCents, dropCount };
}

interface Candidate { q: number; r: number; cents: number; taxi: number }

function findBestCell(origQ: number, origR: number, origFreq: number, newMode: TuningMode): Candidate {
  let best: Candidate = { q: origQ, r: origR, cents: Infinity, taxi: Infinity };
  for (let dq = -SEARCH_RADIUS; dq <= SEARCH_RADIUS; dq++) {
    for (let dr = -SEARCH_RADIUS; dr <= SEARCH_RADIUS; dr++) {
      const q = origQ + dq;
      const r = origR + dr;
      const midi = coordToMidi(q, r);
      if (midi < MIDI_LOW || midi > MIDI_HIGH) continue;
      const f = freqAt(q, r, newMode);
      const cents = Math.abs(1200 * Math.log2(f / origFreq));
      const taxi = Math.abs(dq) + Math.abs(dr);
      const delta = best.cents - cents;
      if (delta > CENTS_EPS || (Math.abs(delta) <= CENTS_EPS && taxi < best.taxi)) {
        best = { q, r, cents, taxi };
      }
    }
  }
  return best;
}

/** Build a human-readable summary of the plan for the confirmation prompt. */
export function summarizePlan(plan: RetunePlan): string {
  const total = plan.notes.length;
  const moved = total - plan.exactCount;
  const lines: string[] = [];
  lines.push(`Changing tuning from "${labelForMode(plan.fromMode)}" to "${labelForMode(plan.toMode)}" will retune ${total} note${total === 1 ? '' : 's'}.`);
  if (plan.exactCount > 0) {
    lines.push(`  ${plan.exactCount} exact match${plan.exactCount === 1 ? '' : 'es'} (no pitch change).`);
  }
  if (moved > 0) {
    lines.push(`  ${moved} relocated to nearest available pitch (max deviation: ${plan.maxCents.toFixed(1)}¢).`);
  }
  if (plan.dropCount > 0) {
    lines.push(`  ${plan.dropCount} note${plan.dropCount === 1 ? '' : 's'} dropped due to chord collision.`);
  }
  lines.push('');
  lines.push('Proceed?');
  return lines.join('\n');
}

const MODE_LABELS: Record<TuningMode, string> = {
  E: 'Equal',
  '5': 'Ptolemaic',
  P: 'Pythagorean',
  D: 'Semiditonal',
  '7': 'Septimal',
};

function labelForMode(m: TuningMode): string {
  return MODE_LABELS[m];
}

/** Apply the plan to the model in-place. Rewrites lattice attrs for non-dropped
 *  notes, removes dropped notes (with tie-reference cleanup), and re-sorts any
 *  affected chord's notes by MIDI ascending. */
export function applyRetune(model: ComposerModel, plan: RetunePlan): void {
  const doc = model.getDoc();
  const affectedChords = new Set<Element>();

  /* Pass 1: rewrite kept notes. */
  for (const e of plan.notes) {
    if (e.drop) continue;
    const parent = e.noteEl.parentElement;
    if (parent && parent.localName === 'chord') affectedChords.add(parent);
    rewriteNoteCoord(e.noteEl, e.newQ, e.newR);
  }

  /* Pass 2: remove dropped notes + clean up tie references that pointed at
     them. Done after Pass 1 so the rewritten siblings carry their new attrs
     before any tie-partner downgrade re-reads them. */
  for (const e of plan.notes) {
    if (!e.drop) continue;
    const parent = e.noteEl.parentElement;
    if (parent && parent.localName === 'chord') affectedChords.add(parent);
    cleanupTieReferences(doc, e.noteEl);
    e.noteEl.parentNode?.removeChild(e.noteEl);
  }

  /* Pass 3: sort each affected chord's notes ascending by MIDI under the
     new lattice. Sibling order matters for chord-internal cursor selection
     and for accidentals.ts's left-to-right rendering. */
  for (const chord of affectedChords) sortChordNotes(chord);
}

function rewriteNoteCoord(note: Element, q: number, r: number): void {
  note.setAttribute('data-q', String(q));
  note.setAttribute('data-r', String(r));
  const name = noteName(q, r);
  const parsed = parseNote(name);
  const alter = accToVal(parsed.acc);
  const oct = keyOctave(q, r);
  note.setAttribute('pname', parsed.letter.toLowerCase());
  note.setAttribute('oct', String(oct));
  note.removeAttribute('accid.ges');
  if (alter === 0) {
    note.removeAttribute('accid');
  } else {
    /* Clamp to ±3 to match the codebase's accidental convention (Verovio
       overlaps multiple <accid> children — see model.ts replaceDocument
       migration). The pitch is still correct; only display is clamped. */
    const sign = alter > 0 ? 's' : 'f';
    const count = Math.min(3, Math.abs(alter));
    note.setAttribute('accid', sign.repeat(count));
  }
  /* Color is footprint-derived and gets recomputed downstream via the next
     footprint-changed broadcast from HKL. Leave the existing @color in place;
     it'll be overwritten by the post-retune layout sync. */
}

function sortChordNotes(chord: Element): void {
  const notes = Array.from(chord.children).filter((c) => c.localName === 'note');
  if (notes.length < 2) return;
  const nonNotes = Array.from(chord.children).filter((c) => c.localName !== 'note');
  const sorted = notes.slice().sort((a, b) => {
    const aq = parseInt(a.getAttribute('data-q') ?? '0', 10);
    const ar = parseInt(a.getAttribute('data-r') ?? '0', 10);
    const bq = parseInt(b.getAttribute('data-q') ?? '0', 10);
    const br = parseInt(b.getAttribute('data-r') ?? '0', 10);
    return coordToMidi(aq, ar) - coordToMidi(bq, br);
  });
  for (const n of notes) chord.removeChild(n);
  for (const n of sorted) chord.appendChild(n);
  for (const o of nonNotes) chord.appendChild(o);
}

function cleanupTieReferences(doc: Document, removedNote: Element): void {
  const id = removedNote.getAttribute('xml:id');
  if (!id) return;
  for (const n of Array.from(doc.querySelectorAll('note'))) {
    if (n.getAttribute('data-tie-partner') !== id) continue;
    n.removeAttribute('data-tie-partner');
    /* The partner pointed at the removed note as its outgoing target. Update
       @tie accordingly: 'i' (start) → drop entirely (its target is gone);
       'm' (middle) → downgrade to 't' (end of an existing tie chain). */
    const tie = n.getAttribute('tie');
    if (tie === 'i') n.removeAttribute('tie');
    else if (tie === 'm') n.setAttribute('tie', 't');
  }
}
