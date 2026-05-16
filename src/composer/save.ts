// File I/O for Composer:
//   - .hkc save/load (canonical MEI with HKL data-q/data-r attrs)
//   - .musicxml export (one-way, lossy — colors and lattice tags preserved
//     where the spec allows; advanced markings like tempo/dynamics aren't
//     emitted because the model doesn't carry them yet).
//
// Uses simple download/upload via Blob + <input type="file"> — no File System
// Access API yet. Switching to FSA for "live-write to a file" is a v2 concern.

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

interface XmlNoteSpec {
  step: string;
  alter: number;
  octave: number;
  color?: string;
  q?: number;
  r?: number;
}

interface XmlNoteEvent {
  notes: XmlNoteSpec[]; /* empty = rest */
  durTicks: number;
  durName: string;
  dots: number;
  staff: 1 | 2;
  voice: number; /* MusicXML voice number, 1..4 globally */
}

function gatherEvents(model: ComposerModel): XmlNoteEvent[] {
  /* For each of the 4 voices, walk the layer's children, produce ordered
     XmlNoteEvents. v1 has a single measure. */
  const out: XmlNoteEvent[] = [];
  for (let voice: Voice = 1; voice <= 4; voice = (voice + 1) as Voice) {
    const len = model.getVoiceLength(voice);
    const staff = (voice <= 2) ? 1 : 2;
    for (let i = 0; i < len; i++) {
      const id = model.getElementIdAt(voice, i);
      if (id === null) continue;
      const ev = readElement(model, id, voice, staff);
      if (ev) out.push(ev);
    }
    if (voice === 4) break;
  }
  return out;
}

function readElement(
  model: ComposerModel, meiId: string, voice: Voice, staff: 1 | 2,
): XmlNoteEvent | null {
  /* Round-trip via the serialized XML — keeps reading concerns out of the
     model class itself. */
  const xml = model.serialize();
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const node = doc.querySelector('[*|id="' + meiId + '"]')
    ?? doc.querySelector('[id="' + meiId + '"]');
  if (!node) return null;
  const local = node.localName;
  if (local === 'rest') {
    const dur = (node.getAttribute('dur') ?? '4') as Duration;
    const dots = parseInt(node.getAttribute('dots') ?? '0', 10) as Dots;
    return {
      notes: [],
      durTicks: durationToTicks(dur, dots),
      durName: DURATION_NAME[dur] ?? 'quarter',
      dots,
      staff,
      voice,
    };
  }
  if (local === 'note') {
    const dur = (node.getAttribute('dur') ?? '4') as Duration;
    const dots = parseInt(node.getAttribute('dots') ?? '0', 10) as Dots;
    return {
      notes: [readNote(node)],
      durTicks: durationToTicks(dur, dots),
      durName: DURATION_NAME[dur] ?? 'quarter',
      dots,
      staff,
      voice,
    };
  }
  if (local === 'chord') {
    const dur = (node.getAttribute('dur') ?? '4') as Duration;
    const dots = parseInt(node.getAttribute('dots') ?? '0', 10) as Dots;
    const notes: XmlNoteSpec[] = [];
    for (const child of Array.from(node.children)) {
      if (child.localName === 'note') notes.push(readNote(child));
    }
    return {
      notes,
      durTicks: durationToTicks(dur, dots),
      durName: DURATION_NAME[dur] ?? 'quarter',
      dots,
      staff,
      voice,
    };
  }
  return null;
}

function readNote(node: Element): XmlNoteSpec {
  const pname = node.getAttribute('pname') ?? 'c';
  const oct = parseInt(node.getAttribute('oct') ?? '4', 10);
  const accid = node.getAttribute('accid') ?? '';
  const color = node.getAttribute('color') ?? undefined;
  const qStr = node.getAttribute('data-q');
  const rStr = node.getAttribute('data-r');
  return {
    step: PNAME_TO_STEP[pname] ?? 'C',
    alter: ACCID_TO_ALTER[accid] ?? 0,
    octave: oct,
    color,
    q: qStr !== null ? parseInt(qStr, 10) : undefined,
    r: rStr !== null ? parseInt(rStr, 10) : undefined,
  };
}

export function exportMusicXml(model: ComposerModel, title = 'Untitled'): string {
  const events = gatherEvents(model);

  /* Group events by voice for emission. MusicXML wants per-voice streams
     within the measure, separated by <backup> to re-zero the voice clock. */
  const byVoice: Record<number, XmlNoteEvent[]> = { 1: [], 2: [], 3: [], 4: [] };
  for (const ev of events) byVoice[ev.voice].push(ev);

  /* Compute voice durations (in ticks) so backups land on correct offsets. */
  const voiceTicks: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const ev of events) voiceTicks[ev.voice] += ev.durTicks;

  /* Measure length = max voice length (for a single-measure v1 we just pad). */
  const measureTicks = Math.max(voiceTicks[1], voiceTicks[2], voiceTicks[3], voiceTicks[4], DIVISIONS * 4);

  let body = '';
  body += `  <measure number="1">\n`;
  body += `    <attributes>\n`;
  body += `      <divisions>${DIVISIONS}</divisions>\n`;
  body += `      <key><fifths>0</fifths></key>\n`;
  body += `      <time><beats>4</beats><beat-type>4</beat-type></time>\n`;
  body += `      <staves>2</staves>\n`;
  body += `      <clef number="1"><sign>G</sign><line>2</line></clef>\n`;
  body += `      <clef number="2"><sign>F</sign><line>4</line></clef>\n`;
  body += `    </attributes>\n`;

  /* Emit voice 1, then backup+voice2, then backup+voice3, then backup+voice4.
     If a voice is short of measureTicks, pad with a hidden rest at end. */
  for (let voice = 1 as 1 | 2 | 3 | 4; voice <= 4; voice = (voice + 1) as 1 | 2 | 3 | 4) {
    if (voice > 1) body += `    <backup><duration>${voiceTicks[voice - 1]}</duration></backup>\n`;
    for (const ev of byVoice[voice]) body += emitEventXml(ev);
    /* Pad to measure end if needed (so subsequent backup is correct). */
    const remaining = measureTicks - voiceTicks[voice];
    if (remaining > 0) {
      body += `    <note><rest/><duration>${remaining}</duration><staff>${voice <= 2 ? 1 : 2}</staff><voice>${voice}</voice></note>\n`;
      voiceTicks[voice] = measureTicks;
    }
    if (voice === 4) break;
  }
  body += `  </measure>\n`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.0">
  <work><work-title>${escapeXml(title)}</work-title></work>
  <identification>
    <creator type="composer">HKL Composer</creator>
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
  /* Note or chord — emit one <note> per pitch, with <chord/> on the
     second-onward members. */
  let s = '';
  for (let i = 0; i < ev.notes.length; i++) {
    const n = ev.notes[i];
    s += `    <note>`;
    if (i > 0) s += `<chord/>`;
    s += `<pitch><step>${n.step}</step>`;
    if (n.alter !== 0) s += `<alter>${n.alter}</alter>`;
    s += `<octave>${n.octave}</octave></pitch>`;
    s += `<duration>${ev.durTicks}</duration>`;
    s += `<voice>${ev.voice}</voice>`;
    s += `${dotXml(ev.dots)}`;
    s += `<type>${ev.durName}</type>`;
    s += `<staff>${ev.staff}</staff>`;
    if (n.color) s += `<notehead color="${escapeXml(n.color)}">normal</notehead>`;
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

export function downloadMusicXml(model: ComposerModel, title = 'Untitled'): void {
  const xml = exportMusicXml(model, title);
  const filename = 'hkc-' + isoStamp() + '.musicxml';
  downloadBlob(filename, new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }));
}
