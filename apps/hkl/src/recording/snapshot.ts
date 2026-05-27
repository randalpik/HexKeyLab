// Layout snapshot: capture the current tuning / instrument / pedal-mode
// state into a portable record, and check whether a stored snapshot matches
// live state. Applying a snapshot back to live state lives in apply.ts so this
// module stays leaf-position in the dep graph (capture.ts imports it).

import { tuning } from '../state/tuning.js';
import { pedal } from '../state/pedal.js';
import { audio } from '../state/audio.js';
import type { LayoutSnapshot } from './types.js';
import type { TuningMode } from '../state/persistence.js';

const REF_HZ = 220;

export function captureSnapshot(): LayoutSnapshot {
  const t: TuningMode = tuning.mode;
  return {
    tuning: t,
    septimalEnabled: tuning.septimalEnabled,
    equalEnabled: tuning.equalEnabled,
    septimalW: tuning.septimalW,
    instrument: audio.activeWaveform,
    pedalMode: pedal.mode,
    refHz: REF_HZ,
  };
}

/* True iff every tuning/instrument/pedal field of `s` matches live state. */
export function snapshotMatchesLive(s: LayoutSnapshot): boolean {
  return (
    s.tuning === tuning.mode &&
    s.instrument === audio.activeWaveform &&
    s.pedalMode === pedal.mode
  );
}
