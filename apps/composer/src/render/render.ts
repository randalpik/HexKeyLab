// Verovio renderer: loads the WASM toolkit, owns the score container, exposes
// a single render(mei) entry point. View modes (page vs scroll) toggle the
// `breaks` and page-dimensions options; zoom selects a crisp preset
// (scale/unit/line-widths/margin parity — see @hkl/notation/render-presets) that
// keeps staff lines on the device-pixel grid at each zoom level.

import '@hkl/notation/verovio-types.js';
import type { VerovioToolkit } from '@hkl/notation/verovio-types.js';
import { injectHejiGlyphs } from '@hkl/notation/heji-render.js';
import { applyNotationTheme } from '@hkl/notation/verovio.js';
import { installMusicFont, MUSIC_FONT_OPTIONS } from '@hkl/notation/music-font.js';
import { CRISP_PRESETS, crispMarginTop, lineWidthOptions, pinExactScale, snapStaffLinesToGrid, snapBarlines, snapSystemRightEdge } from '@hkl/notation/render-presets.js';
import { pageFitConstants, measureExtents, placeSystems, foldIndex, translateOf, ExtentsStore, SECTION_HEADER_RESERVE, SECTION_HEADER_BASELINE, type PlacedSystem, type SysExtents, type PageFitConstants, type DistributeOpts, alignStaffRows } from './pagefit.js';
import { PageAssembler, type AssemblyHost } from './pageassembly.js';
import type { LineRenderCtx } from './systemrender.js';
import type { ShellGeom, ShellMeta } from './pageshell.js';
import { ScrollSplicer, snapshotSpanners, type SpliceCtx, type SpannerSnapshot } from './splice.js';
import { refreshLockMarks, LOCK_SELECTOR } from './lockmarks.js';
import { lockStartIds, type OwnerWidths } from './linebreaks.js';
import {
  PageLineBreaks,
  type PageBreaksCtx,
  scheduleIdle, FINAL_JUSTIFY_FILL, viewKeyOf, hardStartIds,
} from './linebreaks.js';
import { PageSystemSplicer, type PageSpliceCtx, type SpliceRequest } from './pagesplice.js';
import { buildWindowMei } from './pagesplice.js';
import { mergeGlyphDefs, expandForSpannersOnce, expandForEndings } from './splice.js';
import { hiddenStavesFor, visibleStavesFor, systemMeasureIdxs, renderedStaffNs } from './hiddenstaves.js';
import { layoutBelowStaffText } from './textlayout.js';
import { layoutInstrumentGaps, resetInstrumentGaps } from './instrgap.js';
import { styleTitleBlock } from './pageheader.js';
import { layoutFlippedSlurs, liftSlursOffShiftedNumerals } from './slurlayout.js';
import { layoutCollidingTies, restoreTieRedraws } from './tielayout.js';
import { layoutTupletNums } from './tupletnums.js';
import { repairBarLines } from './barlines.js';
import type { ComposerModel } from '../model/index.js';

function indexCheckEnabled(): boolean {
  return typeof globalThis !== 'undefined' &&
    (globalThis as { __HKL_INDEX_CHECK?: boolean }).__HKL_INDEX_CHECK === true;
}

/** Pagination-repair steps one edit may take before giving up (derive). Each
 *  step moves one page's spilled tail onto the next page; a chain this long
 *  means every page below the edit was full, which is a whole-document reflow
 *  by any name. */
const MAX_CASCADE_STEPS = 64;
/** Mount pump fast-scroll gate: a scrollTop change of more than this many
 *  viewport heights between two pump frames is a drag in progress — mount
 *  nothing, re-check next frame (see pumpMounts). */
const PUMP_FAST_VH = 0.5;
/** Displacement window for viewportMoving(): the view's travel over the last
 *  this-many ms is what is compared against PUMP_FAST_VH. */
const PUMP_VELOCITY_MS = 400;
/** A scroll event older than this means the view has settled: mount. A single
 *  jump (PageDown, scroll-into-view) has one recent sample and no travel, so
 *  it mounts on the very next frame; a drag has travel until it stops, then
 *  this much latency before its landing page draws. */
const PUMP_SETTLE_MS = 120;

/** First `g.system` child of a page's margin group, or null. */
function firstSystemOf(pageEl: HTMLElement): Element | null {
  const margin = pageEl.querySelector('svg g.page-margin');
  if (!margin) return null;
  return Array.from(margin.children).find((c) => c.classList.contains('system')) ?? null;
}

/** One page's vertical placement (render/pagefit.ts): its systems in DOM
 *  order, where the rule puts each, and the paper bottom in the page-margin
 *  frame (what the fold is judged against). */
interface PlacedPage {
  systems: Element[];
  placed: PlacedSystem[];
  paperBottom: number;
}

/** How a placement pass should treat the page's slack. Omitted (or
 *  `distribute: false`) gives rule v1 — minimum clearance — which is what the
 *  fold is judged on. `pageNo` is only consulted to keep page 1's first system
 *  fixed relative to its title block. */
interface PlaceOpts {
  distribute?: boolean;
  pageNo?: number;
}

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
  /** The page assembler that describes a stashed page DOM. */
  assembler: PageAssembler | null;
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
/** Verovio `dynamDist` (units); see BASE_OPTIONS. Exported so the PDF export
 *  and the below-staff text layout share it. */
export const DYNAM_DIST = 4.5;
/** SVG user units of clearance a <dir> keeps below its staff, per Verovio
 *  unit: the probed top of a dynamic glyph at `dynamDist` d is 80·d − 168
 *  user units below the bottom line at unit 8 (d=3 → 72, d=4 → 152), so 4.5
 *  puts it 192 down — 24 per unit. A staff space is 2 units (160 user units
 *  here), so that is 1.2 spaces: a "p" then sits with its centre about two
 *  spaces below the line. 3.5 (0.7 space) read as "a few px" (Max, 2026-09-05). */
export const DIR_GAP_PER_UNIT = 24;
/** Verovio `defaultBottomMargin` (units); see BASE_OPTIONS. Shared with the
 *  PDF export. */
export const DEFAULT_BOTTOM_MARGIN = 2.0;

const SCROLL_GEOM = {
  pageWidth: 100_000,
  pageHeight: 60_000,
  pageMarginTop: 30,
  pageMarginBottom: 30,
  pageMarginLeft: 30,
  pageMarginRight: 30,
};

const BASE_OPTIONS = {
  /* `staff@n` + the control events' `@staff`/`@place` feed the below-staff text
     layout (render/textlayout.ts): Verovio otherwise emits g.dynam/g.dir/
     g.hairpin with no trace of which staff they belong to. Verovio prefixes
     each with `data-` in the SVG (`data-n`, `data-staff`, `data-place`). */
  svgAdditionalAttribute: ['note@data-q', 'note@data-r', 'note@color', 'note@data-light-color', 'note@hkl-paren-caut', 'rest@data-tuplet-placeholder', 'rest@visible', 'rest@data-hkl-cosmetic', 'accid@type',
    'staff@n', 'dynam@staff', 'dynam@place', 'dir@staff', 'dir@place', 'hairpin@staff', 'hairpin@place',
    /* Tempo marks join the above-staff slur-clearance rule (render/textlayout.ts). */
    'tempo@staff', 'tempo@place',
    /* The inter-instrument shift pass (render/instrgap.ts) has to attribute
       every element of a system to an instrument. Staves carry `staff@n` and
       the text marks carry `@staff`, but a TIE is ambiguous by geometry — of
       the sonata's 290, 131 sit in the piano's band, 43 in the viola's, 72 in
       the inter-instrument gap and 44 above every staff (instrument-gap-census.js) — so
       it needs its start note. fermata/trill/lv are note-anchored in our MEI
       (`@startid`, no `@staff` — probed) so they resolve the same way; <octave>
       does carry `@staff`. (grpSym and label are unambiguous by band, and
       mNum / ending / voltaBracket ride the top staff.) */
    'tie@startid', 'fermata@startid', 'trill@startid', 'lv@startid', 'octave@staff',
    /* `@tstamp` (as `data-tstamp`) tells the same-moment un-stack rule in
       render/textlayout.ts which marks genuinely share an anchor — Verovio
       stacks those vertically, and only an identical anchor (not merely
       overlapping boxes) justifies laying them out side by side instead. That
       rule is now the FALLBACK: notation/unstack.ts separates such a group on
       the render clone (before the engrave, so Verovio sizes the inter-staff
       gap for one row instead of the stack), which leaves the pair no longer
       sharing a tstamp — so each mover names its anchor outright in
       `hkl-unstack` (`data-hkl-unstack`) for textlayout's clearance
       fine-tune. */
    'dynam@tstamp', 'dir@tstamp', 'dir@hkl-unstack',
    /* The flipped-slur re-draw (render/slurlayout.ts) needs each slur's side
       and endpoints: `data-curvedir`, `data-startid`, `data-endid`. */
    'slur@curvedir', 'slur@startid', 'slur@endid',
    /* The stem-unifying pass (notation/slurStems.ts) tags each slur it
       handled (`data-hkl-stems`) for the census probe. */
    'slur@hkl-stems',
    /* …and `layer@n` (`data-n` on g.layer) for the covered notes of a slur
       segment broken at a system break. */
    'layer@n',
    /* `data-grace` scales the cursor's offset past a grace (CursorRectQuery.
       isGrace in @hkl/shared/cursor-geom). */
    'note@grace', 'chord@grace'],
  footer: 'none',
  /* Multimeasure rests (model/multirest.ts): Finale's thick bar + count. */
  multiRestStyle: 'block',
  /* Verovio's own "hide empty staves" optimizer is note-driven and global
     (a staff hides on a system when no measure on it has a <note>) and its
     `auto` default switches itself on for any scoreDef with two group symbols.
     Composer hides staves per region itself (render/hiddenstaves.ts), so pin
     it OFF — a second bracketed group must not start hiding rest-only staves. */
  condense: 'none',
  /* Dynamics sit further below the staff than Verovio's default quarter of a
     staff space (2026-09-04; backlog: "more space between the staff and the
     text by default"). Verovio measures `dynamDist` (units) to the glyph's own
     reference, and the glyph's top only starts to move past 2: probed 1→40,
     2→40, 3→72, 4→152 SVG units below the bottom line at unit 8 (a staff
     space is 160). 4.5 puts the top of a "p" 1.2 spaces down (3.5 → 0.7 was
     still "a few px", Max 2026-09-05). <dir> ignores this option; the
     text-layout pass gives it the same clearance. */
  dynamDist: DYNAM_DIST,
  /* Clearance between elements that COLLIDE across a staff boundary — the
     viola's dynamics against the piano's high notes, the piano's low right-hand
     content against its left hand (2026-09-05; backlog: "lack of gap between
     elements that overflow in the area between instruments"). Verovio widens a
     staff distance only as far as the colliding boxes plus their margins, and
     the default margin is half a unit (a quarter of a staff space). This is the
     bottom margin every element without a dedicated margin option gets: probed
     at 0.5/1.0/1.5/2.5 the dynamic→note clearance went 39/79/119/199 user
     units while an UNCOLLIDED staff pair stayed at Verovio's 960 — so it
     targets exactly the overflow case and nothing else. 2.0 ≈ one staff space.
     `defaultTopMargin` had no effect on that clearance (only the upper
     element's bottom margin counts) and is left alone. A `staffDef@spacing`
     minimum was tried first and reverted: it widened the gap between EMPTY
     staves and left the collision case unchanged. */
  defaultBottomMargin: DEFAULT_BOTTOM_MARGIN,
  /* No indentation / inter-element newlines in the SVG string (A9, 2026-09-01).
     Whitespace-only: element count and rendering are identical (a since-deleted probe:
     18 055 nodes either way), but the string is ~40% smaller and the browser's
     `innerHTML` / DOMParser parse ~36% faster — every window, naturals and page
     render pays that parse — and the live DOM carries no whitespace text nodes.
     Nothing in the composer walks whitespace-sensitive siblings. */
  svgFormatRaw: true,
  /* Leipzig for the score (rests, noteheads, G/F clefs), Bravura for the C-clef
     family: the custom "LeipzigHkl" font (@hkl/notation music-font.ts),
     registered on each toolkit by installMusicFont. Accidentals are re-rendered
     in BravuraText by injectHejiGlyphs so they're uniform with the injected HEJI
     glyphs; a global font:'Bravura' would restyle the rests, which read worse.
     See docs/lessons.md. */
  ...MUSIC_FONT_OPTIONS,
};

class Renderer {
  private tk: VerovioToolkit | null = null;
  /** Dedicated toolkit for the splicer's offscreen renders (calibration +
   *  sub-renders). Verovio's setOptions + loadData mutate per-instance state,
   *  so reusing `tk` would pollute the live score's toolkit — see the chunk-era
   *  lesson (dedicated chunkTk). Kept entirely separate. */
  private spliceTk: VerovioToolkit | null = null;
  /** The content frame (`div.score-content`, made by attach() inside #score):
   *  every rendered page card / scroll SVG and the cursor overlay live in it,
   *  and rectForId measures against it. Page view centres THIS element, so a
   *  change of #score's width moves cards and overlay together. */
  private container: HTMLElement | null = null;
  /** #score: the scrolling viewport — scroll offsets, viewport rects, the
   *  mount observer's root, and the theme tags the CSS keys on. */
  private scroller: HTMLElement | null = null;
  private viewMode: ViewMode = 'page';
  private zoom: ZoomLevel = 100;
  /** Document page-size factor (ratio; 1 = default US Letter). Scales the page
   *  rectangle in page view only — content stays at the crisp zoom size. */
  private pageScale = 1;
  /** Single-part view's staff subset (null = all), as of the last
   *  renderComposer: every serialize this renderer does on the model's behalf
   *  — pins for lazy mounts, splice windows, the reference gate — must render
   *  the same staves as the page (2026-09-05). */
  private viewStaves: number[] | null = null;
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
  private partitionCache = new Map<string, {
    docVer: number; lines: string[]; pages: string[];
    /** The owner's width caches at the time (natural + leading-signature
     *  widths, zoom- and page-scale-independent). Restored with the lines so a
     *  zoom round-trip leaves the owner knowing exactly what it knew — without
     *  them every natural went cold and the edit-path balancer declined every
     *  section-final defect until reload (2026-09-12). */
    widths: OwnerWidths;
  }>();
  /** Mode the container's current content was rendered in (null before the
   *  first render). Drives the stash/restore branch in renderComposer. */
  private lastRenderedMode: ViewMode | null = null;
  /** Page-view virtualization state (T2.1, docs/composer-render-perf.md):
   *  which pages hold real SVG vs a fixed-size placeholder, the page box
   *  size, and whether the live toolkit still holds this layout (renderToSVG
   *  of a lazy page needs it). Describes the one page DOM wherever it lives —
   *  on screen or stashed by the mode cache — so it survives view switches. */
  /** The page assembler (render/pageassembly.ts): pages built from measured
   *  systems, first-fit, mounted and parked. Null until the first page render. */
  private assembler: PageAssembler | null = null;
  /** Lazy-mount observer over the page placeholders. */
  private pageIo: IntersectionObserver | null = null;
  /** The model of the last renderComposer — needed to rebuild page data for a
   *  lazy mount after a splice (see pageVirt.stale). Renders always pass it;
   *  this only makes it reachable from the mount path. */
  private lastModel: ComposerModel | null = null;
  /** Per-line extents recorded by every placement pass (Phase 1 of the
   *  vertical-ownership plan; Phase 2 reads it for pages that are not
   *  mounted). Dropped with the page DOM. */
  private extents = new ExtentsStore();
  /** How the last pagination repair landed, step by step (Phase 2 of the
   *  vertical-ownership plan) — fixtures and the sweep read it. A cascade step
   *  is a DOM TRANSPLANT when the receiving page is mounted, ARITHMETIC when it
   *  is a placeholder whose lines' extents are known, PARKED when they are not
   *  (the page draws the block and checks itself at mount), CREATED when a
   *  last page spilled. */
  lastCascade = { steps: 0, transplanted: 0, arithmetic: 0, parked: 0, created: 0, ms: 0, msFold: 0, msClone: 0, msMove: 0, msPlace: 0, msSnap: 0, msMount: 0 };
  /** Outcome of every page-view composer render, newest last, bounded
   *  (2026-09-02). The refill is command-agnostic — it diffs the document, not
   *  the command that changed it — but nothing ASSERTED that a given user
   *  command splices, and two paths were found deriving silently on one guard
   *  (`command-splice-inventory.js`: Ctrl+M insert-measure, section headers). The suite's
   *  splice invariant reads this, so "this edit quietly full-rendered" is a
   *  test failure instead of a latency mystery. */
  private ledger: Array<{ full: boolean; outcome: string; skipReason: string; deriveReason: string; ms: number }> = [];
  /** Measure xml:ids in document order (captured per renderComposer) —
   *  ensureMeasureMounted's index → id map. */
  private measureIds: string[] = [];
  /** The spanners the mounted DOM draws — the document as of the last
   *  renderComposer. Both splicers close an edit's run over it, so a spanner
   *  the edit removed has every segment replaced (splice.ts,
   *  `expandForRenderedSpanners`). */
  private spanners: SpannerSnapshot | null = null;
  /** Per-measure id of the measure that STANDS FOR it in the render: itself,
   *  or the first measure of its multimeasure-rest run (model/multirest.ts).
   *  Interior run members have no rendered `g.measure`; every DOM lookup by
   *  measure index must go through this, never `measureIds`. */
  private renderIds: string[] = [];
  /** Hook run once per mounted page (eager + lazy): main.ts wires its
   *  page-scoped injections (header/footer, section headers, volta styling,
   *  crisp snap). Injections are NOT idempotent (section headers translate
   *  systems), so only the mount path may run them — never a second pass. */
  private onPageMountedCb: ((pageEl: HTMLElement) => void) | null = null;
  /** Lock-id signature the mounted pages' padlocks were last drawn from
   *  (syncLockMarks). */
  private lastLockSig = '';
  /** Pending idle handle + latest cursor measure for updateMountWindow. */
  private mountWindowHandle: number | null = null;
  private mountWindowMi = -1;
  private mountWindowEnabled = true;
  /** The mount pump (2026-09-11). Pages the IntersectionObserver reported as
   *  entering the ±1-viewport band wait here to be mounted VISIBLE-FIRST, one
   *  per animation frame, against the CURRENT scroll position — never in the
   *  observer callback, which delivered them in DOM order and mounted every
   *  page a scrollbar drag had swept through the band (15 mounts, 2.6 s, before
   *  the page the user stopped on; see pumpMounts). */
  private pumpWanted = new Set<number>();
  private pumpHandle: number | null = null;
  /** Recent `scroll` samples of the container (top, wall time), read by
   *  viewportMoving(). Sampled from the event, not from pump frames: the pump
   *  goes idle after every frame of a drag, and the idle mount window runs
   *  between frames too, so a per-frame sample saw a "fresh jump" every time
   *  (probe: 9–15 mounts / 2.3–3.5 s on a drag). */
  private scrollSamples: Array<{ top: number; t: number }> = [];
  private scrollSampler: (() => void) | null = null;
  /** Duration of the last full engrave per mode (ms) — predictNextRenderHeavy's
   *  evidence. Splices and cache restores don't update it. */
  private lastFullMs: Partial<Record<ViewMode, number>> = {};
  /** Did the last page-view composer render land as a system splice? Drives
   *  predictNextRenderHeavy (a splice is ~300 ms — deferring it behind the
   *  busy badge costs two frames and flashes for nothing). Mirrors the scroll
   *  path's `willSplice` heuristic: evidence-based, and a wrong guess only
   *  means one un-badged slow render. */
  private lastPageSpliced = false;
  /** Page-view line-break ownership (docs/architecture/composer.md, Page view):
   *  the partition is adopted from each derive render and re-derived locally on
   *  edits (greedy refill + rebalance), pinned into the render MEI. The owner
   *  finds what changed via its own per-measure signature baseline — the
   *  model's renderDirty hint is never trusted here (its reset-then-narrow
   *  lifecycle can swallow an earlier mutation's 'all' under batch-mutate-
   *  then-render flows, e.g. the test runner's doc reset). */
  private pageBreaks = new PageLineBreaks();
  /** Page-view system splice (docs/architecture/composer.md, Page view):
   *  when a refill's edit is provably local, replace only the affected
   *  systems in the mounted page SVGs from a windowed offscreen render —
   *  skipping the full-doc loadData entirely. Stateless: everything it needs
   *  lives in the DOM + the refill result, so there is nothing to invalidate. */
  private pageSplicer = new PageSystemSplicer();
  /** > 0 while a splice or pagination cascade is running — mountPage must not
   *  start a nested repair from the splicer's own ensure-mounts. */
  private spliceDepth = 0;
  /** Page elements the current edit's splice + cascade touched (the test-mode
   *  reference gate verifies exactly these once numbering is final). */
  private touchedPages: HTMLElement[] = [];

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
      /* Before the first render: both toolkits draw score SVG (see BASE_OPTIONS). */
      Promise.all([installMusicFont(this.tk), installMusicFont(this.spliceTk)])
        .catch((e) => console.error('[composer] music font install failed; C clefs fall back to Leipzig', e))
        .finally(resolve);
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
  /** Verovio `minLastJustification` for page view (see its use in buildOptions). */
  private lastSystemJustification(): number {
    const j = this.pageBreaks.finalSystemJustified();
    return j === null ? FINAL_JUSTIFY_FILL : j ? 0 : 1;
  }

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
      /* pageMarginTop is a LAYOUT input and must NOT vary with zoom (2026-09-08).
         It used to be crispMarginTop(base, scale, evenWidth), which nudges the
         margin up to +1 unit at scale 50 and +3 at scale 75 to land the staff
         phase on its stroke parity. That changes the usable page height, so a
         pagination settled at 100 % OVERFLOWED at 75/50, which invalidated the
         cached partition and re-derived a different one — zoom silently
         re-paginating the document (31 pages -> 30 on the first zoom).
         It is also redundant in page view: `placeSystems` chooses the phase of
         the first staff row and `alignStaffRows` keeps every other row a whole
         device pixel from it (pagefit.ts), so crispness does not depend on the
         margin's parity here. */
      pageMarginTop: geom.pageMarginTop,
      ...breaksOpt,
      header: geomMode === 'page' ? 'auto' : 'none',
      /* Scroll trims the page to its single system; page uses fixed-height pages.
         Set EXPLICITLY every render — page and scroll share one toolkit and
         Verovio's setOptions persists unspecified options, so an unset
         adjustPageHeight would leak true from a prior scroll render into page. */
      adjustPageHeight: geomMode === 'scroll',
      /* The LAST system's justification is OUR rule, not Verovio's 0.8 default
         (Max, 2026-10-20; linebreaks.ts `finalSystemJustified`): always when
         the final section was balanced by F, and at fill ≥ FINAL_JUSTIFY_FILL
         when it stayed greedy (a final section of 1–2 lines). The owner
         decides it by its own fill and the option only carries the answer —
         0 justifies any width, 1 leaves an underfull line at its natural width
         — so no slack for Verovio's own ratio is needed (the 0.05 there used to
         be: the two yardsticks disagree by a few percent, lessons.md
         2026-09-02). Only the document's final line is Verovio's "last
         system": a section-final line justifies at any fill (measured on a
         two-section document: section-final 18790, document-final 4290), and
         a line window that does not end the document carries a trailer stub.
         Unknown (a width missing) falls back to the greedy threshold as
         Verovio's ratio.

         Scroll keeps Verovio's default: it renders the whole score as ONE
         system against a 100 000-unit page, so there is no line to justify to
         (measured: 43561 either way), and the line-break owner's naturals
         windows measure NATURAL widths at that geometry — justification there
         would corrupt the very measurement the partition is built from. Set
         explicitly in both branches for the reason adjustPageHeight is: page
         and scroll share one toolkit and Verovio's setOptions persists any
         option that is not re-specified. */
      minLastJustification: geomMode === 'page' ? this.lastSystemJustification() : 0.8,
      scale: preset.scale,
      unit: preset.unit,
      ...lineWidthOptions(preset),
    };
  }

  /** The `breaks` strategy the mounted pages were PAINTED with.
   *
   *  This has to be the paint's own predicate, not a related one. The pinned
   *  and refill renders force breaks:'encoded' whenever a LINE partition is
   *  pinned, but the splice context and the lazy-mount reload used to re-derive
   *  the strategy from `paginationOwned()` — which is PAGE ownership
   *  (`pageStartIds.length > 1`). For every single-page multi-line document the
   *  two disagreed: the DOM was painted 'encoded' while the splice window and
   *  the HKL_INDEX_CHECK reference were built 'line'. The window then engraved
   *  a replaced line under different options than the page it was spliced into,
   *  and the gate compared the result against a reference nobody had painted.
   *  Found 2026-09-03 by that gate, once Phase 3's context-line comparison
   *  stopped refusing such splices for unrelated reasons (a since-deleted probe
   *  reported `optDiff = breaks: stored 'encoded' vs live 'line'`).
   *
   *  Page ownership still governs what it should: whether pagination is
   *  Composer's to re-fit (PageAssembler.applyPartition). */
  private paintedBreaks(): 'line' | 'encoded' {
    return this.pageBreaks.ownershipActive() ? 'encoded' : 'line';
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
   *  See docs/architecture/composer.md (Page view). */
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

  /** Device-grid staff snap. NO LONGER PART OF THE PAGE RENDER PATH (Phase 3.5,
   *  2026-09-03): placement now puts every staff on the grid itself
   *  (`alignStaffRows` + the phase carried by `placeSystems`), so running this
   *  afterwards moved nothing — measured, 0 of 102 staves — while costing a DOM
   *  walk and a `getScreenCTM` per staff on every mount and every splice. It
   *  ran after placement and mutated the extents placement had just consumed,
   *  which is the defect §3.5 fixes. Kept as a diagnostic (probes assert it is
   *  a no-op); scroll view, the frame and the inset are crisped by
   *  `snapStaffLinesToGrid` directly in @hkl/notation, not through here. */
  snapSystems(container: HTMLElement): void {
    const preset = CRISP_PRESETS[this.zoom];
    snapStaffLinesToGrid(container, preset.scale, preset.evenWidth);
  }

  /* ── vertical placement: Composer owns height (Phase 1, 2026-09-02) ─────── */

  /** Ids of the measures that carry a section header in the current model. A
   *  header is a page component: a reserved band above the system that holds
   *  its measure (render/pagefit.ts). */
  private headerMeasureIds(): Set<string> {
    const ids = new Set<string>();
    const doc = this.lastModel?.getDoc();
    if (!doc) return ids;
    for (const m of Array.from(doc.querySelectorAll('measure[data-hkl-section-title]'))) {
      const id = m.getAttribute('xml:id');
      if (id) ids.add(id);
    }
    return ids;
  }

  /** First content top of a page: below its header element (Verovio's
   *  `g.pgHead` — the title on page 1, the autogenerated page number
   *  elsewhere) by the header gap; a page without one gets the calibrated
   *  default. Read on the page-margin group that holds the systems (a live
   *  page's, or a reference host's). */
  private firstContentTop(margin: Element | null, k: ReturnType<typeof pageFitConstants>): number {
    const hb = this.headBottomOf(margin);
    return hb === null ? k.C0 : hb + k.headerGap;
  }

  /** Ink bottom of the page's header element, or null when it has none. Rule
   *  v2 measures the top gap from here, so it is read once and shared with
   *  `firstContentTop` rather than derived twice. */
  private headBottomOf(margin: Element | null): number | null {
    const hd = margin?.querySelector(':scope > g.pgHead') as SVGGraphicsElement | null;
    if (!hd) return null;
    /* The running-header restyle (main.ts `styleRunningHeader`) records the
       header's ORIGINAL ink bottom before it touches the text: the restyled
       "2" reads one unit lower than Verovio's "– 2 –" (the dash glyph cells
       differ), and that unit moved rule v2's distribution enough to flip a
       pixel on re-placed pages while the reference — a fresh render, never
       restyled — did not move (gated sonata sweep, 6 divergences of exactly
       10 units, 2026-09-04). Placement must see the same header on every
       host, so it prefers the recorded value. */
    const kept = hd.getAttribute('data-hkl-head-bottom');
    if (kept !== null && isFinite(Number(kept))) return Number(kept);
    try {
      const bb = hd.getBBox();
      if (!(bb.height > 0)) return null;
      return bb.y + bb.height + translateOf(hd).ty;
    } catch { return null; }
  }

  /** Bottom of the content column (the bottom-margin line) in the page-margin
   *  frame — what rule v2 fills to, and what the fold is judged against. The
   *  PAPER edge is one bottom margin further down; using it as the fold limit
   *  let a repaired page hold a system a fresh castoff would not (measured:
   *  sonata pages 6, 17 and 19), so both now stop at the column. */
  private contentBottomOf(margin: Element | null): number | null {
    const frame = margin?.closest('svg') ?? null;
    if (!margin || !frame) return null;
    const vb = (frame.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    if (vb.length !== 4 || !isFinite(vb[3])) return null;
    return vb[3] - translateOf(margin).ty - 10 * PAGE_GEOM.pageMarginBottom * this.pageScale;
  }

  /** Measure the given laid-out systems and place them by Composer's rule,
   *  writing nothing. Null when a system has no readable extents. */
  /** Placement constants for the live zoom and staff set. The one source for
   *  both placement and first-fit pagination: they must agree on every gap or
   *  a page the fold accepted would overflow when placed. */
  private fitConstants(): PageFitConstants {
    const p = CRISP_PRESETS[this.zoom];
    const staves = this.lastModel ? visibleStavesFor(this.lastModel, this.viewStaves, []) : [];
    return pageFitConstants(p.unit, p.scale, p.evenWidth, staves.length === 1);
  }

  private measureAndPlace(systems: Element[], opts?: PlaceOpts): { placed: PlacedSystem[]; exts: SysExtents[] } | null {
    const headers = this.headerMeasureIds();
    const k = this.fitConstants();
    const y0 = this.firstContentTop(systems[0]?.parentElement ?? null, k);
    const headBottom = this.headBottomOf(systems[0]?.parentElement ?? null);
    const items: Array<{ ext: SysExtents; reserve: number }> = [];
    for (const sys of systems) {
      const ext = measureExtents(sys as SVGGraphicsElement);
      if (!ext) return null;
      let reserve = 0;
      for (const m of Array.from(sys.querySelectorAll('g.measure'))) if (headers.has(m.id)) reserve += SECTION_HEADER_RESERVE;
      items.push({ ext, reserve });
    }
    const margin = systems[0]?.parentElement ?? null;
    let dist: DistributeOpts | null = null;
    if (opts?.distribute) {
      const contentBottom = this.contentBottomOf(margin);
      if (contentBottom !== null) {
        dist = { contentBottom, headBottom: headBottom ?? 0, allowTopGap: opts.pageNo !== 1 };
      }
    }
    return { placed: placeSystems(items, k, y0, this.marginPhase(margin), dist), exts: items.map((i) => i.ext) };
  }

  /** Read-only placement of the given systems (the reference gate's
   *  expectation, the fold's prediction). */
  placeFor(systems: Element[], opts?: PlaceOpts): PlacedSystem[] | null {
    return this.measureAndPlace(systems, opts)?.placed ?? null;
  }

  /** Systems of a page in DOM order, with the paper bottom in the page-margin
   *  frame (the box's height minus the margin group's offset). */
  private pageSystems(pageEl: HTMLElement): { svg: SVGSVGElement; margin: Element; systems: Element[]; paperBottom: number; contentBottom: number | null } | null {
    const svg = pageEl.querySelector('svg');
    const margin = svg?.querySelector(':scope > g.page-margin') ?? svg?.querySelector('g.page-margin') ?? null;
    if (!svg || !margin) return null;
    const systems = Array.from(margin.children).filter((c) => c.classList.contains('system'));
    /* The page-margin group lives in Verovio's INNER `definition-scale` svg,
       whose viewBox is the paper in the same user units (×10 the outer box). */
    const frame = margin.closest('svg') ?? svg;
    const vb = (frame.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    const boxH = vb.length === 4 && isFinite(vb[3]) ? vb[3] : 0;
    return { svg, margin, systems, paperBottom: boxH - translateOf(margin).ty, contentBottom: this.contentBottomOf(margin) };
  }

  /** The vertical placement pass: Composer OWNS height. Every system on the
   *  page is measured (post-processed bbox + staff-line frame) and placed by
   *  ONE rule (`placeSystems`, render/pagefit.ts); a section header is a
   *  reserved band above its system. Writes each system's translate — only
   *  when it moves by more than 0.01 units, so a survivor on a re-placed page
   *  is left alone — stamps `data-hkl-band-top` on header systems for the
   *  title injector, puts the titles already on the page into their bands, and
   *  records the extents per line. Runs on every mount (finishPageMount) and
   *  after every splice, BEFORE the snap (the snap's ≤ ½ px staff shifts would
   *  otherwise be undone), so a derive's page and a spliced page agree by
   *  construction. Needs layout; the caller's flush covers it. */
  placePage(pageEl: HTMLElement): PlacedPage | null {
    const ps = this.pageSystems(pageEl);
    if (!ps || !ps.systems.length) return null;
    /* Own the staff, not just the system (2026-09-03): put every staff row on
       its crisp device phase FIRST, so `measureExtents` reads geometry nothing
       will move again. Doing this after placement — which is what the separate
       `snapStaffLinesToGrid` pass did — invalidated the very extents placement
       had consumed. See docs/architecture/composer.md (Page view, vertical placement) and lessons.md. */
    this.alignPageStaves(ps.margin, ps.systems);
    const mp = this.measureAndPlace(ps.systems, { distribute: true, pageNo: Number(pageEl.dataset.page) });
    if (!mp) {
      console.warn('[page-fit] page ' + pageEl.dataset.page + ': a system has no readable extents — not placed');
      return null;
    }
    const { placed, exts } = mp;
    for (let i = 0; i < ps.systems.length; i++) {
      const sys = ps.systems[i];
      const { tx, ty } = translateOf(sys);
      if (Math.abs(placed[i].ty - ty) > 0.01) sys.setAttribute('transform', `translate(${tx}, ${placed[i].ty})`);
      if (placed[i].bandTop !== null) sys.setAttribute('data-hkl-band-top', String(placed[i].bandTop));
      else sys.removeAttribute('data-hkl-band-top');
      const first = sys.querySelector('g.measure');
      if (first?.id) this.extents.set(first.id, exts[i]);
    }
    for (const t of Array.from(pageEl.querySelectorAll('text.hkl-section-header'))) {
      const id = t.getAttribute('data-for');
      const meas = id ? pageEl.querySelector('#' + CSS.escape(id)) : null;
      const sys = meas?.closest('g.system') ?? null;
      const idx = sys ? ps.systems.indexOf(sys) : -1;
      const band = idx >= 0 ? placed[idx].bandTop : null;
      if (band !== null) t.setAttribute('y', String(band + SECTION_HEADER_BASELINE));
    }
    /* Manual line-break padlocks ride on the placed systems (draw only). */
    this.drawLockMarks(pageEl);
    return { systems: ps.systems, placed, paperBottom: ps.paperBottom };
  }

  /** Phase-align the staff rows of an arbitrary rendered host (the reference
   *  gate's offscreen page), so its extents are measured on the same footing as
   *  a live page's. */
  alignStavesIn(host: HTMLElement, originPhase?: number): void {
    const margin = host.querySelector('svg g.page-margin') ?? host;
    const systems = Array.from(host.querySelectorAll('g.system'));
    /* `alignStaffRows` computes each staff's phase assuming its system sits at
       a whole number of device pixels — which placement GUARANTEES on a live
       page, and which is false on a raw reference render, whose systems sit
       wherever Verovio stacked them. Aligning under a false premise moves
       `g.staff` while content outside the staff stays put, which perturbs the
       measured `above` by a fraction of a pixel (measured: 478 vs 474) and, at
       a rounding boundary, shows up as a whole-pixel placement difference.
       Grid-align the system transforms first so the premise holds; only
       relative extents are read afterwards, so the absolute shift is free. */
    const grid = 1000 / CRISP_PRESETS[this.zoom].scale;
    for (const sys of systems) {
      const { tx, ty } = translateOf(sys);
      const q = Math.round(ty / grid) * grid;
      if (Math.abs(q - ty) > 1e-9) sys.setAttribute('transform', `translate(${tx}, ${q})`);
    }
    this.alignPageStaves(margin, systems, originPhase);
  }

  /** Fractional device y of a page's margin group — the only position-dependent
   *  input to staff alignment. The reference gate reads it from the LIVE page
   *  and aligns its offscreen reference with it, so the two are corrected
   *  identically; aligning the reference by its own (offscreen, unscrolled)
   *  phase instead leaves a residue of up to a device pixel per system. */
  originPhaseOf(pageEl: HTMLElement): number | undefined {
    const margin = pageEl.querySelector('svg g.page-margin') as SVGGraphicsElement | null;
    const ctm = margin?.getScreenCTM?.();
    return ctm ? ((ctm.f % 1) + 1) % 1 : undefined;
  }

  /** Fractional device X of a live page's margin group — the horizontal twin of
   *  `originPhaseOf`, handed to `snapSystemRightEdge` so an offscreen host snaps
   *  its system right edges exactly where the live page does. */
  originPhaseXOf(pageEl: HTMLElement): number | undefined {
    /* Cached per page card while the container keeps its width: the margin's
       screen x moves only with the card's centring. Read per LINE during an
       assembly, the `getScreenCTM` right after a system import forced the
       browser to lay the new system out at that moment, then once more for the
       snap passes — 115 extra full layouts on the sonata (7 ms each in
       Chromium, far more in Gecko), 2026-10-08. */
    const w = this.scroller?.clientWidth ?? 0;
    const holder = pageEl as HTMLElement & { __hklPhaseX?: { w: number; v: number | undefined } };
    if (holder.__hklPhaseX && holder.__hklPhaseX.w === w) return holder.__hklPhaseX.v;
    const margin = pageEl.querySelector('svg g.page-margin') as SVGGraphicsElement | null;
    const ctm = margin?.getScreenCTM?.();
    const v = ctm ? ((ctm.e % 1) + 1) % 1 : undefined;
    holder.__hklPhaseX = { w, v };
    return v;
  }

  /** Phase-align every staff row on a page. The page-margin group's fractional
   *  device y is read ONCE here and handed to `alignStaffRows`; it is not a
   *  global constant (at zoom 75 it differs between pages, since pages stack at
   *  content-dependent heights), which is why it is read per page rather than
   *  derived from the preset. Returns how many staves actually moved — 0 on an
   *  already-aligned page, which is what makes placement idempotent. */
  private alignPageStaves(_margin: Element, systems: Element[], _forcedPhase?: number): number {
    const grid = 1000 / CRISP_PRESETS[this.zoom].scale;
    let moved = 0;
    for (const sys of systems) moved += alignStaffRows(sys, grid);
    return moved;
  }

  /** Fractional device y of a page-margin group — the phase `placeSystems`
   *  aligns each system's first staff row against. */
  private marginPhase(margin: Element | null): number {
    const ctm = (margin as SVGGraphicsElement | null)?.getScreenCTM?.();
    return ctm ? ((ctm.f % 1) + 1) % 1 : 0;
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
    return this.tk;
  }

  getVersion(): string {
    return this.tk ? this.tk.getVersion() : 'not-loaded';
  }

  attach(scroller: HTMLElement): void {
    if (this.scroller && this.scrollSampler) this.scroller.removeEventListener('scroll', this.scrollSampler);
    this.scroller = scroller;
    let content = scroller.querySelector(':scope > .score-content') as HTMLElement | null;
    if (!content) {
      content = scroller.ownerDocument.createElement('div');
      content.className = 'score-content';
      scroller.replaceChildren(content);
    }
    this.container = content;
    this.scrollSamples = [];
    this.scrollSampler = () => {
      this.scrollSamples.push({ top: scroller.scrollTop, t: performance.now() });
      if (this.scrollSamples.length > 64) this.scrollSamples.splice(0, 32);
    };
    scroller.addEventListener('scroll', this.scrollSampler, { passive: true });
  }

  /** The content frame (see `container`): where the cursor overlay attaches. */
  contentElement(): HTMLElement | null {
    return this.container;
  }

  /** The content frame's origin in #score's scroll coordinates — add it to a
   *  rectForId rect before comparing with scrollLeft/scrollTop. */
  contentOrigin(): { x: number; y: number } {
    if (!this.container || !this.scroller) return { x: 0, y: 0 };
    const c = this.container.getBoundingClientRect(), s = this.scroller.getBoundingClientRect();
    return { x: c.left - s.left + this.scroller.scrollLeft, y: c.top - s.top + this.scroller.scrollTop };
  }

  /** Is the page view being scrolled fast right now (a scrollbar drag, a
   *  flick)? True when the newest scroll event is younger than PUMP_SETTLE_MS
   *  and the view travelled more than PUMP_FAST_VH viewports over the last
   *  PUMP_VELOCITY_MS. Shared by the mount pump and the idle mount window so
   *  neither mounts a page the user is scrolling past. */
  private viewportMoving(vh: number): boolean {
    const now = performance.now();
    const s = this.scrollSamples;
    let i = 0;
    while (i < s.length && now - s[i].t > PUMP_VELOCITY_MS) i++;
    if (i) s.splice(0, i);
    if (!s.length || now - s[s.length - 1].t > PUMP_SETTLE_MS) return false;
    return Math.abs(s[s.length - 1].top - s[0].top) > vh * PUMP_FAST_VH;
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
      /* Ask whether a local refill is ON THE TABLE — the structural analogue of
         the scroll branch's `canSplice()` below — instead of extrapolating this
         render's path from what the LAST one cost.
         `lastPageSpliced` was a one-sample path predictor, and it is false after
         ANY derive, so the edit right after a derive was charged the derive's
         price: a ~40 ms splice deferred two frames behind the badge (2026-09-14,
         found via pageSystemSpliceCourtesyBehindSectionBreak, which flipped on
         whether the preceding derive measured under or over HEAVY_MS). Worse,
         the queued render could then be superseded by a full engrave, turning a
         splice into one. Document cost stays extrapolable; the PATH does not.
         Like `canSplice()`, this is readiness, not a guarantee: if the refill
         refuses and derives, the cost is one un-badged slow render — the failure
         mode this predictor already accepts. forceFullRerender() calls
         pageBreaks.invalidate(), which nulls BOTH startIds and adoption, so
         zoom / file-open / HEJI / page-scale still fall through to the cost
         threshold and keep their badge. */
      if (this.pageBreaks.canAttemptRefill()) return false;
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
  forceFullRerender(cause = 'unspecified'): void {
    this.forceFull = true;
    this.forcedCause = cause;
    this.splicer.invalidate();
    this.modeCache = {};
    this.pageBreaks.invalidate();
  }

  /** Why the next unowned page render is a full one — set by
   *  forceFullRerender (its caller's cause) and the string-entry render(),
   *  consumed by the derive it explains. The ledger then says "forced full
   *  render (page scale)" instead of "no owned partition", which is the
   *  reading for an invalidation nobody asked for. */
  private forcedCause: string | null = null;
  /** Document version the current assembler was built for (the card count of
   *  a re-assembly of the SAME document is expected to hold). */
  private lastAssembledDocVer = -1;

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
    if (!this.scroller) return;
    const theme = this.theme === 'light' ? 'light' : 'dark';
    applyNotationTheme(this.scroller, theme);
    /* Every mounted page wrapper (and every spliced-in system) carries its OWN
       `data-notation-theme` tag from postProcessRendered — the theme CSS keys
       on any tagged ancestor. Retag them too: a page left tagged dark after a
       switch to light kept the dark ink rules live, and with the inline
       notehead paint just removed those rules clobbered the noteheads white
       until the next re-render re-tagged the page (backlog, 2026-09-05). */
    for (const el of Array.from(this.scroller.querySelectorAll('[data-notation-theme]'))) {
      if (theme === 'light') delete (el as HTMLElement).dataset.notationTheme;
      else (el as HTMLElement).dataset.notationTheme = 'dark';
    }
    this.scroller.classList.toggle('theme-transparent', this.theme === 'transparent');
  }

  getTheme(): ScoreTheme {
    return this.theme;
  }

  setZoom(z: ZoomLevel): void {
    if (z !== this.zoom) this.forceFullRerender('zoom');    // changes scale → whole layout
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
    if (next !== this.pageScale) this.forceFullRerender('page scale');
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
    this.forcedCause = 'string render';
    this.lastRenderedMode = this.viewMode;
    this.disposePages();
    if (this.viewMode === 'scroll') { this.renderSingleSystem(mei); return; }
    this.renderPage(mei);
  }

  /** String entry only (`render(mei)`): Verovio's own castoff and page paint,
   *  every page real. Composer renders never come here — page view assembles
   *  pages from measured systems (render/pageassembly.ts). */
  private renderPage(mei: string): void {
    this.disposePages();
    const strategy = mei.includes('<sb') ? 'smartSb0' : 'auto';
    this.tk!.setOptions(this.buildOptions(strategy));
    if (!this.tk!.loadData(mei)) {
      this.container!.innerHTML = '<div style="color:#c00;padding:20px">Verovio loadData failed (invalid MEI).</div>';
      return;
    }
    const pages = Math.max(1, this.tk!.getPageCount());
    let combined = '';
    for (let i = 1; i <= pages; i++) {
      combined += '<div class="score-page" data-page="' + i + '">' + this.tk!.renderToSVG(i, {}) + '</div>';
    }
    this.container!.innerHTML = combined;
    for (const div of Array.from(this.container!.querySelectorAll('.score-page'))) this.substituteHiddenStaffSystems(div as HTMLElement);
    this.postProcessRendered(this.container!);
    for (const div of Array.from(this.container!.querySelectorAll('.score-page'))) this.placePage(div as HTMLElement);
  }

  /* ── page-view virtualization (T2.1) ─────────────────────────────────────── */






  /** Turn the mount window off (verification harnesses only). A gate that
   *  compares the WHOLE document — the sonata battery's reference render, or
   *  anything that locates a measure through the page DOM — needs every page to
   *  stay mounted; eviction otherwise silently narrows what it checks, and
   *  non-deterministically, since it lands on an idle callback. Production
   *  never calls this. */
  setMountWindowEnabled(on: boolean): void {
    this.mountWindowEnabled = on;
    if (!on && this.mountWindowHandle !== null) {
      const cic = (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
      if (cic) cic(this.mountWindowHandle); else clearTimeout(this.mountWindowHandle);
      this.mountWindowHandle = null;
    }
  }

  /** Mount EVERY page and return the page SVGs in page order (PDF export,
   *  2026-09-05). The export is the page view's own DOM, page for page — the
   *  same mount path as a scroll-in (mountPage: Verovio SVG, the post pass,
   *  placement, the main.ts injections, the page-fit repair) — so a page held
   *  as a placeholder must be made real first. Loops because a mount's repair
   *  can spill a tail onto a page that did not exist before it ran; stops
   *  when a round mounts nothing (a page whose layout failed to load stays
   *  pending rather than spinning). Scroll view has no pages: the caller
   *  switches to page view first. Production leaves every page mounted; the
   *  mount window evicts them on its next idle pass. */
  mountAllPages(): SVGSVGElement[] {
    if (!this.container) return [];
    if (this.viewMode === 'page' && this.assembler) this.assembler.mountAll();
    return Array.from(this.container.querySelectorAll('.score-page > svg')) as SVGSVGElement[];
  }

  /** Hide empty staves (render/hiddenstaves.ts). For every system on
   *  `pageEl` — or only `scope` — whose hidden set is non-empty and still
   *  drawn, render that system ALONE from a window MEI with those staves
   *  filtered out (the page splicer's own recipe: leader/trailer stubs, one
   *  pinned line) and swap it in. Runs before post-processing and placement,
   *  so every height the page rule measures is the reduced one. Returns the
   *  system list with replacements applied. Page view only. */
  private substituteHiddenStaffSystems(pageEl: HTMLElement, scope?: Element[]): Element[] {
    const systems = scope ?? Array.from(pageEl.querySelectorAll('g.system'));
    const model = this.lastModel;
    if (!model || this.viewMode !== 'page' || !this.spliceTk) return systems;
    if (!model.getDoc().querySelector('staff[data-hkl-hide-empty]')) return systems;   // nothing flagged anywhere
    const total = model.allMeasures().length;
    let ctx: PageSpliceCtx | null = null;
    const out: Element[] = [];
    for (const sys of systems) {
      const idxs = systemMeasureIdxs(model, sys);
      const hidden = hiddenStavesFor(model, idxs, this.viewStaves);
      if (!hidden.length) { out.push(sys); continue; }
      const shown = renderedStaffNs(sys);
      if (!hidden.some((h) => shown.includes(h))) { out.push(sys); continue; }   // already reduced
      const startId = sys.querySelector('g.measure')?.id ?? '';
      const mLo = Math.min(...idxs), mHi = Math.max(...idxs);
      const staves = visibleStavesFor(model, this.viewStaves, hidden);
      /* Cover every spanner with an end inside the system and any <ending> it
         touches — the page splicer's rule: a tie or slur into the system from
         the previous line must find its other end in the window or Verovio
         drops the segment ("Unable to match @tie"). Extra measures on the left
         flow into the leader's line; extra measures on the right get their own
         pinned line, so the system itself keeps exactly its measures. */
      const meiMeasures = model.allMeasures();
      let [wLo, wHi] = expandForSpannersOnce(meiMeasures, mLo, mHi, model.docVersion());
      [wLo, wHi] = expandForEndings(meiMeasures, wLo, wHi);
      const starts = [startId];
      if (wHi > mHi) starts.push(meiMeasures[mHi + 1].getAttribute('xml:id') ?? '');
      const mei = startId ? buildWindowMei(model, wLo, wHi, starts, wLo > 0, wHi < total - 1, null, new Set(), staves) : null;
      if (!mei) { out.push(sys); continue; }
      ctx ??= this.pageSpliceCtx();
      const tk = this.spliceTk;
      /* A window that IS the whole document (a one-system score) carries no
         line pin — injectPins never pins the first measure and there is no
         stub to pin — and 'line'/'encoded' would warn "Requesting layout with
         line breaks but nothing provided". Such a document was cast off with
         'auto' by the live render too (castoffPlan), so match it. */
      const wholeDoc = wLo === 0 && wHi === total - 1 && starts.length === 1;
      tk.setOptions(wholeDoc ? { ...ctx.windowOptions, breaks: 'auto' } : ctx.windowOptions);
      if (!tk.loadData(mei)) { console.warn('[hidden-staves] window loadData failed at ' + startId); out.push(sys); continue; }
      const host = new DOMParser().parseFromString(tk.renderToSVG(1, {}), 'image/svg+xml');
      const fresh = Array.from(host.querySelectorAll('g.system'))
        .find((g) => g.querySelector('g.measure')?.id === startId) as SVGGElement | undefined;
      if (!fresh) { console.warn('[hidden-staves] window has no system starting at ' + startId); out.push(sys); continue; }
      const imported = pageEl.ownerDocument.importNode(fresh, true) as SVGGElement;
      /* Same horizontal frame as the system it replaces; the vertical position
         is placement's (placePage runs after this). */
      const tr = sys.getAttribute('transform');
      if (tr) imported.setAttribute('transform', tr); else imported.removeAttribute('transform');
      const defs = sys.closest('svg')?.querySelector('defs') ?? pageEl.querySelector('svg defs');
      if (defs) mergeGlyphDefs(defs, host, [imported]);
      sys.replaceWith(imported);
      out.push(imported);
    }
    return out;
  }

  /** Page view: does model measure `mi` draw staff `staffN` where it is
   *  rendered? False only for a staff hidden on that system (hide-empty
   *  staves); true in scroll view, for unmounted pages, and for unknown ids —
   *  navigation is never blocked on a guess. */
  isCellRendered(mi: number, staffN: number): boolean {
    if (this.viewMode !== 'page' || !this.container) return true;
    const id = this.renderIdForMeasure(mi);
    if (!id) return true;
    const g = this.container.querySelector('#' + CSS.escape(id));
    if (!g) return true;
    if (!g.querySelector(':scope > g.staff')) return true;
    return !!g.querySelector(':scope > g.staff[data-n="' + staffN + '"]');
  }

  /** xml:id of the rendered measure standing for model measure `mi` (the
   *  measure itself, or its multimeasure-rest run's first measure). */
  renderIdForMeasure(mi: number): string | null {
    return this.renderIds[mi] ?? this.measureIds[mi] ?? null;
  }

  /** Page holding a measure, read from the DOM (0 when it isn't mounted).
   *  Deliberately does NOT consult the toolkit: `getPageWithElement` needs the
   *  layout loaded, which can cost ~1 s. */
  private pageOfMeasure(mi: number): number {
    const id = this.renderIds[mi];
    if (!id || !this.container) return 0;
    const el = this.container.querySelector('#' + CSS.escape(id));
    const pageEl = el?.closest('.score-page') as HTMLElement | null;
    if (pageEl) return Number(pageEl.dataset.page) || 0;
    return this.assembler?.pageOfMeasure(mi) ?? 0;
  }

  /** Hold the mounted set to a small window: mount what is within one viewport
   *  of the view (the same band the IntersectionObserver arms, so the two never
   *  fight) plus the cursor's page and its neighbours, and evict anything
   *  beyond TWO viewports. The gap between the two bands is the hysteresis —
   *  without it, scrolling along a page boundary would churn, and a re-mount
   *  costs the same ~138 ms as the original.
   *
   *  The cursor's neighbours are mounted eagerly because that is where the next
   *  edit will need context: a splice whose context line sits one page over
   *  used to mount it mid-edit (B5), which is the whole difference between a
   *  377 ms and a 239 ms splice. Doing it here moves that cost off the edit
   *  path entirely. */
  private updateMountWindow(cursorMeasure: number): void {
    const as = this.assembler;
    if (this.viewMode !== 'page' || !as || !this.container || !this.scroller) return;
    const view = this.scroller.getBoundingClientRect();
    const vh = view.height || 1;
    const pages = Array.from(this.container.querySelectorAll('.score-page')) as HTMLElement[];
    const rect = new Map<number, DOMRect>();
    for (const div of pages) rect.set(Number(div.dataset.page), div.getBoundingClientRect());

    /* The cursor's page may not exist yet (an assembly in idle slices): make
       it real first — the sync build to that page is the document-order cost
       the design accepts — so the window pins the right neighbourhood instead
       of whatever placeholders happen to be in band (2026-10-08). */
    if (as.pending() && cursorMeasure >= 0 && this.pageOfMeasure(cursorMeasure) < 1) as.ensureMeasureMounted(cursorMeasure);
    const cursorPage = this.pageOfMeasure(cursorMeasure);
    const pinned = new Set<number>();
    if (cursorPage >= 1) {
      for (const q of [cursorPage - 1, cursorPage, cursorPage + 1]) {
        if (q >= 1 && q <= as.pageCount) pinned.add(q);
      }
    }
    /* Mount ONE page per idle slice (2026-09-11) — nearest the viewport first,
       then the cursor's neighbourhood — and come back for the rest. Mounting
       the whole band in one callback blocked ~150 ms a page (Chromium; more in
       Firefox) with nothing painted in between, and a page the user scrolled
       past while it waited was mounted anyway. `mountPageIfCheap` refuses a
       stale or toolkit-less page; skip those rather than spin on them. */
    const cands: Array<{ p: number; d: number }> = [];
    for (const [p, r] of rect) {
      if (as.mounted.has(p)) continue;
      const inBand = r.bottom >= view.top - vh && r.top <= view.bottom + vh;
      if (!inBand && !pinned.has(p)) continue;
      const d = r.bottom < view.top ? view.top - r.bottom : r.top > view.bottom ? r.top - view.bottom : 0;
      cands.push({ p, d: inBand ? d : Infinity });
    }
    cands.sort((a, b) => a.d - b.d);
    /* Not while the view is flying past (viewportMoving) — idle time exists
       between the frames of a drag, and this pass used to spend it mounting
       the pages the drag was sweeping through. Retry once it settles. */
    const moving = cands.length > 0 && this.viewportMoving(vh);
    let mountedOne = false;
    if (!moving) {
      for (const c of cands) {
        if (!this.mountOne(c.p)) continue;
        mountedOne = true;
        break;
      }
    }
    if (moving || (mountedOne && cands.length > 1)) this.scheduleMountWindow(cursorMeasure);
    /* Evict: mounted, not pinned, and more than two viewports away. A stale
       page is evictable like any other — re-mounting one reloads the document
       once (~600 ms) and leaves the toolkit current for everything after, which
       is better than pinning edited pages in memory forever. */
    for (const p of Array.from(as.mounted)) {
      if (pinned.has(p)) continue;
      const r = rect.get(p);
      if (!r) continue;
      if (r.bottom < view.top - 2 * vh || r.top > view.bottom + 2 * vh) this.evictPage(p);
    }
  }

  /** Queue an updateMountWindow for idle time. Never runs on the edit path:
   *  mounting is ~138 ms and evicting forces layout, neither of which belongs
   *  in a keystroke. Coalesces — only the latest cursor position matters. */
  scheduleMountWindow(cursorMeasure: number): void {
    this.mountWindowMi = cursorMeasure;
    if (!this.mountWindowEnabled) return;
    if (this.viewMode !== 'page' || !this.assembler || this.mountWindowHandle !== null) return;
    const run = (): void => {
      this.mountWindowHandle = null;
      try { this.updateMountWindow(this.mountWindowMi); } catch { /* never break a render */ }
    };
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    this.mountWindowHandle = ric
      ? ric(run, { timeout: 300 })
      : (setTimeout(run, 0) as unknown as number);
  }



  /** (Re)arm the lazy-mount observer over the current pending placeholders. */
  private armPageIo(): void {
    if (!this.assembler || !this.container) return;
    this.pageIo?.disconnect();
    this.pageIo = new IntersectionObserver((entries) => {
      /* The observer only WAKES the pump. Its entries describe the moment of
         observation, in DOM order: mounting them here drew the page above the
         viewport before the visible one, and every page a drag swept through
         the band — all synchronously, ahead of the page the user stopped on. */
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        this.pumpWanted.add(Number((e.target as HTMLElement).dataset.page));
      }
      if (this.pumpWanted.size) this.requestPump();
    }, { root: this.scroller, rootMargin: '100% 0px 100% 0px' });
    for (const div of Array.from(this.container.querySelectorAll('.score-page-pending'))) {
      this.pageIo.observe(div);
    }
  }

  /** Ask for one pump frame (coalesced). */
  private requestPump(): void {
    if (this.pumpHandle !== null) return;
    this.pumpHandle = requestAnimationFrame(() => {
      this.pumpHandle = null;
      try { this.pumpMounts(); } catch { /* never break a render */ }
    });
  }

  private cancelPump(): void {
    if (this.pumpHandle !== null) { cancelAnimationFrame(this.pumpHandle); this.pumpHandle = null; }
    this.pumpWanted.clear();
  }

  /** One animation frame of lazy mounting (2026-09-11). Classifies every
   *  wanted page against the viewport AS IT IS NOW: a VISIBLE page (intersects
   *  the view) is mounted — one per frame, nearest the top of the view first,
   *  so a paint lands between mounts; a NEAR page (inside the ±1-viewport
   *  band) is left to the idle mount window; a page that has LEFT the band is
   *  dropped (it stays observed, so the observer re-wakes us if it returns).
   *  While the viewport is moving fast (viewportMoving: a scrollbar drag, a
   *  flick) nothing is mounted: the placeholders show, and the page under the
   *  thumb mounts PUMP_SETTLE_MS after it stops. Measured (sonata, Chromium): a drag 20→3 went from 15 mounts
   *  / 2.75 s before the landing page was drawn to one mount of ~150 ms. */
  private pumpMounts(): void {
    const as = this.assembler;
    if (this.viewMode !== 'page' || !as || !this.container || !this.scroller) { this.pumpWanted.clear(); return; }
    const view = this.scroller.getBoundingClientRect();
    const vh = view.height || 1;
    const moving = this.viewportMoving(vh);
    let best: { p: number; d: number } | null = null;
    let visible = 0;
    let near = false;
    for (const p of Array.from(this.pumpWanted)) {
      if (as.mounted.has(p)) { this.pumpWanted.delete(p); continue; }
      const div = this.pageDiv(p);
      if (!div) { this.pumpWanted.delete(p); continue; }
      const r = div.getBoundingClientRect();
      if (r.bottom > view.top && r.top < view.bottom) {
        visible++;
        const d = Math.abs(r.top - view.top);
        if (!best || d < best.d) best = { p, d };
      } else if (r.bottom >= view.top - vh && r.top <= view.bottom + vh) {
        near = true;
      } else {
        this.pumpWanted.delete(p);
      }
    }
    if (best && !moving) {
      this.mountOne(best.p);
      this.pumpWanted.delete(best.p);
      visible--;
    }
    if ((best && moving) || visible > 0) {
      this.requestPump();
    } else {
      /* Near pages are idle work; the window also evicts what a scroll left
         behind. */
      if (near || as.mounted.size > 0) this.scheduleMountWindow(this.mountWindowMi);
    }
  }

  /** Container-level theme tags (#score attr + transparent class) — the theme
   *  CSS keys on #score, not on the per-page wrappers that postProcessRendered
   *  tags in the virtualized path. */
  private setContainerThemeTags(): void {
    if (!this.scroller) return;
    if (this.theme === 'light') delete this.scroller.dataset.notationTheme;
    else this.scroller.dataset.notationTheme = 'dark';
    this.scroller.classList.toggle('theme-transparent', this.theme === 'transparent');
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
      spanners: this.spanners,
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
    model.setRenderView(viewStaves);
    const units = model.renderUnits(viewStaves);
    this.renderIds = units.active
      ? this.measureIds.map((_, mi) => this.measureIds[units.repIdxOf(mi)])
      : this.measureIds;
    this.lastModel = model;
    this.viewStaves = viewStaves;
    this.pageBreaks.setView(viewStaves);
    const heji = { hejiEnabled: model.getHejiEnabled() };
    let preMei: string | null = null;
    if (this.lastRenderedMode !== null && this.lastRenderedMode !== this.viewMode) {
      preMei = model.serialize(heji, viewStaves);
      if (this.stashAndRestore(preMei)) {
        this.spanners = snapshotSpanners(model.allMeasures(), model.docVersion());
        return false;
      }
    }
    const t0 = performance.now();
    if (this.viewMode === 'scroll') {
      const tookFull = this.renderScroll(model, viewStaves, preMei);
      if (tookFull) this.lastFullMs.scroll = performance.now() - t0;
    } else {
      const tookFull = this.renderPageComposer(model, viewStaves, preMei, heji);
      if (tookFull) this.lastFullMs.page = performance.now() - t0;
      this.ledger.push({
        full: tookFull,
        outcome: this.pageSplicer.lastOutcome,
        skipReason: tookFull ? this.pageSplicer.lastSkipReason : '',
        deriveReason: tookFull ? this.pageBreaks.lastDeriveReason : '',
        ms: Math.round(performance.now() - t0),
      });
      if (this.ledger.length > 200) this.ledger.splice(0, this.ledger.length - 200);
      /* Whatever path ran, the partition now on screen is the right one for
         this layout budget — cache it so returning to this zoom/page scale on
         an unchanged document skips the castoff pass (A4). Written AFTER the
         settle pass at the adopt sites below, so the entry a later zoom
         restores is the settled pagination, not a pre-cascade one. */
      this.rememberPartition(model);
      this.syncLockMarks(model);
    }
    this.spanners = snapshotSpanners(model.allMeasures(), model.docVersion());
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
    if (this.pageBreaks.canAttemptRefill()) {
      /* An assembly still in flight (a keystroke right after a load) has
         committed only a PREFIX of the page starts; the refill carries page
         starts by membership, so it must see the whole list — else a line past
         the prefix lands on a provisional page the DOM does not agree with and
         the splice refuses ('DOM partition drift above', every chunk start of
         the gated sweep, 2026-10-08). Finish it first — the same cost the
         splice would pay below, paid before the partition is read. */
      if (this.assembler?.pending()) this.assembler.finishSync();
      const refill = this.pageBreaks.tryRefill(model, viewStaves, this.pageBreaksCtx());
      if (refill) {
        /* Splice/no-op only when the mounted DOM is the page render the
           committed partition describes: never across a view-mode switch
           (preMei non-null — the container may hold the OTHER mode's DOM,
           where measure ids resolve into the wrong frame). */
        const pageDomLive = preMei === null && this.assembler !== null
          && this.container!.querySelector('.score-page svg') !== null;
        if (pageDomLive) {
          if (refill.changedRun === null && !refill.breaksChanged) {
            /* Signature-identical doc (head/user-break/interior guards all
               passed) — the mounted DOM already renders exactly this. */
            this.pageSplicer.noteNoop();
            this.lastPageSpliced = true;   // DOM untouched — the fastest path there is
            return false;
          }
          /* ONE landing for every refill (2026-10-21, Max: "every repartition
             must repaginate … no path should allow pagination to be stale on
             mounted lines"). The splicer ENGRAVES the line hunk in one window
             when it can (`trySplice` → `lastStaged`); PageAssembler.applyPartition
             engraves every other changed line on a mounted page, places every
             system, and re-fits the pages from one page before the first
             affected line against what each page actually holds. Nothing is
             placed from carried pins. The DOM must hold every page the edit may
             touch: finish an assembly still in flight (a keystroke right after
             a load). */
          this.assembler!.finishSync();
          this.spliceDepth++;
          this.touchedPages = [];
          let landed = false, engraved = false;
          try {
            if (refill.changedRun !== null) {
              const req: SpliceRequest = {
                oldStartIds: refill.oldStartIds, newStartIds: refill.newStartIds,
                oldPageStartIds: refill.oldPageStartIds,
                changedRun: refill.changedRun,
                partitionOnly: refill.partitionOnly,
                spanners: this.spanners,
              };
              engraved = this.pageSplicer.trySplice(model, req, this.pageSpliceCtx());
              if (!engraved) console.info('[page-splice] not spliceable (' + this.pageSplicer.lastSkipReason + ') — engraving the changed lines one window each');
            }
            /* Every line the edit changed — the splicer's hunk, closed over
               spanners and endings, when it got that far (deferred lines
               included: their pages must re-fit too), plus the changed run's
               own lines. */
            const changed = this.changedLineIdsFor(model, refill.changedRun, refill.newStartIds);
            const hunk = this.pageSplicer.lastHunkFull;
            if (hunk) for (let li = hunk.a; li <= hunk.bNew; li++) { const id = refill.newStartIds[li]; if (id) changed.add(id); }
            landed = this.assembler!.applyPartition(
              refill.oldStartIds, changed, this.pagesOfBreaks(refill.breakIds),
              engraved ? this.pageSplicer.lastStaged : undefined, refill.oldPageStartIds,
            );
            this.noteRepagination();
            if (landed) {
              if (!engraved) this.pageSplicer.noteApplied();
              for (const el of this.assembler!.lastRebuiltPages) if (!this.touchedPages.includes(el)) this.touchedPages.push(el);
            } else {
              console.warn('[page-splice] partition could not be applied — re-assembling');
            }
          } finally {
            this.spliceDepth--;
          }
          if (landed) {
            this.lastPageSpliced = true;
            /* The page's furniture follows its content: a page the rebuild
               created gets its section titles and padlocks as a mount does
               (the hooks are idempotent). */
            for (const el of this.touchedPages) this.onPageMountedCb?.(el);
            for (const el of this.touchedPages) this.drawLockMarks(el);
            this.pageBreaks.verifyRenderedPartition(
              this.container!, model, this.assembler?.pageCount ?? 1, this.pageBreaksCtx());
            /* Reference gate (test mode): after the pages have settled,
               against the owner's CURRENT pins (the fit committed them). */
            if (indexCheckEnabled()) {
              this.pageSplicer.verifyAgainstReference(this.pinnedMeiForCurrentModel(), this.touchedPages, this.pageSpliceCtx());
              /* The fit is the ONLY fit check on this path — overflowingPage
                 runs on the full-render branches alone. Assert the OUTCOME, so
                 any future path that skips it fails the suite instead of
                 shipping (a one-page score once piled every new system past
                 the bottom of page 1, 2026-09-18). */
              const over = this.overflowingPage();
              if (over !== 0) {
                throw new Error('[page-splice] page ' + over + ' is drawn past its paper after a landed edit'
                  + ' (pageStarts=' + this.pageBreaks.pageStarts().length
                  + ', repairable=' + this.pageBreaks.paginationRepairable() + ')');
              }
            }
            return false;
          }
        }
        /* Not spliceable: re-assemble every page from the partition the refill
           just committed — a render of systems, never a Verovio page. */
        this.assembleDocument(model, viewStaves, false);
        this.pageBreaks.verifyRenderedPartition(
          this.container!, model, this.assembler?.pageCount ?? 1, this.pageBreaksCtx());
        this.lastPageSpliced = false;
        return true;
      } else if (this.pageBreaks.ownershipActive()) {
        console.info('[page-breaks] refill unavailable for this edit — derive render');
      }
    } else {
      /* Nothing owned. A forced invalidation (new document, Setup apply, view
         change, zoom, page scale — forceFullRerender's callers) is by design
         and says why; anything else is an invalidation nobody asked for, and
         the suite's splice invariant treats it as a defect. */
      this.pageBreaks.lastDeriveReason = this.forcedCause !== null
        ? 'forced full render (' + this.forcedCause + ')' : 'no owned partition';
      const cause = this.forcedCause;
      this.forcedCause = null;
      if (cause === 'zoom' && this.rescaleForZoom(model)) {
        this.pageSplicer.noteRescaled();
        this.lastPageSpliced = true;
        return false;
      }
    }
    this.assembleDocument(model, viewStaves, true);
    this.lastPageSpliced = false;
    return true;
  }

  /** Zoom is visual-only (the inner SVG is identical at every zoom): keep every
   *  rendered system, restore the owner's partition from the DOM and the width
   *  cache, and let the assembler resize, re-snap and re-place in place. False
   *  when the current assembly cannot stand in (another document, nothing
   *  built, no cached widths) — the caller then assembles. */
  private rescaleForZoom(model: ComposerModel): boolean {
    const as = this.assembler;
    if (!as || this.lastAssembledDocVer !== model.docVersion() || this.viewMode !== 'page') return false;
    const cached = this.partitionCache.get(this.partitionKey(model));
    if (!cached || cached.docVer !== model.docVersion()) return false;
    const lines = as.domLineStarts();
    const pages = as.domPageStarts();
    if (lines.length <= 1 || !pages.length) return false;
    if (!this.pageBreaks.restorePartition(model, lines, pages, cached.widths, this.pageBudgetW())) return false;
    const prevH = as.pageH;
    const g = this.shellGeom();
    const newH = g.pageHeight * g.scale / 100;
    as.rescale(prevH > 0 ? newH / prevH : 1);
    this.setContainerThemeTags();
    this.armPageIo();
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
    const mei = model.serialize({ hejiEnabled: model.getHejiEnabled() }, this.viewStaves);
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
    /* The USER BREAK STRUCTURE is a layout input too, and leaving it out made
       the cache serve a stale partition across a break toggle: adding a page
       break split a line and grew the page count, that partition was cached
       under the same key, and REMOVING the break then restored it instead of
       re-deriving (fixture pageUserBreakReflows: 5 pages/16 lines where the
       document's own layout is 4/15). Pre-existing; it only became visible
       once the initial render balanced the whole document, which made the
       un-broken layout differ from the broken one. */
    const breaks = Array.from(hardStartIds(model)).sort().join('.');
    return `u${unit}|s${this.pageScale}|${model.getHejiEnabled() ? 'heji' : 'plain'}|v${viewKeyOf(this.viewStaves)}|b${breaks}`;
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
    /* Page starts are a PREFIX while the assembly is in flight (pages commit
       as they close): remember them only when it is complete, else keep the
       complete list an earlier render stored for this key — a prefix served
       as the expected card count made a zoom start as one page (2026-10-08). */
    const key = this.partitionKey(model);
    const complete = this.assembler !== null && !this.assembler.pending();
    const prior = this.partitionCache.get(key);
    const pages = complete ? this.pageBreaks.pageStarts()
      : (prior && prior.docVer === model.docVersion() ? prior.pages : []);
    this.partitionCache.set(key, {
      docVer: model.docVersion(), lines, pages,
      widths: this.pageBreaks.exportWidths(),
    });
    /* Bounded: one entry per (zoom, pageScale, heji) combination actually
       visited. Trim anyway so a scripted sweep can't grow it without limit. */
    if (this.partitionCache.size > 24) {
      const oldest = this.partitionCache.keys().next().value;
      if (oldest !== undefined) this.partitionCache.delete(oldest);
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
    const strategy = this.paintedBreaks();
    const owned = strategy === 'encoded';
    const base = this.buildOptions(strategy, 'page');
    return {
      toolkit: this.spliceTk!,
      viewStaves: this.viewStaves,
      /* With pagination owned the window uses the LIVE page options verbatim:
         'encoded' paginates only at the <pb> pins the window carries, so the
         tall-page trick is unnecessary — and the page geometry must match
         exactly, running header included. That band is what anchors a page's
         FIRST system (~419 units on the sonata); suppressing it made every
         window-page-first system read ~419 units too high, which is what the
         B1 vertical plan reads directly (see pagesplice.ts verticalPlan).
         Unowned pagination still needs the tall page: 'line' paginates by
         height and the window must land on one page — but it must NOT suppress
         the header. Verovio's page-1 `pgHead` band (600 units on a titled doc)
         is what its first system is anchored below, and `verticalPlan` reads a
         page-first system's position ABSOLUTELY from the window. Suppressing it
         put line 0 — the only line that can be window-page-first here, since a
         mid-score window's first system is the synthetic leader — 650 units too
         high, sliding the whole page up under its own title. Same lesson as the
         owned path's ~419-unit anchor band, one path over. */
      windowOptions: owned
        ? base
        : { ...base, pageHeight: 60_000, adjustPageHeight: true },
      liveOptions: () => base,
      /* Hide-empty staves first (render/hiddenstaves.ts): an imported system
         whose hidden set is non-empty is re-rendered with those staves out and
         swapped before the per-system passes measure it; the reference host
         of the index-check gate goes through the same wrapper, so live and
         reference agree. */
      postProcess: (el: HTMLElement, scope?: Element[], originPhaseX?: number) => {
        if (scope !== undefined) this.postProcessRendered(el, this.substituteHiddenStaffSystems(el, scope), originPhaseX);
        else { this.substituteHiddenStaffSystems(el); this.postProcessRendered(el, undefined, originPhaseX); }
      },
      decorateHost: (el: HTMLElement) => styleVoltaNumbers(el),
      placeFor: (systems: Element[], opts?: PlaceOpts) => this.placeFor(systems, opts),
      alignStaves: (host: HTMLElement, originPhase?: number) => this.alignStavesIn(host, originPhase),
      originPhaseOf: (pageEl: HTMLElement) => this.originPhaseOf(pageEl),
      originPhaseXOf: (pageEl: HTMLElement) => this.originPhaseXOf(pageEl),
      headerMeta: () => this.shellMeta(),
      ensurePageMounted: (p: number) => this.assembler?.mount(p) ?? false,
      isPageMounted: (p: number) => this.isPageMounted(p),
    };
  }

  /** Every page-view render since `clearRenderLedger`, oldest first: whether it
   *  was a full engrave and, if so, the refusal / derive reason. */
  renderLedger(): ReadonlyArray<{ full: boolean; outcome: string; skipReason: string; deriveReason: string; ms: number }> {
    return this.ledger.slice();
  }

  /** Drop the ledger — the suite calls this after a fixture's setup so the
   *  document BUILD (which necessarily derives) is not counted against the
   *  edits the fixture then makes. */
  clearRenderLedger(): void {
    this.ledger = [];
  }

  /** Page element by (current) page number, mounted or placeholder. */
  private pageDiv(p: number): HTMLElement | null {
    return this.container?.querySelector('.score-page[data-page="' + p + '"]') as HTMLElement | null ?? null;
  }



  /** Systems of a mounted page that sit past its paper: the index of the first
   *  system whose bottom crosses the page box (−1 when the page fits). Same
   *  tolerance as overflowingPage: a system's bbox includes hanging content
   *  that legitimately reaches into the bottom margin. */
  private foldOf(div: HTMLElement): { systems: Element[]; firstPast: number } | null {
    const ps = this.pageSystems(div);
    if (!ps || !ps.systems.length) return null;
    /* PREDICTED from the placement rule over the page's measured extents
       (Phase 1) — the same arithmetic that placed the page, read without
       writing (the snap has run; a write would undo its staff shifts). The
       limit is the PAPER, as before: 2 device px of tolerance for hanging
       content that legitimately reaches into the bottom margin. */
    /* Rule v1 (no `distribute`): the fold decides how many systems the page
       holds, and only then does the page share out what is left. */
    const placed = this.placeFor(ps.systems);
    if (!placed) return null;
    const tol = 2 * 1000 / this.currentScale();
    const firstPast = foldIndex(placed, ps.contentBottom ?? ps.paperBottom, tol);
    if (indexCheckEnabled()) {
      /* Test mode: the prediction must agree with the laid-out DOM — measured
         against the same limit the prediction uses, the CONTENT COLUMN. Using
         the SVG box (the paper, one bottom margin lower) made the two disagree
         by exactly that margin the moment the fold moved to the column. */
      const ctm = (ps.margin as SVGGraphicsElement).getScreenCTM?.();
      const limit = ctm && ps.contentBottom !== null
        ? ctm.f + ps.contentBottom * ctm.d
        : ps.svg.getBoundingClientRect().bottom;
      const bottom = limit + 2;
      let measured = -1;
      for (let i = 0; i < ps.systems.length; i++) {
        if (ps.systems[i].getBoundingClientRect().bottom > bottom) { measured = i; break; }
      }
      if (measured !== firstPast) {
        throw new Error(`[page-fit] page ${div.dataset.page}: predicted fold ${firstPast} but the DOM measures ${measured}`);
      }
    }
    return { systems: ps.systems, firstPast };
  }












  /** Context the page line-break owner drives Verovio through. */
  private pageBreaksCtx(): PageBreaksCtx {
    return {
      naturalsToolkit: () => this.spliceTk!,
      naturalsOptions: () => this.buildOptions('none', 'scroll'),
      budgetW: () => this.pageBudgetW(),
      isPageMounted: (p: number) => this.isPageMounted(p),
    };
  }

  /** Is page `p` drawn (exists and is not a placeholder)? */
  private isPageMounted(p: number): boolean {
    const el = this.pageDiv(p);
    return !!el && !el.classList.contains('score-page-pending');
  }

  /** Sync band balance before the first pinned paint (see
   *  PageLineBreaks.balanceInitialBand). The justified system width comes from
   *  the layout the live toolkit holds — nothing is mounted for the DOM read
   *  yet, and a previous render's DOM may sit at another page scale. */
  private balanceInitialBand(model: ComposerModel): void {
    /* Page geometry, not a laid-out page (see pageBudgetW). This is what lets
       the pre-paint balance run without a castoff layout to measure. */
    const budget = this.pageBudgetW();
    if (!(budget > 0)) return;
    /* THE WHOLE DOCUMENT, not a band (2026-09-08, Max's ruling). Balancing
       used to cover the first INITIAL_BAND_PAGES here and leave the rest to an
       idle job armed after the paint — and that job is a multi-step sequence
       that ANY re-render cancelled. Measured on
       the sonata: the sequence walks 115 -> 115 -> 114 -> 113 lines over ~4.5 s,
       and a zoom landing mid-sequence abandons it there, leaving the partition
       at an intermediate state that nothing ever resumes (`budgetW` is zeroed
       by the re-render and only re-measured when a repartition is attempted).
       Three different, perfectly stable settled layouts came out of the same
       document that way, depending only on when the zoom happened — including
       one that left pagination repaired against a partition still in motion,
       which is where four measures went missing. Balancing to completion
       before the paint makes the settled partition a function of the document:
       there is no interruptible window to observe.

       Every section is partitioned (F, render/balance.ts). This path writes
       `startIds`/`pageStartIds` directly rather than through a splice
       precisely because it runs pre-paint, so covering the whole document adds
       no splice or re-entrancy risk — only work. An edit runs the same F over
       the sections it touched (the refill path), so a load and an edit agree
       by construction. */
    /* Naturals for the WHOLE document first, so the balance below judges every
       section with complete information — and so a later edit's own balance
       finds them cached instead of reporting 'naturals incomplete'. */
    if (!this.pageBreaks.warmAllNaturals(model, this.pageBreaksCtx())) {
      console.warn('[page-balance] could not measure every natural — balancing with what is cached');
    }
    this.pageBreaks.balanceInitialBand(model, this.pageBreaksCtx(), budget);
  }

  /* ── manual line breaks (2026-09-11) ─────────────────────────────────── */

  /** Draw the manual line-break padlocks of one mounted page
   *  (render/lockmarks.ts) from the model's locks; a page-final system's
   *  successor comes from the owner's partition, else from the next mounted
   *  page. Idempotent; runs after every placement and after every splice. */
  private drawLockMarks(pageEl: Element): void {
    const model = this.lastModel;
    if (!model || this.viewMode !== 'page') return;
    const locks = lockStartIds(model);
    const lines = this.pageBreaks.lineStarts();
    const next = new Map<string, string>();
    for (let i = 0; i + 1 < lines.length; i++) next.set(lines[i], lines[i + 1]);
    const pageNo = Number((pageEl as HTMLElement).dataset?.page);
    refreshLockMarks(pageEl, locks, (id) => {
      const owned = next.get(id);
      if (owned) return owned;
      const nextPage = pageNo >= 1 ? this.pageDiv(pageNo + 1) : null;
      return nextPage?.querySelector('g.system g.measure')?.id ?? null;
    });
  }

  /** Padlocks whose system is in `block` leave with it (a splice moves the
   *  block to another page, which redraws them on its own placement). */
  private removeLockMarksOf(from: HTMLElement, block: Element[]): void {
    for (const l of Array.from(from.querySelectorAll(LOCK_SELECTOR))) {
      const sid = l.getAttribute('data-system');
      const sys = sid ? from.querySelector('#' + CSS.escape(sid))?.closest('g.system') ?? null : null;
      if (sys && block.includes(sys)) l.remove();
    }
  }

  /** After a page render: when the set of locks changed (a lock added or
   *  removed), redraw every mounted page's padlocks — a placement redraws only
   *  the pages it touched. */
  private syncLockMarks(model: ComposerModel): void {
    const sig = Array.from(lockStartIds(model)).join(',');
    if (sig === this.lastLockSig) return;
    this.lastLockSig = sig;
    if (!this.container) return;
    for (const page of Array.from(this.container.querySelectorAll('.score-page:not(.score-page-pending)'))) this.drawLockMarks(page);
  }

  /** The owned system holding measure `mi` (document index): its line index
   *  and first/last measure indices. Null unless page view with an owned
   *  multi-line partition whose ids all resolve in the current document. */
  systemOfMeasure(model: ComposerModel, mi: number): { lineIdx: number; startIdx: number; endIdx: number } | null {
    if (this.viewMode !== 'page' || !this.pageBreaks.ownershipActive()) return null;
    const ids = model.allMeasures().map((m) => m.getAttribute('xml:id') ?? '');
    const idx = new Map(ids.map((id, i) => [id, i]));
    const starts: number[] = [];
    for (const id of this.pageBreaks.lineStarts()) { const i = idx.get(id); if (i == null) return null; starts.push(i); }
    if (!starts.length || mi < 0 || mi >= ids.length) return null;
    let k = 0;
    while (k + 1 < starts.length && starts[k + 1] <= mi) k++;
    const startIdx = starts[k];
    const endIdx = (k + 1 < starts.length ? starts[k + 1] : ids.length) - 1;
    if (mi < startIdx || mi > endIdx) return null;
    return { lineIdx: k, startIdx, endIdx };
  }

  /** Max justified system width (SVG user units) from the mounted page DOM. */
  /** The justified system width a page-view line is measured against, in SVG
   *  user units — computed from PAGE GEOMETRY, never from a laid-out page.
   *
   *  Verovio justifies a system to the page's margin box, and its SVG user
   *  units are ten times the 1/100 mm option units (a margin of 140 emits
   *  `translate(1400, …)` on `g.page-margin`). Verified across six geometries
   *  on an isolated toolkit (2026-09-18): the rendered system width is exactly
   *  `(pageWidth − marginLeft − marginRight) × 10` plus a CONSTANT ~222 that
   *  does not scale with either term.
   *
   *  That constant is why this no longer reads the DOM. On a braced score it
   *  is the brace, which Verovio draws left of the staff in the page margin:
   *  every later system's bbox starts at x = −220, the brace's left edge,
   *  while its staff runs from 0 to exactly this budget (measured 2026-10-21;
   *  the first system's staff starts after the instrument names and the
   *  brace, which line 0 pays as `labelIndentW`). The per-measure naturals
   *  this budget divides do NOT carry it (their bboxes sum to the content
   *  width, 220 short of the system bbox). Measuring the system
   *  therefore inflated the budget by ~1.2 %, which made every fill ~1.2 % too
   *  SMALL and pushed marginal lines under the balancer's MIN_FILL floor of
   *  the time (0.65, retired 2026-10-20): an 8-measure locked
   *  section computed [4,4] as 0.6707 / 0.6451 against a 0.65 floor — short by
   *  0.0049 — so every two-line split was illegal and the section collapsed
   *  onto one compressed line of 8 (fixture lock_down_sparse_remainder_kept).
   *  On the geometry the same split is 0.6787 / 0.6528 and legal.
   *
   *  Computing it also removes the bootstrap: the partition no longer needs a
   *  laid-out page to exist before it can be chosen, so castoff never has to
   *  run to seed one. Always the PAGE block — the owner is page-view only;
   *  scroll's 100 000-unit page is a naturals-measurement geometry, not a
   *  justification target. */
  private pageBudgetW(): number {
    const g = this.scalePageGeom(PAGE_GEOM);
    return (g.pageWidth - g.pageMarginLeft - g.pageMarginRight) * 10;
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
      let stashedAssembler: PageAssembler | null = null;
      if (outgoing === 'page') {
        this.pageIo?.disconnect();
        this.pageIo = null;
        this.assembler?.finishSync();
        stashedAssembler = this.assembler;
        this.assembler = null;
      }
      this.modeCache[outgoing] = {
        nodes: Array.from(this.container!.childNodes),
        mei, zoom: this.zoom, pageScale: this.pageScale, theme: this.theme, assembler: stashedAssembler,
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
      if (this.viewMode === 'page') {
        this.assembler = entry.assembler;
        this.setContainerThemeTags();
        this.mountVisible();
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
    /* The scroll splicer's measure index is the live doc's; a one-staff DOCUMENT
       with a collapsed multimeasure rest (model/multirest.ts) has rendered
       measures the live index doesn't know, so that case re-engraves. Part
       views (viewStaves != null) already do. */
    const canSpliceNow = !this.forceFull && this.splicer.canSplice() && viewStaves == null
      && !model.renderUnits(viewStaves).active;
    if (!canSpliceNow) {
      this.renderSingleSystem(preMei ?? model.serialize(heji, viewStaves));
      if (viewStaves == null) this.splicer.capture(model, this.spliceCtx());
      else this.splicer.invalidate();
      this.forceFull = false;
      return true;
    }
    if (this.splicer.splice(model, viewStaves, this.spliceCtx())) return false;
    console.warn('[scroll-splice] edit could not be spliced (' +
      (this.splicer.lastSkipReason || 'unknown') + ') — full re-engrave');
    this.renderSingleSystem(model.serialize(heji, viewStaves));
    this.splicer.capture(model, this.spliceCtx());
    return true;
  }

  /** Post-render DOM treatment shared by page + scroll: crisp pinning, notehead
   *  z-order, HEJI/stacked-accidental glyph injection, and theming. */
  private postProcessRendered(container: HTMLElement, scope?: Element[], originPhaseX?: number): void {
    /* `scope` (A8, page splicer): run the per-system passes ONLY on these
       systems — the ones that will be imported into the live page. A splice
       window is 3–4 lines plus leader/trailer of which one line is typically
       replaced; snapping barlines, reordering noteheads and theming the context
       lines was ~30 ms of work on systems that are measured and discarded. Two
       passes stay host-wide regardless: pinExactScale (the root <svg> box sets
       the device scale every snap reads through getScreenCTM) and the HEJI
       injection (the context gate compares key-signature glyph identity, and the
       live pages' key signatures are HEJI-processed — a raw context line would
       refuse on glyph identity, and the pass is a no-op walk when nothing is
       tagged). An EMPTY scope means "no systems on this host are imported" and
       must not fall back to the whole host. */
    const t0 = performance.now();
    const st = { pin: 0, snapBar: 0, snapEdge: 0, noteheads: 0, text: 0, instr: 0, tuplets: 0, slurs: 0, ties: 0, heji: 0, theme: 0, total: 0, scoped: scope !== undefined, targets: scope ? scope.length : 1 };
    const targets: Element[] = scope !== undefined ? scope : [container];
    /* Pin device scale exact so thin staff lines stay grid-aligned (crisp) —
       counters Verovio's whole-px ceil of the root <svg> box. */
    let t = performance.now();
    pinExactScale(container, this.currentScale());
    st.pin = performance.now() - t;
    /* Page-1 title block: larger title, subtitle clear of it (render/pageheader.ts).
       Host-wide and BEFORE placement — the header's bbox is what
       `firstContentTop` anchors the first system under.
       The COMPOSER CREDIT is page furniture and is suppressed in scroll view
       (Max, backlog Layout): scroll renders with `header: 'none'`, so there is
       no title block for it to sit under, and `styleTitleBlock` synthesized a
       credit-only `g.pgHead` whose right-aligned text landed at the far END of
       the single continuous system. The footer and the running header are
       page-only for the same reason (main.ts `injectHeaderFooter`). Passing ''
       rather than skipping the call keeps the removal path, so a credit baked
       into a stashed/spliced scroll DOM is cleaned up. Page-view renders at
       scroll GEOMETRY (the line-break owner's naturals windows,
       buildOptions('none','scroll')) never reach here — they measure through
       the toolkit, not the DOM. */
    if (this.viewMode === 'scroll') styleTitleBlock(container, '');
    /* Crisp the verticals: snap intermediate barlines onto their pixel phase,
       then land each system's right edge (final barline + staff-line ends) on
       the grid (no sliver past the final bar). */
    t = performance.now();
    for (const el of targets) snapBarlines(el, this.currentScale(), CRISP_PRESETS[this.zoom].evenWidth);
    st.snapBar = performance.now() - t;
    t = performance.now();
    for (const el of targets) snapSystemRightEdge(el, this.currentScale(), originPhaseX);
    st.snapEdge = performance.now() - t;
    /* Bring noteheads to the front. Verovio renders each <g class="note"> as
       [notehead, dots, stem]; SVG z-order is document order, so the stem draws
       over the notehead. With colored noteheads + black stems the stem intrudes;
       move each notehead group last so it draws on top. */
    t = performance.now();
    for (const el of targets) {
      for (const note of Array.from(el.querySelectorAll('g.note'))) {
        const notehead = note.querySelector(':scope > g.notehead');
        if (notehead) note.appendChild(notehead);
      }
    }
    st.noteheads = performance.now() - t;
    /* Replace tagged placeholder accidentals with BravuraText HEJI / stacked
       glyphs (+ paren <use> swaps); plain accidentals and key signatures are
       re-drawn in BravuraText too. No-op when none are left. Host-wide.
       BEFORE every geometry pass (2026-10-18): the passes below measure
       accidentals as obstacles (text marks, instrument gaps, slur and tie
       re-draws), and a pass must measure the glyph that will be drawn. With
       the injection last, run 1 measured Verovio's Leipzig <use> boxes and a
       RE-RUN of the same passes (a zoom rescales every mounted page) measured
       BravuraText ink — a different answer for the same music, so the
       inter-instrument shift moved on every zoom (fixture
       `pag_zoomRerunKeepsSlursAndGaps`: 390 → 350 user units). */
    t = performance.now();
    injectHejiGlyphs(container);
    st.heji = performance.now() - t;
    /* Below-staff marks: keep <dir> text a dynamic's distance below a staff
       and a lone hairpin on the dynamics' line (render/textlayout.ts; inside a
       grand staff the marks are `between` and Verovio centres them — see
       expressions.ts `defaultMarkPlace`). Before placement measures
       the system — a nudged <dir> under a system's last staff is the one case
       that changes its extents — and idempotent, so a re-run on a mounted page
       is harmless. Needs the instrument table for which staff pairs are grand
       staves; a render before any model is known centres nothing. */
    {
      const pairs: Array<readonly [number, number]> = [];
      for (const inst of this.lastModel?.instruments() ?? []) {
        if (inst.staffNs.length === 2) pairs.push([inst.staffNs[0], inst.staffNs[1]]);
      }
      /* Refill the barline stretches Verovio erased under those marks
         (render/barlines.ts) BEFORE the marks move: a barline never breaks. */
      for (const el of targets) repairBarLines(el, pairs);
      /* A RE-RUN (a zoom rescales every mounted page, 2026-10-18) must see
         the geometry run 1 saw: the inter-instrument shift comes off BEFORE
         the text pass measures, or the clamp that pass records — and the gap
         pass's "unmet" term reads — is taken against an already-widened gap
         and the shift decays. The gap pass resets again before measuring. */
      for (const el of targets) resetInstrumentGaps(el);
      const dirGapUser = DIR_GAP_PER_UNIT * CRISP_PRESETS[this.zoom].unit;
      t = performance.now();
      for (const el of targets) layoutBelowStaffText(el, { dirGapUser });
      st.text += performance.now() - t;
      /* Then the inter-instrument clearance (render/instrgap.ts): it needs the
         marks SETTLED (its metric measures what is actually drawn) and it also
         has to release textlayout's INSTR_CLEAR clamp, which is what left
         p. 21 m. 94's "rit." on a slur. Those two wants conflict in time, so
         textlayout runs again on the systems this pass moved — one extra round
         is enough by construction: widening only ever LOOSENS a clamp, and the
         shift granted is exactly the demand the first round could not meet, so
         the second cannot ask for more. Gated on "this system moved", which on
         the sonata is 48 of 113. */
      const instrStaffNs = (this.lastModel?.instruments() ?? []).map((i) => i.staffNs);
      if (instrStaffNs.length > 1) {
        const unit = CRISP_PRESETS[this.zoom].unit;
        const gapOpts = { instrStaffNs, grid: 1000 / this.currentScale(), unitUser: unit * 10 };
        const shifted = new Set<Element>();
        t = performance.now();
        for (const el of targets) for (const sys of layoutInstrumentGaps(el, gapOpts)) shifted.add(sys);
        st.instr = performance.now() - t;
        t = performance.now();
        for (const sys of shifted) layoutBelowStaffText(sys, { dirGapUser });
        st.text += performance.now() - t;
      }
      /* Bracketless tuplet numerals off their beams (render/tupletnums.ts),
         then flipped slurs Verovio carried away from their notes re-drawn at
         them (render/slurlayout.ts; the numerals and Verovio's ties are its
         obstacles, so the numerals settle first and any tie re-arched by a
         previous run is put back) — both before placement: the numeral can
         grow a system by a few units, and a re-drawn slur hugs its notes, so
         it only ever shrinks the extents. */
      const unitUser = CRISP_PRESETS[this.zoom].unit * 10;
      t = performance.now();
      for (const el of targets) layoutTupletNums(el, { unitUser });
      st.tuplets = performance.now() - t;
      t = performance.now();
      for (const el of targets) restoreTieRedraws(el);
      for (const el of targets) layoutFlippedSlurs(el, { unitUser });
      /* Then every other slur a lifted numeral now runs into is lifted over
         it, Verovio's endpoints kept (render/slurlayout.ts, 2026-10-18). */
      for (const el of targets) liftSlursOffShiftedNumerals(el, { unitUser });
      st.slurs = performance.now() - t;
    }
    /* Ties Verovio drew through another voice, re-arched over it
       (render/tielayout.ts). After the slur pass, whose final curves are
       obstacles (every accidental is a BravuraText <text> by now, measured by
       its ink). Still before placement: a raised tie can grow a system's
       extents. */
    t = performance.now();
    {
      const unitUser = CRISP_PRESETS[this.zoom].unit * 10;
      for (const el of targets) layoutCollidingTies(el, { unitUser });
    }
    st.ties = performance.now() - t;
    /* Theme: tag the container for the shared notation-theme CSS and repaint
       noteheads with their light-source variant in dark/transparent themes.
       'transparent' shares dark's ink; the .theme-transparent class drops fills.
       Scoped: each imported system carries its own tag (the CSS matches
       descendants of any tagged element; the live page is tagged anyway). */
    t = performance.now();
    for (const el of targets) applyNotationTheme(el as HTMLElement | SVGElement, this.theme === 'light' ? 'light' : 'dark');
    container.classList.toggle('theme-transparent', this.theme === 'transparent');
    st.theme = performance.now() - t;
    st.total = performance.now() - t0;
    this.lastPostStats = st;
  }

  /** Per-pass wall of the last `postProcessRendered` call (diagnostics for
   *  `edit-cost-attribution.js`; A8). */
  lastPostStats: { pin: number; snapBar: number; snapEdge: number; noteheads: number; text: number; instr: number; tuplets: number; slurs: number; ties: number; heji: number; theme: number; total: number; scoped: boolean; targets: number } | null = null;

  /** Page mode: mount the page holding this measure so rectForId / the cursor
   *  overlay can resolve it (a cursor move, scroll-into-view, or playback bar
   *  may target a page still held as a placeholder). Scroll mode renders the
   *  whole score in one SVG, so it's a no-op there. Call sites stay
   *  mode-agnostic. */
  ensureMeasureMounted(mi: number): void {
    if (this.viewMode !== 'page' || !this.assembler) return;
    this.assembler.ensureMeasureMounted(mi);
  }


  /* ── page assembly (decisions.md "Composer draws the pages", 2026-10-08) ──────────── */

  /** True while pages are still being assembled after a render (idle slices). */
  assemblyPending(): boolean {
    return this.assembler?.pending() ?? false;
  }

  /** Test/probe compatibility: the page state object. Its IDENTITY changes on
   *  every full render and survives a splice (what fixtures compare), and it
   *  carries `pageCount` and `mounted` as the old virtualization record did. */
  get pageVirt(): PageAssembler | null {
    return this.assembler;
  }

  /** The lines of `newStartIds` a changed measure run reaches — what
   *  `applyPartition` re-engraves. The run's first measure pulls its
   *  predecessor in when it holds a layer clef (`relocateInitialClefs` draws a
   *  measure-initial clef at the end of the PREVIOUS measure, possibly on the
   *  line above — the splicer's rule); a signature range already starts one
   *  measure early for the end-of-line courtesy (sigranges.ts). */
  private changedLineIdsFor(model: ComposerModel, run: { lo: number; hi: number } | null, newStartIds: readonly string[]): Set<string> {
    const out = new Set<string>();
    if (!run) return out;
    const meas = model.allMeasures();
    const ids = meas.map((m) => m.getAttribute('xml:id') ?? '');
    const idIdx = new Map(ids.map((id, i) => [id, i]));
    let lo = Math.min(run.lo, ids.length - 1);
    if (lo > 0 && meas[lo]?.querySelector(':scope > staff > layer > clef')) lo--;
    const hi = Math.min(run.hi, ids.length - 1);
    const starts = newStartIds.map((id) => idIdx.get(id) ?? -1);
    for (let k = 0; k < newStartIds.length; k++) {
      const a = starts[k];
      if (a < 0) continue;
      const b = k + 1 < newStartIds.length && starts[k + 1] >= 0 ? starts[k + 1] - 1 : ids.length - 1;
      if (b >= lo && a <= hi) out.add(newStartIds[k]);
    }
    return out;
  }

  /** Pages holding the measures a changed page break / section header precedes. */
  private pagesOfBreaks(breakIds: readonly string[]): number[] {
    const out: number[] = [];
    for (const id of breakIds) {
      const mi = this.measureIds.indexOf(id);
      if (mi < 0) continue;
      const p = this.pageOfMeasure(mi);
      if (p >= 1 && !out.includes(p)) out.push(p);
    }
    return out;
  }

  /** Setup apply: the page headers changed (title, subtitle, composer). Redraw
   *  them on every built page and re-fit from page 1 — no system renders. */
  refreshPageHeaders(): void {
    if (this.viewMode !== 'page' || !this.assembler) return;
    this.assembler.refreshHeaders(this.shellMeta());
  }

  /** Map a repagination onto the cascade diagnostics the probes and fixtures
   *  read: a rebuilt page is a step, a moved system a transplant, a page the
   *  rebuild added a creation. */
  private noteRepagination(): void {
    const st = this.assembler?.lastRepaginate;
    if (!st) return;
    this.lastCascade = {
      ...this.lastCascade,
      steps: st.rebuiltPages, transplanted: st.movedSystems, arithmetic: 0, parked: 0,
      created: Math.max(0, st.pagesAfter - st.pagesBefore), ms: Math.round(st.ms),
    };
  }

  /** Page view, every non-splice path: build the pages from measured systems.
   *  `reseed` recomputes the line partition from naturals (a derive); false
   *  keeps the owner's committed partition (a refill the splicer refused). */
  private assembleDocument(model: ComposerModel, viewStaves: number[] | null, reseed: boolean): void {
    /* The card count to show from the first paint: the same document's
       previous count (zoom, page scale, view change), the cached pagination's
       on a round trip, else page 1's estimate once it closes. */
    const sameDoc = this.assembler !== null && this.lastAssembledDocVer === model.docVersion();
    let expected: number | null = sameDoc ? this.assembler!.cardCount() : null;
    const geomNow = this.shellGeom();
    const newPageH = geomNow.pageHeight * geomNow.scale / 100;
    const scrollScale = sameDoc && this.assembler!.pageH > 0 ? newPageH / this.assembler!.pageH : 1;
    this.disposePages();
    const ctx = this.pageBreaksCtx();
    let lines: string[] | null = null;
    if (reseed || !this.pageBreaks.ownershipActive()) {
      const cached = this.partitionCache.get(this.partitionKey(model));
      if (cached && cached.docVer === model.docVersion()
          && this.pageBreaks.restorePartition(model, cached.lines, [], cached.widths, this.pageBudgetW())) {
        lines = cached.lines;
        if (cached.pages.length) expected = cached.pages.length;
      } else {
        lines = this.pageBreaks.seedPartition(model, ctx, this.pageBudgetW());
        if (lines && lines.length > 1) this.balanceInitialBand(model);
        if (this.pageBreaks.ownershipActive()) lines = this.pageBreaks.lineStarts();
      }
    } else {
      lines = this.pageBreaks.lineStarts();
    }
    if (!lines || !lines.length) { this.container!.innerHTML = ''; return; }
    this.assembler = new PageAssembler(this.assemblyHost(), this.pageBreaks, this.extents);
    this.assembler.begin(lines, model.docVersion(), this.mountWindowMi >= 0 ? this.mountWindowMi : null, expected, scrollScale);
    this.lastAssembledDocVer = model.docVersion();
    this.setContainerThemeTags();
    this.armPageIo();
    this.lastCascade = { ...this.lastCascade, steps: 0, transplanted: 0, arithmetic: 0, parked: 0, created: 0 };
  }

  private assemblyHost(): AssemblyHost {
    return {
      container: this.container!,
      scroller: this.scroller!,
      model: () => this.lastModel!,
      measureIds: () => this.measureIds,
      lineRenderCtx: () => this.lineRenderCtx(),
      shellGeom: () => this.shellGeom(),
      shellMeta: () => this.shellMeta(),
      fitConstants: () => this.fitConstants(),
      gridUser: () => 1000 / this.currentScale(),
      postProcess: (div, scope) => {
        const scoped = this.substituteHiddenStaffSystems(div, scope);
        this.postProcessRendered(div, scoped, this.originPhaseXOf(div));
        return scoped;
      },
      decorate: (div) => styleVoltaNumbers(div),
      placePage: (div) => { this.placePage(div); },
      firstContentTop: (margin, k) => this.firstContentTop(margin, k),
      contentBottomOf: (margin) => this.contentBottomOf(margin),
      headerMeasureIds: () => this.headerMeasureIds(),
      onPageMounted: (div) => this.onPageMountedCb?.(div),
      removeLockMarksOf: (div, systems) => this.removeLockMarksOf(div, systems),
      applyTheme: (div) => this.applyThemeTo(div),
      foldTolerance: () => 2 * 1000 / this.currentScale(),
      observePlaceholder: (div) => { this.pageIo?.observe(div); },
    };
  }

  /** How a line window is rendered: the live page options, `breaks:'encoded'`
   *  (the window carries its own `<sb>` pins), the isolated toolkit. */
  private lineRenderCtx(): LineRenderCtx {
    return { toolkit: this.spliceTk!, windowOptions: this.buildOptions('encoded', 'page'), viewStaves: this.viewStaves };
  }

  private shellGeom(): ShellGeom {
    const g = this.scalePageGeom(PAGE_GEOM);
    return { pageWidth: g.pageWidth, pageHeight: g.pageHeight, pageMarginLeft: g.pageMarginLeft, pageMarginTop: g.pageMarginTop, scale: CRISP_PRESETS[this.zoom].scale };
  }

  private shellMeta(): ShellMeta {
    const m = this.lastModel;
    return { title: m?.getTitle() ?? '', subtitle: m?.getSubtitle() ?? '', composer: m?.getComposer() ?? '' };
  }

  /** Drop the page DOM's bookkeeping (it is about to be replaced). */
  private disposePages(): void {
    this.assembler?.cancel();
    this.assembler = null;
    this.extents.clear();
    this.pageIo?.disconnect();
    this.pageIo = null;
    this.cancelPump();
  }

  /** Mount every parked page whose placeholder lies within one page-height of
   *  the viewport (restore time: what the user looks at is never blank). */
  private mountVisible(): void {
    const as = this.assembler;
    if (!as || !this.container || !this.scroller) return;
    const view = this.scroller.getBoundingClientRect();
    const pad = as.pageH || view.height;
    for (const div of Array.from(this.container.querySelectorAll('.score-page-pending')) as HTMLElement[]) {
      const r = div.getBoundingClientRect();
      if (r.bottom >= view.top - pad && r.top <= view.bottom + pad) this.mountOne(Number(div.dataset.page));
    }
  }

  /** Attach one parked page (no render) and stop observing its placeholder. */
  private mountOne(p: number): boolean {
    const as = this.assembler;
    if (!as) return false;
    const ok = as.mount(p, false);   // the scroll path never builds a page synchronously
    const div = this.pageDiv(p);
    if (ok && div) this.pageIo?.unobserve(div);
    return ok;
  }

  /** Park one mounted page and observe its placeholder for a scroll-back. */
  private evictPage(p: number): void {
    const as = this.assembler;
    if (!as) return;
    as.unmount(p);
    const div = this.pageDiv(p);
    if (div) this.pageIo?.observe(div);
  }

  /** Theme tags on one page (a page re-attached from the park, or closed while
   *  the theme is dark). Mirrors applyThemeToRendered for a single page. */
  private applyThemeTo(div: HTMLElement): void {
    const theme = this.theme === 'light' ? 'light' : 'dark';
    applyNotationTheme(div, theme);
    for (const el of Array.from(div.querySelectorAll('[data-notation-theme]')).concat([div])) {
      if (theme === 'light') delete (el as HTMLElement).dataset.notationTheme;
      else (el as HTMLElement).dataset.notationTheme = 'dark';
    }
  }

  /** Probe API (kept for the sonata probes): is the line's extent known? */
  extentsKnown(startId: string): boolean {
    return this.extents.get(startId) !== undefined;
  }

  /** Probe API: finish the assembly now and rebuild every page a clipped
   *  splice deferred, so a later mount is a plain re-attach (the old extents
   *  job's "warm"). Returns the pages it rebuilt. */
  runExtentsJobNow(): number[] {
    const as = this.assembler;
    if (!as) return [];
    as.finishSync();
    return as.rebuildDeferred();
  }

  /** Test compatibility: mount / park one page (the old lazy-mount entry
   *  points, bracket-accessed by fixtures). */
  private mountPage(p: number): void {
    this.mountOne(p);
  }
  private unmountPage(p: number): void {
    this.evictPage(p);
  }

  /** Probe API: the extents job is gone; null means "nothing pending". */
  extentsJobState(): null {
    return null;
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

  /** Bounding rect of a rendered MEI element by xml:id, in the content frame
   *  (the cursor overlay's). Returns null if not found in the current SVG. */
  rectForId(meiId: string): DOMRect | null {
    if (!this.container) return null;
    const node = this.container.querySelector('#' + CSS.escape(meiId));
    return node ? this.rectForElement(node) : null;
  }

  /** Bounding rect of a rendered element in the content frame (the frame
   *  rectForId reports). The frame scrolls and re-centres with the content,
   *  so no scroll offset enters. */
  rectForElement(el: Element): DOMRect | null {
    if (!this.container) return null;
    const containerRect = this.container.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return new DOMRect(r.left - containerRect.left, r.top - containerRect.top, r.width, r.height);
  }

  /** Rendered elements matching `selector` (in document order). */
  queryRendered(selector: string): Element[] {
    return this.container ? Array.from(this.container.querySelectorAll(selector)) : [];
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
    /* g.mRest / g.multiRest count as content too: an empty bar renders as
       [mRest, courtesy clef] once a clef change follows it, and without the
       rest as a bound that courtesy clef passed as the LEADING sig, pulling
       the empty bar's wrapper cursor to the barline (2026-09-27). */
    for (const n of Array.from(this.container.querySelectorAll('g.note, g.chord, g.rest, g.mRest, g.multiRest'))) {
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
    return rightmost - containerRect.left;
  }
}


export const renderer = new Renderer();
