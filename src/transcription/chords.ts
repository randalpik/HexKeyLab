// Onset clustering. Onsets whose onset time is within CHORD_WINDOW_SEC of
// the first member of the current cluster collapse into a single ChordEvent.
// "First member" rather than "last member" anchoring prevents transitive
// drift through near-30 ms IOIs (e.g. fast 32nd runs).

import type { Onset, ChordEvent } from './types.js';

const CHORD_WINDOW_SEC = 0.030;

export function groupChords(onsets: Onset[]): ChordEvent[] {
  if (onsets.length === 0) return [];

  const sorted = [...onsets].sort((a, b) => a.t - b.t);
  const groups: Onset[][] = [];
  let cur: Onset[] = [sorted[0]];
  let anchor = sorted[0].t;

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].t - anchor <= CHORD_WINDOW_SEC) {
      cur.push(sorted[i]);
    } else {
      groups.push(cur);
      cur = [sorted[i]];
      anchor = sorted[i].t;
    }
  }
  groups.push(cur);

  return groups.map<ChordEvent>((g) => {
    const ts = g.map((o) => o.t).sort((a, b) => a - b);
    const median = ts[Math.floor(ts.length / 2)];
    let maxOff = -Infinity;
    for (const o of g) {
      if (o.tOff !== null && o.tOff > maxOff) maxOff = o.tOff;
    }
    if (!Number.isFinite(maxOff)) maxOff = median;
    return { t: median, tOff: maxOff, onsets: g };
  });
}
