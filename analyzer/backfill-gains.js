#!/usr/bin/env node
/**
 * backfill-gains.js — measure per-sample RMS and patch the `gain` field in
 * src/audio/samples.ts in-place.
 *
 * Usage:
 *   node analyzer/backfill-gains.js                    # all instruments
 *   node analyzer/backfill-gains.js piano violin       # subset
 *
 * Pipeline (per sample):
 *   1. Fetch baseUrl + name + ext to analyzer/.cache/<key>/<name>.mp3 (curl)
 *   2. Decode to f32 mono PCM @ 44.1 kHz via ffmpeg → analyzer/.cache/.../*.raw
 *   3. Find trimStart (first |x|>0.003) and measure RMS:
 *        loop  : findSteadyRegion (50ms/10ms RMS curve, ≥70% peak run); RMS
 *                over the steady span. vibrato:true passes smoothMs=300.
 *        decay : peak 500ms window via 50ms-hop slide.
 *   4. gain = 10^(TARGET_DBFS/20) / rms, clamped [GAIN_MIN, GAIN_MAX]
 *   5. Patch `gain:N.NNNN` into the entry line right after `freq:`
 *
 * Idempotent: if a `gain:` field is already present, it's replaced. Writes a
 * markdown report to analyzer/out/gain-backfill-report.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');
const ANALYZER_HTML = path.join(REPO, 'tools', 'HexKeyLab-analyzer.html');
const SAMPLES_TS = path.join(REPO, 'src', 'audio', 'samples.ts');
const CACHE_DIR = path.join(__dirname, '.cache');
const OUT_DIR = path.join(__dirname, 'out');

const SR = 44100;
const TARGET_DBFS = -18;
const TARGET_RMS = Math.pow(10, TARGET_DBFS / 20);  /* ≈ 0.12589 */
/* Peak ceiling: limits gain so a single voice's peak after boost stays at or
   below this. Polyphony rise is statistical — peaks rarely align coherently
   across voices — so a -3 dBFS single-voice peak ceiling still leaves usable
   headroom at full chord. */
const PEAK_DBFS = -3;
const TARGET_PEAK = Math.pow(10, PEAK_DBFS / 20);   /* ≈ 0.7079 */
const GAIN_MIN = 0.1;
const GAIN_MAX = 8.0;  /* sanity bound; the peak ceiling is the real limiter */

// ─── parse INSTRUMENTS map from samples.ts ───────────────────────────────────

function parseInstruments(src) {
  const lines = src.split('\n');
  const instruments = {};
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^    (\w+):\{$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const start = i;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === '    },' || lines[j] === '    }') { end = j; break; }
    }
    if (end < 0) break;
    const body = lines.slice(start, end + 1).join('\n');
    const baseUrlM = body.match(/baseUrl:'([^']+)'/);
    const extM     = body.match(/ext:'([^']+)'/);
    if (!baseUrlM || !extM) { i = end + 1; continue; }
    const vibrato = /vibrato:true/.test(body);
    const decays  = /decays:true/.test(body);
    const samples = [];
    for (let j = start + 1; j < end; j++) {
      const sm = lines[j].match(/^ *\{name:'([^']+)'/);
      if (sm) samples.push({ name: sm[1], lineIdx: j });
    }
    instruments[key] = { key, baseUrl: baseUrlM[1], ext: extM[1], vibrato, decays, samples };
    i = end + 1;
  }
  return instruments;
}

// ─── fetch + decode (shared cache with generate-samples.js) ──────────────────

function fetchOne(key, sampleName, baseUrl, ext) {
  const dir = path.join(CACHE_DIR, key);
  fs.mkdirSync(dir, { recursive: true });
  const mp3 = path.join(dir, `${sampleName}${ext}`);
  if (fs.existsSync(mp3) && fs.statSync(mp3).size > 0) return mp3;
  const url = (baseUrl + sampleName + ext).replace(/#/g, '%23');
  const r = spawnSync('curl', ['-sLfo', mp3, url], { stdio: 'ignore' });
  if (r.status !== 0) {
    try { fs.unlinkSync(mp3); } catch {}
    return null;
  }
  return mp3;
}

function decodeOne(mp3) {
  const raw = mp3.replace(/\.\w+$/, '.raw');
  if (!fs.existsSync(raw) || fs.statSync(raw).mtimeMs < fs.statSync(mp3).mtimeMs) {
    execFileSync('ffmpeg', ['-loglevel','error','-y','-i', mp3, '-ac','1','-ar', String(SR),'-f','f32le', raw], { stdio: 'inherit' });
  }
  const buf = fs.readFileSync(raw);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length/4));
}

// ─── load findSteadyRegion from analyzer HTML ────────────────────────────────

function loadAnalyzer() {
  const html = fs.readFileSync(ANALYZER_HTML, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no <script> block in analyzer HTML');
  const stub = {
    document: { getElementById:()=>({addEventListener:()=>{},textContent:'',value:'',dataset:{}}), addEventListener:()=>{}, readyState:'complete', createElement:()=>({appendChild:()=>{}}) },
    window: { AudioContext: function(){} }
  };
  const src = m[1] + '\n;return {findSteadyRegion};';
  const factory = new Function('document','window', src);
  return factory(stub.document, stub.window);
}

// ─── RMS measurement ─────────────────────────────────────────────────────────

function findTrimStart(d) {
  for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 0.003) return i;
  return 0;
}

function rmsOver(d, start, end) {
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) sum += d[i] * d[i];
  return Math.sqrt(sum / (end - start));
}

function peakOver(d, start, end) {
  let p = 0;
  for (let i = start; i < end; i++) { const a = Math.abs(d[i]); if (a > p) p = a; }
  return p;
}

function measureRmsLoop(d, instr, fns) {
  const trim = findTrimStart(d);
  /* Vibrato instruments need smoothing on the RMS curve so the AMP cycle
     doesn't drag troughs below 70% of peak and shatter the steady region. */
  const opts = { smoothMs: instr.vibrato ? 300 : 0 };
  const res = fns.findSteadyRegion(d, SR, trim, d.length, opts);
  if (res.failReason) return { rms: null, failReason: res.failReason };
  return {
    rms: rmsOver(d, res.steadyStart, res.steadyEnd),
    peak: peakOver(d, res.steadyStart, res.steadyEnd),
    region: 'steady',
  };
}

function measureRmsDecay(d) {
  /* For percussive/decaying content, use a short 100ms peak-loudness window.
     A 500ms window includes too much decay tail for fast-decaying notes
     (harp top end, piano top end) and drives RMS 15-30 dB below what's
     perceptually loud. 100ms aligns with loudness-integration time constants
     for transient sources and gives values that track perceived loudness. */
  const trim = findTrimStart(d);
  const winLen = Math.round(SR * 0.1);
  if (d.length - trim < winLen + Math.round(SR * 0.02)) {
    return { rms: null, failReason: 'sample too short for 100ms peak window' };
  }
  const hop = Math.round(SR * 0.02);
  let bestStart = trim, bestSumSq = 0;
  for (let s = trim; s + winLen < d.length; s += hop) {
    let sum = 0;
    for (let k = 0; k < winLen; k++) sum += d[s+k] * d[s+k];
    if (sum > bestSumSq) { bestSumSq = sum; bestStart = s; }
  }
  return {
    rms: Math.sqrt(bestSumSq / winLen),
    peak: peakOver(d, bestStart, bestStart + winLen),
    region: 'peak100ms',
  };
}

// ─── patching ────────────────────────────────────────────────────────────────

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const fmtGain = g => (+g.toFixed(4)).toString();

function patchEntryLine(line, gainStr) {
  /* Replace existing gain if present, else insert immediately after freq:N. */
  if (/,gain:[\d.]+/.test(line)) return line.replace(/,gain:[\d.]+/, `,gain:${gainStr}`);
  return line.replace(/(\{name:'[^']+',freq:[\d.]+)/, `$1,gain:${gainStr}`);
}

// ─── main ────────────────────────────────────────────────────────────────────

(function main() {
  const argv = process.argv.slice(2);
  const targetKeys = argv.length ? new Set(argv) : null;

  const orig = fs.readFileSync(SAMPLES_TS, 'utf8');
  const instruments = parseInstruments(orig);
  const allKeys = Object.keys(instruments);
  const keys = targetKeys ? allKeys.filter(k => targetKeys.has(k)) : allKeys;
  if (targetKeys) {
    const missing = [...targetKeys].filter(k => !instruments[k]);
    if (missing.length) console.error(`warning: not found in samples.ts: ${missing.join(', ')}`);
  }
  console.error(`parsed ${allKeys.length} instruments; processing ${keys.length}: ${keys.join(', ')}`);
  console.error(`target = ${TARGET_DBFS} dBFS RMS  (TARGET_RMS = ${TARGET_RMS.toFixed(5)})`);

  const fns = loadAnalyzer();
  const lines = orig.split('\n');
  const reportLines = [];
  reportLines.push(`# Sample gain backfill — measured RMS and computed gain factors`);
  reportLines.push('');
  reportLines.push(`- Target: **${TARGET_DBFS} dBFS RMS** per sample`);
  reportLines.push(`- TARGET_RMS = ${TARGET_RMS.toFixed(5)} (linear)`);
  reportLines.push(`- gain = TARGET_RMS / measuredRms, clamped to [${GAIN_MIN}, ${GAIN_MAX}]`);
  reportLines.push(`- Loop instruments: RMS over findSteadyRegion span (vibrato uses smoothMs=300)`);
  reportLines.push(`- Decay instruments: RMS over peak 500ms window post-trimStart`);
  reportLines.push('');

  for (const key of keys) {
    const instr = instruments[key];
    const path_ = instr.decays ? 'decay' : (instr.vibrato ? 'vibrato' : 'macro');
    console.error(`\n=== ${key} (${path_}, ${instr.samples.length} samples) ===`);
    reportLines.push(`## ${key} (${path_})`);
    reportLines.push('');
    reportLines.push(`| Sample | RMS | RMS dBFS | Peak dBFS | gain | note |`);
    reportLines.push(`| --- | ---: | ---: | ---: | ---: | --- |`);

    for (const s of instr.samples) {
      const mp3 = fetchOne(key, s.name, instr.baseUrl, instr.ext);
      if (!mp3) {
        console.error(`  ${s.name}: fetch failed`);
        reportLines.push(`| ${s.name} | — | — | — | fetch failed |`);
        continue;
      }
      const d = decodeOne(mp3);
      const meas = instr.decays ? measureRmsDecay(d) : measureRmsLoop(d, instr, fns);
      if (meas.rms == null) {
        console.error(`  ${s.name}: ${meas.failReason}`);
        reportLines.push(`| ${s.name} | — | — | — | ${meas.failReason} |`);
        continue;
      }
      const gainRms = TARGET_RMS / meas.rms;
      const gainPeak = (meas.peak > 0) ? (TARGET_PEAK / meas.peak) : Infinity;
      const rawGain = Math.min(gainRms, gainPeak);
      const gain = clamp(rawGain, GAIN_MIN, GAIN_MAX);
      const peakLimited = gainPeak < gainRms;
      const sanityClamped = (Math.abs(gain - rawGain) > 1e-9);
      const tag = sanityClamped ? '⚠ clamped' : (peakLimited ? 'peak-lim' : '');
      const dBFS = 20 * Math.log10(meas.rms);
      const peakDb = meas.peak > 0 ? 20 * Math.log10(meas.peak) : -Infinity;
      console.error(`  ${s.name}: rms=${meas.rms.toFixed(5)} (${dBFS.toFixed(1)} dBFS), peak=${peakDb.toFixed(1)} dBFS → gain=${fmtGain(gain)}${tag ? '  ' + tag : ''}`);
      reportLines.push(`| ${s.name} | ${meas.rms.toFixed(5)} | ${dBFS.toFixed(1)} | ${peakDb.toFixed(1)} | ${fmtGain(gain)} | ${tag} |`);

      lines[s.lineIdx] = patchEntryLine(lines[s.lineIdx], fmtGain(gain));
    }
    reportLines.push('');
  }

  fs.writeFileSync(SAMPLES_TS, lines.join('\n'));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const reportPath = path.join(OUT_DIR, 'gain-backfill-report.md');
  fs.writeFileSync(reportPath, reportLines.join('\n') + '\n');
  console.error(`\nwrote ${SAMPLES_TS}`);
  console.error(`wrote ${reportPath}`);
})();
