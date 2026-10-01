// Mark-placement inventory (2026-09-09) — the gate for "dynamics are mis-placed
// between the staves after the instrGap pass" (Max: sonata p. 9 m. 131's `pp`
// collides with the staff below and is nowhere near centred; p. 17 m. 37's
// `dim.` collides with a tuplet bracket, both with room unused above).
//
// cb-instrgap.js only measures marks at an INSTRUMENT BOUNDARY, so a mark
// mis-placed inside its own grand staff is invisible to it. This walks EVERY
// mark in the document and reports, in the page-margin group's user space:
//   • mode        — 'center' (inside a grand staff: the pass centres it in the
//                   gap) or 'mingap' (under any other staff)
//   • cErr        — center mode only: actual box centre − the gap's centre.
//                   POSITIVE = the mark sits too LOW. This is the number the
//                   double-counted instrument shift showed up in.
//   • hits        — every obstacle the mark's INK overlaps (staff spaces deep):
//                   glyphs, stems, beams, ledger lines, the staff band, barlines,
//                   slurs/ties, other marks. Exact geometry since 2026-09-30 —
//                   see "Proper ink geometry" below.
//   • above/below — vertical clearance to the nearest non-overlapping obstacle
//                   on each side, in true x-overlap.
//   • ish/vsh     — the tags: instrgap's granted shift, textlayout's own dy.
//
//   node test/composer-inspect/phasec/runner.mjs test/composer-inspect/phasec/cb-markplace.js
//   --arg "from=0,limit=40"    chunk the deviation rows
//   --arg "rows=0"             summary only
//   --arg "page=9"             every mark on one page, deviating or not
//   --arg "hits=1"             rows = collisions only
//   --arg "all=1"              rows = every mark (with `nearest`, its closest
//                              approach in user units, for near-miss review)
const H = window.__hkl_composer; const r = H.renderer; const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 120000, step = 40) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const arg = String(window.__probeArg || '');
const numArg = (k, d) => { const m = arg.match(new RegExp(k + '=(-?\\d+)')); return m ? parseInt(m[1], 10) : d; };
const FROM = numArg('from', 0), LIMIT = numArg('limit', 10000), WANT_ROWS = numArg('rows', 1), ONLY_PAGE = numArg('page', 0);

/* Settle the partition properly: the whole document is balanced before the
   paint, so waiting on the render badge is enough (the idle job is gone).
   Historical note: balanceJobActive() was false BEFORE the job was
   armed, so waiting on !active hands back a pre-settle layout. Wait for the
   partition signature itself to stop moving. (cb-instrgap.js, lessons.md.) */
const partitionSig = () => (pb['pageStartIds'] || []).join(',') + '|' + pb.lineStarts().length;
const idle = () => { const b = document.getElementById('renderBusy'); return (!b || b.hidden) && r.extentsJobState() === null; };
const settleFully = async (stableMs = 4000, budget = 150000) => {
  const t0 = performance.now(); let last = null, since = 0;
  while (performance.now() - t0 < budget) {
    const s = partitionSig();
    if (s !== last) { last = s; since = performance.now(); }
    else if (idle() && performance.now() - since > stableMs) return true;
    await sleep(200);
  }
  return false;
};
await waitFor(() => pb['startIds'] !== null, 60000);
await settleFully();
r.setMountWindowEnabled(false); r.mountAllPages(); await settleFully(2500); await sleep(400);

const PAD = 40, SPACE = 160;
/* Overlap below this many user units (half a device pixel at scale 100) is a
   touch, not a collision. */
const TOUCH = 5;
const MARK_SEL = 'g.dynam, g.dir, g.hairpin, g.tempo';
/* Glyph-owning groups of a staff. NOT g.note: its box unions notehead and stem,
   so the empty corner beside a stem read as ink. Each group contributes only
   the leaves whose nearest obstacle ancestor is itself — a g.beam wraps the
   notes it beams, and those belong to their own noteheads/stems. */
const OBST_SEL = 'g.notehead, g.stem, g.accid, g.dots, g.flag, g.beam, g.rest, g.mRest, g.multiRest, g.clef, g.keySig, g.meterSig, g.tupletBracket, g.tupletNum, g.artic, g.ledgerLines';
const LEAF_SEL = 'use, path, rect, polygon, polyline, ellipse, circle, line';

const instrs = H.model.instruments().map((i) => i.staffNs.slice());
const grandUpperOf = new Map(), grandLowerOf = new Map();
for (const ns of instrs) if (ns.length === 2) { grandLowerOf.set(ns[0], ns[1]); grandUpperOf.set(ns[1], ns[0]); }
/* Real measure numbers (the engraved g.mNum only shows at system starts). */
const measureN = new Map();
for (const m of H.model.allMeasures()) measureN.set(m.getAttribute('xml:id'), m.getAttribute('n'));

const boxIn = (el, inv) => {
  let b; try { b = el.getBBox(); } catch { return null; }
  if (!b) return null;
  const ctm = el.getCTM && el.getCTM(); if (!ctm) return null;
  const m = inv.multiply(ctm);
  const p = (x, y) => new DOMPoint(x, y).matrixTransform(m);
  const a = p(b.x, b.y), c = p(b.x + b.width, b.y + b.height);
  return { left: Math.min(a.x, c.x), right: Math.max(a.x, c.x), top: Math.min(a.y, c.y), bottom: Math.max(a.y, c.y) };
};
const isInk = (b) => !!b && b.right > b.left && b.bottom > b.top;

/* ── Proper ink geometry (2026-09-30) ──
   Max: "I see no collisions in the places you flagged." Every obstacle used to
   be a bounding RECTANGLE: a g.note's box covers the empty corner beside its
   stem, a sloped beam's box the triangle under it, a mark's <text> box its
   whole character cell (full ascent + descent), a stem had no width at all,
   and the x-test admitted boxes a quarter unit to the SIDE of a mark. Now an
   obstacle is a set of CONVEX polygons in the frame — glyph boxes for <use>,
   per-character ink for <text>, the polygon itself for a beam, each segment of
   a stroked line widened by half its stroke — and a mark is a set of axis-
   aligned ink rects (per character; a hairpin's lines cut into short pieces).
   Each polygon is clipped to a mark rect's x-slab: for a flat-edged rect the
   clipped polygon's y-range gives the exact vertical gap, or the overlap. */
const xf = (m, x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
const rectPoly = (b) => [{ x: b.left, y: b.top }, { x: b.right, y: b.top }, { x: b.right, y: b.bottom }, { x: b.left, y: b.bottom }];
const strokeOf = (el) => {
  const a = parseFloat(el.getAttribute('stroke-width') || '');
  if (a > 0) return a;
  const cs = getComputedStyle(el);
  return cs.stroke && cs.stroke !== 'none' ? (parseFloat(cs.strokeWidth) || 0) : 0;
};
/* `M/L/H/V/Z` (either case) → segments in local units; null for curves. */
const lineSegs = (d) => {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
  const segs = []; let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0;
  const num = () => parseFloat(toks[i++]);
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case 'M': { const nx = num(), ny = num(); x = rel ? x + nx : nx; y = rel ? y + ny : ny; sx = x; sy = y; cmd = rel ? 'l' : 'L'; break; }
      case 'L': { const nx = num(), ny = num(); const x2 = rel ? x + nx : nx, y2 = rel ? y + ny : ny; segs.push([x, y, x2, y2]); x = x2; y = y2; break; }
      case 'H': { const nx = num(); const x2 = rel ? x + nx : nx; segs.push([x, y, x2, y]); x = x2; break; }
      case 'V': { const ny = num(); const y2 = rel ? y + ny : ny; segs.push([x, y, x, y2]); y = y2; break; }
      case 'Z': segs.push([x, y, sx, sy]); x = sx; y = sy; break;
      default: return null;
    }
  }
  return segs;
};
const segQuads = (segs, m, halfLocal) => segs.map(([x1, y1, x2, y2]) => {
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len * halfLocal, ny = dx / len * halfLocal;
  return [xf(m, x1 + nx, y1 + ny), xf(m, x2 + nx, y2 + ny), xf(m, x2 - nx, y2 - ny), xf(m, x1 - nx, y1 - ny)];
});
/* Per-character ink rects of a <text> (canvas measureText in its computed
   font, placed at getStartPositionOfChar — tielayout.ts `textInk`); the cell
   box when the font cannot be measured, which only over-reports. */
const mctx = document.createElement('canvas').getContext('2d');
const textRects = (t, inv) => {
  const cell = () => { const b = boxIn(t, inv); return isInk(b) ? [b] : []; };
  let n; try { n = t.getNumberOfChars(); } catch { return cell(); }
  if (!n) return [];
  const ctm = t.getCTM(); if (!ctm) return cell();
  const chars = [];
  const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const cs = getComputedStyle(node.parentElement);
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    if (document.fonts && !document.fonts.check(font)) return cell();
    for (const ch of node.nodeValue || '') { if (ch.length !== 1) return cell(); chars.push({ ch, font }); }
  }
  if (chars.length !== n) return cell();
  const m = inv.multiply(ctm);
  const out = [];
  for (let i = 0; i < n; i++) {
    mctx.font = chars[i].font;
    const k = mctx.measureText(chars[i].ch);
    const l = k.actualBoundingBoxLeft, rr = k.actualBoundingBoxRight, a = k.actualBoundingBoxAscent, d = k.actualBoundingBoxDescent;
    if (!(l + rr > 0) || !(a + d > 0)) continue;
    const p = t.getStartPositionOfChar(i);
    const q = [xf(m, p.x - l, p.y - a), xf(m, p.x + rr, p.y + d)];
    out.push({ left: Math.min(q[0].x, q[1].x), right: Math.max(q[0].x, q[1].x), top: Math.min(q[0].y, q[1].y), bottom: Math.max(q[0].y, q[1].y) });
  }
  return out;
};
/* Convex polygons drawn by one leaf (never a <text> — see textRects). */
const leafPolys = (leaf, inv) => {
  const ctm = leaf.getCTM && leaf.getCTM(); if (!ctm) return [];
  const m = inv.multiply(ctm);
  const tag = leaf.localName;
  if (tag === 'polygon') {
    const v = (leaf.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
    const pts = []; for (let i = 0; i + 1 < v.length; i += 2) pts.push(xf(m, v[i], v[i + 1]));
    return pts.length >= 3 ? [pts] : [];
  }
  const sw = strokeOf(leaf);
  if (sw > 0 && (tag === 'path' || tag === 'polyline' || tag === 'line')) {
    let segs = null;
    if (tag === 'path') segs = lineSegs(leaf.getAttribute('d') || '');
    else if (tag === 'line') segs = [['x1', 'y1', 'x2', 'y2'].map((a) => parseFloat(leaf.getAttribute(a) || '0'))];
    else {
      const v = (leaf.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number); segs = [];
      for (let i = 0; i + 3 < v.length; i += 2) segs.push([v[i], v[i + 1], v[i + 2], v[i + 3]]);
    }
    if (segs && segs.length) return segQuads(segs, m, sw / 2);
  }
  const b = boxIn(leaf, inv);
  return isInk(b) ? [rectPoly(b)] : [];
};
/* Clip a convex polygon to l ≤ x ≤ r (Sutherland–Hodgman, two planes). */
const clipX = (poly, l, r) => {
  const plane = (pts, inside, cut) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], ia = inside(a), ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) { const t = (cut - a.x) / (b.x - a.x); out.push({ x: cut, y: a.y + t * (b.y - a.y) }); }
    }
    return out;
  };
  return plane(plane(poly, (p) => p.x >= l, l), (p) => p.x <= r, r);
};
/* Mark pieces: per-character ink for text, short pieces of a hairpin's lines. */
const markRects = (mk, inv) => {
  const out = [];
  for (const t of mk.localName === 'text' ? [mk] : mk.querySelectorAll('text')) out.push(...textRects(t, inv));
  for (const leaf of mk.querySelectorAll(LEAF_SEL)) {
    if (leaf.closest('text')) continue;
    for (const poly of leafPolys(leaf, inv)) {
      const xs = poly.map((p) => p.x), lo = Math.min(...xs), hi = Math.max(...xs), N = 8;
      for (let k = 0; k < N; k++) {
        const c = clipX(poly, lo + (hi - lo) * k / N, lo + (hi - lo) * (k + 1) / N);
        if (c.length < 2) continue;
        const ys = c.map((p) => p.y), cx = c.map((p) => p.x);
        out.push({ left: Math.min(...cx), right: Math.max(...cx), top: Math.min(...ys), bottom: Math.max(...ys) });
      }
    }
  }
  return out.filter((b) => b.right > b.left);
};

const pages = [...document.querySelectorAll('#score .score-page')];
const all = [];
let systemsSeen = 0;

for (let pi = 0; pi < pages.length; pi++) {
  if (ONLY_PAGE && pi + 1 !== ONLY_PAGE) continue;
  let sysOnPage = 0;
  for (const sys of pages[pi].querySelectorAll('g.system')) {
    const frame = sys.parentElement;
    const fctm = frame && frame.getCTM && frame.getCTM(); if (!fctm) continue;
    const inv = fctm.inverse();
    systemsSeen++; sysOnPage++;
    /* Every obstacle polygon of the system, once, labelled class@staff. */
    const obs = [];
    for (const st of sys.querySelectorAll('g.staff')) {
      const n = parseInt(st.getAttribute('data-n') || '', 10);
      for (const o of st.querySelectorAll(OBST_SEL)) {
        if (o.closest('[style*="display: none"], [visibility="hidden"]')) continue;
        const cls = [...o.classList][0] + '@' + n;
        for (const t of o.querySelectorAll('text')) { if (t.parentElement.closest(OBST_SEL) === o) for (const b of textRects(t, inv)) obs.push({ cls, poly: rectPoly(b) }); }
        for (const leaf of o.querySelectorAll(LEAF_SEL)) {
          if (leaf.closest('text') || leaf.parentElement.closest(OBST_SEL) !== o) continue;
          for (const poly of leafPolys(leaf, inv)) obs.push({ cls, poly });
        }
      }
      /* The staff itself: its line band — text inside a staff is a collision. */
      let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
      for (const p of st.children) {
        if (p.tagName !== 'path') continue;
        const b = boxIn(p, inv); if (!b || b.bottom - b.top > PAD) continue;
        top = Math.min(top, b.top); bottom = Math.max(bottom, b.bottom);
        left = Math.min(left, b.left); right = Math.max(right, b.right);
      }
      if (Number.isFinite(top)) obs.push({ cls: 'staffLines@' + n, poly: rectPoly({ left, right, top, bottom }) });
    }
    for (const bl of sys.querySelectorAll('g.barLine')) for (const leaf of bl.querySelectorAll(LEAF_SEL)) for (const poly of leafPolys(leaf, inv)) obs.push({ cls: 'barLine', poly });
    /* Curves: sampled outline points (both edges of the filled path). */
    const curves = [];
    for (const p of sys.querySelectorAll('g.slur > path, g.tie > path')) {
      const ctm = p.getCTM(); if (!ctm) continue;
      const m = inv.multiply(ctm); let L; try { L = p.getTotalLength(); } catch { continue; }
      const N = Math.max(16, Math.ceil(L / 8)), pts = [];
      for (let i = 0; i <= N; i++) { const q = p.getPointAtLength(L * i / N); pts.push(xf(m, q.x, q.y)); }
      curves.push({ cls: p.parentElement.classList.contains('slur') ? 'slur' : 'tie', pts });
    }
    for (const o of obs) { const xs = o.poly.map((p) => p.x); o.l = Math.min(...xs); o.r = Math.max(...xs); }
    const marks = [...sys.querySelectorAll(MARK_SEL)].map((mk) => ({ mk, rects: markRects(mk, inv) }));

    for (const { mk, rects } of marks) {
      const measure = mk.closest('g.measure'); if (!measure) continue;
      const sN = parseInt(mk.getAttribute('data-staff') || '', 10);
      const cellBox = boxIn(mk, inv); if (!isInk(cellBox) || !rects.length) continue;
      const rows = [];
      for (const st of measure.children) {
        if (!st.classList || !st.classList.contains('staff')) continue;
        const n = parseInt(st.getAttribute('data-n') || '', 10);
        let top = Infinity, bottom = -Infinity;
        for (const p of st.children) { if (p.tagName !== 'path') continue; const b = boxIn(p, inv); if (!b || b.bottom - b.top > PAD) continue; top = Math.min(top, b.top); bottom = Math.max(bottom, b.bottom); }
        if (Number.isFinite(top)) rows.push({ n, top, bottom });
      }
      rows.sort((a, b) => a.top - b.top);
      const own = rows.find((x) => x.n === sN); if (!own) continue;
      const idx = rows.indexOf(own);
      const place = mk.getAttribute('data-place') || (mk.classList.contains('tempo') ? 'above'
        : ((cellBox.top + cellBox.bottom) / 2 > (own.top + own.bottom) / 2 ? 'below' : 'above'));
      let mode = 'mingap', gapUp = null, gapLo = null;
      if (place === 'below') {
        const lower = idx + 1 < rows.length ? rows[idx + 1] : null;
        if (lower && grandLowerOf.get(sN) === lower.n) { mode = 'center'; gapUp = own; gapLo = lower; }
      } else {
        const upper = idx > 0 ? rows[idx - 1] : null;
        if (upper && grandUpperOf.get(sN) === upper.n) { mode = 'center'; gapUp = upper; gapLo = own; }
      }
      /* Per obstacle: the deepest overlap with any ink rect of the mark (true
         x-overlap only), else the vertical gap on each side. */
      const hitBy = new Map();
      const hit = (cls, depth) => { if (depth > (hitBy.get(cls) || 0)) hitBy.set(cls, depth); };
      let above = Infinity, below = Infinity, aboveCls = '', belowCls = '';
      const mL = Math.min(...rects.map((b) => b.left)), mR = Math.max(...rects.map((b) => b.right));
      for (const o of obs) {
        if (o.r <= mL || o.l >= mR) continue;
        for (const R of rects) {
          const c = clipX(o.poly, R.left, R.right); if (c.length < 2) continue;
          let y0 = Infinity, y1 = -Infinity; for (const p of c) { if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
          if (y1 > R.top && y0 < R.bottom) hit(o.cls, Math.min(R.bottom - y0, y1 - R.top));
          else if (y1 <= R.top) { if (R.top - y1 < above) { above = R.top - y1; aboveCls = o.cls; } }
          else if (R.bottom <= y0) { if (y0 - R.bottom < below) { below = y0 - R.bottom; belowCls = o.cls; } }
        }
      }
      for (const cv of curves) for (const R of rects) for (const p of cv.pts) {
        if (p.x > R.left && p.x < R.right && p.y > R.top && p.y < R.bottom) hit(cv.cls, Math.min(p.y - R.top, R.bottom - p.y));
      }
      /* Other marks' ink — a stacked cluster may touch, never overlap. */
      for (const other of marks) {
        if (other.mk === mk) continue;
        for (const A of rects) for (const B of other.rects) {
          const w = Math.min(A.right, B.right) - Math.max(A.left, B.left), h = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
          if (w > 0 && h > 0) hit('mark:' + [...other.mk.classList][0] + ':' + (other.mk.textContent || '').trim().slice(0, 10), Math.min(w, h));
        }
      }
      /* The nearest approach, for near-miss review: the deepest sub-threshold
         overlap as a negative gap, else the smaller clearance. */
      const maxOv = Math.max(0, ...hitBy.values());
      const nearest = maxOv > 0 ? -maxOv : Math.min(above, below);
      const nearestCls = maxOv > 0 ? [...hitBy].find(([, d]) => d === maxOv)[0] : (above <= below ? aboveCls : belowCls);
      const hits = [...hitBy].filter(([, d]) => d > TOUCH).map(([cls, d]) => ({ cls, spaces: +(d / SPACE).toFixed(2) })).sort((a, b) => b.spaces - a.spaces);
      all.push({
        page: pi + 1, sysOnPage, sys: systemsSeen, measure: measureN.get(measure.id) ?? '?',
        cls: [...mk.classList][0], text: (mk.textContent || '').trim().slice(0, 12), id: mk.id,
        staff: sN, place, mode,
        cErr: mode === 'center' ? Math.round((cellBox.top + cellBox.bottom) / 2 - (gapUp.bottom + gapLo.top) / 2) : null,
        above: Number.isFinite(above) ? Math.round(above) : null,
        below: Number.isFinite(below) ? Math.round(below) : null,
        aboveCls, belowCls, hits,
        nearest: Number.isFinite(nearest) ? Math.round(nearest) : null, nearestCls,
        ish: Math.round(parseFloat(mk.getAttribute('data-hkl-ishift') || '0') || 0),
        vsh: Math.round(parseFloat(mk.getAttribute('data-hkl-vshift') || '0') || 0),
      });
    }
  }
}

/* A deviation: badly off-centre in a grand staff, or overlapping ink/lines. */
const OFF = 20;                                   // a quarter unit
const bad = (x) => (x.cErr !== null && Math.abs(x.cErr) >= OFF) || x.hits.length > 0;
const devs = all.filter(bad);
const centered = all.filter((x) => x.cErr !== null);
const collide = all.filter((x) => x.hits.length > 0);
const shifted = all.filter((x) => x.ish !== 0);
const q = (a) => { const v = a.slice().sort((x, y) => x - y); return v.length ? { min: v[0], p50: v[Math.floor(v.length / 2)], max: v[v.length - 1] } : null; };
const ONLY_HITS = numArg('hits', 0), ALL_ROWS = numArg('all', 0);

return {
  pages: pages.length, systems: systemsSeen, marks: all.length,
  summary: {
    centerMode: centered.length,
    centerOffBy20: centered.filter((x) => Math.abs(x.cErr) >= OFF).length,
    centerErr: q(centered.map((x) => Math.abs(x.cErr))),
    collisions: collide.length,
    onShiftedInstrument: shifted.length,
    shiftedAndCenterOff: shifted.filter((x) => x.cErr !== null && Math.abs(x.cErr) >= OFF).length,
    shiftedAndColliding: shifted.filter((x) => x.hits.length > 0).length,
    ishValues: [...new Set(shifted.map((x) => x.ish))].sort((a, b) => a - b),
    deviations: devs.length,
  },
  worstCenter: centered.slice().sort((a, b) => Math.abs(b.cErr) - Math.abs(a.cErr)).slice(0, 8),
  rows: WANT_ROWS ? (ONLY_PAGE || ALL_ROWS ? all : ONLY_HITS ? collide : devs).slice(FROM, FROM + LIMIT) : [],
  rowsTotal: ONLY_PAGE || ALL_ROWS ? all.length : ONLY_HITS ? collide.length : devs.length,
};
