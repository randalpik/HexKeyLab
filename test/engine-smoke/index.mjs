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
  'setLayerBlend', 'getLayerBlend', 'blendedGain', 'timbreCutoff', 'timbreMakeup',
];
const missing = REQUIRED.filter((k) => typeof engine[k] !== 'function');
if (missing.length) throw new Error('@hkl/engine missing exports: ' + missing.join(', '));

// Minimal Web Audio stub — just enough for init() to build its gain graph.
const filters = []; // every BiquadFilterNode the engine creates
const gains = [];   // every GainNode, with the ramps and curves scheduled on its gain
const param = () => {
  const p = {
    value: 1, ramps: [], curves: [], setValueAtTime() {}, linearRampToValueAtTime(v) { p.ramps.push(v); },
    exponentialRampToValueAtTime() {}, cancelScheduledValues() {},
    setTargetAtTime() {}, setValueCurveAtTime(c) { p.curves.push(c); },
  };
  return p;
};
const node = () => ({ gain: param(), connect() {}, disconnect() {} });
const ctx = {
  currentTime: 0, sampleRate: 44100,
  createGain: () => { const g = node(); gains.push(g); return g; },
  createBufferSource: () => ({ ...node(), buffer: null, playbackRate: param(), loopStart: 0, loopEnd: 0, start() {}, stop() {} }),
  createStereoPanner: () => ({ ...node(), pan: param() }),
  createBiquadFilter: () => { const f = { ...node(), type: 'lowpass', frequency: param(), Q: param(), connected: 0, connect() { f.connected++; } }; filters.push(f); return f; },
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
  instrumentProvider: async (k) => (k === 'pantest' || k === 'timbretest' || k === 'makeuptest' || k === 'makeupplain' ? { 'a3.wav': new Uint8Array(8) } : null),
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

// ── layer blend: log-linear blend between level-matched and sones-matched gains ──
{
  const two = { gain: 2, gainLevel: 8 };
  const close = (a, b, msg) => { if (Math.abs(a - b) > 1e-9) throw new Error(`layerBlend: ${msg} — got ${a}, expected ${b}`); };
  close(engine.blendedGain(two, 0), 8, 't=0 → gainLevel');
  close(engine.blendedGain(two, 1), 2, 't=1 → gain');
  close(engine.blendedGain(two, 0.5), 4, 't=0.5 → geometric mean');
  close(engine.blendedGain({ gain: 3 }, 0), 3, 'no gainLevel → gain regardless of t');
  close(engine.blendedGain({ gain: 3, gainLevel: 0 }, 0), 3, 'non-positive gainLevel ignored');
  close(engine.blendedGain({}, 0.3), 1, 'no gains → 1.0');
  engine.setLayerBlend(0.25); close(engine.getLayerBlend(), 0.25, 'setter/getter');
  close(engine.blendedGain(two), Math.pow(8, 0.75) * Math.pow(2, 0.25), 'default t = module setting');
  engine.setLayerBlend(7); close(engine.getLayerBlend(), 1, 'clamp high');
  engine.setLayerBlend(-1); close(engine.getLayerBlend(), 0, 'clamp low');
  engine.setLayerBlend(NaN); close(engine.getLayerBlend(), 1, 'NaN → 1');
  engine.setLayerBlend(1);
  console.log('   layer blend: endpoints, geometric midpoint, fallbacks, clamps OK.');
}

// ── readHkiInstrument: atomic .hki → { key, def, audio } adapter ──
// Proves a single .hki is self-sufficient for an engine consumer: no separately
// authored defs JSON. Pure — no AudioContext needed (decode/playback is the
// browser check). Uses a real shipped bundle from public/samples/.
{
  const bytes = readFileSync(new URL('../../public/samples/viola.hki', import.meta.url));
  const { key, def, audio } = readHkiInstrument(new Uint8Array(bytes));
  assertEq(key, 'viola', 'readHkiInstrument key = manifest.instrumentKey');
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

// ── brightness curve (HkiTimbre): one lowpass per voice, set from the note's level ──
// An instrument with a curve plays its single sample through a 12 dB/oct lowpass whose
// cutoff comes from the level the note sounds at; the level itself is the voice's gain
// as for any instrument. The curve here is the one fitted to the Korg SP-250 bundle.
{
  const curve = { type: 'lowpass12', points: [
    { gainDb: -22.9, cutoffHz: 364 }, { gainDb: -14.4, cutoffHz: 795 }, { gainDb: -8.5, cutoffHz: 1514 },
    { gainDb: -3.7, cutoffHz: 5007 }, { gainDb: 0, cutoffHz: 20000 }] };
  const lvl = (d) => Math.pow(10, d / 20);
  const close = (a, b, msg) => { if (!(Math.abs(a - b) <= 1e-6 * Math.abs(b))) throw new Error(`timbre: ${msg} — got ${a}, expected ${b}`); };
  for (const pt of curve.points.slice(0, -1)) close(engine.timbreCutoff(curve, lvl(pt.gainDb)), pt.cutoffHz, `at ${pt.gainDb} dB`);
  close(engine.timbreCutoff(curve, lvl(-11.45)), Math.sqrt(795 * 1514), 'midway between two points: the geometric mean');
  close(engine.timbreCutoff(curve, lvl(-31.4)), 364 * 364 / 795, 'below the first point: the first segment continued');
  assertEq(engine.timbreCutoff(curve, 1), Infinity, 'full level, the last point: no filter');
  assertEq(engine.timbreCutoff(curve, lvl(6)), Infinity, 'above the last point: no filter');
  close(engine.timbreCutoff(curve, lvl(-1.85)), Math.sqrt(5007 * 20000), 'just under it the curve heads for the last point\'s cutoff');
  assertEq(engine.timbreCutoff(curve, 0), engine.TIMBRE_MIN_HZ, 'level 0 → the floor');
  assertEq(engine.timbreCutoff(curve, 1e-9), engine.TIMBRE_MIN_HZ, 'a vanishing level → the floor');
  let prev = 0;
  for (let d = -60; d < 0; d += 0.25) { const fc = engine.timbreCutoff(curve, lvl(d)); if (fc < prev) throw new Error(`timbre: cutoff fell as the level rose at ${d} dB`); prev = fc; }
  if (Math.abs(engine.TIMBRE_LOWPASS_Q_DB + 3.0103) > 1e-4) throw new Error('timbre: the lowpass Q is not linear 0.7071 in dB (−3.01)');

  // The manifest field is carried into the def (its validation and round trip: test/hki-timbre).
  const manifest = { version: 2, instrumentKey: 't', name: 'T', loop: false, decays: true, releaseTime: 0.2, volume: 1,
    samples: [{ name: 'A3', file: 'a.wav', freq: 220 }], timbre: curve };
  if (instrumentDefFromManifest(manifest).timbre !== curve) throw new Error('timbre: not carried into the InstrumentDef');
  const { timbre: _none, ...plain } = manifest;
  if ('timbre' in instrumentDefFromManifest(plain)) throw new Error('timbre: a def without a curve has a timbre key');
  // The voice: a soft note gets one lowpass with the curve's cutoff; a note at full level, and an
  // instrument with no curve, get none (their graph is what it was).
  await engine.loadInstrument('timbretest', { ...PAN_DEF, name: 'TimbreTest', timbre: curve });
  await engine.loadInstrument('pantest', PAN_DEF);
  filters.length = 0;
  engine.sNoteOn('tv', 220, 40, 'timbretest');
  assertEq(filters.length, 1, 'timbre: one filter for a soft note');
  assertEq(filters[0].type, 'lowpass', 'timbre: filter type');
  close(filters[0].Q.value, engine.TIMBRE_LOWPASS_Q_DB, 'filter Q');
  close(filters[0].frequency.value, engine.timbreCutoff(curve, 40 / 127), 'filter cutoff = the curve at the house gain of velocity 40');
  assertEq(filters[0].connected, 1, 'timbre: the filter is wired on into the voice chain');
  engine.sHardStop('tv');
  engine.sNoteOn('tv2', 220, 127, 'timbretest');
  assertEq(filters.length, 1, 'timbre: no filter at full level (at the curve\'s last point the sample plays as stored)');
  engine.sHardStop('tv2');
  engine.sNoteOn('tv2', 220, 126, 'timbretest');
  assertEq(filters.length, 2, 'timbre: just under full level there is a filter');
  if (!(filters[1].frequency.value <= ctx.sampleRate * engine.TIMBRE_OPEN_FRACTION)) throw new Error('timbre: cutoff above the cap for the sample rate');
  filters.length = 1;
  engine.sHardStop('tv2');
  engine.sNoteOn('tv3', 220, 40, 'pantest');
  assertEq(filters.length, 1, 'timbre: no filter for an instrument without a curve');
  engine.sHardStop('tv3');
  console.log('   brightness curve: lookup at / between / below / above its points, carried into the def, one lowpass per soft voice — all OK.');

  // ── the level the lowpass takes from a note is put back ──
  // A sample of an instrument with a curve carries, for each cutoff of the curve's grid
  // (`timbre.makeupHz`), the dB its filter takes there (`timbreMakeupDb`); the voice's gain is
  // multiplied by it, read at the cutoff divided by the playback rate (the sample is repitched
  // before the filter).
  const hz = [100, 1000, 10000], dbs = [12, 6, 0], lin = (d) => Math.pow(10, d / 20);
  close(engine.timbreMakeup(hz, dbs, 100), lin(12), 'makeup at the first grid cutoff');
  close(engine.timbreMakeup(hz, dbs, 1000), lin(6), 'makeup at a grid cutoff');
  close(engine.timbreMakeup(hz, dbs, Math.sqrt(100 * 1000)), lin(9), 'midway between two cutoffs in log frequency: the mean in dB');
  close(engine.timbreMakeup(hz, dbs, 30), lin(12), 'under the grid: its first value');
  assertEq(engine.timbreMakeup(hz, dbs, 20000), 1, 'over the grid: its last value');
  assertEq(engine.timbreMakeup(hz, dbs, Infinity), 1, 'no filter, nothing to put back');
  assertEq(engine.timbreMakeup(hz, null, 1000), 1, 'a sample with no list plays as it is');
  assertEq(engine.timbreMakeup(undefined, dbs, 1000), 1, 'a curve with no grid: as it is');
  assertEq(engine.timbreMakeup(hz, [12, 6], 1000), 1, 'a list that does not match the grid: as it is');

  const MK = { ...PAN_DEF, samples: [{ name: 'A3', file: 'a3.wav', freq: 220, gain: 0.5, timbreMakeupDb: dbs }] };
  await engine.loadInstrument('makeuptest', { ...MK, name: 'MakeupTest', timbre: { ...curve, makeupHz: hz } });
  await engine.loadInstrument('makeupplain', { ...MK, name: 'MakeupPlain' });
  const struck = (fn) => { gains.length = 0; fn(); return gains.flatMap((g) => g.gain.ramps); };
  const faded = (fn) => { gains.length = 0; fn(); return gains.flatMap((g) => g.gain.curves).map((c) => Math.max(...c)); };
  const only = (a, want, msg) => { if (a.length !== 1) throw new Error(`timbre: ${msg} — ${a.length} gains scheduled, expected 1`); close(a[0], want, msg); };
  const fc40 = engine.timbreCutoff(curve, 40 / 127), down = 220 * Math.pow(2, -1.5 / 12);
  only(struck(() => engine.sNoteOn('mk1', 220, 40, 'makeuptest')), 40 / 127 * 0.5 * engine.timbreMakeup(hz, dbs, fc40), 'voice gain = house gain × sample gain × the add-back at its cutoff');
  engine.sHardStop('mk1');
  only(struck(() => engine.sNoteOn('mk2', down, 40, 'makeuptest')), 40 / 127 * 0.5 * engine.timbreMakeup(hz, dbs, fc40 * 220 / down), 'a repitched note reads the add-back at cutoff ÷ playback rate');
  engine.sHardStop('mk2');
  if (Math.abs(engine.timbreMakeup(hz, dbs, fc40 * 220 / down) / engine.timbreMakeup(hz, dbs, fc40) - 1) < 0.01) throw new Error('timbre: the repitch check cannot tell the two readings apart');
  only(struck(() => engine.sNoteOn('mk3', 220, 127, 'makeuptest')), 0.5, 'at full level: no filter, and the gain it always had');
  engine.sHardStop('mk3');
  only(struck(() => engine.sNoteOn('mk4', 220, 40, 'makeupplain')), 40 / 127 * 0.5, 'an instrument without a curve ignores the list');
  engine.sHardStop('mk4');
  only(faded(() => engine.sNoteOnFaded('mk5', 220, 40 / 127, 0.1, 'makeuptest')), 40 / 127 * 0.5 * engine.timbreMakeup(hz, dbs, fc40), 'the faded note-on path: the same gain');
  engine.sHardStop('mk5');
  only(faded(() => engine.sNoteOnFaded('mk6', 220, 40 / 127, 0.1, 'makeupplain')), 40 / 127 * 0.5, 'the faded path without a curve');
  engine.sHardStop('mk6');
  console.log('   brightness curve add-back: lookup at / between / outside the grid, in the gain of both note-on paths, at cutoff ÷ rate, absent at full level and without a curve — all OK.');
}

console.log('OK — @hkl/engine imported + init() ran standalone (zero HKL app/state imports).');
console.log('   exports: ' + Object.keys(engine).sort().join(', '));
console.log('   inflightExpRampValue midpoint check: ' + ramp.toFixed(4) + ' (expect 0.0100)');
console.log('   pickLayer velocity-layer selection: all assertions passed.');
