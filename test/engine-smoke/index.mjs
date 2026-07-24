// Standalone-consumption proof for @hkl/engine (Phase 6 acceptance).
//
// This package lives OUTSIDE apps/ and depends only on @hkl/engine. It imports
// the sample playback engine, asserts its public surface, and drives init()
// with a stub AudioContext + injected host dependencies — demonstrating the
// engine carries zero HKL app/state/MIDI coupling. (Actual audio playback of an
// .hki needs a browser AudioContext + decodeAudioData; that's the browser
// sandbox / Max's by-ear test, not this headless check.)
//
// Run: pnpm --filter @hkl/engine-smoke start

import * as engine from '@hkl/engine/samples-engine.js';
import { readHkiInstrument, instrumentDefFromManifest } from '@hkl/engine/hki-instrument.js';
import { readFileSync } from 'node:fs';

const REQUIRED = [
  'init', 'loadInstrument', 'sNoteOn', 'sNoteOff', 'sRampFreq',
  'sSetAftertouch', 'sSetVoiceDamperDepth', 'sSetVoicePan', 'isInstrumentLoaded',
  'inflightExpRampValue', 'pickLayer',
];
const missing = REQUIRED.filter((k) => typeof engine[k] !== 'function');
if (missing.length) throw new Error('@hkl/engine missing exports: ' + missing.join(', '));

// Minimal Web Audio stub — just enough for init() to build its gain graph.
const param = () => ({
  value: 1, setValueAtTime() {}, linearRampToValueAtTime() {},
  exponentialRampToValueAtTime() {}, cancelScheduledValues() {},
  setTargetAtTime() {}, setValueCurveAtTime() {},
});
const node = () => ({ gain: param(), connect() {}, disconnect() {} });
const ctx = {
  currentTime: 0, sampleRate: 44100,
  createGain: node,
  createBufferSource: () => ({ ...node(), buffer: null, playbackRate: param(), loopStart: 0, loopEnd: 0, start() {}, stop() {} }),
  createStereoPanner: () => ({ ...node(), pan: param() }),
  decodeAudioData: async () => ({ getChannelData: () => new Float32Array(0), numberOfChannels: 1, length: 0, sampleRate: 44100 }),
};

// One stub-decoded 'hki' instrument so the per-voice setters can be exercised
// against a live voice (decays:true keeps the loop scheduler out of play, so
// the process exits cleanly with no timers).
const PAN_DEF = {
  name: 'PanTest', source: 'hki', baseUrl: '', ext: '', releaseTime: 0.1,
  volume: 1, loop: false, decays: true,
  samples: [{ name: 'A3', file: 'a3.wav', freq: 220 }],
};

engine.init(ctx, node(), {
  instrumentProvider: async (k) => (k === 'pantest' ? { 'a3.wav': new Uint8Array(8) } : null),
  velocityToGain: (v) => v / 127,
  onSeamEvent: () => {},
});

const ramp = engine.inflightExpRampValue({ startVal: 0.0001, startTime: 0, targetVal: 1, endTime: 1 }, 0.5);

// ── pickLayer: discrete velocity-layer selection (.hki v2) ──
// Pure function; no AudioContext needed. Layers carry a `vel` reference velocity.
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`pickLayer: ${msg} — got ${actual}, expected ${expected}`);
}
{
  const L = [{ vel: 24, name: 'soft' }, { vel: 64, name: 'mid' }, { vel: 112, name: 'hard' }];
  assertEq(engine.pickLayer(L, 1).vel, 24, 'v=1 → softest');
  assertEq(engine.pickLayer(L, 20).vel, 24, 'v=20 → 24');
  assertEq(engine.pickLayer(L, 50).vel, 64, 'v=50 → 64');
  assertEq(engine.pickLayer(L, 90).vel, 112, 'v=90 → 112');
  assertEq(engine.pickLayer(L, 127).vel, 112, 'v=127 → loudest');
  // Tie at the exact midpoint (44 is equidistant from 24 and 64): strict `<`
  // keeps the lower-velocity layer.
  assertEq(engine.pickLayer(L, 44).vel, 24, 'v=44 (midpoint 24|64) → lower layer');
  // Single-layer parity: no `vel` on any entry → always the sole/first entry,
  // regardless of velocity (byte-identical to v1 behavior).
  const single = [{ name: 'only', freq: 440 }];
  assertEq(engine.pickLayer(single, 10).name, 'only', 'single-layer v=10');
  assertEq(engine.pickLayer(single, 127).name, 'only', 'single-layer v=127');
  // Multiple entries but none tagged with vel → first entry (defensive).
  const noVel = [{ name: 'a' }, { name: 'b' }];
  assertEq(engine.pickLayer(noVel, 100).name, 'a', 'untagged group → first');
}

// ── readHkiInstrument: atomic .hki → { key, def, audio } adapter ──
// Proves a single .hki is self-sufficient for an engine consumer: no separately
// authored defs JSON. Pure — no AudioContext needed (decode/playback is the
// browser check). Uses a real shipped-style bundle from handoff/musiquest/.
{
  const bytes = readFileSync(new URL('../../handoff/musiquest/piano.hki', import.meta.url));
  const { key, def, audio } = readHkiInstrument(new Uint8Array(bytes));
  assertEq(key, 'piano', 'readHkiInstrument key = manifest.instrumentKey');
  assertEq(def.source, 'hki', 'def.source routes to instrumentProvider');
  if (!def.name) throw new Error('readHkiInstrument: def.name is empty');
  if (!Array.isArray(def.samples) || def.samples.length === 0) {
    throw new Error('readHkiInstrument: def.samples empty');
  }
  // The self-wiring invariant: every sample the def names must have bytes in the
  // returned audio map, so `instrumentProvider: () => audio` fully feeds loadInstrument.
  for (const s of def.samples) {
    if (!(s.file in audio)) throw new Error(`readHkiInstrument: audio missing for ${s.file}`);
  }
  // instrumentKey is NOT leaked into the def (it's loadInstrument's first arg).
  if ('instrumentKey' in def) throw new Error('readHkiInstrument: instrumentKey leaked into def');
  // instrumentDefFromManifest is the exported building block; a bare-minimum
  // manifest maps to a playable single-layer def.
  const minDef = instrumentDefFromManifest({
    version: 2, instrumentKey: 'x', name: 'X', loop: false, decays: true,
    releaseTime: 0.2, volume: 1, samples: [{ name: 'A3', file: 'a.wav', freq: 220 }],
  });
  assertEq(minDef.source, 'hki', 'instrumentDefFromManifest source');
  assertEq(minDef.samples.length, 1, 'instrumentDefFromManifest passes samples through');
  console.log(`   readHkiInstrument: '${key}' → ${def.samples.length} samples, all audio present.`);
}

// ── sSetVoicePan: per-voice stereo pan (lazy StereoPannerNode) ──
// The panner must NOT exist until a pan is specified (unpanned voices keep the
// pre-pan graph byte-identical — mono transparency), must splice once and be
// reused, and must degrade to a silent no-op on hosts without createStereoPanner.
{
  await engine.loadInstrument('pantest', PAN_DEF);
  engine.sNoteOn('pv', 220, 90, 'pantest');
  const v = engine.getActiveVoices()['pv'];
  if (!v) throw new Error('pan: voice not created');
  if (v.panNode) throw new Error('pan: panner exists before any pan was set');
  engine.sSetVoicePan('pv', -0.5);
  if (!v.panNode) throw new Error('pan: sSetVoicePan did not splice a panner');
  const firstPanNode = v.panNode;
  engine.sSetVoicePan('pv', 1, 0.2); // ramped set must reuse the spliced node
  if (v.panNode !== firstPanNode) throw new Error('pan: panner recreated on second set');
  engine.sSetVoicePan('absent-voice', 0.3); // absent voice → silent no-op
  engine.sHardStop('pv');

  // note-on pan arg wires the panner at voice construction
  engine.sNoteOn('pv2', 220, 90, 'pantest', undefined, 0.7);
  if (!engine.getActiveVoices()['pv2'].panNode) throw new Error('pan: note-on pan arg did not create panner');
  engine.sHardStop('pv2');

  // feature-detect path: no createStereoPanner → no node, both entry points no-op
  const csp = ctx.createStereoPanner;
  delete ctx.createStereoPanner;
  engine.sNoteOn('pv3', 220, 90, 'pantest', undefined, 0.5);
  const v3 = engine.getActiveVoices()['pv3'];
  if (v3.panNode) throw new Error('pan: note-on created panner despite missing createStereoPanner');
  engine.sSetVoicePan('pv3', 0.5);
  if (v3.panNode) throw new Error('pan: setter created panner despite missing createStereoPanner');
  engine.sHardStop('pv3');
  ctx.createStereoPanner = csp;
  console.log('   sSetVoicePan: lazy splice, node reuse, note-on pan arg, no-op guards — all OK.');
}

console.log('OK — @hkl/engine imported + init() ran standalone (zero HKL app/state imports).');
console.log('   exports: ' + Object.keys(engine).sort().join(', '));
console.log('   inflightExpRampValue midpoint check: ' + ramp.toFixed(4) + ' (expect 0.0100)');
console.log('   pickLayer velocity-layer selection: all assertions passed.');
