/* Layer-level placeholder normalization. A `<space data-placeholder="true">`
 * gives Verovio enough layout content to size a measure correctly, is visually
 * invisible per MEI spec, and serves as a navigation target so the cursor can
 * land in an empty voice in mid-score.
 *
 * Tuplet-internal placeholders (data-tuplet-placeholder) are a different
 * concern and live in note-elements.ts (regenTupletPlaceholders). */

import { realTicks } from './ticks.js';
import { el, newId, decomposeTicks } from './index.js';
import { clearEmptyFlags, isCellContent } from './empty-flags.js';

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
 *  tuplet-specific code.
 *
 *  A layer-level `<mRest>` is stripped like a placeholder: the whole-bar rest
 *  is never document state. It is a render-time function of the cell
 *  (notation/measurerests.ts draws one while every layer is empty), so a
 *  stored one — a file saved before 2026-09-28, when the MusicXML importer
 *  still wrote them — is scrubbed on load (every load path ends here) and by
 *  any later edit that touches its layer. */
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
       `layer.children` twice (content sum and the idempotency check). Nothing
       mutates the layer between them. */
    const kids = Array.from(layer.children);
    /* Compute the desired trailing placeholder decomposition for this layer. */
    let used = 0;
    /* Stored <mRest>s to scrub (see the doc comment). They count for nothing:
       the layer's placeholders are sized from its real content alone. */
    const staleMRests: Element[] = [];
    let hasContent = false;
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
        hasContent = true;
      } else if (ln === 'mRest') {
        staleMRests.push(c);
      } else if (isCellContent(ln)) {
        hasContent = true;             // a layer <clef> also un-empties the cell
      }
    }
    /* Content in the cell drops its empty-cell flags (hide-empty / multirest):
       a flag may only live on an EMPTY staff cell, and this loop is the one
       pass every edit path already runs over every dirty layer — see
       model/empty-flags.ts. Runs BEFORE the idempotency shortcut below, since a
       full layer has no placeholders to rebuild. */
    if (hasContent) {
      const staff = layer.parentElement;
      if (staff && staff.localName === 'staff') clearEmptyFlags(staff);
    }
    const remaining = ticksForLayer(layer) - used;
    const desired = remaining > 0 ? decomposeTicks(remaining) : [];

    /* IDEMPOTENT: if the layer's placeholders already match `desired` exactly
       (right count, dur/dots, trailing, none interspersed), leave them in place.
       This is on the hot path — every edit calls normalizePlaceholdersAll over
       EVERY layer in the doc; blindly stripping + re-appending with fresh
       newId('sp') churned every measure's serialization, so the scroll splicer
       saw the whole score as dirty and full-re-engraved (O(total), seconds).
       Skipping unchanged layers keeps placeholder ids stable. */
    const existingPh = kids.filter(isPlaceholder);
    /* A run of <clef> at the very END of the layer — after the placeholders —
       is a barline clef in its courtesy spelling (model/clef-slot.ts; what the
       render relocation writes and a reload reads back). Placeholders live
       BEFORE it: appending them after it turned `[sp, clef]` into `[clef, sp]`
       on every load, i.e. a clef in an empty bar became that bar's HEAD clef
       and the next save relocated it a bar earlier again (2026-09-27, the
       "clef on an empty layer does not roundtrip" note). */
    let tailStart = kids.length;
    while (tailStart > 0 && kids[tailStart - 1].localName === 'clef') tailStart--;
    const body = kids.slice(0, tailStart);
    const trailing = body.slice(body.length - desired.length);
    const dotsOf = (c: Element) => parseInt(c.getAttribute('dots') ?? '0', 10) || 0;
    const matches =
      staleMRests.length === 0 &&
      existingPh.length === desired.length &&
      trailing.length === desired.length &&
      trailing.every((c, i) =>
        isPlaceholder(c) && c.getAttribute('dur') === desired[i].dur && dotsOf(c) === desired[i].dots);
    if (matches) continue;                       // already correct — don't churn ids

    /* Otherwise rebuild: strip existing placeholders (and any stored <mRest>),
       insert fresh ones at the tail — before a trailing clef run, else
       appended. */
    rebuilt++;
    const tailAnchor = kids[tailStart] ?? null;
    for (const c of existingPh) layer.removeChild(c);
    for (const c of staleMRests) layer.removeChild(c);
    for (const p of desired) {
      const space = el(doc, 'space', {
        'xml:id': newId('sp'),
        dur: p.dur,
        dots: p.dots > 0 ? p.dots : undefined,
      });
      space.setAttribute(PLACEHOLDER_ATTR, 'true');
      layer.insertBefore(space, tailAnchor);
    }
  }
  return rebuilt;
}
