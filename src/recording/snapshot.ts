// Layout snapshot: capture the current tuning / layout / instrument / pedal-mode
// state into a portable record, and check whether a stored snapshot matches
// live state. Applying a snapshot back to live state lives in apply.ts so this
// module stays leaf-position in the dep graph (capture.ts imports it).

import { tuning } from '../state/tuning.js';
import { pedal } from '../state/pedal.js';
import { audio } from '../state/audio.js';
import type { LayoutSnapshot } from './types.js';
import type { LayoutId, TuningMode } from '../state/persistence.js';

const REF_HZ = 220;

export function captureSnapshot(): LayoutSnapshot {
  const t: TuningMode = tuning.equalEnabled ? 'E' : tuning.septimalEnabled ? '7' : '5';
  return {
    curLayout: tuning.curLayout as LayoutId,
    tuning: t,
    septimalEnabled: tuning.septimalEnabled,
    equalEnabled: tuning.equalEnabled,
    septimalShift: tuning.septimalShift,
    /* qwertyTranspose removed from live state; preserved in snapshot schema
       as 0 for back-compat with older HKR readers. */
    qwertyTranspose: 0,
    septimalW: tuning.septimalW,
    instrument: audio.activeWaveform,
    pedalMode: pedal.mode,
    refHz: REF_HZ,
  };
}

/* True iff every tuning/instrument/pedal field of `s` matches live state. */
export function snapshotMatchesLive(s: LayoutSnapshot): boolean {
  return (
    s.curLayout === tuning.curLayout &&
    s.septimalEnabled === tuning.septimalEnabled &&
    s.equalEnabled === tuning.equalEnabled &&
    s.septimalShift === tuning.septimalShift &&
    /* qwertyTranspose no longer live; compare to fixed 0. */
    s.qwertyTranspose === 0 &&
    s.instrument === audio.activeWaveform &&
    s.pedalMode === pedal.mode
  );
}
