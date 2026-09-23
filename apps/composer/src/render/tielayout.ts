// Colliding-tie re-draw — a DOM post-process on rendered systems (2026-09-22).
//
// Verovio 6.3 places a tie from its two noteheads alone (src/tie.cpp, read at
// 425dd7b): the side is `@curvedir`, else the layer's stem direction, else the
// note's; the shape is fixed (control points at ¼ and ¾ of the span, a
// constant `1.6 − staffLineWidth` units off the endpoints); the only obstacles
// it knows are its OWN start note's dots and flag, the staff lines and an
// enharmonic partner. Nothing looks at another layer, so a voice crossing the
// tie's pitch is drawn straight through (Max's repro: V1 A4 dotted half tied to
// a quarter, V2 quarter rest + C5 — the C5 head sits on the tie). Flipping the
// side is no fix (Max): the side follows voice order, and in the real case — an
// arpeggio under a long tie crossing its pitch — the other side collides with
// something else.
//
// So, on the slurlayout.ts path: a tie whose DRAWN shape (either edge of
// Verovio's filled path) overlaps a glyph of its system is re-drawn with the
// same endpoints, side, control-point x and thickness, its arch raised in
// `STEP` increments from Verovio's own height. The first arch whose edges both
// clear every obstacle by `MARGIN` wins — the lowest non-colliding one — as long
// as its outer height stays within the tie's width (Max: never taller than
// wide). If none does, Verovio's tie stays (`data-hkl-tie="kept"`). Contact
// within `END_ZONE` of an endpoint is ignored throughout: it is Verovio's
// placement of the endpoint, which the arch cannot change.
//
// Obstacles: every glyph of the tie's SYSTEM within its span (a raised arch can
// reach the next staff): the slur pass's set plus text marks, less the two tied
// notes (Verovio already handles their dots and flag, and an endpoint does not
// move), CSS-hidden rests, and the tie itself. Glyphs are boxes; CURVES (slurs,
// other ties) are their sampled outlines, tested by distance — a curve's box is
// the whole region under its arc, and on the sonata that made 43 of 55 ties
// under a slur or inside a chord's nested ties "collide" with nothing.
// Barlines and staff / ledger lines are not obstacles — a tie crosses them by
// nature. The start note is `data-startid`; the end note is the notehead
// nearest the path's end point in the start note's staff and layer (a segment
// whose start note is on another system takes the nearest notehead in the
// system).
//
// Runs LAST among the glyph passes — after injectHejiGlyphs, which swaps every
// accidental for a BravuraText `<text>`, so it measures the glyphs actually
// drawn (see Ink boxes), and after layoutFlippedSlurs, whose final curves are
// its obstacles. The slur pass must not see a raised tie, so the renderer
// restores Verovio's ties (restoreTieRedraws) before it; this pass restores
// them again itself, so it is idempotent. A raised tie can grow a system's
// extents; it still runs before placement measures them.

import { svgBox, type Box } from './textlayout.js';
import { bez, fmt, MARGIN, OBSTACLE_SEL, type Pt } from './slurlayout.js';

export interface TieLayoutOpts {
  /** SVG user units per Verovio unit (80 at unit 8). */
  unitUser: number;
}

/* In Verovio units. */
const STEP = 0.25;         // arch raise per attempt
const END_NEAR = 3;        // an end notehead further than this from the path's end point is not the tie's
const SAMPLE_GAP = 0.25;   // curve sampling density along the span
const CURVE_TOUCH = 0.2;   // Verovio's tie "crosses" a curve obstacle within this distance (> SAMPLE_GAP / 2)
/* Contact this close (in x) to an endpoint is not the arch's: the endpoint does
   not move and the raise barely moves the curve there, so testing it made a tie
   whose start note also starts a slur — or a chord's nested ties, which meet at
   their ends — unsolvable (4 of 9 kept on the sonata). Capped at a fifth of the
   span so a short tie keeps most of its length under test. */
const END_ZONE = 1.5, END_ZONE_FRAC = 0.2;
const EPS = 0.02;          // "no nearer than the original" tolerance inside the zones

const TIE_OBSTACLE_SEL = OBSTACLE_SEL + ', g.dynam, g.dir, g.tempo, g.fermata';
const HIDDEN_SEL = 'g.rest[data-visible="false"], g.rest[data-data-tuplet-placeholder="true"]';

/** A glyph's box; a curve also carries its outline polyline (same frame),
 *  sampled on first use — `undefined` until then, `null` for a glyph. */
interface Obstacle { el: Element; box: Box; poly: Pt[] | null | undefined }

/** Squared distance from `p` to segment `a`–`b`. */
function segDist2(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  const x = a.x + t * dx - p.x, y = a.y + t * dy - p.y;
  return x * x + y * y;
}

/** Whether `p` lies within `pad` of obstacle `o`: inside its box, or near
 *  its outline for a curve (`poly` must be resolved). */
function hits(p: Pt, o: Obstacle, pad: number): boolean {
  const b = o.box;
  if (p.x < b.left - pad || p.x > b.right + pad || p.y < b.top - pad || p.y > b.bottom + pad) return false;
  if (!o.poly) return true;
  const pad2 = pad * pad;
  for (let i = 1; i < o.poly.length; i++) if (segDist2(p, o.poly[i - 1], o.poly[i]) <= pad2) return true;
  return false;
}

/** Distance from `p` to obstacle `o` (0 inside a glyph box). */
function distTo(p: Pt, o: Obstacle): number {
  if (!o.poly) {
    const b = o.box;
    return Math.hypot(Math.max(b.left - p.x, 0, p.x - b.right), Math.max(b.top - p.y, 0, p.y - b.bottom));
  }
  let d2 = Infinity;
  for (let i = 1; i < o.poly.length; i++) d2 = Math.min(d2, segDist2(p, o.poly[i - 1], o.poly[i]));
  return Math.sqrt(d2);
}

/** Short label of an obstacle, for the `data-hkl-tie-hit` diagnostic. */
const labelOf = (el: Element): string =>
  el.localName === 'path' ? (el.parentElement?.classList[0] ?? 'path') + '>path' : (el.classList[0] ?? el.localName);

/** A curve path's outline sampled into `frameInv`'s frame, or null. */
function outline(path: SVGGeometryElement, frameInv: DOMMatrix, gap: number): Pt[] | null {
  const own = path.getCTM();
  if (!own) return null;
  let L: number;
  try { L = path.getTotalLength(); } catch { return null; }
  if (!(L > 0)) return null;
  const m = frameInv.multiply(own);
  const n = Math.max(8, Math.ceil(L / gap));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const q = path.getPointAtLength(L * i / n);
    out.push({ x: m.a * q.x + m.c * q.y + m.e, y: m.b * q.x + m.d * q.y + m.f });
  }
  return out;
}

/* ── Ink boxes ──
   `getBBox` is tight for geometry (Verovio's `<use>` glyphs, paths, polygons)
   but for a `<text>` it is the CHARACTER CELL — full ascent + descent, whole
   advance. Every accidental is a BravuraText `<text>` once injectHejiGlyphs
   has run (plain ones too), and dynamics / directions / tempi are text, so a
   cell box flagged ties that pass beside an accidental as colliding (Max,
   2026-09-22: "neither of those are real collisions"). Text is measured per
   character instead: canvas `measureText` in the element's computed font gives
   the glyph's ink extents about its origin, placed at getStartPositionOfChar. */
const LEAF_SEL = 'use, path, rect, polygon, polyline, ellipse, circle, line';
let measureCtx: CanvasRenderingContext2D | null | undefined;
const inkCache = new Map<string, { l: number; r: number; a: number; d: number }>();

function charInk(font: string, ch: string): { l: number; r: number; a: number; d: number } | null {
  const key = font + '\u0000' + ch;
  const hit = inkCache.get(key);
  if (hit) return hit;
  if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return null;
  measureCtx.font = font;
  const m = measureCtx.measureText(ch);
  const v = { l: m.actualBoundingBoxLeft, r: m.actualBoundingBoxRight, a: m.actualBoundingBoxAscent, d: m.actualBoundingBoxDescent };
  inkCache.set(key, v);
  return v;
}

/** Ink box of one `<text>` in `frameInv`'s frame; `ok: false` when it cannot
 *  be measured (font not loaded, whitespace collapsed, surrogates) — the caller
 *  then falls back to the cell box, which only over-reports. */
function textInk(t: SVGTextElement, frameInv: DOMMatrix): { ok: boolean; box: Box | null } {
  let n: number;
  try { n = t.getNumberOfChars(); } catch { return { ok: false, box: null }; }
  if (!n) return { ok: true, box: null };
  const ctm = t.getCTM();
  if (!ctm) return { ok: false, box: null };
  const chars: Array<{ ch: string; font: string }> = [];
  const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const cs = getComputedStyle(node.parentElement as Element);
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    if (typeof document.fonts?.check === 'function' && !document.fonts.check(font)) return { ok: false, box: null };
    const str = node.nodeValue ?? '';
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDFFF) return { ok: false, box: null };
      chars.push({ ch: str[i], font });
    }
  }
  if (chars.length !== n) return { ok: false, box: null };
  const m = frameInv.multiply(ctm);
  let box: Box | null = null;
  for (let i = 0; i < n; i++) {
    const ink = charInk(chars[i].font, chars[i].ch);
    if (!ink) return { ok: false, box: null };
    if (!(ink.l + ink.r > 0) || !(ink.a + ink.d > 0)) continue;     // no ink (a space)
    const p = t.getStartPositionOfChar(i);
    for (const [x, y] of [[p.x - ink.l, p.y - ink.a], [p.x + ink.r, p.y - ink.a], [p.x - ink.l, p.y + ink.d], [p.x + ink.r, p.y + ink.d]]) {
      const q = { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
      box = box
        ? { left: Math.min(box.left, q.x), right: Math.max(box.right, q.x), top: Math.min(box.top, q.y), bottom: Math.max(box.bottom, q.y) }
        : { left: q.x, right: q.x, top: q.y, bottom: q.y };
    }
  }
  return { ok: true, box };
}

/** An element's INK box in `frameInv`'s frame: geometry boxes for its shapes,
 *  per-character ink for its text. Null when it draws nothing measurable. */
export function inkBox(el: Element, frameInv: DOMMatrix): Box | null {
  const texts = el.localName === 'text' ? [el] : Array.from(el.querySelectorAll('text'));
  if (!texts.length) return svgBox(el, frameInv);
  let box: Box | null = null;
  const add = (b: Box | null): void => {
    if (!b) return;
    box = box ? { left: Math.min(box.left, b.left), right: Math.max(box.right, b.right), top: Math.min(box.top, b.top), bottom: Math.max(box.bottom, b.bottom) } : b;
  };
  for (const leaf of Array.from(el.querySelectorAll(LEAF_SEL))) if (!leaf.closest('text')) add(svgBox(leaf, frameInv));
  for (const t of texts) {
    const r = textInk(t as SVGTextElement, frameInv);
    add(r.ok ? r.box : svgBox(t, frameInv));
  }
  return box;
}

/** Verovio's tie path `M S C o1 o2 E C i2 i1 S` → its six points, or null. */
function parseTie(d: string): { S: Pt; o1: Pt; o2: Pt; E: Pt; i2: Pt; i1: Pt } | null {
  if (!/^\s*M[^MC]+C[^MC]+C[^MC]+$/.test(d)) return null;
  const n = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (n.length < 12) return null;
  const P = (i: number): Pt => ({ x: n[i], y: n[i + 1] });
  return { S: P(0), o1: P(2), o2: P(4), E: P(6), i2: P(8), i1: P(10) };
}

/** The note (or its chord) a notehead belongs to — the subtree excluded as a
 *  tie endpoint. */
const noteRoot = (el: Element): Element => el.closest('g.chord') ?? el.closest('g.note') ?? el;

/** Put every tie under `root` back to Verovio's curve and drop the marks. The
 *  renderer calls this BEFORE the slur pass, so flipped slurs are always
 *  routed around Verovio's ties (the same input on every re-run), and the tie
 *  pass itself runs later, after injectHejiGlyphs, against the final glyphs
 *  and the final slurs. */
export function restoreTieRedraws(root: Element): void {
  for (const path of Array.from(root.querySelectorAll('g.tie > path[data-hkl-orig-d]'))) {
    path.setAttribute('d', path.getAttribute('data-hkl-orig-d') ?? '');
    path.removeAttribute('data-hkl-orig-d');
  }
  for (const g of Array.from(root.querySelectorAll('g.tie'))) { g.removeAttribute('data-hkl-tie'); g.removeAttribute('data-hkl-tie-hit'); }
}

/** Re-draw every tie under `root` that Verovio drew through another glyph. */
export function layoutCollidingTies(root: Element, opts: TieLayoutOpts): void {
  const u = opts.unitUser;
  const ties = Array.from(root.querySelectorAll('g.tie'));
  if (!ties.length) return;
  restoreTieRedraws(root);   // measure Verovio's ties, never a previous re-draw
  /* Obstacle boxes per system, built on first use in the SYSTEM's frame. A
     tie's own frame can differ from it — render/instrgap.ts translates an
     instrument's elements, ties included, before this runs — so each tie's
     points are mapped into the system frame and back (measuring every tie in
     the first tie's frame lifted a shifted tie into its neighbour, sonata
     p. 18). */
  const cache = new Map<Element, { frameInv: DOMMatrix; obs: Obstacle[] }>();
  const apply = (m: DOMMatrix, p: Pt): Pt => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });
  for (const g of ties) {
    const path = g.querySelector(':scope > path') as SVGPathElement | null;
    if (!path || typeof path.getCTM !== 'function') continue;
    const local = parseTie(path.getAttribute('d') ?? '');
    if (!local) continue;
    const sys = g.closest('g.system') as SVGGraphicsElement | null;
    if (!sys || typeof sys.getCTM !== 'function') continue;
    let entry = cache.get(sys);
    if (!entry) {
      const sctm = sys.getCTM();
      if (!sctm) continue;
      const frameInv = sctm.inverse();
      const obs: Obstacle[] = [];
      for (const el of Array.from(sys.querySelectorAll(TIE_OBSTACLE_SEL))) {
        if (el.matches(HIDDEN_SEL)) continue;
        const b = inkBox(el, frameInv);
        if (!b || !(b.right > b.left)) continue;
        obs.push({ el, box: b, poly: el.localName === 'path' ? undefined : null });
      }
      entry = { frameInv, obs };
      cache.set(sys, entry);
    }
    const { frameInv, obs } = entry;
    const tctm = path.getCTM();
    if (!tctm) continue;
    const toSys = frameInv.multiply(tctm), toLocal = toSys.inverse();
    const pts = {
      S: apply(toSys, local.S), o1: apply(toSys, local.o1), o2: apply(toSys, local.o2),
      E: apply(toSys, local.E), i2: apply(toSys, local.i2), i1: apply(toSys, local.i1),
    };
    const { S, E } = pts;
    const width = E.x - S.x;
    if (!(width > 0)) continue;
    /* Side: SVG y grows downward, so an above-tie's outer controls sit higher. */
    const sign = (pts.o1.y + pts.o2.y) / 2 < (S.y + E.y) / 2 ? -1 : 1;
    /* The tied notes. */
    const sid = (g.getAttribute('data-startid') ?? '').replace(/^#/, '');
    const sEl = sid ? sys.querySelector('#' + CSS.escape(sid)) : null;
    const staffN = sEl?.closest('g.staff')?.getAttribute('data-n') ?? null;
    const layerN = sEl?.closest('g.layer')?.getAttribute('data-n') ?? null;
    const headSel = (staffN !== null ? 'g.staff[data-n="' + staffN + '"] ' : '')
      + (layerN !== null ? 'g.layer[data-n="' + layerN + '"] ' : '') + 'g.note > g.notehead';
    let eRoot: Element | null = null, best = END_NEAR * u;
    for (const h of Array.from(sys.querySelectorAll(headSel))) {
      const b = svgBox(h, frameInv);
      if (!b) continue;
      const dist = Math.hypot((b.left + b.right) / 2 - E.x, (b.top + b.bottom) / 2 - E.y);
      if (dist < best) { best = dist; eRoot = noteRoot(h); }
    }
    const sRoot = sEl ? noteRoot(sEl) : null;
    const own = (el: Element): boolean =>
      el.parentElement === g || (!!sRoot && sRoot.contains(el)) || (!!eRoot && eRoot.contains(el));
    const near = obs.filter((o) => !own(o.el) && o.box.right > S.x && o.box.left < E.x);
    for (const o of near) if (o.poly === undefined) o.poly = outline(o.el as SVGGeometryElement, frameInv, SAMPLE_GAP * u);
    for (let i = near.length - 1; i >= 0; i--) if (near[i].poly === undefined || (near[i].el.localName === 'path' && !near[i].poly)) near.splice(i, 1);
    if (!near.length) continue;
    const samples = Math.max(24, Math.ceil(width / (SAMPLE_GAP * u)));
    const zone = Math.min(END_ZONE * u, END_ZONE_FRAC * width);
    const tested = (p: Pt): boolean => p.x - S.x >= zone && E.x - p.x >= zone;
    type Curve = { o1: Pt; o2: Pt; i1: Pt; i2: Pt };
    const orig: Curve = { o1: pts.o1, o2: pts.o2, i1: pts.i1, i2: pts.i2 };
    const edgesAt = (c: Curve, t: number): [Pt, Pt] => [bez(S, c.o1, c.o2, E, t), bez(S, c.i1, c.i2, E, t)];
    const pad = MARGIN * u;
    /* Inside the endpoint zones the arch cannot remove Verovio's own contact,
       so there it is excused — but only as close as Verovio drew it: a raise
       may never bring an edge nearer an obstacle there than the original
       curve was at that sample (keyed sample:edge:obstacle). Excusing any
       original contact let a chord's inner tie be lifted INTO its sibling
       beside their shared end (sonata p. 18). */
    const excused = new Map<string, number>();
    for (let i = 0; i <= samples; i++) {
      const e = edgesAt(orig, i / samples);
      for (let k = 0; k < 2; k++) {
        if (tested(e[k])) continue;
        for (let j = 0; j < near.length; j++) if (hits(e[k], near[j], pad)) excused.set(i + ':' + k + ':' + j, distTo(e[k], near[j]));
      }
    }
    /* Outer-edge height above (below) the chord, and the first obstacle either
       edge comes within `glyphPad` / `curvePad` of — outside the zones always,
       inside them only when `excuse` is given and the edge is nearer than the
       original was there. */
    const probe = (c: Curve, glyphPad: number, curvePad: number, excuse: Map<string, number> | null): { height: number; hit: Obstacle | null } => {
      let height = 0, hit: Obstacle | null = null;
      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const e = edgesAt(c, t);
        height = Math.max(height, sign * (e[0].y - (S.y + (E.y - S.y) * t)));
        for (let j = 0; j < near.length && !hit; j++) {
          const o = near[j], d = o.poly ? curvePad : glyphPad;
          for (let k = 0; k < 2; k++) {
            if (!hits(e[k], o, d)) continue;
            if (tested(e[k])) { hit = o; break; }
            if (!excuse) continue;
            const was = excuse.get(i + ':' + k + ':' + j);
            if (was === undefined || distTo(e[k], o) < was - EPS * u) { hit = o; break; }
          }
        }
      }
      return { height, hit };
    };
    const first = probe(orig, 0, CURVE_TOUCH * u, null).hit;
    if (!first) continue;                                          // Verovio's tie touches nothing: keep it
    g.setAttribute('data-hkl-tie-hit', labelOf(first.el));
    let found: Curve | null = null;
    for (let raise = STEP * u; ; raise += STEP * u) {
      const dy = sign * raise;
      const lift = (p: Pt): Pt => ({ x: p.x, y: p.y + dy });
      const cand: Curve = { o1: lift(pts.o1), o2: lift(pts.o2), i1: lift(pts.i1), i2: lift(pts.i2) };
      const r = probe(cand, pad, pad, excused);
      if (r.height > width) break;                                  // taller than wide: give up
      if (!r.hit) { found = cand; break; }
    }
    if (!found) { g.setAttribute('data-hkl-tie', 'kept'); continue; }
    path.setAttribute('data-hkl-orig-d', path.getAttribute('d') ?? '');
    const L = (p: Pt): string => fmt(apply(toLocal, p));
    path.setAttribute('d', `M${L(S)} C${L(found.o1)} ${L(found.o2)} ${L(E)} C${L(found.i2)} ${L(found.i1)} ${L(S)}`);
    g.setAttribute('data-hkl-tie', 'redrawn');
    /* Later ties of this system see the re-drawn curve. */
    const mine = obs.find((o) => o.el === path);
    const nb = svgBox(path, frameInv), np = outline(path, frameInv, SAMPLE_GAP * u);
    if (mine && nb && np) { mine.box = nb; mine.poly = np; }
  }
}
