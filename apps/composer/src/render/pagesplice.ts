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
import { expandForSpanners, expandForEndings, mergeGlyphDefs } from './splice.js';
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
    let [rLo, rHi] = expandForSpanners(meiMeasures, changedRun.lo, Math.min(changedRun.hi, ids.length - 1), docVer);
    [rLo, rHi] = expandForEndings(meiMeasures, rLo, rHi);
    let a = lineOf(rLo), b = lineOf(rHi);
    for (let i = 0; i < nLines; i++) {
      if (oldStartIds[i] !== newStartIds[i]) {
        a = Math.min(a, Math.max(0, i - 1));
        b = Math.max(b, i);
      }
    }
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

    /* Window: L ± one context line, closed over spanners/endings to LINE
       boundaries (iterated — closure can pull in another line whose own
       spanners reach further). Context lines make the window's systems render
       with every entering/exiting spanner present (page spike 1, finding 5)
       and give the vertical gate its measured spacing chain. */
    let wLo = Math.max(0, a - 1);
    let wHi = Math.min(nLines - 1, b + 1);
    for (let guard = 0; guard < 8; guard++) {
      let lo2: number, hi2: number;
      [lo2, hi2] = expandForSpanners(meiMeasures, spans[wLo][0], spans[wHi][1] - 1, docVer);
      [lo2, hi2] = expandForEndings(meiMeasures, lo2, hi2);
      const nLo = lineOf(lo2), nHi = lineOf(hi2);
      if (nLo === wLo && nHi === wHi) break;
      wLo = nLo; wHi = nHi;
    }
    if (wHi - wLo + 1 > MAX_WINDOW_LINES) return skip('window too many lines');
    const mLo = spans[wLo][0], mHi = spans[wHi][1] - 1;
    if (mHi - mLo + 1 > MAX_WINDOW_MEASURES) return skip('window too many measures');
    this.lastStats.windowLines = wHi - wLo + 1;
    this.lastStats.windowMeasures = mHi - mLo + 1;

    const winStarts = newStartIds.slice(wLo, wHi + 1);
    /* A window ending mid-document needs a synthetic TRAILER line: the
       sub-document's last measure would otherwise draw the end-of-score FINAL
       barline (~5 px wider than the live line's normal barline — found by the
       sonata battery's context check). The pinned mRest trailer absorbs it
       and is discarded, exactly like the leader absorbs score-start artifacts. */
    const trailer = mHi < ids.length - 1;
    const winMei = buildWindowMei(model, mLo, mHi, winStarts, wLo > 0, trailer);
    if (!winMei) return skip('window build failed');

    const tLoad = performance.now();
    ctx.toolkit.setOptions(ctx.windowOptions);
    if (!ctx.toolkit.loadData(winMei)) return skip('window loadData failed');
    if (ctx.toolkit.getPageCount() !== 1) return skip('window paginated');
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-99999px;top:0';
    host.innerHTML = ctx.toolkit.renderToSVG(1, {});
    document.body.appendChild(host);
    this.lastStats.loadMs = Math.round(performance.now() - tLoad);
    try {
      ctx.postProcess(host);
      ctx.decorateHost(host);
      const ok = this.spliceDom(host, { a, b, wLo, wHi, winStarts, leader: wLo > 0, trailer }, live, newStartIds, ctx, skip);
      if (ok) {
        this.lastOutcome = 'spliced';
        this.lastSkipReason = '';
        this.lastStats.lines = b - a + 1;
        this.lastStats.totalMs = Math.round(performance.now() - t0);
        if (indexCheckEnabled()) this.verifyAgainstReference(refill, live, ctx);
      }
      return ok;
    } finally {
      host.remove();
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
    return {
      ...prof,
      pageEl,
      pageFirst: siblings[0] === sys,
      pageLast: siblings[siblings.length - 1] === sys,
    };
  }

  /** Gates that need the rendered window, then the surgery. */
  private spliceDom(
    host: HTMLElement,
    r: { a: number; b: number; wLo: number; wHi: number; winStarts: string[]; leader: boolean; trailer: boolean },
    live: LiveSys[],
    newStartIds: string[],
    ctx: PageSpliceCtx,
    skip: (why: string) => false,
  ): boolean {
    const systems = Array.from(host.querySelectorAll('g.system')) as SVGGElement[];
    const expected = (r.leader ? [LEAD_ID] : []).concat(r.winStarts, r.trailer ? [TRAIL_ID] : []);
    if (systems.length !== expected.length) return skip('window system count mismatch');
    for (let i = 0; i < systems.length; i++) {
      if (systems[i].querySelector('g.measure')?.id !== expected[i]) return skip('window partition mismatch');
    }
    const winProf = new Map<number, SysProfile>();
    for (let li = r.wLo; li <= r.wHi; li++) {
      const p = systemProfile(systems[(r.leader ? 1 : 0) + (li - r.wLo)]);
      if (!p) return skip('window profile unreadable');
      winProf.set(li, p);
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

    /* Vertical gate: nothing outside the replaced systems may move. Verovio
       stacks systems by content clearance (probe 1), so the window's own
       consecutive-system spacing IS the spacing a full render would produce
       (probe 2: delta 0.0). Splice only when that measured spacing keeps
       every replaced system exactly at its live position — and the last one
       keeps its live spacing to the line below (or, at a page bottom, its
       bottom extent, so pagination provably cannot change). */
    for (let k = r.a; k <= r.b; k++) {
      const lk = live[k - r.a];
      const wk = winProf.get(k)!;
      if (lk.pageFirst) {
        /* A page's first system anchors its CONTENT top at the margin — the
           staff lands at margin + hang. Hang must be unchanged. */
        const liveHang = lk.staffTop - lk.bboxTop;
        const winHang = wk.staffTop - wk.bboxTop;
        if (Math.abs(winHang - liveHang) > EPS) return skip('vertical: page-first hang would move');
      } else {
        const prevLive = k === r.a ? ctxPrev : live[k - r.a - 1];
        const prevWin = winProf.get(k - 1)!;
        const dWin = wk.staffTop - prevWin.staffTop;
        const dLive = lk.staffTop - prevLive.staffTop;
        if (Math.abs(dWin - dLive) > EPS) return skip('vertical: spacing above would move');
      }
    }
    const lb = live[r.b - r.a];
    const wb = winProf.get(r.b)!;
    if (lb.pageLast) {
      const liveBotRel = lb.bboxBot - lb.staffTop;
      const winBotRel = wb.bboxBot - wb.staffTop;
      if (Math.abs(winBotRel - liveBotRel) > EPS) return skip('vertical: page-last bottom extent would move');
    } else {
      const wNext = winProf.get(r.b + 1)!;
      const dWin = wNext.staffTop - wb.staffTop;
      const dLive = ctxNext!.staffTop - lb.staffTop;
      if (Math.abs(dWin - dLive) > EPS) return skip('vertical: spacing below would move');
    }
    /* When the line above/below sits on the same page, it must be the actual
       DOM neighbour (drift detector, mirrors the intra-L consecutive check). */
    if (!live[0].pageFirst && nextSystemSibling(ctxPrev.el) !== live[0].el) return skip('DOM partition drift above');
    if (ctxNext && !lb.pageLast && nextSystemSibling(lb.el) !== ctxNext.el) return skip('DOM partition drift below');

    /* ── surgery ── */
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
      const dy = lk.staffTop - wk.staffTop;
      imported.setAttribute('transform', `translate(${dx},${dy})`);
      const defs = lk.pageEl.querySelector('svg defs');
      if (!defs) return skip('page defs missing');
      mergeGlyphDefs(defs, host, [imported]);
      lk.el.parentElement!.insertBefore(imported, lk.el);
      lk.el.remove();
      pages.add(lk.pageEl);
    }
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
           reserve (main.ts, not Verovio) — vertical spacing is not comparable
           against the raw reference there; x/width and sequence still are. */
        const headerPage = pageEl.querySelector('text.hkl-section-header') !== null;
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
          if (i > 0 && !headerPage) {
            const rPrev = systemProfile(refSys[i - 1])!;
            const lPrev = systemProfile(liveSys[i - 1])!;
            const dRef = rp.staffTop - rPrev.staffTop;
            const dLive = lp.staffTop - lPrev.staffTop;
            if (Math.abs(dRef - dLive) > TOL) {
              throw new Error(`[page-splice] page ${pno} system ${i}: vertical spacing diverged from reference (${dRef.toFixed(1)} vs ${dLive.toFixed(1)})`);
            }
          }
        }
      } finally {
        refHost.remove();
      }
    }
  }
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
 *  line 0, so injectPins pins ALL real starts). */
function buildWindowMei(
  model: ComposerModel, mLo: number, mHi: number, winStarts: string[],
  leader: boolean, trailer: boolean,
): string | null {
  const heji = { hejiEnabled: model.getHejiEnabled() };
  const range = model.serializeRangeForRender(mLo, mHi, heji, null);
  if (!leader && !trailer) return injectPins(range, winStarts, null);
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
  return injectPins(new XMLSerializer().serializeToString(doc), pinIds, null);
}
