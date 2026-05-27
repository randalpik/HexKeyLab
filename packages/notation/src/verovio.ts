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

const VEROVIO_CDN = 'https://www.verovio.org/javascript/latest/verovio-toolkit-wasm.js';

/* Single-page, no-breaks geometry for a one-measure inset. A large pageWidth
 * gives breaks:'none' headroom and Verovio clips the emitted SVG width to the
 * actual content extent; adjustPageHeight trims the height to content too, so
 * the SVG is snug to the grand-staff chord (no excess padding — tight margins
 * keep the surround minimal). The inset box centers this SVG vertically and
 * left-aligns it, so the staff stays put as notes are added. scale is a
 * preapproved preset (50 → crisp 1px lines at this size). */
const INSET_OPTIONS = {
  svgAdditionalAttribute: ['note@data-q', 'note@data-r', 'note@color', 'accid@type'],
  footer: 'none',
  header: 'none',
  breaks: 'none',
  adjustPageHeight: true,
  pageWidth: 100000,
  pageHeight: 60000,
  pageMarginTop: 40,
  pageMarginBottom: 40,
  pageMarginLeft: 40,
  pageMarginRight: 40,
  scale: 50,
  /* A whole note normally reserves a full measure's worth of horizontal space,
     leaving a long gap between the chord and the right barline. Collapse the
     duration-driven spacing so the barline sits just past the chord. */
  spacingLinear: 0.4,
  spacingNonLinear: 0.4,
};

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
export async function renderMeiToContainer(mei: string, container: HTMLElement): Promise<void> {
  const tk = await loadVerovioToolkit();
  tk.setOptions(INSET_OPTIONS);
  if (!tk.loadData(mei)) {
    container.innerHTML = '<div style="color:#c00;padding:8px;font-size:11px">Verovio loadData failed (invalid MEI).</div>';
    return;
  }
  container.innerHTML = tk.renderToSVG(1, {});
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
}
