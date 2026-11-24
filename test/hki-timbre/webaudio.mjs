// Browser gate for the engine's brightness-curve voice: does a real BiquadFilterNode, wired
// by the real engine, compute the filter the curve was fitted with?
//
// apps/analyzer/cli/hki-timbre.mjs fits an instrument's curve with the lowpass of the Web
// Audio spec at the engine's Q (TIMBRE_LOWPASS_Q_DB; for a lowpass the node's Q is in dB), and
// the engine sets one such node per voice from the level a note sounds at. This renders the
// same sample through the engine in an OfflineAudioContext, as an instrument with a curve and
// as one without, and requires the first to be the second put through that filter, sample for
// sample, at the cutoff the curve gives for the note's level, times the level put back for
// that cutoff (the sample's `timbreMakeupDb`, read at cutoff ÷ playback rate).
//
// Then the whole chain: apps/analyzer/cli/hki-timbre.mjs is run on a synthetic layered bundle,
// its output is loaded through the engine's own `.hki` reader, and every note is rendered at
// several velocities and pitches with the curve and without it. The tool is run with
// `--match level`, which puts back the level the filter takes and nothing else, so the two must
// have the same K-weighted level over the first 400 ms. (The tool's default adds a loudness
// part taken from the source's two gains; that sum is checked in run.mjs, and the engine
// applies whatever the list holds, which W3, W7 and this part show.)
//
// Requires `pnpm dev` running (umbrella proxy at :5170): the engine module is imported from
// the dev server, as its own instance. Nothing is played: the context is offline, and the
// shared launcher mutes the browser anyway.
//
//   node test/hki-timbre/webaudio.mjs      # exits non-zero on any failure
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeHki } from '../../packages/shared/src/hki.ts';
import { layeredBundle } from './synth.mjs';
import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { CDP } from '../composer-test/lib/cdp.mjs';
import { isolatedHklUrl } from '../composer-test/lib/private-relay.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const URL = await isolatedHklUrl(process.env.HKL_URL ?? 'http://localhost:5170/');
const ENGINE = '/@fs' + REPO + '/packages/engine/src/samples-engine.ts?gate=timbre';
const HKI_INSTRUMENT = '/@fs' + REPO + '/packages/engine/src/hki-instrument.ts?gate=timbre';
const K_WEIGHTING = '/@fs' + REPO + '/packages/analysis/src/k-weighting.js?gate=timbre';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The tool's own output for a small synthetic layered bundle: three notes two octaves apart,
   0.9 s each. */
const TOOL_NOTES = [['A2', 110], ['A4', 440], ['A6', 1760]];
const toolBundle = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkl-hki-timbre-web-'));
  try {
    const inPath = path.join(dir, 'in.hki'), outPath = path.join(dir, 'out.hki');
    fs.writeFileSync(inPath, writeHki(layeredBundle({}, { notes: TOOL_NOTES, seconds: 0.9 })));
    const r = spawnSync('node', ['--max-old-space-size=1024', path.join(REPO, 'apps/analyzer/cli/hki-timbre.mjs'), inPath, '--out', outPath, '--match', 'level'], { encoding: 'utf8' });
    if (r.status !== 0) { console.log('FAILED TO RUN: hki-timbre.mjs on the synthetic bundle\n' + r.stderr); process.exit(1); }
    return fs.readFileSync(outPath).toString('base64');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

const SCRIPT = `(async () => {
  const engine = await import(${JSON.stringify(ENGINE)});
  const SR = 48000, results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail) });
  const house = (v) => 0.05 + 0.95 * Math.pow(v / 127, 1.5); // HKL's velocity → gain
  /* The curve hki-timbre.mjs fits to the Korg SP-250 bundle. */
  const curve = { type: 'lowpass12', points: [
    { gainDb: -24.94, cutoffHz: 431 }, { gainDb: -15.3, cutoffHz: 863 }, { gainDb: -9.1, cutoffHz: 1690 },
    { gainDb: -3.8, cutoffHz: 5510 }, { gainDb: 0, cutoffHz: 20000 }],
    /* A made-up, steep list of level to put back, so that a wrong reading of it shows. */
    makeupHz: [100, 1000, 10000] };
  const MAKEUP_DB = [12, 6, 0];
  /* The gate's own reading of the list: linear in dB against log frequency, held at its ends. */
  const makeup = (hz) => {
    const g = curve.makeupHz, d = MAKEUP_DB, u = Math.min(Math.max(hz, g[0]), g[g.length - 1]);
    let i = 1; while (i < g.length - 1 && u > g[i]) i++;
    return Math.pow(10, (d[i - 1] + (d[i] - d[i - 1]) * Math.log(u / g[i - 1]) / Math.log(g[i] / g[i - 1])) / 20);
  };

  /* One sample: 0.1 s of near silence, then a bright decaying tone at 220 Hz. */
  const n = Math.round(1.1 * SR), pre = Math.round(0.1 * SR), x = new Float32Array(n);
  let seed = 99; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  for (let i = 0; i < n; i++) x[i] = 1e-6 * rnd();
  for (let k = 1; k <= 70; k++) {
    const amp = Math.pow(k, -0.5), ph = Math.PI * rnd(), tau = 0.9 / (1 + 0.05 * k);
    for (let i = pre; i < n; i++) { const t = (i - pre) / SR; x[i] += 0.05 * amp * Math.sin(2 * Math.PI * 220 * k * t + ph) * Math.exp(-t / tau); }
  }
  const wav = new ArrayBuffer(44 + n * 4), dv = new DataView(wav);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); tag(8, 'WAVE'); tag(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 3, true); dv.setUint16(22, 1, true); dv.setUint32(24, SR, true); dv.setUint32(28, SR * 4, true);
  dv.setUint16(32, 4, true); dv.setUint16(34, 32, true); tag(36, 'data'); dv.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) dv.setFloat32(44 + i * 4, x[i], true);

  const def = (timbre) => ({ name: 'T', source: 'hki', baseUrl: '', ext: '', releaseTime: 0.15, volume: 1, loop: false, decays: true,
    samples: [{ name: 'A3', file: 'a3.wav', freq: 220, gain: 1, timbreMakeupDb: MAKEUP_DB }], ...(timbre ? { timbre } : {}) });

  /* Every note of both instruments in one offline render, each in its own slot. Slot
     times are whole multiples of 1/128 s: exact in binary and a whole number of samples
     at 48 kHz, so the engine's own snap of a start time (up to the next sample) lands
     where the slot is cut. */
  const VELS = [8, 20, 40, 64, 90, 110, 126, 127], SLOT = 205 / 128, LEN = 1.4;
  /* The same sample a semitone and a half down, the most a note of a minor-third-spaced
     instrument is repitched: two more velocities, after the others. */
  const DOWN = 220 * Math.pow(2, -1.5 / 12), DOWN_VELS = [40, 90];
  const ctx = new OfflineAudioContext(1, Math.ceil(SR * (0.2 + SLOT * (VELS.length + DOWN_VELS.length) * 2)), SR);
  engine.init(ctx, ctx.destination, { instrumentProvider: async () => ({ 'a3.wav': new Uint8Array(wav.slice(0)) }), velocityToGain: house });
  await engine.loadInstrument('plain', def(null));
  await engine.loadInstrument('curve', def(curve));
  const at = (i, which) => 13 / 128 + SLOT * (2 * i + which);
  VELS.forEach((v, i) => { engine.sNoteOn('p' + v, 220, v, 'plain', at(i, 0)); engine.sNoteOn('c' + v, 220, v, 'curve', at(i, 1)); });
  DOWN_VELS.forEach((v, j) => { const i = VELS.length + j; engine.sNoteOn('pd' + v, DOWN, v, 'plain', at(i, 0)); engine.sNoteOn('cd' + v, DOWN, v, 'curve', at(i, 1)); });
  const out = (await ctx.startRendering()).getChannelData(0);
  const seg = (t) => out.subarray(Math.round(t * SR), Math.round((t + LEN) * SR));

  /* The spec's lowpass, run sample by sample in double precision. qDb is the node's Q. */
  const lowpass = (p, fc, qDb) => {
    const w0 = 2 * Math.PI * fc / SR, c = Math.cos(w0), al = Math.sin(w0) / (2 * Math.pow(10, qDb / 20)), a0 = 1 + al;
    const b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0, y = new Float64Array(p.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < p.length; i++) { const v = b0 * p[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = p[i]; y2 = y1; y1 = v; y[i] = v; }
    return y;
  };
  const peak = (a) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i])); return m; };
  const apart = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

  const full = seg(at(VELS.indexOf(127), 0));
  check('W0: the plain instrument sounds', peak(full) > 0.01, 'peak ' + peak(full));
  VELS.forEach((v, i) => {
    const p = seg(at(i, 0)), c = seg(at(i, 1)), pk = peak(p), level = house(v);
    /* An instrument without a curve: the level is the house gain, nothing else. */
    const scaled = Float64Array.from(full, (s) => s * level / house(127));
    check('W1 v' + v + ': without a curve the note is the full-level note times the house gain', apart(p, scaled) / pk < 1e-4, (apart(p, scaled) / pk).toExponential(2));
    const fc = engine.timbreCutoff(curve, level);
    if (!isFinite(fc)) {
      check('W2 v' + v + ': at the top of the curve the voice has no filter (identical to the plain one)', apart(c, p) / pk < 1e-6, (apart(c, p) / pk).toExponential(2));
      return;
    }
    const used = Math.min(fc, SR * engine.TIMBRE_OPEN_FRACTION), mk = makeup(used), times = (a) => a.map((s) => s * mk);
    const err = apart(c, times(lowpass(p, used, engine.TIMBRE_LOWPASS_Q_DB))) / (pk * mk);
    check('W3 v' + v + ': the curve voice is the plain voice through the fitted lowpass at ' + Math.round(used) + ' Hz, times the level put back there (' + (20 * Math.log10(mk)).toFixed(2) + ' dB)', err < 1e-4, err.toExponential(2));
    /* The check can tell: a cutoff 5 % off, or the Q read as a linear 0.7071, does not match. */
    const off = apart(c, times(lowpass(p, used * 1.05, engine.TIMBRE_LOWPASS_Q_DB))) / (pk * mk);
    const lin = apart(c, times(lowpass(p, used, 0.7071))) / (pk * mk);
    if (used < 12000) {
      check('W4 v' + v + ': a cutoff 5 % higher does not match', off > 20 * err && off > 1e-3, off.toExponential(2));
      check('W5 v' + v + ': Q taken as 0.7071 dB instead of linear 0.7071 does not match', lin > 20 * err && lin > 1e-3, lin.toExponential(2));
    }
    /* The fundamental, far under the cutoff, passes the filter whole and is raised by the level put back. */
    if (used > 800) {
      const amp = (a) => { let re = 0, im = 0; for (let k = 4800; k < 4800 + 9600; k++) { const w = 2 * Math.PI * 220 * k / SR; re += a[k] * Math.cos(w); im += a[k] * Math.sin(w); } return Math.hypot(re, im); };
      const dB = 20 * Math.log10(amp(c) / amp(p)) - 20 * Math.log10(mk);
      check('W6 v' + v + ': the fundamental is raised by the level put back and no more (within 0.5 dB)', Math.abs(dB) < 0.5, dB.toFixed(2) + ' dB');
    }
  });
  /* Repitched: the sample is slowed before the filter, so the filter sits higher against the
     sample's own spectrum, and the list is read at cutoff ÷ playback rate. */
  DOWN_VELS.forEach((v, j) => {
    const i = VELS.length + j, p = seg(at(i, 0)), c = seg(at(i, 1)), pk = peak(p), rate = DOWN / 220;
    const used = Math.min(engine.timbreCutoff(curve, house(v)), SR * engine.TIMBRE_OPEN_FRACTION), lp = lowpass(p, used, engine.TIMBRE_LOWPASS_Q_DB);
    const mk = makeup(used / rate), err = apart(c, lp.map((s) => s * mk)) / (pk * mk);
    check('W7 v' + v + ': a note 1.5 semitones under its sample reads the level put back at cutoff ÷ rate (' + Math.round(used / rate) + ' Hz)', err < 1e-4, err.toExponential(2));
    const flat = makeup(used), wrong = apart(c, lp.map((s) => s * flat)) / (pk * mk);
    check('W8 v' + v + ': read at the cutoff itself it does not match', wrong > 20 * err && wrong > 1e-3, wrong.toExponential(2));
  });
  engine.sHardStopAll();

  /* ── the whole chain: the tool's bundle through the engine ── */
  {
    const { readHkiInstrument } = await import(${JSON.stringify(HKI_INSTRUMENT)});
    const kw = await import(${JSON.stringify(K_WEIGHTING)});
    const bytes = Uint8Array.from(atob(${JSON.stringify(toolBundle)}), (ch) => ch.charCodeAt(0));
    const { def: toolDef, audio } = readHkiInstrument(bytes);
    const { timbre: toolCurve, ...toolPlain } = toolDef;
    const NOTES = ${JSON.stringify(TOOL_NOTES)}, TV = [1, 8, 20, 40, 64, 90, 110, 126], BENDS = [0, 1.5, -1.5], TSLOT = 160 / 128;
    const jobs = [];
    for (const [name, f0] of NOTES) for (const bend of BENDS) for (const v of TV) jobs.push({ name, f0, bend, v, freq: f0 * Math.pow(2, bend / 12) });
    const c3 = new OfflineAudioContext(1, Math.ceil(SR * (0.2 + TSLOT * jobs.length * 2)), SR);
    engine.init(c3, c3.destination, { instrumentProvider: async () => Object.fromEntries(Object.entries(audio).map(([f, b]) => [f, b.slice()])), velocityToGain: house });
    await engine.loadInstrument('tool', toolDef);
    await engine.loadInstrument('toolplain', toolPlain);
    const tat = (i, which) => 13 / 128 + TSLOT * (2 * i + which);
    jobs.forEach((j, i) => { engine.sNoteOn('tp' + i, j.freq, j.v, 'toolplain', tat(i, 0)); engine.sNoteOn('tc' + i, j.freq, j.v, 'tool', tat(i, 1)); });
    const out3 = (await c3.startRendering()).getChannelData(0), kc = kw.kWeightingCoeffs(SR), W = Math.round(0.4 * SR);
    const kLevel = (t) => { const y = Float64Array.from(out3.subarray(Math.round(t * SR), Math.round(t * SR) + W)); kw.applyBiquadInPlace(y, kc.pre); kw.applyBiquadInPlace(y, kc.rlb); let e = 0; for (let i = 0; i < W; i++) e += y[i] * y[i]; return 10 * Math.log10(e / W); };
    const worst = { 0: { d: 0 }, 1: { d: 0 } }, byBend = {}; let most = 0;
    jobs.forEach((j, i) => {
      const d = kLevel(tat(i, 1)) - kLevel(tat(i, 0)), w = worst[j.bend === 0 ? 0 : 1];
      if (j.bend) { const k = j.name + (j.bend > 0 ? ' +' : ' ') + j.bend; if (!(k in byBend) || Math.abs(d) > Math.abs(byBend[k])) byBend[k] = d; }
      if (Math.abs(d) >= Math.abs(w.d)) Object.assign(w, { d, at: j.name + (j.bend ? (j.bend > 0 ? ' +' : ' ') + j.bend + ' st' : '') + ' v' + j.v });
      const row = toolDef.samples.find((s) => s.name === j.name);
      const fc = engine.timbreCutoff(toolCurve, house(j.v));
      if (isFinite(fc)) most = Math.max(most, 20 * Math.log10(engine.timbreMakeup ? engine.timbreMakeup(toolCurve.makeupHz, row.timbreMakeupDb, fc) : 1));
    });
    check('E0: the bundle the tool wrote has level to put back (the checks below have something to see)', toolDef.samples.every((s) => s.timbreMakeupDb[0] > 6), 'at the lowest cutoff: ' + toolDef.samples.map((s) => s.name + ' ' + s.timbreMakeupDb[0] + ' dB').join(', ') + '; most put back in this run ' + most.toFixed(1) + ' dB');
    check('E1: at the pitch of a sample, ' + NOTES.length * TV.length + ' notes with the curve have the K-weighted level of the same notes without it (within 0.1 dB)', Math.abs(worst[0].d) < 0.1, worst[0].d.toFixed(3) + ' dB at ' + worst[0].at);
    /* Repitched notes get a wider bound, and it is the test tone's, not the engine's. Chromium
       repitches a source by linear interpolation, which dulls a bright note: it takes up to
       0.44 dB of K-weighted level from this tone unfiltered (partials at k^-0.7 up to 18 kHz)
       and nothing from it filtered, so the curve voice reads up to 0.55 dB over the plain one.
       Measured 2026-11-24 with the same notes repitched in Node: linear interpolation gives
       these figures to 0.01 dB, a windowed sinc 0.18 dB at most (the K-weighting itself moves
       with pitch). On the Korg SP-250 bundle the same model gives 0.26 dB at most (C8).
       W7 and W8 above are the exact check of the reading at cutoff ÷ rate. */
    check('E2: 1.5 semitones either side of it, ' + NOTES.length * TV.length * 2 + ' notes (within 0.7 dB, most of it the linear interpolation of this bright test tone)', Math.abs(worst[1].d) < 0.7, worst[1].d.toFixed(3) + ' dB at ' + worst[1].at + '; widest per note and bend: ' + Object.entries(byBend).map(([k, d]) => k + ' st ' + d.toFixed(2)).join(', '));
    engine.sHardStopAll();
  }

  /* Cost: 64 voices sounding together for two seconds, rendered offline, with a lowpass on
     each against none. The render time stands in for the audio thread's load. */
  const timeRender = async (key) => {
    let best = Infinity;
    for (let rep = 0; rep < 3; rep++) {
      const c2 = new OfflineAudioContext(1, Math.ceil(SR * 2.2), SR);
      engine.init(c2, c2.destination, { instrumentProvider: async () => ({ 'a3.wav': new Uint8Array(wav.slice(0)) }), velocityToGain: house });
      for (let i = 0; i < 64; i++) engine.sNoteOn('k' + i, 220 * Math.pow(2, i / 64), 60, key, 13 / 128);
      const t0 = performance.now(); await c2.startRendering(); best = Math.min(best, performance.now() - t0);
      engine.sHardStopAll();
    }
    return best;
  };
  const plainMs = await timeRender('plain'), curveMs = await timeRender('curve');
  check('C1: 64 voices for 2 s render in ' + plainMs.toFixed(1) + ' ms without a curve and ' + curveMs.toFixed(1) + ' ms with one (under 3 times)', curveMs < 3 * plainMs + 5, (curveMs / plainMs).toFixed(2) + 'x');
  return { pass: results.every((r) => r.ok), results };
})()`;

const chrome = await launchChromium();
let exit = 0;
try {
  const cdp = new CDP(await newTabWsUrl(chrome.port));
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const errors = [];
  cdp.on('Runtime.exceptionThrown', (p) => errors.push(p?.exceptionDetails?.exception?.description ?? p?.exceptionDetails?.text ?? 'exception'));
  const loaded = new Promise((res) => { const off = cdp.on('Page.loadEventFired', () => { off(); res(); }); });
  await cdp.send('Page.navigate', { url: URL });
  await loaded;
  await sleep(1500);
  const out = await cdp.evalJSON(SCRIPT);
  if (!out || !out.results) {
    console.log('FAILED TO RUN:', JSON.stringify(out), errors.join('\n'));
    exit = 1;
  } else {
    for (const r of out.results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.detail})`);
    console.log(`\n${out.results.filter((r) => r.ok).length}/${out.results.length} checks passed`);
    if (!out.pass) exit = 1;
  }
} finally {
  await chrome.stop();
}
process.exit(exit);
