// Tuplet numerals off their beams — a DOM post-process on rendered systems
// (2026-09-05).
//
// A tuplet wholly under one beam draws its numeral alone (no bracket — see
// tuplet-ops.ts). Verovio places that numeral against the beam, and on a steep
// beam the numeral's box can cut into the beam polygon: sonata p. 17, three
// bass triplets (f3 → b♭3 → d♭4) with the "3" 7.7 px INTO the beam while every
// other numeral on the page cleared its beam by 4 px or more (Max: "tuplet
// numbers are colliding with the notes' beams"). This pass measures the true
// clearance between a bracketless numeral and every beam polygon of its staff
// crossing its x-range — the polygon's edge at the numeral's x, not the
// polygon's bounding box, which a sloped beam fills only diagonally — and
// moves the numeral away from the beam, along the beam side, until it clears
// by `MIN_CLEAR`. Numerals sitting in a bracket are left alone (the bracket
// would stay behind). Idempotent via `data-hkl-numshift`; runs before
// placement measures the system and before the slur re-draw (which treats the
// numeral as an obstacle).

import { svgBox } from './textlayout.js';

export interface TupletNumOpts {
  /** SVG user units per Verovio unit (80 at unit 8). */
  unitUser: number;
}

/** Clearance kept between a numeral and a beam, in Verovio units. */
const MIN_CLEAR = 0.5;

interface Pt { x: number; y: number }

/** The vertical extent of a convex polygon at abscissa `x`, or null when `x`
 *  is outside it. */
function polyYAt(pts: Pt[], x: number): [number, number] | null {
  const ys: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if ((a.x <= x && x <= b.x) || (b.x <= x && x <= a.x)) {
      if (a.x === b.x) ys.push(a.y, b.y);
      else ys.push(a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x));
    }
  }
  return ys.length ? [Math.min(...ys), Math.max(...ys)] : null;
}

/** Nudge every bracketless tuplet numeral under `root` clear of its beams. */
export function layoutTupletNums(root: Element, opts: TupletNumOpts): void {
  const u = opts.unitUser;
  for (const num of Array.from(root.querySelectorAll('g.tupletNum')) as SVGGraphicsElement[]) {
    if (num.hasAttribute('data-hkl-numshift')) { num.removeAttribute('transform'); num.removeAttribute('data-hkl-numshift'); }
    const tup = num.closest('g.tuplet');
    const parent = num.parentElement as SVGGraphicsElement | null;
    if (!tup || tup.querySelector('g.tupletBracket') || !parent || typeof parent.getCTM !== 'function') continue;
    const ctm = parent.getCTM();
    if (!ctm) continue;
    const inv = ctm.inverse();
    const nb = svgBox(num, inv);
    if (!nb || !(nb.right > nb.left)) continue;
    const staff = num.closest('g.staff');
    if (!staff) continue;
    let shift = 0;
    for (const poly of Array.from(staff.querySelectorAll('g.beam > polygon')) as SVGGraphicsElement[]) {
      const pctm = poly.getCTM();
      if (!pctm) continue;
      const m = inv.multiply(pctm);
      const pts: Pt[] = (poly.getAttribute('points') ?? '').trim().split(/\s+/)
        .map((s) => s.split(',').map(Number))
        .filter((p) => p.length === 2 && p.every(Number.isFinite))
        .map(([x, y]) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }));
      if (pts.length < 3) continue;
      const left = Math.min(...pts.map((p) => p.x)), right = Math.max(...pts.map((p) => p.x));
      if (right < nb.left || left > nb.right) continue;
      const cx = Math.min(Math.max((nb.left + nb.right) / 2, left), right);
      const mid = polyYAt(pts, cx);
      if (!mid) continue;
      const numAbove = (nb.top + nb.bottom) / 2 < (mid[0] + mid[1]) / 2;
      let clear = Infinity;
      const x0 = Math.max(left, nb.left), x1 = Math.min(right, nb.right), step = Math.max((x1 - x0) / 8, 1);
      for (let x = x0; x <= x1 + 1e-6; x += step) {
        const yy = polyYAt(pts, x);
        if (yy) clear = Math.min(clear, numAbove ? yy[0] - nb.bottom : nb.top - yy[1]);
      }
      if (clear === Infinity) continue;
      const need = MIN_CLEAR * u - clear;
      if (need > 0) shift = numAbove ? Math.min(shift, -need) : Math.max(shift, need);
    }
    shift = Math.round(shift);
    if (Math.abs(shift) < 3) continue;
    num.setAttribute('transform', `translate(0, ${shift})`);
    num.setAttribute('data-hkl-numshift', String(shift));
  }
}
