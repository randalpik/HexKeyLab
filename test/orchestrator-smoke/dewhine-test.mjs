#!/usr/bin/env node
// Deterministic unit test for the capture NR DSP (pure logic, no audio device):
//   - detectCombTones: find fixed narrowband whine tones in an idle recording
//   - dewhineChannels: notch them out, leaving broadband + program intact
//   - wienerDenoiseChannels: pull the broadband floor down without eating the note
//
//   node --import ./test/orchestrator-smoke/register-ts.mjs test/orchestrator-smoke/dewhine-test.mjs
//
// Node strips the TS types on import; register-ts.mjs rewrites the modules'
// `./foo.js` specifiers to their `.ts` siblings.

import { detectCombTones, dewhineChannels } from '../../apps/orchestrator/src/analysis/dewhine.ts';
import { wienerDenoiseChannels } from '../../apps/orchestrator/src/analysis/wiener.ts';

const SR = 48000;
let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  ok: ' + msg);
  else { console.error('  FAIL: ' + msg); failures++; }
}

// Deterministic PRNG (LCG) so the test never flakes on noise.
let seed = 0x2545f4914f6cdd1d >>> 0;
function rnd() { seed = (1103515245 * seed + 12345) >>> 0; return seed / 0xffffffff; }
function noise(amp) { return (rnd() * 2 - 1) * amp; }

const db = x => (x > 1e-12 ? 20 * Math.log10(x) : -140);

// Goertzel single-frequency magnitude (amplitude) over a window.
function toneAmp(sig, f0, start, len) {
  const w0 = (2 * Math.PI * f0) / SR;
  const coeff = 2 * Math.cos(w0);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = start; i < start + len; i++) { s0 = sig[i] + coeff * s1 - s2; s2 = s1; s1 = s0; }
  const real = s1 - s2 * Math.cos(w0);
  const imag = s2 * Math.sin(w0);
  return (2 * Math.hypot(real, imag)) / len;
}
function rms(sig, start, len) {
  let s = 0; for (let i = start; i < start + len; i++) s += sig[i] * sig[i];
  return Math.sqrt(s / len);
}

const WHINE_HZ = 12000, WHINE_A = 0.02;
const WHINE2_HZ = 6000, WHINE2_A = 0.01;
const NOISE_A = 0.002;

// --- 1. detectCombTones on a 3s idle recording (whine + broadband, no note).
//     Detection ALWAYS runs on idle — never on a note capture — so a musical
//     fundamental can never be mistaken for a whine tone. ---
const idle = (() => {
  const n = SR * 3;
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    a[i] = WHINE_A * Math.sin(2 * Math.PI * WHINE_HZ * t)
         + WHINE2_A * Math.sin(2 * Math.PI * WHINE2_HZ * t)
         + noise(NOISE_A);
  }
  return a;
})();
const idleTones = detectCombTones(idle, SR);
{
  console.log('detected tones:', idleTones.map(t => t.toFixed(1)));
  const near = f => idleTones.some(t => Math.abs(t - f) < 8);
  check(near(WHINE_HZ), '12 kHz whine detected (±8 Hz)');
  check(near(WHINE2_HZ), '6 kHz whine detected (±8 Hz)');
  check(!idleTones.some(t => t < 3000), 'no spurious tones below 3 kHz from broadband');
}

// --- build a note capture: 0.2s preroll (whine+noise), then a decaying 500 Hz
//     note (+ persistent whine + noise) for 0.8s ---
const PREROLL = 0.2, NOTE = 0.8, NOTE_HZ = 500;
const nTot = Math.round((PREROLL + NOTE) * SR);
const onset = Math.round(PREROLL * SR);
const cap = new Float32Array(nTot);
for (let i = 0; i < nTot; i++) {
  const t = i / SR;
  let s = WHINE_A * Math.sin(2 * Math.PI * WHINE_HZ * t)
        + WHINE2_A * Math.sin(2 * Math.PI * WHINE2_HZ * t)
        + noise(NOISE_A);
  if (i >= onset) {
    const td = (i - onset) / SR;
    // Fast decay (τ=80 ms) so the late tail is unambiguously broadband, not note.
    s += 0.3 * Math.exp(-td / 0.08) * Math.sin(2 * Math.PI * NOTE_HZ * t);
  }
  cap[i] = s;
}

// --- 2. dewhineChannels: notch the idle-detected tones on the note capture ---
{
  const [dw] = dewhineChannels([cap], SR, idleTones);
  const bodyStart = onset + Math.round(0.02 * SR), bodyLen = Math.round(0.2 * SR);
  const whineBefore = toneAmp(cap, WHINE_HZ, bodyStart, bodyLen);
  const whineAfter = toneAmp(dw, WHINE_HZ, bodyStart, bodyLen);
  const noteBefore = toneAmp(cap, NOTE_HZ, bodyStart, bodyLen);
  const noteAfter = toneAmp(dw, NOTE_HZ, bodyStart, bodyLen);
  console.log(`  12kHz: ${db(whineBefore).toFixed(1)} -> ${db(whineAfter).toFixed(1)} dB`);
  console.log(`  500Hz note: ${db(noteBefore).toFixed(1)} -> ${db(noteAfter).toFixed(1)} dB`);
  check(db(whineBefore) - db(whineAfter) >= 20, '12 kHz whine notched by ≥20 dB');
  check(Math.abs(db(noteBefore) - db(noteAfter)) < 1.5, '500 Hz note preserved within 1.5 dB');
}

// --- 3. wienerDenoiseChannels: pull the broadband floor down, keep the note ---
{
  const [dw] = dewhineChannels([cap], SR, idleTones);
  const [clean] = wienerDenoiseChannels([dw], SR, PREROLL);
  // Late tail: >7 time-constants past onset → note is −70 dB, so this is the
  // broadband floor, not the note.
  const tailStart = onset + Math.round(0.6 * SR), tailLen = Math.round(0.08 * SR);
  const floorBefore = rms(dw, tailStart, tailLen);
  const floorAfter = rms(clean, tailStart, tailLen);
  console.log(`  tail floor: ${db(floorBefore).toFixed(1)} -> ${db(floorAfter).toFixed(1)} dB`);
  // Note body preserved.
  const bodyStart = onset + Math.round(0.02 * SR), bodyLen = Math.round(0.15 * SR);
  const bodyBefore = toneAmp(dw, NOTE_HZ, bodyStart, bodyLen);
  const bodyAfter = toneAmp(clean, NOTE_HZ, bodyStart, bodyLen);
  console.log(`  500Hz body: ${db(bodyBefore).toFixed(1)} -> ${db(bodyAfter).toFixed(1)} dB`);
  check(db(floorBefore) - db(floorAfter) >= 6, 'broadband tail floor pulled down ≥6 dB');
  check(Math.abs(db(bodyBefore) - db(bodyAfter)) < 2, 'note body preserved within 2 dB');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall dewhine/wiener checks passed');
process.exit(failures ? 1 : 0);
