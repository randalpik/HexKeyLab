// Anchor (Syntonic / Polysyntonic home band) changed — state/reference.ts
// recomputed `tuning.anchor`. In S/Y that changes the pitch, HEJI and color of
// every band but the new home: exactly a tuning change, so the fan-out is
// onTuningChanged's (ramp held voices in place, re-render, Lumatone color
// diff, Composer rebroadcast incl. the anchor in hkl-layout-state). Every
// other mode ignores the anchor, so nothing happens there.

import { tuning } from '../state/tuning.js';
import { onTuningChanged } from './onTuningChanged.js';

export function onAnchorChanged(): void {
  if (tuning.mode !== 'S' && tuning.mode !== 'Y') return;
  onTuningChanged();
}
