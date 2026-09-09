// Same-moment mark separation — a PRE-ENGRAVE render-clone pass (2026-09-09,
// backlog Layout; Max on the sonata's p. 21 second system, mm. 94–99).
//
// Verovio draws two control events sharing one `@tstamp`, `@staff` and
// `@place` at ONE x and stacks them vertically, and it sizes the inter-staff
// gap to hold that stack. `render/textlayout.ts` has un-stacked them since
// 2026-09-08 by moving the `<dir>` sideways in the DOM — but that happens
// AFTER the engrave, so the reserved row stays and the grand staff keeps a gap
// no longer holding anything. On m. 99's `p` + `dim.` the piano's own gap was
// 2120 user units (13.25 staff spaces) where 1160 would do.
//
// Probed, on that system (each measured after a full re-render):
//   @ho=4 / @ho=8 on the <dir>   glyph moves, gap 2120 → 2120   (unchanged)
//   @vgrp=1 on both              nothing moves at all, gap 2120
//   merged into one <dynam>      gap 2120 → 1710, but Verovio's mixed-content
//                                bbox is 1910 units TALL (the SMuFL glyph's em
//                                box plus the text's), which would wreck every
//                                downstream centring and ink-floor measurement
//   the <dir> deleted            gap 2120 → 1160     ← the ceiling
//   @tstamp 1 → 1.25             gap 2120 → 1240, and textlayout's horizontal
//                                move becomes a no-op: Verovio spaces the pair
//                                itself
// The distinction is that `@ho` is a DRAW-TIME offset — Verovio's row
// reservation never sees it — while `@tstamp` is the LAYOUT-TIME anchor. So the
// separation has to be decided before the engrave, which is what this pass
// does: each following `<dir>` gets its clone tstamp nudged past its dynamic
// anchor, and Verovio then engraves one row and sizes the gap for one row.
//
// WHY THE CLONE ONLY: the nudge decouples the rendered anchor from the
// document's. Nothing downstream of engraving depends on a `<dir>`'s tstamp —
// playback reads `<dynam>`/`<hairpin>` off the LIVE doc and `<dir>` has no
// playback role — and the saved document is never this clone. It is the same
// liberty the importer already takes with `<offset>` (decisions.md: correct
// placement relative to each other, not Finale replication).
//
// WHAT IT DOES NOT DO: it cannot know x before the engrave, so the exact
// clearance between the pair is still textlayout's (`UNSTACK_GAP`, one staff
// space). And a group with no room left in its measure is left ALONE, sharing
// its tstamp — textlayout's original same-moment rule is still there and still
// handles that case, now as the documented fallback.

const HKL_NS = 'https://hexkeylab.com/ns/mei';

/* How far past its anchor each successive <dir> is moved, in beats. Big enough
   that Verovio sees no horizontal overlap (a nudge of a few hundredths lands
   the mark at nearly the same x and the second row comes back), small enough
   to stay inside an ordinary measure. textlayout corrects the resulting
   clearance either way, so this only has to break the overlap. */
const NUDGE_BEATS = 0.25;
/* Keep a nudged mark this many beats clear of the barline: Verovio centres a
   mark on its tstamp, and one at `beats + 1` sits exactly ON the barline (the
   case textlayout's barline rule exists to undo — importMusicXml's <offset>
   note). */
const BAR_MARGIN = 0.5;
/* Two tstamps this close are the same moment for the occupancy test. */
const EPS = 1e-3;

const firstNum = (raw: string | null): number | null => {
  if (raw === null) return null;
  const n = parseFloat(raw.trim().split(/\s+/)[0]);
  return Number.isFinite(n) ? n : null;
};

/** Beats available in each `<measure>`: its meter's count, or the reduced
 *  budget a pickup carries (`hkl:pickup-ticks`). Walks in-section `<scoreDef>`
 *  meter overrides seeded by the head, the same walk `beams.ts`
 *  (`perMeasureTimeSig`) and `expressions.ts` (`measureTickInfo`) each make
 *  doc-locally. */
function beatsPerMeasure(doc: Document): Map<Element, number> {
  const head = doc.querySelector('scoreDef');
  let count = firstNum(head?.getAttribute('meter.count') ?? null) ?? 4;
  let unit = firstNum(head?.getAttribute('meter.unit') ?? null) ?? 4;
  const out = new Map<Element, number>();
  const section = doc.querySelector('section');
  const nodes = section
    ? Array.from(section.querySelectorAll('scoreDef, measure'))
    : Array.from(doc.querySelectorAll('measure'));
  for (const node of nodes) {
    if (node.localName === 'scoreDef') {
      const c = node.getAttribute('meter.count');
      const u = node.getAttribute('meter.unit');
      if (c !== null || u !== null) {
        if (c) count = firstNum(c) ?? count;
        if (u) unit = firstNum(u) ?? unit;
      }
      continue;
    }
    const pk = firstNum(node.getAttributeNS(HKL_NS, 'pickup-ticks'));
    out.set(node, pk !== null && pk > 0 ? pk / (64 / unit) : count);
  }
  return out;
}

/** Nudge each same-moment `<dir>` past its `<dynam>` anchor so Verovio
 *  engraves the group as ONE row. Render clone only. */
export function separateSameMomentMarks(clone: Document): void {
  const beats = beatsPerMeasure(clone);
  for (const measure of Array.from(clone.querySelectorAll('measure'))) {
    const marks = Array.from(measure.children).filter(
      (c) => c.localName === 'dynam' || c.localName === 'dir');
    if (marks.length < 2) continue;

    /* Group by the anchor a mark actually shares: moment + staff + side. */
    const groups = new Map<string, Element[]>();
    /* …and remember every moment each (staff, side) already occupies, so a
       nudge never lands on another mark of the same row. */
    const occupied = new Map<string, number[]>();
    for (const mk of marks) {
      const ts = firstNum(mk.getAttribute('tstamp'));
      const staff = mk.getAttribute('staff');
      if (ts === null || staff === null) continue;
      const row = staff.trim().split(/\s+/)[0] + '/' + (mk.getAttribute('place') ?? '');
      const key = row + '@' + ts;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(mk);
      (occupied.get(row) ?? occupied.set(row, []).get(row)!).push(ts);
    }

    const barEnd = (beats.get(measure) ?? 4) + 1;
    for (const [key, group] of groups) {
      if (group.length < 2) continue;
      /* The DYNAMIC anchors the cluster (it is what `dynamDist` positions and
         what textlayout leaves in place); only <dir>s follow it. */
      const anchor = group.find((g) => g.localName === 'dynam');
      if (!anchor) continue;
      const anchorTs = firstNum(anchor.getAttribute('tstamp'));
      if (anchorTs === null) continue;
      const movers = group.filter((g) => g !== anchor && g.localName === 'dir');
      if (!movers.length) continue;
      const row = key.slice(0, key.lastIndexOf('@'));
      const taken = occupied.get(row) ?? [];
      const anchorId = anchor.getAttribute('xml:id');

      let running = anchorTs;
      for (const mv of movers) {
        let ts = running + NUDGE_BEATS;
        /* Never onto another mark of the same row. */
        while (taken.some((t) => Math.abs(t - ts) < EPS) && ts <= barEnd - BAR_MARGIN) ts += NUDGE_BEATS;
        /* No room left in the measure: leave this mover and the rest sharing
           the anchor's tstamp — textlayout's same-moment rule takes them. */
        if (ts > barEnd - BAR_MARGIN) break;
        mv.setAttribute('tstamp', String(ts));
        /* The pair no longer shares a tstamp, which is what textlayout's rule
           keys on, so name the anchor outright for its clearance fine-tune. */
        if (anchorId) mv.setAttribute('hkl-unstack', anchorId);
        taken.push(ts);
        running = ts;
      }
    }
  }
}
