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
// A slur across a SYSTEM BREAK is two segments (the continuation carries
// `class="slur id-<id> spanning"` and no id, but the same data attributes).
// Verovio parks each segment's open end at a fixed staff-relative spot — for a
// below-slur just under the bottom line — so a flipped bass slur dives away
// from its notes at the break and the continuation climbs back through the
// staff and the lower voice (sonata m. 43→44, m. 52→53, m. 88→89, 2026-09-05).
// Here the open end is treated like any endpoint: anchored `END_GAP +
// OPEN_DROP` past the last (first) covered notehead of the slur's own layer in
// that system, at Verovio's own open-end x, and the segment gets the same
// curve and clearance search.
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
const OPEN_DROP = 0.75;    // extra reach of a broken slur's open end past its last covered notehead
const OPEN_LIFT_MAX = 2;   // how far a broken slur's open end may move back toward its notes to clear
const END_GAP_TIGHT = 0.4, MARGIN_TIGHT = 0.25;   // second attempt when a lower voice sits right under the end note
export const MARGIN = 0.5; // clearance kept from every other glyph (also render/tielayout.ts)
const H_MIN = 1.25, H_START_MAX = 3.5, H_MAX = 6, H_STEP = 0.5;   // bulge range
const H_RATE = 0.12;       // bulge per unit of span
const THICK = 0.4;         // control-point offset giving Verovio's 0.6-unit midpoint thickness
const SAMPLES = 40;

/* Ledger lines are NOT obstacles: a slur's own endpoint hangs at the level of
   the ledger line under (over) its notehead, so treating the line as a glyph
   made every slur ending on a note beyond the staff unsolvable (m. 43→44). */
export const OBSTACLE_SEL = 'g.notehead, g.stem, g.flag, g.accid, g.dots, g.beam > polygon, g.tupletNum, g.tupletBracket, g.artic, g.rest, g.slur > path, g.tie > path';

export interface Pt { x: number; y: number }

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

export const bez = (p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt => {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
};
export const inside = (p: Pt, b: Box): boolean => p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom;
export const fmt = (p: Pt): string => `${Math.round(p.x)},${Math.round(p.y)}`;

/** Re-draw the displaced flipped slurs of every system under `root`. */
export function layoutFlippedSlurs(root: Element, opts: SlurLayoutOpts): void {
  const u = opts.unitUser;
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
    /* Resolve the slur's notes WITHIN THIS SYSTEM: a segment broken at a
       system break has its other note on a system — often a page — that may
       not be mounted when this one is post-processed, and it is not needed
       (only the open end's x, which Verovio's own path supplies). */
    const sys = g.closest('g.system');
    if (!sys) continue;
    const inSys = (id: string): Element | null => sys.querySelector('#' + CSS.escape(id));
    const sEl = inSys(sid), eEl = inSys(eid);
    const sIn = sEl !== null, eIn = eEl !== null;
    if (!sIn && !eIn) continue;
    const ctm = path.getCTM();
    if (!ctm) continue;
    const frameInv = ctm.inverse();
    const sign = side === 'below' ? 1 : -1;
    const edge = (b: Box): number => (side === 'below' ? b.bottom : b.top);
    /* Verovio's endpoints: the path starts at the start point and reaches the
       end point half-way along (two cubics of equal length). */
    let p0: Pt, pEnd: Pt;
    try { const L = path.getTotalLength(); p0 = path.getPointAtLength(0); pEnd = path.getPointAtLength(L / 2); } catch { continue; }
    const anchorEl = (sIn ? sEl : eEl) as Element;
    const staffN = anchorEl.closest('g.staff')?.getAttribute('data-n');
    const layerN = anchorEl.closest('g.layer')?.getAttribute('data-n');
    if (staffN === null || staffN === undefined) continue;
    let S: Pt, E: Pt, displaced: boolean;
    let open: Pt | null = null, openY = 0;
    if (sEl && eEl) {
      const sHead = endHead(sEl, side, frameInv), eHead = endHead(eEl, side, frameInv);
      if (!sHead || !eHead) continue;
      const dispS = sign * (p0.y - edge(sHead.box)), dispE = sign * (pEnd.y - edge(eHead.box));
      displaced = dispS > DISP_TOL * u || dispE > DISP_TOL * u;
      S = { x: (sHead.box.left + sHead.box.right) / 2, y: edge(sHead.box) + sign * END_GAP * u };
      E = { x: (eHead.box.left + eHead.box.right) / 2, y: edge(eHead.box) + sign * END_GAP * u };
    } else {
      /* A broken segment: the open end sits past the covered notehead nearest
         the break, at Verovio's own open-end x. */
      const head = endHead(anchorEl, side, frameInv);
      if (!head) continue;
      const noteEnd: Pt = { x: (head.box.left + head.box.right) / 2, y: edge(head.box) + sign * END_GAP * u };
      const openX = sIn ? pEnd.x : p0.x;
      const lo = Math.min(noteEnd.x, openX), hi = Math.max(noteEnd.x, openX);
      /* The covered notehead NEAREST the break anchors the open end (not the
         extreme one anywhere in the segment: that put a stub's start under the
         lower voice while the notes at the break were a fifth higher). */
      let nearest: { d: number; e: number } | null = null;
      const layerSel = layerN != null ? 'g.layer[data-n="' + layerN + '"] ' : '';
      for (const st of Array.from(sys.querySelectorAll('g.staff[data-n="' + staffN + '"]'))) {
        for (const nh of Array.from(st.querySelectorAll(layerSel + 'g.note > g.notehead'))) {
          const b = svgBox(nh, frameInv);
          if (!b || b.right < lo || b.left > hi) continue;
          const d = Math.abs((b.left + b.right) / 2 - openX);
          if (!nearest || d < nearest.d) nearest = { d, e: edge(b) };
        }
      }
      openY = (nearest ? nearest.e : edge(head.box)) + sign * (END_GAP + OPEN_DROP) * u;
      open = { x: openX, y: openY };
      const pNote = sIn ? p0 : pEnd, pOpen = sIn ? pEnd : p0;
      displaced = sign * (pNote.y - edge(head.box)) > DISP_TOL * u || Math.abs(pOpen.y - openY) > DISP_TOL * u;
      S = sIn ? noteEnd : open;
      E = sIn ? open : noteEnd;
    }
    if (E.x <= S.x) continue;
    const endHeads = new Set<Element>();
    for (const el of [sEl, eEl]) { if (!el) continue; const h = endHead(el, side, frameInv); if (h) endHeads.add(h.el); }
    /* Obstacles: every glyph of this staff (all layers) within the span, less
       the two endpoint noteheads and the slur itself; boxes padded by MARGIN. */
    const lo = S.x - u, hi = E.x + u, pad = MARGIN * u;
    const obstacles: Box[] = [], tight: Box[] = [];
    for (const st of Array.from(sys.querySelectorAll('g.staff[data-n="' + staffN + '"]'))) {
      for (const el of Array.from(st.querySelectorAll(OBSTACLE_SEL))) {
        if (endHeads.has(el) || el === path) continue;
        const b = svgBox(el, frameInv);
        if (!b || b.right < lo || b.left > hi || !(b.right > b.left)) continue;
        obstacles.push({ left: b.left - pad, right: b.right + pad, top: b.top - pad, bottom: b.bottom + pad });
        tight.push(b);
      }
    }
    /* Verovio's own curve through a glyph is the other reason to re-draw: a
       broken segment's continuation can start at a sensible height and still
       cut through the lower voice on its way to the note (m. 43→44). */
    let collides = false;
    if (!displaced && tight.length) {
      try {
        const L = path.getTotalLength();
        for (let i = 0; i <= SAMPLES && !collides; i++) {
          const q = path.getPointAtLength(L / 2 * i / SAMPLES);
          for (const b of tight) { if (inside(q, b)) { collides = true; break; } }
        }
      } catch { /* unmeasurable path: leave it */ }
    }
    if (!displaced && !collides) continue;                        // Verovio's slur is at its notes and clear: keep it
    /* The curve: a cubic bulging perpendicular to the chord, toward the slur
       side, grown until the sampled curve clears every obstacle. */
    const solve = (A: Pt, B: Pt): { P1: Pt; P2: Pt; nx: number; ny: number } | null => {
      const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy);
      if (!(len > 0)) return null;
      let nx = -dy / len, ny = dx / len;
      if (Math.sign(ny) !== sign) { nx = -nx; ny = -ny; }
      let h = Math.min(Math.max(H_RATE * len, H_MIN * u), H_START_MAX * u);
      for (; h <= H_MAX * u + 1e-6; h += H_STEP * u) {
        const k = (4 / 3) * h;
        const P1: Pt = { x: A.x + dx * 0.25 + nx * k, y: A.y + dy * 0.25 + ny * k };
        const P2: Pt = { x: A.x + dx * 0.75 + nx * k, y: A.y + dy * 0.75 + ny * k };
        let clear = true;
        for (let i = 0; i <= SAMPLES && clear; i++) {
          const q = bez(A, P1, P2, B, i / SAMPLES);
          for (const b of obstacles) { if (inside(q, b)) { clear = false; break; } }
        }
        if (clear) return { P1, P2, nx, ny };
      }
      return null;
    };
    let found: { P1: Pt; P2: Pt; nx: number; ny: number } | null = null;
    if (open === null) {
      found = solve(S, E);
    } else {
      /* A broken segment's open end hangs from no note: when the curve cannot
         clear from the anchored height (the lower voice right under it), bring
         the open end back toward the covered notes, half a unit at a time. */
      for (let lift = 0; lift <= OPEN_LIFT_MAX * u + 1e-6 && !found; lift += 0.5 * u) {
        open.y = openY - sign * lift;
        found = solve(S, E);
      }
    }
    let mark = 'redrawn';
    if (!found) {
      /* Tight retry: the lower voice's chord right under the slur's end note
         (m. 52→53) leaves less than the standard end gap plus margin; shrink
         both and try once more. */
      const shrink = (END_GAP - END_GAP_TIGHT) * u, mt = MARGIN_TIGHT * u;
      obstacles.splice(0, obstacles.length, ...tight.map((b) => ({ left: b.left - mt, right: b.right + mt, top: b.top - mt, bottom: b.bottom + mt })));
      for (const q of (open === null ? [S, E] : [open === S ? E : S])) q.y -= sign * shrink;
      if (open === null) found = solve(S, E);
      else for (let lift = 0; lift <= OPEN_LIFT_MAX * u + 1e-6 && !found; lift += 0.5 * u) { open.y = openY - sign * lift; found = solve(S, E); }
      mark = 'redrawn-tight';
    }
    if (!found) { g.setAttribute('data-hkl-slur', 'kept'); continue; }
    const { P1, P2, nx, ny } = found;
    const t = THICK * u;
    const o1: Pt = { x: P1.x + nx * t, y: P1.y + ny * t }, o2: Pt = { x: P2.x + nx * t, y: P2.y + ny * t };
    const i1: Pt = { x: P1.x - nx * t, y: P1.y - ny * t }, i2: Pt = { x: P2.x - nx * t, y: P2.y - ny * t };
    path.setAttribute('data-hkl-orig-d', path.getAttribute('d') ?? '');
    path.setAttribute('d', `M${fmt(S)} C${fmt(o1)} ${fmt(o2)} ${fmt(E)} C${fmt(i2)} ${fmt(i1)} ${fmt(S)}`);
    g.setAttribute('data-hkl-slur', mark);
  }
}
