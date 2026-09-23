// Render-clone whole-bar rests (2026-09-22, backlog Composer).
//
// A staff cell with no musical content — every layer holds only <space>
// placeholders (or nothing), plus at most a <clef> — used to render as a bare
// measure frame. Engraving never shows one: an empty complete bar carries a
// whole-bar rest, the whole-rest glyph centred between the barlines whatever
// the meter, which is exactly what Verovio draws for <mRest>. The exception is
// a PICKUP (`hkl:pickup-ticks`): a whole rest would claim a full bar the
// anacrusis doesn't have, so its first layer shows a rest of the pickup's
// length instead — ONE rest whenever a single value (up to two dots) spells it
// (half, dotted quarter, double-dotted half …), else the fewest values,
// largest first (decomposeTicks). Max, 2026-09-22: beat-aligned rests (two
// quarters for a half-bar pickup) widened the bar and displaced its barline.
//
// Cosmetic only. This runs on the render clone, never on the saved document,
// so the cell's placeholders — and with them the cursor's measure-start stop,
// the empty-cell flags, playback and every save path — are untouched. The
// synthesized elements are not cursor stops (the cursor reads the model, not
// the render) and are invisible to click hit-testing: an <mRest> renders as
// g.mRest, which click.ts never collects, and the pickup rests carry
// `data-hkl-cosmetic` (SVG: `data-data-hkl-cosmetic`), which it skips — so a
// click there still resolves to the empty staff. Ids derive from the layer's,
// so an unchanged cell renders identically every time.
//
// Only the FIRST layer gets the rest; the other layers keep their
// placeholders, and settleRestLocations (which runs after this) pins the rest
// at its single-layer place, since nothing visible meets it. A cell already
// drawing a full-measure glyph (an imported <mRest>, a collapsed <multiRest>)
// is left alone.

import { el } from '@hkl/notation/mei-build.js';
import { HKL_NS } from '../expressions.js';
import { decomposeTicks } from '../model/ticks.js';

/** Marks a synthesized rest in the render clone (surfaced to the SVG). */
export const COSMETIC_ATTR = 'data-hkl-cosmetic';

/** Anything that makes a cell NOT empty. A <clef> does not: a clef change in
 *  an otherwise empty bar still wants its rest. <mRest>/<multiRest> already
 *  draw one. */
const FILLED: ReadonlySet<string> = new Set([
  'chord', 'note', 'rest', 'tuplet', 'fTrem', 'bTrem', 'beam', 'mRest', 'multiRest',
]);

/** Filler a synthesized rest replaces: layout placeholders and invisible
 *  full-measure space. */
const isFiller = (c: Element): boolean => c.localName === 'space' || c.localName === 'mSpace';

function cellIsEmpty(layers: readonly Element[]): boolean {
  for (const layer of layers) {
    for (let c = layer.firstElementChild; c; c = c.nextElementSibling) {
      if (FILLED.has(c.localName)) return false;
    }
  }
  return true;
}

function pickupTicksOf(measure: Element): number | null {
  const v = measure.getAttributeNS(HKL_NS, 'pickup-ticks');
  const n = v ? parseInt(v, 10) : NaN;
  return isFinite(n) && n > 0 ? n : null;
}

/** Give every content-free staff cell its conventional rest (see above).
 *  Idempotent: a filled cell is no longer empty. */
export function fillEmptyMeasureRests(doc: Document): void {
  for (const measure of Array.from(doc.querySelectorAll('measure'))) {
    for (let staff = measure.firstElementChild; staff; staff = staff.nextElementSibling) {
      if (staff.localName !== 'staff') continue;
      const layers = Array.from(staff.children).filter((c) => c.localName === 'layer');
      if (!cellIsEmpty(layers)) continue;
      let layer = layers.reduce<Element | null>((lo, l) =>
        !lo || parseInt(l.getAttribute('n') ?? '1', 10) < parseInt(lo.getAttribute('n') ?? '1', 10) ? l : lo, null);
      if (!layer) {
        layer = el(doc, 'layer', { n: '1' });
        staff.appendChild(layer);
      }
      const base = layer.getAttribute('xml:id');
      /* Rests go where the first filler stood (after any leading clef). */
      const anchor = Array.from(layer.children).find(isFiller) ?? null;
      const pickup = pickupTicksOf(measure);
      const rests: Element[] = [];
      if (pickup === null) {
        rests.push(el(doc, 'mRest', { 'xml:id': base ? `${base}-mrest` : undefined }));
      } else {
        decomposeTicks(pickup).forEach((p, k) => {
          const r = el(doc, 'rest', {
            'xml:id': base ? `${base}-prest${k}` : undefined,
            dur: p.dur, dots: p.dots > 0 ? p.dots : undefined,
          });
          r.setAttribute(COSMETIC_ATTR, 'true');
          rests.push(r);
        });
      }
      for (const r of rests) layer.insertBefore(r, anchor);
      for (const c of Array.from(layer.children)) if (isFiller(c)) layer.removeChild(c);
    }
  }
}
