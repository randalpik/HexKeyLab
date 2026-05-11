#!/usr/bin/env node
/**
 * didgeridoo.js — single-sample drone instrument builder.
 *
 * VCSL ships the Didgeridoo as a handful of un-pitch-labeled long sustains
 * (Didgeridoo1_Sus2_Main.wav, Sus3, Sus8). The drone has no defined chromatic
 * scale, so the normal generate-samples.js enumeration doesn't apply. Instead,
 * we:
 *
 *   1. Fetch the three Sus files.
 *   2. Decode each to mono f32 PCM at 44.1 kHz.
 *   3. Autocorrelation-measure the fundamental period across a 500ms window
 *      near the middle of each sample (skipping attack / final decay).
 *   4. Pick the sample with the strongest, most stable fundamental.
 *   5. Emit a single-entry samples.ts block whose freq is the measured
 *      fundamental. The runtime engine will then pitch-shift this one
 *      sample across the whole keyboard, A3 turning it into a 220 Hz drone,
 *      C7 into a fast-and-thin chirp — exactly what a tunable drone wants.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');
const ANALYZER_HTML = path.join(REPO, 'tools', 'HexKeyLab-analyzer.html');
const CACHE_DIR = path.join(__dirname, '.cache', 'didgeridoo');
const OUT_DIR   = path.join(__dirname, 'out');
const SR = 44100;
const TARGET_PEAK_DECAY_DBFS = -6;
const TARGET_PEAK_DECAY = Math.pow(10, TARGET_PEAK_DECAY_DBFS / 20);
const GAIN_MIN = 0.1, GAIN_MAX = 12.0;
const NOTE_NAMES = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];

const BASE_URL = 'https://cdn.jsdelivr.net/gh/sgossner/VCSL@master/Aerophones/Lip%20Aerophones/Didgeridoo/';
const FILES = [
  'Didgeridoo1_Sus2_Main.wav',
  'Didgeridoo1_Sus3_Main.wav',
  'Didgeridoo1_Sus8_Main.wav',
];

function loadAnalyzer() {
  const html = fs.readFileSync(ANALYZER_HTML, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no <script> block in analyzer HTML');
  const stub = {
    document:{getElementById:()=>({addEventListener:()=>{},textContent:'',value:'',dataset:{}}),addEventListener:()=>{},readyState:'complete',createElement:()=>({appendChild:()=>{}})},
    window:{AudioContext:function(){}}
  };
  const src = m[1] + '\n;return {refineFundamentalPeriod, findSteadyRegion};';
  const factory = new Function('document','window', src);
  return factory(stub.document, stub.window);
}

function fetchOne(name) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const wav = path.join(CACHE_DIR, name);
  if (!fs.existsSync(wav) || fs.statSync(wav).size === 0) {
    const url = BASE_URL + encodeURIComponent(name);
    const r = spawnSync('curl', ['-sLfo', wav, url], { stdio: 'ignore' });
    if (r.status !== 0) throw new Error(`fetch failed: ${url}`);
  }
  return wav;
}

function decodeMono(wav) {
  const raw = wav.replace(/\.\w+$/, '.raw');
  if (!fs.existsSync(raw) || fs.statSync(raw).mtimeMs < fs.statSync(wav).mtimeMs) {
    execFileSync('ffmpeg', ['-loglevel','error','-y','-i', wav, '-ac','1','-ar', String(SR),'-f','f32le', raw], { stdio: 'inherit' });
  }
  const buf = fs.readFileSync(raw);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length/4));
}
function decodeStereo(wav) {
  const raw = wav.replace(/\.\w+$/, '.s2.raw');
  if (!fs.existsSync(raw) || fs.statSync(raw).mtimeMs < fs.statSync(wav).mtimeMs) {
    execFileSync('ffmpeg', ['-loglevel','error','-y','-i', wav, '-ac','2','-ar', String(SR),'-f','f32le', raw], { stdio: 'inherit' });
  }
  const buf = fs.readFileSync(raw);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length/4));
}

/* Sweep candidate fundamentals across the typical didgeridoo range
   (50–110 Hz) and ask refineFundamentalPeriod which lands. Take the
   strongest. Window: 500ms centered roughly mid-sample, where the player
   has settled into the drone. */
function measurePitch(mono, fns) {
  const findTrim = (d) => { for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 0.003) return i; return 0; };
  const trim = findTrim(mono);
  const len = mono.length;
  if (len - trim < SR * 1.0) return null;
  const winLen = Math.round(SR * 0.5);
  /* Scan in 250ms hops; pick the window with highest RMS, that's where the
     player has settled. */
  let bestStart = trim, bestRms = 0;
  const hop = Math.round(SR * 0.25);
  for (let s = trim + Math.round(SR * 0.3); s + winLen < len - Math.round(SR * 0.3); s += hop) {
    let sum = 0;
    for (let k = 0; k < winLen; k++) sum += mono[s+k] * mono[s+k];
    if (sum > bestRms) { bestRms = sum; bestStart = s; }
  }
  const end = bestStart + winLen;
  /* Coarse pitch sweep — typical Aboriginal didgeridoo drones land in
     E1–A2 (~41 Hz to 110 Hz). Try seed freqs across that range and keep
     the period whose refinement lands most consistently. */
  const seeds = [40, 50, 60, 65, 70, 75, 80, 90, 100, 110];
  const hits = [];
  for (const f of seeds) {
    const T = fns.refineFundamentalPeriod(mono, SR, f, bestStart, end, { tRefineRange: 0.10, minPeakRatio: 0.3 });
    if (T == null) continue;
    hits.push({ seed: f, freq: 1/T, T });
  }
  if (hits.length === 0) return null;
  /* Cluster the hits — refinement from different seeds should converge on
     the true fundamental (or octave multiples thereof). Take the smallest
     fundamental, since for a periodic signal autocorrelation also locks at
     2T, 3T, etc. — but smaller T values are the real fundamental, the rest
     are aliases at higher multiples of the freq. (Actually opposite: T at
     larger value is the true fundamental; smaller T is a harmonic. We want
     the LARGEST T that gets sustained agreement.) */
  hits.sort((a,b) => b.T - a.T);
  /* Find the cluster of consistent T values within ±5%. */
  const groups = [];
  for (const h of hits) {
    let placed = false;
    for (const g of groups) {
      if (Math.abs(h.T - g[0].T) / g[0].T < 0.05) { g.push(h); placed = true; break; }
    }
    if (!placed) groups.push([h]);
  }
  groups.sort((a, b) => b.length - a.length || b[0].T - a[0].T);
  const winner = groups[0];
  /* Average T within the winning cluster. */
  let Tavg = 0;
  for (const h of winner) Tavg += h.T;
  Tavg /= winner.length;
  return { freq: 1 / Tavg, windowStart: bestStart, windowEnd: end, agreement: winner.length };
}

function measurePeak(stereo, mono) {
  const trim = (() => { for (let i = 0; i < mono.length; i++) if (Math.abs(mono[i]) > 0.003) return i; return 0; })();
  const peakSearchLen = Math.round(SR * 0.5);
  const monoLen = mono.length;
  if (monoLen <= trim) return null;
  const searchEnd = Math.min(trim + peakSearchLen, monoLen);
  let peakAbs = 0;
  for (let i = trim; i < searchEnd; i++) {
    const aL = Math.abs(stereo[2*i]);
    const aR = Math.abs(stereo[2*i+1]);
    const a = aL > aR ? aL : aR;
    if (a > peakAbs) peakAbs = a;
  }
  return peakAbs > 0 ? peakAbs : null;
}

function freqToNoteName(freq) {
  /* Closest equal-tempered note name to `freq`, in flat naming. */
  const midi = Math.round(69 + 12 * Math.log2(freq / 440));
  const oct = Math.floor(midi / 12) - 1;
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  return name + oct;
}

(async function main() {
  const fns = loadAnalyzer();
  const results = [];
  for (const name of FILES) {
    console.error(`fetching ${name}…`);
    const wav = fetchOne(name);
    const mono = decodeMono(wav);
    const stereo = decodeStereo(wav);
    const dur = mono.length / SR;
    const pitch = measurePitch(mono, fns);
    if (!pitch) { console.error(`  no fundamental found in ${name}`); continue; }
    const peak = measurePeak(stereo, mono);
    const noteName = freqToNoteName(pitch.freq);
    const gain = peak ? Math.max(GAIN_MIN, Math.min(GAIN_MAX, TARGET_PEAK_DECAY / peak)) : 1.0;
    const dBFS = peak ? (20 * Math.log10(peak)).toFixed(1) : 'n/a';
    console.error(`  ${name}: ${dur.toFixed(1)}s, ${pitch.freq.toFixed(2)} Hz (≈${noteName}), agreement=${pitch.agreement}, peak=${dBFS} dBFS, gain=${gain.toFixed(4)}`);
    results.push({ file: name, freq: pitch.freq, noteName, gain, peak, agreement: pitch.agreement, durSec: dur });
  }
  if (results.length === 0) { console.error('no usable samples'); process.exit(1); }
  /* Pick the sample with the highest agreement (consensus across seeds);
     break ties by duration (longer drone = more stable measurement). */
  results.sort((a, b) => b.agreement - a.agreement || b.durSec - a.durSec);
  const pick = results[0];
  console.error(`\npicking ${pick.file} (agreement=${pick.agreement}, ${pick.freq.toFixed(2)} Hz ≈ ${pick.noteName})`);

  const fmt = (x, n) => (+x.toFixed(n)).toString();
  const lines = [];
  lines.push(`    didgeridoo:{`);
  lines.push(`      name:'Didgeridoo',baseUrl:'${BASE_URL}',`);
  lines.push(`      ext:'.wav',releaseTime:0.5,volume:1.0,loop:false,decays:true,filePattern:'${pick.file}',`);
  lines.push(`      /* Single-sample drone. VCSL's didgeridoo Sus* recordings have no pitch labels;`);
  lines.push(`         analyzer/didgeridoo.js measures the fundamental of each via autocorrelation`);
  lines.push(`         and writes it here as freq. The runtime maps every keyboard target to this`);
  lines.push(`         one file and pitch-shifts via rate = target / freq — so a "C4" key plays the`);
  lines.push(`         drone an octave-and-change above its native pitch, and so on. Will obviously`);
  lines.push(`         sound thin or chirpy far from the native pitch (${pick.freq.toFixed(2)} Hz ≈ ${pick.noteName});`);
  lines.push(`         that's the price of a fine-tunable drone. Generated by analyzer/didgeridoo.js. */`);
  lines.push(`      samples:[`);
  lines.push(`        {name:'${pick.noteName}',freq:${fmt(pick.freq, 3)},gain:${fmt(pick.gain, 4)}}`);
  lines.push(`      ]`);
  lines.push(`    },`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const blockPath = path.join(OUT_DIR, 'didgeridoo-block.txt');
  const reportPath = path.join(OUT_DIR, 'didgeridoo-report.md');
  fs.writeFileSync(blockPath, lines.join('\n') + '\n');
  const rep = [
    `# Didgeridoo — single-sample drone report`,
    ``,
    `## Candidate measurements`,
    ``,
    `| File | Duration | Measured Hz | ≈ Note | Seed agreement | Peak (dBFS) | gain |`,
    `| --- | ---: | ---: | --- | ---: | ---: | ---: |`,
    ...results.map(r => `| ${r.file} | ${r.durSec.toFixed(1)}s | ${r.freq.toFixed(2)} | ${r.noteName} | ${r.agreement} | ${r.peak ? (20*Math.log10(r.peak)).toFixed(1) : 'n/a'} | ${r.gain.toFixed(4)} |`),
    ``,
    `## Pick`,
    ``,
    `**${pick.file}** — ${pick.freq.toFixed(2)} Hz (≈ ${pick.noteName}). The engine will play this single sample at rate = targetFreq / ${pick.freq.toFixed(2)} for every keyboard pitch.`,
  ];
  fs.writeFileSync(reportPath, rep.join('\n') + '\n');
  console.error(`\nwrote: ${blockPath}`);
  console.error(`wrote: ${reportPath}`);
})();
