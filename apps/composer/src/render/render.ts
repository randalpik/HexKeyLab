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
import {
  PageLineBreaks, partitionFromLayout, systemStartsFromPageSvg, injectPins,
  type PageBreaksCtx,
} from './linebreaks.js';
import { PageSystemSplicer, type PageSpliceCtx } from './pagesplice.js';
import type { ComposerModel } from '../model/index.js';

/* Verovio draws volta (1st/2nd ending) numbers in a large, heavy default.
 * Restyle the innermost numeric tspan to a lighter serif and append the
 * conventional trailing period ("1." / "2."). Idempotent, content-level —
 * main.ts runs it per mounted page; the page system splicer runs it on its
 * offscreen host before importing systems. */
const VOLTA_NUMBER_FONT = 300;

export function styleVoltaNumbers(scoreEl: HTMLElement): void {
  for (const vb of Array.from(scoreEl.querySelectorAll('g.voltaBracket'))) {
    for (const ts of Array.from(vb.querySelectorAll('text tspan'))) {
      /* The innermost tspan holds the bare number (no element children). */
      if (ts.children.length > 0) continue;
      const txt = (ts.textContent ?? '').trim();
      if (!/^\d+\.?$/.test(txt)) continue;
      ts.setAttribute('font-size', String(VOLTA_NUMBER_FONT));
      ts.setAttribute('font-weight', 'normal');
      ts.setAttribute('font-family', 'Times, serif');
      if (!txt.endsWith('.')) ts.textContent = txt + '.';
    }
  }
}

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
  /** Line partitions already computed, per layout budget (see partitionKey).
   *  Guarded by the model's document version, so an entry is only reused on a
   *  document that hasn't changed since — which makes a zoom round-trip skip
   *  Verovio's castoff pass entirely. Deliberately survives
   *  forceFullRerender/invalidate; staleness is handled by the version guard,
   *  not by clearing. */
  private partitionCache = new Map<string, { docVer: number; lines: string[]; pages: string[] }>();
  /** Mode the container's current content was rendered in (null before the
   *  first render). Drives the stash/restore branch in renderComposer. */
  private lastRenderedMode: ViewMode | null = null;
  /** Page-view virtualization state (T2.1, docs/composer-render-perf.md):
   *  which pages hold real SVG vs a fixed-size placeholder, the page box
   *  size, and whether the live toolkit still holds this layout (renderToSVG
   *  of a lazy page needs it). Describes the one page DOM wherever it lives —
   *  on screen or stashed by the mode cache — so it survives view switches. */
  private pageVirt: {
    mei: string;                 // exact data loaded (post-layoutBreaks)
    options: object;             // buildOptions the layout used
    pageCount: number;
    pageW: number;               // placeholder content box, px (from page 1's SVG)
    pageH: number;
    mounted: Set<number>;
    io: IntersectionObserver | null;
    tkCurrent: boolean;          // tk still holds this layout → loadData-free mounts
    /** Pages a system splice edited in place, so `mei`/the toolkit layout
     *  describe THEM. Every other page is byte-identical to the loaded layout
     *  (a splice only replaces the systems it touched), so those still mount
     *  for free — only mounting one of THESE needs the document re-serialized
     *  and re-pinned first. */
    stalePages: Set<number>;
  } | null = null;
  /** The model of the last renderComposer — needed to rebuild page data for a
   *  lazy mount after a splice (see pageVirt.stale). Renders always pass it;
   *  this only makes it reachable from the mount path. */
  private lastModel: ComposerModel | null = null;
  /** Measure xml:ids in document order (captured per renderComposer) —
   *  ensureMeasureMounted's index → id map. */
  private measureIds: string[] = [];
  /** Hook run once per mounted page (eager + lazy): main.ts wires its
   *  page-scoped injections (header/footer, section headers, volta styling,
   *  crisp snap). Injections are NOT idempotent (section headers translate
   *  systems), so only the mount path may run them — never a second pass. */
  private onPageMountedCb: ((pageEl: HTMLElement) => void) | null = null;
  /** Duration of the last full engrave per mode (ms) — predictNextRenderHeavy's
   *  evidence. Splices and cache restores don't update it. */
  private lastFullMs: Partial<Record<ViewMode, number>> = {};
  /** Did the last page-view composer render land as a system splice? Drives
   *  predictNextRenderHeavy (a splice is ~300 ms — deferring it behind the
   *  busy badge costs two frames and flashes for nothing). Mirrors the scroll
   *  path's `willSplice` heuristic: evidence-based, and a wrong guess only
   *  means one un-badged slow render. */
  private lastPageSpliced = false;
  /** Page-view line-break ownership (Phase C, docs/composer-page-splice-design.md):
   *  the partition is adopted from each derive render and re-derived locally on
   *  edits (greedy refill + rebalance), pinned into the render MEI. The owner
   *  finds what changed via its own per-measure signature baseline — the
   *  model's renderDirty hint is never trusted here (its reset-then-narrow
   *  lifecycle can swallow an earlier mutation's 'all' under batch-mutate-
   *  then-render flows, e.g. the test runner's doc reset). */
  private pageBreaks = new PageLineBreaks();
  /** Page-view system splice (Phase C-B, docs/composer-page-splice-design.md):
   *  when a refill's edit is provably local, replace only the affected
   *  systems in the mounted page SVGs from a windowed offscreen render —
   *  skipping the full-doc loadData entirely. Stateless: everything it needs
   *  lives in the DOM + the refill result, so there is nothing to invalidate. */
  private pageSplicer = new PageSystemSplicer();

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
   *   - 'line'    : page view, fully pinned partition (line-break ownership):
   *                 every <sb> honored VERBATIM — castoff never wraps even a
   *                 line it deems overfull (unlike 'smart', probed 2026-08-30)
   *                 — while pages are still broken automatically by height.
   *   - 'encoded' : page view with page breaks present — only encoded breaks
   *                 are honored, so the natural system breaks must already be
   *                 baked into the data (see layoutBreaks / the refill's pins). */
  private buildOptions(strategy: 'none' | 'auto' | 'smartSb0' | 'line' | 'encoded' = 'auto', geomMode: ViewMode = this.viewMode): object {
    /* Page view: scale the page rectangle (dims + margins) by the document's
       pageScale so the notation — rendered at the fixed crisp scale/unit —
       occupies more/less of the page (more/fewer bars per system) while every
       glyph keeps its on-screen size. Scroll view has no page rectangle, so the
       factor is ignored (SCROLL_GEOM as-is). The scaled top margin still flows
       through crispMarginTop below, keeping staff-line phase crisp.
       `geomMode` overrides the geometry/header/page-height treatment without
       touching the live view mode — the page line-break owner's naturals
       windows render breaks:'none' at scroll geometry from page view. */
    const geom = geomMode === 'page' ? this.scalePageGeom(PAGE_GEOM) : SCROLL_GEOM;
    const breaksOpt: Record<string, string | number> =
      strategy === 'smartSb0' ? { breaks: 'smart', breaksSmartSb: 0 }
      : { breaks: strategy };
    /* Crisp preset for this zoom: scale/unit chosen so the staff-space is whole
       pixels, whole-px line widths, and a pageMarginTop whose parity puts staff
       lines on the phase their width needs (½-pixel for 1px, integer for 2px).
       The zoom label IS the Verovio scale now (50/75/100), and `unit` is
       CONSTANT at 8 across all three so zooming cannot re-break the score.
       pinExactScale() in render() then pins the device scale. */
    const preset = CRISP_PRESETS[this.zoom];
    return {
      ...BASE_OPTIONS,
      ...geom,
      pageMarginTop: crispMarginTop(geom.pageMarginTop, preset.scale, preset.evenWidth),
      ...breaksOpt,
      header: geomMode === 'page' ? 'auto' : 'none',
      /* Scroll trims the page to its single system; page uses fixed-height pages.
         Set EXPLICITLY every render — page and scroll share one toolkit and
         Verovio's setOptions persists unspecified options, so an unset
         adjustPageHeight would leak true from a prior scroll render into page. */
      adjustPageHeight: geomMode === 'scroll',
      scale: preset.scale,
      unit: preset.unit,
      ...lineWidthOptions(preset),
    };
  }

  /** The active preset's Verovio scale (for pinExactScale). */
  private currentScale(): number {
    return CRISP_PRESETS[this.zoom].scale;
  }

  /** DEAD END (2026-08-31, do not retry without new evidence): compensating the
   *  PAGE SIZE by `unit / 9` to make line breaking zoom-invariant.
   *
   *  The reasoning was sound and the arithmetic checked out — measures-per-line
   *  looked governed by the music:paper ratio, and scaling the paper by the
   *  unit ratio matched `contentWidth / unit` to five digits (208.79 at zoom 75
   *  vs 208.78 at zoom 100). It still did not produce the same partition: the
   *  sonata went from 134 lines (11 % too many) to 113 (4 % too few) where 118
   *  was wanted. So Verovio's horizontal spacing contains terms that do NOT
   *  scale with `unit`, and no paper size reproduces another unit's layout.
   *  Fitting the factor to hit 118 would be reverse-engineering the spacing
   *  model, which is permanently out of scope.
   *
   *  The route that IS guaranteed: make every LAYOUT input identical across
   *  zooms (same `unit`, same page rectangle) and let only `scale` vary. Zoom 50
   *  and zoom 100 already prove that works — identical unit 9 and pageWidth
   *  2159, scale 50 vs 100, and byte-identical partitions — i.e. `scale` has no
   *  layout effect at all. That requires re-deriving the zoom-75 crisp preset
   *  to keep unit 9 (staff spacing 9 × scale/100 = 7 px needs scale 77.78,
   *  fractional), which is a change to the crispness scheme and its fixtures.
   *  See docs/composer-page-splice-design.md. */
  /** Scale a page-geometry block (pageWidth/pageHeight + the four margins) by the
   *  current pageScale AND the zoom's unit compensation. Dimensions round to
   *  integers (Verovio units); margins stay float (the top one is re-crisped by
   *  crispMarginTop in buildOptions). */
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
    return this.layoutBreaksWithLines(mei).data;
  }

  /** `layoutBreaks`, also returning the line partition it baked — the segmented
   *  castoff (`castoffSegmentedByUserBreaks`) needs the list, not just the
   *  data. `lines` is empty when the castoff could not be read. */
  private layoutBreaksWithLines(mei: string): { data: string; lines: string[] } {
    if (!this.tk) return { data: mei, lines: [] };
    this.tk.setOptions(this.buildOptions('smartSb0'));
    if (!this.tk.loadData(mei)) return { data: mei, lines: [] };
    /* Read the partition from page-based MEI (~0.1 s on the sonata) rather than
       rendering every page to SVG (~1.8 s) — same read the partition adoption
       uses. The SVG walk stays as the fallback for unreadable output. */
    let ordered: string[] = partitionFromLayout(this.tk)?.lines ?? [];
    if (!ordered.length) {
      for (let p = 1; p <= this.tk.getPageCount(); p++) {
        ordered = ordered.concat(systemStartsFromPageSvg(this.tk.renderToSVG(p, {})));
      }
    }
    const starts = new Set<string>(ordered);
    if (!starts.size) return { data: mei, lines: [] };
    const MEI_NS = 'http://www.music-encoding.org/ns/mei';
    const mdoc = new DOMParser().parseFromString(mei, 'application/xml');
    const section = mdoc.querySelector('section');
    if (!section) return { data: mei, lines: [] };
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
    return { data: new XMLSerializer().serializeToString(mdoc), lines: ordered };
  }

  /** Document-order measure indices that a USER page break forces onto a new
   *  page: the measure immediately after a section-level `<pb>`. Index 0 is
   *  excluded — the document already starts a page there. */
  private userPageBreakIndices(model: ComposerModel): number[] {
    const measures = model.allMeasures();
    const pos = new Map<Element, number>();
    measures.forEach((m, i) => pos.set(m, i));
    const section = model.getDoc().querySelector('section');
    if (!section) return [];
    const out: number[] = [];
    let pending = false;
    const walk = (el: Element): void => {
      for (const c of Array.from(el.children)) {
        if (c.localName === 'measure') {
          if (pending) { const i = pos.get(c); if (i !== undefined && i > 0) out.push(i); }
          pending = false;
        } else if (c.localName === 'pb') {
          pending = true;
        } else if (c.localName === 'sb') {
          pending = false;          // a system break is not a page break
        } else if (c.localName !== 'scoreDef' && c.querySelector('measure')) {
          walk(c);
        }
      }
    };
    walk(section);
    return out.sort((a, b) => a - b);
  }

  /** Pagination for a document containing USER page breaks, computed by casting
   *  off each inter-break SEGMENT independently.
   *
   *  Why this is needed: no Verovio mode does both jobs. `'line'` paginates by
   *  height but treats `<pb>` as a SYSTEM break (measured: on the sonata with one
   *  Ctrl+B it returns the same 30 pages as with no break at all, and the break
   *  measure is not a page start); `'encoded'` honors `<pb>` as a page break but
   *  never paginates by height. Previously we took `'line'`'s page starts —
   *  computed as if the break did not exist — and then painted `'encoded'`, which
   *  honored the `<pb>` ON TOP of those unchanged pins. That inserted an extra
   *  boundary without re-packing anything after it: a short page (one system if
   *  the break fell before a page's last line), our page list one short of the
   *  DOM, and no cascade — exactly the reported defect.
   *
   *  The fix keeps Verovio as the page-fit engine and only chooses where to cut.
   *  The LINE partition comes from the whole-document castoff and is pinned, so
   *  it is identical to what it would be without any break; each segment is then
   *  laid out alone with `'line'`, which honors those pins verbatim and decides
   *  only how many lines fit per page. Concatenating the segments' page starts
   *  gives "a user break starts a fresh page, and everything after it re-packs
   *  by height". Reading page ASSIGNMENT is insensitive to the segment-edge
   *  justification differences (a segment's last line is document-final for
   *  Verovio), so those cannot corrupt the result.
   *
   *  Returns null when anything is unreadable, and the caller falls back to the
   *  ordinary single-pass castoff. */
  private castoffSegmentedByUserBreaks(
    model: ComposerModel, mei: string, heji: { hejiEnabled: boolean },
  ): { lines: string[]; pages: string[] } | null {
    if (!this.tk) return null;
    const breaks = this.userPageBreakIndices(model);
    if (!breaks.length) return null;
    const baked = this.layoutBreaksWithLines(mei);
    if (baked.lines.length <= 1) return null;
    const ids = model.allMeasures().map((m) => m.getAttribute('xml:id') ?? '');
    const idxOf = new Map<string, number>();
    ids.forEach((id, i) => { if (id) idxOf.set(id, i); });
    /* A page break MUST split its line — a page begins with a new system, so the
       break measure has to start one. The whole-document castoff ran under
       smartSb0, which IGNORES `<pb>`, so the break measure is generally mid-line
       there and absent from `baked.lines`. Merge the break measures in (document
       order) before segmenting: without this the segment document begins at a
       measure the partition says is mid-line, Verovio necessarily starts a line
       there, and the partition check below refuses the inconsistency — which is
       exactly what it is for. This merge is also what makes a MID-SYSTEM page
       break reflow its measures: the measures before it finish the previous
       (now shorter) line, and the break measure opens the new page's first. */
    const lineIdx = new Set<number>();
    for (const id of baked.lines) {
      const i = idxOf.get(id);
      if (i !== undefined) lineIdx.add(i);
    }
    for (const b of breaks) lineIdx.add(b);
    const mergedLines = Array.from(lineIdx).sort((a, b) => a - b).map((i) => ids[i]);
    if (mergedLines.some((id) => !id)) return null;
    /* Segment bounds: [0..b1-1], [b1..b2-1], … [bk..last]. */
    const bounds: Array<[number, number]> = [];
    let from = 0;
    for (const b of breaks) {
      if (b <= from || b >= ids.length) continue;
      bounds.push([from, b - 1]);
      from = b;
    }
    bounds.push([from, ids.length - 1]);
    if (bounds.length < 2) return null;
    const pages: string[] = [];
    for (const [lo, hi] of bounds) {
      const segLines = mergedLines.filter((id) => {
        const i = idxOf.get(id);
        return i !== undefined && i >= lo && i <= hi;
      });
      if (!segLines.length) return null;
      /* A single-line segment occupies exactly one page and cannot overflow, so
         it needs no layout pass at all. Skipping it also avoids Verovio's
         "Requesting layout with line breaks but nothing provided in the data"
         warning: `injectPins` emits no pin for the first line (the document
         already starts there), so a one-line segment would hand `'line'` data
         with no encoded break — which warns and falls back to castoff
         internally. The composer suite treats any console warning as a failure,
         which is how this surfaced. */
      if (segLines.length === 1) { pages.push(segLines[0]); continue; }
      const segMei = model.serializeRangeForRender(lo, hi, heji, null);
      /* Pin the GLOBAL line partition inside this segment (sb only — pagination
         is what we are asking Verovio for, so it must not be pre-decided). */
      const pinned = injectPins(segMei, segLines, null);
      if (pinned === null) return null;
      /* Defensive: multi-line segment whose starts all already sit behind an
         existing sb/pb would likewise give 'line' nothing encoded to honor. */
      if (!/<(sb|pb)\b/.test(pinned)) return null;
      this.tk.setOptions(this.buildOptions('line', 'page'));
      if (!this.tk.loadData(pinned)) return null;
      const read = partitionFromLayout(this.tk);
      if (!read) return null;
      /* Load-bearing check: pinning must have preserved the global partition
         inside the segment. If a segment re-broke its lines, its page starts
         describe a different layout than the one we will paint. */
      if (read.lines.join('|') !== segLines.join('|')) return null;
      for (const p of read.pages) pages.push(p);
    }
    if (pages.length <= 1) return null;
    return { lines: mergedLines, pages };
  }

  /** Which breaks strategy lets Verovio CAST OFF this document, and the data
   *  to feed it. Section/system breaks alone → 'smart' + breaksSmartSb:0
   *  (honors them and auto-wraps). Page breaks → bake the natural system
   *  breaks first, then **'line'**, which honors the user's `<pb>` AND still
   *  paginates the rest by height. No manual breaks → plain 'auto'. This is the
   *  pass that DECIDES a partition; with line/page ownership it is a bootstrap
   *  whose output is read, not painted.
   *
   *  The `<pb>` case used to cast off with 'encoded', which paginates ONLY at
   *  encoded breaks — so one Ctrl+B on the sonata produced TWO pages of 15 and
   *  104 systems, overhanging the paper by 6 800 and 59 534 px (C1, measured by
   *  `cb-userpb.js`). 'encoded' remains the strategy for PAINTING a pinned
   *  document, where every page start is pinned by construction; it was never
   *  right for discovering pagination. `layoutBreaks` still bakes the `<sb>`
   *  first, because 'line' honors breaks verbatim and would otherwise render
   *  each section-break-delimited chunk as one enormous system. */
  private castoffPlan(mei: string): { data: string; strategy: 'auto' | 'smartSb0' | 'line' } {
    if (mei.includes('<pb')) return { data: this.layoutBreaks(mei), strategy: 'line' };
    if (mei.includes('<sb')) return { data: mei, strategy: 'smartSb0' };
    return { data: mei, strategy: 'auto' };
  }

  /** Resolves once Verovio WASM is ready. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  /** Returns the live toolkit. Throws if called before ready resolves.
   *  Handing out the raw toolkit means the caller may load anything into it
   *  (PDF export does, per page) — page-mode lazy mounts must reload theirs. */
  toolkit(): VerovioToolkit {
    if (!this.tk) throw new Error('Verovio toolkit not ready');
    if (this.pageVirt) this.pageVirt.tkCurrent = false;
    return this.tk;
  }

  getVersion(): string {
    return this.tk ? this.tk.getVersion() : 'not-loaded';
  }

  attach(container: HTMLElement): void {
    this.container = container;
  }

  /** Register the per-page-mount hook (see onPageMountedCb). Call before the
   *  first render. */
  setOnPageMounted(cb: (pageEl: HTMLElement) => void): void {
    this.onPageMountedCb = cb;
  }

  /** Will the next renderComposer be a multi-second job (full engrave or mode
   *  switch on a large document)? main.ts uses this to defer the render one
   *  frame behind a busy badge and coalesce burst re-render requests (T2.2).
   *  Mirrors renderScroll's own splice test so prediction can't drift from
   *  behavior; durations come from lastFullMs, so small documents — everything
   *  under 250 ms — always render synchronously (test fixtures included). */
  predictNextRenderHeavy(viewStaves: number[] | null): boolean {
    const HEAVY_MS = 250;
    const proxy = Math.max(this.lastFullMs.page ?? 0, this.lastFullMs.scroll ?? 0);
    if (this.lastRenderedMode !== null && this.lastRenderedMode !== this.viewMode) {
      return proxy > HEAVY_MS;   // switch: restore (~1 s on large docs) or fresh engrave
    }
    if (this.viewMode === 'page') {
      /* An owned-partition edit that spliced last time will almost certainly
         splice again (the gates are stable across consecutive edits in a
         region) — render it synchronously, no badge. */
      if (this.lastPageSpliced && viewStaves == null && this.pageBreaks.ownershipActive()) return false;
      return (this.lastFullMs.page ?? proxy) > HEAVY_MS;
    }
    const willSplice = !this.forceFull && this.splicer.canSplice() && viewStaves == null;
    if (willSplice) return false;
    return (this.lastFullMs.scroll ?? proxy) > HEAVY_MS;
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
    this.pageBreaks.invalidate();
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
    this.pageBreaks.invalidate();
    this.forceFull = true;
    this.lastRenderedMode = this.viewMode;
    this.disposePageVirt();
    if (this.viewMode === 'scroll') { this.renderSingleSystem(mei); return; }
    this.renderPage(mei, false);
  }

  /** Page-view full render: strategy choice + layout + per-page SVG. Internal
   *  (renderComposer / render) — does not touch splicer or mode-cache state.
   *  `virtualize` (the renderComposer path): only pages near the viewport +
   *  page 1 get real SVG; the rest are fixed-size placeholders mounted on
   *  demand (T2.1, docs/composer-render-perf.md). The string-entry path
   *  renders every page (legacy tooling asserts on the full DOM). */
  private renderPage(mei: string, virtualize: boolean, forcedStrategy?: 'auto' | 'smartSb0' | 'line' | 'encoded'): void {
    /* The DOM this call replaces is the only one pageVirt could describe. */
    this.disposePageVirt();
    /* A refill or pinned render forces its strategy — its pins are already in
       the data, so the sniffing (and layoutBreaks' second layout pass) must
       not run. Otherwise let castoffPlan choose. */
    const plan = forcedStrategy ? { data: mei, strategy: forcedStrategy } : this.castoffPlan(mei);
    const data = plan.data;
    const strategy = plan.strategy;
    const options = this.buildOptions(strategy);
    this.tk!.setOptions(options);
    if (!this.tk!.loadData(data)) {
      this.container!.innerHTML = '<div style="color:#c00;padding:20px">Verovio loadData failed (invalid MEI).</div>';
      return;
    }
    /* Each page SVG wrapped in a .score-page div so CSS can give it
       a white background, border, and surrounding margin against the
       dark #score surround. */
    const pages = Math.max(1, this.tk!.getPageCount());
    if (!virtualize) {
      let combined = '';
      for (let i = 1; i <= pages; i++) {
        combined += '<div class="score-page" data-page="' + i + '">' + this.tk!.renderToSVG(i, {}) + '</div>';
      }
      this.container!.innerHTML = combined;
      this.postProcessRendered(this.container!);
      return;
    }
    /* Virtualized: page 1 real (its box sizes every placeholder — CSS gives
       .score-page `width: max-content`, so an empty placeholder needs explicit
       dims to hold the grid). Sizes are set after insertion, BEFORE any
       observer exists, so a zero-height placeholder can never look "visible".

       MEASURE THE PAGE DIV, AFTER finishPageMount — not the inner SVG, before.
       A placeholder must predict the box the page will have once MOUNTED,
       because mountPage drops the explicit dims and lets the page size to its
       own content. Two things made the old measurement fall short of that:
       the .score-page div is taller than the SVG it wraps (2794 → 2796 px on
       the sonata, every page), and finishPageMount's crisp pinning runs after.
       Every page therefore GREW 2 px the moment it mounted — 56 px across the
       sonata — so each full render, which rebuilds the whole placeholder grid,
       shifted the document under the reader by a few px as pages re-mounted.
       Splices never touch the grid, which is why only fallbacks drifted
       (cb-sweep.js: 34 of 42 full renders, 3 of 65 splices). */
    /* The swap below momentarily leaves every non-first page as an EMPTY
       zero-height div, and the getBoundingClientRect that measures page 1
       forces layout in that collapsed state — the browser clamps the
       container's scrollTop to the one-page extent, and the clamp survives
       the placeholder re-sizing (probe-confirmed on the sonata: 25392 → 2744
       across a content-identical edit). Capture the scroll position first and
       restore it once the grid is back — in this same synchronous block, and
       BEFORE mountVisiblePages, so the pages at the restored position are the
       ones that mount. A legitimately shorter document just re-clamps. */
    const keepTop = this.container!.scrollTop;
    const keepLeft = this.container!.scrollLeft;
    let html = '<div class="score-page" data-page="1">' + this.tk!.renderToSVG(1, {}) + '</div>';
    for (let i = 2; i <= pages; i++) {
      html += '<div class="score-page score-page-pending" data-page="' + i + '"></div>';
    }
    this.container!.innerHTML = html;
    const p1 = this.container!.querySelector('.score-page[data-page="1"]') as HTMLElement;
    this.pageVirt = {
      mei: data, options, pageCount: pages,
      pageW: 0, pageH: 0,
      mounted: new Set([1]), io: null, tkCurrent: true, stalePages: new Set(),
    };
    this.finishPageMount(p1);
    const box = p1.getBoundingClientRect();
    const pageW = box.width || 800, pageH = box.height || 1000;
    for (const div of Array.from(this.container!.querySelectorAll('.score-page-pending'))) {
      (div as HTMLElement).style.width = pageW + 'px';
      (div as HTMLElement).style.height = pageH + 'px';
    }
    this.pageVirt.pageW = pageW;
    this.pageVirt.pageH = pageH;
    this.container!.scrollTop = keepTop;
    this.container!.scrollLeft = keepLeft;
    this.setContainerThemeTags();
    this.mountVisiblePages();
    this.armPageIo();
  }

  /* ── page-view virtualization (T2.1) ─────────────────────────────────────── */

  /** Drop virtualization state (the page DOM it describes is going away). */
  private disposePageVirt(): void {
    this.pageVirt?.io?.disconnect();
    this.pageVirt = null;
  }

  /** Reload the page layout into the live toolkit if something else (a scroll
   *  engrave, PDF export via toolkit()) replaced it — lazy mounts render from
   *  tk. One loadData (~1 s on the sonata), then mounts are cheap again. */
  private ensureTkHoldsPageLayout(forPage?: number): boolean {
    const st = this.pageVirt;
    if (!st) return false;
    /* Only a page a splice actually edited needs fresh data; every other page
       is untouched, so mounting it from the loaded layout is both correct and
       free. Rebuilding costs a whole-document serialize + pin + loadData
       (~600 ms on the sonata) — never pay it speculatively. */
    const needsFresh = forPage === undefined ? st.stalePages.size > 0 : st.stalePages.has(forPage);
    if (needsFresh) {
      const mei = this.pinnedMeiForCurrentModel();
      if (mei === null) return false;
      /* Data and options travel together — loading pinned MEI under the
         previous strategy's options (or vice versa) would repaginate the
         whole document. */
      st.mei = mei;
      st.options = this.buildOptions(this.pageBreaks.paginationOwned() ? 'encoded' : 'line');
      st.stalePages.clear();
      st.tkCurrent = false;
    }
    if (st.tkCurrent) return true;
    this.tk!.setOptions(st.options);
    if (!this.tk!.loadData(st.mei)) return false;
    st.tkCurrent = true;
    return true;
  }

  /** Render one pending page's real SVG into its placeholder + run the full
   *  per-page post pass. Idempotent per page. */
  private mountPage(p: number): void {
    const st = this.pageVirt;
    if (!st || st.mounted.has(p) || !this.container) return;
    const div = this.container.querySelector('.score-page[data-page="' + p + '"]') as HTMLElement | null;
    if (!div) return;
    if (!this.ensureTkHoldsPageLayout(p)) return;
    st.mounted.add(p);
    div.innerHTML = this.tk!.renderToSVG(p, {});
    div.classList.remove('score-page-pending');
    /* The SVG defines the box now; a page later grown by a section-header
       injection (viewBox growth) must not be clipped by the placeholder dims. */
    div.style.removeProperty('width');
    div.style.removeProperty('height');
    st.io?.unobserve(div);
    this.finishPageMount(div);
  }

  /** Shared per-page post pass: crisp pinning/notehead/HEJI/theme, then the
   *  main.ts page injections (exactly once per mount — they aren't idempotent). */
  private finishPageMount(div: HTMLElement): void {
    this.postProcessRendered(div);
    this.onPageMountedCb?.(div);
  }

  /** Mount every pending page whose box lies within one page-height of the
   *  viewport. Synchronous — used at render/restore time so what the user is
   *  looking at is never a blank placeholder. */
  private mountVisiblePages(): void {
    const st = this.pageVirt;
    if (!st || !this.container) return;
    const view = this.container.getBoundingClientRect();
    const pad = st.pageH;
    for (const div of Array.from(this.container.querySelectorAll('.score-page-pending'))) {
      const r = (div as HTMLElement).getBoundingClientRect();
      if (r.bottom >= view.top - pad && r.top <= view.bottom + pad) {
        this.mountPage(Number((div as HTMLElement).dataset.page));
      }
    }
  }

  /** (Re)arm the lazy-mount observer over the current pending placeholders. */
  private armPageIo(): void {
    const st = this.pageVirt;
    if (!st || !this.container) return;
    st.io?.disconnect();
    st.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        this.mountPage(Number((e.target as HTMLElement).dataset.page));
      }
    }, { root: this.container, rootMargin: '100% 0px 100% 0px' });
    for (const div of Array.from(this.container.querySelectorAll('.score-page-pending'))) {
      st.io.observe(div);
    }
  }

  /** Container-level theme tags (#score attr + transparent class) — the theme
   *  CSS keys on #score, not on the per-page wrappers that postProcessRendered
   *  tags in the virtualized path. */
  private setContainerThemeTags(): void {
    if (!this.container) return;
    if (this.theme === 'light') delete this.container.dataset.notationTheme;
    else this.container.dataset.notationTheme = 'dark';
    this.container.classList.toggle('theme-transparent', this.theme === 'transparent');
  }

  /* ── scroll-mode single-system render ────────────────────────────────────── */

  /** Render the whole score as one continuous system into the container (no
   *  .score-page wrapper — the bare SVG sits directly in #score, styled by the
   *  `#score.view-scroll svg` CSS). This is the persistent SVG that edits will
   *  spot-splice into (Phase B); for now every render re-engraves it whole. */
  private renderSingleSystem(mei: string): void {
    /* The live toolkit now holds the scroll layout — a stashed page DOM's lazy
       mounts must reload theirs first (ensureTkHoldsPageLayout). */
    if (this.pageVirt) this.pageVirt.tkCurrent = false;
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
    /* Measure-index → xml:id map for ensureMeasureMounted (page mode). Cheap
       (one childNodes walk), refreshed every render so it can't go stale. */
    this.measureIds = model.allMeasures().map((m) => m.getAttribute('xml:id') ?? '');
    this.lastModel = model;
    const heji = { hejiEnabled: model.getHejiEnabled() };
    let preMei: string | null = null;
    if (this.lastRenderedMode !== null && this.lastRenderedMode !== this.viewMode) {
      preMei = model.serialize(heji, viewStaves);
      if (this.stashAndRestore(preMei)) return false;
    }
    const t0 = performance.now();
    if (this.viewMode === 'scroll') {
      const tookFull = this.renderScroll(model, viewStaves, preMei);
      if (tookFull) this.lastFullMs.scroll = performance.now() - t0;
    } else {
      const tookFull = this.renderPageComposer(model, viewStaves, preMei, heji);
      if (tookFull) this.lastFullMs.page = performance.now() - t0;
      /* Whatever path ran, the partition now on screen is the right one for
         this layout budget — cache it so returning to this zoom/page scale on
         an unchanged document skips the castoff pass (A4). */
      if (viewStaves == null) this.rememberPartition(model);
    }
    this.lastRenderedMode = this.viewMode;
    return true;
  }

  /** Page-view composer render: line-break-owned refill when the edit is
   *  provably local (adopted partition + narrow dirty union + unchanged user
   *  breaks/head/interior context), else a derive render (today's strategies)
   *  that re-arms lazy partition adoption. See render/linebreaks.ts. A refill
   *  lands as a SYSTEM SPLICE (Phase C-B, render/pagesplice.ts) when its
   *  gates hold — no full-doc loadData at all; otherwise the full refill
   *  render. Returns true when a full engrave happened (lastFullMs evidence —
   *  splices and no-op skips must not poison the heaviness predictor). */
  private renderPageComposer(
    model: ComposerModel, viewStaves: number[] | null, preMei: string | null,
    heji: { hejiEnabled: boolean },
  ): boolean {
    if (viewStaves == null && this.pageBreaks.canAttemptRefill()) {
      const refill = this.pageBreaks.tryRefill(model, viewStaves, this.pageBreaksCtx());
      if (refill) {
        /* Splice/no-op only when the mounted DOM is the page render the
           committed partition describes: never across a view-mode switch
           (preMei non-null — the container may hold the OTHER mode's DOM,
           where measure ids resolve into the wrong frame). */
        const pageDomLive = preMei === null && this.pageVirt !== null
          && this.container!.querySelector('.score-page svg') !== null;
        /* A splice replaces systems inside the EXISTING page grid, so it is
           only valid while the pagination it renders under is unchanged. */
        const paginationHeld = refill.oldPageStartIds.join() === refill.newPageStartIds.join();
        if (pageDomLive && paginationHeld) {
          if (refill.changedRun === null) {
            /* Signature-identical doc (head/user-break/interior guards all
               passed) — the mounted DOM already renders exactly this. */
            this.pageSplicer.noteNoop();
            this.lastPageSpliced = true;   // DOM untouched — the fastest path there is
            return false;
          }
          if (this.pageSplicer.trySplice(model, refill, this.pageSpliceCtx())) {
            /* A splice that MOVED systems (B1's dy-cascade) can push its page
               past the paper. Verovio won't re-paginate for us under pinned
               <pb>, so the same rule the pinned full-render path uses applies
               here: a spill means our page assignment is wrong, and the honest
               response is to hand pagination back rather than draw a clipped
               page. Scoped to the edited pages — nothing else moved. */
            const vp = this.pageSplicer.lastVertical;
            if (vp && !vp.static) {
              const spill = this.overflowingPage(this.pageSplicer.lastPages);
              if (spill !== 0) {
                console.warn('[page-splice] cascade overflows page ' + spill + ' — returning pagination to Verovio (derive)');
                this.pageBreaks.invalidate();
                this.renderPage(model.serialize(heji, viewStaves), true);
                if (this.pageVirt) {
                  this.pageBreaks.armAdoption(model, this.pageVirt.pageCount, this.pageBreaksCtx());
                }
                this.lastPageSpliced = false;
                return true;
              }
            }
            /* The mounted pages now show the edit but the toolkit's layout —
               and pageVirt.mei — still describe the pre-edit document; a lazy
               mount must rebuild before drawing (pageVirt.stale). Its options
               become the pinned 'line' ones the rebuilt data expects, whatever
               strategy the last full render used. */
            /* Mark ONLY the edited pages. The live toolkit is untouched by a
               splice (it renders through spliceTk), so it still holds a valid
               layout for every other page — clearing tkCurrent here would
               force a needless ~600 ms reload on the next lazy mount. `mei`
               and `options` stay paired with that layout and are replaced
               together when a stale page actually needs mounting. */
            if (this.pageVirt) {
              for (const p of this.pageSplicer.lastPages) this.pageVirt.stalePages.add(p);
            }
            this.lastPageSpliced = true;
            this.pageBreaks.verifyRenderedPartition(
              this.container!, model, this.pageVirt?.pageCount ?? 1, this.pageBreaksCtx());
            return false;
          }
          console.info('[page-splice] not spliceable (' + this.pageSplicer.lastSkipReason + ') — full refill render');
        }
        const pinned = refill.mei();
        if (pinned !== null) {
          this.renderPage(pinned, true, refill.strategy);
          /* The refill layout is now in the toolkit — the committed partition
             describes it directly, no idle adoption needed. Verify the pins were
             honored on the mounted pages (a safety net for castoff overrides —
             warn + re-adopt; throws under HKL_INDEX_CHECK). */
          this.pageBreaks.verifyRenderedPartition(
            this.container!, model, this.pageVirt?.pageCount ?? 1, this.pageBreaksCtx());
          /* Owned pagination has no safety net inside Verovio — check it here
             and hand the pages back if ours don't fit. */
          this.lastPageSpliced = false;
          const spill = this.overflowingPage();
          if (spill !== 0) {
            console.warn('[page-breaks] pinned page ' + spill + ' overflows its box — returning pagination to Verovio (derive)');
            this.pageBreaks.invalidate();
            this.renderPage(model.serialize(heji, viewStaves), true);
            if (this.pageVirt) {
              this.pageBreaks.armAdoption(model, this.pageVirt.pageCount, this.pageBreaksCtx());
            }
          }
          return true;
        }
        console.warn('[page-breaks] pin injection failed (missing id) — derive render');
        this.pageBreaks.invalidate();
      } else if (this.pageBreaks.ownershipActive()) {
        console.info('[page-breaks] refill unavailable for this edit — derive render');
      }
    }
    this.derivePageRender(model, viewStaves, preMei, heji);
    this.lastPageSpliced = false;
    return true;
  }

  /** Page-fit check for OWNED pagination. Verovio re-paginates by height only
   *  while it owns the pages; once `<pb>` pins decide them it will happily draw
   *  a page past its own rectangle. So after any pinned full render, every
   *  mounted page's content must still sit inside its box — a violation means
   *  our page assignment is wrong, and the honest response is to hand
   *  pagination back to Verovio (derive + re-adopt) rather than show a clipped
   *  page. Returns the first offending page number, or 0 when all fit. */
  private overflowingPage(only?: readonly number[]): number {
    if (!this.container) return 0;
    for (const pageEl of Array.from(this.container.querySelectorAll('.score-page:not(.score-page-pending)'))) {
      if (only && !only.includes(Number((pageEl as HTMLElement).dataset.page))) continue;
      const svg = pageEl.querySelector('svg');
      if (!svg) continue;
      const systems = Array.from(pageEl.querySelectorAll('g.system'));
      if (!systems.length) continue;
      const box = svg.getBoundingClientRect();
      const last = systems[systems.length - 1].getBoundingClientRect();
      /* Tolerance: a system's bbox includes hanging content that legitimately
         reaches into the bottom margin. Only a real spill (past the paper)
         counts. */
      if (last.bottom > box.bottom + 2) return Number((pageEl as HTMLElement).dataset.page) || -1;
    }
    return 0;
  }

  /** Serialize the live model and inject the line-break owner's CURRENT pins —
   *  the data a lazy mount must load after a splice. Null when no model has
   *  rendered yet or the partition can't be pinned. */
  private pinnedMeiForCurrentModel(): string | null {
    const model = this.lastModel;
    if (!model) return null;
    const mei = model.serialize({ hejiEnabled: model.getHejiEnabled() }, null);
    return this.pageBreaks.pinRenderMei(mei);
  }

  /** Derive render: let Verovio cast off, ADOPT that partition, and paint the
   *  PINNED render of it — so the castoff pass is an internal bootstrap and
   *  every pixel the user ever sees comes from the same break algorithm as the
   *  splice windows ('encoded'). Without this the derive painted castoff
   *  spacing while windows rendered encoded, and the first edit after every
   *  load/zoom/fallback had to full-render just to reconcile the two (Max,
   *  2026-08-30: that is first-interaction friction, not a harmless detail).
   *
   *  Cost on the sonata: first paint 1055 ms → ~1630 ms (one extra loadData),
   *  against removing a ~1830 ms idle SVG walk entirely — 44 % less total work
   *  — and removing ~650 ms from the first edit. Adoption reads the layout via
   *  page-based getMEI (~100 ms), which is what makes this affordable.
   *  Anything unreadable falls back to painting the castoff layout and arming
   *  the old idle walk, i.e. exactly today's behaviour. */
  /** Cache key for a line partition: the actual LAYOUT INPUTS, not the zoom
   *  label.
   *
   *  Measures-per-line is governed by `pageWidth / unit` — `pageWidth` comes
   *  from `scalePageGeom`, which scales by `pageScale` ONLY (never by zoom), and
   *  `unit` is the staff half-space the crisp preset picks. Verovio's `scale`
   *  is device magnification with no layout effect. So on the sonata zoom 50 and
   *  zoom 100 produce the IDENTICAL 118-line partition (both `unit: 9`) while
   *  zoom 75 produces 134 (`unit: 10` — music ~11 % larger against the same
   *  page). Keying on (unit, pageWidth) rather than zoom therefore lets a
   *  50 ↔ 100 switch REUSE the partition and skip the castoff, while 75
   *  correctly misses. HEJI is in the key because its accidental glyphs change
   *  widths, hence fills. The document is NOT — that is the `docVer` guard. */
  private partitionKey(model: ComposerModel): string {
    /* Keyed on the LAYOUT INPUTS, never the zoom label. `unit` is constant at 8
       across every zoom preset (see render-presets.ts "WHY unit 8"), so in
       practice this collapses to ONE entry for all zooms and every zoom change
       is a cache hit — the castoff pass runs once per document, not once per
       zoom. It stays in the key rather than being assumed: if a future preset
       ladder ever varies `unit` again, the cache stays correct instead of
       silently serving another unit's partition.
       `pageScale` stays EXPLICIT rather than being folded into a derived
       pageWidth: two scales can round to the same pageWidth but a different
       pageHeight, which changes PAGINATION (and we cache page starts too), so
       the coarser-but-safer term is the right one. */
    const unit = CRISP_PRESETS[this.zoom].unit;
    return `u${unit}|s${this.pageScale}|${model.getHejiEnabled() ? 'heji' : 'plain'}`;
  }

  /** Snapshot the committed partition for the current key, so returning to this
   *  zoom/page scale on an unchanged document can skip the castoff pass. Called
   *  after every page render that leaves ownership active — cheap (two id array
   *  copies), and `forceFullRerender`'s invalidate deliberately does NOT clear
   *  this, which is the whole point: the entry must outlive leaving the zoom. */
  private rememberPartition(model: ComposerModel): void {
    if (!this.pageBreaks.ownershipActive()) return;
    const lines = this.pageBreaks.lineStarts();
    if (lines.length <= 1) return;
    this.partitionCache.set(this.partitionKey(model), {
      docVer: model.docVersion(), lines, pages: this.pageBreaks.pageStarts(),
    });
    /* Bounded: one entry per (zoom, pageScale, heji) combination actually
       visited. Trim anyway so a scripted sweep can't grow it without limit. */
    if (this.partitionCache.size > 24) {
      const oldest = this.partitionCache.keys().next().value;
      if (oldest !== undefined) this.partitionCache.delete(oldest);
    }
  }

  private derivePageRender(
    model: ComposerModel, viewStaves: number[] | null, preMei: string | null,
    heji: { hejiEnabled: boolean },
  ): void {
    const data = preMei ?? model.serialize(heji, viewStaves);
    if (viewStaves != null) {
      /* Filtered view: a partition would describe a subset of the staves. */
      this.renderPage(data, true);
      this.pageBreaks.invalidate();
      return;
    }
    /* A partition we already computed for this exact layout budget, on a
       document that has not changed since, is still the right partition — so
       skip the castoff `loadData` (~1 s on the sonata) and paint the pinned
       render directly. A zoom round-trip is the common case. Anything that
       doesn't hold falls through to the castoff below, and the render is
       verified either way (verifyRenderedPartition + overflowingPage). */
    const cached = this.partitionCache.get(this.partitionKey(model));
    if (cached && cached.docVer === model.docVersion()
        && this.pageBreaks.restorePartition(model, cached.lines, cached.pages)) {
      const pinnedFromCache = this.pageBreaks.pinRenderMei(data);
      if (pinnedFromCache !== null) {
        this.renderPage(pinnedFromCache, true, 'encoded');
        this.pageBreaks.verifyRenderedPartition(
          this.container!, model, this.pageVirt?.pageCount ?? 1, this.pageBreaksCtx());
        if (this.overflowingPage() === 0) return;
        console.warn('[page-breaks] cached partition overflows its page — re-deriving');
      }
      this.partitionCache.delete(this.partitionKey(model));
      this.pageBreaks.invalidate();
    }
    /* Documents with USER page breaks need pagination computed per inter-break
       segment — see castoffSegmentedByUserBreaks for why a single pass cannot
       do it. Falls through to the ordinary castoff when unavailable. */
    const segmented = this.castoffSegmentedByUserBreaks(model, data, heji);
    if (segmented && this.pageBreaks.restorePartition(model, segmented.lines, segmented.pages)) {
      const pinnedSeg = this.pageBreaks.pinRenderMei(data);
      if (pinnedSeg !== null) {
        this.renderPage(pinnedSeg, true, 'encoded');
        this.pageBreaks.verifyRenderedPartition(
          this.container!, model, this.pageVirt?.pageCount ?? 1, this.pageBreaksCtx());
        const segSpill = this.overflowingPage();
        if (segSpill === 0) return;
        console.warn('[page-breaks] segmented pagination overflows page ' + segSpill
          + ' — falling back to the single-pass castoff');
      }
      this.pageBreaks.invalidate();
    }
    const plan = this.castoffPlan(data);
    /* Bootstrap pass: load only — never rendered to SVG, never painted. */
    this.tk!.setOptions(this.buildOptions(plan.strategy));
    if (this.tk!.loadData(plan.data) && this.pageBreaks.adoptFromCastoff(model, this.tk!)) {
      const pinned = this.pageBreaks.pinRenderMei(data);
      if (pinned !== null) {
        this.renderPage(pinned, true, 'encoded');
        this.pageBreaks.verifyRenderedPartition(
          this.container!, model, this.pageVirt?.pageCount ?? 1, this.pageBreaksCtx());
        const spill = this.overflowingPage();
        if (spill === 0) return;
        console.warn('[page-breaks] adopted pagination overflows page ' + spill + ' — painting Verovio\'s own layout instead');
        this.pageBreaks.invalidate();
      }
    }
    /* Fallback: paint the castoff layout itself and adopt from it lazily. */
    this.renderPage(plan.data, true, plan.strategy);
    if (this.pageVirt) {
      this.pageBreaks.armAdoption(model, this.pageVirt.pageCount, this.pageBreaksCtx());
    } else {
      this.pageBreaks.invalidate();
    }
  }

  /** Context the page system splicer drives Verovio + the post passes through. */
  private pageSpliceCtx(): PageSpliceCtx {
    /* The window MUST use the same display strategy as the live render, or
       spliced systems carry the other mode's justification (encoded vs line
       redistribute intra-line spacing by up to ~52 px — probed 2026-08-30).
       With pagination owned the live mode is 'encoded'; a window carries sb
       pins only, and 'encoded' paginates ONLY at encoded <pb>, so it lands on
       one page by construction (no tall-page trick needed). */
    const owned = this.pageBreaks.paginationOwned();
    const strategy = owned ? 'encoded' : 'line';
    const base = this.buildOptions(strategy, 'page');
    return {
      container: this.container!,
      toolkit: this.spliceTk!,
      /* With pagination owned the window uses the LIVE page options verbatim:
         'encoded' paginates only at the <pb> pins the window carries, so the
         tall-page trick is unnecessary — and the page geometry must match
         exactly, running header included. That band is what anchors a page's
         FIRST system (~419 units on the sonata); suppressing it made every
         window-page-first system read ~419 units too high, which is what the
         B1 vertical plan reads directly (see pagesplice.ts verticalPlan).
         Unowned pagination still needs the tall page: 'line' paginates by
         height and the window must land on one page. */
      windowOptions: owned
        ? base
        : { ...base, pageHeight: 60_000, adjustPageHeight: true, header: 'none' },
      liveOptions: () => base,
      postProcess: (el: HTMLElement) => this.postProcessRendered(el),
      decorateHost: (el: HTMLElement) => styleVoltaNumbers(el),
      snapPage: (el: HTMLElement) => this.snapSystems(el),
    };
  }

  /** Context the page line-break owner drives Verovio through. */
  private pageBreaksCtx(): PageBreaksCtx {
    return {
      layoutToolkit: () => (this.pageVirt?.tkCurrent ? this.tk : null),
      naturalsToolkit: () => this.spliceTk!,
      naturalsOptions: () => this.buildOptions('none', 'scroll'),
      budgetW: () => this.measureBudgetW(),
    };
  }

  /** Max justified system width (SVG user units) from the mounted page DOM. */
  private measureBudgetW(): number | null {
    if (!this.container) return null;
    let max = 0;
    for (const sys of Array.from(this.container.querySelectorAll('.score-page g.system'))) {
      const w = (sys as SVGGraphicsElement).getBBox().width;
      if (w > max) max = w;
    }
    return max > 0 ? max : null;
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
      /* A stashed page DOM keeps its pageVirt (it describes those nodes); the
         observer must not keep firing on detached placeholders. */
      if (outgoing === 'page' && this.pageVirt) {
        this.pageVirt.io?.disconnect();
        this.pageVirt.io = null;
      }
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
      /* Restored page DOM: mount anything now visible + re-arm lazy mounts. */
      if (this.viewMode === 'page' && this.pageVirt) {
        this.setContainerThemeTags();
        this.mountVisiblePages();
        this.armPageIo();
      }
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
  private renderScroll(model: ComposerModel, viewStaves: number[] | null, preMei: string | null = null): boolean {
    const heji = { hejiEnabled: model.getHejiEnabled() };
    const canSpliceNow = !this.forceFull && this.splicer.canSplice() && viewStaves == null;
    if (!canSpliceNow) {
      this.renderSingleSystem(preMei ?? model.serialize(heji, viewStaves));
      if (viewStaves == null) this.splicer.capture(model, this.spliceCtx());
      else this.splicer.invalidate();
      this.forceFull = false;
      return true;
    }
    if (this.splicer.splice(model, viewStaves, this.spliceCtx())) return false;
    console.warn('[scroll-splice] edit could not be spliced — full re-engrave (investigate)');
    this.renderSingleSystem(model.serialize(heji, viewStaves));
    this.splicer.capture(model, this.spliceCtx());
    return true;
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

  /** Page mode: mount the page holding this measure so rectForId / the cursor
   *  overlay can resolve it (a cursor move, scroll-into-view, or playback bar
   *  may target a page still held as a placeholder). Scroll mode renders the
   *  whole score in one SVG, so it's a no-op there. Call sites stay
   *  mode-agnostic. */
  ensureMeasureMounted(mi: number): void {
    const st = this.pageVirt;
    if (this.viewMode !== 'page' || !st) return;
    if (st.mounted.size >= st.pageCount) return;   // everything already real
    const id = this.measureIds[mi];
    if (!id) return;
    /* Already rendered → done. Checked BEFORE ensureTkHoldsPageLayout: locating
       an element needs the layout in tk, and reloading it costs ~1 s on a large
       doc — pure waste when the measure is visible anyway (e.g. the cursor
       measure right after a view-switch restore). */
    if (this.container?.querySelector('#' + CSS.escape(id))) return;
    if (!this.ensureTkHoldsPageLayout()) return;
    const p = this.tk!.getPageWithElement(id);
    if (p >= 1) this.mountPage(p);
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
