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
// Sharp naming with 's' suffix instead of '#' — used by nbrosowsky/tonejs-instruments.
// Avoids URL-encoding sharps, since 's' is filename-safe.
const NOTES_SHARP_S = ['C','Cs','D','Ds','E','F','Fs','G','Gs','A','As','B'];
// Lowercase sharp naming — used by peastman/sso (oboe-a#4.wav, etc.)
const NOTES_SHARP_LOWER = ['c','c#','d','d#','e','f','f#','g','g#','a','a#','b'];
// Tone.js Salamander naming + sparse sampling: only A/C/Ds/Fs at semitones 9/0/3/6
const SALAMANDER_NOTES = { 0:'C', 3:'Ds', 6:'Fs', 9:'A' };
const SEMI = {C:0,'C#':1,Cs:1,Db:1,D:2,'D#':3,Ds:3,Eb:3,E:4,F:5,'F#':6,Fs:6,Gb:6,G:7,'G#':8,Gs:8,Ab:8,A:9,'A#':10,As:10,Bb:10,B:11};
const SR = 44100;

/* Per-sample normalization targets. Loop instruments use RMS targeting
   (steady-region RMS → TARGET_DBFS). Decay instruments use peak targeting
   (attack peak → TARGET_PEAK_DECAY_DBFS) so every decay sample's peak lands
   at the same dB regardless of how fast the note decays. Single source of
   truth — backfill-gains.js mirrors these constants. */
const TARGET_DBFS = -18;
const TARGET_RMS = Math.pow(10, TARGET_DBFS / 20);  /* ≈ 0.12589 */
const TARGET_PEAK_DECAY_DBFS = -6;
const TARGET_PEAK_DECAY = Math.pow(10, TARGET_PEAK_DECAY_DBFS / 20);  /* ≈ 0.5012 */
const GAIN_MIN = 0.1;
const GAIN_MAX = 12.0;

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
      else if (cfg.noteStyle === 'sharp_s') name = NOTES_SHARP_S[semi];
      else if (cfg.noteStyle === 'sharp_lower') name = NOTES_SHARP_LOWER[semi];
      else                                 name = NOTES_FLAT[semi];
      if (!name) continue;
      const note = name + oct;
      const midi = 12*(oct+1) + semi;
      out.push({ note, midi, labeledFreq: midiToFreq(midi) });
    }
  }
  return out;
}

function applyPlaceholders(pattern, note, midi) {
  // {NOTE}        — full note name with octave, sharp/flat (e.g. "F#4", "Bb3")
  // {NOTE_LETTER} — letter without octave (e.g. "F#", "Bb")
  // {NOTE_LOWER}  — full note name lowercased (SSO harp uses "harp-c4.wav")
  // {MIDI}        — 3-digit zero-padded MIDI number (SSO organ, jRhodes3d)
  // '#' is URL-encoded *after* substitution so the placeholder itself
  // never needs to be entered already-encoded.
  const letter = note.replace(/\d+$/, '');
  const midiStr = String(midi).padStart(3, '0');
  return pattern
    .replace(/\{NOTE_LETTER\}/g, letter)
    .replace(/\{NOTE_LOWER\}/g, note.toLowerCase())
    .replace(/\{MIDI\}/g, midiStr)
    .replace(/\{NOTE\}/g, note)
    .replace(/#/g, '%23');
}

function buildUrls(cfg, note, midi) {
  // filePatterns (plural) — array of templates to try in order. The first
  // that successfully fetches wins. Used for Iowa strings where the sul-string
  // prefix varies per pitch and we'd rather brute-force than encode a
  // string-per-note table.
  const patterns = cfg.filePatterns || [cfg.filePattern];
  return patterns.map(p => cfg.baseUrl + applyPlaceholders(p, note, midi));
}

// ─── 1. fetch (curl, cached) ─────────────────────────────────────────────────

/* Local copy of the cached file lives at dir/<note>.<ext>; the matchedPattern
   sidecar (dir/<note>.pattern) records which filePattern actually fetched, so
   subsequent runs reuse the same cached file without re-checking every URL and
   emitSampleEntry can record the per-sample filename for the runtime to fetch
   from. Sidecar absence (legacy cache) means: assume the first filePattern is
   the match — acceptable for single-pattern configs and harmless for the rare
   regeneration where the first pattern wasn't actually the one that hit. */
function fetchAll(cfg, notes) {
  const dir = path.join(CACHE_DIR, cfg.instrumentKey);
  fs.mkdirSync(dir, { recursive: true });
  const fetched = [];
  let nFetched = 0, nCached = 0, nMiss = 0;
  for (const n of notes) {
    const mp3 = path.join(dir, `${n.note}${cfg.ext}`);
    const patFile = path.join(dir, `${n.note}.pattern`);
    let matchedFile = null;
    if (!fs.existsSync(mp3) || fs.statSync(mp3).size === 0) {
      const patterns = cfg.filePatterns || [cfg.filePattern];
      let ok = false;
      for (const pattern of patterns) {
        const url = cfg.baseUrl + applyPlaceholders(pattern, n.note, n.midi);
        const r = spawnSync('curl', ['-sLfo', mp3, url], { stdio: 'ignore' });
        if (r.status === 0 && fs.existsSync(mp3) && fs.statSync(mp3).size > 0) {
          ok = true;
          matchedFile = applyPlaceholders(pattern, n.note, n.midi);
          fs.writeFileSync(patFile, matchedFile);
          break;
        }
        try { fs.unlinkSync(mp3); } catch {}
      }
      if (!ok) { nMiss++; continue; }
      nFetched++;
    } else {
      nCached++;
      if (fs.existsSync(patFile)) {
        matchedFile = fs.readFileSync(patFile, 'utf8');
      } else {
        const firstPattern = (cfg.filePatterns && cfg.filePatterns[0]) || cfg.filePattern;
        matchedFile = applyPlaceholders(firstPattern, n.note, n.midi);
      }
    }
    fetched.push({ ...n, mp3, matchedFile });
  }
  console.error(`fetch: ${nFetched} new, ${nCached} cached, ${nMiss} 404/missing`);
  return fetched;
}

// ─── 2. decode (ffmpeg → f32 PCM 44.1k; mono for pitch/RMS, stereo for peak) ──

function decodeAll(samples) {
  for (const s of samples) {
    const raw = s.mp3.replace(/\.\w+$/, '.raw');
    if (!fs.existsSync(raw) || fs.statSync(raw).mtimeMs < fs.statSync(s.mp3).mtimeMs) {
      execFileSync('ffmpeg', ['-loglevel','error','-y','-i', s.mp3, '-ac','1','-ar', String(SR),'-f','f32le', raw], { stdio: 'inherit' });
    }
    s.raw = raw;
    /* Stereo decode for decay peak measurement — mono downmix attenuates
       anti-correlated stereo content vs. the per-frame max(|L|,|R|) the
       browser actually plays. Cached separately as .s2.raw so the mono
       pipeline (pitch, loop analysis) is unaffected. */
    const rawS2 = s.mp3.replace(/\.\w+$/, '.s2.raw');
    if (!fs.existsSync(rawS2) || fs.statSync(rawS2).mtimeMs < fs.statSync(s.mp3).mtimeMs) {
      execFileSync('ffmpeg', ['-loglevel','error','-y','-i', s.mp3, '-ac','2','-ar', String(SR),'-f','f32le', rawS2], { stdio: 'inherit' });
    }
    s.rawStereo = rawS2;
  }
}

function loadRaw(rawPath) {
  const buf = fs.readFileSync(rawPath);
  const data = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length/4));
  return { sampleRate: SR, length: data.length, getChannelData: () => data };
}

function loadStereoRaw(rawPath) {
  const buf = fs.readFileSync(rawPath);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length/4));
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
  // the exports we need bound at the end. findSteadyRegion (the old
  // 70%-of-peak detector) is gone; the segments pipeline uses
  // findSteadyRegionMeanThreshold internally and surfaces the resulting
  // steady region through res.stats.steadyStartSec/.steadyEndSec — so the
  // headless runner reads it from there for measureRmsLoop instead of
  // re-running the detection.
  const src = m[1] + '\n;return {prepareLoop, refineFundamentalPeriod};';
  const factory = new Function('document','window', src);
  return factory(stub.document, stub.window);
}

// ─── 4. analysis paths ───────────────────────────────────────────────────────

function analyzeLoop(buf, freq, cfg, fns) {
  // Segment-based pipeline. The cfg.vibrato flag pre-fills looser phase-
  // coherence defaults (corrThreshold:0.90, corrWindowPeriods:2) for pitched-
  // vibrato samples; per-instrument cfg.gateOpts override. prepareLoop returns
  //   { segments: [{a, b}, ...], stats: {nSegments, sccOk, bridgeCount,
  //     steadyStartSec, steadyEndSec, ...}, diag: {...} }
  // and we propagate that shape through the rest of the pipeline.
  const opts = { ...(cfg.gateOpts || {}) };
  if (cfg.vibrato) {
    if (opts.corrThreshold === undefined) opts.corrThreshold = 0.90;
    if (opts.corrWindowPeriods === undefined) opts.corrWindowPeriods = 2;
  }
  return fns.prepareLoop(buf, freq, opts);
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

function measurePeakDecay(stereo, mono) {
  /* Peak amplitude over the attack region (first 200ms after trim) measured
     on STEREO data as max(|L|,|R|) per frame — that's what the browser plays
     and what determines clip-relevant amplitude. Mono downmix would attenuate
     anti-correlated content and over-boost the gain. RMS-based targeting
     fails on decay sounds anyway: crest factor varies across the keyboard
     and equal-RMS gives unequal peaks. */
  const trim = findGainTrimStart(mono);
  const peakSearchLen = Math.round(SR * 0.2);
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

function measureRmsLoop(d, res) {
  /* Reuse the steady region that prepareLoop already detected. Same
     boundaries the segment selector used → gain normalization stays
     consistent with the audio region the seams are validated over. */
  const stats = res && res.stats;
  if (!stats || stats.steadyStartSec == null || stats.steadyEndSec == null) return null;
  const start = Math.round(stats.steadyStartSec * SR);
  const end = Math.round(stats.steadyEndSec * SR);
  if (end <= start) return null;
  return rmsOver(d, start, end);
}

function computeGainFromRms(rms) {
  if (rms == null || rms <= 0) return null;
  return Math.max(GAIN_MIN, Math.min(GAIN_MAX, TARGET_RMS / rms));
}

function computeGainFromPeak(peak) {
  if (peak == null || peak <= 0) return null;
  return Math.max(GAIN_MIN, Math.min(GAIN_MAX, TARGET_PEAK_DECAY / peak));
}

// ─── 5. classify ─────────────────────────────────────────────────────────────

function classifyLoop(res) {
  /* Segments-pipeline tier:
       fail  no segments returned, or stats missing
       red   1 segment (or SCC broken — no perpetual cycle possible)
       yellow 2–3 segments (perpetual loop works but low variety)
       blue  4+ segments, SCC OK, but ≥half are bridges (constrained variety)
       green 4+ segments, SCC OK, fewer than half bridges (real randomization)
     Mirrors the analyzer's per-row tier classifier — keep them in sync. */
  if (!res || !Array.isArray(res.segments)) return 'fail';
  const s = res.stats || {};
  const n = res.segments.length;
  const sccOk = !!s.sccOk;
  const bridges = s.bridgeCount || 0;
  if (n < 2 || !sccOk) return 'red';
  if (n < 4) return 'yellow';
  if (bridges * 2 >= n) return 'blue';
  return 'green';
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
  // each ±2-semitone window. Tiebreak inside a tier: more segments first
  // (richer randomization), then more steady-region seconds.
  const picked = [];
  let target = usable[0].midi;
  const maxMidi = usable[usable.length - 1].midi;
  const used = new Set();
  while (target <= maxMidi + 2) {
    const win = usable.filter(r => Math.abs(r.midi - target) <= 2 && !used.has(r.note));
    if (win.length === 0) { target += 4; continue; }
    win.sort((a,b) => {
      if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[b.tier] - TIER_RANK[a.tier];
      const na = (a.res.segments && a.res.segments.length) || 0;
      const nb = (b.res.segments && b.res.segments.length) || 0;
      if (na !== nb) return nb - na;
      const sa = (a.res.stats && a.res.stats.steadyDurSec) || 0;
      const sb = (b.res.stats && b.res.stats.steadyDurSec) || 0;
      return sb - sa;
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
  /* gain: loop = TARGET_RMS / measuredRms; decay = TARGET_PEAK_DECAY / peak.
     Both clamped. Goes immediately after freq so the schema fans out:
     identifier (name), pitch (freq), level (gain), then loop-specific fields.
     Falls back to 1.0 silently at runtime if absent. */
  const gainStr = (typeof r.gain === 'number') ? `,gain:${fmt(r.gain, 4)}` : '';
  /* Emit a per-sample `file` field whenever the resolved filename can't be
     reconstructed from a simple `{NOTE}{ext}` substitution at runtime — i.e.
     when filePatterns plural was used, or any of {MIDI}/{NOTE_LETTER}/
     {NOTE_LOWER} appeared in the template. The runtime engine prefers this
     over filePattern substitution. */
  const defaultPattern = '{NOTE}' + cfg.ext;
  const usesMulti = !!cfg.filePatterns;
  const singleTemplate = cfg.filePattern || defaultPattern;
  const usesNewPlaceholders = /\{MIDI\}|\{NOTE_LETTER\}|\{NOTE_LOWER\}/.test(singleTemplate);
  const needFile = usesMulti || usesNewPlaceholders;
  const fileStr = (needFile && r.matchedFile) ? `,file:'${r.matchedFile}'` : '';

  if (cfg.decays) {
    return `        {name:'${r.note}',freq:${freqStr}${gainStr}${fileStr}}`;
  }

  // loop entry — segments array, one {a, b} per pair the runtime picker can
  // pick at each wrap. Sorted by `a` (selectSegments returns them sorted, but
  // sort defensively in case anyone post-processes). No loopPts /
  // validStartsByEnd anymore.
  const segs = (r.res.segments || []).slice().sort((p, q) => p.a - q.a);
  const segsStr = '[' + segs.map(s => `{a:${fmt(s.a, 7)},b:${fmt(s.b, 7)}}`).join(',') + ']';
  return `        {name:'${r.note}',freq:${freqStr}${gainStr}${fileStr},segments:${segsStr},trimStart:${fmt(r.res.trimStart, 7)}}`;
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
  return [
    'Segments pipeline. Each entry\'s `segments` is a list of {a, b} loop',
    'pairs picked from inside the sample\'s mean-anchored steady region. The',
    'runtime picker plays to a chosen b, crossfades back to the same segment\'s',
    'a (validated pair-seam), then picks a new segment whose b is reachable',
    'from a — yielding perpetual random looping over the SCC. Generated by',
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
  // Emit filePattern only when non-default. Runtime engine uses
  // filePattern if present, else falls back to '{NOTE}{ext}'.
  const defaultPattern = '{NOTE}' + cfg.ext;
  if (cfg.filePattern && cfg.filePattern !== defaultPattern) {
    header += `,filePattern:'${cfg.filePattern}'`;
  }
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
  lines.push(`- Path: **${cfg.decays ? 'decay (freq-only)' : 'loop / unified'}**${cfg.vibrato ? ' (vibrato hint: looser phase defaults)' : ''}`);
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
  const gainColLoop = (p) => {
    if (typeof p.rms !== 'number' || p.rms <= 0) return '— | —';
    const dBFS = (20 * Math.log10(p.rms)).toFixed(1);
    const g = (typeof p.gain === 'number') ? p.gain.toFixed(4) : '—';
    return `${dBFS} | ${g}`;
  };
  const gainColDecay = (p) => {
    if (typeof p.peak !== 'number' || p.peak <= 0) return '— | —';
    const dBFS = (20 * Math.log10(p.peak)).toFixed(1);
    const g = (typeof p.gain === 'number') ? p.gain.toFixed(4) : '—';
    return `${dBFS} | ${g}`;
  };
  if (cfg.decays) {
    lines.push(`| Note | Labeled (Hz) | Measured (Hz) | Drift (¢) | Peak (dBFS) | gain | Tier |`);
    lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | --- |`);
    picks.forEach(p => {
      const drift = p.res.driftCents != null ? p.res.driftCents.toFixed(1) : '—';
      const fa    = p.res.freqActual != null ? p.res.freqActual.toFixed(2) : '—';
      lines.push(`| ${p.note} | ${p.labeledFreq.toFixed(2)} | ${fa} | ${drift} | ${gainColDecay(p)} | ${p.tier} |`);
    });
  } else {
    lines.push(`| Note | Hz | segments | SCC | bridges | steady (s) | RMS (dBFS) | gain | tier |`);
    lines.push(`| --- | ---: | ---: | :---: | ---: | ---: | ---: | ---: | --- |`);
    picks.forEach(p => {
      const s = p.res.stats || {};
      const fa = p.res.freqActual != null ? p.res.freqActual.toFixed(2) : p.labeledFreq.toFixed(2);
      const nSeg = (p.res.segments && p.res.segments.length) || 0;
      const scc = s.sccOk ? 'ok' : 'BRK';
      const br = (s.bridgeCount != null) ? s.bridgeCount : '—';
      const steady = (s.steadyDurSec != null) ? s.steadyDurSec.toFixed(2) : '—';
      lines.push(`| ${p.note} | ${fa} | ${nSeg} | ${scc} | ${br} | ${steady} | ${gainColLoop(p)} | ${p.tier} |`);
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
  console.error(`config: ${cfg.instrumentKey} (${cfg.displayName}), ${cfg.decays?'decay':'unified loop'} path${cfg.vibrato?' (vibrato hint)':''}, transpose=${cfg.transpose}`);
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
    let rms = null, peak = null, gain = null;
    if (cfg.decays) {
      const stereo = loadStereoRaw(s.rawStereo);
      peak = measurePeakDecay(stereo, d);
      gain = computeGainFromPeak(peak);
    } else {
      rms = measureRmsLoop(d, res);
      gain = computeGainFromRms(rms);
    }
    return { note: s.note, midi: s.midi, labeledFreq: s.labeledFreq, matchedFile: s.matchedFile, res, tier, rms, peak, gain };
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
