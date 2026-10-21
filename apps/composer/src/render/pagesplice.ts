// Page-view system splice (docs/architecture/composer.md, Page view).
//
// After the line-break owner (render/linebreaks.ts) recomputes the partition
// for an edit, this module re-engraves ONLY the affected systems in one
// windowed offscreen sub-render — no loadData of the full document at all.
// Since 2026-10-21 it ENGRAVES and nothing else (Max: "every repartition must
// repaginate"): the systems go to PageAssembler.applyPartition, which imports
// and measures them, places every page by first-fit against what each page
// actually holds, and is the one landing for every refill. The placement
// history below (B1/B2, the cascade) describes what this module used to do.
//
// Why the gates are shaped the way they are (probes 2026-08-30, sonata,
// since deleted):
//   - A pin-anchored window (synthetic mRest leader + <sb> pins, page
//     geometry, tall page, breaks:'line') reproduces mid-score systems
//     PIXEL-EXACTLY — per-measure x/width, inter-staff gaps, hanging extents,
//     and consecutive-system spacing all delta 0.0 against a full pinned
//     render. The leader absorbs every score-start artifact; every window
//     therefore starts at a hard anchor (spike 2's decisive finding).
//   - Verovio stacks page systems by CONTENT clearance (staff-frame gaps vary
//     145-267 units; bbox clearance ~constant), pages are never vertically
//     justified (bottom slack 650-811), and a page's first system anchors its
//     content top at the margin. System positions therefore depend on system
//     content — so instead of emulating the stacker, the splice MEASURES the
//     window's own spacing chain against the live DOM and only lands when
//     nothing outside the replaced systems would move (v1); B1 applies the
//     measured dy-cascade instead of refusing, and B2 (2026-09-02) replaces a
//     line HUNK — N old systems by M new ones, each placed on the page the
//     owned pagination assigns it — so line-count changes, moved page starts
//     and the overflow cascade's page-to-page moves all land as splices.
//   - Divergent zones are caught by the HKL_INDEX_CHECK reference gate, which
//     compares every touched page against a fresh full render — there is no
//     zone excluded by name. The two that used to be (line 0 "drifts ~1px";
//     section-header lines "NOT idempotent") were re-measured 2026-09-01
//     against the CURRENT window recipe and both splice reference-clean: line 0
//     at 8/12/9 units (x/width/absolute staff top), header lines at 0/2/4.8
//     with the title landing on its rule exactly. The k=0 figure came from the
//     pre-ownership recipe (tall page + header:'none'), which no longer exists.
//     Until 2026-09-03 a LIVE context-line comparison stood in front of that
//     gate: the window also rendered L-1 and L+1 and refused if either failed
//     to reproduce its mounted geometry. Phase 3 removed it — it was a
//     fallback that masked a subset of the splicer's own replaced-set defects,
//     and it detected nothing the reference gate does not.
//
// Correctness contract (Max's acceptance gate): a spliced result must equal
// what a full re-engrave of the same pinned MEI would produce. The v1 gates
// guarantee it by construction: identical partition (pins), identical system
// content (windows are pixel-exact at hard anchors), and identical vertical
// placement (measured, not assumed — anything that would move falls back).
// Under HKL_INDEX_CHECK every splice is verified against an offscreen full
// reference render and throws on divergence.
//
// The splicer is deliberately STATELESS: everything it needs lives in the
// mounted DOM, the refill result, and the model — so there is no index to
// invalidate and no drift to chase.

import type { VerovioToolkit } from '@hkl/notation/verovio-types.js';
import { pageFrameOf } from './pageheader.js';
import { drawPageHeader, type ShellMeta } from './pageshell.js';
import type { ComposerModel } from '../model/index.js';
import { expandForSpannersOnce, expandForRenderedSpanners, expandForEndings, mergeGlyphDefs, type SpannerSnapshot } from './splice.js';
import { injectPins } from './linebreaks.js';

import { measureExtents, type SysExtents } from './pagefit.js';

const MEI_NS = 'http://www.music-encoding.org/ns/mei';
const LEAD_ID = 'hkl-splice-lead';
const TRAIL_ID = 'hkl-splice-trail';

/** Geometry tolerance, SVG user units (definition scale — ~10 units/px at
 *  zoom 100). Clean windows measure delta 0.0; the tolerance only absorbs
 *  snap noise (staff/barline snapping is ≤½ device px per pass, applied at
 *  different screen phases on live vs host). Real layout movement is ≥ a
 *  staff-space (~90 units). */
/* No size caps (Max, 2026-09-01). The former line and measure caps were
 * backstops from the fixed-point spanner expansion, which could balloon a
 * window; the one-pass rule ended that, and a window costs linearly in its
 * measures right up to the whole document, where it equals a full render — so a
 * subset render is never the worse deal. The only refusals are structural: the
 * line count must not change (B2) and pagination must hold, plus the fidelity
 * gates below. `lastStats.windowLines/Measures` still report the sizes. */

function indexCheckEnabled(): boolean {
  return typeof globalThis !== 'undefined' &&
    (globalThis as { __HKL_INDEX_CHECK?: boolean }).__HKL_INDEX_CHECK === true;
}

/** Everything the splicer needs from the Renderer. */
export interface PageSpliceCtx {
  /** Isolated toolkit (spliceTk) — never the live one. */
  toolkit: VerovioToolkit;
  /** Single-part view's staves (null = all): a window must render the same
   *  staff subset as the live page it is spliced into (2026-09-05). */
  viewStaves: number[] | null;
  /** Live page options with breaks:'line', a huge pageHeight (the window must
   *  land on ONE page), adjustPageHeight, and header:'none'. Page width and
   *  margins MUST match the live render — they set the justification width. */
  windowOptions: object;
  /** The exact options the live pinned render uses (reference verification). */
  liveOptions: () => object;
  /** Renderer.postProcessRendered (crisp pinning, notehead z-order, HEJI,
   *  theme) — run on the reference host exactly as on a live page. (The
   *  engraved hunk is post-processed by PageAssembler.applyPartition.) */
  postProcess: (el: HTMLElement, scope?: Element[], originPhaseX?: number) => void;
  /** Non-geometry page decorations that live in main.ts for mounted pages
   *  (volta number styling) — idempotent, content-level. */
  decorateHost: (el: HTMLElement) => void;
  /** Where the placement rule would put these systems (staff tops in the
   *  page-margin frame), measured on the given laid-out elements, writing
   *  nothing — the reference gate's expectation. Null when unreadable. */
  placeFor: (systems: Element[], opts?: { distribute?: boolean; pageNo?: number }) => Array<{ top: number }> | null;
  /** Renderer.alignStavesIn — phase-align the staff rows of a rendered host
   *  exactly as a live page's are, so the reference gate compares like with
   *  like. Without it `placeFor(reference)` reads UNALIGNED extents while the
   *  live page's are aligned, and the difference (up to one device pixel per
   *  system, accumulating down the page) is what `TOL = 30` used to absorb. */
  alignStaves: (host: HTMLElement, originPhase?: number) => void;
  /** Fractional device y of a live page's margin group (see alignStaves). */
  originPhaseOf: (pageEl: HTMLElement) => number | undefined;
  /** Fractional device X of a live page's margin group — the horizontal twin,
   *  for `snapSystemRightEdge`'s absolute pixel snap (see postProcess). */
  originPhaseXOf: (pageEl: HTMLElement) => number | undefined;
  /** What the page header shows (render/pageshell.ts): the reference gate
   *  draws the live page's Composer header onto its Verovio page. */
  headerMeta: () => ShellMeta;
  /** Mount a lazily-virtualized page so its systems can be measured and
   *  spliced (B5). Returns false when mounting would be expensive or would
   *  draw POST-edit content — the splice then refuses, as it always did. */
  ensurePageMounted: (page: number) => boolean;
  /** Is page `page` currently drawn (it exists and is not a placeholder)? */
  isPageMounted: (page: number) => boolean;
}

interface SysProfile {
  el: SVGGElement;
  /** First-measure bbox.x + the system's own translate.x. */
  x0: number;
  /** Top staff line y (first measure, first staff) + staff & system ty. */
  staffTop: number;
  /** System bbox extents + system ty (children transforms are included by
   *  getBBox already). */
  /** Per-measure x/width, LAZY + memoised (A6). Only the context-line sanity
   *  check and the HKL_INDEX_CHECK reference gate need these; the vertical gate
   *  and the surgery itself need only x0/staffTop/bbox, and they cover most of
   *  the ~14 systems a splice profiles. Each call is one getBBox per measure,
   *  and every getBBox flushes layout over every mounted page. */
  measures: () => Array<{ id: string; relX: number; w: number }>;
}

/** Section-header state of one mounted page, read back from what the mount-time
 *  injector actually did (main.ts `injectSectionHeaders`): each title <text>
 *  displaced its own system and every later one on the page by `data-reserve`
 *  units, and sits at an ABSOLUTE y in page-margin coordinates. Both facts
 *  matter here — the displacement must come out of the vertical arithmetic,
 *  and the title must travel with its system when the cascade moves it. */
interface PageHeaders {
  systems: Element[];
  /** Accumulated displacement per system index. */
  reserve: number[];
  titles: Array<{ el: Element; sysIdx: number; baseline: number; reserve: number }>;
  /** False when a title carries no readable `data-reserve`/`data-baseline` —
   *  the page's geometry is then unexplained and must not be reasoned about.
   *  Both are needed: the reserve to take the injector's displacement out of
   *  the vertical arithmetic, the baseline to put a re-engraved title back. */
  known: boolean;
}

function pageHeaders(pageEl: HTMLElement): PageHeaders {
  const margin = pageEl.querySelector('svg g.page-margin');
  const systems = margin
    ? Array.from(margin.children).filter((c) => c.classList.contains('system'))
    : [];
  const reserve = new Array<number>(systems.length).fill(0);
  const titles: Array<{ el: Element; sysIdx: number; baseline: number; reserve: number }> = [];
  let known = true;
  for (const t of Array.from(pageEl.querySelectorAll('text.hkl-section-header'))) {
    const id = t.getAttribute('data-for');
    const meas = id ? pageEl.querySelector('#' + CSS.escape(id)) : null;
    const sys = meas?.closest('g.system') ?? null;
    const idx = sys ? systems.indexOf(sys) : -1;
    const r = Number(t.getAttribute('data-reserve'));
    const base = Number(t.getAttribute('data-baseline'));
    if (idx < 0 || !isFinite(r) || !isFinite(base)) { known = false; continue; }
    titles.push({ el: t, sysIdx: idx, baseline: base, reserve: r });
    for (let i = idx; i < reserve.length; i++) reserve[i] += r;
  }
  return { systems, reserve, titles, known };
}

/** Where a full re-engrave would put the replaced systems, and what that does
 *  to everything below them. Every number is MEASURED from the window's own
 *  spacing chain (a since-deleted probe: delta 0.0 against a full pinned render)
 *  — the splicer never models Verovio's stacker.
 *
 *  Only ONE page can have followers: a replaced system that is not its page's
 *  last is followed by another replaced system on the same page, so the only
 *  system that can be followed by UNREPLACED ones is the last replaced one. */
export interface VerticalPlan {
  /** Start-measure id of each replaced line (index k − a). */
  startIds: string[];
  /** Live staff-top of each replaced system (SVG user units, page-absolute). */
  liveTop: number[];
  /** Staff-top a full re-engrave would give it. */
  newTop: number[];
  /** dy every system BELOW the last replaced one on its page would take
   *  (0 when the last replaced system ends its page — the next page's first
   *  system is margin-anchored and does not move). */
  dyFollow: number;
  /** Start id of the first unreplaced follower, '' when there is none. */
  followId: string;
  /** True when nothing moves at all (the Phase C-B v1 case). */
  static: boolean;
}

function consolidate(el: SVGGElement): { tx: number; ty: number } {
  const base = el.transform?.baseVal?.consolidate?.();
  return base ? { tx: base.matrix.e, ty: base.matrix.f } : { tx: 0, ty: 0 };
}

/** Geometry profile of one rendered system (live page or the window's parsed
 *  SVG document), read from the SVG TEXT — no layout (A11, 2026-09-02).
 *
 *  A measure's horizontal extent is its staff line: the first horizontal
 *  `<path d="M x1 y L x2 y">` under its first `g.staff`. Consecutive measures'
 *  lines abut, so `relX`/`w` are the measure's layout position and width; the
 *  staff top is that line's y. Everything else is a transform attribute. This
 *  replaced `getBBox` reads that needed the window host laid out (~20 ms per
 *  splice, the whole remaining DOM-side cost) and were POLLUTED by content: a
 *  measure's bbox includes spanners overhanging into its neighbours and, on a
 *  system's first measure, the brace (144 units left of the staff).
 *
 *  Proven equivalent where it matters (a since-deleted probe, every sonata line
 *  + governed-range key changes): against the bbox reading, the staff top, the
 *  placement dx/dy and the context-gate verdicts were identical on every splice
 *  (gate deltas ≤ 3 units under both — the live right-edge snap moving a
 *  staff-line end by ½ device px, which both readings see because the snap
 *  rewrites the path). No system-extent fields: the vertical plan never
 *  consumed them beyond diagnostics, and the page-fit check reads the live
 *  page after surgery. Null when the shape is not what we expect — the caller
 *  refuses, never guesses. */
function systemProfile(sysEl: SVGGElement): SysProfile | null {
  const t = consolidate(sysEl);
  const measures = Array.from(sysEl.querySelectorAll('g.measure')) as SVGGraphicsElement[];
  if (!measures.length) return null;
  const l0 = staffLineOf(measures[0]);
  if (!l0) return null;
  const staffT = consolidate(l0.staff as SVGGElement);
  /* Top staff line = min y over the staff's horizontal direct-child paths. */
  let topLine = Infinity;
  for (const p of Array.from(l0.staff.children)) {
    if (p.localName !== 'path') continue;
    const d = parseLinePath(p.getAttribute('d'));
    if (d && d.y1 < topLine) topLine = d.y1;
  }
  if (!isFinite(topLine)) return null;
  return {
    el: sysEl,
    x0: l0.x1 + t.tx,
    staffTop: topLine + staffT.ty + t.ty,
    measures: (() => {
      let memo: Array<{ id: string; relX: number; w: number }> | null = null;
      return () => (memo ??= measures.map((m) => {
        const l = staffLineOf(m);
        /* A measure without a readable staff line cannot be compared; report
           it as an impossible width so any gate on it refuses. */
        return l ? { id: m.id, relX: l.x1 - l0.x1, w: l.x2 - l.x1 } : { id: m.id, relX: NaN, w: NaN };
      }));
    })(),
  };
}

/** `M x1 y1 L x2 y2` of a horizontal staff-line path, or null. */
function parseLinePath(d: string | null): { x1: number; y1: number; x2: number; y2: number } | null {
  const m = /M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(d ?? '');
  if (!m) return null;
  const y1 = Number(m[2]), y2 = Number(m[4]);
  if (Math.abs(y1 - y2) > 1e-6) return null;
  return { x1: Number(m[1]), y1, x2: Number(m[3]), y2 };
}

/** The first horizontal staff-line path of a measure's first `g.staff`. */
function staffLineOf(measureEl: Element): { staff: Element; x1: number; x2: number; y: number } | null {
  const staff = measureEl.querySelector(':scope > g.staff');
  if (!staff) return null;
  for (const p of Array.from(staff.children)) {
    if (p.localName !== 'path') continue;
    const d = parseLinePath(p.getAttribute('d'));
    if (d) return { staff, x1: d.x1, x2: d.x2, y: d.y1 };
  }
  return null;
}

/** What the splicer is asked to engrave (B2, 2026-09-02): the edit path builds
 *  one from a `RefillResult` — the systems of a line hunk, re-engraved for the
 *  NEW partition. Where they go is PageAssembler.applyPartition's (2026-10-21). */
export interface SpliceRequest {
  /** Partition the mounted DOM renders (pre-edit) — live systems are located
   *  by THESE ids, even ones whose measure the edit deleted. */
  oldStartIds: string[];
  /** Partition the DOM must render afterwards. */
  newStartIds: string[];
  /** Pagination the DOM was built for (page-start line ids, page 1 first, DOM
   *  page numbers): where each line is drawn NOW, so the hunk is clipped to the
   *  mounted band. Where lines go after the edit is the assembler's fit. */
  oldPageStartIds: string[];
  /** Measure run the edit changed (NEW measure indices), or null when nothing
   *  in the document changed (a pure move). */
  changedRun: { lo: number; hi: number } | null;
  /** The spanners the mounted DOM draws (pre-edit), so a run that removed one
   *  replaces every line its segments are on. Absent = the edit changed no
   *  content (a partition-only move). */
  spanners?: SpannerSnapshot | null;
  /** The document is unchanged and only the partition moved (the section
   *  balancer's idle job, 2026-09-05). There is no edit line that must be
   *  mounted: a hunk whose first line is on an unmounted page is deferred
   *  whole — pins committed, pages marked stale — instead of refused. */
  partitionOnly?: boolean;
}

export class PageSystemSplicer {
  /** Diagnostics for tests/probes. */
  lastOutcome: 'spliced' | 'applied' | 'rescaled' | 'skipped' | 'noop' | '' = '';
  lastSkipReason = '';
  /** The systems the last splice engraved, by new line start, each with the
   *  parsed window document it came from — handed to
   *  PageAssembler.applyPartition, which imports, measures and places them. */
  lastStaged = new Map<string, { system: SVGGElement; host: Document }>();
  lastStats = { lines: 0, windowLines: 0, windowMeasures: 0, loadMs: 0, totalMs: 0 };
  /** The vertical plan the last gate computed (null when it never got that
   *  far). Diagnostics for the probes; the splice itself consumes it inline. */
  lastVertical: VerticalPlan | null = null;
  /** NEW-line range the last attempt needed to REPLACE (diagnostics: a refusal
   *  names a reason, but not which lines it wanted — `splice-sweep.js` needs that
   *  to tell a not-mounted line from a not-mounted spanner-expanded run). */
  lastRun: { a: number; b: number } | null = null;
  /** Pages whose hunk lines the last splice DEFERRED (2026-09-02): outside the
   *  mounted band, so they were not re-engraved. The renderer marks them stale
   *  and returns any that were drawn to placeholders, so each redraws from the
   *  committed pins when it next mounts. */
  lastDeferredPages: number[] = [];
  /** NEW-line range the last splice deferred, or null when it deferred none. */
  lastDeferredLines: { a: number; b: number } | null = null;
  /** The line hunk the last attempt replaced: old lines [a..bOld] gave way to
   *  new lines [a..bNew] (B2 — the counts may differ). */
  lastHunk: { a: number; bOld: number; bNew: number } | null = null;
  /** The hunk before the mounted-band clip: every NEW line the edit changes
   *  (spanner- and ending-closed), engraved or deferred. Set as soon as it is
   *  known, so it survives a later refusal — the renderer re-fits all of it. */
  lastHunkFull: { a: number; bOld: number; bNew: number } | null = null;
  /** Shape of the last window built (diagnostics): the lines and measures the
   *  sub-document covered, its synthetic leader/trailer, its page pins, and how
   *  many lines the courtesy rule (B3) pulled in. */
  lastWindow: {
    wLo: number; wHi: number; mLo: number; mHi: number;
    leader: boolean; trailer: boolean; pbIds: string[];
    /** First measure of the line beyond the window, appended as a pinned
     *  one-measure stub when that line begins a signature change (it
     *  generates the last window line's end-of-line courtesy). */
    stubId: string | null;
  } | null = null;
  /** The sub-MEI the last window rendered from (diagnostics — a reference to a
   *  string that already exists, so free to keep). */
  lastWindowMei: string | null = null;

  /** The caller resolved a signature-identical doc — the mounted DOM already
   *  renders it; nothing to do. Recorded for diagnostics only. */
  /** The renderer applied the partition line by line (PageAssembler.applyPartition)
   *  after this splicer refused or the change was not a hunk — a splice in every
   *  sense the ledger cares about. */
  noteApplied(): void {
    this.lastOutcome = 'applied';
    this.lastSkipReason = '';
  }

  /** A zoom rescaled the pages in place (PageAssembler.rescale): no render. */
  noteRescaled(): void {
    this.lastOutcome = 'rescaled';
    this.lastSkipReason = '';
  }

  noteNoop(): void {
    this.lastOutcome = 'noop';
    this.lastSkipReason = '';
  }

  /** Engrave the request's line hunk in one window. True when the hunk's
   *  mounted lines are engraved (`lastStaged`; possibly none, when the hunk is
   *  deferred whole) — the caller hands them to PageAssembler.applyPartition,
   *  which places every system and re-fits the pages. False when any gate
   *  refused (lastSkipReason says why) — the caller then lets applyPartition
   *  engrave the changed lines one window each. The DOM is never touched. */
  trySplice(model: ComposerModel, req: SpliceRequest, ctx: PageSpliceCtx): boolean {
    const t0 = performance.now();
    this.lastStats = { lines: 0, windowLines: 0, windowMeasures: 0, loadMs: 0, totalMs: 0 };
    this.lastStaged = new Map();
    this.lastVertical = null;
    this.lastRun = null;
    this.lastHunk = null;
    this.lastHunkFull = null;
    this.lastWindow = null;
    this.lastWindowMei = null;
    const skip = (why: string): false => {
      this.lastOutcome = 'skipped';
      this.lastSkipReason = why;
      this.lastStats.totalMs = Math.round(performance.now() - t0);
      return false;
    };
    this.lastDeferredPages = [];
    this.lastDeferredLines = null;
    const { changedRun, oldStartIds, newStartIds } = req;
    if (!changedRun) return skip('no changed run');

    const meiMeasures = model.allMeasures();
    const ids = meiMeasures.map((m) => m.getAttribute('xml:id') ?? '');
    const idIdx = new Map(ids.map((id, i) => [id, i]));
    const N = oldStartIds.length, M = newStartIds.length;
    const spans: Array<[number, number]> = [];
    for (let li = 0; li < M; li++) {
      const a0 = idIdx.get(newStartIds[li]);
      if (a0 == null) return skip('partition id missing from doc');
      spans.push([a0, li + 1 < M ? (idIdx.get(newStartIds[li + 1]) ?? ids.length) : ids.length]);
    }
    const lineOf = (mi: number): number => {
      let lo = 0, hi = M - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (spans[mid][0] <= mi) lo = mid; else hi = mid - 1; }
      return lo;
    };

    /* ── the replaced HUNK (B2): old lines [a..bOld] → new lines [a..bNew] ──
       The partition diff is taken by START ID, prefix and suffix, so a refill
       that turned N systems into M (a new final line while composing, a line
       whose measures were all deleted, a line split before a user break) is a
       hunk with unequal sides instead of a refusal. Lines outside the hunk are
       identical on both sides, line for line, so the two coordinate systems
       agree there; inside it, old lines are what the DOM shows and new lines
       are what the window renders. A non-empty partition diff also changed the
       EXTENT of the line just above it (its last measure moved across the
       boundary), so that line joins the hunk. */
    let pre = 0;
    while (pre < Math.min(N, M) && oldStartIds[pre] === newStartIds[pre]) pre++;
    let suf = 0;
    while (suf < Math.min(N, M) - pre && oldStartIds[N - 1 - suf] === newStartIds[M - 1 - suf]) suf++;
    /* Hunk bounds. An identical partition (N = M, every id equal) leaves the
       changed run alone to decide the replaced set, on both sides alike. Note
       the new side alone can be empty (a > bNew) when whole lines vanished —
       that is a changed partition, not an unchanged one. */
    let a = pre, bNew = M - 1 - suf, bOld = N - 1 - suf;
    const partitionUnchanged = N === M && pre === N;
    if (!partitionUnchanged && a > 0) a--;

    /* The changed run, closed over spanners/endings (a spanner overlapping the
       run renders segments in every line it touches — all of them must be
       replaced together), in NEW line coordinates; it widens the hunk. */
    let a2 = M, b2 = -1;
    if (changedRun) {
      const docVer = model.docVersion();
      /* A render-time dependency the sig-diff cannot see: `relocateInitialClefs`
         draws a measure-initial clef at the END of the PREVIOUS measure (as the
         change/courtesy glyph), so an edit that makes a clef measure-initial — or
         stops it being so — re-engraves the measure BEFORE the changed run, which
         may sit on the line above. The sonata's last measure holds a mid-measure
         C clef; deleting the chord ahead of it moved the clef onto the previous
         line and re-justified that whole line (dW 89..329), which the context
         check correctly refused as "unchanged context that changed"
         (a since-deleted probe, m-cy6). Any layer clef in the run's first measure
         pulls its predecessor into the run: cheap, and covers both directions
         without needing the pre-edit measure. */
      let cLo = Math.min(changedRun.lo, ids.length - 1);
      if (cLo > 0 && meiMeasures[cLo].querySelector(':scope > staff > layer > clef')) cLo--;
      let [rLo, rHi] = expandForRenderedSpanners(req.spanners ?? null, idIdx, cLo, Math.min(changedRun.hi, ids.length - 1));
      [rLo, rHi] = expandForSpannersOnce(meiMeasures, rLo, rHi, docVer);
      [rLo, rHi] = expandForEndings(meiMeasures, rLo, rHi);
      [rLo, rHi] = model.renderUnits(ctx.viewStaves).snap(rLo, rHi);   // a multimeasure rest is one rendered measure
      a2 = lineOf(rLo); b2 = lineOf(rHi);
    }
    if (a2 <= b2) {
      if (partitionUnchanged) {
        a = a2; bNew = b2; bOld = b2;                 // N === M here
      } else {
        /* Lines outside the hunk are identical on both sides, so a changed-run
           line in the prefix keeps its index and one in the suffix maps by the
           count difference. */
        a = Math.min(a, a2);
        bNew = Math.max(bNew, b2);
        bOld = bNew + (N - M);
      }
    }
    if (a > bNew || a > bOld) return skip('empty replaced set');
    this.lastRun = { a, b: bNew };
    this.lastHunk = { a, bOld, bNew };
    this.lastHunkFull = { a, bOld, bNew };

    /* Pages are not the splicer's (2026-10-21, Max: "every repartition must
       repaginate"): it ENGRAVES the hunk, and PageAssembler.applyPartition
       places every system and re-fits every page against what it actually
       holds. What the splicer needs is where each new line's first measure is
       drawn NOW — the pre-edit page grid, which the old pins describe — so it
       engraves only lines on mounted pages and leaves the rest to their pages'
       mounts (the assembler turns those pages into deferred cards). */
    const pageOfOld = pageIndexer(oldStartIds, req.oldPageStartIds);
    const oldStartIdx = oldStartIds.map((id) => idIdx.get(id) ?? -1);
    const pageNow = (li: number): number => {
      const mi = spans[li][0];
      let k = 0;
      for (let i = 0; i < N; i++) if (oldStartIdx[i] >= 0 && oldStartIdx[i] <= mi) k = i;
      return pageOfOld(k);
    };

    /* B5 — ensure-mount the EDIT's own neighbourhood. Page view mounts pages
       lazily, so in real use only a handful are live (2-6 on the sonata) and
       the line the splice must touch is sometimes still a placeholder.
       Mounting from the already-loaded pre-edit layout costs ~50 ms against
       the per-line engraving it avoids. The edit's neighbourhood ONLY, not the
       whole hunk (2026-09-02) — see the clip below. */
    if (req.oldPageStartIds.length && !req.partitionOnly) {
      const want = new Set<number>();
      for (let k = Math.max(0, a - 1); k <= Math.min(N - 1, Math.min(bOld, a + 1)); k++) want.add(pageOfOld(k));
      for (const p of want) ctx.ensurePageMounted(p);
    }

    /* ── clip the engraved set to the MOUNTED BAND (2026-09-02) ──
       Max: "aren't unmounted pages supposed to be deferred off the main
       thread? A synchronous wait for a 34-line window shouldn't be possible."
       A wide changed run — most often a renumber, which dirties every measure
       to the end of its section — can span many pages; engraving all of them
       for an edit made on page 1 is the cost the clip removes. A line nobody
       has mounted needs no engraving now: its page is re-fitted from the
       committed lines and engraved when it mounts. So the window covers the
       lines from the edit's that sit on the maximal contiguous run of mounted
       pages containing it (page granularity keeps them contiguous, which the
       window needs); a changed line on any other mounted page is engraved by
       the assembler on its own. */
    const deferFrom = (from: number): void => {
      const deferred = new Set<number>();
      for (let k = from; k <= bNew; k++) deferred.add(pageNow(k));
      this.lastDeferredPages = [...deferred].sort((x, y) => x - y);
      this.lastDeferredLines = { a: from, b: bNew };
    };
    const editPage = pageNow(a);
    if (!ctx.isPageMounted(editPage)) {
      if (!req.partitionOnly) return skip('edit line not mounted');
      /* Partition-only change whose first line nobody has drawn: engrave
         nothing; every hunk page re-fits and redraws when it mounts. */
      deferFrom(a);
      this.lastOutcome = 'spliced';
      this.lastSkipReason = '';
      this.lastStats.lines = 0;
      this.lastStats.totalMs = Math.round(performance.now() - t0);
      this.lastRun = { a, b: a - 1 };
      this.lastHunk = { a, bOld, bNew };
      return true;
    }
    let bandLo = editPage, bandHi = editPage;
    while (bandLo > 1 && ctx.isPageMounted(bandLo - 1)) bandLo--;
    while (ctx.isPageMounted(bandHi + 1)) bandHi++;
    for (let k = a + 1; k <= bNew; k++) {
      const p = pageNow(k);
      if (p >= bandLo && p <= bandHi) continue;
      deferFrom(k);
      bOld = Math.min(bOld, k - 1);
      bNew = k - 1;
      break;
    }
    this.lastRun = { a, b: bNew };
    this.lastHunk = { a, bOld, bNew };

    /* Window: cover every spanner with an end inside the REPLACED lines, then
       add one context line each side. ONE pass, no fixed point.

       The rule (Max, 2026-08-31): a spanner with one end inside the replaced
       set needs the window to cover its other end — otherwise Verovio cannot
       resolve the endpoint, drops the spanner, and a REPLACED line renders
       without a segment the live page has. A spanner lying entirely outside
       the replaced set cannot change how those lines draw, so it is none of
       the window's business; one dangling out of a CONTEXT line is harmless,
       since context lines are only measured for per-measure x/width.

       Iterating to a fixed point instead (what this did until 2026-08-31)
       makes the window a transitive closure over the interval graph of
       spanners, and on real music that graph is a chain: the sonata's ordinary
       legato phrasing — 2-measure slurs each ending where the next begins —
       walked one seed 17 slurs deep, over 24 measures and 6 lines, purely
       through lines nobody was re-rendering (measured 2026-08-31 by probes since
       deleted; decisions.md, Phase C-B entries).

       There are no CONTEXT lines any more (Phase 3, 2026-09-03). They had
       three jobs and all three are gone: the vertical spacing chain went with
       Phase 1 (every system is placed by Composer's own rule over measured
       extents, render/pagefit.ts); the courtesy went with Phase 0's one-measure
       stub; and the live fidelity comparison — comparing L-1 and L+1 against
       the mounted page — was a FALLBACK that masked a subset of our own
       replaced-set defects, which is the pattern the governing principle
       rejects. It detected nothing the reference gate does not: every touched
       page is compared against a fresh full render under HKL_INDEX_CHECK, and
       every dependency this window rule encodes was discovered in such a run.
       So the stub rules ARE the cross-measure dependency list, made
       executable, and a not-yet-known dependency is now a visible wrong page
       instead of a silent slow render. Preconditions and evidence:
       docs/decisions.md 2026-09-03.

       Window = leader? + the spanner/ending-closed hunk lines + courtesy stub?
       + trailer? — 14.3 measures to ~6.5 on the sonata. */
    const docVer = model.docVersion();
    let [wm0, wm1] = expandForSpannersOnce(meiMeasures, spans[a][0], spans[bNew][1] - 1, docVer);
    [wm0, wm1] = expandForEndings(meiMeasures, wm0, wm1);
    [wm0, wm1] = model.renderUnits(ctx.viewStaves).snap(wm0, wm1);
    let wLo = lineOf(wm0);
    let wHi = lineOf(wm1);
    /* Rounding out to whole LINES reaches back past wm0 (a line's first measure
       precedes the seed) and forward past wm1, and that reach can land inside
       an <ending>; a volta bracket re-engraved over a truncated member set is
       wrong, so contain it — once. */
    const [em0, em1] = expandForEndings(meiMeasures, spans[wLo][0], spans[wHi][1] - 1);
    wLo = lineOf(em0); wHi = lineOf(em1);
    /* Courtesy signatures (B3; stub form since 2026-09-02). An end-of-line
       courtesy is generated by the line that FOLLOWS, so if the line just
       beyond the window begins with a clef/key/meter change, the window's last
       line would render without a courtesy the live page draws — width-only,
       43-347 units on the sonata, and 9 of the 11 context-check refusals
       measured by `splice-sweep.js`. Only that line's FIRST measure generates the
       courtesy, so it is appended as a pinned one-measure STUB system — the
       same partial-absorber idea as the leader and trailer: discarded, never
       compared, never imported, never chained from. Until 2026-09-02 the whole
       line was pulled in, bounded at two lines because the sonata has runs of
       consecutive meter changes; a stub has no such chain (its own courtesy is
       nobody's business) and costs one measure instead of a line (4-10 on the
       sonata, ~25 % of the window where it fired). Proof: a since-deleted probe
       on both code states. */
    let stubId: string | null = null;
    if (wHi + 1 < M && beginsSignatureChange(meiMeasures[spans[wHi + 1][0]])) stubId = newStartIds[wHi + 1];
    const mLo = spans[wLo][0], mHi = stubId ? spans[wHi + 1][0] : spans[wHi][1] - 1;
    this.lastStats.windowLines = wHi - wLo + 1;
    this.lastStats.windowMeasures = mHi - mLo + 1;

    const winStarts = newStartIds.slice(wLo, wHi + 1);
    /* No page pins (Phase 1 of the vertical-ownership plan, 2026-09-02): the
       window is ONE page. Nothing is read from the window's vertical layout
       any more — every system's place on its live page comes from Composer's
       placement rule over extents measured after import (render/pagefit.ts) —
       so a page-first line needs no `<pb>` to be read "absolutely" (B1's
       reason for pinning), and a cascade's moved block is placed like any
       other system. `pbIds` stays for the window builder's signature and the
       diagnostics. */
    const leader = wLo > 0;
    const pbIds = new Set<string>();
    /* A window ending mid-document needs a synthetic TRAILER line: the
       sub-document's last measure would otherwise draw the end-of-score FINAL
       barline (~5 px wider than the live line's normal barline — found by the
       sonata battery's context check). The pinned mRest trailer absorbs it
       and is discarded, exactly like the leader absorbs score-start artifacts. */
    const trailer = mHi < ids.length - 1;
    this.lastWindow = { wLo, wHi, mLo, mHi, leader, trailer, pbIds: [...pbIds], stubId };
    const winMei = buildWindowMei(model, mLo, mHi, winStarts, leader, trailer, stubId, pbIds, ctx.viewStaves);
    if (!winMei) return skip('window build failed');
    this.lastWindowMei = winMei;

    const tLoad = performance.now();
    ctx.toolkit.setOptions(ctx.windowOptions);
    if (!ctx.toolkit.loadData(winMei)) return skip('window loadData failed');
    const wantPages = 1 + pbIds.size;
    if (ctx.toolkit.getPageCount() !== wantPages) return skip('window paginated');
    /* One parsed SVG document per window page (A11): NEVER attached, never
       laid out. Everything the splice reads from the window is text — staff-line
       paths, transforms, glyph hrefs — and the systems are post-processed by
       PageAssembler.applyPartition once imported (in their page, or its
       staging shell). Attaching a host used to cost its initial layout
       (~20 ms) on the first geometry read. */
    const hosts: Document[] = [];
    for (let pno = 1; pno <= wantPages; pno++) {
      const doc = new DOMParser().parseFromString(ctx.toolkit.renderToSVG(pno, {}), 'image/svg+xml');
      if (doc.querySelector('parsererror')) return skip('window svg unparsable');
      hosts.push(doc);
    }
    this.lastStats.loadMs = Math.round(performance.now() - tLoad);
    const ok = this.stageWindow(hosts, { a, bNew, wLo, wHi, winStarts, leader, trailer, stubId }, newStartIds, skip);
    if (ok) {
      this.lastOutcome = 'spliced';
      this.lastSkipReason = '';
      this.lastStats.lines = bNew - a + 1;
      this.lastStats.totalMs = Math.round(performance.now() - t0);
    }
    return ok;
  }

  /** The engraved hunk: lines [a..bNew] of the window, validated against the
   *  window's expected system sequence, recorded in `lastStaged` by new line
   *  start with the parsed window document each came from (its glyph defs).
   *  Nothing is imported or placed here — PageAssembler.applyPartition imports
   *  them into its staging shell, post-processes and measures them exactly as
   *  the assembly does a line, and places every page. */
  private stageWindow(
    hosts: Document[],
    r: { a: number; bNew: number; wLo: number; wHi: number; winStarts: string[]; leader: boolean; trailer: boolean; stubId: string | null },
    newStartIds: string[],
    skip: (why: string) => false,
  ): boolean {
    const systems: SVGGElement[] = [];
    const hostOf = new Map<SVGGElement, Document>();
    for (const h of hosts) {
      const onPage = Array.from(h.querySelectorAll('g.system')) as SVGGElement[];
      onPage.forEach((sys) => hostOf.set(sys, h));
      systems.push(...onPage);
    }
    const expected = (r.leader ? [LEAD_ID] : []).concat(r.winStarts, r.stubId ? [r.stubId] : [], r.trailer ? [TRAIL_ID] : []);
    if (systems.length !== expected.length) return skip('window system count mismatch');
    for (let i = 0; i < systems.length; i++) {
      if (systems[i].querySelector('g.measure')?.id !== expected[i]) return skip('window partition mismatch');
    }
    const staged = new Map<string, { system: SVGGElement; host: Document }>();
    for (let li = r.a; li <= r.bNew; li++) {
      const sys = systems[(r.leader ? 1 : 0) + (li - r.wLo)];
      if (!systemProfile(sys)) return skip('window profile unreadable');
      staged.set(newStartIds[li], { system: sys, host: hostOf.get(sys) ?? hosts[0] });
    }
    this.lastStaged = staged;
    return true;
  }

  /** Page `pno` of the reference loaded on `tk`, prepared EXACTLY as the live
   *  page `pageEl` is, in an offscreen host the caller removes. Shared by the
   *  gate below and the census probe (`referenceTops`), so the two cannot
   *  drift apart again: the census once built its own reference without
   *  Composer's page header and placed it without the page number, and read
   *  page 1's title block and every section-header band as splice error
   *  (2026-10-20). Its post passes may render a window on `tk` — reload
   *  before the next page. */
  private referenceHost(tk: VerovioToolkit, pno: number, pageEl: HTMLElement, ctx: PageSpliceCtx): HTMLElement {
    const refHost = document.createElement('div');
    refHost.style.cssText = 'position:absolute;left:-99999px;top:0';
    refHost.innerHTML = tk.renderToSVG(pno, {});
    document.body.appendChild(refHost);
    /* The live page's header is Composer's (render/pageshell.ts, 2026-10-08);
       give the reference the same one, or page 1's title block anchors its
       first system elsewhere. */
    const refMargin = refHost.querySelector('svg g.page-margin');
    if (refMargin) drawPageHeader(refMargin, pno, ctx.headerMeta(), pageFrameOf(refMargin).innerW);
    /* Same post-processing the live pages and the window hosts get: the HEJI
       pass replaces key-signature `use` glyphs with injected <text>, so a raw
       reference would compare its E260 flats against a live page that has
       none — a false divergence, not a wrong render (seen on the sonata's
       line 0 the day the glyph check landed). Geometry is unaffected. */
    /* Snap the reference's system right edges on the LIVE page's horizontal
       phase. `snapSystemRightEdge` lands them on an ABSOLUTE device pixel, so
       a host at left:-99999px otherwise snaps to a different one — up to a
       whole device pixel of disagreement, which is 10 user units at scale 100
       (exactly TOL, so invisible here) but 20 at scale 50, and that is the
       entire content of `lock_after_zoom_reflows` (2026-09-18). Same argument,
       and the same `g.page-margin` origin, as the vertical `alignStaves`
       transfer below. */
    ctx.postProcess(refHost, undefined, ctx.originPhaseXOf(pageEl));
    /* The reference must be prepared EXACTLY as a live page is, decoration
       included. `decorateHost` (styleVoltaNumbers) restyles a tspan inside
       `g.voltaBracket` — font, weight and a trailing '.' — which changes the
       bracket's bbox, and a volta is content ABOVE the staff, so it changes
       the `above` this gate then places from. Omitting it made every
       reference disagree with the live page by that amount on any system
       carrying a volta (measured: above 1303 vs 1275), which read as a splice
       defect and was very nearly "fixed" by widening TOL. It runs BEFORE
       alignment and measurement, mirroring the live order (postProcess →
       decorate → place). */
    ctx.decorateHost(refHost);
    /* Same phase alignment the live pages get (2026-09-03) — see alignStaves. */
    ctx.alignStaves(refHost, ctx.originPhaseOf(pageEl));
    return refHost;
  }

  /** Probe API (sonata-probes/splice-exactness-census.js): the gate's own
   *  comparison with NO tolerance — for every given live page, the reference's
   *  staff tops placed by Composer's rule (distributed, page-numbered, exactly
   *  as the gate places them) minus the live page's measured staff tops
   *  (`ds`), and the live page's self-consistency (`self`: its own placement
   *  minus the same). A page whose system count differs reports both counts. */
  referenceTops(mei: string | null, pageEls: Iterable<HTMLElement>, ctx: PageSpliceCtx):
    Array<{ page: number; sys: number; ds: number[]; self: number[] } | { page: number; refSys: number; liveSys: number }> {
    const out: Array<{ page: number; sys: number; ds: number[]; self: number[] } | { page: number; refSys: number; liveSys: number }> = [];
    if (mei === null) return out;
    const tk = ctx.toolkit;
    let loaded = false;
    for (const pageEl of pageEls) {
      if (!pageEl.isConnected) continue;
      if (!loaded) { tk.setOptions(ctx.liveOptions()); if (!tk.loadData(mei)) return out; loaded = true; }
      const pno = Number(pageEl.dataset.page);
      if (!(pno >= 1) || pno > tk.getPageCount()) continue;
      const refHost = this.referenceHost(tk, pno, pageEl, ctx);
      loaded = false;
      try {
        const refSys = Array.from(refHost.querySelectorAll('g.system')) as SVGGElement[];
        const liveSys = Array.from(pageEl.querySelectorAll('g.system')) as SVGGElement[];
        if (refSys.length !== liveSys.length) { out.push({ page: pno, refSys: refSys.length, liveSys: liveSys.length }); continue; }
        const expect = ctx.placeFor(refSys, { distribute: true, pageNo: pno });
        const self = ctx.placeFor(liveSys, { distribute: true, pageNo: pno });
        if (!expect || !self) continue;
        const ds: number[] = [], sc: number[] = [];
        for (let i = 0; i < liveSys.length; i++) {
          const lp = systemProfile(liveSys[i]);
          if (!lp) { ds.push(NaN); sc.push(NaN); continue; }
          ds.push(+(expect[i].top - lp.staffTop).toFixed(2));
          sc.push(+(self[i].top - lp.staffTop).toFixed(2));
        }
        out.push({ page: pno, sys: liveSys.length, ds, self: sc });
      } finally {
        refHost.remove();
      }
    }
    return out;
  }

  /** HKL_INDEX_CHECK deep gate (the design doc's parity harness, inline):
   *  full-render the pinned MEI offscreen and assert every given page's system
   *  sequence + geometry matches the spliced DOM. Called by the renderer once
   *  the splice AND its pagination repair have settled (page numbers are final
   *  by then). Throws. */
  verifyAgainstReference(mei: string | null, pageEls: Iterable<HTMLElement>, ctx: PageSpliceCtx): void {
    if (mei === null) throw new Error('[page-splice] reference MEI unavailable (pin injection failed)');
    const tk = ctx.toolkit;
    tk.setOptions(ctx.liveOptions());
    if (!tk.loadData(mei)) throw new Error('[page-splice] reference loadData failed');
    /* ONE DEVICE PIXEL (10 user units at scale 100). Not a fudge — the exact
       size of a Verovio behaviour we cannot control, measured 2026-09-03.

       `renderToSVG` is NOT IDEMPOTENT for the running page header: rendering a
       page a SECOND time from the same loaded document moves its `pgHead` text
       (a since-deleted probe — pages 1-5 render at y 371/195/194/194/197 on the first
       pass and 371/197/197/197/197 on the second; a fresh loadData plus a
       single render is perfectly deterministic at 194). It is not order
       dependence and not instance specific. Our pages go through a variable
       number of renders (initial mount, re-mount, the gate's own reference
       render), so a live page's header can sit 3 units from a freshly rendered
       one. `firstContentTop` measures that header, every system on the page is
       placed relative to it, and the device-grid quantization turns those 3
       fractional units into a clean 10-unit step — which is why the residual
       was always EXACTLY one pixel, on a stable set of pages, and never moved
       no matter what changed in our own placement code.

       Pre-existing and not Composer-specific: a re-render has always shifted
       the header fractionally; owning placement only made it visible as a whole
       pixel (Max, 2026-09-03: "accept it, set TOL to 10, and move on").

       Everything we DO control is exact: per-measure relX, per-measure width
       and the live page's placement self-consistency are all 0 across the
       sonata (`splice-exactness-census.js`, 338 pairs), and 317 of 338 pairs are exact
       outright. Do not raise this to hide a regression — the last three
       proposals to widen it were each concealing a real defect.

       The 1e-6 is float noise, not tolerance: a one-pixel flip arrives as
       15259.999999999998 vs 15270 (the reference top is a quantized sum), and a
       strict `> 10` counted that as MORE than one pixel. Measured on the sonata
       after the 2026-09-04 layout changes (gated sweep: 3 rows, all exactly one
       pixel, live header 252.00000763 vs reference 254 — the residual above,
       landing on new rounding boundaries). The accepted residual is one whole
       device pixel; this makes the comparison say so. */
    const TOL = 10 + 1e-6;
    /* The reference page's post-processing below can render on THIS toolkit
       (hide-empty substitution engraves a one-line window for a hidden-staff
       system), replacing the loaded reference with a one-page window; the next
       page element then read as "reference lost page N" (sonata p. 7 → 8, the
       viola solo's one-staff systems, 2026-10-08). Reload before each page
       after the first. */
    let refLoaded = true;
    for (const pageEl of pageEls) {
      if (!pageEl.isConnected) continue;   // an emptied page the renderer removed
      if (!refLoaded) {
        tk.setOptions(ctx.liveOptions());
        if (!tk.loadData(mei)) throw new Error('[page-splice] reference reload failed');
        refLoaded = true;
      }
      const pno = Number(pageEl.dataset.page);
      if (!(pno >= 1) || pno > tk.getPageCount()) {
        throw new Error(`[page-splice] reference lost page ${pageEl.dataset.page}`);
      }
      const refHost = this.referenceHost(tk, pno, pageEl, ctx);
      refLoaded = false;   // its post passes may have rendered a window on this toolkit
      try {
        const refSys = Array.from(refHost.querySelectorAll('g.system')) as SVGGElement[];
        const liveSys = Array.from(pageEl.querySelectorAll('g.system')) as SVGGElement[];
        if (refSys.length !== liveSys.length) {
          throw new Error(`[page-splice] page ${pno}: spliced ${liveSys.length} systems, reference ${refSys.length}`);
        }
        /* Vertical truth is Composer's placement rule (render/pagefit.ts), not
           Verovio's stacking: the reference's systems, measured on the
           reference render, are placed by the rule and must land where the
           live page put its systems; and the live page must be self-consistent
           — placed by the same rule over its own extents. Header bands are part
           of the rule on both sides, so header pages are verified like any
           other with nothing to subtract and nothing exempt. */
        /* DISTRIBUTED on both sides (Phase 4): a live page has had rule v2
           applied, so a reference placed by v1 alone would differ by the whole
           distribution on every page with slack. */
        const expect = ctx.placeFor(refSys, { distribute: true, pageNo: pno });
        const self = ctx.placeFor(liveSys, { distribute: true, pageNo: pno });
        if (!expect || !self) throw new Error(`[page-splice] page ${pno}: placement unreadable`);
        for (let i = 0; i < refSys.length; i++) {
          const rp = systemProfile(refSys[i]);
          const lp = systemProfile(liveSys[i]);
          if (!rp || !lp) throw new Error(`[page-splice] page ${pno} system ${i}: unreadable profile`);
          const rpm = rp.measures(), lpm = lp.measures();
          if (rpm.length !== lpm.length ||
              rpm.some((m, j) => m.id !== lpm[j].id)) {
            throw new Error(`[page-splice] page ${pno} system ${i}: measure sequence diverged from reference`);
          }
          for (let j = 0; j < rpm.length; j++) {
            if (Math.abs(rpm[j].relX - lpm[j].relX) > TOL ||
                Math.abs(rpm[j].w - lpm[j].w) > TOL) {
              throw new Error(`[page-splice] page ${pno} system ${i} measure ${rpm[j].id}: x/width diverged from reference`
                + ` (relX live ${lpm[j].relX.toFixed(1)} vs ref ${rpm[j].relX.toFixed(1)}, d=${(lpm[j].relX - rpm[j].relX).toFixed(1)};`
                + ` w live ${lpm[j].w.toFixed(1)} vs ref ${rpm[j].w.toFixed(1)}, d=${(lpm[j].w - rpm[j].w).toFixed(1)}; TOL ${TOL})`);
            }
          }
          /* Glyph IDENTITY of the signatures, not only their geometry: a clef,
             key or meter drawn in the wrong FORM at the right width passes
             every check above — the sonata's cut time rendered as "2/2" on a
             line-0 splice and no gate noticed (Max, 2026-09-01). Codepoints
             (the `use` href before the per-render hash) are exact and cost no
             layout flush. */
          const refM = Array.from(refSys[i].querySelectorAll('g.measure'));
          const liveM = Array.from(liveSys[i].querySelectorAll('g.measure'));
          for (let j = 0; j < refM.length && j < liveM.length; j++) {
            const a = sigGlyphs(refM[j]), b = sigGlyphs(liveM[j]);
            if (a !== b) {
              throw new Error(`[page-splice] page ${pno} system ${i} measure ${refM[j].id}: signature glyphs diverged from reference (live "${b}" vs "${a}")`);
            }
          }
          /* WHAT each measure drew, not only how wide it is (Phase 3
             precondition 4, 2026-09-03). Every check above is geometry or
             signature form, so a dropped slur segment, a missing articulation
             or an extra accidental at the SAME width passed the whole gate —
             and once the context lines go, the live comparison that used to
             refuse such a window on incidental drift is gone too. A
             glyph-CLASS census is exact, symmetric (both sides carry the same
             post-processing) and costs no layout flush: attribute reads only. */
          for (let j = 0; j < refM.length && j < liveM.length; j++) {
            const d = censusDiff(glyphCensus(refM[j]), glyphCensus(liveM[j]));
            if (d) {
              throw new Error(`[page-splice] page ${pno} system ${i} measure ${refM[j].id}: rendered glyph classes diverged from reference (${d})`);
            }
          }
          /* And the residue: Verovio draws the CONTINUATION segment of a
             spanner that crosses a system break as a direct child of
             `g.system`, outside every measure (measured on the sonata: 4 slurs
             and 9 ties on the mounted pages). A per-measure census cannot see
             one of those go missing — which is precisely the defect a window
             that fails to reach a spanner's far endpoint produces. */
          const dRes = censusDiff(systemResidueCensus(refSys[i]), systemResidueCensus(liveSys[i]));
          if (dRes) {
            throw new Error(`[page-splice] page ${pno} system ${i}: glyph classes outside the measures diverged from reference (${dRes}) — a spanner segment crossing the system break`);
          }
          /* ABSOLUTE tops, not just consecutive spacing: a cascade that shifted
             a whole page by a constant would satisfy every spacing check and
             still be wrong (B1). */
          if (Math.abs(expect[i].top - lp.staffTop) > TOL) {
            /* Name what differs: the two sides' extents and first-content tops,
               so a divergence says whether the content or the frame moved. */
            const re = measureExtents(refSys[i]), le = measureExtents(liveSys[i]);
            const fmt = (e: SysExtents | null): string => e ? `above ${e.above.toFixed(0)} below ${e.below.toFixed(0)} span ${(e.staffBot - e.staffTop).toFixed(0)}` : 'unreadable';
            throw new Error(`[page-splice] page ${pno} system ${i}: staff top diverged from the placement of the reference (${expect[i].top.toFixed(1)} expected, live ${lp.staffTop.toFixed(1)}; ref ${fmt(re)}; live ${fmt(le)}; first tops ref ${expect[0].top.toFixed(1)} live ${self[0].top.toFixed(1)}; n=${refSys.length}; ALL ref ${refSys.map((x, q) => `${q}:${fmt(measureExtents(x))}@${expect[q].top.toFixed(0)}`).join(' | ')}; ALL live ${liveSys.map((x, q) => `${q}:${fmt(measureExtents(x))}@${self[q].top.toFixed(0)}`).join(' | ')})`);
          }
          if (Math.abs(self[i].top - lp.staffTop) > TOL) {
            throw new Error(`[page-splice] page ${pno} system ${i}: live page is not placed by its own rule (${self[i].top.toFixed(1)} vs ${lp.staffTop.toFixed(1)})`);
          }
        }
      } finally {
        refHost.remove();
      }
      /* And every section title must still sit in the band its own system's
         reserve carved out — the invariant the cascade broke. */
      for (const t of hdrTitles(pageEl)) {
        if (!t.ok) {
          throw new Error(`[page-splice] page ${pno}: section title "${t.text}" no longer sits above its system (gap ${t.gap.toFixed(1)})`);
        }
      }
    }
  }
}

/** Line index → 1-based page number under a pagination given as page-start
 *  line ids (in that partition's coordinates). */
function pageIndexer(startIds: string[], pageStartIds: string[]): (li: number) => number {
  const at = new Map(startIds.map((id, i) => [id, i]));
  const pageStartLines: number[] = [];
  for (const id of pageStartIds) {
    const li = at.get(id);
    if (li !== undefined) pageStartLines.push(li);
  }
  pageStartLines.sort((x, y) => x - y);
  return (li: number): number => {
    let p = 1;
    for (let i = 0; i < pageStartLines.length; i++) if (pageStartLines[i] <= li) p = i + 1;
    return p;
  };
}

/** Each section title with a verdict on whether it still labels its system:
 *  the title's baseline must sit inside the reserve band immediately above the
 *  system's content top. A cascade that moved the system without the title
 *  (or vice versa) shows up here immediately. */
function hdrTitles(pageEl: HTMLElement): Array<{ text: string; gap: number; ok: boolean }> {
  const hdr = pageHeaders(pageEl);
  const out: Array<{ text: string; gap: number; ok: boolean }> = [];
  for (const t of hdr.titles) {
    const sys = hdr.systems[t.sysIdx] as SVGGraphicsElement | undefined;
    if (!sys) continue;
    let box: DOMRect;
    try { box = sys.getBBox(); } catch { continue; }
    const ty = consolidate(sys as SVGGElement).ty;
    const y = Number(t.el.getAttribute('y') ?? 0);
    /* Distance from the title baseline down to the system's content top. */
    const gap = (box.y + ty) - y;
    out.push({ text: t.el.textContent ?? '', gap, ok: gap > 0 && gap < 2 * SECTION_TITLE_BAND });
  }
  return out;
}
/** Generous bound on the reserve band (main.ts reserves 900 and puts the
 *  baseline 360 into it). Only used to catch a title that has drifted away
 *  from its system entirely, so the exact value is not load-bearing. */
const SECTION_TITLE_BAND = 900;

/* The vertical plan (verticalPlan, B1) is gone: since Phase 1 of the
   vertical-ownership plan (2026-09-02) every system's place comes from the
   renderer's placement pass over Composer-measured extents (render/pagefit.ts).
   `VerticalPlan` stays as a type for the `lastVertical` diagnostic, which is
   now always null. */

/** Does this measure BEGIN a clef / key / meter change? Verovio draws an
 *  end-of-line courtesy signature on the PREVIOUS line when it does, so a
 *  window that stops here renders its last line without a courtesy the live
 *  page has — a width-only divergence the context check then (correctly)
 *  refuses on. Section-level `<scoreDef>` before the measure, or a signature
 *  element ahead of any event in ANY of its staves.
 *
 *  Two holes closed 2026-09-01, each a sonata movement boundary the first
 *  version walked straight past (a since-deleted probe):
 *  - the scoreDef may sit BEHIND a break element — the importer and
 *    `setSectionHeaderAt` emit `scoreDef > sb[section] > measure`, so the
 *    measure's immediate previous sibling is the `<sb>`, not the scoreDef
 *    (dW 347 and 604 at the II→III and III→IV boundaries);
 *  - a leading clef on staff 2 is a courtesy clef on staff 2 (dW 49 — a
 *    piano right hand going G→F at a line start). */
export function beginsSignatureChange(meas: Element | undefined): boolean {
  if (!meas) return false;
  let top: Element = meas;
  while (top.parentElement && top.parentElement.localName !== 'section') top = top.parentElement;
  for (let p = top.previousElementSibling; p; p = p.previousElementSibling) {
    if (p.localName === 'scoreDef') return true;
    if (p.localName === 'measure' || p.querySelector('measure')) break;
  }
  /* Walk each staff's leading elements (and EVERY one of its layers'): a
     signature element before the first note/rest/chord is a change AT the
     barline; one after it is mid-measure and generates no courtesy.

     Third hole closed 2026-09-03 (Phase 3 precondition 1): the scan used to
     `return false` at the first layer that opened with an event, so it never
     looked at layer 2. Composer puts voices 3-4 in layer 2 of the same staff
     (`layerForVoice`, model/index.ts), so a clef change entered on voice 3 or
     4 was invisible whenever voice 1's layer began with a note — the common
     case. The stub rule becomes load-bearing for the replaced line's own
     courtesy once the context lines go, so a missed change here is a wrong
     page rather than a slow render. Each layer is judged on its own leading
     elements; any layer that leads with a signature element is a change. */
  const scanLeading = (parent: Element): boolean => {
    for (const c of Array.from(parent.children)) {
      const ln = c.localName;
      if (ln === 'clef' || ln === 'keySig' || ln === 'meterSig') return true;
      if (ln === 'note' || ln === 'chord' || ln === 'rest' || ln === 'mRest' || ln === 'beam' || ln === 'tuplet' || ln === 'space') return false;
    }
    return false;
  };
  for (const staff of Array.from(meas.children)) {
    if (staff.localName !== 'staff') continue;
    if (scanLeading(staff)) return true;                 // staff-level signature element
    for (const layer of Array.from(staff.children)) {
      if (layer.localName === 'layer' && scanLeading(layer)) return true;
    }
  }
  return false;
}

/** SMuFL codepoints of every clef / key-signature / meter-signature glyph in a
 *  rendered measure, in document order — the form of each signature, which
 *  geometry checks cannot see (cut time vs "2/2" differ by a few units). */
function sigGlyphs(measureEl: Element): string {
  return Array.from(measureEl.querySelectorAll('g.clef use, g.keySig use, g.meterSig use, g.clef text, g.keySig text, g.meterSig text'))
    .map((n) => {
      if (n.localName === 'use') return (n.getAttribute('xlink:href') ?? n.getAttribute('href') ?? '').replace(/^#/, '').split('-')[0];
      /* A HEJI-injected glyph: the `use` was replaced by a <text> whose content
         IS the codepoint (heji-render.ts). Same identity as the href's `E262`. */
      const cp = (n.textContent ?? '').codePointAt(0);
      return cp === undefined ? '' : cp.toString(16).toUpperCase().padStart(4, '0');
    })
    .join(' ');
}

/** Classes that are layout DIRECTIVES rather than drawn content, and whose
 *  identity legitimately differs between a windowed splice and the pinned
 *  reference: `injectPins` upgrades the `<sb>` at a page start to a `<pb>` in
 *  the render copy (linebreaks.ts), so the reference system carries `g.pb`
 *  exactly where the spliced one carries the window's `g.sb`. Neither draws a
 *  mark. Excluding them was measured, not assumed — before it, this was the
 *  ONLY divergence the census reported across all 377 fixtures. */
const CENSUS_IGNORED_CLASSES = new Set(['pb', 'sb']);

/** Glyph classes a system draws OUTSIDE any of its measures — where Verovio
 *  puts the continuation segment of a spanner crossing the system break. */
function systemResidueCensus(sysEl: Element): Map<string, number> {
  const tally = new Map<string, number>();
  for (const g of Array.from(sysEl.querySelectorAll('g'))) {
    if (g.closest('g.measure')) continue;      // the measure itself, and everything in one
    const cls = g.getAttribute('class')?.split(/\s+/)[0];
    if (cls && !CENSUS_IGNORED_CLASSES.has(cls)) tally.set(cls, (tally.get(cls) ?? 0) + 1);
  }
  return tally;
}

/** Classes whose counts differ between a reference census and a live one —
 *  '' when every class matches. Names each class with both counts, so the
 *  message says WHAT was dropped or added rather than that something was. */
function censusDiff(ref: Map<string, number>, live: Map<string, number>): string {
  const parts: string[] = [];
  for (const k of Array.from(new Set([...ref.keys(), ...live.keys()])).sort()) {
    const a = ref.get(k) ?? 0, b = live.get(k) ?? 0;
    if (a !== b) parts.push(`${k}: reference ${a}, live ${b}`);
  }
  return parts.join('; ');
}

function glyphCensus(measureEl: Element): Map<string, number> {
  const tally = new Map<string, number>();
  for (const g of Array.from(measureEl.querySelectorAll('g'))) {
    const cls = g.getAttribute('class')?.split(/\s+/)[0];
    if (cls && !CENSUS_IGNORED_CLASSES.has(cls)) tally.set(cls, (tally.get(cls) ?? 0) + 1);
  }
  return tally;
}

/** Windowed sub-MEI: serializeRangeForRender over the window's measures, a
 *  synthetic mRest LEADER (when the window is mid-score) that absorbs every
 *  score-start artifact, a synthetic mRest TRAILER (when the window ends
 *  mid-score) that absorbs the end-of-score final barline, and <sb> pins
 *  before every window line start plus the trailer (the leader counts as
 *  line 0, so injectPins pins ALL real starts).
 *
 *  `pbIds` are the window lines that begin a LIVE page: they are pinned as
 *  <pb> instead of <sb>, so the window paginates exactly where the mounted
 *  document does. That is what makes a page-first system page-first in the
 *  window too — the only way to read its position rather than model it (see
 *  verticalPlan). */
export function buildWindowMei(
  model: ComposerModel, mLo: number, mHi: number, winStarts: string[],
  leader: boolean, trailer: boolean, stubId: string | null, pbIds: Set<string>,
  viewStaves: number[] | null,
): string | null {
  const heji = { hejiEnabled: model.getHejiEnabled() };
  const range = model.serializeRangeForRender(mLo, mHi, heji, viewStaves);
  /* The courtesy stub is a real document measure (the last of the range), so
     the serialized range already carries it and any scoreDef / section break
     before it; it only needs its own line pin. */
  const lineStarts = stubId ? winStarts.concat(stubId) : winStarts;
  if (!leader && !trailer) return injectPins(range, lineStarts, pbIds);
  const doc = new DOMParser().parseFromString(range, 'application/xml');
  if (doc.querySelector('parsererror')) return null;
  const section = doc.querySelector('section');
  if (!section) return null;
  /* Staves of the HEAD scoreDef only. A window that contains a movement
     boundary also carries the restart's label-replacement scoreDef, whose
     `<staffGrp n><label/><staffDef n/>` entries are labels, not staves
     (notation/sectionRestart.ts, 2026-09-05); counting them gave the sonata's
     3-staff score a 5-staff mRest leader and Verovio a null staffDef to
     dereference — "RuntimeError: null function" on loadData, surfaced by the
     splice battery's section-header-zone edit once the balancer let a hunk
     start exactly at the boundary. */
  const headDef = doc.querySelector('score > scoreDef') ?? doc.querySelector('scoreDef');
  /* The staves' NUMBERS, not a count: single-part view keeps a part's own
     staff @n (the viola alone is staff 3), and a synthetic staff numbered 1
     would have no staffDef (2026-09-05). */
  const staffNs = headDef
    ? Array.from(headDef.querySelectorAll('staffDef')).map((sd) => sd.getAttribute('n') ?? '').filter((n) => n !== '')
    : [];
  const synthStaffNs = staffNs.length ? staffNs : ['1'];
  const synthMeasure = (id: string): Element => {
    const meas = doc.createElementNS(MEI_NS, 'measure');
    meas.setAttribute('xml:id', id);
    meas.setAttribute('n', '0');
    for (const n of synthStaffNs) {
      const st = doc.createElementNS(MEI_NS, 'staff');
      st.setAttribute('n', n);
      const ly = doc.createElementNS(MEI_NS, 'layer');
      ly.setAttribute('n', '1');
      ly.appendChild(doc.createElementNS(MEI_NS, 'mRest'));
      st.appendChild(ly);
      meas.appendChild(st);
    }
    return meas;
  };
  if (leader) section.insertBefore(synthMeasure(LEAD_ID), section.firstElementChild);
  if (trailer) section.appendChild(synthMeasure(TRAIL_ID));
  const pinIds = (leader ? [LEAD_ID] : []).concat(lineStarts, trailer ? [TRAIL_ID] : []);
  return injectPins(new XMLSerializer().serializeToString(doc), pinIds, pbIds);
}
