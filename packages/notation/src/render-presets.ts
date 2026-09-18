// Crisp-rendering presets shared by every Verovio render surface (HKL Composer's
// page/scroll views, HKL's read-only Composer-view frame, and the chord inset).
//
// THE PROBLEM. Verovio emits staff lines as sub-pixel strokes whose device
// position is a function of the scale + page margin. Two things make them blur:
//   1. A thin (≈0.65px) line centered on an integer device-y sits ON a pixel
//      boundary and rasterizes as a dim ~2-row smear.
//   2. Verovio ceils the root <svg> px box to whole pixels while the inner
//      definition-scale viewBox is exact, so the browser's viewBox→device scale
//      (root_px / viewBox) drifts off the intended scale/1000 at "unclean"
//      scales (e.g. 70 → 0.0701), accumulating sub-pixel drift down the system.
//
// THE FIX (all first-paint, no layout read-back):
//   • Pick scale + unit so the staff-space (= unit × scale / 50 device px) is an
//     INTEGER — every staff line then shares one sub-pixel phase.
//
//     THE UNIT IS CONSTANT ACROSS ALL ZOOMS, and that is load-bearing (see
//     "WHY unit 8" below). Which scales are available depends on
//     gcd(unit, 50): a scale must be a multiple of 50/gcd(unit,50). At unit 9
//     (gcd 1) that is multiples of 50 — only 50/100/150, with NOTHING between
//     50 % and 100 %. At unit 8 (gcd 2) it is multiples of 25, so 50/75/100 all
//     land on integer staff-spaces (8/12/16 px) at one unit.
//   • Set stroke widths to whole device px (1px for the 50/75 presets, 2px for
//     100) so a centered line fills whole rows. Width is per-preset, since
//     stroke px = int(width × unit × 10) × scale/1000 and the achievable values
//     differ per scale.
//
// WHY unit 8 — and why a VARYING unit was a bug (2026-08-31).
//   `scale` is a pure output zoom with NO layout effect; `unit` and the page
//   rectangle are the only layout inputs. So a preset ladder that changes
//   `unit` re-breaks the score when the user merely zooms. That is exactly what
//   happened: this file previously used unit 9 at 50/100 and unit 10 at 75 (the
//   only way to make 75 % crisp at unit 9 was... not to use unit 9), so zooming
//   the 446-bar sonata to 75 % moved it from 118 lines / 37 pages to
//   134 lines / 45 pages — eight extra pages from a zoom. decisions.md had
//   asserted the opposite ("zoom is pure magnification and does not change
//   music-per-page"), which is why the cost was never weighed: unit 9 was
//   inherited as Verovio's default rather than chosen, and unit 10 was a later
//   patch to rescue an already-existing 75 % step.
//   Unit 8 dissolves it: gcd(8,50)=2 admits scale multiples of 25, so all three
//   levels are crisp at ONE unit and zoom is layout-neutral by construction
//   (the page-view partition cache then holds a single entry for every zoom).
//   The cost, accepted by Max after a side-by-side review: every level is ~11 %
//   smaller than the old unit-9/10 ladder (100 % staff-space 18px → 16px).
//   Do NOT reintroduce a per-zoom `unit`. See docs/lessons.md ("Verovio's
//   `scale` is layout-neutral; `unit` is not").
//   • Choose pageMarginTop parity so the lines' shared phase lands where a line
//     of that width is crisp: HALF-pixel (.5) for an odd (1px) width, integer
//     (.0) for an even (2px) width. See `crispMarginTop`.
//   • Pin the device scale to EXACTLY scale/1000 by overriding the root <svg>
//     box to viewBox × scale/1000. See `pinExactScale`.
//
// Stems/barlines sit at content-driven x positions (Verovio's non-uniform note
// spacing), so they can't all share a phase the way staff lines do — we give
// them whole-px widths (crisp where they land, and matching across surfaces) but
// don't try to phase-align them.

export type ZoomLevel = 50 | 75 | 100;

export interface CrispPreset {
  /** Verovio --scale (%). Chosen with `unit` so staff-space = unit×scale/50 ∈ ℤ. */
  scale: number;
  /** Verovio --unit (½ the staff-line distance, MEI units). Sizes the staff. */
  unit: number;
  /** Stroke widths (in --unit) tuned to whole device px at this scale/unit. */
  staffLineWidth: number;
  stemWidth: number;
  barLineWidth: number;
  ledgerLineThickness: number;
  /** true → even (2px) strokes, want integer line phase; false → odd (1px), half-pixel. */
  evenWidth: boolean;
}

/* deviceScale = scale/1000; staff-space px = unit×scale/50; stroke px =
   int(width×unit×10) × deviceScale. ONE unit (8) across all three levels, so
   zoom cannot change the layout; scales are multiples of 25 (clean — no
   root-<svg> ceil drift), and every staff-space is an integer:
     50%  → scale 50,  8px space,  internal 20 → 1.0px   lines (single crisp row)
     75%  → scale 75,  12px space, internal 13 → 0.975px lines (single crisp row)
     100% → scale 100, 16px space, internal 20 → 2.0px   lines (two crisp rows)
   50% & 100% share width 0.25 (internal 20 → 1px at ds .05, 2px at .1); 75%
   needs 0.1625 (internal 13) because 20 × .075 = 1.5px would straddle rows. */
export const CRISP_PRESETS: Record<ZoomLevel, CrispPreset> = {
  50: { scale: 50, unit: 8, staffLineWidth: 0.25, stemWidth: 0.25, barLineWidth: 0.25, ledgerLineThickness: 0.25, evenWidth: false },
  75: { scale: 75, unit: 8, staffLineWidth: 0.1625, stemWidth: 0.1625, barLineWidth: 0.1625, ledgerLineThickness: 0.1625, evenWidth: false },
  100: { scale: 100, unit: 8, staffLineWidth: 0.25, stemWidth: 0.25, barLineWidth: 0.25, ledgerLineThickness: 0.25, evenWidth: true },
};

/** Snap an arbitrary number (e.g. a zoom level off the overlay wire, or from a
 *  build whose ladder differs) to the nearest available preset. Keeps every
 *  consumer of a transported zoom from having to know the ladder, and keeps a
 *  stale/foreign value from reaching CRISP_PRESETS as an undefined lookup. */
export function resolveZoomLevel(n: number): ZoomLevel {
  const levels = Object.keys(CRISP_PRESETS).map(Number) as ZoomLevel[];
  let best = levels[0];
  for (const l of levels) if (Math.abs(l - n) < Math.abs(best - n)) best = l;
  return best;
}

/** The Verovio line-width options for a preset (spread into setOptions). */
export function lineWidthOptions(p: CrispPreset): Record<string, number> {
  return {
    staffLineWidth: p.staffLineWidth,
    stemWidth: p.stemWidth,
    barLineWidth: p.barLineWidth,
    ledgerLineThickness: p.ledgerLineThickness,
  };
}

/** Smallest pageMarginTop ≥ `base` that puts the staff-line phase on the value a
 *  stroke of this width needs to be crisp: integer (.0) for an even width, a
 *  half-pixel (.5) for an odd width. Phase = frac(pageMarginTop × scale/100)
 *  (empirically verified). Returns `base` unchanged if none found within 20
 *  units (only happens at scale 100, where the phase is always .0 — which is
 *  exactly what its even/2px width wants). */
export function crispMarginTop(base: number, scale: number, evenWidth: boolean): number {
  const target = evenWidth ? 0 : 0.5;
  for (let m = base; m < base + 20; m++) {
    const frac = ((m * scale / 100) % 1 + 1) % 1;
    if (Math.abs(frac - target) < 1e-9 || Math.abs(frac - target - 1) < 1e-9) return m;
  }
  return base;
}

/** Snap each system's staff lines onto the device-pixel grid (page view).
 *
 *  Single-system renders (scroll view, the frame, the inset) are crisped purely
 *  by the preset's scale/unit/width + margin parity. But a multi-system page
 *  stacks systems whose heights are content-dependent, so each system's top
 *  lands at its own sub-pixel phase — only the first can be margin-aligned. This
 *  reads each system's first staff line's device-y phase and adds a ≤½px vertical
 *  translate to land it on the phase its stroke width needs (½-pixel for odd/1px,
 *  integer for even/2px). The shift is sub-pixel, so nothing visibly moves; it
 *  just removes the cross-system blur. A render-time read-then-translate (like
 *  Composer's existing two-pass layoutBreaks), done before first paint.
 *
 *  Composes with any existing system transform (e.g. the section-header reserve
 *  shift), so call it AFTER all system-moving injections and before measuring
 *  cursor/overlay geometry. `ds` must already be exact (see pinExactScale). */
export function snapStaffLinesToGrid(container: HTMLElement, scale: number, evenWidth: boolean): void {
  const ds = scale / 1000;
  const target = evenWidth ? 0 : 0.5;
  /* Snap EACH g.staff, not each g.system: on a grand staff, inter-staff content
     (e.g. an expression between the staves) displaces the lower staff by a
     content-dependent amount, so the two staves land at different phases. Each
     staff's 5 lines share one phase (uniform spacing), so aligning the first
     aligns that staff. (Barlines span both staves and are NOT inside g.staff, so
     they don't follow this shift — handled/observed separately.) */
  /* Two-phase (see snapBarlines): batch all getScreenCTM/getBBox reads, then all
     writes — interleaving forces a synchronous layout per staff, reflowing the
     large persistent scroll SVG each time on big scores. */
  const writes: { svgStaff: SVGGraphicsElement; dOverDs: number }[] = [];
  for (const staff of Array.from(container.querySelectorAll('g.staff'))) {
    let line: SVGGraphicsElement | null = null;
    for (const p of Array.from((staff as Element).querySelectorAll(':scope > path'))) {
      let h = Infinity;
      try { h = (p as SVGGraphicsElement).getBBox().height; } catch { continue; }
      if (h < 1) { line = p as SVGGraphicsElement; break; }
    }
    if (!line) continue;
    const ctm = line.getScreenCTM();
    if (!ctm) continue;
    const deviceY = ctm.f + line.getBBox().y * ctm.d;
    const phase = ((deviceY % 1) + 1) % 1;
    let d = target - phase;
    d = ((d % 1) + 1) % 1;
    if (d > 0.5) d -= 1;
    if (Math.abs(d) < 1e-4) continue;            /* already on-grid */
    writes.push({ svgStaff: staff as SVGGraphicsElement, dOverDs: d / ds });
  }
  for (const { svgStaff, dOverDs } of writes) {
    const base = svgStaff.transform.baseVal.consolidate();
    const tx = base ? base.matrix.e : 0;
    const ty = base ? base.matrix.f : 0;
    svgStaff.setAttribute('transform', `translate(${tx}, ${ty + dOverDs})`);
  }
}

/** Snap each single-position barline's center onto the device-pixel phase its
 *  stroke width needs to be crisp (½-pixel for an odd/1px width, integer for an
 *  even/2px width). Barlines sit at content-driven x's that are usually off that
 *  phase → soft; they're not anchored to noteheads, so a ≤½px horizontal shift
 *  crisps them with no side effects. Double/final barlines (whose thin+thick
 *  lines have different x's, so one shift can't crisp both) are skipped — the
 *  terminal one is handled by snapSystemRightEdge. Call after pinExactScale. */
export function snapBarlines(container: Element, scale: number, evenWidth: boolean): void {
  const target = evenWidth ? 0 : 0.5;
  /* Two-phase to avoid layout thrashing: ALL getScreenCTM reads first, THEN all
     transform writes. Interleaving a write after each read forces a fresh
     synchronous layout per barline (and when this container is in the DOM beside
     the large persistent scroll SVG, each layout reflows that too — a measured
     hotspot on large scores in Firefox). Reads are independent (barlines are
     siblings, not nested), so batching yields identical snaps with one flush. */
  const writes: { svgG: SVGGraphicsElement; dOverA: number }[] = [];
  for (const g of Array.from(container.querySelectorAll('g.barLine'))) {
    const xs = new Set<number>();
    let ref: SVGGraphicsElement | null = null;
    for (const b of Array.from(g.querySelectorAll('path'))) {
      const m = (b.getAttribute('d') ?? '').match(/^M\s*(-?[\d.]+)/);
      if (!m) continue;
      xs.add(Math.round(parseFloat(m[1]) * 100) / 100);
      ref = b as SVGGraphicsElement;
    }
    if (xs.size !== 1 || !ref) continue;          /* skip double/final bars */
    const ctm = ref.getScreenCTM();
    if (!ctm) continue;
    const deviceX = ctm.e + [...xs][0] * ctm.a;
    let d = target - ((deviceX % 1) + 1) % 1;
    d = ((d % 1) + 1) % 1;
    if (d > 0.5) d -= 1;
    if (Math.abs(d) < 1e-3) continue;             /* already on-grid */
    writes.push({ svgG: g as SVGGraphicsElement, dOverA: d / ctm.a });
  }
  for (const { svgG, dOverA } of writes) {
    const base = svgG.transform.baseVal.consolidate();
    svgG.setAttribute('transform', `translate(${(base ? base.matrix.e : 0) + dOverA}, ${base ? base.matrix.f : 0})`);
  }
}

/** Snap each system's right edge — the final barline together with the staff-line
 *  ends that terminate on it — onto an integer device-x, so the shared edge is a
 *  crisp pixel boundary. Verovio runs the staff lines to the final barline's outer
 *  edge (same x as the bar's right edge); when that x lands on a fractional device
 *  pixel, the coincident edge anti-aliases and a faint sliver of staff line pokes
 *  past the bar. Shifting the bar AND the staff ends by the same ≤½px delta keeps
 *  them coincident (clean corner) while landing the edge on the grid (no poke).
 *  Only acts when a terminal barline sits at the staff ends (open system-break
 *  ends, with no terminal bar, are left alone). Horizontal analog of
 *  snapSystemsToGrid; call after pinExactScale so the device scale is exact.
 *
 *  `originPhaseX` (2026-09-18) is the horizontal twin of the vertical
 *  `originPhaseOf` phase transfer. The snap target is an ABSOLUTE device pixel,
 *  so it depends on where the host sits in the viewport: an offscreen host at
 *  `left:-99999px` lands on a different sub-pixel phase than the live page and
 *  snaps the same staff end to a different pixel. One snap moves at most half a
 *  device pixel, so two hosts can disagree by a whole one — `1 / ctm.a` user
 *  units, i.e. 10 at scale 100 but 20 at scale 50, which is how this cleared the
 *  splice gate's 10-unit tolerance at zoom 50 and never at zoom 100
 *  (`lock_after_zoom_reflows`; lessons.md, same date). Pass the LIVE page's
 *  fractional device x and an offscreen host snaps exactly as the live page
 *  does. Omitted, the behaviour is unchanged: the host snaps by its own
 *  position, which is what a real on-screen page must do to be crisp. */
export function snapSystemRightEdge(container: Element, scale: number, originPhaseX?: number): void {
  const ds = scale / 1000;
  /* `container` may itself be a system (the page splicer scopes post-processing
     to the systems it will import — A8); querySelectorAll finds descendants only. */
  const systems = container.matches('g.system') ? [container] : Array.from(container.querySelectorAll('g.system'));
  for (const sys of systems) {
    /* Horizontal staff lines + their right-end x. */
    const lines: { p: Element; x1: string; y: string; x2: number }[] = [];
    for (const p of Array.from(sys.querySelectorAll('.staff path'))) {
      const m = (p.getAttribute('d') ?? '').match(/^M\s*(-?[\d.]+)\s+(-?[\d.]+)\s+L\s*(-?[\d.]+)\s+(-?[\d.]+)\s*$/);
      if (!m || m[2] !== m[4]) continue;
      lines.push({ p, x1: m[1], y: m[2], x2: parseFloat(m[3]) });
    }
    if (!lines.length) continue;
    const staffEnd = Math.max(...lines.map(l => l.x2));
    /* Rightmost barline group + its outer-edge x (center + ½ stroke). */
    let barGroup: SVGGraphicsElement | null = null, barRight = -Infinity;
    for (const g of Array.from(sys.querySelectorAll('g.barLine'))) {
      for (const b of Array.from(g.querySelectorAll('path'))) {
        const m = (b.getAttribute('d') ?? '').match(/^M\s*(-?[\d.]+)/);
        if (!m) continue;
        const r = parseFloat(m[1]) + (parseFloat(b.getAttribute('stroke-width') ?? '0') || 0) / 2;
        if (r > barRight) { barRight = r; barGroup = g as SVGGraphicsElement; }
      }
    }
    if (!barGroup || Math.abs(barRight - staffEnd) > 4) continue;   /* no terminal bar at the staff end */
    const ref = lines.find(l => l.x2 === staffEnd)!.p as SVGGraphicsElement;
    const ctm = ref.getScreenCTM();
    if (!ctm) continue;
    /* Only frac(deviceX) matters (Math.round(x) - x), so re-basing the host's
       own page-margin phase onto the supplied one is enough to make the snap
       host-independent. Both phases come from `g.page-margin`, the group the
       vertical transfer reads too, so the two axes agree on what "the page's
       origin" means. Any piece missing → snap by absolute position, as before. */
    let deviceX = ctm.e + staffEnd * ctm.a;
    if (originPhaseX !== undefined) {
      const marginCtm = (ref.ownerSVGElement?.querySelector('g.page-margin') as SVGGraphicsElement | null)
        ?.getScreenCTM?.();
      if (marginCtm) deviceX += originPhaseX - (((marginCtm.e % 1) + 1) % 1);
    }
    const deltaUser = (Math.round(deviceX) - deviceX) / ctm.a;
    if (Math.abs(deltaUser) < 1e-3) continue;                       /* already on-grid */
    for (const l of lines) {
      if (Math.abs(l.x2 - staffEnd) > 4) continue;                  /* only ends on the terminal bar */
      l.p.setAttribute('d', `M${l.x1} ${l.y} L${l.x2 + deltaUser} ${l.y}`);
    }
    const base = barGroup.transform.baseVal.consolidate();
    barGroup.setAttribute('transform', `translate(${(base ? base.matrix.e : 0) + deltaUser}, ${base ? base.matrix.f : 0})`);
  }
}

/** Pin every rendered page's device scale to EXACTLY scale/1000 by overriding
 *  the root <svg> box to its inner definition-scale viewBox × scale/1000. Counters
 *  Verovio's whole-px ceil of the root box, which otherwise lets the browser's
 *  viewBox→device scale drift and blur thin lines. Pure arithmetic from the SVG's
 *  own viewBox — no getBoundingClientRect / layout read-back. Safe on a container
 *  holding one SVG (scroll/inset) or many (.score-page wrappers in page view). */
export function pinExactScale(container: HTMLElement, scale: number): void {
  const ds = scale / 1000;
  for (const inner of Array.from(container.querySelectorAll('svg.definition-scale'))) {
    const root = inner.parentElement;
    if (!(root instanceof SVGSVGElement)) continue;
    const vb = (inner.getAttribute('viewBox') ?? '').split(/\s+/).map(Number);
    if (vb.length === 4 && vb[2] && vb[3]) {
      /* Idempotent by construction: nothing may grow a page's viewBox after
         mount (Composer's section-header injector used to, and the first
         re-pin on such a page then resized it by the reserve — 2026-09-02). */
      root.setAttribute('width', `${vb[2] * ds}px`);
      root.setAttribute('height', `${vb[3] * ds}px`);
    }
  }
}
