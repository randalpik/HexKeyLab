// Pages assembled from measured systems (decisions.md "Composer draws the pages",
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
//          membership-carried pagination names; placePage records the hunk's
//          new extents; `repaginateFrom` runs first-fit from the first touched
//          page over the store and rebuilds ONLY the pages up to the first one
//          whose start comes out where it already is — a changed page never
//          affects a page before it, and an unchanged boundary means every
//          page after it is unchanged too.
//          Only MOUNTED pages are engraved (Max, 2026-10-20). A line on an
//          unmounted page that has no measured height yet — the partition
//          (render/balance.ts F) re-laid it — counts with the height of the
//          line that held its first measure in the layout the pages were last
//          fitted for (`paginatedLines`): the unmounted region stays as it
//          was for page count and scroll height. Its page becomes a deferred
//          card, engraved on mount, and the fit re-runs from there; a line
//          that lands on a MOUNTED page with only such a height is engraved
//          before the page is shown and the fit re-run from its page.
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
import { renderLineSystem, renderLineSystems, CHUNK_LINES, styleTextOf, STYLE_ROOT_TOKEN, type LineRenderCtx, type RenderedLine } from './systemrender.js';
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
  /** Renderer.postProcessRendered on `div` for exactly `scope` — after the
   *  hide-empty substitution, which may REPLACE a system; returns the systems
   *  now in the DOM, which is what a caller must measure and move. */
  postProcess(div: HTMLElement, scope: Element[]): Element[];
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
  /** A placeholder card the assembler created after the load (a deferred
   *  page): observe it so scrolling to it mounts it. */
  observePlaceholder(div: HTMLElement): void;
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
  /** Systems rendered ahead by the last chunk window, by line index. */
  prepared: Map<number, RenderedLine>;
  /** Document version the prepared systems were rendered from: an edit while
   *  the assembly is in flight stales them (a hide-empty toggle swapped a
   *  stale three-staff system out from under the step, 2026-10-09). */
  preparedVer: number;
}

const BUILDING = 'score-page-building';
/* The staging shell's root id, and the id of the ONE stylesheet that styles it
   (see openStaging). */
const STAGING_ROOT_ID = 'hklpg-staging';
const STAGING_STYLE_ID = 'hkl-staging-style';
const PENDING = 'score-page-pending';
/** A slice of assembly work between yields. Each yield is a macrotask hop
 *  (MessageChannel), not an idle callback: `requestIdleCallback` waited for
 *  the browser to declare idle time after every slice, and with a slice
 *  holding one line (68 ms on the sonata) that was ~2 s of waiting across a
 *  load (2026-10-08). A macrotask hop still lets input and painting through
 *  between slices; the slice length bounds how long they wait. */
const IDLE_BUDGET_MS = 60;
const yieldPort = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
const yieldCbs = new Map<number, () => void>();
let yieldSeq = 0;
if (yieldPort) {
  yieldPort.port1.onmessage = (e: MessageEvent<number>) => {
    const cb = yieldCbs.get(e.data);
    if (cb) { yieldCbs.delete(e.data); cb(); }
  };
}
const scheduleIdle = (cb: () => void): number => {
  const id = ++yieldSeq;
  if (yieldPort) { yieldCbs.set(id, cb); yieldPort.port2.postMessage(id); return id; }
  return setTimeout(cb, 0) as unknown as number;
};
const cancelIdle = (h: number): void => {
  if (yieldPort) yieldCbs.delete(h); else clearTimeout(h);
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
  /** Page cards expected for this assembly (the previous count on a zoom or
   *  page-scale change, the cached pagination on a round trip, page 1's
   *  estimate on a fresh load) — placeholders exist for all of them from the
   *  first paint, and the count is corrected only when the assembly ends with
   *  a different total. Null until known. */
  private expected: number | null = null;
  lastStats: AssemblyStats = { lines: 0, pages: 0, syncMs: 0, totalMs: 0, renderMs: 0 };
  /** Diagnostics of the last repagination (fixtures and the sweep read it). */
  lastRepaginate = { fromPage: 0, rebuiltPages: 0, refreshedPages: 0, movedSystems: 0, renderedLines: 0, prestagedLines: 0, pagesBefore: 0, pagesAfter: 0, ms: 0 };
  /** Pages applyPartition rebuilt on its last run (the renderer's touched set). */
  lastRebuiltPages: HTMLElement[] = [];
  /** Parked pages whose post passes must re-run on mount (a rescale). */
  private needsPost = new Set<number>();
  /** The line partition the pages were last fitted for: what "as it was"
   *  means for a line that has no measured height yet (`heightOf`). */
  private paginatedLines: string[] = [];
  /** Heights a fit ASSUMED for lines never engraved since their membership
   *  changed (unmounted pages), by line start id. A measured height in the
   *  store always wins; an estimate only stands in until the line mounts. */
  private estimates = new Map<string, SysExtents>();

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
  begin(lines: string[], docVer: number, targetMeasure: number | null, expectedPages: number | null = null, scrollScale = 1): void {
    this.cancel();
    this.reset();
    this.seedLines = lines.slice();
    const c = this.host.container;
    /* `scrollScale` = new card height / old card height on a re-assembly of
       the same document (zoom, page scale): the reader stays on the same
       page, not at the same pixel. */
    this.keepScroll = { top: c.scrollTop * scrollScale, left: c.scrollLeft * scrollScale };
    c.innerHTML = '';
    this.pbStarts = this.readPbStarts();
    /* Card geometry is the shell's (createPageShell) — known before anything
       renders — so every expected page gets its card now and the scroll
       position survives the first paint (Max, 2026-10-08: the card count
       stays constant unless the total is actually different). */
    const g = this.host.shellGeom();
    this.pageW = g.pageWidth * g.scale / 100;
    this.pageH = g.pageHeight * g.scale / 100;
    this.expected = expectedPages !== null && expectedPages >= 1 ? Math.floor(expectedPages) : null;
    if (this.expected !== null) { this.ensurePlaceholders(this.expected); this.restoreScroll(); }
    const target = targetMeasure === null ? -1 : this.lineOfMeasure(targetMeasure);
    this.job = { docVer, nextLine: 0, cancelled: false, targetLine: Math.max(0, target), targetClosed: false, idle: null, t0: performance.now(), syncMs: 0, renderMs: 0, prepared: new Map(), preparedVer: docVer };
    this.runSync(() => this.job?.targetClosed === true);
    this.scheduleSlice();
  }

  /** Blank, sized cards for pages 1..n that have none yet (appended at the
   *  end, so nothing above moves). */
  private ensurePlaceholders(n: number): void {
    const c = this.host.container;
    let maxP = 0;
    for (const div of Array.from(c.querySelectorAll('.score-page')) as HTMLElement[]) maxP = Math.max(maxP, Number(div.dataset.page) || 0);
    for (let p = maxP + 1; p <= n; p++) {
      const div = c.ownerDocument.createElement('div');
      div.className = 'score-page ' + PENDING;
      div.dataset.page = String(p);
      div.style.width = this.pageW + 'px';
      div.style.height = this.pageH + 'px';
      c.appendChild(div);
    }
  }

  private restoreScroll(): void {
    if (!this.keepScroll) return;
    this.host.container.scrollTop = this.keepScroll.top;
    this.host.container.scrollLeft = this.keepScroll.left;
    this.keepScroll = null;
  }

  /** Cards in the container for pages ≥ 1 (built or placeholder) — what the
   *  next assembly of the same document should expect. */
  cardCount(): number {
    let n = 0;
    for (const div of Array.from(this.host.container.querySelectorAll('.score-page')) as HTMLElement[]) n = Math.max(n, Number(div.dataset.page) || 0);
    return Math.max(n, this.pageCount);
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
    this.estimates.clear();
    this.paginatedLines = [];
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
    /* One window per CHUNK_LINES lines: the systems rendered ahead wait in
       `prepared` and are consumed one line per step. */
    const ver = this.host.model().docVersion();
    if (job.preparedVer !== ver) { job.prepared.clear(); job.preparedVer = ver; }
    let rl = job.prepared.get(li) ?? null;
    if (!rl) {
      job.prepared.clear();
      const chunk = renderLineSystems(this.host.model(), lines, li, Math.min(lines.length, li + CHUNK_LINES), this.host.measureIds(), this.host.lineRenderCtx());
      for (const [k, v] of chunk) job.prepared.set(k, v);
      rl = job.prepared.get(li) ?? null;
    }
    job.prepared.delete(li);
    job.renderMs += performance.now() - tr;
    if (!rl) {
      console.warn('[page-assembly] line ' + li + ' (' + lines[li] + ') could not be rendered — skipped');
      job.nextLine++;
      return true;
    }
    if (!this.styleText) this.styleText = styleTextOf(rl.host);
    if (!this.open) this.openPage(this.pageCount + 1);
    const open = this.open!;
    const imported = this.importSystem(rl.system, rl.host, open.div);
    /* The passes may REPLACE the system (hide-empty substitution): measure and
       move what is in the DOM afterwards, never the import. */
    const sys = this.host.postProcess(open.div, [imported])[0] ?? imported;
    alignStaffRows(sys, this.host.gridUser());
    const ext = measureExtents(sys as SVGGraphicsElement);
    if (ext) this.extents.set(lines[li], ext);
    else console.warn('[page-assembly] line ' + lines[li] + ' has no readable extents (assembly step)');
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
    this.paginatedLines = this.lines().slice();
    /* The total is known now: cards past it were an estimate and go. */
    for (const div of Array.from(this.host.container.querySelectorAll('.score-page.' + PENDING)) as HTMLElement[]) {
      if ((Number(div.dataset.page) || 0) > this.pageCount) div.remove();
    }
    this.lastStats = {
      lines: this.lines().length, pages: this.pageCount,
      syncMs: Math.round(job.syncMs), totalMs: Math.round(performance.now() - job.t0), renderMs: Math.round(job.renderMs),
    };
  }

  private openPage(pageNo: number): void {
    const doc = this.host.container.ownerDocument;
    const shell = createPageShell(doc, this.host.shellGeom(), pageNo, this.host.shellMeta(), this.styleText);
    /* Take over the page's placeholder card in place when there is one. */
    const existing = this.pageDiv(pageNo);
    let div: HTMLElement;
    if (existing && existing.classList.contains(PENDING) && !this.parked.has(pageNo)) {
      div = existing;
      div.innerHTML = '';
      div.classList.remove(PENDING);
      div.style.removeProperty('width');
      div.style.removeProperty('height');
      div.classList.add(BUILDING);
    } else {
      div = doc.createElement('div');
      div.className = 'score-page ' + BUILDING;
      div.dataset.page = String(pageNo);
      /* Before the first card numbered past it (an estimate's placeholders), else last. */
      let before: HTMLElement | null = null;
      for (const d of Array.from(this.host.container.querySelectorAll('.score-page')) as HTMLElement[]) {
        if ((Number(d.dataset.page) || 0) > pageNo) { before = d; break; }
      }
      if (before) before.before(div); else this.host.container.appendChild(div);
    }
    div.appendChild(shell.svg);
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
      /* The real card box (border included) sizes the placeholders. */
      const box = open.div.getBoundingClientRect();
      if (box.width && box.height && (Math.abs(box.width - this.pageW) > 0.5 || Math.abs(box.height - this.pageH) > 0.5)) {
        this.pageW = box.width;
        this.pageH = box.height;
        for (const d of Array.from(this.host.container.querySelectorAll('.score-page.' + PENDING)) as HTMLElement[]) {
          d.style.width = this.pageW + 'px';
          d.style.height = this.pageH + 'px';
        }
      }
      /* A fresh load has no expected count: estimate it from page 1 — still
         inside the synchronous burst, so the first paint shows every card. */
      if (this.expected === null) {
        this.expected = Math.max(1, Math.ceil(this.lines().length / Math.max(1, open.lines.length)));
        this.ensurePlaceholders(this.expected);
      }
      this.restoreScroll();
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
  mount(p: number, build = true): boolean {
    if (this.mounted.has(p)) return true;
    if (!this.isBuilt(p)) {
      /* An unbuilt page is a blank card until the assembly reaches it; only a
         caller that must have it now (the cursor's page, an edit, the export)
         builds synchronously — the scroll path (`build: false`) never does. */
      if (!build) return false;
      this.ensurePageBuilt(p);
      if (this.mounted.has(p)) return true;
    }
    const div = this.pageDiv(p);
    if (!div) return false;
    /* A deferred page (a clipped splice's stale park, or a card the fit left
       unengraved) is built from its committed lines — it may have no shell. */
    if (this.needsRebuild.has(p)) {
      this.needsRebuild.delete(p);
      this.parked.delete(p);
      this.rebuildPage(p, div);
      return this.mounted.has(p);
    }
    const svg = this.parked.get(p);
    if (!svg) return false;
    div.innerHTML = '';
    div.appendChild(svg);
    div.classList.remove(PENDING);
    div.style.removeProperty('width');
    div.style.removeProperty('height');
    this.parked.delete(p);
    this.mounted.add(p);
    this.host.applyTheme(div);
    if (this.needsPost.has(p)) {
      this.needsPost.delete(p);
      delete (div as HTMLElement & { __hklPhaseX?: unknown }).__hklPhaseX;
      this.host.postProcess(div, this.systemsOf(svg));
    }
    if (this.needsPlace.has(p)) { this.needsPlace.delete(p); this.host.placePage(div); }
    return true;
  }

  /** Zoom is visual-only: the inner SVG coordinates, viewBox and margin are
   *  identical at every zoom; only the card's outer size and the device-grid
   *  placement differ (measured on the sonata, 2026-10-09). So a zoom renders
   *  NOTHING: every shell is resized, every built page gets its post passes
   *  (the crisp snaps, the grid-dependent instrument gaps) and its placement
   *  again at the new scale — mounted pages now, parked pages on mount — and
   *  the kept scroll position scales with the cards so the reader stays on the
   *  same page. Before this a zoom was a full re-assembly (20 s in Firefox). */
  rescale(scrollScale: number): void {
    this.finishSync();
    const g = this.host.shellGeom();
    this.pageW = g.pageWidth * g.scale / 100;
    this.pageH = g.pageHeight * g.scale / 100;
    const c = this.host.container;
    const top = c.scrollTop * scrollScale, left = c.scrollLeft * scrollScale;
    for (let p = 1; p <= this.pageCount; p++) {
      const root = this.rootOf(p);
      if (!root) {
        /* A deferred card: only its box follows the zoom (it builds on mount). */
        const card = this.pageDiv(p);
        if (card) { card.style.width = this.pageW + 'px'; card.style.height = this.pageH + 'px'; }
        continue;
      }
      root.setAttribute('width', this.pageW + 'px');
      root.setAttribute('height', this.pageH + 'px');
      const div = this.pageDiv(p);
      if (this.mounted.has(p) && div) {
        delete (div as HTMLElement & { __hklPhaseX?: unknown }).__hklPhaseX;
        this.host.postProcess(div, this.systemsOf(root));
        this.host.placePage(div);
      } else {
        this.needsPost.add(p);
        this.needsPlace.add(p);
        if (div) { div.style.width = this.pageW + 'px'; div.style.height = this.pageH + 'px'; }
      }
    }
    c.scrollTop = top;
    c.scrollLeft = left;
  }

  /** The line starts the built pages render, in order — the partition the DOM
   *  holds (every page built). */
  domLineStarts(): string[] {
    this.finishSync();
    const out: string[] = [];
    for (let p = 1; p <= this.pageCount; p++) {
      const root = this.rootOf(p);
      /* A deferred page holds no current systems (none, or the stale ones of
         its old lines): its lines are the committed ones until it mounts. */
      if (!root || this.needsRebuild.has(p)) { out.push(...this.committedLinesOf(p)); continue; }
      for (const sys of this.systemsOf(root)) { const id = sys.querySelector('g.measure')?.id; if (id) out.push(id); }
    }
    return out;
  }

  /** The first line of every built page, in order. */
  domPageStarts(): string[] {
    this.finishSync();
    const out: string[] = [];
    for (let p = 1; p <= this.pageCount; p++) {
      const root = this.rootOf(p);
      const id = !root || this.needsRebuild.has(p)
        ? this.committedLinesOf(p)[0]
        : this.systemsOf(root)[0]?.querySelector('g.measure')?.id;
      if (id) out.push(id);
    }
    return out;
  }

  /** Line starts of page `p` by the committed page starts. */
  private committedLinesOf(p: number): string[] {
    const lines = this.lines();
    const pages = this.pageBreaks.pageStarts();
    const from = lines.indexOf(pages[p - 1] ?? '');
    if (from < 0) return [];
    const toId = pages[p];
    const to = toId === undefined ? lines.length : lines.indexOf(toId);
    return lines.slice(from, to < 0 ? lines.length : to);
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

  /** After a landed splice: pages re-fit from the first touched page over the
   *  store (lines unchanged, the hunk's extents already refreshed by the
   *  splice's placePage) — `applyPartition` with nothing to render. */
  repaginateFrom(touched: number[]): boolean {
    return this.applyPartition(this.lines(), new Set(), touched);
  }

  /** THE edit operation (decisions.md "Every edit is a
   *  splice", 2026-10-08). `oldLines` is the partition the DOM renders,
   *  `this.lines()` the one the refill just committed, `changedIds` the lines
   *  whose content or render context changed (the refill's changed run, by
   *  line start). A line is re-rendered when it is in that set or when its
   *  member set differs from what its system was drawn with (same start,
   *  different end): the fresh system is engraved into a hidden staging shell,
   *  post-processed and measured there, exactly as the assembly measures a
   *  line. Every other line is reused from the DOM with its stored extents —
   *  no Verovio call for an unchanged line. Pages are then first-fit from one
   *  page before the first affected line (a changed line that starts a page
   *  may fit on the page before) and rebuilt by moving systems between
   *  shells; pages past the last changed one are kept and renumbered.
   *  `touched` names pages that must re-fit even with no line change (the
   *  page of a changed break, a page whose header changed). `prestaged` holds
   *  systems the splicer already engraved for some changed lines (one window
   *  for the hunk); every other changed line on a mounted page is engraved
   *  here. `oldPages` is the pagination the DOM was built for (the refill's
   *  pre-edit pins); it defaults to the committed one.
   *
   *  Pagination is never carried (2026-10-21, Max: "every repartition must
   *  repaginate"; "no path should allow pagination to be stale on mounted
   *  lines"). What a page holds NOW is read from its DOM — its systems'
   *  first measures, mounted or parked — and only a page with no DOM (never
   *  built, or deferred) is taken from the old pins. A page is kept only when
   *  the fit gives it exactly the lines it holds and none of them changed.
   *  False when the page starts could not be committed (the caller
   *  re-assembles). */
  applyPartition(
    oldLines: readonly string[], changedIds: ReadonlySet<string>, touched: number[],
    prestaged?: ReadonlyMap<string, { system: SVGGElement; host: Document }>, oldPages?: readonly string[],
  ): boolean {
    const t0 = performance.now();
    this.finishSync();
    this.lastRebuiltPages = [];
    this.pbStarts = this.readPbStarts();
    const lines = this.lines();
    const pins = oldPages ?? this.pageBreaks.pageStarts();
    /* Each page as it actually is: a built page's systems (first-measure ids)
       from its DOM, else null and its start from the old pins. */
    const actualLines: Array<string[] | null> = [];
    const pages: string[] = [];
    const heldEl = new Map<string, { sys: Element; p: number }>();
    for (let p = 1; p <= this.pageCount; p++) {
      const root = this.rootOf(p);
      const held: string[] = [];
      if (root && !this.needsRebuild.has(p)) {
        for (const sys of this.systemsOf(root)) {
          const id = sys.querySelector('g.measure')?.id ?? '';
          if (!id) continue;
          held.push(id);
          heldEl.set(id, { sys, p });
        }
      }
      actualLines.push(held.length ? held : null);
      pages.push(held.length ? held[0] : (pins[p - 1] ?? ''));
    }
    const stats = { fromPage: 0, rebuiltPages: 0, refreshedPages: 0, movedSystems: 0, renderedLines: 0, prestagedLines: 0, pagesBefore: this.pageCount, pagesAfter: this.pageCount, ms: 0 };
    this.lastRepaginate = stats;
    if (!lines.length || !pages.length) { stats.ms = performance.now() - t0; return true; }
    const lineIdx = new Map(lines.map((id, i) => [id, i]));
    const oldIdx = new Map(oldLines.map((id, i) => [id, i]));
    const measureIdx = new Map(this.host.measureIds().map((id, i) => [id, i]));
    /* What is on screen decides what is engraved: pages mounted now, and the
       page each measure is drawn on (a stale page's systems are the old
       layout, so they say nothing). */
    const mountedBefore = new Set(this.mounted);
    const staleBefore = new Set(this.needsRebuild);
    const pageOfMeasure = new Map<string, number>();
    const staleRoots = new Set<Element>();
    for (let p = 1; p <= this.pageCount; p++) {
      const root = this.rootOf(p);
      if (!root) continue;
      if (staleBefore.has(p)) { staleRoots.add(root); continue; }
      for (const g of Array.from(root.querySelectorAll('g.system g.measure'))) if (g.id) pageOfMeasure.set(g.id, p);
    }
    const onMountedPage = (id: string): boolean => mountedBefore.has(pageOfMeasure.get(id) ?? 0);

    /* Lines that need a fresh system, and the first line about which anything
       differs from the DOM: content, membership, or index. */
    const needRender = new Set<string>();
    let firstAffected = lines.length;
    for (let i = 0; i < lines.length; i++) {
      const id = lines[i];
      const oi = oldIdx.get(id);
      const newEnd = i + 1 < lines.length ? lines[i + 1] : '';
      const oldEnd = oi === undefined ? null : (oi + 1 < oldLines.length ? oldLines[oi + 1] : '');
      if (changedIds.has(id) || oi === undefined || oldEnd !== newEnd) needRender.add(id);
      if ((needRender.has(id) || oi !== i) && i < firstAffected) firstAffected = i;
    }
    /* The committed page starts as NEW line indices (−1 when that line is gone). */
    const pageStartLines = pages.map((id) => lineIdx.get(id) ?? -1);
    const pageOfLineIdx = (li: number): number => {
      let p = 0;
      for (let i = 0; i < pageStartLines.length; i++) if (pageStartLines[i] >= 0 && pageStartLines[i] <= li) p = i + 1;
      return Math.max(1, p);
    };
    let fromLine = firstAffected < lines.length ? firstAffected : -1;
    const touchedPages = touched.filter((p) => p >= 1 && p <= pages.length);
    if (touchedPages.length) {
      const tl = pageStartLines[Math.min(...touchedPages) - 1];
      if (tl >= 0 && (fromLine < 0 || tl < fromLine)) fromLine = tl;
    }
    if (fromLine < 0) { this.paginatedLines = lines.slice(); stats.ms = performance.now() - t0; return true; }   // nothing differs
    /* Start one page BEFORE the first affected page: a changed line that
       starts a page may have shrunk enough to go back onto the page before
       it — the one the first-fit closed on that line's old height. Pagination
       is a function of the extents alone, never of the edit history, so the
       page before must be offered the line again. The membership compare
       below trims the rebuild to the pages that actually change. */
    let fromPage = Math.max(1, pageOfLineIdx(fromLine) - 1);
    while (fromPage > 1 && pageStartLines[fromPage - 1] < 0) fromPage--;
    fromLine = pageStartLines[fromPage - 1] >= 0 ? pageStartLines[fromPage - 1] : 0;

    /* Stage the fresh systems — for the lines on a mounted page only. Every
       other changed line keeps the height it had (`heightOf`) and is engraved
       when its page mounts, or below if the fit lands it on a mounted page.
       A line whose old system (same start) sits on a mounted page is engraved
       IN that page, replacing it — post-processed and measured where it is
       drawn, as the pre-2026-10-21 splicer did; the fit below then decides
       whether it stays there. Only a line with no old system goes through the
       staging shell, whose stylesheet costs a document-wide style recalc on
       insertion and again on removal (~25 ms each with the sonata's 32 pages
       mounted, measured 2026-10-21). */
    const staged = new Map<string, Element>();
    const inPlace = new Set<string>();
    const touchedInPlace = new Set<number>();
    let staging: { div: HTMLElement; root: SVGSVGElement } | null = null;
    for (const id of needRender) {
      const pre = prestaged?.get(id);
      /* The splicer engraved only lines drawn on mounted pages; a line whose
         start measure the edit created has no page to look up, so its
         presence in `prestaged` is the answer. */
      if (!pre && !onMountedPage(id)) continue;
      const li = lineIdx.get(id)!;
      const rl = pre ?? renderLineSystem(this.host.model(), lines, li, this.host.measureIds(), this.host.lineRenderCtx());
      if (!rl) { console.warn('[page-assembly] line ' + id + ' could not be rendered — its old system stays'); continue; }
      if (pre) stats.prestagedLines++;
      if (!this.styleText) this.styleText = styleTextOf(rl.host);
      const live = heldEl.get(id);
      const liveDiv = live && mountedBefore.has(live.p) ? this.pageDiv(live.p) : null;
      if (live && liveDiv && live.sys.parentElement) {
        const fresh = this.importSystem(rl.system, rl.host, liveDiv);
        live.sys.parentElement.insertBefore(fresh, live.sys);
        this.host.removeLockMarksOf(liveDiv, [live.sys]);
        live.sys.remove();
        const sys = this.host.postProcess(liveDiv, [fresh])[0] ?? fresh;
        alignStaffRows(sys, this.host.gridUser());
        const ext = measureExtents(sys as SVGGraphicsElement);
        if (ext) this.extents.set(id, ext);
        else console.warn('[page-assembly] line ' + id + ' has no readable extents (in place)');
        heldEl.set(id, { sys, p: live.p });
        inPlace.add(id);
        touchedInPlace.add(live.p);
        stats.renderedLines++;
        continue;
      }
      if (!staging) staging = this.openStaging();
      const imported = this.importSystem(rl.system, rl.host, staging.div);
      const sys = this.host.postProcess(staging.div, [imported])[0] ?? imported;
      alignStaffRows(sys, this.host.gridUser());
      const ext = measureExtents(sys as SVGGraphicsElement);
      if (ext) this.extents.set(id, ext);
      else console.warn('[page-assembly] line ' + id + ' has no readable extents (staging)');
      staged.set(id, sys);
      stats.renderedLines++;
    }
    const disposeStaging = (): void => { staging?.div.remove(); staging = null; };

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
      (li) => this.heightOf(lines, li, measureIdx),
      (li) => this.lineReserve(lines[li], headers),
      (li) => this.pbStarts.has(lines[li]),
      k, y0Of, limitOf, this.host.foldTolerance(), fromLine, fromPage,
    );
    if (!ff.complete) {
      console.warn('[page-assembly] a line has no extents — pagination left as committed');
      disposeStaging();
      stats.ms = performance.now() - t0;
      return staged.size === 0;   // a staged line with nowhere to go is a failed apply
    }
    const newTail = ff.pageStarts.map((li) => lines[li]);
    const oldTail = pages.slice(fromPage - 1);
    /* A page is unchanged when its start AND its end (the next start, or the
       document's end) are what they were AND none of its lines was re-rendered:
       its lines and their extents are then exactly what the old pagination
       placed, wherever the page now sits in the numbering. Trim such pages off
       both ends of the tails; what remains is the contiguous window to rebuild
       — old pages [s, a] become new pages [s, b] — and every old page past `a`
       is kept as is (renumbered when the window's page count changed). */
    const END = '';
    const rangeOf = (startId: string, nextId: string | undefined): [number, number] => [
      lineIdx.get(startId) ?? 0,
      nextId !== undefined && nextId !== END ? (lineIdx.get(nextId) ?? lines.length) : lines.length,
    ];
    /* A page whose start AND end the fit leaves where they were keeps its
       element; what may change is the content between. It is REUSED when:
       - mounted (a DOM nobody sees is never edited): every line the fit gives
         it is either engraved above or already on it, unchanged — the page is
         then refreshed in place below (systems swapped, inserted, removed;
         nothing moves between pages);
       - built but parked: its DOM holds exactly those lines and none changed;
       - never built, or deferred: compared by its pins alone, no line changed.
       Anything else is rebuilt — a deferred card when it is not on screen. */
    const reusable = (ni: number, oi: number): boolean => {
      if (newTail[ni] !== oldTail[oi] || (newTail[ni + 1] ?? END) !== (oldTail[oi + 1] ?? END)) return false;
      const [a0, b0] = rangeOf(newTail[ni], newTail[ni + 1]);
      const p = fromPage + oi;
      const held = actualLines[p - 1];
      if (mountedBefore.has(p) && held) {
        const have = new Set(held);
        for (let i = a0; i < b0; i++) {
          const id = lines[i];
          if (staged.has(id)) continue;
          if ((needRender.has(id) && !inPlace.has(id)) || !have.has(id)) return false;
        }
        return true;
      }
      for (let i = a0; i < b0; i++) if (needRender.has(lines[i])) return false;
      if (!held) return true;
      if (held.length !== b0 - a0) return false;
      for (let i = a0; i < b0; i++) if (held[i - a0] !== lines[i]) return false;
      return true;
    };
    /* Bring a reused mounted page's systems to the fit's lines, in order: an
       engraved system replaces or joins, a system whose line vanished or was
       re-engraved leaves, every other system stays where it is. Re-placed
       from the extents the fit already counted. */
    const refreshInPlace = (oi: number): void => {
      const p = fromPage + oi;
      const root = this.rootOf(p), div = this.pageDiv(p);
      if (!root || !div || !mountedBefore.has(p)) return;
      const [a0, b0] = rangeOf(oldTail[oi], oldTail[oi + 1]);
      const heldSys = this.systemsOf(root);
      const byId = new Map(heldSys.map((sys) => [sys.querySelector('g.measure')?.id ?? '', sys]));
      const want: Element[] = [];
      for (let i = a0; i < b0; i++) {
        const el = staged.get(lines[i]) ?? byId.get(lines[i]);
        if (el) want.push(el);
      }
      const keep = new Set(want);
      let changed = 0;
      for (const sys of heldSys) {
        if (keep.has(sys)) continue;
        this.host.removeLockMarksOf(div, [sys]);
        sys.remove();
        changed++;
      }
      /* `root.contains`, not `closest('svg')`: a page's systems sit under the
         nested `svg.definition-scale`, never directly under the root. */
      for (let k = 0; k < want.length; k++) {
        const el = want[k];
        if (root.contains(el)) continue;   // already on the page
        let anchor: Element | null = null;
        for (let n = k + 1; n < want.length && !anchor; n++) if (root.contains(want[n])) anchor = want[n];
        if (staging) this.moveSystems(staging.root, root, [el], anchor);
        changed++;
      }
      if (!changed && !touchedInPlace.has(p)) return;
      this.host.decorate(div);
      this.host.placePage(div);
      this.host.applyTheme(div);
      this.lastRebuiltPages.push(div);
      stats.refreshedPages++;
    };
    let s = 0;
    while (s < newTail.length && s < oldTail.length && reusable(s, s)) s++;
    let a = oldTail.length - 1, b = newTail.length - 1;
    while (a >= s && b >= s && reusable(b, a)) { a--; b--; }
    for (let oi = 0; oi < s; oi++) refreshInPlace(oi);
    for (let oi = a + 1; oi < oldTail.length; oi++) refreshInPlace(oi);
    if (a < s && b < s) { this.paginatedLines = lines.slice(); disposeStaging(); stats.ms = performance.now() - t0; return true; }   // pagination unchanged
    const base = fromPage + s;                       // first page rebuilt (same number on both sides)
    const rebuildNew = newTail.slice(s, b + 1);
    const rebuildOld = oldTail.slice(s, a + 1);
    const keptAfter = oldTail.slice(a + 1);          // unchanged pages past the window, old order
    stats.fromPage = base;
    /* Pages [base, base + rebuildOld.length) are torn down; their systems, in
       line order, plus the staged ones, refill rebuildNew.length pages. */
    const oldCount = rebuildOld.length, newCount = rebuildNew.length;
    const firstUnchanged = base + oldCount;                // old numbering; past the end when none
    /* Every built page from `base` on goes when nothing past the window is
       kept — including pages the committed list no longer names (a page start
       the owner dropped): the DOM is rebuilt from `lines`, never from stale
       divs. */
    const lastOld = keptAfter.length ? Math.min(this.pageCount, base + oldCount - 1) : this.pageCount;
    const bank: Array<{ id: string; el: Element; root: Element }> = [];
    for (let p = base; p <= lastOld; p++) {
      const root = this.rootOf(p);
      if (!root) continue;
      for (const sys of this.systemsOf(root)) {
        const id = sys.querySelector('g.measure')?.id ?? '';
        bank.push({ id, el: sys, root });
      }
    }
    const byId = new Map(bank.map((bk) => [bk.id, bk]));
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
    /* A mounted page that received a line with no current system (one the
       fit placed by an assumed height) is engraved now and the fit re-run
       from it: nothing on screen is laid out around a guess. */
    let refitFrom = 0;
    for (let i = 0; i < newCount; i++) {
      const p = base + i;
      const from = lineIdx.get(rebuildNew[i]) ?? 0;
      const to = i + 1 < newCount ? (lineIdx.get(rebuildNew[i + 1]) ?? rangeEnd) : rangeEnd;
      const div = doc.createElement('div');
      div.dataset.page = String(p);
      if (anchorDiv) anchorDiv.before(div);
      else {
        const all = this.host.container.querySelectorAll('.score-page:not(.' + BUILDING + ')');
        const last = all.length ? all[all.length - 1] : null;
        if (last) last.after(div); else this.host.container.appendChild(div);
      }
      if (!mountedBefore.has(p)) {
        /* Not on screen: a deferred card, engraved from its committed lines
           when it mounts (`rebuildPage`). Its systems, if any, are dropped. */
        div.className = 'score-page ' + PENDING;
        div.style.width = this.pageW + 'px';
        div.style.height = this.pageH + 'px';
        this.needsRebuild.add(p);
        this.host.observePlaceholder(div);
        continue;
      }
      div.className = 'score-page';
      const shell = createPageShell(doc, this.host.shellGeom(), p, meta, this.styleText);
      div.appendChild(shell.svg);
      for (let li = from; li < to; li++) {
        const st = staged.get(lines[li]);
        if (st && staging) {
          this.moveSystems(staging.root, shell.svg, [st], null);
          stats.movedSystems++;
          continue;
        }
        const bk = byId.get(lines[li]);
        if (!bk || staleRoots.has(bk.root) || (needRender.has(lines[li]) && !inPlace.has(lines[li]))) {
          /* No current system for this line: engrave it here. */
          const rl = renderLineSystem(this.host.model(), lines, li, this.host.measureIds(), this.host.lineRenderCtx());
          if (!rl) { console.warn('[page-assembly] line ' + lines[li] + ' could not be rendered during repagination'); continue; }
          const sys = this.importSystem(rl.system, rl.host, div);
          this.host.postProcess(div, [sys]);
          stats.renderedLines++;
          if (!refitFrom) refitFrom = p;
          continue;
        }
        this.moveSystems(bk.root, shell.svg, [bk.el], null);
        stats.movedSystems++;
      }
      this.host.decorate(div);
      this.host.placePage(div);
      this.host.onPageMounted(div);
      this.host.applyTheme(div);
      this.mounted.add(p);
      this.lastRebuiltPages.push(div);
      stats.rebuiltPages++;
    }
    disposeStaging();
    const committed = pages.slice(0, base - 1).concat(rebuildNew, keptAfter);
    if (!this.pageBreaks.setPageStarts(committed)) {
      console.warn('[page-assembly] page starts refused after repagination');
      return false;
    }
    this.paginatedLines = lines.slice();
    stats.pagesAfter = this.pageCount;
    stats.ms = performance.now() - t0;
    if (refitFrom) {
      /* placePage measured the lines engraved above: fit again from their
         page with real heights. Each pass engraves only lines new to the
         mounted pages, so this ends. */
      const rebuilt = this.lastRebuiltPages;
      const ok = this.applyPartition(lines, new Set(), [refitFrom]);
      this.lastRebuiltPages = rebuilt.filter((d) => d.isConnected).concat(this.lastRebuiltPages.filter((d) => !rebuilt.includes(d)));
      return ok;
    }
    return true;
  }

  /** The height first-fit counts for line `li` of `lines`: its measured
   *  extents, else the height a fit already assumed for it, else — a line no
   *  fit has seen, re-laid by the partition on a page nobody has mounted since
   *  — the height of the line that held its first measure in the layout the
   *  pages were last fitted for (Max, 2026-10-20: the unmounted region stays
   *  as it was until it mounts). Null only when nothing was ever measured. */
  private heightOf(lines: readonly string[], li: number, measureIdx: ReadonlyMap<string, number>): SysExtents | null {
    const id = lines[li];
    const own = this.extents.get(id) ?? this.estimates.get(id);
    if (own) return own;
    const mi = measureIdx.get(id);
    if (mi === undefined) return null;
    let best: SysExtents | null = null, bestAt = -1;
    for (const pid of this.paginatedLines) {
      const at = measureIdx.get(pid);
      if (at === undefined || at > mi || at <= bestAt) continue;
      const e = this.extents.get(pid) ?? this.estimates.get(pid);
      if (e) { best = e; bestAt = at; }
    }
    if (best) this.estimates.set(id, best);
    return best;
  }

  /** A hidden shell to engrave and measure fresh systems in before they are
   *  moved to their page (applyPartition). */
  private openStaging(): { div: HTMLElement; root: SVGSVGElement } {
    const doc = this.host.container.ownerDocument;
    const div = doc.createElement('div');
    div.className = 'score-page ' + BUILDING;
    div.dataset.page = '0';
    /* No `<style>` of its own: inserting or removing ANY stylesheet restyles
       the whole document (~25 ms each way with the sonata's 32 pages mounted,
       measured 2026-10-21), and a staging shell lives for one edit. Its root
       has a fixed id, and Verovio's rules — scoped to that id — live in one
       stylesheet that is written once and only rewritten when the text
       changes. */
    const shell = createPageShell(doc, this.host.shellGeom(), Math.max(2, this.pageCount + 1), this.host.shellMeta(), '');
    shell.svg.setAttribute('id', STAGING_ROOT_ID);
    const css = this.styleText.split(STYLE_ROOT_TOKEN).join('#' + STAGING_ROOT_ID);
    let sheet = doc.getElementById(STAGING_STYLE_ID) as HTMLStyleElement | null;
    if (!sheet) {
      sheet = doc.createElement('style');
      sheet.id = STAGING_STYLE_ID;
      doc.head.appendChild(sheet);
    }
    if (sheet.textContent !== css) sheet.textContent = css;
    div.appendChild(shell.svg);
    this.host.container.appendChild(div);
    return { div, root: shell.svg };
  }

  /** The page headers changed (Setup apply: title, subtitle, composer):
   *  redraw every built page's header, re-place page 1 (its title block
   *  anchors its first system) and re-fit from it. No system renders. */
  refreshHeaders(meta: ShellMeta): void {
    this.finishSync();
    for (let p = 1; p <= this.pageCount; p++) {
      const root = this.rootOf(p);
      if (root) renumberPageHeader(root, p, meta);
    }
    const d1 = this.pageDiv(1);
    if (d1 && this.mounted.has(1)) this.host.placePage(d1);
    this.repaginateFrom([1]);
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

  /** A deferred page — one the splicer could not reach, or a card the fit
   *  left unengraved because it was not on screen: engrave it from its
   *  committed lines on mount, then re-run first-fit from it with the real
   *  heights (a page shift by a system here is expected, Max 2026-10-20). */
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
