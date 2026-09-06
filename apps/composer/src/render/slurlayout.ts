// Flipped-slur re-draw — a DOM post-process on rendered systems (2026-09-05).
//
// `notation/slurSides.ts` puts a two-voice slur on the notehead side with
// `@curvedir`. Verovio honours the side but routes the slur around whatever
// else is there, and its endpoint rule treats the OTHER layer's noteheads in
// the slur's own start / end column as part of that column: a slur told to go
// below a descending upper-voice line whose downbeat shares its x with the
// lower voice's chord starts BELOW that chord — sonata m. 83, start point 65 px
// (8 units) under its own notehead, then a 100-px scoop — although the slur
// fits under the notes and above the chord (Max: "there is room for it").
// Probed on the bare toolkit: the shift follows the chord's noteheads, not its
// stem; `slurEndpointFlexibility` 0 (the default) still shifts; `@bezier` and
// `@bulge` change nothing; `@startvo`/`@endvo` do move the endpoints but
// would have to be predicted before the render.
//
// So the pass re-draws, in place, every slur the side pass flipped whose
// rendered endpoint sits more than `DISP_TOL` units from its notehead: the
// endpoints go `END_GAP` past the start / end noteheads on the slur side, the
// curve is a cubic Bézier bulging `H_RATE` × span (clamped) away from the
// notes, and the bulge grows until the sampled curve clears every glyph box of
// the staff within its span (`MARGIN` of clearance) — the slur's own notes,
// the other voice's, beams, numerals, brackets, other slurs. A curve that
// cannot clear them within `H_MAX` keeps Verovio's routing. Verovio's path is
// one filled shape — two cubics sharing the endpoints, `stroke-width` 0.1
// unit — and is rewritten as the same shape with Verovio's thicknesses.
//
// Everything is measured in the slur path's own user space (its parent chain
// carries only the page-margin translate), through `svgBox`. Idempotent: the
// original `d` is kept in `data-hkl-orig-d` and restored before re-measuring.
// Runs before placement measures the system (a re-drawn slur hugs its notes,
// so it only ever shrinks the extents).

import { svgBox, type Box } from './textlayout.js';

export interface SlurLayoutOpts {
  /** SVG user units per Verovio unit (80 at unit 8). */
  unitUser: number;
}

/* All in Verovio units. */
const DISP_TOL = 2;        // an endpoint further than this from its notehead is displaced
const END_GAP = 0.75;      // endpoint clearance from the notehead
const MARGIN = 0.5;        // clearance kept from every other glyph
const H_MIN = 1.25, H_START_MAX = 3.5, H_MAX = 6, H_STEP = 0.5;   // bulge range
const H_RATE = 0.12;       // bulge per unit of span
const THICK = 0.4;         // control-point offset giving Verovio's 0.6-unit midpoint thickness
const SAMPLES = 40;

const OBSTACLE_SEL = 'g.notehead, g.stem, g.flag, g.accid, g.dots, g.beam > polygon, g.tupletNum, g.tupletBracket, g.artic, g.rest, g.ledgerLines, g.slur > path, g.tie > path';

interface Pt { x: number; y: number }

/** The notehead a slur endpoint hangs from: a note's own, or the extreme
 *  notehead of a chord on the slur side. */
function endHead(el: Element, side: 'below' | 'above', frameInv: DOMMatrix): { el: Element; box: Box } | null {
  const heads = el.classList.contains('note')
    ? Array.from(el.querySelectorAll(':scope > g.notehead'))
    : Array.from(el.querySelectorAll('g.note > g.notehead'));
  let best: { el: Element; box: Box } | null = null;
  for (const h of heads) {
    const b = svgBox(h, frameInv);
    if (!b) continue;
    if (!best || (side === 'below' ? b.bottom > best.box.bottom : b.top < best.box.top)) best = { el: h, box: b };
  }
  return best;
}

const bez = (p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt => {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
};
const inside = (p: Pt, b: Box): boolean => p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom;
const fmt = (p: Pt): string => `${Math.round(p.x)},${Math.round(p.y)}`;

/** Re-draw the displaced flipped slurs of every system under `root`. */
export function layoutFlippedSlurs(root: Element, opts: SlurLayoutOpts): void {
  const u = opts.unitUser;
  const doc = root.ownerDocument;
  const byId = (id: string): Element | null => root.querySelector('#' + CSS.escape(id)) ?? doc.getElementById(id);
  for (const g of Array.from(root.querySelectorAll('g.slur[data-curvedir]'))) {
    const path = g.querySelector(':scope > path') as SVGPathElement | null;
    if (!path || typeof path.getCTM !== 'function') continue;
    const side = g.getAttribute('data-curvedir');
    if (side !== 'below' && side !== 'above') continue;
    /* Idempotency: measure Verovio's own curve, never a previous re-draw. */
    const orig = path.getAttribute('data-hkl-orig-d');
    if (orig !== null) { path.setAttribute('d', orig); path.removeAttribute('data-hkl-orig-d'); g.removeAttribute('data-hkl-slur'); }
    const sid = (g.getAttribute('data-startid') ?? '').replace(/^#/, '');
    const eid = (g.getAttribute('data-endid') ?? '').replace(/^#/, '');
    if (!sid || !eid) continue;
    const sEl = byId(sid), eEl = byId(eid);
    const sys = g.closest('g.system');
    if (!sEl || !eEl || !sys || sEl.closest('g.system') !== sys || eEl.closest('g.system') !== sys) continue;   // a system-break segment: Verovio's
    const ctm = path.getCTM();
    if (!ctm) continue;
    const frameInv = ctm.inverse();
    const sHead = endHead(sEl, side, frameInv), eHead = endHead(eEl, side, frameInv);
    if (!sHead || !eHead) continue;
    /* Verovio's endpoints: the path starts at the start point and reaches the
       end point half-way along (two cubics of equal length). */
    let p0: Pt, pEnd: Pt;
    try { const L = path.getTotalLength(); p0 = path.getPointAtLength(0); pEnd = path.getPointAtLength(L / 2); } catch { continue; }
    const sign = side === 'below' ? 1 : -1;
    const edge = (b: Box): number => (side === 'below' ? b.bottom : b.top);
    const dispS = sign * (p0.y - edge(sHead.box)), dispE = sign * (pEnd.y - edge(eHead.box));
    if (dispS <= DISP_TOL * u && dispE <= DISP_TOL * u) continue;       // Verovio's slur is at its notes: keep it

    const S: Pt = { x: (sHead.box.left + sHead.box.right) / 2, y: edge(sHead.box) + sign * END_GAP * u };
    const E: Pt = { x: (eHead.box.left + eHead.box.right) / 2, y: edge(eHead.box) + sign * END_GAP * u };
    if (E.x <= S.x) continue;
    /* Obstacles: every glyph of this staff (all layers) within the span, less
       the two endpoint noteheads and the slur itself; boxes padded by MARGIN. */
    const staffN = sEl.closest('g.staff')?.getAttribute('data-n');
    if (staffN === null || staffN === undefined) continue;
    const lo = S.x - u, hi = E.x + u, pad = MARGIN * u;
    const obstacles: Box[] = [];
    for (const st of Array.from(sys.querySelectorAll('g.staff[data-n="' + staffN + '"]'))) {
      for (const el of Array.from(st.querySelectorAll(OBSTACLE_SEL))) {
        if (el === sHead.el || el === eHead.el || el === path) continue;
        const b = svgBox(el, frameInv);
        if (!b || b.right < lo || b.left > hi || !(b.right > b.left)) continue;
        obstacles.push({ left: b.left - pad, right: b.right + pad, top: b.top - pad, bottom: b.bottom + pad });
      }
    }
    /* The curve: bulge perpendicular to the chord, toward the slur side. */
    const dx = E.x - S.x, dy = E.y - S.y, len = Math.hypot(dx, dy);
    let nx = -dy / len, ny = dx / len;
    if (Math.sign(ny) !== sign) { nx = -nx; ny = -ny; }
    let h = Math.min(Math.max(H_RATE * len, H_MIN * u), H_START_MAX * u);
    let ctrl: [Pt, Pt] | null = null;
    for (; h <= H_MAX * u + 1e-6; h += H_STEP * u) {
      const k = (4 / 3) * h;
      const P1: Pt = { x: S.x + dx * 0.25 + nx * k, y: S.y + dy * 0.25 + ny * k };
      const P2: Pt = { x: S.x + dx * 0.75 + nx * k, y: S.y + dy * 0.75 + ny * k };
      let clear = true;
      for (let i = 0; i <= SAMPLES && clear; i++) {
        const p = bez(S, P1, P2, E, i / SAMPLES);
        for (const b of obstacles) { if (inside(p, b)) { clear = false; break; } }
      }
      if (clear) { ctrl = [P1, P2]; break; }
    }
    if (!ctrl) { g.setAttribute('data-hkl-slur', 'kept'); continue; }
    const t = THICK * u;
    const [P1, P2] = ctrl;
    const o1: Pt = { x: P1.x + nx * t, y: P1.y + ny * t }, o2: Pt = { x: P2.x + nx * t, y: P2.y + ny * t };
    const i1: Pt = { x: P1.x - nx * t, y: P1.y - ny * t }, i2: Pt = { x: P2.x - nx * t, y: P2.y - ny * t };
    path.setAttribute('data-hkl-orig-d', path.getAttribute('d') ?? '');
    path.setAttribute('d', `M${fmt(S)} C${fmt(o1)} ${fmt(o2)} ${fmt(E)} C${fmt(i2)} ${fmt(i1)} ${fmt(S)}`);
    g.setAttribute('data-hkl-slur', 'redrawn');
  }
}
