// Page-view line-break ownership (Phase C foundation — "own the line-breaking",
// docs/composer-page-splice-design.md, spike 5).
//
// In page view, Composer — not Verovio's castoff — decides which measure starts
// each system. The partition is pinned as render-time <sb> elements injected
// into the serialized render MEI (never into the live doc: saves, undo
// snapshots and history diffs stay pin-free by construction). Verovio remains
// the measure-level engraver + within-line justifier; with every boundary
// pinned, castoff has no free choices left, so an edit can only move the
// boundaries WE move.
//
// THE PARTITION IS NEVER RE-DERIVED (Max's ruling, 2026-08-30). An edit carries
// the existing partition across by line MEMBERSHIP and then repairs ONLY the
// lines the edit made ILLEGAL — outside the [MIN_FILL, FIT_MAX] envelope — by
// moving as few measures as possible. Everything else stays exactly where it
// was. This is what makes edits reversible: a greedy re-derivation accepts any
// line up to FIT_MAX, so a measure pulled into a line by a deletion stayed
// there when the deletion was undone (threshold hysteresis — the layout drifted
// one measure per edit and never drifted back). With conservative repair a
// no-op edit provably moves nothing, undo restores the original layout, and the
// legality bounds above are the only tuning surface. (An explicit "reflow the
// whole document as if freshly engraved" command, and explicit move-measure-
// between-systems commands, are deliberately future work — not this path.)
//
// Lifecycle:
//   derive render (doc load / zoom / page scale / staff filter / any fallback)
//     → today's strategy, byte-identical output (nothing changes at enablement);
//       the partition is ADOPTED from the laid-out toolkit lazily — an
//       idle-chunked renderToSVG walk (~2 s on the 37-page sonata), finished
//       synchronously if an edit arrives first.
//   edit in page view (narrow accumulated dirty range)
//     → naturals for the dirty window are (re)measured from an offscreen
//       breaks:'none' sub-render (spanner/ending-complete, context-padded),
//       the partition is carried across by membership and any line the edit
//       made illegal is repaired minimally (push/pull one measure at a time,
//       hard breaks respected), pins are re-encoded, and the doc re-renders with
//       breaks:'line' — every <sb> honored VERBATIM, pages still broken
//       automatically by height (probed 2026-08-30: 'line', unlike 'smart',
//       never wraps a pinned line it deems overfull, so the partition really
//       is ours; 'smart' rewrapped refilled lines wholesale). Docs with user
//       page breaks render 'encoded' instead — 'line' ignores <pb>, and
//       verbatim page semantics are what those docs already have today.
//   anything the refill can't prove (structural dirty, changed user breaks or
//   head/staff context, missing ids, window caps) → derive, never silently.
//
// Pin placement rules (probed 2026-08-30, lessons.md):
//   - a pin lands directly BEFORE its measure — including directly after a
//     scoreDef (matches the model's own section-break convention
//     `scoreDef, sb, measure`; partition parity verified for both orders);
//   - a pin whose position directly follows an </ending> goes INSIDE the
//     wrapper as its last child (smart castoff silently ignores it outside);
//   - an existing user sb/pb directly before the measure IS the break — no pin.

import type { VerovioToolkit } from '@hkl/notation/verovio-types.js';
import type { ComposerModel } from '../model/index.js';
import { expandForSpanners, expandForEndings } from './splice.js';

const MEI_NS = 'http://www.music-encoding.org/ns/mei';

/** LEGALITY bounds — the load-bearing tuning surface (Max, 2026-08-30).
 *  Fills are (sigW + Σ natural widths)/budget: >1 = the justified line
 *  compresses, <1 = it stretches. These are NOT a packing target: the
 *  partition is never re-derived, so a line is only ever re-laid when an edit
 *  pushes it OUTSIDE this envelope (see `repartition`). Set wide enough to
 *  contain Verovio's own castoff output — the sonata's 118 lines measure
 *  0.706–1.426 by this same naturals model (spike 5) — so an adopted
 *  partition is legal by construction and the first edit in a region moves
 *  nothing. Narrowing them makes reflow more eager; widening makes lines
 *  denser/sparser before they break. */
const FIT_MAX = 1.45;
const MIN_FILL = 0.65;
/** Measure moves one repartition may perform before giving up (derive). */
const MAX_REPAIR_STEPS = 64;
/** Leading clef+key block estimate (Verovio units) when a window has no
 *  measurable sig glyphs (e.g. C major, percussion clef edge cases). */
const SIG_FALLBACK = 450;
/** Naturals windows one repartition may render before giving up (derive).
 *  Repairs examine a handful of lines, so this is generous. */
const MAX_ENSURES = 4;
/** A single naturals window (post spanner/ending expansion) larger than this
 *  falls back to a derive render instead. */
const WINDOW_CAP = 260;

function indexCheckEnabled(): boolean {
  return typeof globalThis !== 'undefined' &&
    (globalThis as { __HKL_INDEX_CHECK?: boolean }).__HKL_INDEX_CHECK === true;
}

/** Everything the owner needs from the Renderer. */
export interface PageBreaksCtx {
  /** The live toolkit while it still holds the page layout being adopted
   *  (renderPage's data); null once something else was loaded into it. */
  layoutToolkit(): VerovioToolkit | null;
  /** Isolated toolkit for offscreen naturals renders (never the live one). */
  naturalsToolkit(): VerovioToolkit;
  /** breaks:'none' options at the current zoom preset with a huge page budget
   *  (scroll geometry) so a window renders as one unwrapped system. */
  naturalsOptions(): object;
  /** Max justified system width (SVG user units) from the live page DOM;
   *  null while nothing is mounted. */
  budgetW(): number | null;
}

/** Refill display strategy: 'line' honors every <sb> VERBATIM (castoff never
 *  wraps even an overfull pinned line — unlike 'smart', which re-wraps by its
 *  own context-dependent fit metric; probed 2026-08-30) while still paginating
 *  automatically by height. Docs with user page breaks render 'encoded'
 *  instead — 'line' ignores <pb>, and verbatim page semantics are what those
 *  docs already have today. */
export type RefillStrategy = 'line' | 'encoded';

/** A successful refill: the committed partition plus everything the Phase C-B
 *  system splicer needs to decide whether the edit can land as a DOM splice
 *  instead of a full loadData render (see render/pagesplice.ts). */
export interface RefillResult {
  strategy: RefillStrategy;
  /** Lazily serialize + pin the full doc — only the full-render path pays for
   *  it. Null when pin injection fails (caller must derive). */
  mei: () => string | null;
  /** Sig-diff changed run in CURRENT (new) measure indices; null = the doc is
   *  signature-identical to the committed baseline (a no-op render). */
  changedRun: { lo: number; hi: number } | null;
  /** Partition the mounted DOM currently renders (pre-edit). */
  oldStartIds: string[];
  /** Partition just committed (what the DOM must render after this edit). */
  newStartIds: string[];
}

/* ── pure helpers ─────────────────────────────────────────────────────────── */

/** System-start measure ids of one rendered page SVG, in order. */
export function systemStartsFromPageSvg(svgText: string): string[] {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const starts: string[] = [];
  for (const sys of Array.from(doc.querySelectorAll('g.system'))) {
    const first = sys.querySelector('g.measure');
    if (first?.id) starts.push(first.id);
  }
  return starts;
}

/** Inject partition pins into a serialized render MEI: an `<sb>` (or `<pb>`
 *  for ids in `pageStartIds`) before every line-start measure except the
 *  first. Returns null when a start id is missing from the document (the
 *  caller must fall back to a derive render). See the placement rules above. */
export function injectPins(
  mei: string, startIds: string[], pageStartIds?: Set<string> | null,
): string | null {
  const doc = new DOMParser().parseFromString(mei, 'application/xml');
  if (doc.querySelector('parsererror')) return null;
  const byId = new Map<string, Element>();
  for (const m of Array.from(doc.querySelectorAll('measure'))) {
    const id = m.getAttribute('xml:id');
    if (id) byId.set(id, m);
  }
  let n = 0;
  for (let i = 1; i < startIds.length; i++) {
    const id = startIds[i];
    const m = byId.get(id);
    if (!m) return null;
    const wantPb = pageStartIds?.has(id) ?? false;
    const mk = (): Element => {
      const e = doc.createElementNS(MEI_NS, wantPb ? 'pb' : 'sb');
      e.setAttribute('xml:id', 'hklpin-' + n++);
      return e;
    };
    let node: Element = m;
    let container = node.parentElement;
    if (!container) return null;
    if (container.localName === 'ending' && node.previousElementSibling === null) {
      /* line starts at an ending's first measure → position is before the
         wrapper at section level */
      node = container;
      container = node.parentElement;
      if (!container) return null;
    }
    const prev = node.previousElementSibling;
    if (prev && (prev.localName === 'sb' || prev.localName === 'pb')) {
      /* an existing user/section break already forces this boundary; for a
         page start over an sb, upgrade it to pb in the render copy only */
      if (wantPb && prev.localName === 'sb') {
        const pb = mk();
        for (const at of prev.getAttributeNames()) {
          if (at !== 'xml:id') pb.setAttribute(at, prev.getAttribute(at)!);
        }
        container.replaceChild(pb, prev);
      }
      continue;
    }
    if (prev && prev.localName === 'ending') {
      prev.appendChild(mk());      // smart castoff ignores an sb AFTER </ending>
      continue;
    }
    container.insertBefore(mk(), node);
  }
  return new XMLSerializer().serializeToString(doc);
}

/** Measure ids (document order) of the live doc. */
function measureIds(meiMeasures: Element[]): string[] {
  return meiMeasures.map((m) => m.getAttribute('xml:id') ?? '');
}

/** Signature of the user break structure (section-level sb/pb positions).
 *  Any change — Ctrl+B page break, section header add/remove — invalidates a
 *  narrow dirty range's meaning for the partition, so the refill guards on it. */
function computeUserBreakSig(model: ComposerModel): string {
  const section = model.getDoc().querySelector('section');
  if (!section) return '';
  let count = 0;
  const parts: string[] = [];
  const walk = (el: Element): void => {
    for (const c of Array.from(el.children)) {
      if (c.localName === 'measure') count++;
      else if (c.localName === 'sb' || c.localName === 'pb') parts.push(count + c.localName);
      else if (c.localName !== 'scoreDef' && c.querySelector('measure')) walk(c);
    }
  };
  walk(section);
  return parts.join(',');
}

/** Measure ids that MUST start a line: those directly preceded by a user
 *  sb/pb in the doc's section stream. */
function hardStartIds(model: ComposerModel): Set<string> {
  const out = new Set<string>();
  const section = model.getDoc().querySelector('section');
  if (!section) return out;
  let pending = false;
  const walk = (el: Element): void => {
    for (const c of Array.from(el.children)) {
      if (c.localName === 'measure') {
        if (pending) { const id = c.getAttribute('xml:id'); if (id) out.add(id); }
        pending = false;
      } else if (c.localName === 'sb' || c.localName === 'pb') {
        pending = true;
      } else if (c.localName !== 'scoreDef' && c.querySelector('measure')) {
        walk(c);
      }
    }
  };
  walk(section);
  return out;
}

/** Head-context signature: the head scoreDef plus any section-level elements
 *  before the first measure, plus the composer/footer credits (injected per
 *  page mount — a splice or no-op skip would keep stale text without this).
 *  A change means the context every line renders under moved — derive. */
function computeHeadSig(model: ComposerModel): string {
  const doc = model.getDoc();
  const ser = new XMLSerializer();
  const scoreDef = doc.querySelector('scoreDef');
  let s = scoreDef ? ser.serializeToString(scoreDef) : '';
  const first = doc.querySelector('section measure');
  if (first) {
    let top: Element = first;
    while (top.parentElement && top.parentElement.localName !== 'section') top = top.parentElement;
    let node = top.previousElementSibling;
    let pre = '';
    while (node) { pre = ser.serializeToString(node) + pre; node = node.previousElementSibling; }
    s += '|' + pre;
  }
  return s + '|' + model.getComposer() + '|' + model.getFooter();
}

/** Interior-structure signature: every section-level element that is NOT a
 *  measure, sb/pb, or measure-bearing wrapper (i.e. mid-piece scoreDefs),
 *  serialized with its measure-count position. A mid-piece key/meter change
 *  lives OUTSIDE any measure, so the per-measure sig diff cannot see it — a
 *  refill would render it correctly (full loadData), but the Phase C-B system
 *  splice and the no-op skip would keep stale glyphs. Guarded here so both
 *  paths derive instead. */
function computeInteriorSig(model: ComposerModel): string {
  const section = model.getDoc().querySelector('section');
  if (!section) return '';
  const ser = new XMLSerializer();
  let count = 0;
  const parts: string[] = [];
  const walk = (el: Element): void => {
    for (const c of Array.from(el.children)) {
      if (c.localName === 'measure') count++;
      else if (c.localName === 'sb' || c.localName === 'pb') continue;   // userBreakSig's job
      else if (c.querySelector('measure')) walk(c);
      else parts.push(count + ':' + ser.serializeToString(c));
    }
  };
  walk(section);
  return parts.join('|');
}

/* ── the owner ────────────────────────────────────────────────────────────── */

interface AdoptionTask {
  nextPage: number;
  pageCount: number;
  startIds: string[];
  cancelled: boolean;
}

export class PageLineBreaks {
  /** Adopted partition: line-start measure ids, document order. Null until a
   *  derive render's layout has been read (or a refill committed its own). */
  private startIds: string[] | null = null;
  private userBreakSig = '';
  private headSig = '';
  private interiorSig = '';
  private budgetW = 0;
  /** Natural (unjustified) measure widths in SVG user units, from breaks:'none'
   *  window renders. Only missing/dirty ids are ever (re)written, so a cached
   *  value never drifts — determinism of the refill depends on it. */
  private naturals = new Map<string, number>();
  /** Leading clef+key block width (Verovio units), measured from the last
   *  naturals window. Persisted across refills so a line whose naturals are
   *  all cached judges legality by the same yardstick as one that measured. */
  private sigW = SIG_FALLBACK;
  /** Per-measure live-doc serializations (+ their id order) captured whenever
   *  a partition is committed against the current document. The refill diffs
   *  the live doc against these to find the TRUE changed run — it never
   *  trusts the model's renderDirty hint, whose reset-then-narrow lifecycle
   *  can silently swallow an earlier mutation's 'all' under batch-mutate-
   *  then-render flows (same reason the scroll splicer keeps its own sig
   *  map). ~13 ms on a 446-bar score, amortized into a >1 s render. */
  private sig = new Map<string, string>();
  private sigOrder: string[] = [];
  private adoption: AdoptionTask | null = null;
  /** Line starts the last refill actually MOVED (0 = the edit changed content
   *  only and no boundary shifted — the common, desired case). Diagnostics
   *  and tests read it; fixtures assert 0 for no-op-equivalent edits. */
  lastRefillLines = 0;
  /** Timing/diagnostic breakdown of the last tryRefill (ms). */
  lastRefillStats: { naturalsMs: number; windows: number; windowMeasures: number; injectMs: number; serializeMs: number } =
    { naturalsMs: 0, windows: 0, windowMeasures: 0, injectMs: 0, serializeMs: 0 };
  /** Why the last tryRefill returned null (diagnostics/tests); '' after a
   *  successful refill. */
  lastDeriveReason = '';

  /** Drop all partition state. Next page render must derive + re-adopt. */
  invalidate(): void {
    this.startIds = null;
    this.naturals.clear();
    this.sigW = SIG_FALLBACK;
    this.sig.clear();
    this.sigOrder = [];
    this.budgetW = 0;
    if (this.adoption) this.adoption.cancelled = true;
    this.adoption = null;
  }

  /** Capture per-measure signatures of the current live doc (see `sig`). */
  private captureSigs(meiMeasures: Element[], ids: string[], pre?: string[]): void {
    const ser = new XMLSerializer();
    this.sig.clear();
    this.sigOrder = ids;
    for (let i = 0; i < meiMeasures.length; i++) {
      this.sig.set(ids[i], pre?.[i] ?? ser.serializeToString(meiMeasures[i]));
    }
  }

  /** Inject the CURRENT partition's pins into a freshly serialized render MEI.
   *  Used by the renderer to rebuild page data for a lazy mount after a system
   *  splice (the mounted DOM is current; the toolkit's layout is not).
   *  Null when nothing is adopted or an id is missing. */
  pinRenderMei(mei: string): string | null {
    if (this.startIds === null || this.startIds.length <= 1) return null;
    return injectPins(mei, this.startIds, null);
  }

  /** True when a refill attempt is worth making (adopted, or adoption armed
   *  and finishable). */
  canAttemptRefill(): boolean {
    return this.startIds !== null || this.adoption !== null;
  }

  /** True when the doc is actually being line-break-owned (a multi-line
   *  partition is adopted) — gates the derive-fallback log so single-line
   *  documents, which always derive by design, don't spam the console. */
  ownershipActive(): boolean {
    return this.startIds !== null && this.startIds.length > 1;
  }

  /* ── adoption ─────────────────────────────────────────────────────────── */

  /** Arm lazy partition adoption right after a derive render: the live toolkit
   *  holds the rendered layout; read each page's system starts in idle slices
   *  so the (~2 s on a large score) walk never blocks an interaction. */
  armAdoption(model: ComposerModel, pageCount: number, ctx: PageBreaksCtx): void {
    this.invalidate();
    this.userBreakSig = computeUserBreakSig(model);
    this.headSig = computeHeadSig(model);
    this.interiorSig = computeInteriorSig(model);
    /* Signatures of the doc state this layout renders — captured NOW, in the
       same synchronous block as the derive render, so the idle-completed
       partition and the sig baseline describe the same document. */
    const meiMeasures = model.allMeasures();
    this.captureSigs(meiMeasures, measureIds(meiMeasures));
    const task: AdoptionTask = { nextPage: 1, pageCount, startIds: [], cancelled: false };
    this.adoption = task;
    const step = (): void => {
      if (task.cancelled) return;
      const tk = ctx.layoutToolkit();
      if (!tk) { task.cancelled = true; this.adoption = null; return; }
      const budget = performance.now() + 40;
      while (task.nextPage <= task.pageCount && performance.now() < budget) {
        task.startIds.push(...systemStartsFromPageSvg(tk.renderToSVG(task.nextPage, {})));
        task.nextPage++;
      }
      if (task.nextPage > task.pageCount) {
        this.commitAdoption(task);
        return;
      }
      scheduleIdle(step);
    };
    scheduleIdle(step);
  }

  /** Finish an in-flight adoption synchronously (an edit arrived first). */
  private finishAdoptionNow(ctx: PageBreaksCtx): boolean {
    const task = this.adoption;
    if (!task || task.cancelled) return this.startIds !== null;
    const tk = ctx.layoutToolkit();
    if (!tk) { task.cancelled = true; this.adoption = null; return false; }
    while (task.nextPage <= task.pageCount) {
      task.startIds.push(...systemStartsFromPageSvg(tk.renderToSVG(task.nextPage, {})));
      task.nextPage++;
    }
    return this.commitAdoption(task);
  }

  private commitAdoption(task: AdoptionTask): boolean {
    this.adoption = null;
    if (task.cancelled || task.startIds.length === 0) return false;
    this.startIds = task.startIds;
    return true;
  }

  /* ── refill ───────────────────────────────────────────────────────────── */

  /** Recompute the affected lines for whatever actually changed since the
   *  last committed partition and return the refill (strategy + lazy pinned
   *  render MEI + splice metadata), or null when a derive is required. The
   *  changed run is found by a per-measure signature diff against the owner's
   *  own baseline (see `sig`) — the model's renderDirty hint is never trusted.
   *  On success the new partition and a fresh sig baseline are committed.
   *  `mei()` is lazy: the system splicer (Phase C-B) never needs the full
   *  serialize + pin pass, so the full-render path pays for it, not the hot
   *  path. `changedRun` is the sig-diff run in CURRENT (new) measure indices;
   *  null means the document is signature-identical to the committed baseline. */
  tryRefill(
    model: ComposerModel,
    viewStaves: number[] | null,
    ctx: PageBreaksCtx,
  ): RefillResult | null {
    const bail = (why: string): null => { this.lastDeriveReason = why; return null; };
    if (viewStaves != null) return bail('filtered view');
    if (this.startIds === null && !this.finishAdoptionNow(ctx)) return bail('no adoptable partition');
    if (this.startIds!.length <= 1) return bail('single-line partition');
    if (computeUserBreakSig(model) !== this.userBreakSig) return bail('user breaks changed');
    if (computeHeadSig(model) !== this.headSig) return bail('head context changed');
    if (computeInteriorSig(model) !== this.interiorSig) return bail('interior structure changed');
    if (this.budgetW <= 0) {
      const w = ctx.budgetW();
      if (w == null || !(w > 0)) return bail('no budgetW measurable');
      this.budgetW = w;
    }

    this.lastRefillStats = { naturalsMs: 0, windows: 0, windowMeasures: 0, injectMs: 0, serializeMs: 0 };
    const meiMeasures = model.allMeasures();
    if (meiMeasures.length === 0) return bail('empty document');
    const ids = measureIds(meiMeasures);
    const idIdx = new Map(ids.map((id, i) => [id, i]));

    /* The refill assumes CONTINUITY — an edit on the document this partition
       was adopted from. A wholesale swap (most line-start ids gone, e.g. a
       replaceDocument without a render in between) is a load, not an edit. */
    const surviving = this.startIds!.filter((id) => idIdx.has(id));
    if (surviving.length * 2 < this.startIds!.length) return bail('foreign document (line-start survival < 50%)');

    /* Changed run via prefix/suffix diff of (id, serialized measure) against
       the committed baseline — structural truth in the CURRENT index space. */
    const ser = new XMLSerializer();
    const cur = meiMeasures.map((m) => ser.serializeToString(m));
    const oldOrder = this.sigOrder;
    const oN = oldOrder.length, nN = ids.length;
    const eq = (i: number, j: number): boolean =>
      oldOrder[i] === ids[j] && this.sig.get(oldOrder[i]) === cur[j];
    let P = 0;
    while (P < Math.min(oN, nN) && eq(P, P)) P++;
    let S = 0;
    while (S < Math.min(oN, nN) - P && eq(oN - 1 - S, nN - 1 - S)) S++;

    /* Surviving old line starts, in document order. If the very first measure
       was replaced, re-anchor line 0 at the current first measure. */
    const oldStarts = surviving.slice();
    if (oldStarts.length === 0 || idIdx.get(oldStarts[0])! !== 0) oldStarts.unshift(ids[0]);
    const hard = hardStartIds(model);
    /* The partition the current DOM renders (verifyRenderedPartition keeps
       these in lockstep) — the splicer locates the systems to replace by
       THESE ids, even ones whose measure the edit deleted. */
    const oldStartIds = this.startIds!.slice();

    let newStartIds: string[];
    let changedRun: { lo: number; hi: number } | null;
    if (P >= nN && oN === nN) {
      newStartIds = oldStarts;               // nothing changed — re-pin as-is
      changedRun = null;
      this.lastRefillLines = 0;
    } else {
      /* A pure deletion can leave an empty new-side run (hi < lo); the line
         that LOST content still needs re-laying — anchor the range at the
         structural change point. */
      const dLo = Math.min(P, nN - 1);
      const dHi = Math.max(dLo, nN - 1 - S);
      changedRun = { lo: dLo, hi: dHi };
      const repaired = this.repartition(model, meiMeasures, ids, idIdx, hard, { lo: dLo, hi: dHi }, ctx);
      if (!repaired) return bail('repartition window/cap exhausted');
      newStartIds = repaired;
    }
    /* A single-line partition isn't worth owning: breaks:'line' with no <sb>
       in the data WARNS and falls back to auto castoff internally (probed
       2026-08-30), and the 1-vs-2-line cusp is exactly where our fill rules
       and castoff's metric could flip-flop per edit. Docs that small derive
       synchronously well under the deferral threshold — let them. */
    if (newStartIds.length <= 1) return bail('single-line result');

    const strategy: RefillStrategy = model.getDoc().querySelector('section pb') ? 'encoded' : 'line';
    this.startIds = newStartIds;
    this.captureSigs(meiMeasures, ids, cur);
    this.lastDeriveReason = '';
    const mei = (): string | null => {
      const tSer = performance.now();
      const full = model.serialize({ hejiEnabled: model.getHejiEnabled() }, null);
      this.lastRefillStats.serializeMs = Math.round(performance.now() - tSer);
      const tInj = performance.now();
      const pinned = injectPins(full, newStartIds, null);
      this.lastRefillStats.injectMs = Math.round(performance.now() - tInj);
      return pinned;
    };
    return { strategy, mei, changedRun, oldStartIds, newStartIds };
  }

  /** Carry the committed partition across the edit and repair ONLY what the
   *  edit made illegal. Never re-derives: an edit that leaves every line
   *  inside [MIN_FILL, FIT_MAX] moves no boundary at all, so a no-op edit is
   *  a visual no-op and undo restores the original layout exactly (Max's
   *  ruling, 2026-08-30 — see the module header). Returns the new start-id
   *  list, or null (caller derives). */
  private repartition(
    model: ComposerModel,
    meiMeasures: Element[],
    ids: string[],
    idIdx: Map<string, number>,
    hard: Set<string>,
    dirty: { lo: number; hi: number },
    ctx: PageBreaksCtx,
  ): string[] | null {
    const n = ids.length;
    const dLo = Math.max(0, Math.min(dirty.lo, n - 1));
    const dHi = Math.max(dLo, Math.min(dirty.hi, n - 1));

    /* ── carry the partition across the edit, by MEMBERSHIP ──
       Each old line keeps its first surviving member as its start, so:
       deleting a line's first measure just moves that line's start to the
       next survivor (no reflow); an inserted measure joins the line whose
       index range contains it; a line whose every member was deleted
       disappears. Nothing here consults widths — only structure. */
    const oldPos = new Map(this.sigOrder.map((id, i) => [id, i]));
    const oldStartPos: number[] = [];
    for (const id of this.startIds!) {
      const p = oldPos.get(id);
      if (p == null) return null;   // partition/baseline disagree → derive
      oldStartPos.push(p);
    }
    const starts: number[] = [];
    for (let k = 0; k < oldStartPos.length; k++) {
      const from = oldStartPos[k];
      const to = k + 1 < oldStartPos.length ? oldStartPos[k + 1] : this.sigOrder.length;
      for (let i = from; i < to; i++) {
        const ni = idIdx.get(this.sigOrder[i]);
        if (ni == null) continue;
        if (!starts.length || ni > starts[starts.length - 1]) starts.push(ni);
        break;
      }
    }
    if (!starts.length) return null;
    starts[0] = 0;   // line 0 always begins the document

    /* Dirty measures must be re-measured; drop their cached naturals. */
    for (let i = dLo; i <= dHi; i++) this.naturals.delete(ids[i]);

    /* ── naturals on demand (only for the lines we actually examine) ── */
    let ensures = 0;
    const ensureRange = (lo: number, hi: number): boolean => {
      lo = Math.max(0, lo); hi = Math.min(n - 1, hi);
      let i = lo;
      while (i <= hi) {
        if (this.naturals.has(ids[i])) { i++; continue; }
        let j = i;
        while (j + 1 <= hi && !this.naturals.has(ids[j + 1])) j++;
        if (ensures >= MAX_ENSURES) return false;
        ensures++;
        const w = this.measureWindow(model, meiMeasures, ids, i, j, ctx);
        if (w == null) return false;
        if (w.sigW > 0) this.sigW = w.sigW;
        i = j + 1;
      }
      return true;
    };

    const budget = this.budgetW;
    const lineEnd = (k: number): number => (k + 1 < starts.length ? starts[k + 1] : n);
    const fillOf = (k: number): number | null => {
      const from = starts[k], to = lineEnd(k);
      if (!ensureRange(from, to - 1)) return null;
      let acc = this.sigW;
      for (let i = from; i < to; i++) acc += this.naturals.get(ids[i]) ?? 0;
      return acc / budget;
    };

    /* ── repair ──
       Examine only the lines the edit touched, then whatever a repair
       cascades into. Each step moves ONE measure across ONE boundary, so the
       reflow is as small as the illegality demands. */
    let first = 0, last = 0;
    for (let k = 0; k < starts.length; k++) {
      if (starts[k] <= dLo) first = k;
      if (starts[k] <= dHi) last = k;
    }
    /* A line that pushed must never pull the same measure back (oscillation);
       an overfull line that cannot shed without going underfull stays as it
       is — content over churn. */
    let pushed = new Set<number>();
    let steps = 0;
    let k = first;
    let through = last;
    while (k < starts.length && k <= through) {
      if (++steps > MAX_REPAIR_STEPS) return null;
      const f = fillOf(k);
      if (f == null) return null;
      const from = starts[k], to = lineEnd(k);
      if (f > FIT_MAX && to - from > 1) {
        const moving = to - 1;                       // last measure of this line
        const nat = this.naturals.get(ids[moving]) ?? 0;
        if ((f * budget - nat) / budget < MIN_FILL && to - from === 2) {
          k++; continue;                             // shedding would only trade one illegality for another
        }
        if (k + 1 >= starts.length) {
          starts.push(moving);                       // new final line
          pushed = new Set<number>();
        } else if (hard.has(ids[starts[k + 1]])) {
          starts.splice(k + 1, 0, moving);           // can't move a user break — new line before it
          pushed = new Set<number>();
          through++;
        } else {
          starts[k + 1] = moving;
        }
        pushed.add(k);
        through = Math.max(through, k + 1);
        continue;                                    // re-check this line
      }
      if (f < MIN_FILL && k + 1 < starts.length && !pushed.has(k)) {
        const cand = starts[k + 1];
        if (!hard.has(ids[cand]) && lineEnd(k + 1) - cand > 1) {
          if (!ensureRange(cand, cand)) return null;
          const nat = this.naturals.get(ids[cand]) ?? 0;
          if ((f * budget + nat) / budget <= FIT_MAX) {
            starts[k + 1] = cand + 1;
            through = Math.max(through, k + 1);
            continue;                                // re-check this line
          }
        }
      }
      k++;
    }

    const out = starts.map((i) => ids[i]);
    let movedLines = 0;
    for (let i = 0; i < Math.max(out.length, this.startIds!.length); i++) {
      if (out[i] !== this.startIds![i]) movedLines++;
    }
    this.lastRefillLines = movedLines;
    return out;
  }

  /* ── naturals measurement ─────────────────────────────────────────────── */

  /** Measure natural widths for ids[needLo..needHi] via one offscreen
   *  breaks:'none' window render. The window gains two left + one right
   *  context measures and is expanded to hold every spanner and <ending>
   *  whole, so member widths reproduce their full-context values (page
   *  spike 1, finding 5). Only [needLo..needHi] values are written — cached
   *  neighbours are never disturbed (determinism). Returns the window's
   *  measured leading clef+key width, or null on failure. */
  private measureWindow(
    model: ComposerModel, meiMeasures: Element[], ids: string[],
    needLo: number, needHi: number, ctx: PageBreaksCtx,
  ): { sigW: number } | null {
    let lo = Math.max(0, needLo - 2);
    let hi = Math.min(ids.length - 1, needHi + 1);
    [lo, hi] = expandForSpanners(meiMeasures, lo, hi);
    [lo, hi] = expandForEndings(meiMeasures, lo, hi);
    if (hi - lo + 1 > WINDOW_CAP) return null;
    const tWin = performance.now();
    this.lastRefillStats.windows++;
    this.lastRefillStats.windowMeasures += hi - lo + 1;
    const sub = model.serializeRangeForRender(lo, hi, { hejiEnabled: model.getHejiEnabled() }, null);
    const tk = ctx.naturalsToolkit();
    tk.setOptions(ctx.naturalsOptions());
    if (!tk.loadData(sub)) return null;
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-99999px;top:0';
    host.innerHTML = tk.renderToSVG(1, {});
    document.body.appendChild(host);
    try {
      const els: SVGGraphicsElement[] = [];
      for (let i = lo; i <= hi; i++) {
        const el = host.querySelector('#' + CSS.escape(ids[i]));
        if (!el) return null;
        els.push(el as SVGGraphicsElement);
      }
      const boxes = els.map((el) => el.getBBox());
      for (let i = needLo; i <= needHi; i++) {
        const k = i - lo;
        const w = k + 1 < boxes.length ? boxes[k + 1].x - boxes[k].x : boxes[k].width;
        if (!(w > 0)) return null;
        this.naturals.set(ids[i], w);
      }
      /* Leading clef+key extent (meter excluded — mid-score systems don't
         redraw it): sig glyphs left of the first note/rest/chord. */
      let firstContent = Infinity;
      for (const el of Array.from(host.querySelectorAll('g.note, g.rest, g.chord, g.mRest'))) {
        const b = (el as SVGGraphicsElement).getBBox();
        if (b.x < firstContent) firstContent = b.x;
      }
      let sigRight = -Infinity;
      for (const el of Array.from(host.querySelectorAll('g.clef, g.keySig'))) {
        const b = (el as SVGGraphicsElement).getBBox();
        if (b.x < firstContent && b.x + b.width > sigRight) sigRight = b.x + b.width;
      }
      const sigW = isFinite(sigRight) ? sigRight - boxes[0].x : 0;
      return { sigW };
    } finally {
      host.remove();
      this.lastRefillStats.naturalsMs += Math.round(performance.now() - tWin);
    }
  }

  /* ── post-render verification ─────────────────────────────────────────── */

  /** After a refill render, check that every mounted page's system starts form
   *  a contiguous, in-order run of the pinned partition. smartSb0 can in rare
   *  cases auto-wrap a pinned line it deems overfull (the k87 class) — that is
   *  detected here, warned about, and healed by re-adopting from the rendered
   *  layout; under HKL_INDEX_CHECK it throws so fixtures fail loudly. */
  verifyRenderedPartition(container: HTMLElement, model: ComposerModel, pageCount: number, ctx: PageBreaksCtx): boolean {
    if (this.startIds === null) return true;
    const pos = new Map(this.startIds.map((id, i) => [id, i]));
    let ok = true;
    let prevEnd = -1;
    for (const page of Array.from(container.querySelectorAll('.score-page:not(.score-page-pending)'))) {
      const starts: string[] = [];
      for (const sys of Array.from(page.querySelectorAll('g.system'))) {
        const first = sys.querySelector('g.measure');
        if (first?.id) starts.push(first.id);
      }
      if (!starts.length) continue;
      let at = pos.get(starts[0]);
      if (at == null || at <= prevEnd) { ok = false; break; }
      for (let i = 1; i < starts.length && ok; i++) {
        if (pos.get(starts[i]) !== at + i) ok = false;
      }
      if (!ok) break;
      prevEnd = at + starts.length - 1;
    }
    if (!ok) {
      if (indexCheckEnabled()) {
        throw new Error('[page-breaks] rendered partition diverged from the pinned one (castoff override?)');
      }
      console.warn('[page-breaks] rendered partition diverged from pins — re-adopting from the rendered layout');
      this.armAdoption(model, pageCount, ctx);
    }
    return ok;
  }
}

/** requestIdleCallback with a setTimeout fallback. */
function scheduleIdle(fn: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 1000 });
  else setTimeout(fn, 120);
}
