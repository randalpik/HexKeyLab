// Composer MEI model. In-memory MEI 5 DOM with mutation operations for
// keyboard-driven step entry. Serializes to a string for Verovio's loadData().
//
// Structure:
//   1 mdiv / 1 score / 1 section
//   <scoreDef> carries key.sig, meter.count, meter.unit
//   <section> contains a flat ordered list of <measure> elements
//   Each <measure> has a <staffGrp> of two <staff>, each with two <layer>
//   Voices map to (staff, layer):
//     voice 1 → staff 1, layer 1   (treble top)
//     voice 2 → staff 1, layer 2   (treble bottom)
//     voice 3 → staff 2, layer 1   (bass top)
//     voice 4 → staff 2, layer 2   (bass bottom)
//   Per voice, per measure: an ordered list of <chord>, <note>, or <rest>
//   elements as immediate children of the layer.
//
// The "linear cursor" abstraction (per voice) indexes into the concatenation
// of all (measure × layer-children) so callers never see measure boundaries.
// Inserts overflowing a measure are split via `decomposeTicks` and connected
// with `@tie` so notation stays representable.
//
// (q, r) lattice coordinates ride along on each <note> as data-q / data-r
// attributes so future tools can recover the lattice identity from a saved
// .hkc file. MEI ignores unknown attributes.

import type { ResolvedNote } from '../bridge/protocol.js';
import { regroupBeams, readTimeSig } from './beams.js';
import { computeAccidentalDisplay } from './accidentals.js';

/* ── public types ────────────────────────────────────────────────────────── */

export type Voice = 1 | 2 | 3 | 4;
export type Duration = '1' | '2' | '4' | '8' | '16' | '32' | '64';
export type Dots = 0 | 1 | 2;

export interface ChordInput {
  notes: ReadonlyArray<ResolvedNote>;
  duration: Duration;
  dots?: Dots;
}

export interface RestInput {
  duration: Duration;
  dots?: Dots;
}

export type CurrentRef = { index: number; id: string; elem: Element } | null;

export interface SetupDefaults {
  title?: string;
  composer?: string;
  keySig?: string;           /* "0" | "1s".."7s" | "1f".."7f" */
  meterCount?: number;
  meterUnit?: number;
  tempoBpm?: number;
  tempoUnit?: '1' | '2' | '4' | '8';
  tempoDots?: 0 | 1;
  tempoText?: string;
}

/* ── XML namespace + utilities ───────────────────────────────────────────── */

export const MEI_NS = 'http://www.music-encoding.org/ns/mei';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

function el(doc: Document, name: string, attrs?: Record<string, string | number | undefined>): Element {
  const e = doc.createElementNS(MEI_NS, name);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === undefined || v === null || v === '') continue;
      if (k === 'xml:id') {
        /* xml:id must live in the XML namespace — without setAttributeNS,
           the attribute would have local name literally "xml:id" in the null
           namespace, so selectors like `[*|id="…"]` fail to find it and our
           tie-partner lookups silently bail. Serializing still emits
           xml:id="…" exactly as before. */
        e.setAttributeNS(XML_NS, 'xml:id', String(v));
      } else {
        e.setAttribute(k, String(v));
      }
    }
  }
  return e;
}

/* MEI id space — required for Verovio's xml:id → SVG id mapping. */
let nextSeq = 0;
function newId(prefix: string): string {
  nextSeq++;
  return prefix + '-' + nextSeq.toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/* ── tick math ──────────────────────────────────────────────────────────── */

/* 64th-note tick table for representable durations (greedy decomposition).
   Largest first. */
const TICK_TABLE: ReadonlyArray<{ ticks: number; dur: Duration; dots: Dots }> = [
  { ticks: 64, dur: '1',  dots: 0 },
  { ticks: 56, dur: '1',  dots: 2 },
  { ticks: 48, dur: '1',  dots: 1 },
  { ticks: 32, dur: '2',  dots: 0 },
  { ticks: 28, dur: '2',  dots: 2 },
  { ticks: 24, dur: '2',  dots: 1 },
  { ticks: 16, dur: '4',  dots: 0 },
  { ticks: 14, dur: '4',  dots: 2 },
  { ticks: 12, dur: '4',  dots: 1 },
  { ticks: 8,  dur: '8',  dots: 0 },
  { ticks: 7,  dur: '8',  dots: 2 },
  { ticks: 6,  dur: '8',  dots: 1 },
  { ticks: 4,  dur: '16', dots: 0 },
  { ticks: 3,  dur: '16', dots: 1 },
  { ticks: 2,  dur: '32', dots: 0 },
  { ticks: 1,  dur: '64', dots: 0 },
];

export function ticksOf(dur: Duration, dots: Dots = 0): number {
  const denom = parseInt(dur, 10);
  const base = 64 / denom;
  if (dots === 1) return base * 1.5;
  if (dots === 2) return base * 1.75;
  return base;
}

export function decomposeTicks(n: number): Array<{ dur: Duration; dots: Dots }> {
  const out: Array<{ dur: Duration; dots: Dots }> = [];
  let remaining = n;
  while (remaining > 0) {
    let picked = false;
    for (const entry of TICK_TABLE) {
      if (entry.ticks <= remaining) {
        out.push({ dur: entry.dur, dots: entry.dots });
        remaining -= entry.ticks;
        picked = true;
        break;
      }
    }
    if (!picked) break; /* shouldn't happen — TICK_TABLE has a 1-tick entry */
  }
  return out;
}

/** Element duration in 64th-note ticks. Returns 16 (quarter) as a safe
 *  fallback for elements with malformed/missing @dur. */
function elementDurationTicks(el: Element): number {
  const dur = el.getAttribute('dur');
  const dots = parseInt(el.getAttribute('dots') ?? '0', 10);
  const denom = dur ? parseInt(dur, 10) : NaN;
  if (!Number.isFinite(denom) || denom <= 0) return 16;
  const base = 64 / denom;
  if (dots === 1) return base * 1.5;
  if (dots === 2) return base * 1.75;
  return base;
}

/* ── initial empty document ─────────────────────────────────────────────── */

function emptyMeiDoc(setup: SetupDefaults = {}): Document {
  const title = setup.title ?? 'Untitled';
  const composer = setup.composer ?? '';
  const keySig = setup.keySig ?? '0';
  const count = setup.meterCount ?? 4;
  const unit = setup.meterUnit ?? 4;
  const bpm = setup.tempoBpm ?? 120;
  const tempoUnit = setup.tempoUnit ?? '4';
  const tempoDots = setup.tempoDots ?? 0;
  const tempoText = setup.tempoText ?? '';

  const composerBlock = composer
    ? `<respStmt><persName role="composer">${escapeXml(composer)}</persName></respStmt>`
    : '';
  const tempoTextSpan = tempoText ? escapeXml(tempoText) + ' ' : '';
  const tempoDotsAttr = tempoDots > 0 ? ` mm.dots="${tempoDots}"` : '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="${MEI_NS}" meiversion="5.0">
  <meiHead>
    <fileDesc>
      <titleStmt><title>${escapeXml(title)}</title>${composerBlock}</titleStmt>
      <pubStmt/>
    </fileDesc>
  </meiHead>
  <music><body><mdiv><score>
    <scoreDef key.sig="${keySig}" meter.count="${count}" meter.unit="${unit}">
      <staffGrp symbol="brace" bar.thru="true">
        <staffDef n="1" lines="5" clef.shape="G" clef.line="2"/>
        <staffDef n="2" lines="5" clef.shape="F" clef.line="4"/>
      </staffGrp>
    </scoreDef>
    <section>
      <measure n="1" right="end" xml:id="${newId('m')}">
        <tempo tstamp="1" staff="1" mm="${bpm}" mm.unit="${tempoUnit}"${tempoDotsAttr} midi.bpm="${bpm}">${tempoTextSpan}</tempo>
        <staff n="1">
          <layer n="1" xml:id="${newId('l')}"/>
          <layer n="2" xml:id="${newId('l')}"/>
        </staff>
        <staff n="2">
          <layer n="1" xml:id="${newId('l')}"/>
          <layer n="2" xml:id="${newId('l')}"/>
        </staff>
      </measure>
    </section>
  </score></mdiv></body></music>
</mei>`;
  return new DOMParser().parseFromString(xml, 'application/xml');
}

/* ── model class ─────────────────────────────────────────────────────────── */

export class ComposerModel {
  private doc: Document;
  private currentVoice: Voice = 1;
  private cursors: Record<Voice, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };

  constructor(initialMei?: string) {
    if (initialMei) {
      this.doc = new DOMParser().parseFromString(initialMei, 'application/xml');
      if (this.doc.querySelector('parsererror')) {
        throw new Error('Failed to parse initial MEI');
      }
      this.stripBeamsInLiveDoc();
    } else {
      this.doc = emptyMeiDoc();
    }
  }

  /** Replace the entire document in-place (used by Load .hkc to preserve
   *  bindings held by other modules). */
  replaceDocument(meiXml: string): void {
    const newDoc = new DOMParser().parseFromString(meiXml, 'application/xml');
    if (newDoc.querySelector('parsererror')) throw new Error('Invalid MEI in load');
    this.doc = newDoc;
    this.currentVoice = 1;
    this.cursors = { 1: 0, 2: 0, 3: 0, 4: 0 };
    this.stripBeamsInLiveDoc();
    /* Migrate older .hkc files that lack bar.thru on the staffGrp. */
    const sg = this.doc.querySelector('staffGrp');
    if (sg && !sg.hasAttribute('bar.thru')) sg.setAttribute('bar.thru', 'true');
    /* Migrate older .hkc files that used right="dbl" for the final barline. */
    this.setBarlines();
  }

  /** Strip any <beam> wrappers from the live doc so cursor/mutation code
   *  always sees flat layer children. Beams are re-added at serialize() time
   *  by the beams.ts module. Safe no-op when there are no beams. */
  private stripBeamsInLiveDoc(): void {
    const beams = this.doc.querySelectorAll('beam');
    for (const b of Array.from(beams)) {
      const parent = b.parentNode;
      if (!parent) continue;
      while (b.firstChild) parent.insertBefore(b.firstChild, b);
      parent.removeChild(b);
    }
  }

  /* ── accessors ──────────────────────────────────────────────────────────── */

  /** Returns the raw (unbeamed) MEI doc. The renderer wraps this in a clone +
   *  regroupBeams pass before handing it to Verovio. */
  getDoc(): Document {
    return this.doc;
  }

  serialize(): string {
    /* Render-time passes operate on a clone so the live doc stays flat
       (cursor/mutation invariant). Both passes are idempotent. Order:
       accidentals first (operates on flat notes), then beams (wraps them). */
    const clone = this.doc.cloneNode(true) as Document;
    computeAccidentalDisplay(clone, this.getKeySig());
    regroupBeams(clone, readTimeSig(clone));
    return new XMLSerializer().serializeToString(clone);
  }

  getCurrentVoice(): Voice {
    return this.currentVoice;
  }

  getCursor(voice?: Voice): number {
    return this.cursors[voice ?? this.currentVoice];
  }

  getVoiceLength(voice?: Voice): number {
    return this.flatChildren(voice ?? this.currentVoice).length;
  }

  /** Returns the MEI xml:id of the element at the given linear cursor. */
  getElementIdAt(voice: Voice, cursor: number): string | null {
    const flat = this.flatChildren(voice);
    if (cursor < 0 || cursor >= flat.length) return null;
    return flat[cursor].getAttribute('xml:id');
  }

  /** Find which voice + index contains the element with the given xml:id.
   *  Used by playback to advance the cursor to the currently-sounding chord. */
  findElement(meiId: string): { voice: Voice; index: number } | null {
    for (let voice: Voice = 1; voice <= 4; voice = (voice + 1) as Voice) {
      const flat = this.flatChildren(voice);
      for (let i = 0; i < flat.length; i++) {
        if (flat[i].getAttribute('xml:id') === meiId) {
          return { voice, index: i };
        }
      }
      if (voice === 4) break;
    }
    return null;
  }

  /** Returns the "current" element in the flat stream given the active mode.
   *  - insert:    element at index `cursor - 1`. Null when cursor === 0.
   *  - overwrite: element at index `cursor`. Null when cursor === voiceLen.
   *
   *  This is the single source of truth used by cursor positioning, dot
   *  cycling, and tie toggling. */
  getCurrentElement(voice: Voice, mode: 'insert' | 'overwrite'): CurrentRef {
    const flat = this.flatChildren(voice);
    const cursor = this.cursors[voice];
    let idx: number;
    if (mode === 'insert') {
      if (cursor === 0) return null;
      idx = cursor - 1;
    } else {
      if (cursor >= flat.length) return null;
      idx = cursor;
    }
    const elem = flat[idx];
    if (!elem) return null;
    const id = elem.getAttribute('xml:id');
    if (!id) return null;
    return { index: idx, id, elem };
  }

  /** Returns the element at flat-index + 1 (in the same voice's flat stream).
   *  Transparently crosses measure boundaries. */
  getNextElement(voice: Voice, index: number): CurrentRef {
    const flat = this.flatChildren(voice);
    const nextIdx = index + 1;
    if (nextIdx < 0 || nextIdx >= flat.length) return null;
    const elem = flat[nextIdx];
    const id = elem.getAttribute('xml:id');
    if (!id) return null;
    return { index: nextIdx, id, elem };
  }

  /* ── setup setters / getters ──────────────────────────────────────────── */

  getTitle(): string {
    const t = this.doc.querySelector('titleStmt > title');
    return t?.textContent ?? 'Untitled';
  }

  setTitle(title: string): void {
    let t = this.doc.querySelector('titleStmt > title');
    if (!t) {
      const titleStmt = this.doc.querySelector('titleStmt');
      if (!titleStmt) return;
      t = el(this.doc, 'title');
      titleStmt.insertBefore(t, titleStmt.firstChild);
    }
    t.textContent = title;
  }

  getComposer(): string {
    const p = this.doc.querySelector('titleStmt persName[role="composer"]');
    return p?.textContent ?? '';
  }

  setComposer(name: string): void {
    const titleStmt = this.doc.querySelector('titleStmt');
    if (!titleStmt) return;
    let respStmt = titleStmt.querySelector('respStmt');
    let persName = respStmt?.querySelector('persName[role="composer"]') ?? null;
    if (!name) {
      /* Empty composer: remove the respStmt entirely if it's empty. */
      if (persName) persName.parentNode?.removeChild(persName);
      if (respStmt && respStmt.children.length === 0) respStmt.parentNode?.removeChild(respStmt);
      return;
    }
    if (!respStmt) {
      respStmt = el(this.doc, 'respStmt');
      titleStmt.appendChild(respStmt);
    }
    if (!persName) {
      persName = el(this.doc, 'persName', { role: 'composer' });
      respStmt.appendChild(persName);
    }
    persName.textContent = name;
  }

  getKeySig(): string {
    const sd = this.doc.querySelector('scoreDef');
    return sd?.getAttribute('key.sig') ?? '0';
  }

  setKeySig(sig: string): void {
    const sd = this.doc.querySelector('scoreDef');
    if (!sd) return;
    sd.setAttribute('key.sig', sig);
  }

  getTimeSig(): { count: number; unit: number } {
    const sd = this.doc.querySelector('scoreDef');
    const count = parseInt(sd?.getAttribute('meter.count') ?? '4', 10);
    const unit = parseInt(sd?.getAttribute('meter.unit') ?? '4', 10);
    return { count, unit };
  }

  /** Set the time signature. Triggers rebuildMeasureLayout if the meter
   *  actually changes AND the score has any content. */
  setTimeSig(count: number, unit: number): void {
    const sd = this.doc.querySelector('scoreDef');
    if (!sd) return;
    const prevCount = parseInt(sd.getAttribute('meter.count') ?? '4', 10);
    const prevUnit = parseInt(sd.getAttribute('meter.unit') ?? '4', 10);
    sd.setAttribute('meter.count', String(count));
    sd.setAttribute('meter.unit', String(unit));
    if (count !== prevCount || unit !== prevUnit) {
      if (this.hasAnyContent()) this.rebuildMeasureLayout();
    }
  }

  getTempo(): { bpm: number; unit: string; dots: number; text: string } {
    const t = this.doc.querySelector('tempo');
    const bpm = parseInt(t?.getAttribute('mm') ?? t?.getAttribute('midi.bpm') ?? '120', 10);
    const unit = t?.getAttribute('mm.unit') ?? '4';
    const dots = parseInt(t?.getAttribute('mm.dots') ?? '0', 10);
    const text = (t?.textContent ?? '').replace(/\s+$/, '');
    return { bpm, unit, dots, text };
  }

  setTempo(bpm: number, mmUnit: '1' | '2' | '4' | '8', dots: 0 | 1, text = ''): void {
    let t = this.doc.querySelector('tempo');
    if (!t) {
      const firstMeasure = this.doc.querySelector('measure');
      if (!firstMeasure) return;
      t = el(this.doc, 'tempo', { tstamp: '1', staff: '1' });
      firstMeasure.insertBefore(t, firstMeasure.firstChild);
    }
    t.setAttribute('mm', String(bpm));
    t.setAttribute('mm.unit', mmUnit);
    t.setAttribute('midi.bpm', String(bpm));
    if (dots > 0) t.setAttribute('mm.dots', String(dots));
    else t.removeAttribute('mm.dots');
    /* Tempo text rendered with a trailing space so the metronome glyph follows.
       Verovio renders text content + auto-formatted "♩ = 120" from mm/mm.unit. */
    t.textContent = text ? text + ' ' : '';
  }

  /* ── measure-aware structural helpers ─────────────────────────────────── */

  allMeasures(): Element[] {
    return Array.from(this.doc.querySelectorAll('measure'));
  }

  /** Total ticks in one measure under the current meter. */
  measureTicks(): number {
    const { count, unit } = this.getTimeSig();
    return count * (64 / unit);
  }

  /** Return the <layer> for (voice, measure). */
  private layerInMeasure(measure: Element, voice: Voice): Element | null {
    const staffN = voice <= 2 ? 1 : 2;
    const layerN = voice === 1 || voice === 3 ? 1 : 2;
    const staff = Array.from(measure.querySelectorAll('staff'))
      .find((s) => s.getAttribute('n') === String(staffN));
    if (!staff) return null;
    const layer = Array.from(staff.querySelectorAll('layer'))
      .find((l) => l.getAttribute('n') === String(layerN));
    return layer ?? null;
  }

  /** Layers for one voice, one per measure, in measure order. */
  private allLayers(voice: Voice): Element[] {
    const out: Element[] = [];
    for (const m of this.allMeasures()) {
      const l = this.layerInMeasure(m, voice);
      if (l) out.push(l);
    }
    return out;
  }

  /** Flat content children (chord|note|rest) across all measures for voice. */
  flatChildren(voice: Voice): Element[] {
    const out: Element[] = [];
    for (const layer of this.allLayers(voice)) {
      for (const c of Array.from(layer.children)) {
        const ln = c.localName;
        if (ln === 'chord' || ln === 'note' || ln === 'rest') out.push(c);
      }
    }
    return out;
  }

  /** Translate a linear cursor into an INSERTION POINT
   *  (measureIdx, layer, withinIdx). Inclusive — at a measure boundary,
   *  prefers the earlier measure so callers can fill its trailing edge.
   *  When linear cursor is at end-of-voice, returns the last layer with
   *  withinIdx = its content length. */
  private locateCursor(voice: Voice, linearCursor: number): {
    measureIdx: number; layer: Element; withinIdx: number;
  } | null {
    const layers = this.allLayers(voice);
    if (layers.length === 0) return null;
    let consumed = 0;
    for (let mi = 0; mi < layers.length; mi++) {
      const layer = layers[mi];
      const kids = this.contentChildren(layer);
      if (linearCursor <= consumed + kids.length) {
        return { measureIdx: mi, layer, withinIdx: linearCursor - consumed };
      }
      consumed += kids.length;
    }
    /* Past end — return the last layer at its full length. */
    const last = layers.length - 1;
    const layer = layers[last];
    return { measureIdx: last, layer, withinIdx: this.contentChildren(layer).length };
  }

  /** Locate a SPECIFIC ELEMENT by its flat index. Returns the measure and
   *  position holding element[flatIdx], or null when flatIdx is out of range.
   *  Strict-less-than walker — at a measure boundary, the first element of
   *  the next measure has the higher precedence (which differs from
   *  locateCursor's insertion-point semantics). */
  private locateFlatElement(voice: Voice, flatIdx: number): {
    measureIdx: number; layer: Element; withinIdx: number;
  } | null {
    if (flatIdx < 0) return null;
    const layers = this.allLayers(voice);
    let remaining = flatIdx;
    for (let mi = 0; mi < layers.length; mi++) {
      const kids = this.contentChildren(layers[mi]);
      if (remaining < kids.length) {
        return { measureIdx: mi, layer: layers[mi], withinIdx: remaining };
      }
      remaining -= kids.length;
    }
    return null;
  }

  /** Cumulative ticks for `voice` BEFORE its `withinIdx`-th content child
   *  in measure `measureIdx`. */
  private timeWithinMeasure(voice: Voice, measureIdx: number, withinIdx: number): number {
    const layers = this.allLayers(voice);
    if (measureIdx >= layers.length) return 0;
    const kids = this.contentChildren(layers[measureIdx]);
    let t = 0;
    for (let i = 0; i < Math.min(withinIdx, kids.length); i++) t += elementDurationTicks(kids[i]);
    return t;
  }

  /** Filter to actual musical content (chord/note/rest), skip whitespace
   *  and any other element types (<tempo>, etc.). */
  private contentChildren(layer: Element): Element[] {
    return Array.from(layer.children).filter((c) =>
      c.localName === 'chord' || c.localName === 'note' || c.localName === 'rest');
  }

  /** Append a new empty measure with all four layers. Sets barlines. */
  private appendMeasure(): Element {
    const section = this.doc.querySelector('section');
    if (!section) throw new Error('section element missing');
    const measures = this.allMeasures();
    const n = measures.length + 1;
    const m = el(this.doc, 'measure', { n, 'xml:id': newId('m') });
    const s1 = el(this.doc, 'staff', { n: 1 });
    s1.appendChild(el(this.doc, 'layer', { n: 1, 'xml:id': newId('l') }));
    s1.appendChild(el(this.doc, 'layer', { n: 2, 'xml:id': newId('l') }));
    const s2 = el(this.doc, 'staff', { n: 2 });
    s2.appendChild(el(this.doc, 'layer', { n: 1, 'xml:id': newId('l') }));
    s2.appendChild(el(this.doc, 'layer', { n: 2, 'xml:id': newId('l') }));
    m.appendChild(s1);
    m.appendChild(s2);
    section.appendChild(m);
    this.setBarlines();
    return m;
  }

  /** Set @right="end" on the last measure, clear it on the others. Called
   *  whenever the measure list grows or shrinks. */
  setBarlines(): void {
    const measures = this.allMeasures();
    for (let i = 0; i < measures.length; i++) {
      if (i < measures.length - 1) measures[i].removeAttribute('right');
      else measures[i].setAttribute('right', 'end');
    }
  }

  private hasAnyContent(): boolean {
    for (let v: Voice = 1; v <= 4; v = (v + 1) as Voice) {
      if (this.flatChildren(v).length > 0) return true;
      if (v === 4) break;
    }
    return false;
  }

  /* ── navigation ─────────────────────────────────────────────────────────── */

  switchVoice(dir: 'up' | 'down'): Voice {
    const cur = this.currentVoice;
    let next: Voice;
    if (dir === 'up') next = (cur > 1 ? cur - 1 : 1) as Voice;
    else              next = (cur < 4 ? cur + 1 : 4) as Voice;
    if (next === cur) return next;
    const currentTime = this.getTimeAt(cur, this.cursors[cur]);
    this.currentVoice = next;
    this.cursors[next] = this.findCursorAtOrBefore(next, currentTime);
    return next;
  }

  /** Cumulative duration (in 64th-note ticks) of elements before `cursor`
   *  in `voice` (across all measures). */
  getTimeAt(voice: Voice, cursor: number): number {
    const flat = this.flatChildren(voice);
    const upto = Math.max(0, Math.min(cursor, flat.length));
    let t = 0;
    for (let i = 0; i < upto; i++) t += elementDurationTicks(flat[i]);
    return t;
  }

  findCursorAtOrBefore(voice: Voice, targetTime: number): number {
    const flat = this.flatChildren(voice);
    let cumulative = 0;
    let bestCursor = 0;
    for (let i = 0; i <= flat.length; i++) {
      if (cumulative <= targetTime) bestCursor = i;
      else break;
      if (i < flat.length) cumulative += elementDurationTicks(flat[i]);
    }
    return bestCursor;
  }

  setVoice(v: Voice): void {
    this.currentVoice = v;
    const max = this.getVoiceLength(v);
    if (this.cursors[v] > max) this.cursors[v] = max;
  }

  moveCursor(dir: 'left' | 'right'): number {
    const v = this.currentVoice;
    const len = this.getVoiceLength(v);
    let c = this.cursors[v];
    if (dir === 'left' && c > 0) c--;
    else if (dir === 'right' && c < len) c++;
    this.cursors[v] = c;
    return c;
  }

  setCursor(c: number, voice?: Voice): void {
    const v = voice ?? this.currentVoice;
    const len = this.getVoiceLength(v);
    this.cursors[v] = Math.max(0, Math.min(len, c));
  }

  cursorToEnd(voice?: Voice): void {
    const v = voice ?? this.currentVoice;
    this.cursors[v] = this.getVoiceLength(v);
  }

  /* ── mutations ──────────────────────────────────────────────────────────── */

  /** Insert a chord at the current voice's cursor; advances cursor. May
   *  split across measure boundaries with ties. Returns the first new
   *  element's xml:id. */
  insertChordAtCursor(input: ChordInput): string {
    const v = this.currentVoice;
    const originalCursor = this.cursors[v];
    const id = this.insertWithSplit(input, false);
    this.resolvePendingTies(originalCursor);
    return id;
  }

  /** Insert a rest at the current voice's cursor; advances cursor. May
   *  split across measure boundaries (no ties on rests). Inserting a rest
   *  does NOT resolve a pending tie (a rest has no matching pitch). */
  insertRestAtCursor(input: RestInput): string {
    return this.insertWithSplit({ ...input, notes: [] as ReadonlyArray<ResolvedNote> }, true);
  }

  /** Before an element is removed or replaced, clean up any tie state
   *  that points at it. Stub notes (data-pending-tie) get their <lv>
   *  element removed. Realized tie partners on OTHER notes get their
   *  @tie cleared (and the surviving initiator demoted to a stub so it
   *  can auto-resolve later). */
  private orphanTiePartners(elem: Element): void {
    const notes = this.extractNoteElements(elem);
    for (const n of notes) {
      /* If this note IS a stub itself, drop its visual <lv>. */
      if (n.hasAttribute('data-pending-tie')) removeLvForNote(n);
      /* Then handle realized tie partners. */
      const partnerId = n.getAttribute('data-tie-partner');
      if (!partnerId) continue;
      const partner = this.doc.querySelector('[*|id="' + partnerId + '"]')
        ?? this.doc.querySelector('[id="' + partnerId + '"]');
      if (!partner) continue;
      const partnerTie = partner.getAttribute('tie');
      if (partnerTie === 'i') {
        clearTieFlag(partner);
        setStubTie(partner);
      } else if (partnerTie === 't' || partnerTie === 'm') {
        clearTieFlag(partner);
      }
      partner.removeAttribute('data-tie-partner');
    }
  }

  /** After a new chord lands at flat-index `newFirstFlatIdx`, look at the
   *  immediately-preceding element in the same voice for any notes marked
   *  data-pending-tie. For each, find a matching pitch in the new chord
   *  and complete the tie pair (@tie="i" + @tie="t" + data-tie-partner).
   *  Unmatched pending ties stay pending — they may resolve on a future
   *  insert. */
  private resolvePendingTies(newFirstFlatIdx: number): void {
    if (newFirstFlatIdx <= 0) return;
    const v = this.currentVoice;
    const prev = this.locateFlatElement(v, newFirstFlatIdx - 1);
    const curr = this.locateFlatElement(v, newFirstFlatIdx);
    if (!prev || !curr) return;
    const prevElem = this.contentChildren(prev.layer)[prev.withinIdx];
    const currElem = this.contentChildren(curr.layer)[curr.withinIdx];
    if (!prevElem || !currElem) return;
    if (currElem.localName === 'rest') return;
    const prevNotes = this.extractNoteElements(prevElem);
    const currNotes = this.extractNoteElements(currElem);
    for (const n of prevNotes) {
      if (!n.hasAttribute('data-pending-tie')) continue;
      const partner = currNotes.find((m) => notesMatch(n, m) && !m.hasAttribute('tie'));
      if (!partner) continue;
      /* Replace the stub representation (<lv> + data-pending-tie) with a
         proper @tie="i"/@tie="t" pair. */
      clearStubTie(n);
      setTieFlag(n, 'i');
      setTieFlag(partner, 't');
      const partnerId = partner.getAttribute('xml:id');
      const nId = n.getAttribute('xml:id');
      if (partnerId) n.setAttribute('data-tie-partner', partnerId);
      if (nId) partner.setAttribute('data-tie-partner', nId);
    }
  }

  /** Append a chord at the end of the current voice. */
  appendChord(input: ChordInput): string {
    this.cursorToEnd();
    return this.insertChordAtCursor(input);
  }

  /** Append a rest at the end of the current voice. */
  appendRest(input: RestInput): string {
    this.cursorToEnd();
    return this.insertRestAtCursor(input);
  }

  /** Replace the element at the current cursor with a new chord. Cursor
   *  remains at its original position (the caller is expected to advance
   *  if desired — matches the historical replace contract). When overflow
   *  forces a split chain, cursor stays put even though the chain may have
   *  >1 elements; this matches the simple-path semantics. */
  replaceChordAtCursor(input: ChordInput): string | null {
    const v = this.currentVoice;
    const cursorAtCall = this.cursors[v];
    const loc = this.locateCursor(v, cursorAtCall);
    if (!loc) return null;
    const kids = this.contentChildren(loc.layer);
    if (loc.withinIdx >= kids.length) return null; /* nothing to replace */
    /* Simple in-place replace WITHIN current measure if it fits. */
    const totalTicks = ticksOf(input.duration, input.dots ?? 0);
    const usedBefore = this.timeWithinMeasure(v, loc.measureIdx, loc.withinIdx);
    if (usedBefore + totalTicks <= this.measureTicks()) {
      const old = kids[loc.withinIdx];
      this.orphanTiePartners(old);
      const replaced = this.buildChordElement(input);
      loc.layer.replaceChild(replaced, old);
      this.resolvePendingTies(cursorAtCall);
      return replaced.getAttribute('xml:id');
    }
    /* Overflow on replace: remove old, insertWithSplit, restore cursor. */
    const old = kids[loc.withinIdx];
    this.orphanTiePartners(old);
    loc.layer.removeChild(old);
    const id = this.insertWithSplit(input, false);
    this.cursors[v] = cursorAtCall;
    this.resolvePendingTies(cursorAtCall);
    return id;
  }

  /** Delete the last element of the current voice (Backspace at end). */
  deleteLastInVoice(): boolean {
    const v = this.currentVoice;
    const len = this.getVoiceLength(v);
    if (len === 0) return false;
    this.cursors[v] = len;
    return this.deleteAtCursor();
  }

  /** Delete the element immediately to the left of the cursor. If that
   *  deletion empties the entire measure (across all 4 voices), the
   *  measure itself is removed — unless it's the only measure left. */
  deleteAtCursor(): boolean {
    const v = this.currentVoice;
    const c = this.cursors[v];
    if (c <= 0) return false;
    const loc = this.locateFlatElement(v, c - 1);
    if (!loc) return false;
    const kids = this.contentChildren(loc.layer);
    if (loc.withinIdx >= kids.length) return false;
    const measure = loc.layer.closest('measure') as Element | null;
    const victim = kids[loc.withinIdx];
    this.orphanTiePartners(victim);
    loc.layer.removeChild(victim);
    this.cursors[v] = c - 1;
    /* If the just-emptied measure has no content in ANY voice, drop it
       (unless it's the only measure left). */
    if (measure && this.measureIsEmpty(measure) && this.allMeasures().length > 1) {
      measure.parentNode?.removeChild(measure);
      this.renumberMeasures();
    }
    /* Always re-apply barlines (last measure may have changed). */
    this.setBarlines();
    return true;
  }

  private measureIsEmpty(measure: Element): boolean {
    for (let v: Voice = 1; v <= 4; v = (v + 1) as Voice) {
      const layer = this.layerInMeasure(measure, v);
      if (layer && this.contentChildren(layer).length > 0) return false;
      if (v === 4) break;
    }
    return true;
  }

  private renumberMeasures(): void {
    const measures = this.allMeasures();
    for (let i = 0; i < measures.length; i++) {
      measures[i].setAttribute('n', String(i + 1));
    }
  }

  /** Cycle dots on the current note/chord/rest. Respects the 'insert' /
   *  'overwrite' mode for which element to target. When the new total
   *  exceeds remaining measure space, splits across the bar with ties
   *  (auto-tie-overflow behavior). Returns null when there's no current
   *  element. */
  cycleDotsOnCurrent(mode: 'insert' | 'overwrite'): { id: string; newDots: Dots } | null {
    const v = this.currentVoice;
    const ref = this.getCurrentElement(v, mode);
    if (!ref) return null;
    const elem = ref.elem;
    const isRest = elem.localName === 'rest';
    const curDots = parseInt(elem.getAttribute('dots') ?? '0', 10) as Dots;
    const nextDots = (((curDots + 1) % 3) as Dots);
    const dur = (elem.getAttribute('dur') ?? '4') as Duration;
    const newTotalTicks = ticksOf(dur, nextDots);

    /* Determine fit within current measure. */
    const loc = this.locateCursor(v, ref.index);
    if (!loc) return null;
    const kids = this.contentChildren(loc.layer);
    const idxInLayer = kids.indexOf(elem);
    if (idxInLayer < 0) return null;
    const ticksBefore = this.timeWithinMeasure(v, loc.measureIdx, idxInLayer);
    const remaining = this.measureTicks() - ticksBefore;

    if (newTotalTicks <= remaining) {
      /* Fits in measure: just set/remove @dots. */
      if (nextDots > 0) elem.setAttribute('dots', String(nextDots));
      else elem.removeAttribute('dots');
      return { id: ref.id, newDots: nextDots };
    }

    /* Overflow: replace element with a split chain. Preserve pitches
       (for chord/note) so the chain remains pitch-identical. */
    let chordInput: ChordInput | null = null;
    let restInput: RestInput | null = null;
    if (isRest) {
      restInput = { duration: dur, dots: nextDots };
    } else {
      const notes = this.extractResolvedFromElement(elem);
      chordInput = { notes, duration: dur, dots: nextDots };
    }

    /* Snapshot cursor: getCurrentElement targets cursor-1 (insert) or cursor
       (overwrite). We want to position the cursor BEFORE the element to be
       replaced, then run insertWithSplit, then restore cursor to consume
       the new chain. */
    const savedCursor = this.cursors[v];
    /* Position cursor immediately BEFORE the target element. */
    this.cursors[v] = ref.index;
    /* Remove the old element, clearing any tie partners that pointed at it. */
    this.orphanTiePartners(elem);
    loc.layer.removeChild(elem);
    /* Insert the split chain. */
    let firstId: string | null = null;
    if (restInput) firstId = this.insertWithSplit({ ...restInput, notes: [] }, true);
    else if (chordInput) firstId = this.insertWithSplit(chordInput, false);
    /* Cursor has advanced past the chain pieces. Calculate net delta:
       original cursor at savedCursor; we replaced 1 element with N pieces.
       After remove + insert, cursors[v] = ref.index + N. Restore semantics
       so the "current" element relationship holds:
         - insert mode: keep cursor at end of chain (consistent with "just
           entered the new chain")
         - overwrite mode: move cursor back to start of chain (so the new
           chain head is the current element)
    */
    if (mode === 'overwrite') {
      this.cursors[v] = ref.index;
    } else {
      /* For insert, leave cursor at the end of the chain — savedCursor was
         ref.index + 1; after replacing with N pieces it's ref.index + N.
         If N > 1, the cursor naturally sits past all pieces, which is the
         insert-mode convention "right of just-entered element". */
    }
    void savedCursor; /* not needed beyond reasoning; ref.index re-derived */
    if (!firstId) return null;
    return { id: firstId, newDots: nextDots };
  }

  /** Toggle a tie on the current note/chord. Attaches to next element's
   *  matching pitches; stubs for non-matching. Returns null when there's
   *  no tieable current element (e.g. rest, no current). */
  toggleTieOnCurrent(mode: 'insert' | 'overwrite'): { id: string; tied: boolean } | null {
    const v = this.currentVoice;
    const ref = this.getCurrentElement(v, mode);
    if (!ref) return null;
    if (ref.elem.localName === 'rest') return null;
    const currentNotes = this.extractNoteElements(ref.elem);
    if (currentNotes.length === 0) return null;

    const alreadyTied = currentNotes.some((n) => {
      const t = n.getAttribute('tie');
      return t === 'i' || t === 'm' || n.hasAttribute('data-pending-tie');
    });
    if (alreadyTied) {
      /* Toggle off: clear ties / pending markers on current notes; find
         realized partners (via data-tie-partner) and clear them too. */
      for (const n of currentNotes) {
        if (n.hasAttribute('data-pending-tie')) {
          clearStubTie(n);
          continue;
        }
        const partnerId = n.getAttribute('data-tie-partner');
        if (partnerId) {
          const partner = this.doc.querySelector('[*|id="' + partnerId + '"]')
            ?? this.doc.querySelector('[id="' + partnerId + '"]');
          if (partner) {
            clearTieFlag(partner);
            partner.removeAttribute('data-tie-partner');
          }
          n.removeAttribute('data-tie-partner');
        }
        clearTieFlag(n);
      }
      return { id: ref.id, tied: false };
    }

    /* Toggle on: find next element and per-pitch match. Notes that don't
       match anything in the next element get a stub: data-pending-tie marks
       it for auto-resolve later, and @lv="true" gives Verovio the visual
       hanging-tie arc (laissez vibrer). When a matching note follows, the
       resolve replaces both with a proper @tie="i"/"t" pair. */
    const next = this.getNextElement(v, ref.index);
    const nextNotes = next ? this.extractNoteElements(next.elem) : [];
    for (const n of currentNotes) {
      const partner = nextNotes.find((m) => notesMatch(n, m) && !m.hasAttribute('tie'));
      if (partner) {
        setTieFlag(n, 'i');
        setTieFlag(partner, 't');
        const partnerId = partner.getAttribute('xml:id');
        const nId = n.getAttribute('xml:id');
        if (partnerId) n.setAttribute('data-tie-partner', partnerId);
        if (nId) partner.setAttribute('data-tie-partner', nId);
      } else {
        setStubTie(n);
      }
    }
    return { id: ref.id, tied: true };
  }

  /** Rebuild measures: flatten all content per voice, then re-distribute
   *  under the current meter via insertWithSplit (which auto-ties across
   *  the new bar lines). */
  rebuildMeasureLayout(): void {
    /* Snapshot per-voice ordered list of {duration, dots, notes|rest, tieIn?}. */
    type Snap = { kind: 'note' | 'rest'; dur: Duration; dots: Dots; notes: SnapNote[] };
    const snapsByVoice: Record<Voice, Snap[]> = { 1: [], 2: [], 3: [], 4: [] };

    for (let v: Voice = 1; v <= 4; v = (v + 1) as Voice) {
      /* Walk flat children; coalesce tied chains into single notional events
         (so the rebuild creates one long note that re-splits naturally). */
      const flat = this.flatChildren(v);
      let i = 0;
      while (i < flat.length) {
        const elem = flat[i];
        if (elem.localName === 'rest') {
          const dur = (elem.getAttribute('dur') ?? '4') as Duration;
          const dots = parseInt(elem.getAttribute('dots') ?? '0', 10) as Dots;
          snapsByVoice[v].push({ kind: 'rest', dur, dots, notes: [] });
          i++;
          continue;
        }
        const notes = this.extractNoteElements(elem).map((n) => snapNoteOf(n));
        let ticks = elementDurationTicks(elem);
        let j = i + 1;
        /* Coalesce tied chain. */
        if (this.elementHasTieInitial(elem)) {
          while (j < flat.length) {
            const e2 = flat[j];
            if (e2.localName === 'rest') break;
            if (!this.elementHasTieTerminal(e2)) break;
            ticks += elementDurationTicks(e2);
            if (!this.elementHasTieInitial(e2)) { j++; break; }
            j++;
          }
        }
        /* Convert ticks back to (dur, dots): not always representable
           cleanly for a tied chain (e.g. quarter + 8th = dotted quarter
           is representable; quarter + 16 = not directly representable as
           single dur). decomposeTicks splits it into reasonable pieces.
           We push one snap per piece. */
        const pieces = decomposeTicks(ticks);
        for (const p of pieces) snapsByVoice[v].push({ kind: 'note', dur: p.dur, dots: p.dots, notes });
        i = j === i + 1 ? i + 1 : j;
      }
      if (v === 4) break;
    }

    /* Tear down all measures except a single fresh first measure. */
    const section = this.doc.querySelector('section');
    if (!section) return;
    while (section.firstChild) section.removeChild(section.firstChild);
    /* Build fresh measure 1, preserving the tempo element if present. */
    const m1 = el(this.doc, 'measure', { n: 1, 'xml:id': newId('m') });
    /* Re-add tempo (we kept it referenced elsewhere; rebuild puts a new
       <tempo> in based on current tempo state). */
    const tempo = this.recreateTempoElement();
    if (tempo) m1.appendChild(tempo);
    const s1 = el(this.doc, 'staff', { n: 1 });
    s1.appendChild(el(this.doc, 'layer', { n: 1, 'xml:id': newId('l') }));
    s1.appendChild(el(this.doc, 'layer', { n: 2, 'xml:id': newId('l') }));
    const s2 = el(this.doc, 'staff', { n: 2 });
    s2.appendChild(el(this.doc, 'layer', { n: 1, 'xml:id': newId('l') }));
    s2.appendChild(el(this.doc, 'layer', { n: 2, 'xml:id': newId('l') }));
    m1.appendChild(s1);
    m1.appendChild(s2);
    section.appendChild(m1);

    this.cursors = { 1: 0, 2: 0, 3: 0, 4: 0 };

    /* Replay snaps per voice. */
    const savedVoice = this.currentVoice;
    for (let v: Voice = 1; v <= 4; v = (v + 1) as Voice) {
      this.currentVoice = v;
      this.cursors[v] = 0;
      for (const snap of snapsByVoice[v]) {
        if (snap.kind === 'rest') {
          this.insertRestAtCursor({ duration: snap.dur, dots: snap.dots });
        } else {
          const notes = snap.notes.map((sn) => resolvedFromSnapNote(sn));
          this.insertChordAtCursor({ notes, duration: snap.dur, dots: snap.dots });
        }
      }
      if (v === 4) break;
    }
    this.currentVoice = savedVoice;
    this.setBarlines();
  }

  /* ── private helpers ────────────────────────────────────────────────────── */

  private recreateTempoElement(): Element | null {
    const t = this.doc.querySelector('tempo');
    if (!t) return null;
    return t.cloneNode(true) as Element;
  }

  /** Core insert with measure-overflow splitting. For chords with notes
   *  arr.length > 0, splits notes-identical pieces with ties; for rests
   *  (notes.length === 0), splits without ties. */
  private insertWithSplit(
    input: { duration: Duration; dots?: Dots; notes: ReadonlyArray<ResolvedNote> },
    isRest: boolean,
  ): string {
    const v = this.currentVoice;
    const cursor = this.cursors[v];
    const loc = this.locateCursor(v, cursor);
    if (!loc) throw new Error('no layer at cursor');
    const totalTicks = ticksOf(input.duration, input.dots ?? 0);
    const usedBefore = this.timeWithinMeasure(v, loc.measureIdx, loc.withinIdx);
    const remaining = this.measureTicks() - usedBefore;

    if (totalTicks <= remaining) {
      /* Fits in current measure: single element. */
      const element = isRest
        ? this.buildRestElement({ duration: input.duration, dots: input.dots })
        : this.buildChordElement({ notes: input.notes, duration: input.duration, dots: input.dots });
      this.insertAt(loc.layer, element, loc.withinIdx);
      this.cursors[v]++;
      return element.getAttribute('xml:id') ?? '';
    }

    /* Split. Head pieces fill the rest of current measure; tail pieces
       continue in subsequent measures (creating new measures as needed). */
    const headParts = remaining > 0 ? decomposeTicks(remaining) : [];
    const tailParts = decomposeTicks(totalTicks - remaining);
    const pieces = [...headParts, ...tailParts];

    let firstId: string | null = null;
    let measureCursor = loc.measureIdx;
    let layerCursor = loc.layer;
    let withinCursor = loc.withinIdx;
    let firstPieceLayer = layerCursor;
    let lastNoteEls: Element[] | null = null;

    for (let pi = 0; pi < pieces.length; pi++) {
      const p = pieces[pi];
      /* Determine whether we're in head section (still in starting measure) or
         tail (next measures). headParts.length pieces stay in starting measure. */
      const isHead = pi < headParts.length;
      if (!isHead) {
        /* Advance to next measure's layer (create if needed). */
        measureCursor++;
        let measures = this.allMeasures();
        if (measureCursor >= measures.length) {
          this.appendMeasure();
          measures = this.allMeasures();
        }
        const layer = this.layerInMeasure(measures[measureCursor], v);
        if (!layer) throw new Error('layer not found in new measure');
        layerCursor = layer;
        withinCursor = 0;
      }
      const element = isRest
        ? this.buildRestElement({ duration: p.dur, dots: p.dots })
        : this.buildChordElement({ notes: input.notes, duration: p.dur, dots: p.dots });
      this.insertAt(layerCursor, element, withinCursor);
      withinCursor++;
      if (!firstId) {
        firstId = element.getAttribute('xml:id');
        firstPieceLayer = layerCursor;
      }
      /* For non-rest, set ties on inner notes: 'i' on first, 'm' on middle,
         't' on last. */
      if (!isRest && pieces.length > 1) {
        const innerNotes = this.extractNoteElements(element);
        let flag: 'i' | 'm' | 't';
        if (pi === 0) flag = 'i';
        else if (pi === pieces.length - 1) flag = 't';
        else flag = 'm';
        for (let ni = 0; ni < innerNotes.length; ni++) {
          setTieFlag(innerNotes[ni], flag);
          /* Wire data-tie-partner on incoming-end pieces (medial + terminal):
             partner is the corresponding note in the previous piece. */
          if ((flag === 'm' || flag === 't') && lastNoteEls && lastNoteEls[ni]) {
            const prevId = lastNoteEls[ni].getAttribute('xml:id');
            if (prevId) innerNotes[ni].setAttribute('data-tie-partner', prevId);
          }
        }
        lastNoteEls = innerNotes;
      }
      this.cursors[v]++;
    }
    void firstPieceLayer;
    this.setBarlines();
    return firstId ?? '';
  }

  private insertAt(parent: Element, child: Element, index: number): void {
    const kids = this.contentChildren(parent);
    if (index >= kids.length) parent.appendChild(child);
    else parent.insertBefore(child, kids[index]);
  }

  private buildChordElement(input: ChordInput): Element {
    const doc = this.doc;
    const dur = input.duration;
    const dots = input.dots ?? 0;
    if (input.notes.length === 1) {
      const n = input.notes[0];
      return this.buildNoteElement(n, dur, dots);
    }
    const chord = el(doc, 'chord', {
      'xml:id': newId('c'),
      dur,
      dots: dots > 0 ? dots : undefined,
    });
    const sorted = [...input.notes].sort((a, b) => a.midi - b.midi);
    for (const n of sorted) chord.appendChild(this.buildNoteElement(n, dur, dots, /* inChord */ true));
    return chord;
  }

  private buildNoteElement(n: ResolvedNote, dur: Duration, dots: Dots, inChord = false): Element {
    const attrs: Record<string, string | number | undefined> = {
      'xml:id': newId('n'),
      pname: n.pname,
      oct: n.oct,
      color: n.colorHex,
      'data-q': n.q,
      'data-r': n.r,
    };
    if (!inChord) {
      attrs.dur = dur;
      if (dots > 0) attrs.dots = dots;
    }
    if (n.accid) attrs.accid = n.accid;
    return el(this.doc, 'note', attrs);
  }

  private buildRestElement(input: RestInput): Element {
    return el(this.doc, 'rest', {
      'xml:id': newId('r'),
      dur: input.duration,
      dots: input.dots && input.dots > 0 ? input.dots : undefined,
    });
  }

  private extractNoteElements(elem: Element): Element[] {
    if (elem.localName === 'note') return [elem];
    if (elem.localName === 'chord') {
      return Array.from(elem.children).filter((c) => c.localName === 'note');
    }
    return [];
  }

  private extractResolvedFromElement(elem: Element): ResolvedNote[] {
    const noteEls = this.extractNoteElements(elem);
    return noteEls.map((n) => {
      const q = parseInt(n.getAttribute('data-q') ?? '0', 10);
      const r = parseInt(n.getAttribute('data-r') ?? '0', 10);
      const pname = (n.getAttribute('pname') ?? 'c') as ResolvedNote['pname'];
      const accid = (n.getAttribute('accid') ?? '') as ResolvedNote['accid'];
      const oct = parseInt(n.getAttribute('oct') ?? '4', 10);
      const colorHex = n.getAttribute('color') ?? '#000000';
      /* MIDI is not used by buildChordElement except for sort order; reconstruct
         from coords: midi = 57 + 4q + 7r. */
      const midi = 57 + 4 * q + 7 * r;
      return { q, r, pname, accid, oct, midi, colorHex, velocity: 80 };
    });
  }

  /** True when any inner note has an outgoing tie ('i' or 'm'). */
  private elementHasTieInitial(elem: Element): boolean {
    const notes = this.extractNoteElements(elem);
    return notes.some((n) => {
      const t = n.getAttribute('tie');
      return t === 'i' || t === 'm';
    });
  }

  /** True when any inner note has an incoming tie ('t' or 'm'). */
  private elementHasTieTerminal(elem: Element): boolean {
    const notes = this.extractNoteElements(elem);
    return notes.some((n) => {
      const t = n.getAttribute('tie');
      return t === 't' || t === 'm';
    });
  }

}

/* ── helpers (module-scope) ──────────────────────────────────────────────── */

/** Set the @tie attribute to a single MEI 5 value. data.TIE is i|m|t|n;
 *  there is NO compound form. Callers that need both "incoming and outgoing"
 *  semantics should pass 'm' directly. */
function setTieFlag(note: Element, value: 'i' | 'm' | 't'): void {
  note.setAttribute('tie', value);
}

/** Remove any tie marker from this note. */
function clearTieFlag(note: Element): void {
  note.removeAttribute('tie');
}

/** Mark a note as a stub tie:
 *    - data-pending-tie drives our auto-resolve on later inserts.
 *    - A <lv> control element (laissez vibrer) is added as a child of the
 *      enclosing <measure>, with @startid pointing to the note. */
function setStubTie(note: Element): void {
  note.setAttribute('data-pending-tie', 'true');
  ensureLvForNote(note);
}

/** Remove the stub-tie markers (both data-pending-tie and the <lv> element). */
function clearStubTie(note: Element): void {
  note.removeAttribute('data-pending-tie');
  removeLvForNote(note);
}

/** Add a <lv startid="#noteId"/> child to the enclosing <measure> if one
 *  for this note doesn't already exist. */
function ensureLvForNote(note: Element): void {
  const id = note.getAttribute('xml:id');
  if (!id) return;
  const doc = note.ownerDocument;
  if (!doc) return;
  const measure = note.closest('measure');
  if (!measure) return;
  const target = '#' + id;
  for (const child of Array.from(measure.children)) {
    if (child.localName === 'lv' && child.getAttribute('startid') === target) return;
  }
  /* Verovio reads only @endid or @tstamp2 to resolve the end of an <lv>'s
     timespan (verified in src/timeinterface.cpp + src/preparedatafunctor.cpp
     in rism-digital/verovio). @dur is ignored. Pointing @endid at another
     real note would draw a misleading regular tie. We synthesize @tstamp2
     a half-beat past the note's onset, clamped just shy of the bar line,
     giving a short hanging arc. Verovio's Lv::CalculatePosition requires
     start and end to share a measure — by construction, our tstamp2 is
     within the same measure as the note. */
  const tstamp2 = computeStubTstamp2(note, doc);
  const lv = doc.createElementNS(MEI_NS, 'lv');
  lv.setAttribute('startid', target);
  lv.setAttribute('tstamp2', tstamp2);
  measure.appendChild(lv);
}

/** Compute a @tstamp2 value (format "0m+B") that lands a half beat past the
 *  given note's onset, clamped to stay just inside the current measure. */
function computeStubTstamp2(note: Element, doc: Document): string {
  const sd = doc.querySelector('scoreDef');
  const count = parseInt(sd?.getAttribute('meter.count') ?? '4', 10);
  const unit = parseInt(sd?.getAttribute('meter.unit') ?? '4', 10);

  const layer = note.closest('layer');
  if (!layer) return '0m+' + count;
  /* The note may be inside a <chord>; walk up until the immediate child of
     <layer> (which is the note/chord/rest at this timeline position). */
  let container: Element | null = note;
  while (container && container.parentElement !== layer) {
    container = container.parentElement;
  }
  if (!container) return '0m+' + count;

  /* Sum 64th-note ticks of preceding sibling content. */
  let ticks = 0;
  for (const c of Array.from(layer.children)) {
    if (c === container) break;
    if (c.localName !== 'chord' && c.localName !== 'note' && c.localName !== 'rest') continue;
    const dur = c.getAttribute('dur');
    const dots = parseInt(c.getAttribute('dots') ?? '0', 10);
    const denom = dur ? parseInt(dur, 10) : NaN;
    if (!Number.isFinite(denom) || denom <= 0) continue;
    const base = 64 / denom;
    ticks += dots === 1 ? base * 1.5 : dots === 2 ? base * 1.75 : base;
  }

  /* 1 beat = (64 / meter.unit) ticks. Beats are 1-indexed. */
  const ticksPerBeat = 64 / unit;
  const startBeat = ticks / ticksPerBeat + 1;
  const cap = count + 0.95;
  const endBeat = Math.min(startBeat + 0.5, cap);
  return '0m+' + endBeat.toFixed(3).replace(/\.?0+$/, '');
}

/** Remove any <lv> whose @startid points at this note. */
function removeLvForNote(note: Element): void {
  const id = note.getAttribute('xml:id');
  if (!id) return;
  const measure = note.closest('measure');
  if (!measure) return;
  const target = '#' + id;
  for (const child of Array.from(measure.children)) {
    if (child.localName === 'lv' && child.getAttribute('startid') === target) {
      measure.removeChild(child);
    }
  }
}

function notesMatch(a: Element, b: Element): boolean {
  return a.getAttribute('pname') === b.getAttribute('pname')
    && (a.getAttribute('accid') ?? '') === (b.getAttribute('accid') ?? '')
    && a.getAttribute('oct') === b.getAttribute('oct');
}

/* ── rebuild snapshot helpers ────────────────────────────────────────────── */

interface SnapNote {
  q: number; r: number;
  pname: ResolvedNote['pname'];
  accid: ResolvedNote['accid'];
  oct: number;
  colorHex: string;
}

function snapNoteOf(n: Element): SnapNote {
  return {
    q: parseInt(n.getAttribute('data-q') ?? '0', 10),
    r: parseInt(n.getAttribute('data-r') ?? '0', 10),
    pname: (n.getAttribute('pname') ?? 'c') as ResolvedNote['pname'],
    accid: (n.getAttribute('accid') ?? '') as ResolvedNote['accid'],
    oct: parseInt(n.getAttribute('oct') ?? '4', 10),
    colorHex: n.getAttribute('color') ?? '#000000',
  };
}

function resolvedFromSnapNote(s: SnapNote): ResolvedNote {
  const midi = 57 + 4 * s.q + 7 * s.r;
  return {
    q: s.q, r: s.r,
    pname: s.pname, accid: s.accid, oct: s.oct,
    midi, colorHex: s.colorHex, velocity: 80,
  };
}

/* ── chord input builder from bridge held-keys ──────────────────────────── */

export function buildChordInput(
  resolvedNotes: ReadonlyArray<ResolvedNote>,
  duration: Duration,
  dots: Dots = 0,
): ChordInput {
  return { notes: resolvedNotes, duration, dots };
}
