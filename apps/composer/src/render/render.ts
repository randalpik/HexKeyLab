// Verovio renderer: loads the WASM toolkit, owns the score container, exposes
// a single render(mei) entry point. View modes (page vs scroll) toggle the
// `breaks` and page-dimensions options; zoom selects a crisp preset
// (scale/unit/line-widths/margin parity — see @hkl/notation/render-presets) that
// keeps staff lines on the device-pixel grid at each zoom level.

import '@hkl/notation/verovio-types.js';
import type { VerovioToolkit } from '@hkl/notation/verovio-types.js';
import { injectHejiGlyphs } from '@hkl/notation/heji-render.js';
import { applyNotationTheme } from '@hkl/notation/verovio.js';
import { CRISP_PRESETS, crispMarginTop, lineWidthOptions, pinExactScale, snapStaffLinesToGrid, snapBarlines, snapSystemRightEdge } from '@hkl/notation/render-presets.js';
import { VirtualRibbon } from './virtualize.js';

/* Scroll-mode chunk layout: pinned vertical spacing so every chunk lays out
 *  staves at the SAME Y (content-independent) — required so chunks align
 *  vertically across seams (see docs/decisions.md). `spacingStaff` is generous
 *  for safety; tuning it down (2e) is purely cosmetic and must stay ≥ the
 *  score's max inter-staff content extent to preserve alignment. */
const SCROLL_STAFF_SPACING = 24;
const SCROLL_TARGET_STAFF_Y = 160;
const SCROLL_BAND_HEIGHT = 1000;

export type ViewMode = 'page' | 'scroll';
/** Score theme. 'transparent' renders like 'dark' (light-source noteheads,
 *  light ink) but with no background fill, so the score can be exported / read
 *  into HKL or an OBS overlay. */
export type ScoreTheme = 'light' | 'dark' | 'transparent';
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
  svgAdditionalAttribute: ['note@data-q', 'note@data-r', 'note@color', 'note@data-light-color', 'note@hkl-paren-caut', 'rest@data-tuplet-placeholder', 'rest@visible', 'accid@type'],
  footer: 'none',
  /* Keep Verovio's default Leipzig font for the score (rests, clefs,
     noteheads). Accidentals are re-rendered in BravuraText by injectHejiGlyphs
     so they're uniform with the injected HEJI glyphs — but ONLY accidentals;
     a global font:'Bravura' would restyle the rests, which read worse. See
     docs/lessons.md. */
};

class Renderer {
  private tk: VerovioToolkit | null = null;
  private container: HTMLElement | null = null;
  private viewMode: ViewMode = 'page';
  private zoom: ZoomLevel = 100;
  private theme: ScoreTheme = 'light';
  private readyPromise: Promise<void>;
  /** Scroll-mode virtualized ribbon. Null until first scroll-mode render. */
  private vr: VirtualRibbon | null = null;
  private vrContainer: HTMLElement | null = null;
  /** Dedicated Verovio toolkit for chunk renders — isolated from `tk` so chunk
   *  options (spacingStaff etc.) can't leak into page renders (Verovio's
   *  setOptions persists unspecified options). */
  private chunkTk: VerovioToolkit | null = null;

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

  /** Breaks strategy for a render:
   *   - 'none'    : scroll view (one continuous system).
   *   - 'auto'    : page view, no manual breaks — Verovio flows freely.
   *   - 'smartSb0': page view with section/system breaks but no page breaks —
   *                 'smart' + breaksSmartSb:0 honors EVERY encoded <sb> (even
   *                 a 1-measure system) AND still auto-wraps overflow.
   *   - 'encoded' : page view with page breaks present — only encoded breaks
   *                 are honored, so the natural system breaks must already be
   *                 baked into the data (see layoutBreaks). */
  private buildOptions(strategy: 'none' | 'auto' | 'smartSb0' | 'encoded' = 'auto'): object {
    const geom = this.viewMode === 'page' ? PAGE_GEOM : SCROLL_GEOM;
    const breaksOpt: Record<string, string | number> =
      strategy === 'smartSb0' ? { breaks: 'smart', breaksSmartSb: 0 }
      : { breaks: strategy };
    /* Crisp preset for this zoom: scale/unit chosen so the staff-space is whole
       pixels, whole-px line widths, and a pageMarginTop whose parity puts staff
       lines on the phase their width needs (½-pixel for 1px, integer for 2px).
       The zoom LABEL (50/75/100) maps to the preset's actual Verovio scale
       (50/70/100). pinExactScale() in render() then pins the device scale. */
    const preset = CRISP_PRESETS[this.zoom];
    return {
      ...BASE_OPTIONS,
      ...geom,
      pageMarginTop: crispMarginTop(geom.pageMarginTop, preset.scale, preset.evenWidth),
      ...breaksOpt,
      header: this.viewMode === 'page' ? 'auto' : 'none',
      scale: preset.scale,
      unit: preset.unit,
      ...lineWidthOptions(preset),
    };
  }

  /** The active preset's Verovio scale (for pinExactScale). */
  private currentScale(): number {
    return CRISP_PRESETS[this.zoom].scale;
  }

  /** Snap every rendered system's staff lines onto the device-pixel grid for the
   *  active zoom preset. Page view stacks content-height-dependent systems that
   *  each land at their own sub-pixel phase; this lands them all on the crisp
   *  phase. Call AFTER any post-render injections that move systems (section
   *  headers) and before measuring cursor/overlay geometry. Single-system renders
   *  (scroll) are a no-op (margin parity already aligned them). */
  snapSystems(container: HTMLElement): void {
    const preset = CRISP_PRESETS[this.zoom];
    snapStaffLinesToGrid(container, preset.scale, preset.evenWidth);
  }

  /** Bake natural system breaks into the MEI so page-break ('encoded') docs
   *  still auto-wrap. Lays the data out once with 'smart' + breaksSmartSb:0
   *  (honors every <sb> + wraps overflow; ignores <pb>), reads which measure
   *  starts each rendered system, and inserts an `<sb>` before each of those
   *  measures. The caller then renders the result with 'encoded' so the
   *  forced <pb> page breaks AND the baked system breaks are all honored. */
  private layoutBreaks(mei: string): string {
    if (!this.tk) return mei;
    this.tk.setOptions(this.buildOptions('smartSb0'));
    if (!this.tk.loadData(mei)) return mei;
    const starts = new Set<string>();
    for (let p = 1; p <= this.tk.getPageCount(); p++) {
      const doc = new DOMParser().parseFromString(this.tk.renderToSVG(p, {}), 'image/svg+xml');
      for (const sys of Array.from(doc.querySelectorAll('g.system'))) {
        const first = sys.querySelector('g.measure');
        if (first?.id) starts.add(first.id);
      }
    }
    if (!starts.size) return mei;
    const MEI_NS = 'http://www.music-encoding.org/ns/mei';
    const mdoc = new DOMParser().parseFromString(mei, 'application/xml');
    const section = mdoc.querySelector('section');
    if (!section) return mei;
    for (const meas of Array.from(mdoc.querySelectorAll('measure'))) {
      const id = meas.getAttribute('xml:id');
      if (!id || !starts.has(id)) continue;
      let node: Node = meas;
      while (node.parentNode && node.parentNode !== section) node = node.parentNode;
      const prev = (node as Element).previousElementSibling;
      if (!prev) continue;                    /* first measure — no break needed */
      if (prev.localName === 'sb') continue;  /* already broken here */
      section.insertBefore(mdoc.createElementNS(MEI_NS, 'sb'), node);
    }
    return new XMLSerializer().serializeToString(mdoc);
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
    /* Leaving scroll mode: tear down the virtualized ribbon (detach its scroll
       listener) so its chunk-mounting can't corrupt the page-mode DOM. */
    if (mode !== this.viewMode && this.vr) {
      this.vr.destroy();
      this.vr = null;
      this.vrContainer = null;
    }
    this.viewMode = mode;
  }

  getViewMode(): ViewMode {
    return this.viewMode;
  }

  setTheme(t: ScoreTheme): void {
    this.theme = t;
  }

  getTheme(): ScoreTheme {
    return this.theme;
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
    /* Scroll view → virtualized horizontal ribbon (render only the viewport's
       chunks; scroll never calls Verovio). Page view keeps the full render. */
    if (this.viewMode === 'scroll') { this.renderScroll(mei); return; }
    /* Choose a breaks strategy. Section/system breaks alone → single-pass
       'smart' (honors them + auto-wraps). Page breaks → bake the natural
       system breaks first, then 'encoded' (honors pages + the baked wraps).
       No manual breaks → plain 'auto'. Scroll view → 'none'. */
    let data = mei;
    let strategy: 'auto' | 'smartSb0' | 'encoded';
    if (mei.includes('<pb')) {
      data = this.layoutBreaks(mei);
      strategy = 'encoded';
    } else if (mei.includes('<sb')) {
      strategy = 'smartSb0';
    } else {
      strategy = 'auto';
    }
    this.tk.setOptions(this.buildOptions(strategy));
    if (!this.tk.loadData(data)) {
      this.container.innerHTML = '<div style="color:#c00;padding:20px">Verovio loadData failed (invalid MEI).</div>';
      return;
    }
    /* Each page SVG wrapped in a .score-page div so CSS can give it
       a white background, border, and surrounding margin against the
       dark #score surround. */
    {
      const pages = this.tk.getPageCount();
      let combined = '';
      for (let i = 1; i <= Math.max(1, pages); i++) {
        combined += '<div class="score-page" data-page="' + i + '">' + this.tk.renderToSVG(i, {}) + '</div>';
      }
      this.container.innerHTML = combined;
    }
    /* Pin every page's device scale exact so thin staff lines stay grid-aligned
       (crisp) — counters Verovio's whole-px ceil of the root <svg> box. */
    pinExactScale(this.container, this.currentScale());
    /* Crisp the verticals: snap intermediate barlines onto their pixel phase,
       then land each system's right edge (final barline + staff-line ends) on the
       grid (no sliver past the final bar). */
    snapBarlines(this.container, this.currentScale(), CRISP_PRESETS[this.zoom].evenWidth);
    snapSystemRightEdge(this.container, this.currentScale());
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
    /* Theme the score: tag the container for the shared notation-theme CSS
       (staff/stems/accidentals/HEJI follow --notation-ink) and repaint
       noteheads with their light-source variant in dark/transparent themes.
       'transparent' shares dark's ink/notehead treatment; the .theme-
       transparent class (toggled here) drops all background fills in CSS. */
    applyNotationTheme(this.container, this.theme === 'light' ? 'light' : 'dark');
    this.container.classList.toggle('theme-transparent', this.theme === 'transparent');
  }

  /* ── scroll-mode virtualized ribbon ──────────────────────────────────────── */

  /** Verovio options for a chunk render: natural unjustified spacing
   *  (breaks:'none') + pinned content-independent vertical layout + the active
   *  crisp preset, so chunks are width-identical to the full ribbon and align
   *  vertically across seams. */
  private chunkOptions(): object {
    const preset = CRISP_PRESETS[this.zoom];
    return {
      ...BASE_OPTIONS,
      breaks: 'none',
      pageWidth: 100000,
      pageHeight: 4000,
      adjustPageHeight: true,
      header: 'none',
      spacingStaff: SCROLL_STAFF_SPACING,
      spacingSystem: 0,
      scale: preset.scale,
      unit: preset.unit,
      ...lineWidthOptions(preset),
    };
  }

  /** Per-chunk post-processing — the same treatment the page path applies to the
   *  whole container, run on each freshly-rendered chunk wrapper: notehead
   *  z-order, HEJI/stacked-accidental glyphs, theme, crisp pinning. */
  private postProcessChunk = (node: HTMLElement): void => {
    for (const note of Array.from(node.querySelectorAll('g.note'))) {
      const nh = note.querySelector(':scope > g.notehead');
      if (nh) note.appendChild(nh);
    }
    injectHejiGlyphs(node);
    applyNotationTheme(node, this.theme === 'light' ? 'light' : 'dark');
    node.classList.toggle('theme-transparent', this.theme === 'transparent');
    pinExactScale(node, this.currentScale());
    snapBarlines(node, this.currentScale(), CRISP_PRESETS[this.zoom].evenWidth);
  };

  private renderScroll(mei: string): void {
    const doc = new DOMParser().parseFromString(mei, 'application/xml');
    if (doc.querySelector('parsererror')) {
      this.container!.innerHTML = '<div style="color:#c00;padding:20px">Render failed (invalid MEI).</div>';
      return;
    }
    /* Dedicated toolkit for chunk renders (isolated from the page toolkit). */
    if (!this.chunkTk && window.verovio) this.chunkTk = new window.verovio.toolkit();
    /* (Re)create the ribbon if absent or bound to a stale container. */
    if (!this.vr || this.vrContainer !== this.container) {
      this.vr?.destroy();
      this.vr = new VirtualRibbon({
        container: this.container!, tk: this.chunkTk ?? this.tk!, options: this.chunkOptions(),
        chunkSize: 8, overlap: 2, estimate: 400,
        bandHeight: SCROLL_BAND_HEIGHT, targetStaffY: SCROLL_TARGET_STAFF_Y, bufferPx: 1200,
        postProcess: this.postProcessChunk,
      });
      this.vrContainer = this.container;
    } else {
      /* Zoom/theme may have changed → refresh chunk options (clears cache). */
      this.vr.setOptions(this.chunkOptions());
    }
    this.vr.rebuild(doc);
  }

  /** Ensure the chunk holding measure index `mi` is rendered + mounted (so the
   *  cursor overlay can resolve its rect). Scroll mode only; no-op otherwise. */
  ensureMeasureMounted(mi: number): void { this.vr?.ensureMeasureMounted(mi); }

  /** Ribbon-x + width of a measure by xml:id, from the virtualization index
   *  (works without the measure being mounted). Null when not in scroll mode. */
  measureBox(id: string): { x: number; w: number } | null { return this.vr?.measureBox(id) ?? null; }

  /** Total ribbon width (scroll canvas), or null when not in scroll mode. */
  ribbonWidth(): number | null { return this.vr?.totalWidth() ?? null; }

  /** Vertical band height of the scroll ribbon (px). */
  scrollBandHeight(): number { return SCROLL_BAND_HEIGHT; }

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
    /* Leftmost notehead/rest in THIS staff — the leading-signature region is
       everything to its left. A mid-measure clef change renders as a g.clef
       too, but it sits AFTER some notes; without this bound it would be picked
       up and the measure-left cursor anchor would jump past it (see lessons.md
       "mid-measure clef vs sig-end"). */
    let firstContentLeft = Infinity;
    for (const n of Array.from(this.container.querySelectorAll('g.note, g.chord, g.rest'))) {
      const r = (n as Element).getBoundingClientRect();
      const cy = (r.top + r.bottom) / 2;
      const cx = (r.left + r.right) / 2;
      if (cy < staffRect.top || cy > staffRect.bottom) continue;
      if (cx < staffRect.left || cx > staffRect.right) continue;
      if (r.left < firstContentLeft) firstContentLeft = r.left;
    }
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
      /* Only the LEADING sig group (left of the first notehead), so a
         mid-measure clef change doesn't drag the anchor rightward. */
      if (r.left >= firstContentLeft) continue;
      if (r.right > rightmost) rightmost = r.right;
    }
    if (rightmost === -Infinity) return null;
    return rightmost - containerRect.left + this.container.scrollLeft;
  }
}


export const renderer = new Renderer();
