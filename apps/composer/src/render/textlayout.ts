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
//     as the dynamics are — Verovio's `dynamDist` governs <dynam> only — and a
//     hairpin standing alone is put ON the dynamics' line, up or down (Max,
//     2026-09-05: sonata mm. 49–52, the crescendo sat 15 px below the `f`
//     that follows it and the decrescendo 16 px above the `p`, because Verovio
//     hugs a lone hairpin to the staff — probed: its top 0.3 space below the
//     bottom line at any dynamDist — and aligns it to a neighbouring dynamic
//     only sometimes). A cluster that holds a DYNAMIC is left where Verovio put
//     it: dynamDist is the dynamic's baseline, and Verovio already aligned any
//     hairpin or text touching it to that dynamic. A push DOWN stops
//     INSTR_CLEAR (one staff space) short of the next instrument's line and
//     ink — half a unit, the grand-staff pad, put p. 21's "dim." 0.45 space
//     above the piano (2026-09-06).
// Marks whose horizontal ranges overlap (a dynamic with its hairpin, a stacked
// dynamic + text) move as ONE block so Verovio's own stacking survives.
//   • SAME-MOMENT text is laid out side by side instead (2026-09-08, backlog
//     Layout: "beat-level positioning of text is not being preserved from
//     Finale import, leading to vertical overlap of elements that should be
//     horizontally adjacent", sonata p. 21 m. 99). Verovio draws two marks
//     sharing an anchor at one x and stacks them vertically; the block rule
//     above would then preserve that stack forever. Finale had separated them
//     with a `default-x`/`relative-x` nudge the importer deliberately drops
//     (correct placement relative to each other, not Finale replication), so
//     the separation is derived: the DYNAMIC keeps its place — it anchors the
//     cluster — and the <dir>s follow to its right, centred on its line.
//     `data-tstamp` gates it, so only a genuinely identical anchor qualifies
//     and two marks a beat apart whose boxes merely touch stay stacked. A run
//     that would cross the measure's barline or reach the next cluster is
//     abandoned: with no room, Verovio's stack is the honest answer. The
//     sonata has exactly three such groups, each a dynamic plus one word.
//     SINCE 2026-09-09 THIS RULE IS THE FALLBACK. Separating the pair in the
//     DOM leaves the inter-staff row Verovio reserved for the STACK, and no
//     DOM move gives that space back — the sonata's m. 99 kept a piano gap of
//     13.25 staff spaces where 7.75 does (Max: "far too much vertical space
//     within the grand staff"). `notation/unstack.ts` now nudges each mover's
//     tstamp on the RENDER CLONE instead, so Verovio engraves one row and
//     sizes the gap for one row; that pass owns the separation, this rule
//     keeps only the groups it had no room to separate. What stays here either
//     way is the CLEARANCE (`UNSTACK_GAP`, one staff space): x is not knowable
//     before the engrave, so the mover names its anchor in
//     `data-hkl-unstack` and the horizontal phase below sets the gap exactly.
//   • A TEXT mark (dynamic, expressive text — not a hairpin) is also kept
//     INSIDE its own measure: a box that overlaps one of the measure's barlines
//     is moved off it to the near side, half a unit clear (Max, 2026-09-05:
//     nothing sits on a measure boundary). Verovio centres a dynamic at
//     tstamp beats+1 exactly on the barline, and a wide dynamic under a
//     measure's first note reaches back over the previous one; both read as
//     "on the boundary", and inside a grand staff the barline runs through
//     them (Verovio erases the barline there — render/barlines.ts refills it).
//     The horizontal move comes first, so the vertical rules below cluster and
//     measure the marks where they will actually be drawn.
//   • ABOVE a staff, text (expressive text, a dynamic, a tempo) clears the
//     slurs and ties of its own staff (2026-09-06, backlog Layout: sonata
//     p. 21 m. 94, the piano's "rit." sat on the right hand's slur). Verovio's
//     floating positioners avoid the staff's notes but not its curves — a slur
//     arching over a high run passes through the text. Every curve whose
//     sampled outline dips below the mark's top (so it is anchored at the
//     mark's staff or lower — a curve wholly above the mark belongs to the
//     staff above) and whose top, within the mark's horizontal range, reaches
//     the mark's box moves the mark up until the box clears it by half a
//     unit; marks stacked above it move with it. The move stops a pad short of
//     the staff above and its content (INSTR_CLEAR across instruments).
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
// It never changes a system's EXTENTS except in two cases: a centred mark
// stays inside the gap between its two staves, but a nudged <dir> under the
// last staff grows the system, and a mark lifted over a slur above the FIRST
// staff grows it upward — which is why this runs before placement measures
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

export interface Box { left: number; right: number; top: number; bottom: number }
interface Row extends Box { n: number; el: Element }
interface Mark { el: SVGGraphicsElement; box: Box; upper: Row; lower: Row | null; mode: 'center' | 'mingap' }

const MARK_SEL = 'g.dynam, g.dir, g.hairpin';
/* Text marks placed above a staff: the slur-clearance rule's subjects. A
   <tempo> without @place is above (MEI's default; model.setTempo writes none). */
const ABOVE_SEL = 'g.dir[data-place="above"], g.dynam[data-place="above"], g.tempo:not([data-place="below"])';
const CURVE_SEL = 'g.slur > path, g.tie > path';
/* Glyph-bearing groups of a staff that a moving mark must not run into. */
const OBSTACLE_SEL = 'g.note, g.rest, g.mRest, g.accid, g.beam, g.stem, g.clef, g.keySig, g.meterSig, g.tupletBracket, g.tupletNum, g.artic, g.dots, g.ledgerLines, g.flag';
/* Half a Verovio unit at the crisp presets (unit 8 → 80 user units per unit). */
const PAD = 40;
/* One staff space: the clearance kept from ANOTHER instrument's line and ink
   when a mark is pushed toward it. */
const INSTR_CLEAR = 160;
/* A device pixel: a mark this close to a barline counts as touching it. */
const TOUCH = 10;
/* The clearance kept between a dynamic and a same-moment word laid out beside
   it — one staff space. Was PAD (half a unit, a quarter space), which read as
   touching: Max, 2026-09-09, on the sonata's m. 99 `p dim.`, where the pair
   sat 40 user units = 4 px apart at scale 100. */
const UNSTACK_GAP = 160;
/* How far a hairpin's top sits ABOVE the dynamics' clearance line when it is
   put on the dynamics' line: Verovio's own hairpin-to-dynamic alignment (probed
   at unit 8 with a dynamic and a hairpin at one moment: hairpin top 2 px above
   the dynamic's top) — a quarter unit. */
const HAIRPIN_LIFT = 20;
/* Samples along a slur's outline (both edges — the path is closed). */
const CURVE_SAMPLES = 48;
const isText = (el: Element): boolean => el.classList.contains('dynam') || el.classList.contains('dir');

const attrNum = (el: Element, name: string): number | null => {
  const v = el.getAttribute(name);
  if (v === null) return null;
  const n = parseInt(v.trim().split(/\s+/)[0], 10);
  return Number.isFinite(n) ? n : null;
};

/** The inter-instrument shift already GRANTED to this mark's instrument by
 *  render/instrgap.ts, which tags the amount and leaves the transform to this
 *  pass (it owns a mark's transform). A tag is not a transform, so `svgBox`
 *  reads a tagged mark at its PRE-shift position while its staff rows — real
 *  transforms, written by instrgap and re-applied by pagefit's alignStaffRows
 *  — read POST-shift. Every box of a tagged mark is therefore taken in the
 *  post-shift frame (`markBox`), which is the frame the write at the end
 *  composes in: a `dy` derived from a raw box already contains the shift, and
 *  `translate(dx, dy + ish)` would then apply it TWICE (Max, 2026-09-09:
 *  sonata p. 9 m. 131's `pp` and p. 17 m. 37's `dim.` sat a whole shift low —
 *  on the staff and the tuplet bracket below — with the room they had asked
 *  for lying unused above them).
 *  parseFloat, not parseInt: at zoom 75 the device grid is 40/3 user units, so
 *  the shift is fractional, and alignStaffRows reads the same tag as a float —
 *  truncating here would desync a mark from its own staff by up to a unit. */
const ishOf = (el: Element): number => parseFloat(el.getAttribute('data-hkl-ishift') ?? '0') || 0;

/** An element's bbox in a shared reference frame — the coordinate system of
 *  `frame` (the system's parent: the page-margin group, or the splice host's
 *  equivalent). `getCTM()` maps to the nearest viewport, and for everything
 *  inside Verovio's nested `svg.definition-scale` that includes the viewBox
 *  scale (user units × 0.1 at scale 100); composing with the frame's inverse
 *  CTM cancels it, so the result is in the frame's USER units — the units the
 *  mark's `translate` is written in — and independent of where the host sits
 *  on screen. Verovio's transforms are translates and uniform scales, so
 *  mapping the two corners is exact. Null when the element has no box. */
export function svgBox(el: Element, frameInv: DOMMatrix): Box | null {
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

/** A curve's outline sampled into the reference frame, or null when the path
 *  cannot be measured. */
function curvePoints(path: Element, frameInv: DOMMatrix): Array<{ x: number; y: number }> | null {
  const p = path as SVGGeometryElement;
  if (typeof p.getTotalLength !== 'function' || typeof p.getPointAtLength !== 'function' || typeof p.getCTM !== 'function') return null;
  const own = p.getCTM();
  if (!own) return null;
  let L: number;
  try { L = p.getTotalLength(); } catch { return null; }
  if (!(L > 0)) return null;
  const m = frameInv.multiply(own);
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= CURVE_SAMPLES; i++) {
    const q = p.getPointAtLength(L * i / CURVE_SAMPLES);
    out.push({ x: m.a * q.x + m.c * q.y + m.e, y: m.b * q.x + m.d * q.y + m.f });
  }
  return out;
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

const shiftBox = (b: Box, dx: number, dy: number): Box => ({ left: b.left + dx, right: b.right + dx, top: b.top + dy, bottom: b.bottom + dy });

/** Lay out the below-staff marks of every system under `root` (or of `root`
 *  itself when it is a system). */
export function layoutBelowStaffText(root: Element, opts: TextLayoutOpts): void {
  const systems = root.matches('g.system') ? [root] : Array.from(root.querySelectorAll('g.system'));
  for (const sys of systems) layoutSystem(sys, opts);
}

function layoutSystem(sys: Element, opts: TextLayoutOpts): void {
  const marks = Array.from(sys.querySelectorAll(MARK_SEL + ', ' + ABOVE_SEL)) as SVGGraphicsElement[];
  if (!marks.length) return;
  /* Undo a previous run's shifts before measuring (idempotency). */
  for (const m of marks) {
    m.removeAttribute('data-hkl-clamped');
    if (!m.hasAttribute('data-hkl-vshift') && !m.hasAttribute('data-hkl-hshift')) continue;
    m.removeAttribute('transform'); m.removeAttribute('data-hkl-vshift'); m.removeAttribute('data-hkl-hshift');
  }
  /* The reference frame: the system's parent (the page-margin group). */
  const frame = sys.parentElement as (SVGGraphicsElement | null);
  const frameCtm = frame && typeof frame.getCTM === 'function' ? frame.getCTM() : null;
  if (!frameCtm) return;
  const frameInv = frameCtm.inverse();
  /* A mark's box in the frame its transform is written in — see `ishOf`. */
  const markBox = (el: Element): Box | null => {
    const b = svgBox(el, frameInv);
    const ish = b ? ishOf(el) : 0;
    return b && ish ? { ...b, top: b.top + ish, bottom: b.bottom + ish } : b;
  };
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
  /* The barlines bounding a measure: its right barline (the rightmost of its
     own `g.barLine` groups) and its left one — a left barLine group when
     Verovio drew one (repeat starts), else the previous measure's right
     barline; none for a system's first measure (the system start is no
     boundary a mark could straddle). */
  interface Bars { left: Box | null; right: Box | null }
  const barCache = new Map<Element, Bars>();
  const barsFor = (measure: Element): Bars => {
    let r = barCache.get(measure);
    if (r) return r;
    const boxes: Box[] = [];
    for (const g of Array.from(measure.children)) {
      if (!g.classList.contains('barLine')) continue;
      const b = svgBox(g, frameInv);
      if (b) boxes.push(b);
    }
    boxes.sort((a, b) => a.left - b.left);
    const right = boxes.length ? boxes[boxes.length - 1] : null;
    let left: Box | null = boxes.length >= 2 ? boxes[0] : null;
    if (!left) {
      const prev = measure.previousElementSibling;
      if (prev && prev.classList.contains('measure')) left = barsFor(prev).right;
    }
    r = { left, right };
    barCache.set(measure, r);
    return r;
  };
  const hshift = new Map<SVGGraphicsElement, number>();
  const shifted = new Map<SVGGraphicsElement, Box>();

  /* ── the clearance notation/unstack.ts could not set ──
     That pass nudges a same-moment `<dir>` past its dynamic anchor on the
     RENDER CLONE, so Verovio engraves the group as one row and sizes the
     inter-staff gap for one row (a DOM move cannot give that space back — see
     its header). What it cannot do is know x before the engrave, so Verovio's
     own spacing of the separated pair stands until here. Each mover names its
     anchor in `data-hkl-unstack` — the pair no longer shares a tstamp, which
     is what the fallback rule below keys on. Runs BEFORE the barline nudge so
     that rule still has the last horizontal word. */
  const byId = new Map<string, SVGGraphicsElement>();
  for (const el of marks) if (el.id) byId.set(el.id, el);
  const followers = new Map<SVGGraphicsElement, SVGGraphicsElement[]>();
  for (const el of marks) {
    const anchorId = el.getAttribute('data-hkl-unstack');
    if (!anchorId) continue;
    const anchor = byId.get(anchorId);
    if (!anchor) continue;                     // anchor engraved in another system
    (followers.get(anchor) ?? followers.set(anchor, []).get(anchor)!).push(el);
  }
  for (const [anchor, group] of followers) {
    const ab = markBox(anchor);
    if (!ab || !(ab.right > ab.left)) continue;
    const rows = group
      .map((el) => ({ el, box: markBox(el) }))
      .filter((x): x is { el: SVGGraphicsElement; box: Box } => !!x.box && x.box.right > x.box.left)
      .sort((a, b) => a.box.left - b.box.left);
    let run = ab.right;
    for (const { el, box } of rows) {
      const measure = el.closest('g.measure');
      const bars = measure ? barsFor(measure) : null;
      let dx = Math.round((run + UNSTACK_GAP) - box.left);
      if (Math.abs(dx) < 3) dx = 0;
      /* Honouring the gap must not put the mark on the measure's barline —
         the rule the loop below enforces. Verovio's x stands instead. */
      if (dx && bars?.right && box.right + dx > bars.right.left - PAD) dx = 0;
      if (dx) {
        hshift.set(el, (hshift.get(el) ?? 0) + dx);
        shifted.set(el, { ...box, left: box.left + dx, right: box.right + dx });
      }
      run = box.right + dx;
    }
  }

  /* Horizontal: text marks off their measure's barlines. */
  for (const el of marks) {
    if (!isText(el)) continue;
    const measure = el.closest('g.measure');
    if (!measure) continue;
    const box = shifted.get(el) ?? markBox(el);
    if (!box || !(box.right > box.left)) continue;
    const { left, right } = barsFor(measure);
    let dx = 0;
    if (right && box.right > right.left - TOUCH && box.left < right.right + TOUCH) dx = (right.left - PAD) - box.right;
    else if (left && box.left < left.right + TOUCH && box.right > left.left - TOUCH) dx = (left.right + PAD) - box.left;
    dx = Math.round(dx);
    if (Math.abs(dx) < 3) continue;
    /* A mark wider than its measure stays where Verovio put it. */
    if (left && box.left + dx < left.right + PAD / 2) continue;
    if (right && box.right + dx > right.left - PAD / 2) continue;
    hshift.set(el, (hshift.get(el) ?? 0) + dx);
    shifted.set(el, { ...box, left: box.left + dx, right: box.right + dx });
  }

  const items: Mark[] = [];
  for (const el of marks) {
    if (!el.matches(MARK_SEL)) continue;
    const measure = el.closest('g.measure');
    if (!measure) continue;
    const staffN = attrNum(el, 'data-staff');
    if (staffN === null) continue;
    const rows = rowsFor(measure);
    const own = rows.find((r) => r.n === staffN);
    if (!own) continue;
    const box = shifted.get(el) ?? markBox(el);
    if (!box || !(box.right > box.left) || !(box.bottom > box.top)) continue;
    const place = el.getAttribute('data-place') ?? ((box.top + box.bottom) / 2 > (own.top + own.bottom) / 2 ? 'below' : 'above');
    const idx = rows.indexOf(own);
    if (place === 'below') {
      const lower = idx + 1 < rows.length ? rows[idx + 1] : null;
      if (lower && grandLowerOf.get(staffN) === lower.n) items.push({ el, box, upper: own, lower, mode: 'center' });
      else items.push({ el, box, upper: own, lower, mode: 'mingap' });   // dynam / dir / hairpin — see the cluster rule
    } else if (place === 'above') {
      const upper = idx > 0 ? rows[idx - 1] : null;
      if (upper && grandUpperOf.get(staffN) === upper.n) items.push({ el, box, upper, lower: own, mode: 'center' });
    }
  }
  const shifts = new Map<SVGGraphicsElement, { dx: number; dy: number }>();
  for (const [el, dx] of hshift) shifts.set(el, { dx, dy: 0 });

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

  /* ── same-moment text: side by side, not stacked ──
     Two marks sharing an anchor are drawn by Verovio at ONE x and stacked
     vertically, and the cluster rule above then preserves that stack verbatim
     (a dynamic-bearing cluster is left exactly where Verovio put it). Finale
     separated them with a `default-x`/`relative-x` nudge the importer
     deliberately drops — correct placement relative to each other, not Finale
     replication — so the separation is DERIVED here: the dynamic keeps its
     place (it anchors the cluster) and the <dir>s follow to its right, on its
     line. `data-tstamp` is what makes this safe: only a genuinely identical
     anchor qualifies, never merely overlapping boxes, so two marks a beat
     apart that happen to touch stay stacked. A run that would cross the
     measure's barline or reach the next cluster is abandoned — Verovio's stack
     is the honest fallback when there is no room (sonata p. 21 m. 99 is 259
     tenths wide holding one dotted-half chord).
     Boxes are adjusted IN PLACE so the vertical phases below measure the
     un-stacked cluster, and the writes compose (Phase C accumulates). */
  const anchorOf = (el: Element): string | null => el.getAttribute('data-tstamp');
  for (const cl of clusters) {
    if (cl.length < 2) continue;
    const anchorMark = cl.find((m) => m.el.classList.contains('dynam'));
    if (!anchorMark) continue;
    const at = anchorOf(anchorMark.el);
    if (at === null) continue;
    const movers = cl.filter((m) => m !== anchorMark
      && m.el.classList.contains('dir') && anchorOf(m.el) === at);
    if (!movers.length) continue;
    const anch = anchorMark.box;
    /* Only when Verovio actually stacked them — a mover clear of the anchor's
       vertical band. Marks already side by side need nothing. */
    if (!movers.every((m) => m.box.top >= anch.bottom - PAD || m.box.bottom <= anch.top + PAD)) continue;
    const measure = anchorMark.el.closest('g.measure');
    const bars = measure ? barsFor(measure) : null;
    let limit = bars && bars.right ? bars.right.left - PAD : Infinity;
    for (const other of clusters) {
      if (other === cl || key(other[0]) !== key(cl[0])) continue;
      for (const o of other) if (o.box.left > anch.right) limit = Math.min(limit, o.box.left - PAD);
    }
    let run = anch.right;
    for (const m of cl) if (!movers.includes(m)) run = Math.max(run, m.box.right);
    const plan: { m: Mark; dx: number; dy: number }[] = [];
    let room = true;
    for (const m of movers.slice().sort((a, b) => a.box.left - b.box.left)) {
      const dx = Math.round((run + UNSTACK_GAP) - m.box.left);
      const dy = Math.round((anch.top + anch.bottom) / 2 - (m.box.top + m.box.bottom) / 2);
      if (m.box.right + dx > limit) { room = false; break; }
      plan.push({ m, dx, dy });
      run = m.box.right + dx;
    }
    if (!room) continue;
    for (const { m, dx, dy } of plan) {
      m.box = { left: m.box.left + dx, right: m.box.right + dx, top: m.box.top + dy, bottom: m.box.bottom + dy };
      const sh = shifts.get(m.el);
      if (sh) { sh.dx += dx; sh.dy += dy; } else shifts.set(m.el, { dx, dy });
    }
  }

  /* Obstacles: glyph groups of a staff row overlapping an x-range, plus marks
     attached to that staff on the gap side — never the moving cluster's own
     marks (a place-below hairpin moving UP toward its staff met itself here
     and stayed put: sonata m. 49, 2026-09-05). */
  const obstacleBoxes = (row: Row, left: number, right: number, side: 'above' | 'below', moving: ReadonlySet<Element>): Box[] => {
    const out: Box[] = [];
    const rowEls = Array.from(sys.querySelectorAll('g.staff')).filter((s) => attrNum(s, 'data-n') === row.n);
    for (const s of rowEls) {
      for (const g of Array.from(s.querySelectorAll(OBSTACLE_SEL))) {
        const b = svgBox(g, frameInv);
        if (!b || b.right < left - PAD || b.left > right + PAD || !(b.right > b.left)) continue;
        out.push(b);
      }
    }
    for (const g of Array.from(sys.querySelectorAll(MARK_SEL + ', ' + ABOVE_SEL))) {
      if (moving.has(g)) continue;
      if (attrNum(g, 'data-staff') !== row.n || (g.getAttribute('data-place') ?? (g.classList.contains('tempo') ? 'above' : '')) !== side) continue;
      const b = markBox(g);
      if (!b || b.right < left - PAD || b.left > right + PAD || !(b.right > b.left)) continue;
      out.push(b);
    }
    return out;
  };

  for (const cl of clusters) {
    let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
    for (const m of cl) { top = Math.min(top, m.box.top); bottom = Math.max(bottom, m.box.bottom); left = Math.min(left, m.box.left); right = Math.max(right, m.box.right); }
    const { upper, lower, mode } = cl[0];
    const moving = new Set<Element>(cl.map((m) => m.el));
    let dy: number;
    if (mode === 'center') {
      if (!lower) continue;
      dy = (upper.bottom + lower.top) / 2 - (top + bottom) / 2;
    } else {
      /* A dynamic anchors its cluster: Verovio's placement stands. */
      if (cl.some((m) => m.el.classList.contains('dynam'))) continue;
      const line = upper.bottom + opts.dirGapUser;
      /* Text is pushed DOWN to the dynamics' clearance, never up (Verovio's
         floor is right when it is lower); hairpins alone go to the line. */
      dy = cl.some((m) => m.el.classList.contains('dir')) ? Math.max(0, line - top) : (line - HAIRPIN_LIFT) - top;
    }
    if (dy > 0) {
      /* Moving down: stay above the lower staff's line and its content — by
         the grand-staff pad inside an instrument, by a full space toward
         another instrument (in 'mingap' the lower row is always another
         instrument's; grand pairs centre). */
      const clear = mode === 'mingap' ? INSTR_CLEAR : PAD;
      let limit = lower ? lower.top - clear : Infinity;
      if (lower) for (const b of obstacleBoxes(lower, left, right, 'above', moving)) limit = Math.min(limit, b.top - clear);
      const wanted = dy;
      dy = Math.min(dy, limit - bottom);
      if (dy < 0) dy = 0;
      /* What the clearance to the NEXT INSTRUMENT refused. render/instrgap.ts
         grants it by moving that instrument, and this pass then reruns with the
         room (only a 'mingap' lower row is another instrument's — grand pairs
         centre, and their pad is not a shortage worth widening a system for). */
      if (mode === 'mingap' && wanted - dy >= 1) {
        for (const m of cl) m.el.setAttribute('data-hkl-clamped', String(Math.round(wanted - dy)));
      }
    } else if (dy < 0) {
      /* Moving up: stay below the upper staff's line and its content. */
      let limit = upper.bottom + PAD;
      for (const b of obstacleBoxes(upper, left, right, 'below', moving)) limit = Math.max(limit, b.bottom + PAD);
      dy = Math.max(dy, limit - top);
      if (dy > 0) dy = 0;
    }
    /* Whole user units: the same music must yield the same shift on every
       host, and a float tail here would be a float tail in the extents. */
    dy = Math.round(dy);
    if (Math.abs(dy) < 3) continue;                     // under a third of a device pixel: leave it
    for (const m of cl) {
      const s = shifts.get(m.el);
      /* ADD, not assign: the same-moment un-stack above may already have put a
         dy on a mover, and a centred cluster must carry it along. (Before that
         rule existed every dy here was the first, so this is equivalent for
         every other cluster.) */
      if (s) s.dy += dy; else shifts.set(m.el, { dx: 0, dy });
    }
  }

  /* ── above-staff text vs the staff's slurs and ties ── */
  interface Above { el: SVGGraphicsElement; box: Box; staffN: number; rows: Row[]; own: Row }
  const aboves: Above[] = [];
  for (const el of marks) {
    if (!el.matches(ABOVE_SEL)) continue;
    const measure = el.closest('g.measure');
    if (!measure) continue;
    const staffN = attrNum(el, 'data-staff');
    if (staffN === null) continue;
    const rows = rowsFor(measure);
    const own = rows.find((r) => r.n === staffN);
    if (!own) continue;
    const raw = shifted.get(el) ?? markBox(el);
    if (!raw || !(raw.right > raw.left) || !(raw.bottom > raw.top)) continue;
    const s = shifts.get(el);
    const box = s ? shiftBox(raw, 0, s.dy) : raw;          // `shifted` already carries dx
    aboves.push({ el, box, staffN, rows, own });
  }
  if (aboves.length) {
    const curves: Array<Array<{ x: number; y: number }>> = [];
    for (const p of Array.from(sys.querySelectorAll(CURVE_SEL))) {
      const pts = curvePoints(p, frameInv);
      if (pts) curves.push(pts);
    }
    const need = new Map<Above, number>();
    if (curves.length) {
      for (const a of aboves) {
        let dy = 0;
        for (const pts of curves) {
          let maxY = -Infinity, topInRange = Infinity;
          for (const q of pts) {
            maxY = Math.max(maxY, q.y);
            if (q.x >= a.box.left - PAD && q.x <= a.box.right + PAD) topInRange = Math.min(topInRange, q.y);
          }
          if (!(maxY > a.box.top) || topInRange === Infinity) continue;      // wholly above the mark, or out of its range
          if (topInRange >= a.box.bottom + PAD) continue;                     // clear below it already
          dy = Math.min(dy, (topInRange - PAD) - a.box.bottom);
        }
        if (dy < 0) need.set(a, dy);
      }
    }
    /* Marks stacked above a lifted mark (same staff, x-overlap, box above it)
       rise with it. Chains settle in a few passes. */
    for (let pass = 0; pass < 4 && need.size; pass++) {
      let changed = false;
      for (const [a, dy] of Array.from(need)) {
        for (const b of aboves) {
          if (b === a || b.staffN !== a.staffN) continue;
          if (b.box.right < a.box.left - PAD || b.box.left > a.box.right + PAD) continue;
          if (!(b.box.bottom <= a.box.top + PAD && b.box.top < a.box.top)) continue;
          const cur = need.get(b) ?? 0;
          if (dy < cur) { need.set(b, dy); changed = true; }
        }
      }
      if (!changed) break;
    }
    const moving = new Set<Element>(Array.from(need.keys()).map((a) => a.el));
    for (const [a, want] of need) {
      let dy = want;
      const idx = a.rows.indexOf(a.own);
      const upper = idx > 0 ? a.rows[idx - 1] : null;
      if (upper) {
        const acrossInstruments = grandUpperOf.get(a.staffN) !== upper.n;
        const clear = acrossInstruments ? INSTR_CLEAR : PAD;
        let limit = upper.bottom + clear;
        for (const b of obstacleBoxes(upper, a.box.left, a.box.right, 'below', moving)) limit = Math.max(limit, b.bottom + clear);
        dy = Math.max(dy, limit - a.box.top);
        if (dy > 0) dy = 0;
        /* The slur-clearance lift this instrument boundary refused — sonata
           p. 21 m. 94's "rit." stopped one space under the viola with the
           slur still inside its box, and only more room can finish it. */
        if (acrossInstruments && want - dy <= -1) {
          a.el.setAttribute('data-hkl-clamped', String(Math.round(dy - want)));
        }
      }
      dy = Math.round(dy);
      if (Math.abs(dy) < 3) continue;
      const s = shifts.get(a.el);
      if (s) s.dy += dy; else shifts.set(a.el, { dx: 0, dy });
    }
  }

  /* ── an un-stacked mover shares its anchor's line ──
     notation/unstack.ts separates the pair BEFORE the engrave, so they are no
     longer one cluster and every vertical rule above reached them
     independently: the dynamic keeps Verovio's `dynamDist` while a now-lone
     <dir> is pushed to the `dirGapUser` line, and those two lines do not
     coincide — the glyph and the text have different box metrics (fixture
     engr_sameMomentDynamAndDirSideBySide: 7.4 px apart, not even overlapping).
     Aligning the centres is what the cluster rule did when it owned the
     separation, so it is kept here, last, over whatever the rules settled. */
  const finalCentre = (el: SVGGraphicsElement): number | null => {
    const b = markBox(el);
    return b ? (b.top + b.bottom) / 2 + (shifts.get(el)?.dy ?? 0) : null;
  };
  for (const [anchor, group] of followers) {
    const ac = finalCentre(anchor);
    if (ac === null) continue;
    for (const el of group) {
      const mc = finalCentre(el);
      if (mc === null) continue;
      const dy = Math.round(ac - mc);
      if (Math.abs(dy) < 3) continue;
      const s = shifts.get(el);
      if (s) s.dy += dy; else shifts.set(el, { dx: 0, dy });
    }
  }

  /* ── writes ── */
  /* A mark whose instrument moved but which needs no shift of its own is not
     in the map yet; it still has to receive the instrument's translate. */
  for (const m of marks) {
    if (m.hasAttribute('data-hkl-ishift') && !shifts.has(m)) shifts.set(m, { dx: 0, dy: 0 });
  }
  for (const [el, { dx, dy }] of shifts) {
    /* render/instrgap.ts moved this mark's whole instrument; it tags the amount
       and leaves the transform to this pass, which owns it. */
    const ish = ishOf(el);
    if (!dx && !dy && !ish) continue;
    el.setAttribute('transform', `translate(${dx}, ${dy + ish})`);
    if (dy) el.setAttribute('data-hkl-vshift', String(dy));
    if (dx) el.setAttribute('data-hkl-hshift', String(dx));
  }
}
