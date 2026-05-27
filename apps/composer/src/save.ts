// File I/O for Composer:
//   - .hkc save/load (canonical MEI with HKL data-q/data-r attrs)
//   - .musicxml export (one-way, lossy — colors and lattice tags preserved
//     where the spec allows; advanced markings like dynamics aren't emitted
//     because the model doesn't carry them yet).
//
// Uses simple download/upload via Blob + <input type="file"> — no File System
// Access API yet.

import { ComposerModel } from './model/index.js';
import type { Voice, Duration, Dots } from './model/index.js';
import { noteAlter } from '@hkl/notation/accidentals.js';
import type { VerovioToolkit } from '@hkl/notation/verovio-types.js';

/* ── helpers ─────────────────────────────────────────────────────────────── */

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error ?? new Error('read failed'));
    fr.readAsText(file);
  });
}

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -5);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/* ── .hkc save / load ────────────────────────────────────────────────────── */

export function saveHkc(model: ComposerModel, name?: string): void {
  const xml = model.serialize();
  const filename = (name ? name.replace(/\.[^.]*$/, '') : 'hkc-' + isoStamp()) + '.hkc';
  downloadBlob(filename, new Blob([xml], { type: 'application/xml' }));
}

export async function loadHkcFromFile(file: File): Promise<ComposerModel> {
  const text = await readFileAsText(file);
  return new ComposerModel(text);
}

/* ── MusicXML export ─────────────────────────────────────────────────────── */

const DURATION_NAME: Record<Duration, string> = {
  '1':  'whole',
  '2':  'half',
  '4':  'quarter',
  '8':  'eighth',
  '16': '16th',
  '32': '32nd',
  '64': '64th',
};

const PNAME_TO_STEP: Record<string, string> = {
  a: 'A', b: 'B', c: 'C', d: 'D', e: 'E', f: 'F', g: 'G',
};

/** Net alteration for a MusicXML <alter> element. Derives from (q, r) via
 *  noteAlter so any magnitude (incl. >±3 stacks) exports correctly; falls back
 *  to the @accid token for coordinate-less notes. HEJI commas are not
 *  representable in MusicXML (W3C #263 open) and are intentionally dropped. */
function totalAlter(node: Element): number {
  return noteAlter(node);
}

/* divisions per quarter — base 16 covers 32nd notes (= 2) and dotted 16ths
 * (= 6). For tuplet support we multiply by the LCM of all tuplet `num`
 * values found in the doc so each tuplet child's sounding ticks come out
 * integer (e.g. triplet of 8ths needs divisions = LCM(16, 3) = 48). */
const BASE_DIVISIONS = 16;

function gcdN(a: number, b: number): number { return b === 0 ? a : gcdN(b, a % b); }
function lcmN(a: number, b: number): number { return (a * b) / gcdN(a, b); }

function computeDivisions(doc: Document): number {
  let result = BASE_DIVISIONS;
  for (const t of Array.from(doc.querySelectorAll('tuplet'))) {
    const num = parseInt(t.getAttribute('num') ?? '1', 10);
    if (num > 1) result = lcmN(result, num);
  }
  return result;
}

function durationToTicks(dur: Duration, dots: Dots, divisions: number): number {
  const base = (divisions * 4) / parseInt(dur, 10);
  if (dots === 1) return base * 3 / 2;
  if (dots === 2) return base * 7 / 4;
  return base;
}

function isTupletPlaceholderEl(el: Element): boolean {
  return el.localName === 'space' && el.getAttribute('data-tuplet-placeholder') === 'true';
}

function keySigToFifths(sig: string): number {
  if (sig === '0' || !sig) return 0;
  const n = parseInt(sig.slice(0, -1), 10);
  if (!isFinite(n)) return 0;
  if (sig.endsWith('s')) return n;
  if (sig.endsWith('f')) return -n;
  return 0;
}

interface XmlNoteSpec {
  step: string;
  alter: number;
  octave: number;
  color?: string;
  q?: number;
  r?: number;
  tieStart: boolean;
  tieStop: boolean;
}

interface XmlNoteEvent {
  notes: XmlNoteSpec[]; /* empty = rest */
  durTicks: number;
  durName: string;
  dots: number;
  staff: 1 | 2;
  voice: number; /* MusicXML voice number, 1..4 globally */
  measureIdx: number; /* 0-based; emitted as @number = measureIdx + 1 */
  /** Set when this event is inside a tuplet. `position` marks first/last/etc.
   *  for the MusicXML `<tuplet>` notation start/stop tags. */
  tuplet?: {
    actualNotes: number;  /* @num */
    normalNotes: number;  /* @numbase */
    position: 'start' | 'middle' | 'stop' | 'solo';
  };
}

function isMeiElement(elem: Element, name: string): boolean {
  return elem.localName === name;
}

function readTieFlags(node: Element): { tieStart: boolean; tieStop: boolean } {
  const t = node.getAttribute('tie');
  /* MEI 5 data.TIE: 'i' (initial) | 'm' (medial — both) | 't' (terminal). */
  return {
    tieStart: t === 'i' || t === 'm',
    tieStop: t === 't' || t === 'm',
  };
}

function readNote(node: Element): XmlNoteSpec {
  const pname = node.getAttribute('pname') ?? 'c';
  const oct = parseInt(node.getAttribute('oct') ?? '4', 10);
  /* Sum the net alteration from whichever encoding the note carries
     (@accid, @accid.ges, or <accid> children). MusicXML's <alter> needs
     the actual pitch as a signed integer. */
  const alter = totalAlter(node);
  const color = node.getAttribute('color') ?? undefined;
  const qStr = node.getAttribute('data-q');
  const rStr = node.getAttribute('data-r');
  const ties = readTieFlags(node);
  return {
    step: PNAME_TO_STEP[pname] ?? 'C',
    alter,
    octave: oct,
    color,
    q: qStr !== null ? parseInt(qStr, 10) : undefined,
    r: rStr !== null ? parseInt(rStr, 10) : undefined,
    tieStart: ties.tieStart,
    tieStop: ties.tieStop,
  };
}

function gatherEventsFromDoc(doc: Document, divisions: number): XmlNoteEvent[] {
  const out: XmlNoteEvent[] = [];
  const measures = Array.from(doc.querySelectorAll('measure'));
  for (let mi = 0; mi < measures.length; mi++) {
    const measure = measures[mi];
    for (let voice = 1 as Voice; voice <= 4; voice = (voice + 1) as Voice) {
      const staff = (voice <= 2) ? 1 : 2;
      const staffN = staff;
      const layerN = (voice === 1 || voice === 3) ? 1 : 2;
      const layer = Array.from(measure.querySelectorAll(`staff[n="${staffN}"] layer[n="${layerN}"]`))[0];
      if (!layer) {
        if (voice === 4) break;
        continue;
      }
      for (const child of contentChildren(layer)) {
        if (child.localName === 'tuplet') {
          const num = parseInt(child.getAttribute('num') ?? '3', 10);
          const numbase = parseInt(child.getAttribute('numbase') ?? '2', 10);
          /* Emit one event per filled tuplet child. Placeholders are skipped
             — they're MEI-internal layout artifacts with no MusicXML form. */
          const filled = Array.from(child.children).filter((c) =>
            !isTupletPlaceholderEl(c) &&
            (c.localName === 'note' || c.localName === 'chord' || c.localName === 'rest'));
          for (let i = 0; i < filled.length; i++) {
            const elem = filled[i];
            const dur = (elem.getAttribute('dur') ?? '4') as Duration;
            const dots = parseInt(elem.getAttribute('dots') ?? '0', 10) as Dots;
            const writtenTicks = durationToTicks(dur, dots, divisions);
            /* Sounding ticks = written × numbase / num. With divisions chosen
               as LCM(BASE, num), this is always an integer. */
            const soundingTicks = writtenTicks * numbase / num;
            const position: 'start' | 'middle' | 'stop' | 'solo' =
              filled.length === 1 ? 'solo' :
              i === 0 ? 'start' :
              i === filled.length - 1 ? 'stop' : 'middle';
            const tupletInfo = { actualNotes: num, normalNotes: numbase, position };
            if (elem.localName === 'rest') {
              out.push({
                notes: [], durTicks: soundingTicks,
                durName: DURATION_NAME[dur] ?? 'quarter',
                dots, staff: staff as 1 | 2, voice, measureIdx: mi,
                tuplet: tupletInfo,
              });
            } else if (elem.localName === 'note') {
              out.push({
                notes: [readNote(elem)], durTicks: soundingTicks,
                durName: DURATION_NAME[dur] ?? 'quarter',
                dots, staff: staff as 1 | 2, voice, measureIdx: mi,
                tuplet: tupletInfo,
              });
            } else if (elem.localName === 'chord') {
              const noteEls = Array.from(elem.children).filter((c) => c.localName === 'note');
              out.push({
                notes: noteEls.map((n) => readNote(n)),
                durTicks: soundingTicks,
                durName: DURATION_NAME[dur] ?? 'quarter',
                dots, staff: staff as 1 | 2, voice, measureIdx: mi,
                tuplet: tupletInfo,
              });
            }
          }
          continue;
        }
        const dur = (child.getAttribute('dur') ?? '4') as Duration;
        const dots = parseInt(child.getAttribute('dots') ?? '0', 10) as Dots;
        if (isMeiElement(child, 'rest')) {
          out.push({
            notes: [],
            durTicks: durationToTicks(dur, dots, divisions),
            durName: DURATION_NAME[dur] ?? 'quarter',
            dots, staff: staff as 1 | 2, voice, measureIdx: mi,
          });
        } else if (isMeiElement(child, 'note')) {
          out.push({
            notes: [readNote(child)],
            durTicks: durationToTicks(dur, dots, divisions),
            durName: DURATION_NAME[dur] ?? 'quarter',
            dots, staff: staff as 1 | 2, voice, measureIdx: mi,
          });
        } else if (isMeiElement(child, 'chord')) {
          const noteEls = Array.from(child.children).filter((c) => c.localName === 'note');
          out.push({
            notes: noteEls.map((n) => readNote(n)),
            durTicks: durationToTicks(dur, dots, divisions),
            durName: DURATION_NAME[dur] ?? 'quarter',
            dots, staff: staff as 1 | 2, voice, measureIdx: mi,
          });
        }
      }
      if (voice === 4) break;
    }
  }
  return out;
}

function contentChildren(layer: Element): Element[] {
  /* Layer may contain <beam> wrappers in the serialized MEI; flatten them.
   * <tuplet> elements are returned as-is here — gatherEventsFromDoc handles
   * the per-child descent so it can attach tuplet metadata. */
  const out: Element[] = [];
  for (const c of Array.from(layer.children)) {
    const ln = c.localName;
    if (ln === 'chord' || ln === 'note' || ln === 'rest' || ln === 'tuplet') {
      out.push(c);
    } else if (ln === 'beam') {
      for (const cc of Array.from(c.children)) {
        const ln2 = cc.localName;
        if (ln2 === 'chord' || ln2 === 'note' || ln2 === 'rest') out.push(cc);
      }
    }
  }
  return out;
}

export function exportMusicXml(model: ComposerModel): string {
  const xml = model.serialize();
  const doc = new DOMParser().parseFromString(xml, 'application/xml');

  const title = model.getTitle();
  const composer = model.getComposer() || 'HKL Composer';
  const keySig = model.getKeySig();
  const fifths = keySigToFifths(keySig);
  const keyMode = model.getKeyMode();
  const ts = model.getTimeSig();
  const tempo = model.getTempo();

  const divisions = computeDivisions(doc);
  const events = gatherEventsFromDoc(doc, divisions);
  const measureCount = Math.max(1, doc.querySelectorAll('measure').length);

  /* Group events by (measure, voice). */
  const grouped: Record<number, Record<number, XmlNoteEvent[]>> = {};
  for (let mi = 0; mi < measureCount; mi++) {
    grouped[mi] = { 1: [], 2: [], 3: [], 4: [] };
  }
  for (const ev of events) grouped[ev.measureIdx][ev.voice].push(ev);

  /* Measure-tick budget under current meter. */
  const measureTicks = ts.count * divisions * 4 / ts.unit;

  let body = '';
  for (let mi = 0; mi < measureCount; mi++) {
    body += `  <measure number="${mi + 1}">\n`;

    if (mi === 0) {
      body += `    <attributes>\n`;
      body += `      <divisions>${divisions}</divisions>\n`;
      body += `      <key><fifths>${fifths}</fifths><mode>${keyMode}</mode></key>\n`;
      body += `      <time><beats>${ts.count}</beats><beat-type>${ts.unit}</beat-type></time>\n`;
      body += `      <staves>2</staves>\n`;
      body += `      <clef number="1"><sign>G</sign><line>2</line></clef>\n`;
      body += `      <clef number="2"><sign>F</sign><line>4</line></clef>\n`;
      body += `    </attributes>\n`;
      body += `    <sound tempo="${tempo.bpm}"/>\n`;
      const beatUnitName = DURATION_NAME[(String(tempo.unit) as Duration) ?? '4'] ?? 'quarter';
      body += `    <direction placement="above">\n`;
      body += `      <direction-type>\n`;
      if (tempo.text) body += `        <words>${escapeXml(tempo.text)} </words>\n`;
      body += `        <metronome><beat-unit>${beatUnitName}</beat-unit>`;
      if (tempo.dots > 0) body += `<beat-unit-dot/>`;
      body += `<per-minute>${tempo.bpm}</per-minute></metronome>\n`;
      body += `      </direction-type>\n`;
      body += `      <sound tempo="${tempo.bpm}"/>\n`;
      body += `    </direction>\n`;
    }

    /* Per-voice streams within this measure, separated by <backup>. */
    const voiceTicks: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (let voice = 1 as 1 | 2 | 3 | 4; voice <= 4; voice = (voice + 1) as 1 | 2 | 3 | 4) {
      if (voice > 1) body += `    <backup><duration>${voiceTicks[voice - 1]}</duration></backup>\n`;
      for (const ev of grouped[mi][voice]) {
        body += emitEventXml(ev);
        voiceTicks[voice] += ev.durTicks;
      }
      /* Pad to measure end if voice short. */
      const remaining = measureTicks - voiceTicks[voice];
      if (remaining > 0) {
        body += `    <note><rest/><duration>${remaining}</duration><staff>${voice <= 2 ? 1 : 2}</staff><voice>${voice}</voice></note>\n`;
        voiceTicks[voice] = measureTicks;
      }
      if (voice === 4) break;
    }

    /* Final barline on the last measure. */
    if (mi === measureCount - 1) {
      body += `    <barline location="right"><bar-style>light-heavy</bar-style></barline>\n`;
    }

    body += `  </measure>\n`;
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.0">
  <work><work-title>${escapeXml(title)}</work-title></work>
  <identification>
    <creator type="composer">${escapeXml(composer)}</creator>
    <encoding>
      <software>HKL Composer</software>
      <encoding-date>${new Date().toISOString().slice(0, 10)}</encoding-date>
    </encoding>
  </identification>
  <part-list>
    <score-part id="P1">
      <part-name>Piano</part-name>
    </score-part>
  </part-list>
  <part id="P1">
${body}  </part>
</score-partwise>
`;
}

function emitEventXml(ev: XmlNoteEvent): string {
  if (ev.notes.length === 0) {
    /* Rest. Tuplet rest carries time-modification too (for correct DAW
       timing) but no <tuplet/> notation tag — only notes get brackets. */
    let r = `    <note><rest/><duration>${ev.durTicks}</duration>` +
      `<voice>${ev.voice}</voice>${dotXml(ev.dots)}<type>${ev.durName}</type>`;
    if (ev.tuplet) r += timeModXml(ev.tuplet.actualNotes, ev.tuplet.normalNotes);
    r += `<staff>${ev.staff}</staff></note>\n`;
    return r;
  }
  let s = '';
  for (let i = 0; i < ev.notes.length; i++) {
    const n = ev.notes[i];
    s += `    <note>`;
    if (i > 0) s += `<chord/>`;
    s += `<pitch><step>${n.step}</step>`;
    if (n.alter !== 0) s += `<alter>${n.alter}</alter>`;
    s += `<octave>${n.octave}</octave></pitch>`;
    s += `<duration>${ev.durTicks}</duration>`;
    /* Sound-layer ties. */
    if (n.tieStart) s += `<tie type="start"/>`;
    if (n.tieStop) s += `<tie type="stop"/>`;
    s += `<voice>${ev.voice}</voice>`;
    s += `${dotXml(ev.dots)}`;
    s += `<type>${ev.durName}</type>`;
    /* Time-modification applies to ALL chord notes inside a tuplet, so
       the DAW timing comes out right per voice. */
    if (ev.tuplet) s += timeModXml(ev.tuplet.actualNotes, ev.tuplet.normalNotes);
    s += `<staff>${ev.staff}</staff>`;
    if (n.color) s += `<notehead color="${escapeXml(n.color)}">normal</notehead>`;
    /* Engraving-layer ties + tuplet start/stop bracket. Only the chord's
       PRIMARY note (i === 0) carries the <tuplet/> notation tag — standard
       MusicXML practice (one bracket per chord, not one per chord member). */
    const tStart = ev.tuplet && i === 0 && (ev.tuplet.position === 'start' || ev.tuplet.position === 'solo');
    const tStop  = ev.tuplet && i === 0 && (ev.tuplet.position === 'stop'  || ev.tuplet.position === 'solo');
    if (n.tieStart || n.tieStop || tStart || tStop) {
      s += `<notations>`;
      if (n.tieStart) s += `<tied type="start"/>`;
      if (n.tieStop) s += `<tied type="stop"/>`;
      if (tStart) s += `<tuplet type="start" number="1"/>`;
      if (tStop) s += `<tuplet type="stop" number="1"/>`;
      s += `</notations>`;
    }
    s += `</note>\n`;
  }
  return s;
}

function timeModXml(actual: number, normal: number): string {
  return `<time-modification><actual-notes>${actual}</actual-notes>` +
    `<normal-notes>${normal}</normal-notes></time-modification>`;
}

function dotXml(dots: number): string {
  if (dots <= 0) return '';
  let s = '';
  for (let i = 0; i < dots; i++) s += '<dot/>';
  return s;
}

export function downloadMusicXml(model: ComposerModel): void {
  const xml = exportMusicXml(model);
  const filename = 'hkc-' + isoStamp() + '.musicxml';
  downloadBlob(filename, new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }));
}

/* ── .pdf export ─────────────────────────────────────────────────────────── */

/* Verovio US-Letter geometry in 1/100 mm (mirrors render.ts PAGE_GEOM).
 * 8.5 × 11 in = 2159 × 2794; 0.55 in margin = 140. We force these for
 * export regardless of the user's current view mode so the PDF is always
 * paginated. The on-screen view is restored by the `restore` callback. */
const PDF_EXPORT_OPTS = {
  pageWidth: 2159,
  pageHeight: 2794,
  pageMarginTop: 140,
  pageMarginBottom: 140,
  pageMarginLeft: 140,
  pageMarginRight: 140,
  breaks: 'auto',
  header: 'auto',
  footer: 'none',
  scale: 100,
  svgAdditionalAttribute: ['note@data-q', 'note@data-r', 'note@color', 'rest@data-tuplet-placeholder'],
};

/* Letter in PDF points (1 in = 72 pt). */
const LETTER_PT_W = 612;
const LETTER_PT_H = 792;

/* MEI's @color attribute on <note> propagates to all descendants by default
 * — notehead AND stem AND flag AND accidental AND dots — because Verovio
 * emits the descendants with fill="currentColor". On screen, composer.html
 * forces these non-notehead elements back to black via CSS. That CSS does
 * NOT reach the detached SVG handed to svg2pdf, so without this normalize
 * pass the PDF picks up the inherited color on every stem/flag/accid/etc.
 * Walk the SVG and pin `color` + `fill` to black on the same selectors the
 * stylesheet covers; descendants then resolve currentColor as black. */
const NON_NOTEHEAD_BLACK_CLASSES = ['stem', 'flag', 'accid', 'ledgerLines', 'dots'];

export function forceNonNoteheadBlack(svg: SVGSVGElement): void {
  const sel = NON_NOTEHEAD_BLACK_CLASSES.map((c) => '.' + c).join(', ');
  for (const container of Array.from(svg.querySelectorAll(sel))) {
    container.setAttribute('color', '#000');
    container.setAttribute('fill', '#000');
    /* Belt and braces: any descendant with an explicit non-currentColor
     * fill (would otherwise win over the container's color) also gets
     * pinned to black. Mirrors the `.stem *` part of the stylesheet. */
    for (const desc of Array.from(container.querySelectorAll('*'))) {
      desc.setAttribute('fill', '#000');
    }
  }
}

/* Verovio emits each single-note <g class="note"> as [notehead, dots, stem];
 * SVG z-order is document order, so the stem draws over the notehead. With
 * colored noteheads + black stems, the stem intrudes visibly. Move each
 * notehead to be the LAST child of its note so it draws on top. Chord
 * stems live outside the per-note <g> already, so chords don't need this.
 * Mirrors the same pass render.ts applies to the on-screen DOM. */
export function liftNoteheadsAbove(svg: SVGSVGElement): void {
  for (const note of Array.from(svg.querySelectorAll('g.note'))) {
    const notehead = note.querySelector(':scope > g.notehead');
    if (notehead) note.appendChild(notehead);
  }
}

export async function downloadPdf(
  model: ComposerModel,
  tk: VerovioToolkit,
  restore: () => void,
): Promise<void> {
  /* Lazy-load so the libraries only land in the composer bundle on first
     export click. Both ship ESM. svg2pdf.js side-effect-patches jsPDF's
     prototype with .svg(). */
  const { jsPDF } = await import('jspdf');
  await import('svg2pdf.js');

  const savedOpts = tk.getOptions();
  try {
    tk.setOptions(PDF_EXPORT_OPTS);
    tk.loadData(model.serialize());

    const pdf = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
    const pageCount = Math.max(1, tk.getPageCount());
    for (let i = 1; i <= pageCount; i++) {
      const svgStr = tk.renderToSVG(i, {});
      /* svg2pdf resolves <use href="#…"> against the SVG root, so each
         page must keep its own <defs> block. Parse into a detached host
         (not appended to document) and pass the live <svg> element. */
      const host = document.createElement('div');
      host.innerHTML = svgStr;
      const svg = host.firstElementChild as SVGSVGElement | null;
      if (!svg) throw new Error('Verovio produced no SVG for page ' + i);
      forceNonNoteheadBlack(svg);
      liftNoteheadsAbove(svg);
      if (i > 1) pdf.addPage('letter', 'portrait');
      /* Process pages sequentially — parallel pdf.svg() calls would
         race addPage ordering. */
      await pdf.svg(svg, { x: 0, y: 0, width: LETTER_PT_W, height: LETTER_PT_H });
    }
    pdf.save('hkc-' + isoStamp() + '.pdf');
  } finally {
    /* getOptions() returns a JSON string; parse before restoring. */
    try { tk.setOptions(JSON.parse(savedOpts)); } catch { /* ignore */ }
    restore();
  }
}
