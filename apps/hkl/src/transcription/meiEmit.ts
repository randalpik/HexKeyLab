// MEI (.hkc) emission. Builds a grand-staff Composer-native document from the
// voiced score: treble → staff 1 / layer 1, bass → staff 2 / layer 1 (layer 2
// of each staff is left empty; Composer fills measure-width placeholders on
// load). Noteheads carry data-q/data-r lattice identity + a pre-darkened color,
// spelled via the same shared chain Composer's buildNoteElement uses.
//
// The head / hkl:config / scoreDef skeleton and the note/chord/rest builders
// come from @hkl/notation/mei-build — the single source of truth for the .hkc
// dialect, shared with Composer's model.
//
// Ties: a sustained note split across atoms (within a QNote, or across a
// bar-line where quantize marks the previous QNote's trailing atom tied) becomes
// an MEI @tie chain (i / m / t) on each note. data-tie-partner is left for
// Composer's normalizeTies, which runs on load via replaceDocument.

import type { VoicedScore, QNote, Meter, TempoEstimate } from './types.js';
import type { LayoutSnapshot } from '../recording/types.js';
import {
  el,
  newId,
  buildNoteElement,
  buildChordElement,
  buildRestElement,
  buildScoreSkeletonXml,
  type NoteSpec,
  type Duration,
  type Dots,
} from '@hkl/notation/mei-build.js';
import { noteName, keyOctave, parseNote, accToVal } from '@hkl/shared/notes.js';
import { coordToMidi } from '@hkl/shared/freq.js';

export interface EmitMeiOpts {
  title: string;
  numerator: number;
}

/** Spell a lattice cell into a NoteSpec, mirroring Composer's buildNoteElement
 *  input (count-form accidental of any magnitude — Composer collapses to the
 *  right glyph stack). */
function noteSpecFromCoord(q: number, r: number, colorHex: string): NoteSpec {
  const parsed = parseNote(noteName(q, r));
  const alter = accToVal(parsed.acc);
  const accid = alter === 0 ? '' : (alter > 0 ? 's' : 'f').repeat(Math.abs(alter));
  return {
    q,
    r,
    pname: parsed.letter.toLowerCase() as NoteSpec['pname'],
    accid,
    oct: keyOctave(q, r),
    midi: coordToMidi(q, r),
    colorHex,
  };
}

/** Apply an MEI tie token to a note or to every inner note of a chord. */
function setTie(elem: Element, token: 'i' | 'm' | 't' | null): void {
  if (!token) return;
  if (elem.localName === 'note') {
    elem.setAttribute('tie', token);
    return;
  }
  for (const child of Array.from(elem.children)) {
    if (child.localName === 'note') child.setAttribute('tie', token);
  }
}

function tieToken(incoming: boolean, outgoing: boolean): 'i' | 'm' | 't' | null {
  if (incoming && outgoing) return 'm';
  if (incoming) return 't';
  if (outgoing) return 'i';
  return null;
}

/** Emit one voice's QNotes for a single bar into the given layer element.
 *  `carryTie` (a one-element box) threads the cross-QNote tie state: it is true
 *  after a note-atom whose `tied` flag forwards into the next note-atom. */
function emitVoiceBar(
  doc: Document,
  layer: Element,
  notes: QNote[],
  carryTie: { v: boolean },
): void {
  for (const q of notes) {
    if (q.isRest || q.pitches.length === 0) {
      for (const a of q.atoms) {
        layer.appendChild(buildRestElement(doc, {
          duration: a.notation.base as Duration,
          dots: a.notation.dots as Dots,
        }));
      }
      carryTie.v = false;
      continue;
    }

    const specs = q.coords.map((c, i) => noteSpecFromCoord(c.q, c.r, q.colors[i]));
    for (const a of q.atoms) {
      const incoming = carryTie.v;
      const outgoing = a.notation.tied;
      const dur = a.notation.base as Duration;
      const dots = a.notation.dots as Dots;
      const elem = specs.length === 1
        ? buildNoteElement(doc, specs[0], dur, dots)
        : buildChordElement(doc, { notes: specs, duration: dur, dots });
      setTie(elem, tieToken(incoming, outgoing));
      layer.appendChild(elem);
      carryTie.v = outgoing;
    }
  }
}

export function emitMei(
  voiced: VoicedScore,
  meter: Meter,
  tempo: TempoEstimate,
  opts: EmitMeiOpts,
  snapshot: LayoutSnapshot,
): string {
  const bpm = Math.max(1, Math.round(tempo.bpm));
  const num = Math.max(1, Math.round(opts.numerator));

  /* Reuse the shared skeleton for head / hkl:config / scoreDef, then rebuild the
     section with one measure per bar. refQ/refR = 0,0: recording coords are
     origin-relative to A3=220 (the only ref a recording carries). */
  const skeleton = buildScoreSkeletonXml({
    title: opts.title,
    composer: 'HexKeyLab',
    keySig: '0',
    meterCount: num,
    meterUnit: 4,
    tempoBpm: bpm,
    layoutReq: { tuningMode: snapshot.tuning, refQ: 0, refR: 0 },
  });
  const doc = new DOMParser().parseFromString(skeleton, 'application/xml');
  const section = doc.querySelector('section');
  if (!section) throw new Error('mei skeleton missing <section>');
  while (section.firstChild) section.removeChild(section.firstChild);

  const barTicks = meter.subdivisions * num;
  const barOf = (q: QNote): number => Math.floor(q.startTick / barTicks);
  let maxBar = 0;
  for (const q of voiced.treble) maxBar = Math.max(maxBar, barOf(q));
  for (const q of voiced.bass) maxBar = Math.max(maxBar, barOf(q));
  const numBars = maxBar + 1;

  /* Tie carry is per-voice and must persist across bar boundaries. */
  const trebleCarry = { v: false };
  const bassCarry = { v: false };

  for (let bar = 0; bar < numBars; bar++) {
    const measure = el(doc, 'measure', { n: bar + 1, 'xml:id': newId('m') });
    /* Final barline only on the last measure (Composer's setBarlines convention). */
    if (bar === numBars - 1) measure.setAttribute('right', 'end');
    if (bar === 0) {
      measure.appendChild(el(doc, 'tempo', {
        tstamp: 1, staff: 1, mm: bpm, 'mm.unit': '4', 'midi.bpm': bpm,
      }));
    }

    const s1 = el(doc, 'staff', { n: 1, 'xml:id': newId('s') });
    const s1l1 = el(doc, 'layer', { n: 1, 'xml:id': newId('l') });
    emitVoiceBar(doc, s1l1, voiced.treble.filter((q) => barOf(q) === bar), trebleCarry);
    s1.appendChild(s1l1);
    s1.appendChild(el(doc, 'layer', { n: 2, 'xml:id': newId('l') }));

    const s2 = el(doc, 'staff', { n: 2, 'xml:id': newId('s') });
    const s2l1 = el(doc, 'layer', { n: 1, 'xml:id': newId('l') });
    emitVoiceBar(doc, s2l1, voiced.bass.filter((q) => barOf(q) === bar), bassCarry);
    s2.appendChild(s2l1);
    s2.appendChild(el(doc, 'layer', { n: 2, 'xml:id': newId('l') }));

    measure.appendChild(s1);
    measure.appendChild(s2);
    section.appendChild(measure);
  }

  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + new XMLSerializer().serializeToString(doc.documentElement);
}
