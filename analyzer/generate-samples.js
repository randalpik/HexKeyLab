#!/usr/bin/env node
/**
 * generate-samples.js — produce a samples.ts block for one instrument.
 *
 * Usage:
 *   node analyzer/generate-samples.js analyzer/configs/<name>.json
 *
 * Pipeline:
 *   1. Fetch every chromatic note in the config range from the CDN, cache to
 *      analyzer/.cache/<key>/<note>.mp3
 *   2. Decode each cached MP3 to f32 mono PCM at 44.1 kHz via ffmpeg
 *   3. Load tools/HexKeyLab-analyzer.html, evaluate its <script> with stub
 *      DOM globals, expose prepareLoopVibrato/prepareLoopMacroPeriod/
 *      refineFundamentalPeriod
 *   4. Run the appropriate path on each sample (loop vs decay, see plan)
 *   5. Tier-classify (loop) or peak-validate (decay)
 *   6. Pick samples at ~4-semitone spacing, prefer higher tier
 *   7. Emit two outputs in analyzer/out/:
 *        <key>-block.txt    — ready-to-paste JS source
 *        <key>-report.md    — diagnostics
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');
const ANALYZER_HTML = path.join(REPO, 'tools', 'HexKeyLab-analyzer.html');
const CACHE_DIR = path.join(__dirname, '.cache');
const OUT_DIR = path.join(__dirname, 'out');

const NOTES_FLAT  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
const NOTES_SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
// Tone.js Salamander naming + sparse sampling: only A/C/Ds/Fs at semitones 9/0/3/6
const SALAMANDER_NOTES = { 0:'C', 3:'Ds', 6:'Fs', 9:'A' };
const SEMI = {C:0,'C#':1,Db:1,D:2,'D#':3,Ds:3,Eb:3,E:4,F:5,'F#':6,Fs:6,Gb:6,G:7,'G#':8,Ab:8,A:9,'A#':10,Bb:10,B:11};
const SR = 44100;

/* Per-sample RMS-normalization target. The analyzer measures each sample's
   steady-region RMS (loop) or peak 500ms RMS (decay) and emits a `gain` field
   that brings the audible portion to TARGET_DBFS at runtime. Single source of
   truth for normalization — backfill-gains.js mirrors these constants. */
const TARGET_DBFS = -18;
const TARGET_RMS = Math.pow(10, TARGET_DBFS / 20);  /* ≈ 0.12589 */
const GAIN_MIN = 0.1;
const GAIN_MAX = 4.0;

// ─── 0. config + helpers ─────────────────────────────────────────────────────

function loadConfig() {
  const cfgPath = process.argv[2];
  if (!cfgPath) {
    console.error('Usage: node generate-samples.js <config.json>');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  // defaults
  cfg.transpose = cfg.transpose || 1;
  cfg.filePattern = cfg.filePattern || '{NOTE}.mp3';
  cfg.noteStyle = cfg.noteStyle || 'flat';
  cfg.ext = cfg.ext || '.mp3';
  cfg.volume = cfg.volume == null ? 1.0 : cfg.volume;
  cfg.releaseTime = cfg.releaseTime == null ? 0.3 : cfg.releaseTime;
  cfg.gateOpts = cfg.gateOpts || {};
  cfg.vibrato = cfg.vibrato === true;
  cfg.decays = cfg.decays === true;
  return cfg;
}

function noteNameToMidi(name) {
  const m = name.match(/^([A-G][#b]?)(\d+)$/);
  return 12*(parseInt(m[2])+1) + SEMI[m[1]];
}
function midiToFreq(midi) { return 440 * Math.pow(2, (midi - 69)/12); }

function enumerateNotes(cfg) {
  const out = [];
  // noteSemis: which semitones to enumerate per octave (default all 12).
  // Used for sparsely-sampled soundfonts like Salamander piano (every minor
  // third) or FluidR3 harp (same spacing, different naming).
  const semis = cfg.noteSemis || [0,1,2,3,4,5,6,7,8,9,10,11];
  for (let oct = cfg.lowOct; oct <= cfg.highOct; oct++) {
    for (const semi of semis) {
      let name;
      if (cfg.noteStyle === 'salamander') name = SALAMANDER_NOTES[semi];
      else if (cfg.noteStyle === 'sharp') name = NOTES_SHARP[semi];
      else                                 name = NOTES_FLAT[semi];
      if (!name) continue;
      const note = name + oct;
      const midi = 12*(oct+1) + semi;
      out.push({ note, midi, labeledFreq: midiToFreq(midi) });
    }
  }
  return out;
}

function buildUrl(cfg, note) {
  return cfg.baseUrl + cfg.filePattern.replace('{NOTE}', note).replace(/#/g, '%23');
}

// ─── 1. fetch (curl, cached) ─────────────────────────────────────────────────

function fetchAll(cfg, notes) {
  const dir = path.join(CACHE_DIR, cfg.instrumentKey);
  fs.mkdirSync(dir, { recursive: true });
  const fetched = [];
  let nFetched = 0, nCached = 0, nMiss = 0;
  for (const n of notes) {
    const mp3 = path.join(dir, `${n.note}${cfg.ext}`);
    if (!fs.existsSync(mp3) || fs.statSync(mp3).size === 0) {
      const url = buildUrl(cfg, n.note);
      const r = spawnSync('curl', ['-sLfo', mp3, url], { stdio: 'ignore' });
      if (r.status !== 0) {
        try { fs.unlinkSync(mp3); } catch {}
        nMiss++;
        continue;
      }
      nFetched++;
    } else {
      nCached++;
    }
    fetched.push({ ...n, mp3 });
  }
  console.error(`fetch: ${nFetched} new, ${nCached} cached, ${nMiss} 404/missing`);
  return fetched;
}

// ─── 2. decode (ffmpeg → f32 mono 44.1k) ─────────────────────────────────────

function decodeAll(samples) {
  for (const s of samples) {
    const raw = s.mp3.replace(/\.\w+$/, '.raw');
    if (!fs.existsSync(raw) || fs.statSync(raw).mtimeMs < fs.statSync(s.mp3).mtimeMs) {
      execFileSync('ffmpeg', ['-loglevel','error','-y','-i', s.mp3, '-ac','1','-ar', String(SR),'-f','f32le', raw], { stdio: 'inherit' });
    }
    s.raw = raw;
  }
}

function loadRaw(rawPath) {
  const buf = fs.readFileSync(rawPath);
  const data = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length/4));
  return { sampleRate: SR, length: data.length, getChannelData: () => data };
}

// ─── 3. load analyzer functions from HTML ────────────────────────────────────

function loadAnalyzer() {
  const html = fs.readFileSync(ANALYZER_HTML, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no <script> block in analyzer HTML');
  // stub the DOM bits the analyzer uses on load (DOMContentLoaded listener etc.)
  const stub = {
    document: { getElementById:()=>({addEventListener:()=>{},textContent:'',value:'',dataset:{}}), addEventListener:()=>{}, readyState:'complete', createElement:()=>({appendChild:()=>{}}) },
    window: { AudioContext: function(){} }
  };
  // create a function whose body is the analyzer's <script> content, with
  // the exports we need bound at the end
  const src = m[1] + '\n;return {prepareLoopVibrato, prepareLoopMacroPeriod, refineFundamentalPeriod, findSteadyRegion};';
  const factory = new Function('document','window', src);
  return factory(stub.document, stub.window);
}

// ─── 4. analysis paths ───────────────────────────────────────────────────────

function analyzeLoop(buf, freq, cfg, fns) {
  const opts = { ...(cfg.gateOpts || {}) };
  if (cfg.vibrato) return fns.prepareLoopVibrato(buf, freq, opts);
  return fns.prepareLoopMacroPeriod(buf, freq, opts);
}

function analyzeDecay(buf, freq, fns) {
  // For decay instruments the envelope is by definition non-steady. The
  // 70%-of-peak `findSteadyRegion` heuristic that loop instruments use can
  // shatter on fast-decaying high notes (one short above-threshold blip,
  // then below). Instead, just lock onto the loudest 500ms window after
  // trimStart — that's where pitch is most defined, regardless of the
  // overall envelope shape.
  const d = buf.getChannelData();
  const sr = buf.sampleRate;
  let trimStart = 0;
  for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 0.003) { trimStart = i; break; }
  const winLen = Math.round(sr * 0.5);
  if (d.length - trimStart < winLen + Math.round(sr * 0.05)) {
    return { failReason: 'sample too short for decay analysis', trimStart: trimStart/sr };
  }
  // slide a 500ms window forward, find the position with highest RMS
  const hop = Math.round(sr * 0.05);
  let bestStart = trimStart, bestRms = 0;
  for (let s = trimStart; s + winLen < d.length; s += hop) {
    let sum = 0;
    for (let k = 0; k < winLen; k++) sum += d[s+k] * d[s+k];
    if (sum > bestRms) { bestRms = sum; bestStart = s; }
  }
  const T = fns.refineFundamentalPeriod(d, sr, freq, bestStart, bestStart + winLen, { tRefineRange: 0.05, minPeakRatio: 0.5 });
  if (T == null) return { failReason: 'no fundamental at labeled freq ±5%', trimStart: trimStart/sr };
  return {
    trimStart: trimStart/sr,
    freqActual: 1/T,
    driftCents: 1200 * Math.log2((1/T)/freq),
    method: 'decay'
  };
}

// ─── 4b. RMS measurement for gain normalization ─────────────────────────────

function findGainTrimStart(d) {
  for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 0.003) return i;
  return 0;
}

function rmsOver(d, start, end) {
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) sum += d[i] * d[i];
  return Math.sqrt(sum / (end - start));
}

function measureRmsDecay(d) {
  /* 100ms peak-loudness window — see comment in backfill-gains.js. The
     analyzer's separate analyzeDecay() uses 500ms because that window is for
     pitch refinement (autocorrelation needs duration); amplitude measurement
     wants something closer to perceptual integration. */
  const trim = findGainTrimStart(d);
  const winLen = Math.round(SR * 0.1);
  if (d.length - trim < winLen + Math.round(SR * 0.02)) return null;
  const hop = Math.round(SR * 0.02);
  let bestSumSq = 0;
  for (let s = trim; s + winLen < d.length; s += hop) {
    let sum = 0;
    for (let k = 0; k < winLen; k++) sum += d[s+k] * d[s+k];
    if (sum > bestSumSq) bestSumSq = sum;
  }
  return Math.sqrt(bestSumSq / winLen);
}

function measureRmsLoop(d, cfg, fns) {
  const trim = findGainTrimStart(d);
  /* Vibrato instruments smooth the RMS envelope so AMP cycles don't drag
     troughs below the 70% threshold and shatter the steady region. */
  const opts = { smoothMs: cfg.vibrato ? 300 : 0 };
  const res = fns.findSteadyRegion(d, SR, trim, d.length, opts);
  if (res.failReason) return null;
  return rmsOver(d, res.steadyStart, res.steadyEnd);
}

function computeGainFromRms(rms) {
  if (rms == null || rms <= 0) return null;
  return Math.max(GAIN_MIN, Math.min(GAIN_MAX, TARGET_RMS / rms));
}

// ─── 5. classify ─────────────────────────────────────────────────────────────

function classifyLoop(res) {
  if (!res || res.failReason || !res.loopPts || res.loopPts.length < 2) return 'fail';
  const s = res.stats || {};
  const seams  = s.validSeams  || 0;
  const ub     = s.usableBs    || 0;
  const corr   = s.minPickCorr || 0;
  if (seams < 2 || ub < 2) return 'red';
  if (seams < 4 || ub < 3) return 'yellow';
  if (corr >= 0.93) return 'green';
  return 'blue';
}

function classifyDecay(res) {
  if (!res || res.failReason) return 'fail';
  if (Math.abs(res.driftCents) > 50) return 'yellow'; // suspect labeling/tuning
  return 'green';
}

// ─── 6. select at 4-semitone spacing ─────────────────────────────────────────

const TIER_RANK = { green: 4, blue: 3, yellow: 2, red: 1, fail: 0 };

function pickSamples(results, cfg) {
  const usable = results.filter(r => r.tier === 'green' || r.tier === 'blue' || r.tier === 'yellow');
  if (usable.length === 0) return [];
  usable.sort((a,b) => a.midi - b.midi);

  // Decay instruments have no loop-quality tiering; samples are typically
  // pre-curated by the soundfont author. Keep every valid sample.
  if (cfg.decays) return usable.slice();

  // Loop instruments: ~4-semitone spacing, preferring higher tier within
  // each ±2-semitone window.
  const picked = [];
  let target = usable[0].midi;
  const maxMidi = usable[usable.length - 1].midi;
  const used = new Set();
  while (target <= maxMidi + 2) {
    const win = usable.filter(r => Math.abs(r.midi - target) <= 2 && !used.has(r.note));
    if (win.length === 0) { target += 4; continue; }
    win.sort((a,b) => {
      if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[b.tier] - TIER_RANK[a.tier];
      const ca = (a.res.stats && a.res.stats.minPickCorr) || 0;
      const cb = (b.res.stats && b.res.stats.minPickCorr) || 0;
      return cb - ca;
    });
    picked.push(win[0]);
    used.add(win[0].note);
    target = win[0].midi + 4;
  }
  return picked;
}

// ─── 7. emit JS source ───────────────────────────────────────────────────────

const fmt = (x, n) => (+x.toFixed(n)).toString();

function emitSampleEntry(r, cfg) {
  // freq = analyzer-measured actual audio fundamental
  // (for decay this is res.freqActual; for loop pipelines we surface freqActual too)
  const freq = (typeof r.res.freqActual === 'number') ? r.res.freqActual : r.labeledFreq / cfg.transpose;
  const freqStr = fmt(freq, 3);
  /* gain = TARGET_RMS / measuredRms, clamped. Goes immediately after freq so
     the schema fans out: identifier (name), pitch (freq), level (gain), then
     loop-specific fields. Falls back to 1.0 silently at runtime if absent. */
  const gainStr = (typeof r.gain === 'number') ? `,gain:${fmt(r.gain, 4)}` : '';

  if (cfg.decays) {
    return `        {name:'${r.note}',freq:${freqStr}${gainStr}}`;
  }

  // loop entry
  const ptsStr = '[' + r.res.loopPts.map(p => fmt(p, 7)).join(',') + ']';
  const ebsStr = '[' + (r.res.validStartsByEnd || []).map(arr => '['+arr.join(',')+']').join(',') + ']';
  const slopeStr = (typeof r.res.slopeCV === 'number') ? `,slopeCV:${fmt(r.res.slopeCV, 3)}` : '';
  return `        {name:'${r.note}',freq:${freqStr}${gainStr},loopPts:${ptsStr},validStartsByEnd:${ebsStr},trimStart:${fmt(r.res.trimStart, 7)}${slopeStr}}`;
}

// Path-specific default comments. Override per-instrument via cfg.comment
// (an array of lines, no leading whitespace, no comment delimiters).
function defaultComment(cfg) {
  if (cfg.decays) {
    return [
      'Decay path: each freq is the recording\'s autocorrelation-measured',
      'fundamental, so the engine plays each sample at native rate=1.0 for',
      'matched pitches (no labeled-vs-actual drift). Generated by',
      `analyzer/generate-samples.js from ${path.basename(process.argv[2] || 'unknown.json')}.`,
    ];
  }
  if (cfg.vibrato) {
    return [
      'Loop path (prepareLoopVibrato). Every loop point is a positive-going',
      'waveform zero-crossing aligned with the dominant AMP/PITCH vibrato',
      'cycle, so any pair loops seamlessly in both fundamental waveform and',
      'modulation envelope (minPickCorr ≥ 0.93 across all picks). Generated',
      `by analyzer/generate-samples.js from ${path.basename(process.argv[2] || 'unknown.json')}.`,
    ];
  }
  return [
    'Loop path (prepareLoopMacroPeriod). Each loop point is a phase-coherent',
    'positive-going zero-crossing on a regular grid at the autocorrelation-',
    'refined fundamental period, so the runtime engine can wrap between any',
    'pair of points without timbral discontinuity. Generated by',
    `analyzer/generate-samples.js from ${path.basename(process.argv[2] || 'unknown.json')}.`,
  ];
}

function emitBlock(picks, cfg) {
  const lines = [];
  lines.push(`    ${cfg.instrumentKey}:{`);
  lines.push(`      name:'${cfg.displayName}',baseUrl:'${cfg.baseUrl}',`);
  const decayFlag = cfg.decays ? 'decays:true' : 'decays:false';
  const loopFlag  = cfg.decays ? 'loop:false' : 'loop:true';
  let header = `      ext:'${cfg.ext}',releaseTime:${cfg.releaseTime},volume:${cfg.volume},${loopFlag},${decayFlag}`;
  if (!cfg.decays && cfg.vibrato) header += ',vibrato:true';
  lines.push(header + ',');
  // Comment: per-config override (cfg.comment as an array of lines) takes
  // precedence over the path-default. This lets configs document
  // instrument-specific quirks (e.g. piano's Railsback-curve drift,
  // drawbar's filename-octave convention) without losing the documentation
  // on every regen.
  const commentLines = (cfg.comment && cfg.comment.length) ? cfg.comment : defaultComment(cfg);
  lines.push(`      /* ${commentLines[0]}`);
  for (let i = 1; i < commentLines.length; i++) {
    const last = i === commentLines.length - 1;
    lines.push(`         ${commentLines[i]}${last ? ' */' : ''}`);
  }
  lines.push(`      samples:[`);
  picks.forEach((r,i) => lines.push(emitSampleEntry(r, cfg) + (i < picks.length-1 ? ',' : '')));
  lines.push(`      ]`);
  lines.push(`    },`);
  return lines.join('\n') + '\n';
}

// ─── 8. report ───────────────────────────────────────────────────────────────

function buildReport(results, picks, cfg) {
  const tally = { green: 0, blue: 0, yellow: 0, red: 0, fail: 0 };
  results.forEach(r => tally[r.tier]++);
  const lines = [];
  lines.push(`# ${cfg.displayName} (${cfg.instrumentKey}) — analysis report`);
  lines.push('');
  lines.push(`- Path: **${cfg.decays ? 'decay (freq-only)' : (cfg.vibrato ? 'loop / vibrato' : 'loop / macro-period')}**`);
  lines.push(`- Range: ${cfg.lowOct}–${cfg.highOct} (${results.length} samples analyzed)`);
  lines.push(`- Transpose: ${cfg.transpose}`);
  lines.push('');
  lines.push(`## Tier distribution`);
  lines.push('');
  lines.push(`| Tier | Count |`);
  lines.push(`| --- | ---: |`);
  for (const t of ['green','blue','yellow','red','fail']) lines.push(`| ${t} | ${tally[t]} |`);
  lines.push('');
  lines.push(`## Picks (${picks.length}, ~4-semitone spacing)`);
  lines.push('');
  const gainCol = (p) => {
    if (typeof p.rms !== 'number' || p.rms <= 0) return '— | —';
    const dBFS = (20 * Math.log10(p.rms)).toFixed(1);
    const g = (typeof p.gain === 'number') ? p.gain.toFixed(4) : '—';
    return `${dBFS} | ${g}`;
  };
  if (cfg.decays) {
    lines.push(`| Note | Labeled (Hz) | Measured (Hz) | Drift (¢) | RMS (dBFS) | gain | Tier |`);
    lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | --- |`);
    picks.forEach(p => {
      const drift = p.res.driftCents != null ? p.res.driftCents.toFixed(1) : '—';
      const fa    = p.res.freqActual != null ? p.res.freqActual.toFixed(2) : '—';
      lines.push(`| ${p.note} | ${p.labeledFreq.toFixed(2)} | ${fa} | ${drift} | ${gainCol(p)} | ${p.tier} |`);
    });
  } else {
    lines.push(`| Note | Hz | minPickCorr | seams | usable | RMS (dBFS) | gain | tier |`);
    lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |`);
    picks.forEach(p => {
      const s = p.res.stats || {};
      const fa = p.res.freqActual != null ? p.res.freqActual.toFixed(2) : p.labeledFreq.toFixed(2);
      lines.push(`| ${p.note} | ${fa} | ${s.minPickCorr || '—'} | ${s.validSeams || '—'} | ${s.usableBs || '—'} | ${gainCol(p)} | ${p.tier} |`);
    });
  }
  // failures
  const failed = results.filter(r => r.tier === 'fail' || r.tier === 'red');
  if (failed.length) {
    lines.push('');
    lines.push(`## Excluded samples (${failed.length})`);
    lines.push('');
    failed.forEach(f => {
      const reason = (f.res && f.res.failReason) || (f.res && f.res.stats && f.res.stats.failReason) || f.tier;
      lines.push(`- ${f.note}: ${reason}`);
    });
  }
  return lines.join('\n') + '\n';
}

// ─── main ────────────────────────────────────────────────────────────────────

(async function main() {
  const cfg = loadConfig();
  console.error(`config: ${cfg.instrumentKey} (${cfg.displayName}), ${cfg.decays?'decay':'loop'} path${cfg.vibrato?', vibrato':''}, transpose=${cfg.transpose}`);
  const notes = enumerateNotes(cfg);
  console.error(`enumerated ${notes.length} notes (${cfg.lowOct}–${cfg.highOct})`);
  const samples = fetchAll(cfg, notes);
  decodeAll(samples);
  const fns = loadAnalyzer();
  const results = samples.map(s => {
    const buf = loadRaw(s.raw);
    const analysisFreq = s.labeledFreq / cfg.transpose;
    const res = cfg.decays ? analyzeDecay(buf, analysisFreq, fns)
                            : analyzeLoop(buf, analysisFreq, cfg, fns);
    const tier = cfg.decays ? classifyDecay(res) : classifyLoop(res);
    const d = buf.getChannelData();
    const rms = cfg.decays ? measureRmsDecay(d) : measureRmsLoop(d, cfg, fns);
    const gain = computeGainFromRms(rms);
    return { note: s.note, midi: s.midi, labeledFreq: s.labeledFreq, res, tier, rms, gain };
  });
  const picks = pickSamples(results, cfg);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const blockPath  = path.join(OUT_DIR, `${cfg.instrumentKey}-block.txt`);
  const reportPath = path.join(OUT_DIR, `${cfg.instrumentKey}-report.md`);
  fs.writeFileSync(blockPath,  emitBlock(picks, cfg));
  fs.writeFileSync(reportPath, buildReport(results, picks, cfg));
  console.error(`\nwrote: ${blockPath}\nwrote: ${reportPath}`);
  console.error(`picks: ${picks.length}`);
})();
