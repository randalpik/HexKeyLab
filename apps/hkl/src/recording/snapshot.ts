// Layout snapshot: capture the current tuning / instrument state into a
// portable record, and check whether a stored snapshot matches
// live state. Applying a snapshot back to live state lives in apply.ts so this
// module stays leaf-position in the dep graph (capture.ts imports it).

import { tuning } from '../state/tuning.js';
import { audio } from '../state/audio.js';
import type { LayoutSnapshot } from './types.js';
import type { TuningMode } from '../state/persistence.js';

const REF_HZ = 220;

export function captureSnapshot(): LayoutSnapshot {
  const t: TuningMode = tuning.mode;
  return {
    tuning: t,
    mapping: tuning.mapping,
    anchor: tuning.anchor,
    banded: tuning.banded,
    septimalEnabled: tuning.septimalEnabled,
    equalEnabled: tuning.equalEnabled,
    septimalW: tuning.septimalW,
    instrument: audio.activeWaveform,
    /* every take records the sostenuto on cc64 (recording/types.ts PedalMode) */
    pedalMode: 'sostenuto',
    refHz: REF_HZ,
  };
}

/* True iff every tuning/mapping/instrument field of `s` matches live state.
   `pedalMode` says how to read the take's own pedal events and has no live
   counterpart: playback never touches the pedal jacks' roles. */
export function snapshotMatchesLive(s: LayoutSnapshot): boolean {
  return (
    s.tuning === tuning.mode &&
    s.mapping === tuning.mapping &&
    s.banded === tuning.banded &&
    s.instrument === audio.activeWaveform
  );
}
