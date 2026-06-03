// File I/O for Composer:
//   - .hkc save/load (canonical MEI with HKL data-q/data-r attrs)
//   - .musicxml export (one-way, lossy — colors and lattice tags preserved
//     where the spec allows; advanced markings like dynamics aren't emitted
//     because the model doesn't carry them yet).
//
// Uses simple download/upload via Blob + <input type="file"> — no File System
// Access API yet.

import { ComposerModel } from './model/index.js';
import type { Voice, Duration, Dots, InstrumentEntry } from './model/index.js';
import { noteAlter } from '@hkl/notation/accidentals.js';
import { injectHejiGlyphs } from '@hkl/notation/heji-render.js';
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
  staff: number;
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

function gatherEventsFromDoc(doc: Document, divisions: number, model: ComposerModel): XmlNoteEvent[] {
  const out: XmlNoteEvent[] = [];
  const measures = Array.from(doc.querySelectorAll('measure'));
  const totalVoices = model.totalVoices();
  for (let mi = 0; mi < measures.length; mi++) {
    const measure = measures[mi];
    for (let voice = 1 as Voice; voice <= totalVoices; voice = (voice + 1) as Voice) {
      const staffN = model.staffForVoice(voice);
      const staff = staffN;
      const layerN = model.layerForVoice(voice);
      const layer = Array.from(measure.querySelectorAll(`staff[n="${staffN}"] layer[n="${layerN}"]`))[0];
      if (!layer) {
        if (voice === totalVoices) break;
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
                dots, staff, voice, measureIdx: mi,
                tuplet: tupletInfo,
              });
            } else if (elem.localName === 'note') {
              out.push({
                notes: [readNote(elem)], durTicks: soundingTicks,
                durName: DURATION_NAME[dur] ?? 'quarter',
                dots, staff, voice, measureIdx: mi,
                tuplet: tupletInfo,
              });
            } else if (elem.localName === 'chord') {
              const noteEls = Array.from(elem.children).filter((c) => c.localName === 'note');
              out.push({
                notes: noteEls.map((n) => readNote(n)),
                durTicks: soundingTicks,
                durName: DURATION_NAME[dur] ?? 'quarter',
                dots, staff, voice, measureIdx: mi,
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
            dots, staff, voice, measureIdx: mi,
          });
        } else if (isMeiElement(child, 'note')) {
          out.push({
            notes: [readNote(child)],
            durTicks: durationToTicks(dur, dots, divisions),
            durName: DURATION_NAME[dur] ?? 'quarter',
            dots, staff, voice, measureIdx: mi,
          });
        } else if (isMeiElement(child, 'chord')) {
          const noteEls = Array.from(child.children).filter((c) => c.localName === 'note');
          out.push({
            notes: noteEls.map((n) => readNote(n)),
            durTicks: durationToTicks(dur, dots, divisions),
            durName: DURATION_NAME[dur] ?? 'quarter',
            dots, staff, voice, measureIdx: mi,
          });
        }
      }
      if (voice === totalVoices) break;
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

interface ClefSpec { sign: string; line: string; oct: number }

function clefEq(a: ClefSpec, b: ClefSpec): boolean {
  return a.sign === b.sign && a.line === b.line && a.oct === b.oct;
}

/** MEI `@clef.dis`/`@clef.dis.place` (or `@dis`/`@dis.place`) → MusicXML
 *  clef-octave-change (+1/-1 for 8va/8vb, +2/-2 for 15ma/15mb). */
function disToOct(dis: string | null, place: string | null): number {
  if (!dis) return 0;
  const n = parseInt(dis, 10);
  const steps = n === 15 ? 2 : n === 8 ? 1 : 0;
  return place === 'below' ? -steps : steps;
}

/** Opening clef for a staff from the head `<staffDef>` (defaults treble/bass). */
function headClefForStaff(doc: Document, staffN: number): ClefSpec {
  const sd = Array.from(doc.querySelectorAll('scoreDef staffDef'))
    .find((d) => d.getAttribute('n') === String(staffN));
  return {
    sign: sd?.getAttribute('clef.shape') ?? (staffN === 1 ? 'G' : 'F'),
    line: sd?.getAttribute('clef.line') ?? (staffN === 1 ? '2' : '4'),
    oct: disToOct(sd?.getAttribute('clef.dis') ?? null, sd?.getAttribute('clef.dis.place') ?? null),
  };
}

/** The last inline `<clef>` in a staff's layers within a measure, or null. */
function lastClefInMeasure(measureEl: Element, staffN: number): ClefSpec | null {
  const staff = Array.from(measureEl.querySelectorAll('staff'))
    .find((s) => s.getAttribute('n') === String(staffN));
  if (!staff) return null;
  const clefs = Array.from(staff.querySelectorAll('layer > clef'));
  if (clefs.length === 0) return null;
  const c = clefs[clefs.length - 1];
  return {
    sign: c.getAttribute('shape') ?? 'G',
    line: c.getAttribute('line') ?? '2',
    oct: disToOct(c.getAttribute('dis'), c.getAttribute('dis.place')),
  };
}

function clefXml(number: number, c: ClefSpec): string {
  let s = `      <clef number="${number}"><sign>${c.sign}</sign><line>${c.line}</line>`;
  if (c.oct) s += `<clef-octave-change>${c.oct}</clef-octave-change>`;
  s += `</clef>\n`;
  return s;
}

export function exportMusicXml(model: ComposerModel): string {
  const xml = model.serialize();
  const doc = new DOMParser().parseFromString(xml, 'application/xml');

  const title = model.getTitle();
  const composer = model.getComposer() || 'HKL Composer';
  const tempo = model.getTempo();

  const divisions = computeDivisions(doc);
  const events = gatherEventsFromDoc(doc, divisions, model);
  const measureCount = Math.max(1, doc.querySelectorAll('measure').length);
  const measureEls = Array.from(doc.querySelectorAll('measure'));
  const totalVoices = model.totalVoices();

  /* Group events by (measure, GLOBAL voice). The score splits into one <part>
     per instrument (roadmap §14.2): each part renumbers its staves and voices
     part-local (1-based) so a non-first instrument's staff @n=3 doesn't leak a
     bogus clef number. A single-instrument doc degenerates to one <part>. */
  const grouped: Record<number, Record<number, XmlNoteEvent[]>> = {};
  for (let mi = 0; mi < measureCount; mi++) {
    grouped[mi] = {};
    for (let v = 1; v <= totalVoices; v++) grouped[mi][v] = [];
  }
  for (const ev of events) grouped[ev.measureIdx][ev.voice].push(ev);

  const instruments = model.instruments();

  /* Build the body for one instrument's <part>. staffMap/voiceMap convert the
     global staff @n / voice index to part-local (1-based). Tempo direction is
     emitted only in the first part (score-global). */
  const buildPartBody = (inst: InstrumentEntry, isFirstPart: boolean): string => {
    const partStaffNs = inst.staffNs;
    const partStaffCount = partStaffNs.length;
    const staffMap = (globalN: number): number => partStaffNs.indexOf(globalN) + 1;
    const partVoices = model.voicesForInstrument(inst.index);
    const voiceMap = (globalV: number): number => partVoices.indexOf(globalV) + 1;

    /* Per-staff clef tracking (part-local), best-effort for mid-piece changes. */
    const curClef: Record<number, ClefSpec> = {};
    for (const sn of partStaffNs) curClef[sn] = headClefForStaff(doc, sn);
    let prevKeySig: string | null = null;
    let prevCount = -1;
    let prevUnit = -1;

    let body = '';
    for (let mi = 0; mi < measureCount; mi++) {
      body += `  <measure number="${mi + 1}">\n`;

      const mMeter = model.meterAt(mi);
      const mKeySig = model.keySigAt(mi);
      const mKeyMode = model.keyModeAt(mi);
      const measureTicks = mMeter.count * divisions * 4 / mMeter.unit;

      const clefToEmit: Record<number, ClefSpec | null> = {};
      for (const staffN of partStaffNs) {
        clefToEmit[staffN] = null;
        const cl = lastClefInMeasure(measureEls[mi], staffN);
        if (cl && !clefEq(cl, curClef[staffN])) {
          clefToEmit[staffN] = cl;
          curClef[staffN] = cl;
        }
      }
      const keyChanged = mKeySig !== prevKeySig;
      const meterChanged = mMeter.count !== prevCount || mMeter.unit !== prevUnit;
      const anyClefChange = partStaffNs.some((sn) => clefToEmit[sn]);

      if (mi === 0 || keyChanged || meterChanged || anyClefChange) {
        body += `    <attributes>\n`;
        if (mi === 0) body += `      <divisions>${divisions}</divisions>\n`;
        if (mi === 0 || keyChanged) body += `      <key><fifths>${keySigToFifths(mKeySig)}</fifths><mode>${mKeyMode}</mode></key>\n`;
        if (mi === 0 || meterChanged) body += `      <time><beats>${mMeter.count}</beats><beat-type>${mMeter.unit}</beat-type></time>\n`;
        if (mi === 0 && partStaffCount > 1) body += `      <staves>${partStaffCount}</staves>\n`;
        for (const sn of partStaffNs) {
          if (mi === 0) body += clefXml(staffMap(sn), curClef[sn]);
          else if (clefToEmit[sn]) body += clefXml(staffMap(sn), clefToEmit[sn]!);
        }
        body += `    </attributes>\n`;
      }
      prevKeySig = mKeySig;
      prevCount = mMeter.count;
      prevUnit = mMeter.unit;

      if (mi === 0 && isFirstPart) {
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
      const voiceTicks: Record<number, number> = {};
      for (const v of partVoices) voiceTicks[v] = 0;
      partVoices.forEach((voice, i) => {
        if (i > 0) body += `    <backup><duration>${voiceTicks[partVoices[i - 1]]}</duration></backup>\n`;
        for (const ev of grouped[mi][voice]) {
          body += emitEventXml(ev, staffMap(ev.staff), voiceMap(ev.voice));
          voiceTicks[voice] += ev.durTicks;
        }
        const remaining = measureTicks - voiceTicks[voice];
        if (remaining > 0) {
          body += `    <note><rest/><duration>${remaining}</duration><staff>${staffMap(model.staffForVoice(voice))}</staff><voice>${voiceMap(voice)}</voice></note>\n`;
          voiceTicks[voice] = measureTicks;
        }
      });

      if (mi === measureCount - 1) {
        body += `    <barline location="right"><bar-style>light-heavy</bar-style></barline>\n`;
      }

      body += `  </measure>\n`;
    }
    return body;
  };

  const partList = instruments
    .map((inst, pi) => `    <score-part id="P${pi + 1}">\n      <part-name>${escapeXml(inst.name)}</part-name>\n    </score-part>`)
    .join('\n');
  const parts = instruments
    .map((inst, pi) => `  <part id="P${pi + 1}">\n${buildPartBody(inst, pi === 0)}  </part>`)
    .join('\n');

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
${partList}
  </part-list>
${parts}
</score-partwise>
`;
}

function emitEventXml(ev: XmlNoteEvent, staff: number, voice: number): string {
  if (ev.notes.length === 0) {
    /* Rest. Tuplet rest carries time-modification too (for correct DAW
       timing) but no <tuplet/> notation tag — only notes get brackets. */
    let r = `    <note><rest/><duration>${ev.durTicks}</duration>` +
      `<voice>${voice}</voice>${dotXml(ev.dots)}<type>${ev.durName}</type>`;
    if (ev.tuplet) r += timeModXml(ev.tuplet.actualNotes, ev.tuplet.normalNotes);
    r += `<staff>${staff}</staff></note>\n`;
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
    s += `<voice>${voice}</voice>`;
    s += `${dotXml(ev.dots)}`;
    s += `<type>${ev.durName}</type>`;
    /* Time-modification applies to ALL chord notes inside a tuplet, so
       the DAW timing comes out right per voice. */
    if (ev.tuplet) s += timeModXml(ev.tuplet.actualNotes, ev.tuplet.normalNotes);
    s += `<staff>${staff}</staff>`;
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
  /* Mirror render.ts's set so the PDF SVG carries the attributes the export
     passes act on — esp. `rest@visible` (→ data-visible) so user-hidden rests
     can be stripped, matching the on-screen CSS that hides them. */
  svgAdditionalAttribute: ['note@data-q', 'note@data-r', 'note@color', 'note@hkl-paren-caut', 'rest@data-tuplet-placeholder', 'rest@visible', 'accid@type'],
};

/* Letter in PDF points (1 in = 72 pt). */
const LETTER_PT_W = 612;
const LETTER_PT_H = 792;

/* MEI's @color attribute on <note> propagates to all descendants by default
 * — notehead AND stem AND flag AND accidental AND dots — because Verovio
 * emits the descendants with fill="currentColor". On screen, composer.html
 * forces these non-notehead elements back to black via CSS. That CSS does
 * NOT reach the off-screen SVG handed to svg-to-pdfkit, so without this normalize
 * pass the PDF picks up the inherited color on every stem/flag/accid/etc.
 * Walk the SVG and pin `color` + `fill` to black on the same selectors the
 * stylesheet covers; descendants then resolve currentColor as black. */
const NON_NOTEHEAD_BLACK_CLASSES = ['stem', 'flag', 'accid', 'ledgerLines', 'dots', 'artic', 'fermata', 'breath'];

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

/* svg-to-pdfkit asks us which PDF font to draw each SVG <text> in. Verovio's
 * music symbols (clefs, noteheads, time sigs) are vector <path>/<use> — no font
 * — but the title/composer/footer text and the HEJI accidentals injected by
 * injectHejiGlyphs ARE <text>. Map the injected HEJI/music family to the
 * embedded Bravura OTF; everything else to a built-in PDFKit font. */
function pdfFontFor(family: string, bold: boolean, italic: boolean): string {
  if (/bravura|leipzig|smufl|vero|music/i.test(family)) return 'Bravura';
  const serif = /times|serif|georgia/i.test(family);
  if (serif) return bold ? (italic ? 'Times-BoldItalic' : 'Times-Bold') : (italic ? 'Times-Italic' : 'Times-Roman');
  return bold ? (italic ? 'Helvetica-BoldOblique' : 'Helvetica-Bold') : (italic ? 'Helvetica-Oblique' : 'Helvetica');
}

/* On screen, composer CSS hides two kinds of rests: tuplet-placeholder rests
 * (`data-data-tuplet-placeholder="true"` — only there to make Verovio draw the
 * bracket) and user-hidden rests (`data-visible="false"`, the `H` toggle).
 * Verovio doesn't honor @visible (rism-digital/verovio#202), so this is CSS —
 * which doesn't reach svg-to-pdfkit. Remove those rests outright before the PDF
 * draws them (removal, not visibility, since svg-to-pdfkit ignores both). */
function removeHiddenRests(svg: SVGSVGElement): void {
  for (const el of Array.from(svg.querySelectorAll(
    'g.rest[data-data-tuplet-placeholder="true"], g.rest[data-visible="false"]',
  ))) {
    el.parentNode?.removeChild(el);
  }
}

/* Verovio strokes staff lines / barlines / stems via an embedded
 * `<style>… path,rect,…{stroke:currentColor}</style>` block rather than inline
 * `stroke` attributes (the line paths carry only `d` + `stroke-width`). On
 * screen the browser applies that scoped style; svg-to-pdfkit does NOT process
 * `<style>` selector blocks, so stroke-only lines render invisible in the PDF
 * (fill-based glyphs are unaffected). Resolve each strokable element's COMPUTED
 * stroke — which the off-screen-but-attached host resolves from the scoped
 * style + `currentColor` (incl. forceNonNoteheadBlack's color overrides) — into
 * an explicit `stroke` attribute svg-to-pdfkit honors.
 *
 * ONLY elements Verovio gave an explicit `stroke-width` (staff lines, barlines,
 * stems, ledger lines, hairpins) are stroke-drawn; we gate on that. Filled
 * glyphs (noteheads, accidentals, clefs — `<use>` of filled `<path>`s in
 * `<defs>`, which have no stroke-width) must NOT be stroked, else every glyph
 * picks up a hairline outline that antialiases to a gray edge in the PDF. */
function inlineComputedStroke(svg: SVGSVGElement): void {
  for (const el of Array.from(svg.querySelectorAll('path, rect, line, polyline, polygon'))) {
    if (el.getAttribute('stroke')) continue;
    if (!el.getAttribute('stroke-width')) continue;
    const stroke = getComputedStyle(el).stroke;
    if (stroke && stroke !== 'none') el.setAttribute('stroke', stroke);
  }
}

export async function downloadPdf(
  model: ComposerModel,
  tk: VerovioToolkit,
  restore: () => void,
  viewStaves?: number[] | null,
): Promise<void> {
  /* Lazy-load so the PDF stack only lands in the bundle on first export. We use
     PDFKit (not jsPDF) because it embeds the Bravura OTF (CFF) via fontkit —
     jsPDF supports only TrueType-`glyf` and silently drops Bravura, so HEJI
     accidentals wouldn't render. svg-to-pdfkit draws Verovio's SVG, including
     the injected HEJI <text>, into the PDFKit doc as vectors + embedded glyphs.
     See decisions.md "Composer PDF export uses PDFKit, not jsPDF". */
  const PDFDocument = (await import('pdfkit/js/pdfkit.standalone.js')).default;
  const SVGtoPDF = (await import('svg-to-pdfkit')).default;

  /* HEJI glyph injection measures BravuraText advances via getComputedTextLength,
     which only works on a laid-out (in-document) element — so each page SVG is
     parsed into an off-screen-but-attached host before injection. */
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute; left:-100000px; top:0; visibility:hidden';
  document.body.appendChild(host);

  const savedOpts = tk.getOptions();
  try {
    const otf = await fetch('/BravuraText.otf').then((r) => r.arrayBuffer());

    tk.setOptions(PDF_EXPORT_OPTS);
    /* WYSIWYG with the on-screen render: same HEJI prep + the toolbar's
       instrument-view selector (single-part view prints just that part). */
    tk.loadData(model.serialize({ hejiEnabled: model.getHejiEnabled() }, viewStaves));

    const doc = new PDFDocument({ size: 'letter', margin: 0, autoFirstPage: false });
    /* PDFKit's doc is itself a readable stream — collect its chunks into a Blob
       directly (avoids blob-stream, which references a Node `global`). */
    const chunks: BlobPart[] = [];
    const ended = new Promise<void>((resolve) => {
      doc.on('data', (c: Uint8Array) => chunks.push(c.slice()));
      doc.on('end', () => resolve());
    });
    doc.registerFont('Bravura', otf);

    const pageCount = Math.max(1, tk.getPageCount());
    for (let i = 1; i <= pageCount; i++) {
      host.innerHTML = tk.renderToSVG(i, {});
      const svg = host.firstElementChild as SVGSVGElement | null;
      if (!svg) throw new Error('Verovio produced no SVG for page ' + i);
      /* Match the on-screen render pipeline (render.ts): HEJI glyph swap →
         non-notehead black → noteheads on top. */
      removeHiddenRests(svg);
      injectHejiGlyphs(host);
      forceNonNoteheadBlack(svg);
      liftNoteheadsAbove(svg);
      /* Inline the embedded-style stroke so svg-to-pdfkit draws staff lines /
         barlines / stems (must run AFTER forceNonNoteheadBlack so the resolved
         stroke reflects its color overrides). */
      inlineComputedStroke(svg);
      doc.addPage({ size: 'letter', margin: 0 });
      SVGtoPDF(doc, svg, 0, 0, {
        width: LETTER_PT_W,
        height: LETTER_PT_H,
        preserveAspectRatio: 'xMinYMin meet',
        fontCallback: pdfFontFor,
      });
    }
    doc.end();
    await ended;
    downloadBlob('hkc-' + isoStamp() + '.pdf', new Blob(chunks, { type: 'application/pdf' }));
  } finally {
    document.body.removeChild(host);
    /* getOptions() returns a JSON string; parse before restoring. */
    try { tk.setOptions(JSON.parse(savedOpts)); } catch { /* ignore */ }
    restore();
  }
}
