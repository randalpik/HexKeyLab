// Composer MEI model. In-memory MEI 5 DOM with mutation operations for
// keyboard-driven step entry. Serializes to a string for Verovio's loadData().
//
// Structure assumption (v1):
//   1 mdiv / 1 score / 1 section
//   <staffGrp symbol="brace"> with two <staffDef> (treble, bass)
//   Voices map to (staff, layer):
//     voice 1 → staff 1, layer 1   (treble top)
//     voice 2 → staff 1, layer 2   (treble bottom)
//     voice 3 → staff 2, layer 1   (bass top)
//     voice 4 → staff 2, layer 2   (bass bottom)
//   Per voice: an ordered list of <chord>, <note>, or <rest> elements as
//   immediate children of the layer. Initial v1 has a single measure that
//   grows; explicit "next measure" is a v2 concern.
//
// (q, r) lattice coordinates ride along on each <note> as data-q / data-r
// attributes so future tools can recover the lattice identity from a saved
// .hkc file. MEI ignores unknown attributes.

import type { ResolvedNote } from '../bridge/protocol.js';

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

/* ── XML namespace + utilities ───────────────────────────────────────────── */

const MEI_NS = 'http://www.music-encoding.org/ns/mei';

function el(doc: Document, name: string, attrs?: Record<string, string | number | undefined>): Element {
  const e = doc.createElementNS(MEI_NS, name);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v !== undefined && v !== null && v !== '') e.setAttribute(k, String(v));
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

/** Element duration in 64th-note ticks (1 whole = 64). Returns 16 (quarter)
 *  as a safe fallback for elements with malformed/missing @dur. Used for
 *  cursor time-alignment when switching voices. */
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

function emptyMeiDoc(title: string): Document {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="${MEI_NS}" meiversion="5.0">
  <meiHead>
    <fileDesc>
      <titleStmt><title>${escapeXml(title)}</title></titleStmt>
      <pubStmt/>
    </fileDesc>
  </meiHead>
  <music><body><mdiv><score>
    <scoreDef>
      <staffGrp symbol="brace">
        <staffDef n="1" lines="5" clef.shape="G" clef.line="2"/>
        <staffDef n="2" lines="5" clef.shape="F" clef.line="4"/>
      </staffGrp>
    </scoreDef>
    <section>
      <measure n="1" xml:id="${newId('m')}">
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

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
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
    } else {
      this.doc = emptyMeiDoc('Untitled');
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
  }

  /* ── accessors ──────────────────────────────────────────────────────────── */

  serialize(): string {
    return new XMLSerializer().serializeToString(this.doc);
  }

  getCurrentVoice(): Voice {
    return this.currentVoice;
  }

  getCursor(voice?: Voice): number {
    return this.cursors[voice ?? this.currentVoice];
  }

  getVoiceLength(voice?: Voice): number {
    const layer = this.layerOf(voice ?? this.currentVoice);
    if (!layer) return 0;
    return this.contentChildren(layer).length;
  }

  /** Returns the MEI xml:id of the element at the given cursor (if any). */
  getElementIdAt(voice: Voice, cursor: number): string | null {
    const layer = this.layerOf(voice);
    if (!layer) return null;
    const kids = this.contentChildren(layer);
    if (cursor < 0 || cursor >= kids.length) return null;
    return kids[cursor].getAttribute('xml:id');
  }

  /** Find which voice + index contains the element with the given xml:id.
   *  Used by playback to advance the cursor to the currently-sounding chord. */
  findElement(meiId: string): { voice: Voice; index: number } | null {
    for (let voice: Voice = 1; voice <= 4; voice = (voice + 1) as Voice) {
      const layer = this.layerOf(voice);
      if (!layer) {
        if (voice === 4) break;
        continue;
      }
      const kids = this.contentChildren(layer);
      for (let i = 0; i < kids.length; i++) {
        if (kids[i].getAttribute('xml:id') === meiId) {
          return { voice, index: i };
        }
      }
      if (voice === 4) break;
    }
    return null;
  }

  /* ── navigation ─────────────────────────────────────────────────────────── */

  switchVoice(dir: 'up' | 'down'): Voice {
    /* Voice order top-to-bottom: 1 (treble top) → 2 → 3 → 4 (bass bottom).
       'up' arrow moves toward voice 1; 'down' arrow toward voice 4. */
    const cur = this.currentVoice;
    let next: Voice;
    if (dir === 'up') next = (cur > 1 ? (cur - 1) : 1) as Voice;
    else              next = (cur < 4 ? (cur + 1) : 4) as Voice;
    if (next === cur) return next;
    /* Align the new voice's cursor with the current time position. Choose
       the latest cursor in the new voice whose start time is ≤ the source
       cursor's start time — i.e. prefer going backward, not forward, when
       no exact-time match exists. */
    const currentTime = this.getTimeAt(cur, this.cursors[cur]);
    this.currentVoice = next;
    this.cursors[next] = this.findCursorAtOrBefore(next, currentTime);
    return next;
  }

  /** Cumulative duration (in 64th-note ticks) of elements before `cursor`
   *  in `voice`. Used to derive a time-position from a cursor index, so
   *  switching voices can land at an equivalent time in the new voice. */
  getTimeAt(voice: Voice, cursor: number): number {
    const layer = this.layerOf(voice);
    if (!layer) return 0;
    const kids = this.contentChildren(layer);
    const upto = Math.max(0, Math.min(cursor, kids.length));
    let t = 0;
    for (let i = 0; i < upto; i++) t += elementDurationTicks(kids[i]);
    return t;
  }

  /** Largest cursor index in `voice` whose start-time is ≤ targetTime.
   *  Returns 0 for empty voices or when targetTime is before the first
   *  element; returns voiceLength when targetTime is past the last. */
  findCursorAtOrBefore(voice: Voice, targetTime: number): number {
    const layer = this.layerOf(voice);
    if (!layer) return 0;
    const kids = this.contentChildren(layer);
    let cumulative = 0;
    let bestCursor = 0;
    for (let i = 0; i <= kids.length; i++) {
      if (cumulative <= targetTime) bestCursor = i;
      else break;
      if (i < kids.length) cumulative += elementDurationTicks(kids[i]);
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

  /** Append a chord at the end of the current voice; advances cursor. */
  appendChord(input: ChordInput): string {
    const v = this.currentVoice;
    this.cursors[v] = this.getVoiceLength(v); /* always append at end on chord-entry shortcut */
    return this.insertChordAtCursor(input);
  }

  /** Insert a chord at the current voice's cursor; advances cursor. */
  insertChordAtCursor(input: ChordInput): string {
    const v = this.currentVoice;
    const layer = this.requireLayer(v);
    const element = this.buildChordElement(input);
    this.insertAt(layer, element, this.cursors[v]);
    this.cursors[v]++;
    return element.getAttribute('xml:id')!;
  }

  /** Replace the element at the current cursor with a new chord. */
  replaceChordAtCursor(input: ChordInput): string | null {
    const v = this.currentVoice;
    const layer = this.requireLayer(v);
    const kids = this.contentChildren(layer);
    const c = this.cursors[v];
    if (c >= kids.length) return null; /* cursor at end — nothing to replace */
    const element = this.buildChordElement(input);
    layer.replaceChild(element, kids[c]);
    return element.getAttribute('xml:id')!;
  }

  /** Append a rest at the end of the current voice; advances cursor. */
  appendRest(input: RestInput): string {
    const v = this.currentVoice;
    this.cursors[v] = this.getVoiceLength(v);
    const layer = this.requireLayer(v);
    const element = this.buildRestElement(input);
    this.insertAt(layer, element, this.cursors[v]);
    this.cursors[v]++;
    return element.getAttribute('xml:id')!;
  }

  /** Insert a rest at the current voice's cursor; advances cursor. */
  insertRestAtCursor(input: RestInput): string {
    const v = this.currentVoice;
    const layer = this.requireLayer(v);
    const element = this.buildRestElement(input);
    this.insertAt(layer, element, this.cursors[v]);
    this.cursors[v]++;
    return element.getAttribute('xml:id')!;
  }

  /** Delete the last element of the current voice (Backspace semantics). */
  deleteLastInVoice(): boolean {
    const v = this.currentVoice;
    const layer = this.requireLayer(v);
    const kids = this.contentChildren(layer);
    if (kids.length === 0) return false;
    layer.removeChild(kids[kids.length - 1]);
    if (this.cursors[v] > kids.length - 1) this.cursors[v] = kids.length - 1;
    return true;
  }

  /** Delete the element immediately to the left of the cursor. */
  deleteAtCursor(): boolean {
    const v = this.currentVoice;
    const layer = this.requireLayer(v);
    const kids = this.contentChildren(layer);
    const c = this.cursors[v];
    if (c <= 0 || c > kids.length) return false;
    layer.removeChild(kids[c - 1]);
    this.cursors[v] = c - 1;
    return true;
  }

  /* ── private helpers ────────────────────────────────────────────────────── */

  private layerOf(voice: Voice): Element | null {
    const staffN = (voice <= 2) ? 1 : 2;
    const layerN = (voice === 1 || voice === 3) ? 1 : 2;
    /* First measure for v1. */
    const measure = this.doc.querySelector('measure');
    if (!measure) return null;
    const staff = Array.from(measure.querySelectorAll('staff'))
      .find((s) => s.getAttribute('n') === String(staffN));
    if (!staff) return null;
    const layer = Array.from(staff.querySelectorAll('layer'))
      .find((l) => l.getAttribute('n') === String(layerN));
    return layer ?? null;
  }

  private requireLayer(voice: Voice): Element {
    const l = this.layerOf(voice);
    if (!l) throw new Error('layer not found for voice ' + voice);
    return l;
  }

  /** Filter to actual musical content (chord/note/rest), skip whitespace. */
  private contentChildren(layer: Element): Element[] {
    return Array.from(layer.children).filter((c) =>
      c.localName === 'chord' || c.localName === 'note' || c.localName === 'rest');
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
      /* Single note — emit as bare <note>, not <chord>, for cleaner MEI. */
      const n = input.notes[0];
      return this.buildNoteElement(n, dur, dots);
    }
    const chord = el(doc, 'chord', {
      'xml:id': newId('c'),
      dur,
      dots: dots > 0 ? dots : undefined,
    });
    /* Sort low → high for stable rendering. */
    const sorted = [...input.notes].sort((a, b) => a.midi - b.midi);
    for (const n of sorted) chord.appendChild(this.buildNoteElement(n, dur, dots, /* inChord */ true));
    return chord;
  }

  private buildNoteElement(n: ResolvedNote, dur: Duration, dots: Dots, inChord = false): Element {
    /* Inside a chord, MEI takes pitch/accid/color from the <note> but the
       duration is on the <chord>. So omit dur on the inner notes. */
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
}

/* ── chord input builder from bridge held-keys ──────────────────────────── */

export function buildChordInput(
  resolvedNotes: ReadonlyArray<ResolvedNote>,
  duration: Duration,
  dots: Dots = 0,
): ChordInput {
  return { notes: resolvedNotes, duration, dots };
}
