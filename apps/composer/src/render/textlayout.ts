// Below-staff text layout — a DOM post-process on rendered systems (2026-09-04).
//
// Verovio places a dynamic, hairpin or expressive text just under its staff
// (its `dynamDist` floor, or whatever the staff's lowest content forces). Two
// conventions on top of that (backlog, Opinionation):
//   • Inside a GRAND STAFF, a mark under the upper staff (or above the lower
//     one) is centred in the gap between the two staves, as far as the other
//     staff's content in the same horizontal range allows.
//   • Under any OTHER staff (a single-line instrument, the bottom of a grand
//     staff), expressive text (<dir>) is kept at least as far from the staff
//     as the dynamics are — Verovio's `dynamDist` governs <dynam> only.
// Marks whose horizontal ranges overlap (a dynamic with its hairpin, a stacked
// dynamic + text) move as ONE block so Verovio's own stacking survives.
//
// EVERY measurement is taken in the SVG's own user space — `getBBox()` mapped
// through `getCTM()` into the page-margin group's frame (see `svgBox`) —
// never through screen rectangles. The pass runs on the live page AND on the
// splice / reference hosts, and the same music must produce the same shift on
// each: a screen-rect version differed between hosts by the hosts' sub-pixel
// phase, a `<dir>` nudged under a system's last staff then changed that
// system's `below` extent by a fraction of a unit, and rule v2's whole-pixel
// quantization flipped some systems by one pixel on re-placed pages while the
// reference gate's fresh render did not (gated sonata sweep, 2026-09-04).
// Two phases — all reads, then all writes — so a system costs one layout
// flush. Idempotent: a mark's previous shift is undone before it is
// re-measured (the post-process is re-run on re-mounts).
//
// It never changes a system's EXTENTS except in one case: a centred mark stays
// inside the gap between its two staves, but a nudged <dir> under the last
// staff grows the system — which is why this runs before placement measures
// the system (postProcessRendered precedes placePage).

/** The staff-relationships the pass needs from the document. */
export interface TextLayoutOpts {
  /** [upper, lower] staff @n of every two-staff instrument (grand staff). */
  grandPairs: ReadonlyArray<readonly [number, number]>;
  /** Minimum clearance kept between a <dir> and the staff line above it, in
   *  SVG user units: matches the dynamics' `dynamDist` so text and dynamics
   *  under one staff share a baseline. */
  dirGapUser: number;
}

interface Box { left: number; right: number; top: number; bottom: number }
interface Row extends Box { n: number; el: Element }
interface Mark { el: SVGGraphicsElement; box: Box; upper: Row; lower: Row | null; mode: 'center' | 'mingap' }

const MARK_SEL = 'g.dynam, g.dir, g.hairpin';
/* Glyph-bearing groups of a staff that a moving mark must not run into. */
const OBSTACLE_SEL = 'g.note, g.rest, g.mRest, g.accid, g.beam, g.stem, g.clef, g.keySig, g.meterSig, g.tupletBracket, g.tupletNum, g.artic, g.dots, g.ledgerLines, g.flag';
/* Half a Verovio unit at the crisp presets (unit 8 → 80 user units per unit). */
const PAD = 40;

const attrNum = (el: Element, name: string): number | null => {
  const v = el.getAttribute(name);
  if (v === null) return null;
  const n = parseInt(v.trim().split(/\s+/)[0], 10);
  return Number.isFinite(n) ? n : null;
};

/** An element's bbox in a shared reference frame — the coordinate system of
 *  `frame` (the system's parent: the page-margin group, or the splice host's
 *  equivalent). `getCTM()` maps to the nearest viewport, and for everything
 *  inside Verovio's nested `svg.definition-scale` that includes the viewBox
 *  scale (user units × 0.1 at scale 100); composing with the frame's inverse
 *  CTM cancels it, so the result is in the frame's USER units — the units the
 *  mark's `translate` is written in — and independent of where the host sits
 *  on screen. Verovio's transforms are translates and uniform scales, so
 *  mapping the two corners is exact. Null when the element has no box. */
function svgBox(el: Element, frameInv: DOMMatrix): Box | null {
  const g = el as SVGGraphicsElement;
  if (typeof g.getBBox !== 'function' || typeof g.getCTM !== 'function') return null;
  let b: DOMRect;
  try { b = g.getBBox(); } catch { return null; }
  const own = g.getCTM();
  if (!own) return null;
  const m = frameInv.multiply(own);
  const x1 = m.a * b.x + m.c * b.y + m.e, x2 = m.a * (b.x + b.width) + m.c * (b.y + b.height) + m.e;
  const y1 = m.b * b.x + m.d * b.y + m.f, y2 = m.b * (b.x + b.width) + m.d * (b.y + b.height) + m.f;
  return { left: Math.min(x1, x2), right: Math.max(x1, x2), top: Math.min(y1, y2), bottom: Math.max(y1, y2) };
}

/** Staff rows of a measure, from its `g.staff` children's line paths. */
function rowsOf(measure: Element, frameInv: DOMMatrix): Row[] {
  const rows: Row[] = [];
  for (const staff of Array.from(measure.children)) {
    if (!staff.classList.contains('staff')) continue;
    const n = attrNum(staff, 'data-n');
    if (n === null) continue;
    let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
    for (const p of Array.from(staff.children)) {
      if (p.localName !== 'path') continue;
      const b = svgBox(p, frameInv);
      if (!b || b.bottom - b.top > PAD) continue;      // not a staff line
      top = Math.min(top, b.top); bottom = Math.max(bottom, b.bottom);
      left = Math.min(left, b.left); right = Math.max(right, b.right);
    }
    if (!isFinite(top)) continue;
    rows.push({ n, top, bottom, left, right, el: staff });
  }
  rows.sort((a, b) => a.top - b.top);
  return rows;
}

/** Lay out the below-staff marks of every system under `root` (or of `root`
 *  itself when it is a system). */
export function layoutBelowStaffText(root: Element, opts: TextLayoutOpts): void {
  const systems = root.matches('g.system') ? [root] : Array.from(root.querySelectorAll('g.system'));
  for (const sys of systems) layoutSystem(sys, opts);
}

function layoutSystem(sys: Element, opts: TextLayoutOpts): void {
  const marks = Array.from(sys.querySelectorAll(MARK_SEL)) as SVGGraphicsElement[];
  if (!marks.length) return;
  /* Undo a previous run's shifts before measuring (idempotency). */
  for (const m of marks) if (m.hasAttribute('data-hkl-vshift')) { m.removeAttribute('transform'); m.removeAttribute('data-hkl-vshift'); }
  /* The reference frame: the system's parent (the page-margin group). */
  const frame = sys.parentElement as (SVGGraphicsElement | null);
  const frameCtm = frame && typeof frame.getCTM === 'function' ? frame.getCTM() : null;
  if (!frameCtm) return;
  const frameInv = frameCtm.inverse();
  const grandLowerOf = new Map<number, number>();
  const grandUpperOf = new Map<number, number>();
  for (const [u, l] of opts.grandPairs) { grandLowerOf.set(u, l); grandUpperOf.set(l, u); }

  /* ── reads ── */
  const rowCache = new Map<Element, Row[]>();
  const rowsFor = (measure: Element): Row[] => {
    let r = rowCache.get(measure);
    if (!r) { r = rowsOf(measure, frameInv); rowCache.set(measure, r); }
    return r;
  };
  const items: Mark[] = [];
  for (const el of marks) {
    const measure = el.closest('g.measure');
    if (!measure) continue;
    const staffN = attrNum(el, 'data-staff');
    if (staffN === null) continue;
    const rows = rowsFor(measure);
    const own = rows.find((r) => r.n === staffN);
    if (!own) continue;
    const box = svgBox(el, frameInv);
    if (!box || !(box.right > box.left) || !(box.bottom > box.top)) continue;
    const place = el.getAttribute('data-place') ?? ((box.top + box.bottom) / 2 > (own.top + own.bottom) / 2 ? 'below' : 'above');
    const idx = rows.indexOf(own);
    if (place === 'below') {
      const lower = idx + 1 < rows.length ? rows[idx + 1] : null;
      if (lower && grandLowerOf.get(staffN) === lower.n) items.push({ el, box, upper: own, lower, mode: 'center' });
      else if (el.classList.contains('dir')) items.push({ el, box, upper: own, lower, mode: 'mingap' });
    } else if (place === 'above') {
      const upper = idx > 0 ? rows[idx - 1] : null;
      if (upper && grandUpperOf.get(staffN) === upper.n) items.push({ el, box, upper, lower: own, mode: 'center' });
    }
  }
  if (!items.length) return;

  /* Cluster x-overlapping marks that share a gap. */
  const clusters: Mark[][] = [];
  const key = (m: Mark): string => m.upper.n + '/' + (m.lower?.n ?? '-') + '/' + m.mode;
  const byGap = new Map<string, Mark[]>();
  for (const m of items) { const k = key(m); (byGap.get(k) ?? byGap.set(k, []).get(k)!).push(m); }
  for (const group of byGap.values()) {
    group.sort((a, b) => a.box.left - b.box.left);
    let cur: Mark[] = [];
    let right = -Infinity;
    for (const m of group) {
      if (cur.length && m.box.left > right + PAD) { clusters.push(cur); cur = []; right = -Infinity; }
      cur.push(m); right = Math.max(right, m.box.right);
    }
    if (cur.length) clusters.push(cur);
  }

  /* Obstacles: glyph groups of a staff row overlapping an x-range, plus marks
     attached to that staff on the gap side. */
  const obstacleBoxes = (row: Row, left: number, right: number, side: 'above' | 'below'): Box[] => {
    const out: Box[] = [];
    const rowEls = Array.from(sys.querySelectorAll('g.staff')).filter((s) => attrNum(s, 'data-n') === row.n);
    for (const s of rowEls) {
      for (const g of Array.from(s.querySelectorAll(OBSTACLE_SEL))) {
        const b = svgBox(g, frameInv);
        if (!b || b.right < left - PAD || b.left > right + PAD || !(b.right > b.left)) continue;
        out.push(b);
      }
    }
    for (const g of Array.from(sys.querySelectorAll(MARK_SEL))) {
      if (attrNum(g, 'data-staff') !== row.n || (g.getAttribute('data-place') ?? '') !== side) continue;
      const b = svgBox(g, frameInv);
      if (!b || b.right < left - PAD || b.left > right + PAD || !(b.right > b.left)) continue;
      out.push(b);
    }
    return out;
  };

  const writes: Array<{ el: SVGGraphicsElement; dy: number }> = [];
  for (const cl of clusters) {
    let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
    for (const m of cl) { top = Math.min(top, m.box.top); bottom = Math.max(bottom, m.box.bottom); left = Math.min(left, m.box.left); right = Math.max(right, m.box.right); }
    const { upper, lower, mode } = cl[0];
    let dy: number;
    if (mode === 'center') {
      if (!lower) continue;
      dy = (upper.bottom + lower.top) / 2 - (top + bottom) / 2;
    } else {
      dy = Math.max(0, upper.bottom + opts.dirGapUser - top);
    }
    if (dy > 0) {
      /* Moving down: stay above the lower staff's line and its content. */
      let limit = lower ? lower.top - PAD : Infinity;
      if (lower) for (const b of obstacleBoxes(lower, left, right, 'above')) limit = Math.min(limit, b.top - PAD);
      dy = Math.min(dy, limit - bottom);
      if (dy < 0) dy = 0;
    } else if (dy < 0) {
      /* Moving up: stay below the upper staff's line and its content. */
      let limit = upper.bottom + PAD;
      for (const b of obstacleBoxes(upper, left, right, 'below')) limit = Math.max(limit, b.bottom + PAD);
      dy = Math.max(dy, limit - top);
      if (dy > 0) dy = 0;
    }
    /* Whole user units: the same music must yield the same shift on every
       host, and a float tail here would be a float tail in the extents. */
    dy = Math.round(dy);
    if (Math.abs(dy) < 3) continue;                     // under a third of a device pixel: leave it
    for (const m of cl) writes.push({ el: m.el, dy });
  }

  /* ── writes ── */
  for (const { el, dy } of writes) {
    el.setAttribute('transform', `translate(0, ${dy})`);
    el.setAttribute('data-hkl-vshift', String(dy));
  }
}
