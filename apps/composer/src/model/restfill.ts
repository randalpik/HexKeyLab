// Beat-aligned rest decomposition for autofill.
//
// Given a partial measure with `total` ticks of free space starting at offset
// `startTick`, emit a sequence of {dur, dots} for visible rests that fill the
// space without crossing beat boundaries. Beat unit:
//   - simple meter (2/4, 3/4, 4/4, ...): beat = meter.unit note.
//   - compound meter (6/8, 9/8, 12/8): beat = three meter.unit notes (dotted).
// Within a beat we emit the largest power-of-two (optionally single-dotted)
// rest that fits both the remaining-in-beat budget and the remaining-total
// budget. Double dots aren't used — they're correct but uncommon as autofill.

import type { Duration, Dots } from './index.js';
import type { TimeSigInfo } from '../notation/beams.js';

const REST_TABLE: ReadonlyArray<{ ticks: number; dur: Duration; dots: Dots }> = [
  { ticks: 24, dur: '4',  dots: 1 },   /* dotted quarter (compound beat) */
  { ticks: 16, dur: '4',  dots: 0 },   /* quarter */
  { ticks: 12, dur: '8',  dots: 1 },   /* dotted eighth */
  { ticks: 8,  dur: '8',  dots: 0 },   /* eighth */
  { ticks: 6,  dur: '16', dots: 1 },   /* dotted 16th */
  { ticks: 4,  dur: '16', dots: 0 },   /* 16th */
  { ticks: 3,  dur: '32', dots: 1 },   /* dotted 32nd */
  { ticks: 2,  dur: '32', dots: 0 },   /* 32nd */
  { ticks: 1,  dur: '64', dots: 0 },   /* 64th */
];

/** Ticks per beat for `ts`. Compound meters use a dotted beat (3 × unit). */
export function beatTicks(ts: TimeSigInfo): number {
  const base = 64 / ts.unit;
  return ts.isCompound ? base * 3 : base;
}

export function decomposeBeatAlignedRests(
  startTick: number,
  total: number,
  ts: TimeSigInfo,
): Array<{ dur: Duration; dots: Dots }> {
  const out: Array<{ dur: Duration; dots: Dots }> = [];
  if (total <= 0) return out;
  const bt = beatTicks(ts);
  let pos = startTick;
  let remaining = total;
  while (remaining > 0) {
    const beatOff = pos % bt;
    const spaceInBeat = bt - beatOff;
    const cap = Math.min(remaining, spaceInBeat);
    let picked = false;
    for (const entry of REST_TABLE) {
      if (entry.ticks <= cap) {
        out.push({ dur: entry.dur, dots: entry.dots });
        pos += entry.ticks;
        remaining -= entry.ticks;
        picked = true;
        break;
      }
    }
    if (!picked) break;
  }
  return out;
}
