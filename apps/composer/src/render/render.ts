// Verovio renderer: loads the WASM toolkit, owns the score container, exposes
// a single render(mei) entry point. View modes (page vs scroll) toggle the
// `breaks` and page-dimensions options; zoom adjusts the scale and (for the
// 75% preset) per-element line widths.

import '@hkl/notation/verovio-types.js';
import type { VerovioToolkit } from '@hkl/notation/verovio-types.js';
import { injectHejiGlyphs } from '@hkl/notation/heji-render.js';

export type ViewMode = 'page' | 'scroll';
export type ZoomLevel = 50 | 75 | 100;
export const ZOOM_PRESETS: ReadonlyArray<ZoomLevel> = [50, 75, 100];

const VEROVIO_CDN = 'https://www.verovio.org/javascript/latest/verovio-toolkit-wasm.js';

/* Page geometry constants in Verovio's 1/100 mm units.
 * US Letter = 8.5 × 11 in = 2159 × 2794. Margin 0.55 in = 13.97 mm → 140.
 * Scroll mode wants a huge pageWidth so the content never breaks; Verovio
 * clips the emitted SVG to actual content extent, so a large pageWidth
 * doesn't make the SVG huge — it just gives breaks: 'none' headroom. */
const PAGE_GEOM = {
  pageWidth: 2159,
  pageHeight: 2794,
  pageMarginTop: 140,
  pageMarginBottom: 140,
  pageMarginLeft: 140,
  pageMarginRight: 140,
};

const SCROLL_GEOM = {
  pageWidth: 100000,
  pageHeight: 400,
  pageMarginTop: 30,
  pageMarginBottom: 30,
  pageMarginLeft: 30,
  pageMarginRight: 30,
};

const BASE_OPTIONS = {
  svgAdditionalAttribute: ['note@data-q', 'note@data-r', 'note@color', 'note@hkl-paren-caut', 'rest@data-tuplet-placeholder', 'rest@visible', 'accid@type'],
  footer: 'none',
  /* Keep Verovio's default Leipzig font for the score (rests, clefs,
     noteheads). Accidentals are re-rendered in BravuraText by injectHejiGlyphs
     so they're uniform with the injected HEJI glyphs — but ONLY accidentals;
     a global font:'Bravura' would restyle the rests, which read worse. See
     docs/lessons.md. */
};

/* Verovio line-width defaults (in units of --unit):
 *   barLineWidth 0.30, staffLineWidth 0.15, stemWidth 0.20, ledgerLineThickness 0.25.
 * At scale 100, defaults give crisp ~2 px lines. Scale 50 halves them to crisp
 * 1 px lines. Scale 75 would land them on sub-pixel widths (~1.5 px) that blur
 * under shape-rendering: geometricPrecision. The 75% overrides multiply each
 * default by 4/3 so post-scale pixel widths match the scale-100 output. */
function lineWidthOverrides(zoom: ZoomLevel): object {
  if (zoom !== 75) return {};
  return {
    barLineWidth: 0.40,
    staffLineWidth: 0.20,
    stemWidth: 0.27,
    ledgerLineThickness: 0.33,
  };
}

class Renderer {
  private tk: VerovioToolkit | null = null;
  private container: HTMLElement | null = null;
  private viewMode: ViewMode = 'page';
  private zoom: ZoomLevel = 100;
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
      resolve();
    };
  }

  private buildOptions(): object {
    const geom = this.viewMode === 'page' ? PAGE_GEOM : SCROLL_GEOM;
    return {
      ...BASE_OPTIONS,
      ...geom,
      breaks: this.viewMode === 'page' ? 'auto' : 'none',
      header: this.viewMode === 'page' ? 'auto' : 'none',
      scale: this.zoom,
      ...lineWidthOverrides(this.zoom),
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
    this.viewMode = mode;
  }

  getViewMode(): ViewMode {
    return this.viewMode;
  }

  setZoom(z: ZoomLevel): void {
    this.zoom = z;
  }

  getZoom(): ZoomLevel {
    return this.zoom;
  }

  /** Render the given MEI string into the attached container. */
  render(mei: string): void {
    if (!this.tk) throw new Error('render() before ready()');
    if (!this.container) throw new Error('render() before attach()');
    this.tk.setOptions(this.buildOptions());
    if (!this.tk.loadData(mei)) {
      this.container.innerHTML = '<div style="color:#c00;padding:20px">Verovio loadData failed (invalid MEI).</div>';
      return;
    }
    if (this.viewMode === 'scroll') {
      /* breaks: 'none' produces a single page; render only the first page so
         multi-page concatenation can't expand the canvas vertically. */
      this.container.innerHTML = this.tk.renderToSVG(1, {});
    } else {
      /* Each page SVG wrapped in a .score-page div so CSS can give it
         a white background, border, and surrounding margin against the
         dark #score surround. */
      const pages = this.tk.getPageCount();
      let combined = '';
      for (let i = 1; i <= Math.max(1, pages); i++) {
        combined += '<div class="score-page" data-page="' + i + '">' + this.tk.renderToSVG(i, {}) + '</div>';
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
    /* Replace tagged placeholder accidentals with BravuraText HEJI / stacked
       glyphs. Also swaps any paren <use> glyphs Verovio emitted (from
       @enclose="paren" on a child accid) to BravuraText. No-op when the
       MEI carried no tagged placeholders or parens. */
    injectHejiGlyphs(this.container);
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
