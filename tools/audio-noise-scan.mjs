#!/usr/bin/env node
// Noise-floor / whine analyzer for a recorded WAV. Welch-averages the magnitude
// spectrum (using the orchestrator's FFT) and reports the time-domain level, the
// broadband floor, and the dominant tonal peaks — so a background whine can be
// localized by its frequency signature:
//   • 50/60 Hz + integer harmonics → mains ground loop / EMI
//   • a discrete high tone (often kHz, or tied to USB 8 kHz SOF) → USB/clock/digital
//   • flat broadband, no peaks → ADC / preamp self-noise (hiss)
//
// Record silence first, e.g.:
//   arecord -D plughw:CARD=Card -f S24_3LE -r 48000 -c 2 -d 5 /tmp/silence.wav
// Then:
//   node tools/audio-noise-scan.mjs /tmp/silence.wav

import { readFileSync } from 'node:fs';
import { magnitudeSpectrum } from '../apps/orchestrator/src/discovery/fft.ts';

const path = process.argv[2];
if (!path) { console.error('usage: node tools/audio-noise-scan.mjs <file.wav>'); process.exit(1); }

// ── Minimal WAV reader: PCM 16/24/32-bit int (fmt 1) + 32-bit float (fmt 3) ──
const buf = readFileSync(path);
if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
  console.error('not a RIFF/WAVE file'); process.exit(1);
}
let fmt = null, dataOff = -1, dataLen = 0;
for (let off = 12; off + 8 <= buf.length;) {
  const id = buf.toString('ascii', off, off + 4);
  const sz = buf.readUInt32LE(off + 4);
  if (id === 'fmt ') {
    fmt = {
      audioFormat: buf.readUInt16LE(off + 8),
      channels: buf.readUInt16LE(off + 10),
      sampleRate: buf.readUInt32LE(off + 12),
      bits: buf.readUInt16LE(off + 22),
    };
  } else if (id === 'data') { dataOff = off + 8; dataLen = sz; }
  off += 8 + sz + (sz & 1);
}
if (!fmt || dataOff < 0) { console.error('missing fmt/data chunk'); process.exit(1); }

const { audioFormat, channels, sampleRate, bits } = fmt;
const bytesPerSample = bits >> 3;
const frameBytes = bytesPerSample * channels;
const nFrames = Math.floor(dataLen / frameBytes);

function readSample(frame, ch) {
  const p = dataOff + frame * frameBytes + ch * bytesPerSample;
  if (audioFormat === 3 && bits === 32) return buf.readFloatLE(p);
  if (audioFormat === 1) {
    if (bits === 16) return buf.readInt16LE(p) / 32768;
    if (bits === 24) { const v = buf.readUInt8(p) | (buf.readUInt8(p + 1) << 8) | (buf.readInt8(p + 2) << 16); return v / 8388608; }
    if (bits === 32) return buf.readInt32LE(p) / 2147483648;
  }
  throw new Error(`unsupported WAV: fmt ${audioFormat}, ${bits}-bit`);
}

// Mono downmix.
const mono = new Float32Array(nFrames);
let sumSq = 0, peak = 0, clipped = 0;
const CLIP = 0.999;
for (let i = 0; i < nFrames; i++) {
  let s = 0;
  for (let c = 0; c < channels; c++) { const v = readSample(i, c); s += v; if (Math.abs(v) >= CLIP) clipped++; }
  s /= channels;
  mono[i] = s;
  sumSq += s * s;
  const a = Math.abs(s); if (a > peak) peak = a;
}
const rms = Math.sqrt(sumSq / nFrames);
const dB = (x) => x > 0 ? 20 * Math.log10(x) : -Infinity;

// ── Welch-averaged magnitude spectrum ──
const FFT = 8192;                       // ~5.9 Hz bins @ 48k — resolves mains harmonics
const hop = FFT >> 1;
const half = FFT >> 1;
const acc = new Float64Array(half);
let frames = 0;
for (let off = 0; off + FFT <= nFrames; off += hop) {
  const mag = magnitudeSpectrum(mono, off, FFT);
  for (let i = 0; i < half; i++) acc[i] += mag[i];
  frames++;
}
if (frames === 0) { console.error('file too short for one FFT frame'); process.exit(1); }
// Approx one-sided amplitude → dBFS (Hann coherent gain 0.5): amp ≈ 4·mag / N.
const binDb = new Float64Array(half);
for (let i = 0; i < half; i++) binDb[i] = dB((4 * (acc[i] / frames)) / FFT);
const binHz = (i) => (i * sampleRate) / FFT;

// Broadband floor = median bin level.
const sorted = [...binDb].filter(Number.isFinite).sort((a, b) => a - b);
const floor = sorted[sorted.length >> 1];

// Peak-pick local maxima ≥ floor + 10 dB.
const peaks = [];
for (let i = 2; i < half - 2; i++) {
  if (binDb[i] >= floor + 10 && binDb[i] >= binDb[i - 1] && binDb[i] >= binDb[i + 1]) {
    peaks.push({ hz: binHz(i), db: binDb[i] });
  }
}
peaks.sort((a, b) => b.db - a.db);

console.log(`file       : ${path}`);
console.log(`format     : ${audioFormat === 3 ? 'float' : 'PCM'} ${bits}-bit, ${channels}ch, ${sampleRate} Hz, ${(nFrames / sampleRate).toFixed(2)}s`);
console.log(`time-domain: RMS ${dB(rms).toFixed(1)} dBFS, peak ${dB(peak).toFixed(1)} dBFS`);
if (clipped > 0) console.log(`  ⚠ CLIPPING: ${clipped} samples at full scale — ADC overloaded; turn the SOURCE down (software gain can't fix this).`);
else console.log(`  headroom: ${(-dB(peak)).toFixed(1)} dB below full scale${dB(peak) > -2 ? ' (hot — watch for clipping)' : dB(peak) < -12 ? ' (low — bring the source up for better SNR)' : ' (good)'}.`);
console.log(`broadband floor (median bin): ${floor.toFixed(1)} dBFS`);
console.log(`tonal peaks above floor+10dB:`);
if (peaks.length === 0) console.log('  (none — looks broadband; suspect ADC/preamp self-noise)');
for (const p of peaks.slice(0, 10)) console.log(`  ${p.hz.toFixed(1).padStart(8)} Hz   ${p.db.toFixed(1)} dBFS   (+${(p.db - floor).toFixed(1)} dB)`);

// Heuristic read.
const isMains = (hz) => { const r = hz / 60, r2 = hz / 50; return Math.abs(r - Math.round(r)) < 0.04 || Math.abs(r2 - Math.round(r2)) < 0.04; };
const mains = peaks.filter(p => isMains(p.hz));
const high = peaks.filter(p => p.hz > 2000);
console.log('\ninterpretation:');
if (peaks.length === 0) {
  console.log('  → no tonal peaks: broadband hiss = ADC/preamp self-noise. Improve gain-staging (Korg hot, capture gain low) or use a cleaner input stage.');
} else {
  if (mains.length >= 2) console.log(`  → ${mains.length} mains harmonics (50/60 Hz family): ground loop / EMI on the analog path or the Korg's own PSU.`);
  if (high.length >= 1) console.log(`  → discrete high tone(s) at ${high.slice(0, 3).map(p => Math.round(p.hz) + ' Hz').join(', ')}: USB/clock/digital coupling (try a different expansion bay / USB isolation).`);
  if (mains.length < 2 && high.length === 0) {
    const top = peaks[0];
    console.log(`  → dominant tone at ${top.hz.toFixed(0)} Hz${isMains(top.hz) ? ' (a 50/60 Hz multiple → likely mains/EMI)' : ' (not a mains multiple → switching/clock artifact or Korg-internal)'}.`);
  }
  console.log('  (Compare a Korg-volume-0 / Korg-unplugged capture: peaks that vanish are in the Korg/cable; peaks that remain are card/USB/ADC.)');
}
