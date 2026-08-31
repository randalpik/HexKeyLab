// Page-view line-break ownership (Phase C foundation — "own the line-breaking",
// docs/composer-page-splice-design.md, spike 5).
//
// In page view, Composer — not Verovio's castoff — decides which measure starts
// each system. The partition is pinned as render-time <sb> elements injected
// into the serialized render MEI (never into the live doc: saves, undo
// snapshots and history diffs stay pin-free by construction). Verovio remains
// the measure-level engraver + within-line justifier; with every boundary
// pinned, castoff has no free choices left, so an edit can only move the
// boundaries WE recompute — reflow is "greedy from the edited system's line
// start", bounded, and deterministic (a no-op edit reproduces the partition
// bit-for-bit; Max's ruling ii is satisfied structurally).
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
//       the affected lines are refilled by the greedy partitioner
//       (FIT_MAX/MIN_FILL + backward min-fill rebalance, hard breaks
//       respected), pins are re-encoded, and the doc re-renders with
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

/** Fill rules (spike-5 prototype values; tunable — design doc item 1c).
 *  Fills are Σ(natural widths)/budget: >1 = the justified line compresses,
 *  <1 = it stretches. Verovio's own lines span ~[0.71, 1.43]. */
const FIT_MAX = 1.2;
const MIN_FILL = 0.7;
/** Leading clef+key block estimate (Verovio units) when a window has no
 *  measurable sig glyphs (e.g. C major, percussion clef edge cases). */
const SIG_FALLBACK = 450;
/** Naturals ensure-ladder: first window reaches this far past the dirty range;
 *  each escalation adds the next step; at most MAX_ENSURES windows per refill. */
const ENSURE_AHEAD = [16, 64, 250];
const MAX_ENSURES = 3;
/** A single naturals window (post spanner/ending expansion) larger than this
 *  falls back to a derive render instead. */
const WINDOW_CAP = 260;
/** Total measures a refill may re-partition before giving up (derive). */
const REFILL_CAP = 250;

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
 *  before the first measure. A change (key/meter/staff structure) means the
 *  running context every line renders under moved — derive, don't refill. */
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
  return s;
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
  private budgetW = 0;
  /** Natural (unjustified) measure widths in SVG user units, from breaks:'none'
   *  window renders. Only missing/dirty ids are ever (re)written, so a cached
   *  value never drifts — determinism of the refill depends on it. */
  private naturals = new Map<string, number>();
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
  /** One-shot flag for the last refill: how many lines it recomputed
   *  (diagnostics / tests). */
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
   *  last committed partition and return the pinned render MEI + strategy, or
   *  null when a derive is required. The changed run is found by a per-measure
   *  signature diff against the owner's own baseline (see `sig`) — the model's
   *  renderDirty hint is never trusted. On success the new partition and a
   *  fresh sig baseline are committed. */
  tryRefill(
    model: ComposerModel,
    viewStaves: number[] | null,
    ctx: PageBreaksCtx,
  ): { mei: string; strategy: RefillStrategy } | null {
    const bail = (why: string): null => { this.lastDeriveReason = why; return null; };
    if (viewStaves != null) return bail('filtered view');
    if (this.startIds === null && !this.finishAdoptionNow(ctx)) return bail('no adoptable partition');
    if (this.startIds!.length <= 1) return bail('single-line partition');
    if (computeUserBreakSig(model) !== this.userBreakSig) return bail('user breaks changed');
    if (computeHeadSig(model) !== this.headSig) return bail('head context changed');
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
    const oldStartIdx = new Set(oldStarts.map((id) => idIdx.get(id)!));
    const hard = hardStartIds(model);

    let newStartIds: string[];
    if (P >= nN && oN === nN) {
      newStartIds = oldStarts;               // nothing changed — re-pin as-is
      this.lastRefillLines = 0;
    } else {
      /* A pure deletion can leave an empty new-side run (hi < lo); the line
         that LOST content still needs re-laying — anchor the range at the
         structural change point. */
      const dLo = Math.min(P, nN - 1);
      const dHi = Math.max(dLo, nN - 1 - S);
      const refilled = this.refillLines(model, meiMeasures, ids, idIdx, oldStarts, oldStartIdx, hard, { lo: dLo, hi: dHi }, ctx);
      if (!refilled) return bail('refill window/cap exhausted');
      newStartIds = refilled;
    }
    /* A single-line partition isn't worth owning: breaks:'line' with no <sb>
       in the data WARNS and falls back to auto castoff internally (probed
       2026-08-30), and the 1-vs-2-line cusp is exactly where our fill rules
       and castoff's metric could flip-flop per edit. Docs that small derive
       synchronously well under the deferral threshold — let them. */
    if (newStartIds.length <= 1) return bail('single-line result');

    const tSer = performance.now();
    const mei = model.serialize({ hejiEnabled: model.getHejiEnabled() }, null);
    this.lastRefillStats.serializeMs = Math.round(performance.now() - tSer);
    const strategy: RefillStrategy = model.getDoc().querySelector('section pb') ? 'encoded' : 'line';
    const tInj = performance.now();
    const pinned = injectPins(mei, newStartIds, null);
    this.lastRefillStats.injectMs = Math.round(performance.now() - tInj);
    if (pinned === null) return bail('pin injection failed (missing id)');
    this.startIds = newStartIds;
    this.captureSigs(meiMeasures, ids, cur);
    this.lastDeriveReason = '';
    return { mei: pinned, strategy };
  }

  /** The greedy core: re-lay lines from the one before the dirty range until
   *  the computed partition re-joins the old one beyond it. Returns the full
   *  new start-id list, or null (caller derives). */
  private refillLines(
    model: ComposerModel,
    meiMeasures: Element[],
    ids: string[],
    idIdx: Map<string, number>,
    oldStarts: string[],
    oldStartIdx: Set<number>,
    hard: Set<string>,
    dirty: { lo: number; hi: number },
    ctx: PageBreaksCtx,
  ): string[] | null {
    const n = ids.length;
    const dLo = Math.max(0, Math.min(dirty.lo, n - 1));
    const dHi = Math.max(dLo, Math.min(dirty.hi, n - 1));
    /* Refill starts at the line containing the measure LEFT of the dirty range:
       if the dirty range begins exactly at a line start, the previous line's
       greedy decision depended on that measure's width — recompute it too. */
    const anchor = Math.max(0, dLo - 1);
    let s0 = 0;
    for (const id of oldStarts) {
      const i = idIdx.get(id)!;
      if (i <= anchor) s0 = i; else break;
    }
    /* Dirty measures must be re-measured; drop their cached naturals. */
    for (let i = dLo; i <= dHi; i++) this.naturals.delete(ids[i]);

    /* Naturals ensure ladder: one window now, escalate only if the greedy walk
       outruns it. */
    let ensures = 0;
    let sigW = SIG_FALLBACK;
    const ensureThrough = (hiNeed: number): boolean => {
      if (ensures >= MAX_ENSURES) return false;
      const ahead = ENSURE_AHEAD[Math.min(ensures, ENSURE_AHEAD.length - 1)];
      ensures++;
      const hi = Math.min(n - 1, Math.max(hiNeed, dHi) + ahead);
      /* find the contiguous span actually missing */
      let lo = s0;
      while (lo <= hi && this.naturals.has(ids[lo])) lo++;
      let realHi = hi;
      while (realHi >= lo && this.naturals.has(ids[realHi])) realHi--;
      if (lo > realHi) return true;   // nothing missing
      const w = this.measureWindow(model, meiMeasures, ids, lo, realHi, ctx);
      if (w == null) return false;
      if (w.sigW > 0) sigW = w.sigW;
      return true;
    };
    if (!ensureThrough(dHi)) return null;

    /* Greedy walk. */
    const budget = this.budgetW;
    const starts: number[] = [];
    let cur = s0;
    let terminal: number | null = null;   // index whose old-partition tail we keep
    for (let guard = 0; guard < n + 2; guard++) {
      starts.push(cur);
      let acc = sigW;
      let j = cur;
      while (j < n) {
        if (j > cur && hard.has(ids[j])) break;
        let nat = this.naturals.get(ids[j]);
        if (nat == null) {
          if (!ensureThrough(j)) return null;
          nat = this.naturals.get(ids[j]);
          if (nat == null) return null;
        }
        if (j > cur && acc + nat > FIT_MAX * budget) break;
        acc += nat;
        j++;
      }
      if (j >= n) break;                                   // partitioned to doc end
      if (j > dHi && oldStartIdx.has(j)) { terminal = j; break; }
      if (j - s0 > REFILL_CAP) return null;
      cur = j;
    }

    /* Backward min-fill rebalance over the refilled lines (Max's ruling iii).
       Lines that cannot legally absorb more (hard-start lines — their break
       element pins the start) or that end the document are exempt. */
    this.rebalance(starts, terminal ?? n, ids, hard, sigW, budget, n);

    this.lastRefillLines = starts.length;
    const out: string[] = [];
    for (const id of oldStarts) {
      const i = idIdx.get(id)!;
      if (i < s0) out.push(id); else break;
    }
    for (const i of starts) out.push(ids[i]);
    if (terminal != null) {
      let inTail = false;
      for (const id of oldStarts) {
        if (idIdx.get(id)! === terminal) inTail = true;
        if (inTail) out.push(id);
      }
    }
    return out;
  }

  /** Pull measures backward (from the previous line's tail) into any refilled
   *  line under MIN_FILL until every line clears it or is structurally stuck.
   *  `starts` is mutated in place; `end` bounds the last refilled line. */
  private rebalance(
    starts: number[], end: number, ids: string[], hard: Set<string>,
    sigW: number, budget: number, n: number,
  ): void {
    const fill = (li: number): number => {
      const from = starts[li];
      const to = li + 1 < starts.length ? starts[li + 1] : end;
      let acc = sigW;
      for (let i = from; i < to; i++) acc += this.naturals.get(ids[i]) ?? 0;
      return acc / budget;
    };
    for (let pass = 0; pass < 8; pass++) {
      let moved = false;
      for (let li = starts.length - 1; li >= 1; li--) {
        const lineEnd = li + 1 < starts.length ? starts[li + 1] : end;
        if (lineEnd >= n) continue;               // document-final line: ragged is fine
        if (hard.has(ids[starts[li]])) continue;  // start pinned by a user break
        let guard = 0;
        while (fill(li) < MIN_FILL && guard++ < 16) {
          if (starts[li] - starts[li - 1] <= 1) break;      // previous line can't give
          const candidate = starts[li] - 1;
          const natC = this.naturals.get(ids[candidate]) ?? 0;
          if ((fill(li) * budget + natC) / budget > FIT_MAX) break;
          starts[li] = candidate;
          moved = true;
        }
      }
      if (!moved) break;
    }
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
