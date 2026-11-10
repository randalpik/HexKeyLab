// Footprint-extent gate for the piano canvas height (render/canvas.ts).
//
// The canvas sizes the piano outline from tuning/picker.ts footprintExtents: per
// position in band, one footprint over relative MIDI −87…+87 that every ref's
// 88-cell footprint is a window of. This gate checks that claim and the height
// arithmetic against brute force, on every MAPPINGS layout × mode × banding:
//
//   A. reduction — refs of each position at MIDI 21…108 and rows −8, 0, +6: the
//      picker's footprint, relative to the ref, equals its position's window,
//      cell for cell (a step along the pure line or one band over, the anchor
//      following, preserves every relative interval);
//   B. heights — footprintHalfHeight equals the largest |sy(cell) − sy(MIDI 64's
//      cell)| over a brute-force footprint per (position, ref MIDI 21…108), under
//      four tilts (the arithmetic is tilt-generic; the tilts needn't match
//      layout/geometry.ts);
//   C. anchor offsets — under the Piano outline the ref can be Composer's cursor
//      note, d bands from the home band. The runtime measures the offsets
//      footprintAnchorOffsets names (0–3 in banded Syntonic, whose band offset is
//      periodic in d; 0 elsewhere, where it is linear or absent); every other
//      offset must reproduce one of those (Syntonic: 4 ≡ 0, −1 ≡ 3; elsewhere:
//      1 ≡ 2 ≡ 0).
//
// Run:
//   node --max-old-space-size=1024 --import ./test/orchestrator-smoke/register-ts.mjs test/picker/footprint-extent.mjs
//
// Exits non-zero on any mismatch.

import { TUNING_MODES, anchorOf, coordToMidi } from '../../packages/shared/src/freq.ts';
import { MAPPINGS, layoutOf, posInBandOf } from '../../packages/shared/src/mapping.ts';
import { pianoFootprint, footprintAnchorOffsets, footprintExtents, footprintHalfHeight } from '../../apps/hkl/src/tuning/picker.ts';

const hexR = 16, dxH = hexR * 1.78, dyH = hexR * 1.54;
const sy = (q, r, t) => -((q * dxH + r * dxH * 0.5) * Math.sin(t) + r * dyH * Math.cos(t));
function tilts(mapping) {
  const qStep = Math.log(2) * layoutOf(mapping).c / 12;
  const avgR = Math.log(3 / 2) - Math.log(81 / 80) / 12;
  const verticalFreq = Math.PI / 2 - Math.atan2((avgR - qStep / 2) / dyH, qStep / dxH);
  return [verticalFreq, Math.atan(dyH / (3 * dxH)), 0, 0.7];
}
const stateOf = (mapping, mode, banded) => ({
  mode, mapping, anchor: 0, banded,
  equalEnabled: mode === 'E', septimalEnabled: mode === '7', septimalW: 3,
});
/* a ref at `midi` in band position `pos`, on the row nearest r0 */
function refAt(mapping, pos, midi, r0) {
  const { c } = layoutOf(mapping);
  const rho = coordToMidi(0, 1, mapping) - 57;
  for (let a = 0; a < 60; a++) for (const r of a ? [r0 + a, r0 - a] : [r0]) {
    const n = midi - 57 - rho * r;
    if (n % c !== 0) continue;
    const q = n / c;
    if (posInBandOf(q, r, mapping) === pos) return [q, r];
  }
  throw new Error(`no ref: ${mapping} position ${pos} MIDI ${midi}`);
}
const footprintAt = (state, q, r) => pianoFootprint(q, r, { ...state, anchor: anchorOf(q, r, state.mapping) });

let failures = 0;
console.time('footprint-extent');
for (const banded of [true, false]) for (const mapping of MAPPINGS) {
  const line = [];
  for (const mode of TUNING_MODES) {
    const state = stateOf(mapping, mode, banded);
    const ext = footprintExtents(state);
    const T = tilts(mapping);
    let bad = 0;
    /* A */
    ext.forEach((E, j) => {
      const pos = posInBandOf(j, 0, mapping);
      for (const midi of [21, 30, 47, 64, 69, 81, 99, 108]) for (const r0 of [-8, 0, 6]) {
        const [rq, rr] = refAt(mapping, pos, midi, r0);
        footprintAt(state, rq, rr).forEach(([q, r], i) => {
          const e = E[21 + i - midi + 87];
          if (e[0] !== q - rq || e[1] !== r - rr) bad++;
        });
      }
    });
    /* B */
    const brute = T.map(() => 0);
    ext.forEach((_, j) => {
      const pos = posInBandOf(j, 0, mapping);
      for (let refMidi = 21; refMidi <= 108; refMidi++) {
        const [rq, rr] = refAt(mapping, pos, refMidi, 0);
        const cells = footprintAt(state, rq, rr);
        const [mq, mr] = cells[64 - 21];
        T.forEach((t, k) => {
          for (const [q, r] of cells) brute[k] = Math.max(brute[k], Math.abs(sy(q, r, t) - sy(mq, mr, t)));
        });
      }
    });
    const runtime = T.map((t) => footprintHalfHeight(ext, (q, r) => sy(q, r, t)));
    T.forEach((_, k) => { if (Math.abs(runtime[k] - brute[k]) > 1e-6) bad++; });
    /* C */
    let offBad = 0;
    const offs = footprintAnchorOffsets(state);
    const extAt = new Map(offs.map((d) => [d, d === 0 ? ext : footprintExtents(state, d)]));
    const probes = offs.length === 4 ? [[4, 0], [-1, 3]] : [[1, 0], [2, 0]];
    for (const [d, twin] of probes) {
      if (JSON.stringify(footprintExtents(state, d)) !== JSON.stringify(extAt.get(twin))) offBad++;
    }
    failures += bad + offBad;
    line.push(`${mode}:${bad + offBad === 0 ? '✓' : `✗${bad}/${offBad}`}`);
  }
  console.log(`${banded ? 'banded  ' : 'unbanded'} ${mapping.padEnd(11)} ${line.join(' ')}`);
}
console.timeEnd('footprint-extent');
console.log(failures === 0
  ? '\n✓ every footprint is its position\'s window; runtime heights match brute force; every anchor offset repeats a measured one'
  : `\n✗ ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
