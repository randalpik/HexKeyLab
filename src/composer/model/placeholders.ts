/* Layer-level placeholder normalization. A `<space data-placeholder="true">`
 * gives Verovio enough layout content to size a measure correctly, is visually
 * invisible per MEI spec, and serves as a navigation target so the cursor can
 * land in an empty voice in mid-score.
 *
 * Tuplet-internal placeholders (data-tuplet-placeholder) are a different
 * concern and live in note-elements.ts (regenTupletPlaceholders). */

import { realTicks } from './ticks.js';
import { el, newId, decomposeTicks } from './index.js';

export const PLACEHOLDER_ATTR = 'data-placeholder';

export function isPlaceholder(elem: Element): boolean {
  return elem.localName === 'space' && elem.getAttribute(PLACEHOLDER_ATTR) === 'true';
}

/** Strip existing layer-level placeholders and append fresh trailing
 *  placeholders summing to whatever residual ticks remain in the measure.
 *
 *  A fully-empty layer ends up with placeholders summing to the whole
 *  measure; a partial layer gets placeholders summing to the residual space
 *  (which serves as the fill-anchor's home in the nav-stop model); a full
 *  layer gets none.
 *
 *  Tuplet-internal placeholders (data-tuplet-placeholder) are never touched
 *  here — those live inside <tuplet> elements and are managed by
 *  tuplet-specific code. */
export function normalizePlaceholders(doc: Document, measureTicks: number): void {
  const layers = doc.querySelectorAll('layer');
  for (const layer of Array.from(layers)) {
    /* Strip existing layer-level placeholders. */
    for (const c of Array.from(layer.children)) {
      if (isPlaceholder(c)) layer.removeChild(c);
    }
    /* Sum real-content ticks; append trailing placeholders to fill the
       remainder. */
    let used = 0;
    for (const c of Array.from(layer.children)) {
      if (
        c.localName === 'chord' ||
        c.localName === 'note' ||
        c.localName === 'rest' ||
        c.localName === 'tuplet'
      ) {
        used += realTicks(c);
      }
    }
    const remaining = measureTicks - used;
    if (remaining <= 0) continue;
    for (const p of decomposeTicks(remaining)) {
      const space = el(doc, 'space', {
        'xml:id': newId('sp'),
        dur: p.dur,
        dots: p.dots > 0 ? p.dots : undefined,
      });
      space.setAttribute(PLACEHOLDER_ATTR, 'true');
      layer.appendChild(space);
    }
  }
}
