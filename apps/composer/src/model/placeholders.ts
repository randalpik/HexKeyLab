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
export function normalizePlaceholders(
  doc: Document,
  ticksForLayer: (layer: Element) => number,
  only?: Iterable<Element> | null,
): number {
  /* `only` restricts the pass to layers known to have changed (Phase D — the
   *  full pass walks every layer in the document, ~1800 on the sonata, on every
   *  edit). Detached layers are skipped: a dirty set can outlive a deletion. */
  const layers = only
    ? Array.from(only).filter((l) => l.isConnected !== false && l.ownerDocument === doc)
    : Array.from(doc.querySelectorAll('layer'));
  let rebuilt = 0;
  for (const layer of layers) {
    /* ONE children snapshot per layer (Phase D): this runs over every layer in
       the document on every edit — ~1800 on the sonata — and used to materialise
       `layer.children` three separate times (content sum, mRest test, and the
       idempotency check). Nothing mutates the layer between them. */
    const kids = Array.from(layer.children);
    /* Compute the desired trailing placeholder decomposition for this layer. */
    let used = 0;
    /* An <mRest> is a full-measure rest — it fills the measure by definition, so
       the layer needs NO trailing placeholder. (Adding one made Verovio size the
       measure as a breve rest — the "double whole rest" bug.) */
    let hasMRest = false;
    for (const c of kids) {
      const ln = c.localName;
      if (
        ln === 'chord' ||
        ln === 'note' ||
        ln === 'rest' ||
        ln === 'tuplet' ||
        ln === 'fTrem' ||
        ln === 'bTrem'
      ) {
        used += realTicks(c);
      } else if (ln === 'mRest') {
        hasMRest = true;
      }
    }
    const remaining = hasMRest ? 0 : ticksForLayer(layer) - used;
    const desired = remaining > 0 ? decomposeTicks(remaining) : [];

    /* IDEMPOTENT: if the layer's placeholders already match `desired` exactly
       (right count, dur/dots, trailing, none interspersed), leave them in place.
       This is on the hot path — every edit calls normalizePlaceholdersAll over
       EVERY layer in the doc; blindly stripping + re-appending with fresh
       newId('sp') churned every measure's serialization, so the scroll splicer
       saw the whole score as dirty and full-re-engraved (O(total), seconds).
       Skipping unchanged layers keeps placeholder ids stable. */
    const existingPh = kids.filter(isPlaceholder);
    const trailing = kids.slice(kids.length - desired.length);
    const dotsOf = (c: Element) => parseInt(c.getAttribute('dots') ?? '0', 10) || 0;
    const matches =
      existingPh.length === desired.length &&
      trailing.length === desired.length &&
      trailing.every((c, i) =>
        isPlaceholder(c) && c.getAttribute('dur') === desired[i].dur && dotsOf(c) === desired[i].dots);
    if (matches) continue;                       // already correct — don't churn ids

    /* Otherwise rebuild: strip existing placeholders, append fresh trailing. */
    rebuilt++;
    for (const c of existingPh) layer.removeChild(c);
    for (const p of desired) {
      const space = el(doc, 'space', {
        'xml:id': newId('sp'),
        dur: p.dur,
        dots: p.dots > 0 ? p.dots : undefined,
      });
      space.setAttribute(PLACEHOLDER_ATTR, 'true');
      layer.appendChild(space);
    }
  }
  return rebuilt;
}
