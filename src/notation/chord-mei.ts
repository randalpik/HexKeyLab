// Build a minimal grand-staff MEI document holding the currently-held notes as
// a single chord of whole notes — the live-chord staff inset's input to
// Verovio. Self-contained: no dependency on Composer's measure/model code.
//
// Notes split across treble (midi >= 60) and bass (< 60) staves at middle C.
// Accidentals are set per note from the count-form alteration; when HEJI is on,
// a comma-bearing note with no conventional accidental gets an explicit natural
// so transformDocForHeji draws its arrow (the isolated-chord analogue of
// Composer's computeAccidentalDisplay comma-natural rule — no measure carry).

import type { TuningMode } from '../shared/freq.js';
import { hejiCommasFor } from '../shared/heji.js';
import { alterFromCount, tokenFromAlter } from './accidentals.js';
import { transformDocForHeji } from './heji-render.js';

const MEI_NS = 'http://www.music-encoding.org/ns/mei';
const MIDDLE_C = 60;

/** One note to place on the staff. Structurally a subset of the bridge's
 *  ResolvedNote, so HKL's resolveNoteSpec output is directly usable. */
export interface StaffChordNote {
  q: number;
  r: number;
  pname: string;   // 'a'..'g'
  accid: string;   // count-form: '', 's', 'ff', 'sss', 'n' …
  oct: number;
  midi: number;
  colorHex: string;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function noteXml(n: StaffChordNote, mode: TuningMode, hejiEnabled: boolean): string {
  const alter = alterFromCount(n.accid);
  let token = alter !== 0 ? tokenFromAlter(alter) : null;
  if (hejiEnabled && !token) {
    const { syn5, sept7 } = hejiCommasFor(mode, n.q, n.r);
    /* Comma on a conventionally-natural note: force an explicit natural so the
       HEJI transform sees an @accid and renders the arrow/hook on it. */
    if (syn5 !== 0 || sept7 !== 0) token = 'n';
  }
  const accidAttr = token ? ` accid="${token}"` : '';
  return `<note pname="${n.pname}" oct="${n.oct}" color="${escapeAttr(n.colorHex)}"`
    + ` data-q="${n.q}" data-r="${n.r}"${accidAttr}/>`;
}

/** Build the content of one staff layer: a whole-note chord, a single whole
 *  note, or an invisible whole-measure space when the staff has no notes (no
 *  rest glyph — this is a live chord view, not an engraved score). */
function staffContent(notes: StaffChordNote[], mode: TuningMode, hejiEnabled: boolean): string {
  if (notes.length === 0) return '<space dur="1"/>';
  if (notes.length === 1) {
    /* Single note still needs dur="1" (whole note). */
    return noteXml(notes[0], mode, hejiEnabled).replace('<note ', '<note dur="1" ');
  }
  const inner = notes.map(n => noteXml(n, mode, hejiEnabled)).join('');
  return `<chord dur="1">${inner}</chord>`;
}

/** Serialize the held notes into a one-measure grand-staff MEI string, with the
 *  HEJI/stack accidental transform applied (render-only — (q, r) stays truth).
 *  Assumes at least one note; an empty selection should clear the inset
 *  upstream rather than render an empty staff. */
export function buildChordMei(notes: StaffChordNote[], mode: TuningMode, hejiEnabled: boolean): string {
  const sorted = [...notes].sort((a, b) => a.midi - b.midi);
  const treble = sorted.filter(n => n.midi >= MIDDLE_C);
  const bass = sorted.filter(n => n.midi < MIDDLE_C);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="${MEI_NS}" meiversion="5.0">
  <music><body><mdiv><score>
    <scoreDef key.sig="0">
      <staffGrp symbol="brace" bar.thru="true">
        <staffDef n="1" lines="5" clef.shape="G" clef.line="2"/>
        <staffDef n="2" lines="5" clef.shape="F" clef.line="4"/>
      </staffGrp>
    </scoreDef>
    <section>
      <measure n="1" right="single">
        <staff n="1"><layer n="1">${staffContent(treble, mode, hejiEnabled)}</layer></staff>
        <staff n="2"><layer n="1">${staffContent(bass, mode, hejiEnabled)}</layer></staff>
      </measure>
    </section>
  </score></mdiv></body></music>
</mei>`;

  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  transformDocForHeji(doc, mode, hejiEnabled);
  return new XMLSerializer().serializeToString(doc);
}
