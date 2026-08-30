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
import { ScrollSplicer, type SpliceCtx } from './splice.js';
import type { ComposerModel } from '../model/index.js';

export type ViewMode = 'page' | 'scroll';

/** Stashed DOM + validity key for the view mode NOT currently on screen
 *  (T1.2, docs/composer-render-perf.md). `nodes` are the real detached
 *  container children — not serialized HTML — so the scroll splicer's element
 *  refs stay valid across a stash/restore round-trip. */
interface ModeCacheEntry {
  nodes: Node[];
  mei: string;
  zoom: ZoomLevel;
  pageScale: number;
  theme: ScoreTheme;
}
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

/* Scroll mode renders the whole score as ONE continuous system (breaks:'none').
 * pageWidth/pageHeight are pinned to Verovio's MAXIMA (100000 / 60000 MEI units —
 * exceeding them logs a bounds error and is version-fragile). pageWidth is a
 * layout budget in MEI units, NOT output px (the emitted SVG is clipped to the
 * content extent, e.g. ~190k px for the 446-bar sonata), so 100000 units holds a
 * very wide single system — roughly ~500 bars at 100% zoom (more at lower zoom)
 * before content would exceed the budget and wrap. Larger scores wrapping in
 * scroll view is a known limit to revisit if a real score hits it. */
const SCROLL_GEOM = {
  pageWidth: 100_000,
  pageHeight: 60_000,
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
  /** Dedicated toolkit for the splicer's offscreen renders (calibration +
   *  sub-renders). Verovio's setOptions + loadData mutate per-instance state,
   *  so reusing `tk` would pollute the live score's toolkit — see the chunk-era
   *  lesson (dedicated chunkTk). Kept entirely separate. */
  private spliceTk: VerovioToolkit | null = null;
  private container: HTMLElement | null = null;
  private viewMode: ViewMode = 'page';
  private zoom: ZoomLevel = 100;
  /** Document page-size factor (ratio; 1 = default US Letter). Scales the page
   *  rectangle in page view only — content stays at the crisp zoom size. */
  private pageScale = 1;
  private theme: ScoreTheme = 'light';
  private readyPromise: Promise<void>;
  /** Scroll-view spot-splice engine (Phase B2). Holds the persistent SVG's
   *  measure index + gap calibration; surgically splices each edit. */
  private splicer = new ScrollSplicer();
  /** Next scroll render must be a full re-engrave (file open, reflow, or a
   *  zoom/page-scale/view-filter change that splice can't retrofit). */
  private forceFull = true;
  /** Per-mode stashed DOM from the last time each mode was on screen (T1.2).
   *  Cleared by forceFullRerender() and by the string-entry render(). */
  private modeCache: Partial<Record<ViewMode, ModeCacheEntry>> = {};
  /** Mode the container's current content was rendered in (null before the
   *  first render). Drives the stash/restore branch in renderComposer. */
  private lastRenderedMode: ViewMode | null = null;

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
      this.spliceTk = new v.toolkit();   // isolated toolkit for splicer offscreen renders
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
    /* Page view: scale the page rectangle (dims + margins) by the document's
       pageScale so the notation — rendered at the fixed crisp scale/unit —
       occupies more/less of the page (more/fewer bars per system) while every
       glyph keeps its on-screen size. Scroll view has no page rectangle, so the
       factor is ignored (SCROLL_GEOM as-is). The scaled top margin still flows
       through crispMarginTop below, keeping staff-line phase crisp. */
    const geom = this.viewMode === 'page' ? this.scalePageGeom(PAGE_GEOM) : SCROLL_GEOM;
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
      /* Scroll trims the page to its single system; page uses fixed-height pages.
         Set EXPLICITLY every render — page and scroll share one toolkit and
         Verovio's setOptions persists unspecified options, so an unset
         adjustPageHeight would leak true from a prior scroll render into page. */
      adjustPageHeight: this.viewMode === 'scroll',
      scale: preset.scale,
      unit: preset.unit,
      ...lineWidthOptions(preset),
    };
  }

  /** The active preset's Verovio scale (for pinExactScale). */
  private currentScale(): number {
    return CRISP_PRESETS[this.zoom].scale;
  }

  /** Scale a page-geometry block (pageWidth/pageHeight + the four margins) by the
   *  current pageScale. Dimensions round to integers (Verovio units); margins
   *  stay float (the top one is re-crisped by crispMarginTop in buildOptions). */
  private scalePageGeom(g: typeof PAGE_GEOM): typeof PAGE_GEOM {
    const f = this.pageScale;
    if (f === 1) return g;
    return {
      pageWidth: Math.round(g.pageWidth * f),
      pageHeight: Math.round(g.pageHeight * f),
      pageMarginTop: g.pageMarginTop * f,
      pageMarginBottom: g.pageMarginBottom * f,
      pageMarginLeft: g.pageMarginLeft * f,
      pageMarginRight: g.pageMarginRight * f,
    };
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
    this.viewMode = mode;
    /* No forceFullRerender here: renderComposer's mode-change branch decides
       between restoring the stashed DOM for this mode (doc unchanged) and a
       forced full engrave — see stashAndRestore (T1.2). */
  }

  /** Force the next render to be a full re-engrave + re-capture (not a splice
   *  or a mode-cache restore). Call on file open, explicit reflow, or any
   *  change neither can retrofit (zoom, page scale, instrument-view filter,
   *  HEJI toggle). Theme is NOT such a change — see applyThemeToRendered. */
  forceFullRerender(): void {
    this.forceFull = true;
    this.splicer.invalidate();
    this.modeCache = {};
  }

  getViewMode(): ViewMode {
    return this.viewMode;
  }

  setTheme(t: ScoreTheme): void {
    /* Theme never moves geometry — the notehead repaint + ink recolor are
       DOM-only, so no re-engrave and no splicer/cache invalidation (T1.1).
       Callers pair this with applyThemeToRendered(). */
    this.theme = t;
  }

  /** Re-apply the current theme to the already-rendered container without
   *  re-engraving: applyNotationTheme is fully reversible (dark tags +
   *  inline-paints noteheads; light removes both). No-op before attach(). */
  applyThemeToRendered(): void {
    if (!this.container) return;
    applyNotationTheme(this.container, this.theme === 'light' ? 'light' : 'dark');
    this.container.classList.toggle('theme-transparent', this.theme === 'transparent');
  }

  getTheme(): ScoreTheme {
    return this.theme;
  }

  setZoom(z: ZoomLevel): void {
    if (z !== this.zoom) this.forceFullRerender();    // changes scale → whole layout
    this.zoom = z;
  }

  getZoom(): ZoomLevel {
    return this.zoom;
  }

  /** Set the document page-size factor (ratio; 1 = default). Only page view
   *  uses it; a change forces a full re-engrave (page dims drive the whole
   *  layout). Idempotent — no-op when unchanged, so steady-state edits keep
   *  splicing. */
  setPageScale(ratio: number): void {
    const next = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    if (next !== this.pageScale) this.forceFullRerender();
    this.pageScale = next;
  }

  getPageScale(): number {
    return this.pageScale;
  }

  /* DEAD END (2026-08-29, do not retry): a `redoLayout()` shortcut for
     byte-identical data with changed options. On the CDN build, setOptions +
     redoLayout does NOT re-apply page geometry — a scroll→page relayout kept
     the 100000-unit scroll page and produced 2 pages instead of 37, and a
     zoom relayout returned in 0 ms (silent no-op; unit changes likely not
     re-applied). loadData is the only reliable relayout. See lessons.md. */

  /** Render the given MEI string into the attached container. String entry
   *  (PDF, tests) — it bypasses the model-aware splice/cache paths, so it
   *  resets them: after this, neither the splicer nor a stashed mode DOM can
   *  describe what's on screen. Composer renders go through renderComposer. */
  render(mei: string): void {
    if (!this.tk) throw new Error('render() before ready()');
    if (!this.container) throw new Error('render() before attach()');
    this.modeCache = {};
    this.splicer.invalidate();
    this.forceFull = true;
    this.lastRenderedMode = this.viewMode;
    if (this.viewMode === 'scroll') { this.renderSingleSystem(mei); return; }
    this.renderPage(mei);
  }

  /** Page-view full render: strategy choice + layout + per-page SVG. Internal
   *  (renderComposer / render) — does not touch splicer or mode-cache state. */
  private renderPage(mei: string): void {
    /* Choose a breaks strategy. Section/system breaks alone → single-pass
       'smart' (honors them + auto-wraps). Page breaks → bake the natural
       system breaks first, then 'encoded' (honors pages + the baked wraps).
       No manual breaks → plain 'auto'. */
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
    this.tk!.setOptions(this.buildOptions(strategy));
    if (!this.tk!.loadData(data)) {
      this.container!.innerHTML = '<div style="color:#c00;padding:20px">Verovio loadData failed (invalid MEI).</div>';
      return;
    }
    /* Each page SVG wrapped in a .score-page div so CSS can give it
       a white background, border, and surrounding margin against the
       dark #score surround. */
    {
      const pages = this.tk!.getPageCount();
      let combined = '';
      for (let i = 1; i <= Math.max(1, pages); i++) {
        combined += '<div class="score-page" data-page="' + i + '">' + this.tk!.renderToSVG(i, {}) + '</div>';
      }
      this.container!.innerHTML = combined;
    }
    this.postProcessRendered(this.container!);
  }

  /* ── scroll-mode single-system render ────────────────────────────────────── */

  /** Render the whole score as one continuous system into the container (no
   *  .score-page wrapper — the bare SVG sits directly in #score, styled by the
   *  `#score.view-scroll svg` CSS). This is the persistent SVG that edits will
   *  spot-splice into (Phase B); for now every render re-engraves it whole. */
  private renderSingleSystem(mei: string): void {
    this.tk!.setOptions(this.buildOptions('none'));
    if (!this.tk!.loadData(mei)) {
      this.container!.innerHTML = '<div style="color:#c00;padding:20px">Verovio loadData failed (invalid MEI).</div>';
      return;
    }
    this.container!.innerHTML = this.tk!.renderToSVG(1, {});
    this.postProcessRendered(this.container!);
  }

  /** Build the Verovio context the splicer needs (toolkit + the exact
   *  buildOptions('none') the full render used + the post-process pass). */
  private spliceCtx(): SpliceCtx {
    return {
      container: this.container!,
      toolkit: this.spliceTk!,
      optionsNone: this.buildOptions('none'),
      postProcess: (el: HTMLElement) => this.postProcessRendered(el),
      scale: this.currentScale(),
    };
  }

  /** Composer render entry (called by main.ts with the live model). Page view →
   *  full serialize + multi-page. Scroll view → surgical splice when possible,
   *  else a full re-engrave + re-capture. On a view-mode switch, first tries to
   *  restore the incoming mode's stashed DOM (T1.2). Returns true when the
   *  container content was freshly engraved — false on a cache restore, so the
   *  caller can skip its page-only post-render injections (already baked into
   *  the stashed DOM). */
  renderComposer(model: ComposerModel, viewStaves: number[] | null): boolean {
    if (!this.tk) throw new Error('renderComposer() before ready()');
    if (!this.container) throw new Error('renderComposer() before attach()');
    const heji = { hejiEnabled: model.getHejiEnabled() };
    let preMei: string | null = null;
    if (this.lastRenderedMode !== null && this.lastRenderedMode !== this.viewMode) {
      preMei = model.serialize(heji, viewStaves);
      if (this.stashAndRestore(preMei)) return false;
    }
    if (this.viewMode === 'scroll') this.renderScroll(model, viewStaves, preMei);
    else this.renderPage(preMei ?? model.serialize(heji, viewStaves));
    this.lastRenderedMode = this.viewMode;
    return true;
  }

  /** View-mode switch: stash the outgoing mode's rendered DOM, and re-attach
   *  the incoming mode's stashed DOM when it still matches the document (same
   *  serialize output) + zoom + page scale — skipping the re-engrave entirely.
   *  On a miss, force the incoming render to be a full engrave: splicing across
   *  a mode switch would target DOM the other mode owns. Returns true when
   *  restored. `mei` is the current render-serialize — the outgoing DOM
   *  reflects it, since every mutation re-renders before a switch can happen. */
  private stashAndRestore(mei: string): boolean {
    const outgoing = this.lastRenderedMode!;
    if (this.container!.querySelector('svg')) {
      this.modeCache[outgoing] = {
        nodes: Array.from(this.container!.childNodes),
        mei, zoom: this.zoom, pageScale: this.pageScale, theme: this.theme,
      };
    }
    const entry = this.modeCache[this.viewMode];
    if (entry && entry.mei === mei && entry.zoom === this.zoom && entry.pageScale === this.pageScale) {
      delete this.modeCache[this.viewMode];
      this.container!.replaceChildren(...entry.nodes);
      if (entry.theme !== this.theme) this.applyThemeToRendered();
      /* The restored scroll DOM is correct to look at either way; future edits
         may splice only while the splicer still describes it (nothing between
         stash and restore touched it — anything that would have also cleared
         the cache, so we couldn't be here). */
      if (this.viewMode === 'scroll' && !this.splicer.canSplice()) this.forceFull = true;
      this.lastRenderedMode = this.viewMode;
      return true;
    }
    this.forceFull = true;
    if (this.viewMode === 'scroll') this.splicer.invalidate();
    return false;
  }

  /** Scroll render: full re-engrave + capture when forced (file open / reflow /
   *  zoom / view-filter change) or in single-part view, otherwise a surgical
   *  splice straight from the model (O(edited-range), no whole-doc
   *  serialize/parse). A splice that can't be performed logs loudly and falls
   *  back to a full re-engrave — a visible bring-up safety net, never a silent
   *  hang. Splicing is gated to all-parts view (viewStaves == null): the gap
   *  calibration assumes the full staff set, so single-part view always
   *  full-renders. `preMei` reuses renderComposer's mode-switch serialize. */
  private renderScroll(model: ComposerModel, viewStaves: number[] | null, preMei: string | null = null): void {
    const heji = { hejiEnabled: model.getHejiEnabled() };
    const canSpliceNow = !this.forceFull && this.splicer.canSplice() && viewStaves == null;
    if (!canSpliceNow) {
      this.renderSingleSystem(preMei ?? model.serialize(heji, viewStaves));
      if (viewStaves == null) this.splicer.capture(model, this.spliceCtx());
      else this.splicer.invalidate();
      this.forceFull = false;
      return;
    }
    if (this.splicer.splice(model, viewStaves, this.spliceCtx())) return;
    console.warn('[scroll-splice] edit could not be spliced — full re-engrave (investigate)');
    this.renderSingleSystem(model.serialize(heji, viewStaves));
    this.splicer.capture(model, this.spliceCtx());
  }

  /** Post-render DOM treatment shared by page + scroll: crisp pinning, notehead
   *  z-order, HEJI/stacked-accidental glyph injection, and theming. */
  private postProcessRendered(container: HTMLElement): void {
    /* Pin device scale exact so thin staff lines stay grid-aligned (crisp) —
       counters Verovio's whole-px ceil of the root <svg> box. */
    pinExactScale(container, this.currentScale());
    /* Crisp the verticals: snap intermediate barlines onto their pixel phase,
       then land each system's right edge (final barline + staff-line ends) on
       the grid (no sliver past the final bar). */
    snapBarlines(container, this.currentScale(), CRISP_PRESETS[this.zoom].evenWidth);
    snapSystemRightEdge(container, this.currentScale());
    /* Bring noteheads to the front. Verovio renders each <g class="note"> as
       [notehead, dots, stem]; SVG z-order is document order, so the stem draws
       over the notehead. With colored noteheads + black stems the stem intrudes;
       move each notehead group last so it draws on top. */
    for (const note of Array.from(container.querySelectorAll('g.note'))) {
      const notehead = note.querySelector(':scope > g.notehead');
      if (notehead) note.appendChild(notehead);
    }
    /* Replace tagged placeholder accidentals with BravuraText HEJI / stacked
       glyphs (+ paren <use> swaps). No-op when none are tagged. */
    injectHejiGlyphs(container);
    /* Theme: tag the container for the shared notation-theme CSS and repaint
       noteheads with their light-source variant in dark/transparent themes.
       'transparent' shares dark's ink; the .theme-transparent class drops fills. */
    applyNotationTheme(container, this.theme === 'light' ? 'light' : 'dark');
    container.classList.toggle('theme-transparent', this.theme === 'transparent');
  }

  /** No-op in the single-SVG renderer (the whole score is always rendered).
   *  Retained so cursor/scroll call sites stay mode-agnostic; the chunk
   *  renderer needed it to mount off-screen measures on demand. */
  ensureMeasureMounted(_mi: number): void { /* everything is always rendered */ }

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
