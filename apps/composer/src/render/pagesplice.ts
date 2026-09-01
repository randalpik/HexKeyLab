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
//     nothing outside the replaced systems would move (v1). dy-cascades and
//     page-boundary moves fall back to a full render (Phase C-B2, with
//     pagination ownership).
//   - The score-start line (line 0) and section-boundary zones render with
//     small divergences in windows (probe k=0: ~1px; k=59: large — the
//     mid-piece scoreDef / section-header zone). Line 0 is excluded outright;
//     divergent zones are caught structurally by the context-line sanity
//     check (an unchanged neighbour line must reproduce its live geometry
//     exactly) and fall back to a full render.
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
import { injectPins, type RefillResult } from './linebreaks.js';

const MEI_NS = 'http://www.music-encoding.org/ns/mei';
const LEAD_ID = 'hkl-splice-lead';
const TRAIL_ID = 'hkl-splice-trail';

/** Geometry tolerance, SVG user units (definition scale — ~10 units/px at
 *  zoom 100). Clean windows measure delta 0.0; the tolerance only absorbs
 *  snap noise (staff/barline snapping is ≤½ device px per pass, applied at
 *  different screen phases on live vs host). Real layout movement is ≥ a
 *  staff-space (~90 units). */
const EPS = 25;
/** Most lines an edit may replace before falling back. A single-note edit can
 *  legitimately touch several lines when a slur/hairpin chain closes the run
 *  over them (sonata measure 250), and every replaced line is still proven by
 *  the context + vertical gates — so the cap is set by window COST, not by
 *  caution. Windows carry L ± 1 context line. */
const MAX_SPLICE_LINES = 5;
/** Backstops, not working limits. Since the spanner expansion became a single
 *  containment pass (2026-08-31) the measured maxima over the whole sonata are
 *  2 replaced / 6 window lines for a real one-note edit, and 3 / 7 for the
 *  worst-case seed — so neither cap binds on this document any more. They stay
 *  as a guard against pathological input (a genuinely document-long spanner),
 *  which is the case truncation would eventually be for. */
const MAX_WINDOW_LINES = 9;
const MAX_WINDOW_MEASURES = 80;

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
   *  theme) — run on the offscreen host BEFORE importing, like the scroll
   *  splicer does. */
  postProcess: (el: HTMLElement) => void;
  /** Non-geometry page decorations that live in main.ts for mounted pages
   *  (volta number styling) — idempotent, content-level. */
  decorateHost: (el: HTMLElement) => void;
  /** Renderer.snapSystems — re-land staff lines on the device-pixel grid for
   *  an affected page after the surgery (idempotent). */
  snapPage: (pageEl: HTMLElement) => void;
  /** Mount a lazily-virtualized page so its systems can be measured and
   *  spliced (B5). Returns false when mounting would be expensive or would
   *  draw POST-edit content — the splice then refuses, as it always did. */
  ensurePageMounted: (page: number) => boolean;
}

interface SysProfile {
  el: SVGGElement;
  /** First-measure bbox.x + the system's own translate.x. */
  x0: number;
  /** Top staff line y (first measure, first staff) + staff & system ty. */
  staffTop: number;
  /** System bbox extents + system ty (children transforms are included by
   *  getBBox already). */
  bboxTop: number;
  bboxBot: number;
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
  titles: Array<{ el: Element; sysIdx: number }>;
  /** False when a title carries no readable `data-reserve` — the page's
   *  geometry is then unexplained and must not be reasoned about. */
  known: boolean;
}

function pageHeaders(pageEl: HTMLElement): PageHeaders {
  const margin = pageEl.querySelector('svg g.page-margin');
  const systems = margin
    ? Array.from(margin.children).filter((c) => c.classList.contains('system'))
    : [];
  const reserve = new Array<number>(systems.length).fill(0);
  const titles: Array<{ el: Element; sysIdx: number }> = [];
  let known = true;
  for (const t of Array.from(pageEl.querySelectorAll('text.hkl-section-header'))) {
    const id = t.getAttribute('data-for');
    const meas = id ? pageEl.querySelector('#' + CSS.escape(id)) : null;
    const sys = meas?.closest('g.system') ?? null;
    const idx = sys ? systems.indexOf(sys) : -1;
    const r = Number(t.getAttribute('data-reserve'));
    if (idx < 0 || !isFinite(r)) { known = false; continue; }
    titles.push({ el: t, sysIdx: idx });
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
  /** Bottom extent of the last replaced system after the plan (page-absolute,
   *  same units as newTop) — the page-fit input. */
  newBottom: number;
  /** Its live bottom extent, for comparison. */
  liveBottom: number;
  /** True when nothing moves at all (the Phase C-B v1 case). */
  static: boolean;
}

function consolidate(el: SVGGElement): { tx: number; ty: number } {
  const base = el.transform?.baseVal?.consolidate?.();
  return base ? { tx: base.matrix.e, ty: base.matrix.f } : { tx: 0, ty: 0 };
}

/** Geometry profile of one rendered system (live page or offscreen host). */
function systemProfile(sysEl: SVGGElement): SysProfile | null {
  const t = consolidate(sysEl);
  const measures = Array.from(sysEl.querySelectorAll('g.measure')) as SVGGraphicsElement[];
  if (!measures.length) return null;
  let m0box: DOMRect;
  try { m0box = measures[0].getBBox(); } catch { return null; }
  const firstStaff = measures[0].querySelector(':scope > g.staff') as SVGGElement | null;
  if (!firstStaff) return null;
  const staffT = consolidate(firstStaff);
  /* Top staff line = min over the staff's five direct-child <path>s.
     DELIBERATELY not shortened to "the first path is the topmost" (A6, tried
     and reverted 2026-08-31): that assumption removed 30 of 199 getBBox calls
     per splice and changed the measured time by NOTHING — this cost is bound by
     layout FLUSHES, not by call count (see the A6 note in the design doc). An
     unverifiable assumption about Verovio's emission order, whose failure mode
     is silently mis-positioned spliced systems, is not worth zero milliseconds. */
  let topLine = Infinity;
  for (const p of Array.from(firstStaff.querySelectorAll(':scope > path'))) {
    try {
      const b = (p as SVGGraphicsElement).getBBox();
      if (b.y < topLine) topLine = b.y;
    } catch { /* skip */ }
  }
  if (!isFinite(topLine)) return null;
  let sysBox: DOMRect;
  try { sysBox = sysEl.getBBox(); } catch { return null; }
  return {
    el: sysEl,
    x0: m0box.x + t.tx,
    staffTop: topLine + staffT.ty + t.ty,
    bboxTop: sysBox.y + t.ty,
    bboxBot: sysBox.y + sysBox.height + t.ty,
    measures: (() => {
      let memo: Array<{ id: string; relX: number; w: number }> | null = null;
      return () => (memo ??= measures.map((m) => {
        const b = m.getBBox();
        return { id: m.id, relX: b.x - m0box.x, w: b.width };
      }));
    })(),
  };
}

export class PageSystemSplicer {
  /** Diagnostics for tests/probes. */
  lastOutcome: 'spliced' | 'skipped' | 'noop' | '' = '';
  lastSkipReason = '';
  /** Page numbers the last splice edited in place. The renderer marks exactly
   *  these as stale: every other page still matches the loaded layout, so it
   *  can be mounted without re-loading the document. */
  lastPages: number[] = [];
  lastStats = { lines: 0, windowLines: 0, windowMeasures: 0, loadMs: 0, totalMs: 0 };
  /** The vertical plan the last gate computed (null when it never got that
   *  far). Diagnostics for the probes; the splice itself consumes it inline. */
  lastVertical: VerticalPlan | null = null;
  /** Line range the last attempt needed to REPLACE (diagnostics: a refusal
   *  names a reason, but not which lines it wanted — `cb-sweep.js` needs that
   *  to tell a not-mounted line from a not-mounted spanner-expanded run). */
  lastRun: { a: number; b: number } | null = null;
  /** Per-splice memo of each mounted page's section-header state. */
  private headerCache = new Map<HTMLElement, PageHeaders>();

  /** The caller resolved a signature-identical doc — the mounted DOM already
   *  renders it; nothing to do. Recorded for diagnostics only. */
  noteNoop(): void {
    this.lastOutcome = 'noop';
    this.lastSkipReason = '';
  }

  /** Attempt to land the refilled edit as a system splice. Returns true when
   *  the DOM was updated (the caller must NOT full-render); false when any
   *  gate refused (lastSkipReason says why — the caller full-renders). */
  trySplice(model: ComposerModel, refill: RefillResult, ctx: PageSpliceCtx): boolean {
    const t0 = performance.now();
    this.lastStats = { lines: 0, windowLines: 0, windowMeasures: 0, loadMs: 0, totalMs: 0 };
    this.lastPages = [];
    this.lastVertical = null;
    this.lastRun = null;
    this.headerCache.clear();
    const skip = (why: string): false => {
      this.lastOutcome = 'skipped';
      this.lastSkipReason = why;
      this.lastStats.totalMs = Math.round(performance.now() - t0);
      return false;
    };
    const { changedRun, oldStartIds, newStartIds } = refill;
    if (!changedRun) return skip('no changed run');
    if (newStartIds.length !== oldStartIds.length) return skip('line count changed');

    const meiMeasures = model.allMeasures();
    const ids = meiMeasures.map((m) => m.getAttribute('xml:id') ?? '');
    const idIdx = new Map(ids.map((id, i) => [id, i]));
    const nLines = newStartIds.length;
    const spans: Array<[number, number]> = [];
    for (let li = 0; li < nLines; li++) {
      const a0 = idIdx.get(newStartIds[li]);
      if (a0 == null) return skip('partition id missing from doc');
      spans.push([a0, li + 1 < nLines ? (idIdx.get(newStartIds[li + 1]) ?? ids.length) : ids.length]);
    }
    const lineOf = (mi: number): number => {
      let lo = 0, hi = nLines - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (spans[mid][0] <= mi) lo = mid; else hi = mid - 1; }
      return lo;
    };

    /* The replaced-line set L: the sig-diff run closed over spanners/endings
       (a spanner overlapping the run renders segments in every line it
       touches — all of them must be replaced together, exactly like the
       scroll splicer's run expansion), plus both lines adjacent to any moved
       boundary. */
    const docVer = model.docVersion();
    let [rLo, rHi] = expandForSpannersOnce(meiMeasures, changedRun.lo, Math.min(changedRun.hi, ids.length - 1), docVer);
    [rLo, rHi] = expandForEndings(meiMeasures, rLo, rHi);
    let a = lineOf(rLo), b = lineOf(rHi);
    for (let i = 0; i < nLines; i++) {
      if (oldStartIds[i] !== newStartIds[i]) {
        a = Math.min(a, Math.max(0, i - 1));
        b = Math.max(b, i);
      }
    }
    this.lastRun = { a, b };
    if (b - a + 1 > MAX_SPLICE_LINES) return skip('too many changed lines');
    /* Line 0 is the score start — window fidelity is unproven there (probe
       k=0 drifts ~1px: header/title treatment differs under a windowed
       render). Edits touching it always full-render. */
    if (a === 0) return skip('score-start line');

    /* Section-header measures: their title text + the reserve translate are
       page-mount injections (NOT idempotent) — never splice them. */
    for (let i = spans[a][0]; i < spans[b][1] && i < ids.length; i++) {
      if (meiMeasures[i].hasAttribute('data-hkl-section-title')) return skip('section-header line');
    }

    /* B5 — ensure-mount before the mounted gate. Page view mounts pages
       lazily, so in real use only a handful are live (2-6 on the sonata) and a
       line the splice needs is often still a placeholder. That used to refuse
       outright, which made mount misses the single biggest refusal class once
       the coverage sweep stopped pre-mounting everything (19 of 39). Mounting
       from the already-loaded pre-edit layout costs ~50 ms against the ~1.2 s
       full render it avoids.

       The page a line sits on comes from the PARTITION, not the DOM — the
       measure of an unmounted line has no element to look up. Pagination is
       pinned and unchanged here (`paginationHeld` is checked by the caller),
       so page starts describe the mounted DOM too. */
    const pageStartLines: number[] = [];
    {
      const at = new Map(newStartIds.map((id, i) => [id, i]));
      for (const id of refill.newPageStartIds) {
        const li = at.get(id);
        if (li !== undefined) pageStartLines.push(li);
      }
      pageStartLines.sort((x, y) => x - y);
    }
    const pageOfLine = (li: number): number => {
      let p = 1;
      for (let i = 0; i < pageStartLines.length; i++) if (pageStartLines[i] <= li) p = i + 1;
      return p;
    };
    if (pageStartLines.length) {
      /* Everything the splice will MEASURE live: the replaced lines plus the
         two context lines. The window itself renders offscreen. */
      const want = new Set<number>();
      for (let k = Math.max(0, a - 1); k <= Math.min(nLines - 1, b + 1); k++) want.add(pageOfLine(k));
      for (const p of want) ctx.ensurePageMounted(p);
    }

    /* Live systems to replace, located by the PRE-edit partition (that is
       what the mounted DOM renders). All must be mounted, first-of-system,
       and consecutive in the DOM. */
    const live: LiveSys[] = [];
    for (let k = a; k <= b; k++) {
      const ls = this.liveSystem(ctx.container, oldStartIds[k]);
      if (!ls) return skip('changed line not mounted');
      live.push(ls);
    }
    for (let k = a + 1; k <= b; k++) {
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
       through lines nobody was re-rendering. Measured over all 446 measures,
       the fixed point put 52 seeds past MAX_WINDOW_LINES; this rule puts none
       there (window max 14 → 6 lines, mean 6.33 → 4.14). See
       `cb-spanchain.js` / `cb-window-walk.js` and the design doc.
       
       Context lines still do their two jobs: they let the window's systems
       render with every entering/exiting spanner present (page spike 1,
       finding 5) and give the vertical gate its measured spacing chain. */
    let [wm0, wm1] = expandForSpannersOnce(meiMeasures, spans[a][0], spans[b][1] - 1, docVer);
    [wm0, wm1] = expandForEndings(meiMeasures, wm0, wm1);
    let wLo = Math.max(0, lineOf(wm0) - 1);
    let wHi = Math.min(nLines - 1, lineOf(wm1) + 1);
    /* A context line can bring in a partially-covered <ending>; a volta bracket
       re-engraved over a truncated member set is wrong, so contain it — once. */
    const [em0, em1] = expandForEndings(meiMeasures, spans[wLo][0], spans[wHi][1] - 1);
    wLo = lineOf(em0); wHi = lineOf(em1);
    if (wHi - wLo + 1 > MAX_WINDOW_LINES) return skip('window too many lines');
    const mLo = spans[wLo][0], mHi = spans[wHi][1] - 1;
    if (mHi - mLo + 1 > MAX_WINDOW_MEASURES) return skip('window too many measures');
    this.lastStats.windowLines = wHi - wLo + 1;
    this.lastStats.windowMeasures = mHi - mLo + 1;

    const winStarts = newStartIds.slice(wLo, wHi + 1);
    /* Page pins: every window line that begins a LIVE page becomes a <pb>, so
       the window paginates exactly like the mounted document. Without this a
       page-first system is mid-page in the window and its absolute placement
       (Verovio's page-top anchoring) is unreadable — the v1 gate had to model
       it as "content top at the margin + hanging extent", which is wrong
       whenever the system's topmost content is a <text> element (g.dir,
       g.tempo, HEJI g.accid): Verovio's own metrics for those disagree with
       the rendered bbox by up to ~85 units. See the B1 note in the design doc.
       The window's FIRST system (leader, else line wLo) already starts page 1,
       so it never takes a pin. */
    const leader = wLo > 0;
    const livePageStarts = new Set(refill.newPageStartIds);
    const pbIds = new Set<string>();
    for (let li = leader ? wLo : wLo + 1; li <= wHi; li++) {
      if (livePageStarts.has(newStartIds[li])) pbIds.add(newStartIds[li]);
    }
    /* A window ending mid-document needs a synthetic TRAILER line: the
       sub-document's last measure would otherwise draw the end-of-score FINAL
       barline (~5 px wider than the live line's normal barline — found by the
       sonata battery's context check). The pinned mRest trailer absorbs it
       and is discarded, exactly like the leader absorbs score-start artifacts. */
    const trailer = mHi < ids.length - 1;
    const winMei = buildWindowMei(model, mLo, mHi, winStarts, leader, trailer, pbIds);
    if (!winMei) return skip('window build failed');

    const tLoad = performance.now();
    ctx.toolkit.setOptions(ctx.windowOptions);
    if (!ctx.toolkit.loadData(winMei)) return skip('window loadData failed');
    const wantPages = 1 + pbIds.size;
    if (ctx.toolkit.getPageCount() !== wantPages) return skip('window paginated');
    /* One host per window page — the same shape a mounted page has, so
       postProcess/decorate and mergeGlyphDefs (which reads ONE <defs>) behave
       exactly as they do on the live path. */
    const hosts: HTMLElement[] = [];
    for (let pno = 1; pno <= wantPages; pno++) {
      const h = document.createElement('div');
      h.style.cssText = 'position:absolute;left:-99999px;top:0';
      h.innerHTML = ctx.toolkit.renderToSVG(pno, {});
      document.body.appendChild(h);
      hosts.push(h);
    }
    this.lastStats.loadMs = Math.round(performance.now() - tLoad);
    try {
      for (const h of hosts) { ctx.postProcess(h); ctx.decorateHost(h); }
      const ok = this.spliceDom(hosts, { a, b, wLo, wHi, winStarts, leader, trailer }, live, newStartIds, ctx, skip);
      if (ok) {
        this.lastOutcome = 'spliced';
        this.lastSkipReason = '';
        this.lastStats.lines = b - a + 1;
        this.lastStats.totalMs = Math.round(performance.now() - t0);
        if (indexCheckEnabled()) this.verifyAgainstReference(refill, live, ctx);
      }
      return ok;
    } finally {
      for (const h of hosts) h.remove();
    }
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
    hosts: HTMLElement[],
    r: { a: number; b: number; wLo: number; wHi: number; winStarts: string[]; leader: boolean; trailer: boolean },
    live: LiveSys[],
    newStartIds: string[],
    ctx: PageSpliceCtx,
    skip: (why: string) => false,
  ): boolean {
    /* Window systems in document order across the window's pages, each tagged
       with the host page it came from (mergeGlyphDefs reads that page's defs)
       and whether it STARTS that page (the anchor the vertical plan reads). */
    const systems: SVGGElement[] = [];
    const hostOf = new Map<SVGGElement, HTMLElement>();
    const winPageFirst = new Set<SVGGElement>();
    for (const h of hosts) {
      const onPage = Array.from(h.querySelectorAll('g.system')) as SVGGElement[];
      onPage.forEach((sys, i) => { hostOf.set(sys, h); if (i === 0) winPageFirst.add(sys); });
      systems.push(...onPage);
    }
    const expected = (r.leader ? [LEAD_ID] : []).concat(r.winStarts, r.trailer ? [TRAIL_ID] : []);
    if (systems.length !== expected.length) return skip('window system count mismatch');
    for (let i = 0; i < systems.length; i++) {
      if (systems[i].querySelector('g.measure')?.id !== expected[i]) return skip('window partition mismatch');
    }
    const winProf = new Map<number, SysProfile>();
    const winIsPageFirst = new Set<number>();
    for (let li = r.wLo; li <= r.wHi; li++) {
      const sys = systems[(r.leader ? 1 : 0) + (li - r.wLo)];
      const p = systemProfile(sys);
      if (!p) return skip('window profile unreadable');
      winProf.set(li, p);
      if (winPageFirst.has(sys)) winIsPageFirst.add(li);
    }

    /* Context-line sanity: the unchanged neighbour lines must reproduce their
       live geometry (per-measure x/width). This is the structural detector
       for zones where windowed renders diverge (probe k=59: the mid-piece
       scoreDef / section-boundary zone) — any drift there means the window
       cannot be trusted for the changed lines either. The previous line
       always exists (a ≥ 1); the next only when b isn't the last line. */
    const ctxPrev = this.liveSystem(ctx.container, newStartIds[r.a - 1]);
    if (!ctxPrev) return skip('context line above not mounted');
    const dAbove = profilesMatch(winProf.get(r.a - 1)!, ctxPrev);
    if (dAbove) return skip('context line above diverged (' + dAbove + ')');
    let ctxNext: LiveSys | null = null;
    if (r.b + 1 < newStartIds.length) {
      ctxNext = this.liveSystem(ctx.container, newStartIds[r.b + 1]);
      if (!ctxNext) return skip('context line below not mounted');
      const dBelow = profilesMatch(winProf.get(r.b + 1)!, ctxNext);
      if (dBelow) return skip('context line below diverged (' + dBelow + ')');
    }

    /* Vertical PLAN: where a full re-engrave would put each replaced system,
       and by how much the systems below it on its page would move. Verovio
       stacks systems by content clearance (probe 1) and the window reproduces
       that chain exactly (probe 2: delta 0.0), so the plan is MEASURED, never
       emulated. v1 splices only when the plan is static (nothing moves); B1
       applies a non-static plan instead of refusing. */
    /* A live page-first system is placed from its window counterpart's
       ABSOLUTE position, which is only comparable when the window paginates
       there too. Section-header reserves no longer disqualify a page — they are
       subtracted explicitly (see verticalPlan) — but an UNREADABLE reserve
       leaves the page's geometry unexplained, and guessing is what caused the
       overlap this replaced. */
    for (const l of [ctxPrev, ...live, ...(ctxNext ? [ctxNext] : [])]) {
      if (!this.headersFor(l.pageEl).known) return skip('section-header reserve unreadable');
    }
    for (let k = r.a; k <= r.b; k++) {
      const lk = live[k - r.a];
      if (!lk.pageFirst) continue;
      if (!winIsPageFirst.has(k)) return skip('window page boundary missing');
    }
    const plan = verticalPlan(r, live, winProf, ctxPrev, ctxNext);
    this.lastVertical = plan;
    const lb = live[r.b - r.a];
    /* When the line above/below sits on the same page, it must be the actual
       DOM neighbour (drift detector, mirrors the intra-L consecutive check). */
    if (!live[0].pageFirst && nextSystemSibling(ctxPrev.el) !== live[0].el) return skip('DOM partition drift above');
    if (ctxNext && !lb.pageLast && nextSystemSibling(lb.el) !== ctxNext.el) return skip('DOM partition drift below');

    /* ── surgery ── */
    /* dy-cascade (B1): every system BELOW the last replaced one on its page
       shifts by the same measured amount — their spacing to each other is
       content-driven and unchanged, so one dy describes all of them. The next
       PAGE is unaffected: its first system is anchored at that page's top and
       pagination is pinned (paginationHeld), so a full render agrees.
       Collected BEFORE the surgery: it removes lb.el from the DOM, and a
       detached node has no siblings to walk. */
    const followers: Element[] = [];
    /* Section titles sit at an ABSOLUTE y beside the systems (main.ts appends
       them to the page-margin, not to a system), so a cascade that moves a
       header's system must move its title by the same dy or the music slides
       over the words. */
    const movedTitles: Element[] = [];
    if (!plan.static && Math.abs(plan.dyFollow) > EPS) {
      for (let n = nextSystemSibling(lb.el); n; n = nextSystemSibling(n)) followers.push(n);
      for (const t of this.headersFor(lb.pageEl).titles) {
        if (t.sysIdx > lb.sysIdx) movedTitles.push(t.el);
      }
    }
    const pages = new Set<HTMLElement>();
    for (let k = r.a; k <= r.b; k++) {
      const lk = live[k - r.a];
      const wk = winProf.get(k)!;
      const doc = lk.el.ownerDocument;
      const imported = doc.importNode(wk.el, true) as SVGGElement;
      /* Place the new system's staff top exactly at the old one's (the gate
         proved a full render would keep it there) and its first measure at
         the old x. Live values already include the old transform, so this
         composes with section-header reserves and snap adjustments. */
      const dx = lk.x0 - wk.x0;
      /* All-or-nothing: a STATIC plan pins each system to its live staff top
         exactly as Phase C-B v1 did. The plan is measured to ~±8 units, so
         "applying" a 3-unit movement would ADD error rather than remove it,
         and would re-snap every system on the page for a sub-pixel edit.
         Only a plan that moves something by more than EPS is applied. */
      const dy = (plan.static ? lk.staffTop : plan.newTop[k - r.a]) - wk.staffTop;
      imported.setAttribute('transform', `translate(${dx},${dy})`);
      const defs = lk.pageEl.querySelector('svg defs');
      if (!defs) return skip('page defs missing');
      mergeGlyphDefs(defs, hostOf.get(wk.el as SVGGElement) ?? hosts[0], [imported]);
      lk.el.parentElement!.insertBefore(imported, lk.el);
      lk.el.remove();
      pages.add(lk.pageEl);
    }
    for (const n of followers) {
      const t = consolidate(n as SVGGElement);
      n.setAttribute('transform', `translate(${t.tx},${t.ty + plan.dyFollow})`);
    }
    for (const t of movedTitles) {
      t.setAttribute('y', String(Number(t.getAttribute('y') ?? 0) + plan.dyFollow));
    }
    if (followers.length) pages.add(lb.pageEl);
    for (const pageEl of pages) ctx.snapPage(pageEl);
    this.lastPages = Array.from(pages, (el) => Number(el.dataset.page)).filter((n) => n >= 1);
    return true;
  }

  /** HKL_INDEX_CHECK deep gate (the design doc's parity harness, inline):
   *  full-render the same pinned MEI offscreen and assert every affected
   *  page's system sequence + geometry matches the spliced DOM. Throws. */
  private verifyAgainstReference(refill: RefillResult, live: LiveSys[], ctx: PageSpliceCtx): void {
    const mei = refill.mei();
    if (mei === null) throw new Error('[page-splice] reference MEI unavailable (pin injection failed)');
    const tk = ctx.toolkit;
    tk.setOptions(ctx.liveOptions());
    if (!tk.loadData(mei)) throw new Error('[page-splice] reference loadData failed');
    const TOL = 30;   // snap noise: live pages are grid-snapped, reference is raw
    const pages = new Set<HTMLElement>();
    for (const l of live) pages.add(l.pageEl);
    for (const pageEl of pages) {
      const pno = Number(pageEl.dataset.page);
      if (!(pno >= 1) || pno > tk.getPageCount()) {
        throw new Error(`[page-splice] reference lost page ${pageEl.dataset.page}`);
      }
      const refHost = document.createElement('div');
      refHost.style.cssText = 'position:absolute;left:-99999px;top:0';
      refHost.innerHTML = tk.renderToSVG(pno, {});
      document.body.appendChild(refHost);
      try {
        const refSys = Array.from(refHost.querySelectorAll('g.system')) as SVGGElement[];
        const liveSys = Array.from(pageEl.querySelectorAll('g.system')) as SVGGElement[];
        if (refSys.length !== liveSys.length) {
          throw new Error(`[page-splice] page ${pno}: spliced ${liveSys.length} systems, reference ${refSys.length}`);
        }
        /* Section-header injections translate the live page's systems by the
           reserve (main.ts, not Verovio). That used to EXEMPT such pages from
           the vertical check — which is exactly how a cascade that stranded a
           section title got past this gate. The reserve is now subtracted, so
           header pages are verified like any other; only an unreadable reserve
           is exempt. */
        const hdr = pageHeaders(pageEl);
        const headerPage = !hdr.known;
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
          if (!headerPage) {
            /* ABSOLUTE tops, not just consecutive spacing: a dy-cascade that
               shifted a whole page by a constant would satisfy every spacing
               check and still be wrong (B1). Both sides are page-margin
               relative once the live side's header reserve is removed. */
            const liveV = lp.staffTop - (hdr.reserve[i] ?? 0);
            if (Math.abs(rp.staffTop - liveV) > TOL) {
              throw new Error(`[page-splice] page ${pno} system ${i}: staff top diverged from reference (${rp.staffTop.toFixed(1)} vs ${liveV.toFixed(1)}, reserve ${(hdr.reserve[i] ?? 0).toFixed(1)})`);
            }
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

/** Compute the vertical plan (see VerticalPlan). Pure measurement:
 *  - a page-FIRST system takes its window counterpart's absolute staff-top.
 *    The window paginates at the same boundary (a <pb> pin), so Verovio has
 *    already applied its own page-top anchoring there, and both coordinate
 *    systems are page-margin-relative with identical margins. This replaces
 *    the v1 model ("content top at the margin + hang"), which mis-predicts by
 *    up to ~85 units whenever the topmost content is a <text> element —
 *    Verovio's internal metrics for text disagree with the rendered bbox;
 *  - any other system sits at the previous system's staff-top plus the
 *    window's own consecutive-system spacing;
 *  - the chain therefore RESETS at every page boundary inside the replaced
 *    run, which is what keeps a dy from leaking onto the next page. */
function verticalPlan(
  r: { a: number; b: number },
  live: LiveSys[],
  winProf: Map<number, SysProfile>,
  ctxPrev: LiveSys,
  ctxNext: LiveSys | null,
): VerticalPlan {
  const newTop: number[] = [];
  const liveTop: number[] = [];
  const startIds: string[] = [];
  /* The chain runs in VEROVIO coordinates. Live staff tops carry main.ts's
     section-header reserve (added at mount, invisible to Verovio and to the
     window), so it comes out before chaining and goes back on afterwards.
     Without this the pair that straddles a header boundary is wrong by the
     whole reserve — which is how an edit above a header used to cascade the
     page while the title stayed put. */
  const newV: number[] = [];
  for (let k = r.a; k <= r.b; k++) {
    const lk = live[k - r.a];
    const wk = winProf.get(k)!;
    liveTop.push(lk.staffTop);
    startIds.push(lk.el.querySelector('g.measure')?.id ?? '');
    let v: number;
    if (lk.pageFirst) {
      v = wk.staffTop;
    } else {
      const prevV = k === r.a ? ctxPrev.staffTop - ctxPrev.reserve : newV[k - r.a - 1];
      const prevWin = winProf.get(k - 1)!;
      v = prevV + (wk.staffTop - prevWin.staffTop);
    }
    newV.push(v);
    newTop.push(v + lk.reserve);
  }
  const lb = live[r.b - r.a], wb = winProf.get(r.b)!;
  const lastV = newV[newV.length - 1];
  let dyFollow = 0, followId = '';
  if (!lb.pageLast && ctxNext) {
    const wNext = winProf.get(r.b + 1)!;
    const nextV = lastV + (wNext.staffTop - wb.staffTop);
    dyFollow = (nextV + ctxNext.reserve) - ctxNext.staffTop;
    followId = ctxNext.el.querySelector('g.measure')?.id ?? '';
  }
  const isStatic = newTop.every((t, i) => Math.abs(t - liveTop[i]) <= EPS) && Math.abs(dyFollow) <= EPS;
  return {
    startIds, liveTop, newTop, dyFollow, followId,
    newBottom: newTop[newTop.length - 1] + (wb.bboxBot - wb.staffTop),
    liveBottom: lb.bboxBot,
    static: isStatic,
  };
}

function nextSystemSibling(el: Element): Element | null {
  let n = el.nextElementSibling;
  while (n && !n.classList.contains('system')) n = n.nextElementSibling;
  return n;
}

/** Per-measure x/width comparison of a window context system against its live
 *  counterpart (unchanged content — must reproduce exactly, ± snap noise).
 *  Returns '' on match, else a human-readable divergence detail. */
function profilesMatch(win: SysProfile, liveSys: SysProfile): string {
  const wm = win.measures(), lm = liveSys.measures();
  if (wm.length !== lm.length) {
    return `measure count ${wm.length} vs live ${lm.length}`;
  }
  for (let i = 0; i < wm.length; i++) {
    const w = wm[i], l = lm[i];
    if (w.id !== l.id) return `measure order ${w.id} vs live ${l.id}`;
    const dx = Math.abs(w.relX - l.relX), dw = Math.abs(w.w - l.w);
    if (dx > EPS || dw > EPS) {
      return `${w.id}: dRelX=${dx.toFixed(1)} dW=${dw.toFixed(1)}`;
    }
  }
  return '';
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
  leader: boolean, trailer: boolean, pbIds: Set<string>,
): string | null {
  const heji = { hejiEnabled: model.getHejiEnabled() };
  const range = model.serializeRangeForRender(mLo, mHi, heji, null);
  if (!leader && !trailer) return injectPins(range, winStarts, pbIds);
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
  const pinIds = (leader ? [LEAD_ID] : []).concat(winStarts, trailer ? [TRAIL_ID] : []);
  return injectPins(new XMLSerializer().serializeToString(doc), pinIds, pbIds);
}
