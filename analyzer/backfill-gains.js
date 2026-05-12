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
 *   1. Fetch baseUrl + name + ext to analyzer/.cache/<configName>/<name>.mp3 (curl)
 *      — <configName> resolved from baseUrl via analyzer/configs/*.json so the
 *      cache lines up with generate-samples.js's per-config directories.
 *   2. Decode to f32 mono PCM @ 44.1 kHz via ffmpeg → analyzer/.cache/.../*.raw
 *   3. Find trimStart (first |x|>0.003) and measure RMS:
 *        loop  : findSteadyRegion (50ms/10ms RMS curve, ≥70% peak run); RMS
 *                over the steady span. vibrato:true passes smoothMs=300.
 *                gain = TARGET_RMS / measuredRms (peak-ceiling capped).
 *        decay : peak amplitude in attack region (first 200ms post-trim).
 *                gain = TARGET_PEAK_DECAY / peak (so all decay sample peaks
 *                land at the same dB).
 *   4. gain = 10^(TARGET_DBFS/20) / rms, floored at GAIN_MIN (no ceiling)
 *   5. Patch `gain:N.NNNN` into the entry line right after `freq:`
 *
 * Idempotent: if a `gain:` field is already present, it's replaced. Writes a
 * markdown report to analyzer/out/gain-backfill-report.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');
/* findSteadyRegion etc. live in the modular ESM at analyzer-analysis.js
   (extracted from the old monolithic tools/HexKeyLab-analyzer.html). */
const ANALYZER_ANALYSIS_JS = path.join(__dirname, 'analyzer-analysis.js');
/* The INSTRUMENTS map was split out of samples.ts into samples-data.ts when
   the audio engine was modularized. */
const SAMPLES_TS = path.join(REPO, 'src', 'audio', 'samples-data.ts');
const CACHE_DIR = path.join(__dirname, '.cache');
const CONFIGS_DIR = path.join(__dirname, 'configs');
const OUT_DIR = path.join(__dirname, 'out');

/* Build a baseUrl → config-basename index so we can reuse the same per-config
   cache directories generate-samples.js writes. Without this, backfill would
   write to .cache/<instrumentKey>/ while generate writes to .cache/<configName>/,
   producing parallel caches that get out of sync. */
function buildConfigIndex() {
  const map = {};
  for (const f of fs.readdirSync(CONFIGS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, f), 'utf8'));
      if (cfg.baseUrl) map[cfg.baseUrl] = f.replace(/\.json$/, '');
    } catch { /* ignore malformed configs */ }
  }
  return map;
}

const SR = 44100;
const TARGET_DBFS = -18;
const TARGET_RMS = Math.pow(10, TARGET_DBFS / 20);  /* ≈ 0.12589 */
/* Decay path uses PEAK normalization, not RMS: every decay sample's attack
   peak lands at exactly the same dB after gain. RMS-based targeting fails on
   decay sounds because crest factor varies wildly across the keyboard — fast-
   decaying high notes have high crest factor, so equal-RMS gives unequal
   peaks. Peak normalization side-steps this: gain = TARGET_PEAK_DECAY / peak. */
const TARGET_PEAK_DECAY_DBFS = -6;
const TARGET_PEAK_DECAY = Math.pow(10, TARGET_PEAK_DECAY_DBFS / 20);  /* ≈ 0.5012 */
/* Peak ceiling: caps any sample's post-gain peak at -3 dBFS. Decay path
   normally targets -6 dBFS so this rarely engages there; it's the active
   limiter for loop instruments where TARGET_RMS would otherwise push some
   samples' peak above the ceiling. */
const PEAK_DBFS = -3;
const TARGET_PEAK = Math.pow(10, PEAK_DBFS / 20);   /* ≈ 0.7079 */
/* Floor only — see generate-samples.js for rationale. No GAIN_MAX: quiet
   sources are normalized to target regardless of how much gain that takes.
   Per-note level consistency is the higher priority. */
const GAIN_MIN = 0.1;

// ─── parse INSTRUMENTS map from samples-data.ts ──────────────────────────────

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

function fetchOne(cacheSubdir, sampleName, baseUrl, ext) {
  const dir = path.join(CACHE_DIR, cacheSubdir);
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
  /* Append `.raw` (not replace ext) so distinct source extensions in the
     same cache dir get distinct decoded outputs. See generate-samples.js
     decodeOne for the full rationale. */
  const raw = mp3 + '.raw';
  if (!fs.existsSync(raw) || fs.statSync(raw).mtimeMs < fs.statSync(mp3).mtimeMs) {
    execFileSync('ffmpeg', ['-loglevel','error','-y','-i', mp3, '-ac','1','-ar', String(SR),'-f','f32le', raw], { stdio: 'inherit' });
  }
  const buf = fs.readFileSync(raw);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length/4));
}

/* Stereo decode for peak measurement. The browser plays stereo and the
   diagnostic tap reads each channel separately — runtime peak is
   max(|L|,|R|) per frame, NOT the mono downmix. ffmpeg's mono downmix
   ((L+R)/√2) attenuates anti-correlated stereo content (e.g. piano hammer
   resonance with stereo width) by up to 6+ dB versus the actual played
   peak, which makes a peak-based gain calibration over-boost those samples.
   Returns interleaved [L0,R0,L1,R1,...]. */
function decodeStereo(mp3) {
  const raw = mp3 + '.s2.raw';
  if (!fs.existsSync(raw) || fs.statSync(raw).mtimeMs < fs.statSync(mp3).mtimeMs) {
    execFileSync('ffmpeg', ['-loglevel','error','-y','-i', mp3, '-ac','2','-ar', String(SR),'-f','f32le', raw], { stdio: 'inherit' });
  }
  const buf = fs.readFileSync(raw);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length/4));
}

// ─── load findSteadyRegion from analyzer-analysis.js ─────────────────────────

async function loadAnalyzer() {
  const mod = await import(pathToFileURL(ANALYZER_ANALYSIS_JS).href);
  const api = mod.HKLAnalysis;
  if (!api || !api.findSteadyRegion) throw new Error('analyzer-analysis.js did not export HKLAnalysis.findSteadyRegion');
  return { findSteadyRegion: api.findSteadyRegion };
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

function measurePeakDecay(stereo, mono) {
  /* Peak amplitude normalization for decay instruments. Peak is measured on
     STEREO data as max(|L|,|R|) per frame, because that's what the runtime
     plays and what determines clip-relevant amplitude — mono downmix
     under-reports anti-correlated content. Trim/search range is in mono-
     sample coordinates and applies to the stereo data 1:1 (same SR). */
  const trim = findTrimStart(mono);
  const peakSearchLen = Math.round(SR * 0.2);
  const monoLen = mono.length;
  if (monoLen <= trim) {
    return { peak: null, failReason: 'sample empty after trim' };
  }
  const searchEnd = Math.min(trim + peakSearchLen, monoLen);
  let peakPos = trim, peakAbs = 0;
  for (let i = trim; i < searchEnd; i++) {
    const aL = Math.abs(stereo[2*i]);
    const aR = Math.abs(stereo[2*i+1]);
    const a = aL > aR ? aL : aR;
    if (a > peakAbs) { peakAbs = a; peakPos = i; }
  }
  /* Diagnostic 25ms energy-summed RMS at peak — not used for gain, just reported */
  const winLen = Math.round(SR * 0.025);
  let rms = null;
  if (peakPos + winLen <= monoLen) {
    let sumL = 0, sumR = 0;
    for (let k = 0; k < winLen; k++) {
      const L = stereo[2*(peakPos+k)];
      const R = stereo[2*(peakPos+k)+1];
      sumL += L*L; sumR += R*R;
    }
    rms = Math.sqrt((sumL + sumR) / winLen);
  }
  return {
    rms,
    peak: peakAbs,
    region: 'attackPeakStereo',
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

(async function main() {
  const argv = process.argv.slice(2);
  const targetKeys = argv.length ? new Set(argv) : null;

  const orig = fs.readFileSync(SAMPLES_TS, 'utf8');
  const instruments = parseInstruments(orig);
  const allKeys = Object.keys(instruments);
  const keys = targetKeys ? allKeys.filter(k => targetKeys.has(k)) : allKeys;
  if (targetKeys) {
    const missing = [...targetKeys].filter(k => !instruments[k]);
    if (missing.length) console.error(`warning: not found in samples-data.ts: ${missing.join(', ')}`);
  }
  console.error(`parsed ${allKeys.length} instruments; processing ${keys.length}: ${keys.join(', ')}`);
  console.error(`target = ${TARGET_DBFS} dBFS RMS  (TARGET_RMS = ${TARGET_RMS.toFixed(5)})`);

  const fns = await loadAnalyzer();
  const configByBaseUrl = buildConfigIndex();
  const lines = orig.split('\n');
  const reportLines = [];
  reportLines.push(`# Sample gain backfill — measured RMS and computed gain factors`);
  reportLines.push('');
  reportLines.push(`- Target: **${TARGET_DBFS} dBFS RMS** per sample`);
  reportLines.push(`- TARGET_RMS = ${TARGET_RMS.toFixed(5)} (linear)`);
  reportLines.push(`- Loop instruments: gain = TARGET_RMS (${TARGET_RMS.toFixed(5)}, ${TARGET_DBFS} dBFS) / measuredRmsOverSteadyRegion`);
  reportLines.push(`- Decay instruments: gain = TARGET_PEAK_DECAY (${TARGET_PEAK_DECAY.toFixed(5)}, ${TARGET_PEAK_DECAY_DBFS} dBFS) / measuredAttackPeak — every decay-sample peak normalized to the same dB`);
  reportLines.push(`- Both paths peak-ceiling capped at ${PEAK_DBFS} dBFS, gain floored at ${GAIN_MIN} (no ceiling)`);
  reportLines.push('');

  for (const key of keys) {
    const instr = instruments[key];
    const path_ = instr.decays ? 'decay' : (instr.vibrato ? 'vibrato' : 'macro');
    /* Resolve the cache subdir from the instrument's baseUrl via the
       config index. Falls back to the instrument key with a warning if no
       matching config exists — that means generate-samples.js hasn't been
       run for this source, so the parallel cache is the best we can do. */
    const cacheSubdir = configByBaseUrl[instr.baseUrl] || key;
    if (!configByBaseUrl[instr.baseUrl]) {
      console.error(`  warning: no config matches ${key}'s baseUrl; caching under "${key}"`);
    }
    console.error(`\n=== ${key} (${path_}, ${instr.samples.length} samples)  cache=${cacheSubdir} ===`);
    reportLines.push(`## ${key} (${path_}, cache: \`${cacheSubdir}\`)`);
    reportLines.push('');
    reportLines.push(`| Sample | RMS | RMS dBFS | Peak dBFS | gain | note |`);
    reportLines.push(`| --- | ---: | ---: | ---: | ---: | --- |`);

    for (const s of instr.samples) {
      const mp3 = fetchOne(cacheSubdir, s.name, instr.baseUrl, instr.ext);
      if (!mp3) {
        console.error(`  ${s.name}: fetch failed`);
        reportLines.push(`| ${s.name} | — | — | — | fetch failed |`);
        continue;
      }
      const d = decodeOne(mp3);
      const meas = instr.decays ? measurePeakDecay(decodeStereo(mp3), d) : measureRmsLoop(d, instr, fns);
      const measFailed = instr.decays ? (meas.peak == null) : (meas.rms == null);
      if (measFailed) {
        console.error(`  ${s.name}: ${meas.failReason}`);
        reportLines.push(`| ${s.name} | — | — | — | ${meas.failReason} |`);
        continue;
      }
      /* Decay: peak-target normalization. Loop: RMS-target normalization with
         peak ceiling. Floored at GAIN_MIN; no ceiling — see file header. */
      const gainTarget = instr.decays
        ? (meas.peak > 0 ? TARGET_PEAK_DECAY / meas.peak : Infinity)
        : (TARGET_RMS / meas.rms);
      const gainCeiling = (meas.peak > 0) ? (TARGET_PEAK / meas.peak) : Infinity;
      const rawGain = Math.min(gainTarget, gainCeiling);
      const gain = Math.max(GAIN_MIN, rawGain);
      const peakLimited = gainCeiling < gainTarget;
      const tag = peakLimited ? 'peak-lim' : '';
      const rmsStr = meas.rms != null ? meas.rms.toFixed(5) : '—';
      const dBFS = meas.rms != null ? (20 * Math.log10(meas.rms)).toFixed(1) : '—';
      const peakDb = meas.peak > 0 ? 20 * Math.log10(meas.peak) : -Infinity;
      console.error(`  ${s.name}: rms=${rmsStr} (${dBFS} dBFS), peak=${peakDb.toFixed(1)} dBFS → gain=${fmtGain(gain)}${tag ? '  ' + tag : ''}`);
      reportLines.push(`| ${s.name} | ${rmsStr} | ${dBFS} | ${peakDb.toFixed(1)} | ${fmtGain(gain)} | ${tag} |`);

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
