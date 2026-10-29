// Color helpers for transcription: the ink-on-paper notehead color for a
// lattice cell under the current layout. The remap itself (per-hue ink
// profiles) is @hkl/shared/keycolor.js's inkColorHex, shared with Composer.

import { inkColorHex } from '@hkl/shared/keycolor.js';
import { tuning } from '../state/tuning.js';

/** Lattice color, remapped per-hue for ink-on-white-paper readability. */
export function darkColorHex(q: number, r: number): string {
  return inkColorHex(q, r, tuning.mode, tuning.mapping, tuning.anchor, tuning.banded);
}
