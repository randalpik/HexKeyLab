// File I/O for Composer:
//   - .hkc save/load (canonical MEI with HKL data-q/data-r attrs)
//   - .musicxml export (one-way, lossy — colors and lattice tags preserved
//     where the spec allows; advanced markings like dynamics aren't emitted
//     because the model doesn't carry them yet).
//
// Uses simple download/upload via Blob + <input type="file"> — no File System
// Access API yet.

import { ComposerModel } from './model.js';
import type { Voice, Duration, Dots } from './model.js';

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

const ACCID_TO_ALTER: Record<string, number> = {
  '':   0,
  'n':  0,
  's':  1,
  'f':  -1,
  'ss': 2,
  'ff': -2,
};

/* divisions per quarter — use 16 so we cover 32nd notes (= 2 divisions) and
   dotted 16ths (= 6) without fractional values. */
const DIVISIONS = 16;

function durationToTicks(dur: Duration, dots: Dots): number {
  const base = (DIVISIONS * 4) / parseInt(dur, 10);
  if (dots === 1) return base * 3 / 2;
  if (dots === 2) return base * 7 / 4;
  return base;
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
  /* Sounded accidental is whatever is currently displayed (@accid) OR the
     hidden gestural accidental (@accid.ges) left behind by the accidental
     display pass. MusicXML's <alter> needs the actual pitch, not the
     visual representation. */
  const accid = node.getAttribute('accid') ?? node.getAttribute('accid.ges') ?? '';
  const color = node.getAttribute('color') ?? undefined;
  const qStr = node.getAttribute('data-q');
  const rStr = node.getAttribute('data-r');
  const ties = readTieFlags(node);
  return {
    step: PNAME_TO_STEP[pname] ?? 'C',
    alter: ACCID_TO_ALTER[accid] ?? 0,
    octave: oct,
    color,
    q: qStr !== null ? parseInt(qStr, 10) : undefined,
    r: rStr !== null ? parseInt(rStr, 10) : undefined,
    tieStart: ties.tieStart,
    tieStop: ties.tieStop,
  };
}

function gatherEventsFromDoc(doc: Document): XmlNoteEvent[] {
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
        const local = child.localName;
        const dur = (child.getAttribute('dur') ?? '4') as Duration;
        const dots = parseInt(child.getAttribute('dots') ?? '0', 10) as Dots;
        if (isMeiElement(child, 'rest')) {
          out.push({
            notes: [],
            durTicks: durationToTicks(dur, dots),
            durName: DURATION_NAME[dur] ?? 'quarter',
            dots, staff: staff as 1 | 2, voice, measureIdx: mi,
          });
        } else if (isMeiElement(child, 'note')) {
          out.push({
            notes: [readNote(child)],
            durTicks: durationToTicks(dur, dots),
            durName: DURATION_NAME[dur] ?? 'quarter',
            dots, staff: staff as 1 | 2, voice, measureIdx: mi,
          });
        } else if (isMeiElement(child, 'chord')) {
          const noteEls = Array.from(child.children).filter((c) => c.localName === 'note');
          out.push({
            notes: noteEls.map((n) => readNote(n)),
            durTicks: durationToTicks(dur, dots),
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
  /* Layer may contain <beam> wrappers in the serialized MEI; flatten them. */
  const out: Element[] = [];
  for (const c of Array.from(layer.children)) {
    const ln = c.localName;
    if (ln === 'chord' || ln === 'note' || ln === 'rest') {
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
  const ts = model.getTimeSig();
  const tempo = model.getTempo();

  const events = gatherEventsFromDoc(doc);
  const measureCount = Math.max(1, doc.querySelectorAll('measure').length);

  /* Group events by (measure, voice). */
  const grouped: Record<number, Record<number, XmlNoteEvent[]>> = {};
  for (let mi = 0; mi < measureCount; mi++) {
    grouped[mi] = { 1: [], 2: [], 3: [], 4: [] };
  }
  for (const ev of events) grouped[ev.measureIdx][ev.voice].push(ev);

  /* Measure-tick budget under current meter. */
  const measureTicks = ts.count * DIVISIONS * 4 / ts.unit;

  let body = '';
  for (let mi = 0; mi < measureCount; mi++) {
    body += `  <measure number="${mi + 1}">\n`;

    if (mi === 0) {
      body += `    <attributes>\n`;
      body += `      <divisions>${DIVISIONS}</divisions>\n`;
      body += `      <key><fifths>${fifths}</fifths></key>\n`;
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
    /* Rest */
    return `    <note><rest/><duration>${ev.durTicks}</duration>` +
      `<voice>${ev.voice}</voice>${dotXml(ev.dots)}<type>${ev.durName}</type>` +
      `<staff>${ev.staff}</staff></note>\n`;
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
    s += `<staff>${ev.staff}</staff>`;
    if (n.color) s += `<notehead color="${escapeXml(n.color)}">normal</notehead>`;
    /* Engraving-layer ties. */
    if (n.tieStart || n.tieStop) {
      s += `<notations>`;
      if (n.tieStart) s += `<tied type="start"/>`;
      if (n.tieStop) s += `<tied type="stop"/>`;
      s += `</notations>`;
    }
    s += `</note>\n`;
  }
  return s;
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
