// The page, drawn by Composer (decisions.md "Composer draws the pages", 2026-10-08).
//
// A page used to be Verovio's `renderToSVG(p)` of a pinned layout, and every
// system on it Verovio's; Composer then re-placed the systems (pagefit.ts),
// restyled the header (pageheader.ts, main.ts) and injected the furniture.
// Since pagination is first-fit over MEASURED systems (each rendered from a
// one-line window, render/systemrender.ts), there is no Verovio page any
// more: Composer draws the paper, the margin frame, the header and the
// footer, and moves the measured `g.system` elements in.
//
// The shell reproduces a Verovio page's NESTING exactly —
//   svg[width,height] > defs + style + svg.definition-scale[viewBox]
//     > g.page-margin[translate] > g.pgHead + g.system…
// — because everything that reads a page does so by that structure: the
// placement pass (`pageSystems` → `g.page-margin` + the inner viewBox for the
// paper bottom), `svgBox` (the page-margin frame through the definition-scale
// viewBox), `pageFrameOf` (the margins from the translate), the splicer, the
// PDF export (the page DOM, page for page) and the reference gate.
//
// The header is drawn at Verovio's own geometry (pageheader.ts
// VEROVIO_* — the title baseline at 371 for x-large 540 px, the page number
// baseline at 196 for 288 px), restyled exactly as `styleTitleBlock` and
// `styleRunningHeader` restyled Verovio's: the title at TITLE_FONT_PX keeping
// its em-box top, the subtitle on the next line at SUBTITLE_FONT_PX, the
// composer credit right-aligned CREDIT_GAP below the block, the page number
// at RUNNING_HEADER_FONT_PX in the outer top corner with the running title
// centered. `data-hkl-head-bottom` records the header's ink bottom
// ANALYTICALLY from the nominal em-boxes — the value Verovio's original
// header measured to (256 on pages 2+) — so placement never measures a
// header and every host agrees (Firefox gives no useful tspan bbox).

import {
  TITLE_FONT_PX, SUBTITLE_FONT_PX, CREDIT_FONT_PX, RUNNING_HEADER_FONT_PX,
  SUBTITLE_GAP, CREDIT_GAP,
  VEROVIO_TITLE_BASELINE, VEROVIO_TITLE_FONT_PX, VEROVIO_PGNUM_BASELINE, VEROVIO_PGNUM_FONT_PX,
  ascentOf, bottomOf, baselineFor,
} from './pageheader.js';

import { STYLE_ROOT_TOKEN } from './systemrender.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
let shellSeq = 0;

/** Page geometry in Verovio option units (the scaled PAGE_GEOM). */
export interface ShellGeom {
  pageWidth: number;
  pageHeight: number;
  pageMarginLeft: number;
  pageMarginTop: number;
  /** The Verovio `scale` option (the zoom preset): the root box is
   *  `pageWidth × scale / 100` CSS px, as Verovio's own root was. */
  scale: number;
}

/** What the header shows. */
export interface ShellMeta {
  title: string;
  subtitle: string;
  composer: string;
}

export interface PageShell {
  svg: SVGSVGElement;
  defs: SVGDefsElement;
  margin: SVGGElement;
  /** Header ink bottom in the page-margin frame, or null for a header-less page. */
  headBottom: number | null;
}

const text = (doc: Document, cls: string, x: number, y: number, anchor: 'start' | 'middle' | 'end', fontPx: number, content: string): SVGTextElement => {
  const t = doc.createElementNS(SVG_NS, 'text') as SVGTextElement;
  t.setAttribute('class', cls);
  t.setAttribute('x', String(x));
  t.setAttribute('y', String(Math.round(y)));
  t.setAttribute('text-anchor', anchor);
  t.setAttribute('font-size', fontPx + 'px');
  t.setAttribute('font-family', 'Times, serif');
  t.textContent = content;
  return t;
};

/** Draw a page's header into `margin` (replacing any `g.pgHead` there) and
 *  return its ink bottom in the page-margin frame (null = no header). Page 1
 *  carries the title block; every later page the page number and the running
 *  title. `innerW` is the content column's width (pageFrameOf). Also used on
 *  the reference gate's Verovio page, so the two hosts carry one header. */
export function drawPageHeader(margin: Element, pageNo: number, meta: ShellMeta, innerW: number): number | null {
  const doc = margin.ownerDocument!;
  margin.querySelector(':scope > g.pgHead')?.remove();
  margin.querySelector(':scope > text.hkl-running-title')?.remove();
  const head = doc.createElementNS(SVG_NS, 'g');
  head.setAttribute('class', 'pgHead hkl-page-header');
  let bottom: number | null = null;
  if (pageNo === 1) {
    const title = meta.title.trim(), subtitle = meta.subtitle.trim(), composer = meta.composer.trim();
    if (!title && !composer) return null;
    let blockBottom: number | null = null;
    if (title) {
      /* The title keeps the em-box top Verovio gave its x-large title: the
         baseline moves down by exactly the ascent growth (pageheader.ts). */
      const titleBaseline = VEROVIO_TITLE_BASELINE + (ascentOf(TITLE_FONT_PX) - ascentOf(VEROVIO_TITLE_FONT_PX));
      head.appendChild(text(doc, 'hkl-title', innerW / 2, titleBaseline, 'middle', TITLE_FONT_PX, title));
      blockBottom = bottomOf(titleBaseline, TITLE_FONT_PX);
      if (subtitle) {
        const subBaseline = Math.round(baselineFor(blockBottom + SUBTITLE_GAP, SUBTITLE_FONT_PX));
        head.appendChild(text(doc, 'hkl-subtitle', innerW / 2, subBaseline, 'middle', SUBTITLE_FONT_PX, subtitle));
        blockBottom = bottomOf(subBaseline, SUBTITLE_FONT_PX);
      }
    }
    if (composer) {
      const want = blockBottom === null ? 0 : blockBottom + CREDIT_GAP;
      const creditBaseline = Math.round(baselineFor(want, CREDIT_FONT_PX));
      head.appendChild(text(doc, 'hkl-injected-composer', innerW, creditBaseline, 'end', CREDIT_FONT_PX, composer));
      bottom = bottomOf(creditBaseline, CREDIT_FONT_PX);
    } else {
      bottom = blockBottom;
    }
    if (!composer) head.classList.remove('hkl-credit-only');
  } else {
    const even = pageNo % 2 === 0;
    const num = text(doc, 'hkl-page-number', even ? 0 : innerW, VEROVIO_PGNUM_BASELINE, even ? 'start' : 'end', RUNNING_HEADER_FONT_PX, String(pageNo));
    num.setAttribute('data-hkl-pgnum', String(pageNo));
    head.appendChild(num);
    /* The ink bottom Verovio's ORIGINAL "– N –" at 288 px measured to, which is
       what placement anchored the first system under (main.ts recorded it
       before restyling: 256 on every sonata page). */
    bottom = bottomOf(VEROVIO_PGNUM_BASELINE, VEROVIO_PGNUM_FONT_PX);
    const title = meta.title.trim();
    if (title) margin.appendChild(text(doc, 'hkl-running-title', innerW / 2, VEROVIO_PGNUM_BASELINE, 'middle', RUNNING_HEADER_FONT_PX, title));
  }
  if (bottom !== null) head.setAttribute('data-hkl-head-bottom', String(bottom));
  margin.insertBefore(head, margin.firstChild);
  return bottom;
}

/** A page with no systems yet. `styleText` is Verovio's own `<style>` for a
 *  rendered page (copied from the first system window), so glyphs and text
 *  inside the systems render as they did on a Verovio page. */
export function createPageShell(doc: Document, geom: ShellGeom, pageNo: number, meta: ShellMeta, styleText: string): PageShell {
  const svg = doc.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('width', (geom.pageWidth * geom.scale / 100) + 'px');
  svg.setAttribute('height', (geom.pageHeight * geom.scale / 100) + 'px');
  svg.setAttribute('version', '1.1');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:xlink', XLINK_NS);
  svg.setAttribute('overflow', 'visible');
  svg.setAttribute('class', 'hkl-page');
  /* Verovio's stylesheet is scoped by the root's id; the shell gets its own
     and the copied rules are re-pointed at it (systemrender.ts styleTextOf). */
  const rootId = 'hklpg' + String(++shellSeq);
  svg.setAttribute('id', rootId);
  const defs = doc.createElementNS(SVG_NS, 'defs') as SVGDefsElement;
  svg.appendChild(defs);
  if (styleText) {
    const style = doc.createElementNS(SVG_NS, 'style');
    style.setAttribute('type', 'text/css');
    style.textContent = styleText.split(STYLE_ROOT_TOKEN).join('#' + rootId);
    svg.appendChild(style);
  }
  const inner = doc.createElementNS(SVG_NS, 'svg');
  inner.setAttribute('class', 'definition-scale');
  inner.setAttribute('color', 'black');
  inner.setAttribute('font-family', 'Times, serif');
  inner.setAttribute('viewBox', `0 0 ${geom.pageWidth * 10} ${geom.pageHeight * 10}`);
  svg.appendChild(inner);
  const margin = doc.createElementNS(SVG_NS, 'g') as SVGGElement;
  margin.setAttribute('class', 'page-margin');
  margin.setAttribute('transform', `translate(${geom.pageMarginLeft * 10}, ${geom.pageMarginTop * 10})`);
  inner.appendChild(margin);
  const innerW = (geom.pageWidth - 2 * geom.pageMarginLeft) * 10;
  const headBottom = drawPageHeader(margin, pageNo, meta, innerW);
  return { svg, defs, margin, headBottom };
}

/** Renumber a page's header in place (a cascade moved page boundaries). */
export function renumberPageHeader(svg: Element, pageNo: number, meta: ShellMeta): void {
  const margin = svg.querySelector('g.page-margin');
  if (!margin) return;
  const frame = margin.closest('svg');
  const vb = (frame?.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const tr = /translate\(\s*(-?[\d.]+)/.exec(margin.getAttribute('transform') ?? '');
  const mx = tr ? Number(tr[1]) : 1400;
  const innerW = vb.length === 4 ? vb[2] - 2 * mx : 18790;
  drawPageHeader(margin, pageNo, meta, innerW);
}
