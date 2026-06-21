// MusicXML → .hkc/MEI import. The inverse of exportMusicXml (save.ts): parse a
// score-partwise MusicXML document (e.g. exported by Finale/MuseScore) into the
// MEI dialect ComposerModel consumes. The result is handed to
// `new ComposerModel(mei)` / applyLoadedDocument.
//
// On import the document is forced to Equal tuning, HEJI off, ignore-color on
// (the imported score is the input to a later JI-retuning workflow, out of
// scope here; the goal is faithful rendering).
//
// Pitch → (q, r) preserves the source's exact enharmonic spelling via
// coordForSpelling, with the comma-variant chosen relative to a key center that
// tracks the major-key root of the active key signature.

import {
  el, newId, escapeXml, MEI_NS,
  buildNoteElement, buildChordElement, buildRestElement,
  type NoteSpec, type Duration, type Dots,
} from '@hkl/notation/mei-build.js';
import { coordForSpelling } from '@hkl/notation/coord-spelling.js';
import { coordToMidi } from '@hkl/shared/freq.js';
import { keySigToTonic } from './notation/accidentals.js';
import { findTonicCoord } from './cursor/refNote.js';
import { setLayoutReq, setHejiEnabled, setIgnoreColor, addDynam, addHairpin } from './expressions.js';
import { addSlur } from './slurs.js';

/* ── small XML helpers ─────────────────────────────────────────────────────── */

const child = (parent: Element, tag: string): Element | null => {
  for (const c of Array.from(parent.children)) if (c.localName === tag) return c;
  return null;
};
const children = (parent: Element, tag: string): Element[] =>
  Array.from(parent.children).filter((c) => c.localName === tag);
const textOf = (parent: Element | null, tag: string): string =>
  parent ? (child(parent, tag)?.textContent?.trim() ?? '') : '';
const intOf = (parent: Element | null, tag: string, dflt: number): number => {
  const t = textOf(parent, tag);
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : dflt;
};

/* ── duration mapping ──────────────────────────────────────────────────────── */

const TYPE_TO_DUR: Record<string, Duration> = {
  whole: '1', half: '2', quarter: '4', eighth: '8',
  '16th': '16', '32nd': '32', '64th': '64',
};
/** MEI internal ticks (quarter = 16). */
const DUR_TICKS: Record<Duration, number> = {
  '1': 64, '2': 32, '4': 16, '8': 8, '16': 4, '32': 2, '64': 1,
};
function dottedTicks(dur: Duration, dots: Dots): number {
  const base = DUR_TICKS[dur];
  if (dots === 1) return base * 1.5;
  if (dots === 2) return base * 1.75;
  return base;
}

/** MusicXML <alter> integer → count-form accidental ('', 's', 'ff', 'sss', …). */
function alterToCount(alter: number): string {
  if (alter > 0) return 's'.repeat(alter);
  if (alter < 0) return 'f'.repeat(-alter);
  return '';
}

/** MusicXML <fifths> → HKL key-sig string ('0' | 'Ns' | 'Nf'). */
function fifthsToKeySig(fifths: number): string {
  if (fifths === 0) return '0';
  return fifths > 0 ? `${fifths}s` : `${-fifths}f`;
}

/* ── per-event model (one layer entry) ─────────────────────────────────────── */

interface ImpNote {
  spec: NoteSpec;
  tieStart: boolean;
  tieStop: boolean;
}

interface ImpEvent {
  kind: 'note' | 'chord' | 'rest';
  notes: ImpNote[];   // empty for rest
  dur: Duration;
  dots: Dots;
  /** Tuplet group boundaries (from <notations><tuplet type=start|stop>). */
  tupletStart?: { num: number; numbase: number };
  tupletStop?: boolean;
  /** Note-attached articulations: 'stacc' | 'acc' | 'ten'. */
  artics: string[];
  fermata: boolean;
  /** Slur level numbers starting / stopping at this event. */
  slurStart: number[];
  slurStop: number[];
  /** Built element (set during emission), for slur/fermata id wiring. */
  el?: Element;
}

/* ── clef ──────────────────────────────────────────────────────────────────── */

interface ClefSpec { shape: string; line: number; dis?: number; disPlace?: string }

function clefFromXml(clefEl: Element): ClefSpec {
  const shape = textOf(clefEl, 'sign') || 'G';
  const line = intOf(clefEl, 'line', shape === 'F' ? 4 : shape === 'C' ? 3 : 2);
  const oct = intOf(clefEl, 'clef-octave-change', 0);
  const spec: ClefSpec = { shape, line };
  if (oct === 1) { spec.dis = 8; spec.disPlace = 'above'; }
  else if (oct === -1) { spec.dis = 8; spec.disPlace = 'below'; }
  else if (oct === 2) { spec.dis = 15; spec.disPlace = 'above'; }
  else if (oct === -2) { spec.dis = 15; spec.disPlace = 'below'; }
  return spec;
}

/* ── per-part analysis ─────────────────────────────────────────────────────── */

interface PartInfo {
  name: string;
  measures: Element[];
  staffCount: number;
  /** part-local staff (1..staffCount) → global staff @n. */
  globalStaff: number[];      // index by localStaff (1-based)
  /** voice number → { localStaff, layer(1|2) }. */
  voiceMap: Map<number, { localStaff: number; layer: number }>;
  /** part-local staff → head clef. */
  headClef: Map<number, ClefSpec>;
  divisions: number;
}

/** Voice/staff usage scan: which voices appear on which staff, in order. */
function analyzePart(partEl: Element, name: string, globalStaffBase: number): PartInfo {
  const measures = children(partEl, 'measure');
  // staff count from first <attributes><staves>, else max <staff> seen, else 1.
  let staffCount = 1;
  let divisions = 24;
  const headClef = new Map<number, ClefSpec>();
  for (const m of measures) {
    const attrs = child(m, 'attributes');
    if (attrs) {
      const st = child(attrs, 'staves');
      if (st) staffCount = Math.max(staffCount, parseInt(st.textContent ?? '1', 10) || 1);
      const div = child(attrs, 'divisions');
      if (div) divisions = parseInt(div.textContent ?? '24', 10) || divisions;
      for (const cl of children(attrs, 'clef')) {
        const num = parseInt(cl.getAttribute('number') ?? '1', 10) || 1;
        if (!headClef.has(num)) headClef.set(num, clefFromXml(cl));
      }
    }
  }
  // voices-per-staff in first-appearance order.
  const voicesByStaff = new Map<number, number[]>();
  for (const m of measures) {
    for (const note of children(m, 'note')) {
      const ls = intOf(note, 'staff', 1);
      const v = intOf(note, 'voice', 1);
      staffCount = Math.max(staffCount, ls);
      const arr = voicesByStaff.get(ls) ?? [];
      if (!arr.includes(v)) { arr.push(v); voicesByStaff.set(ls, arr); }
    }
  }
  const globalStaff: number[] = [];
  for (let ls = 1; ls <= staffCount; ls++) globalStaff[ls] = globalStaffBase + ls - 1;
  const voiceMap = new Map<number, { localStaff: number; layer: number }>();
  for (let ls = 1; ls <= staffCount; ls++) {
    const vs = voicesByStaff.get(ls) ?? [];
    vs.forEach((v, i) => { if (i < 2) voiceMap.set(v, { localStaff: ls, layer: i + 1 }); });
  }
  // default clefs if missing.
  for (let ls = 1; ls <= staffCount; ls++) {
    if (!headClef.has(ls)) headClef.set(ls, { shape: ls === 1 ? 'G' : 'F', line: ls === 1 ? 2 : 4 });
  }
  return { name, measures, staffCount, globalStaff, voiceMap, headClef, divisions };
}

/* ── build a layer's events for one (part, measure, localStaff, layer) ──────── */

function buildEvents(
  measureEl: Element, part: PartInfo, localStaff: number, layer: number,
  centerQ: number, centerR: number,
): ImpEvent[] {
  // Which voice maps to (localStaff, layer)?
  let targetVoice: number | null = null;
  for (const [v, m] of part.voiceMap) {
    if (m.localStaff === localStaff && m.layer === layer) { targetVoice = v; break; }
  }
  if (targetVoice === null) return [];

  const events: ImpEvent[] = [];
  for (const note of children(measureEl, 'note')) {
    const ls = intOf(note, 'staff', 1);
    const v = intOf(note, 'voice', 1);
    if (v !== targetVoice || ls !== localStaff) continue;

    const isRest = child(note, 'rest') !== null;
    const isChordNote = child(note, 'chord') !== null;
    const typeName = textOf(note, 'type');
    const dur = TYPE_TO_DUR[typeName] ?? '4';
    const dots = (children(note, 'dot').length) as Dots;

    if (isChordNote && events.length > 0) {
      // Merge onto the previous event (note → chord). Tie/notations attach
      // per chord-note; articulations/slurs/fermata stay event-level.
      const prev = events[events.length - 1];
      const im = impNoteFromXml(note, centerQ, centerR);
      if (im) { prev.notes.push(im); prev.kind = 'chord'; }
      mergeNotations(note, prev);
      continue;
    }

    const im = isRest ? null : impNoteFromXml(note, centerQ, centerR);
    const ev: ImpEvent = {
      kind: isRest ? 'rest' : 'note',
      notes: im ? [im] : [],
      dur, dots, artics: [], fermata: false, slurStart: [], slurStop: [],
    };

    /* Tuplet boundaries from <notations><tuplet type=start|stop>. num/numbase
       come from <time-modification> (actual-notes / normal-notes). */
    const notations = child(note, 'notations');
    const tupletTag = notations ? children(notations, 'tuplet').find(Boolean) : null;
    if (tupletTag) {
      const ttype = tupletTag.getAttribute('type');
      if (ttype === 'start') {
        const tm = child(note, 'time-modification');
        ev.tupletStart = {
          num: tm ? intOf(tm, 'actual-notes', 3) : 3,
          numbase: tm ? intOf(tm, 'normal-notes', 2) : 2,
        };
      } else if (ttype === 'stop') {
        ev.tupletStop = true;
      }
    }
    mergeNotations(note, ev);
    events.push(ev);
  }
  return events;
}

/** Pull articulations / slurs / fermata off a <note>'s <notations> into the
 *  owning event (these are event-level, not per chord-note). */
function mergeNotations(note: Element, ev: ImpEvent): void {
  const notations = child(note, 'notations');
  if (!notations) return;
  const artics = child(notations, 'articulations');
  if (artics) {
    for (const a of Array.from(artics.children)) {
      if (a.localName === 'staccato') ev.artics.push('stacc');
      else if (a.localName === 'accent') ev.artics.push('acc');
      else if (a.localName === 'tenuto') ev.artics.push('ten');
    }
  }
  if (child(notations, 'fermata')) ev.fermata = true;
  for (const s of children(notations, 'slur')) {
    const num = parseInt(s.getAttribute('number') ?? '1', 10) || 1;
    const t = s.getAttribute('type');
    if (t === 'start') ev.slurStart.push(num);
    else if (t === 'stop') ev.slurStop.push(num);
  }
}

function impNoteFromXml(note: Element, centerQ: number, centerR: number): ImpNote | null {
  const pitch = child(note, 'pitch');
  if (!pitch) return null;
  const step = textOf(pitch, 'step');
  const alter = intOf(pitch, 'alter', 0);
  const octave = intOf(pitch, 'octave', 4);
  const coord = coordForSpelling(step, alter, octave, centerQ, centerR);
  if (!coord) return null;
  const [q, r] = coord;
  // Sounding tie (<tie type=...>) — match per chord-note for @tie intent.
  let tieStart = false, tieStop = false;
  for (const t of children(note, 'tie')) {
    if (t.getAttribute('type') === 'start') tieStart = true;
    else if (t.getAttribute('type') === 'stop') tieStop = true;
  }
  return {
    spec: {
      q, r,
      pname: step.toLowerCase() as NoteSpec['pname'],
      accid: alterToCount(alter),
      oct: octave,
      midi: coordToMidi(q, r),
      colorHex: '#000000',
    },
    tieStart, tieStop,
  };
}

/* ── element emission ──────────────────────────────────────────────────────── */

const TIE_VALUE = (start: boolean, stop: boolean): string | null =>
  start && stop ? 'm' : start ? 'i' : stop ? 't' : null;

/** Set @tie on a note element from ImpNote flags (normalizeTies derives the
 *  data-tie-partner links from flat-order adjacency on load). */
function applyTie(noteEl: Element, im: ImpNote): void {
  const v = TIE_VALUE(im.tieStart, im.tieStop);
  if (v) noteEl.setAttribute('tie', v);
}

/** Build a note/chord/rest element and apply per-note ties + articulations.
 *  Sets ev.el to the built element for downstream slur/fermata wiring. */
function eventToElement(doc: Document, ev: ImpEvent): Element {
  let element: Element;
  if (ev.kind === 'rest') {
    element = buildRestElement(doc, { duration: ev.dur, dots: ev.dots });
  } else if (ev.kind === 'chord' || ev.notes.length > 1) {
    element = buildChordElement(doc, { notes: ev.notes.map((n) => n.spec), duration: ev.dur, dots: ev.dots });
    /* Apply ties per chord-note (match built child by q,r). */
    const childNotes = Array.from(element.children).filter((c) => c.localName === 'note');
    for (const im of ev.notes) {
      const match = childNotes.find((c) =>
        c.getAttribute('data-q') === String(im.spec.q) && c.getAttribute('data-r') === String(im.spec.r));
      if (match) applyTie(match, im);
    }
  } else {
    element = buildNoteElement(doc, ev.notes[0].spec, ev.dur, ev.dots);
    applyTie(element, ev.notes[0]);
  }
  /* Articulations: <artic artic="…"> children of the note/chord. */
  for (const a of ev.artics) {
    const artic = el(doc, 'artic', { artic: a });
    element.appendChild(artic);
  }
  ev.el = element;
  return element;
}

interface SlurPair { startId: string; endId: string; voice: number }

/** Append a layer's events (wrapping tuplet runs in <tuplet>), attaching
 *  fermatas to the measure and collecting slur start/stop pairs per voice.
 *  A complete musical tuplet is self-contained — no trailing placeholder. */
function appendLayerChildren(
  doc: Document, layerEl: Element, events: ImpEvent[],
  measureEl: Element, voice: number,
  slurOpen: Map<number, string>, slurPairs: SlurPair[],
  fermataEls: Element[],
): void {
  const wire = (ev: ImpEvent): void => {
    const id = ev.el?.getAttribute('xml:id');
    if (!id || !ev.el) return;
    /* Fermata is appended to the measure in a post-pass (after <staff>s exist)
       — Verovio requires control events to follow the staff content. */
    if (ev.fermata) fermataEls.push(ev.el);
    for (const n of ev.slurStart) slurOpen.set(n, id);
    for (const n of ev.slurStop) {
      const startId = slurOpen.get(n);
      if (startId) { slurPairs.push({ startId, endId: id, voice }); slurOpen.delete(n); }
    }
  };

  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    if (ev.tupletStart) {
      const { num, numbase } = ev.tupletStart;
      const tuplet = el(doc, 'tuplet', {
        'xml:id': newId('t'), num: String(num), numbase: String(numbase),
        'bracket.visible': 'true', 'num.visible': 'true', 'num.format': 'count',
        'data-tuplet-atomic-dur': ev.dur,
      });
      let j = i;
      for (; j < events.length; j++) {
        tuplet.appendChild(eventToElement(doc, events[j]));
        wire(events[j]);
        if (events[j].tupletStop) break;
      }
      layerEl.appendChild(tuplet);
      i = j + 1;
    } else {
      layerEl.appendChild(eventToElement(doc, ev));
      wire(ev);
      i++;
    }
  }
}

/* ── directions: dynamics + hairpins (time-anchored via tstamp) ────────────── */

interface DynamRec { measureIdx: number; tstamp: number; staff: number; place: 'above' | 'below'; text: string }
interface HairpinRec {
  startMeasureIdx: number; startTstamp: number;
  endMeasureIdx: number; endTstamp: number;
  staff: number; place: 'above' | 'below'; form: 'cres' | 'dim';
}

/** Walk a part's measures in document order, tracking the beat position of each
 *  <direction>, and collect dynamics + hairpins. Wedges are paired across
 *  measures by their level number. */
function scanPartDirections(
  part: PartInfo,
  globalStaffOf: (localStaff: number) => number,
): { dynamics: DynamRec[]; hairpins: HairpinRec[] } {
  const dynamics: DynamRec[] = [];
  const hairpins: HairpinRec[] = [];
  /* open wedge per level number → its start moment + staff/place. */
  const openWedge = new Map<number, { mi: number; tstamp: number; staff: number; place: 'above' | 'below'; form: 'cres' | 'dim' }>();

  let divisions = part.divisions;
  let meterUnit = 4;

  part.measures.forEach((m, mi) => {
    const attrs = child(m, 'attributes');
    if (attrs) {
      const d = child(attrs, 'divisions');
      if (d) divisions = parseInt(d.textContent ?? '', 10) || divisions;
      const t = child(attrs, 'time');
      if (t) meterUnit = intOf(t, 'beat-type', meterUnit);
    }
    const ticksPerBeat = divisions * 4 / meterUnit;
    const tstampOf = (ticks: number): number => ticks / ticksPerBeat + 1;

    let cur = 0;
    for (const node of Array.from(m.children)) {
      const ln = node.localName;
      if (ln === 'note') {
        if (child(node, 'chord')) continue;          // chord note: no advance
        cur += intOf(node, 'duration', 0);
      } else if (ln === 'backup') {
        cur -= intOf(node, 'duration', 0);
      } else if (ln === 'forward') {
        cur += intOf(node, 'duration', 0);
      } else if (ln === 'direction') {
        const placement = node.getAttribute('placement');
        const place: 'above' | 'below' = placement === 'above' ? 'above' : 'below';
        const localStaff = intOf(node, 'staff', 1);
        const staff = globalStaffOf(localStaff);
        const tstamp = Math.max(1, tstampOf(cur));
        for (const dt of children(node, 'direction-type')) {
          const dyn = child(dt, 'dynamics');
          if (dyn) {
            const text = Array.from(dyn.children).map((c) => c.localName).join('');
            if (text) dynamics.push({ measureIdx: mi, tstamp, staff, place, text });
          }
          const wedge = child(dt, 'wedge');
          if (wedge) {
            const wtype = wedge.getAttribute('type');
            const num = parseInt(wedge.getAttribute('number') ?? '1', 10) || 1;
            if (wtype === 'crescendo' || wtype === 'diminuendo') {
              openWedge.set(num, { mi, tstamp, staff, place, form: wtype === 'crescendo' ? 'cres' : 'dim' });
            } else if (wtype === 'stop') {
              const w = openWedge.get(num);
              if (w) {
                hairpins.push({
                  startMeasureIdx: w.mi, startTstamp: w.tstamp,
                  endMeasureIdx: mi, endTstamp: tstamp,
                  staff: w.staff, place: w.place, form: w.form,
                });
                openWedge.delete(num);
              }
            }
          }
        }
      }
    }
  });
  return { dynamics, hairpins };
}

/** Tempo from the first <direction> with a <metronome> or <sound tempo>. */
function extractTempo(root: Element): { bpm: number; unit: Duration; dots: number; text: string } | null {
  for (const d of Array.from(root.querySelectorAll('direction'))) {
    const metro = d.querySelector('metronome');
    const sound = d.querySelector('sound[tempo]');
    if (!metro && !sound) continue;
    let bpm = 120; let unit: Duration = '4'; let dots = 0;
    if (metro) {
      const bu = metro.querySelector('beat-unit')?.textContent?.trim() ?? '';
      unit = TYPE_TO_DUR[bu] ?? '4';
      dots = metro.querySelectorAll('beat-unit-dot').length;
      const pm = metro.querySelector('per-minute')?.textContent?.trim();
      if (pm) bpm = parseInt(pm, 10) || bpm;
    }
    if (sound) { const v = parseInt(sound.getAttribute('tempo') ?? '', 10); if (Number.isFinite(v)) bpm = v; }
    const text = d.querySelector('direction-type > words')?.textContent?.trim() ?? '';
    return { bpm, unit, dots, text };
  }
  return null;
}

/* ── main ──────────────────────────────────────────────────────────────────── */

export function importMusicXml(xmlText: string): string {
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('Invalid MusicXML (parse error).');
  const root = xml.querySelector('score-partwise');
  if (!root) throw new Error('Unsupported MusicXML: expected <score-partwise>.');

  /* Metadata. */
  const workTitle = xml.querySelector('work > work-title')?.textContent?.trim();
  const movementTitle = xml.querySelector('movement-title')?.textContent?.trim();
  const title = workTitle || movementTitle || 'Imported Score';
  const composer = xml.querySelector('identification > creator[type="composer"]')
    ?.textContent?.trim() || '';

  /* Part names from <part-list>. */
  const partNames = new Map<string, string>();
  for (const sp of Array.from(xml.querySelectorAll('part-list > score-part'))) {
    const id = sp.getAttribute('id') ?? '';
    partNames.set(id, sp.querySelector('part-name')?.textContent?.trim() || id);
  }

  /* Analyze each part; assign global staff numbers sequentially. */
  const partEls = Array.from(root.querySelectorAll(':scope > part'));
  const parts: PartInfo[] = [];
  let staffBase = 1;
  for (const pe of partEls) {
    const id = pe.getAttribute('id') ?? '';
    const info = analyzePart(pe, partNames.get(id) ?? id, staffBase);
    parts.push(info);
    staffBase += info.staffCount;
  }

  /* Initial key / meter from the first part's first measure attributes. */
  const firstAttrs = parts[0]?.measures.map((m) => child(m, 'attributes')).find(Boolean) ?? null;
  const firstKey = firstAttrs ? child(firstAttrs, 'key') : null;
  const fifths = firstKey ? parseInt(textOf(firstKey, 'fifths') || '0', 10) : 0;
  const keyMode = (firstKey && textOf(firstKey, 'mode') === 'minor') ? 'minor' : 'major';
  const keySig = fifthsToKeySig(fifths);
  const firstTime = firstAttrs ? child(firstAttrs, 'time') : null;
  const meterCount = firstTime ? intOf(firstTime, 'beats', 4) : 4;
  const meterUnit = firstTime ? intOf(firstTime, 'beat-type', 4) : 4;
  const meterSym = firstTime?.getAttribute('symbol'); // 'common' | 'cut' | null

  /* Key center for the comma-variant tiebreak: the MAJOR-key root of the key
     signature (per design). Updated as we encounter key changes. */
  const centerFor = (f: number): { q: number; r: number } =>
    findTonicCoord(keySigToTonic(fifthsToKeySig(f), 'major'));
  let center = centerFor(fifths);

  /* ── build scoreDef staffGrp ──────────────────────────────────────────────
     Multiple parts → nested <staffGrp> per instrument; a single part → flat
     (root staffGrp holds the staffDefs directly), matching the model's
     implicit/explicit instrument shapes. */
  const clefAttrs = (c: ClefSpec): string =>
    ` clef.shape="${c.shape}" clef.line="${c.line}"` +
    (c.dis ? ` clef.dis="${c.dis}" clef.dis.place="${c.disPlace}"` : '');
  const staffDefXml = (gStaff: number, c: ClefSpec): string =>
    `<staffDef n="${gStaff}" lines="5"${clefAttrs(c)}/>`;

  let staffGrpInner: string;
  if (parts.length === 1) {
    const p = parts[0];
    staffGrpInner = Array.from({ length: p.staffCount }, (_, i) =>
      staffDefXml(p.globalStaff[i + 1], p.headClef.get(i + 1)!)).join('');
  } else {
    staffGrpInner = parts.map((p) => {
      const defs = Array.from({ length: p.staffCount }, (_, i) =>
        staffDefXml(p.globalStaff[i + 1], p.headClef.get(i + 1)!)).join('');
      return `<staffGrp hkl:instr="piano"><label>${escapeXml(p.name)}</label>${defs}</staffGrp>`;
    }).join('');
  }

  const composerBlock = composer
    ? `<respStmt><persName role="composer">${escapeXml(composer)}</persName></respStmt>` : '';
  const meterSymAttr = meterSym === 'cut' || meterSym === 'common' ? ` meter.sym="${meterSym}"` : '';

  const scaffold = `<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="${MEI_NS}" xmlns:hkl="https://hexkeylab.com/ns/mei" meiversion="5.0">
  <meiHead>
    <fileDesc>
      <titleStmt><title>${escapeXml(title)}</title>${composerBlock}</titleStmt>
      <pubStmt/>
    </fileDesc>
  </meiHead>
  <music><body><mdiv><score>
    <scoreDef key.sig="${keySig}" mode="${keyMode}" meter.count="${meterCount}" meter.unit="${meterUnit}"${meterSymAttr}>
      <staffGrp symbol="brace" bar.thru="true">${staffGrpInner}</staffGrp>
    </scoreDef>
    <section></section>
  </score></mdiv></body></music>
</mei>`;

  const doc = new DOMParser().parseFromString(scaffold, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Internal: failed to build MEI scaffold.');
  const section = doc.querySelector('section')!;

  /* All global staves in order. */
  const allStaves: number[] = [];
  for (const p of parts) for (let ls = 1; ls <= p.staffCount; ls++) allStaves.push(p.globalStaff[ls]);
  const partForStaff = (g: number): { part: PartInfo; localStaff: number } => {
    for (const p of parts) for (let ls = 1; ls <= p.staffCount; ls++)
      if (p.globalStaff[ls] === g) return { part: p, localStaff: ls };
    return { part: parts[0], localStaff: 1 };
  };

  const measureCount = Math.max(...parts.map((p) => p.measures.length));

  /* Global voice for (globalStaff, layer): staves contribute 2 voices each in
     order, so voice = (staff-1)*2 + layer. Slur state persists per voice. */
  const voiceFor = (gStaff: number, layer: number): number => (gStaff - 1) * 2 + layer;
  const slurOpenByVoice = new Map<number, Map<number, string>>();
  const slurPairs: SlurPair[] = [];
  const fermataEls: Element[] = [];

  /* Running notation state for mid-piece change detection. */
  let runKeySig = keySig, runMode = keyMode, runCount = meterCount, runUnit = meterUnit;
  let runSym = meterSym === 'cut' || meterSym === 'common' ? meterSym : '';
  const runClef = new Map<number, ClefSpec>();   // global staff → clef
  for (const g of allStaves) runClef.set(g, partForStaff(g).part.headClef.get(partForStaff(g).localStaff)!);

  const clefEqual = (a: ClefSpec, b: ClefSpec): boolean =>
    a.shape === b.shape && a.line === b.line && (a.dis ?? 0) === (b.dis ?? 0) && (a.disPlace ?? '') === (b.disPlace ?? '');

  for (let mi = 0; mi < measureCount; mi++) {
    /* Read this measure's declared key/meter (from the first part that has
       attributes — parts agree on global key/meter). */
    let mFifths: number | null = null, mMode: string | null = null;
    let mCount: number | null = null, mUnit: number | null = null, mSym: string | null = null;
    for (const p of parts) {
      const attrs = p.measures[mi] ? child(p.measures[mi], 'attributes') : null;
      if (!attrs) continue;
      const k = child(attrs, 'key');
      if (k && mFifths === null) { mFifths = parseInt(textOf(k, 'fifths') || '0', 10); mMode = textOf(k, 'mode') === 'minor' ? 'minor' : 'major'; }
      const t = child(attrs, 'time');
      if (t && mCount === null) { mCount = intOf(t, 'beats', 4); mUnit = intOf(t, 'beat-type', 4); mSym = t.getAttribute('symbol'); }
    }
    if (mFifths !== null) center = centerFor(mFifths);

    /* In-section <scoreDef> for a key and/or meter change after measure 0. */
    if (mi > 0) {
      const newKeySig = mFifths !== null ? fifthsToKeySig(mFifths) : runKeySig;
      const newMode = mMode ?? runMode;
      const keyChanged = newKeySig !== runKeySig || newMode !== runMode;
      const newCount = mCount ?? runCount, newUnit = mUnit ?? runUnit;
      const newSym = mCount !== null ? (mSym === 'cut' || mSym === 'common' ? mSym : '') : runSym;
      const meterChanged = mCount !== null && (newCount !== runCount || newUnit !== runUnit || newSym !== runSym);
      if (keyChanged || meterChanged) {
        const sd = el(doc, 'scoreDef', {});
        if (keyChanged) { sd.setAttribute('key.sig', newKeySig); sd.setAttribute('mode', newMode); }
        if (meterChanged) {
          sd.setAttribute('meter.count', String(newCount));
          sd.setAttribute('meter.unit', String(newUnit));
          if (newSym) sd.setAttribute('meter.sym', newSym);
        }
        section.appendChild(sd);
        runKeySig = newKeySig; runMode = newMode; runCount = newCount; runUnit = newUnit; runSym = newSym;
      }
    }

    const measureEl = el(doc, 'measure', { n: String(mi + 1), 'xml:id': newId('m') });
    if (mi === measureCount - 1) measureEl.setAttribute('right', 'end');

    /* Pickup: implicit="yes" on a part's measure → reduced tick budget. */
    const implicit = parts.some((p) => p.measures[mi]?.getAttribute('implicit') === 'yes');
    if (implicit) {
      // budget = max filled ticks across this measure's layers.
      let maxTicks = 0;
      for (const g of allStaves) {
        const { part, localStaff } = partForStaff(g);
        const pm = part.measures[mi];
        if (!pm) continue;
        for (const layer of [1, 2]) {
          const evs = buildEvents(pm, part, localStaff, layer, center.q, center.r);
          const t = evs.reduce((s, e) => s + dottedTicks(e.dur, e.dots), 0);
          maxTicks = Math.max(maxTicks, t);
        }
      }
      if (maxTicks > 0) measureEl.setAttributeNS('https://hexkeylab.com/ns/mei', 'hkl:pickup-ticks', String(maxTicks));
    }

    for (const g of allStaves) {
      const { part, localStaff } = partForStaff(g);
      const pm = part.measures[mi];
      const staffEl = el(doc, 'staff', { n: String(g), 'xml:id': newId('s') });

      /* Mid-piece clef change: inline <clef> at the head of layer 1 when this
         measure's attributes declare a clef differing from the running one. */
      let clefChange: ClefSpec | null = null;
      if (mi > 0 && pm) {
        const attrs = child(pm, 'attributes');
        const cl = attrs ? children(attrs, 'clef').find((c) => (parseInt(c.getAttribute('number') ?? '1', 10) || 1) === localStaff) : null;
        if (cl) {
          const spec = clefFromXml(cl);
          if (!clefEqual(spec, runClef.get(g)!)) { clefChange = spec; runClef.set(g, spec); }
        }
      }

      for (const layer of [1, 2]) {
        const layerEl = el(doc, 'layer', { n: String(layer), 'xml:id': newId('l') });
        if (layer === 1 && clefChange) {
          layerEl.appendChild(el(doc, 'clef', {
            shape: clefChange.shape, line: clefChange.line,
            dis: clefChange.dis, 'dis.place': clefChange.disPlace,
          }));
        }
        if (pm) {
          const voice = voiceFor(g, layer);
          let slurOpen = slurOpenByVoice.get(voice);
          if (!slurOpen) { slurOpen = new Map(); slurOpenByVoice.set(voice, slurOpen); }
          const evs = buildEvents(pm, part, localStaff, layer, center.q, center.r);
          appendLayerChildren(doc, layerEl, evs, measureEl, voice, slurOpen, slurPairs, fermataEls);
        }
        staffEl.appendChild(layerEl);
      }
      measureEl.appendChild(staffEl);
    }
    section.appendChild(measureEl);
  }

  /* Tempo: from the first <direction> carrying <metronome> or <sound tempo>.
     Carry the words text (e.g. "Moderato con passione"). */
  const tempo = extractTempo(root);
  if (tempo) {
    const firstMeasure = doc.querySelector('measure');
    if (firstMeasure) {
      const tEl = el(doc, 'tempo', {
        tstamp: 1, staff: 1, mm: tempo.bpm, 'mm.unit': tempo.unit,
        'mm.dots': tempo.dots > 0 ? tempo.dots : undefined, 'midi.bpm': tempo.bpm,
      });
      tEl.textContent = tempo.text ? tempo.text + ' ' : '';
      firstMeasure.insertBefore(tEl, firstMeasure.firstChild);
    }
  }

  /* Resolve slurs now that all note elements are attached to the document. */
  for (const p of slurPairs) addSlur(doc, p.startId, p.endId, p.voice);

  /* Fermatas: appended after the measure's <staff>s (Verovio control-event
     ordering requirement). */
  for (const noteEl of fermataEls) {
    const id = noteEl.getAttribute('xml:id');
    const measure = noteEl.closest('measure');
    if (id && measure) measure.appendChild(el(doc, 'fermata', { 'xml:id': newId('f'), startid: '#' + id }));
  }

  /* Dynamics + hairpins (time-anchored), per part. */
  for (const part of parts) {
    const globalStaffOf = (ls: number): number => part.globalStaff[Math.min(Math.max(ls, 1), part.staffCount)];
    const { dynamics, hairpins } = scanPartDirections(part, globalStaffOf);
    for (const d of dynamics) {
      addDynam(doc, { measureIdx: d.measureIdx, tstamp: d.tstamp }, { text: d.text, place: d.place, staff: d.staff });
    }
    for (const h of hairpins) {
      addHairpin(doc,
        { measureIdx: h.startMeasureIdx, tstamp: h.startTstamp },
        { measureIdx: h.endMeasureIdx, tstamp: h.endTstamp },
        { form: h.form, place: h.place, staff: h.staff });
    }
  }

  /* Forced import settings. */
  setLayoutReq(doc, { tuningMode: 'E', refQ: 0, refR: 0 });
  setHejiEnabled(doc, false);
  setIgnoreColor(doc, true);

  return new XMLSerializer().serializeToString(doc);
}
