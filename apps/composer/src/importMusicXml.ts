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
import { setLayoutReq, setHejiEnabled, setIgnoreColor, addDynam, addHairpin, addDir } from './expressions.js';
import { addSlur } from './slurs.js';
import { realTicks } from './model/ticks.js';
import { decomposeBeatAlignedRests } from './model/restfill.js';
import { naturalBeatGroupStarts, type TimeSigInfo } from './notation/beams.js';

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
  /** Diamond notehead (<notehead>diamond) → string harmonic. */
  harmonic?: boolean;
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
  /** <ornaments><trill-mark> → note-attached <trill> (with/without wavy-line). */
  trill?: boolean;
  /** <ornaments><tremolo type=...> beams-count. 'single' = bowed (bTrem);
   *  'start'/'stop' = fingered two-note tremolo (fTrem) over the pair. */
  tremolo?: { type: 'single' | 'start' | 'stop'; beams: number };
  /** A full-measure rest (<rest measure="yes"/>): expanded to meter-filling
   *  rests at emission (the source carries no <type>). */
  measureRest?: boolean;
  /** Did the source start a new beam at this event? Derived from
   *  <beam number="1"> (begin/absent = true; continue/end = false). Consulted
   *  only for beamable events by the post-build beam-diff pass. */
  finaleBeamStart?: boolean;
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

/** Every clef declared in a measure's `<attributes>` blocks, keyed by clef
 *  `number` (= local staff), each with its document-order tick position (in MEI
 *  ticks, quarter = 16). A measure can carry several `<attributes>` — a clef in
 *  a later one is a mid-measure change, NOT a measure-head clef. */
function scanMeasureClefs(measureEl: Element, divisions: number): Map<number, { meiTick: number; spec: ClefSpec }[]> {
  const out = new Map<number, { meiTick: number; spec: ClefSpec }[]>();
  let cur = 0;
  for (const node of Array.from(measureEl.children)) {
    const ln = node.localName;
    if (ln === 'attributes') {
      for (const cl of children(node, 'clef')) {
        const num = parseInt(cl.getAttribute('number') ?? '1', 10) || 1;
        const meiTick = divisions > 0 ? Math.round(cur * 16 / divisions) : 0;
        const arr = out.get(num) ?? [];
        arr.push({ meiTick, spec: clefFromXml(cl) });
        out.set(num, arr);
      }
    } else if (ln === 'note') {
      if (child(node, 'chord')) continue;     // chord note shares the prior onset
      cur += intOf(node, 'duration', 0);
    } else if (ln === 'backup') {
      cur -= intOf(node, 'duration', 0);
    } else if (ln === 'forward') {
      cur += intOf(node, 'duration', 0);
    }
  }
  return out;
}

/** Insert inline `<clef>` elements into a (layer-1) layer at their tick
 *  positions: before the first child whose cumulative start-tick reaches the
 *  clef's tick (tick 0 → layer head). A clef inside a long note lands just
 *  before the following event. The beam pass treats `<clef>` as a break. */
function insertClefsIntoLayer(doc: Document, layerEl: Element, clefs: { meiTick: number; spec: ClefSpec }[]): void {
  for (const { meiTick, spec } of [...clefs].sort((a, b) => a.meiTick - b.meiTick)) {
    const clefEl = el(doc, 'clef', {
      shape: spec.shape, line: spec.line, dis: spec.dis, 'dis.place': spec.disPlace,
    });
    if (meiTick <= 0) { layerEl.insertBefore(clefEl, layerEl.firstChild); continue; }
    let t = 0;
    let target: Element | null = null;
    for (const c of Array.from(layerEl.children)) {
      if (c.localName === 'clef') continue;
      if (t >= meiTick) { target = c; break; }
      t += realTicks(c);
    }
    layerEl.insertBefore(clefEl, target);   // target null → appended at end
  }
}

/** Minimal TimeSigInfo for rest-fill / meter math (no additive beat-groups). */
function makeTimeSig(count: number, unit: number): TimeSigInfo {
  return {
    count, unit,
    isCompound: unit >= 8 && count >= 6 && count % 3 === 0,
    is4_4: count === 4 && unit === 4,
    beatGroups: null,
  };
}

/** Measure tick capacities that map to a single rest glyph (≤ whole note). An
 *  empty measure is conventionally one rest; we use a whole rest when the
 *  capacity is exactly a whole note, else the largest single dotted rest that
 *  fits the meter, falling back to a beat-aligned fill for odd meters. */
const FULL_MEASURE_REST: Record<number, { dur: Duration; dots: Dots }> = {
  64: { dur: '1', dots: 0 },   /* 4/4, 2/2 → whole rest */
  48: { dur: '2', dots: 1 },   /* 3/4, 6/8 → dotted half */
  32: { dur: '2', dots: 0 },   /* 2/4 → half */
  24: { dur: '4', dots: 1 },   /* 3/8 → dotted quarter */
  16: { dur: '4', dots: 0 },   /* 1/4 → quarter */
};

/** A layer that is exactly one full-measure rest (`<rest measure="yes"/>`, which
 *  carries no `<type>`) → a meter-filling rest. Otherwise unchanged. */
function expandMeasureRests(evs: ImpEvent[], count: number, unit: number): ImpEvent[] {
  if (evs.length !== 1 || !evs[0].measureRest) return evs;
  const measureTicks = count * (64 / unit);
  const single = FULL_MEASURE_REST[measureTicks];
  const pieces = single ? [single] : decomposeBeatAlignedRests(0, measureTicks, makeTimeSig(count, unit));
  if (pieces.length === 0) return evs;
  return pieces.map((p) => ({
    kind: 'rest' as const, notes: [], dur: p.dur, dots: p.dots,
    artics: [], fermata: false, slurStart: [], slurStop: [],
  }));
}

/** Beamable predicate matching beams.ts: a note/chord whose @dur denominator
 *  is >= 8 (eighth or shorter). */
function isBeamableElement(c: Element): boolean {
  if (c.localName !== 'note' && c.localName !== 'chord') return false;
  const denom = parseInt(c.getAttribute('dur') ?? '', 10);
  return Number.isFinite(denom) && denom >= 8;
}

/** Reproduce the source's beam grouping by diffing it against our auto-beamer.
 *  For each adjacent beamable pair in a layer with nothing between them that
 *  would break the run anyway (rest, quarter+, clef, tuplet, tremolo), set
 *  `@hkl-beam-break` iff the natural beat boundary disagrees with the source's
 *  "starts a new beam" flag (stashed as `data-imp-beamstart` during emission).
 *  The serializer XORs the marker against the natural boundary, so the result
 *  matches the source — mid-beat breaks AND cross-beat joins. */
function applyBeamMarkers(doc: Document): void {
  for (const layer of Array.from(doc.querySelectorAll('layer'))) {
    const naturalStarts = naturalBeatGroupStarts(doc, layer);
    let prevBeamable: Element | null = null;
    let clefSince = false;
    for (const c of Array.from(layer.children)) {
      const ln = c.localName;
      if (ln === 'clef') { clefSince = true; continue; }
      if (ln === 'note' || ln === 'chord' || ln === 'rest') {
        const beamable = isBeamableElement(c);
        if (beamable && prevBeamable && !clefSince) {
          const sourceStart = c.getAttribute('data-imp-beamstart') === '1';
          if (naturalStarts.has(c) !== sourceStart) c.setAttribute('hkl-beam-break', 'true');
        }
        prevBeamable = beamable ? c : null;
        clefSince = false;
        continue;
      }
      /* tuplet / fTrem / bTrem / space / etc. break the layer-level run. */
      prevBeamable = null;
      clefSince = false;
    }
  }
  /* Strip the temp flag everywhere (incl. tuplet/tremolo-internal notes). */
  for (const e of Array.from(doc.querySelectorAll('[data-imp-beamstart]'))) {
    e.removeAttribute('data-imp-beamstart');
  }
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

    const restEl = child(note, 'rest');
    const isRest = restEl !== null;
    const isMeasureRest = restEl?.getAttribute('measure') === 'yes';
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
    if (isMeasureRest) ev.measureRest = true;
    /* Source beam-start for the diff-based beam pass: <beam number="1"> value
       of `begin` (or absent) starts a new beam; `continue`/`end` joins prev. */
    const beam1 = children(note, 'beam').find((b) => (b.getAttribute('number') ?? '1') === '1');
    const beamVal = beam1?.textContent?.trim() ?? '';
    ev.finaleBeamStart = beamVal === '' || beamVal === 'begin';

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
  /* Ornaments: trill (trill-mark / wavy-line start) and tremolo (single =
     bowed/bTrem; start+stop pair = fingered/fTrem). */
  const ornaments = child(notations, 'ornaments');
  if (ornaments) {
    const hasWavyStart = children(ornaments, 'wavy-line').some((w) => w.getAttribute('type') === 'start');
    if (child(ornaments, 'trill-mark') || hasWavyStart) ev.trill = true;
    const trem = child(ornaments, 'tremolo');
    if (trem) {
      const ty = (trem.getAttribute('type') ?? 'single');
      const type = (ty === 'start' || ty === 'stop') ? ty : 'single';
      const beams = parseInt(trem.textContent?.trim() ?? '3', 10) || 3;
      ev.tremolo = { type, beams };
    }
  }
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
  // Diamond notehead → string harmonic (Finale encodes harmonics this way,
  // not as <technical><harmonic>).
  const harmonic = child(note, 'notehead')?.textContent?.trim() === 'diamond';
  return {
    spec: {
      q, r,
      pname: step.toLowerCase() as NoteSpec['pname'],
      accid: alterToCount(alter),
      oct: octave,
      midi: coordToMidi(q, r),
      colorHex: '#000000',
    },
    tieStart, tieStop, harmonic,
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
    /* Apply ties + harmonic per chord-note (match built child by q,r). */
    const childNotes = Array.from(element.children).filter((c) => c.localName === 'note');
    for (const im of ev.notes) {
      const match = childNotes.find((c) =>
        c.getAttribute('data-q') === String(im.spec.q) && c.getAttribute('data-r') === String(im.spec.r));
      if (match) { applyTie(match, im); if (im.harmonic) applyHarmonic(element, match); }
    }
  } else {
    element = buildNoteElement(doc, ev.notes[0].spec, ev.dur, ev.dots);
    applyTie(element, ev.notes[0]);
    if (ev.notes[0].harmonic) applyHarmonic(element, element);
  }
  /* Articulations: <artic artic="…"> children of the note/chord. */
  for (const a of ev.artics) {
    const artic = el(doc, 'artic', { artic: a });
    element.appendChild(artic);
  }
  /* Temp marker for the post-build beam-diff pass; stripped before serialize. */
  if (ev.kind !== 'rest' && ev.finaleBeamStart !== undefined) {
    element.setAttribute('data-imp-beamstart', ev.finaleBeamStart ? '1' : '0');
  }
  ev.el = element;
  return element;
}

/** Mark a string-harmonic note: open diamond notehead on the note + the
 *  playback flag on its slot (note or enclosing chord). Mirrors
 *  ComposerModel.toggleHarmonicAtCursor. */
function applyHarmonic(slot: Element, noteEl: Element): void {
  noteEl.setAttribute('head.shape', 'diamond');
  noteEl.setAttribute('head.fill', 'void');
  slot.setAttribute('data-hkl-harmonic', 'true');
}

interface SlurPair { startId: string; endId: string; voice: number }

/** Append a layer's events (wrapping tuplet runs in <tuplet>), attaching
 *  fermatas to the measure and collecting slur start/stop pairs per voice.
 *  A complete musical tuplet is self-contained — no trailing placeholder. */
function appendLayerChildren(
  doc: Document, layerEl: Element, events: ImpEvent[],
  measureEl: Element, voice: number,
  slurOpen: Map<number, string>, slurPairs: SlurPair[],
  fermataEls: Element[], trillEls: Element[],
): void {
  const wire = (ev: ImpEvent): void => {
    const id = ev.el?.getAttribute('xml:id');
    if (!id || !ev.el) return;
    /* Fermata + trill are appended to the measure in a post-pass (after
       <staff>s exist) — Verovio requires control events to follow staff
       content. */
    if (ev.fermata) fermataEls.push(ev.el);
    if (ev.trill) trillEls.push(ev.el);
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
    } else if (ev.tremolo?.type === 'start' && events[i + 1]?.tremolo?.type === 'stop') {
      /* Fingered two-note tremolo: wrap the start/stop pair in <fTrem>. Each
         note is already DRAWN at the combined value by the source; the tremolo
         occupies one note's written duration (see ticks.ts writtenTicks). */
      const next = events[i + 1];
      const n = ev.tremolo.beams;
      const fTrem = el(doc, 'fTrem', { 'xml:id': newId('ftrem'), beams: String(n), 'beams.float': String(n) });
      fTrem.appendChild(eventToElement(doc, ev)); wire(ev);
      fTrem.appendChild(eventToElement(doc, next)); wire(next);
      layerEl.appendChild(fTrem);
      i += 2;
    } else if (ev.tremolo?.type === 'single') {
      /* Bowed single-note tremolo → <bTrem> with stem slashes. */
      const bTrem = el(doc, 'bTrem', { 'xml:id': newId('btrem') });
      const noteEl = eventToElement(doc, ev);
      noteEl.setAttribute('stem.mod', `${ev.tremolo.beams}slash`);
      bTrem.appendChild(noteEl); wire(ev);
      layerEl.appendChild(bTrem);
      i++;
    } else {
      layerEl.appendChild(eventToElement(doc, ev));
      wire(ev);
      i++;
    }
  }
}

/* ── directions: dynamics + hairpins (time-anchored via tstamp) ────────────── */

interface DynamRec { measureIdx: number; tstamp: number; staff: number; place: 'above' | 'below'; text: string }
interface DirRec { measureIdx: number; tstamp: number; staff: number; place: 'above' | 'below'; text: string; italic: boolean }
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
): { dynamics: DynamRec[]; hairpins: HairpinRec[]; dirs: DirRec[] } {
  const dynamics: DynamRec[] = [];
  const hairpins: HairpinRec[] = [];
  const dirs: DirRec[] = [];
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
          /* Free expressive text (pizz., dim., espressivo, …) → <dir>. Skip the
             tempo direction's words, which extractTempo already bakes in. */
          const isTempoDir = node.querySelector('metronome') !== null
            || node.querySelector('sound[tempo]') !== null;
          if (!isTempoDir) {
            for (const w of children(dt, 'words')) {
              const wtext = w.textContent?.trim() ?? '';
              if (wtext) {
                dirs.push({
                  measureIdx: mi, tstamp, staff, place, text: wtext,
                  italic: w.getAttribute('font-style') === 'italic',
                });
              }
            }
          }
        }
      }
    }
  });
  return { dynamics, hairpins, dirs };
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
  const trillEls: Element[] = [];

  /* Running notation state for mid-piece change detection. */
  let runKeySig = keySig, runMode = keyMode, runCount = meterCount, runUnit = meterUnit;
  let runSym = meterSym === 'cut' || meterSym === 'common' ? meterSym : '';
  const runClef = new Map<number, ClefSpec>();   // global staff → clef
  for (const g of allStaves) runClef.set(g, partForStaff(g).part.headClef.get(partForStaff(g).localStaff)!);
  const runDivisions = new Map<PartInfo, number>();   // part → divisions in effect
  for (const p of parts) runDivisions.set(p, p.divisions);

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

    /* Track per-part divisions (a measure's <divisions> applies from here on) —
       needed to convert mid-measure clef tick positions to MEI ticks. */
    for (const p of parts) {
      const attrs = p.measures[mi] ? child(p.measures[mi], 'attributes') : null;
      const dv = attrs ? child(attrs, 'divisions') : null;
      if (dv) { const n = parseInt(dv.textContent ?? '', 10); if (Number.isFinite(n) && n > 0) runDivisions.set(p, n); }
    }

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

      /* Clef changes in this measure for this staff, in document (tick) order.
         A measure-head clef equal to the running clef (e.g. the head clef
         repeated) is dropped; the remaining changes become inline <clef> at
         their tick position in layer 1 — handling BOTH measure-head changes
         and true mid-measure changes (a clef in a later <attributes> block). */
      const div = runDivisions.get(part) ?? part.divisions;
      const rawClefs = pm ? (scanMeasureClefs(pm, div).get(localStaff) ?? []) : [];
      const clefChanges: { meiTick: number; spec: ClefSpec }[] = [];
      for (const c of [...rawClefs].sort((a, b) => a.meiTick - b.meiTick)) {
        if (clefEqual(c.spec, runClef.get(g)!)) continue;
        clefChanges.push(c);
        runClef.set(g, c.spec);
      }

      for (const layer of [1, 2]) {
        const layerEl = el(doc, 'layer', { n: String(layer), 'xml:id': newId('l') });
        if (pm) {
          const voice = voiceFor(g, layer);
          let slurOpen = slurOpenByVoice.get(voice);
          if (!slurOpen) { slurOpen = new Map(); slurOpenByVoice.set(voice, slurOpen); }
          let evs = buildEvents(pm, part, localStaff, layer, center.q, center.r);
          evs = expandMeasureRests(evs, runCount, runUnit);
          appendLayerChildren(doc, layerEl, evs, measureEl, voice, slurOpen, slurPairs, fermataEls, trillEls);
        }
        /* Inline clefs live in layer 1 (the beam pass treats <clef> as a break). */
        if (layer === 1 && clefChanges.length) insertClefsIntoLayer(doc, layerEl, clefChanges);
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

  /* Fermatas + trills: appended after the measure's <staff>s (Verovio
     control-event ordering requirement), anchored to the note via @startid. */
  for (const noteEl of fermataEls) {
    const id = noteEl.getAttribute('xml:id');
    const measure = noteEl.closest('measure');
    if (id && measure) measure.appendChild(el(doc, 'fermata', { 'xml:id': newId('f'), startid: '#' + id }));
  }
  for (const noteEl of trillEls) {
    const id = noteEl.getAttribute('xml:id');
    const measure = noteEl.closest('measure');
    if (id && measure) measure.appendChild(el(doc, 'trill', { 'xml:id': newId('tr'), startid: '#' + id }));
  }

  /* Dynamics + hairpins + expressive text (time-anchored), per part. */
  for (const part of parts) {
    const globalStaffOf = (ls: number): number => part.globalStaff[Math.min(Math.max(ls, 1), part.staffCount)];
    const { dynamics, hairpins, dirs } = scanPartDirections(part, globalStaffOf);
    for (const d of dynamics) {
      addDynam(doc, { measureIdx: d.measureIdx, tstamp: d.tstamp }, { text: d.text, place: d.place, staff: d.staff });
    }
    for (const h of hairpins) {
      addHairpin(doc,
        { measureIdx: h.startMeasureIdx, tstamp: h.startTstamp },
        { measureIdx: h.endMeasureIdx, tstamp: h.endTstamp },
        { form: h.form, place: h.place, staff: h.staff });
    }
    for (const d of dirs) {
      addDir(doc, { measureIdx: d.measureIdx, tstamp: d.tstamp },
        { text: d.text, place: d.place, staff: d.staff, italic: d.italic });
    }
  }

  /* Beam markers: diff the source beaming against our auto-beamer and set
     `@hkl-beam-break` wherever they differ. Because the serializer XORs that
     marker against the natural beat boundary, this reproduces the source
     grouping — both mid-beat breaks and cross-beat joins — while staying
     editable with `/`. Runs after clefs/scoreDefs exist (the natural boundary
     depends on the per-measure meter and inline clef breaks). */
  applyBeamMarkers(doc);

  /* Forced import settings. */
  setLayoutReq(doc, { tuningMode: 'E', refQ: 0, refR: 0 });
  setHejiEnabled(doc, false);
  setIgnoreColor(doc, true);

  return new XMLSerializer().serializeToString(doc);
}
