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
import { setLayoutReq, setHejiEnabled, setIgnoreColor, addDynam, addHairpin, addDir, addTempo, addOctave } from './expressions.js';
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
/** A MusicXML `divisions`-typed child, which is a DECIMAL (and may be signed —
 *  <offset> routinely is), so it cannot go through `intOf`. */
const numOf = (parent: Element | null, tag: string, dflt: number): number => {
  const t = textOf(parent, tag);
  const n = parseFloat(t);
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
  /** Hollow notehead on a value that is normally filled
   *  (`<notehead filled="no">`) → `@head.fill="void"`. Finale writes a
   *  measured tremolo as two beamed hollow 32nds under a 1:8 tuplet. */
  voidHead?: boolean;
}

interface ImpEvent {
  kind: 'note' | 'chord' | 'rest';
  notes: ImpNote[];   // empty for rest
  dur: Duration;
  dots: Dots;
  /** Tuplet group boundaries (from <notations><tuplet type=start|stop>).
   *  `bracket`/`showNum` carry the source's `bracket="no"` /
   *  `show-number="none"` — Finale's measured-tremolo tuplets hide both. */
  tupletStart?: { num: number; numbase: number; bracket: boolean; showNum: boolean };
  tupletStop?: boolean;
  /** Note-attached articulations: 'stacc' | 'acc' | 'ten'. */
  artics: string[];
  fermata: boolean;
  /** <ornaments><trill-mark> → note-attached <trill> (with/without wavy-line). */
  trill?: boolean;
  /** Accidental shown above the trill (<accidental-mark>) → @accidupper. */
  trillAccid?: string;
  /** <wavy-line> level starting / stopping at this event (extender span). */
  wavyStart?: number;
  wavyStop?: number;
  /** <ornaments><tremolo type=...> beams-count. 'single' = bowed (bTrem);
   *  'start'/'stop' = fingered two-note tremolo (fTrem) over the pair. */
  tremolo?: { type: 'single' | 'start' | 'stop'; beams: number };
  /** A full-measure rest (<rest measure="yes"/>): expanded to meter-filling
   *  rests at emission (the source carries no <type>). */
  measureRest?: boolean;
  /** A hidden rest — Finale's encoding for an invisible time advance
   *  (`<forward>`, e.g. a voice that enters mid-bar) → `<rest visible="false">`.
   *  Occupies ticks (keeps following notes in place) but draws no glyph. */
  hidden?: boolean;
  /** Did the source start a new beam at this event? Derived from
   *  <beam number="1"> (begin/absent = true; continue/end = false). Consulted
   *  only for beamable events by the post-build beam-diff pass. */
  finaleBeamStart?: boolean;
  /** Slur level numbers starting / stopping at this event. */
  slurStart: number[];
  slurStop: number[];
  /** Index into the global octave-span list when this event's notes were
   *  written-pitch-shifted by an <octave-shift> (see OctaveRec), plus its
   *  onset in source divisions within the measure — together these pick the
   *  span's first/last slot for @startid/@endid after emission. */
  octSpanIdx?: number;
  octPosDiv?: number;
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

/* ── barlines / repeats / endings ────────────────────────────────────────────── */

interface BarlineInfo {
  /** Right barline style → MEI @right. */
  rightStyle: 'end' | 'dbl' | 'rptend' | null;
  /** Forward repeat → MEI @left="rptstart". */
  leftRepeatStart: boolean;
  /** Volta number from <ending type="start">, else null. */
  endingStart: number | null;
  /** <ending type="stop"|"discontinue"> closes the current volta. */
  endingClose: boolean;
}

const EMPTY_BARLINE: BarlineInfo =
  { rightStyle: null, leftRepeatStart: false, endingStart: null, endingClose: false };

/** Read a measure's `<barline>` children into the model's barline vocabulary.
 *  MusicXML puts a forward repeat + ending-start on the LEFT barline and a
 *  backward repeat + ending-stop on the RIGHT barline; bar-style carries the
 *  visual style. A backward repeat wins over any bar-style in the same measure
 *  (→ "rptend"). If several right barlines exist (Finale emits a mid-measure
 *  `light-light` before a terminal `light-heavy` at movement ends), the
 *  terminal one wins — MEI/the model has no mid-measure barline. */
function scanMeasureBarlines(measureEl: Element): BarlineInfo {
  let rightStyle: BarlineInfo['rightStyle'] = null;
  let rightIsRepeat = false;
  let leftRepeatStart = false;
  let endingStart: number | null = null;
  let endingClose = false;
  for (const bl of children(measureEl, 'barline')) {
    const loc = bl.getAttribute('location') ?? 'right';
    const repeat = child(bl, 'repeat');
    const dir = repeat?.getAttribute('direction');
    const ending = child(bl, 'ending');
    const endType = ending?.getAttribute('type');
    if (ending) {
      if (endType === 'start') {
        const num = parseInt(ending.getAttribute('number') ?? '', 10);
        if (Number.isFinite(num)) endingStart = num;
      } else if (endType === 'stop' || endType === 'discontinue') {
        endingClose = true;
      }
    }
    if (loc === 'left') {
      if (dir === 'forward') leftRepeatStart = true;
      continue;
    }
    /* right barline */
    if (dir === 'backward') { rightStyle = 'rptend'; rightIsRepeat = true; continue; }
    if (rightIsRepeat) continue;   // repeat wins over a later plain bar-style
    const style = textOf(bl, 'bar-style');
    if (style === 'light-heavy') rightStyle = 'end';
    else if (style === 'light-light') rightStyle = 'dbl';
  }
  return { rightStyle, leftRepeatStart, endingStart, endingClose };
}

/** Small int → Roman numeral (movement headers; values stay well under 20). */
function intToRoman(n: number): string {
  const table: [number, string][] = [
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '', v = n;
  for (const [val, sym] of table) while (v >= val) { out += sym; v -= val; }
  return out;
}

function makeClef(doc: Document, spec: ClefSpec): Element {
  return el(doc, 'clef', {
    'xml:id': newId('clf'), shape: spec.shape, line: spec.line,
    dis: spec.dis, 'dis.place': spec.disPlace,
  });
}

/** True iff a layer holds any real content (note/chord/rest/tuplet/tremolo) —
 *  not just a layout `<space>` placeholder or an `<mRest>`. A layer whose only
 *  content is `<tuplet>`s still counts (else a mid-measure clef change over a
 *  tripleted voice is dropped — the clef must be inserted into that layer). */
function layerHasContent(layerEl: Element): boolean {
  return Array.from(layerEl.children).some(
    (c) => c.localName === 'note' || c.localName === 'chord' || c.localName === 'rest'
      || c.localName === 'tuplet' || c.localName === 'fTrem' || c.localName === 'bTrem');
}

/** Insert an inline `<clef>` at MEI tick `meiTick` in a layer: before the first
 *  child whose cumulative start-tick reaches the clef's tick (a clef inside a
 *  long note lands just before the following event). The beam pass treats
 *  `<clef>` as a break. */
function insertMidClef(doc: Document, layerEl: Element, meiTick: number, spec: ClefSpec): void {
  const clefEl = makeClef(doc, spec);
  let t = 0;
  let target: Element | null = null;
  for (const c of Array.from(layerEl.children)) {
    if (c.localName === 'clef') continue;
    if (t >= meiTick) { target = c; break; }
    t += realTicks(c);
  }
  layerEl.insertBefore(clefEl, target);   // target null → appended at end
}

/** Minimal TimeSigInfo for meter/rest-fill math (no additive beat-groups). */
function makeTimeSig(count: number, unit: number): TimeSigInfo {
  return {
    count, unit,
    isCompound: unit >= 8 && count >= 6 && count % 3 === 0,
    is4_4: count === 4 && unit === 4,
    beatGroups: null,
  };
}

/** Beat-aligned rest ImpEvents filling `ticks` — used for an empty voice in a
 *  PICKUP measure (which must show a reduced-duration rest, not a whole-measure
 *  `<mRest>`). */
function beatAlignedRestEvents(ticks: number, count: number, unit: number): ImpEvent[] {
  return decomposeBeatAlignedRests(0, ticks, makeTimeSig(count, unit)).map((p) => ({
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

/** An octave-shift span clipped to a single measure, expressed in that
 *  measure's source `divisions`: a note whose onset falls in [fromDiv, toDiv)
 *  is written `octDelta` octaves from its encoded (sounding) pitch. */
interface MeasureOctSpan { fromDiv: number; toDiv: number; octDelta: number; spanIdx: number }

function buildEvents(
  measureEl: Element, part: PartInfo, localStaff: number, layer: number,
  centerQ: number, centerR: number,
  divisions: number, tsCount: number, tsUnit: number,
  octSpans: MeasureOctSpan[] = [],
): ImpEvent[] {
  // Which voice maps to (localStaff, layer)?
  let targetVoice: number | null = null;
  for (const [v, m] of part.voiceMap) {
    if (m.localStaff === localStaff && m.layer === layer) { targetVoice = v; break; }
  }
  if (targetVoice === null) return [];

  const events: ImpEvent[] = [];
  /* Running onset of this voice within the measure, in SOURCE divisions (not
     MEI ticks): tuplets make written ticks diverge from sounding position, and
     the octave-shift spans are recorded in the same divisions space. */
  let curDiv = 0;
  let lastOnsetDiv = 0;          // onset of the last non-chord note
  const octAt = (posDiv: number): { delta: number; spanIdx?: number } => {
    let delta = 0;
    let spanIdx: number | undefined;
    for (const sp of octSpans) {
      if (posDiv < sp.fromDiv - 1e-6 || posDiv >= sp.toDiv - 1e-6) continue;
      delta += sp.octDelta;
      if (spanIdx === undefined) spanIdx = sp.spanIdx;
    }
    return { delta, spanIdx };
  };
  /* Walk the measure's children in document order so a <forward> (an invisible
     time advance for a voice — Finale's encoding of a hidden rest, e.g. a voice
     entering mid-bar) lands as a hidden rest at its true position. Ignoring it
     collapses the gap and displaces every following note in the voice. */
  for (const node of Array.from(measureEl.children)) {
    if (node.localName === 'forward') {
      /* Only an explicitly voiced forward is unambiguous per-voice; a voiceless
         one applies to the global position we don't track here, so skip it. */
      const voiceEl = child(node, 'voice');
      if (!voiceEl) continue;
      const fv = parseInt(voiceEl.textContent ?? '', 10) || 0;
      const fs = intOf(node, 'staff', localStaff);
      if (fv !== targetVoice || fs !== localStaff) continue;
      const meiTicks = divisions > 0 ? Math.round(intOf(node, 'duration', 0) * 16 / divisions) : 0;
      for (const r of beatAlignedRestEvents(meiTicks, tsCount, tsUnit)) {
        r.hidden = true;
        events.push(r);
      }
      curDiv += intOf(node, 'duration', 0);
      continue;
    }
    if (node.localName !== 'note') continue;
    const note = node;
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

    /* Onset of this note (chord members share the head's) and the written-
       octave shift of any <octave-shift> covering it. */
    const posDiv = isChordNote ? lastOnsetDiv : curDiv;
    if (!isChordNote) { lastOnsetDiv = curDiv; curDiv += intOf(note, 'duration', 0); }
    const oct = isRest ? { delta: 0, spanIdx: undefined } : octAt(posDiv);

    if (isChordNote && events.length > 0) {
      // Merge onto the previous event (note → chord). Tie/notations attach
      // per chord-note; articulations/slurs/fermata stay event-level.
      const prev = events[events.length - 1];
      const im = impNoteFromXml(note, centerQ, centerR, oct.delta);
      if (im) { prev.notes.push(im); prev.kind = 'chord'; }
      mergeNotations(note, prev);
      continue;
    }

    const im = isRest ? null : impNoteFromXml(note, centerQ, centerR, oct.delta);
    const ev: ImpEvent = {
      kind: isRest ? 'rest' : 'note',
      notes: im ? [im] : [],
      dur, dots, artics: [], fermata: false, slurStart: [], slurStop: [],
    };
    if (oct.spanIdx !== undefined) { ev.octSpanIdx = oct.spanIdx; ev.octPosDiv = posDiv; }
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
          bracket: tupletTag.getAttribute('bracket') !== 'no',
          showNum: tupletTag.getAttribute('show-number') !== 'none',
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
    /* Wavy-line = the trill's extender span. Start makes this a trill; the
       matching stop (paired globally by number) gives the extender @endid. */
    for (const w of children(ornaments, 'wavy-line')) {
      const num = parseInt(w.getAttribute('number') ?? '1', 10) || 1;
      if (w.getAttribute('type') === 'start') ev.wavyStart = num;
      else if (w.getAttribute('type') === 'stop') ev.wavyStop = num;
    }
    if (child(ornaments, 'trill-mark') || ev.wavyStart !== undefined) ev.trill = true;
    const trem = child(ornaments, 'tremolo');
    if (trem) {
      const ty = (trem.getAttribute('type') ?? 'single');
      const type = (ty === 'start' || ty === 'stop') ? ty : 'single';
      const beams = parseInt(trem.textContent?.trim() ?? '3', 10) || 3;
      ev.tremolo = { type, beams };
    }
  }
  /* Accidental above a trill (<accidental-mark>, sibling of <ornaments>). */
  const accMark = child(notations, 'accidental-mark');
  if (accMark && ev.trill) {
    const t = accMark.textContent?.trim();
    ev.trillAccid = t === 'sharp' ? 's' : t === 'flat' ? 'f' : t === 'natural' ? 'n'
      : t === 'double-sharp' || t === 'sharp-sharp' ? 'x' : t === 'flat-flat' ? 'ff' : undefined;
  }
  for (const s of children(notations, 'slur')) {
    const num = parseInt(s.getAttribute('number') ?? '1', 10) || 1;
    const t = s.getAttribute('type');
    if (t === 'start') ev.slurStart.push(num);
    else if (t === 'stop') ev.slurStop.push(num);
  }
}

/** `octDelta` shifts the WRITTEN octave: MusicXML <pitch> under an
 *  <octave-shift> is the SOUNDING pitch, while the model stores the written
 *  pitch and derives the sounding one from the <octave> bracket. An 8va
 *  (`type="down"`) therefore imports as octDelta = −1. */
function impNoteFromXml(note: Element, centerQ: number, centerR: number, octDelta = 0): ImpNote | null {
  const pitch = child(note, 'pitch');
  if (!pitch) return null;
  const step = textOf(pitch, 'step');
  const alter = intOf(pitch, 'alter', 0);
  const octave = intOf(pitch, 'octave', 4) + octDelta;
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
  // not as <technical><harmonic>). A hollow "normal" notehead is the other
  // notehead override we honor (measured tremolos).
  const noteheadEl = child(note, 'notehead');
  const harmonic = noteheadEl?.textContent?.trim() === 'diamond';
  const voidHead = !harmonic && noteheadEl?.getAttribute('filled') === 'no';
  return {
    spec: {
      q, r,
      pname: step.toLowerCase() as NoteSpec['pname'],
      accid: alterToCount(alter),
      oct: octave,
      midi: coordToMidi(q, r),
      colorHex: '#000000',
    },
    tieStart, tieStop, harmonic, voidHead,
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
    if (ev.hidden) element.setAttribute('visible', 'false');
  } else if (ev.kind === 'chord' || ev.notes.length > 1) {
    element = buildChordElement(doc, { notes: ev.notes.map((n) => n.spec), duration: ev.dur, dots: ev.dots });
    /* Apply ties + harmonic per chord-note (match built child by q,r). */
    const childNotes = Array.from(element.children).filter((c) => c.localName === 'note');
    for (const im of ev.notes) {
      const match = childNotes.find((c) =>
        c.getAttribute('data-q') === String(im.spec.q) && c.getAttribute('data-r') === String(im.spec.r));
      if (match) {
        applyTie(match, im);
        if (im.harmonic) applyHarmonic(element, match);
        else if (im.voidHead) match.setAttribute('head.fill', 'void');
      }
    }
  } else {
    element = buildNoteElement(doc, ev.notes[0].spec, ev.dur, ev.dots);
    applyTie(element, ev.notes[0]);
    if (ev.notes[0].harmonic) applyHarmonic(element, element);
    else if (ev.notes[0].voidHead) element.setAttribute('head.fill', 'void');
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
interface TrillRec { noteEl: Element; accid?: string }

/** Shared emission state. Slur AND wavy-line pairing are GLOBAL (keyed by
 *  number across all voices/staves), not per-voice, so cross-staff slurs and
 *  trill extenders that span voices pair correctly. */
interface EmitCtx {
  slurOpen: Map<number, { id: string; voice: number }>;   // number → open slur start
  slurPairs: SlurPair[];
  fermataEls: Element[];
  trillRecs: TrillRec[];
  wavyOpen: Map<number, string>;    // number → trill-note id of an open wavy-line
  wavyEnd: Map<string, string>;     // trill-note id → extender end note id
}

/** Append a layer's events (wrapping tuplet runs in <tuplet>), attaching
 *  fermatas/trills to the measure in a post-pass and collecting slur + trill-
 *  extender pairs. A complete musical tuplet is self-contained — no trailing
 *  placeholder. */
function appendLayerChildren(
  doc: Document, layerEl: Element, events: ImpEvent[],
  measureEl: Element, voice: number, partIdx: number, ctx: EmitCtx,
): void {
  /* Slur/wavy numbers are reused across parts, so pairing is scoped PER PART
     (composite key) — global across a part's staves/voices for cross-staff
     spans, but never crossing into another instrument's part. */
  const key = (n: number): number => partIdx * 1000 + n;
  const wire = (ev: ImpEvent): void => {
    const id = ev.el?.getAttribute('xml:id');
    if (!id || !ev.el) return;
    /* Fermata + trill are appended to the measure in a post-pass (after
       <staff>s exist) — Verovio requires control events to follow staff
       content. */
    if (ev.fermata) ctx.fermataEls.push(ev.el);
    if (ev.trill) ctx.trillRecs.push({ noteEl: ev.el, accid: ev.trillAccid });
    if (ev.wavyStart !== undefined) ctx.wavyOpen.set(key(ev.wavyStart), id);
    if (ev.wavyStop !== undefined) {
      const s = ctx.wavyOpen.get(key(ev.wavyStop));
      if (s) { ctx.wavyEnd.set(s, id); ctx.wavyOpen.delete(key(ev.wavyStop)); }
    }
    for (const n of ev.slurStart) ctx.slurOpen.set(key(n), { id, voice });
    for (const n of ev.slurStop) {
      const o = ctx.slurOpen.get(key(n));
      if (o) { ctx.slurPairs.push({ startId: o.id, endId: id, voice: o.voice }); ctx.slurOpen.delete(key(n)); }
    }
  };

  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    if (ev.tupletStart) {
      const { num, numbase, bracket, showNum } = ev.tupletStart;
      /* Number visibility follows the source, and so does a suppressed bracket:
         Finale's measured tremolo is a `bracket="no" show-number="none"` 1:8
         tuplet over two hollow beamed notes, and drew a bracket + "1" here until
         2026-09-04 (sonata m. 93). A source bracket="yes" is NOT forced: with no
         `bracket.visible` Verovio draws the bracket only when the tuplet is not
         wholly under one beam (Max, 2026-09-05: numbers alone on full beams). */
      const tuplet = el(doc, 'tuplet', {
        'xml:id': newId('t'), num: String(num), numbase: String(numbase),
        ...(bracket ? {} : { 'bracket.visible': 'false' }),
        'num.visible': showNum ? 'true' : 'false',
        'num.format': 'count',
        'data-tuplet-atomic-dur': ev.dur,
      });
      let j = i;
      for (; j < events.length; j++) {
        tuplet.appendChild(eventToElement(doc, events[j]));
        wire(events[j]);
        if (events[j].tupletStop) break;
      }
      /* Composer's tuplet model holds exactly `num` atoms of the atomic value
         (placeholders, ticks, the placeholder invariant). Finale's measured
         tremolo breaks that: TWO 32nds under a "1 in the time of 8" tuplet.
         Rescale to the atom count when every member shares the written value
         and the ratio stays exact — 1:8 over two 32nds becomes 2:16, the same
         real duration (× numbase/num) with `num` atoms inside. */
      const members = Array.from(tuplet.children);
      const k = members.length;
      const uniform = members.every((c) => c.getAttribute('dur') === ev.dur && (c.getAttribute('dots') ?? '0') === String(ev.dots ?? 0));
      if (uniform && k > 0 && k !== num && (k * numbase) % num === 0) {
        tuplet.setAttribute('num', String(k));
        tuplet.setAttribute('numbase', String((k * numbase) / num));
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
/** A tempo marking: a <direction> carrying <metronome> and/or <sound tempo>
 *  (its <words> are the verbal text), or a bare measure-level <sound tempo>
 *  (no text — a playback-only change). `showMm` when the source drew a
 *  metronome mark. */
interface TempoRec { measureIdx: number; tstamp: number; text: string; bpm?: number; unit: number; dots: number; showMm: boolean; italic: boolean }
interface HairpinRec {
  startMeasureIdx: number; startTstamp: number;
  endMeasureIdx: number; endTstamp: number;
  staff: number; place: 'above' | 'below'; form: 'cres' | 'dim';
}
/** An <octave-shift> span (ottava). `startDiv`/`endDiv` are the span's
 *  endpoints in their own measure's source divisions — the note-onset space
 *  buildEvents works in; the tstamps carry the playback tick-span. `endDiv` is
 *  EXCLUSIVE: Finale writes the `stop` direction at the position just past the
 *  last bracketed note. */
interface OctaveRec {
  startMeasureIdx: number; startTstamp: number; startDiv: number;
  endMeasureIdx: number; endTstamp: number; endDiv: number;
  staff: number; dis: 8 | 15; place: 'above' | 'below';
}

/** Walk a part's measures in document order, tracking the beat position of each
 *  <direction>, and collect dynamics + hairpins. Wedges are paired across
 *  measures by their level number. */
function scanPartDirections(
  part: PartInfo,
  globalStaffOf: (localStaff: number) => number,
): {
  dynamics: DynamRec[]; hairpins: HairpinRec[]; dirs: DirRec[]; tempi: TempoRec[]; octaves: OctaveRec[];
  /** How many <direction>s carried a non-zero <offset>, and how many of those
   *  reached past their bar's start and were clamped to beat 1. Reported once
   *  per import so a file whose offsets cross barlines is visible, not silent. */
  offsetsApplied: number; offsetsClamped: number;
} {
  const dynamics: DynamRec[] = [];
  const hairpins: HairpinRec[] = [];
  const dirs: DirRec[] = [];
  const tempi: TempoRec[] = [];
  const octaves: OctaveRec[] = [];
  let offsetsApplied = 0;
  let offsetsClamped = 0;
  /** Metronome / sound-tempo fields of a <direction> (or a bare <sound>). */
  const tempoFields = (node: Element): { bpm?: number; unit: number; dots: number; showMm: boolean } => {
    const metro = node.querySelector('metronome');
    const sound = node.localName === 'sound' ? node : node.querySelector('sound[tempo]');
    let bpm: number | undefined; let unit = 4; let dots = 0;
    if (metro) {
      const bu = metro.querySelector('beat-unit')?.textContent?.trim() ?? '';
      unit = parseInt(TYPE_TO_DUR[bu] ?? '4', 10) || 4;
      dots = metro.querySelectorAll('beat-unit-dot').length;
      const pm = parseInt(metro.querySelector('per-minute')?.textContent?.trim() ?? '', 10);
      if (Number.isFinite(pm) && pm > 0) bpm = pm;
    }
    if (sound) { const v = parseInt(sound.getAttribute('tempo') ?? '', 10); if (Number.isFinite(v) && v > 0) bpm = v; }
    return { bpm, unit, dots, showMm: metro !== null };
  };
  /* open wedge per level number → its start moment + staff/place. */
  const openWedge = new Map<number, { mi: number; tstamp: number; staff: number; place: 'above' | 'below'; form: 'cres' | 'dim' }>();
  /* open octave-shift per level number → its start moment + staff/size. */
  const openOct = new Map<number, { mi: number; tstamp: number; div: number; staff: number; dis: 8 | 15; place: 'above' | 'below' }>();

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
      } else if (ln === 'sound') {
        /* A bare measure-level <sound tempo> (Finale's hidden tempo change):
           a playback-only <tempo> with no text. */
        if (node.hasAttribute('tempo')) {
          const f = tempoFields(node);
          if (f.bpm) tempi.push({ measureIdx: mi, tstamp: Math.max(1, tstampOf(cur)), text: '', ...f, showMm: false, italic: false });
        }
      } else if (ln === 'direction') {
        const placement = node.getAttribute('placement');
        const place: 'above' | 'below' = placement === 'above' ? 'above' : 'below';
        const localStaff = intOf(node, 'staff', 1);
        const staff = globalStaffOf(localStaff);
        /* <offset> (source divisions, signed, possibly fractional) is where the
           direction BELONGS. Finale writes a mark at the end of a measure's
           element stream and offsets it back to its real beat, so dropping it
           put three of the sonata's p. 21 m. 99 marks at tstamp 4 in a 3/4 bar
           — ON the barline (backlog, Layout). It moves the single @tstamp, so
           the playback effect travels with the glyph: every offset the sonata
           carries is sound="no", but the offset position is the musically
           correct one (m. 43's diminuendo wedge is written AT the bar end with
           offset -480, i.e. un-offset it would begin on the barline).
           A negative offset reaching past the bar start clamps to beat 1 rather
           than migrating into the previous measure — decisions.md declined
           import-time anchor migration ("it changes the document and would
           stack the mark on any downbeat text", m. 90 'cresc.'). There is no
           upper clamp: a wedge stop legitimately sits at beats+1, which is what
           textlayout's barline nudge exists for. */
        const offsetDiv = numOf(node, 'offset', 0);
        const tstampRaw = Math.max(1, tstampOf(cur));
        const tstamp = Math.max(1, tstampOf(cur + offsetDiv));
        if (offsetDiv !== 0) {
          offsetsApplied++;
          if (tstampOf(cur + offsetDiv) < 1) offsetsClamped++;
        }
        /* A tempo direction (metronome and/or sound tempo): ONE <tempo> per
           direction, its <words> as the verbal text — every tempo marking in
           the piece, not only the first (backlog, Layout P1: the sonata's
           "Poco più mosso", "Tempo I", … were dropped). */
        const isTempoDir = node.querySelector('metronome') !== null
          || node.querySelector('sound[tempo]') !== null;
        if (isTempoDir) {
          const words = children(node, 'direction-type').flatMap((dt) => children(dt, 'words'));
          const text = words.map((w) => w.textContent?.trim() ?? '').filter(Boolean).join(' ');
          const italic = words.length > 0 && words.every((w) => w.getAttribute('font-style') === 'italic');
          tempi.push({ measureIdx: mi, tstamp, text, ...tempoFields(node), italic });
        }
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
          /* Ottava (<octave-shift>). MusicXML `type` names the direction the
             PRINTED notes move relative to the encoded (sounding) pitch, so
             `down` = printed an octave lower = 8va, bracket ABOVE; `up` = 8vb,
             bracket below. `continue` (a system-break continuation) leaves the
             span open. */
          const osh = child(dt, 'octave-shift');
          if (osh) {
            const otype = osh.getAttribute('type');
            const num = parseInt(osh.getAttribute('number') ?? '1', 10) || 1;
            if (otype === 'down' || otype === 'up') {
              const size = parseInt(osh.getAttribute('size') ?? '8', 10) || 8;
              /* An <octave-shift> keeps the UN-offset anchor: its div span decides
                 which notes get rewritten an octave, so an offset there would
                 change content rather than placement, and the bracket is drawn
                 from @startid/@endid anyway. */
              openOct.set(num, {
                mi, tstamp: tstampRaw, div: cur, staff,
                dis: size >= 15 ? 15 : 8,
                place: otype === 'down' ? 'above' : 'below',
              });
            } else if (otype === 'stop') {
              const o = openOct.get(num);
              if (o) {
                octaves.push({
                  startMeasureIdx: o.mi, startTstamp: o.tstamp, startDiv: o.div,
                  endMeasureIdx: mi, endTstamp: tstampRaw, endDiv: cur,
                  staff: o.staff, dis: o.dis, place: o.place,
                });
                openOct.delete(num);
              }
            }
          }
          /* Free expressive text (pizz., dim., espressivo, …) → <dir>. A tempo
             direction's words are the <tempo>'s text, not a <dir>. */
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
  return { dynamics, hairpins, dirs, tempi, octaves, offsetsApplied, offsetsClamped };
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

  /* A brace + through-barlines mark a GRAND STAFF and nothing else (convention;
     Max, 2026-09-04): a lone staff gets no brace (Verovio draws one on any
     group that asks), and the root group of a multi-instrument score gets
     neither — barlines must not run between instruments. Until this fix the
     root always carried both, so the sonata braced viola + piano together and
     joined their barlines while the piano itself had no brace. */
  const grandAttrs = (staffCount: number): string =>
    staffCount === 2 ? ' symbol="brace" bar.thru="true"' : '';
  const defsOf = (p: PartInfo): string => Array.from({ length: p.staffCount }, (_, i) =>
    staffDefXml(p.globalStaff[i + 1], p.headClef.get(i + 1)!)).join('');
  let staffGrpXml: string;
  if (parts.length === 1) {
    const p = parts[0];
    staffGrpXml = `<staffGrp${grandAttrs(p.staffCount)}>${defsOf(p)}</staffGrp>`;
  } else {
    staffGrpXml = '<staffGrp>' + parts.map((p) =>
      `<staffGrp${grandAttrs(p.staffCount)}><label>${escapeXml(p.name)}</label>${defsOf(p)}</staffGrp>`).join('') + '</staffGrp>';
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
      ${staffGrpXml}
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
  /* Directions are scanned UP FRONT (not with the other control events after
     the build): an <octave-shift> has to be known while notes are built,
     because MusicXML encodes bracketed notes at sounding pitch while the model
     stores written pitch + an <octave> span. */
  const dirScans = parts.map((part) => scanPartDirections(
    part, (ls) => part.globalStaff[Math.min(Math.max(ls, 1), part.staffCount)],
  ));
  /* Say once what the <offset> handling did. The anchor used to be dropped
     silently (backlog, Layout), and a clamp means a direction's offset reached
     past its bar's start — worth seeing rather than guessing at later. */
  {
    const applied = dirScans.reduce((n, d) => n + d.offsetsApplied, 0);
    const clamped = dirScans.reduce((n, d) => n + d.offsetsClamped, 0);
    if (applied) {
      console.info(`[import] <offset> applied to ${applied} direction(s)`
        + (clamped ? `; ${clamped} clamped to beat 1 (reached past the bar start)` : ''));
    }
  }
  const octSpans: OctaveRec[] = dirScans.flatMap((d) => d.octaves);
  /* The spans covering (global staff, measure), clipped to that measure. */
  const octSpansFor = (g: number, mi: number): MeasureOctSpan[] => {
    const out: MeasureOctSpan[] = [];
    octSpans.forEach((sp, i) => {
      if (sp.staff !== g || mi < sp.startMeasureIdx || mi > sp.endMeasureIdx) return;
      out.push({
        fromDiv: mi === sp.startMeasureIdx ? sp.startDiv : -Infinity,
        toDiv: mi === sp.endMeasureIdx ? sp.endDiv : Infinity,
        octDelta: (sp.place === 'above' ? -1 : 1) * (sp.dis === 15 ? 2 : 1),
        spanIdx: i,
      });
    });
    return out;
  };
  /* span index → its first/last emitted slot (Verovio anchors the bracket to
     @startid/@endid). Ordered by (measure, onset) so a span crossing measures
     or covering both layers of a staff still picks its true extremes. */
  const octAnchors = new Map<number, {
    firstMi: number; firstPos: number; firstId: string;
    lastMi: number; lastPos: number; lastId: string;
  }>();
  const recordOctaveAnchors = (evs: ImpEvent[], mi: number): void => {
    for (const ev of evs) {
      if (ev.octSpanIdx === undefined || !ev.el) continue;
      if (ev.el.localName !== 'note' && ev.el.localName !== 'chord') continue;
      const id = ev.el.getAttribute('xml:id');
      if (!id) continue;
      const pos = ev.octPosDiv ?? 0;
      const a = octAnchors.get(ev.octSpanIdx);
      if (!a) {
        octAnchors.set(ev.octSpanIdx, {
          firstMi: mi, firstPos: pos, firstId: id, lastMi: mi, lastPos: pos, lastId: id,
        });
        continue;
      }
      if (mi < a.firstMi || (mi === a.firstMi && pos < a.firstPos)) {
        a.firstMi = mi; a.firstPos = pos; a.firstId = id;
      }
      if (mi > a.lastMi || (mi === a.lastMi && pos > a.lastPos)) {
        a.lastMi = mi; a.lastPos = pos; a.lastId = id;
      }
    }
  };

  /* Emission state — slur + wavy pairing is GLOBAL (cross-staff/voice). */
  const ctx: EmitCtx = {
    slurOpen: new Map(), slurPairs: [], fermataEls: [], trillRecs: [],
    wavyOpen: new Map(), wavyEnd: new Map(),
  };

  /* Running notation state for mid-piece change detection. */
  let runKeySig = keySig, runMode = keyMode, runCount = meterCount, runUnit = meterUnit;
  let runSym = meterSym === 'cut' || meterSym === 'common' ? meterSym : '';
  const runClef = new Map<number, ClefSpec>();   // global staff → clef
  for (const g of allStaves) runClef.set(g, partForStaff(g).part.headClef.get(partForStaff(g).localStaff)!);
  const runDivisions = new Map<PartInfo, number>();   // part → divisions in effect
  for (const p of parts) runDivisions.set(p, p.divisions);

  const clefEqual = (a: ClefSpec, b: ClefSpec): boolean =>
    a.shape === b.shape && a.line === b.line && (a.dis ?? 0) === (b.dis ?? 0) && (a.disPlace ?? '') === (b.disPlace ?? '');

  /* Barline / repeat / ending / movement-break state carried across measures.
     A mid-piece final barline (right="end") ends a movement, so the NEXT
     measure becomes a section header (Roman-numeral title, starting at II);
     endings wrap their measures in an <ending> container inside <section>. */
  let pendingSectionStart = false;
  let movementNum = 2;                  // first movement has no header
  let currentEnding: Element | null = null;

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

    /* Barlines (read from the first part that has this measure — parts agree).
       @left/@right map to the model's native barline vocabulary; a mid-piece
       final barline flags the next measure as a movement/section header. */
    const barSrc = parts.map((p) => p.measures[mi]).find(Boolean) ?? null;
    const bar = barSrc ? scanMeasureBarlines(barSrc) : EMPTY_BARLINE;
    if (bar.leftRepeatStart) measureEl.setAttribute('left', 'rptstart');
    if (bar.rightStyle) measureEl.setAttribute('right', bar.rightStyle);
    else if (mi === measureCount - 1) measureEl.setAttribute('right', 'end');

    /* Pickup: implicit="yes" on a part's measure → reduced tick budget. */
    const implicit = parts.some((p) => p.measures[mi]?.getAttribute('implicit') === 'yes');
    let pickupTicks: number | null = null;   // reduced budget of a pickup measure
    if (implicit) {
      // budget = max filled ticks across this measure's layers.
      let maxTicks = 0;
      for (const g of allStaves) {
        const { part, localStaff } = partForStaff(g);
        const pm = part.measures[mi];
        if (!pm) continue;
        for (const layer of [1, 2]) {
          const evs = buildEvents(pm, part, localStaff, layer, center.q, center.r,
            runDivisions.get(part) ?? part.divisions, runCount, runUnit, octSpansFor(g, mi));
          /* A measure-rest voice is EMPTY — it's sized TO the pickup budget, so
             it must not define it (its default quarter would inflate the bar). */
          const t = evs.filter((e) => !e.measureRest).reduce((s, e) => s + dottedTicks(e.dur, e.dots), 0);
          maxTicks = Math.max(maxTicks, t);
        }
      }
      if (maxTicks > 0) {
        pickupTicks = maxTicks;
        measureEl.setAttributeNS('https://hexkeylab.com/ns/mei', 'hkl:pickup-ticks', String(maxTicks));
      }
    }

    for (const g of allStaves) {
      const { part, localStaff } = partForStaff(g);
      const partIdx = parts.indexOf(part);
      const pm = part.measures[mi];
      const staffEl = el(doc, 'staff', { n: String(g), 'xml:id': newId('s') });

      /* Clef changes in this measure for this staff, in document (tick) order.
         A change equal to the running clef is dropped. */
      const div = runDivisions.get(part) ?? part.divisions;
      const rawClefs = pm ? (scanMeasureClefs(pm, div).get(localStaff) ?? []) : [];
      const clefChanges: { meiTick: number; spec: ClefSpec }[] = [];
      for (const c of [...rawClefs].sort((a, b) => a.meiTick - b.meiTick)) {
        if (clefEqual(c.spec, runClef.get(g)!)) continue;
        clefChanges.push(c);
        runClef.set(g, c.spec);
      }

      const layerEls: Element[] = [];
      for (const layer of [1, 2]) {
        const layerEl = el(doc, 'layer', { n: String(layer), 'xml:id': newId('l') });
        if (pm) {
          const voice = voiceFor(g, layer);
          const evs = buildEvents(pm, part, localStaff, layer, center.q, center.r, div, runCount, runUnit, octSpansFor(g, mi));
          if (evs.length === 1 && evs[0].measureRest) {
            if (pickupTicks != null) {
              /* Pickup exception: an empty voice shows a rest sized to the
                 reduced pickup budget, NOT a whole-measure <mRest> (which would
                 draw a whole rest spanning the short bar). */
              appendLayerChildren(doc, layerEl, beatAlignedRestEvents(pickupTicks, runCount, runUnit), measureEl, voice, partIdx, ctx);
            } else {
              /* Empty full bar → a single <mRest> (centered whole rest,
                 meter-agnostic — the conventional empty-measure glyph). */
              layerEl.appendChild(el(doc, 'mRest', { 'xml:id': newId('mr') }));
            }
          } else {
            appendLayerChildren(doc, layerEl, evs, measureEl, voice, partIdx, ctx);
            recordOctaveAnchors(evs, mi);
          }
        }
        layerEls.push(layerEl);
        staffEl.appendChild(layerEl);
      }

      /* Clef changes → inline <clef> at their tick in EVERY content layer of the
         staff (so the clef governs all voices — a change on a staff whose notes
         are in layer 2 must not leave them in the old clef). A boundary change
         (tick 0) lands at the layer head; the render-time pass
         `relocateInitialClefs` moves any measure-initial clef before the barline
         (globally, for native edits too). Mid-measure changes stay at their tick. */
      const contentLayers = layerEls.filter(layerHasContent);
      for (const cc of clefChanges) {
        for (const le of contentLayers) insertMidClef(doc, le, cc.meiTick, cc.spec);
      }
      measureEl.appendChild(staffEl);
    }

    /* Movement/section header: the measure after a mid-piece final barline
       starts a new movement — tag it with a Roman-numeral title and insert a
       section system-break before it (matches setSectionHeaderAt's encoding;
       setBarlines() derives the preceding measure's @right="end" on load). */
    if (pendingSectionStart) {
      measureEl.setAttribute('data-hkl-section-title', intToRoman(movementNum));
      movementNum++;
      section.appendChild(el(doc, 'sb', { 'xml:id': newId('sb'), 'data-hkl-section': 'true' }));
      pendingSectionStart = false;
    }

    /* Ending (volta): open a new <ending> container, wrap this measure, close
       it when the source stops/discontinues the volta. */
    if (bar.endingStart != null) {
      currentEnding = el(doc, 'ending', { n: String(bar.endingStart), 'xml:id': newId('ending') });
      section.appendChild(currentEnding);
    }
    (currentEnding ?? section).appendChild(measureEl);
    if (bar.endingClose) currentEnding = null;

    /* A mid-piece final barline ends a movement → next measure is a header. */
    if (bar.rightStyle === 'end' && mi !== measureCount - 1) pendingSectionStart = true;
  }

  /* Resolve slurs (global pairing → cross-staff slurs pair correctly) now that
     all note elements are attached to the document. */
  for (const p of ctx.slurPairs) addSlur(doc, p.startId, p.endId, p.voice);

  /* Fermatas + trills: appended after the measure's <staff>s (Verovio
     control-event ordering requirement), anchored to the note via @startid.
     Trills carry the accidental (@accidupper) and the wavy-line extender
     (@extender + @endid = the note where the wavy-line stops). */
  for (const noteEl of ctx.fermataEls) {
    const id = noteEl.getAttribute('xml:id');
    const measure = noteEl.closest('measure');
    if (id && measure) measure.appendChild(el(doc, 'fermata', { 'xml:id': newId('f'), startid: '#' + id }));
  }
  for (const { noteEl, accid } of ctx.trillRecs) {
    const id = noteEl.getAttribute('xml:id');
    const measure = noteEl.closest('measure');
    if (!id || !measure) continue;
    const attrs: Record<string, string | undefined> = { 'xml:id': newId('tr'), startid: '#' + id };
    if (accid) attrs.accidupper = accid;
    const endId = ctx.wavyEnd.get(id);
    if (endId && endId !== id) { attrs.extender = 'true'; attrs.endid = '#' + endId; }
    measure.appendChild(el(doc, 'trill', attrs));
  }

  /* Ottava brackets: one <octave> per <octave-shift> span, anchored to the
     first and last slot it covers (Verovio draws the bracket from
     @startid/@endid only — @tstamp alone yields an empty group). The bracketed
     notes were already written down/up an octave during the build, so the
     bracket restores the source's sounding pitch. A span covering no slot
     (rests only) is dropped — there is nothing to anchor it to. */
  octSpans.forEach((sp, i) => {
    const a = octAnchors.get(i);
    if (!a) return;
    addOctave(doc,
      { measureIdx: sp.startMeasureIdx, tstamp: sp.startTstamp },
      { measureIdx: sp.endMeasureIdx, tstamp: sp.endTstamp },
      { dis: sp.dis, place: sp.place, staff: sp.staff, startId: a.firstId, endId: a.lastId });
  });

  /* Dynamics + hairpins + expressive text + tempo markings (time-anchored),
     per part — from the scans taken before the build. */
  const seenTempi = new Set<string>();
  for (const { dynamics, hairpins, dirs, tempi } of dirScans) {
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
    /* Tempo markings, once per moment: Finale writes the same direction on
       every part, so identical (moment, text, bpm) records collapse to one
       <tempo> above the top staff. The bpm is stored either way (playback);
       the metronome is drawn only when the source drew one. */
    for (const t of tempi) {
      const key = `${t.measureIdx}|${t.tstamp}|${t.text}|${t.bpm ?? ''}`;
      if (seenTempi.has(key)) continue;
      seenTempi.add(key);
      addTempo(doc, { measureIdx: t.measureIdx, tstamp: t.tstamp },
        { text: t.text, bpm: t.bpm, unit: t.unit, dots: t.dots, showMm: t.showMm, italic: t.italic, place: 'above', staff: 1 });
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
