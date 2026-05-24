/* Element builders + extractors for MEI notes, chords, rests, and tuplet
 * placeholders. Pure functions: take `doc` as input, return a freshly built
 * Element (no model state mutation). Counterparts: `extract*` and
 * `elementHasTie*` read from existing elements. */

import type { ResolvedNote } from '../../bridge/protocol.js';
import { tokenFromAlter, alterFromCount, getNoteAlter } from '../notation/accidentals.js';
import {
  el,
  newId,
  TUPLET_PLACEHOLDER_ATTR,
  ticksOf,
  decomposeTicks,
  type ChordInput,
  type RestInput,
  type Duration,
  type Dots,
} from './index.js';

export function buildChordElement(doc: Document, input: ChordInput): Element {
  const dur = input.duration;
  const dots = input.dots ?? 0;
  if (input.notes.length === 1) {
    return buildNoteElement(doc, input.notes[0], dur, dots);
  }
  const chord = el(doc, 'chord', {
    'xml:id': newId('c'),
    dur,
    dots: dots > 0 ? dots : undefined,
  });
  const sorted = [...input.notes].sort((a, b) => a.midi - b.midi);
  for (const n of sorted) {
    chord.appendChild(buildNoteElement(doc, n, dur, dots, /* inChord */ true));
  }
  return chord;
}

export function buildNoteElement(
  doc: Document,
  n: ResolvedNote,
  dur: Duration,
  dots: Dots,
  inChord = false,
): Element {
  const attrs: Record<string, string | number | undefined> = {
    'xml:id': newId('n'),
    pname: n.pname,
    oct: n.oct,
    color: n.colorHex,
    'data-q': n.q,
    'data-r': n.r,
  };
  if (!inChord) {
    attrs.dur = dur;
    if (dots > 0) attrs.dots = dots;
  }
  /* Accidental: emit a single canonical MEI token (s/f/x/ff/ts/tf or
     'n' for explicit natural). HKL count-form string is parsed to an
     integer alter; values outside ±3 should never arrive here (entry
     path filters them) but we clamp to ±3 defensively just in case. */
  if (n.accid === 'n') {
    attrs.accid = 'n';
  } else {
    const token = tokenFromAlter(alterFromCount(n.accid));
    if (token) attrs.accid = token;
  }
  return el(doc, 'note', attrs);
}

export function buildRestElement(doc: Document, input: RestInput): Element {
  return el(doc, 'rest', {
    'xml:id': newId('r'),
    dur: input.duration,
    dots: input.dots && input.dots > 0 ? input.dots : undefined,
  });
}

/** Build a single tuplet-internal placeholder: a `<rest>` with the
 *  `data-tuplet-placeholder="true"` marker. Verovio draws the bracket
 *  over these (because rests count as content) but renders the rest
 *  glyph too. We hide that glyph in CSS via the data attribute (which is
 *  propagated to the SVG by `svgAdditionalAttribute` in render.ts).
 *  MEI's @visible="false" would be the spec-correct way, but Verovio
 *  doesn't honor it on rests (rism-digital/verovio#202, still open). */
export function buildTupletPlaceholder(
  doc: Document,
  dur: Duration,
  dots: Dots = 0,
): Element {
  const sp = el(doc, 'rest', {
    'xml:id': newId('sp'),
    dur,
    dots: dots > 0 ? dots : undefined,
  });
  sp.setAttribute(TUPLET_PLACEHOLDER_ATTR, 'true');
  return sp;
}

/** Regenerate the trailing placeholders of a tuplet to cover
 *  `remainingTicks` written ticks. Prefers N atomic-sized rests (per the
 *  tuplet's recorded `data-tuplet-atomic-dur`) so that fill+delete is
 *  perfectly reversible; falls back to `decomposeTicks` for any awkward
 *  leftover (e.g. a written-dotted-8th inserted into a triplet-of-8ths
 *  leaves 4 of 12 ticks not divisible by atomic). Returns built elements
 *  for the caller to append. */
export function regenTupletPlaceholders(
  doc: Document,
  tuplet: Element,
  remainingTicks: number,
): Element[] {
  const out: Element[] = [];
  if (remainingTicks <= 0) return out;
  const atomicDurStr = tuplet.getAttribute('data-tuplet-atomic-dur') as Duration | null;
  let r = remainingTicks;
  if (atomicDurStr) {
    const atomicTicks = ticksOf(atomicDurStr, 0);
    while (r >= atomicTicks) {
      out.push(buildTupletPlaceholder(doc, atomicDurStr, 0));
      r -= atomicTicks;
    }
  }
  if (r > 0) {
    for (const p of decomposeTicks(r)) {
      out.push(buildTupletPlaceholder(doc, p.dur, p.dots));
    }
  }
  return out;
}

export function extractNoteElements(elem: Element): Element[] {
  if (elem.localName === 'note') return [elem];
  if (elem.localName === 'chord') {
    return Array.from(elem.children).filter((c) => c.localName === 'note');
  }
  return [];
}

export function extractResolvedFromElement(elem: Element): ResolvedNote[] {
  const noteEls = extractNoteElements(elem);
  return noteEls.map((n) => {
    const q = parseInt(n.getAttribute('data-q') ?? '0', 10);
    const r = parseInt(n.getAttribute('data-r') ?? '0', 10);
    const pname = (n.getAttribute('pname') ?? 'c') as ResolvedNote['pname'];
    /* Reconstruct the count-form accidental string from whatever form the
       note carries (@accid attr, @accid.ges, or <accid> children). */
    const alter = getNoteAlter(n);
    const accid = alter === 0 ? '' : (alter > 0 ? 's' : 'f').repeat(Math.abs(alter));
    const oct = parseInt(n.getAttribute('oct') ?? '4', 10);
    const colorHex = n.getAttribute('color') ?? '#000000';
    /* MIDI is not used by buildChordElement except for sort order; reconstruct
       from coords: midi = 57 + 4q + 7r. */
    const midi = 57 + 4 * q + 7 * r;
    return { q, r, pname, accid, oct, midi, colorHex, velocity: 80 };
  });
}

/** True when any inner note has an outgoing tie ('i' or 'm'). */
export function elementHasTieInitial(elem: Element): boolean {
  const notes = extractNoteElements(elem);
  return notes.some((n) => {
    const t = n.getAttribute('tie');
    return t === 'i' || t === 'm';
  });
}

/** True when any inner note has an incoming tie ('t' or 'm'). */
export function elementHasTieTerminal(elem: Element): boolean {
  const notes = extractNoteElements(elem);
  return notes.some((n) => {
    const t = n.getAttribute('tie');
    return t === 't' || t === 'm';
  });
}
