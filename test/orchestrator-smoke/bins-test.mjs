#!/usr/bin/env node
// Deterministic unit test for the discovery bin-detector (pure logic, no audio).
// detectBins() is the algorithm that turns a velocity sweep of fingerprints into
// velocity-layer boundaries; here we feed hand-built fingerprints so the result
// is exact and flake-free (the loopback-through-headless-audio smoke is too noisy
// to assert boundary positions on). Node v22+ strips the TS types on import.
//
//   node test/orchestrator-smoke/bins-test.mjs

import { detectBins, evenBins, binsFromBoundaries } from '../../apps/orchestrator/src/discovery/bins.ts';

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log('  ok: ' + msg); }
  else { console.error('  FAIL: ' + msg); failures++; }
}

// Build a fingerprint whose band energy bump + centroid + level track `bright`∈[0,1].
function fp(velocity, bright, jitter = 0) {
  const N = 24;
  const center = bright * 20 + 2;
  const bands = new Array(N).fill(0);
  let sum = 0;
  for (let b = 0; b < N; b++) { const d = b - center; const e = Math.exp(-(d * d) / 8) + jitter; bands[b] = e; sum += e; }
  for (let b = 0; b < N; b++) bands[b] /= sum;
  return { velocity, bands, centroidHz: 200 + bright * 4000, levelDb: -40 + bright * 30 };
}

const sweepVels = [1, 17, 33, 49, 65, 81, 97, 113, 127];

// 1. Layered device: 3 layers split at ~43 and ~85 (flat within, jump between).
{
  const layerBright = v => (v <= 43 ? 0.2 : v <= 85 ? 0.5 : 0.8);
  const fps = sweepVels.map(v => fp(v, layerBright(v)));
  const r = detectBins(fps);
  check(r.detected, 'layered → detected');
  check(r.boundaries.length === 2, `layered → 2 boundaries (got ${r.boundaries.length}: [${r.boundaries}])`);
  check(r.boundaries.some(b => Math.abs(b - 41) <= 10), `boundary near 41 (got [${r.boundaries}])`);
  check(r.boundaries.some(b => Math.abs(b - 89) <= 10), `boundary near 89 (got [${r.boundaries}])`);
  check(r.bins.length === 3, `→ 3 velocity layers (got ${r.bins.length})`);
}

// 2. Flat device: every probe identical → no boundaries → even-bin fallback.
{
  const fps = sweepVels.map(v => fp(v, 0.5));
  const r = detectBins(fps);
  check(!r.detected, 'flat → not detected');
  check(r.boundaries.length === 0, `flat → 0 boundaries (got [${r.boundaries}])`);
  check(r.bins.length === 4, `flat → 4 even bins (got ${r.bins.length})`);
}

// 3. Flat + tiny noise: absFloor must suppress noise-driven false boundaries.
{
  const fps = sweepVels.map((v, i) => fp(v, 0.5, 1e-4 * ((i * 7) % 5 - 2)));
  const r = detectBins(fps);
  check(!r.detected, 'flat+noise → not detected (absFloor suppresses)');
}

// 4. Single sharp boundary at the midpoint.
{
  const fps = sweepVels.map(v => fp(v, v <= 65 ? 0.2 : 0.8));
  const r = detectBins(fps);
  check(r.detected && r.boundaries.length === 1, `single jump → 1 boundary (got [${r.boundaries}])`);
}

// 5. Helpers.
{
  const even = evenBins(4);
  check(even.length === 4 && even[0].lo === 1 && even[3].hi === 127, 'evenBins(4) spans 1..127');
  const fromB = binsFromBoundaries([43, 85]);
  check(fromB.length === 3 && fromB[0].lo === 1 && fromB[1].lo === 44 && fromB[2].hi === 127, 'binsFromBoundaries([43,85]) → 3 layers');
  check(even.every(b => b.sampleVel >= b.lo && b.sampleVel <= b.hi), 'sampleVel within each bin');
}

if (failures) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1); }
console.log('\nOK — detectBins: all assertions passed.');
