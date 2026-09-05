// Page-view system splice (Phase C-B, docs/composer-page-splice-design.md).
//
// After the line-break owner (render/linebreaks.ts) recomputes the partition
// for an edit, the full-render path still costs a whole-doc loadData (~1.25 s
// Chromium / 2-3 s Firefox on the sonata). When the edit is provably local,
// this module re-engraves ONLY the affected systems in a windowed offscreen
// sub-render and splices them into the mounted page SVGs — no loadData of the
// full document at all.
//
// Why the gates are shaped the way they are (probes 2026-08-30, sonata,
// test/composer-inspect/phasec/cb-structure.js + cb-window.js):
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
import type { ComposerModel } from '../model/index.js';
import { expandForSpannersOnce, expandForEndings, mergeGlyphDefs } from './splice.js';
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
  container: HTMLElement;
  /** Isolated toolkit (spliceTk) — never the live one. */
  toolkit: VerovioToolkit;
  /** Live page options with breaks:'line', a huge pageHeight (the window must
   *  land on ONE page), adjustPageHeight, and header:'none'. Page width and
   *  margins MUST match the live render — they set the justification width. */
  windowOptions: object;
  /** The exact options the live pinned render uses (reference verification). */
  liveOptions: () => object;
  /** Renderer.postProcessRendered (crisp pinning, notehead z-order, HEJI,
   *  theme). The page splicer calls it on the LIVE page with `scope` = the
   *  systems it just imported (A11): the window itself is never laid out, so
   *  every geometry-dependent pass runs where the systems actually sit. */
  postProcess: (el: HTMLElement, scope?: Element[]) => void;
  /** Non-geometry page decorations that live in main.ts for mounted pages
   *  (volta number styling) — idempotent, content-level. */
  decorateHost: (el: HTMLElement) => void;
  /** Renderer.placePage — the vertical placement pass (render/pagefit.ts,
   *  Phase 1): measures every system on the page, computes each staff top and
   *  header band from Composer's rule, writes the transforms, stamps band tops
   *  and re-places titles. Runs after post-processing, before the snap. */
  placePage: (pageEl: HTMLElement) => unknown;
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

interface LiveSys extends SysProfile {
  pageEl: HTMLElement;
  pageFirst: boolean;
  pageLast: boolean;
  /** Index of this system among its page's systems. */
  sysIdx: number;
  /** Accumulated section-header displacement this system carries (main.ts's
   *  mount-time injector, which Verovio knows nothing about). Live staff tops
   *  are Verovio's + this. */
  reserve: number;
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
 *  spacing chain (probe cb-window.js: delta 0.0 against a full pinned render)
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
 *  Proven equivalent where it matters (`cb-pathprofile.js`, every sonata line
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

/** What the splicer is asked to land (B2, 2026-09-02): the edit path builds
 *  one from a `RefillResult` — replace the systems of a line hunk with
 *  re-engraved ones, placed where the NEW pagination says they go. (Until
 *  Phase 2 of the vertical-ownership plan the overflow cascade also built one
 *  per moved block; a cascade step is a DOM transplant in
 *  Renderer.repairPagination now and never comes through here.) */
export interface SpliceRequest {
  /** Partition the mounted DOM renders (pre-edit) — live systems are located
   *  by THESE ids, even ones whose measure the edit deleted. */
  oldStartIds: string[];
  /** Partition the DOM must render afterwards. */
  newStartIds: string[];
  /** Pagination before / after (page-start line ids, page 1 first). Old numbers
   *  are DOM page numbers; the count differs only when a page collapsed. */
  oldPageStartIds: string[];
  newPageStartIds: string[];
  /** Measure run the edit changed (NEW measure indices), or null when nothing
   *  in the document changed (a pure move). */
  changedRun: { lo: number; hi: number } | null;
}

/** Where a new line's system goes. */
interface Target {
  /** The live page element. */
  el: HTMLElement;
  pageNo: number;
  pageFirst: boolean;
}

export class PageSystemSplicer {
  /** Diagnostics for tests/probes. */
  lastOutcome: 'spliced' | 'skipped' | 'noop' | '' = '';
  lastSkipReason = '';
  /** Page numbers the last splice edited in place, as numbered at the END of
   *  the splice (the renderer renumbers after removing an emptied page). The
   *  renderer marks exactly these as stale. */
  lastPages: number[] = [];
  /** Page elements the last splice touched (imported into, cascaded, emptied,
   *  or created) — what `lastPages` is computed from once numbering settles. */
  lastPageEls: HTMLElement[] = [];
  /** Source pages the last splice left without any system: a page whose every
   *  line vanished (B2). The renderer removes them and renumbers. */
  lastEmptiedPages: HTMLElement[] = [];
  lastStats = { lines: 0, windowLines: 0, windowMeasures: 0, loadMs: 0, totalMs: 0 };
  /** The vertical plan the last gate computed (null when it never got that
   *  far). Diagnostics for the probes; the splice itself consumes it inline. */
  lastVertical: VerticalPlan | null = null;
  /** NEW-line range the last attempt needed to REPLACE (diagnostics: a refusal
   *  names a reason, but not which lines it wanted — `cb-sweep.js` needs that
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
  /** Per-splice memo of each mounted page's section-header state. */
  private headerCache = new Map<HTMLElement, PageHeaders>();

  /** The caller resolved a signature-identical doc — the mounted DOM already
   *  renders it; nothing to do. Recorded for diagnostics only. */
  noteNoop(): void {
    this.lastOutcome = 'noop';
    this.lastSkipReason = '';
  }

  /** Attempt to land the request as a system splice. Returns true when the
   *  DOM was updated (the caller must NOT full-render; it must then remove
   *  `lastEmptiedPages` and run its page-fit
   *  check on `lastPageEls`); false when any gate refused (lastSkipReason says
   *  why — the caller full-renders). */
  trySplice(model: ComposerModel, req: SpliceRequest, ctx: PageSpliceCtx): boolean {
    const t0 = performance.now();
    this.lastStats = { lines: 0, windowLines: 0, windowMeasures: 0, loadMs: 0, totalMs: 0 };
    this.lastPages = [];
    this.lastPageEls = [];
    this.lastEmptiedPages = [];
    this.lastVertical = null;
    this.lastRun = null;
    this.lastHunk = null;
    this.lastWindow = null;
    this.lastWindowMei = null;
    this.headerCache.clear();
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
       replaced together), in NEW line coordinates; it widens the hunk. (The
       cascade's moved block no longer comes through here: since Phase 2 of
       the vertical-ownership plan a cascade step is a DOM transplant in
       Renderer.repairPagination, never a splice.) */
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
         (`cb-ctxdiverge.js`, m-cy6). Any layer clef in the run's first measure
         pulls its predecessor into the run: cheap, and covers both directions
         without needing the pre-edit measure. */
      let cLo = Math.min(changedRun.lo, ids.length - 1);
      if (cLo > 0 && meiMeasures[cLo].querySelector(':scope > staff > layer > clef')) cLo--;
      let [rLo, rHi] = expandForSpannersOnce(meiMeasures, cLo, Math.min(changedRun.hi, ids.length - 1), docVer);
      [rLo, rHi] = expandForEndings(meiMeasures, rLo, rHi);
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

    /* Pages. NEW numbering decides where every new line goes; OLD numbering is
       the DOM's (the pre-edit page grid), used to mount what will be measured.
       Pages are carried by line (linebreaks.ts), so outside the hunk both
       agree; a page whose every line vanished is missing from the new list
       and its element ends the splice empty (the renderer removes it). */
    const pageOfNew = pageIndexer(newStartIds, req.newPageStartIds);
    const pageOfOld = pageIndexer(oldStartIds, req.oldPageStartIds);
    const newPageStarts = new Set(req.newPageStartIds);
    const isPageFirst = (li: number): boolean => li === 0 || newPageStarts.has(newStartIds[li]);

    /* B5 — ensure-mount the EDIT's own neighbourhood. Page view mounts pages
       lazily, so in real use only a handful are live (2-6 on the sonata) and
       the line the splice must touch is sometimes still a placeholder. That
       used to refuse outright, which made mount misses the single biggest
       refusal class once the coverage sweep stopped pre-mounting everything
       (19 of 39). Mounting from the already-loaded pre-edit layout costs
       ~50 ms against the ~1.2 s full render it avoids.
       The edit's neighbourhood ONLY, not the whole hunk (2026-09-02) — see the
       clip below. */
    if (req.oldPageStartIds.length) {
      const want = new Set<number>();
      for (let k = Math.max(0, a - 1); k <= Math.min(N - 1, Math.min(bOld, a + 1)); k++) want.add(pageOfOld(k));
      for (const p of want) ctx.ensurePageMounted(p);
    }

    /* ── clip the replaced set to the MOUNTED BAND (2026-09-02) ──
       Max: "aren't unmounted pages supposed to be deferred off the main
       thread? A synchronous wait for a 34-line window shouldn't be possible."
       They were not. A wide changed run — most often a renumber, which dirties
       every measure to the end of its section — made the hunk span nine pages;
       B5 mounted every one of them (834 ms) and one window re-engraved all 145
       measures (650 ms), synchronously, for an edit made on page 1.

       A line on a page nobody has mounted needs no DOM work: the partition and
       pagination pins are committed document-wide by the refill, and a page
       marked stale redraws from THOSE pins when it mounts. Same deferral the
       overflow cascade uses for its arithmetic steps (Phase 2).

       So: process the lines whose old AND new page lie in the maximal
       contiguous run of mounted pages containing the edit, and defer the rest.
       Page granularity keeps the processed lines contiguous, which the window
       needs. A mounted page OUTSIDE that band carrying hunk lines cannot be
       left alone — `verifyRenderedPartition` would rightly fail on it — so it
       is deferred too and the renderer returns it to a placeholder. */
    const editPageLo = Math.min(pageOfOld(a), pageOfNew(a));
    const editPageHi = Math.max(pageOfOld(a), pageOfNew(a));
    let bandLo = editPageLo, bandHi = editPageHi;
    for (let p = editPageLo; p <= editPageHi; p++) {
      if (!ctx.isPageMounted(p)) return skip('edit line not mounted');
    }
    while (bandLo > 1 && ctx.isPageMounted(bandLo - 1)) bandLo--;
    while (ctx.isPageMounted(bandHi + 1)) bandHi++;
    const inBand = (p: number): boolean => p >= bandLo && p <= bandHi;
    let bClipOld = bOld, bClipNew = bNew;
    for (let k = a; k <= Math.max(bOld, bNew); k++) {
      const okOld = k > bOld || inBand(pageOfOld(k));
      const okNew = k > bNew || inBand(pageOfNew(k));
      if (okOld && okNew) continue;
      bClipOld = Math.min(bOld, k - 1);
      bClipNew = Math.min(bNew, k - 1);
      break;
    }
    if (bClipOld < bOld || bClipNew < bNew) {
      const deferred = new Set<number>();
      for (let k = bClipOld + 1; k <= bOld; k++) deferred.add(pageOfOld(k));
      for (let k = bClipNew + 1; k <= bNew; k++) deferred.add(pageOfNew(k));
      /* Never defer a page the band still draws lines onto. */
      for (let k = a; k <= bClipOld; k++) deferred.delete(pageOfOld(k));
      for (let k = a; k <= bClipNew; k++) deferred.delete(pageOfNew(k));
      this.lastDeferredPages = [...deferred].sort((x, y) => x - y);
      this.lastDeferredLines = { a: bClipNew + 1, b: bNew };
      bOld = bClipOld; bNew = bClipNew;
      if (bNew < a || bOld < a) {
        /* Nothing the user can see changed: the pins are committed and every
           affected page is deferred. A landing, not a refusal. */
        this.lastOutcome = 'spliced';
        this.lastSkipReason = '';
        this.lastStats.lines = 0;
        this.lastStats.totalMs = Math.round(performance.now() - t0);
        this.lastRun = { a, b: a - 1 };
        this.lastHunk = { a, bOld, bNew };
        return true;
      }
      this.lastRun = { a, b: bNew };
      this.lastHunk = { a, bOld, bNew };
    }

    /* Live systems to replace, located by the PRE-edit partition (that is
       what the mounted DOM renders). All must be mounted, first-of-system,
       and consecutive in the DOM. */
    const live: LiveSys[] = [];
    for (let k = a; k <= bOld; k++) {
      const ls = this.liveSystem(ctx.container, oldStartIds[k]);
      if (!ls) return skip('changed line not mounted');
      live.push(ls);
    }
    for (let k = a + 1; k <= bOld; k++) {
      const prev = live[k - a - 1], cur = live[k - a];
      const consecutive = prev.pageEl === cur.pageEl
        ? nextSystemSibling(prev.el) === cur.el
        : prev.pageLast && cur.pageFirst;
      if (!consecutive) return skip('DOM partition drift (spliced lines not consecutive)');
    }

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
       through lines nobody was re-rendering. See `cb-spanchain.js` /
       `cb-window-walk.js` and the design doc.

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
       measured by `cb-sweep.js`. Only that line's FIRST measure generates the
       courtesy, so it is appended as a pinned one-measure STUB system — the
       same partial-absorber idea as the leader and trailer: discarded, never
       compared, never imported, never chained from. Until 2026-09-02 the whole
       line was pulled in, bounded at two lines because the sonata has runs of
       consecutive meter changes; a stub has no such chain (its own courtesy is
       nobody's business) and costs one measure instead of a line (4-10 on the
       sonata, ~25 % of the window where it fired). Proof: `cb-courtesystub.js`
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
    const winMei = buildWindowMei(model, mLo, mHi, winStarts, leader, trailer, stubId, pbIds);
    if (!winMei) return skip('window build failed');
    this.lastWindowMei = winMei;

    const tLoad = performance.now();
    ctx.toolkit.setOptions(ctx.windowOptions);
    if (!ctx.toolkit.loadData(winMei)) return skip('window loadData failed');
    const wantPages = 1 + pbIds.size;
    if (ctx.toolkit.getPageCount() !== wantPages) return skip('window paginated');
    /* One parsed SVG document per window page (A11): NEVER attached, never
       laid out. Everything the splice reads from the window is text — staff-line
       paths, transforms, glyph hrefs — and the systems it imports are
       post-processed once they sit in the live page, where the post-surgery
       snap already forces the one layout that is needed. Attaching a host used
       to cost its initial layout (~20 ms) on the first geometry read. */
    const hosts: Document[] = [];
    for (let pno = 1; pno <= wantPages; pno++) {
      const doc = new DOMParser().parseFromString(ctx.toolkit.renderToSVG(pno, {}), 'image/svg+xml');
      if (doc.querySelector('parsererror')) return skip('window svg unparsable');
      hosts.push(doc);
    }
    this.lastStats.loadMs = Math.round(performance.now() - tLoad);
    const ok = this.spliceDom(
      hosts, { a, bOld, bNew, wLo, wHi, winStarts, leader, trailer, stubId },
      live, req, newStartIds, spans, idIdx, pageOfNew, isPageFirst, ctx, skip,
    );
    if (ok) {
      this.lastOutcome = 'spliced';
      this.lastSkipReason = '';
      this.lastStats.lines = bNew - a + 1;
      this.lastStats.totalMs = Math.round(performance.now() - t0);
    }
    return ok;
  }

  /** Locate the mounted live system whose FIRST measure is `startId`. */
  private liveSystem(container: HTMLElement, startId: string): LiveSys | null {
    const m = container.querySelector('#' + CSS.escape(startId));
    if (!m) return null;
    const sys = m.closest('g.system') as SVGGElement | null;
    const pageEl = m.closest('.score-page') as HTMLElement | null;
    if (!sys || !pageEl || pageEl.classList.contains('score-page-pending')) return null;
    if (sys.querySelector('g.measure')?.id !== startId) return null;
    const prof = systemProfile(sys);
    if (!prof) return null;
    const margin = sys.parentElement;
    if (!margin) return null;
    const siblings = Array.from(margin.children).filter((c) => c.classList.contains('system'));
    const hdr = this.headersFor(pageEl);
    const sysIdx = siblings.indexOf(sys);
    return {
      ...prof,
      pageEl,
      pageFirst: siblings[0] === sys,
      pageLast: siblings[siblings.length - 1] === sys,
      sysIdx,
      reserve: (sysIdx >= 0 ? hdr.reserve[sysIdx] : undefined) ?? 0,
    };
  }

  /** `pageHeaders`, memoised for the duration of one splice attempt. */
  private headersFor(pageEl: HTMLElement): PageHeaders {
    let h = this.headerCache.get(pageEl);
    if (!h) { h = pageHeaders(pageEl); this.headerCache.set(pageEl, h); }
    return h;
  }

  /** Gates that need the rendered window, then the surgery. */
  private spliceDom(
    hosts: Document[],
    r: { a: number; bOld: number; bNew: number; wLo: number; wHi: number; winStarts: string[]; leader: boolean; trailer: boolean; stubId: string | null },
    live: LiveSys[],
    req: SpliceRequest,
    newStartIds: string[],
    spans: Array<[number, number]>,
    idIdx: Map<string, number>,
    pageOfNew: (li: number) => number,
    isPageFirst: (li: number) => boolean,
    ctx: PageSpliceCtx,
    skip: (why: string) => false,
  ): boolean {
    const M = newStartIds.length;
    /* Window systems in document order (one window page since Phase 1), each
       tagged with the host it came from (mergeGlyphDefs reads that page's defs). */
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
    /* No post-processing on the window (A11): it is a parsed document that is
       never laid out, and every pass that needs geometry runs on the imported
       systems once they sit in the live page, where the post-surgery snap
       already forces the one layout that is needed. */
    const winProf = new Map<number, SysProfile>();
    for (let li = r.wLo; li <= r.wHi; li++) {
      const sys = systems[(r.leader ? 1 : 0) + (li - r.wLo)];
      const p = systemProfile(sys);
      if (!p) return skip('window profile unreadable');
      winProf.set(li, p);
    }

    /* The live neighbours of the replaced set. Since Phase 3 they are NOT
       compared against anything — the window no longer renders their lines —
       but the surgery still needs them as DOM structure: they say which page a
       target line belongs to, they anchor a non-page-first first line, and
       they are the drift detectors below. Either may legitimately be absent
       (line 0 has no predecessor, the last line no successor, and a clipped
       edge's neighbour sits on a deferred page); every use below handles null.

       Nothing here verifies them. The replaced lines' appearance is
       unknowable live by definition (Max, 2026-09-01) and is verified against a
       fresh full render by the reference gate under HKL_INDEX_CHECK — which
       since Phase 3 also censuses every measure's rendered glyph CLASSES and
       the segments a system draws outside its measures, so an equal-width
       content loss (a dropped slur, a missing articulation) is caught there
       rather than being inferred from a neighbour's incidental drift. */
    const ctxPrev: LiveSys | null = r.a > 0
      ? this.liveSystem(ctx.container, newStartIds[r.a - 1]) : null;
    const ctxNext: LiveSys | null = r.bNew + 1 < M
      ? this.liveSystem(ctx.container, newStartIds[r.bNew + 1]) : null;

    /* ── target pages (B2) ──
       Where each new line goes, under the NEW pagination. A page that keeps a
       line outside the hunk is found through that line (the context line on
       it, which is mounted and checked). A page made entirely of hunk lines
       is the page its first line's measure sits on right now (the same page
       under a new start id, or a collapsed predecessor's successor). Pages
       are never created here: a spill past the last page is the cascade's
       (Renderer.repairPagination, Phase 2). */
    const targetEl = new Map<number, HTMLElement>();   // new page → element
    const firstLineOfPage = new Map<number, number>();
    for (let li = r.a; li <= r.bNew; li++) {
      const p = pageOfNew(li);
      if (!firstLineOfPage.has(p)) firstLineOfPage.set(p, li);
    }
    for (const [p, f] of firstLineOfPage) {
      let el: HTMLElement;
      if (r.a > 0 && ctxPrev && pageOfNew(r.a - 1) === p) el = ctxPrev.pageEl;
      else if (ctxNext && r.bNew + 1 < M && pageOfNew(r.bNew + 1) === p) el = ctxNext.pageEl;
      else {
        const m = ctx.container.querySelector('#' + CSS.escape(newStartIds[f]));
        const pg = m?.closest('.score-page') as HTMLElement | null;
        if (!pg || pg.classList.contains('score-page-pending')) return skip('target page not mounted');
        el = pg;
      }
      targetEl.set(p, el);
    }

    /* Section titles across the hunk. A title is a page-margin element the
       mount pass drew beside its system; WHERE it sits is the placement pass's
       business (the header band is a component of the page's budget,
       render/pagefit.ts), so nothing here computes a y. What the splice must
       keep right is which page each title is on: one whose line moves to
       another page MIGRATES with its system, and one whose measure the edit
       deleted is removed (Phase 2: a header is a component of the model —
       deleting its measure removes the component, there is no title to
       strand). */
    const hunkLineOfMeasure = (id: string): number | null => {
      const mi = idIdx.get(id);
      if (mi == null) return null;
      for (let li = r.a; li <= r.bNew; li++) if (mi >= spans[li][0] && mi < spans[li][1]) return li;
      return -1;   // exists, outside the hunk
    };
    const involved = new Set<HTMLElement>();
    for (const l of live) involved.add(l.pageEl);
    for (const e of targetEl.values()) involved.add(e);
    const hunkTitles: Array<{ el: Element; li: number; from: HTMLElement }> = [];
    for (const pageEl of involved) {
      for (const t of this.headersFor(pageEl).titles) {
        const id = t.el.getAttribute('data-for') ?? '';
        const li = hunkLineOfMeasure(id);
        if (li === null) { t.el.remove(); continue; }
        if (li < 0) continue;
        hunkTitles.push({ el: t.el, li, from: pageEl });
      }
    }

    /* Targets: page and page-firstness (the insertion anchor needs it). A
       non-page-first first line follows the context line above on its page. */
    const targets: Target[] = [];
    for (let li = r.a; li <= r.bNew; li++) {
      const p = pageOfNew(li);
      const pageFirst = isPageFirst(li);
      if (!pageFirst && li === r.a && (!ctxPrev || ctxPrev.pageEl !== targetEl.get(p))) return skip('DOM partition drift above');   // needs the live line above
      targets.push({ el: targetEl.get(p)!, pageNo: p, pageFirst });
    }
    const lastT = targets[targets.length - 1];
    /* Unreplaced systems below the hunk on its last page exist only when the
       next line is not a page start; that line must then be the live
       neighbour on that page (drift detector). The placement pass moves them. */
    const hasFollowers = r.bNew + 1 < M && !isPageFirst(r.bNew + 1);
    if (hasFollowers && (!ctxNext || ctxNext.pageEl !== lastT.el)) return skip('DOM partition drift below');
    /* When a context line sits on the same page as the hunk's edge system, it
       must be the actual DOM neighbour (mirrors the intra-hunk consecutive check). */
    if (ctxPrev && ctxPrev.pageEl === live[0].pageEl && nextSystemSibling(ctxPrev.el) !== live[0].el) return skip('DOM partition drift above');
    const lb = live[live.length - 1];
    if (ctxNext && ctxNext.pageEl === lb.pageEl && nextSystemSibling(lb.el) !== ctxNext.el) return skip('DOM partition drift below');

    /* Horizontal frame offset between window and live coordinates. Read on
       the hunk's OWN first line (Phase 3): the outgoing live system and its
       incoming window replacement, whose x0 is the left edge of the staff
       lines — set by the page frame and the margins, not by content, so the
       two agree up to exactly the offset being measured. This used to read a
       context line, which the window no longer renders. The window and the
       page share margins, so it is ~0; it is measured rather than assumed. */
    const dxFrame = live[0].x0 - winProf.get(r.a)!.x0;
    this.lastVertical = null;

    /* ── surgery ── */
    /* Insertion anchor per target page: the first old hunk system on it (the
       new systems take its place), else the page's first system (a moved block
       lands at the head), else none (a created page — append). */
    const liveOnPage = (pageEl: HTMLElement): LiveSys[] => live.filter((l) => l.pageEl === pageEl);
    const anchorOf = new Map<HTMLElement, Element | null>();
    for (const t of targets) {
      if (anchorOf.has(t.el)) continue;
      const oldOn = liveOnPage(t.el);
      anchorOf.set(t.el, oldOn.length ? oldOn[0].el : firstSystemOf(t.el));
    }
    const pages = new Set<HTMLElement>();
    const importedByPage = new Map<HTMLElement, SVGGElement[]>();
    for (let k = r.a; k <= r.bNew; k++) {
      const t = targets[k - r.a];
      const wk = winProf.get(k)!;
      const pageEl = t.el;
      const doc = pageEl.ownerDocument;
      const imported = doc.importNode(wk.el, true) as SVGGElement;
      /* Horizontal frame only. The vertical position is the placement pass's
         (below): it measures the imported system where it sits and places every
         system on the page from Composer's rule. */
      imported.setAttribute('transform', `translate(${dxFrame},0)`);
      const defs = pageEl.querySelector('svg defs');
      if (!defs) return skip('page defs missing');
      mergeGlyphDefs(defs, hostOf.get(wk.el as SVGGElement) ?? hosts[0], [imported]);
      const margin = pageEl.querySelector('svg g.page-margin');
      if (!margin) return skip('page margin missing');
      const anchor = anchorOf.get(pageEl) ?? null;
      if (anchor) anchor.parentElement!.insertBefore(imported, anchor);
      else margin.appendChild(imported);
      pages.add(pageEl);
      (importedByPage.get(pageEl) ?? importedByPage.set(pageEl, []).get(pageEl)!).push(imported);
      for (const tt of hunkTitles) {
        if (tt.li !== k) continue;
        if (tt.from !== pageEl) {
          /* Migrate: the title travels to its system's new page; that page's
             placement puts it in its band. */
          margin.appendChild(tt.el);
          pages.add(tt.from);
        }
      }
    }
    /* Remove the old hunk systems; a page left without systems is reported for
       the renderer to remove. */
    const emptied: HTMLElement[] = [];
    for (const l of live) {
      l.el.remove();
      pages.add(l.pageEl);
    }
    for (const l of live) {
      if (!l.pageEl.querySelector('g.system') && !emptied.includes(l.pageEl)) emptied.push(l.pageEl);
    }
    /* Post-process the IMPORTED systems in place (A11): the same per-system
       passes a mounted page gets (crisp barline / right-edge snaps, notehead
       z-order, HEJI, theme), scoped to them, in the live page's own device
       frame. */
    for (const [pageEl, imported] of importedByPage) {
      ctx.postProcess(pageEl, imported);
      ctx.decorateHost(pageEl);
    }
    /* PLACE every touched page (Phase 1): each system's staff top and each
       header band from Composer's rule over extents measured now — the
       imported systems in their new frame, the survivors unchanged, so a
       follower or a page that lost a system moves exactly by what the
       arithmetic says and nothing else. Then the snap. The geometry reads share
       the one layout flush this surgery causes. */
    for (const pageEl of pages) {
      if (emptied.includes(pageEl)) continue;
      ctx.placePage(pageEl);
    }
    this.lastPageEls = Array.from(pages);
    this.lastEmptiedPages = emptied;
    this.lastPages = this.lastPageEls.map((el) => Number(el.dataset.page)).filter((n) => n >= 1);
    return true;
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
       (`cb-hdrdet.js` — pages 1-5 render at y 371/195/194/194/197 on the first
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
       sonata (`cb-exact.js`, 338 pairs), and 317 of 338 pairs are exact
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
    for (const pageEl of pageEls) {
      if (!pageEl.isConnected) continue;   // an emptied page the renderer removed
      const pno = Number(pageEl.dataset.page);
      if (!(pno >= 1) || pno > tk.getPageCount()) {
        throw new Error(`[page-splice] reference lost page ${pageEl.dataset.page}`);
      }
      const refHost = document.createElement('div');
      refHost.style.cssText = 'position:absolute;left:-99999px;top:0';
      refHost.innerHTML = tk.renderToSVG(pno, {});
      document.body.appendChild(refHost);
      /* Same post-processing the live pages and the window hosts get: the HEJI
         pass replaces key-signature `use` glyphs with injected <text>, so a raw
         reference would compare its E260 flats against a live page that has
         none — a false divergence, not a wrong render (seen on the sonata's
         line 0 the day the glyph check landed). Geometry is unaffected. */
      ctx.postProcess(refHost);
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
              throw new Error(`[page-splice] page ${pno} system ${i} measure ${rpm[j].id}: x/width diverged from reference`);
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

function firstSystemOf(pageEl: HTMLElement): Element | null {
  const margin = pageEl.querySelector('svg g.page-margin');
  if (!margin) return null;
  for (const c of Array.from(margin.children)) if (c.classList.contains('system')) return c;
  return null;
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
 *  version walked straight past (`cb-ctxdiverge.js`):
 *  - the scoreDef may sit BEHIND a break element — the importer and
 *    `setSectionHeaderAt` emit `scoreDef > sb[section] > measure`, so the
 *    measure's immediate previous sibling is the `<sb>`, not the scoreDef
 *    (dW 347 and 604 at the II→III and III→IV boundaries);
 *  - a leading clef on staff 2 is a courtesy clef on staff 2 (dW 49 — a
 *    piano right hand going G→F at a line start). */
function beginsSignatureChange(meas: Element | undefined): boolean {
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

function nextSystemSibling(el: Element): Element | null {
  let n = el.nextElementSibling;
  while (n && !n.classList.contains('system')) n = n.nextElementSibling;
  return n;
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
function buildWindowMei(
  model: ComposerModel, mLo: number, mHi: number, winStarts: string[],
  leader: boolean, trailer: boolean, stubId: string | null, pbIds: Set<string>,
): string | null {
  const heji = { hejiEnabled: model.getHejiEnabled() };
  const range = model.serializeRangeForRender(mLo, mHi, heji, null);
  /* The courtesy stub is a real document measure (the last of the range), so
     the serialized range already carries it and any scoreDef / section break
     before it; it only needs its own line pin. */
  const lineStarts = stubId ? winStarts.concat(stubId) : winStarts;
  if (!leader && !trailer) return injectPins(range, lineStarts, pbIds);
  const doc = new DOMParser().parseFromString(range, 'application/xml');
  if (doc.querySelector('parsererror')) return null;
  const section = doc.querySelector('section');
  if (!section) return null;
  const nStaves = doc.querySelectorAll('scoreDef staffDef').length || 1;
  const synthMeasure = (id: string): Element => {
    const meas = doc.createElementNS(MEI_NS, 'measure');
    meas.setAttribute('xml:id', id);
    meas.setAttribute('n', '0');
    for (let s = 1; s <= nStaves; s++) {
      const st = doc.createElementNS(MEI_NS, 'staff');
      st.setAttribute('n', String(s));
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
