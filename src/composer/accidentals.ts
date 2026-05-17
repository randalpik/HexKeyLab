// Compute accidental display visibility per engraving convention.
//
// HKL emits an absolute pitch spelling on every note: a letter (@pname) plus
// an accidental token (@accid) drawn from {'', 's', 'f', 'ss', 'ff', 'n'},
// where '' means "no symbol drawn, natural in absolute pitch terms" and 'n'
// means "natural sign drawn, natural in absolute pitch terms". The two
// differ only in display, not in sounding pitch.
//
// Engraving rules:
//   1. Within a measure, an accidental at (pname, oct) carries forward across
//      ALL voices on the same staff. Subsequent notes at the same letter+
//      octave don't repeat it unless they DIFFER.
//   2. At a bar line, state resets to the key signature.
//   3. Tie destinations (@tie="t" or "m") never show an accidental — the
//      sound is implicit from the tied chain. BUT they DO update the
//      carry-state for subsequent notes at the same letter+octave.
//   4. An accidental matching the current implied pitch is hidden.
//   5. When a note differs from the implied pitch, the visible accidental
//      is determined by the absolute pitch: 's'/'f'/'ss'/'ff' draw the
//      symbol; a natural pitch when the implied is non-natural draws 'n'
//      (the natural sign to cancel).
//
// The pass mutates @accid / @accid.ges on the clone. The live doc keeps its
// original @accid values written by HKL.

const SHARP_ORDER: ReadonlyArray<string> = ['f', 'c', 'g', 'd', 'a', 'e', 'b'];
const FLAT_ORDER:  ReadonlyArray<string> = ['b', 'e', 'a', 'd', 'g', 'c', 'f'];

/** Decode a key signature attribute into a map of pitch letter → 's' | 'f'.
 *  '0' or unset → {}. '3s' → { f: 's', c: 's', g: 's' }. '2f' → { b: 'f', e: 'f' }. */
function keySigToAccids(sig: string): Record<string, 's' | 'f'> {
  const out: Record<string, 's' | 'f'> = {};
  if (!sig || sig === '0') return out;
  const n = parseInt(sig.slice(0, -1), 10);
  if (!Number.isFinite(n) || n <= 0) return out;
  const order = sig.endsWith('s') ? SHARP_ORDER : FLAT_ORDER;
  const accid: 's' | 'f' = sig.endsWith('s') ? 's' : 'f';
  for (let i = 0; i < Math.min(n, 7); i++) out[order[i]] = accid;
  return out;
}

/** Normalize an accidental token to its absolute-pitch representation.
 *  '' and 'n' both mean "natural" in pitch terms. */
function toAbsolute(written: string): string {
  if (written === '' || written === 'n') return '';
  return written;
}

/** Decide what @accid value (if any) to display, given the note's absolute
 *  pitch and the currently-implied pitch at its (letter, oct) position.
 *  Returns null when nothing should be displayed (note will sound at the
 *  implied pitch naturally). */
function neededDisplay(absolute: string, expected: string): string | null {
  if (absolute === expected) return null;
  if (absolute === '') return 'n'; /* natural sign cancels a sharp/flat */
  return absolute;
}

/** Apply a display decision to a note. */
function applyDecision(note: Element, written: string, display: string | null): void {
  if (display === null) {
    /* Hide any written accidental — keep gestural for the sound. */
    if (note.hasAttribute('accid')) {
      note.setAttribute('accid.ges', written);
      note.removeAttribute('accid');
    }
    return;
  }
  /* Display this accidental. */
  if (note.getAttribute('accid') === display) return; /* already correct */
  note.setAttribute('accid', display);
  /* If we just wrote a natural that cancels a written sharp/flat, the
     sounding pitch is natural — accid.ges should also reflect that or be
     absent. Verovio reads @accid as the sounded value too. */
  note.removeAttribute('accid.ges');
}

function elementDurationTicks(el: Element): number {
  const dur = el.getAttribute('dur');
  const dots = parseInt(el.getAttribute('dots') ?? '0', 10);
  const denom = dur ? parseInt(dur, 10) : NaN;
  if (!Number.isFinite(denom) || denom <= 0) return 16;
  const base = 64 / denom;
  if (dots === 1) return base * 1.5;
  if (dots === 2) return base * 1.75;
  return base;
}

/** Returns all <note> elements in a layer's content stream, paired with
 *  the start tick of their parent chord/note and the layer number. */
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
    }
  }
  return out;
}

/** Compute and write accidental display visibility for every note in the
 *  doc. Mutates @accid / @accid.ges on notes; does not change pitch.
 *  Walks one measure-staff at a time; resets state at each bar line. */
export function computeAccidentalDisplay(doc: Document, keySig: string): void {
  const keyAccids = keySigToAccids(keySig);

  const measures = doc.querySelectorAll('measure');
  for (const measure of Array.from(measures)) {
    for (const staffN of [1, 2]) {
      const staff = Array.from(measure.querySelectorAll('staff'))
        .find((s) => s.getAttribute('n') === String(staffN));
      if (!staff) continue;
      const layers = Array.from(staff.querySelectorAll('layer'));
      const allNotes: Array<{ note: Element; startTick: number; layerN: number }> = [];
      for (const layer of layers) allNotes.push(...notesInLayer(layer));
      /* Sort by startTick ascending, breaking ties by layer (1 wins so its
         accidental sets state for voice 2 at the same beat). */
      allNotes.sort((a, b) =>
        a.startTick !== b.startTick ? a.startTick - b.startTick : a.layerN - b.layerN);

      /* (pname:oct) → absolute accidental currently in effect for this
         measure-staff. Initial: empty (means "default to key sig"). */
      const local: Record<string, string> = {};

      for (const { note } of allNotes) {
        const pname = note.getAttribute('pname');
        const oct = note.getAttribute('oct');
        if (!pname || !oct) continue;
        const key = pname + ':' + oct;

        const written = note.getAttribute('accid') ?? '';
        const absolute = toAbsolute(written);
        const expected = (key in local) ? local[key] : (keyAccids[pname] ?? '');
        const tie = note.getAttribute('tie');
        const isTieDestination = tie === 't' || tie === 'm';

        if (isTieDestination) {
          /* Hide the accidental — chain initiator already showed it. But
             DO update the carry state: a tie destination IS sounding at
             the carried pitch, and subsequent notes need to know. */
          applyDecision(note, written, null);
          local[key] = absolute;
          continue;
        }

        const display = neededDisplay(absolute, expected);
        applyDecision(note, written, display);
        /* Update carry state to reflect the absolute pitch (whether
           visually displayed or not). */
        local[key] = absolute;
      }
    }
  }
}
