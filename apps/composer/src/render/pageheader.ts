// Page-1 title block: sizes, subtitle clearance, composer credit (2026-09-06).
//
// Verovio autogenerates the page-1 header from <titleStmt>: the title in one
// <rend> at "x-large" (540 px at the crisp presets, 1.5 × the 360 px text
// size), the subtitle after an <lb/> at "small" (288 px). Composer draws the
// COMPOSER CREDIT itself (right-aligned "Max Randal, Op. 12" — the line Max
// calls the subtitle). Three things were wrong (backlog, Layout; Max's review
// the same day):
//   • the title should be slightly larger (Max) — TITLE_FONT_PX;
//   • the <lb/> steps the subtitle down by the OUTER rend's line height (347
//     user units on the sonata), which is less than the title's own size, so
//     the subtitle's text box (top = baseline − 0.9 × 288) begins ABOVE the
//     title's box bottom (baseline + 0.22 × 540): the two overlap vertically
//     and only clear horizontally when the title is short. Verovio has no
//     option for the header's line height;
//   • the credit used to be injected AFTER placement (main.ts), anchored to
//     the first system's top, which put it BESIDE the title — its text box
//     overlapping the title's vertically, clearing only horizontally — and
//     nothing could reserve room for it. Max: a full vertical gap between the
//     title block and the credit, and the credit slightly larger at the
//     title's ratio.
// This pass restyles the rendered header in the DOM: the title leaf gets
// TITLE_FONT_PX with its em-box top kept where Verovio put it (the baseline
// moves down by the ascent growth), the subtitle leaf gets SUBTITLE_FONT_PX —
// the credit's size, the two reading as a pair — and its positioned tspan is
// SET so its box top sits SUBTITLE_GAP below the title's box bottom, which is
// zero: the subtitle takes the next line, not the one after a blank one (Max,
// 2026-09-06). The credit is drawn INSIDE `g.pgHead` (right-aligned to the
// page's real column, CREDIT_FONT_PX) with its box top CREDIT_GAP — a full line
// of its own size — below the title block's bottom (title, or subtitle when
// there is one). The header's bbox grows downward by exactly that, and —
// because this runs inside `postProcessRendered`, BEFORE `placePage` —
// placement (`headBottomOf` → `firstContentTop`) puts the first system below
// the whole band. A title-less document with a composer gets a synthesized
// `g.pgHead` holding just the credit, so the band still exists. Nothing here
// touches pages 2+ (their header is the page number; main.ts
// `styleRunningHeader` restyles it, post-placement, at RUNNING_HEADER_FONT_PX
// and records the original band first). Idempotent: Verovio's original values
// are recorded on the first run and every run recomputes from them; the
// credit is removed and re-drawn. NOTHING here measures: every edge is the
// nominal em-box of a (baseline, font-size) pair — see ASCENT/DESCENT — so the
// same header yields the same numbers on every host (live page, splice window,
// reference gate) AND in every engine. The measured version was Chromium-only:
// Firefox gives no useful getBBox for a `<tspan>`, so the whole block silently
// bailed and the credit landed on the title's line (Max, 2026-09-06).

/** Main title, page 1. Verovio's x-large is 540 px. */
export const TITLE_FONT_PX = 600;
/** Composer credit: the former 324 px grown by the title's ratio (600/540). */
export const CREDIT_FONT_PX = 360;
/** Subtitle: the credit's size (Max, 2026-09-06 — the two lines read as a
 *  pair, so they match). Verovio's "small" is 288. */
export const SUBTITLE_FONT_PX = CREDIT_FONT_PX;
/** Running title and page numbers on pages 2+ — the footer's size (Max). */
export const RUNNING_HEADER_FONT_PX = 320;
/** Clear space ADDED between the title's text box and the subtitle's: none,
 *  so the subtitle sits on the next line rather than after a blank one (Max,
 *  2026-09-06). Zero here still means the em-boxes only touch — ordinary line
 *  spacing — never the overlap Verovio's own `<lb/>` step produces. */
export const SUBTITLE_GAP = 0;
/** Clear space between the title block's text box and the credit's: a full
 *  line of the credit's own size (Max, 2026-09-06: "a full vertical gap
 *  between the title and subtitle text blocks"). */
export const CREDIT_GAP = CREDIT_FONT_PX;

/* Nominal Times/serif em-box, used INSTEAD of measuring (2026-09-06). This
 * block used to read `getBBox()` off the title/subtitle `<tspan>`s — the one
 * SVG measurement Blink and Gecko disagree about. Chromium answers a tspan
 * getBBox with the font's em-box (measured on the sonata header: heights of
 * 660/600, 360/320 and 400/360 user units — all 1.107 × font-size, i.e.
 * ascent+descent, independent of which glyphs are present); Firefox does not
 * answer it usefully at all, so `styleTitle` hit its `catch` and returned
 * null, the credit fell to its `blockBottom === null ? 0` branch, and every
 * gap constant here was dead code on Gecko — the credit landed on the title's
 * own line. Deriving the same em-box arithmetically reproduces Chromium's
 * accepted geometry to within ~5 user units (≈0.5 px at 100 %) and makes the
 * result identical on every host, including detached ones where getBBox
 * throws outright (splice window, reference gate). */
const ASCENT = 0.891;
const DESCENT = 0.216;
/* Verovio wraps the page in `svg.definition-scale`, so one CSS pixel is ten
 * user units and a "600 px" font-size is really 60 px of type. A font's
 * ascent and descent resolve at WHOLE-pixel granularity, which is what the
 * measured version was picking up: Chromium reported 480 and 530 units of
 * ascent at 540 and 600, i.e. round(0.891 × 54) and round(0.891 × 60) scaled
 * by ten — never the unrounded 481.1 / 534.6. Quantizing here reproduces the
 * measured geometry EXACTLY (verified on all six of the sonata header's
 * ascent/descent readings) instead of landing ~3 units off, which matters
 * because the header's depth feeds `headBottomOf` → `firstContentTop` and a
 * sub-pixel drift there crosses a device-grid snap and moves every system and
 * section header on the page by a whole pixel. Doing the rounding ourselves
 * makes it identical on every engine rather than Chromium's to give. */
const UNITS_PER_PX = 10;
const ascentOf = (fontPx: number): number => Math.round((ASCENT * fontPx) / UNITS_PER_PX) * UNITS_PER_PX;
const descentOf = (fontPx: number): number => Math.round((DESCENT * fontPx) / UNITS_PER_PX) * UNITS_PER_PX;
/** Em-box bottom of a line with this baseline and size. */
const bottomOf = (baseline: number, fontPx: number): number => baseline + descentOf(fontPx);
/** Baseline that puts a line of `fontPx` with its em-box top at `top`. */
const baselineFor = (top: number, fontPx: number): number => top + ascentOf(fontPx);

const SVG_NS = 'http://www.w3.org/2000/svg';
const CREDIT_CLASS = 'hkl-injected-composer';

/* The page's inner column, READ from the rendered page rather than assumed
 * (2026-09-04): the paper scales with the document's page size (`pageScale`,
 * Setup → "Page size"), so the column's width/height and the margin depth are
 * per-page facts — the constants are the unscaled US-Letter case and only a
 * fallback. Until this, every injected text (footer, composer credit, section
 * titles) sat at the 100 % coordinates on a resized page. Moved here from
 * main.ts with the credit (2026-09-06). */
export interface PageFrame { innerW: number; innerH: number; marginX: number; marginY: number }
/** Usable width inside `g.page-margin` on an unscaled US-Letter page. */
export const PAGE_INNER_W = 21590 - 2 * 1400;   // 18790
/** Usable height inside `g.page-margin` on an unscaled US-Letter page. */
export const PAGE_INNER_H = 27940 - 2 * 1400;   // 25140
export const UNSCALED_MARGIN = 1400;
export function pageFrameOf(pageMargin: Element): PageFrame {
  const frame = pageMargin.closest('svg');
  const vb = (frame?.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const tr = (pageMargin.getAttribute('transform') ?? '').match(/translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/);
  const marginX = tr ? parseFloat(tr[1]) : UNSCALED_MARGIN;
  const marginY = tr ? parseFloat(tr[2]) : UNSCALED_MARGIN;
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    return { innerW: vb[2] - 2 * marginX, innerH: vb[3] - 2 * marginY, marginX, marginY };
  }
  return { innerW: PAGE_INNER_W, innerH: PAGE_INNER_H, marginX, marginY };
}

const num = (v: string | null): number | null => {
  if (v === null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/** A group's own `translate(tx, ty)`, or zeros. */
function translateOf(el: Element): { tx: number; ty: number } {
  const m = (el.getAttribute('transform') ?? '').match(/translate\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?/);
  return m ? { tx: parseFloat(m[1]), ty: m[2] !== undefined ? parseFloat(m[2]) : 0 } : { tx: 0, ty: 0 };
}

/** Restyle every page-1 title block under `root` and draw the composer credit
 *  (`composer` empty → none) into it. */
export function styleTitleBlock(root: Element, composer = ''): void {
  const margins = Array.from(root.querySelectorAll('svg.definition-scale > g.page-margin'));
  for (const margin of margins) {
    let head = margin.querySelector(':scope > g.pgHead');
    if (head && head.querySelector('tspan.num')) continue;              // pages 2+
    let blockBottom: number | null = null;
    if (head) blockBottom = styleTitle(head);
    /* The credit, inside the header band. */
    head?.querySelector(':scope > text.' + CREDIT_CLASS)?.remove();
    if (!composer) {
      if (head && head.classList.contains('hkl-credit-only')) head.remove();
      continue;
    }
    if (!head) {
      /* No title: a header of our own so placement still sees a band. */
      head = margin.ownerDocument!.createElementNS(SVG_NS, 'g');
      head.setAttribute('class', 'pgHead hkl-credit-only');
      margin.insertBefore(head, margin.firstChild);
    }
    const frame = pageFrameOf(margin);
    const t = margin.ownerDocument!.createElementNS(SVG_NS, 'text') as SVGGraphicsElement;
    t.setAttribute('class', CREDIT_CLASS);
    t.setAttribute('x', String(frame.innerW - translateOf(head).tx));
    t.setAttribute('y', '0');
    t.setAttribute('text-anchor', 'end');
    t.setAttribute('font-size', CREDIT_FONT_PX + 'px');
    t.setAttribute('font-family', 'Times, serif');
    /* Box top at CREDIT_GAP below the title block (or at the band's top when
       there is no title to sit under). Solved from the nominal em-box, not a
       getBBox of `t` — see ASCENT/DESCENT. */
    const want = blockBottom === null ? 0 : blockBottom + CREDIT_GAP;
    t.setAttribute('y', String(Math.round(baselineFor(want, CREDIT_FONT_PX))));
    t.textContent = composer;
    head.appendChild(t);
  }
}

/** Restyle one autogenerated title block; returns the block's em-box bottom
 *  (the title's, or the moved subtitle's) in the header's frame, or null when
 *  the block cannot be identified. */
function styleTitle(head: Element): number | null {
  const block = Array.from(head.querySelectorAll('tspan.rend')).find((r) =>
    Array.from(r.children).some((c) => c.localName === 'title' && (c.textContent ?? '').trim() === 'title'));
  if (!block) return null;
  const leaves = Array.from(block.querySelectorAll('tspan[font-size]')) as SVGGraphicsElement[];
  if (!leaves.length) return null;
  const title = leaves[0];
  /* Verovio's originals, recorded once. */
  if (!block.hasAttribute('data-hkl-orig-y')) block.setAttribute('data-hkl-orig-y', block.getAttribute('y') ?? '');
  if (!title.hasAttribute('data-hkl-orig-fs')) title.setAttribute('data-hkl-orig-fs', title.getAttribute('font-size') ?? '');
  const origY = num(block.getAttribute('data-hkl-orig-y'));
  const origFs = num(title.getAttribute('data-hkl-orig-fs'));   // parseFloat eats the "px"
  if (origY === null || origFs === null) return null;
  /* Grow the title keeping its em-box top where Verovio put it: the baseline
     moves down by exactly the ascent growth. Computed from the recorded
     originals, so every run is idempotent without a restore-and-remeasure. */
  const titleBaseline = origY + (ascentOf(TITLE_FONT_PX) - ascentOf(origFs));
  title.setAttribute('font-size', TITLE_FONT_PX + 'px');
  block.setAttribute('y', String(titleBaseline));
  const titleBottom = bottomOf(titleBaseline, TITLE_FONT_PX);
  /* Subtitle: the leaf after the <lb/>, positioned by its own x/y tspan. */
  const lb = Array.from(block.children).find((c) => c.classList.contains('lb'));
  const sub = lb ? leaves.find((l) => lb.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING) : undefined;
  if (!sub) return titleBottom;
  let pos: Element | null = sub;
  while (pos && pos !== block && !pos.hasAttribute('y')) pos = pos.parentElement;
  if (!pos || pos === block) return titleBottom;
  if (!pos.hasAttribute('data-hkl-orig-y')) pos.setAttribute('data-hkl-orig-y', pos.getAttribute('y') ?? '');
  if (num(pos.getAttribute('data-hkl-orig-y')) === null) return titleBottom;
  sub.setAttribute('font-size', SUBTITLE_FONT_PX + 'px');
  /* SET, not clamped against Verovio's own `<lb/>` step: the block is fully
     derived now, and with SUBTITLE_GAP at 0 a "never pull it above where
     Verovio put it" guard would silently reinstate whatever arbitrary gap
     that step happened to leave — the gap this is here to remove. */
  const subBaseline = Math.round(baselineFor(titleBottom + SUBTITLE_GAP, SUBTITLE_FONT_PX));
  pos.setAttribute('y', String(subBaseline));
  return bottomOf(subBaseline, SUBTITLE_FONT_PX);
}
