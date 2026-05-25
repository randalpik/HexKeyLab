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

import type { ResolvedNote } from '../../bridge/protocol.js';
import { regroupBeams, readTimeSig } from '../notation/beams.js';
import { decomposeBeatAlignedRests } from './restfill.js';
import { computeAccidentalDisplay, alterFromCount, alterFromToken, tokenFromAlter, getNoteAlter } from '../notation/accidentals.js';
import { ensureExpressionDefaults, getLayoutReq, setLayoutReq, type LayoutReq, type Moment } from '../expressions.js';
import type { TuningMode } from '../../shared/freq.js';
import { realTicks, writtenTicks } from './ticks.js';
import {
  buildChordElement,
  buildNoteElement,
  buildRestElement,
  buildTupletPlaceholder,
  regenTupletPlaceholders,
  extractNoteElements,
  extractResolvedFromElement,
  elementHasTieInitial,
  elementHasTieTerminal,
} from './note-elements.js';
import { isPlaceholder, normalizePlaceholders } from './placeholders.js';
import {
  flatChildren as flatChildrenImpl,
  layerIsFull,
  shouldEmitWrapper,
  layerStops,
  tupletNavStops,
  locateCursor,
  locationForAnchor,
  measureStopCount,
  locateFlatElement,
  type CursorLocation,
} from './cursor-location.js';
import { normalizeTies, setTieFlag, clearTieFlag } from './ties.js';
import {
  isCursorInTuplet as isCursorInTupletImpl,
  cursorTupletRemainingWrittenTicks as cursorTupletRemainingWrittenTicksImpl,
  canInsertHere as canInsertHereImpl,
  createTupletAtCursor as createTupletAtCursorImpl,
} from './tuplet-ops.js';
import {
  planInsert,
  insertWithSplit,
  insertAt,
} from './insertion-plan.js';
import {
  clearBeatRange as clearBeatRangeImpl,
  clearMeasureRange as clearMeasureRangeImpl,
} from './measure-ops.js';

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

/** Custom attribute marking an element inside a <tuplet> that represents
 *  unfilled written-ticks (the "fill anchor" chain). Distinct from the
 *  measure-level PLACEHOLDER_ATTR — these live as direct children of
 *  <tuplet>, never of <layer>. Concretely the element is
 *  `<rest visible="false">` (Verovio reserves layout width AND draws the
 *  tuplet bracket over it, while suppressing the rest glyph). */
export const TUPLET_PLACEHOLDER_ATTR = 'data-tuplet-placeholder';

/** Element-name-agnostic tuplet-placeholder predicate. Matches the canonical
 *  `<rest visible="false" data-tuplet-placeholder="true">` form as well as
 *  any legacy `<space data-tuplet-placeholder="true">` that might survive
 *  in older docs. */
export function isTupletPlaceholder(el: Element): boolean {
  return el.getAttribute(TUPLET_PLACEHOLDER_ATTR) === 'true';
}

export function el(doc: Document, name: string, attrs?: Record<string, string | number | undefined>): Element {
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
export function newId(prefix: string): string {
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
    normalizePlaceholders(this.doc, this.measureTicks());
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
    normalizeTies(this);
    normalizePlaceholders(this.doc, this.measureTicks());
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
    normalizeTies(this);
    normalizePlaceholders(this.doc, this.measureTicks());
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
    normalizeTies(this);
    normalizePlaceholders(this.doc, this.measureTicks());
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
      if (lastLayer && layerIsFull(this, lastLayer)) return flatLen - 1;
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
    const loc = locateCursor(this, v, this.cursors[v]);
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
      const emit = shouldEmitWrapper(this, measures, voice, mi);
      consumed += measureStopCount(this, measures, voice, mi, layer, emit);
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
    const loc = locateCursor(this, voice, c);
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
    const loc = locateCursor(this, voice, c);
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
      normalizeTies(this);
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
  layerInMeasure(measure: Element, voice: Voice): Element | null {
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
  allLayers(voice: Voice): Element[] {
    const out: Element[] = [];
    for (const m of this.allMeasures()) {
      const l = this.layerInMeasure(m, voice);
      if (l) out.push(l);
    }
    return out;
  }

  /** Flat navigable children across all measures for voice. See
   *  cursor-location.ts for the stop-emission rules. */
  flatChildren(voice: Voice): Element[] {
    return flatChildrenImpl(this, voice);
  }

  /** Cumulative ticks for `voice` BEFORE its `withinIdx`-th content child
   *  in measure `measureIdx`. */
  timeWithinMeasure(
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
  contentChildren(layer: Element): Element[] {
    return Array.from(layer.children).filter(
      (c) =>
        c.localName === "chord" ||
        c.localName === "note" ||
        c.localName === "rest" ||
        c.localName === "tuplet",
    );
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
    return this.setVoicePreservingMeasure(next);
  }

  /** Switch the active voice to `tgtV` while preserving the cursor's visual
   *  measure index and within-measure tick offset. The placeholder invariant
   *  (every voice has at least one cursor stop per measure) guarantees a valid
   *  target landing exists.
   *
   *  Replaces the legacy time-based translation (`getTimeAt` +
   *  `findCursorAtOrBefore`) which silently flipped measures at wrapper-stop
   *  boundaries: zero-tick wrappers alias with "past last content of prev
   *  measure," so absolute-tick equality is structurally ambiguous and the
   *  off-by-one accounting in `findCursorAtOrBefore` resolved it to whichever
   *  measure came first in the target voice's flat stream — usually the wrong
   *  one when the two voices had different content shapes. */
  setVoicePreservingMeasure(tgtV: Voice): Voice {
    const srcV = this.currentVoice;
    if (srcV === tgtV) return tgtV;
    const measures = this.allMeasures();
    if (measures.length === 0) {
      this.setVoice(tgtV);
      return tgtV;
    }
    const srcMeasure = this.cursorMeasureIdx(srcV);
    const mTicks = this.measureTicks();
    const srcAbs = this.getCursorAbsoluteTicks(srcV);
    const within = srcAbs - srcMeasure * mTicks;
    this.setVoice(tgtV);
    let cand = this.findCursorByTickPosition(tgtV, srcMeasure * mTicks + within);
    if (this.cursorVisualMeasureAtIndex(tgtV, cand, "insert") !== srcMeasure) {
      cand = this.getFirstVisualCursorInMeasure(tgtV, srcMeasure, "insert");
    }
    this.setCursor(cand, tgtV);
    return tgtV;
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
      layer.appendChild(buildRestElement(this.doc, { duration: r.dur, dots: r.dots }));
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
    const loc = locateCursor(this, voice, cursor);
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

  isCursorInTuplet(voice?: Voice): boolean {
    return isCursorInTupletImpl(this, voice);
  }

  cursorTupletRemainingWrittenTicks(voice?: Voice): number | null {
    return cursorTupletRemainingWrittenTicksImpl(this, voice);
  }

  canInsertHere(
    duration: Duration,
    dots: Dots = 0,
  ): { ok: true } | { ok: false; reason: string } {
    return canInsertHereImpl(this, duration, dots);
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
    return createTupletAtCursorImpl(this, opts);
  }

  /** Insert a chord at the current voice's cursor; advances cursor. May
   *  split across measure boundaries with ties. Returns the first new
   *  element's xml:id, or null when an in-tuplet insert was rejected for
   *  overflow. */
  insertChordAtCursor(input: ChordInput): string | null {
    const v = this.currentVoice;
    const originalCursor = this.cursors[v];
    const id = insertWithSplit(this, input, false);
    if (id === null) return null;
    this.resolvePendingTies(originalCursor);
    normalizePlaceholders(this.doc, this.measureTicks());
    this.cursors[v] = Math.min(this.cursors[v], this.getVoiceLength(v));
    return id;
  }

  /** Insert a rest at the current voice's cursor; advances cursor. May
   *  split across measure boundaries (no ties on rests). Inserting a rest
   *  does NOT resolve a pending tie (a rest has no matching pitch). */
  insertRestAtCursor(input: RestInput): string | null {
    const v = this.currentVoice;
    const id = insertWithSplit(this, 
      { ...input, notes: [] as ReadonlyArray<ResolvedNote> },
      true,
    );
    if (id === null) return null;
    normalizeTies(this);
    normalizePlaceholders(this.doc, this.measureTicks());
    this.cursors[v] = Math.min(this.cursors[v], this.getVoiceLength(v));
    return id;
  }

  /** Look up a `<note>` element by its xml:id, scanning all voices. Returns
   *  null when not present. Used by chord-internal selection operations.
   *  Uses a linear scan rather than querySelector with the `xml\\:id`
   *  attribute escape, which has had cross-environment quirks in testing. */
  private findNoteByIdAnywhere(noteId: string): Element | null {
    const notes = this.doc.querySelectorAll("note");
    for (const n of Array.from(notes)) {
      if (n.getAttribute("xml:id") === noteId) return n;
    }
    return null;
  }

  /** Delete a single `<note>` from its parent `<chord>`. The chord must
   *  exist as the note's parent and must have ≥2 note children (the typical
   *  invariant for a Composer-emitted chord). Behavior:
   *
   *    - Drops to ≥2 notes remaining: just removes the note child. Returns
   *      { collapsed: false, survivorId: null }.
   *    - Drops to 1 note remaining: collapses the chord wrapper to a bare
   *      `<note>` in the parent layer. The chord's @dur/@dots transfer to
   *      the survivor; @tie/@data-* on the chord wrapper are not used in
   *      Composer's emission so are not transferred. The survivor's xml:id
   *      is preserved (caller can migrate the chord-internal selection to
   *      it). Returns { collapsed: true, survivorId: <survivor xml:id> }.
   *
   *  Returns null when the note isn't a chord-child (caller should fall
   *  back to deleteAtCursor for bare-note deletion). After mutation:
   *  setBarlines + normalizeTies + normalizePlaceholders. Cursor untouched —
   *  the chord wrapper / bare-note replacement stays at the same flat index.
   */
  deleteNoteInChord(
    noteId: string,
  ): { collapsed: boolean; survivorId: string | null } | null {
    const note = this.findNoteByIdAnywhere(noteId);
    if (!note) return null;
    const chord = note.parentElement;
    if (!chord || chord.localName !== "chord") return null;
    const noteChildren = Array.from(chord.children).filter(
      (c) => c.localName === "note",
    );
    if (noteChildren.length < 2) return null;

    chord.removeChild(note);

    const remaining = Array.from(chord.children).filter(
      (c) => c.localName === "note",
    );
    let collapsed = false;
    let survivorId: string | null = null;
    if (remaining.length === 1) {
      /* Collapse: transfer @dur/@dots from chord wrapper to the surviving
         <note>, replace the wrapper with the note in the layer. */
      const survivor = remaining[0];
      const dur = chord.getAttribute("dur");
      const dots = chord.getAttribute("dots");
      if (dur) survivor.setAttribute("dur", dur);
      if (dots) survivor.setAttribute("dots", dots);
      const layer = chord.parentElement;
      if (layer) {
        layer.replaceChild(survivor, chord);
      }
      collapsed = true;
      survivorId = survivor.getAttribute("xml:id");
    }

    this.setBarlines();
    normalizeTies(this);
    normalizePlaceholders(this.doc, this.measureTicks());
    return { collapsed, survivorId };
  }

  /** Append `held` notes to the chord (or bare-note → chord) containing
   *  `anchorNoteId`. Used by chord-extend in INS mode. Behavior:
   *
   *    - Anchor is a chord-child note: appends each non-duplicate as a
   *      `<note>` child (inheriting chord wrapper's @dur/@dots). Re-sorts
   *      ascending by MIDI.
   *    - Anchor is a bare `<note>`: builds a new `<chord>` wrapper inheriting
   *      the bare note's @dur/@dots (stripped from the note), moves the
   *      original note into the wrapper, appends non-duplicates, sorts. The
   *      original note's xml:id is preserved (caller may keep its selection).
   *
   *  Duplicate predicate: `(q, r)` equality with any existing note in the
   *  chord (or with the bare-note anchor itself). Returns the added
   *  `<note>` xml:ids in MIDI-ascending order, plus the count of skipped
   *  duplicates. Returns null when the anchor isn't found or has no (q, r). */
  appendNotesToSelection(
    anchorNoteId: string,
    held: ReadonlyArray<ResolvedNote>,
  ): { addedIds: string[]; skipped: number } | null {
    const anchor = this.findNoteByIdAnywhere(anchorNoteId);
    if (!anchor) return null;
    const parent = anchor.parentElement;
    if (!parent) return null;

    /* Determine the chord wrapper (creating one on bare-note promotion). */
    let chord: Element;
    if (parent.localName === "chord") {
      chord = parent;
    } else if (parent.localName === "layer") {
      /* Promote bare note → chord. Build a fresh wrapper with the bare
         note's @dur/@dots, strip them off the note, place it as the
         wrapper's first child, then put the wrapper where the note was. */
      const dur = anchor.getAttribute("dur");
      const dots = anchor.getAttribute("dots");
      if (!dur) return null;
      chord = el(this.doc, "chord", {
        "xml:id": newId("c"),
        dur,
        dots: dots && parseInt(dots, 10) > 0 ? dots : undefined,
      });
      anchor.removeAttribute("dur");
      anchor.removeAttribute("dots");
      parent.insertBefore(chord, anchor);
      parent.removeChild(anchor);
      chord.appendChild(anchor);
    } else {
      return null;
    }

    /* Duplicate predicate over (q, r). Existing notes' coords come from
       data-q/data-r; held notes carry q/r directly. */
    const existingKeys = new Set<string>();
    for (const child of Array.from(chord.children)) {
      if (child.localName !== "note") continue;
      const q = child.getAttribute("data-q");
      const r = child.getAttribute("data-r");
      if (q !== null && r !== null) existingKeys.add(q + "," + r);
    }

    const addedIds: string[] = [];
    let skipped = 0;
    const dur = chord.getAttribute("dur") as Duration | null;
    if (!dur) return null;
    const dotsAttr = chord.getAttribute("dots");
    const dots: Dots = (dotsAttr ? (parseInt(dotsAttr, 10) as Dots) : 0);

    for (const k of held) {
      const key = k.q + "," + k.r;
      if (existingKeys.has(key)) {
        skipped++;
        continue;
      }
      existingKeys.add(key);
      const noteEl = buildNoteElement(this.doc, k, dur, dots, /* inChord */ true);
      chord.appendChild(noteEl);
      const id = noteEl.getAttribute("xml:id");
      if (id) addedIds.push(id);
    }

    /* Re-sort chord's note children by MIDI ascending. */
    if (addedIds.length > 0) {
      const noteChildren = Array.from(chord.children).filter(
        (c) => c.localName === "note",
      );
      const nonNotes = Array.from(chord.children).filter(
        (c) => c.localName !== "note",
      );
      const sortKey = (n: Element): number => {
        const q = parseInt(n.getAttribute("data-q") ?? "0", 10);
        const r = parseInt(n.getAttribute("data-r") ?? "0", 10);
        return 57 + 4 * q + 7 * r;
      };
      const sorted = noteChildren.slice().sort((a, b) => sortKey(a) - sortKey(b));
      for (const n of noteChildren) chord.removeChild(n);
      for (const n of sorted) chord.appendChild(n);
      for (const o of nonNotes) chord.appendChild(o);
    }

    this.setBarlines();
    normalizeTies(this);
    normalizePlaceholders(this.doc, this.measureTicks());
    return { addedIds, skipped };
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
  /** Backwards-compatible alias used by call sites that still expect a
   *  pre-deletion / post-mutation cleanup hook. With the unified
   *  `normalizeTies`, both are the same operation: run AFTER the
   *  structural mutation completes. Callers that previously ran
   *  `orphanTiePartners(elem)` BEFORE removing `elem` now just remove
   *  the element and call `normalizeTies()` — the normalization picks up
   *  the survivors correctly because intent lives on the surviving notes,
   *  not in cross-references pointing AT the deleted note. */
  orphanTiePartners(_elem: Element): void {
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
    normalizeTies(this);
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
        const replaced = buildChordElement(this.doc, input);
        tuplet.appendChild(replaced);
        for (const p of regenTupletPlaceholders(this.doc, 
          tuplet,
          trailingTicks - newTicks,
        )) {
          tuplet.appendChild(p);
        }
        this.resolvePendingTies(cursorAtCall);
        normalizePlaceholders(this.doc, this.measureTicks());
            return replaced.getAttribute("xml:id");
      }

      /* Replace a filled tuplet child. Tick delta absorbs into trailing
         placeholders (grow if shrinking, consume if growing). */
      const oldTicks = writtenTicks(target);
      const delta = newTicks - oldTicks;
      if (delta > trailingTicks) return null;
      this.orphanTiePartners(target);
      const replaced = buildChordElement(this.doc, input);
      tuplet.replaceChild(replaced, target);
      for (const c of Array.from(tuplet.children)) {
        if (isTupletPlaceholder(c)) tuplet.removeChild(c);
      }
      for (const p of regenTupletPlaceholders(this.doc, 
        tuplet,
        trailingTicks - delta,
      )) {
        tuplet.appendChild(p);
      }
      this.resolvePendingTies(cursorAtCall);
      normalizePlaceholders(this.doc, this.measureTicks());
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
      const id = insertWithSplit(this, input, false);
      this.cursors[v] = cursorAtCall;
      this.resolvePendingTies(cursorAtCall);
      normalizePlaceholders(this.doc, this.measureTicks());
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
      const replaced = buildChordElement(this.doc, input);
      layer.replaceChild(replaced, target);
      this.resolvePendingTies(cursorAtCall);
      normalizePlaceholders(this.doc, this.measureTicks());
        return replaced.getAttribute("xml:id");
    }
    /* Overflow on replace: remove old, run the planning insertWithSplit
       (which handles displacement of any remaining post-cursor content),
       restore cursor to its pre-replace position. */
    this.orphanTiePartners(target);
    layer.removeChild(target);
    this.cursors[v] = Math.max(0, cursorAtCall - 1);
    const id = insertWithSplit(this, input, false);
    this.cursors[v] = cursorAtCall;
    this.resolvePendingTies(cursorAtCall);
    normalizePlaceholders(this.doc, this.measureTicks());
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
          normalizeTies(this);
          normalizePlaceholders(this.doc, this.measureTicks());
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
        normalizeTies(this);
        normalizePlaceholders(this.doc, this.measureTicks());
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
        normalizePlaceholders(this.doc, this.measureTicks());
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
      for (const p of regenTupletPlaceholders(this.doc, 
        tupletParent,
        trailingTicks + oldTicks,
      )) {
        tupletParent.appendChild(p);
      }
      this.cursors[v] = Math.max(0, c - 1);
      this.setBarlines();
      normalizeTies(this);
      normalizePlaceholders(this.doc, this.measureTicks());
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
    normalizeTies(this);
    normalizePlaceholders(this.doc, this.measureTicks());
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
    clearBeatRangeImpl(this, voice, tLoAbs, tHiAbs);
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
    normalizeTies(this);
    normalizePlaceholders(this.doc, this.measureTicks());
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
      const notes = extractResolvedFromElement(src);
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
      const loc = locateCursor(this, v, this.cursors[v]);
      if (!loc || loc.inTuplet) return false;
      const tupletTicks = realTicks(src);
      const used = this.timeWithinMeasure(v, loc.measureIdx, loc.withinIdx);
      if (used + tupletTicks > this.measureTicks() + 1e-6) return false;
      /* Clone into our doc with fresh ids. */
      const fresh = src.cloneNode(true) as Element;
      this.regenerateIds(fresh);
      insertAt(this, loc.layer, fresh, loc.withinIdx);
      /* Advance cursor past the tuplet's contributed flat stops. The simplest
         way is to compute the new cursor via tstamp lookup. */
      const newTstamp = this.getCursorAbsoluteTicks(v) + tupletTicks;
      normalizePlaceholders(this.doc, this.measureTicks());
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
    normalizeTies(this);
    normalizePlaceholders(this.doc, this.measureTicks());
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
    clearMeasureRangeImpl(this, mLo, mHi, firstStaff, lastStaff);
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
      for (const p of regenTupletPlaceholders(this.doc, 
        enclosingTuplet,
        trailingTicks - delta,
      )) {
        enclosingTuplet.appendChild(p);
      }
      normalizePlaceholders(this.doc, this.measureTicks());
        return { id: ref.id, newDots: nextDots };
    }

    /* Determine fit within current measure. */
    const loc = locateCursor(this, v, ref.index);
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
      normalizePlaceholders(this.doc, this.measureTicks());
        return { id: ref.id, newDots: nextDots };
    }

    /* Overflow: replace element with a split chain. Preserve pitches
       (for chord/note) so the chain remains pitch-identical. */
    let chordInput: ChordInput | null = null;
    let restInput: RestInput | null = null;
    if (isRest) {
      restInput = { duration: dur, dots: nextDots };
    } else {
      const notes = extractResolvedFromElement(elem);
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
      firstId = insertWithSplit(this, { ...restInput, notes: [] }, true);
    else if (chordInput) firstId = insertWithSplit(this, chordInput, false);
    /* insertWithSplit leaves the cursor at the index of the last inserted
       piece (= past the last chain element). For insert mode that's the
       right "just-entered the chain" position; for overwrite we want the
       cursor selecting the CHAIN HEAD, which sits at the same flat-index
       the original element occupied — i.e., back at `ref.index`. */
    if (mode === "overwrite") {
      this.cursors[v] = ref.index;
    }
    normalizePlaceholders(this.doc, this.measureTicks());
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
    const allNotes = extractNoteElements(ref.elem);
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

    normalizeTies(this);
    normalizePlaceholders(this.doc, this.measureTicks());
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
    normalizePlaceholders(this.doc, this.measureTicks());
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



  /** Sum of writtenTicks of placeholders inside a tuplet (the unfilled
   *  budget). Used by tuplet-aware insertion/replacement to decide fit. */
  private tupletPlaceholderTicks(tuplet: Element): number {
    let t = 0;
    for (const c of Array.from(tuplet.children)) {
      if (isTupletPlaceholder(c)) t += writtenTicks(c);
    }
    return t;
  }


}

/* ── helpers (module-scope) ──────────────────────────────────────────────── */


/* ── chord input builder from bridge held-keys ──────────────────────────── */

export function buildChordInput(
  resolvedNotes: ReadonlyArray<ResolvedNote>,
  duration: Duration,
  dots: Dots = 0,
): ChordInput {
  return { notes: resolvedNotes, duration, dots };
}
