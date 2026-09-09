// Inter-instrument clearance — a DOM post-process on rendered systems
// (2026-09-08, backlog Layout: "still not enough space between instruments on
// certain lines, ex. top system of page 16, where the mf dynamic on the viola
// part reads as part of the piano part").
//
// Verovio spaces two instruments by its `spacingStaff` floor and widens a
// collision-driven distance only by the colliding boxes plus their margins
// (`defaultBottomMargin`, one staff space). That is right relative to the
// staff a mark belongs to and wrong relative to the NEXT instrument: III m. 10
// stacks the viola's `mf` under its triplet numerals, 3.6 spaces below the
// viola, and the piano is then packed to one space below the mf. Census over
// the sonata (test/composer-inspect/phasec/cb-instrgap.js): of 151 marks at the
// viola/piano boundary, 59 sit NEARER the piano than their own staff and 33
// within one space of piano ink.
//
// The rule: shift the lower instrument down until every boundary mark is at
// least as close to its own staff as to its neighbour —
//   demand = max(0, min(dOwn, CAP) - dOther)
// where `dOwn` is the mark's distance to its own staff's near line and `dOther`
// its distance to the nearest ink or line of the other instrument within its
// horizontal range. CAP keeps a mark under a very low ledger note from
// demanding its whole distance. Both sides of a boundary count: an upper
// staff's below-marks AND a lower staff's above-marks (after the <offset>
// import fix the two can share a moment — sonata p. 21 m. 99). A bare INK
// FLOOR term keeps any cross-instrument ink pair a space apart, and a fourth
// term grants whatever clearance `textlayout` asked for and could not have —
// its INSTR_CLEAR clamp is what left p. 21 m. 94's "rit." on the piano's slur
// with "only more room between the instruments" as the remedy.
//
// WHY THE SHIFT IS A WHOLE DEVICE PIXEL: rule v2 quantizes each system's
// translate onto the device grid (pagefit.ts), so a fractional extent flips
// some systems by a whole pixel on re-placed pages while a fresh reference
// render does not — the splice gate's tolerance is exactly one pixel. The dir
// nudge in textlayout.ts hit this first; see its header.
//
// WHY IT DOES NOT WRITE THE STAFF TRANSFORM ALONE: `alignStaffRows`
// (pagefit.ts) rewrites every `g.staff` transform from the staff-line path text
// and is the FIRST thing `placePage` does, on the reference host too — a raw
// translate here would be destroyed before it was ever measured. So the shift
// is recorded as `data-hkl-ishift` and `alignStaffRows` ADDS it to its own
// phase correction. Because the shift is a whole grid multiple that correction
// is arithmetically unchanged, so the crispness invariant holds.
//
// WHAT MOVES: a `g.staff` carries its own notes, stems, beams and accidentals,
// so translating it moves the music with it. Everything else in a system is
// attributed explicitly — `data-staff` (dynam/dir/hairpin/tempo/octave),
// `data-startid` → the note's staff (slur/tie/fermata/trill/lv), or the
// instrument band the box sits in (grpSym, label). `mNum`, `ending` and
// `voltaBracket` ride the top staff and stay. A barline or bare path that
// CROSSES the boundary is lengthened rather than moved (the system's left line
// is one per system). An element that cannot be attributed leaves its system
// UNSHIFTED and says so — a silent guess here is a displaced glyph.
//
// Growing a system is the point, and placement consumes it: `measureExtents`
// derives `span` from the first measure's first and last staff transform and
// `above`/`below` from the system bbox, all AFTER this pass, because
// `postProcessRendered` precedes `placePage`. Every measurement is in the
// page-margin group's user space (`svgBox`), never screen rectangles.

import { svgBox, type Box } from './textlayout.js';

/* ── ALWAYS ON (2026-09-09) ──
   This pass was gated behind an `ENABLED` flag while a pagination defect was
   open: a grown system pushed the sonata's tail past the last page div and
   page 31 came back EMPTY, 442 of its 446 measures rendered, because page divs
   are Verovio's castoff at `loadData` and predate anything this pass grows
   (lessons.md "The page-div count is frozen at the initial castoff").
   Pagination is owned now — `cb-pagegrowth.js` reports paginationOwned with
   446/446 measures, 113 systems, 31 page divs, no empty pages and a 16-step
   cascade resolved entirely arithmetically — so the flag is gone and the pass
   is unconditional.

   Gated on the sonata (cb-instrgap.js, 2026-09-09): marks nearer the OTHER
   instrument than their own staff 59 -> 29, marks within one space of the
   other instrument's ink 33 -> 12, systems with unmet demand 48 -> 11; 43
   systems shifted, each one's system-start line lengthened, none bailing on an
   unattributable element.

   Still owed: no FIXTURE asserts that every measure of a multi-page document
   renders. `cb-pagegrowth.js` is a probe, not a gate. */

/** What the pass needs from the document. */
export interface InstrGapOpts {
  /** Each instrument's staff `@n`s, in score order (`InstrumentEntry.staffNs`). */
  instrStaffNs: ReadonlyArray<ReadonlyArray<number>>;
  /** The device grid, `1000 / scale`: every shift is a whole multiple. */
  grid: number;
  /** One Verovio unit in user units (80 at unit 8). */
  unitUser: number;
}

/* Half a unit — the pad textlayout uses for an x-range overlap test. */
const PAD = 40;
/* One staff space: the clearance a mark or ink keeps from another instrument
   (textlayout's INSTR_CLEAR, the same value for the same reason). */
const INSTR_CLEAR = 160;
/* A mark under a very low ledger note must not demand its whole distance. */
const CAP = 480;
/* Glyph-bearing groups of a staff that count as ink at a boundary. */
const OBSTACLE_SEL = 'g.note, g.rest, g.mRest, g.accid, g.beam, g.stem, g.clef, g.keySig, g.meterSig, g.tupletBracket, g.tupletNum, g.artic, g.dots, g.ledgerLines, g.flag';
/* Control events that name their staff outright. */
const STAFF_SEL = 'g.dynam, g.dir, g.hairpin, g.tempo, g.octave';
/* Control events attributed through their start note. */
const STARTID_SEL = 'g.slur, g.tie, g.fermata, g.trill, g.lv';
/* System decorations that ride the TOP staff and never move. */
const TOP_STAFF_SEL = 'g.mNum, g.ending, g.voltaBracket';
/* Vertical `M x y L x y2` path, the shape barlines.ts also parses. */
const LINE_RE = /^\s*M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*$/;

const attrNum = (el: Element, name: string): number | null => {
  const raw = el.getAttribute(name);
  if (raw === null) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
};
const translateOf = (el: Element): { tx: number; ty: number } => {
  const m = /translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/.exec(el.getAttribute('transform') ?? '');
  return m ? { tx: parseFloat(m[1]), ty: parseFloat(m[2]) } : { tx: 0, ty: 0 };
};
/** A box with real area. A zero-size `g.accid` (Verovio emits them) maps to the
 *  frame origin and reads as ink touching across the whole system — see
 *  lessons.md "Verovio emits zero-size `g.accid` groups". */
const isInk = (b: Box | null): b is Box => !!b && b.right > b.left && b.bottom > b.top;

/** A staff row's line band, in the frame's user space. */
interface Row { n: number; top: number; bottom: number }

export function layoutInstrumentGaps(root: Element, opts: InstrGapOpts): Set<Element> {
  const moved = new Set<Element>();
  if (opts.instrStaffNs.length < 2 || !(opts.grid > 0)) return moved;
  const systems = root.matches('g.system') ? [root] : Array.from(root.querySelectorAll('g.system'));
  for (const sys of systems) if (layoutSystem(sys, opts)) moved.add(sys);
  return moved;
}

function layoutSystem(sys: Element, opts: InstrGapOpts): boolean {
  const frame = sys.parentElement as (SVGGraphicsElement | null);
  const frameCtm = frame && typeof frame.getCTM === 'function' ? frame.getCTM() : null;
  if (!frameCtm) return false;                       // detached host: nothing to measure
  const frameInv = frameCtm.inverse();

  /* ── undo the previous run before measuring (idempotency) ── */
  resetSystem(sys);

  /* ── bands, from the FIRST measure's staves: the rows measureExtents reads ── */
  const firstMeasure = sys.querySelector('g.measure');
  if (!firstMeasure) return false;
  const rows = new Map<number, Row>();
  for (const st of Array.from(firstMeasure.children)) {
    if (!st.classList.contains('staff')) continue;
    const n = attrNum(st, 'data-n');
    if (n === null) continue;
    let top = Infinity, bottom = -Infinity;
    for (const path of Array.from(st.children)) {
      if (path.tagName !== 'path') continue;
      const b = svgBox(path as SVGGraphicsElement, frameInv);
      if (!b || b.bottom - b.top > PAD) continue;    // not a staff line
      top = Math.min(top, b.top); bottom = Math.max(bottom, b.bottom);
    }
    if (top < bottom || top === bottom) if (Number.isFinite(top)) rows.set(n, { n, top, bottom });
  }
  const bandOf = (staffNs: ReadonlyArray<number>): Row | null => {
    const rs = staffNs.map((n) => rows.get(n)).filter((r): r is Row => !!r);
    if (!rs.length) return null;
    return { n: staffNs[0], top: Math.min(...rs.map((r) => r.top)), bottom: Math.max(...rs.map((r) => r.bottom)) };
  };
  const bands = opts.instrStaffNs.map(bandOf);
  if (bands.some((b) => !b)) return false;           // an instrument has no staff here

  /* ── demand per boundary ── */
  const shiftOf = new Array<number>(opts.instrStaffNs.length).fill(0);
  let any = false;
  for (let k = 0; k + 1 < opts.instrStaffNs.length; k++) {
    const upper = bands[k]!, lower = bands[k + 1]!;
    const upperNs = opts.instrStaffNs[k], lowerNs = opts.instrStaffNs[k + 1];
    const upInk = inkOf(sys, upperNs, frameInv), loInk = inkOf(sys, lowerNs, frameInv);
    let demand = 0;

    for (const mk of Array.from(sys.querySelectorAll(STAFF_SEL)) as SVGGraphicsElement[]) {
      const sN = attrNum(mk, 'data-staff');
      if (sN === null) continue;
      const box = svgBox(mk, frameInv);
      if (!isInk(box)) continue;
      const place = mk.getAttribute('data-place') ?? (mk.classList.contains('tempo') ? 'above' : null);
      if (sN === upperNs[upperNs.length - 1] && place === 'below') {
        let near = lower.top;
        for (const b of loInk) if (b.top > box.bottom && overlapsX(b, box)) near = Math.min(near, b.top);
        demand = Math.max(demand, want(box.top - upper.bottom, near - box.bottom));
      } else if (sN === lowerNs[0] && place === 'above') {
        let near = upper.bottom;
        for (const b of upInk) if (b.bottom < box.top && overlapsX(b, box)) near = Math.max(near, b.bottom);
        demand = Math.max(demand, want(lower.top - box.bottom, box.top - near));
      }
      /* Whatever textlayout asked for and its INSTR_CLEAR clamp refused. */
      const unmet = attrNum(mk, 'data-hkl-clamped');
      if (unmet !== null && (sN === upperNs[upperNs.length - 1] || sN === lowerNs[0])) {
        demand = Math.max(demand, Math.abs(unmet));
      }
    }
    /* Bare ink floor: no cross-instrument ink pair closer than one space. */
    for (const a of upInk) for (const b of loInk) {
      if (!overlapsX(a, b)) continue;
      const gap = b.top - a.bottom;
      if (gap >= 0 && gap < INSTR_CLEAR) demand = Math.max(demand, INSTR_CLEAR - gap);
    }

    if (demand > 0) {
      /* UP to a whole device pixel: a fractional extent flips rule v2's
         per-system quantization by a pixel on re-placed pages. */
      const q = Math.ceil(demand / opts.grid) * opts.grid;
      for (let j = k + 1; j < shiftOf.length; j++) shiftOf[j] += q;
      any = true;
    }
  }
  if (!any) return false;

  /* ── apply ── */
  return applyShifts(sys, opts, rows, bands as Row[], shiftOf, frameInv);
}

const overlapsX = (a: Box, b: Box): boolean => !(a.right < b.left - PAD || a.left > b.right + PAD);
/** The clearance a mark wants: enough that it is no nearer the other
 *  instrument than its own staff, capped so a very distant mark does not
 *  demand its whole distance. */
const want = (dOwn: number, dOther: number): number => Math.max(0, Math.min(dOwn, CAP) - dOther);

/** Every ink box of an instrument's staves, across all measures of the system. */
function inkOf(sys: Element, staffNs: ReadonlyArray<number>, frameInv: DOMMatrix): Box[] {
  const out: Box[] = [];
  const want = new Set(staffNs);
  for (const st of Array.from(sys.querySelectorAll('g.staff'))) {
    const n = attrNum(st, 'data-n');
    if (n === null || !want.has(n)) continue;
    for (const o of Array.from(st.querySelectorAll(OBSTACLE_SEL))) {
      const b = svgBox(o as SVGGraphicsElement, frameInv);
      if (isInk(b)) out.push(b);
    }
  }
  return out;
}

/** Undo a previous run: the tags, and this pass's contribution to every
 *  transform — so the whole system is measured below in ONE frame, the raw
 *  pre-shift one. A STAFF's transform is rewritten by alignStaffRows from the
 *  path text, so its shift is subtracted rather than the transform dropped.
 *  A MARK's transform belongs to textlayout (which reruns right after and
 *  composes the tag) and reads `translate(dx, dy + prev)`, so the shift is
 *  subtracted there too, leaving the `dy` that `data-hkl-vshift` records.
 *  Dropping only the TAG and leaving `prev` baked in was measuring a shifted
 *  instrument's marks against unshifted bands: `dOwn` came out `prev` too
 *  large and `dOther` `prev` too small, so a re-run of the same music asked
 *  for less than the first run and the shift decayed (2026-09-09). */
function resetSystem(sys: Element): void {
  for (const el of Array.from(sys.querySelectorAll('[data-hkl-ishift]'))) {
    const prev = parseFloat(el.getAttribute('data-hkl-ishift') ?? '0') || 0;
    el.removeAttribute('data-hkl-ishift');
    if (el.classList.contains('staff')) {
      const { tx, ty } = translateOf(el);
      el.setAttribute('transform', `translate(${tx}, ${ty - prev})`);
    } else if (el.matches('g.dynam, g.dir, g.hairpin, g.tempo')) {
      /* textlayout owns the whole transform; only our term comes off. */
      if (prev) {
        const { tx, ty } = translateOf(el);
        el.setAttribute('transform', `translate(${tx}, ${ty - prev})`);
      }
    } else {
      el.removeAttribute('transform');
    }
  }
  for (const el of Array.from(sys.querySelectorAll('[data-hkl-igrow]'))) {
    const d = el.getAttribute('data-hkl-igrow');
    if (d !== null) el.setAttribute('d', d);
    el.removeAttribute('data-hkl-igrow');
  }
}

const clsOf = (el: Element): string => (el.getAttribute('class') ?? '').split(/\s+/)[0] || el.tagName;

/** The frame→element y scale, so a frame-space distance can be written into an
 *  element's own `d` (the nested `svg.definition-scale` viewBox means local
 *  user units are not frame user units). */
const yScaleOf = (el: SVGGraphicsElement, frameInv: DOMMatrix): number | null => {
  const ctm = typeof el.getCTM === 'function' ? el.getCTM() : null;
  if (!ctm) return null;
  const d = frameInv.multiply(ctm).d;
  return Number.isFinite(d) && Math.abs(d) > 1e-9 ? d : null;
};

function applyShifts(
  sys: Element, opts: InstrGapOpts, rows: Map<number, Row>, bands: Row[],
  shiftOf: number[], frameInv: DOMMatrix,
): boolean {
  const staffToInstr = new Map<number, number>();
  opts.instrStaffNs.forEach((ns, k) => ns.forEach((n) => staffToInstr.set(n, k)));

  const move: { el: Element; dy: number }[] = [];
  const grow: { el: SVGGraphicsElement; dy: number }[] = [];
  const unattributed: string[] = [];

  /* Which instrument a box belongs to by BAND, or null when ambiguous. A band
     is extended by one space on each side so a mark or brace hanging just off
     its staves still resolves; overlapping two extended bands is ambiguous. */
  const bandOf = (box: Box): number | null => {
    const hits: number[] = [];
    bands.forEach((b, k) => {
      if (box.bottom >= b.top - INSTR_CLEAR && box.top <= b.bottom + INSTR_CLEAR) hits.push(k);
    });
    return hits.length === 1 ? hits[0] : null;
  };
  /* …and by its start note, which works across a system break (a continuation
     segment's start note lives in the previous system, but the staff NUMBER is
     the same wherever the note sits). */
  const startIdInstr = (el: Element): number | null => {
    const raw = el.getAttribute('data-startid');
    if (!raw) return null;
    const note = el.ownerDocument?.getElementById(raw.replace(/^#/, ''));
    const staff = note?.closest('g.staff');
    const n = staff ? attrNum(staff, 'data-n') : null;
    return n === null ? null : (staffToInstr.get(n) ?? null);
  };

  /* ── staves ── */
  for (const st of Array.from(sys.querySelectorAll('g.staff'))) {
    const n = attrNum(st, 'data-n');
    const k = n === null ? undefined : staffToInstr.get(n);
    if (k === undefined) { unattributed.push(`staff data-n=${n}`); continue; }
    if (shiftOf[k]) move.push({ el: st, dy: shiftOf[k] });
  }
  /* ── control events that name their staff ── */
  for (const el of Array.from(sys.querySelectorAll(STAFF_SEL))) {
    const n = attrNum(el, 'data-staff');
    const k = n === null ? undefined : staffToInstr.get(n);
    if (k === undefined) { unattributed.push(`${clsOf(el)} data-staff=${n}`); continue; }
    if (shiftOf[k]) move.push({ el, dy: shiftOf[k] });
  }
  /* ── spanners: start note first, band as the fallback ── */
  for (const el of Array.from(sys.querySelectorAll(STARTID_SEL))) {
    let k = startIdInstr(el);
    if (k === null) {
      const b = svgBox(el as SVGGraphicsElement, frameInv);
      k = isInk(b) ? bandOf(b) : null;
    }
    if (k === null) { unattributed.push(`${clsOf(el)} (no start note, ambiguous band)`); continue; }
    if (shiftOf[k]) move.push({ el, dy: shiftOf[k] });
  }
  /* ── brace and instrument label: unambiguous by band (probed) ── */
  for (const el of Array.from(sys.querySelectorAll('g.grpSym, g.label'))) {
    const b = svgBox(el as SVGGraphicsElement, frameInv);
    const k = isInk(b) ? bandOf(b) : null;
    if (k === null) { unattributed.push(`${clsOf(el)} ambiguous band`); continue; }
    if (shiftOf[k]) move.push({ el, dy: shiftOf[k] });
  }
  /* ── barlines and bare system paths: translate within an instrument,
        LENGTHEN across a boundary (the system's left line is one per system) ── */
  const verticals: SVGGraphicsElement[] = [];
  for (const bl of Array.from(sys.querySelectorAll('g.barLine'))) {
    for (const path of Array.from(bl.children)) if (path.tagName === 'path') verticals.push(path as SVGGraphicsElement);
  }
  for (const path of Array.from(sys.children)) {
    if (path.tagName === 'path') verticals.push(path as SVGGraphicsElement);
  }
  for (const path of verticals) {
    const b = svgBox(path, frameInv);
    if (!b) continue;
    if (b.bottom - b.top < PAD) continue;                    // horizontal rule: nothing to do
    const spans = bands.map((bd, k) => ({ k, hit: b.bottom >= bd.top - PAD && b.top <= bd.bottom + PAD }))
      .filter((x) => x.hit).map((x) => x.k);
    if (spans.length === 1) {
      if (shiftOf[spans[0]]) move.push({ el: path, dy: shiftOf[spans[0]] });
    } else if (spans.length > 1) {
      const dy = shiftOf[spans[spans.length - 1]];
      if (dy) grow.push({ el: path, dy });
    }
    /* spans.length === 0: a path in the gap belonging to neither — left alone. */
  }

  if (unattributed.length) {
    /* A silent guess here is a displaced glyph, so the system keeps Verovio's
       spacing and says why. resetSystem already left it clean. */
    console.warn('[instrgap] system left unshifted — unattributed: '
      + unattributed.slice(0, 6).join('; ') + (unattributed.length > 6 ? ` (+${unattributed.length - 6})` : ''));
    return false;
  }

  for (const { el, dy } of move) {
    if (el.matches('g.dynam, g.dir, g.hairpin, g.tempo')) {
      /* textlayout owns a mark's transform and reruns right after this pass;
         it reads the tag and writes translate(dx, ishift + dy). */
      el.setAttribute('data-hkl-ishift', String(dy));
      continue;
    }
    const { tx, ty } = translateOf(el);
    el.setAttribute('transform', `translate(${tx}, ${ty + dy})`);
    el.setAttribute('data-hkl-ishift', String(dy));
  }
  for (const { el, dy } of grow) {
    const d = el.getAttribute('d');
    const m = d ? LINE_RE.exec(d) : null;
    const sc = yScaleOf(el, frameInv);
    if (!d || !m || sc === null) continue;
    const [x1, y1, x2, y2] = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])];
    const local = dy / sc;
    const lower = y2 >= y1 ? 4 : 2;                          // extend the LOWER end
    const ny1 = lower === 2 ? y1 + local : y1;
    const ny2 = lower === 4 ? y2 + local : y2;
    el.setAttribute('data-hkl-igrow', d);                    // for idempotency
    el.setAttribute('d', `M${x1} ${ny1} L${x2} ${ny2}`);
  }
  return true;
}
