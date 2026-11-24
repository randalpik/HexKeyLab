// Browser gate for the engine's brightness-curve voice: does a real BiquadFilterNode, wired
// by the real engine, compute the filter the curve was fitted with?
//
// apps/analyzer/cli/hki-timbre.mjs fits an instrument's curve with the lowpass of the Web
// Audio spec at the engine's Q (TIMBRE_LOWPASS_Q_DB; for a lowpass the node's Q is in dB), and
// the engine sets one such node per voice from the level a note sounds at. This renders the
// same sample through the engine in an OfflineAudioContext, as an instrument with a curve and
// as one without, and requires the first to be the second put through that filter, sample for
// sample, at the cutoff the curve gives for the note's level.
//
// Requires `pnpm dev` running (umbrella proxy at :5170): the engine module is imported from
// the dev server, as its own instance. Nothing is played: the context is offline, and the
// shared launcher mutes the browser anyway.
//
//   node test/hki-timbre/webaudio.mjs      # exits non-zero on any failure
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { CDP } from '../composer-test/lib/cdp.mjs';
import { isolatedHklUrl } from '../composer-test/lib/private-relay.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const URL = await isolatedHklUrl(process.env.HKL_URL ?? 'http://localhost:5170/');
const ENGINE = '/@fs' + REPO + '/packages/engine/src/samples-engine.ts?gate=timbre';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRIPT = `(async () => {
  const engine = await import(${JSON.stringify(ENGINE)});
  const SR = 48000, results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail) });
  const house = (v) => 0.05 + 0.95 * Math.pow(v / 127, 1.5); // HKL's velocity → gain
  /* The curve hki-timbre.mjs fits to the Korg SP-250 bundle. */
  const curve = { type: 'lowpass12', points: [
    { gainDb: -24.94, cutoffHz: 431 }, { gainDb: -15.3, cutoffHz: 863 }, { gainDb: -9.1, cutoffHz: 1690 },
    { gainDb: -3.8, cutoffHz: 5510 }, { gainDb: 0, cutoffHz: 20000 }] };

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
    samples: [{ name: 'A3', file: 'a3.wav', freq: 220, gain: 1 }], ...(timbre ? { timbre } : {}) });

  /* Every note of both instruments in one offline render, each in its own slot. Slot
     times are whole multiples of 1/128 s: exact in binary and a whole number of samples
     at 48 kHz, so the engine's own snap of a start time (up to the next sample) lands
     where the slot is cut. */
  const VELS = [8, 20, 40, 64, 90, 110, 126, 127], SLOT = 205 / 128, LEN = 1.4;
  const ctx = new OfflineAudioContext(1, Math.ceil(SR * (0.2 + SLOT * VELS.length * 2)), SR);
  engine.init(ctx, ctx.destination, { instrumentProvider: async () => ({ 'a3.wav': new Uint8Array(wav.slice(0)) }), velocityToGain: house });
  await engine.loadInstrument('plain', def(null));
  await engine.loadInstrument('curve', def(curve));
  const at = (i, which) => 13 / 128 + SLOT * (2 * i + which);
  VELS.forEach((v, i) => { engine.sNoteOn('p' + v, 220, v, 'plain', at(i, 0)); engine.sNoteOn('c' + v, 220, v, 'curve', at(i, 1)); });
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
    const used = Math.min(fc, SR * engine.TIMBRE_OPEN_FRACTION);
    const err = apart(c, lowpass(p, used, engine.TIMBRE_LOWPASS_Q_DB)) / pk;
    check('W3 v' + v + ': the curve voice is the plain voice through the fitted lowpass at ' + Math.round(used) + ' Hz', err < 1e-4, err.toExponential(2));
    /* The check can tell: a cutoff 5 % off, or the Q read as a linear 0.7071, does not match. */
    const off = apart(c, lowpass(p, used * 1.05, engine.TIMBRE_LOWPASS_Q_DB)) / pk;
    const lin = apart(c, lowpass(p, used, 0.7071)) / pk;
    if (used < 12000) {
      check('W4 v' + v + ': a cutoff 5 % higher does not match', off > 20 * err && off > 1e-3, off.toExponential(2));
      check('W5 v' + v + ': Q taken as 0.7071 dB instead of linear 0.7071 does not match', lin > 20 * err && lin > 1e-3, lin.toExponential(2));
    }
    /* The level is still the house gain: the fundamental, far under the cutoff, is not reduced. */
    if (used > 800) {
      const amp = (a) => { let re = 0, im = 0; for (let k = 4800; k < 4800 + 9600; k++) { const w = 2 * Math.PI * 220 * k / SR; re += a[k] * Math.cos(w); im += a[k] * Math.sin(w); } return Math.hypot(re, im); };
      const dB = 20 * Math.log10(amp(c) / amp(p));
      check('W6 v' + v + ': the fundamental keeps its level (within 0.5 dB)', Math.abs(dB) < 0.5, dB.toFixed(2) + ' dB');
    }
  });
  engine.sHardStopAll();

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
