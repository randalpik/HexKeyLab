// Viewport controller for the virtualized horizontal-ribbon renderer.
//
// Owns the scroll "canvas" (an inner div whose width is the full ribbon width)
// and mounts only the chunks intersecting the viewport (+ a buffer). Chunks are
// rendered lazily via renderChunk and cached; widths feed back into the
// MeasureIndex, whose reflow repositions mounted chunks. Scrolling never calls
// Verovio — it just adds/removes cached chunk nodes.

import type { VerovioToolkit } from '@hkl/notation/verovio-types.js';
import { MeasureIndex } from './measure-index.js';
import { renderChunk, type ChunkResult } from './chunk-render.js';

export interface VirtualRibbonOpts {
  /** The scroll container (#score). */
  container: HTMLElement;
  tk: VerovioToolkit;
  /** Verovio options for chunk renders (breaks:'none' + pinned vertical + crisp). */
  options: object;
  chunkSize?: number;       // measures per chunk
  overlap?: number;         // K — context measures each side
  estimate?: number;        // initial per-measure width estimate (px)
  bandHeight?: number;      // vertical band (px)
  targetStaffY?: number;    // common staff-line Y (px)
  bufferPx?: number;        // off-screen render margin (px) each side
  leftMargin?: number;      // left breathing room before measure 0 (px)
  /** Per-chunk post-processing (HEJI/theme/crisp) applied to each freshly
   *  rendered chunk wrapper before it is mounted. */
  postProcess?: (node: HTMLElement) => void;
}

export class VirtualRibbon {
  private readonly container: HTMLElement;
  private readonly tk: VerovioToolkit;
  private options: object;
  private readonly chunkSize: number;
  private readonly overlap: number;
  private readonly bandHeight: number;
  private readonly targetStaffY: number;
  private readonly bufferPx: number;
  private readonly estimate: number;
  readonly leftMargin: number;
  private readonly postProcess?: (node: HTMLElement) => void;

  private canvas: HTMLElement;
  private index: MeasureIndex = new MeasureIndex([]);
  private doc: Document | null = null;
  private measures: Element[] = [];
  private cache = new Map<number, ChunkResult>();   // chunkIdx → rendered chunk
  private mounted = new Set<number>();
  private rafPending = false;

  constructor(o: VirtualRibbonOpts) {
    this.container = o.container;
    this.tk = o.tk;
    this.options = o.options;
    this.chunkSize = o.chunkSize ?? 8;
    this.overlap = o.overlap ?? 2;
    this.bandHeight = o.bandHeight ?? 1000;
    this.targetStaffY = o.targetStaffY ?? 160;
    this.bufferPx = o.bufferPx ?? 1200;
    this.estimate = o.estimate ?? 400;
    this.leftMargin = o.leftMargin ?? 0;
    this.postProcess = o.postProcess;

    this.canvas = this.container.ownerDocument.createElement('div');
    this.canvas.className = 'hkl-ribbon-canvas';
    /* Left breathing room before measure 0. Set in JS (not CSS) so the renderer
       can account for it when sizing the cursor overlay — rectForId reports
       positions in #score's content frame, which this margin shifts right. */
    this.canvas.style.cssText = `position:relative;height:${this.bandHeight}px;margin-left:${this.leftMargin}px`;
    this.container.addEventListener('scroll', this.onScroll, { passive: true });
  }

  private onScroll = (): void => {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => { this.rafPending = false; this.update(); });
  };

  private chunkCount(): number { return Math.ceil(this.index.count / this.chunkSize); }
  private chunkDispLo(ci: number): number { return ci * this.chunkSize; }
  private chunkDispHi(ci: number): number { return Math.min(this.index.count - 1, ci * this.chunkSize + this.chunkSize - 1); }
  private chunkOfMeasure(mi: number): number { return Math.floor(mi / this.chunkSize); }

  /** Full rebuild for a new/changed document. Parses measures, resets the index
   *  and cache, sizes the canvas, and renders the current viewport. */
  rebuild(doc: Document): void {
    this.doc = doc;
    this.measures = Array.from(doc.querySelector('section')?.children ?? [])
      .filter((c) => c.localName === 'measure') as Element[];
    const ids = this.measures.map((m) => m.getAttribute('xml:id') ?? '');
    this.index = new MeasureIndex(ids, this.estimate);
    this.cache.clear();
    this.mounted.clear();
    this.canvas.replaceChildren();
    /* Make the canvas the container's SOLE child every rebuild — this also
       drops any stale cursor overlay from a prior render (the caller re-adds a
       fresh one), preventing overlay/cursor accumulation. */
    this.container.replaceChildren(this.canvas);
    this.canvas.style.width = Math.ceil(this.index.totalWidth) + 'px';
    this.update();
  }

  private ensureChunk(ci: number): ChunkResult | null {
    const cached = this.cache.get(ci);
    if (cached) return cached;
    if (!this.doc) return null;
    const dispLo = this.chunkDispLo(ci);
    const dispHi = this.chunkDispHi(ci);
    if (dispLo >= this.index.count) return null;
    const res = renderChunk({
      tk: this.tk, fullDoc: this.doc, measures: this.measures, measureIds: this.index.ids,
      dispLo, dispHi, overlap: this.overlap, options: this.options,
      targetStaffY: this.targetStaffY, bandHeight: this.bandHeight,
      ownerDocument: this.container.ownerDocument,
    });
    this.postProcess?.(res.node);
    this.cache.set(ci, res);
    // Feed measured widths back into the index; reflow if they differ from estimate.
    this.index.setMeasuredMany(res.measuredWidths);
    return res;
  }

  /** Recompute the visible chunk set and mount/unmount accordingly. */
  private update(): void {
    if (!this.doc || this.index.count === 0) return;
    const scrollLeft = this.container.scrollLeft;
    const clientW = this.container.clientWidth;
    const { lo, hi } = this.index.rangeForViewport(scrollLeft - this.bufferPx, scrollLeft + clientW + this.bufferPx);
    const ciLo = this.chunkOfMeasure(lo), ciHi = this.chunkOfMeasure(hi);

    // Anchor: keep the leftmost visible measure stationary across reflow.
    const anchorMi = this.index.measureAtX(scrollLeft);
    const anchorOffset = scrollLeft - this.index.xOf(anchorMi);

    // Render + mount visible chunks (rendering may reflow widths).
    let reflowed = false;
    for (let ci = ciLo; ci <= ciHi; ci++) {
      const wasMeasured = this.cache.has(ci);
      const res = this.ensureChunk(ci);
      if (!res) continue;
      if (!wasMeasured) reflowed = true;   // first render of this chunk may have changed widths
      if (!this.mounted.has(ci)) {
        this.canvas.appendChild(res.node);
        this.mounted.add(ci);
      }
    }
    // Unmount chunks outside the visible range (keep them cached for re-use).
    for (const ci of [...this.mounted]) {
      if (ci < ciLo || ci > ciHi) {
        const res = this.cache.get(ci);
        if (res && res.node.parentElement === this.canvas) this.canvas.removeChild(res.node);
        this.mounted.delete(ci);
      }
    }

    // Reposition + resize after possible reflow, then re-anchor scroll.
    this.canvas.style.width = Math.ceil(this.index.totalWidth) + 'px';
    for (const ci of this.mounted) {
      const res = this.cache.get(ci)!;
      res.node.style.left = this.index.xOf(this.chunkDispLo(ci)).toFixed(2) + 'px';
    }
    if (reflowed) {
      const desired = this.index.xOf(anchorMi) + anchorOffset;
      if (Math.abs(desired - this.container.scrollLeft) > 0.5) this.container.scrollLeft = desired;
    }
  }

  /** Ensure the chunk containing measure `mi` is rendered+mounted (e.g. for the
   *  cursor). Returns the measure's ribbon-x. */
  ensureMeasureMounted(mi: number): number {
    if (mi < 0 || mi >= this.index.count) return 0;
    const ci = this.chunkOfMeasure(mi);
    const res = this.ensureChunk(ci);
    if (res) {
      res.node.style.left = this.index.xOf(this.chunkDispLo(ci)).toFixed(2) + 'px';
      if (!this.mounted.has(ci)) { this.canvas.appendChild(res.node); this.mounted.add(ci); }
      this.canvas.style.width = Math.ceil(this.index.totalWidth) + 'px';
    }
    return this.index.xOf(mi);
  }

  xForMeasureId(id: string): number {
    const i = this.index.indexOfId(id);
    return i >= 0 ? this.index.xOf(i) : 0;
  }

  /** Ribbon-x + width of a measure by id (from the index; no mount needed). */
  measureBox(id: string): { x: number; w: number } | null {
    const i = this.index.indexOfId(id);
    if (i < 0) return null;
    return { x: this.index.xOf(i), w: this.index.widthOf(i) };
  }

  totalWidth(): number { return this.index.totalWidth; }

  /** Update chunk render options (zoom/theme change) and drop cached chunks so
   *  they re-render with the new options on next update(). */
  setOptions(options: object): void {
    this.options = options;
    this.cache.clear();
    this.mounted.clear();
    this.canvas.replaceChildren();
  }

  destroy(): void { this.container.removeEventListener('scroll', this.onScroll); }
}
