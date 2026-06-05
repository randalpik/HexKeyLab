// Lazy Verovio WASM loader + a stateless "render this MEI into this container"
// entry point, for the live-chord staff inset (and reusable by any future
// single-shot Verovio render in HKL). The CDN script is fetched on first use,
// so HKL's startup pays nothing until a feature actually renders notation.
//
// HKL Composer keeps its own stateful Renderer (page/scroll/zoom/cursor
// helpers); this module is the minimal counterpart for one-shot renders.

import './verovio-types.js';
import type { VerovioToolkit } from './verovio-types.js';
import { injectHejiGlyphs } from './heji-render.js';
import { ensureNotationThemeStyle } from './notation-theme.js';
import { SANCTIONED_LIGHT, sanctionedLightForInk } from '@hkl/shared/colors.js';
import { CRISP_PRESETS, crispMarginTop, lineWidthOptions, pinExactScale, snapStaffLinesToGrid, snapBarlines, snapSystemRightEdge } from './render-presets.js';

/* The frame + inset both render at the 50% crisp preset (the Composer-view frame
   mirrors Composer's 50% scroll). Single source of truth for scale/unit/widths. */
const FRAME_PRESET = CRISP_PRESETS[50];

const VEROVIO_CDN = 'https://www.verovio.org/javascript/latest/verovio-toolkit-wasm.js';

/* Single-page, no-breaks geometry for a one-measure inset. A large pageWidth
 * gives breaks:'none' headroom and Verovio clips the emitted SVG width to the
 * actual content extent; adjustPageHeight trims the height to content too, so
 * the SVG is snug to the grand-staff chord (no excess padding — tight margins
 * keep the surround minimal). The inset box centers this SVG vertically and
 * left-aligns it, so the staff stays put as notes are added. scale is a
 * preapproved preset (50 → crisp 1px lines at this size). */
/* `rest@data-tuplet-placeholder` + `rest@visible` are surfaced so a consuming
   container can hide tuplet-bracket placeholder rests and user-hidden rests in
   CSS (Verovio doesn't honor @visible on rests — see the Composer render
   options + index.html). They appear in the SVG as data-data-tuplet-placeholder
   / data-visible (Verovio prepends data-). */
/* Mirrors Composer's BASE_OPTIONS svgAdditionalAttribute exactly (incl.
   note@hkl-paren-caut, which injectHejiGlyphs reads to nudge paren-cautionary
   accidentals — omitting it would render those differently). */
const ADDITIONAL_ATTRS = ['note@data-q', 'note@data-r', 'note@color', 'note@data-light-color', 'note@hkl-paren-caut', 'rest@data-tuplet-placeholder', 'rest@visible', 'accid@type'];

const INSET_OPTIONS = {
  svgAdditionalAttribute: ADDITIONAL_ATTRS,
  footer: 'none',
  header: 'none',
  breaks: 'none',
  adjustPageHeight: true,
  pageWidth: 100000,
  pageHeight: 60000,
  /* Crisp 50% preset: scale/unit/whole-px line widths, and a pageMarginTop whose
     parity puts staff lines on half-pixel centers (1px-crisp). pinExactScale (in
     renderMeiToContainer) keeps the device scale exact. */
  pageMarginTop: crispMarginTop(40, FRAME_PRESET.scale, FRAME_PRESET.evenWidth),
  pageMarginBottom: 40,
  pageMarginLeft: 40,
  pageMarginRight: 40,
  scale: FRAME_PRESET.scale,
  unit: FRAME_PRESET.unit,
  ...lineWidthOptions(FRAME_PRESET),
  /* A whole note normally reserves a full measure's worth of horizontal space,
     leaving a long gap between the chord and the right barline. Collapse the
     duration-driven spacing so the barline sits just past the chord. */
  spacingLinear: 0.4,
  spacingNonLinear: 0.4,
};

/* Continuous-scroll geometry for HKL's read-only "Composer view" frame. MUST
   be byte-for-byte the same Verovio options Composer uses for its scroll view
   at 50% zoom (apps/composer SCROLL_GEOM + BASE_OPTIONS + scale 50, header
   none), so the frame's render is pixel-identical: same pageWidth/Height, same
   30-unit margins, breaks:'none', NO adjustPageHeight, NO spacing overrides,
   scale 50. (The geometricPrecision line rendering Composer applies via CSS is
   mirrored on #composerFrame in apps/hkl/index.html.) */
const SCROLL_OPTIONS = {
  svgAdditionalAttribute: ADDITIONAL_ATTRS,
  footer: 'none',
  header: 'none',
  breaks: 'none',
  pageWidth: 100000,
  pageHeight: 400,
  /* crispMarginTop(30,…) → 31 at the 50% preset (odd → half-pixel line phase). */
  pageMarginTop: crispMarginTop(30, FRAME_PRESET.scale, FRAME_PRESET.evenWidth),
  pageMarginBottom: 30,
  pageMarginLeft: 30,
  pageMarginRight: 30,
  scale: FRAME_PRESET.scale,
  unit: FRAME_PRESET.unit,
  ...lineWidthOptions(FRAME_PRESET),
};

/** Dark-theme notehead color: only ever a SANCTIONED light-source color. Prefer
 *  the baked light variant (`data-light-color`) when it's sanctioned; otherwise
 *  reverse-map the baked ink color to its sanctioned light variant. Anything
 *  unrecognized (a foreign / corrupt import) returns white — NOT an
 *  approximation — so a bad import is obvious. */
function sanctionedDarkNotehead(light: string | null, ink: string | null): string {
  if (light && SANCTIONED_LIGHT.has(light.toLowerCase())) return light;
  const mapped = ink ? sanctionedLightForInk(ink) : null;
  return mapped ?? '#ffffff';
}

export type NotationTheme = 'light' | 'dark';
export interface RenderOpts { geometry?: 'inset' | 'scroll'; theme?: NotationTheme }

/** Apply a notation theme to an already-rendered container: tags it with
 *  `data-notation-theme` (so the shared notation-theme.css recolors staff /
 *  stems / accidentals via --notation-ink/--notation-bg) and, in dark theme,
 *  repaints noteheads with their bright `data-light-color` lattice variant
 *  (the baked ink `color` is unreadable on a dark background). Old documents
 *  without a light variant fall back to a brightness filter so they stay
 *  legible. Exported so the stateful Composer renderer reuses the exact same
 *  pass. Safe to call repeatedly. */
export function applyNotationTheme(container: HTMLElement, theme: NotationTheme): void {
  /* Light theme is a strict no-op: we leave `data-notation-theme` UNSET so the
     shared stylesheet's `[data-notation-theme] …` rules don't match, and the
     SVG renders exactly as Verovio emitted it (byte-identical to the unthemed
     path). Only dark theme tags the container + repaints noteheads. */
  if (theme === 'dark') {
    ensureNotationThemeStyle();
    container.dataset.notationTheme = 'dark';
  } else {
    delete container.dataset.notationTheme;
  }
  for (const note of Array.from(container.querySelectorAll('g.note'))) {
    const heads = note.querySelectorAll(':scope > g.notehead, :scope > g.notehead *');
    /* Verovio prefixes svgAdditionalAttribute names with `data-`, so the MEI
       `data-light-color` surfaces as `data-data-light-color` in the SVG (same
       quirk as data-q → data-data-q). Read that, with a plain fallback. The
       baked ink color (MEI @color) likewise surfaces as `data-color`. */
    const light = note.getAttribute('data-data-light-color') ?? note.getAttribute('data-light-color');
    const ink = note.getAttribute('data-color') ?? note.getAttribute('color');
    for (const h of Array.from(heads)) {
      const s = (h as SVGElement).style;
      if (theme === 'dark') {
        /* Paint the notehead via INLINE color + fill. Inline style beats the
           (non-important) dark stylesheet rules, so the broad recolor never
           clobbers the notehead — and setting `color` (not just `fill`) makes
           the notehead's own `stroke: currentColor` match its fill, so it gets
           no ink outline. Old docs without a light variant keep the baked ink
           color but brighten it so it stays legible on dark. */
        const c = sanctionedDarkNotehead(light, ink);
        s.setProperty('color', c); s.setProperty('fill', c); s.removeProperty('filter');
      } else {
        s.removeProperty('color');
        s.removeProperty('fill');
        s.removeProperty('filter');
      }
    }
  }
}

let toolkitPromise: Promise<VerovioToolkit> | null = null;

/** Resolve the singleton toolkit, loading the CDN WASM script on first call. */
export function loadVerovioToolkit(): Promise<VerovioToolkit> {
  if (toolkitPromise) return toolkitPromise;
  toolkitPromise = new Promise<VerovioToolkit>((resolve, reject) => {
    const bind = (): void => {
      const v = window.verovio;
      if (!v) { reject(new Error('Verovio global missing after load')); return; }
      v.module.onRuntimeInitialized = () => resolve(new v.toolkit());
    };
    if (window.verovio) { bind(); return; }
    const tag = document.createElement('script');
    tag.src = VEROVIO_CDN;
    tag.async = true;
    tag.onload = bind;
    tag.onerror = () => reject(new Error('failed to load Verovio from ' + VEROVIO_CDN));
    document.head.appendChild(tag);
  });
  return toolkitPromise;
}

/** Render an MEI string into `container` as a single inset page. Loads Verovio
 *  if needed. Runs the same notehead-to-front + HEJI-glyph injection passes the
 *  Composer renderer uses, so HEJI placeholders produced by transformDocForHeji
 *  resolve to real BravuraText glyphs. */
export async function renderMeiToContainer(mei: string, container: HTMLElement, opts?: RenderOpts): Promise<void> {
  const theme: NotationTheme = opts?.theme ?? 'light';
  const tk = await loadVerovioToolkit();
  /* Reset first: this singleton toolkit is shared between the inset and the
     scroll frame, and Verovio's setOptions MERGES — without a reset the inset's
     spacing (spacingLinear/NonLinear, adjustPageHeight) leaks into the frame,
     making its note spacing differ from Composer's (it doesn't set them). A
     clean slate guarantees the frame's options exactly match Composer's. */
  tk.resetOptions();
  tk.setOptions(opts?.geometry === 'scroll' ? SCROLL_OPTIONS : INSET_OPTIONS);
  if (!tk.loadData(mei)) {
    container.innerHTML = '<div style="color:#c00;padding:8px;font-size:11px">Verovio loadData failed (invalid MEI).</div>';
    return;
  }
  container.innerHTML = tk.renderToSVG(1, {});
  /* Pin the device scale exact so thin staff lines stay on the pixel grid
     (counters Verovio's whole-px ceil of the root box). See render-presets.ts. */
  pinExactScale(container, FRAME_PRESET.scale);
  /* Crisp staff lines per-staff (grand-staff bass can be displaced), barlines,
     and the system's right edge (final barline + staff-line ends). */
  snapStaffLinesToGrid(container, FRAME_PRESET.scale, FRAME_PRESET.evenWidth);
  snapBarlines(container, FRAME_PRESET.scale, FRAME_PRESET.evenWidth);
  snapSystemRightEdge(container, FRAME_PRESET.scale);
  /* Bring noteheads to the front so black stems don't draw over the colored
     notehead (Verovio emits [notehead, dots, stem] in document order). */
  for (const note of Array.from(container.querySelectorAll('g.note'))) {
    const notehead = note.querySelector(':scope > g.notehead');
    if (notehead) note.appendChild(notehead);
  }
  /* injectHejiGlyphs measures BravuraText advances via getComputedTextLength;
     if the font isn't loaded yet those come back wrong and accidentals land
     misaligned. Wait for it before injecting. */
  if (document.fonts?.load) {
    try { await document.fonts.load('1em "BravuraText"'); } catch { /* fall through */ }
  }
  injectHejiGlyphs(container);
  applyNotationTheme(container, theme);
}
