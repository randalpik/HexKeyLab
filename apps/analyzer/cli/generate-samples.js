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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { measureDecayLufs, measureLufs } from '../analysis/k-weighting.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO = path.resolve(__dirname, '../..');
/* analyzer-analysis.js holds the pure signal-processing module (prepareLoop,
   refineFundamentalPeriod, etc). The analyzer was split out of the single-
   file tools/HexKeyLab-analyzer.html into analyzer/*.js; we read only the
   analysis module since the visualization + harness need DOM/Canvas. */
const ANALYZER_ANALYSIS_JS = path.join(__dirname, '..', 'analysis', 'analyzer-analysis.js');
const CACHE_DIR = path.join(__dirname, '..', '.cache');
const OUT_DIR = path.join(__dirname, '..', 'out');

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

/* Per-sample normalization targets. Both loop and decay paths target the
   same TARGET_RMS, with a peak ceiling at TARGET_PEAK_DBFS that engages only
   when RMS targeting would push a sample's peak into clip range. The
   measurement *methods* differ — loop uses stereo RMS over the analyzer's
   steady region; decay uses K-weighted integrated loudness (ITU-R BS.1770,
   see k-weighting.js) returned as a stereo-RMS-equivalent so the gain math
   stays uniform. Single source of truth — backfill-gains.js mirrors these. */
const TARGET_DBFS = -18;
const TARGET_RMS = Math.pow(10, TARGET_DBFS / 20);  /* ≈ 0.12589 */
/* Peak ceiling — engages when RMS targeting would push a sample's peak above
   this level. Per-voice headroom that the master limiter also catches if
   multiple voices stack; this just keeps single notes from clipping. */
const TARGET_PEAK_DBFS = -3;
const TARGET_PEAK = Math.pow(10, TARGET_PEAK_DBFS / 20);  /* ≈ 0.7079 */
/* Floor only — sources can be quiet enough to need any amount of boost,
   and an arbitrary ceiling produces silent per-note level discontinuities
   that are harder to diagnose than the occasional noisy boosted sample.
   Trust the measurement; if a sample ends up too noisy after gain, the
   right fix is a better source recording, not a hidden clamp. */
const GAIN_MIN = 0.1;

// ─── 0. config + helpers ─────────────────────────────────────────────────────

function loadConfig() {
  const cfgPath = process.argv[2];
  if (!cfgPath) {
    console.error('Usage: node generate-samples.js <config.json>');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  /* Config basename (no extension) drives the on-disk cache directory.
     Per-config caches let multiple soundfonts target the same instrumentKey
     (e.g. iowa-clarinet vs fatboy-clarinet → both have instrumentKey:'clarinet')
     without overwriting each other's decoded audio. */
  cfg.configName = path.basename(cfgPath, '.json');
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
  cfg.replayOnTranspose = cfg.replayOnTranspose === true;
  /* Source dispatch. 'cdn' (default) → fetchOne uses curl against cfg.baseUrl.
     'local' → fetchOne copies from cfg.sourceDir into the cache so every
     downstream step (decodeOne writes `.raw` next to the source file) sees a
     cache-local path and never writes back into the user's sample folder.
     cfg.sourceDir is resolved relative to the config file's directory when
     not absolute, so configs can live alongside their samples. */
  cfg.source = cfg.source || 'cdn';
  if (cfg.source === 'local') {
    if (!cfg.sourceDir) {
      console.error('source:"local" requires "sourceDir" in config');
      process.exit(1);
    }
    if (!path.isAbsolute(cfg.sourceDir)) {
      cfg.sourceDir = path.resolve(path.dirname(cfgPath), cfg.sourceDir);
    }
    if (!fs.existsSync(cfg.sourceDir) || !fs.statSync(cfg.sourceDir).isDirectory()) {
      console.error(`sourceDir not found or not a directory: ${cfg.sourceDir}`);
      process.exit(1);
    }
  } else if (cfg.source !== 'cdn') {
    console.error(`unknown source "${cfg.source}" (expected "cdn" or "local")`);
    process.exit(1);
  }
  /* Bundling defaults. Local configs auto-bundle (the whole reason for
     source:"local"). CDN configs only bundle when --bundle is passed on the
     command line, since their default emission target is samples-data.ts. */
  cfg.bundle = !!cfg.bundle || cfg.source === 'local' || process.argv.includes('--bundle');
  /* trustLabeledPitch: when on, the bundled per-sample `freq` field uses the
     labeled ET frequency (from the filename) instead of the analyzer's
     auto-detected fundamental. Default ON for source:"local" (the user owns
     the samples and almost always has them pre-validated via Melodyne or
     similar); OFF for source:"cdn" (CDN provenance is unknown — auto-detect
     is the safer default).

     Why: our +ZC-pair pitch estimator is exact for pure sines but biased for
     spectrally rich signals (vowels, brass with strong formants). The bias
     varies per-sample with the harmonic content / glottal asymmetry /
     mic-DC. For samples the user has already pitch-validated, our estimate
     is at best a noisy confirmation and at worst introduces ±3-8¢ inter-
     sample disagreement by feeding the engine slightly-wrong "native"
     freqs. The auto-detected value stays in res.freqActual for the report
     (diagnostic) — only the EMITTED freq changes. */
  if (cfg.trustLabeledPitch === undefined) {
    cfg.trustLabeledPitch = (cfg.source === 'local');
  }
  /* keepAllGreenRange: optional ["lowNote", "highNote"] pair (inclusive) that
     overrides the ~4-semitone picker inside this midi range — every green-tier
     sample within bounds is kept. Used for voices, where the ear detects
     timbre seams across adjacent semitones more readily than for instrumental
     samples. The picker outside the range, and the blue/yellow fill pass
     across the whole range, run unchanged. */
  if (cfg.keepAllGreenRange) {
    if (!Array.isArray(cfg.keepAllGreenRange) || cfg.keepAllGreenRange.length !== 2) {
      console.error('keepAllGreenRange must be a 2-element array of note names, e.g. ["E2", "E4"]');
      process.exit(1);
    }
    const [lo, hi] = cfg.keepAllGreenRange;
    cfg.keepAllGreenLowMidi = noteNameToMidi(lo);
    cfg.keepAllGreenHighMidi = noteNameToMidi(hi);
    if (cfg.keepAllGreenLowMidi > cfg.keepAllGreenHighMidi) {
      console.error(`keepAllGreenRange: low note (${lo}) must be at or below high note (${hi})`);
      process.exit(1);
    }
  }
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
  // {MIDI_RAW}    — unpadded MIDI number (Headroom uses "...CLOSE 60.flac")
  // '#' is URL-encoded *after* substitution so the placeholder itself
  // never needs to be entered already-encoded.
  const letter = note.replace(/\d+$/, '');
  const midiStr = String(midi).padStart(3, '0');
  const midiRaw = String(midi);
  return pattern
    .replace(/\{NOTE_LETTER\}/g, letter)
    .replace(/\{NOTE_LOWER\}/g, note.toLowerCase())
    .replace(/\{MIDI_RAW\}/g, midiRaw)
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

/* Cache is keyed by the actual URL-matched filename (relative to baseUrl).
   This lets multi-pattern configs (e.g. Iowa strings: sulC/G/D/A variants of
   each note) cache every fetched variant independently so the analyze-time
   fallback can replay any of them without re-downloading. Single-pattern
   configs (filePattern: '{NOTE}.mp3', etc.) end up with the same filename as
   before, so their caches transfer over cleanly. The old <NOTE>.<ext> +
   .pattern-sidecar layout is no longer written; legacy files just sit unused.

   Returns {matchedFile, mp3, fromCache} or null on missing.

   For cfg.source==='local', the file is read from cfg.sourceDir and copied
   into the cache directory (so decodeOne's `.raw` and `.s2.raw` artifacts
   land in the cache instead of the user's sample folder). The matchedFile
   path is what the user types in `filePattern` resolved against `sourceDir`. */
function fetchOne(cfg, note, midi, patternIdx) {
  const patterns = cfg.filePatterns || [cfg.filePattern];
  if (patternIdx >= patterns.length) return null;
  const dir = path.join(CACHE_DIR, cfg.configName);
  const matchedFile = applyPlaceholders(patterns[patternIdx], note, midi);
  const cachedFile = path.join(dir, matchedFile);
  fs.mkdirSync(path.dirname(cachedFile), { recursive: true });
  if (fs.existsSync(cachedFile) && fs.statSync(cachedFile).size > 0) {
    return { matchedFile, mp3: cachedFile, fromCache: true };
  }
  if (cfg.source === 'local') {
    /* Local source — copy from cfg.sourceDir. Missing file == 'no such note'
       (mirror CDN's 404 semantics for the multi-pattern fallback). */
    const srcPath = path.join(cfg.sourceDir, matchedFile);
    if (!fs.existsSync(srcPath) || fs.statSync(srcPath).size === 0) return null;
    fs.copyFileSync(srcPath, cachedFile);
    return { matchedFile, mp3: cachedFile, fromCache: false };
  }
  const url = cfg.baseUrl + matchedFile;
  const r = spawnSync('curl', ['-sLfo', cachedFile, url], { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(cachedFile) || fs.statSync(cachedFile).size === 0) {
    try { fs.unlinkSync(cachedFile); } catch {}
    return null;
  }
  return { matchedFile, mp3: cachedFile, fromCache: false };
}

// ─── 2. decode (ffmpeg → f32 PCM 44.1k; mono for pitch/RMS, stereo for peak) ──

function decodeOne(s) {
  /* Append `.raw` to the full filename (NOT replace the extension), so two
     source files with the same note name but different extensions — e.g.
     Iowa `E3.aif` and FatBoy `E3.mp3` coexisting in the same cache dir after
     a source switch — decode to distinct `.raw` paths instead of one
     clobbering the other. Same applies to the stereo decode. */
  const raw = s.mp3 + '.raw';
  if (!fs.existsSync(raw) || fs.statSync(raw).mtimeMs < fs.statSync(s.mp3).mtimeMs) {
    execFileSync('ffmpeg', ['-loglevel','error','-y','-i', s.mp3, '-ac','1','-ar', String(SR),'-f','f32le', raw], { stdio: 'inherit' });
  }
  s.raw = raw;
  const rawS2 = s.mp3 + '.s2.raw';
  if (!fs.existsSync(rawS2) || fs.statSync(rawS2).mtimeMs < fs.statSync(s.mp3).mtimeMs) {
    execFileSync('ffmpeg', ['-loglevel','error','-y','-i', s.mp3, '-ac','2','-ar', String(SR),'-f','f32le', rawS2], { stdio: 'inherit' });
  }
  s.rawStereo = rawS2;
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

async function loadAnalyzer() {
  // analyzer-analysis.js is an ES module exporting `HKLAnalysis` — a DOM-free
  // namespace publishing prepareLoop, refineFundamentalPeriod, etc.
  // pathToFileURL is required for dynamic import on Windows; harmless on
  // Linux (canonical file:// form).
  const mod = await import(pathToFileURL(ANALYZER_ANALYSIS_JS).href);
  const api = mod.HKLAnalysis;
  if (!api || !api.prepareLoop) throw new Error('analyzer-analysis.js did not export HKLAnalysis.prepareLoop');
  return {
    prepareLoop: api.prepareLoop,
    refineFundamentalPeriod: api.refineFundamentalPeriod,
    trimSilence: api.trimSilence,
    applyConfigDefaults: api.applyConfigDefaults,
  };
}

// ─── 4. analysis paths ───────────────────────────────────────────────────────

function analyzeLoop(buf, freq, cfg, fns) {
  // Segment-based pipeline. applyConfigDefaults applies the cfg.vibrato hint
  // (corrThreshold:0.90, corrWindowPeriods:2) + trend-normalization defaults
  // shared with the browser harness so both paths produce identical results.
  // prepareLoop returns
  //   { segments: [{a, b}, ...], stats: {nSegments, sccOk, bridgeCount,
  //     steadyStartSec, steadyEndSec, ...}, diag: {...} }
  // and we propagate that shape through the rest of the pipeline.
  const opts = fns.applyConfigDefaults(cfg, cfg.gateOpts);
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
  const { trimStart } = fns.trimSilence(d, sr);
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

function measureDecay(stereo, mono) {
  /* Decay-path loudness measure: K-weighted integrated loudness per ITU-R
     BS.1770-4 (see analyzer/k-weighting.js). Replaces the previous 200ms
     post-trim RMS, which was dominated by the hammer transient and produced
     audible inter-sample loudness drift on sources with inconsistent
     attack-vs-sustain ratios (Maestro grand piano was the prompting case —
     ~8 dB source-level mismatch between adjacent semitones, matched at the
     attack window but drifting on the sustain).

     Returns rms in stereo-combined-RMS-equivalent units so the existing gain
     formula (gain = TARGET_RMS/rms, peak-ceiling capped) operates unchanged.
     Peak is still measured on the unfiltered stereo for clip protection. */
  const m = measureDecayLufs(stereo, mono, SR);
  if (m.rms == null) return null;
  return m;
}

function stereoRmsOver(stereo, start, end) {
  if (end <= start) return 0;
  let sumSq = 0;
  for (let i = start; i < end; i++) {
    const l = stereo[2*i], r = stereo[2*i+1];
    sumSq += l*l + r*r;
  }
  return Math.sqrt(sumSq / (2 * (end - start)));
}

function stereoPeakOver(stereo, start, end) {
  let p = 0;
  for (let i = start; i < end; i++) {
    const aL = Math.abs(stereo[2*i]);
    const aR = Math.abs(stereo[2*i+1]);
    const a = aL > aR ? aL : aR;
    if (a > p) p = a;
  }
  return p;
}

function measureRmsLoop(stereo, mono, res) {
  /* Loudness measure for loop-path gain normalization. Two-tier:
       (1) primary: K-weighted integrated loudness over the analyzer's steady
           region — the loop body the user actually hears during sustained
           playback. Matches the engine's playback regime AND perceptual
           weighting (frequency-dependent ear response).
       (2) fallback: K-weighted loudness over the loudest 1-second window in
           the post-trim audio, for samples where steady detection yields a
           too-narrow span (<200ms) or fails entirely. Identical pipeline,
           different region.

     Previously this used plain stereo RMS over the steady region, which
     produced ~6 dB perceived-loudness drift across a viola's range despite
     matched RMS (a structurally identical failure to the decay-path's prior
     200ms-post-trim RMS that K-weighting solved on the Maestro piano). The
     decay docstring covers the rationale; the loop case is the same problem
     with a different window. */
  const stats = res && res.stats;
  if (stats && stats.steadyStartSec != null && stats.steadyEndSec != null) {
    const start = Math.round(stats.steadyStartSec * SR);
    const end = Math.round(stats.steadyEndSec * SR);
    if (end - start >= Math.round(SR * 0.4)) {
      /* 400ms minimum: measureLufs needs ≥1 momentary window (400ms). The
         old 200ms RMS floor isn't valid here; under it we fall through to
         the loudest-1s fallback. */
      const m = measureLufs(stereo, mono, SR, { startSample: start, endSample: end });
      if (m && m.rms != null) return m;
    }
  }
  /* Fallback for samples with no usable steady region. Scan for the loudest
     1s window in post-trim audio and run K-weighting over that window. */
  const trimStartSec = (res && typeof res.trimStart === 'number') ? res.trimStart : 0;
  const start = Math.max(0, Math.round(trimStartSec * SR));
  const end = mono.length;
  if (end - start < Math.round(SR * 0.4)) return null;
  const winSamp = Math.min(end - start, Math.round(SR * 1.0));
  const hopSamp = Math.max(1, Math.round(SR * 0.1));
  /* Coarse RMS-based scan to find the loudest window (cheap), then run
     K-weighting on the winning region. The scan doesn't need to be
     perceptually weighted — we're just locating the right 1s slice. */
  let bestRms = 0, bestStart = start;
  for (let s = start; s + winSamp <= end; s += hopSamp) {
    const r = stereoRmsOver(stereo, s, s + winSamp);
    if (r > bestRms) { bestRms = r; bestStart = s; }
  }
  const lastStart = end - winSamp;
  if (lastStart > start) {
    const r = stereoRmsOver(stereo, lastStart, end);
    if (r > bestRms) { bestRms = r; bestStart = lastStart; }
  }
  if (bestRms <= 0) return null;
  const m = measureLufs(stereo, mono, SR, { startSample: bestStart, endSample: bestStart + winSamp });
  return (m && m.rms != null) ? m : null;
}

function computeGain(meas) {
  /* Unified gain calculation for both loop and decay paths:
       gain = min(TARGET_RMS / rms, TARGET_PEAK / peak), floored at GAIN_MIN.
     The RMS-target hits TARGET_DBFS for the measurement window; the peak
     ceiling kicks in only when RMS targeting would push the per-channel
     stereo peak above TARGET_PEAK_DBFS (avoiding clipping). Measurement
     windows differ (loop: steady region; decay: 200ms post-trim) but the
     gain shape is identical. */
  if (!meas || meas.rms == null || meas.rms <= 0) return null;
  const gainRms = TARGET_RMS / meas.rms;
  const gainPeakCeiling = (meas.peak > 0) ? (TARGET_PEAK / meas.peak) : Infinity;
  return Math.max(GAIN_MIN, Math.min(gainRms, gainPeakCeiling));
}

// ─── 5. classify ─────────────────────────────────────────────────────────────

function classifyLoop(res) {
  /* Segments-pipeline tier:
       fail   no segments returned, or stats missing
       red    ≤2 segments (or SCC broken — no perpetual cycle possible);
              filtered out by pickSamples and triggers the filePatterns
              fallback in the main loop
       yellow exactly 3 segments (perpetual loop works but low variety)
       blue   4+ segments, SCC OK, but ≥half are bridges (constrained variety)
       green  4+ segments, SCC OK, fewer than half bridges (real randomization)
     Mirrors the analyzer's per-row tier classifier — keep them in sync. */
  if (!res || !Array.isArray(res.segments)) return 'fail';
  const s = res.stats || {};
  const n = res.segments.length;
  const sccOk = !!s.sccOk;
  const bridges = s.bridgeCount || 0;
  if (n < 3 || !sccOk) return 'red';
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
  // Hard exclusion: red and fail tier samples NEVER get picked, regardless
  // of coverage gaps. Reds either fail SCC (no perpetual loop possible) or
  // produce ≤2 segments (too few to randomize away from). Either way we'd
  // rather have a wider coverage gap than emit an unloopable sample.
  const usable = results.filter(r => r.tier === 'green' || r.tier === 'blue' || r.tier === 'yellow');
  if (usable.length === 0) return [];
  usable.sort((a,b) => a.midi - b.midi);

  // Decay instruments have no loop-quality tiering; samples are typically
  // pre-curated by the soundfont author. Keep every valid sample.
  if (cfg.decays) return usable.slice();

  /* Two-pass selection for loop instruments:
       Pass 1 — spine: walk green samples at ~4-semitone spacing, pick the
                best within each ±2-semitone window.
       Pass 2 — fill: identify gaps > 4 semitones in the spine (between
                adjacent picks and at the head/tail of the usable range)
                and insert blue+yellow samples at ~4-semitone spacing inside
                each gap, anchored so no fill lands within 4 semitones of a
                spine pick.
     Within a window the picker prefers higher tier (blue > yellow), then
     more segments (richer randomization), then more steady-region seconds. */
  const tiebreak = (a, b) => {
    if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[b.tier] - TIER_RANK[a.tier];
    const na = (a.res.segments && a.res.segments.length) || 0;
    const nb = (b.res.segments && b.res.segments.length) || 0;
    if (na !== nb) return nb - na;
    const sa = (a.res.stats && a.res.stats.steadyDurSec) || 0;
    const sb = (b.res.stats && b.res.stats.steadyDurSec) || 0;
    return sb - sa;
  };
  /* spacedPick: walk from startMidi to endMidi by 4-semitone targets; in each
     ±2-semitone window pick the best candidate by tiebreak; advance to
     best.midi + 4 after each pick. Optionally exclude any candidate within
     minSep semitones of an existing-pick set (used by the fill pass to keep
     yellows from clustering against the spine). */
  function spacedPick(candidates, startMidi, endMidi, excludeFrom, minSep) {
    if (candidates.length === 0) return [];
    const sorted = candidates.slice().sort((a,b) => a.midi - b.midi);
    const picked = [];
    const seen = new Set();
    let target = startMidi;
    while (target <= endMidi + 2) {
      const win = sorted.filter(r =>
        Math.abs(r.midi - target) <= 2
        && !seen.has(r.note)
        && (!excludeFrom || !excludeFrom.some(p => Math.abs(r.midi - p.midi) < minSep))
        && !picked.some(p => Math.abs(r.midi - p.midi) < (minSep || 0))
      );
      if (win.length === 0) { target += 4; continue; }
      const best = win.slice().sort(tiebreak)[0];
      picked.push(best);
      seen.add(best.note);
      target = best.midi + 4;
    }
    return picked;
  }

  // Pass 1: green spine. No min-sep — allow close greens (e.g. Ab3+Bb3 on
  // Iowa viola) since both are loop-quality samples and redundancy at the
  // green tier is fine.
  //
  // keepAllGreenRange (when set) carves the green tier into two slices:
  //   - in-range greens: every one is kept unconditionally (no spacing).
  //   - out-of-range greens: run the spine picker at ~4-st spacing as usual.
  // The spine is the union of (in-range kept-all) ∪ (out-of-range spaced),
  // sorted by midi. The blue/yellow fill pass downstream uses the union as
  // its excludeFrom set so fills don't crowd the dense in-range section.
  const greens = usable.filter(r => r.tier === 'green');
  let spine = [];
  if (greens.length > 0) {
    const loM = cfg.keepAllGreenLowMidi, hiM = cfg.keepAllGreenHighMidi;
    const inRange = (loM != null && hiM != null)
      ? greens.filter(g => g.midi >= loM && g.midi <= hiM)
      : [];
    const outOfRange = (loM != null && hiM != null)
      ? greens.filter(g => g.midi < loM || g.midi > hiM)
      : greens;
    /* Out-of-range portion still gets the ~4-st spacing treatment, with one
       caveat: a single-side gap adjacent to the kept-all block shouldn't
       drop a pick that's <4 semitones from the block edge. spacedPick walks
       startMidi → endMidi targeting at +4 each iteration; setting startMidi
       to the first available midi (and endMidi to the last) keeps that
       behavior, and the subsequent .concat + sort + fill pass exclusion
       naturally guards against duplicates. */
    const spaced = outOfRange.length > 0
      ? spacedPick(outOfRange, outOfRange[0].midi, outOfRange[outOfRange.length - 1].midi)
      : [];
    spine = inRange.concat(spaced);
  }
  spine.sort((a,b) => a.midi - b.midi);

  // Pass 2: blue + yellow fill in gaps > 4 semitones. Head/tail edges count
  // as gaps too (we want coverage out to the lowest and highest usable
  // note). Each fill must sit ≥2 semitones from every spine pick AND every
  // other fill — strict enough to block stacking (a yellow at midi N+1
  // landing right next to a green at N+0, no coverage gain) but loose
  // enough that a 5-semitone gap can still be filled at the only spacing
  // available (one fill at distance 2 from one boundary, 3 from the other).
  const fillTier = usable.filter(r => r.tier === 'blue' || r.tier === 'yellow');
  const minMidi = usable[0].midi;
  const maxMidi = usable[usable.length - 1].midi;
  const FILL_MIN_SEP = 2;
  const gaps = [];
  if (spine.length === 0) {
    // No green spine — fill the entire usable range with blue+yellow.
    gaps.push({ lowExcl: minMidi - 1, highExcl: maxMidi + 1, isHead: false, isTail: false });
  } else {
    if (spine[0].midi - minMidi > 4) gaps.push({ lowExcl: minMidi - 1, highExcl: spine[0].midi, isHead: true, isTail: false });
    for (let i = 1; i < spine.length; i++) {
      if (spine[i].midi - spine[i - 1].midi > 4) {
        gaps.push({ lowExcl: spine[i - 1].midi, highExcl: spine[i].midi, isHead: false, isTail: false });
      }
    }
    const last = spine[spine.length - 1];
    if (maxMidi - last.midi > 4) gaps.push({ lowExcl: last.midi, highExcl: maxMidi + 1, isHead: false, isTail: true });
  }

  const fills = [];
  for (const gap of gaps) {
    const inGap = fillTier.filter(r => r.midi > gap.lowExcl && r.midi < gap.highExcl);
    if (inGap.length === 0) continue;
    /* Anchor depends on gap location:
       - head (lowest available is below the spine): walk inward from the
         lowest in-gap candidate so we extend coverage down to the
         instrument's bottom.
       - tail (highest available is above the spine): walk inward from
         lowExcl+4 up to the highest in-gap candidate.
       - middle: walk from lowExcl+4 up to highExcl-1, centered between
         the two spine boundaries.
       Empty-spine case is a single "head+tail" gap covering everything. */
    const startTarget = gap.isHead ? inGap[0].midi : gap.lowExcl + 4;
    const endTarget = gap.isTail ? inGap[inGap.length - 1].midi : gap.highExcl - 1;
    const excludeFrom = spine.length > 0 ? spine.concat(fills) : null;
    const filled = spacedPick(inGap, startTarget, endTarget, excludeFrom, FILL_MIN_SEP);
    for (const f of filled) fills.push(f);
  }

  const all = spine.concat(fills);
  all.sort((a,b) => a.midi - b.midi);
  return all;
}

// ─── 7. emit JS source ───────────────────────────────────────────────────────

const fmt = (x, n) => (+x.toFixed(n)).toString();

/* Mirror of analyzer/bundle.js:targetExt. Inlined to avoid importing the
   bundler just for this. Keep in sync. */
const LOSSY_EXTS = new Set(['.mp3', '.ogg', '.opus', '.aac', '.m4a']);
const LOSSLESS_EXTS = new Set(['.wav', '.aiff', '.aif', '.flac']);
function archiveExt(srcExt) {
  const e = srcExt.toLowerCase();
  if (LOSSY_EXTS.has(e)) return e;
  if (LOSSLESS_EXTS.has(e)) return '.opus';
  return e;
}

function emitSampleEntry(r, cfg) {
  /* Pitch source for the emitted `freq`:
     - trustLabeledPitch (default for source:"local"): labeled ET / transpose.
       Use when sample tuning has been externally validated (Melodyne, tuned
       synth source, MIDI-keyboard capture).
     - else: analyzer-detected fundamental from res.freqActual, falling back
       to labeled ET if detection failed.
     The auto-detected value is still surfaced in the diagnostic report so
     you can see when measurement and label diverge. */
  const detected = (typeof r.res.freqActual === 'number') ? r.res.freqActual : null;
  const labeled = r.labeledFreq / cfg.transpose;
  const freq = cfg.trustLabeledPitch ? labeled : (detected != null ? detected : labeled);
  const freqStr = fmt(freq, 3);
  /* gain: both paths target TARGET_RMS over their measurement window, with a
     peak ceiling at TARGET_PEAK that kicks in only when RMS targeting would
     otherwise clip. Floored at GAIN_MIN (no ceiling on the gain itself).
     Goes immediately after freq so the schema fans out: identifier (name),
     pitch (freq), level (gain), then loop-specific fields. Falls back to 1.0
     silently at runtime if absent. */
  const gainStr = (typeof r.gain === 'number') ? `,gain:${fmt(r.gain, 4)}` : '';
  /* Emit a per-sample `file` field. Two shapes:
       - source==='local' (shipped .hki bundle): the engine reads audio from
         the bundle's in-memory map keyed by archive-internal path, so file
         must be `samples/<NOTE><archiveExt>` matching bundle.js's layout.
       - source==='cdn' (legacy): emit r.matchedFile (CDN-relative filename)
         only when the runtime can't reconstruct the URL from a default
         pattern. Multi-pattern configs and configs using new placeholders
         always need it; simple configs don't.
     archiveExt() picks .mp3/.opus/etc. per bundle.js's lossy-passthrough
     vs lossless-to-Opus policy. */
  let fileStr = '';
  if (cfg.source === 'local') {
    const srcExt = r.matchedFile ? path.extname(r.matchedFile) : cfg.ext;
    fileStr = `,file:'samples/${r.note}${archiveExt(srcExt)}'`;
  } else {
    const defaultPattern = '{NOTE}' + cfg.ext;
    const usesMulti = !!cfg.filePatterns;
    const singleTemplate = cfg.filePattern || defaultPattern;
    const usesNewPlaceholders = /\{MIDI(_RAW)?\}|\{NOTE_LETTER\}|\{NOTE_LOWER\}/.test(singleTemplate);
    const needFile = usesMulti || usesNewPlaceholders;
    fileStr = (needFile && r.matchedFile) ? `,file:'${r.matchedFile}'` : '';
  }

  if (cfg.decays) {
    return `        {name:'${r.note}',freq:${freqStr}${gainStr}${fileStr}}`;
  }

  // loop entry — segments array, one {a, b} per pair the runtime picker can
  // pick at each wrap. Sorted by `a` (selectSegments returns them sorted, but
  // sort defensively in case anyone post-processes). No loopPts /
  // validStartsByEnd anymore.
  const segs = (r.res.segments || []).slice().sort((p, q) => p.a - q.a);
  const segsStr = '[' + segs.map(s => `{a:${fmt(s.a, 7)},b:${fmt(s.b, 7)}}`).join(',') + ']';
  // Trend curve (sustained loop only). Compact dense array at 50ms hop;
  // values are mean-normalized (~1 over steady region) so the runtime can
  // apply 1/trend as a gain envelope without altering average loudness.
  // Absent when the analyzer skipped normalization (e.g. steady region too
  // short or instrument opted out via gateOpts.trendNormalize:false).
  const trend = r.res.trend;
  const trendStr = (trend && trend.applied && trend.values && trend.values.length)
    ? `,trend:[${trend.values.map(v => fmt(v, 4)).join(',')}],trendHopMs:${trend.hopMs},trendStartSec:${fmt(trend.startSec, 4)}`
    : '';
  return `        {name:'${r.note}',freq:${freqStr}${gainStr}${fileStr},segments:${segsStr},trimStart:${fmt(r.res.trimStart, 7)}${trendStr}}`;
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
  /* Header source line:
       source==='local': hki-shipped — runtime fetches `bundleUrl` once, reads
         per-sample bytes from the parsed bundle's audio map. No baseUrl/ext.
       source==='cdn' (legacy): emits the CDN baseUrl + ext as before. */
  if (cfg.source === 'local') {
    lines.push(`      name:'${cfg.displayName}',source:'hki-shipped',bundleUrl:'/samples/${cfg.instrumentKey}.hki',`);
  } else {
    lines.push(`      name:'${cfg.displayName}',baseUrl:'${cfg.baseUrl}',`);
  }
  const decayFlag = cfg.decays ? 'decays:true' : 'decays:false';
  const loopFlag  = cfg.decays ? 'loop:false' : 'loop:true';
  /* ext: only meaningful for CDN entries (used for default {NOTE}{ext}
     filePattern substitution). HKI-shipped entries carry per-sample file
     fields exclusively, so ext is omitted for them. */
  let header = (cfg.source === 'local')
    ? `      releaseTime:${cfg.releaseTime},volume:${cfg.volume},${loopFlag},${decayFlag}`
    : `      ext:'${cfg.ext}',releaseTime:${cfg.releaseTime},volume:${cfg.volume},${loopFlag},${decayFlag}`;
  /* Opt-in: sustained instruments that should retrigger (not crossfade)
     on coordinate transposes — see audio/engine.ts:instrReplaysOnTranspose. */
  if (cfg.replayOnTranspose) header += ',replayOnTranspose:true';
  if (!cfg.decays && cfg.vibrato) header += ',vibrato:true';
  // Emit filePattern only when non-default and only when filePatterns plural
  // was NOT used — with filePatterns each sample carries its own `file:`
  // field, so a header filePattern would be both redundant and misleading
  // (loadConfig defaults cfg.filePattern to '{NOTE}.mp3' which is wrong for
  // FLAC sources, and the value is never consulted at runtime either way).
  const defaultPattern = '{NOTE}' + cfg.ext;
  /* HKI-shipped entries carry per-sample file: fields keyed by archive path;
     filePattern is meaningless (it described how to interpret CDN URLs / local
     source filenames at analysis time, not bundle internals). */
  if (cfg.source !== 'local' && !cfg.filePatterns && cfg.filePattern && cfg.filePattern !== defaultPattern) {
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

function buildReport(results, picks, cfg, fallbackNotes) {
  fallbackNotes = fallbackNotes || [];
  const tally = { green: 0, blue: 0, yellow: 0, red: 0, fail: 0 };
  results.forEach(r => tally[r.tier]++);
  const lines = [];
  lines.push(`# ${cfg.displayName} (${cfg.instrumentKey}) — analysis report`);
  lines.push('');
  lines.push(`- Path: **${cfg.decays ? 'decay (freq-only)' : 'loop / unified'}**${cfg.vibrato ? ' (vibrato hint: looser phase defaults)' : ''}`);
  lines.push(`- Range: ${cfg.lowOct}–${cfg.highOct} (${results.length} samples analyzed)`);
  lines.push(`- Transpose: ${cfg.transpose}`);
  lines.push(`- Pitch source: **${cfg.trustLabeledPitch ? 'labeled ET (filename)' : 'auto-detected (+ZC pair / pitch-curve median)'}**`);
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
    /* Loop path now uses K-weighted measurement (see measureRmsLoop). Surface
       LUFS like the decay path so the report tells the truth about what was
       measured; p.rms is the K-weighted stereo-RMS-equivalent (~3 dB below
       the LUFS value), not plain RMS. */
    const lufs = (typeof p.lufs === 'number') ? p.lufs.toFixed(1) : '—';
    const g = (typeof p.gain === 'number') ? p.gain.toFixed(4) : '—';
    return `${lufs} | ${g}`;
  };
  const gainColDecay = (p) => {
    const lufs = (typeof p.lufs === 'number') ? p.lufs.toFixed(1) : '—';
    const peak = (typeof p.peak === 'number' && p.peak > 0) ? (20 * Math.log10(p.peak)).toFixed(1) : '—';
    const g = (typeof p.gain === 'number') ? p.gain.toFixed(4) : '—';
    return `${lufs} | ${peak} | ${g}`;
  };
  if (cfg.decays) {
    lines.push(`| Note | Labeled (Hz) | Measured (Hz) | Drift (¢) | LUFS | Peak (dBFS) | gain | Tier |`);
    lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |`);
    picks.forEach(p => {
      const drift = p.res.driftCents != null ? p.res.driftCents.toFixed(1) : '—';
      const fa    = p.res.freqActual != null ? p.res.freqActual.toFixed(2) : '—';
      lines.push(`| ${p.note} | ${p.labeledFreq.toFixed(2)} | ${fa} | ${drift} | ${gainColDecay(p)} | ${p.tier} |`);
    });
  } else {
    /* Loop-path picks: show Labeled / Measured / Drift so the diagnostic
       value of the auto-detector survives even when trustLabeledPitch routes
       the labeled value into the bundle. A large drift on a pitch-validated
       source flags a real measurement bias (vowel formants, glottal
       asymmetry, etc.) rather than a real tuning issue. */
    lines.push(`| Note | Labeled (Hz) | Measured (Hz) | Drift (¢) | segments | SCC | bridges | steady (s) | LUFS | gain | tier |`);
    lines.push(`| --- | ---: | ---: | ---: | ---: | :---: | ---: | ---: | ---: | ---: | --- |`);
    picks.forEach(p => {
      const s = p.res.stats || {};
      const labeled = p.labeledFreq / (cfg.transpose || 1);
      const detected = p.res.freqActual;
      const drift = (typeof detected === 'number' && labeled > 0)
        ? (1200 * Math.log2(detected / labeled)).toFixed(1)
        : '—';
      const labStr = labeled.toFixed(2);
      const detStr = (typeof detected === 'number') ? detected.toFixed(2) : '—';
      const nSeg = (p.res.segments && p.res.segments.length) || 0;
      const scc = s.sccOk ? 'ok' : 'BRK';
      const br = (s.bridgeCount != null) ? s.bridgeCount : '—';
      const steady = (s.steadyDurSec != null) ? s.steadyDurSec.toFixed(2) : '—';
      lines.push(`| ${p.note} | ${labStr} | ${detStr} | ${drift} | ${nSeg} | ${scc} | ${br} | ${steady} | ${gainColLoop(p)} | ${p.tier} |`);
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
  // filePattern fallback summary — only emitted for multi-pattern configs
  // where at least one note had to walk past patterns[0] (either because
  // patterns[0] 404'd or because its analysis tier was fail/red).
  if (fallbackNotes.length) {
    lines.push('');
    lines.push(`## Fallbacks used (${fallbackNotes.length})`);
    lines.push('');
    lines.push(`Notes whose first available filePattern produced an invalid result and were re-analyzed against later patterns. Each row lists every attempt (✓ = kept; ✗ = rejected with reason).`);
    lines.push('');
    fallbackNotes.forEach(fb => {
      const trail = fb.attempts.map(a => {
        const tag = (a.patternIdx === fb.bestPatternIdx) ? '✓' : '✗';
        const reason = a.failReason ? ` — ${a.failReason}` : '';
        return `${tag} [${a.patternIdx}] ${a.matchedFile} (${a.tier})${a.patternIdx === fb.bestPatternIdx ? '' : reason}`;
      }).join('  →  ');
      lines.push(`- **${fb.note}**: ${trail}`);
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
  const fns = await loadAnalyzer();
  const patterns = cfg.filePatterns || [cfg.filePattern];
  const multiPattern = patterns.length > 1;
  /* "Valid" = usable by pickSamples (tier ∈ {yellow, blue, green}). Once
     a pattern yields one of these, we stop trying alternatives — we have
     a working sample. Fail/red trigger the fallback to the next pattern. */
  const VALID_TIERS = new Set(['green', 'blue', 'yellow']);
  const results = [];
  const fallbackNotes = []; /* per-note: { note, attempts:[{patternIdx, matchedFile, tier, failReason}] } */
  let nFetched = 0, nCached = 0, nMissAll = 0;
  for (const n of notes) {
    let best = null, bestPatternIdx = -1;
    const attempts = [];
    for (let patternIdx = 0; patternIdx < patterns.length; patternIdx++) {
      const fetched = fetchOne(cfg, n.note, n.midi, patternIdx);
      if (!fetched) continue; /* 404 — try next pattern */
      if (fetched.fromCache) nCached++; else nFetched++;
      decodeOne(fetched);
      const buf = loadRaw(fetched.raw);
      const analysisFreq = n.labeledFreq / cfg.transpose;
      const res = cfg.decays ? analyzeDecay(buf, analysisFreq, fns)
                              : analyzeLoop(buf, analysisFreq, cfg, fns);
      const tier = cfg.decays ? classifyDecay(res) : classifyLoop(res);
      const d = buf.getChannelData();
      const stereo = loadStereoRaw(fetched.rawStereo);
      const meas = cfg.decays ? measureDecay(stereo, d) : measureRmsLoop(stereo, d, res);
      const rms = meas ? meas.rms : null;
      const peak = meas ? meas.peak : null;
      const lufs = (meas && typeof meas.lufs === 'number') ? meas.lufs : null;
      const gain = computeGain(meas);
      const rec = { note: n.note, midi: n.midi, labeledFreq: n.labeledFreq, matchedFile: fetched.matchedFile, res, tier, rms, peak, lufs, gain };
      attempts.push({ patternIdx, matchedFile: fetched.matchedFile, tier, failReason: (res && (res.failReason || (res.stats && res.stats.failReason))) || null });
      if (!best || TIER_RANK[tier] > TIER_RANK[best.tier]) {
        best = rec;
        bestPatternIdx = patternIdx;
      }
      if (VALID_TIERS.has(tier)) break;
    }
    if (!best) { nMissAll++; continue; }
    results.push(best);
    if (multiPattern && (bestPatternIdx > 0 || attempts.length > 1)) {
      fallbackNotes.push({ note: n.note, bestPatternIdx, attempts });
    }
    /* Force a GC pass between notes when --expose-gc is available. Each
       per-note iteration allocates a fresh Float32Array view over a
       fs.readFileSync Buffer (~3-30 MB per sample); V8 won't release those
       Buffers until it runs GC on the small JS heap. For multi-pattern
       configs like vcsl-baroque-recorder (4 patterns × 28 notes = up to
       112 fetch+decode+analyze cycles) the off-heap Buffer pool grows
       linearly and crashes Node at the default 4 GB old-space limit. An
       explicit gc() here keeps the pool tight; the `npm run analyze`
       script also bumps --max-old-space-size as a belt-and-suspenders. */
    if (typeof global.gc === 'function') global.gc();
  }
  console.error(`fetch: ${nFetched} new, ${nCached} cached, ${nMissAll} 404/missing` + (multiPattern ? `, ${fallbackNotes.length} note${fallbackNotes.length===1?'':'s'} used fallback` : ''));
  const picks = pickSamples(results, cfg);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const blockPath  = path.join(OUT_DIR, `${cfg.instrumentKey}-block.txt`);
  const reportPath = path.join(OUT_DIR, `${cfg.instrumentKey}-report.md`);
  fs.writeFileSync(blockPath,  emitBlock(picks, cfg));
  fs.writeFileSync(reportPath, buildReport(results, picks, cfg, fallbackNotes));
  console.error(`\nwrote: ${blockPath}\nwrote: ${reportPath}`);
  console.error(`picks: ${picks.length}`);
  /* Bundle emission. cfg.bundle is true when source==='local' OR --bundle was
     passed; either way we additionally write out/<key>.hki alongside the
     block + report. CDN configs default to off (their primary emission target
     is samples-data.ts via insert-instrument.js). */
  if (cfg.bundle && picks.length > 0) {
    const { buildBundle } = await import('./bundle.js');
    const cacheDir = path.join(CACHE_DIR, cfg.configName);
    const hkiPath = buildBundle(cfg, picks, OUT_DIR, cacheDir);
    console.error(`wrote: ${hkiPath}`);
  }
})();
