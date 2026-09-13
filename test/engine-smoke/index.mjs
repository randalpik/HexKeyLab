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
  'inflightExpRampValue', 'pickLayer', 'findPerceptualOnset', 'bakeOnsetFade',
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

// ── findPerceptualOnset: load-time trim for decaying instruments ──
// Pure function over (Float32Array, sampleRate, gain). The Korg SP-250 audit
// (2026-09-12) showed real samples carry a low-level pre-strike segment that an
// amplitude gate trips on; the detector must skip it and start on the strike.
{
  const sr = 48000;
  const ms = (t) => Math.round(t * sr / 1000);
  // Synthetic note: 100 ms near-silence (−80 dBFS), 40 ms harmonic pre-strike
  // plateau ramping −30 → −15 dB rel. peak, then a strike (step to −3 dBFS,
  // exponential decay). Raw level is 1/gain of the normalized target so the
  // gain-normalization path is exercised.
  const mk = (gain, strikeAt, plateauMs) => {
    const n = ms(600), x = new Float32Array(n);
    let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
    for (let i = 0; i < n; i++) x[i] = 1e-4 * rnd() / gain;
    const peak = Math.pow(10, -3 / 20) / gain;
    for (let i = strikeAt - ms(plateauMs); i < strikeAt; i++) {
      const frac = (i - (strikeAt - ms(plateauMs))) / ms(plateauMs);
      const lvl = Math.pow(10, (-30 + 15 * frac) / 20) * peak;
      const t = i / sr; x[i] += lvl * (Math.sin(2 * Math.PI * 660 * t) + 0.5 * Math.sin(2 * Math.PI * 880 * t));
    }
    for (let i = strikeAt; i < n; i++) {
      const t = (i - strikeAt) / sr; let v = 0;
      for (let k = 1; k <= 8; k++) v += Math.sin(2 * Math.PI * 220 * k * t) / k;
      x[i] += peak * (v / 2.7) * Math.exp(-t / 0.8);
    }
    return x;
  };
  const near = (actual, expected, tolMs, msg) => {
    const d = (actual - expected) / sr * 1000;
    if (Math.abs(d) > tolMs) throw new Error(`findPerceptualOnset: ${msg} — landed ${d.toFixed(2)} ms from the strike (tol ±${tolMs})`);
  };
  // Loud layer (gain ≈ 2) with a 40 ms plateau: must land just before the strike, not on the plateau.
  { const strike = ms(140); const on = engine.findPerceptualOnset(mk(2.0, strike, 40), sr, 2.0); near(on, strike, 3, 'loud layer, 40 ms plateau'); if (on > strike) throw new Error('findPerceptualOnset: started after the strike'); }
  // Soft layer (gain 60×) with a 12 ms plateau: same landing.
  { const strike = ms(112); near(engine.findPerceptualOnset(mk(60, strike, 12), sr, 60), strike, 3, 'soft layer, 12 ms plateau'); }
  // Tightly pre-cut file (strike at sample 0, no plateau): onset within one envelope window of 0.
  { const x = mk(2.0, 0, 0); const on = engine.findPerceptualOnset(x, sr, 2.0); if (on > ms(2.5)) throw new Error(`findPerceptualOnset: pre-cut file started ${(on / sr * 1000).toFixed(2)} ms in`); }
  // Silence → 0; empty → 0.
  assertEq(engine.findPerceptualOnset(new Float32Array(ms(50)), sr, 1), 0, 'silent buffer → 0');
  assertEq(engine.findPerceptualOnset(new Float32Array(0), sr, 1), 0, 'empty buffer → 0');
  console.log('   findPerceptualOnset: plateau skipped, pre-cut parity, silence guards OK.');
}

// ── bakeOnsetFade: raised-cosine fade baked into the PCM from the onset ──
// Guards the live-input race where a clamped source.start begins before/after
// the segGain ramp: the first played sample must be zero regardless of timing.
{
  const sr = 48000, n = 2000, onset = 500;
  const chans = [new Float32Array(n).fill(1), new Float32Array(n).fill(-0.5)];
  const buf = { numberOfChannels: 2, length: n, sampleRate: sr, getChannelData: (c) => chans[c] };
  engine.bakeOnsetFade(buf, onset);
  const fn = Math.round(0.003 * sr);
  for (const [c, base] of [[0, 1], [1, -0.5]]) {
    const d = chans[c];
    if (d[onset - 1] !== base) throw new Error('bakeOnsetFade: touched samples before the onset');
    if (d[onset] !== 0) throw new Error(`bakeOnsetFade: first played sample is ${d[onset]}, expected 0`);
    for (let i = 1; i < fn; i++) if (Math.abs(d[onset + i]) <= Math.abs(d[onset + i - 1])) throw new Error('bakeOnsetFade: fade not strictly rising');
    if (d[onset + fn] !== base) throw new Error('bakeOnsetFade: fade ran past its length');
    if (Math.abs(d[onset + fn - 1]) < Math.abs(base) * 0.99) throw new Error('bakeOnsetFade: fade does not reach unity');
  }
  // Onset near the end / out of range: never throws, never writes out of bounds.
  engine.bakeOnsetFade({ numberOfChannels: 1, length: 10, sampleRate: sr, getChannelData: () => new Float32Array(10).fill(1) }, 9);
  engine.bakeOnsetFade(buf, n + 5);
  console.log('   bakeOnsetFade: zero first sample, strictly rising, untouched pre-onset, bounds OK.');
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
