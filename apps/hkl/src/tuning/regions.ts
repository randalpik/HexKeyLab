// The tuning fields every pitch / ratio / HEJI / colour computation needs. The
// per-mode tuning itself lives in exactly one place — @hkl/shared/freq.js's
// coordExps — and everything else (frequency, ratios, HEJI commas, colour)
// derives from it.

import type { TuningMode, Mapping } from '../state/persistence.js';

/** Tuning fields needed for frequency + ratio math. Subset of `tuning` so
 *  consumers (recording snapshot, MIDI import) can pass a stored state without
 *  mutating the live `tuning` module. `mapping` is the coordinate frame the
 *  (q, r) arguments are in; `anchor` is the home band (only Syntonic /
 *  Polysyntonic read it — see anchorOf in @hkl/shared/freq.js). */
export interface TuningStateLike {
  mode: TuningMode;
  mapping: Mapping;
  anchor: number;
  equalEnabled: boolean;
  septimalEnabled: boolean;
  septimalW: number;
}
