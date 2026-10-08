// Pages assembled from measured systems (composer-pagination-design.md,
// approved 2026-10-08). Composer owns pagination: which systems share a page
// is first-fit over the systems' MEASURED heights, in document order, and no
// page is ever painted from a guess.
//
//   load   render line 0 into a hidden page shell → post-process → measure →
//          fits? append : close the page (place by rule v2, reveal, inject
//          the furniture) and open the next with that system; repeat.
//          Synchronous until the page holding the cursor closes, then in idle
//          slices. The page count is whatever the fold produces.
//   mount  re-attach a parked page's shell (no render); unmount parks it.
//   edit   the splicer re-engraves its hunk into the pages the refill's
//          provisional (membership-carried) pagination names; placePage
//          records the hunk's new extents; `repaginateFrom` runs first-fit
//          from the first touched page over the store and rebuilds ONLY the
//          pages up to the first one whose start comes out where it already
//          is — a changed page never affects a page before it, and an
//          unchanged boundary means every page after it is unchanged too.
//
// Verovio is asked for one thing: a line window (render/systemrender.ts).
// The page itself is Composer's (render/pageshell.ts).

import type { ComposerModel } from '../model/index.js';
import type { PageLineBreaks } from './linebreaks.js';
import {
  ExtentsStore, measureExtents, alignStaffRows, placeSystems, foldIndex, firstFitLines,
  SECTION_HEADER_RESERVE, type PageFitConstants, type SysExtents,
} from './pagefit.js';
import { createPageShell, renumberPageHeader, type ShellGeom, type ShellMeta } from './pageshell.js';
import { renderLineSystem, styleTextOf, type LineRenderCtx } from './systemrender.js';
import { mergeGlyphDefs } from './splice.js';

/** What the assembler needs from the renderer. */
export interface AssemblyHost {
  container: HTMLElement;
  model(): ComposerModel;
  /** Every measure's xml:id, document order. */
  measureIds(): readonly string[];
  lineRenderCtx(): LineRenderCtx;
  shellGeom(): ShellGeom;
  shellMeta(): ShellMeta;
  fitConstants(): PageFitConstants;
  /** SVG user units per device pixel (1000 / scale). */
  gridUser(): number;
  /** Renderer.postProcessRendered on `div` for exactly `scope`. */
  postProcess(div: HTMLElement, scope: Element[]): void;
  /** Content-level decoration (volta numbers) — idempotent. */
  decorate(div: HTMLElement): void;
  /** Renderer.placePage: rule v1 + v2 over the page, extents into the store. */
  placePage(div: HTMLElement): void;
  firstContentTop(margin: Element, k: PageFitConstants): number;
  contentBottomOf(margin: Element): number | null;
  headerMeasureIds(): Set<string>;
  /** main.ts page injections (footer, section headers, volta) — once per page. */
  onPageMounted(div: HTMLElement): void;
  removeLockMarksOf(div: HTMLElement, systems: Element[]): void;
  /** Re-apply the theme tags to a page re-attached from the park. */
  applyTheme(div: HTMLElement): void;
  /** Fold tolerance in user units (two device pixels). */
  foldTolerance(): number;
}

export interface AssemblyStats {
  lines: number;
  pages: number;
  /** Wall time of the synchronous burst (ms) and of the whole job. */
  syncMs: number;
  totalMs: number;
  renderMs: number;
}

interface OpenPage { pageNo: number; div: HTMLElement; lines: string[] }
interface Job {
  docVer: number;
  nextLine: number;
  cancelled: boolean;
  /** Line whose page the synchronous burst runs until (the cursor's), or -1. */
  targetLine: number;
  targetClosed: boolean;
  idle: number | null;
  t0: number;
  syncMs: number;
  renderMs: number;
}

const BUILDING = 'score-page-building';
const PENDING = 'score-page-pending';
const IDLE_BUDGET_MS = 40;

const scheduleIdle = (cb: () => void): number => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  return ric ? ric(cb, { timeout: 200 }) : (setTimeout(cb, 0) as unknown as number);
};
const cancelIdle = (h: number): void => {
  const cic = (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
  if (cic) cic(h); else clearTimeout(h);
};

export class PageAssembler {
  /** Pages that exist: closed ones (mounted or parked) plus the open one. */
  pageCount = 0;
  private open: OpenPage | null = null;
  /** Closed pages attached to the DOM. */
  mounted = new Set<number>();
  /** Closed pages detached from the DOM, shell and systems intact. */
  private parked = new Map<number, SVGSVGElement>();
  /** Parked pages whose systems moved since they were last placed. */
  private needsPlace = new Set<number>();
  /** Parked pages whose lines a deferred splice changed (rebuilt on mount). */
  private needsRebuild = new Set<number>();
  private job: Job | null = null;
  private styleText = '';
  /** Placeholder box of a parked page (page 1's rendered box, CSS px). */
  pageW = 0;
  pageH = 0;
  /** The lines of a document the owner does not own (a one-line score). */
  private seedLines: string[] = [];
  /** Measures preceded by a user `<pb>`: hard page starts. */
  private pbStarts = new Set<string>();
  private keepScroll: { top: number; left: number } | null = null;
  lastStats: AssemblyStats = { lines: 0, pages: 0, syncMs: 0, totalMs: 0, renderMs: 0 };
  /** Diagnostics of the last repagination (fixtures and the sweep read it). */
  lastRepaginate = { fromPage: 0, rebuiltPages: 0, movedSystems: 0, pagesBefore: 0, pagesAfter: 0, ms: 0 };

  constructor(private readonly host: AssemblyHost, private readonly pageBreaks: PageLineBreaks, private readonly extents: ExtentsStore) {}

  /* ── queries ─────────────────────────────────────────────────────────── */

  pending(): boolean { return this.job !== null; }

  /** The lines being assembled: the owner's, or the seed of an unowned document. */
  lines(): string[] {
    return this.pageBreaks.ownershipActive() ? this.pageBreaks.lineStarts() : this.seedLines;
  }

  isMounted(p: number): boolean { return this.mounted.has(p); }
  isBuilt(p: number): boolean { return p >= 1 && p <= this.pageCount && !(this.open && this.open.pageNo === p); }

  pageDiv(p: number): HTMLElement | null {
    return this.host.container.querySelector('.score-page[data-page="' + p + '"]') as HTMLElement | null;
  }

  /** Page of a line (1-based) from the committed page starts; 0 when the line
   *  is past the assembly frontier or unknown. */
  pageOfLine(li: number): number {
    const lines = this.lines();
    const starts = this.pageBreaks.pageStarts();
    if (!lines.length) return 0;
    const pageStartLines = starts.length ? starts.map((id) => lines.indexOf(id)) : [0];
    let p = 0;
    for (let i = 0; i < pageStartLines.length; i++) if (pageStartLines[i] >= 0 && pageStartLines[i] <= li) p = i + 1;
    if (p === 0) return 0;
    if (this.open && this.open.pageNo === p) return 0;      // not closed yet
    return p <= this.pageCount ? p : 0;
  }

  lineOfMeasure(mi: number): number {
    const lines = this.lines();
    const ids = this.host.measureIds();
    let li = -1;
    for (let i = 0; i < lines.length; i++) {
      const at = ids.indexOf(lines[i]);
      if (at < 0 || at > mi) break;
      li = i;
    }
    return li;
  }

  pageOfMeasure(mi: number): number {
    const li = this.lineOfMeasure(mi);
    return li < 0 ? 0 : this.pageOfLine(li);
  }

  /* ── the load ─────────────────────────────────────────────────────────── */

  /** Start assembling `lines` (the owner's, or a single unowned line) into a
   *  cleared container. Synchronous until the page holding `targetMeasure`
   *  closes (page 1 when unknown), then idle slices. */
  begin(lines: string[], docVer: number, targetMeasure: number | null): void {
    this.cancel();
    this.reset();
    this.seedLines = lines.slice();
    const c = this.host.container;
    this.keepScroll = { top: c.scrollTop, left: c.scrollLeft };
    c.innerHTML = '';
    this.pbStarts = this.readPbStarts();
    const target = targetMeasure === null ? -1 : this.lineOfMeasure(targetMeasure);
    this.job = { docVer, nextLine: 0, cancelled: false, targetLine: Math.max(0, target), targetClosed: false, idle: null, t0: performance.now(), syncMs: 0, renderMs: 0 };
    this.runSync(() => this.job?.targetClosed === true);
    this.scheduleSlice();
  }

  /** Run the job to completion now (an edit, a far mount, the PDF export). */
  finishSync(): void {
    if (!this.job) return;
    this.runSync(() => false);
  }

  cancel(): void {
    if (!this.job) return;
    this.job.cancelled = true;
    if (this.job.idle !== null) cancelIdle(this.job.idle);
    this.job = null;
  }

  private reset(): void {
    this.pageCount = 0;
    this.open = null;
    this.mounted.clear();
    this.parked.clear();
    this.needsPlace.clear();
    this.needsRebuild.clear();
    this.styleText = '';
    this.pageW = 0;
    this.pageH = 0;
    this.extents.clear();
    this.pageBreaks.setPageStarts([]);
  }

  private readPbStarts(): Set<string> {
    const out = new Set<string>();
    const doc = this.host.model().getDoc();
    for (const pb of Array.from(doc.querySelectorAll('pb'))) {
      let next = pb.nextElementSibling;
      while (next && next.localName !== 'measure') next = next.nextElementSibling;
      const id = next?.getAttribute('xml:id');
      if (id) out.add(id);
    }
    return out;
  }

  private runSync(stop: () => boolean): void {
    const job = this.job;
    if (!job) return;
    const t0 = performance.now();
    while (this.job === job && !job.cancelled) {
      if (!this.step()) break;
      if (stop()) break;
    }
    job.syncMs += performance.now() - t0;
  }

  private scheduleSlice(): void {
    const job = this.job;
    if (!job || job.cancelled) return;
    job.idle = scheduleIdle(() => {
      job.idle = null;
      if (this.job !== job || job.cancelled) return;
      const budget = performance.now() + IDLE_BUDGET_MS;
      let more = true;
      while (this.job === job && performance.now() < budget && more) more = this.step();
      if (this.job === job && more) this.scheduleSlice();
    });
  }

  /** One line: render, import, post-process, measure, fit. False when the
   *  document is fully assembled (the job is then finished). */
  private step(): boolean {
    const job = this.job;
    if (!job) return false;
    const lines = this.lines();
    if (job.nextLine >= lines.length) {
      this.closeOpenPage();
      this.finishJob(job);
      return false;
    }
    const li = job.nextLine;
    const tr = performance.now();
    const rl = renderLineSystem(this.host.model(), lines, li, this.host.measureIds(), this.host.lineRenderCtx());
    job.renderMs += performance.now() - tr;
    if (!rl) {
      console.warn('[page-assembly] line ' + li + ' (' + lines[li] + ') could not be rendered — skipped');
      job.nextLine++;
      return true;
    }
    if (!this.styleText) this.styleText = styleTextOf(rl.host);
    if (!this.open) this.openPage(this.pageCount + 1);
    const open = this.open!;
    const sys = this.importSystem(rl.system, rl.host, open.div);
    this.host.postProcess(open.div, [sys]);
    alignStaffRows(sys, this.host.gridUser());
    const ext = measureExtents(sys as SVGGraphicsElement);
    if (ext) this.extents.set(lines[li], ext);
    else console.warn('[page-assembly] line ' + lines[li] + ' has no readable extents');
    if (!this.fitsOnOpen(lines[li])) {
      /* Out BEFORE the page closes: rule v2 distributes over the page's
         systems, so a candidate still in the margin would be counted and the
         survivors would keep a geometry placed for one system too many. */
      const fromRoot = open.div.querySelector('svg')!;
      sys.remove();
      this.closeOpenPage();
      this.openPage(this.pageCount + 1);
      this.moveSystems(fromRoot, this.open!.div.querySelector('svg')!, [sys], null);
    }
    this.open!.lines.push(lines[li]);
    job.nextLine++;
    return true;
  }

  private finishJob(job: Job): void {
    if (this.job !== job) return;
    this.job = null;
    this.lastStats = {
      lines: this.lines().length, pages: this.pageCount,
      syncMs: Math.round(job.syncMs), totalMs: Math.round(performance.now() - job.t0), renderMs: Math.round(job.renderMs),
    };
  }

  private openPage(pageNo: number): void {
    const doc = this.host.container.ownerDocument;
    const div = doc.createElement('div');
    div.className = 'score-page ' + BUILDING;
    div.dataset.page = String(pageNo);
    const shell = createPageShell(doc, this.host.shellGeom(), pageNo, this.host.shellMeta(), this.styleText);
    div.appendChild(shell.svg);
    const all = this.host.container.querySelectorAll('.score-page');
    const last = all.length ? all[all.length - 1] : null;
    if (last) last.after(div); else this.host.container.appendChild(div);
    this.pageCount = pageNo;
    this.open = { pageNo, div, lines: [] };
  }

  /** The open page is full (or the document ended): place it, reveal it,
   *  inject its furniture and commit its page start. */
  private closeOpenPage(): void {
    const open = this.open;
    if (!open) return;
    this.open = null;
    if (!open.lines.length) { open.div.remove(); this.pageCount--; return; }
    this.host.decorate(open.div);
    this.host.placePage(open.div);
    open.div.classList.remove(BUILDING);
    this.host.onPageMounted(open.div);
    this.host.applyTheme(open.div);
    this.mounted.add(open.pageNo);
    const starts = this.pageBreaks.pageStarts();
    const next = open.pageNo === 1 ? [open.lines[0]] : starts.concat([open.lines[0]]);
    if (!this.pageBreaks.setPageStarts(next)) console.warn('[page-assembly] page start refused for page ' + open.pageNo);
    if (open.pageNo === 1) {
      const box = open.div.getBoundingClientRect();
      this.pageW = box.width || 800;
      this.pageH = box.height || 1000;
      if (this.keepScroll) {
        this.host.container.scrollTop = this.keepScroll.top;
        this.host.container.scrollLeft = this.keepScroll.left;
        this.keepScroll = null;
      }
    }
    const job = this.job;
    if (job && !job.targetClosed) {
      const lines = this.lines();
      const targetId = lines[job.targetLine];
      if (open.lines.includes(targetId) || job.targetLine < 0) job.targetClosed = true;
    }
  }

  /** Import a window system into a page: the element, its glyph defs. */
  private importSystem(fresh: SVGGElement, host: Document, div: HTMLElement): SVGGElement {
    const svg = div.querySelector('svg')!;
    const margin = svg.querySelector('g.page-margin')!;
    const defs = svg.querySelector(':scope > defs')!;
    const imported = div.ownerDocument.importNode(fresh, true) as SVGGElement;
    imported.removeAttribute('transform');
    margin.appendChild(imported);
    mergeGlyphDefs(defs, host, [imported]);
    return imported;
  }

  /** Would `lineId` fit on the open page under the minimum placement? */
  private fitsOnOpen(lineId: string): boolean {
    const open = this.open!;
    if (!open.lines.length) return true;
    if (this.pbStarts.has(lineId)) return false;
    const margin = open.div.querySelector('svg g.page-margin')!;
    return this.predictFold(margin, open.lines.concat([lineId])) < 0;
  }

  /** Fold index of `lineIds` placed on a page whose header is `margin`'s, from
   *  stored extents (−1 = every line fits; a missing extent counts as fitting,
   *  so an unmeasured line is never the reason a page closes). */
  private predictFold(margin: Element, lineIds: string[]): number {
    const k = this.host.fitConstants();
    const limit = this.host.contentBottomOf(margin);
    if (limit === null) return -1;
    const headers = this.host.headerMeasureIds();
    const items: Array<{ ext: SysExtents; reserve: number }> = [];
    for (const id of lineIds) {
      const ext = this.extents.get(id);
      if (!ext) return -1;
      items.push({ ext, reserve: this.lineReserve(id, headers) });
    }
    return foldIndex(placeSystems(items, k, this.host.firstContentTop(margin, k)), limit, this.host.foldTolerance());
  }

  /** Header reserve carried by the line starting at `startId`. */
  private lineReserve(startId: string, headers: Set<string>): number {
    if (!headers.size) return 0;
    const lines = this.lines();
    const ids = this.host.measureIds();
    const li = lines.indexOf(startId);
    const lo = ids.indexOf(startId);
    if (li < 0 || lo < 0) return 0;
    const hiId = li + 1 < lines.length ? ids.indexOf(lines[li + 1]) : -1;
    const hi = hiId < 0 ? ids.length : hiId;
    let reserve = 0;
    for (let mi = lo; mi < hi; mi++) if (headers.has(ids[mi])) reserve += SECTION_HEADER_RESERVE;
    return reserve;
  }

  /* ── mount / unmount (no render) ─────────────────────────────────────── */

  /** Attach a parked page. True when the page is mounted afterwards. */
  mount(p: number): boolean {
    if (this.mounted.has(p)) return true;
    if (!this.isBuilt(p)) {
      this.ensurePageBuilt(p);
      if (this.mounted.has(p)) return true;
    }
    const svg = this.parked.get(p);
    const div = this.pageDiv(p);
    if (!svg || !div) return false;
    if (this.needsRebuild.has(p)) {
      this.needsRebuild.delete(p);
      this.parked.delete(p);
      this.rebuildPage(p, div);
      return this.mounted.has(p);
    }
    div.innerHTML = '';
    div.appendChild(svg);
    div.classList.remove(PENDING);
    div.style.removeProperty('width');
    div.style.removeProperty('height');
    this.parked.delete(p);
    this.mounted.add(p);
    this.host.applyTheme(div);
    if (this.needsPlace.has(p)) { this.needsPlace.delete(p); this.host.placePage(div); }
    return true;
  }

  /** Detach a mounted page into the park, leaving a sized placeholder. */
  unmount(p: number): void {
    if (!this.mounted.has(p)) return;
    const div = this.pageDiv(p);
    const svg = div?.querySelector(':scope > svg') as SVGSVGElement | null;
    if (!div || !svg) return;
    svg.remove();
    div.classList.add(PENDING);
    div.style.width = this.pageW + 'px';
    div.style.height = this.pageH + 'px';
    this.mounted.delete(p);
    this.parked.set(p, svg);
  }

  mountAll(): void {
    this.finishSync();
    for (let p = 1; p <= this.pageCount; p++) this.mount(p);
  }

  /** Assemble synchronously until page `p` is closed. */
  private ensurePageBuilt(p: number): void {
    if (!this.job) return;
    this.runSync(() => this.isBuilt(p));
  }

  /** Make the page holding measure `mi` real (the cursor, scroll-into-view). */
  ensureMeasureMounted(mi: number): void {
    const li = this.lineOfMeasure(mi);
    if (li < 0) return;
    if (this.job && this.job.nextLine <= li) this.runSync(() => this.job === null || this.job.nextLine > li && this.pageOfLine(li) > 0);
    const p = this.pageOfLine(li);
    if (p >= 1) this.mount(p);
  }

  /* ── the edit path ───────────────────────────────────────────────────── */

  /** The root `<svg>` of a built page, mounted or parked. */
  private rootOf(p: number): SVGSVGElement | null {
    const parked = this.parked.get(p);
    if (parked) return parked;
    return this.pageDiv(p)?.querySelector(':scope > svg') as SVGSVGElement | null ?? null;
  }

  private systemsOf(root: Element): Element[] {
    const margin = root.querySelector('g.page-margin');
    return margin ? Array.from(margin.children).filter((c) => c.classList.contains('system')) : [];
  }

  /** Move systems (and the section titles riding on them) between page roots,
   *  carrying the glyph defs they reference — a def the target lacks is copied
   *  from the source under a fresh id (never a duplicate id in one document). */
  private moveSystems(fromRoot: Element, toRoot: Element, systems: Element[], anchor: Element | null): void {
    const fromMargin = fromRoot.querySelector('g.page-margin');
    const toMargin = toRoot.querySelector('g.page-margin');
    const toDefs = toRoot.querySelector(':scope > defs');
    const fromDefs = fromRoot.querySelector(':scope > defs');
    if (!fromMargin || !toMargin || !toDefs) return;
    const titles: Element[] = [];
    for (const t of Array.from(fromMargin.querySelectorAll(':scope > text.hkl-section-header'))) {
      const id = t.getAttribute('data-for');
      const m = id ? fromMargin.querySelector('#' + CSS.escape(id)) : null;
      const sys = m?.closest('g.system');
      if (sys && systems.includes(sys)) titles.push(t);
    }
    const fromDiv = fromRoot.parentElement;
    if (fromDiv) this.host.removeLockMarksOf(fromDiv as HTMLElement, systems);
    const have = new Map<string, string>();
    for (const g of Array.from(toDefs.children)) { const id = g.getAttribute('id'); if (id) have.set(id, id); }
    const uid = 'a' + String(++PageAssembler.seq);
    for (const sys of systems) {
      for (const use of Array.from(sys.querySelectorAll('use'))) {
        const href = use.getAttribute('xlink:href') || use.getAttribute('href');
        if (!href || !href.startsWith('#')) continue;
        const id = href.slice(1);
        let target = have.get(id);
        if (!target) {
          const src = fromDefs ? Array.from(fromDefs.children).find((g) => g.getAttribute('id') === id) : undefined;
          if (!src) continue;
          const copy = src.cloneNode(true) as Element;
          target = id + '-' + uid;
          copy.setAttribute('id', target);
          toDefs.appendChild(copy);
          have.set(id, target);
        }
        if (target !== id) {
          if (use.hasAttribute('xlink:href')) use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#' + target);
          else use.setAttribute('href', '#' + target);
        }
      }
      if (anchor) toMargin.insertBefore(sys, anchor); else toMargin.appendChild(sys);
    }
    for (const t of titles) toMargin.appendChild(t);
  }
  private static seq = 0;

  /** After a landed splice: first-fit from the first touched page over the
   *  store, rebuild the pages whose membership changed, up to the first page
   *  whose start is unchanged. Returns false when the pins could not be
   *  committed (the caller derives). */
  repaginateFrom(touched: number[]): boolean {
    const t0 = performance.now();
    this.finishSync();
    const lines = this.lines();
    const pages = this.pageBreaks.pageStarts();
    const stats = { fromPage: 0, rebuiltPages: 0, movedSystems: 0, pagesBefore: this.pageCount, pagesAfter: this.pageCount, ms: 0 };
    this.lastRepaginate = stats;
    if (!lines.length || !pages.length || !touched.length) { stats.ms = performance.now() - t0; return true; }
    /* Start one page BEFORE the first touched page: a changed line that
       starts a page may have shrunk enough to go back onto the page before
       it — the one the first-fit closed on that line's old height. Pagination
       is a function of the extents alone, never of the edit history, so the
       page before must be offered the line again. The membership compare
       below trims the rebuild to the pages that actually change. */
    const firstTouched = Math.max(1, Math.min(...touched));
    if (firstTouched > pages.length) { stats.ms = performance.now() - t0; return true; }
    const fromPage = Math.max(1, firstTouched - 1);
    const fromLine = lines.indexOf(pages[fromPage - 1]);
    if (fromLine < 0) return false;
    const k = this.host.fitConstants();
    const headers = this.host.headerMeasureIds();
    const marginOf = (p: number): Element | null => this.rootOf(p)?.querySelector('g.page-margin') ?? null;
    /* Page geometry is identical on every page but the first (its title block),
       so any page ≥ 2 stands in for a page that does not exist yet. */
    const anyLater = (): Element | null => { for (let p = 2; p <= this.pageCount; p++) { const m = marginOf(p); if (m) return m; } return null; };
    const y0Of = (p: number): number => {
      const m = marginOf(p) ?? (p >= 2 ? anyLater() : null);
      return m ? this.host.firstContentTop(m, k) : k.C0;
    };
    const limitOf = (p: number): number => {
      const m = marginOf(p) ?? anyLater() ?? marginOf(1);
      return (m && this.host.contentBottomOf(m)) ?? Infinity;
    };
    const ff = firstFitLines(
      lines.length,
      (li) => this.extents.get(lines[li]) ?? null,
      (li) => this.lineReserve(lines[li], headers),
      (li) => this.pbStarts.has(lines[li]),
      k, y0Of, limitOf, this.host.foldTolerance(), fromLine, fromPage,
    );
    if (!ff.complete) {
      console.warn('[page-assembly] a line has no extents — pagination left as committed');
      stats.ms = performance.now() - t0;
      return true;
    }
    const newTail = ff.pageStarts.map((li) => lines[li]);
    const oldTail = pages.slice(fromPage - 1);
    /* A page is unchanged when its start AND its end (the next start, or the
       document's end) are what they were: its lines and their extents are then
       exactly what the old pagination placed, wherever the page now sits in
       the numbering. Trim such pages off both ends of the tails; what remains
       is the contiguous window to rebuild — old pages [s, a] become new pages
       [s, b] — and every old page past `a` is kept as is (renumbered when the
       window's page count changed). Comparing starts alone at the same index
       (what this did before) stopped at a page whose start held while its
       content had overflowed, and never recognised a kept page once the
       count had changed. */
    const END = '';
    const pairSame = (ni: number, oi: number): boolean =>
      newTail[ni] === oldTail[oi] && (newTail[ni + 1] ?? END) === (oldTail[oi + 1] ?? END);
    let s = 0;
    while (s < newTail.length && s < oldTail.length && pairSame(s, s)) s++;
    let a = oldTail.length - 1, b = newTail.length - 1;
    while (a >= s && b >= s && pairSame(b, a)) { a--; b--; }
    if (a < s && b < s) { stats.ms = performance.now() - t0; return true; }   // identical pagination
    const base = fromPage + s;                       // first page rebuilt (same number on both sides)
    const rebuildNew = newTail.slice(s, b + 1);
    const rebuildOld = oldTail.slice(s, a + 1);
    const keptAfter = oldTail.slice(a + 1);          // unchanged pages past the window, old order
    stats.fromPage = base;
    /* Pages [base, base + rebuildOld.length) are torn down; their
       systems, in line order, refill rebuildNew.length pages. */
    const oldCount = rebuildOld.length, newCount = rebuildNew.length;
    const firstUnchanged = base + oldCount;                // old numbering; past the end when none
    const lastOld = Math.min(this.pageCount, base + oldCount - 1);
    const bank: Array<{ id: string; el: Element; root: Element }> = [];
    for (let p = base; p <= lastOld; p++) {
      const root = this.rootOf(p);
      if (!root) continue;
      for (const sys of this.systemsOf(root)) {
        const id = sys.querySelector('g.measure')?.id ?? '';
        bank.push({ id, el: sys, root });
      }
    }
    const byId = new Map(bank.map((b) => [b.id, b]));
    const lineIdx = new Map(lines.map((id, i) => [id, i]));
    const rangeEnd = keptAfter.length ? (lineIdx.get(keptAfter[0]) ?? lines.length) : lines.length;
    /* Tear down the old pages' divs (keep the roots alive for the move). */
    const oldRoots: Element[] = [];
    for (let p = base; p <= lastOld; p++) {
      const root = this.rootOf(p); if (root) oldRoots.push(root);
      const div = this.pageDiv(p);
      div?.remove();
      this.mounted.delete(p); this.parked.delete(p); this.needsPlace.delete(p); this.needsRebuild.delete(p);
    }
    /* Renumber what follows when the count changes. */
    const delta = newCount - oldCount;
    if (delta !== 0 && keptAfter.length) {
      const later: number[] = [];
      for (let p = firstUnchanged; p <= this.pageCount; p++) later.push(p);
      const order = delta > 0 ? later.slice().reverse() : later;
      for (const p of order) this.renumberPage(p, p + delta);
    }
    this.pageCount += delta;
    /* Build the new pages in place, in order, before the first unchanged page. */
    const anchorDiv = keptAfter.length ? this.pageDiv(firstUnchanged + delta) : null;
    const meta = this.host.shellMeta();
    const doc = this.host.container.ownerDocument;
    for (let i = 0; i < newCount; i++) {
      const p = base + i;
      const from = lineIdx.get(rebuildNew[i]) ?? 0;
      const to = i + 1 < newCount ? (lineIdx.get(rebuildNew[i + 1]) ?? rangeEnd) : rangeEnd;
      const div = doc.createElement('div');
      div.className = 'score-page';
      div.dataset.page = String(p);
      const shell = createPageShell(doc, this.host.shellGeom(), p, meta, this.styleText);
      div.appendChild(shell.svg);
      if (anchorDiv) anchorDiv.before(div);
      else {
        const all = this.host.container.querySelectorAll('.score-page');
        const last = all.length ? all[all.length - 1] : null;
        if (last) last.after(div); else this.host.container.appendChild(div);
      }
      for (let li = from; li < to; li++) {
        const b = byId.get(lines[li]);
        if (!b) {
          /* A line the splice deferred (its page was not mounted): render it now. */
          const rl = renderLineSystem(this.host.model(), lines, li, this.host.measureIds(), this.host.lineRenderCtx());
          if (!rl) { console.warn('[page-assembly] line ' + lines[li] + ' could not be rendered during repagination'); continue; }
          const sys = this.importSystem(rl.system, rl.host, div);
          this.host.postProcess(div, [sys]);
          continue;
        }
        this.moveSystems(b.root, shell.svg, [b.el], null);
        stats.movedSystems++;
      }
      this.host.decorate(div);
      this.host.placePage(div);
      this.host.onPageMounted(div);
      this.host.applyTheme(div);
      this.mounted.add(p);
      stats.rebuiltPages++;
    }
    const committed = pages.slice(0, base - 1).concat(rebuildNew, keptAfter);
    if (!this.pageBreaks.setPageStarts(committed)) {
      console.warn('[page-assembly] page starts refused after repagination');
      return false;
    }
    stats.pagesAfter = this.pageCount;
    stats.ms = performance.now() - t0;
    return true;
  }

  /** Give page `from` the number `to`: its div, its header, its park/mount keys. */
  private renumberPage(from: number, to: number): void {
    const div = this.pageDiv(from);
    if (div) div.dataset.page = String(to);
    const root = this.rootOf(from);
    if (root) renumberPageHeader(root, to, this.host.shellMeta());
    if (this.mounted.delete(from)) this.mounted.add(to);
    const parked = this.parked.get(from);
    if (parked) { this.parked.delete(from); this.parked.set(to, parked); }
    if (this.needsPlace.delete(from)) this.needsPlace.add(to);
    if (this.needsRebuild.delete(from)) this.needsRebuild.add(to);
  }

  /** A page the splicer could not reach (deferred): rebuild it from its
   *  committed lines on mount, then re-run first-fit from it. */
  private rebuildPage(p: number, div: HTMLElement): void {
    const lines = this.lines();
    const pages = this.pageBreaks.pageStarts();
    const from = lines.indexOf(pages[p - 1]);
    const to = p < pages.length ? lines.indexOf(pages[p]) : lines.length;
    if (from < 0 || to < 0) return;
    div.innerHTML = '';
    const shell = createPageShell(div.ownerDocument, this.host.shellGeom(), p, this.host.shellMeta(), this.styleText);
    div.appendChild(shell.svg);
    div.classList.remove(PENDING);
    div.style.removeProperty('width');
    div.style.removeProperty('height');
    for (let li = from; li < to; li++) {
      const rl = renderLineSystem(this.host.model(), lines, li, this.host.measureIds(), this.host.lineRenderCtx());
      if (!rl) continue;
      const sys = this.importSystem(rl.system, rl.host, div);
      this.host.postProcess(div, [sys]);
    }
    this.host.decorate(div);
    this.host.placePage(div);
    this.host.onPageMounted(div);
    this.host.applyTheme(div);
    this.mounted.add(p);
    this.repaginateFrom([p]);
  }

  /** Test compatibility: the pages a clipped splice deferred (the old
   *  "stale" set) — rebuilt from their committed lines on mount. */
  get stalePages(): Set<number> {
    return this.needsRebuild;
  }

  /** Rebuild every deferred page now, in the park (a later mount is a plain
   *  re-attach). Returns the pages rebuilt. */
  rebuildDeferred(): number[] {
    const out: number[] = [];
    for (const p of Array.from(this.needsRebuild).sort((a, b) => a - b)) {
      if (!this.needsRebuild.has(p)) continue;        // a rebuild's repagination may have cleared it
      const wasMounted = this.mounted.has(p);
      if (this.mount(p)) { out.push(p); if (!wasMounted) this.unmount(p); }
    }
    return out;
  }

  /** The splicer deferred lines on these pages: their parked systems are stale. */
  markDeferred(pages: number[]): void {
    for (const p of pages) {
      if (this.mounted.has(p)) this.unmount(p);
      if (this.parked.has(p)) this.needsRebuild.add(p);
    }
  }

  /** A page the splice emptied (every line on it vanished): drop it and
   *  renumber the rest. */
  removePage(div: HTMLElement): void {
    const p = Number(div.dataset.page);
    div.remove();
    if (!(p >= 1)) return;
    this.mounted.delete(p); this.parked.delete(p); this.needsPlace.delete(p); this.needsRebuild.delete(p);
    for (let q = p + 1; q <= this.pageCount; q++) this.renumberPage(q, q - 1);
    this.pageCount = Math.max(0, this.pageCount - 1);
  }
}
