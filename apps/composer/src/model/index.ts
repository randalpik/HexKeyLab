// Composer MEI model. In-memory MEI 5 DOM with mutation operations for
// keyboard-driven step entry. Serializes to a string for Verovio's loadData().
//
// Structure:
//   1 mdiv / 1 score / 1 section
//   <scoreDef> carries key.sig, meter.count, meter.unit
//   <section> contains a flat ordered list of <measure> elements
//   The head <scoreDef>'s root <staffGrp> declares the instruments (see the
//   instrument table, instrumentTable()): the default doc is one implicit
//   2-staff "Piano" instrument; multi-instrument docs nest one <staffGrp> per
//   instrument (each 1–2 staves, 2 layers per staff). Each <measure> carries a
//   <staff> for every staff @n, each with its <layer>s.
//   A flat voice index maps to (instrument, staff, layer) via the table. For
//   the default piano: v1→s1l1, v2→s1l2, v3→s2l1, v4→s2l2.
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

import type { ResolvedNote } from '@hkl/bridge/protocol.js';
import { regroupBeams, readTimeSig } from '../notation/beams.js';
import { decomposeBeatAlignedRests } from './restfill.js';
import { computeAccidentalDisplay } from '../notation/accidentals.js';
import { alterFromCount, alterFromToken, tokenFromAlter, getNoteAlter } from '@hkl/notation/accidentals.js';
import {
  el,
  newId,
  MEI_NS,
  XML_NS,
  emptyMeiDoc as buildSkeletonDoc,
  type Duration,
  type Dots,
} from '@hkl/notation/mei-build.js';
import { ensureExpressionDefaults, getLayoutReq, setLayoutReq, getHejiEnabled, setHejiEnabled, getIgnoreColor, setIgnoreColor, HKL_NS, type LayoutReq, type Moment } from '../expressions.js';
import { toggleArticulation, toggleTrill, type ArticKind } from '../articulations.js';
import { transformDocForHeji } from '@hkl/notation/heji-render.js';
import type { TuningMode } from '@hkl/shared/freq.js';
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

/** A flat voice index, 1-based. For the default single-piano doc the range is
 *  1..4 (the historic v1→s1l1 … v4→s2l2 grand-staff mapping); with multiple
 *  instruments it extends to `totalVoices()`. The voice→(instrument, staff,
 *  layer) mapping is owned by the instrument table — never recompute it from a
 *  `voice<=2?1:2` ternary; route through `staffForVoice`/`layerForVoice`. */
export type Voice = number;
/* Duration / Dots / el / newId / MEI_NS now live in @hkl/notation/mei-build
   (single source of truth for the .hkc dialect). Re-exported here so the many
   Composer modules that import them from './index.js' stay zero-touch. */
export { el, newId, MEI_NS };
export type { Duration, Dots };

/** One instrument in the score: a (possibly nested) `<staffGrp>` owning 1–2
 *  staves, 2 layers each. `instrumentTable()` derives these from the head
 *  `<scoreDef>`'s root staffGrp and maps the flat voice index onto
 *  (instrument, staff, layer). The historic single-piano doc is one implicit
 *  2-staff instrument. See docs/architecture/composer.md "MEI model". */
export interface InstrumentEntry {
  /** 0-based position in the score. */
  index: number;
  /** Display name from `<label>`, else a default ("Piano" for index 0). */
  name: string;
  /** `hkl:instr` sample-set key, else 'piano'. */
  instrKey: string;
  /** The owning `<staffGrp>` (the root staffGrp for the implicit single instrument). */
  staffGrp: Element;
  /** Global `<staff>` @n of this instrument's staves, in order (length 1 or 2). */
  staffNs: number[];
  /** Flat voice index (1-based) of this instrument's first voice. */
  voiceBase: number;
  /** Number of voices: 2 (single-staff) or 4 (grand staff). */
  voiceCount: number;
}

export interface ChordInput {
  notes: ReadonlyArray<ResolvedNote>;
  duration: Duration;
  dots?: Dots;
}

export interface RestInput {
  duration: Duration;
  dots?: Dots;
}

/** Meter-symbol display: `null` = plain numeral, `'common'` = C (4/4),
 *  `'cut'` = ¢ (2/2). Rendered by Verovio via `meter.sym`; the tick budget
 *  still comes from count/unit (common=64t, cut=64t), so symbols never affect
 *  measure capacity. */
export type MeterSym = 'common' | 'cut' | null;

/** Optional extras carried alongside a meter (count, unit): the display symbol
 *  and an additive beat-group pattern (e.g. `[2,2,3]` for a 7/8 grouped 2+2+3).
 *  Beat groups are beaming-only — `meter.count` stays the sum so the displayed
 *  numeral is unchanged. Both ride the `<scoreDef>` (head or in-section). */
export interface MeterOpts {
  sym?: MeterSym;
  beatGroups?: number[] | null;
}

/** A fully-resolved meter descriptor at a measure. */
export interface MeterInfo {
  count: number;
  unit: number;
  sym: MeterSym;
  beatGroups: number[] | null;
}

const BEAT_GROUPS_ATTR = 'beat-groups';

/** Parse a `"2+2+3"` beat-group string into `[2,2,3]`. Returns null for
 *  empty/malformed input (any non-positive-integer token rejects the whole). */
export function parseBeatGroups(s: string | null | undefined): number[] | null {
  if (!s) return null;
  const parts = s.split('+').map((t) => t.trim());
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = parseInt(p, 10);
    if (n <= 0) return null;
    out.push(n);
  }
  return out.length > 0 ? out : null;
}

/** Serialize `[2,2,3]` → `"2+2+3"`; null/empty → null (clear the attr). */
export function formatBeatGroups(g: number[] | null | undefined): string | null {
  if (!g || g.length === 0) return null;
  return g.join('+');
}

const PICKUP_TICKS_ATTR = 'pickup-ticks';

/** Read an explicit reduced tick budget (`hkl:pickup-ticks`) off a measure, or
 *  null when the measure uses its meter's full budget. */
function readPickupTicks(measure: Element): number | null {
  const v = measure.getAttributeNS(HKL_NS, PICKUP_TICKS_ATTR);
  if (!v) return null;
  const n = parseInt(v, 10);
  return isFinite(n) && n > 0 ? n : null;
}

/** Read `meter.sym` off a scoreDef element, normalised to MeterSym. */
function readMeterSym(sd: Element | null): MeterSym {
  const v = sd?.getAttribute('meter.sym');
  return v === 'common' || v === 'cut' ? v : null;
}

/** Read the `hkl:beat-groups` attr off a scoreDef element. */
function readBeatGroups(sd: Element | null): number[] | null {
  return parseBeatGroups(sd?.getAttributeNS(HKL_NS, BEAT_GROUPS_ATTR) ?? null);
}

/** Write/clear `meter.sym` + `hkl:beat-groups` on a scoreDef from MeterOpts.
 *  Only mutates an attr when the corresponding opt key is PRESENT (undefined
 *  leaves it untouched; null/falsy clears). */
function applyMeterOpts(sd: Element, opts: MeterOpts | undefined): void {
  if (!opts) return;
  if ('sym' in opts) {
    if (opts.sym === 'common' || opts.sym === 'cut') sd.setAttribute('meter.sym', opts.sym);
    else sd.removeAttribute('meter.sym');
  }
  if ('beatGroups' in opts) {
    const s = formatBeatGroups(opts.beatGroups);
    if (s) sd.setAttributeNS(HKL_NS, 'hkl:' + BEAT_GROUPS_ATTR, s);
    else sd.removeAttributeNS(HKL_NS, BEAT_GROUPS_ATTR);
  }
}

/** Deep-equal for beat-group arrays (null-safe). */
function beatGroupsEqual(a: number[] | null, b: number[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
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

/* ── tick math ──────────────────────────────────────────────────────────── */

/* 64th-note tick table for representable durations (greedy decomposition).
   Largest first. The @dur values here MUST be consistent with ticksOf —
   e.g. dotted half = ticksOf('2', 1) = 48, so the 48-tick entry must carry
   dur='2' dots=1, not dur='1' dots=1 (= 96). */
/* Tolerance for tstamp-equality comparisons in tick math (used by
   measureBoundaryCursors). 1e-6 is the same tolerance selection.ts uses. */
const TICK_EPS = 1e-6;

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

/* Composer's SetupDefaults is structurally a superset of the shared
   ScoreSkeletonSetup, so it passes straight through to the shared builder. */
function emptyMeiDoc(setup: SetupDefaults = {}): Document {
  return buildSkeletonDoc(setup);
}

/* ── model class ─────────────────────────────────────────────────────────── */

export class ComposerModel {
  private doc: Document;
  private currentVoice: Voice = 1;
  private cursors: Record<Voice, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  /** Cached per-measure tick budgets + cumulative prefix sums. Built lazily by
   *  meterTable(); cleared by invalidateMeterCache() on any structural/meter
   *  change. Depends only on the measure set + meter overrides, NOT on note
   *  content — so it survives the content mutations that dominate the call
   *  sites and only rebuilds when measures are added/removed or meter changes
   *  (every such path runs through normalizePlaceholdersAll, which invalidates
   *  first). See docs/architecture/composer.md "Mid-piece time/key signatures & clefs". */
  private meterCache:
    | {
        measures: Element[];
        perMeasure: number[];
        prefix: number[];
        budgetByEl: Map<Element, number>;
        meterByEl: Map<Element, MeterInfo>;
        keyByEl: Map<Element, { sig: string; mode: 'major' | 'minor' }>;
      }
    | null = null;
  /** Cached instrument table: the flat-voice ↔ (instrument, staff, layer) map
   *  derived from the head `<scoreDef>`'s root staffGrp. Mirrors meterCache —
   *  built lazily by instrumentTable(), cleared by invalidateInstrumentCache()
   *  on any change to the staffGrp set (add/remove instrument). Depends only on
   *  the staffGrp structure, NEVER on note content. See roadmap §12. */
  private instrCache:
    | {
        instruments: InstrumentEntry[];
        staffForVoice: number[];   // [voiceIdx] → global staff @n (1-based; idx 0 unused)
        layerForVoice: number[];   // [voiceIdx] → layer @n (1|2)
        instrForVoice: number[];   // [voiceIdx] → instrument index
        staffNToInstr: Map<number, InstrumentEntry>;
        totalVoices: number;
        totalStaves: number;
      }
    | null = null;

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
    this.normalizePlaceholdersAll();
    this.ensureCursorSlots();
  }

  /** Replace the entire document in-place (used by Load .hkc to preserve
   *  bindings held by other modules). */
  replaceDocument(meiXml: string): void {
    const newDoc = new DOMParser().parseFromString(meiXml, "application/xml");
    if (newDoc.querySelector("parsererror"))
      throw new Error("Invalid MEI in load");
    this.doc = newDoc;
    this.invalidateInstrumentCache();
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
    this.normalizePlaceholdersAll();
    this.ensureCursorSlots();
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

  /** Serialize to MEI. Pass `forRender` to apply the HEJI / arbitrary-stack
   *  accidental transform (render path only — save/snapshot leave it off so
   *  the stored doc stays clean conventional MEI; (q, r) is the truth). */
  serialize(forRender?: { hejiEnabled: boolean }, viewStaves?: number[] | null): string {
    /* Render-time passes operate on a clone so the live doc stays flat
       (cursor/mutation invariant). All passes are idempotent. Order:
       accidentals first (operates on flat notes), then the HEJI/stack
       placeholder transform (reads the visible @accid the prior pass set),
       then beams (wraps them). */
    const clone = this.doc.cloneNode(true) as Document;
    const mode = this.getLayoutReq().tuningMode;
    computeAccidentalDisplay(clone, this.getKeySig(),
      forRender ? { mode, enabled: forRender.hejiEnabled } : undefined);
    if (forRender) {
      transformDocForHeji(clone, mode, forRender.hejiEnabled);
      /* Ignore-color (render-only): drop the lattice @color so noteheads draw
         plain black. Stays on the render clone — the saved doc keeps (q, r) +
         color truth. Export (save.ts) blacks output via forceNonNoteheadBlack. */
      if (getIgnoreColor(clone)) {
        for (const n of Array.from(clone.querySelectorAll('note'))) n.removeAttribute('color');
      }
    }
    /* Single-part view (render/PDF only): keep only the viewed instrument's
       staves. Orthogonal to forRender (PDF filters without the HEJI pass). The
       model/snapshot doc is untouched; staff @n are preserved (not renumbered)
       so the cursor's xml:id lookups still resolve. */
    if (viewStaves) filterToStaves(clone, new Set(viewStaves));
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
    this.normalizePlaceholdersAll();
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
    this.normalizePlaceholdersAll();
    this.clampAllCursors();
  }

  /** Seed a 0 cursor for every voice 1..totalVoices() that lacks one. Cheap;
   *  idempotent. Called after any doc swap / instrument change so voices added
   *  by a new instrument have a valid cursor slot (reads default-type to
   *  `number`, so an unseeded slot would be NaN in arithmetic). */
  private ensureCursorSlots(): void {
    const n = this.totalVoices();
    for (let v = 1; v <= n; v++) {
      if (typeof this.cursors[v] !== 'number') this.cursors[v] = 0;
    }
  }

  private clampAllCursors(): void {
    this.ensureCursorSlots();
    for (let v = 1; v <= this.totalVoices(); v++) {
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
    for (let voice = 1; voice <= this.totalVoices(); voice++) {
      const flat = this.flatChildren(voice);
      for (let i = 0; i < flat.length; i++) {
        if (flat[i].getAttribute("xml:id") === meiId) {
          return { voice, index: i };
        }
      }
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

  /** Cursor positions whose tick position is exactly a multiple of
   *  `measureTicks()` (= barlines). Always includes 0 and the past-end
   *  cursor. Tuplet-internal stops are filtered. Dedupe rule: when two
   *  cursors share a tstamp (e.g. past-last-content of full M_k and
   *  past-wrapper of M_{k+1}), the LATER one wins. Used by both
   *  Ctrl+Shift+Arrow (selection-mode bar extension) and Ctrl+Arrow
   *  (voice-mode bar jump) so the two land identically. */
  measureBoundaryCursors(voice: Voice): number[] {
    const flat = this.flatChildren(voice);
    const candidates: Array<{ c: number; t: number }> = [];
    for (let c = 0; c <= flat.length; c++) {
      let t: number;
      if (c === flat.length) {
        t = this.measureStartTick(this.allMeasures().length);
      } else {
        const info = this.getFlatStopInfo(voice, c);
        if (!info) continue;
        if (info.inTuplet) continue;
        t = this.getTickPositionAt(voice, c);
      }
      /* A position is a barline iff its absolute tick coincides with some
         measure start. measureIdxAtTick(t) is the measure whose start is the
         greatest ≤ t, so inMeas≈0 captures both "start of M_k" and "end of a
         full M_{k-1}" (whose tick equals M_k's start). */
      const mi = this.measureIdxAtTick(t);
      const inMeas = t - this.measureStartTick(mi);
      const budget = this.measureTicksAt(mi);
      if (inMeas < TICK_EPS || budget - inMeas < TICK_EPS) {
        candidates.push({ c, t });
      }
    }
    const byT = new Map<number, number>();
    for (const { c, t } of candidates) {
      const key = Math.round(t * 1e6);
      byT.set(key, c);
    }
    return Array.from(byT.values()).sort((a, b) => a - b);
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
      return this.measureStartTick(this.allMeasures().length);
    }
    const loc = locateCursor(this, voice, c);
    if (!loc) return 0;
    let t = this.measureStartTick(loc.measureIdx);
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

  /** Optional subtitle — stored as a second `<title type="subtitle">` in
   *  `<titleStmt>` next to the main title. Empty string = no subtitle. */
  getSubtitle(): string {
    const titles = Array.from(this.doc.querySelectorAll('titleStmt > title'));
    for (const t of titles) {
      if (t.getAttribute('type') === 'subtitle') return t.textContent ?? '';
    }
    return '';
  }

  setSubtitle(subtitle: string): void {
    const titleStmt = this.doc.querySelector('titleStmt');
    if (!titleStmt) return;
    let sub: Element | null = null;
    for (const t of Array.from(titleStmt.querySelectorAll(':scope > title'))) {
      if (t.getAttribute('type') === 'subtitle') { sub = t; break; }
    }
    if (!subtitle) {
      if (sub) sub.parentNode?.removeChild(sub);
      return;
    }
    if (!sub) {
      sub = el(this.doc, 'title', { type: 'subtitle' });
      titleStmt.appendChild(sub);
    }
    sub.textContent = subtitle;
  }

  /** Footer text appearing at the bottom of every page. Defaults to
   *  "Engraved with HKL Composer" — set explicitly to "" to suppress. */
  getFooter(): string {
    const cfg = this.doc.getElementsByTagNameNS('https://hexkeylab.com/ns/mei', 'config')[0];
    if (cfg && cfg.hasAttribute('footer')) return cfg.getAttribute('footer') ?? '';
    return 'Engraved with HKL Composer';
  }

  setFooter(footer: string): void {
    /* Always write the attribute so the user's explicit choice (including
       empty string = suppress) is persisted. */
    const HKL_NS = 'https://hexkeylab.com/ns/mei';
    let cfg = this.doc.getElementsByTagNameNS(HKL_NS, 'config')[0];
    if (!cfg) {
      ensureExpressionDefaults(this.doc);
      cfg = this.doc.getElementsByTagNameNS(HKL_NS, 'config')[0];
    }
    cfg?.setAttribute('footer', footer);
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

  /** Read whether the key signature is being used as major or relative minor.
   *  Stored as standard MEI @mode on <scoreDef>. Defaults to 'major' when
   *  absent so pre-keyMode .hkc files load unchanged. */
  getKeyMode(): 'major' | 'minor' {
    const sd = this.doc.querySelector("scoreDef");
    return sd?.getAttribute("mode") === "minor" ? "minor" : "major";
  }

  setKeyMode(mode: 'major' | 'minor'): void {
    const sd = this.doc.querySelector("scoreDef");
    if (!sd) return;
    sd.setAttribute("mode", mode);
  }

  /** Read the score's required layout (tuning mode + ref note). The block is
   *  seeded by ensureExpressionDefaults so this always returns a valid value. */
  getLayoutReq(): LayoutReq {
    return getLayoutReq(this.doc);
  }

  setLayoutReq(req: LayoutReq): void {
    setLayoutReq(this.doc, req);
  }

  /** Document-level "show HEJI accidentals" flag. Render-only display state. */
  getHejiEnabled(): boolean {
    return getHejiEnabled(this.doc);
  }

  setHejiEnabled(on: boolean): void {
    setHejiEnabled(this.doc, on);
  }

  /** Document-level "ignore lattice color" flag. Render-only display state:
   *  when on, noteheads draw plain black. */
  getIgnoreColor(): boolean {
    return getIgnoreColor(this.doc);
  }

  setIgnoreColor(on: boolean): void {
    setIgnoreColor(this.doc, on);
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
  setTimeSig(count: number, unit: number, opts?: MeterOpts): void {
    const sd = this.doc.querySelector("scoreDef");
    if (!sd) return;
    const prevCount = parseInt(sd.getAttribute("meter.count") ?? "4", 10);
    const prevUnit = parseInt(sd.getAttribute("meter.unit") ?? "4", 10);
    sd.setAttribute("meter.count", String(count));
    sd.setAttribute("meter.unit", String(unit));
    applyMeterOpts(sd, opts);
    /* Head meter changed → the cached per-measure budgets are stale. (truncate
       below also invalidates via normalizePlaceholdersAll, but invalidate here
       too so any read between this point and truncate sees the new budget.) */
    this.invalidateMeterCache();
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
    const staffN = this.staffForVoice(voice);
    const staff = Array.from(measure.querySelectorAll("staff")).find(
      (s) => s.getAttribute("n") === String(staffN),
    );
    return staff?.getAttribute("xml:id") ?? null;
  }

  /** Total ticks in one measure under the SCORE-DEFAULT meter (the head
   *  `<scoreDef>`). Retained as the default-budget alias for the many sites
   *  that legitimately want the score default; for a SPECIFIC measure's budget
   *  use `measureTicksAt(mi)`. Under a single-meter doc the two are identical. */
  measureTicks(): number {
    const { count, unit } = this.getTimeSig();
    return count * (64 / unit);
  }

  /** Drop the cached meter table. Call after any change to the measure set or
   *  to a meter (head or in-section override). normalizePlaceholdersAll() and
   *  the meter setters call this; most callers get it for free because nearly
   *  every structural mutation ends in normalizePlaceholdersAll(). */
  invalidateMeterCache(): void {
    this.meterCache = null;
  }

  /** Lazily build the per-measure tick table. Walks the single `<section>`'s
   *  `<scoreDef>` overrides + `<measure>` nodes in document order, tracking the
   *  meter in effect (seeded from the head `<scoreDef>`). An in-section
   *  `<scoreDef>` with `@meter.count`/`@meter.unit` changes the budget from
   *  that point forward (MEI 5 idiom — see roadmap §10). With no overrides
   *  (the only case until Phase 4.2 lands), every measure gets the head
   *  budget, so this is byte-for-byte equivalent to the old global path. */
  private meterTable(): {
    measures: Element[];
    perMeasure: number[];
    prefix: number[];
    budgetByEl: Map<Element, number>;
    meterByEl: Map<Element, MeterInfo>;
    keyByEl: Map<Element, { sig: string; mode: 'major' | 'minor' }>;
  } {
    if (this.meterCache) return this.meterCache;
    const headSd = this.doc.querySelector('scoreDef');
    const head = this.getTimeSig();
    let count = head.count;
    let unit = head.unit;
    let sym: MeterSym = readMeterSym(headSd);
    let beatGroups: number[] | null = readBeatGroups(headSd);
    let keySig = this.getKeySig();
    let keyMode = this.getKeyMode();
    const measures: Element[] = [];
    const perMeasure: number[] = [];
    const budgetByEl = new Map<Element, number>();
    const meterByEl = new Map<Element, MeterInfo>();
    const keyByEl = new Map<Element, { sig: string; mode: 'major' | 'minor' }>();
    const section = this.doc.querySelector('section');
    /* scoreDef + measure nodes in document order. The head scoreDef lives
       under <score> (outside <section>) so it is not matched here — it seeds
       count/unit/key above. An in-section <scoreDef> overrides meter and/or
       key from that point forward (MEI 5 idiom — see roadmap §10). Measures
       nested in <ending> wrappers are still matched (querySelectorAll is
       depth-agnostic) and stay in order. */
    const nodes = section
      ? Array.from(section.querySelectorAll('scoreDef, measure'))
      : this.allMeasures();
    for (const node of nodes) {
      if (node.localName === 'scoreDef') {
        const c = node.getAttribute('meter.count');
        const u = node.getAttribute('meter.unit');
        /* A scoreDef that TOUCHES meter (has count and/or unit) resets the full
           meter descriptor — count, unit, sym, and beat-groups — from this node
           (absent sym/beat-groups = cleared). A pure key-only override leaves
           the running meter (incl. sym/groups) untouched. Mirrors how the
           setters write count+unit+sym+groups together. */
        if (c !== null || u !== null) {
          if (c) count = parseInt(c, 10);
          if (u) unit = parseInt(u, 10);
          sym = readMeterSym(node);
          beatGroups = readBeatGroups(node);
        }
        const ks = node.getAttribute('key.sig');
        if (ks !== null) keySig = ks;
        const km = node.getAttribute('mode');
        if (km === 'major' || km === 'minor') keyMode = km;
      } else {
        /* Pickup/anacrusis: a measure may carry an explicit reduced tick budget
           (hkl:pickup-ticks) that overrides the meter's count*unit budget while
           the displayed meter stays full. */
        const meterTicks = count * (64 / unit);
        const ticks = readPickupTicks(node) ?? meterTicks;
        measures.push(node);
        perMeasure.push(ticks);
        budgetByEl.set(node, ticks);
        meterByEl.set(node, { count, unit, sym, beatGroups });
        keyByEl.set(node, { sig: keySig, mode: keyMode });
      }
    }
    const prefix: number[] = new Array(measures.length + 1);
    prefix[0] = 0;
    for (let i = 0; i < measures.length; i++) prefix[i + 1] = prefix[i] + perMeasure[i];
    this.meterCache = { measures, perMeasure, prefix, budgetByEl, meterByEl, keyByEl };
    return this.meterCache;
  }

  /** Tick budget of measure `mi` (its meter's ticks-per-measure). Out-of-range
   *  indices fall back to the score-default budget (used for the synthetic
   *  "one past the last measure" slot). */
  measureTicksAt(mi: number): number {
    const t = this.meterTable();
    if (mi < 0 || mi >= t.perMeasure.length) return this.measureTicks();
    return t.perMeasure[mi];
  }

  /** Absolute tick at the START of measure `mi` — the cumulative sum of all
   *  earlier measures' budgets. `measureStartTick(measureCount)` is the score's
   *  total tick length. Replaces the old uniform `mi * measureTicks()`. */
  measureStartTick(mi: number): number {
    const t = this.meterTable();
    if (mi <= 0) return 0;
    if (mi >= t.prefix.length) return t.prefix[t.prefix.length - 1];
    return t.prefix[mi];
  }

  /** Measure index whose span contains absolute tick `tAbs` (the largest `mi`
   *  with `measureStartTick(mi) <= tAbs`). Replaces `Math.floor(tAbs / W)`. */
  measureIdxAtTick(tAbs: number): number {
    const t = this.meterTable();
    const n = t.measures.length;
    if (n === 0) return 0;
    /* prefix is monotonic non-decreasing; linear scan is fine (measure counts
       are small) and avoids binary-search edge cases at exact boundaries. */
    let mi = 0;
    for (let i = 0; i < n; i++) {
      if (t.prefix[i] <= tAbs + TICK_EPS) mi = i;
      else break;
    }
    return mi;
  }

  /** Index of a `<measure>` element in document order, or -1. */
  measureIdxOf(measure: Element): number {
    return this.meterTable().measures.indexOf(measure);
  }

  /** The `<measure>` ancestor of an arbitrary node (layer/staff/etc.), or null. */
  measureElementOf(node: Element | null): Element | null {
    let n: Element | null = node;
    while (n && n.localName !== 'measure') n = n.parentElement;
    return n;
  }

  /** Tick budget for the measure containing `layer`. Falls back to the
   *  score-default budget if the layer has no measure ancestor (defensive). */
  measureTicksForLayer(layer: Element): number {
    const m = this.measureElementOf(layer);
    if (!m) return this.measureTicks();
    const b = this.meterTable().budgetByEl.get(m);
    return b ?? this.measureTicks();
  }

  /** Meter (count, unit) in effect at measure `mi` (nearest in-section
   *  `<scoreDef>` meter override at or before `mi`, else the head). */
  meterAt(mi: number): MeterInfo {
    const t = this.meterTable();
    if (mi < 0 || mi >= t.measures.length) return this.getMeterInfo();
    return t.meterByEl.get(t.measures[mi]) ?? this.getMeterInfo();
  }

  /** The score-default meter descriptor (head `<scoreDef>`), incl. symbol +
   *  beat-groups. The head fallback for `meterAt` out-of-range queries. */
  getMeterInfo(): MeterInfo {
    const headSd = this.doc.querySelector('scoreDef');
    const { count, unit } = this.getTimeSig();
    return { count, unit, sym: readMeterSym(headSd), beatGroups: readBeatGroups(headSd) };
  }

  /** Key signature in effect at measure `mi` (nearest in-section `<scoreDef>`
   *  key override at or before `mi`, else the head). */
  keySigAt(mi: number): string {
    const t = this.meterTable();
    if (mi < 0 || mi >= t.measures.length) return this.getKeySig();
    return t.keyByEl.get(t.measures[mi])?.sig ?? this.getKeySig();
  }

  /** Key mode (major/minor) in effect at measure `mi`. */
  keyModeAt(mi: number): 'major' | 'minor' {
    const t = this.meterTable();
    if (mi < 0 || mi >= t.measures.length) return this.getKeyMode();
    return t.keyByEl.get(t.measures[mi])?.mode ?? this.getKeyMode();
  }

  /** Key signature in effect for the `<measure>` element (used by the accidental
   *  pipeline, which walks measures in document order). */
  keySigForMeasure(measure: Element): string {
    return this.meterTable().keyByEl.get(measure)?.sig ?? this.getKeySig();
  }

  /* ── instrument table ─────────────────────────────────────────────────────
     The flat voice index ↔ (instrument, staff, layer) map. Mirrors the meter
     table (lazy cache + central invalidation). For the historic single-piano
     doc this is one implicit 2-staff instrument, reproducing the v1→s1l1 …
     v4→s2l2 mapping exactly — so every site routed through staffForVoice /
     layerForVoice is byte-identical on pre-multi-instrument docs. */

  /** Drop the cached instrument table. Call after any change to the head
   *  `<scoreDef>`'s staffGrp set (add/remove instrument). normalizePlaceholdersAll
   *  calls this, so most callers get it for free. */
  invalidateInstrumentCache(): void {
    this.instrCache = null;
  }

  /** Lazily build the instrument table from the head `<scoreDef>`'s root
   *  `<staffGrp>`. Two shapes are recognised:
   *   • IMPLICIT (old/default doc): the root staffGrp's direct children are
   *     `<staffDef>`s → ONE instrument ("Piano"), the root staffGrp itself.
   *     This shape is never rewritten on load (byte-identity for legacy .hkc).
   *   • EXPLICIT: the root staffGrp's children are nested `<staffGrp>`s, one per
   *     instrument; each carries `hkl:instr` + an optional `<label>`.
   *  Staff @n is global-sequential across instruments in document order; each
   *  staff contributes 2 voices (layer 1 then 2). */
  private instrumentTable(): {
    instruments: InstrumentEntry[];
    staffForVoice: number[];
    layerForVoice: number[];
    instrForVoice: number[];
    staffNToInstr: Map<number, InstrumentEntry>;
    totalVoices: number;
    totalStaves: number;
  } {
    if (this.instrCache) return this.instrCache;
    const head = this.doc.querySelector('scoreDef');
    const rootGrp = head?.querySelector('staffGrp') ?? null;
    const instruments: InstrumentEntry[] = [];
    if (rootGrp) {
      const nestedGrps = Array.from(rootGrp.children).filter(
        (c) => c.localName === 'staffGrp',
      );
      /* Nested groups present → each is an instrument; else the root staffGrp
         (with its direct <staffDef>s) is the single implicit instrument. */
      const grpEls = nestedGrps.length > 0 ? nestedGrps : [rootGrp];
      let idx = 0;
      for (const grp of grpEls) {
        const staffNs = Array.from(grp.children)
          .filter((c) => c.localName === 'staffDef')
          .map((d) => parseInt(d.getAttribute('n') ?? '0', 10))
          .filter((n) => n > 0);
        if (staffNs.length === 0) continue;
        const labelEl = Array.from(grp.children).find((c) => c.localName === 'label');
        const name =
          labelEl?.textContent?.trim() ||
          (idx === 0 ? 'Piano' : `Instrument ${idx + 1}`);
        const instrKey =
          grp.getAttributeNS(HKL_NS, 'instr') ||
          grp.getAttribute('hkl:instr') ||
          'piano';
        instruments.push({
          index: idx,
          name,
          instrKey,
          staffGrp: grp,
          staffNs,
          voiceBase: 0,
          voiceCount: 0,
        });
        idx++;
      }
    }
    /* 1-based flat voice arrays (index 0 unused, matching 1-based voices). */
    const staffForVoice: number[] = [0];
    const layerForVoice: number[] = [0];
    const instrForVoice: number[] = [0];
    const staffNToInstr = new Map<number, InstrumentEntry>();
    let voice = 1;
    let totalStaves = 0;
    for (const inst of instruments) {
      inst.voiceBase = voice;
      for (const staffN of inst.staffNs) {
        staffNToInstr.set(staffN, inst);
        totalStaves++;
        for (const layerN of [1, 2]) {
          staffForVoice[voice] = staffN;
          layerForVoice[voice] = layerN;
          instrForVoice[voice] = inst.index;
          voice++;
        }
      }
      inst.voiceCount = voice - inst.voiceBase;
    }
    this.instrCache = {
      instruments,
      staffForVoice,
      layerForVoice,
      instrForVoice,
      staffNToInstr,
      totalVoices: voice - 1,
      totalStaves,
    };
    return this.instrCache;
  }

  /** The score's instruments in document order. */
  instruments(): readonly InstrumentEntry[] {
    return this.instrumentTable().instruments;
  }

  /** Global `<staff>` @n that flat voice `v` lives on (defaults to 1). */
  staffForVoice(v: number): number {
    return this.instrumentTable().staffForVoice[v] ?? 1;
  }

  /** Layer @n (1|2) that flat voice `v` lives on (defaults to 1). */
  layerForVoice(v: number): number {
    return this.instrumentTable().layerForVoice[v] ?? 1;
  }

  /** The instrument owning flat voice `v` (defaults to the first instrument). */
  instrumentOf(v: number): InstrumentEntry {
    const t = this.instrumentTable();
    return t.instruments[t.instrForVoice[v] ?? 0] ?? t.instruments[0];
  }

  /** Flat voice indices belonging to instrument `i`, in order. */
  voicesForInstrument(i: number): number[] {
    const inst = this.instrumentTable().instruments[i];
    if (!inst) return [];
    return Array.from({ length: inst.voiceCount }, (_, k) => inst.voiceBase + k);
  }

  /** Total voices across all instruments (4 for the default doc). */
  totalVoices(): number {
    return this.instrumentTable().totalVoices;
  }

  /** Total staves across all instruments (2 for the default doc). */
  totalStaves(): number {
    return this.instrumentTable().totalStaves;
  }

  /* ── instrument mutations ──────────────────────────────────────────────────
     Add/remove an instrument: structural edits to the head <scoreDef>'s
     staffGrp set + every measure's <staff> blocks. The first add PROMOTES the
     implicit single-piano shape into nested form; a remove that leaves a sole
     default piano DEMOTES back to the implicit shape, so add-then-remove
     round-trips to byte-identical original MEI. */

  /** Append a `<staff n=N>` (2 empty layers) for each of `staffNs` to
   *  `measure`, keeping `<staff>` elements in ascending-@n document order. */
  private addStavesToMeasure(measure: Element, staffNs: number[]): void {
    for (const staffN of staffNs) {
      const staff = el(this.doc, "staff", { n: staffN, "xml:id": newId("s") });
      staff.appendChild(el(this.doc, "layer", { n: 1, "xml:id": newId("l") }));
      staff.appendChild(el(this.doc, "layer", { n: 2, "xml:id": newId("l") }));
      const after = Array.from(measure.querySelectorAll("staff")).find(
        (s) => parseInt(s.getAttribute("n") ?? "0", 10) > staffN,
      );
      const lastStaff = Array.from(measure.querySelectorAll("staff")).pop() ?? null;
      if (after) measure.insertBefore(staff, after);
      else if (lastStaff) measure.insertBefore(staff, lastStaff.nextSibling);
      else measure.appendChild(staff);
    }
  }

  /** Add a new instrument (1- or 2-staff) after the existing ones. Promotes the
   *  implicit single-piano shape to nested form on the first add. Default
   *  clefs: G/2 (+ F/4 for the bottom staff of a grand staff). */
  addInstrument(opts: { name: string; instrKey: string; staffCount: 1 | 2 }): void {
    const head = this.doc.querySelector("scoreDef");
    let root = head?.querySelector("staffGrp") ?? null;
    if (!head || !root) return;
    /* Promote the implicit shape → nested, making the existing piano the first
       instrument. (Direct <staffDef> children ⇒ implicit shape.) */
    if (Array.from(root.children).some((c) => c.localName === "staffDef")) {
      const newRoot = this.doc.createElementNS(MEI_NS, "staffGrp");
      head.replaceChild(newRoot, root);
      if (!root.getAttributeNS(HKL_NS, "instr") && !root.getAttribute("hkl:instr"))
        root.setAttributeNS(HKL_NS, "hkl:instr", "piano");
      if (!Array.from(root.children).some((c) => c.localName === "label")) {
        const lbl = el(this.doc, "label");
        lbl.textContent = "Piano";
        root.insertBefore(lbl, root.firstChild);
      }
      newRoot.appendChild(root);
      root = newRoot;
    }
    const existingNs = Array.from(root.querySelectorAll("staffDef"))
      .map((d) => parseInt(d.getAttribute("n") ?? "0", 10));
    let nextN = (existingNs.length ? Math.max(...existingNs) : 0) + 1;
    const grp = this.doc.createElementNS(MEI_NS, "staffGrp");
    grp.setAttributeNS(HKL_NS, "hkl:instr", opts.instrKey);
    if (opts.staffCount === 2) {
      grp.setAttribute("symbol", "brace");
      grp.setAttribute("bar.thru", "true");
    }
    const lbl = el(this.doc, "label");
    lbl.textContent = opts.name;
    grp.appendChild(lbl);
    const newStaffNs: number[] = [];
    for (let s = 0; s < opts.staffCount; s++) {
      const n = nextN++;
      newStaffNs.push(n);
      const bottom = opts.staffCount === 2 && s === 1;
      grp.appendChild(el(this.doc, "staffDef", {
        n, lines: 5,
        "clef.shape": bottom ? "F" : "G",
        "clef.line": bottom ? "4" : "2",
      }));
    }
    root.appendChild(grp);
    for (const m of this.allMeasures()) this.addStavesToMeasure(m, newStaffNs);
    this.invalidateInstrumentCache();
    normalizeTies(this);
    this.normalizePlaceholdersAll();
    this.ensureCursorSlots();
  }

  /** Remove instrument `i`: drop its staffGrp + per-measure staves + its
   *  control events, renumber the survivors, then demote if a sole default
   *  piano remains. Resets the cursor (voice identity shifts on renumber). */
  removeInstrument(i: number): void {
    const insts = this.instruments();
    if (i < 0 || i >= insts.length || insts.length <= 1) return;
    const inst = insts[i];
    const drop = new Set(inst.staffNs);
    inst.staffGrp.parentNode?.removeChild(inst.staffGrp);
    for (const m of this.allMeasures()) {
      for (const s of Array.from(m.querySelectorAll("staff"))) {
        if (drop.has(parseInt(s.getAttribute("n") ?? "0", 10))) s.parentNode?.removeChild(s);
      }
    }
    for (const ce of Array.from(this.doc.querySelectorAll(
      "dynam, dir, hairpin, pedal, tempo, octave, trill, fermata, breath",
    ))) {
      const sn = parseInt(ce.getAttribute("staff") ?? "0", 10);
      if (drop.has(sn)) ce.parentNode?.removeChild(ce);
    }
    this.renumberStaves();
    this.maybeDemoteToImplicit();
    this.invalidateInstrumentCache();
    this.currentVoice = 1;
    this.cursors = {};
    normalizeTies(this);
    this.normalizePlaceholdersAll();
    this.ensureCursorSlots();
  }

  /** Reorder the instruments to `order` (a permutation of the current instrument
   *  indices, top-to-bottom). Re-sequences the nested `<staffGrp>`s, then
   *  renumbers staves + remaps `@staff` + reorders each measure's `<staff>`
   *  (content travels). Resets the cursor (voice identity shifts). No-op unless
   *  there are ≥2 instruments and `order` is a full permutation. */
  reorderInstruments(order: number[]): void {
    const head = this.doc.querySelector("scoreDef");
    const root = head?.querySelector("staffGrp");
    if (!root) return;
    const groups = Array.from(root.children).filter((c) => c.localName === "staffGrp");
    if (groups.length < 2 || order.length !== groups.length) return;
    const seen = new Set(order);
    if (seen.size !== groups.length || order.some((i) => i < 0 || i >= groups.length)) return;
    /* appendChild moves each group to the end; iterating `order` rebuilds it. */
    for (const idx of order) root.appendChild(groups[idx]);
    this.renumberStaves();
    this.invalidateInstrumentCache();
    this.currentVoice = 1;
    this.cursors = {};
    normalizeTies(this);
    this.normalizePlaceholdersAll();
    this.ensureCursorSlots();
  }

  /** Renumber all `<staffDef>` globally 1..N (document order) and remap every
   *  `<staff>` @n and control-event @staff to match. */
  private renumberStaves(): void {
    const head = this.doc.querySelector("scoreDef");
    const root = head?.querySelector("staffGrp");
    if (!root) return;
    const staffDefs = Array.from(root.querySelectorAll("staffDef"));
    const map = new Map<number, number>();
    staffDefs.forEach((d, k) => map.set(parseInt(d.getAttribute("n") ?? "0", 10), k + 1));
    staffDefs.forEach((d, k) => d.setAttribute("n", String(k + 1)));
    const remap = (n: number) => map.get(n) ?? n;
    for (const m of this.allMeasures()) {
      const updates = Array.from(m.querySelectorAll("staff"))
        .map((s) => [s, remap(parseInt(s.getAttribute("n") ?? "0", 10))] as const);
      for (const [s, n] of updates) s.setAttribute("n", String(n));
      /* Re-order the <staff> elements (content travels with them) so document
         order matches ascending @n — needed after an instrument REORDER, where
         the new @n no longer matches the existing element order. */
      const staves = Array.from(m.querySelectorAll("staff"))
        .sort((a, b) => parseInt(a.getAttribute("n") ?? "0", 10) - parseInt(b.getAttribute("n") ?? "0", 10));
      for (const s of staves) m.appendChild(s);
    }
    for (const ce of Array.from(this.doc.querySelectorAll(
      "dynam, dir, hairpin, pedal, tempo, octave, trill, fermata, breath",
    ))) {
      const a = ce.getAttribute("staff");
      if (a === null) continue;
      ce.setAttribute("staff", a.trim().split(/\s+/).map((t) => String(remap(parseInt(t, 10)))).join(" "));
    }
  }

  /** If exactly one instrument remains and it's a default 2-staff piano in
   *  nested form, unwrap it back to the implicit root-staffGrp shape (strips
   *  the hkl:instr + <label> added by promote) so add-then-remove round-trips
   *  to the byte-identical original MEI. */
  private maybeDemoteToImplicit(): void {
    const head = this.doc.querySelector("scoreDef");
    const root = head?.querySelector("staffGrp");
    if (!head || !root) return;
    const nested = Array.from(root.children).filter((c) => c.localName === "staffGrp");
    if (nested.length !== 1) return;
    const only = nested[0];
    const staffDefs = Array.from(only.children).filter((c) => c.localName === "staffDef");
    if (staffDefs.length !== 2) return;
    const instrKey = only.getAttributeNS(HKL_NS, "instr") || only.getAttribute("hkl:instr") || "piano";
    if (instrKey !== "piano") return;
    only.removeAttributeNS(HKL_NS, "instr");
    only.removeAttribute("hkl:instr");
    for (const lbl of Array.from(only.children).filter((c) => c.localName === "label"))
      only.removeChild(lbl);
    head.replaceChild(only, root);
  }

  /** Ensure an in-section `<scoreDef>` override sits immediately before measure
   *  `mi` and return it. For `mi <= 0` returns the head `<scoreDef>` (the score
   *  default — no override node needed). Reuses an existing override scoreDef
   *  that is already the measure's previous section sibling. Mirrors the
   *  `<ending>`/`<sb>` ref-walk used by insertMeasureAt. */
  private ensureScoreDefBefore(mi: number): Element | null {
    const head = this.doc.querySelector('scoreDef');
    if (mi <= 0) return head;
    const measures = this.allMeasures();
    if (mi >= measures.length) return head;
    const section = this.doc.querySelector('section');
    if (!section || !head) return head;
    /* The measure may be wrapped in an <ending>; the override must precede the
       whole wrapper so it applies to the wrapper's first measure. */
    let ref: Node = measures[mi];
    while (ref.parentNode && ref.parentNode !== section) ref = ref.parentNode;
    const prev = (ref as Element).previousElementSibling;
    if (prev && prev.localName === 'scoreDef') return prev;
    const sd = this.doc.createElementNS(head.namespaceURI, 'scoreDef');
    section.insertBefore(sd, ref);
    return sd;
  }

  /** Set the time signature effective FROM measure `mi` forward (until the next
   *  existing override). `mi === 0` writes the head scoreDef (= setTimeSig).
   *  Truncates overflow only within the affected span.
   *
   *  Diff-aware: if (count, unit) equals what `mi` already INHERITS (the meter
   *  in effect at `mi-1`), no override is written — and any existing meter
   *  attributes on `mi`'s own override are cleared (so submitting an unchanged
   *  meter never renders a redundant meter change). */
  setMeterAt(mi: number, count: number, unit: number, opts?: MeterOpts): void {
    const sym: MeterSym = opts?.sym ?? null;
    const beatGroups: number[] | null = opts?.beatGroups ?? null;
    if (mi <= 0) { this.setTimeSig(count, unit, { sym, beatGroups }); return; }
    const inherited = this.meterAt(mi - 1);
    const sameAsInherited = inherited.count === count && inherited.unit === unit
      && inherited.sym === sym && beatGroupsEqual(inherited.beatGroups, beatGroups);
    /* Find an existing override sibling without creating one. */
    const existing = this.overrideScoreDefBefore(mi);
    if (sameAsInherited) {
      if (!existing || !existing.hasAttribute('meter.count')) return; /* nothing to do */
      existing.removeAttribute('meter.count');
      existing.removeAttribute('meter.unit');
      existing.removeAttribute('meter.sym');
      existing.removeAttributeNS(HKL_NS, BEAT_GROUPS_ATTR);
      this.pruneEmptyScoreDef(existing);
      this.invalidateMeterCache();
      this.normalizePlaceholdersAll();
      return;
    }
    const sd = this.ensureScoreDefBefore(mi);
    if (!sd) return;
    sd.setAttribute('meter.count', String(count));
    sd.setAttribute('meter.unit', String(unit));
    applyMeterOpts(sd, { sym, beatGroups });
    this.invalidateMeterCache();
    /* Truncate from mi up to (but not including) the next measure that carries
       its own meter override. */
    const hi = this.nextMeterOverrideIdx(mi) - 1;
    const v = this.currentVoice;
    const flat = this.flatChildren(v);
    const c = this.cursors[v];
    const lookForward: Element[] = c < flat.length ? flat.slice(c) : [];
    this.truncateOverflowingMeasuresInRange(mi, hi);
    normalizeTies(this);
    this.reanchorCursorAfter(v, lookForward);
  }

  /** Set the key signature effective FROM measure `mi` forward. `mi === 0`
   *  writes the head scoreDef (= setKeySig + setKeyMode). Notes before `mi`
   *  keep the prior key's spelling; the accidental pipeline resets carry-state
   *  to the new key at `mi` (silent switch — no courtesy naturals).
   *
   *  Diff-aware (keyed on `sig` — the rendered key signature): equal to the
   *  inherited sig → no override written + existing key attrs cleared, so an
   *  unchanged key never renders a redundant key change at `mi`. */
  setKeySigAt(mi: number, sig: string, mode: 'major' | 'minor'): void {
    if (mi <= 0) { this.setKeySig(sig); this.setKeyMode(mode); this.invalidateMeterCache(); return; }
    const inheritedSig = this.keySigAt(mi - 1);
    const existing = this.overrideScoreDefBefore(mi);
    if (sig === inheritedSig) {
      if (existing && existing.hasAttribute('key.sig')) {
        existing.removeAttribute('key.sig');
        existing.removeAttribute('mode');
        this.pruneEmptyScoreDef(existing);
      }
      this.invalidateMeterCache();
      return;
    }
    const sd = this.ensureScoreDefBefore(mi);
    if (!sd) return;
    sd.setAttribute('key.sig', sig);
    sd.setAttribute('mode', mode);
    this.invalidateMeterCache();
  }

  /** Set the meter over the inclusive measure span `[lo, hi]`, then restore the
   *  PRIOR meter at `hi+1` so the change is confined to the span ("bounded
   *  restore after the range"). Each call is diff-aware, so the restore at
   *  `hi+1` self-elides when the span change didn't actually alter what `hi+1`
   *  inherits. Used by selection-driven signature changes (Phase 4a). */
  setMeterRange(lo: number, hi: number, count: number, unit: number, opts?: MeterOpts): void {
    const measures = this.allMeasures();
    if (lo < 0 || lo > hi) return;
    /* Capture what hi+1 currently shows so we can pin it back after the span
       change propagates forward. */
    const after = hi + 1 < measures.length ? this.meterAt(hi + 1) : null;
    this.setMeterAt(lo, count, unit, opts);
    if (after) this.setMeterAt(hi + 1, after.count, after.unit, { sym: after.sym, beatGroups: after.beatGroups });
  }

  /** Set the key signature over the inclusive measure span `[lo, hi]`, restoring
   *  the prior key at `hi+1` (bounded restore — Phase 4a). */
  setKeySigRange(lo: number, hi: number, sig: string, mode: 'major' | 'minor'): void {
    const measures = this.allMeasures();
    if (lo < 0 || lo > hi) return;
    const afterSig = hi + 1 < measures.length ? this.keySigAt(hi + 1) : null;
    const afterMode = hi + 1 < measures.length ? this.keyModeAt(hi + 1) : 'major';
    this.setKeySigAt(lo, sig, mode);
    if (afterSig !== null) this.setKeySigAt(hi + 1, afterSig, afterMode);
  }

  /** The in-section override `<scoreDef>` immediately before measure `mi`, if
   *  one already exists (never creates). */
  private overrideScoreDefBefore(mi: number): Element | null {
    const measures = this.allMeasures();
    if (mi <= 0 || mi >= measures.length) return null;
    const section = this.doc.querySelector('section');
    if (!section) return null;
    let ref: Node = measures[mi];
    while (ref.parentNode && ref.parentNode !== section) ref = ref.parentNode;
    const prev = (ref as Element).previousElementSibling;
    return prev && prev.localName === 'scoreDef' ? (prev as Element) : null;
  }

  /** Remove an in-section override `<scoreDef>` once it carries no attributes
   *  (so reverting a measure to fully-inherited leaves no empty node). */
  private pruneEmptyScoreDef(sd: Element | null): void {
    if (!sd) return;
    if (sd === this.doc.querySelector('scoreDef')) return; /* never the head */
    if (sd.attributes.length === 0) sd.parentNode?.removeChild(sd);
  }

  /** Clef in effect at the current cursor for its staff. Inline `<clef>` changes
   *  persist FORWARD across measures (like Verovio renders them), so this walks
   *  every measure up to the cursor's — applying each inline `<clef>` in the
   *  voice's layer — then the cursor measure up to the cursor; falling back to
   *  the head `<staffDef>`. `exclude` skips one inline clef (the one being
   *  edited) so callers can ask "what would be in effect WITHOUT this clef". */
  private effectiveClefForVoice(voice: Voice, cursor: number, exclude?: Element | null): { shape: string; line: string; dis: string | null; disPlace: string | null } {
    const v = voice;
    const staffN = this.staffForVoice(v);
    let shape = staffN === 1 ? 'G' : 'F';
    let line = staffN === 1 ? '2' : '4';
    let dis: string | null = null;
    let disPlace: string | null = null;
    const headDef = Array.from(this.doc.querySelectorAll('scoreDef staffDef'))
      .find((d) => d.getAttribute('n') === String(staffN));
    if (headDef) {
      shape = headDef.getAttribute('clef.shape') ?? shape;
      line = headDef.getAttribute('clef.line') ?? line;
      dis = headDef.getAttribute('clef.dis');
      disPlace = headDef.getAttribute('clef.dis.place');
    }
    const loc = locateCursor(this, v, cursor);
    const cursorMi = loc && !loc.inTuplet ? loc.measureIdx : -1;
    const measures = this.allMeasures();
    const lastMi = cursorMi >= 0 ? cursorMi : measures.length - 1;
    for (let mi = 0; mi <= lastMi && mi < measures.length; mi++) {
      const layer = this.layerInMeasure(measures[mi], v);
      if (!layer) continue;
      /* In the cursor's own measure, stop at the cursor; earlier measures
         contribute every clef they hold (a clef change carries forward). */
      let limit: Element | null = null;
      if (mi === cursorMi && loc) {
        const content = this.contentChildren(loc.layer);
        limit = loc.withinIdx < content.length ? content[loc.withinIdx] : null;
      }
      for (const c of Array.from(layer.children)) {
        if (limit && c === limit) break;
        if (c === exclude) continue;
        if (c.localName === 'clef') {
          shape = c.getAttribute('shape') ?? shape;
          line = c.getAttribute('line') ?? line;
          dis = c.getAttribute('dis');
          disPlace = c.getAttribute('dis.place');
        }
      }
    }
    return { shape, line, dis, disPlace };
  }

  /** Clef in effect at the current cursor for its staff (head staffDef + inline
   *  clef changes carried forward). Used to pre-select the clef modal. */
  clefAtCursor(): { shape: string; line: string; dis: string | null; disPlace: string | null } {
    const v = this.currentVoice;
    return this.effectiveClefForVoice(v, this.cursors[v]);
  }

  /** Insert (or replace) an inline `<clef>` at the current cursor — a
   *  mid-measure clef change for the cursor's staff. Zero-duration: it changes
   *  no ticks/placeholders, only notation. Returns false if the cursor is
   *  inside a tuplet (unsupported in v1). Re-running at the same spot edits the
   *  clef already there. `dis`/`disPlace` give octave clefs (treble+8 etc.). */
  setClefAt(shape: string, line: string, dis: string | null, disPlace: string | null): boolean {
    const v = this.currentVoice;
    return this.setClefAtCursor(v, this.cursors[v], shape, line, dis, disPlace);
  }

  /** Insert/replace an inline `<clef>` at an EXPLICIT (voice, cursor) — the
   *  cursor-parameterized core that `setClefAt` (current cursor) and
   *  `setClefRange` (span endpoints) both call. Zero-duration; clefs aren't
   *  content children, so inserting one never shifts flat-cursor indices. */
  setClefAtCursor(voice: Voice, cursor: number, shape: string, line: string, dis: string | null, disPlace: string | null): boolean {
    const v = voice;
    const loc = locateCursor(this, v, cursor);
    if (!loc || loc.inTuplet) return false;
    const layer = loc.layer;
    const content = this.contentChildren(layer);
    /* Insertion ref = the element at the cursor's tick: the content child at
       withinIdx, else the first trailing placeholder (cursor past content), so
       the clef lands at the cursor's x — not after the invisible padding. */
    let ref: Element | null = loc.withinIdx < content.length ? content[loc.withinIdx] : null;
    if (!ref) ref = Array.from(layer.children).find((c) => isPlaceholder(c)) ?? null;
    /* Reuse a clef already at this spot (re-edit), else create one. */
    const prev = ref ? ref.previousElementSibling : layer.lastElementChild;
    const here = prev && prev.localName === 'clef' ? prev : null;

    /* Diff-aware (mirrors setMeterAt/setKeySigAt): if the requested clef equals
       the clef INHERITED at this spot — the staffDef default plus every inline
       clef carried forward from earlier in the staff, EXCLUDING the one here —
       then writing it would be redundant. Remove the inline clef here instead
       (or no-op if none), so setting a clef back to the prevailing one clears
       the override rather than stacking a redundant clef. */
    const inh = this.effectiveClefForVoice(v, cursor, here);
    const redundant = inh.shape === shape && inh.line === line
      && (inh.dis ?? '') === (dis ?? '') && (inh.disPlace ?? '') === (disPlace ?? '');
    if (redundant) {
      if (here) here.remove();
      return true;
    }

    let clef: Element;
    if (here) {
      clef = here;
    } else {
      clef = el(this.doc, 'clef', { 'xml:id': newId('clf') });
      if (ref) layer.insertBefore(clef, ref);
      else layer.appendChild(clef);
    }
    clef.setAttribute('shape', shape);
    clef.setAttribute('line', line);
    if (dis) {
      clef.setAttribute('dis', dis);
      clef.setAttribute('dis.place', disPlace ?? 'above');
    } else {
      clef.removeAttribute('dis');
      clef.removeAttribute('dis.place');
    }
    return true;
  }

  /** Apply a clef across the beat span `[startCursor, endCursor)` for `voice`,
   *  confined to the span: the new clef is inserted at `startCursor` and the
   *  clef that prevailed at `endCursor` is restored there (Phase 4a, selection-
   *  driven). Captures the restore clef BEFORE mutating. Returns false if either
   *  endpoint is inside a tuplet. */
  setClefRange(voice: Voice, startCursor: number, endCursor: number, shape: string, line: string, dis: string | null, disPlace: string | null): boolean {
    /* The clef in effect just before endCursor today — restored after the new
       clef is laid down so the change doesn't leak past the selection. */
    const restore = this.effectiveClefForVoice(voice, endCursor);
    if (!this.setClefAtCursor(voice, startCursor, shape, line, dis, disPlace)) return false;
    /* endCursor at/after the voice end has nothing to restore onto. */
    if (endCursor < this.getVoiceLength(voice)) {
      this.setClefAtCursor(voice, endCursor, restore.shape, restore.line, restore.dis, restore.disPlace);
    }
    return true;
  }

  /* ── pickup / anacrusis (Phase 4c) ────────────────────────────────────────
     A pickup is a dedicated measure carrying a reduced tick budget
     (hkl:pickup-ticks) + @metcon="false" (Verovio skips the meter-conformance
     check, so the short bar renders without padding). It sits as the first
     measure of a section and is numbered 0 by renumberMeasures. */

  /** First measure index of the section the cursor is in: the nearest measure
   *  at or before the cursor carrying a section title, else 0. */
  sectionStartIdxForCursor(voice?: Voice): number {
    const mi = Math.max(0, this.cursorMeasureIdx(voice));
    const measures = this.allMeasures();
    for (let i = Math.min(mi, measures.length - 1); i > 0; i--) {
      if (measures[i].getAttribute('data-hkl-section-title')) return i;
    }
    return 0;
  }

  /** Pickup length in BEATS (denominator units) for the section starting at
   *  `sectionStartIdx`, or 0 when the section has no pickup. The pickup, once
   *  added, IS the section's first measure. */
  pickupBeatsForSection(sectionStartIdx: number): number {
    const measures = this.allMeasures();
    if (sectionStartIdx < 0 || sectionStartIdx >= measures.length) return 0;
    const ticks = readPickupTicks(measures[sectionStartIdx]);
    if (ticks === null) return 0;
    const { unit } = this.meterAt(sectionStartIdx);
    return Math.round(ticks / (64 / unit));
  }

  /** Add / resize / remove the pickup at the start of the section beginning at
   *  `sectionStartIdx`. `beats` in 1..count-1 sets the pickup length (inserting
   *  a measure 0 if none exists); `beats === 0` removes the pickup measure
   *  (no content confirmation — it's one short bar). Returns true on change. */
  setPickupAt(sectionStartIdx: number, beats: number): boolean {
    const measures = this.allMeasures();
    if (sectionStartIdx < 0 || sectionStartIdx >= measures.length) return false;
    const meter = this.meterAt(sectionStartIdx);
    const unitTicks = 64 / meter.unit;
    const startEl = measures[sectionStartIdx];
    const existing = readPickupTicks(startEl) !== null ? startEl : null;

    if (beats <= 0) {
      if (!existing) return false;
      this.removePickupMeasure(existing);
      return true;
    }
    if (beats >= meter.count) return false; /* a full bar isn't a pickup */

    const budget = beats * unitTicks;
    const pickup = existing ?? this.insertSectionPickup(sectionStartIdx);
    pickup.setAttributeNS(HKL_NS, 'hkl:' + PICKUP_TICKS_ATTR, String(budget));
    pickup.setAttribute('metcon', 'false');
    this.invalidateMeterCache();
    const mi = this.measureIdxOf(pickup);
    /* Truncate any content that no longer fits the reduced budget, then refill
       placeholders to the new budget. */
    this.truncateOverflowingMeasuresInRange(mi, mi);
    normalizeTies(this);
    this.renumberMeasures();
    this.setBarlines();
    this.normalizePlaceholdersAll();
    for (let v: Voice = 1; v <= this.totalVoices(); v++) {
      this.cursors[v] = Math.min(this.cursors[v], this.getVoiceLength(v));
      if (v === this.totalVoices()) break;
    }
    return true;
  }

  /** Insert a fresh empty measure at the front of the section beginning at
   *  `sectionStartIdx` (becomes the new section-first measure). If that measure
   *  carried a section title, the title moves to the pickup so the pickup heads
   *  the section. */
  private insertSectionPickup(sectionStartIdx: number): Element {
    const section = this.doc.querySelector('section');
    const measures = this.allMeasures();
    const startEl = measures[sectionStartIdx];
    const m = el(this.doc, 'measure', { 'xml:id': newId('m') });
    this.appendMeasureStaves(m);
    if (!section) return m;
    /* Section-level node for startEl (unwrap any <ending>). Insert the pickup
       right before it — i.e. after any <sb data-hkl-section> break, so the
       break still precedes the (now pickup-led) section. */
    let ref: Node = startEl;
    while (ref.parentNode && ref.parentNode !== section) ref = ref.parentNode;
    section.insertBefore(m, ref);
    const title = startEl.getAttribute('data-hkl-section-title');
    if (title !== null) {
      m.setAttribute('data-hkl-section-title', title);
      startEl.removeAttribute('data-hkl-section-title');
    }
    /* A tempo marking on the section's downbeat governs the music from its
       start — including the anacrusis — so move it onto the pickup. */
    this.moveDownbeatTempos(startEl, m);
    this.invalidateMeterCache();
    return m;
  }

  /** Move beat-1 INSTANT tempo marks from `from` to the front of `to` (keeping
   *  tstamp=1). Used when a pickup is added/removed so the score's tempo stays
   *  on the section's first sounding moment. Gradual marks (with a tstamp2 span)
   *  stay put — re-encoding their span across a short pickup is ambiguous. */
  private moveDownbeatTempos(from: Element, to: Element): void {
    for (const t of Array.from(from.children)) {
      if (t.localName !== 'tempo') continue;
      if (t.getAttribute('data-hkl-gradual')) continue;
      const ts = parseFloat(t.getAttribute('tstamp') ?? '1');
      if (Math.abs((isFinite(ts) ? ts : 1) - 1) > 1e-6) continue;
      to.insertBefore(t, to.firstChild);
      t.setAttribute('tstamp', '1');
    }
  }

  /** Remove a pickup measure, handing its section title (if any) to the next
   *  measure so the section keeps its heading. */
  private removePickupMeasure(pickup: Element): void {
    const section = this.doc.querySelector('section');
    let node: Node = pickup;
    while (node.parentNode && section && node.parentNode !== section) node = node.parentNode;
    const nextMeasure = this.allMeasures()[this.measureIdxOf(pickup) + 1] ?? null;
    const title = pickup.getAttribute('data-hkl-section-title');
    if (title !== null && nextMeasure) nextMeasure.setAttribute('data-hkl-section-title', title);
    /* Hand any downbeat tempo back to the measure that becomes the section start. */
    if (nextMeasure) this.moveDownbeatTempos(pickup, nextMeasure);
    /* Orphan any ties leaving the pickup's content so survivors re-tag. */
    for (const c of Array.from(pickup.querySelectorAll('note, chord'))) this.orphanTiePartners(c);
    (node as Element).parentNode?.removeChild(node as Element);
    this.invalidateMeterCache();
    this.renumberMeasures();
    this.setBarlines();
    normalizeTies(this);
    this.normalizePlaceholdersAll();
    for (let v: Voice = 1; v <= this.totalVoices(); v++) {
      this.cursors[v] = Math.min(this.cursors[v], this.getVoiceLength(v));
      if (v === this.totalVoices()) break;
    }
  }

  /** First measure index > `mi` that carries its OWN meter override (so a
   *  ranged truncation knows where the changed span ends), or measure count. */
  private nextMeterOverrideIdx(mi: number): number {
    const measures = this.allMeasures();
    const section = this.doc.querySelector('section');
    if (!section) return measures.length;
    for (let i = mi + 1; i < measures.length; i++) {
      let ref: Node = measures[i];
      while (ref.parentNode && ref.parentNode !== section) ref = ref.parentNode;
      const prev = (ref as Element).previousElementSibling;
      if (prev && prev.localName === 'scoreDef'
        && (prev.hasAttribute('meter.count') || prev.hasAttribute('meter.unit'))) {
        return i;
      }
    }
    return measures.length;
  }

  /** Normalize layer-level placeholders across the whole doc, each layer filled
   *  to ITS measure's budget (per-measure-meter aware). Invalidates the meter
   *  cache first so the table reflects whatever structural/meter mutation just
   *  ran. Replaces the old `normalizePlaceholders(this.doc, this.measureTicks())`
   *  pattern at every call site. */
  normalizePlaceholdersAll(): void {
    this.invalidateMeterCache();
    this.invalidateInstrumentCache();
    normalizePlaceholders(this.doc, (layer) => this.measureTicksForLayer(layer));
  }

  /** Return the <layer> for (voice, measure). */
  layerInMeasure(measure: Element, voice: Voice): Element | null {
    const staffN = this.staffForVoice(voice);
    const layerN = this.layerForVoice(voice);
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
        c.localName === "tuplet" ||
        c.localName === "fTrem" ||
        c.localName === "bTrem",
    );
  }


  /** Append a `<staff n=…>` (with 2 empty `<layer>`s) to `measure` for every
   *  staff in the score, in global-@n order. The single source for the
   *  per-instrument measure skeleton — used by appendMeasure / insertMeasureAt.
   *  For the default single-piano doc this emits staves 1+2 exactly as before. */
  private appendMeasureStaves(measure: Element): void {
    for (const inst of this.instruments()) {
      for (const staffN of inst.staffNs) {
        const staff = el(this.doc, "staff", { n: staffN, "xml:id": newId("s") });
        staff.appendChild(el(this.doc, "layer", { n: 1, "xml:id": newId("l") }));
        staff.appendChild(el(this.doc, "layer", { n: 2, "xml:id": newId("l") }));
        measure.appendChild(staff);
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
    this.appendMeasureStaves(m);
    section.appendChild(m);
    this.setBarlines();
    /* Fill the new measure's four empty layers with full-measure placeholders
       so the placeholder invariant holds without callers having to remember
       to normalize. */
    this.normalizePlaceholdersAll();
    return m;
  }

  /** Set @right="end" on the last measure; preserve user-set @right values
   *  ("dbl", future "rptend", etc.) on interior measures. Called whenever the
   *  measure list grows or shrinks. Removing the final-bar from a non-last
   *  measure (the measure that USED to be last) only clears @right if it was
   *  the "end" sentinel — interior measures with explicit user markers stay
   *  as the user left them. */
  setBarlines(): void {
    const measures = this.allMeasures();
    for (let i = 0; i < measures.length; i++) {
      const m = measures[i];
      const right = m.getAttribute("right");
      const isLast = i === measures.length - 1;
      const next = isLast ? null : measures[i + 1];
      const beforeSection = !!next && !!next.getAttribute("data-hkl-section-title");
      /* The final measure, and any measure immediately before a section header,
         carry a final barline (@right="end") — DERIVED from position so it's
         never orphaned when measures are inserted/deleted around it. A backward
         repeat (rptend) wins over the final bar. Everywhere else, clear a stray
         "end" sentinel but leave user markers ("dbl") and repeats alone. */
      if ((isLast || beforeSection) && right !== "rptend") {
        m.setAttribute("right", "end");
      } else if (!isLast && !beforeSection && right === "end") {
        m.removeAttribute("right");
      }
    }
  }

  /** Toggle an articulation `kind` on the current note/chord/rest. Returns
   *  `{ id, on, target: 'chord'|'note'|'rest' }` on success, null on no-op.
   *  Routing:
   *    - chord-internal sel set → applies to that single `<note>` child;
   *    - bare `<note>` → applies to the note itself;
   *    - `<chord>` (no sel) → applies to the chord wrapper (Verovio renders
   *      one glyph for the whole chord);
   *    - `<rest>` → only `kind === 'fermata'` is accepted; others no-op. */
  toggleArticulationAtCursor(
    mode: "insert" | "overwrite",
    kind: ArticKind,
  ): { id: string; on: boolean; target: 'chord' | 'note' | 'rest' } | null {
    const v = this.currentVoice;
    const ref = this.getCurrentElement(v, mode);
    if (!ref) return null;
    if (isPlaceholder(ref.elem)) return null;
    if (ref.elem.localName === 'measure' || ref.elem.localName === 'tuplet') return null;
    /* Articulations attach to the SLOT element (chord wrapper or bare
       note), not individual chord members — "staccato on the bass of a
       chord" doesn't have a notational meaning. Fermata is the only kind
       valid on a rest. */
    let target: Element | null = null;
    let kindOfTarget: 'chord' | 'note' | 'rest' = 'note';
    if (ref.elem.localName === 'rest') {
      if (kind !== 'fermata') return null;
      target = ref.elem;
      kindOfTarget = 'rest';
    } else if (ref.elem.localName === 'note') {
      target = ref.elem;
      kindOfTarget = 'note';
    } else if (ref.elem.localName === 'chord') {
      target = ref.elem;
      kindOfTarget = 'chord';
    }
    if (!target) return null;
    const on = toggleArticulation(target, kind);
    return { id: ref.id, on, target: kindOfTarget };
  }

  /** Toggle a `<trill>` ornament on the current note/chord (voice mode). The
   *  trill is diatonic (Verovio alternates with the upper neighbour). No-op
   *  on rests / placeholders / wrappers. Returns `{ id, on }` or null. */
  toggleTrillAtCursor(mode: "insert" | "overwrite"): { id: string; on: boolean } | null {
    const v = this.currentVoice;
    const ref = this.getCurrentElement(v, mode);
    if (!ref) return null;
    if (isPlaceholder(ref.elem)) return null;
    const ln = ref.elem.localName;
    if (ln !== 'note' && ln !== 'chord') return null;
    const on = toggleTrill(ref.elem);
    return { id: ref.id, on };
  }

  /** Selection-mode trills + tremolos (backlog line 100). Operates on the two
   *  note/chord slots whose onsets fall in [tLo, tHi). Requires EXACTLY two
   *  equal-duration, undotted, non-tuplet slots whose combined value is a
   *  single notehead (else returns null = no-op). Then:
   *    - already wrapped in <fTrem> → unwrap (remove tremolo);
   *    - two single notes a diatonic step apart → collapse to one
   *      combined-duration note + a <trill>;
   *    - otherwise → wrap the pair in <fTrem beams="3"> (two-note tremolo).
   *  Render-only in v1 — playback shaping is deferred. */
  toggleTrillOrTremoloOnSelection(voice: Voice, tLo: number, tHi: number):
    { kind: 'trill' | 'tremolo'; removed: boolean } | null {
    const flat = this.flatChildren(voice);
    const slots: Element[] = [];
    for (let c = 0; c < flat.length; c++) {
      const el2 = flat[c];
      if (el2.localName !== 'note' && el2.localName !== 'chord') continue;
      /* getTickPositionAt is "past flat[c]" (= its end); onset = end − dur. */
      const onset = this.getTickPositionAt(voice, c) - realTicks(el2);
      if (onset >= tLo - 1e-6 && onset < tHi - 1e-6) slots.push(el2);
    }
    if (slots.length !== 2) return null;
    const [a, b] = slots;

    /* Unwrap an existing two-note tremolo. */
    const ft = a.parentElement;
    if (ft && ft.localName === 'fTrem' && b.parentElement === ft) {
      const parent = ft.parentNode;
      if (parent) {
        while (ft.firstChild) parent.insertBefore(ft.firstChild, ft);
        parent.removeChild(ft);
      }
      normalizeTies(this);
      this.normalizePlaceholdersAll();
      return { kind: 'tremolo', removed: true };
    }

    /* Validity gate: equal duration, undotted, not in a tuplet, and the
       combined value must be a single notehead. */
    if (a.closest('tuplet') || b.closest('tuplet')) return null;
    const dotsOf = (e: Element) => parseInt(e.getAttribute('dots') ?? '0', 10) || 0;
    if (dotsOf(a) !== 0 || dotsOf(b) !== 0) return null;
    const wa = writtenTicks(a);
    const wb = writtenTicks(b);
    if (wa !== wb) return null;
    const combined = decomposeTicks(wa + wb);
    if (combined.length !== 1) return null;

    /* They must be consecutive siblings to wrap/collapse cleanly. */
    if (a.parentNode !== b.parentNode) return null;

    /* Diatonic-step test (single notes only): adjacent letter names within a
       2nd, compared as a diatonic pitch number (oct*7 + letterIndex). */
    const LETTER: Record<string, number> = { c: 0, d: 1, e: 2, f: 3, g: 4, a: 5, b: 6 };
    const diatonicNum = (n: Element): number | null => {
      const p = (n.getAttribute('pname') ?? '').toLowerCase();
      const o = parseInt(n.getAttribute('oct') ?? '', 10);
      if (!(p in LETTER) || !Number.isFinite(o)) return null;
      return o * 7 + LETTER[p];
    };
    const isStep = a.localName === 'note' && b.localName === 'note'
      && (() => {
        const da = diatonicNum(a);
        const db = diatonicNum(b);
        return da !== null && db !== null && Math.abs(da - db) === 1;
      })();

    if (isStep) {
      /* Collapse to a single combined-duration note + trill. Total written
         ticks are unchanged (a grows to a+b, b is removed), so placeholders
         stay balanced. Preserve b's EXACT lattice position on `a` so playback
         can alternate between the two real cells (data-hkl-trill-q/r). */
      const bq = b.getAttribute('data-q');
      const br = b.getAttribute('data-r');
      a.setAttribute('dur', combined[0].dur);
      if (combined[0].dots) a.setAttribute('dots', String(combined[0].dots));
      else a.removeAttribute('dots');
      if (bq !== null && br !== null) {
        a.setAttribute('data-hkl-trill-q', bq);
        a.setAttribute('data-hkl-trill-r', br);
      }
      b.parentNode?.removeChild(b);
      toggleTrill(a);
      normalizeTies(this);
      this.normalizePlaceholdersAll();
      return { kind: 'trill', removed: false };
    }

    /* Two-note tremolo: wrap the pair in <fTrem>. Each note is DRAWN at the
       combined value (two quarters → two half-notes) and the tremolo occupies
       that combined value — the standard fingered-tremolo convention. Verovio
       draws 3 tremolo beams between them. */
    for (const n of [a, b]) {
      n.setAttribute('dur', combined[0].dur);
      if (combined[0].dots) n.setAttribute('dots', String(combined[0].dots));
      else n.removeAttribute('dots');
    }
    const fTrem = el(this.doc, 'fTrem', { 'xml:id': newId('ftrem'), beams: 3, 'beams.float': 3 });
    a.parentNode!.insertBefore(fTrem, a);
    fTrem.appendChild(a);
    fTrem.appendChild(b);
    normalizeTies(this);
    this.normalizePlaceholdersAll();
    return { kind: 'tremolo', removed: false };
  }

  /** Toggle `@hkl-paren-caut="true"` on the current note/chord. When `noteId`
   *  is supplied (chord-internal selection), targets that single note; else
   *  applies to every `<note>` under the current element (bare note → that
   *  note; chord → all members). Toggle semantics: if ANY target currently
   *  lacks the flag, set on ALL; if all targets already have it, clear it
   *  from all. Returns `{ id, set, count }` on success, null on no-op. */
  toggleParenCautAtCursor(
    mode: "insert" | "overwrite",
    noteId?: string,
  ): { id: string; set: boolean; count: number } | null {
    const v = this.currentVoice;
    const ref = this.getCurrentElement(v, mode);
    if (!ref) return null;
    if (ref.elem.localName === "rest") return null;
    if (ref.elem.localName === "measure") return null;
    if (ref.elem.localName === "tuplet") return null;
    if (isPlaceholder(ref.elem)) return null;
    let targets: Element[];
    if (noteId) {
      const single = Array.from(ref.elem.localName === "note"
        ? [ref.elem]
        : Array.from(ref.elem.children).filter((c) => c.localName === "note")
      ).find((n) => n.getAttribute("xml:id") === noteId);
      if (!single) return null;
      targets = [single];
    } else if (ref.elem.localName === "note") {
      targets = [ref.elem];
    } else {
      targets = Array.from(ref.elem.children).filter((c) => c.localName === "note");
    }
    if (targets.length === 0) return null;
    const anyOff = targets.some((n) => n.getAttribute("hkl-paren-caut") !== "true");
    const set = anyOff; /* off → set true; else clear */
    for (const n of targets) {
      if (set) n.setAttribute("hkl-paren-caut", "true");
      else n.removeAttribute("hkl-paren-caut");
    }
    return { id: ref.id, set, count: targets.length };
  }

  /** Toggle `@visible="false"` on the current `<rest>` (cursor anchor element
   *  per the dynamics convention — cursor−1 in INS, cursor in OVR; both
   *  resolve to `flat[c]` under the new convention). No-op on non-rest
   *  elements (returns null). Returns `{ id, hidden }` on success. */
  toggleHideRestAtCursor(
    mode: "insert" | "overwrite",
  ): { id: string; hidden: boolean } | null {
    const v = this.currentVoice;
    const ref = this.getCurrentElement(v, mode);
    if (!ref) return null;
    if (ref.elem.localName !== "rest") return null;
    if (isPlaceholder(ref.elem)) return null;
    const cur = ref.elem.getAttribute("visible");
    if (cur === "false") {
      ref.elem.removeAttribute("visible");
      return { id: ref.id, hidden: false };
    }
    ref.elem.setAttribute("visible", "false");
    return { id: ref.id, hidden: true };
  }

  /** Toggle a string-harmonic mark on the note/chord at the cursor anchor.
   *  Sets `data-hkl-harmonic` on the slot (read by playback for the sounding-
   *  pitch shift) and `@head.shape="diamond"` on the slot's highest written
   *  note (the touched/sounding node; for a single note, the note itself).
   *  No-op on rests/placeholders. */
  toggleHarmonicAtCursor(
    mode: "insert" | "overwrite",
  ): { id: string; on: boolean } | null {
    const v = this.currentVoice;
    const ref = this.getCurrentElement(v, mode);
    if (!ref) return null;
    const slot = ref.elem;
    if (slot.localName !== "note" && slot.localName !== "chord") return null;
    if (isPlaceholder(slot)) return null;
    const notes = slot.localName === "note"
      ? [slot]
      : Array.from(slot.children).filter((n) => n.localName === "note");
    if (notes.length === 0) return null;
    if (slot.getAttribute("data-hkl-harmonic") === "true") {
      slot.removeAttribute("data-hkl-harmonic");
      for (const n of notes) { n.removeAttribute("head.shape"); n.removeAttribute("head.fill"); }
      return { id: ref.id, on: false };
    }
    slot.setAttribute("data-hkl-harmonic", "true");
    /* Diamond on the highest-pitched written note (diatonic oct·7 + step).
       `head.fill="void"` forces the OPEN diamond (SMuFL noteheadDiamondHalf)
       regardless of duration, so the harmonic is unfilled (a quarter would
       otherwise draw the filled black diamond). */
    const rank = (n: Element): number => {
      const oct = parseInt(n.getAttribute("oct") ?? "4", 10);
      const pn = (n.getAttribute("pname") ?? "c").toLowerCase();
      return (Number.isFinite(oct) ? oct : 4) * 7 + Math.max(0, "cdefgab".indexOf(pn));
    };
    let top = notes[0];
    for (const n of notes) if (rank(n) > rank(top)) top = n;
    top.setAttribute("head.shape", "diamond");
    top.setAttribute("head.fill", "void");
    return { id: ref.id, on: true };
  }

  /** Doc-level action: fill every partial-but-not-empty layer (across every
   *  measure, every voice) with beat-aligned rests using `decomposeBeatAlignedRests`.
   *  Empty layers stay empty (placeholders only — represent intentional silence);
   *  full layers stay full; partial layers get their trailing placeholders
   *  replaced with visible rests summing to the residual ticks. Cursor
   *  reanchors per voice via the look-forward survival list. */
  fillIncompleteMeasures(): { measuresAffected: number } {
    const measures = this.allMeasures();
    const ts = readTimeSig(this.doc);
    let measuresAffected = 0;
    /* Per-voice cursor preservation: snapshot the look-forward anchors
       before mutating. */
    const looks: Record<number, Element[]> = {};
    for (let v = 1; v <= this.totalVoices(); v++) {
      const flat = this.flatChildren(v);
      const c = this.cursors[v];
      looks[v] = c < flat.length ? flat.slice(c) : [];
    }
    for (let mi = 0; mi < measures.length; mi++) {
      const cap = this.measureTicksAt(mi);
      for (let v = 1; v <= this.totalVoices(); v++) {
        const layer = this.layerInMeasure(measures[mi], v);
        if (!layer) continue;
        const cc = this.contentChildren(layer);
        if (cc.length === 0) continue;          /* fully empty — leave alone */
        let total = 0;
        for (const c of cc) total += realTicks(c);
        if (total >= cap) continue;              /* full — nothing to add */
        /* Replace any trailing placeholders with beat-aligned rests of
           (cap - total) ticks, aligned to the current content's end. */
        for (const c of Array.from(layer.children)) {
          if (isPlaceholder(c)) layer.removeChild(c);
        }
        for (const r of decomposeBeatAlignedRests(total, cap - total, ts)) {
          layer.appendChild(buildRestElement(this.doc, { duration: r.dur, dots: r.dots }));
        }
        measuresAffected++;
      }
    }
    this.normalizePlaceholdersAll();
    for (let v = 1; v <= this.totalVoices(); v++) {
      this.reanchorCursorAfter(v, looks[v] ?? []);
    }
    return { measuresAffected };
  }

  /** Insert a new empty measure BEFORE `beforeMeasureIdx`. The new measure
   *  carries the standard four layers, each filled with full-measure
   *  placeholders. Also breaks any slurs/ties that would now span across
   *  the new (empty) measure: slurs whose endpoints straddle the
   *  insertion are pruned outright; ties are re-realized by `normalizeTies`,
   *  which can no longer pair adjacent notes across the void and demotes
   *  them to stubs. Returns the new measure element. */
  insertMeasureAt(beforeMeasureIdx: number): Element {
    const measures = this.allMeasures();
    if (beforeMeasureIdx >= measures.length) {
      return this.appendMeasure();
    }
    const idx = Math.max(0, beforeMeasureIdx);
    /* Capture pre-insertion measure indexes for every slur endpoint so we
       can detect which slurs straddle the new measure. */
    const slurStraddle: Element[] = [];
    for (const slur of Array.from(this.doc.querySelectorAll('slur'))) {
      const sid = (slur.getAttribute('startid') ?? '').replace('#', '');
      const eid = (slur.getAttribute('endid') ?? '').replace('#', '');
      if (!sid || !eid) continue;
      const startMi = measures.findIndex((meas) => meas.querySelector(`[*|id="${sid}"]`));
      const endMi = measures.findIndex((meas) => meas.querySelector(`[*|id="${eid}"]`));
      if (startMi < 0 || endMi < 0) continue;
      const lo = Math.min(startMi, endMi);
      const hi = Math.max(startMi, endMi);
      /* A slur straddles iff the insertion point falls strictly between
         the endpoints' measures. lo < idx <= hi means the new measure
         (which inserts BEFORE measures[idx]) lands between them. */
      if (lo < idx && idx <= hi) slurStraddle.push(slur);
    }

    const section = this.doc.querySelector("section");
    if (!section) throw new Error("section element missing");
    const m = el(this.doc, "measure", { "xml:id": newId("m") });
    this.appendMeasureStaves(m);
    /* measures[idx] may be wrapped in an <ending>; insertBefore needs a node
       that is a direct child of <section>. Walk up to the section-level
       ancestor (the <ending>, if any) so we insert before the whole volta. */
    let ref: Node = measures[idx];
    while (ref.parentNode && ref.parentNode !== section) ref = ref.parentNode;
    /* If a section break (<sb data-hkl-section>) sits just before the
       reference measure, insert BEFORE the break so the break + its section
       title stay together and the new measure joins the PREVIOUS section. */
    const sbPrev = (ref as Element).previousElementSibling;
    if (sbPrev && sbPrev.localName === "sb" && sbPrev.getAttribute("data-hkl-section") === "true") {
      ref = sbPrev;
    }
    section.insertBefore(m, ref);
    /* Renumber all <measure @n> (section-aware: restarts at each header). */
    this.renumberMeasures();
    this.setBarlines();
    /* Sever the slurs that now straddle the new (empty) measure. */
    for (const slur of slurStraddle) slur.parentNode?.removeChild(slur);
    this.normalizePlaceholdersAll();
    /* Ties: re-realize with the new flat ordering. Notes that were tied
       across the old measure boundary now have the new empty measure's
       wrapper as their "next slot" — extractNoteElements returns [] for
       a wrapper, so the realized tie can't pair and is demoted to a stub. */
    normalizeTies(this);
    return m;
  }

  /** Toggle the "double bar line" marker on the measure at `measureIdx`.
   *  Sets @right="dbl" if currently unset (or any non-dbl value other than
   *  "end"); clears it if currently "dbl". No-op on the last measure (which
   *  always carries @right="end"). Returns the new state, or null on no-op. */
  toggleDoubleBarAt(measureIdx: number): 'dbl' | 'cleared' | null {
    const measures = this.allMeasures();
    if (measureIdx < 0 || measureIdx >= measures.length) return null;
    if (measureIdx === measures.length - 1) return null; /* final bar locked */
    const m = measures[measureIdx];
    const cur = m.getAttribute("right");
    if (cur === "dbl") {
      m.removeAttribute("right");
      return 'cleared';
    }
    m.setAttribute("right", "dbl");
    return 'dbl';
  }

  /** Toggle a forward (start) repeat barline on the measure at `measureIdx`.
   *  Sets @left="rptstart" if currently unset; clears it if already a repeat
   *  start. @left is otherwise unused (setBarlines never touches it), so no
   *  measure is locked. Returns the new state, or null on bad index. */
  toggleRepeatStartAt(measureIdx: number): 'rptstart' | 'cleared' | null {
    const measures = this.allMeasures();
    if (measureIdx < 0 || measureIdx >= measures.length) return null;
    const m = measures[measureIdx];
    if (m.getAttribute("left") === "rptstart") {
      m.removeAttribute("left");
      return 'cleared';
    }
    m.setAttribute("left", "rptstart");
    return 'rptstart';
  }

  /** Toggle a backward (end) repeat barline on the measure at `measureIdx`.
   *  Sets @right="rptend" if currently unset, "dbl", or "end"; clears it if
   *  already a repeat end. Allowed on the final measure (setBarlines preserves
   *  rptend there for whole-piece repeats). Returns the new state, or null on
   *  bad index. */
  toggleRepeatEndAt(measureIdx: number): 'rptend' | 'cleared' | null {
    const measures = this.allMeasures();
    if (measureIdx < 0 || measureIdx >= measures.length) return null;
    const m = measures[measureIdx];
    const isLast = measureIdx === measures.length - 1;
    if (m.getAttribute("right") === "rptend") {
      m.removeAttribute("right");
      /* Restore the final-bar sentinel if we just cleared the last measure. */
      if (isLast) m.setAttribute("right", "end");
      return 'cleared';
    }
    m.setAttribute("right", "rptend");
    return 'rptend';
  }

  /** Toggle a 1st/2nd ending (volta) on the measure at `measureIdx`, one
   *  measure at a time. The MEI encoding wraps `<measure>` elements in an
   *  `<ending n="…">` inside `<section>`; Verovio draws the volta bracket.
   *
   *  Type is context-derived (Max): a measure carrying a backward repeat
   *  (`@right="rptend"`) starts a **1st** ending; the measure immediately
   *  after a backward-repeat measure starts a **2nd** ending; any other
   *  measure **extends an adjacent** ending (grows it by one measure). A
   *  measure already in an ending toggles **off** (only at the ending's edge,
   *  to keep each ending contiguous). Returns `{ n, action }` or null on
   *  no-op. */
  toggleEndingAt(measureIdx: number):
    { n: number; action: 'created' | 'extended' | 'removed' } | null {
    const measures = this.allMeasures();
    if (measureIdx < 0 || measureIdx >= measures.length) return null;
    const m = measures[measureIdx];
    const section = this.doc.querySelector("section");
    if (!section) return null;

    /* Toggle off — only at an edge (interior removal would split the volta). */
    const owner = m.closest("ending");
    if (owner) {
      const kids = Array.from(owner.children).filter((c) => c.localName === "measure");
      const isFirst = kids[0] === m;
      const isLast = kids[kids.length - 1] === m;
      if (!isFirst && !isLast) return null;
      const n = parseInt(owner.getAttribute("n") ?? "1", 10) || 1;
      if (kids.length === 1) {
        /* Last measure in the ending — unwrap and drop the ending. */
        section.insertBefore(m, owner);
        owner.parentNode?.removeChild(owner);
      } else if (isFirst) {
        section.insertBefore(m, owner); /* before the ending → order preserved */
      } else {
        section.insertBefore(m, owner.nextSibling); /* after the ending */
      }
      return { n, action: 'removed' };
    }

    /* Create or extend. */
    const right = m.getAttribute("right");
    const prev = measures[measureIdx - 1] ?? null;
    const next = measures[measureIdx + 1] ?? null;
    const prevEnding = prev?.closest("ending") ?? null;
    const nextEnding = next?.closest("ending") ?? null;

    if (right === "rptend" && !prevEnding) {
      const ending = el(this.doc, "ending", { n: "1", "xml:id": newId("ending") });
      section.insertBefore(ending, m);
      ending.appendChild(m);
      return { n: 1, action: 'created' };
    }
    if (prev?.getAttribute("right") === "rptend" && !nextEnding) {
      const ending = el(this.doc, "ending", { n: "2", "xml:id": newId("ending") });
      section.insertBefore(ending, m);
      ending.appendChild(m);
      return { n: 2, action: 'created' };
    }
    /* Extend an adjacent ending in either direction. */
    if (prevEnding) {
      prevEnding.appendChild(m); /* m sits right after prevEnding → stays in order */
      const n = parseInt(prevEnding.getAttribute("n") ?? "1", 10) || 1;
      return { n, action: 'extended' };
    }
    if (nextEnding) {
      nextEnding.insertBefore(m, nextEnding.firstChild);
      const n = parseInt(nextEnding.getAttribute("n") ?? "1", 10) || 1;
      return { n, action: 'extended' };
    }
    return null; /* no repeat context + no adjacent ending → nothing sensible */
  }

  /** Toggle a page break (`<pb>`) BEFORE the measure at `measureIdx`. The
   *  `<pb>` is a section-level sibling inserted just before the measure (or
   *  its `<ending>` wrapper). Verovio honors it under breaks:'encoded' in page
   *  view. No-op before the first measure (nothing to break onto a new page).
   *  Returns true if added, false if removed, null on bad index. */
  togglePageBreakAt(measureIdx: number): boolean | null {
    const measures = this.allMeasures();
    if (measureIdx <= 0 || measureIdx >= measures.length) return null;
    const section = this.doc.querySelector("section");
    if (!section) return null;
    /* The section-level node containing this measure (itself, or its ending). */
    let node: Node = measures[measureIdx];
    while (node.parentNode && node.parentNode !== section) node = node.parentNode;
    const prev = (node as Element).previousElementSibling;
    if (prev && prev.localName === "pb") {
      prev.parentNode?.removeChild(prev);
      return false;
    }
    section.insertBefore(el(this.doc, "pb", { "xml:id": newId("pb") }), node);
    return true;
  }

  /** Section header (movement title) at the measure `measureIdx`. Pass a
   *  non-empty `title` to set/replace, or '' to remove. A section header:
   *    - tags the measure with `data-hkl-section-title` (rendered centered,
   *      displacing the system, by the post-render injector in main.ts);
   *    - forces a system break (`<sb data-hkl-section>`) so it starts a new
   *      system (Verovio honors it under breaks:'encoded');
   *    - puts a final barline (`@right="end"`) on the preceding measure;
   *    - restarts measure numbering at this measure.
   *  No-op before the first measure (that's the title block's job). Returns
   *  true if set, false if removed, null on bad index. */
  setSectionHeaderAt(measureIdx: number, title: string): boolean | null {
    const measures = this.allMeasures();
    if (measureIdx <= 0 || measureIdx >= measures.length) return null;
    const section = this.doc.querySelector("section");
    if (!section) return null;
    const m = measures[measureIdx];
    let node: Node = m;
    while (node.parentNode && node.parentNode !== section) node = node.parentNode;
    const prev = (node as Element).previousElementSibling;
    const sectionSb = prev && prev.localName === "sb"
      && prev.getAttribute("data-hkl-section") === "true" ? prev : null;

    if (!title) {
      m.removeAttribute("data-hkl-section-title");
      sectionSb?.parentNode?.removeChild(sectionSb);
      this.setBarlines();
      this.renumberMeasures();
      return false;
    }

    m.setAttribute("data-hkl-section-title", title);
    if (!sectionSb) {
      section.insertBefore(
        el(this.doc, "sb", { "xml:id": newId("sb"), "data-hkl-section": "true" }),
        node,
      );
    }
    /* Final barline on the measure before the section (unless it's a repeat). */
    const prevMeasure = measures[measureIdx - 1];
    if (prevMeasure && prevMeasure.getAttribute("right") !== "rptend") {
      prevMeasure.setAttribute("right", "end");
    }
    this.renumberMeasures();
    return true;
  }

  /* ── navigation ─────────────────────────────────────────────────────────── */

  switchVoice(dir: "up" | "down"): Voice {
    const cur = this.currentVoice;
    const maxV = this.totalVoices();
    let next: Voice;
    if (dir === "up") next = cur > 1 ? cur - 1 : 1;
    else next = cur < maxV ? cur + 1 : maxV;
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
    const srcStart = this.measureStartTick(srcMeasure);
    const srcAbs = this.getCursorAbsoluteTicks(srcV);
    const within = srcAbs - srcStart;
    this.setVoice(tgtV);
    let cand = this.findCursorByTickPosition(tgtV, srcStart + within);
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
    const cap = this.measureTicksForLayer(layer);
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
    /* tstamp is in beats of the measure's OWN meter (mid-piece meter change),
       so the beat unit must be the one in effect at loc.measureIdx — not the
       head. absoluteTickForMoment uses the same local unit to invert this. */
    const { unit } = this.meterAt(loc.measureIdx);
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
    this.normalizePlaceholdersAll();
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
    this.normalizePlaceholdersAll();
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
    this.normalizePlaceholdersAll();
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
    this.normalizePlaceholdersAll();
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
        this.normalizePlaceholdersAll();
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
      this.normalizePlaceholdersAll();
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
      this.normalizePlaceholdersAll();
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
    if (usedBefore + newTicks + postBlockTicks <= this.measureTicksAt(measureIdx)) {
      this.orphanTiePartners(target);
      const replaced = buildChordElement(this.doc, input);
      layer.replaceChild(replaced, target);
      this.resolvePendingTies(cursorAtCall);
      this.normalizePlaceholdersAll();
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
    this.normalizePlaceholdersAll();
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
      for (let vi = 1 as Voice; vi <= this.totalVoices(); vi++) {
        this.cursors[vi] = Math.min(
          this.cursors[vi],
          this.getVoiceLength(vi),
        );
        if (vi === this.totalVoices()) break;
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
          this.normalizePlaceholdersAll();
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
        this.normalizePlaceholdersAll();
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
        this.normalizePlaceholdersAll();
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
      this.normalizePlaceholdersAll();
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
    this.normalizePlaceholdersAll();
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
    let effectiveLo = tLoAbs;
    let effectiveHi = tLoAbs + srcDurationTicks;

    /* Expand effective range to swallow any tuplets in the source voice's
       layers that partially overlap [tLoAbs, effectiveHi). */
    const measures0 = this.allMeasures();
    for (let mi = 0; mi < measures0.length; mi++) {
      const mStart = this.measureStartTick(mi);
      const mEnd = this.measureStartTick(mi + 1);
      if (mStart >= effectiveHi) break;
      if (mEnd <= tLoAbs) continue;
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
    while (effectiveHi > this.measureStartTick(this.allMeasures().length)) {
      this.appendMeasure();
    }

    /* Remove all layer-level content in voice that intersects
       [effectiveLo, effectiveHi). */
    const measures = this.allMeasures();
    for (let mi = 0; mi < measures.length; mi++) {
      const mStart = this.measureStartTick(mi);
      const mEnd = this.measureStartTick(mi + 1);
      if (mStart >= effectiveHi) break;
      if (mEnd <= effectiveLo) continue;
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
      const measureIdxLeading = this.measureIdxAtTick(effectiveLo);
      const inMeasureLo = effectiveLo - this.measureStartTick(measureIdxLeading);
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
      const measureIdxTrailing = this.measureIdxAtTick(afterSrc);
      const inMeasureLo = afterSrc - this.measureStartTick(measureIdxTrailing);
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
    this.normalizePlaceholdersAll();
    for (let vi: Voice = 1; vi <= this.totalVoices(); vi++) {
      this.cursors[vi] = Math.min(this.cursors[vi], this.getVoiceLength(vi));
      if (vi === this.totalVoices()) break;
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
      if (used + tupletTicks > this.measureTicksAt(loc.measureIdx) + 1e-6) return false;
      /* Clone into our doc with fresh ids. */
      const fresh = src.cloneNode(true) as Element;
      this.regenerateIds(fresh);
      insertAt(this, loc.layer, fresh, loc.withinIdx);
      /* Advance cursor past the tuplet's contributed flat stops. The simplest
         way is to compute the new cursor via tstamp lookup. */
      const newTstamp = this.getCursorAbsoluteTicks(v) + tupletTicks;
      this.normalizePlaceholdersAll();
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
    firstStaff: number,
    lastStaff: number,
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
    this.normalizePlaceholdersAll();
    for (let vi: Voice = 1; vi <= this.totalVoices(); vi++) {
      this.cursors[vi] = Math.min(this.cursors[vi], this.getVoiceLength(vi));
      if (vi === this.totalVoices()) break;
    }
    return { ok: true, mLo: mDest, mHi: mDest + N - 1 };
  }

  /** Empty all layers of staves [firstStaff..lastStaff] in measures
   *  [mLo..mHi] inclusive. Removes <dynam>/<hairpin> control events anchored
   *  to those measures whose staff attribute is in range. normalizePlaceholders
   *  re-fills emptied layers with placeholders so cursor navigation stays
   *  consistent. Used by Ctrl+X on a measure selection. */
  clearMeasureRange(mLo: number, mHi: number, firstStaff: number, lastStaff: number): void {
    clearMeasureRangeImpl(this, mLo, mHi, firstStaff, lastStaff);
  }

  private measureIsEmpty(measure: Element): boolean {
    for (let v: Voice = 1; v <= this.totalVoices(); v++) {
      const layer = this.layerInMeasure(measure, v);
      if (layer && this.contentChildren(layer).length > 0) return false;
      if (v === this.totalVoices()) break;
    }
    return true;
  }

  /** Renumber every `<measure @n>`, restarting at 1 wherever a section header
   *  (`data-hkl-section-title`) begins, so section-aware numbering survives
   *  inserts/deletes. */
  private renumberMeasures(): void {
    let n = 1;
    for (const mm of this.allMeasures()) {
      if (mm.getAttribute("data-hkl-section-title")) n = 1;
      /* A pickup/anacrusis measure is numbered 0 and does NOT advance the
         counter, so the section's first FULL measure stays "1". */
      if (readPickupTicks(mm) !== null) {
        mm.setAttribute("n", "0");
        n = 1;
        continue;
      }
      mm.setAttribute("n", String(n));
      n++;
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
      this.normalizePlaceholdersAll();
        return { id: ref.id, newDots: nextDots };
    }

    /* Determine fit within current measure. */
    const loc = locateCursor(this, v, ref.index);
    if (!loc) return null;
    const kids = this.contentChildren(loc.layer);
    const idxInLayer = kids.indexOf(elem);
    if (idxInLayer < 0) return null;
    const ticksBefore = this.timeWithinMeasure(v, loc.measureIdx, idxInLayer);
    const remaining = this.measureTicksAt(loc.measureIdx) - ticksBefore;

    if (newTotalTicks <= remaining) {
      /* Fits in measure: just set/remove @dots. */
      if (nextDots > 0) elem.setAttribute("dots", String(nextDots));
      else elem.removeAttribute("dots");
      this.normalizePlaceholdersAll();
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
    this.normalizePlaceholdersAll();
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
    this.normalizePlaceholdersAll();
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
    this.truncateOverflowingMeasuresInRange(0, this.allMeasures().length - 1);
  }

  /** Truncate overflow in measures [miLo..miHi] only, each against ITS own
   *  meter budget. A global meter change truncates the whole doc (miLo=0,
   *  miHi=last); a future per-measure change (Phase 4.2) truncates only the
   *  span from the change point to the next override. */
  private truncateOverflowingMeasuresInRange(miLo: number, miHi: number): void {
    const measures = this.allMeasures();
    const lo = Math.max(0, miLo);
    const hi = Math.min(miHi, measures.length - 1);
    for (let mi = lo; mi <= hi; mi++) {
      const cap = this.measureTicksAt(mi);
      for (let v: Voice = 1; v <= this.totalVoices(); v++) {
        const layer = this.layerInMeasure(measures[mi], v);
        if (layer) this.truncateLayer(layer, cap);
        if (v === this.totalVoices()) break;
      }
    }
    this.normalizePlaceholdersAll();
    for (let v: Voice = 1; v <= this.totalVoices(); v++) {
      this.cursors[v] = Math.min(this.cursors[v], this.getVoiceLength(v));
      if (v === this.totalVoices()) break;
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

/** Render-clone single-part filter: drop every `<staff>`, `<staffDef>`, and
 *  staff-anchored control event whose `@n`/`@staff` is not in `keep`, then
 *  prune emptied `<staffGrp>`s. Operates IN PLACE on a serialize clone — never
 *  the live doc. Staff @n are NOT renumbered (the cursor resolves staves by
 *  the doc's @n → xml:id, which must stay stable). Spanning controls whose
 *  `@startid` points at a dropped note are removed too (else Verovio warns). */
function filterToStaves(clone: Document, keep: ReadonlySet<number>): void {
  /* Collect the xml:ids of notes/chords/rests on dropped staves so we can also
     drop slurs/ties/octaves/etc. that reference them via @startid/@endid. */
  const droppedIds = new Set<string>();
  for (const staff of Array.from(clone.querySelectorAll('measure staff'))) {
    const n = parseInt(staff.getAttribute('n') ?? '0', 10);
    if (keep.has(n)) continue;
    for (const e of Array.from(staff.querySelectorAll('[*|id]'))) {
      const id = e.getAttribute('xml:id');
      if (id) droppedIds.add(id);
    }
    staff.parentNode?.removeChild(staff);
  }
  /* Drop staffDefs for hidden staves, then any staffGrp left with none. */
  for (const sd of Array.from(clone.querySelectorAll('scoreDef staffDef'))) {
    const n = parseInt(sd.getAttribute('n') ?? '0', 10);
    if (!keep.has(n)) sd.parentNode?.removeChild(sd);
  }
  for (const grp of Array.from(clone.querySelectorAll('scoreDef staffGrp'))) {
    if (!grp.querySelector('staffDef')) grp.parentNode?.removeChild(grp);
  }
  /* Drop control events anchored to a hidden staff or a dropped note. */
  for (const ev of Array.from(clone.querySelectorAll('measure > *'))) {
    if (ev.localName === 'staff') continue;
    const st = ev.getAttribute('staff');
    if (st != null && !keep.has(parseInt(st, 10))) { ev.parentNode?.removeChild(ev); continue; }
    const refAttr = ev.getAttribute('startid') ?? ev.getAttribute('endid');
    const refId = refAttr?.replace(/^#/, '');
    if (refId && droppedIds.has(refId)) ev.parentNode?.removeChild(ev);
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
