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
import { ensureExpressionDefaults, type Moment } from './expressions.js';
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

  getCurrentVoice(): Voice {
    return this.currentVoice;
  }

  getCursor(voice?: Voice): number {
    return this.cursors[voice ?? this.currentVoice];
  }

  /** Voice length = number of reachable cursor positions, where
   *  `cursor === flatChildren.length` is the past-end synthetic stop
   *  ("wrapper of the not-yet-existent next measure"). Input at past-end
   *  lazily creates a new measure via `insertWithSplit`'s `appendMeasure`
   *  path. `moveCursor`'s `c < len` lets the cursor reach `len`, so
   *  past-end is `cursor = voiceLen` (NOT one beyond — no +1 here). */
  getVoiceLength(voice?: Voice): number {
    return this.flatChildren(voice ?? this.currentVoice).length;
  }

  /** True iff this voice's cursor is at the past-end synthetic stop. */
  isCursorAtPastEnd(voice?: Voice): boolean {
    const v = voice ?? this.currentVoice;
    return this.cursors[v] === this.flatChildren(v).length;
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

  /** Returns the "current" element in the flat stream given the active mode.
   *  - insert:    element at index `cursor - 1`. Null when cursor === 0.
   *  - overwrite: element at index `cursor`. Null when cursor === voiceLen.
   *
   *  This is the single source of truth used by cursor positioning, dot
   *  cycling, and tie toggling. */
  getCurrentElement(voice: Voice, mode: "insert" | "overwrite"): CurrentRef {
    const flat = this.flatChildren(voice);
    const cursor = this.cursors[voice];
    let idx: number;
    if (mode === "insert") {
      if (cursor === 0) return null;
      idx = cursor - 1;
    } else {
      if (cursor >= flat.length) return null;
      idx = cursor;
    }
    const elem = flat[idx];
    if (!elem) return null;
    const id = elem.getAttribute("xml:id");
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
      this.truncateOverflowingMeasures();
      this.autofillAllAndReanchor(this.currentVoice);
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
      /* Fill-anchor: first layer-level placeholder. Two emission rules
         (mirrors the tuplet model where useful, falls back to wrapper-only
         when the fill-anchor would visually collide with the wrapper):
           - Partial layer (has both content AND placeholder): always emit.
             Carries the "extend this measure" intent distinct from the
             wrapper's "enter this measure" intent.
           - Empty layer: emit only when the PREVIOUS measure has content
             in this voice — that's the case where the post-prev navigation
             stop (= the wrapper) must remain distinct from the explicit
             empty-measure delete stop (= the fill-anchor). Otherwise emit
             only the wrapper (deletion still works — `deleteAtCursor` case 2
             falls back to wrapper-based delete when no fill-anchor is
             emitted for that empty measure). */
      const cc = this.contentChildren(layer);
      const firstPh = Array.from(layer.children).find(isPlaceholder);
      if (firstPh) {
        if (cc.length > 0) {
          out.push(firstPh);
        } else if (this.emptyFillAnchorEmitted(measures, voice, mi)) {
          out.push(firstPh);
        }
      }
    }
    return out;
  }

  /** Whether to emit a fill-anchor stop for the empty layer at this
   *  (voice, measureIdx). True iff the doc has multiple measures AND the
   *  previous measure has content in this voice — i.e., the wrapper of
   *  this empty measure also serves as a "post-prev" navigation stop that
   *  must NOT trigger deletion. In all other empty cases the wrapper is
   *  the only stop and itself serves as the delete target. */
  private emptyFillAnchorEmitted(
    measures: Element[],
    voice: Voice,
    measureIdx: number,
  ): boolean {
    if (measures.length <= 1) return false;
    if (measureIdx === 0) return false;
    const prevLayer = this.layerInMeasure(measures[measureIdx - 1], voice);
    if (!prevLayer) return false;
    return this.contentChildren(prevLayer).length > 0;
  }

  /** Whether layer's content sums to a full measure (no trailing placeholder
   *  space). Used by the wrapper-collapse rule. */
  private layerIsFull(layer: Element): boolean {
    let total = 0;
    for (const c of this.contentChildren(layer)) total += realTicks(c);
    return total >= this.measureTicks();
  }

  /** Wrapper emission decision per measure. Emit iff:
   *    - M_k is empty (the wrapper is the only stop AND the explicit
   *      empty-measure delete target), OR
   *    - M_{k-1} is *partial* (has a fill-anchor stop, so M_k's wrapper
   *      carries the "enter M_k" intent distinct from M_{k-1}'s fill-anchor's
   *      "extend M_{k-1}" intent).
   *  Otherwise collapse — there's no semantic distinction between
   *  "after last stop of M_{k-1}" and "before first stop of M_k":
   *    - M_1 with content: no predecessor to extend, cursor=0 anchors at
   *      sigEnd directly.
   *    - M_k>0 with content + M_{k-1} full: extending M_{k-1} overflows
   *      into M_k anyway, so one combined stop covers both intents.
   *    - M_k>0 with content + M_{k-1} empty: M_{k-1} has only a wrapper
   *      stop (no fill-anchor), so "after wrapper-of-M_{k-1}" IS the only
   *      "boundary" position; collapsing M_k's wrapper avoids the
   *      indistinguishable-twin stops between two adjacent wrappers. */
  private shouldEmitWrapper(
    measures: Element[],
    voice: Voice,
    measureIdx: number,
  ): boolean {
    const thisLayer = this.layerInMeasure(measures[measureIdx], voice);
    if (!thisLayer) return false;
    if (this.contentChildren(thisLayer).length === 0) return true;
    if (measureIdx === 0) return false;
    const prevLayer = this.layerInMeasure(measures[measureIdx - 1], voice);
    if (!prevLayer) return true;
    const prevContent = this.contentChildren(prevLayer);
    if (prevContent.length === 0) return false; /* prev empty → collapse */
    if (this.layerIsFull(prevLayer)) return false; /* prev full → collapse */
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
   *  withinIdx) — where withinIdx is expressed in CONTENT-children terms
   *  (placeholders excluded, tuplets counted as 1). The `inTuplet` field is
   *  populated when the cursor lands on a tuplet child stop.
   *
   *  Stop kinds and their resolved location:
   *    - `<measure>` wrapper stop → `(measureIdx, withinIdx: 0)`. Cursor
   *      means "before this measure's content"; insertion goes at the front.
   *    - Real content element → its position in `contentChildren`.
   *    - Tuplet child → `inTuplet: { tuplet, tupletChildIdx }`; withinIdx
   *      is the tuplet's position in `contentChildren`.
   *    - `<space data-placeholder>` (fill-anchor) → `(measureIdx, withinIdx:
   *      contentChildren.length)`. Cursor means "at the end of this
   *      measure's content, in the placeholder area"; insertion appends.
   *
   *  Past-end (cursor === flat.length): returns the synthetic "next-measure
   *  wrapper" location — `measureIdx = allMeasures.length` (one past the
   *  last existing), `layer` is a fresh empty `<layer>` element (so
   *  `contentChildren` returns empty and downstream code sees no
   *  post-cursor content). The applier in `insertWithSplit` lazily creates
   *  the measure via `appendMeasure` when an action's `targetMIdx` is
   *  beyond the existing measure count. */
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
    let consumed = 0;
    for (let mi = 0; mi < measures.length; mi++) {
      const measure = measures[mi];
      const layer = this.layerInMeasure(measure, voice);
      if (!layer) continue;
      const emitWrapper = this.shouldEmitWrapper(measures, voice, mi);
      const stopCount = this.measureStopCount(measures, voice, mi, layer, emitWrapper);
      if (linearCursor < consumed + stopCount) {
        return this.resolveStopIndex(mi, layer, linearCursor - consumed, emitWrapper);
      }
      consumed += stopCount;
    }
    /* Past-end: synthetic "wrapper of the next non-existent measure". */
    return {
      measureIdx: measures.length,
      layer: this.doc.createElementNS(MEI_NS, 'layer'),
      withinIdx: 0,
      inTuplet: null,
    };
  }

  /** Total nav-stops contributed by one (voice, layer) when `emitWrapper`
   *  indicates whether the leading `<measure>` wrapper stop is included.
   *  Matches `flatChildren`'s fill-anchor emission. */
  private measureStopCount(
    measures: Element[],
    voice: Voice,
    measureIdx: number,
    layer: Element,
    emitWrapper: boolean,
  ): number {
    let n = emitWrapper ? 1 : 0;
    n += this.layerStops(layer).length;
    const cc = this.contentChildren(layer);
    const hasPh = Array.from(layer.children).some(isPlaceholder);
    if (hasPh) {
      if (cc.length > 0) n += 1;
      else if (this.emptyFillAnchorEmitted(measures, voice, measureIdx)) n += 1;
    }
    return n;
  }

  /** Resolve a stop-within-measure index to a cursor location. When the
   *  wrapper is emitted (`emitWrapper=true`), idx 0 is the wrapper, idx
   *  1..N are layer stops, idx N+1 is the fill-anchor (if present).
   *  When the wrapper is collapsed (`emitWrapper=false`), idx 0..N-1 are
   *  layer stops and idx N is the fill-anchor (if present). */
  private resolveStopIndex(
    measureIdx: number,
    layer: Element,
    idx: number,
    emitWrapper: boolean,
  ): {
    measureIdx: number;
    layer: Element;
    withinIdx: number;
    inTuplet: { tuplet: Element; tupletChildIdx: number } | null;
  } {
    if (emitWrapper && idx === 0) {
      /* Wrapper stop: at start of measure. */
      return { measureIdx, layer, withinIdx: 0, inTuplet: null };
    }
    const layerStopIdx = emitWrapper ? idx - 1 : idx;
    const layerStops = this.layerStops(layer);
    if (layerStopIdx < layerStops.length) {
      const target = layerStops[layerStopIdx];
      const tParent = target.parentElement;
      if (tParent && tParent.localName === 'tuplet') {
        const cc = this.contentChildren(layer);
        const wIdx = cc.indexOf(tParent);
        const tChildren = Array.from(tParent.children);
        const tIdx = tChildren.indexOf(target);
        return {
          measureIdx,
          layer,
          withinIdx: wIdx,
          inTuplet: { tuplet: tParent, tupletChildIdx: tIdx },
        };
      }
      /* Top-level content target: count content elements before it. */
      let realIdx = 0;
      for (const c of Array.from(layer.children)) {
        if (c === target) break;
        if (
          c.localName === 'chord' ||
          c.localName === 'note' ||
          c.localName === 'rest' ||
          c.localName === 'tuplet'
        ) {
          realIdx++;
        }
      }
      return { measureIdx, layer, withinIdx: realIdx, inTuplet: null };
    }
    /* Fill-anchor stop: insertion appends to the layer's content. */
    return {
      measureIdx,
      layer,
      withinIdx: this.contentChildren(layer).length,
      inTuplet: null,
    };
  }

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
    let consumed = 0;
    for (let mi = 0; mi < measures.length; mi++) {
      const measure = measures[mi];
      const layer = this.layerInMeasure(measure, voice);
      if (!layer) continue;
      const emitWrapper = this.shouldEmitWrapper(measures, voice, mi);
      const stopCount = this.measureStopCount(measures, voice, mi, layer, emitWrapper);
      if (flatIdx < consumed + stopCount) {
        return this.resolveStopIndex(mi, layer, flatIdx - consumed, emitWrapper);
      }
      consumed += stopCount;
    }
    return null;
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

  /** Append a new empty measure with all four layers. Sets barlines. */
  private appendMeasure(): Element {
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
    /* Switching voice abandons the old voice's cursor location; run the
       autofill sweep on both voices so all abandoned partial measures
       finalize (old voice's cursor stays put; new voice's cursor took its
       new position above). */
    this.autofillAllAndReanchor(cur);
    this.autofillAllAndReanchor(next);
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
    if (oldV !== v) {
      this.autofillAllAndReanchor(oldV);
      this.autofillAllAndReanchor(v);
    } else {
      this.autofillAllAndReanchor(v);
    }
  }

  moveCursor(dir: "left" | "right"): number {
    const v = this.currentVoice;
    const len = this.getVoiceLength(v);
    let c = this.cursors[v];
    if (dir === "left" && c > 0) c--;
    else if (dir === "right" && c < len) c++;
    this.cursors[v] = c;
    this.autofillAllAndReanchor(v);
    return this.cursors[v];
  }

  setCursor(c: number, voice?: Voice): void {
    const v = voice ?? this.currentVoice;
    const len = this.getVoiceLength(v);
    this.cursors[v] = Math.max(0, Math.min(len, c));
    this.autofillAllAndReanchor(v);
  }

  cursorToEnd(voice?: Voice): void {
    const v = voice ?? this.currentVoice;
    this.cursors[v] = this.getVoiceLength(v);
    this.autofillAllAndReanchor(v);
  }

  /** The measureIdx of this voice's current cursor location, or -1 when the
   *  cursor doesn't resolve to a measure (no layers in this voice — only
   *  happens transiently before the doc is initialized). Past-end resolves
   *  to `allMeasures.length` (= one past the last existing measure).
   *  Exposed so the cursor renderer can anchor at the CURSOR'S current
   *  measure rather than a neighboring wrapper's measure. */
  cursorMeasureIdx(voice: Voice): number {
    const loc = this.locateCursor(voice, this.cursors[voice]);
    return loc ? loc.measureIdx : -1;
  }

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
    const newFlat = this.flatChildren(voice);
    for (const el of lookForward) {
      const idx = newFlat.indexOf(el);
      if (idx >= 0) {
        this.cursors[voice] = idx;
        return;
      }
    }
    /* No look-forward survivor (cursor was at past-end, OR every element
       from the old cursor onward was consumed). Snap to the new past-end. */
    this.cursors[voice] = this.getVoiceLength(voice);
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
    /* Advance cursor by +1 to land on the fill anchor. With the iter4 nav
       model, the tuplet wrapper itself is also a nav stop, occupying the
       pre-creation cursor index; the fill anchor is one position right. */
    this.cursors[v] = Math.min(this.cursors[v] + 1, this.getVoiceLength(v));
    this.autofillAllAndReanchor(v);
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
    this.autofillAllAndReanchor(v);
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
    this.normalizePlaceholders();
    this.cursors[v] = Math.min(this.cursors[v], this.getVoiceLength(v));
    this.autofillAllAndReanchor(v);
    return id;
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
      if (n.hasAttribute("data-pending-tie")) removeLvForNote(n);
      /* Then handle realized tie partners. */
      const partnerId = n.getAttribute("data-tie-partner");
      if (!partnerId) continue;
      const partner =
        this.doc.querySelector('[*|id="' + partnerId + '"]') ??
        this.doc.querySelector('[id="' + partnerId + '"]');
      if (!partner) continue;
      const partnerTie = partner.getAttribute("tie");
      if (partnerTie === "i") {
        clearTieFlag(partner);
        setStubTie(partner);
      } else if (partnerTie === "t" || partnerTie === "m") {
        clearTieFlag(partner);
      }
      partner.removeAttribute("data-tie-partner");
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
    if (currElem.localName === "rest") return;
    const prevNotes = this.extractNoteElements(prevElem);
    const currNotes = this.extractNoteElements(currElem);
    for (const n of prevNotes) {
      if (!n.hasAttribute("data-pending-tie")) continue;
      const partner = currNotes.find(
        (m) => notesMatch(n, m) && !m.hasAttribute("tie"),
      );
      if (!partner) continue;
      /* Replace the stub representation (<lv> + data-pending-tie) with a
         proper @tie="i"/@tie="t" pair. */
      clearStubTie(n);
      setTieFlag(n, "i");
      setTieFlag(partner, "t");
      const partnerId = partner.getAttribute("xml:id");
      const nId = n.getAttribute("xml:id");
      if (partnerId) n.setAttribute("data-tie-partner", partnerId);
      if (nId) partner.setAttribute("data-tie-partner", nId);
    }
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
    /* On a wrapper or fill-anchor stop, there's no element to overwrite —
       defer to the caller's insert fallback (input.ts already does this on
       null return). Without this guard, an overwrite at wrapper-of-M_k would
       silently replace M_k's first content; at a fill-anchor the
       contentChildren-index check below would bail anyway but explicit is
       clearer. */
    if (cursorAtCall < flat.length) {
      const here = flat[cursorAtCall];
      if (here.localName === 'measure') return null;
      if (isPlaceholder(here)) return null;
    }
    const loc = this.locateCursor(v, cursorAtCall);
    if (!loc) return null;

    /* In-tuplet branch. */
    if (loc.inTuplet) {
      const { tuplet, tupletChildIdx } = loc.inTuplet;
      const target = Array.from(tuplet.children)[tupletChildIdx];
      if (!target) return null;
      const newTicks = ticksOf(input.duration, input.dots ?? 0);
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
        this.autofillAllAndReanchor(v);
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
      this.autofillAllAndReanchor(v);
      return replaced.getAttribute("xml:id");
    }

    const kids = this.contentChildren(loc.layer);
    if (loc.withinIdx >= kids.length) return null; /* nothing to replace */
    /* If the layer child to replace is a <tuplet>, route through a special
       path: the tuplet is treated atomically and replaced by the new chord
       (the chord's real-time ticks must equal the tuplet's real-time ticks
       or fit the measure budget). */
    const oldLayerChild = kids[loc.withinIdx];
    if (oldLayerChild.localName === "tuplet") {
      /* Treat tuplet as an atomic replace target: remove it, then run
         insertWithSplit. */
      const totalTicks = ticksOf(input.duration, input.dots ?? 0);
      this.orphanTiePartners(oldLayerChild);
      loc.layer.removeChild(oldLayerChild);
      void totalTicks;
      const id = this.insertWithSplit(input, false);
      this.cursors[v] = cursorAtCall;
      this.resolvePendingTies(cursorAtCall);
      this.normalizePlaceholders();
      this.autofillAllAndReanchor(v);
      return id;
    }
    /* Simple in-place replace WITHIN current measure if it fits — checked
       against the post-cursor content too, since the replaced element's
       successors keep their position in the layer's child list and would
       otherwise be pushed past the barline silently. */
    const totalTicks = ticksOf(input.duration, input.dots ?? 0);
    const usedBefore = this.timeWithinMeasure(v, loc.measureIdx, loc.withinIdx);
    let postBlockTicks = 0;
    for (let i = loc.withinIdx + 1; i < kids.length; i++) {
      postBlockTicks += realTicks(kids[i]);
    }
    if (usedBefore + totalTicks + postBlockTicks <= this.measureTicks()) {
      const old = kids[loc.withinIdx];
      this.orphanTiePartners(old);
      const replaced = this.buildChordElement(input);
      loc.layer.replaceChild(replaced, old);
      this.resolvePendingTies(cursorAtCall);
      this.normalizePlaceholders();
      this.autofillAllAndReanchor(v);
      return replaced.getAttribute("xml:id");
    }
    /* Overflow on replace: remove old, run the planning insertWithSplit
       (which handles displacement of any remaining post-cursor content),
       restore cursor to its pre-replace position. */
    const old = kids[loc.withinIdx];
    this.orphanTiePartners(old);
    loc.layer.removeChild(old);
    const id = this.insertWithSplit(input, false);
    this.cursors[v] = cursorAtCall;
    this.resolvePendingTies(cursorAtCall);
    this.normalizePlaceholders();
    this.autofillAllAndReanchor(v);
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

    /* Case 1: cursor on the fill anchor of an empty tuplet. */
    if (c < flat.length) {
      const here = flat[c];
      if (isTupletPlaceholder(here)) {
        const tuplet = here.parentElement;
        if (tuplet && tuplet.localName === "tuplet") {
          const hasFilled = Array.from(tuplet.children).some(
            (cc) => !isTupletPlaceholder(cc),
          );
          if (!hasFilled) {
            tuplet.parentNode?.removeChild(tuplet);
            this.setBarlines();
            this.normalizePlaceholders();
            for (let vi = 1 as Voice; vi <= 4; vi = (vi + 1) as Voice) {
              this.cursors[vi] = Math.min(
                this.cursors[vi],
                this.getVoiceLength(vi),
              );
              if (vi === 4) break;
            }
            this.autofillAllAndReanchor(v);
            return true;
          }
        }
      }
    }

    /* Case 2: cursor on an empty measure's delete-target stop. Mirrors
       case 1 (empty tuplet → delete tuplet at its fill-anchor). The delete
       target is the LAST stop the empty measure contributes:
         - Fill-anchor (a layer-level placeholder) when the measure emits
           one, i.e., when the previous measure has content in this voice.
           This case lets cursor "on wrapper of empty M_k" sit as a
           "post-prev" stop (= delete prev's last note), while cursor "on
           fill-anchor of empty M_k" is the explicit delete-M_k target.
         - Wrapper otherwise (single-stop empty measure: no prev content,
           or prev is itself empty). The wrapper IS the only stop, so it
           doubles as the delete target.
       Skip when it's the only measure left. */
    if (c < flat.length) {
      const here = flat[c];
      let measureToDelete: Element | null = null;
      if (isPlaceholder(here)) {
        const measureA = here.closest("measure") as Element | null;
        if (measureA && this.measureIsEmpty(measureA)) measureToDelete = measureA;
      } else if (here.localName === "measure" && this.measureIsEmpty(here)) {
        /* Wrapper-of-empty fires ONLY when this empty measure doesn't
           emit a fill-anchor — otherwise the wrapper is "post-prev" and
           backspace there should delete prev's last note via the default
           content-delete path below. The fill-anchor would be the very
           next nav stop in `flat` and would belong to the same measure. */
        const next = c + 1 < flat.length ? flat[c + 1] : null;
        const nextIsThisFillAnchor =
          next !== null && isPlaceholder(next) && next.closest("measure") === here;
        if (!nextIsThisFillAnchor) measureToDelete = here;
      }
      if (measureToDelete && this.allMeasures().length > 1) {
        measureToDelete.parentNode?.removeChild(measureToDelete);
        this.renumberMeasures();
        this.setBarlines();
        this.normalizePlaceholders();
        for (let vi = 1 as Voice; vi <= 4; vi = (vi + 1) as Voice) {
          this.cursors[vi] = Math.min(
            this.cursors[vi],
            this.getVoiceLength(vi),
          );
          if (vi === 4) break;
        }
        this.autofillAllAndReanchor(v);
        return true;
      }
    }

    if (c <= 0) return false;
    const target = flat[c - 1];
    if (!target) return false;
    if (isPlaceholder(target)) {
      /* Skip past the placeholder; cursor moves but nothing is removed. */
      this.cursors[v] = c - 1;
      return true;
    }
    if (target.localName === "tuplet" || target.localName === "measure") {
      /* Wrapper skip-left: "back out of the container" without deleting. */
      this.cursors[v] = c - 1;
      return true;
    }

    /* Tuplet case (b): target is a filled child of a <tuplet>. Remove it
       and grow trailing placeholders by writtenTicks(target) so the
       tuplet's total duration stays constant. */
    const tupletParent =
      target.parentElement?.localName === "tuplet"
        ? target.parentElement
        : null;
    if (tupletParent) {
      const oldTicks = writtenTicks(target);
      const trailingTicks = this.tupletPlaceholderTicks(tupletParent);
      this.orphanTiePartners(target);
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
      this.cursors[v] = c - 1;
      this.setBarlines();
      this.normalizePlaceholders();
      for (let vi = 1 as Voice; vi <= 4; vi = (vi + 1) as Voice) {
        this.cursors[vi] = Math.min(this.cursors[vi], this.getVoiceLength(vi));
        if (vi === 4) break;
      }
      this.autofillAllAndReanchor(v);
      return true;
    }

    const loc = this.locateFlatElement(v, c - 1);
    if (!loc) return false;
    const kids = this.contentChildren(loc.layer);
    if (loc.withinIdx >= kids.length) return false;
    const victim = kids[loc.withinIdx];
    this.orphanTiePartners(victim);
    loc.layer.removeChild(victim);
    this.cursors[v] = c - 1;
    /* Emptied measures are NOT auto-removed — once empty across all voices,
       each voice's layer collapses to a single wrapper nav stop, and one
       more backspace at that wrapper is the explicit confirmation that
       drops the measure (see case 2 above). */
    this.setBarlines();
    this.normalizePlaceholders();
    /* Clamp cursor in case content-removal shortened flat. */
    for (let vi = 1 as Voice; vi <= 4; vi = (vi + 1) as Voice) {
      this.cursors[vi] = Math.min(this.cursors[vi], this.getVoiceLength(vi));
      if (vi === 4) break;
    }
    this.autofillAllAndReanchor(v);
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
      this.autofillAllAndReanchor(v);
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
      this.autofillAllAndReanchor(v);
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
    if (restInput)
      firstId = this.insertWithSplit({ ...restInput, notes: [] }, true);
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
    if (mode === "overwrite") {
      this.cursors[v] = ref.index;
    } else {
      /* For insert, leave cursor at the end of the chain — savedCursor was
         ref.index + 1; after replacing with N pieces it's ref.index + N.
         If N > 1, the cursor naturally sits past all pieces, which is the
         insert-mode convention "right of just-entered element". */
    }
    void savedCursor; /* not needed beyond reasoning; ref.index re-derived */
    this.normalizePlaceholders();
    this.cursors[v] = Math.min(this.cursors[v], this.getVoiceLength(v));
    if (!firstId) return null;
    this.autofillAllAndReanchor(v);
    return { id: firstId, newDots: nextDots };
  }

  /** Toggle a tie on the current note/chord. Attaches to next element's
   *  matching pitches; stubs for non-matching. Returns null when there's
   *  no tieable current element (e.g. rest, no current). */
  toggleTieOnCurrent(
    mode: "insert" | "overwrite",
  ): { id: string; tied: boolean } | null {
    const v = this.currentVoice;
    const ref = this.getCurrentElement(v, mode);
    if (!ref) return null;
    if (ref.elem.localName === "rest") return null;
    if (ref.elem.localName === "measure") return null; /* wrapper stops aren't tieable */
    if (ref.elem.localName === "tuplet") return null; /* whole-tuplet tie NYI */
    if (isPlaceholder(ref.elem)) return null; /* placeholders aren't tieable */
    const currentNotes = this.extractNoteElements(ref.elem);
    if (currentNotes.length === 0) return null;

    const alreadyTied = currentNotes.some((n) => {
      const t = n.getAttribute("tie");
      return t === "i" || t === "m" || n.hasAttribute("data-pending-tie");
    });
    if (alreadyTied) {
      /* Toggle off: clear ties / pending markers on current notes; find
         realized partners (via data-tie-partner) and clear them too. */
      for (const n of currentNotes) {
        if (n.hasAttribute("data-pending-tie")) {
          clearStubTie(n);
          continue;
        }
        const partnerId = n.getAttribute("data-tie-partner");
        if (partnerId) {
          const partner =
            this.doc.querySelector('[*|id="' + partnerId + '"]') ??
            this.doc.querySelector('[id="' + partnerId + '"]');
          if (partner) {
            clearTieFlag(partner);
            partner.removeAttribute("data-tie-partner");
          }
          n.removeAttribute("data-tie-partner");
        }
        clearTieFlag(n);
      }
      this.normalizePlaceholders();
      this.autofillAllAndReanchor(v);
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
      const partner = nextNotes.find(
        (m) => notesMatch(n, m) && !m.hasAttribute("tie"),
      );
      if (partner) {
        setTieFlag(n, "i");
        setTieFlag(partner, "t");
        const partnerId = partner.getAttribute("xml:id");
        const nId = n.getAttribute("xml:id");
        if (partnerId) n.setAttribute("data-tie-partner", partnerId);
        if (nId) partner.setAttribute("data-tie-partner", nId);
      } else {
        setStubTie(n);
      }
    }
    this.normalizePlaceholders();
    this.autofillAllAndReanchor(v);
    return { id: ref.id, tied: true };
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

    /* Apply: lift any post-cursor elements out of the cursor's layer so the
       plan can re-place them (some may have moved to subsequent measures). */
    const cc = this.contentChildren(loc.layer);
    const postCursor = cc.slice(loc.withinIdx);
    for (const el of postCursor) loc.layer.removeChild(el);

    /* Walk the plan, building/reusing elements at their target positions.
       withinByMeasure tracks the next insertion index per target measure;
       for the cursor's own measure it starts at loc.withinIdx (post-cursor
       was removed), for any other measure it starts at 0 (validated empty). */
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

    /* Tie wiring on the inserted note's pieces (skipped for rests). */
    if (!isRest && insertedElements.length > 1) {
      let lastNoteEls: Element[] | null = null;
      for (let pi = 0; pi < insertedElements.length; pi++) {
        const innerNotes = this.extractNoteElements(insertedElements[pi]);
        let flag: "i" | "m" | "t";
        if (pi === 0) flag = "i";
        else if (pi === insertedElements.length - 1) flag = "t";
        else flag = "m";
        for (let ni = 0; ni < innerNotes.length; ni++) {
          setTieFlag(innerNotes[ni], flag);
          if (
            (flag === "m" || flag === "t") &&
            lastNoteEls &&
            lastNoteEls[ni]
          ) {
            const prevId = lastNoteEls[ni].getAttribute("xml:id");
            if (prevId) innerNotes[ni].setAttribute("data-tie-partner", prevId);
          }
        }
        lastNoteEls = innerNotes;
      }
    }

    this.setBarlines();
    /* Position the cursor just past the last inserted-from-input element.
       The new flat picks up extra nav stops (wrapper, fill-anchor) when
       inserting into a freshly-created measure, so a naive `cursor +=
       insertedElements.length` would land in the wrong place; instead
       locate the last inserted element by xml:id and snap one past it. */
    if (insertedElements.length > 0) {
      const lastInserted = insertedElements[insertedElements.length - 1];
      const lastId = lastInserted.getAttribute('xml:id');
      if (lastId) {
        const flat = this.flatChildren(v);
        const idx = flat.findIndex((e) => e.getAttribute('xml:id') === lastId);
        if (idx >= 0) this.cursors[v] = idx + 1;
      }
    }
    return firstInsertedElement?.getAttribute("xml:id") ?? "";
  }

  /** Plan a layer-level insert by walking the would-be new sequence
   *  (inserted note + post-cursor items), assigning each element a target
   *  (measureIdx, time-offset). Returns either a list of insertion actions
   *  or a block reason matching the user-facing status string.
   *
   *  Rules:
   *   - The inserted note splits on barlines (decomposeTicks per chunk),
   *     with i/m/t ties wired by the applier.
   *   - Existing post-cursor items move wholesale to keep their identity;
   *     a non-tuplet that wouldn't fit in the current measure bumps to the
   *     next measure (leaving placeholder space in the current — autofill
   *     later turns that into rests on cursor-leave).
   *   - A tuplet is allowed to be pushed wholesale across a barline, but
   *     any measure past the cursor's that would receive overflow content
   *     must currently be empty in this voice (else BLOCK). Distinct
   *     messages for tuplet-pushed-by-displacement vs. other overflow. */
  private planInsert(
    loc: { measureIdx: number; layer: Element; withinIdx: number },
    totalTicks: number,
  ): { ok: true; actions: InsertAction[] } | { ok: false; reason: string } {
    const v = this.currentVoice;
    const measureCap = this.measureTicks();
    const layers = this.allLayers(v);
    const cc = this.contentChildren(loc.layer);
    const postCursor = cc.slice(loc.withinIdx);
    const usedBefore = this.timeWithinMeasure(v, loc.measureIdx, loc.withinIdx);

    /* If the target measure (past the cursor's) currently has any content
       in this voice, block. Tuplets get a specific message per the project
       convention; other items use the generic overflow message. Measures
       beyond the current document length are fine — we'll append them. */
    const checkTargetContent = (
      m: number,
      blockingIsTuplet: boolean,
    ): string | null => {
      if (m <= loc.measureIdx) return null;
      if (m >= layers.length) return null;
      if (this.contentChildren(layers[m]).length === 0) return null;
      return blockingIsTuplet
        ? "Insertion would push tuplet across bar line."
        : "Insertion would overflow into next measure's content.";
    };

    const actions: InsertAction[] = [];
    let mIdx = loc.measureIdx;
    let mOff = usedBefore;

    /* Place inserted note's pieces (split on barlines). */
    const insertedRecorded: Array<Extract<InsertAction, { kind: "inserted" }>> = [];
    let insertedRemaining = totalTicks;
    while (insertedRemaining > 0) {
      const space = measureCap - mOff;
      const chunk = Math.min(insertedRemaining, space);
      if (chunk > 0) {
        for (const p of decomposeTicks(chunk)) {
          const a: Extract<InsertAction, { kind: "inserted" }> = {
            kind: "inserted",
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
        const newMIdx = mIdx + 1;
        const block = checkTargetContent(newMIdx, false);
        if (block) return { ok: false, reason: block };
        mIdx = newMIdx;
        mOff = 0;
      }
    }
    /* Backfill pieceCount now that the chain length is known. */
    for (const a of insertedRecorded) a.pieceCount = insertedRecorded.length;

    /* Place each post-cursor item wholesale at its new (mIdx, mOff). */
    for (const el of postCursor) {
      const elTicks = realTicks(el);
      const isTuplet = el.localName === "tuplet";
      if (mOff + elTicks > measureCap) {
        const newMIdx = mIdx + 1;
        const block = checkTargetContent(newMIdx, isTuplet);
        if (block) return { ok: false, reason: block };
        mIdx = newMIdx;
        mOff = 0;
      }
      if (elTicks > measureCap) {
        /* Element larger than any measure can hold — only possible with
           an unusually tiny meter. Surface the most accurate message. */
        return {
          ok: false,
          reason: isTuplet
            ? "Insertion would push tuplet across bar line."
            : "Doesn't fit.",
        };
      }
      actions.push({ kind: "reuse", el, targetMIdx: mIdx });
      mOff += elTicks;
    }

    return { ok: true, actions };
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
