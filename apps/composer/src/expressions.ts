// Expression layer model. CRUD on MEI control events (<dynam>, <hairpin>)
// and on the document-level <extMeta>/<hkl:config> block that stores
// performance defaults (dynamic→velocity map, future tempo alteration).
//
// Anchoring strategy: time-based via @tstamp (beat within measure, 1-indexed)
// and @tstamp2 ("Nm+beat"). Expressions survive deletion of nearby notes
// because they are not bound to any note's xml:id. Slurs and articulations
// remain note-attached and live elsewhere.
//
// Insertion convention: as last child of the target <measure>, after all
// <staff> elements, matching the existing <lv> placement pattern.
//
// Verovio renders <dynam> and <hairpin> natively from these attributes;
// no rendering code lives here. Each new element gets a fresh xml:id so the
// expression cursor can locate it in the rendered SVG via rectForId().
//
// Moment = (measureIdx, tstamp). measureIdx is 0-based; tstamp is the MEI
// beat float (1.0 = downbeat; 4/4 measure has tstamps [1.0, 5.0)).

import { DYNAMIC_NAMES, DEFAULT_DYNAMIC_MAP } from '@hkl/shared/dynamics.js';
import { TUNING_MODES, type TuningMode } from '@hkl/shared/freq.js';

export const MEI_NS = 'http://www.music-encoding.org/ns/mei';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
export const HKL_NS = 'https://hexkeylab.com/ns/mei';

export interface Moment {
  measureIdx: number;
  tstamp: number;
}

/* ── id minting (self-contained; doesn't share model.ts's counter) ───────── */

let nextSeq = 1_000_000;
function newId(prefix: string): string {
  nextSeq++;
  return prefix + '-' + nextSeq.toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

function createMei(doc: Document, name: string, attrs?: Record<string, string | number | undefined>): Element {
  const e = doc.createElementNS(MEI_NS, name);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === undefined || v === null || v === '') continue;
      if (k === 'xml:id') {
        e.setAttributeNS(XML_NS, 'xml:id', String(v));
      } else {
        e.setAttribute(k, String(v));
      }
    }
  }
  return e;
}

/* ── tstamp formatting / parsing ─────────────────────────────────────────── */

function trimFloat(x: number): string {
  /* MEI tstamps are commonly emitted with at most 3 decimal places; strip
     trailing zeros so a whole-number beat looks like "1" not "1.000". */
  return x.toFixed(3).replace(/\.?0+$/, '');
}

export function formatTstamp(t: number): string {
  return trimFloat(t);
}

/** Emit "Nm+beat" where N is endMeasureIdx − startMeasureIdx. */
export function formatTstamp2(start: Moment, end: Moment): string {
  const dm = end.measureIdx - start.measureIdx;
  return dm + 'm+' + trimFloat(end.tstamp);
}

/** Parse "Nm+B" or shorthand "B" (same-measure). Returns null on malformed. */
export function parseTstamp2(s: string, baseMeasureIdx: number): Moment | null {
  if (!s) return null;
  const m = s.match(/^(?:(\d+)m\+)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const dm = m[1] !== undefined ? parseInt(m[1], 10) : 0;
  const beat = parseFloat(m[2]);
  if (!isFinite(dm) || !isFinite(beat)) return null;
  return { measureIdx: baseMeasureIdx + dm, tstamp: beat };
}

/* ── moment ↔ tick conversion (depends on meter) ─────────────────────────── */

export function readMeter(doc: Document): { count: number; unit: number } {
  const sd = doc.querySelector('scoreDef');
  const count = parseInt(sd?.getAttribute('meter.count') ?? '4', 10);
  const unit = parseInt(sd?.getAttribute('meter.unit') ?? '4', 10);
  return { count: isFinite(count) ? count : 4, unit: isFinite(unit) ? unit : 4 };
}

/** Cumulative start tick of measure `measureIdx` and the beat unit in effect
 *  there — walking in-section `<scoreDef>` meter overrides (mid-piece meter
 *  changes), seeded by the head meter. Doc-local (no model), mirroring the
 *  per-measure key walk in computeAccidentalDisplay. Out-of-range indices
 *  extrapolate past the last measure with the last-known meter. */
function measureTickInfo(doc: Document, measureIdx: number): { startTick: number; ticksPerBeat: number } {
  const head = readMeter(doc);
  let count = head.count;
  let unit = head.unit;
  const section = doc.querySelector('section');
  const nodes = section
    ? Array.from(section.querySelectorAll('scoreDef, measure'))
    : Array.from(doc.querySelectorAll('measure'));
  let tick = 0;
  let mi = 0;
  for (const node of nodes) {
    if (node.localName === 'scoreDef') {
      const c = node.getAttribute('meter.count');
      const u = node.getAttribute('meter.unit');
      if (c) count = parseInt(c, 10);
      if (u) unit = parseInt(u, 10);
    } else {
      if (mi === measureIdx) return { startTick: tick, ticksPerBeat: 64 / unit };
      tick += count * (64 / unit);
      mi++;
    }
  }
  return { startTick: tick, ticksPerBeat: 64 / unit };
}

/** Absolute 64th-note tick offset for a Moment. Per-measure-meter aware: the
 *  measure's cumulative start plus `(tstamp-1)` beats of THAT measure's meter. */
export function absoluteTickForMoment(doc: Document, m: Moment): number {
  const { startTick, ticksPerBeat } = measureTickInfo(doc, m.measureIdx);
  return startTick + (m.tstamp - 1) * ticksPerBeat;
}

/* ── element CRUD ────────────────────────────────────────────────────────── */

function getMeasures(doc: Document): Element[] {
  return Array.from(doc.querySelectorAll('measure'));
}

function measureAtIdx(doc: Document, idx: number): Element | null {
  return getMeasures(doc)[idx] ?? null;
}

function appendAtEnd(measure: Element, child: Element): void {
  /* By convention: append after all <staff> elements. Since we keep no
     hard ordering constraint between control-event siblings, plain
     appendChild is correct. */
  measure.appendChild(child);
}

const TS_EPSILON = 1e-6;

function approxEq(a: number, b: number): boolean {
  return Math.abs(a - b) < TS_EPSILON;
}

function readTstamp(el: Element): number | null {
  const t = el.getAttribute('tstamp');
  if (t === null) return null;
  const n = parseFloat(t);
  return isFinite(n) ? n : null;
}

function readStartMoment(el: Element, measures: Element[]): Moment | null {
  const m = el.closest('measure');
  if (!m) return null;
  const idx = measures.indexOf(m);
  if (idx < 0) return null;
  const t = readTstamp(el);
  if (t === null) return null;
  return { measureIdx: idx, tstamp: t };
}

function readEndMoment(el: Element, measures: Element[]): Moment | null {
  const start = readStartMoment(el, measures);
  if (!start) return null;
  const ts2 = el.getAttribute('tstamp2');
  if (!ts2) return null;
  return parseTstamp2(ts2, start.measureIdx);
}

export interface DynamOpts {
  text: string;
  place?: 'above' | 'below' | 'between';
  staff?: number;
  val?: number;
  vgrp?: number;
}

export function addDynam(doc: Document, at: Moment, opts: DynamOpts): Element | null {
  const measure = measureAtIdx(doc, at.measureIdx);
  if (!measure) return null;
  const attrs: Record<string, string | number | undefined> = {
    'xml:id': newId('d'),
    tstamp: formatTstamp(at.tstamp),
    place: opts.place ?? 'between',
    staff: opts.staff ?? 1,
  };
  if (opts.val !== undefined) attrs.val = Math.max(0, Math.min(127, opts.val | 0));
  if (opts.vgrp !== undefined) attrs.vgrp = opts.vgrp;
  const el = createMei(doc, 'dynam', attrs);
  el.textContent = opts.text;
  appendAtEnd(measure, el);
  return el;
}

export interface HairpinOpts {
  form: 'cres' | 'dim';
  place?: 'above' | 'below' | 'between';
  staff?: number;
  vgrp?: number;
}

export function addHairpin(doc: Document, start: Moment, end: Moment, opts: HairpinOpts): Element | null {
  const measure = measureAtIdx(doc, start.measureIdx);
  if (!measure) return null;
  /* Reject zero/negative spans defensively (caller should already filter). */
  if (end.measureIdx < start.measureIdx) return null;
  if (end.measureIdx === start.measureIdx && end.tstamp <= start.tstamp + TS_EPSILON) return null;
  const attrs: Record<string, string | number | undefined> = {
    'xml:id': newId('h'),
    tstamp: formatTstamp(start.tstamp),
    tstamp2: formatTstamp2(start, end),
    form: opts.form,
    place: opts.place ?? 'between',
    staff: opts.staff ?? 1,
  };
  if (opts.vgrp !== undefined) attrs.vgrp = opts.vgrp;
  const el = createMei(doc, 'hairpin', attrs);
  appendAtEnd(measure, el);
  return el;
}

/* ── <octave> (8va / 8vb ottava lines) ───────────────────────────────────── */

export interface OctaveOpts {
  /** Interval of transposition: 8 = one octave, 15 = two octaves. */
  dis: 8 | 15;
  /** Bracket placement: above = sounds higher (8va), below = lower (8vb). */
  place: 'above' | 'below';
  /** Target staff (1 = treble, 2 = bass). Shifts BOTH voices of that staff. */
  staff: number;
  /** xml:id of the first / last slot the bracket spans. Verovio renders an
   *  ottava from @startid/@endid (it will NOT draw one from @tstamp alone —
   *  an empty <octave> group results); @tstamp/@tstamp2 are kept for the
   *  playback tick-span and toggle lookup. */
  startId?: string;
  endId?: string;
}

/** Add an <octave> spanning [start, end] on `opts.staff`. Verovio draws the
 *  ottava bracket from @startid/@endid ONLY — it warns if @tstamp is also
 *  present, so the playback tick-span is carried on Verovio-ignored
 *  `data-hkl-t0`/`data-hkl-t1` attributes (the same convention as tempo's
 *  data-hkl-* flags), read back by collectOctaves. */
export function addOctave(doc: Document, start: Moment, end: Moment, opts: OctaveOpts): Element | null {
  const measure = measureAtIdx(doc, start.measureIdx);
  if (!measure) return null;
  if (end.measureIdx < start.measureIdx) return null;
  if (end.measureIdx === start.measureIdx && end.tstamp < start.tstamp - TS_EPSILON) return null;
  const el = createMei(doc, 'octave', {
    'xml:id': newId('oct'),
    dis: opts.dis,
    'dis.place': opts.place,
    staff: opts.staff,
    startid: opts.startId ? '#' + opts.startId : undefined,
    endid: opts.endId ? '#' + opts.endId : undefined,
    'data-hkl-t0': absoluteTickForMoment(doc, start),
    'data-hkl-t1': absoluteTickForMoment(doc, end),
  });
  appendAtEnd(measure, el);
  return el;
}

/** The <octave> on `staff` whose start tick matches `startTick` (toggle
 *  lookup). */
export function octaveAt(doc: Document, startTick: number, staff: number): Element | null {
  for (const el of Array.from(doc.querySelectorAll('octave'))) {
    if (parseInt(el.getAttribute('staff') ?? '0', 10) !== staff) continue;
    const t0 = parseFloat(el.getAttribute('data-hkl-t0') ?? 'NaN');
    if (isFinite(t0) && Math.abs(t0 - startTick) < 0.5) return el;
  }
  return null;
}

export interface OctaveRecord {
  startTick: number;
  endTick: number;
  staff: number;
  /** q-shift to apply to spanned notes: +3 per octave above, −3 per below. */
  qShift: number;
}

/** Collect every <octave> as a tick-span record for playback pitch shifting. */
export function collectOctaves(doc: Document): OctaveRecord[] {
  const out: OctaveRecord[] = [];
  for (const el of Array.from(doc.querySelectorAll('octave'))) {
    const t0 = parseFloat(el.getAttribute('data-hkl-t0') ?? 'NaN');
    const t1 = parseFloat(el.getAttribute('data-hkl-t1') ?? 'NaN');
    if (!isFinite(t0) || !isFinite(t1)) continue;
    const dis = parseInt(el.getAttribute('dis') ?? '8', 10);
    const octaves = dis >= 15 ? 2 : 1;
    const place = el.getAttribute('dis.place') ?? 'above';
    const staff = parseInt(el.getAttribute('staff') ?? '1', 10);
    out.push({
      startTick: t0,
      endTick: t1,
      staff,
      qShift: (place === 'below' ? -3 : 3) * octaves,
    });
  }
  return out;
}

/** Set the text content of an existing <dynam>. */
export function setDynamText(el: Element, text: string): void {
  el.textContent = text;
}

/** Remove an expression element from its parent. */
export function removeExpression(el: Element): void {
  el.parentNode?.removeChild(el);
}

/* ── <dir> (expressive text: pizz, dolce, sul tasto, …) ──────────────────── */

export interface DirOpts {
  text: string;
  italic?: boolean;
  place?: 'above' | 'below' | 'between';
  staff?: number;
}

/** Set a <dir>'s content. Italic wraps the text in <rend fontstyle="italic">;
 *  otherwise it's a plain text node. Clears any prior content first. */
function setDirContent(el: Element, text: string, italic: boolean): void {
  while (el.firstChild) el.removeChild(el.firstChild);
  if (italic) {
    const rend = el.ownerDocument!.createElementNS(MEI_NS, 'rend');
    rend.setAttribute('fontstyle', 'italic');
    rend.textContent = text;
    el.appendChild(rend);
  } else {
    el.textContent = text;
  }
}

/** Add a <dir> (expressive text) at the moment, sibling of <staff>, @tstamp
 *  anchored — same shape as <dynam>. Default place 'below' (the conventional
 *  spot for performance text under the staff); 2.4 will toggle place. */
export function addDir(doc: Document, at: Moment, opts: DirOpts): Element | null {
  const measure = measureAtIdx(doc, at.measureIdx);
  if (!measure) return null;
  const el = createMei(doc, 'dir', {
    'xml:id': newId('dir'),
    tstamp: formatTstamp(at.tstamp),
    place: opts.place ?? 'below',
    staff: opts.staff ?? 1,
  });
  setDirContent(el, opts.text, !!opts.italic);
  appendAtEnd(measure, el);
  return el;
}

/** Find a <dir> exactly at the given moment (first match). */
export function dirAt(doc: Document, m: Moment): Element | null {
  const measures = getMeasures(doc);
  const measure = measures[m.measureIdx];
  if (!measure) return null;
  for (const child of Array.from(measure.children)) {
    if (child.localName !== 'dir') continue;
    const t = readTstamp(child);
    if (t !== null && approxEq(t, m.tstamp)) return child;
  }
  return null;
}

/** The plain text of a <dir> (recurses through any <rend> wrapper). */
export function dirText(el: Element): string {
  return (el.textContent ?? '').trim();
}

/** True iff the <dir>'s text is wrapped in an italic <rend>. */
export function dirIsItalic(el: Element): boolean {
  for (const c of Array.from(el.children)) {
    if (c.localName === 'rend' && c.getAttribute('fontstyle') === 'italic') return true;
  }
  return false;
}

/** Replace a <dir>'s text + italic state in place. */
export function setDirText(el: Element, text: string, italic: boolean): void {
  setDirContent(el, text, italic);
}

/* ── <tempo> (instant tempo, gradual rit/accel, "a tempo") ───────────────── */

export type GradualDir = 'rit' | 'accel';
export type GradualIntensity = 'poco' | 'plain' | 'molto';

/* SMuFL "Metronome marks" codepoints. Verovio renders these in its music font
 *  (Leipzig) when they're the content of a <rend glyph.auth="smufl"> — which is
 *  exactly the encoding Verovio itself emits from a MusicXML metronome. (The
 *  @mm/@mm.unit attributes alone render nothing in this build; plain Unicode
 *  note chars like U+2669 render in the serif text font and look wrong.) */
const SMUFL_METRONOME_NOTE: Record<number, number> = {
  2: 0xECA3, /* metNoteHalfUp */
  4: 0xECA5, /* metNoteQuarterUp */
  8: 0xECA7, /* metNote8thUp */
};
const SMUFL_METRONOME_DOT = 0xECB7; /* metAugmentationDot */

/** The SMuFL beat-note glyph string for a metronome mark (note, plus a space +
 *  augmentation dot when dotted — matching Verovio's own emitted form). */
export function mmGlyph(unit: number, dots: number): string {
  const note = String.fromCodePoint(SMUFL_METRONOME_NOTE[unit] ?? SMUFL_METRONOME_NOTE[4]);
  return dots > 0 ? note + ' ' + String.fromCodePoint(SMUFL_METRONOME_DOT) : note;
}

/** Derive gradual intensity from the marking text (Max's rule): "molto" →
 *  molto, "poco" → poco, else plain. The per-document Setup percentages then
 *  supply the magnitude — no per-mark intensity field. */
export function deriveGradualIntensity(text: string): GradualIntensity {
  const t = text.toLowerCase();
  if (t.includes('molto')) return 'molto';
  if (t.includes('poco')) return 'poco';
  return 'plain';
}

export interface TempoOpts {
  /** Verbal marking text (no metronome — that's composed in via showMm). */
  text: string;
  /** Metronome bpm for an instant tempo marking. Omit / 0 for a verbal-only
   *  or gradual mark. */
  bpm?: number;
  /** Beat note value (mm.unit): 1, 2, 4, 8. Default 4 (quarter). */
  unit?: number;
  dots?: number;
  /** Show the "<glyph> = bpm" metronome after the text (composed into the
   *  rendered text). The bpm/unit are still stored for playback either way. */
  showMm?: boolean;
  /** Render italic (expression style, e.g. "rit.") vs upright (tempo marking). */
  italic?: boolean;
  /** Gradual change direction; absent = instant. */
  gradual?: GradualDir;
  /** Explicit gradual endpoint. Absent = open-ended (resolved at playback;
   *  intensity is derived from the text). */
  end?: Moment | null;
  /** Marks an "a tempo" — ends a preceding gradual and restores its prior bpm. */
  aTempo?: boolean;
  place?: 'above' | 'below' | 'between';
  staff?: number;
}

/** Build a <tempo>'s content: the verbal text (optionally italic-wrapped), and
 *  — when a metronome is requested — a SMuFL note glyph in a
 *  <rend glyph.auth="smufl"> followed by " = bpm" (mixed content, the form
 *  Verovio renders). */
function setTempoContent(
  el: Element, text: string, italic: boolean,
  mm?: { bpm: number; unit: number; dots: number },
): void {
  const doc = el.ownerDocument!;
  while (el.firstChild) el.removeChild(el.firstChild);
  if (text) {
    if (italic) {
      const rend = doc.createElementNS(MEI_NS, 'rend');
      rend.setAttribute('fontstyle', 'italic');
      rend.textContent = text;
      el.appendChild(rend);
    } else {
      el.appendChild(doc.createTextNode(text));
    }
  }
  if (mm) {
    /* Parenthesized metronome block: "(♩ = 120)". */
    el.appendChild(doc.createTextNode(text ? ' (' : '('));
    const glyph = doc.createElementNS(MEI_NS, 'rend');
    glyph.setAttribute('glyph.auth', 'smufl');
    glyph.textContent = mmGlyph(mm.unit, mm.dots);
    el.appendChild(glyph);
    el.appendChild(doc.createTextNode(' = ' + mm.bpm + ')'));
  }
}

/** Add a <tempo> at the moment, sibling of <staff>, @tstamp anchored. Instant
 *  markings carry @mm/@mm.unit (Verovio renders "text ♩=bpm"); gradual marks
 *  carry data-hkl-gradual/-intensity + optional @tstamp2; "a tempo" carries
 *  data-hkl-atempo. Default place 'above' (the conventional tempo spot). */
export function addTempo(doc: Document, at: Moment, opts: TempoOpts): Element | null {
  const measure = measureAtIdx(doc, at.measureIdx);
  if (!measure) return null;
  const attrs: Record<string, string | number | undefined> = {
    'xml:id': newId('tempo'),
    tstamp: formatTstamp(at.tstamp),
    place: opts.place ?? 'above',
    staff: opts.staff ?? 1,
  };
  const hasBpm = opts.bpm !== undefined && opts.bpm > 0 && !opts.gradual;
  const unit = opts.unit ?? 4;
  const dots = opts.dots ?? 0;
  if (hasBpm) {
    /* Always store the metronome data (playback + export); display is gated by
       showMm via the composed text below. */
    attrs.mm = opts.bpm;
    attrs['midi.bpm'] = opts.bpm;
    attrs['mm.unit'] = unit;
    if (dots) attrs['mm.dots'] = dots;
  }
  if (opts.gradual) {
    /* Direction is explicit; intensity is derived from the text at read time
       (deriveGradualIntensity), so no data-hkl-intensity attribute. */
    attrs['data-hkl-gradual'] = opts.gradual;
    if (opts.end) attrs.tstamp2 = formatTstamp2(at, opts.end);
  }
  if (opts.aTempo) attrs['data-hkl-atempo'] = 'true';
  const showMm = hasBpm && !!opts.showMm;
  if (showMm) attrs['data-hkl-mm-shown'] = 'true';
  const el = createMei(doc, 'tempo', attrs);
  /* The verbal text stays plain text; the metronome (when shown) is a SMuFL
     <rend> glyph + " = bpm" appended as mixed content. The bare verbal text is
     recovered on edit via tempoVerbalText (text before the SMuFL rend). */
  setTempoContent(el, opts.text, !!opts.italic,
    showMm ? { bpm: opts.bpm!, unit, dots } : undefined);
  appendAtEnd(measure, el);
  return el;
}

/** The verbal text of a <tempo> — everything before the SMuFL metronome rend
 *  (so an edit recovers "Allegro" from "Allegro ♩ = 120"). */
function tempoVerbalText(el: Element): string {
  let s = '';
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 1 && (n as Element).localName === 'rend'
        && (n as Element).getAttribute('glyph.auth') === 'smufl') break;
    s += n.textContent ?? '';
  }
  /* Drop the trailing "(" of the parenthesized metronome block, if present. */
  return s.replace(/\s*\(\s*$/, '').trim();
}

/** Find a <tempo> exactly at the given moment (first match). */
export function tempoAt(doc: Document, m: Moment): Element | null {
  const measure = getMeasures(doc)[m.measureIdx];
  if (!measure) return null;
  for (const child of Array.from(measure.children)) {
    if (child.localName !== 'tempo') continue;
    const t = readTstamp(child);
    if (t !== null && approxEq(t, m.tstamp)) return child;
  }
  return null;
}

export interface TempoRecord {
  el: Element;
  moment: Moment;
  /** Bare verbal text (metronome suffix stripped). */
  text: string;
  /** Metronome bpm, or null for verbal-only / gradual marks. */
  bpm: number | null;
  unit: number;
  dots: number;
  /** Whether the metronome "<glyph> = bpm" is shown in the rendered text. */
  showMm: boolean;
  gradual: GradualDir | null;
  /** Derived from the text (poco/molto/plain). */
  intensity: GradualIntensity;
  /** Explicit gradual endpoint, or null (open-ended). */
  end: Moment | null;
  aTempo: boolean;
}

function parseTempoEl(el: Element, measures: Element[]): TempoRecord | null {
  const measure = el.closest('measure');
  if (!measure) return null;
  const idx = measures.indexOf(measure);
  if (idx < 0) return null;
  const t = readTstamp(el);
  if (t === null) return null;
  const moment: Moment = { measureIdx: idx, tstamp: t };
  const mmAttr = el.getAttribute('mm') ?? el.getAttribute('midi.bpm');
  const bpm = mmAttr !== null && isFinite(parseFloat(mmAttr)) ? parseFloat(mmAttr) : null;
  const unit = parseInt(el.getAttribute('mm.unit') ?? '4', 10) || 4;
  const dots = parseInt(el.getAttribute('mm.dots') ?? '0', 10) || 0;
  const gradAttr = el.getAttribute('data-hkl-gradual');
  const gradual: GradualDir | null = gradAttr === 'rit' || gradAttr === 'accel' ? gradAttr : null;
  const ts2 = el.getAttribute('tstamp2');
  const end = ts2 ? parseTstamp2(ts2, idx) : null;
  const aTempo = el.getAttribute('data-hkl-atempo') === 'true';
  const showMm = el.getAttribute('data-hkl-mm-shown') === 'true';
  const text = tempoVerbalText(el);
  const intensity = deriveGradualIntensity(text);
  return { el, moment, text, bpm, unit, dots, showMm, gradual, intensity, end, aTempo };
}

/** All <tempo> elements with resolved moments + parsed fields, sorted. */
export function collectTempi(doc: Document): TempoRecord[] {
  const measures = getMeasures(doc);
  const out: TempoRecord[] = [];
  for (const el of Array.from(doc.querySelectorAll('tempo'))) {
    const rec = parseTempoEl(el, measures);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => momentCompare(a.moment, b.moment));
  return out;
}

/** Read a single <tempo> element's fields (for modal edit-in-place). */
export function readTempoEl(el: Element): TempoRecord | null {
  return parseTempoEl(el, getMeasures(el.ownerDocument!));
}

/** Moments of all <tempo> marks (for expression-layer navigation). */
export function tempoMoments(doc: Document): Moment[] {
  return collectTempi(doc).map((r) => r.moment);
}

/* ── gradual rit/accel intensity percentages (document config) ───────────── */

export interface GradualPercents { poco: number; plain: number; molto: number }
const DEFAULT_GRADUAL_PERCENTS: GradualPercents = { poco: 20, plain: 40, molto: 60 };

/** Read the open-ended gradual magnitude percentages from <hkl:config>. */
export function getGradualPercents(doc: Document): GradualPercents {
  const cfg = findHklConfig(doc);
  const out = { ...DEFAULT_GRADUAL_PERCENTS };
  if (!cfg) return out;
  for (const k of ['poco', 'plain', 'molto'] as const) {
    const v = parseFloat(cfg.getAttribute('gradual_' + k) ?? '');
    if (isFinite(v)) out[k] = Math.max(0, Math.min(99, v));
  }
  return out;
}

/** Write the gradual magnitude percentages to <hkl:config>. */
export function setGradualPercents(doc: Document, p: GradualPercents): void {
  const cfg = ensureExtMetaConfig(doc);
  for (const k of ['poco', 'plain', 'molto'] as const) {
    cfg.setAttribute('gradual_' + k, String(Math.max(0, Math.min(99, Math.round(p[k])))));
  }
}

/* ── queries ─────────────────────────────────────────────────────────────── */

/** Find a <dynam> exactly at the given moment. */
export function dynamAt(doc: Document, m: Moment): Element | null {
  const measures = getMeasures(doc);
  const measure = measures[m.measureIdx];
  if (!measure) return null;
  for (const child of Array.from(measure.children)) {
    if (child.localName !== 'dynam') continue;
    const t = readTstamp(child);
    if (t !== null && approxEq(t, m.tstamp)) return child;
  }
  return null;
}

/** Return all <hairpin> elements whose [start, end] range (inclusive)
 *  contains the given moment. */
export function hairpinsAt(doc: Document, m: Moment): Element[] {
  const measures = getMeasures(doc);
  const out: Element[] = [];
  for (const el of Array.from(doc.querySelectorAll('hairpin'))) {
    const s = readStartMoment(el, measures);
    const e = readEndMoment(el, measures);
    if (!s || !e) continue;
    if (momentLE(s, m) && momentLE(m, e)) out.push(el);
  }
  return out;
}

function momentLE(a: Moment, b: Moment): boolean {
  if (a.measureIdx < b.measureIdx) return true;
  if (a.measureIdx > b.measureIdx) return false;
  return a.tstamp <= b.tstamp + TS_EPSILON;
}

export function momentEqual(a: Moment, b: Moment): boolean {
  return a.measureIdx === b.measureIdx && approxEq(a.tstamp, b.tstamp);
}

export function momentCompare(a: Moment, b: Moment): number {
  if (a.measureIdx !== b.measureIdx) return a.measureIdx - b.measureIdx;
  if (approxEq(a.tstamp, b.tstamp)) return 0;
  return a.tstamp - b.tstamp;
}

/** True iff `measureIdx` contains or is spanned by any expression element
 *  (<dynam> or <hairpin>). Dynams live as direct children of their own
 *  measure; hairpins live in their start measure but span [start, end]
 *  inclusively, so a hairpin starting in M_1 and ending in M_3 reports
 *  true for M_2 as well. Used by `cycleVoice` to skip the expression
 *  layer when entering it would land on a measure with nothing to edit. */
export function measureHasExpression(doc: Document, measureIdx: number): boolean {
  const measures = getMeasures(doc);
  if (measureIdx < 0 || measureIdx >= measures.length) return false;
  const target = measures[measureIdx];
  for (const child of Array.from(target.children)) {
    if (child.localName === 'dynam' || child.localName === 'dir') return true;
  }
  for (const el of Array.from(doc.querySelectorAll('hairpin'))) {
    const s = readStartMoment(el, measures);
    const e = readEndMoment(el, measures);
    if (!s || !e) continue;
    if (s.measureIdx <= measureIdx && measureIdx <= e.measureIdx) return true;
  }
  return false;
}

/** All <dynam> and <hairpin> moments (hairpins contribute BOTH start and
 *  end moments). Used by the expression cursor's moment-snap navigation
 *  so existing markings are reachable even when no note shares the moment. */
export function expressionMoments(doc: Document): Moment[] {
  const measures = getMeasures(doc);
  const out: Moment[] = [];
  for (const d of Array.from(doc.querySelectorAll('dynam'))) {
    const m = readStartMoment(d, measures);
    if (m) out.push(m);
  }
  for (const h of Array.from(doc.querySelectorAll('hairpin'))) {
    const s = readStartMoment(h, measures);
    const e = readEndMoment(h, measures);
    if (s) out.push(s);
    if (e) out.push(e);
  }
  return out;
}

/** All <dynam> elements with their resolved moments and parsed velocity (from
 *  @val if present, else from the dynamic-name map). Sorted ascending. */
export interface DynamRecord {
  el: Element;
  moment: Moment;
  text: string;
  velocity: number;
}
export function collectDynams(doc: Document, dynamicMap: Record<string, number>): DynamRecord[] {
  const measures = getMeasures(doc);
  const out: DynamRecord[] = [];
  for (const el of Array.from(doc.querySelectorAll('dynam'))) {
    const moment = readStartMoment(el, measures);
    if (!moment) continue;
    const text = (el.textContent ?? '').trim();
    const valAttr = el.getAttribute('val');
    let velocity: number;
    if (valAttr !== null) {
      const v = parseInt(valAttr, 10);
      velocity = isFinite(v) ? Math.max(0, Math.min(127, v)) : (dynamicMap[text] ?? 85);
    } else {
      velocity = dynamicMap[text] ?? 85;
    }
    out.push({ el, moment, text, velocity });
  }
  out.sort((a, b) => momentCompare(a.moment, b.moment));
  return out;
}

/** All <hairpin> elements with resolved start/end moments. */
export interface HairpinRecord {
  el: Element;
  start: Moment;
  end: Moment;
  form: 'cres' | 'dim';
}
export function collectHairpins(doc: Document): HairpinRecord[] {
  const measures = getMeasures(doc);
  const out: HairpinRecord[] = [];
  for (const el of Array.from(doc.querySelectorAll('hairpin'))) {
    const start = readStartMoment(el, measures);
    const end = readEndMoment(el, measures);
    if (!start || !end) continue;
    const formAttr = el.getAttribute('form');
    const form: 'cres' | 'dim' = formAttr === 'dim' ? 'dim' : 'cres';
    out.push({ el, start, end, form });
  }
  out.sort((a, b) => momentCompare(a.start, b.start));
  return out;
}

/* ── <extMeta> / <hkl:config> defaults ───────────────────────────────────── */

function findHklConfig(doc: Document): Element | null {
  const cfg = doc.getElementsByTagNameNS(HKL_NS, 'config');
  return cfg.length > 0 ? cfg[0] : null;
}

function ensureExtMetaConfig(doc: Document): Element {
  let cfg = findHklConfig(doc);
  if (cfg) return cfg;
  const meiHead = doc.querySelector('meiHead');
  if (!meiHead) throw new Error('meiHead missing');
  let extMeta = meiHead.querySelector('extMeta');
  if (!extMeta) {
    extMeta = createMei(doc, 'extMeta');
    meiHead.appendChild(extMeta);
  }
  cfg = doc.createElementNS(HKL_NS, 'hkl:config');
  extMeta.appendChild(cfg);
  /* Seed defaults so callers can always rely on the structure existing. */
  seedDefaults(cfg, doc);
  return cfg;
}

function seedDefaults(cfg: Element, doc: Document): void {
  /* dynamicMap */
  let dm = childInHklNs(cfg, 'dynamicMap');
  if (!dm) {
    dm = doc.createElementNS(HKL_NS, 'hkl:dynamicMap');
    cfg.appendChild(dm);
  }
  for (const name of DYNAMIC_NAMES) {
    const existing = Array.from(dm.children).find((c) =>
      c.namespaceURI === HKL_NS && c.localName === 'level' && c.getAttribute('name') === name);
    if (existing) continue;
    const level = doc.createElementNS(HKL_NS, 'hkl:level');
    level.setAttribute('name', name);
    level.setAttribute('velocity', String(DEFAULT_DYNAMIC_MAP[name]));
    dm.appendChild(level);
  }
  /* layoutReq — the tuning mode + ref note pinned by this score. Default '5'
     (Ptolemaic) matches HKL's default tuning so legacy files without the block
     load as Ptolemaic, which is what they almost certainly were entered in. */
  let lr = childInHklNs(cfg, 'layoutReq');
  if (!lr) {
    lr = doc.createElementNS(HKL_NS, 'hkl:layoutReq');
    lr.setAttribute('tuningMode', '5');
    lr.setAttribute('refQ', '0');
    lr.setAttribute('refR', '0');
    cfg.appendChild(lr);
  }
}

export interface LayoutReq {
  tuningMode: TuningMode;
  refQ: number;
  refR: number;
}

function isTuningMode(s: string): s is TuningMode {
  return (TUNING_MODES as ReadonlyArray<string>).indexOf(s) >= 0;
}

/** Read the score's required layout from <hkl:layoutReq>. Returns Ptolemaic
 *  defaults if the block is missing or malformed — but seedDefaults runs on
 *  every load, so this fallback is purely defensive. */
export function getLayoutReq(doc: Document): LayoutReq {
  const cfg = findHklConfig(doc);
  if (cfg) {
    const lr = childInHklNs(cfg, 'layoutReq');
    if (lr) {
      const m = lr.getAttribute('tuningMode') ?? '5';
      const qStr = lr.getAttribute('refQ') ?? '0';
      const rStr = lr.getAttribute('refR') ?? '0';
      const q = parseInt(qStr, 10);
      const r = parseInt(rStr, 10);
      return {
        tuningMode: isTuningMode(m) ? m : '5',
        refQ: Number.isFinite(q) ? q : 0,
        refR: Number.isFinite(r) ? r : 0,
      };
    }
  }
  return { tuningMode: '5', refQ: 0, refR: 0 };
}

/** Write the score's required layout. Creates the block via ensureExtMetaConfig
 *  + seedDefaults if missing, then overwrites the attrs in place. */
export function setLayoutReq(doc: Document, req: LayoutReq): void {
  const cfg = ensureExtMetaConfig(doc);
  let lr = childInHklNs(cfg, 'layoutReq');
  if (!lr) {
    lr = doc.createElementNS(HKL_NS, 'hkl:layoutReq');
    cfg.appendChild(lr);
  }
  lr.setAttribute('tuningMode', req.tuningMode);
  lr.setAttribute('refQ', String(req.refQ));
  lr.setAttribute('refR', String(req.refR));
}

/** Document-level "show HEJI accidentals" flag, stored on <hkl:config>.
 *  Independent of HKL's own hejiEnabled. Defaults false. */
export function getHejiEnabled(doc: Document): boolean {
  const cfg = findHklConfig(doc);
  return cfg?.getAttribute('heji') === 'true';
}

export function setHejiEnabled(doc: Document, on: boolean): void {
  const cfg = ensureExtMetaConfig(doc);
  cfg.setAttribute('heji', on ? 'true' : 'false');
}

function childInHklNs(parent: Element, localName: string): Element | null {
  for (const c of Array.from(parent.children)) {
    if (c.namespaceURI === HKL_NS && c.localName === localName) return c;
  }
  return null;
}

/** Initialise <extMeta>/<hkl:config> defaults if they're missing. Idempotent.
 *  Called on document creation and on load/migration. */
export function ensureExpressionDefaults(doc: Document): void {
  ensureExtMetaConfig(doc);
}

/** Read the document-level dynamic→velocity map. Falls back to defaults for
 *  any missing entry. */
export function getDynamicMap(doc: Document): Record<string, number> {
  const cfg = findHklConfig(doc);
  const out: Record<string, number> = { ...DEFAULT_DYNAMIC_MAP };
  if (!cfg) return out;
  const dm = childInHklNs(cfg, 'dynamicMap');
  if (!dm) return out;
  for (const lvl of Array.from(dm.children)) {
    if (lvl.namespaceURI !== HKL_NS || lvl.localName !== 'level') continue;
    const name = lvl.getAttribute('name');
    const velStr = lvl.getAttribute('velocity');
    if (!name || velStr === null) continue;
    const v = parseInt(velStr, 10);
    if (isFinite(v)) out[name] = Math.max(0, Math.min(127, v));
  }
  return out;
}

/** Write the dynamic→velocity map. Replaces existing levels by name. */
export function setDynamicMap(doc: Document, map: Record<string, number>): void {
  const cfg = ensureExtMetaConfig(doc);
  let dm = childInHklNs(cfg, 'dynamicMap');
  if (!dm) {
    dm = doc.createElementNS(HKL_NS, 'hkl:dynamicMap');
    cfg.appendChild(dm);
  }
  for (const [name, velocity] of Object.entries(map)) {
    let lvl = Array.from(dm.children).find((c) =>
      c.namespaceURI === HKL_NS && c.localName === 'level' && c.getAttribute('name') === name) ?? null;
    if (!lvl) {
      lvl = doc.createElementNS(HKL_NS, 'hkl:level');
      lvl.setAttribute('name', name);
      dm.appendChild(lvl);
    }
    lvl.setAttribute('velocity', String(Math.max(0, Math.min(127, velocity | 0))));
  }
}
