// Verovio renderer: loads the WASM toolkit, owns the score container, exposes
// a single render(mei) entry point. View modes (page vs scroll) toggle the
// `breaks` and page-dimensions options.

import './verovio-types.js';
import type { VerovioToolkit } from './verovio-types.js';

export type ViewMode = 'page' | 'scroll';

const VEROVIO_CDN = 'https://www.verovio.org/javascript/latest/verovio-toolkit-wasm.js';

/* Engraving options.
   - svgViewBox INTENTIONALLY OMITTED — without it Verovio emits explicit
     width/height in px so the SVG renders at its real intended size, not
     scaled to container width.
   - `scale: 100` (default) — natural Verovio rendering size.
   - At scale: 100, Verovio's default `unit: 9` gives integer staff line
     spacing (9 px), so no override needed for crispness.
   - Scroll-mode `pageWidth` can be arbitrarily large — Verovio clips the
     emitted SVG width to the actual content extent, so a huge pageWidth
     doesn't make the SVG huge; it just gives breaks: 'none' headroom
     for the content to lay out without being justified. */
const BASE_OPTIONS = {
  pageMarginTop: 30,
  pageMarginBottom: 30,
  pageMarginLeft: 30,
  pageMarginRight: 30,
  svgAdditionalAttribute: ['note@data-q', 'note@data-r', 'note@color', 'rest@data-tuplet-placeholder'],
  header: 'none',
  footer: 'none',
  scale: 100,
};

const PAGE_OPTIONS = {
  ...BASE_OPTIONS,
  pageWidth: 2100,
  pageHeight: 2970,
  breaks: 'auto',
};

const SCROLL_OPTIONS = {
  ...BASE_OPTIONS,
  pageWidth: 100000,
  pageHeight: 400,
  breaks: 'none',
};

class Renderer {
  private tk: VerovioToolkit | null = null;
  private container: HTMLElement | null = null;
  private viewMode: ViewMode = 'page';
  private readyPromise: Promise<void>;

  constructor() {
    this.readyPromise = this.loadVerovio();
  }

  private loadVerovio(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (window.verovio) {
        this.bindToolkit(resolve);
        return;
      }
      const tag = document.createElement('script');
      tag.src = VEROVIO_CDN;
      tag.async = true;
      tag.onload = () => this.bindToolkit(resolve);
      tag.onerror = () => reject(new Error('failed to load Verovio from ' + VEROVIO_CDN));
      document.head.appendChild(tag);
    });
  }

  private bindToolkit(resolve: () => void): void {
    const v = window.verovio;
    if (!v) {
      resolve();
      return;
    }
    v.module.onRuntimeInitialized = () => {
      this.tk = new v.toolkit();
      this.tk.setOptions(this.viewMode === 'page' ? PAGE_OPTIONS : SCROLL_OPTIONS);
      resolve();
    };
  }

  /** Resolves once Verovio WASM is ready. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  /** Returns the live toolkit. Throws if called before ready resolves. */
  toolkit(): VerovioToolkit {
    if (!this.tk) throw new Error('Verovio toolkit not ready');
    return this.tk;
  }

  getVersion(): string {
    return this.tk ? this.tk.getVersion() : 'not-loaded';
  }

  attach(container: HTMLElement): void {
    this.container = container;
  }

  setViewMode(mode: ViewMode): void {
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    if (this.tk) this.tk.setOptions(mode === 'page' ? PAGE_OPTIONS : SCROLL_OPTIONS);
  }

  getViewMode(): ViewMode {
    return this.viewMode;
  }

  /** Render the given MEI string into the attached container. */
  render(mei: string): void {
    if (!this.tk) throw new Error('render() before ready()');
    if (!this.container) throw new Error('render() before attach()');
    if (!this.tk.loadData(mei)) {
      this.container.innerHTML = '<div style="color:#c00;padding:20px">Verovio loadData failed (invalid MEI).</div>';
      return;
    }
    if (this.viewMode === 'scroll') {
      /* breaks: 'none' produces a single page; render only the first page so
         multi-page concatenation can't expand the canvas vertically. */
      this.container.innerHTML = this.tk.renderToSVG(1, {});
    } else {
      const pages = this.tk.getPageCount();
      let combined = '';
      for (let i = 1; i <= Math.max(1, pages); i++) {
        combined += this.tk.renderToSVG(i, {});
      }
      this.container.innerHTML = combined;
    }
    /* Bring noteheads to the front. Verovio renders each <g class="note">
       as [notehead, dots, stem]; SVG z-order is document order, so the
       stem draws over the notehead. With our colored noteheads + black
       stems, the stem intrudes visibly. Move each notehead group to be
       the LAST child of its note so it draws on top. Dots are off to the
       side and unaffected. */
    for (const note of Array.from(this.container.querySelectorAll('g.note'))) {
      const notehead = note.querySelector(':scope > g.notehead');
      if (notehead) note.appendChild(notehead);
    }
  }

  /** Resolve a clicked SVG element to its xml:id, walking up to the nearest
   *  <g class="note"> or <g class="chord">. Returns null on miss. */
  static idFromClickTarget(target: EventTarget | null): { id: string; kind: 'note' | 'chord' } | null {
    if (!(target instanceof Element)) return null;
    const noteG = target.closest('g.note') as Element | null;
    if (noteG && noteG.id) return { id: noteG.id, kind: 'note' };
    const chordG = target.closest('g.chord') as Element | null;
    if (chordG && chordG.id) return { id: chordG.id, kind: 'chord' };
    return null;
  }

  /** Bounding rect of a rendered MEI element by xml:id, relative to the
   *  container. Returns null if not found in the current SVG. */
  rectForId(meiId: string): DOMRect | null {
    if (!this.container) return null;
    const node = this.container.querySelector('#' + CSS.escape(meiId));
    if (!node) return null;
    const containerRect = this.container.getBoundingClientRect();
    const r = (node as Element).getBoundingClientRect();
    return new DOMRect(
      r.left - containerRect.left + this.container.scrollLeft,
      r.top - containerRect.top + this.container.scrollTop,
      r.width, r.height,
    );
  }

  /** Find the right-edge x (in container-local coords) of the rightmost
   *  clef / keySig / meterSig element whose bounding box lies INSIDE the
   *  given staff's bounding box. Returns null if the staff isn't rendered
   *  yet or has no sigs inside its bounds (e.g., mid-score measures
   *  without sig changes — caller should fall back to a small staff-left
   *  offset). */
  findSigEndXForStaff(staffId: string): number | null {
    if (!this.container) return null;
    const staffNode = this.container.querySelector('#' + CSS.escape(staffId));
    if (!staffNode) return null;
    const containerRect = this.container.getBoundingClientRect();
    const staffRect = (staffNode as Element).getBoundingClientRect();
    /* Verovio's emitted SVG can place clef/sig groups either inside the
       staff <g> or as siblings at the system/measure level — depends on
       version and whether it's the start of a system. Query the whole
       container and filter to those whose bbox lies inside THIS staff
       (vertically AND horizontally — bass staves on different measures
       share the same y range, so a vertical-only filter would pull in
       sigs from the wrong measure). */
    const candidates = Array.from(
      this.container.querySelectorAll('g.clef, g.keySig, g.meterSig')
    );
    let rightmost = -Infinity;
    for (const n of candidates) {
      const r = (n as Element).getBoundingClientRect();
      const cy = (r.top + r.bottom) / 2;
      const cx = (r.left + r.right) / 2;
      if (cy < staffRect.top || cy > staffRect.bottom) continue;
      if (cx < staffRect.left || cx > staffRect.right) continue;
      if (r.right > rightmost) rightmost = r.right;
    }
    if (rightmost === -Infinity) return null;
    return rightmost - containerRect.left + this.container.scrollLeft;
  }
}

export const renderer = new Renderer();
