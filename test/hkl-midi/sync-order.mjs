// Hardware-free ordering gate. Run with the repo's .js → .ts resolution hook:
// node --import ./test/orchestrator-smoke/register-ts.mjs test/hkl-midi/sync-order.mjs
import assert from 'node:assert/strict';
import { baseKeys } from '../../apps/hkl/src/layout/baseKeys.ts';
import { hexToScreen, setRotation } from '../../apps/hkl/src/layout/geometry.ts';
import { orderColorSync } from '../../apps/hkl/src/lumatone/sync-order.ts';
import { buildColorSysEx, setBoards34Swapped, sysexBoardFor } from '../../apps/hkl/src/lumatone/protocol.ts';

const all = Array.from({ length: 280 }, (_, i) => i);
const board = i => sysexBoardFor(Math.floor(i / 56));
setRotation('lumatone');
const positions = baseKeys.map(([q, r]) => hexToScreen(q, r));

function check(indices, previous) {
  const before = indices.slice();
  const ordered = orderColorSync(indices, previous);
  assert.deepEqual(indices, before, 'caller diff is unchanged');
  assert.deepEqual(ordered.slice().sort((a, b) => a - b), before.slice().sort((a, b) => a - b),
                   'each changed key sent exactly once');
  for (let n = 0; n < ordered.length; n++) {
    const index = ordered[n], remaining = ordered.slice(n);
    if (remaining.some(i => board(i) !== previous)) {
      assert.notEqual(board(index), previous, 'never repeat with another board pending');
    }
    const eligible = remaining.filter(i => board(i) !== previous);
    for (const other of eligible.length ? eligible : remaining) {
      const chosen = positions[index], candidate = positions[other];
      assert(chosen.sy <= candidate.sy + 1e-9, 'topmost eligible physical key first');
      if (Math.abs(chosen.sy - candidate.sy) < 1e-9) {
        assert(chosen.sx <= candidate.sx + 1e-9, 'left-to-right within a physical row');
      }
    }
    const packet = buildColorSysEx(board(index), index % 56, '#123456', index);
    assert.equal(packet[4], board(index));
    assert.equal(packet[6], index % 56);
    assert.equal(packet.keyIdx, index, 'logical ACK tracking survives routing');
    previous = board(index);
  }
  return ordered;
}

let cases = 0;
for (const swap of [false, true]) {
  setBoards34Swapped(swap);
  const full = check(all);
  assert(full.every((i, n) => !n || board(i) !== board(full[n - 1])), 'full wipe has no board repeats');
  assert(full.every((i, n) => !n || positions[i].sy >= positions[full[n - 1]].sy - 1e-9),
         'full wipe moves strictly top-to-bottom');
  for (const previous of [undefined, 0, 1, 2, 3, 4, 5]) {
    for (const changed of [[], [0], [0, 1, 2, 3, 55], [0, 1, 2, 56],
                           [0, 55, 56, 112, 168, 224, 279], all]) {
      check(changed, previous);
      cases++;
    }
    // Deterministic sparse/uneven diffs exercise board exhaustion and row jumps.
    for (let seed = 1; seed <= 20; seed++) {
      let state = seed;
      check(all.filter(() => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state % 10 < seed % 9 + 1;
      }), previous);
      cases++;
    }
  }
  for (const rotation of ['piano', 'verticalFreq', 'lumatone']) {
    setRotation(rotation);
    assert.deepEqual(orderColorSync(all), full, 'canvas rotation cannot change physical sweep');
  }
}
setBoards34Swapped(false);
console.log(`PASS: ${cases} full/sparse/in-flight ordering cases; both board maps; physical geometry and rotation independence`);
