// A synthetic velocity-layered decay bundle with known filters, for the brightness-curve
// gates (run.mjs, webaudio.mjs). Each note is one bright decaying tone; each lower layer is
// that tone through a lowpass and a gain (TRUTH), captured after a stretch of noise floor
// whose length differs from layer to layer (PRE), with noise throughout.
export const SR = 48000;
/* The engine's lowpass Q, stated here on its own: linear 0.7071 in the dB a BiquadFilterNode
   lowpass takes (Web Audio: alpha = sin(w0) / (2 · 10^(Q/20))). */
export const Q_DB = 20 * Math.log10(Math.SQRT1_2);

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };

/* The lowpass a BiquadFilterNode computes, run sample by sample from rest. */
export function lowpass(x, fc, sr = SR) {
  const w0 = 2 * Math.PI * fc / sr, c = Math.cos(w0), al = Math.sin(w0) / (2 * Math.pow(10, Q_DB / 20));
  const a0 = 1 + al, b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, b2 = b0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
  const y = new Float64Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
export function tone(f0, seconds = 1.6) {
  const n = Math.round(seconds * SR), x = new Float64Array(n);
  for (let k = 1; k * f0 < 18000 && k <= 60; k++) {
    const amp = Math.pow(k, -0.7), ph = Math.PI * rnd(), tau = 1.2 / (1 + 0.1 * k), f = k * f0;
    for (let i = 0; i < n; i++) x[i] += amp * Math.sin(2 * Math.PI * f * i / SR + ph) * Math.exp(-i / SR / tau);
  }
  let peak = 0; for (const v of x) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < n; i++) x[i] *= 0.5 / peak;
  return x;
}
/* Mono IEEE float32 WAV. */
export function wav(samples) {
  const b = Buffer.alloc(44 + samples.length * 4);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + samples.length * 4, 4); b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28);
  b.writeUInt16LE(4, 32); b.writeUInt16LE(32, 34); b.write('data', 36, 'latin1'); b.writeUInt32LE(samples.length * 4, 40);
  for (let i = 0; i < samples.length; i++) b.writeFloatLE(samples[i], 44 + i * 4);
  return new Uint8Array(b);
}
/* The samples of a WAV that `wav` wrote. */
export function unwav(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), n = (bytes.byteLength - 44) / 4, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = dv.getFloat32(44 + i * 4, true);
  return x;
}
/* A capture: `pre` seconds of noise floor, then the note, with noise throughout. */
function capture(note, pre) {
  const p = Math.round(pre * SR), out = new Float32Array(p + note.length);
  for (let i = 0; i < out.length; i++) out[i] = 1e-5 * rnd() + (i >= p ? note[i - p] : 0);
  return out;
}
export const TRUTH = { 24: { fc: 350, db: -22 }, 48: { fc: 800, db: -14 }, 72: { fc: 1600, db: -8.5 }, 96: { fc: 5000, db: -3.5 } };
export const PRE = { 24: 0.148, 48: 0.161, 72: 0.1456, 96: 0.1508, 120: 0.15 };
export const NOTES = [['A1', 55], ['A2', 110], ['A3', 220], ['A4', 440], ['A5', 880], ['A6', 1760], ['A7', 3520]];
export function layeredBundle(extra = {}, { notes = NOTES, seconds = 1.6 } = {}) {
  const samples = [], audio = {};
  for (const [name, f0] of notes) {
    const top = tone(f0, seconds);
    for (const vel of [24, 48, 72, 96, 120]) {
      const t = TRUTH[vel], note = t ? lowpass(top, t.fc).map((v) => v * Math.pow(10, t.db / 20)) : top;
      const file = 'samples/' + name + '_v' + vel + '.wav';
      audio[file] = wav(capture(note, PRE[vel]));
      samples.push({ name, file, freq: f0, vel, gain: 0.4 + vel / 1000 + f0 / 1e5, gainLevel: 0.6 + vel / 500, trimStart: PRE[vel] - 0.01 });
    }
  }
  return { manifest: { version: 2, instrumentKey: 'synth-5layer', name: 'Synthetic piano', loop: false, decays: true, releaseTime: 0.15, volume: 1, samples, ...extra },
    audio, provenance: { source: 'gate' } };
}
