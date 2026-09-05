// Unbroken barlines — a DOM post-process on rendered systems (2026-09-05).
//
// Verovio erases the stretch of a `bar.thru` barline (the part between the two
// staves of a grand staff) that a dynamic, expressive text, tempo or copy mark
// overlaps: `View::DrawBarLine` → `SystemAligner::FindAllIntersectionPoints`
// over {CPMARK, DIR, DYNAM, TEMPO} with half a unit of margin, at draw time
// only (skipped for the bbox device context, so layout never sees it) and with
// no option to turn it off. Max's rule: a barline never breaks (backlog,
// Correctness, m. 90). And since Composer then moves those very marks (the
// text-layout pass centres them in the gap), the hole would stay behind where
// the mark used to be while the mark lands on the barline further down.
//
// The repair is draw-only too: for every grand-staff gap a measure's barline
// runs through, the segments Verovio did draw are read back from their own
// `d` (plain `M x y L x y2` verticals, no transforms — the measure's local
// user space, the same one its staff-line paths use) and every uncovered
// stretch of the gap gets a sibling path with the same stroke. Nothing is
// measured through layout, nothing moves. Idempotent: earlier fills are
// removed first. Only gaps a barline actually enters are filled — the
// separation between two INSTRUMENTS carries no barline and is left alone
// (a grand pair is the only place Composer sets `bar.thru`).

interface Seg { el: Element; x: number; y1: number; y2: number }
interface Row { top: number; bottom: number }

const EPS = 1;
const LINE_RE = /M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/;

const attrNum = (el: Element, name: string): number | null => {
  const v = el.getAttribute(name);
  if (v === null) return null;
  const n = parseInt(v.trim().split(/\s+/)[0], 10);
  return Number.isFinite(n) ? n : null;
};

/** `M x1 y1 L x2 y2` → the four numbers, or null for anything else. */
function parseLine(el: Element): [number, number, number, number] | null {
  const d = el.getAttribute('d');
  if (!d) return null;
  const m = LINE_RE.exec(d);
  if (!m) return null;
  const v = [m[1], m[2], m[3], m[4]].map(Number);
  return v.every(Number.isFinite) ? [v[0], v[1], v[2], v[3]] : null;
}

/** Staff rows of a measure by @n, from the horizontal line paths of each
 *  `g.staff` (top = highest line, bottom = lowest). */
function rowsOf(measure: Element): Map<number, Row> {
  const rows = new Map<number, Row>();
  for (const staff of Array.from(measure.children)) {
    if (!staff.classList.contains('staff')) continue;
    const n = attrNum(staff, 'data-n');
    if (n === null) continue;
    let top = Infinity, bottom = -Infinity;
    for (const p of Array.from(staff.children)) {
      if (p.localName !== 'path') continue;
      const l = parseLine(p);
      if (!l || Math.abs(l[1] - l[3]) > EPS) continue;      // not a staff line
      top = Math.min(top, l[1]); bottom = Math.max(bottom, l[1]);
    }
    if (isFinite(top)) rows.set(n, { top, bottom });
  }
  return rows;
}

/** Refill the erased stretches of every grand-staff barline under `root`.
 *  `grandPairs` = [upper, lower] staff @n of each two-staff instrument. */
export function repairBarLines(root: Element, grandPairs: ReadonlyArray<readonly [number, number]>): void {
  if (!grandPairs.length) return;
  for (const old of Array.from(root.querySelectorAll('path[data-hkl-barfill]'))) old.remove();
  const measures = root.matches('g.measure') ? [root] : Array.from(root.querySelectorAll('g.measure'));
  for (const measure of measures) {
    const rows = rowsOf(measure);
    const spans: Array<{ from: number; to: number }> = [];
    for (const [u, l] of grandPairs) {
      const ru = rows.get(u), rl = rows.get(l);
      if (!ru || !rl || rl.top - ru.bottom <= EPS) continue;
      spans.push({ from: ru.bottom, to: rl.top });
    }
    if (!spans.length) continue;
    for (const bar of Array.from(measure.children)) {
      if (!bar.classList.contains('barLine')) continue;
      /* The barline's vertical segments, grouped by x (a double bar has two). */
      const byX = new Map<number, Seg[]>();
      for (const p of Array.from(bar.children)) {
        if (p.localName !== 'path') continue;
        const l = parseLine(p);
        if (!l || Math.abs(l[0] - l[2]) > EPS) continue;
        const seg: Seg = { el: p, x: l[0], y1: Math.min(l[1], l[3]), y2: Math.max(l[1], l[3]) };
        const key = Math.round(seg.x);
        const arr = byX.get(key);
        if (arr) arr.push(seg); else byX.set(key, [seg]);
      }
      for (const segs of byX.values()) {
        segs.sort((a, b) => a.y1 - b.y1);
        for (const { from, to } of spans) {
          /* Verovio draws the between-staff stretch as its own segment(s), and
             an erased one still leaves a (possibly zero-length) piece inside
             the gap: no piece inside the gap means the barline does not run
             through it, and there is nothing to repair. */
          const inside = segs.filter((s) => s.y1 >= from - EPS && s.y2 <= to + EPS);
          if (!inside.length) continue;
          const touching = segs.filter((s) => s.y2 >= from - EPS && s.y1 <= to + EPS);
          let cov = from;
          const gaps: Array<[number, number]> = [];
          for (const s of touching) {
            if (s.y1 > cov + EPS) gaps.push([cov, s.y1]);
            cov = Math.max(cov, s.y2);
          }
          if (cov < to - EPS) gaps.push([cov, to]);
          const template = inside[inside.length - 1].el;
          for (const [g0, g1] of gaps) {
            const fill = template.cloneNode(false) as Element;
            fill.setAttribute('d', `M${segs[0].x} ${g0} L${segs[0].x} ${g1}`);
            fill.setAttribute('data-hkl-barfill', '1');
            template.after(fill);
          }
        }
      }
    }
  }
}
