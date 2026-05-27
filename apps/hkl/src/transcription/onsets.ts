// .hkr event stream → paired Onsets. on/off events are matched FIFO per
// (q,r). Unreleased onsets (the recording was stopped while the key was
// down) get tOff = session.durationSec. v1 ignores pa / cc4 / cc64 / warn.

import type { HkrSession } from '../recording/types.js';
import type { Onset } from './types.js';
import { darkColorHex } from './pitch.js';
import { coordToMidi } from '@hkl/shared/freq.js';

/** Window (seconds) for the density-bonus that nudges chord roots up in onset strength. */
const DENSITY_WINDOW_SEC = 0.030;

export function hkrToOnsets(session: HkrSession): Onset[] {
  const onsets: Onset[] = [];
  const held: Map<string, Onset[]> = new Map();
  let nextId = 0;

  for (const ev of session.events) {
    if (ev.k === 'on') {
      const onset: Onset = {
        id: nextId++,
        t: ev.t,
        tOff: null,
        q: ev.q,
        r: ev.r,
        midi: coordToMidi(ev.q, ev.r),
        v: ev.v,
        strength: ev.v / 127,
        colorHex: darkColorHex(ev.q, ev.r),
      };
      onsets.push(onset);
      const key = ev.q + ',' + ev.r;
      const queue = held.get(key);
      if (queue) queue.push(onset);
      else held.set(key, [onset]);
    } else if (ev.k === 'off') {
      const key = ev.q + ',' + ev.r;
      const queue = held.get(key);
      if (queue && queue.length > 0) {
        const o = queue.shift();
        if (o) o.tOff = ev.t;
      }
    }
  }

  /* Stragglers (never released): pin to session end so quantize has a duration. */
  for (const queue of held.values()) {
    for (const o of queue) {
      if (o.tOff === null) o.tOff = session.durationSec;
    }
  }

  /* Density bonus — onsets in dense regions are more likely to be beats. */
  onsets.sort((a, b) => a.t - b.t);
  for (let i = 0; i < onsets.length; i++) {
    let peers = 0;
    for (let j = i + 1; j < onsets.length; j++) {
      if (onsets[j].t - onsets[i].t > DENSITY_WINDOW_SEC) break;
      peers++;
    }
    for (let j = i - 1; j >= 0; j--) {
      if (onsets[i].t - onsets[j].t > DENSITY_WINDOW_SEC) break;
      peers++;
    }
    onsets[i].strength += Math.min(0.5, peers * 0.1);
  }

  return onsets;
}
