import { baseKeys } from '../layout/baseKeys.js';
import { sysexBoardFor } from './protocol.js';

/** Physical top-to-bottom wipe, always alternating boards when possible. */
export function orderColorSync(indices: readonly number[], previousBoard?: number): number[] {
  const pending = indices.slice().sort((a, b) => {
    const [aq, ar] = baseKeys[a], [bq, br] = baseKeys[b];
    // In the Lumatone rotation, physical height is proportional to 2q + 7r.
    // Integer rows avoid floating-point tie errors; +q runs left-to-right
    // within a row. This is independent of the user's canvas rotation.
    return (2 * bq + 7 * br) - (2 * aq + 7 * ar) || aq - bq;
  });
  const ordered: number[] = [];
  while (pending.length) {
    // Board alternation outranks the wipe: a sparse diff may briefly step
    // down a row to avoid repeating a board. No padding/no-op writes.
    const other = pending.findIndex(i => sysexBoardFor(Math.floor(i / 56)) !== previousBoard);
    const [index] = pending.splice(other < 0 ? 0 : other, 1);
    ordered.push(index);
    previousBoard = sysexBoardFor(Math.floor(index / 56));
  }
  return ordered;
}
