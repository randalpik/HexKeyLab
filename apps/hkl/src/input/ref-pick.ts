// The reference pick: the one body behind every input that picks a ref while
// the ref-edit modifier (input/ref-edit.ts) is held — a Ctrl+click on the
// canvas (ui/init.ts) and a Lumatone key press (midi/handler.ts) — so a key
// press under the modifier does exactly what a click on that cell does.

import { validateRefNoteCandidate } from '../render/draw.js';
import { flashInfoLine } from '../render/info.js';
import {
  referenceNote, setSelectionFromManual, clearSelection as clearRefSelection,
} from '../state/reference.js';
import { savePrefs } from '../state/persistence.js';
import { withRefSlide } from '../effects/onRefChanged.js';

/** Pick cell (q, r) as the reference note — the manual selection tier. Picking
 *  the current effective ref clears the selection instead (revealing the
 *  score-ref tier or the A3 default). Never touches the play selection.
 *  A cell that fails validation flashes the reason and changes nothing. */
export function pickRef(q: number, r: number): void {
  const isCurrentRef = (q === referenceNote.q && r === referenceNote.r);
  if (!isCurrentRef) {
    /* Validate BEFORE mutating state. */
    const reason = validateRefNoteCandidate(q, r);
    if (reason) { flashInfoLine(reason); return; }
  }
  /* reference.ts re-derives kbAnchor and runs onRefChanged (voice migration,
     re-center, redraw, broadcasts) — sliding, for a pick. */
  const changed = withRefSlide(() => isCurrentRef ? clearRefSelection() : setSelectionFromManual(q, r));
  /* Persist or drop the manual ref. Composer-set selections do not persist. */
  if (changed) savePrefs({ manualRef: isCurrentRef ? undefined : { q, r } });
}
