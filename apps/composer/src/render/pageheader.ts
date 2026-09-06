// Page-1 title block: sizes and subtitle clearance (2026-09-06).
//
// Verovio autogenerates the page-1 header from <titleStmt>: the title in one
// <rend> at "x-large" (540 px at the crisp presets, 1.5 × the 360 px text
// size), the subtitle after an <lb/> at "small" (288 px). Two things are wrong
// with it for Composer (backlog, Layout):
//   • the title should be slightly larger (Max) — TITLE_FONT_PX;
//   • the <lb/> steps the subtitle down by the OUTER rend's line height (347
//     user units on the sonata), which is less than the title's own size, so
//     the subtitle's text box (top = baseline − 0.9 × 288) begins ABOVE the
//     title's box bottom (baseline + 0.22 × 540): the two overlap vertically
//     and only clear horizontally when the title is short. Verovio has no
//     option for the header's line height.
// This pass restyles the rendered header in the DOM: the title leaf gets
// TITLE_FONT_PX with its ink top kept where Verovio put it (the baseline moves
// down by the ascent growth), the subtitle leaf gets SUBTITLE_FONT_PX (the same
// ratio), and the subtitle's own positioned tspan is moved so its box top sits
// SUBTITLE_GAP — a full subtitle line — below the title's box bottom. The header's
// bbox grows downward by exactly that, and — because this runs inside
// `postProcessRendered`, BEFORE `placePage` — placement (`headBottomOf` →
// `firstContentTop`) puts the first system below the taller band. Nothing
// here touches pages 2+ (their header is the page number; main.ts
// `styleRunningHeader` restyles it, post-placement, at RUNNING_HEADER_FONT_PX
// and records the original band first). Idempotent: Verovio's original
// values are recorded on the first run and every run recomputes from them.
// Every read is a plain getBBox in the header's own user space, so the same
// header yields the same numbers on every host (live page, splice window,
// reference gate).

/** Main title, page 1. Verovio's x-large is 540 px. */
export const TITLE_FONT_PX = 600;
/** Subtitle: Verovio's "small" 288 px grown by the title's ratio (600/540). */
export const SUBTITLE_FONT_PX = 320;
/** Running title and page numbers on pages 2+ — the footer's size (Max). */
export const RUNNING_HEADER_FONT_PX = 320;
/** Clear space between the title's text box and the subtitle's: a full line
 *  of the subtitle's own size (Max, 2026-09-06: "a full vertical gap between
 *  the title and subtitle text blocks" — 100 units read as barely moved). */
export const SUBTITLE_GAP = SUBTITLE_FONT_PX;

const num = (v: string | null): number | null => {
  if (v === null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/** Restyle every page-1 title block under `root`. */
export function styleTitleBlock(root: Element): void {
  for (const head of Array.from(root.querySelectorAll('g.pgHead'))) {
    if (head.querySelector('tspan.num')) continue;                 // pages 2+
    const block = Array.from(head.querySelectorAll('tspan.rend')).find((r) =>
      Array.from(r.children).some((c) => c.localName === 'title' && (c.textContent ?? '').trim() === 'title'));
    if (!block) continue;
    const leaves = Array.from(block.querySelectorAll('tspan[font-size]')) as SVGGraphicsElement[];
    if (!leaves.length) continue;
    const title = leaves[0];
    /* Verovio's originals, recorded once. */
    if (!block.hasAttribute('data-hkl-orig-y')) block.setAttribute('data-hkl-orig-y', block.getAttribute('y') ?? '');
    if (!title.hasAttribute('data-hkl-orig-fs')) title.setAttribute('data-hkl-orig-fs', title.getAttribute('font-size') ?? '');
    const origY = num(block.getAttribute('data-hkl-orig-y'));
    const origFs = title.getAttribute('data-hkl-orig-fs');
    if (origY === null || !origFs) continue;
    /* Restore, measure the original ink top, then grow the title keeping it. */
    block.setAttribute('y', String(origY));
    title.setAttribute('font-size', origFs);
    let origTop: number;
    try { origTop = title.getBBox().y; } catch { continue; }
    title.setAttribute('font-size', TITLE_FONT_PX + 'px');
    let newTop: number, titleBottom: number;
    try { const b = title.getBBox(); newTop = b.y; titleBottom = b.y + b.height; } catch { continue; }
    const dy = Math.round(origTop - newTop);
    block.setAttribute('y', String(origY + dy));
    titleBottom += dy;
    /* Subtitle: the leaf after the <lb/>, positioned by its own x/y tspan. */
    const lb = Array.from(block.children).find((c) => c.classList.contains('lb'));
    const sub = lb ? leaves.find((l) => lb.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING) : undefined;
    if (!sub) continue;
    let pos: Element | null = sub;
    while (pos && pos !== block && !pos.hasAttribute('y')) pos = pos.parentElement;
    if (!pos || pos === block) continue;
    if (!pos.hasAttribute('data-hkl-orig-y')) pos.setAttribute('data-hkl-orig-y', pos.getAttribute('y') ?? '');
    const subOrigY = num(pos.getAttribute('data-hkl-orig-y'));
    if (subOrigY === null) continue;
    pos.setAttribute('y', String(subOrigY));
    sub.setAttribute('font-size', SUBTITLE_FONT_PX + 'px');
    let subTop: number;
    try { subTop = sub.getBBox().y; } catch { continue; }
    const want = titleBottom + SUBTITLE_GAP;
    if (subTop < want) pos.setAttribute('y', String(Math.round(subOrigY + (want - subTop))));
  }
}
