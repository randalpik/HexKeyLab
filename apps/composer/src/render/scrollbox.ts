// Ownership of the SCROLL view's SVG box — the persistent single-system SVG's
// root <svg> together with the nested <svg class="definition-scale"> whose
// viewBox defines the user-space viewport.
//
// Verovio emits that box ONCE, at full-engrave time, sized to the content
// extent; `pinExactScale` then derives the root's px dimensions from the
// viewBox. The scroll splicer edits measures INSIDE that box, so without this
// module the box stays frozen at whatever the document measured at the last
// full render: content grows rightward, the viewport does not, and an SVG root
// clips to its viewport. Measured 2026-09-13 — typing 13 bars from a blank doc
// left a 345 px box over 29 477 user units of content, and because the root
// element's own width stayed small #score had NO scrollable extent, so the
// notes were not merely hidden but unreachable.
//
// Re-measuring the system's bbox per keystroke would fix that and destroy the
// point of splicing: `g.system`.getBBox() is O(document) geometry, which is
// exactly the cost the splicer exists to avoid. So the box<->content offsets
// are CAPTURED at each full render — they are pure page geometry, and
// `padRight` probed at exactly 290 user units across every document size and
// zoom sampled — and the extent is then maintained from O(1) measurements.
// Capturing rather than hardcoding is also what makes this zoom-proof for
// free: a zoom change forces a full re-engrave, which recaptures.
//
// DELIBERATE ASYMMETRY WITH PAGE VIEW. `pinExactScale` carries the contract
// "nothing may grow a page's viewBox after mount" — a PAGE-view rule, from the
// section-header injector bug (2026-09-02), where re-pinning a grown page
// resized it by the reserve. Scroll view is one continuous system rendered
// with adjustPageHeight and needs precisely the opposite. Keeping the growth
// HERE rather than inside pinExactScale is what lets both rules stay true; do
// not "unify" them.

import { pinExactScale } from '@hkl/notation/render-presets.js';

/** The box's relationship to its content, captured at a full render. All
 *  lengths are SVG user units in the definition-scale frame. */
export interface ScrollBox {
  /** g.page-margin's translate — content coords are page-margin-local, the
   *  viewBox is definition-scale-local, and this is the offset between them. */
  originX: number;
  originY: number;
  /** viewBox width  - content right edge (definition-scale space). */
  padRight: number;
  /** viewBox height - content bottom edge (definition-scale space). */
  padBottom: number;
  /** content right edge - LAST MEASURE's right edge (page-margin space). Covers
   *  content that outruns the final measure box: a trailing hairpin, a volta
   *  bracket, the final barline's stroke. */
  trailPad: number;
  /** Current viewBox, as last written. */
  minX: number;
  minY: number;
  width: number;
  height: number;
}

interface BoxEls { root: SVGSVGElement; inner: SVGSVGElement; pm: SVGGraphicsElement }

/** The three elements the box lives on. Null when the container holds no
 *  rendered scroll SVG (load error, page-view DOM, empty container). */
function boxEls(container: HTMLElement): BoxEls | null {
  const inner = container.querySelector('svg.definition-scale');
  if (!(inner instanceof SVGSVGElement)) return null;
  const root = inner.parentElement;
  if (!(root instanceof SVGSVGElement)) return null;
  const pm = inner.querySelector('g.page-margin');
  if (!(pm instanceof SVGGraphicsElement)) return null;
  return { root, inner, pm };
}

/** g.page-margin's translate. Verovio writes it as `translate(x, y)`. */
function originOf(pm: Element): { x: number; y: number } {
  const m = /translate\(\s*(-?[\d.eE+]+)[\s,]+(-?[\d.eE+]+)\s*\)/.exec(pm.getAttribute('transform') ?? '');
  return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 0, y: 0 };
}

function viewBoxOf(inner: Element): [number, number, number, number] | null {
  const v = (inner.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  return v.length === 4 && v.every((n) => Number.isFinite(n)) ? [v[0], v[1], v[2], v[3]] : null;
}

/** Content extent in PAGE-MARGIN space (the frame measure bboxes live in —
 *  g.system carries no transform in scroll view, so measure-local, system-local
 *  and page-margin-local coordinates all coincide). O(document): full renders
 *  and the rare frame-adoption branch only, never the per-keystroke path. */
function contentExtent(pm: SVGGraphicsElement): { right: number; bottom: number } | null {
  let b: DOMRect;
  try { b = pm.getBBox(); } catch { return null; }
  if (!Number.isFinite(b.width) || !Number.isFinite(b.height)) return null;
  return { right: b.x + b.width, bottom: b.y + b.height };
}

/** Right edge of a spliced measure in page-margin space, including the
 *  x-translate the splicer has applied to it. */
export function measureRight(el: SVGGraphicsElement, tx: number): number | null {
  let b: DOMRect;
  try { b = el.getBBox(); } catch { return null; }
  return Number.isFinite(b.width) ? b.x + b.width + tx : null;
}

/** Record the box's offsets from the freshly engraved content. Called from
 *  ScrollSplicer.capture(), i.e. only after a full render. */
export function captureScrollBox(
  container: HTMLElement, lastMeasureEl: SVGGraphicsElement | null,
): ScrollBox | null {
  const els = boxEls(container);
  if (!els) return null;
  const vb = viewBoxOf(els.inner);
  const ext = contentExtent(els.pm);
  if (!vb || !ext) return null;
  const origin = originOf(els.pm);
  const lastRight = lastMeasureEl ? measureRight(lastMeasureEl, 0) : null;
  return {
    originX: origin.x,
    originY: origin.y,
    padRight: vb[2] - (origin.x + ext.right),
    padBottom: vb[3] - (origin.y + ext.bottom),
    trailPad: lastRight === null ? 0 : ext.right - lastRight,
    minX: vb[0], minY: vb[1], width: vb[2], height: vb[3],
  };
}

/** Write the box back to the DOM and re-pin the root's px dimensions. */
function applyBox(container: HTMLElement, box: ScrollBox, scale: number): void {
  const els = boxEls(container);
  if (!els) return;
  /* Integers, as Verovio itself emits: a user unit is 1/10 device px at zoom
     100, so rounding costs at most 0.05 px and keeps the attribute readable
     (an unrounded fit writes e.g. 4685.000050127506). */
  els.inner.setAttribute('viewBox',
    `${Math.round(box.minX)} ${Math.round(box.minY)} ${Math.round(box.width)} ${Math.round(box.height)}`);
  /* pinExactScale derives root width/height FROM this viewBox, so it must run
     after the write — it is the single writer of the root's px dims. */
  pinExactScale(container, scale);
}

/** Re-fit the box WIDTH to a new last-measure right edge. O(1): one measure
 *  bbox, no document-wide geometry. Exact in both directions, so a delete
 *  shrinks the scroll extent instead of leaving dead space behind. */
export function fitScrollBoxWidth(
  container: HTMLElement, box: ScrollBox, lastRight: number, scale: number,
): void {
  const width = box.originX + lastRight + box.trailPad + box.padRight;
  if (!Number.isFinite(width) || width <= 0) return;
  if (Math.abs(width - box.width) < 0.5) return;
  box.width = width;
  applyBox(container, box, scale);
}

/** Re-fit the box HEIGHT to the content after a frame adoption (the system's
 *  vertical frame moved, so every measure has been re-seated). Pays ONE
 *  document-wide bbox for exactness — Verovio derives page height from its
 *  layout model rather than the ink bbox, so the two disagree by a few units
 *  and `height + dyFrame` would drift; this branch is rare (a vertical frame
 *  change, not a keystroke) and a full re-engrave is orders of magnitude
 *  dearer. */
export function fitScrollBoxHeight(container: HTMLElement, box: ScrollBox, scale: number): void {
  const els = boxEls(container);
  if (!els) return;
  const ext = contentExtent(els.pm);
  if (!ext) return;
  const height = box.originY + ext.bottom + box.padBottom;
  if (!Number.isFinite(height) || height <= 0) return;
  if (Math.abs(height - box.height) < 0.5) return;
  box.height = height;
  applyBox(container, box, scale);
}
