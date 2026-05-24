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
import { decomposeBeatAlignedRests } from './restfill.js';
import { computeAccidentalDisplay, alterFromCount, alterFromToken, tokenFromAlter, getNoteAlter } from './accidentals.js';
import { ensureExpressionDefaults, getLayoutReq, setLayoutReq, type LayoutReq, type Moment } from './expressions.js';
import type { TuningMode } from '../shared/freq.js';
import { realTicks, writtenTicks } from './ticks.js';

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

/** A single placement emitted by `planInsert`. `inserted` actions describe
 *  pieces of the newly-typed note (split into chunks on bar lines, with
 *  ties wired during apply); `reuse` actions describe existing post-cursor
 *  elements that move wholesale (the element keeps its identity, attrs,
 *  and any pre-existing ties). */
type InsertAction =
  | { kind: 'inserted'; dur: Duration; dots: Dots; targetMIdx: number; pieceIdx: number; pieceCount: number }
  | { kind: 'reuse'; el: Element; targetMIdx: number };

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
  /* Required layout for this score. Default is Ptolemaic / A3-at-origin if
     omitted; the Setup dialog populates this with HKL's current state at
     score creation. */
  layoutReq?: LayoutReq;
}

/* ── XML namespace + utilities ───────────────────────────────────────────── */

export const MEI_NS = 'http://www.music-encoding.org/ns/mei';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** Custom attribute marking an empty-voice-in-this-measure placeholder.
 *  These are <space> elements that give Verovio enough layout content to
 *  size the measure correctly, are visually invisible per MEI spec, and
 *  serve as navigation targets so the cursor can land in an empty voice
 *  in mid-score. See normalizePlaceholders. */
const PLACEHOLDER_ATTR = 'data-placeholder';

/** Custom attribute marking an element inside a <tuplet> that represents
 *  unfilled written-ticks (the "fill anchor" chain). Distinct from the
 *  measure-level PLACEHOLDER_ATTR — these live as direct children of
 *  <tuplet>, never of <layer>. Concretely the element is
 *  `<rest visible="false">` (Verovio reserves layout width AND draws the
 *  tuplet bracket over it, while suppressing the rest glyph). */
const TUPLET_PLACEHOLDER_ATTR = 'data-tuplet-placeholder';

function isPlaceholder(el: Element): boolean {
  return el.localName === 'space' && el.getAttribute(PLACEHOLDER_ATTR) === 'true';
}

/** Element-name-agnostic tuplet-placeholder predicate. Matches the canonical
 *  `<rest visible="false" data-tuplet-placeholder="true">` form as well as
 *  any legacy `<space data-tuplet-placeholder="true">` that might survive
 *  in older docs. */
function isTupletPlaceholder(el: Element): boolean {
  return el.getAttribute(TUPLET_PLACEHOLDER_ATTR) === 'true';
}

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
   Largest first. The @dur values here MUST be consistent with ticksOf —
   e.g. dotted half = ticksOf('2', 1) = 48, so the 48-tick entry must carry
   dur='2' dots=1, not dur='1' dots=1 (= 96). */
const TICK_TABLE: ReadonlyArray<{ ticks: number; dur: Duration; dots: Dots }> = [
  { ticks: 64, dur: '1',  dots: 0 },   /* whole */
  { ticks: 56, dur: '2',  dots: 2 },   /* double-dotted half */
  { ticks: 48, dur: '2',  dots: 1 },   /* dotted half */
  { ticks: 32, dur: '2',  dots: 0 },   /* half */
  { ticks: 28, dur: '4',  dots: 2 },   /* double-dotted quarter */
  { ticks: 24, dur: '4',  dots: 1 },   /* dotted quarter */
  { ticks: 16, dur: '4',  dots: 0 },   /* quarter */
  { ticks: 14, dur: '8',  dots: 2 },   /* double-dotted 8th */
  { ticks: 12, dur: '8',  dots: 1 },   /* dotted 8th */
  { ticks: 8,  dur: '8',  dots: 0 },   /* 8th */
  { ticks: 7,  dur: '16', dots: 2 },   /* double-dotted 16th */
  { ticks: 6,  dur: '16', dots: 1 },   /* dotted 16th */
  { ticks: 4,  dur: '16', dots: 0 },   /* 16th */
  { ticks: 3,  dur: '32', dots: 1 },   /* dotted 32nd */
  { ticks: 2,  dur: '32', dots: 0 },   /* 32nd */
  { ticks: 1,  dur: '64', dots: 0 },   /* 64th */
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

/** Element duration in 64th-note ticks (real / sounding ticks). Tuplet-aware:
 *  for a <tuplet> wrapper this returns the total real span (sum of children's
 *  written ticks scaled by numbase/num); for an element inside a tuplet, this
 *  returns its scaled (real) duration. Atomic non-tuplet elements get plain
 *  writtenTicks. See src/composer/ticks.ts for the shared implementation. */
function elementDurationTicks(el: Element): number {
  return realTicks(el);
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
  const lr = setup.layoutReq ?? { tuningMode: '5', refQ: 0, refR: 0 };
  const layoutReqBlock = `<hkl:layoutReq tuningMode="${lr.tuningMode}" refQ="${lr.refQ}" refR="${lr.refR}"/>`;

  /* <extMeta> with HKL-namespaced config carries document-level performance
     defaults (dynamic→velocity map, future tempo alteration). The xmlns:hkl
     prefix declaration lives here so the prefixed elements parse cleanly. */
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="${MEI_NS}" xmlns:hkl="https://hexkeylab.com/ns/mei" meiversion="5.0">
  <meiHead>
    <fileDesc>
      <titleStmt><title>${escapeXml(title)}</title>${composerBlock}</titleStmt>
      <pubStmt/>
    </fileDesc>
    <extMeta>
      <hkl:config>
        ${layoutReqBlock}
        <hkl:dynamicMap>
          <hkl:level name="fff" velocity="127"/>
          <hkl:level name="ff"  velocity="124"/>
          <hkl:level name="f"   velocity="120"/>
          <hkl:level name="mf"  velocity="116"/>
          <hkl:level name="mp"  velocity="112"/>
          <hkl:level name="p"   velocity="108"/>
          <hkl:level name="pp"  velocity="103"/>
          <hkl:level name="ppp" velocity="96"/>
        </hkl:dynamicMap>
      </hkl:config>
    </extMeta>
  </meiHead>
  <music><body><mdiv><score>
    <scoreDef key.sig="${keySig}" meter.count="${count}" meter.unit="${unit}">
      <staffGrp symbol="brace" bar.thru="true">
        <staffDef n="1" lines="5" clef.shape="G" clef.line="2"/>
        <staffDef n="2" lines="5" clef.shape="F" clef.line="4"/>
      </staffGrp>
    </scoreDef>
    <section>
      <measure n="1" right="end" xml:id="${newId("m")}">
        <tempo tstamp="1" staff="1" mm="${bpm}" mm.unit="${tempoUnit}"${tempoDotsAttr} midi.bpm="${bpm}">${tempoTextSpan}</tempo>
        <staff n="1" xml:id="${newId("s")}">
          <layer n="1" xml:id="${newId("l")}"/>
          <layer n="2" xml:id="${newId("l")}"/>
        </staff>
        <staff n="2" xml:id="${newId("s")}">
          <layer n="1" xml:id="${newId("l")}"/>
          <layer n="2" xml:id="${newId("l")}"/>
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
      this.doc = new DOMParser().parseFromString(initialMei, "application/xml");
      if (this.doc.querySelector("parsererror")) {
        throw new Error("Failed to parse initial MEI");
      }
      this.stripBeamsInLiveDoc();
    } else {
      this.doc = emptyMeiDoc();
    }
    ensureExpressionDefaults(this.doc);
    this.normalizePlaceholders();
  }

  /** Replace the entire document in-place (used by Load .hkc to preserve
   *  bindings held by other modules). */
  replaceDocument(meiXml: string): void {
    const newDoc = new DOMParser().parseFromString(meiXml, "application/xml");
    if (newDoc.querySelector("parsererror"))
      throw new Error("Invalid MEI in load");
    this.doc = newDoc;
    this.currentVoice = 1;
    this.cursors = { 1: 0, 2: 0, 3: 0, 4: 0 };
    this.stripBeamsInLiveDoc();
    /* Migrate older .hkc files that lack bar.thru on the staffGrp. */
    const sg = this.doc.querySelector("staffGrp");
    if (sg && !sg.hasAttribute("bar.thru")) sg.setAttribute("bar.thru", "true");
    /* Migrate older .hkc files that lack xml:id on <staff> (cursor.ts looks
       these up to position the empty-voice cursor on the right staff). */
    for (const staff of Array.from(this.doc.querySelectorAll("staff"))) {
      if (!staff.getAttribute("xml:id")) {
        staff.setAttributeNS(XML_NS, "xml:id", newId("s"));
      }
    }
    /* Migrate older .hkc files that used @accid="ss" for double sharps —
       Verovio renders that as a precomposed "##" glyph, not the canonical
       × (which is @accid="x"). Rewrite for visual consistency. */
    for (const note of Array.from(this.doc.querySelectorAll("note"))) {
      if (note.getAttribute("accid") === "ss") note.setAttribute("accid", "x");
      if (note.getAttribute("accid.ges") === "ss")
        note.setAttribute("accid.ges", "x");
    }
    /* Migrate older .hkc files that emitted <accid> child elements for
       quadruple+ accidentals. Verovio's layout doesn't reserve space for
       extra accid children (they overlap), so we no longer use them.
       Collapse them into a single @accid clamped to ±3. */
    for (const note of Array.from(this.doc.querySelectorAll("note"))) {
      const accidChildren = Array.from(note.children).filter(
        (c) => c.localName === "accid",
      );
      if (accidChildren.length === 0) continue;
      let alter = 0;
      for (const c of accidChildren) {
        alter += alterFromToken(c.getAttribute("accid") ?? "");
        note.removeChild(c);
      }
      const token = tokenFromAlter(alter);
      if (token) note.setAttribute("accid", token);
    }
    /* Migrate older .hkc files that used right="dbl" for the final barline. */
    this.setBarlines();
    /* Seed <extMeta>/<hkl:config> defaults if the loaded doc lacks them. */
    ensureExpressionDefaults(this.doc);
    this.normalizeTies();
    this.normalizePlaceholders();
  }

  /** Strip any <beam> wrappers from the live doc so cursor/mutation code
   *  always sees flat layer children. Beams are re-added at serialize() time
   *  by the beams.ts module. Safe no-op when there are no beams. */
  private stripBeamsInLiveDoc(): void {
    const beams = this.doc.querySelectorAll("beam");
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
       (cursor/mutation invariant). All passes are idempotent. Order:
       accidentals first (operates on flat notes), then beams (wraps them). */
    const clone = this.doc.cloneNode(true) as Document;
    computeAccidentalDisplay(clone, this.getKeySig());
    regroupBeams(clone, readTimeSig(clone));
    return new XMLSerializer().serializeToString(clone);
  }

  /* ── undo/redo snapshots ────────────────────────────────────────────────── */

  /** Capture editable state (live MEI + voice + four cursors) for the history
   *  stack. Serializes the live doc directly — no render passes — so the
   *  output is round-trip-stable through restoreSnapshot. */
  snapshotState(): { mei: string; voice: Voice; cursors: Record<Voice, number> } {
    return {
      mei: new XMLSerializer().serializeToString(this.doc),
      voice: this.currentVoice,
      cursors: { ...this.cursors },
    };
  }

  /** Restore a snapshot in full (MEI + voice + cursors). Fast path — snapshots
   *  are already in live form (beams stripped, accidentals normalized), so
   *  the replaceDocument migrations are skipped; we still re-normalize ties
   *  and placeholders defensively. */
  restoreSnapshot(snap: { mei: string; voice: Voice; cursors: Record<Voice, number> }): void {
    const newDoc = new DOMParser().parseFromString(snap.mei, 'application/xml');
    if (newDoc.querySelector('parsererror')) throw new Error('Invalid MEI snapshot');
    this.doc = newDoc;
    this.currentVoice = snap.voice;
    this.cursors = { ...snap.cursors };
    ensureExpressionDefaults(this.doc);
    this.normalizeTies();
    this.normalizePlaceholders();
    this.clampAllCursors();
  }

  /** Restore the MEI portion of a snapshot but keep the caller-supplied
   *  voice/cursors (clamped). Used when the cursor-position-match check
   *  fails and we want to leave the user's focus where they moved it. */
  restoreSnapshotMeiOnly(
    snap: { mei: string },
    voice: Voice,
    cursors: Record<Voice, number>,
  ): void {
    const newDoc = new DOMParser().parseFromString(snap.mei, 'application/xml');
    if (newDoc.querySelector('parsererror')) throw new Error('Invalid MEI snapshot');
    this.doc = newDoc;
    this.currentVoice = voice;
    this.cursors = { ...cursors };
    ensureExpressionDefaults(this.doc);
    this.normalizeTies();
    this.normalizePlaceholders();
    this.clampAllCursors();
  }

  private clampAllCursors(): void {
    for (const v of [1, 2, 3, 4] as Voice[]) {
      const len = this.getVoiceLength(v);
      if (this.cursors[v] < 0) this.cursors[v] = 0;
      else if (this.cursors[v] > len) this.cursors[v] = len;
    }
  }

  getCurrentVoice(): Voice {
    return this.currentVoice;
  }

  getCursor(voice?: Voice): number {
    return this.cursors[voice ?? this.currentVoice];
  }

  /** Voice length = max reachable cursor index (cursor range is `[0, len]`
   *  inclusive). `cursor === flatChildren.length` is the synthetic past-end
   *  stop — but it ONLY exists when the last measure's voice-layer has room
   *  for more content. When the last measure is FULL in this voice, the
   *  rightmost real flat stop (cursor at `flat.length - 1` = past last
   *  content) already inserts into the next measure via bounded-overflow
   *  cascade, so a separate past-end position would render at the same
   *  visual x and produce a stuck-cursor pair. In that case `voiceLen =
   *  flat.length - 1` and there is no past-end position to navigate to. */
  getVoiceLength(voice?: Voice): number {
    const v = voice ?? this.currentVoice;
    const flatLen = this.flatChildren(v).length;
    if (flatLen === 0) return 0;
    const measures = this.allMeasures();
    const lastMeasure = measures[measures.length - 1];
    if (lastMeasure) {
      const lastLayer = this.layerInMeasure(lastMeasure, v);
      if (lastLayer && this.layerIsFull(lastLayer)) return flatLen - 1;
    }
    return flatLen;
  }

  /** True iff this voice's cursor is at the past-end synthetic stop. With
   *  the conditional-past-end rule, past-end exists only when the last
   *  measure's voice-layer has room — so this check requires both
   *  `cursor === flat.length` AND the last layer not being full. */
  isCursorAtPastEnd(voice?: Voice): boolean {
    const v = voice ?? this.currentVoice;
    const flatLen = this.flatChildren(v).length;
    return this.cursors[v] >= flatLen;
  }

  /** Returns the MEI xml:id of the element at the given linear cursor. */
  getElementIdAt(voice: Voice, cursor: number): string | null {
    const flat = this.flatChildren(voice);
    if (cursor < 0 || cursor >= flat.length) return null;
    return flat[cursor].getAttribute("xml:id");
  }

  /** Find which voice + index contains the element with the given xml:id.
   *  Used by playback to advance the cursor to the currently-sounding chord. */
  findElement(meiId: string): { voice: Voice; index: number } | null {
    for (let voice: Voice = 1; voice <= 4; voice = (voice + 1) as Voice) {
      const flat = this.flatChildren(voice);
      for (let i = 0; i < flat.length; i++) {
        if (flat[i].getAttribute("xml:id") === meiId) {
          return { voice, index: i };
        }
      }
      if (voice === 4) break;
    }
    return null;
  }

  /** Measure index containing the given xml:id's element. -1 if not found. */
  getMeasureIdxForId(meiId: string): number {
    const measures = this.allMeasures();
    for (let i = 0; i < measures.length; i++) {
      const m = measures[i];
      if (m.querySelector(`[*|id="${meiId}"]`) || m.getAttribute("xml:id") === meiId) {
        return i;
      }
    }
    return -1;
  }

  /** Measure index of the cursor for `voice` (defaults to current voice).
   *  -1 if the score has no measures. */
  getCursorMeasureIdx(voice?: Voice): number {
    const v = voice ?? this.currentVoice;
    const loc = this.locateCursor(v, this.cursors[v]);
    return loc ? loc.measureIdx : -1;
  }

  /** Flat-children cursor index of the first navigable stop in `measureIdx`
   *  for `voice` (the wrapper if emitted, else the first layer stop). */
  getMeasureStartCursor(voice: Voice, measureIdx: number): number {
    const measures = this.allMeasures();
    if (measureIdx <= 0) return 0;
    const cap = Math.min(measureIdx, measures.length);
    let consumed = 0;
    for (let mi = 0; mi < cap; mi++) {
      const layer = this.layerInMeasure(measures[mi], voice);
      if (!layer) continue;
      const emit = this.shouldEmitWrapper(measures, voice, mi);
      consumed += this.measureStopCount(measures, voice, mi, layer, emit);
    }
    return consumed;
  }

  /** True iff this voice's layer in `measureIdx` has no real content
   *  (only placeholders, or no layer at all). */
  isMeasureEmptyInVoice(voice: Voice, measureIdx: number): boolean {
    const measures = this.allMeasures();
    if (measureIdx < 0 || measureIdx >= measures.length) return false;
    const layer = this.layerInMeasure(measures[measureIdx], voice);
    return !layer || this.contentChildren(layer).length === 0;
  }

  /** Compute the visual measure of a hypothetical cursor at flat-index `c`
   *  in `voice` under `mode`. Under the new cursor-index convention, both
   *  INSERT and OVERWRITE refer to `flat[c]` as the anchor (the element
   *  to the cursor's left). Visual measure = anchor's containing measure.
   *  Past-end (c === flat.length): last existing measure. */
  private cursorVisualMeasureAtIndex(voice: Voice, c: number, _mode: 'insert' | 'overwrite'): number {
    const measures = this.allMeasures();
    if (measures.length === 0) return -1;
    const flat = this.flatChildren(voice);
    if (c >= flat.length) return measures.length - 1; /* past-end */
    const anchor = flat[c];
    const m = anchor.closest('measure');
    return m ? measures.indexOf(m) : 0;
  }

  /** Measure index of the cursor's VISUAL anchor — i.e., where the cursor
   *  renders on screen. This is the single canonical "current measure"
   *  concept used by Ctrl-nav, scroll-into-view, autofill triggers, and
   *  the cursor renderer. See `cursorVisualMeasureAtIndex` for the rules.
   *  Distinct from `locateCursor().insertMeasureIdx`, which returns the
   *  insertion-target measure (used internally by insert/replace/etc.). */
  cursorMeasureIdx(voice?: Voice, mode: 'insert' | 'overwrite' = 'insert'): number {
    const v = voice ?? this.currentVoice;
    return this.cursorVisualMeasureAtIndex(v, this.cursors[v], mode);
  }

  /** First cursor index visually inside `measureIdx` for this voice.
   *  Under the new convention, both modes refer to flat[c] as the
   *  anchor — return the smallest c where flat[c]'s measure is
   *  measureIdx. No mode-specific skip; the wrapper IS the first
   *  navigable stop of the measure (rule 2 for empty, rule 3 for
   *  non-empty with incomplete prev) and Ctrl-nav lands on it. */
  getFirstVisualCursorInMeasure(
    voice: Voice,
    measureIdx: number,
    mode: 'insert' | 'overwrite' = 'insert',
  ): number {
    const measures = this.allMeasures();
    if (measureIdx < 0 || measureIdx >= measures.length) return -1;
    const flat = this.flatChildren(voice);
    for (let c = 0; c <= flat.length; c++) {
      if (this.cursorVisualMeasureAtIndex(voice, c, mode) === measureIdx) {
        return c;
      }
    }
    return -1;
  }

  /** Absolute tick offset (in 64th-notes) of the cursor relative to the
   *  start of the score, computed as `measureIdx * measureTicks +
   *  withinMeasureTicks`. Voice-independent at the measure-index level;
   *  within-measure offset uses real (tuplet-scaled) ticks. Past-end
   *  returns the score's total tick length. */
  getCursorAbsoluteTicks(voice?: Voice): number {
    const v = voice ?? this.currentVoice;
    return this.getTickPositionAt(v, this.cursors[v]);
  }

  /** Absolute tick offset for an arbitrary flat-cursor index `c` in `voice`.
   *  Mirrors `getCursorAbsoluteTicks` but parameterized so callers (selection
   *  beat-boundary detection) can query positions without disturbing the
   *  cursor. Past-end (`c >= flat.length`) returns the score's total tick
   *  length. */
  getTickPositionAt(voice: Voice, c: number): number {
    const flat = this.flatChildren(voice);
    if (c >= flat.length) {
      return this.allMeasures().length * this.measureTicks();
    }
    const loc = this.locateCursor(voice, c);
    if (!loc) return 0;
    let t = loc.measureIdx * this.measureTicks();
    const cc = this.contentChildren(loc.layer);
    const upto = Math.min(loc.withinIdx, cc.length);
    for (let i = 0; i < upto; i++) t += realTicks(cc[i]);
    if (loc.inTuplet) {
      const tChildren = Array.from(loc.inTuplet.tuplet.children);
      const tCap = Math.min(loc.inTuplet.tupletChildIdx, tChildren.length);
      for (let i = 0; i < tCap; i++) t += realTicks(tChildren[i]);
    }
    return t;
  }

  /** Public read-only summary of the cursor location at flat-index `c` in
   *  `voice`. `inTuplet` is true iff the cursor falls strictly inside a
   *  tuplet's body — the "exit-tuplet" stop (= visually past the tuplet)
   *  reports false, because locateCursor's anchoring treats it as a
   *  layer-level position. Past-end yields `measureIdx === allMeasures.length`
   *  (synthetic next-measure slot). */
  getFlatStopInfo(voice: Voice, c: number): { measureIdx: number; inTuplet: boolean } | null {
    const loc = this.locateCursor(voice, c);
    if (!loc) return null;
    return { measureIdx: loc.measureIdx, inTuplet: loc.inTuplet !== null };
  }

  /** Largest cursor index `c` such that `getTickPositionAt(voice, c) <=
   *  targetTime`. Uses the locateCursor convention ("cursor c is past
   *  flat[c]") — the same convention insertChordAtCursor / deleteAtCursor /
   *  etc. operate under. Distinct from `findCursorAtOrBefore`, which uses
   *  an off-by-one accounting (sum of flat[0..c-1] without anchoring on
   *  flat[c]) — keep that one for switchVoice / playback compat, but for
   *  any newer code that pairs tstamps with locateCursor-based mutations,
   *  this is the correct helper. */
  findCursorByTickPosition(voice: Voice, targetTime: number): number {
    const flat = this.flatChildren(voice);
    let best = 0;
    for (let c = 0; c <= flat.length; c++) {
      const ct = this.getTickPositionAt(voice, c);
      if (ct <= targetTime + 1e-6) best = c;
      else break;
    }
    return best;
  }

  /** Returns the "current" element in the flat stream — the element to the
   *  cursor's LEFT under the new convention. Both INSERT and OVERWRITE
   *  modes refer to the same element (flat[cursor]); the difference is
   *  visual rendering only (insert bar past it, overwrite selection on it).
   *  Returns null at past-end (cursor === flat.length, flat[cursor]
   *  doesn't exist). */
  getCurrentElement(voice: Voice, _mode: "insert" | "overwrite"): CurrentRef {
    const flat = this.flatChildren(voice);
    const cursor = this.cursors[voice];
    if (cursor < 0 || cursor >= flat.length) return null;
    const elem = flat[cursor];
    if (!elem) return null;
    const id = elem.getAttribute("xml:id");
    if (!id) return null;
    return { index: cursor, id, elem };
  }

  /** Returns the element at flat-index + 1 (in the same voice's flat stream).
   *  Transparently crosses measure boundaries. */
  getNextElement(voice: Voice, index: number): CurrentRef {
    const flat = this.flatChildren(voice);
    const nextIdx = index + 1;
    if (nextIdx < 0 || nextIdx >= flat.length) return null;
    const elem = flat[nextIdx];
    const id = elem.getAttribute("xml:id");
    if (!id) return null;
    return { index: nextIdx, id, elem };
  }

  /* ── setup setters / getters ──────────────────────────────────────────── */

  getTitle(): string {
    const t = this.doc.querySelector("titleStmt > title");
    return t?.textContent ?? "Untitled";
  }

  setTitle(title: string): void {
    let t = this.doc.querySelector("titleStmt > title");
    if (!t) {
      const titleStmt = this.doc.querySelector("titleStmt");
      if (!titleStmt) return;
      t = el(this.doc, "title");
      titleStmt.insertBefore(t, titleStmt.firstChild);
    }
    t.textContent = title;
  }

  getComposer(): string {
    const p = this.doc.querySelector('titleStmt persName[role="composer"]');
    return p?.textContent ?? "";
  }

  setComposer(name: string): void {
    const titleStmt = this.doc.querySelector("titleStmt");
    if (!titleStmt) return;
    let respStmt = titleStmt.querySelector("respStmt");
    let persName = respStmt?.querySelector('persName[role="composer"]') ?? null;
    if (!name) {
      /* Empty composer: remove the respStmt entirely if it's empty. */
      if (persName) persName.parentNode?.removeChild(persName);
      if (respStmt && respStmt.children.length === 0)
        respStmt.parentNode?.removeChild(respStmt);
      return;
    }
    if (!respStmt) {
      respStmt = el(this.doc, "respStmt");
      titleStmt.appendChild(respStmt);
    }
    if (!persName) {
      persName = el(this.doc, "persName", { role: "composer" });
      respStmt.appendChild(persName);
    }
    persName.textContent = name;
  }

  getKeySig(): string {
    const sd = this.doc.querySelector("scoreDef");
    return sd?.getAttribute("key.sig") ?? "0";
  }

  setKeySig(sig: string): void {
    const sd = this.doc.querySelector("scoreDef");
    if (!sd) return;
    sd.setAttribute("key.sig", sig);
  }

  /** Read the score's required layout (tuning mode + ref note). The block is
   *  seeded by ensureExpressionDefaults so this always returns a valid value. */
  getLayoutReq(): LayoutReq {
    return getLayoutReq(this.doc);
  }

  setLayoutReq(req: LayoutReq): void {
    setLayoutReq(this.doc, req);
  }

  /** True iff the score contains at least one <note> element. Used by the
   *  retune flow to decide whether changing tuning mode needs the warn+migrate
   *  path vs. a silent overwrite. */
  hasNotes(): boolean {
    return this.doc.querySelector('note') !== null;
  }

  getTimeSig(): { count: number; unit: number } {
    const sd = this.doc.querySelector("scoreDef");
    const count = parseInt(sd?.getAttribute("meter.count") ?? "4", 10);
    const unit = parseInt(sd?.getAttribute("meter.unit") ?? "4", 10);
    return { count, unit };
  }

  /** Set the time signature. On any meter change, per-measure truncation
   *  walks each layer and shortens/drops content that doesn't fit the new
   *  measure's tick budget. Measure count is preserved; enlarging is a
   *  no-op except for re-normalizing placeholders to the new duration. */
  setTimeSig(count: number, unit: number): void {
    const sd = this.doc.querySelector("scoreDef");
    if (!sd) return;
    const prevCount = parseInt(sd.getAttribute("meter.count") ?? "4", 10);
    const prevUnit = parseInt(sd.getAttribute("meter.unit") ?? "4", 10);
    sd.setAttribute("meter.count", String(count));
    sd.setAttribute("meter.unit", String(unit));
    if (count !== prevCount || unit !== prevUnit) {
      /* Capture look-forward anchors BEFORE truncation so the cursor can
         re-seat onto the first surviving element afterwards (truncate may
         drop content the cursor pointed at). Auto-autofill is disabled
         (see autofill docblock below); the doc-wide fill sweep that used
         to ride along on a meter change is no longer triggered here. */
      const v = this.currentVoice;
      const flat = this.flatChildren(v);
      const c = this.cursors[v];
      const lookForward: Element[] = c < flat.length ? flat.slice(c) : [];
      this.truncateOverflowingMeasures();
      this.normalizeTies();
      this.reanchorCursorAfter(v, lookForward);
    }
  }

  getTempo(): { bpm: number; unit: string; dots: number; text: string } {
    const t = this.doc.querySelector("tempo");
    const bpm = parseInt(
      t?.getAttribute("mm") ?? t?.getAttribute("midi.bpm") ?? "120",
      10,
    );
    const unit = t?.getAttribute("mm.unit") ?? "4";
    const dots = parseInt(t?.getAttribute("mm.dots") ?? "0", 10);
    const text = (t?.textContent ?? "").replace(/\s+$/, "");
    return { bpm, unit, dots, text };
  }

  setTempo(
    bpm: number,
    mmUnit: "1" | "2" | "4" | "8",
    dots: 0 | 1,
    text = "",
  ): void {
    let t = this.doc.querySelector("tempo");
    if (!t) {
      const firstMeasure = this.doc.querySelector("measure");
      if (!firstMeasure) return;
      t = el(this.doc, "tempo", { tstamp: "1", staff: "1" });
      firstMeasure.insertBefore(t, firstMeasure.firstChild);
    }
    t.setAttribute("mm", String(bpm));
    t.setAttribute("mm.unit", mmUnit);
    t.setAttribute("midi.bpm", String(bpm));
    if (dots > 0) t.setAttribute("mm.dots", String(dots));
    else t.removeAttribute("mm.dots");
    /* Tempo text rendered with a trailing space so the metronome glyph follows.
       Verovio renders text content + auto-formatted "♩ = 120" from mm/mm.unit. */
    t.textContent = text ? text + " " : "";
  }

  /* ── measure-aware structural helpers ─────────────────────────────────── */

  allMeasures(): Element[] {
    return Array.from(this.doc.querySelectorAll("measure"));
  }

  /** Returns the xml:id of the <staff> the given voice maps to, in the
   *  first measure. Cursor overlay uses this for the pathological "no
   *  flat-children at all" fallback. */
  getStaffIdForVoice(voice: Voice): string | null {
    const measure = this.allMeasures()[0];
    if (!measure) return null;
    return this.staffIdInMeasure(measure, voice);
  }

  /** Returns the xml:id of the <staff> the cursor is currently "in" — the
   *  staff for the voice in the measure containing the element at the
   *  cursor (or just before it). When the voice is entirely empty (no
   *  placeholders even — shouldn't happen post-normalize), falls back to
   *  the first measure. */
  getStaffIdAtCursor(voice?: Voice): string | null {
    const v = voice ?? this.currentVoice;
    const c = this.cursors[v];
    const flat = this.flatChildren(v);
    let measure: Element | null = null;
    const target = c < flat.length ? flat[c] : c > 0 ? flat[c - 1] : null;
    if (target) measure = target.closest("measure");
    if (!measure) measure = this.allMeasures()[0] ?? null;
    if (!measure) return null;
    return this.staffIdInMeasure(measure, v);
  }

  private staffIdInMeasure(measure: Element, voice: Voice): string | null {
    const staffN = voice <= 2 ? 1 : 2;
    const staff = Array.from(measure.querySelectorAll("staff")).find(
      (s) => s.getAttribute("n") === String(staffN),
    );
    return staff?.getAttribute("xml:id") ?? null;
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
    const staff = Array.from(measure.querySelectorAll("staff")).find(
      (s) => s.getAttribute("n") === String(staffN),
    );
    if (!staff) return null;
    const layer = Array.from(staff.querySelectorAll("layer")).find(
      (l) => l.getAttribute("n") === String(layerN),
    );
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

  /** Flat navigable children across all measures for voice. Per measure
   *  contributes (mirroring the tuplet model): the <measure> element as a
   *  wrapper stop (sometimes — see collapse rule below), the layer's content
   *  stops (tuplets inlined with their internal stops), and — when the layer
   *  is in the *partial* state (has some real content AND some trailing
   *  placeholder space) — the FIRST `<space data-placeholder>` of the layer
   *  as a single fill-anchor stop. Fully-empty layers collapse to just the
   *  wrapper. Full layers omit the fill-anchor. A synthetic past-end stop
   *  "wrapper of the not-yet-existent next measure" is implicit via
   *  `getVoiceLength = flat.length + 1`.
   *
   *  **Wrapper collapse rule** (mirrors how tuplet wrappers are also their
   *  own layer-level stops): the wrapper for M_k is omitted when M_{k-1}'s
   *  layer is full AND M_k has at least one real-content child. In that
   *  case, "after last content of M_{k-1}" and "wrapper of M_k" are at the
   *  same time AND have identical insertion semantics (insertion goes into
   *  M_k at front either way), so a single combined stop suffices. The
   *  wrapper is always emitted for M_1, for empty layers (the stop becomes
   *  the empty-measure delete target), and when M_{k-1} is partial (the
   *  fill-anchor + wrapper distinction carries the extend-vs-enter intent
   *  that issue 2 from the prior iteration introduced). */
  flatChildren(voice: Voice): Element[] {
    const out: Element[] = [];
    const measures = this.allMeasures();
    for (let mi = 0; mi < measures.length; mi++) {
      const measure = measures[mi];
      const layer = this.layerInMeasure(measure, voice);
      if (!layer) continue;
      if (this.shouldEmitWrapper(measures, voice, mi)) out.push(measure);
      out.push(...this.layerStops(layer));
      /* No fill-anchor stops emitted anymore. The user's simpler stop
         rules: content stops (rule 1) cover non-empty measures; the
         wrapper-of-empty (rule 2) covers empty measures. Cursor at past-
         last-content of partial M_X is just the cursor's natural position;
         insertion at that cursor goes "wherever the cursor is" — i.e.,
         at end of M_X's content, which extends M_X (if partial) or
         cascades to M_{X+1} via bounded overflow (if M_X is full). */
    }
    return out;
  }

  /** Whether layer's content sums to a full measure (no trailing placeholder
   *  space). */
  private layerIsFull(layer: Element): boolean {
    let total = 0;
    for (const c of this.contentChildren(layer)) total += realTicks(c);
    return total >= this.measureTicks();
  }

  /** Wrapper emission decision per measure. Per the user's clean rules:
   *    - Rule 2: empty measure → emit (the wrapper IS the empty measure's
   *      one stop, and the delete target).
   *    - Rule 3: non-empty M_X gets a wrapper iff M_{X-1} is incomplete
   *      (partial or empty) OR nonexistent (M_X is M_0). When M_{X-1} is
   *      FULL, the wrapper is NOT emitted — cursor jumps directly from
   *      "right of last element of M_{X-1}" to "right of first element of
   *      M_X". This is the intentional navigational-smoothness tradeoff:
   *      no dedicated boundary stop between two complete measures. */
  private shouldEmitWrapper(
    measures: Element[],
    voice: Voice,
    measureIdx: number,
  ): boolean {
    const thisLayer = this.layerInMeasure(measures[measureIdx], voice);
    if (!thisLayer) return false;
    if (this.contentChildren(thisLayer).length === 0) return true; /* rule 2 */
    if (measureIdx === 0) return true; /* rule 3, nonexistent prev */
    const prevLayer = this.layerInMeasure(measures[measureIdx - 1], voice);
    if (!prevLayer) return true; /* defensive */
    if (this.contentChildren(prevLayer).length === 0) return true; /* prev empty → incomplete → emit */
    if (this.layerIsFull(prevLayer)) return false; /* prev full → no wrapper */
    return true; /* prev partial → emit */
  }

  /** Cursor stops contributed by a layer: real content elements + tuplet
   *  internal stops. Placeholders are NOT emitted here — the fill-anchor
   *  (a single stop) is handled at the measure level by `flatChildren`. */
  private layerStops(layer: Element): Element[] {
    const out: Element[] = [];
    for (const c of Array.from(layer.children)) {
      const ln = c.localName;
      if (ln === 'tuplet') {
        out.push(c);
        out.push(...this.tupletNavStops(c));
      } else if (ln === 'chord' || ln === 'note' || ln === 'rest') {
        out.push(c);
      }
    }
    return out;
  }

  /** Translate a linear cursor into an insertion point — (measureIdx, layer,
   *  withinIdx, inTuplet) — by anchoring on `flat[linearCursor]` (the
   *  element to the cursor's LEFT under the post-refactor cursor index
   *  convention; cursor `c` means "past flat[c]").
   *
   *  Anchor resolution:
   *    - `<measure>` wrapper of M_Y → `(measureIdx=Y, withinIdx=0)`.
   *      Insertion at start of M_Y's content.
   *    - In-tuplet content of tuplet T (child position `j`) inside M_Y →
   *      `(measureIdx=Y, withinIdx=cc.indexOf(T), inTuplet={tuplet:T,
   *      tupletChildIdx:j+1})`. Insertion AFTER the anchor child in T.
   *    - Top-level content element at cc-position `i` of M_Y →
   *      `(measureIdx=Y, withinIdx=i+1)`. Insertion AFTER the anchor.
   *
   *  Past-end (cursor === flat.length): returns the synthetic "next-measure
   *  wrapper" location — `measureIdx = allMeasures.length`, `layer` is a
   *  fresh empty `<layer>` element. The applier in `insertWithSplit`
   *  lazily creates the measure via `appendMeasure` when an action's
   *  `targetMIdx` is beyond the existing measure count. */
  private locateCursor(
    voice: Voice,
    linearCursor: number,
  ): {
    measureIdx: number;
    layer: Element;
    withinIdx: number;
    inTuplet: { tuplet: Element; tupletChildIdx: number } | null;
  } | null {
    const measures = this.allMeasures();
    if (measures.length === 0) return null;
    const flat = this.flatChildren(voice);
    if (linearCursor >= flat.length) {
      /* Past-end synthetic. */
      return {
        measureIdx: measures.length,
        layer: this.doc.createElementNS(MEI_NS, 'layer'),
        withinIdx: 0,
        inTuplet: null,
      };
    }
    const anchor = flat[linearCursor];
    return this.locationForAnchor(anchor, voice, measures);
  }

  /** Compute (measureIdx, layer, withinIdx, inTuplet) for a given anchor
   *  element (= flat[c] for cursor c). Insertion target is "immediately
   *  after the anchor" within its containing structure. */
  private locationForAnchor(
    anchor: Element,
    voice: Voice,
    measures: Element[],
  ): {
    measureIdx: number;
    layer: Element;
    withinIdx: number;
    inTuplet: { tuplet: Element; tupletChildIdx: number } | null;
  } | null {
    /* Anchor is `<measure>` wrapper. */
    if (anchor.localName === 'measure') {
      const measureIdx = measures.indexOf(anchor);
      const layer = this.layerInMeasure(anchor, voice);
      if (!layer || measureIdx < 0) return null;
      return { measureIdx, layer, withinIdx: 0, inTuplet: null };
    }
    /* Anchor is inside a tuplet (in-tuplet content). */
    const tParent = anchor.parentElement;
    if (tParent && tParent.localName === 'tuplet') {
      const measure = tParent.closest('measure') as Element | null;
      if (!measure) return null;
      const measureIdx = measures.indexOf(measure);
      const layer = this.layerInMeasure(measure, voice);
      if (!layer || measureIdx < 0) return null;
      const cc = this.contentChildren(layer);
      /* Exit-tuplet stop: anchor is the LAST in-tuplet nav stop (fill anchor
         for partial tuplets, last filled child for complete tuplets). The
         cursor's visual "exit-tuplet" position semantically means "past the
         tuplet" — insertion here goes at LAYER level past the tuplet, not
         inside it. Without this branch, typing at the post-tuplet stop
         routes into the in-tuplet path and gets rejected when the new
         element exceeds the trailing-placeholder budget, even when there's
         room in the measure past the tuplet. */
      const navStops = this.tupletNavStops(tParent);
      if (navStops.length > 0 && navStops[navStops.length - 1] === anchor) {
        const tIdxInCc = cc.indexOf(tParent);
        return {
          measureIdx,
          layer,
          withinIdx: tIdxInCc >= 0 ? tIdxInCc + 1 : cc.length,
          inTuplet: null,
        };
      }
      const withinIdx = cc.indexOf(tParent);
      const tChildren = Array.from(tParent.children);
      const tIdx = tChildren.indexOf(anchor);
      return {
        measureIdx,
        layer,
        withinIdx,
        inTuplet: { tuplet: tParent, tupletChildIdx: tIdx + 1 },
      };
    }
    /* Anchor is a layer-level <tuplet> wrapper — the "entered tuplet"
       cursor stop. Visually the cursor renders just inside the bracket
       (cursor.ts's insert-enter-tuplet branch); insertion here goes to
       the tuplet's first slot. Return inTuplet with tupletChildIdx = 0
       so insertWithSplit's in-tuplet branch fires. */
    if (anchor.localName === 'tuplet') {
      const measure = anchor.closest('measure') as Element | null;
      if (!measure) return null;
      const measureIdx = measures.indexOf(measure);
      const layer = this.layerInMeasure(measure, voice);
      if (!layer || measureIdx < 0) return null;
      const cc = this.contentChildren(layer);
      const withinIdx = cc.indexOf(anchor);
      return {
        measureIdx,
        layer,
        withinIdx: withinIdx >= 0 ? withinIdx : cc.length,
        inTuplet: { tuplet: anchor, tupletChildIdx: 0 },
      };
    }
    /* Top-level content of some layer (chord/note/rest). */
    const measure = anchor.closest('measure') as Element | null;
    if (!measure) return null;
    const measureIdx = measures.indexOf(measure);
    const layer = this.layerInMeasure(measure, voice);
    if (!layer || measureIdx < 0) return null;
    const cc = this.contentChildren(layer);
    const idx = cc.indexOf(anchor);
    /* Anchor is a content element of the layer; insertion goes immediately
       after it (withinIdx = idx + 1). If indexOf returns -1 (defensive),
       fall back to appending at end of cc. */
    return {
      measureIdx,
      layer,
      withinIdx: idx >= 0 ? idx + 1 : cc.length,
      inTuplet: null,
    };
  }

  /** Total nav-stops contributed by one (voice, layer) when `emitWrapper`
   *  indicates whether the leading `<measure>` wrapper stop is included.
   *  Matches `flatChildren`'s emission rules. */
  private measureStopCount(
    _measures: Element[],
    _voice: Voice,
    _measureIdx: number,
    layer: Element,
    emitWrapper: boolean,
  ): number {
    let n = emitWrapper ? 1 : 0;
    n += this.layerStops(layer).length;
    return n;
  }

  /** Resolve a stop-within-measure index to a cursor location. When the
   *  wrapper is emitted (`emitWrapper=true`), idx 0 is the wrapper, idx
  /** Locate the navigable element at flat-index `flatIdx`. Same resolution
   *  rules as `locateCursor` for non-past-end indices; returns null when
   *  `flatIdx` is out of range (no synthetic past-end fallback here — the
   *  callers that use this for deletion targets only care about real
   *  elements). */
  private locateFlatElement(
    voice: Voice,
    flatIdx: number,
  ): {
    measureIdx: number;
    layer: Element;
    withinIdx: number;
    inTuplet: { tuplet: Element; tupletChildIdx: number } | null;
  } | null {
    if (flatIdx < 0) return null;
    const measures = this.allMeasures();
    const flat = this.flatChildren(voice);
    if (flatIdx >= flat.length) return null;
    return this.locationForAnchor(flat[flatIdx], voice, measures);
  }

  /** Cumulative ticks for `voice` BEFORE its `withinIdx`-th content child
   *  in measure `measureIdx`. */
  private timeWithinMeasure(
    voice: Voice,
    measureIdx: number,
    withinIdx: number,
  ): number {
    const layers = this.allLayers(voice);
    if (measureIdx >= layers.length) return 0;
    const kids = this.contentChildren(layers[measureIdx]);
    let t = 0;
    for (let i = 0; i < Math.min(withinIdx, kids.length); i++)
      t += elementDurationTicks(kids[i]);
    return t;
  }

  /** Filter to actual musical content at the LAYER level: chord/note/rest
   *  PLUS <tuplet> (which is atomic from the layer's POV). Used for layout /
   *  tick math and for the within-layer index returned by locateCursor.
   *  Tuplet contents are NOT included here — they're addressed via the
   *  inTuplet field on the cursor location instead. */
  private contentChildren(layer: Element): Element[] {
    return Array.from(layer.children).filter(
      (c) =>
        c.localName === "chord" ||
        c.localName === "note" ||
        c.localName === "rest" ||
        c.localName === "tuplet",
    );
  }

  /** Compute the in-tuplet nav-stops contributed by a single tuplet:
   *  - Every filled content child (chord/note/rest) is a stop.
   *  - The first trailing placeholder (fill anchor) is a stop iff any
   *    trailing placeholders exist (regardless of post-tuplet content; the
   *    user must be able to append to a partial tuplet even when there's
   *    content after it).
   *  Does NOT include the tuplet wrapper itself — that's added separately
   *  in `navigableChildren` as a layer-level stop. */
  private tupletNavStops(tuplet: Element): Element[] {
    const kids = Array.from(tuplet.children);
    const filled: Element[] = [];
    let firstTrailing: Element | null = null;
    for (const c of kids) {
      if (isTupletPlaceholder(c)) {
        if (firstTrailing === null) firstTrailing = c;
      } else if (
        c.localName === "note" ||
        c.localName === "chord" ||
        c.localName === "rest"
      ) {
        filled.push(c);
      }
    }
    if (firstTrailing) return [...filled, firstTrailing];
    return filled;
  }

  /** @deprecated retained for any external probe; the live model walks via
   *  `flatChildren` + `layerStops` now. */
  private navigableChildren(_layer: Element): Element[] {
    return this.layerStops(_layer);
  }

  /** Strip and re-add <space data-placeholder> children on every layer so
   *  the document always satisfies the invariant: a layer either has at
   *  least one real-content child (no measure-level placeholders) or it
   *  has only placeholder spaces summing to the measure's full duration.
   *  Idempotent. Called from every mutation entry point. Tuplets count as
   *  real content (they're top-level layer children). Tuplet-internal
   *  placeholders (data-tuplet-placeholder) are never touched here — those
   *  live inside <tuplet> elements and are managed by tuplet-specific code. */
  private normalizePlaceholders(): void {
    const layers = this.doc.querySelectorAll("layer");
    const cap = this.measureTicks();
    for (const layer of Array.from(layers)) {
      /* Strip existing layer-level placeholders. */
      for (const c of Array.from(layer.children)) {
        if (isPlaceholder(c)) layer.removeChild(c);
      }
      /* Sum real-content ticks; append trailing placeholders to fill the
         remainder. A fully-empty layer gets placeholders summing to the
         whole measure; a partial layer gets placeholders summing to the
         residual space (which serves as the fill-anchor's home in the
         new nav-stop model); a full layer gets none. */
      let used = 0;
      for (const c of Array.from(layer.children)) {
        if (
          c.localName === "chord" ||
          c.localName === "note" ||
          c.localName === "rest" ||
          c.localName === "tuplet"
        ) {
          used += realTicks(c);
        }
      }
      const remaining = cap - used;
      if (remaining <= 0) continue;
      for (const p of decomposeTicks(remaining)) {
        const space = el(this.doc, "space", {
          "xml:id": newId("sp"),
          dur: p.dur,
          dots: p.dots > 0 ? p.dots : undefined,
        });
        space.setAttribute(PLACEHOLDER_ATTR, "true");
        layer.appendChild(space);
      }
    }
  }

  /** Append a new empty measure with all four layers. Sets barlines. Public
   *  so paste-overflow paths and selection-mode shift-right (future) can
   *  extend the score. */
  appendMeasure(): Element {
    const section = this.doc.querySelector("section");
    if (!section) throw new Error("section element missing");
    const measures = this.allMeasures();
    const n = measures.length + 1;
    const m = el(this.doc, "measure", { n, "xml:id": newId("m") });
    const s1 = el(this.doc, "staff", { n: 1, "xml:id": newId("s") });
    s1.appendChild(el(this.doc, "layer", { n: 1, "xml:id": newId("l") }));
    s1.appendChild(el(this.doc, "layer", { n: 2, "xml:id": newId("l") }));
    const s2 = el(this.doc, "staff", { n: 2, "xml:id": newId("s") });
    s2.appendChild(el(this.doc, "layer", { n: 1, "xml:id": newId("l") }));
    s2.appendChild(el(this.doc, "layer", { n: 2, "xml:id": newId("l") }));
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
      if (i < measures.length - 1) measures[i].removeAttribute("right");
      else measures[i].setAttribute("right", "end");
    }
  }

  /* ── navigation ─────────────────────────────────────────────────────────── */

  switchVoice(dir: "up" | "down"): Voice {
    const cur = this.currentVoice;
    let next: Voice;
    if (dir === "up") next = (cur > 1 ? cur - 1 : 1) as Voice;
    else next = (cur < 4 ? cur + 1 : 4) as Voice;
    if (next === cur) return next;
    const currentTime = this.getTimeAt(cur, this.cursors[cur]);
    this.currentVoice = next;
    this.cursors[next] = this.findCursorAtOrBefore(next, currentTime);
    /* Cursor-leave autofill disabled — see autofill docblock. */
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
    const oldV = this.currentVoice;
    this.currentVoice = v;
    if (this.cursors[v] > this.getVoiceLength(v)) this.cursors[v] = this.getVoiceLength(v);
    void oldV; /* cursor-leave autofill disabled — see autofill docblock */
  }

  moveCursor(dir: "left" | "right"): number {
    const v = this.currentVoice;
    const len = this.getVoiceLength(v);
    let c = this.cursors[v];
    if (dir === "left" && c > 0) c--;
    else if (dir === "right" && c < len) c++;
    this.cursors[v] = c;
    /* Cursor-leave autofill disabled — see autofill docblock. */
    return this.cursors[v];
  }

  setCursor(c: number, voice?: Voice): void {
    const v = voice ?? this.currentVoice;
    const len = this.getVoiceLength(v);
    this.cursors[v] = Math.max(0, Math.min(len, c));
    /* Cursor-leave autofill disabled — see autofill docblock. */
  }

  cursorToEnd(voice?: Voice): void {
    const v = voice ?? this.currentVoice;
    this.cursors[v] = this.getVoiceLength(v);
    /* Cursor-leave autofill disabled — see autofill docblock. */
  }

  /* ── autofill (disabled — currently unwired from automatic triggers) ───
   *
   * Automatic autofill — where leaving a partial measure with later-content
   * siblings would silently materialize beat-aligned rests in its trailing
   * placeholder space, and a meter change would run the same sweep
   * doc-wide — is intentionally NOT triggered anywhere in the model.
   * Forced fill-on-leave caused more surprise edits than it prevented;
   * the user can still re-anchor cursor position via `reanchorCursorAfter`
   * after a structural mutation (see `setTimeSig` for the only remaining
   * call site).
   *
   * The primitives below (`autofillMeasure`, `autofillAllAbandoned`,
   * `autofillAllAndReanchor`, `autofillOnLeave`) and the
   * `restfill.ts` helpers are retained because they're expected to be
   * wired up later as an EXPLICIT document-level sweep command (a "fill
   * all partial measures with rests now" action). Until then, they are
   * dead code — `autofillAllAndReanchor` is the most likely public entry
   * point for the future command.
   *
   * To re-enable per-cursor-motion autofill, restore the `autofillOnLeave`
   * calls in `switchVoice` / `setVoice` / `moveCursor` / `setCursor` /
   * `cursorToEnd` (each was capturing `prevMIdx` and dispatching on a
   * measure change); restore the `autofillAllAndReanchor` call in
   * `setTimeSig` in place of the inline reanchor. */

  /** Sweep called when the cursor leaves a (voice, measure). When the layer
   *  has real content but isn't full, AND this voice has content in some
   *  strictly-later measure, replace its trailing placeholder space with
   *  visible beat-aligned rests. The rests are plain `<rest>` elements with
   *  no special marker — once placed, they behave like manually-entered
   *  rests (extending the measure requires deleting them first). */
  private autofillMeasure(voice: Voice, measureIdx: number): void {
    const layers = this.allLayers(voice);
    if (measureIdx < 0 || measureIdx >= layers.length) return;
    const layer = layers[measureIdx];
    const cc = this.contentChildren(layer);
    if (cc.length === 0) return;
    let hasLaterContent = false;
    for (let m = measureIdx + 1; m < layers.length; m++) {
      if (this.contentChildren(layers[m]).length > 0) {
        hasLaterContent = true;
        break;
      }
    }
    if (!hasLaterContent) return;
    let total = 0;
    for (const c of cc) total += realTicks(c);
    const cap = this.measureTicks();
    if (total >= cap) return;
    for (const c of Array.from(layer.children)) {
      if (isPlaceholder(c)) layer.removeChild(c);
    }
    const ts = readTimeSig(this.doc);
    for (const r of decomposeBeatAlignedRests(total, cap - total, ts)) {
      layer.appendChild(this.buildRestElement({ duration: r.dur, dots: r.dots }));
    }
  }

  /** Scan every measure of `voice` (except the cursor's current measure)
   *  and run `autofillMeasure` on each. Per the autofill rules, this is a
   *  no-op for measures that don't qualify (fully-empty, full, or no
   *  later-content sibling). Cheap O(measures) walk. */
  private autofillAllAbandoned(voice: Voice): void {
    const cursorMIdx = this.cursorMeasureIdx(voice);
    const layers = this.allLayers(voice);
    for (let m = 0; m < layers.length; m++) {
      if (m === cursorMIdx) continue;
      this.autofillMeasure(voice, m);
    }
  }

  /** Run the doc-wide autofill sweep and re-anchor the cursor. The sweep
   *  can vanish elements (placeholders consumed; wrappers collapsing when
   *  shouldEmitWrapper flips), so we capture an ordered list of "look-forward
   *  anchors" — the elements at or past the cursor in the OLD flat — and
   *  snap to the first one that still exists in the NEW flat. This preserves
   *  the cursor's semantic position (= "the cursor is about to enter / move
   *  past element X") across structural shifts.
   *
   *  Time-based reanchoring was rejected because wrappers have zero realTicks,
   *  so multiple consecutive cursor positions can share the same time;
   *  `findCursorAtOrBefore` then picks the rightmost, advancing the cursor
   *  on a no-op autofill (e.g. `setCursor(0)` in an empty doc snapping to
   *  cursor=1 past the wrapper). The look-forward anchor list keeps the
   *  cursor stable on a no-op sweep and advances it only when the look-forward
   *  elements actually vanish. */
  private autofillAllAndReanchor(voice: Voice): void {
    const flat = this.flatChildren(voice);
    const c = this.cursors[voice];
    const lookForward: Element[] = c < flat.length ? flat.slice(c) : [];
    this.autofillAllAbandoned(voice);
    this.reanchorCursorAfter(voice, lookForward);
  }

  /** Snap the cursor to the first survivor in `lookForward` (an ordered
   *  list of elements captured from the OLD flat before a structural
   *  change). If no survivor exists, snap to past-end. Used by both
   *  mutation paths (post-mutation cursor preservation, no autofill) and
   *  by the autofill helpers (combined autofill + reanchor). */
  private reanchorCursorAfter(voice: Voice, lookForward: Element[]): void {
    const newFlat = this.flatChildren(voice);
    for (const el of lookForward) {
      const idx = newFlat.indexOf(el);
      if (idx >= 0) {
        this.cursors[voice] = idx;
        return;
      }
    }
    this.cursors[voice] = this.getVoiceLength(voice);
  }

  /** Cursor-leave-measure helper. Autofill exactly ONE abandoned measure
   *  for `voice` (the one the cursor just left), then reanchor. Used by
   *  cursor-motion paths (moveCursor / setCursor / cursorToEnd) and voice
   *  switches (switchVoice / setVoice). prevMeasureIdx < 0 → reanchor
   *  only; no autofill target. */
  private autofillOnLeave(voice: Voice, prevMeasureIdx: number): void {
    const flat = this.flatChildren(voice);
    const c = this.cursors[voice];
    const lookForward: Element[] = c < flat.length ? flat.slice(c) : [];
    if (prevMeasureIdx >= 0) this.autofillMeasure(voice, prevMeasureIdx);
    this.reanchorCursorAfter(voice, lookForward);
  }

  /** Translate the current voice's cursor position into an MEI (measureIdx,
   *  tstamp) Moment. Used by voice-mode expression entry — the entered
   *  dynam/hairpin lands at the time of the cursor's anchor element.
   *
   *  Anchor convention: the cursor's "moment" is the onset time of the
   *  element AT the cursor (i.e., the element that would be replaced in
   *  overwrite mode, or the element you'd skip past with Right-arrow in
   *  insert mode). When the cursor is past the last element, returns the
   *  last measure's end-of-content moment. */
  momentForCursor(voice: Voice, cursor: number): Moment | null {
    const layers = this.allLayers(voice);
    if (layers.length === 0) return null;
    const loc = this.locateCursor(voice, cursor);
    if (!loc) return null;
    const ticksInMeasure = this.timeWithinMeasure(
      voice,
      loc.measureIdx,
      loc.withinIdx,
    );
    const { unit } = this.getTimeSig();
    const ticksPerBeat = 64 / unit;
    return {
      measureIdx: loc.measureIdx,
      tstamp: 1 + ticksInMeasure / ticksPerBeat,
    };
  }

  /* ── tuplet helpers (public) ───────────────────────────────────────────── */

  /** True when the current voice's cursor sits inside a <tuplet> per the
   *  "between" rule (insert-mode interpretation): cursor on a tuplet
   *  placeholder OR between two children of the same tuplet. The layer-edge
   *  position (visually anchored to pre-tuplet content) is NOT inside. */
  isCursorInTuplet(voice?: Voice): boolean {
    const v = voice ?? this.currentVoice;
    const loc = this.locateCursor(v, this.cursors[v]);
    return !!(loc && loc.inTuplet);
  }

  /** Remaining written-ticks of trailing placeholders in the tuplet at the
   *  cursor. Null when the cursor is not in a tuplet (per `isCursorInTuplet`).
   *  Used by `canInsertHere` and by status-line displays. */
  cursorTupletRemainingWrittenTicks(voice?: Voice): number | null {
    const v = voice ?? this.currentVoice;
    const loc = this.locateCursor(v, this.cursors[v]);
    if (!loc || !loc.inTuplet) return null;
    let total = 0;
    for (const c of Array.from(loc.inTuplet.tuplet.children)) {
      if (isTupletPlaceholder(c)) total += writtenTicks(c);
    }
    return total;
  }

  /** Pre-flight check for `insertChordAtCursor` / `insertRestAtCursor` that
   *  surfaces a specific rejection reason when the duration cannot fit:
   *    - "Doesn't fit in remaining tuplet space." — cursor inside a tuplet
   *      and duration exceeds trailing-placeholder budget.
   *    - "Insertion would push tuplet across bar line." — cursor at layer
   *      level, but a tuplet at/after the cursor would be displaced past
   *      the bar by the new note.
   *  Otherwise returns `{ ok: true }`. Callers should consult this first;
   *  the insert methods themselves still defensively reject on overflow. */
  canInsertHere(
    duration: Duration,
    dots: Dots = 0,
  ): { ok: true } | { ok: false; reason: string } {
    const v = this.currentVoice;
    const cursor = this.cursors[v];
    let loc = this.locateCursor(v, cursor);
    if (!loc) return { ok: false, reason: "No layer at cursor." };
    const totalTicks = ticksOf(duration, dots);

    if (loc.inTuplet) {
      let remaining = 0;
      for (const c of Array.from(loc.inTuplet.tuplet.children)) {
        if (isTupletPlaceholder(c)) remaining += writtenTicks(c);
      }
      if (totalTicks > remaining) {
        return { ok: false, reason: "Doesn't fit in remaining tuplet space." };
      }
      return { ok: true };
    }

    const plan = this.planInsert(
      { measureIdx: loc.measureIdx, layer: loc.layer, withinIdx: loc.withinIdx },
      totalTicks,
    );
    if (!plan.ok) return { ok: false, reason: plan.reason };
    return { ok: true };
  }

  /* ── mutations ──────────────────────────────────────────────────────────── */

  /** Create a new <tuplet> at the cursor and step the cursor onto its first
   *  placeholder (the fill anchor). Builds `num` placeholder slots of
   *  `atomicDur`. Rejects if the tuplet's real-time span doesn't fit in the
   *  remaining ticks of the current measure, or if the cursor is already
   *  inside a tuplet (no nesting in v1). Returns the tuplet's xml:id on
   *  success, null on rejection. */
  createTupletAtCursor(opts: {
    num: number;
    numbase: number;
    spanDur: Duration;
    spanDots: Dots;
    atomicDur: Duration;
  }): { ok: true; id: string } | { ok: false; reason: string } {
    const { num, numbase, spanDur, spanDots, atomicDur } = opts;
    const v = this.currentVoice;
    const cursor = this.cursors[v];
    const loc = this.locateCursor(v, cursor);
    if (!loc) return { ok: false, reason: "no layer at cursor" };
    if (loc.inTuplet) return { ok: false, reason: "cannot nest tuplets" };

    const spanTicks = ticksOf(spanDur, spanDots);
    const usedBefore = this.timeWithinMeasure(v, loc.measureIdx, loc.withinIdx);
    const remaining = this.measureTicks() - usedBefore;
    if (spanTicks > remaining) {
      return {
        ok: false,
        reason: "Tuplet span exceeds remaining measure space",
      };
    }

    /* Sanity check: num atomic written-ticks scaled by numbase/num must
       equal spanTicks. (Constructs a tuplet whose internal math is sound.) */
    const atomicWritten = ticksOf(atomicDur, 0);
    const computedSpan = (num * atomicWritten * numbase) / num;
    if (Math.abs(computedSpan - spanTicks) > 1e-6) {
      return { ok: false, reason: "tuplet ratio/atomic mismatch with span" };
    }

    const tuplet = el(this.doc, "tuplet", {
      "xml:id": newId("t"),
      num: String(num),
      numbase: String(numbase),
      "bracket.visible": "true",
      "num.visible": "true",
      "num.format": "count",
    });
    /* Record the atomic so that `regenTupletPlaceholders` can preserve
       the atomic structure across fill/delete (perfectly reversible). */
    tuplet.setAttribute("data-tuplet-atomic-dur", atomicDur);
    for (let i = 0; i < num; i++) {
      tuplet.appendChild(this.buildTupletPlaceholder(atomicDur, 0));
    }

    this.insertAt(loc.layer, tuplet, loc.withinIdx);
    this.normalizePlaceholders();
    /* Advance cursor by +1 to land on the "entered tuplet" stop (= past
       the tuplet wrapper). Under the new cursor convention this position
       is the cursor's first-slot entry: cursor.ts's insert-enter-tuplet
       branch renders it at the bracket's left interior; locateCursor's
       tuplet-wrapper branch returns inTuplet with tupletChildIdx=0 so
       insertWithSplit lands the first typed note at slot 0 of the tuplet. */
    this.cursors[v] = Math.min(this.cursors[v] + 1, this.getVoiceLength(v));
    return { ok: true, id: tuplet.getAttribute("xml:id") ?? "" };
  }

  /** Insert a chord at the current voice's cursor; advances cursor. May
   *  split across measure boundaries with ties. Returns the first new
   *  element's xml:id, or null when an in-tuplet insert was rejected for
   *  overflow. */
  insertChordAtCursor(input: ChordInput): string | null {
    const v = this.currentVoice;
    const originalCursor = this.cursors[v];
    const id = this.insertWithSplit(input, false);
    if (id === null) return null;
    this.resolvePendingTies(originalCursor);
    this.normalizePlaceholders();
    this.cursors[v] = Math.min(this.cursors[v], this.getVoiceLength(v));
    return id;
  }

  /** Insert a rest at the current voice's cursor; advances cursor. May
   *  split across measure boundaries (no ties on rests). Inserting a rest
   *  does NOT resolve a pending tie (a rest has no matching pitch). */
  insertRestAtCursor(input: RestInput): string | null {
    const v = this.currentVoice;
    const id = this.insertWithSplit(
      { ...input, notes: [] as ReadonlyArray<ResolvedNote> },
      true,
    );
    if (id === null) return null;
    this.normalizeTies();
    this.normalizePlaceholders();
    this.cursors[v] = Math.min(this.cursors[v], this.getVoiceLength(v));
    return id;
  }

  /** Rebuild all tie metadata across the document from scratch.
   *
   *  Tie state has two parts:
   *    INTENT  — per-note, persisted across mutations:
   *      `wantsForward`: this note wants to be tied to the next same-pitch
   *      note in its voice's flat order. Encoded as @tie ∈ {i,m} OR
   *      @data-pending-tie="true".
   *    REALIZATION — derived from intent + current flat order:
   *      @tie  — MEI 5 value (i|m|t) on each tied note.
   *      @data-tie-partner — forward xml:id reference (each tied note points
   *        to the next member of its chain). The terminal has none.
   *      @data-pending-tie — set only when intent exists but no partner.
   *      <lv> — visual hanging arc for pending stubs.
   *
   *  This function strips all realization, reads the intent from each
   *  note, and rebuilds the realization in a single forward walk per
   *  voice. Idempotent: re-running yields identical state.
   *
   *  Replaces the old `orphanTiePartners` (pre-deletion partner cleanup)
   *  and `resolvePendingTies` (post-insert stub resolution) — both were
   *  partial and asymmetric. Callers run this once AFTER any structural
   *  mutation; correctness no longer depends on cleanup-before-deletion.
   */
  private normalizeTies(): void {
    /* Strip every <lv> — we'll re-create them for surviving stubs. The
     * only <lv> producer in the codebase is our stub machinery. */
    for (const lv of Array.from(this.doc.querySelectorAll("lv"))) {
      lv.parentNode?.removeChild(lv);
    }

    /* Pass 1: snapshot per-note `wantsForward` intent and strip realized
     * tie attributes from every note. Doing this globally (across all
     * voices) keeps the per-voice forward walk simple. */
    const wantsForward = new WeakMap<Element, boolean>();
    for (const note of Array.from(this.doc.querySelectorAll("note"))) {
      const tie = note.getAttribute("tie");
      const pending = note.hasAttribute("data-pending-tie");
      wantsForward.set(note, tie === "i" || tie === "m" || pending);
      note.removeAttribute("tie");
      note.removeAttribute("data-pending-tie");
      note.removeAttribute("data-tie-partner");
    }

    /* Pass 2: per voice, walk flat order and rebuild realization. */
    const pitchKey = (n: Element): string =>
      n.getAttribute("pname") + "/" + n.getAttribute("oct") + "/" + getNoteAlter(n);

    for (let vi: Voice = 1; vi <= 4; vi = (vi + 1) as Voice) {
      const flat = this.flatChildren(vi);
      /* For each cursor between two flat slots, prevOffers[pitchKey] is the
       * note in the previous slot that wantsForward at that pitch — i.e.,
       * the "incoming-tie source" for any matching note in the current
       * slot. Reset on every slot transition. */
      let prevOffers = new Map<string, Element>();
      for (let k = 0; k < flat.length; k++) {
        const notes = this.extractNoteElements(flat[k]);
        const nextNotes = k + 1 < flat.length
          ? this.extractNoteElements(flat[k + 1])
          : [];
        const currOffers = new Map<string, Element>();

        for (const note of notes) {
          const pk = pitchKey(note);
          const wasFromPrev = prevOffers.has(pk);
          const wants = wantsForward.get(note) ?? false;
          const partner = wants ? nextNotes.find((n) => pitchKey(n) === pk) : null;
          const canForward = !!partner;

          if (canForward && partner) {
            /* Realized: this note ties forward (and possibly backward). */
            setTieFlag(note, wasFromPrev ? "m" : "i");
            const pid = partner.getAttribute("xml:id");
            if (pid) note.setAttribute("data-tie-partner", pid);
            currOffers.set(pk, note);
          } else {
            /* No realizable forward tie. Two independent axes:
             *   - If we had incoming (wasFromPrev): set @tie="t" so the
             *     incoming arc still renders (terminal of the prev chain).
             *   - If the user expressed forward intent (wants) that we
             *     couldn't realize: preserve it as a pending stub. The
             *     two can coexist on the SAME note: @tie="t" renders the
             *     incoming arc, and <lv> + data-pending-tie render the
             *     outgoing hanging stub. This lets the user "extend"
             *     a tied-to note forward by toggling tie on it; the
             *     extension auto-resolves later when a same-pitch note
             *     follows. */
            if (wasFromPrev) setTieFlag(note, "t");
            if (wants) setStubTie(note);
          }
        }

        prevOffers = currOffers;
      }
    }
  }

  /** Backwards-compatible alias used by call sites that still expect a
   *  pre-deletion / post-mutation cleanup hook. With the unified
   *  `normalizeTies`, both are the same operation: run AFTER the
   *  structural mutation completes. Callers that previously ran
   *  `orphanTiePartners(elem)` BEFORE removing `elem` now just remove
   *  the element and call `normalizeTies()` — the normalization picks up
   *  the survivors correctly because intent lives on the surviving notes,
   *  not in cross-references pointing AT the deleted note. */
  private orphanTiePartners(_elem: Element): void {
    /* No-op — see normalizeTies. Kept as a stub so the many call sites
     * don't all need to be rewritten in this commit; they all also call
     * normalizePlaceholders / setBarlines afterward, and normalizeTies
     * is invoked by those paths. (See the routing in the mutation
     * entry points: insertChord/Rest, replaceChord, deleteAtCursor,
     * cycleDots, toggleTie, setTimeSig.) */
  }

  /** Backwards-compatible alias for the old resolvePendingTies. Calls
   *  normalizeTies which subsumes the resolution semantics. */
  private resolvePendingTies(_newFirstFlatIdx: number): void {
    this.normalizeTies();
  }

  /** Append a chord at the end of the current voice. */
  appendChord(input: ChordInput): string | null {
    this.cursorToEnd();
    return this.insertChordAtCursor(input);
  }

  /** Append a rest at the end of the current voice. */
  appendRest(input: RestInput): string | null {
    this.cursorToEnd();
    return this.insertRestAtCursor(input);
  }

  /** Replace the element at the current cursor with a new chord. Cursor
   *  remains at its original position (the caller is expected to advance
   *  if desired — matches the historical replace contract). When overflow
   *  forces a split chain, cursor stays put even though the chain may have
   *  >1 elements; this matches the simple-path semantics. Inside a tuplet,
   *  tick differences are absorbed by trailing placeholders; if the new
   *  duration grows past what's available, returns null (rejected). */
  replaceChordAtCursor(input: ChordInput): string | null {
    const v = this.currentVoice;
    const cursorAtCall = this.cursors[v];
    const flat = this.flatChildren(v);
    /* Under the new cursor convention, the overwrite target is flat[c] —
       the element the cursor sits past (and the selection box wraps).
       Past-end has no flat[c] and nothing to overwrite. */
    if (cursorAtCall >= flat.length) return null;
    const target = flat[cursorAtCall];
    /* Wrappers and layer-level placeholders aren't overwrite targets — the
     * caller (input.ts) treats a null return as a signal to fall back to
     * insert. */
    if (target.localName === 'measure') return null;
    if (isPlaceholder(target)) return null;

    const newTicks = ticksOf(input.duration, input.dots ?? 0);

    /* In-tuplet target: replace a filled child OR fill the trailing
       placeholder run (when target IS a fill anchor). */
    if (target.parentElement?.localName === 'tuplet') {
      const tuplet = target.parentElement;
      const trailingTicks = this.tupletPlaceholderTicks(tuplet);

      if (isTupletPlaceholder(target)) {
        /* Overwrite on fill anchor = fill the tuplet (same as insert). */
        if (newTicks > trailingTicks) return null;
        for (const c of Array.from(tuplet.children)) {
          if (isTupletPlaceholder(c)) tuplet.removeChild(c);
        }
        const replaced = this.buildChordElement(input);
        tuplet.appendChild(replaced);
        for (const p of this.regenTupletPlaceholders(
          tuplet,
          trailingTicks - newTicks,
        )) {
          tuplet.appendChild(p);
        }
        this.resolvePendingTies(cursorAtCall);
        this.normalizePlaceholders();
            return replaced.getAttribute("xml:id");
      }

      /* Replace a filled tuplet child. Tick delta absorbs into trailing
         placeholders (grow if shrinking, consume if growing). */
      const oldTicks = writtenTicks(target);
      const delta = newTicks - oldTicks;
      if (delta > trailingTicks) return null;
      this.orphanTiePartners(target);
      const replaced = this.buildChordElement(input);
      tuplet.replaceChild(replaced, target);
      for (const c of Array.from(tuplet.children)) {
        if (isTupletPlaceholder(c)) tuplet.removeChild(c);
      }
      for (const p of this.regenTupletPlaceholders(
        tuplet,
        trailingTicks - delta,
      )) {
        tuplet.appendChild(p);
      }
      this.resolvePendingTies(cursorAtCall);
      this.normalizePlaceholders();
        return replaced.getAttribute("xml:id");
    }

    /* Layer-level target (chord/note/rest, or a tuplet wrapper at the
       layer level — overwrite on a tuplet wrapper means atomic-replace
       the entire tuplet with a single chord). */
    const layer = target.parentElement;
    if (!layer || layer.localName !== 'layer') return null;
    const measure = layer.closest('measure') as Element | null;
    if (!measure) return null;
    const measureIdx = this.allMeasures().indexOf(measure);
    if (measureIdx < 0) return null;
    const kids = this.contentChildren(layer);
    const idxInLayer = kids.indexOf(target);
    if (idxInLayer < 0) return null;

    if (target.localName === 'tuplet') {
      /* Atomic tuplet replace: remove the tuplet, then run insertWithSplit
         at the position the tuplet used to occupy. Repositioning the cursor
         to `c - 1` (= past flat[c-1] = immediately before the tuplet) makes
         insertWithSplit's locateCursor return the correct insertion slot. */
      this.orphanTiePartners(target);
      layer.removeChild(target);
      this.cursors[v] = Math.max(0, cursorAtCall - 1);
      const id = this.insertWithSplit(input, false);
      this.cursors[v] = cursorAtCall;
      this.resolvePendingTies(cursorAtCall);
      this.normalizePlaceholders();
        return id;
    }
    /* Simple in-place replace WITHIN current measure if it fits — checked
       against the post-cursor content too, since the replaced element's
       successors keep their position in the layer's child list and would
       otherwise be pushed past the barline silently. */
    const usedBefore = this.timeWithinMeasure(v, measureIdx, idxInLayer);
    let postBlockTicks = 0;
    for (let i = idxInLayer + 1; i < kids.length; i++) {
      postBlockTicks += realTicks(kids[i]);
    }
    if (usedBefore + newTicks + postBlockTicks <= this.measureTicks()) {
      this.orphanTiePartners(target);
      const replaced = this.buildChordElement(input);
      layer.replaceChild(replaced, target);
      this.resolvePendingTies(cursorAtCall);
      this.normalizePlaceholders();
        return replaced.getAttribute("xml:id");
    }
    /* Overflow on replace: remove old, run the planning insertWithSplit
       (which handles displacement of any remaining post-cursor content),
       restore cursor to its pre-replace position. */
    this.orphanTiePartners(target);
    layer.removeChild(target);
    this.cursors[v] = Math.max(0, cursorAtCall - 1);
    const id = this.insertWithSplit(input, false);
    this.cursors[v] = cursorAtCall;
    this.resolvePendingTies(cursorAtCall);
    this.normalizePlaceholders();
    return id;
  }


  /** Delete the element immediately to the left of the cursor. Containers
   *  (tuplets, measures) require an explicit second backspace at their
   *  anchor stop to drop them — mirroring the empty-tuplet pattern.
   *
   *  Backspace cases (in priority order):
   *    1. Cursor ON the fill-anchor of an *empty* tuplet → delete tuplet.
   *    2. Cursor ON the wrapper of an *empty* measure → delete measure.
   *    3. Target is a placeholder → skip-left (no deletion).
   *    4. Target is a tuplet wrapper or measure wrapper → skip-left.
   *    5. Target is a tuplet's filled child → remove it, grow trailing
   *       placeholders to preserve the tuplet's written-tick budget.
   *    6. Otherwise → remove the target content element. Emptied measures
   *       are NOT auto-removed; the user must back into the wrapper and
   *       press backspace again to drop them (case 2). */
  deleteAtCursor(): boolean {
    const v = this.currentVoice;
    const c = this.cursors[v];
    const flat = this.flatChildren(v);

    /* Past-end is a synthetic stop with no associated element. Backspace
       at past-end just moves the cursor left by 1; it never deletes
       anything. */
    if (c >= flat.length) {
      this.cursors[v] = Math.max(0, c - 1);
      return true;
    }

    /* The deletion target is always flat[c] — the element to the cursor's
       left under the new convention (cursor c = past flat[c]). */
    const target = flat[c];
    if (!target) return false;
    const clampCursors = (): void => {
      for (let vi = 1 as Voice; vi <= 4; vi = (vi + 1) as Voice) {
        this.cursors[vi] = Math.min(
          this.cursors[vi],
          this.getVoiceLength(vi),
        );
        if (vi === 4) break;
      }
    };

    /* Helper: after deleting a structure that contributed N stops to flat
       starting at flat-index `structIdx`, the cursor should land at
       "past the element just before the deleted structure" = flat-index
       `structIdx - 1` (clamped). Avoids the bug where, deleting an empty
       tuplet (N=2 stops) from the fill-anchor cursor (c = structIdx + 1),
       the `c - 1` fallback only collapses ONE stop and leaves the cursor
       one position too far right. */
    const cursorPastPrevOf = (structIdx: number): number =>
      Math.max(0, structIdx - 1);

    /* Case 1: target is the fill anchor of an EMPTY tuplet. Delete the
       whole tuplet. (A non-empty tuplet's fill anchor isn't deletable as
       such — fall through to the wrapper skip-left.) */
    if (isTupletPlaceholder(target)) {
      const tuplet = target.parentElement;
      if (tuplet && tuplet.localName === "tuplet") {
        const hasFilled = Array.from(tuplet.children).some(
          (cc) => !isTupletPlaceholder(cc),
        );
        if (!hasFilled) {
          const tupletIdx = flat.indexOf(tuplet);
          tuplet.parentNode?.removeChild(tuplet);
          this.setBarlines();
          this.normalizeTies();
          this.normalizePlaceholders();
          this.cursors[v] = cursorPastPrevOf(tupletIdx);
          clampCursors();
          return true;
        }
      }
      /* Partial tuplet's fill anchor: not deletable. Skip-left. */
      this.cursors[v] = Math.max(0, c - 1);
      return true;
    }

    /* Case 2: target is the wrapper of an empty measure. The wrapper IS
       the empty measure's one nav stop and doubles as the delete target.
       Skip when it's the only measure left. */
    if (target.localName === "measure") {
      if (this.measureIsEmpty(target) && this.allMeasures().length > 1) {
        const measureIdx = c; /* flat[c] === target === measure wrapper */
        target.parentNode?.removeChild(target);
        this.renumberMeasures();
        this.setBarlines();
        this.normalizeTies();
        this.normalizePlaceholders();
        /* Explicitly seat the cursor "past the element before the deleted
           measure". Without this, clampCursors alone leaves the cursor
           at past-end whenever the surviving prev measure is partial/empty
           (voiceLen still ≥ c), which sits the cursor past the (now-gone)
           deleted measure's right bar rather than at the end of the
           preceding measure's content. */
        this.cursors[v] = cursorPastPrevOf(measureIdx);
        clampCursors();
        return true;
      }
      /* Wrapper of non-empty measure (or last-remaining empty measure):
         skip-left without deletion. */
      this.cursors[v] = Math.max(0, c - 1);
      return true;
    }

    /* Tuplet wrapper. Backspace at "past tuplet wrapper" (= visually entered
       at the bracket's left interior) deletes the tuplet when it's empty
       (only placeholders), matching the behavior at the fill-anchor case
       above. A non-empty tuplet just skip-lefts (out of the bracket). */
    if (target.localName === "tuplet") {
      const hasFilled = Array.from(target.children).some(
        (cc) => !isTupletPlaceholder(cc),
      );
      if (!hasFilled) {
        const tupletIdx = c; /* flat[c] === target === tuplet wrapper */
        target.parentNode?.removeChild(target);
        this.setBarlines();
        this.normalizePlaceholders();
        this.cursors[v] = cursorPastPrevOf(tupletIdx);
        clampCursors();
        return true;
      }
      this.cursors[v] = Math.max(0, c - 1);
      return true;
    }

    /* Defensive: layer-level placeholders aren't emitted in flat after the
       clean-stop-rules refactor. Skip-left if one ever shows up. */
    if (isPlaceholder(target)) {
      this.cursors[v] = Math.max(0, c - 1);
      return true;
    }

    /* In-tuplet branch: target is a filled child of a <tuplet>. Remove it
       and grow trailing placeholders by writtenTicks(target) so the tuplet's
       total duration stays constant. */
    const tupletParent =
      target.parentElement?.localName === "tuplet"
        ? target.parentElement
        : null;
    if (tupletParent) {
      const oldTicks = writtenTicks(target);
      const trailingTicks = this.tupletPlaceholderTicks(tupletParent);
      tupletParent.removeChild(target);
      for (const cc of Array.from(tupletParent.children)) {
        if (isTupletPlaceholder(cc)) tupletParent.removeChild(cc);
      }
      for (const p of this.regenTupletPlaceholders(
        tupletParent,
        trailingTicks + oldTicks,
      )) {
        tupletParent.appendChild(p);
      }
      this.cursors[v] = Math.max(0, c - 1);
      this.setBarlines();
      this.normalizeTies();
      this.normalizePlaceholders();
      clampCursors();
      return true;
    }

    /* Generic layer-level content (chord/note/rest): remove from its parent
       layer directly. Emptied measures are NOT auto-removed — once a layer
       collapses to a single wrapper nav stop (rule 2), one more backspace
       at that wrapper is the explicit confirmation that drops the measure
       (see Case 2 above). */
    const parentLayer = target.parentElement;
    if (!parentLayer || parentLayer.localName !== "layer") return false;
    parentLayer.removeChild(target);
    this.cursors[v] = Math.max(0, c - 1);
    this.setBarlines();
    this.normalizeTies();
    this.normalizePlaceholders();
    clampCursors();
    return true;
  }

  /** Replace all source-voice content within the absolute-tick range
   *  [tLoAbs, tHiAbs) with beat-aligned rests. Used by Ctrl+X on a beat
   *  selection. Beat-aligned selection bounds guarantee no element is
   *  bisected — every overlapping element is fully contained — so we just
   *  remove them and fill the gap.
   *
   *  Important: this assumes the caller has already validated that [tLoAbs,
   *  tHiAbs) starts and ends at beat boundaries in the voice's flat stream.
   *  Otherwise tuplets straddling the range could be partially removed.
   *
   *  Runs normalizeTies + normalizePlaceholders at the end. */
  clearBeatRange(voice: Voice, tLoAbs: number, tHiAbs: number): void {
    if (tHiAbs <= tLoAbs) return;
    const measures = this.allMeasures();
    const cap = this.measureTicks();
    const ts = readTimeSig(this.doc);
    for (let mi = 0; mi < measures.length; mi++) {
      const measureStart = mi * cap;
      const measureEnd = measureStart + cap;
      if (measureEnd <= tLoAbs) continue;
      if (measureStart >= tHiAbs) break;
      const layer = this.layerInMeasure(measures[mi], voice);
      if (!layer) continue;
      const tLoIn = Math.max(0, tLoAbs - measureStart);
      const tHiIn = Math.min(cap, tHiAbs - measureStart);
      /* Walk content children; collect those fully inside [tLoIn, tHiIn). */
      let cursor = 0;
      const toRemove: Element[] = [];
      for (const c of this.contentChildren(layer)) {
        const dur = realTicks(c);
        const cEnd = cursor + dur;
        if (cursor >= tLoIn - 1e-6 && cEnd <= tHiIn + 1e-6) {
          toRemove.push(c);
        }
        cursor = cEnd;
      }
      /* Determine the cc-position where removals start (for re-insertion).
       * If toRemove is empty, nothing to do in this measure. */
      if (toRemove.length === 0) continue;
      const firstToRemove = toRemove[0];
      const cc = this.contentChildren(layer);
      const insertIdx = cc.indexOf(firstToRemove);
      /* Compute the actual removed-range tick span (it may be shorter than
       * tHiIn - tLoIn if leading/trailing content in the layer doesn't
       * actually span the full range — e.g. when the measure is partial). */
      let removedTicks = 0;
      for (const r of toRemove) {
        this.orphanTiePartners(r);
        removedTicks += realTicks(r);
      }
      for (const r of toRemove) {
        r.parentNode?.removeChild(r);
      }
      /* Insert beat-aligned rests filling the removed span. We need a start
       * tick within the measure for beat-alignment; that's just tLoIn. */
      const rests = decomposeBeatAlignedRests(tLoIn, removedTicks, ts);
      let insertBefore = this.contentChildren(layer)[insertIdx] ?? null;
      for (const r of rests) {
        const restEl = el(this.doc, 'rest', {
          'xml:id': newId('r'),
          dur: r.dur,
          dots: r.dots > 0 ? r.dots : undefined,
        });
        if (insertBefore) layer.insertBefore(restEl, insertBefore);
        else layer.appendChild(restEl);
      }
    }
    this.setBarlines();
    this.normalizeTies();
    this.normalizePlaceholders();
    for (let vi: Voice = 1; vi <= 4; vi = (vi + 1) as Voice) {
      this.cursors[vi] = Math.min(this.cursors[vi], this.getVoiceLength(vi));
      if (vi === 4) break;
    }
  }

  /** Paste a list of cloned source elements (chord/note/rest/tuplet) into
   *  `voice` at absolute tick position `tLoAbs`. The destination range
   *  [tLoAbs, tLoAbs + srcDurationTicks) is cleared first (removing all
   *  fully- AND partially-overlapping layer-level elements; tuplets that
   *  partially overlap are removed atomically per spec). If the destination
   *  range extends past end-of-score, empty measures are appended. After
   *  insertion, any residual gap (from tuplet-expansion clearing) is filled
   *  with beat-aligned rests.
   *
   *  Each source element is inserted via the existing infrastructure:
   *    - chord/note: `insertChordAtCursor` (handles bar-line overflow with
   *      auto-tie-on-overflow via insertWithSplit).
   *    - rest: `insertRestAtCursor` (handles bar-line overflow).
   *    - tuplet: atomic DOM placement at layer level; rejected if it doesn't
   *      fit fully in the current measure (status warning surfaced by caller).
   *
   *  Returns the post-paste cursor index for the voice (= position right
   *  past the inserted content), or null if any insertion failed.
   */
  pasteBeatContent(
    voice: Voice,
    tLoAbs: number,
    srcElements: Element[],
    srcDurationTicks: number,
  ): { ok: true; postCursor: number } | { ok: false; reason: string } {
    const cap = this.measureTicks();
    let effectiveLo = tLoAbs;
    let effectiveHi = tLoAbs + srcDurationTicks;

    /* Expand effective range to swallow any tuplets in the source voice's
       layers that partially overlap [tLoAbs, effectiveHi). */
    const measures0 = this.allMeasures();
    for (let mi = 0; mi < measures0.length; mi++) {
      const mStart = mi * cap;
      if (mStart >= effectiveHi) break;
      if (mStart + cap <= tLoAbs) continue;
      const layer = this.layerInMeasure(measures0[mi], voice);
      if (!layer) continue;
      let cursor = mStart;
      for (const c of this.contentChildren(layer)) {
        const dur = realTicks(c);
        const cEnd = cursor + dur;
        if (c.localName === 'tuplet') {
          const overlapsLo = cursor < tLoAbs && cEnd > tLoAbs;
          const overlapsHi = cursor < effectiveHi && cEnd > effectiveHi;
          if (overlapsLo) effectiveLo = Math.min(effectiveLo, cursor);
          if (overlapsHi) effectiveHi = Math.max(effectiveHi, cEnd);
        }
        cursor = cEnd;
      }
    }

    /* Auto-append measures so effectiveHi fits. */
    while (effectiveHi > this.allMeasures().length * cap) {
      this.appendMeasure();
    }

    /* Remove all layer-level content in voice that intersects
       [effectiveLo, effectiveHi). */
    const measures = this.allMeasures();
    for (let mi = 0; mi < measures.length; mi++) {
      const mStart = mi * cap;
      if (mStart >= effectiveHi) break;
      if (mStart + cap <= effectiveLo) continue;
      const layer = this.layerInMeasure(measures[mi], voice);
      if (!layer) continue;
      let cursor = mStart;
      const toRemove: Element[] = [];
      for (const c of this.contentChildren(layer)) {
        const dur = realTicks(c);
        const cEnd = cursor + dur;
        if (cEnd > effectiveLo && cursor < effectiveHi) toRemove.push(c);
        cursor = cEnd;
      }
      for (const r of toRemove) {
        this.orphanTiePartners(r);
        r.parentNode?.removeChild(r);
      }
      /* Strip layer-level placeholders introduced by previous normalizations
         in this layer — paste insertion is about to refill from scratch. */
      for (const c of Array.from(layer.children)) {
        if (isPlaceholder(c)) layer.removeChild(c);
      }
    }

    /* Position the cursor at effectiveLo in the source voice. Use the
     * locateCursor-convention helper since insertChordAtCursor (below) reads
     * the cursor via locateCursor — `findCursorAtOrBefore` uses an off-by-one
     * convention and would put the cursor one element too far right, causing
     * the paste to insert AFTER the next surviving element instead of in
     * the just-deleted slot. */
    const prevVoice = this.currentVoice;
    this.currentVoice = voice;
    this.cursors[voice] = this.findCursorByTickPosition(voice, effectiveLo);
    /* If the leading expansion (effectiveLo < tLoAbs) created a gap before
       the paste's source-content, fill it with beat-aligned rests first. */
    if (effectiveLo < tLoAbs) {
      const leadingTicks = tLoAbs - effectiveLo;
      const ts = readTimeSig(this.doc);
      /* tLo within its measure for beat alignment. */
      const measureIdxLeading = Math.floor(effectiveLo / cap);
      const inMeasureLo = effectiveLo - measureIdxLeading * cap;
      const restPieces = decomposeBeatAlignedRests(inMeasureLo, leadingTicks, ts);
      for (const p of restPieces) {
        if (this.insertRestAtCursor({ duration: p.dur, dots: p.dots }) === null) {
          this.currentVoice = prevVoice;
          return { ok: false, reason: 'Failed to fill leading gap' };
        }
      }
    }

    /* Insert each source element. */
    for (const src of srcElements) {
      const ok = this.insertClonedAtCursor(src);
      if (!ok) {
        this.currentVoice = prevVoice;
        return { ok: false, reason: 'Failed to insert pasted element' };
      }
    }

    /* Fill trailing gap (from tuplet expansion: effectiveHi > tLoAbs + srcDuration). */
    const afterSrc = tLoAbs + srcDurationTicks;
    if (effectiveHi > afterSrc) {
      const trailingTicks = effectiveHi - afterSrc;
      const ts = readTimeSig(this.doc);
      const measureIdxTrailing = Math.floor(afterSrc / cap);
      const inMeasureLo = afterSrc - measureIdxTrailing * cap;
      const restPieces = decomposeBeatAlignedRests(inMeasureLo, trailingTicks, ts);
      for (const p of restPieces) {
        if (this.insertRestAtCursor({ duration: p.dur, dots: p.dots }) === null) {
          this.currentVoice = prevVoice;
          return { ok: false, reason: 'Failed to fill trailing gap' };
        }
      }
    }

    /* Restore voice; final post-cursor at effectiveHi. */
    const postCursor = this.findCursorByTickPosition(voice, effectiveHi);
    this.cursors[voice] = postCursor;
    this.currentVoice = prevVoice;
    this.setBarlines();
    this.normalizeTies();
    this.normalizePlaceholders();
    for (let vi: Voice = 1; vi <= 4; vi = (vi + 1) as Voice) {
      this.cursors[vi] = Math.min(this.cursors[vi], this.getVoiceLength(vi));
      if (vi === 4) break;
    }
    return { ok: true, postCursor: this.cursors[voice] };
  }

  /** Insert a single cloned source element at the current voice's cursor.
   *  Routes to insertChordAtCursor / insertRestAtCursor / atomic tuplet
   *  placement. */
  private insertClonedAtCursor(src: Element): boolean {
    const ln = src.localName;
    if (ln === 'note' || ln === 'chord') {
      const notes = this.extractResolvedFromElement(src);
      const dur = (src.getAttribute('dur') ?? '4') as Duration;
      const dots = (parseInt(src.getAttribute('dots') ?? '0', 10) || 0) as Dots;
      if (notes.length === 0) return false;
      return this.insertChordAtCursor({ notes, duration: dur, dots }) !== null;
    }
    if (ln === 'rest') {
      const dur = (src.getAttribute('dur') ?? '4') as Duration;
      const dots = (parseInt(src.getAttribute('dots') ?? '0', 10) || 0) as Dots;
      return this.insertRestAtCursor({ duration: dur, dots }) !== null;
    }
    if (ln === 'tuplet') {
      const v = this.currentVoice;
      const loc = this.locateCursor(v, this.cursors[v]);
      if (!loc || loc.inTuplet) return false;
      const tupletTicks = realTicks(src);
      const used = this.timeWithinMeasure(v, loc.measureIdx, loc.withinIdx);
      if (used + tupletTicks > this.measureTicks() + 1e-6) return false;
      /* Clone into our doc with fresh ids. */
      const fresh = src.cloneNode(true) as Element;
      this.regenerateIds(fresh);
      this.insertAt(loc.layer, fresh, loc.withinIdx);
      /* Advance cursor past the tuplet's contributed flat stops. The simplest
         way is to compute the new cursor via tstamp lookup. */
      const newTstamp = this.getCursorAbsoluteTicks(v) + tupletTicks;
      this.normalizePlaceholders();
      this.cursors[v] = this.findCursorByTickPosition(v, newTstamp);
      return true;
    }
    return false;
  }

  /** Recursively regenerate xml:id on `el` and all descendants, picking
   *  prefix by localName (n, c, r, t, sp, m, s, l). Used when DOM-importing
   *  cloned content from the clipboard or another part of the document. */
  private regenerateIds(el: Element): void {
    const ln = el.localName;
    const prefix = ln === 'note' ? 'n'
      : ln === 'chord' ? 'c'
      : ln === 'rest' ? 'r'
      : ln === 'tuplet' ? 't'
      : ln === 'space' ? 'sp'
      : ln === 'measure' ? 'm'
      : ln === 'staff' ? 's'
      : ln === 'layer' ? 'l'
      : 'x';
    el.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:id', newId(prefix));
    for (const c of Array.from(el.children)) this.regenerateIds(c);
  }

  /** Paste a list of cloned source measures into the destination starting at
   *  measure `mDest`, replacing the staves in [firstStaff..lastStaff] of
   *  each destination measure with the corresponding source-measure's
   *  staff layers. Auto-appends measures if mDest + sourceCount exceeds
   *  current count. Source <dynam>/<hairpin> expressions (with
   *  `data-hkl-src-measure-offset`) are re-anchored to the appropriate
   *  destination measure. Returns the destination range covered.
   *
   *  Pre-check: source and destination time-signature must match (caller
   *  enforces via the clipboard's `sourceTimeSig`). */
  pasteMeasureContent(
    mDest: number,
    firstStaff: 1 | 2,
    lastStaff: 1 | 2,
    srcMeasures: Element[],
    srcExpressions: Element[],
  ): { ok: true; mLo: number; mHi: number } | { ok: false; reason: string } {
    const N = srcMeasures.length;
    if (N === 0) return { ok: false, reason: 'No measures to paste' };
    /* Auto-append destination measures so mDest+N-1 exists. */
    while (this.allMeasures().length < mDest + N) {
      this.appendMeasure();
    }
    const destMeasures = this.allMeasures();
    /* Clear destination range (staves + expressions). */
    this.clearMeasureRange(mDest, mDest + N - 1, firstStaff, lastStaff);
    /* For each (i, sourceMeasure): replace destination measure's selected
       staves' layers with cloned source layers. */
    for (let i = 0; i < N; i++) {
      const srcM = srcMeasures[i];
      const destM = destMeasures[mDest + i];
      for (let sn = firstStaff; sn <= lastStaff; sn++) {
        const srcStaff = Array.from(srcM.querySelectorAll('staff')).find(
          (s) => s.getAttribute('n') === String(sn),
        );
        const destStaff = Array.from(destM.querySelectorAll('staff')).find(
          (s) => s.getAttribute('n') === String(sn),
        );
        if (!srcStaff || !destStaff) continue;
        /* Replace destStaff's layers with cloned srcStaff's layers (preserving
           the destStaff's xml:id so cursor staff-lookups stay valid). */
        const srcLayers = Array.from(srcStaff.querySelectorAll('layer'));
        const destLayers = Array.from(destStaff.querySelectorAll('layer'));
        for (const dl of destLayers) destStaff.removeChild(dl);
        for (const sl of srcLayers) {
          const fresh = sl.cloneNode(true) as Element;
          this.regenerateIds(fresh);
          destStaff.appendChild(fresh);
        }
      }
    }
    /* Re-anchor source expressions to destination measures. */
    for (const expr of srcExpressions) {
      const off = parseInt(expr.getAttribute('data-hkl-src-measure-offset') ?? '0', 10) || 0;
      const targetIdx = mDest + off;
      if (targetIdx < 0 || targetIdx >= this.allMeasures().length) continue;
      const targetM = this.allMeasures()[targetIdx];
      const fresh = expr.cloneNode(true) as Element;
      fresh.removeAttribute('data-hkl-src-measure-offset');
      this.regenerateIds(fresh);
      /* Adjust @tstamp2 ("Nm+beat") if it points past the source range —
         simplification: keep tstamp2 as-is; advanced re-anchoring TBD. */
      targetM.appendChild(fresh);
    }
    this.setBarlines();
    this.normalizeTies();
    this.normalizePlaceholders();
    for (let vi: Voice = 1; vi <= 4; vi = (vi + 1) as Voice) {
      this.cursors[vi] = Math.min(this.cursors[vi], this.getVoiceLength(vi));
      if (vi === 4) break;
    }
    return { ok: true, mLo: mDest, mHi: mDest + N - 1 };
  }

  /** Empty all layers of staves [firstStaff..lastStaff] in measures
   *  [mLo..mHi] inclusive. Removes <dynam>/<hairpin> control events anchored
   *  to those measures whose staff attribute is in range. normalizePlaceholders
   *  re-fills emptied layers with placeholders so cursor navigation stays
   *  consistent. Used by Ctrl+X on a measure selection. */
  clearMeasureRange(mLo: number, mHi: number, firstStaff: 1 | 2, lastStaff: 1 | 2): void {
    const measures = this.allMeasures();
    for (let mi = Math.max(0, mLo); mi <= mHi && mi < measures.length; mi++) {
      const m = measures[mi];
      /* Clear staves in range. */
      for (const staff of Array.from(m.querySelectorAll('staff'))) {
        const sn = parseInt(staff.getAttribute('n') ?? '0', 10);
        if (sn < firstStaff || sn > lastStaff) continue;
        for (const layer of Array.from(staff.querySelectorAll('layer'))) {
          for (const c of Array.from(layer.children)) {
            const ln = c.localName;
            if (ln === 'chord' || ln === 'note' || ln === 'rest' || ln === 'tuplet'
                || ln === 'space') {
              this.orphanTiePartners(c);
              layer.removeChild(c);
            }
          }
        }
      }
      /* Remove control events anchored to this measure for the staff range. */
      for (const ctrl of Array.from(m.children)) {
        const ln = ctrl.localName;
        if (ln !== 'dynam' && ln !== 'hairpin') continue;
        const sn = parseInt(ctrl.getAttribute('staff') ?? '0', 10);
        if (sn >= firstStaff && sn <= lastStaff) {
          m.removeChild(ctrl);
        }
      }
    }
    this.setBarlines();
    this.normalizeTies();
    this.normalizePlaceholders();
    for (let vi: Voice = 1; vi <= 4; vi = (vi + 1) as Voice) {
      this.cursors[vi] = Math.min(this.cursors[vi], this.getVoiceLength(vi));
      if (vi === 4) break;
    }
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
      measures[i].setAttribute("n", String(i + 1));
    }
  }

  /** Cycle dots on the current note/chord/rest. Respects the 'insert' /
   *  'overwrite' mode for which element to target. When the new total
   *  exceeds remaining measure space, splits across the bar with ties
   *  (auto-tie-overflow behavior). Returns null when there's no current
   *  element. */
  cycleDotsOnCurrent(
    mode: "insert" | "overwrite",
  ): { id: string; newDots: Dots } | null {
    const v = this.currentVoice;
    const ref = this.getCurrentElement(v, mode);
    if (!ref) return null;
    if (isPlaceholder(ref.elem)) return null; /* nothing to dot */
    if (isTupletPlaceholder(ref.elem))
      return null; /* fill anchors aren't dottable */
    const elem = ref.elem;
    if (elem.localName === "tuplet") return null; /* whole-tuplet dotting NYI */
    if (elem.localName === "measure") return null; /* wrapper stops aren't dottable */
    const isRest = elem.localName === "rest";
    const curDots = parseInt(elem.getAttribute("dots") ?? "0", 10) as Dots;
    const nextDots = ((curDots + 1) % 3) as Dots;
    const dur = (elem.getAttribute("dur") ?? "4") as Duration;
    const newTotalTicks = ticksOf(dur, nextDots);

    /* In-tuplet branch: absorb tick delta from trailing placeholders. */
    const enclosingTuplet =
      elem.parentElement?.localName === "tuplet" ? elem.parentElement : null;
    if (enclosingTuplet) {
      const oldTicks = ticksOf(dur, curDots);
      const delta = newTotalTicks - oldTicks;
      const trailingTicks = this.tupletPlaceholderTicks(enclosingTuplet);
      if (delta > trailingTicks) return null; /* doesn't fit — reject */
      if (nextDots > 0) elem.setAttribute("dots", String(nextDots));
      else elem.removeAttribute("dots");
      /* Rebuild trailing placeholders. */
      for (const c of Array.from(enclosingTuplet.children)) {
        if (isTupletPlaceholder(c)) enclosingTuplet.removeChild(c);
      }
      for (const p of this.regenTupletPlaceholders(
        enclosingTuplet,
        trailingTicks - delta,
      )) {
        enclosingTuplet.appendChild(p);
      }
      this.normalizePlaceholders();
        return { id: ref.id, newDots: nextDots };
    }

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
      if (nextDots > 0) elem.setAttribute("dots", String(nextDots));
      else elem.removeAttribute("dots");
      this.normalizePlaceholders();
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

    /* Under the new cursor convention, `ref.index = c` means "past flat[c]"
       = past the element being replaced. To make insertWithSplit insert
       AT the element's position (= replace it), reposition the cursor to
       `c - 1` (= past flat[c-1] = immediately BEFORE the target). Then
       insertWithSplit's locateCursor(c-1) returns insertion-after flat[c-1],
       which is exactly the slot the removed element occupied. */
    this.cursors[v] = Math.max(0, ref.index - 1);
    /* Remove the old element, clearing any tie partners that pointed at it. */
    this.orphanTiePartners(elem);
    loc.layer.removeChild(elem);
    /* Insert the split chain. */
    let firstId: string | null = null;
    if (restInput)
      firstId = this.insertWithSplit({ ...restInput, notes: [] }, true);
    else if (chordInput) firstId = this.insertWithSplit(chordInput, false);
    /* insertWithSplit leaves the cursor at the index of the last inserted
       piece (= past the last chain element). For insert mode that's the
       right "just-entered the chain" position; for overwrite we want the
       cursor selecting the CHAIN HEAD, which sits at the same flat-index
       the original element occupied — i.e., back at `ref.index`. */
    if (mode === "overwrite") {
      this.cursors[v] = ref.index;
    }
    this.normalizePlaceholders();
    this.cursors[v] = Math.min(this.cursors[v], this.getVoiceLength(v));
    if (!firstId) return null;
    return { id: firstId, newDots: nextDots };
  }

  /** Toggle a tie on the current note/chord. Sets per-note "wants to tie
   *  forward" intent (via @data-pending-tie) or clears it; `normalizeTies`
   *  derives @tie / @data-tie-partner / <lv> from flat-order adjacency.
   *  Returns null when there's no tieable current element. */
  toggleTieOnCurrent(
    mode: "insert" | "overwrite",
    chordNoteIndex?: number,
  ): { id: string; tied: boolean } | null {
    const v = this.currentVoice;
    const ref = this.getCurrentElement(v, mode);
    if (!ref) return null;
    if (ref.elem.localName === "rest") return null;
    if (ref.elem.localName === "measure") return null; /* wrapper stops aren't tieable */
    if (ref.elem.localName === "tuplet") return null; /* whole-tuplet tie NYI */
    if (isPlaceholder(ref.elem)) return null; /* placeholders aren't tieable */
    const allNotes = this.extractNoteElements(ref.elem);
    if (allNotes.length === 0) return null;
    /* Target a single chord member when chordNoteIndex is provided AND the
       current element is a chord. Out-of-range or non-chord cases fall back
       to the whole-element behavior (matches expectations: the caller is the
       chord-internal selection, which only sets up an index on real chords). */
    const isChord = ref.elem.localName === "chord";
    const currentNotes = (isChord && typeof chordNoteIndex === "number"
        && chordNoteIndex >= 0 && chordNoteIndex < allNotes.length)
      ? [allNotes[chordNoteIndex]]
      : allNotes;

    const alreadyTied = currentNotes.some((n) => {
      const t = n.getAttribute("tie");
      return t === "i" || t === "m" || n.hasAttribute("data-pending-tie");
    });

    if (alreadyTied) {
      /* Toggle off: drop the forward intent on each current note. If a
       * note had @tie="m" (both incoming and outgoing), downgrade to "t"
       * to preserve the incoming arc. Pending stubs lose @data-pending-tie
       * (their <lv> is rebuilt by normalize). */
      for (const n of currentNotes) {
        n.removeAttribute("data-pending-tie");
        const t = n.getAttribute("tie");
        if (t === "m") setTieFlag(n, "t");
        else if (t === "i") clearTieFlag(n);
        /* `t` or null → no outgoing intent existed; leave as-is. */
      }
    } else {
      /* Toggle on: mark each current note as wanting to tie forward.
       * Use @data-pending-tie as the intent marker — normalize will
       * upgrade to @tie="i" / "m" when a same-pitch partner is found. */
      for (const n of currentNotes) {
        n.setAttribute("data-pending-tie", "true");
      }
    }

    this.normalizeTies();
    this.normalizePlaceholders();
    return { id: ref.id, tied: !alreadyTied };
  }

  /** After a time-signature change, walk each measure × voice layer in
   *  place. For each layer, find the first element that overflows the new
   *  measure's tick budget; shorten it to the largest representable dur ≤
   *  remaining ticks (or drop it if remaining is 0), then drop everything
   *  after it. Measure count is preserved; tied chains that cross the new
   *  truncation point get orphaned cleanly (orphanTiePartners demotes
   *  surviving partners back to stubs). */
  private truncateOverflowingMeasures(): void {
    const cap = this.measureTicks();
    for (const measure of this.allMeasures()) {
      for (let v: Voice = 1; v <= 4; v = (v + 1) as Voice) {
        const layer = this.layerInMeasure(measure, v);
        if (layer) this.truncateLayer(layer, cap);
        if (v === 4) break;
      }
    }
    this.normalizePlaceholders();
    for (let v: Voice = 1; v <= 4; v = (v + 1) as Voice) {
      this.cursors[v] = Math.min(this.cursors[v], this.getVoiceLength(v));
      if (v === 4) break;
    }
    this.setBarlines();
  }

  private truncateLayer(layer: Element, cap: number): void {
    const kids = this.contentChildren(layer);
    let running = 0;
    let truncateAt = -1;
    for (let i = 0; i < kids.length; i++) {
      const ticks = elementDurationTicks(kids[i]);
      if (running + ticks > cap) {
        truncateAt = i;
        break;
      }
      running += ticks;
    }
    if (truncateAt < 0) return; /* fully fits — nothing to do */
    const overflowEl = kids[truncateAt];
    const remaining = cap - running;
    /* Tuplets are atomic — never split. If a tuplet overflows the new
       budget, drop it whole (and everything after). */
    if (overflowEl.localName === "tuplet") {
      this.orphanTiePartners(overflowEl);
      layer.removeChild(overflowEl);
    } else if (remaining > 0) {
      /* Shorten the overflowing element to fit. @dur (and @dots) live on
         the element itself (chord parent or bare note); inner notes of a
         chord don't carry @dur so a single setAttribute is enough.
         Pitches, ties, color, data-q/r, etc. are preserved. */
      const pieces = decomposeTicks(remaining);
      if (pieces.length === 0) {
        this.orphanTiePartners(overflowEl);
        layer.removeChild(overflowEl);
      } else {
        const first = pieces[0];
        overflowEl.setAttribute("dur", first.dur);
        if (first.dots > 0) overflowEl.setAttribute("dots", String(first.dots));
        else overflowEl.removeAttribute("dots");
      }
    } else {
      /* Previous element exactly filled the measure — drop overflowEl. */
      this.orphanTiePartners(overflowEl);
      layer.removeChild(overflowEl);
    }
    for (let i = truncateAt + 1; i < kids.length; i++) {
      this.orphanTiePartners(kids[i]);
      layer.removeChild(kids[i]);
    }
  }

  /* ── private helpers ────────────────────────────────────────────────────── */

  /** Core insert with measure-overflow splitting. For chords with notes
   *  arr.length > 0, splits notes-identical pieces with ties; for rests
   *  (notes.length === 0), splits without ties. Returns null when an
   *  in-tuplet insert is rejected for overflow (cross-measure splits are
   *  never performed inside a tuplet — the tuplet is the unit of fit). */
  private insertWithSplit(
    input: {
      duration: Duration;
      dots?: Dots;
      notes: ReadonlyArray<ResolvedNote>;
    },
    isRest: boolean,
  ): string | null {
    const v = this.currentVoice;
    const cursor = this.cursors[v];
    let loc = this.locateCursor(v, cursor);
    if (!loc) throw new Error("no layer at cursor");

    /* In-tuplet branch: consume trailing placeholders to fit the new element.
       Never splits across measure boundaries — the tuplet's written-tick
       budget is fixed and any overflow rejects outright (returns null). */
    if (loc.inTuplet) {
      const totalTicks = ticksOf(input.duration, input.dots ?? 0);
      const { tuplet, tupletChildIdx } = loc.inTuplet;
      const tKids = Array.from(tuplet.children);
      /* Find the trailing placeholder run. Per the [filled*, placeholder*]
         invariant, placeholders are always contiguous at the tail. */
      let placeholderStart = tKids.length;
      for (let i = 0; i < tKids.length; i++) {
        if (isTupletPlaceholder(tKids[i])) {
          placeholderStart = i;
          break;
        }
      }
      let trailingTicks = 0;
      for (let i = placeholderStart; i < tKids.length; i++) {
        trailingTicks += writtenTicks(tKids[i]);
      }
      if (totalTicks > trailingTicks) return null; /* overflow — reject */

      const element = isRest
        ? this.buildRestElement({ duration: input.duration, dots: input.dots })
        : this.buildChordElement({
            notes: input.notes,
            duration: input.duration,
            dots: input.dots,
          });

      /* Remove all trailing placeholders. */
      for (let i = tKids.length - 1; i >= placeholderStart; i--) {
        tuplet.removeChild(tKids[i]);
      }
      /* Insert position: if the cursor was on the fill anchor (placeholder),
         insertion happens at the tail (= placeholderStart). If the cursor
         was on a filled child, insertion happens before that child. */
      const insertPos = Math.min(tupletChildIdx, placeholderStart);
      const remainingKids = Array.from(tuplet.children);
      const insertBefore = remainingKids[insertPos] ?? null;
      if (insertBefore) tuplet.insertBefore(element, insertBefore);
      else tuplet.appendChild(element);

      /* Refill placeholder remainder, preferring atomic-sized rests. */
      for (const p of this.regenTupletPlaceholders(
        tuplet,
        trailingTicks - totalTicks,
      )) {
        tuplet.appendChild(p);
      }

      this.cursors[v] = Math.min(this.cursors[v] + 1, this.getVoiceLength(v));
      return element.getAttribute("xml:id") ?? "";
    }

    /* No boundary-rule re-aim: extend-vs-enter is now resolved by the
       cursor's explicit position (fill-anchor of M_k vs wrapper of M_k+1). */
    const totalTicks = ticksOf(input.duration, input.dots ?? 0);
    const plan = this.planInsert(loc, totalTicks);
    if (!plan.ok) return null;

    /* Apply: lift evicted elements out of their source measures. The plan
       reports an eviction map (M_0's post-cursor, and M_1's existing
       content when overflow lands there). For the fast no-overflow path,
       evicted is empty and post-cursor stays in place — new pieces insert
       before it via insertAt's withinIdx. */
    for (const [m, els] of plan.evicted) {
      const measures = this.allMeasures();
      if (m >= measures.length) continue;
      const sourceLayer = this.layerInMeasure(measures[m], v);
      if (!sourceLayer) continue;
      for (const el of els) sourceLayer.removeChild(el);
    }

    /* Walk the plan, building/reusing elements at their target positions.
       withinByMeasure tracks the next insertion index per target measure;
       for the cursor's own measure it starts at loc.withinIdx (post-cursor
       was removed if overflow happened, else still there — applier inserts
       before), for any other measure it starts at 0 (post-eviction empty). */
    const withinByMeasure = new Map<number, number>();
    const insertedElements: Element[] = [];
    let firstInsertedElement: Element | null = null;

    for (const action of plan.actions) {
      let measures = this.allMeasures();
      while (action.targetMIdx >= measures.length) {
        this.appendMeasure();
        measures = this.allMeasures();
      }
      const targetLayer = this.layerInMeasure(measures[action.targetMIdx], v);
      if (!targetLayer) throw new Error("layer not found in target measure");
      const widx = withinByMeasure.get(action.targetMIdx) ??
        (action.targetMIdx === loc.measureIdx ? loc.withinIdx : 0);

      let placed: Element;
      if (action.kind === "inserted") {
        placed = isRest
          ? this.buildRestElement({ duration: action.dur, dots: action.dots })
          : this.buildChordElement({
              notes: input.notes,
              duration: action.dur,
              dots: action.dots,
            });
        insertedElements.push(placed);
        if (firstInsertedElement === null) firstInsertedElement = placed;
      } else {
        placed = action.el;
      }
      this.insertAt(targetLayer, placed, widx);
      withinByMeasure.set(action.targetMIdx, widx + 1);
    }

    /* Tie wiring on the inserted note's pieces (skipped for rests). We
     * only set the @tie INTENT on each piece (i for first, m for middle,
     * t for last); the @data-tie-partner forward links are derived by
     * normalizeTies from flat-order adjacency. */
    if (!isRest && insertedElements.length > 1) {
      for (let pi = 0; pi < insertedElements.length; pi++) {
        const innerNotes = this.extractNoteElements(insertedElements[pi]);
        const flag: "i" | "m" | "t" =
          pi === 0 ? "i" :
          pi === insertedElements.length - 1 ? "t" : "m";
        for (const n of innerNotes) setTieFlag(n, flag);
      }
    }

    this.setBarlines();
    /* Position the cursor just past the last inserted-from-input element.
       Under the new cursor-index convention (cursor c = past flat[c]),
       "past the last inserted element flat[idx]" is c = idx. */
    if (insertedElements.length > 0) {
      const lastInserted = insertedElements[insertedElements.length - 1];
      const lastId = lastInserted.getAttribute('xml:id');
      if (lastId) {
        const flat = this.flatChildren(v);
        const idx = flat.findIndex((e) => e.getAttribute('xml:id') === lastId);
        if (idx >= 0) this.cursors[v] = idx;
      }
    }
    return firstInsertedElement?.getAttribute("xml:id") ?? "";
  }

  /** Plan a layer-level insert with BOUNDED overflow into the immediate
   *  next measure (M_1 = loc.measureIdx + 1) only. Never cascades past
   *  M_1. The "displace everything if there is space" rule: M_1's
   *  existing content gets shifted right within M_1 to make room for the
   *  overflowed inserted-pieces and M_0 post-cursor items, as long as the
   *  combined load fits within M_1's tick cap.
   *
   *  Rules:
   *   - Fast path (no overflow): inserted fits in M_0 alongside pre-cursor
   *     content + post-cursor items. Emit only `inserted` actions; the
   *     applier inserts them at loc.withinIdx and existing post-cursor
   *     items stay put. No evictions.
   *   - Overflow path: inserted-note pieces split on the M_0/M_1 bar line;
   *     M_0 post-cursor items pack after the inserted pieces, potentially
   *     spilling into M_1; M_1's existing content (lifted) packs after.
   *     If anything would extend past M_1's cap, block.
   *   - Tuplets in the displaced stream are atomic (placed wholesale).
   *   - Past-end / non-existent M_1: handled by the applier's
   *     `appendMeasure` loop; postM1 is empty in that case.
   *   - In-tuplet insertions are handled by `insertWithSplit`'s in-tuplet
   *     branch BEFORE planInsert is reached; planInsert never sees them. */
  private planInsert(
    loc: { measureIdx: number; layer: Element; withinIdx: number },
    totalTicks: number,
  ): { ok: true; actions: InsertAction[]; evicted: Map<number, Element[]> } | { ok: false; reason: string } {
    const v = this.currentVoice;
    const cap = this.measureTicks();
    const layers = this.allLayers(v);
    const M0 = loc.measureIdx;
    const W0 = loc.withinIdx;
    const usedBefore = this.timeWithinMeasure(v, M0, W0);
    const postCursorM0 = this.contentChildren(loc.layer).slice(W0);

    let postCursorTicks = 0;
    for (const el of postCursorM0) postCursorTicks += realTicks(el);

    const evicted = new Map<number, Element[]>();
    const actions: InsertAction[] = [];

    /* Fast path: everything fits in M_0. No eviction; new pieces insert
       at loc.withinIdx and post-cursor stays put (applier's insertAt puts
       new pieces BEFORE existing post-cursor). */
    if (usedBefore + totalTicks + postCursorTicks <= cap) {
      const insertedRecorded: Array<Extract<InsertAction, { kind: 'inserted' }>> = [];
      for (const p of decomposeTicks(totalTicks)) {
        const a: Extract<InsertAction, { kind: 'inserted' }> = {
          kind: 'inserted',
          dur: p.dur,
          dots: p.dots,
          targetMIdx: M0,
          pieceIdx: insertedRecorded.length,
          pieceCount: 0,
        };
        insertedRecorded.push(a);
        actions.push(a);
      }
      for (const a of insertedRecorded) a.pieceCount = insertedRecorded.length;
      return { ok: true, actions, evicted };
    }

    /* Overflow path. Determine M_1 and its existing content (if any). */
    const M1 = M0 + 1;
    let postM1: Element[] = [];
    if (M1 < layers.length) {
      postM1 = this.contentChildren(layers[M1]);
    }
    let postM1Ticks = 0;
    for (const el of postM1) postM1Ticks += realTicks(el);

    /* Early budget check: combined load must fit in M_0 + M_1. */
    if (usedBefore + totalTicks + postCursorTicks + postM1Ticks > 2 * cap) {
      return { ok: false, reason: "Doesn't fit in next measure." };
    }

    evicted.set(M0, postCursorM0);
    if (postM1.length > 0) evicted.set(M1, postM1);

    /* Place inserted-note pieces, splitting on the M_0/M_1 bar line. Never
       crosses into M_1+1 (block on overflow). */
    const insertedRecorded: Array<Extract<InsertAction, { kind: 'inserted' }>> = [];
    let mIdx = M0;
    let mOff = usedBefore;
    let insertedRemaining = totalTicks;
    while (insertedRemaining > 0) {
      const space = cap - mOff;
      const chunk = Math.min(insertedRemaining, space);
      if (chunk > 0) {
        for (const p of decomposeTicks(chunk)) {
          const a: Extract<InsertAction, { kind: 'inserted' }> = {
            kind: 'inserted',
            dur: p.dur,
            dots: p.dots,
            targetMIdx: mIdx,
            pieceIdx: insertedRecorded.length,
            pieceCount: 0,
          };
          insertedRecorded.push(a);
          actions.push(a);
        }
        mOff += chunk;
        insertedRemaining -= chunk;
      }
      if (insertedRemaining > 0) {
        if (mIdx >= M1) {
          return { ok: false, reason: "Doesn't fit in next measure." };
        }
        mIdx = M1;
        mOff = 0;
      }
    }
    for (const a of insertedRecorded) a.pieceCount = insertedRecorded.length;

    /* Pack the displaced stream (M_0 post-cursor + M_1 existing) wholesale.
       Tuplets are atomic — either fit in the current target measure or
       bump to M_1; bump beyond M_1 is the block condition. */
    const displaced = [...postCursorM0, ...postM1];
    for (const el of displaced) {
      const t = realTicks(el);
      if (t > cap) {
        return {
          ok: false,
          reason: el.localName === 'tuplet'
            ? 'Tuplet too large for measure.'
            : "Doesn't fit.",
        };
      }
      if (mOff + t > cap) {
        if (mIdx >= M1) {
          return { ok: false, reason: "Doesn't fit in next measure." };
        }
        mIdx = M1;
        mOff = 0;
      }
      actions.push({ kind: 'reuse', el, targetMIdx: mIdx });
      mOff += t;
    }

    return { ok: true, actions, evicted };
  }

  /** Sum of writtenTicks of placeholders inside a tuplet (the unfilled
   *  budget). Used by tuplet-aware insertion/replacement to decide fit. */
  private tupletPlaceholderTicks(tuplet: Element): number {
    let t = 0;
    for (const c of Array.from(tuplet.children)) {
      if (isTupletPlaceholder(c)) t += writtenTicks(c);
    }
    return t;
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
    const chord = el(doc, "chord", {
      "xml:id": newId("c"),
      dur,
      dots: dots > 0 ? dots : undefined,
    });
    const sorted = [...input.notes].sort((a, b) => a.midi - b.midi);
    for (const n of sorted)
      chord.appendChild(
        this.buildNoteElement(n, dur, dots, /* inChord */ true),
      );
    return chord;
  }

  private buildNoteElement(
    n: ResolvedNote,
    dur: Duration,
    dots: Dots,
    inChord = false,
  ): Element {
    const attrs: Record<string, string | number | undefined> = {
      "xml:id": newId("n"),
      pname: n.pname,
      oct: n.oct,
      color: n.colorHex,
      "data-q": n.q,
      "data-r": n.r,
    };
    if (!inChord) {
      attrs.dur = dur;
      if (dots > 0) attrs.dots = dots;
    }
    /* Accidental: emit a single canonical MEI token (s/f/x/ff/ts/tf or
       'n' for explicit natural). HKL count-form string is parsed to an
       integer alter; values outside ±3 should never arrive here (entry
       path filters them) but we clamp to ±3 defensively just in case. */
    if (n.accid === "n") {
      attrs.accid = "n";
    } else {
      const token = tokenFromAlter(alterFromCount(n.accid));
      if (token) attrs.accid = token;
    }
    return el(this.doc, "note", attrs);
  }

  private buildRestElement(input: RestInput): Element {
    return el(this.doc, "rest", {
      "xml:id": newId("r"),
      dur: input.duration,
      dots: input.dots && input.dots > 0 ? input.dots : undefined,
    });
  }

  /** Build a single tuplet-internal placeholder: a `<rest>` with the
   *  `data-tuplet-placeholder="true"` marker. Verovio draws the bracket
   *  over these (because rests count as content) but renders the rest
   *  glyph too. We hide that glyph in CSS via the data attribute (which is
   *  propagated to the SVG by `svgAdditionalAttribute` in render.ts).
   *  MEI's @visible="false" would be the spec-correct way, but Verovio
   *  doesn't honor it on rests (rism-digital/verovio#202, still open). */
  private buildTupletPlaceholder(dur: Duration, dots: Dots = 0): Element {
    const sp = el(this.doc, "rest", {
      "xml:id": newId("sp"),
      dur,
      dots: dots > 0 ? dots : undefined,
    });
    sp.setAttribute(TUPLET_PLACEHOLDER_ATTR, "true");
    return sp;
  }

  /** Regenerate the trailing placeholders of a tuplet to cover
   *  `remainingTicks` written ticks. Prefers N atomic-sized rests (per the
   *  tuplet's recorded `data-tuplet-atomic-dur`) so that fill+delete is
   *  perfectly reversible; falls back to `decomposeTicks` for any awkward
   *  leftover (e.g. a written-dotted-8th inserted into a triplet-of-8ths
   *  leaves 4 of 12 ticks not divisible by atomic). Returns built elements
   *  for the caller to append. */
  private regenTupletPlaceholders(
    tuplet: Element,
    remainingTicks: number,
  ): Element[] {
    const out: Element[] = [];
    if (remainingTicks <= 0) return out;
    const atomicDurStr = tuplet.getAttribute(
      "data-tuplet-atomic-dur",
    ) as Duration | null;
    let r = remainingTicks;
    if (atomicDurStr) {
      const atomicTicks = ticksOf(atomicDurStr, 0);
      while (r >= atomicTicks) {
        out.push(this.buildTupletPlaceholder(atomicDurStr, 0));
        r -= atomicTicks;
      }
    }
    if (r > 0) {
      for (const p of decomposeTicks(r)) {
        out.push(this.buildTupletPlaceholder(p.dur, p.dots));
      }
    }
    return out;
  }

  private extractNoteElements(elem: Element): Element[] {
    if (elem.localName === "note") return [elem];
    if (elem.localName === "chord") {
      return Array.from(elem.children).filter((c) => c.localName === "note");
    }
    return [];
  }

  private extractResolvedFromElement(elem: Element): ResolvedNote[] {
    const noteEls = this.extractNoteElements(elem);
    return noteEls.map((n) => {
      const q = parseInt(n.getAttribute("data-q") ?? "0", 10);
      const r = parseInt(n.getAttribute("data-r") ?? "0", 10);
      const pname = (n.getAttribute("pname") ?? "c") as ResolvedNote["pname"];
      /* Reconstruct the count-form accidental string from whatever form the
         note carries (@accid attr, @accid.ges, or <accid> children). */
      const alter = getNoteAlter(n);
      const accid =
        alter === 0 ? "" : (alter > 0 ? "s" : "f").repeat(Math.abs(alter));
      const oct = parseInt(n.getAttribute("oct") ?? "4", 10);
      const colorHex = n.getAttribute("color") ?? "#000000";
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
      const t = n.getAttribute("tie");
      return t === "i" || t === "m";
    });
  }

  /** True when any inner note has an incoming tie ('t' or 'm'). */
  private elementHasTieTerminal(elem: Element): boolean {
    const notes = this.extractNoteElements(elem);
    return notes.some((n) => {
      const t = n.getAttribute("tie");
      return t === "t" || t === "m";
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
    && a.getAttribute('oct') === b.getAttribute('oct')
    && getNoteAlter(a) === getNoteAlter(b);
}

/* ── chord input builder from bridge held-keys ──────────────────────────── */

export function buildChordInput(
  resolvedNotes: ReadonlyArray<ResolvedNote>,
  duration: Duration,
  dots: Dots = 0,
): ChordInput {
  return { notes: resolvedNotes, duration, dots };
}
