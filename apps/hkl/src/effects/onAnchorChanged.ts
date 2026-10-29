// Anchor (Syntonic / Polysyntonic home band; the ref's band unbanded) changed —
// state/reference.ts recomputed `tuning.anchor`. In S/Y, and in every mode
// unbanded, that changes the pitch, spelling, HEJI and color of every band but
// the new home: exactly a tuning change, so the fan-out is onTuningChanged's
// (ramp held voices in place, re-render, Lumatone color diff, Composer
// rebroadcast incl. the anchor in hkl-layout-state). Banded, every other mode
// ignores the anchor, so nothing happens there.

import { tuning } from '../state/tuning.js';
import { readsAnchor } from '@hkl/shared/freq.js';
import { onTuningChanged } from './onTuningChanged.js';

export function onAnchorChanged(): void {
  if (!readsAnchor(tuning.mode, tuning.banded)) return;
  onTuningChanged();
}
