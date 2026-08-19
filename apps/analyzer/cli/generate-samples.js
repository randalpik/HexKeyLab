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
 *   6. Pick samples at ~4-semitone spacing (configurable via pickSpacing), prefer higher tier
 *   7. Emit two outputs in analyzer/out/:
 *        <key>-block.txt    — ready-to-paste JS source
 *        <key>-report.md    — diagnostics
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { measureDecayLufs, measureLufs } from '@hkl/analysis/k-weighting.js';
import { sustainSones } from '@hkl/analysis/loudness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO = path.resolve(__dirname, '../..');
/* analyzer-analysis.js holds the pure signal-processing module (prepareLoop,
   refineFundamentalPeriod, etc). The analyzer was split out of the single-
   file tools/HexKeyLab-analyzer.html into analyzer/*.js; we read only the
   analysis module since the visualization + harness need DOM/Canvas. */
/* The analysis DSP was extracted to the @hkl/analysis package; load it from there. */
const ANALYZER_ANALYSIS_JS = path.join(__dirname, '..', '..', '..', 'packages', 'analysis', 'src', 'analyzer-analysis.js');
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
  /* pickSpacing: target semitone spacing for the sample picker (default 4 =
     the historical hard-coded spacing; 3 = minor thirds). Presence is tracked
     separately because the decay path thins only when a config opts in —
     legacy decay configs keep every usable sample. */
  cfg.pickSpacingSet = cfg.pickSpacing != null;
  cfg.pickSpacing = cfg.pickSpacingSet ? cfg.pickSpacing : 4;
  /* loudnessEvenness (0..1, default 0 = off): per-note gain correction toward
     equal perceived loudness of the SUSTAIN across the pick set, computed
     from the Bark-band sones model (@hkl/analysis/loudness.js). Attenuation
     ONLY — notes louder than the set median are pulled down by
     evenness × 10·log2(rel) dB; notes at/below median are never boosted
     (Max 2026-08-18: the natural high-note falloff usefully cancels
     brightness — leave it). Loop path only. */
  cfg.loudnessEvenness = (typeof cfg.loudnessEvenness === 'number' && cfg.loudnessEvenness > 0)
    ? Math.min(1, cfg.loudnessEvenness) : 0;
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
  /* emitShipped: emit the samples-data block in hki-shipped form (runtime
     fetches /samples/<key>.hki once) even for a CDN-sourced config. Use when
     HKL should ship the tail-cut bundle instead of fetching the raw CDN
     files per load (e.g. VSCO wav sources: ~12 MB of wavs vs a ~0.7 MB
     bundle). Implies bundling — the block is useless without the .hki. */
  cfg.emitShipped = cfg.emitShipped === true || cfg.source === 'local';
  if (cfg.emitShipped) cfg.bundle = true;
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
     overrides the spacing picker inside this midi range — every green-tier
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
  /* keepAllRange: tier-inclusive sibling of keepAllGreenRange — every usable
     (green/blue/yellow) sample in the range is kept, not just greens. For
     voice sets whose short samples tier below green: a yellow (3-segment)
     vocal sample still loops fine, and dropping it back to the spacing
     picker would reintroduce the timbral seams this mechanism prevents. */
  if (cfg.keepAllRange) {
    if (!Array.isArray(cfg.keepAllRange) || cfg.keepAllRange.length !== 2) {
      console.error('keepAllRange must be a 2-element array of note names, e.g. ["E2", "G4"]');
      process.exit(1);
    }
    const [lo, hi] = cfg.keepAllRange;
    cfg.keepAllRangeLowMidi = noteNameToMidi(lo);
    cfg.keepAllRangeHighMidi = noteNameToMidi(hi);
    if (cfg.keepAllRangeLowMidi > cfg.keepAllRangeHighMidi) {
      console.error(`keepAllRange: low note (${lo}) must be at or below high note (${hi})`);
      process.exit(1);
    }
  }
  /* lowNote/highNote: note-level range trim within the lowOct..highOct sweep
     (inclusive). Filters enumeration before fetch/decode/analyze, so
     out-of-range source files are never touched. */
  cfg.lowNoteMidi = cfg.lowNote ? noteNameToMidi(cfg.lowNote) : null;
  cfg.highNoteMidi = cfg.highNote ? noteNameToMidi(cfg.highNote) : null;
  if (cfg.lowNoteMidi != null && cfg.highNoteMidi != null && cfg.lowNoteMidi > cfg.highNoteMidi) {
    console.error(`lowNote (${cfg.lowNote}) must be at or below highNote (${cfg.highNote})`);
    process.exit(1);
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
      if (cfg.lowNoteMidi != null && midi < cfg.lowNoteMidi) continue;
      if (cfg.highNoteMidi != null && midi > cfg.highNoteMidi) continue;
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

/* Onset-blip sample gate: a quick excursion in the middle of the onset
   trajectory (two-sided extrapolation detector in seam-perception.js) —
   fires only when BOTH the absolute magnitude and the ratio to the onset's
   own local roughness are high, so overshoots, swells, and knees (normal
   attack shape — brass!) never gate. Calibration on phil-cello: defects
   Gs5 3.4 dB@2.3x, G3 6.4@2.4x, D4 3.8@2.7x, G4 3.5@2.1x; E5's 6.7 dB at
   1.3x is rough-context, not a blip, and stays legal. */
const ONSET_BLIP_RED_DB = 2.5, ONSET_BLIP_RED_RATIO = 2.0;
function classifyLoop(res, cfg) {
  const g = (cfg && cfg.gateOpts) || {};
  const barDb = g.onsetBlipDbMax != null ? g.onsetBlipDbMax : ONSET_BLIP_RED_DB;
  const barRatio = g.onsetBlipRatioMin != null ? g.onsetBlipRatioMin : ONSET_BLIP_RED_RATIO;
  const st = res && res.stats;
  /* Unsteady-vibrato sample gate: substantial band FM energy without a
     stable rate (phil-cello Ds3) — wraps chop irregular vibrato cycles and
     no per-seam gate can lock onto what has no rate. */
  const uvStd = g.unsteadyVibratoCentsMin != null ? g.unsteadyVibratoCentsMin : 4;
  const uvRatio = g.unsteadyVibratoRatioMin != null ? g.unsteadyVibratoRatioMin : 2.5;
  if (st && st.fmUnsteadyCents != null && st.fmUnsteadyCents >= uvStd
      && st.fmUnsteadyCents >= uvRatio * Math.max(st.fmRateAmpCents || 0, 0.5)) {
    st.failReason = `unsteady vibrato: off-line 3-9Hz FM ±${st.fmUnsteadyCents}¢ vs rate line ±${st.fmRateAmpCents}¢ (bars ${uvStd}¢/${uvRatio}x)`;
    return 'red';
  }
  if (st && st.onsetBlipDb != null && st.onsetBlipRatio != null
      && st.onsetBlipDb >= barDb && st.onsetBlipRatio >= barRatio) {
    st.failReason = `onset blip ${st.onsetBlipDb} dB @${st.onsetBlipAtSec}s (${st.onsetBlipRatio}x local, bars ${barDb} dB/${barRatio}x)`;
    return 'red';
  }
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

// ─── 6. select at spaced intervals ───────────────────────────────────────────

const TIER_RANK = { green: 4, blue: 3, yellow: 2, red: 1, fail: 0 };

function pickSamples(results, cfg) {
  /* Manual veto hatch — cfg.excludeNotes: ["As3", ...]. */
  if (Array.isArray(cfg.excludeNotes) && cfg.excludeNotes.length) {
    const veto = new Set(cfg.excludeNotes);
    for (const r of results) {
      if (veto.has(r.note) && r.tier !== 'fail') {
        r.tier = 'red';
        if (r.res && r.res.stats) r.res.stats.failReason = 'excluded by config (excludeNotes)';
      }
    }
  }
  // Hard exclusion: red and fail tier samples NEVER get picked, regardless
  // of coverage gaps. Reds either fail SCC (no perpetual loop possible) or
  // produce ≤2 segments (too few to randomize away from). Either way we'd
  // rather have a wider coverage gap than emit an unloopable sample.
  /* SET-RELATIVE OUTLIER GATE (the "coherence of the set as a whole" gate
     from the project brief — a sample can be individually flawless yet not
     belong: phil-cello B3 speaks in 5 ms where every neighbor swells for
     30–85 ms and runs 2–8 dB brighter — the different-dynamic-band percept.
     Features are per-sample (attackTonalLagMs, steadyBrightnessDb, source
     level via gain), judged against the median of usable neighbors within
     ±6 semitones (self excluded, ≥3 neighbors required). Severity ≥ 0.3
     demotes to red with a report reason; sub-bar deviation competes in the
     pick tiebreak like every other severity. */
  {
    const pool = results.filter(r => r.tier !== 'fail' && r.res && r.res.stats);
    for (const r of pool) {
      if (r.tier === 'red') continue;
      const nbrs = pool.filter(o => o !== r && Math.abs(o.midi - r.midi) <= 6 && o.tier !== 'red');
      if (nbrs.length < 3) continue;
      const med = (arr) => { const v = arr.filter(x => x != null).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
      const st = r.res.stats;
      /* Demotion may ONLY come from post-normalization-AUDIBLE dimensions
         (attack speed, brightness). Source level is inaudible after gain
         normalization — a first cut demoted half the set on level alone,
         the exact false-positive class this gate must avoid — so it stays
         a weak tiebreak signal only. */
      let sevAudible = 0, sevTiebreak = 0; const why = [];
      const mLag = med(nbrs.map(o => o.res.stats.attackTonalLagMs));
      if (st.attackTonalLagMs != null && mLag != null) {
        const oct = Math.abs(Math.log2((st.attackTonalLagMs + 20) / (mLag + 20)));
        sevAudible = Math.max(sevAudible, oct / 3);
        if (oct >= 0.9) why.push(`attack ${st.attackTonalLagMs}ms vs nbr ${mLag}ms`);
      }
      const mVib = med(nbrs.map(o => o.res.stats.fmRateAmpCents));
      if (st.fmRateAmpCents != null && mVib != null) {
        /* Vibrato-depth outlier (log-domain): a faint/rateless note among
           strongly singing neighbors reads as sloppy or dead (phil-cello
           Ds3: rate-line ±1.9¢ vs neighborhood ~±7¢) — single-sample
           unsteadiness measures missed it because its absolute modulation
           numbers are the SMALLEST in the set; only the neighbor contrast
           is audible. Symmetric: an over-wide wobbler also flags. */
        const oct = Math.abs(Math.log2((st.fmRateAmpCents + 2) / (mVib + 2)));
        sevAudible = Math.max(sevAudible, oct / 3);
        if (oct >= 0.9) why.push(`vibrato ±${st.fmRateAmpCents}¢ vs nbr ±${mVib}¢`);
      }
      const mBr = med(nbrs.map(o => o.res.stats.steadyBrightnessDb));
      if (st.steadyBrightnessDb != null && mBr != null) {
        const dev = Math.abs(st.steadyBrightnessDb - mBr);
        sevAudible = Math.max(sevAudible, Math.max(0, dev - 1) / 6);
        if (dev >= 3) why.push(`brightness ${st.steadyBrightnessDb}dB vs nbr ${mBr}dB`);
      }
      sevTiebreak = sevAudible;
      const mLvl = med(nbrs.map(o => o.gain ? -20 * Math.log10(o.gain) : null));
      if (r.gain && mLvl != null) {
        const dev = Math.abs(-20 * Math.log10(r.gain) - mLvl);
        sevTiebreak = Math.max(sevTiebreak, Math.max(0, dev - 2) / 16);
      }
      r._setOutlierSev = sevTiebreak;
      /* Demotion bar 0.4: the confirmed outliers (B3 0.62, D2 0.51, G2
         0.45) sit well above the borderline cluster (0.31-0.34: small
         absolute attack-lag differences like 15 vs 50 ms) — those merely
         lose pick votes rather than being deleted. */
      if (sevAudible >= 0.4) {
        r.tier = 'red';
        st.failReason = `set outlier (sev ${sevAudible.toFixed(2)}): ${why.join('; ') || 'multi-feature deviation'}`;
      }
    }
  }
  const usable = results.filter(r => r.tier === 'green' || r.tier === 'blue' || r.tier === 'yellow');
  if (usable.length === 0) return [];
  usable.sort((a,b) => a.midi - b.midi);

  /* Picker spacing. S=4 is the historical default (every substituted constant
     below equals the original literal); S=3 = minor-third thinning. */
  const S = cfg.pickSpacing;
  const HALF = Math.floor(S / 2);

  /* Two-pass selection for loop instruments:
       Pass 1 — spine: walk green samples at ~S-semitone spacing, pick the
                best within each ±HALF-semitone window.
       Pass 2 — fill: identify gaps > S semitones in the spine (between
                adjacent picks and at the head/tail of the usable range)
                and insert the best remaining usable samples (green >
                blue > yellow, including greens the spine's window vote
                skipped) at ~S-semitone spacing inside each gap.
     Within a window the picker prefers higher tier (blue > yellow), then
     more segments (richer randomization), then more steady-region seconds. */
  /* Worst kept-seam perceptual severity (0 when the perception gates are
     off or stats are absent). Same scale as the selector: Δφ in cycles vs
     partial step/dip dB / 16. Bucketed to 0.1 in the tiebreak so it decides
     between notes with meaningfully different seam quality without letting
     hairline diffs override segment count. (Added 2026-08-18: the old
     tiebreak preferred more-segments/longer-steady and was blind to seam
     quality — As3 with audible p3 seams beat the near-silent Gs3 in a
     window vote.) */
  const worstSeamSeverity = (r) => {
    let worst = 0;
    const seams = r.res && r.res.diag && r.res.diag.segDiag && r.res.diag.segDiag.selectedSeamStats;
    if (Array.isArray(seams)) {
      for (const s of seams) {
        const mod = s.modPhase != null ? s.modPhase : 0;
        const part = Math.max(s.pStepDb != null ? s.pStepDb : 0, s.pDipDb != null ? -s.pDipDb : 0,
                              s.pSlowDb != null ? s.pSlowDb : 0) / 16;
        const pitch = s.pStateC != null ? s.pStateC / 20 : 0;
        const depth = Math.max(s.dDepthDb != null ? s.dDepthDb / 4 : 0,
                               s.dDepthC != null ? s.dDepthC / 20 : 0);
        worst = Math.max(worst, mod, Math.min(0.5, part), Math.min(0.5, pitch), Math.min(0.5, depth));
      }
    }
    /* Sub-bar onset blips compete in the same severity currency — a
       per-trigger flaw a cleaner neighbor avoids. Overshoot never counts. */
    const st = r.res && r.res.stats;
    if (st && st.onsetBlipDb != null && st.onsetBlipRatio != null
        && st.onsetBlipDb >= 1.5 && st.onsetBlipRatio >= 1.5) {
      worst = Math.max(worst, Math.min(0.5, st.onsetBlipDb / 16));
    }
    /* Set-relative deviation is deliberately NOT folded in here: this value
       gates the sub-red pick bar and the coverage pass, which are seam+blip
       audibility only (perception-handoff §7). Set-deviation competes in
       pick ORDERING via `sev` at the call site — it ranks, it never bars;
       its own ≥0.4 demotion upstream is the only gate it owns. (A previous
       fold of _setOutlierSev here let sub-0.4 set-deviation — including the
       inaudible source-LEVEL term — hard-bar picks: trombone G3/C2/Bb2.) */
    return worst;
  };
  const tiebreak = (a, b) => {
    if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[b.tier] - TIER_RANK[a.tier];
    const va = Math.round(worstSeamSeverity(a) / 0.1), vb = Math.round(worstSeamSeverity(b) / 0.1);
    if (va !== vb) return va - vb;
    const na = (a.res.segments && a.res.segments.length) || 0;
    const nb = (b.res.segments && b.res.segments.length) || 0;
    if (na !== nb) return nb - na;
    const sa = (a.res.stats && a.res.stats.steadyDurSec) || 0;
    const sb = (b.res.stats && b.res.stats.steadyDurSec) || 0;
    return sb - sa;
  };

  /* QUALITY-FIRST picker (perception mode) — mirrors the segment selector's
     redesign. The legacy spine/fill walker had two blind spots the 2026-08
     band audit exposed: TIER outranked seam severity (green-but-red-seamed
     D3 beat clean-but-blue Cs3), and fixed spacing windows skipped notes
     entirely (pristine A2, sev 0.11, fell between windows while As2 at 0.34
     was picked). Here: sort by severity bucket (0.1) then the legacy
     tiebreak, greedily accept at ≥2 st separation, sub-red (sev < 0.3)
     only. Coverage gaps then appear exactly where no sub-red material
     exists — preferred over bridging with an audible outlier (Max). */
  if (cfg.gateOpts && cfg.gateOpts.seamPerception && !cfg.decays) {
    const RED = (cfg.gateOpts.pickWorstSevMax != null) ? cfg.gateOpts.pickWorstSevMax : 0.3;
    /* The sub-red BAR applies to seam severity only — a seam defect replays
       every few wraps; a mild set-deviation (e.g. G5's shallower-but-fine
       vibrato at 0.31) is a ranking concern, not a disqualifier. Set
       deviation ≥ 0.4 already demotes upstream. */
    const scored = usable.map(r => ({
      r,
      seamSev: worstSeamSeverity(r),
      sev: Math.max(worstSeamSeverity(r), r._setOutlierSev || 0),
    }));
    scored.sort((a, b) =>
      (Math.round(a.sev / 0.1) - Math.round(b.sev / 0.1)) || tiebreak(a.r, b.r));
    if (process.env.HKL_PICK_DEBUG) {
      for (const { r, seamSev, sev } of scored) {
        const st = r.res && r.res.stats;
        const blip = (st && st.onsetBlipDb != null && st.onsetBlipRatio != null
                      && st.onsetBlipDb >= 1.5 && st.onsetBlipRatio >= 1.5) ? Math.min(0.5, st.onsetBlipDb / 16) : 0;
        const setdev = r._setOutlierSev || 0;
        const fmt = (v, d) => v == null ? '-' : (+v).toFixed(d);
        console.error(`pickdbg ${r.note} seamSev ${seamSev.toFixed(2)} combined ${sev.toFixed(2)} blip ${blip.toFixed(2)} setdev ${setdev.toFixed(2)} atk ${fmt(st && st.attackTonalLagMs, 0)}ms bright ${fmt(st && st.steadyBrightnessDb, 1)}dB vib ${fmt(st && st.fmRateAmpCents, 1)}c tier ${r.tier}`);
      }
    }
    const picked = [];
    for (const { r, seamSev } of scored) {
      if (seamSev >= RED) continue;
      if (picked.some(p => Math.abs(p.midi - r.midi) < 2)) continue;
      picked.push(r);
    }
    picked.sort((a, b) => a.midi - b.midi);
    /* Coverage pass: a gap > S may pull the best remaining sub-red
       candidate at RELAXED separation (≥1 st) — pristine A2 was left out
       solely by the 2 st rule against Gs2 while its band gapped 5 st.
       Red never bridges: a gap is preferred over an audible outlier. */
    const S = cfg.pickSpacing;
    for (;;) {
      let filled = false;
      const bounds = [usable[0].midi - 1, ...picked.map(p => p.midi), usable[usable.length - 1].midi + 1];
      for (let i = 1; i < bounds.length; i++) {
        if (bounds[i] - bounds[i - 1] <= S) continue;
        const cands = scored.filter(({ r, seamSev }) =>
          seamSev < RED && r.midi > bounds[i - 1] && r.midi < bounds[i]
          && !picked.includes(r) && !picked.some(p => Math.abs(p.midi - r.midi) < 1));
        if (!cands.length) continue;
        picked.push(cands[0].r);
        picked.sort((a, b) => a.midi - b.midi);
        filled = true;
        break;
      }
      if (!filled) break;
    }
    return picked;
  }

  /* spacedPick: walk from startMidi to endMidi by S-semitone targets; in each
     ±HALF-semitone window pick the best candidate by tiebreak; advance to
     best.midi + S after each pick. Optionally exclude any candidate within
     minSep semitones of an existing-pick set (used by the fill pass to keep
     yellows from clustering against the spine). */
  function spacedPick(candidates, startMidi, endMidi, excludeFrom, minSep) {
    if (candidates.length === 0) return [];
    const sorted = candidates.slice().sort((a,b) => a.midi - b.midi);
    const picked = [];
    const seen = new Set();
    let target = startMidi;
    while (target <= endMidi + HALF) {
      const win = sorted.filter(r =>
        Math.abs(r.midi - target) <= HALF
        && !seen.has(r.note)
        && (!excludeFrom || !excludeFrom.some(p => Math.abs(r.midi - p.midi) < minSep))
        && !picked.some(p => Math.abs(r.midi - p.midi) < (minSep || 0))
      );
      if (win.length === 0) { target += S; continue; }
      /* Ties (same tier, same segment count, same steady) break toward the
         candidate nearest the target. Matters on the decay path where every
         quality metric ties: the old stable sort favored the lowest midi in
         the window, walking the whole pick chain S-1 semitones per step
         instead of S. */
      const best = win.slice().sort((a, b) =>
        tiebreak(a, b)
        || (Math.abs(a.midi - target) - Math.abs(b.midi - target))
        || (a.midi - b.midi)
      )[0];
      picked.push(best);
      seen.add(best.note);
      target = best.midi + S;
    }
    return picked;
  }

  /* Decay instruments have no loop-quality tiering; samples are typically
     pre-curated by the soundfont author. Keep every valid sample — unless
     the config opts into spacing by setting pickSpacing explicitly (dense
     chromatic sources like the MusiQuest library want thinning too). */
  if (cfg.decays) {
    return cfg.pickSpacingSet
      ? spacedPick(usable, usable[0].midi, usable[usable.length - 1].midi)
      : usable.slice();
  }

  // Pass 1: green spine. No min-sep — allow close greens (e.g. Ab3+Bb3 on
  // Iowa viola) since both are loop-quality samples and redundancy at the
  // green tier is fine.
  //
  // keepAllGreenRange / keepAllRange (when set) carve the usable samples
  // into two slices:
  //   - in-range keeps: every sample in the range whose tier is in the keep
  //     set (green only for keepAllGreenRange; green+blue+yellow for
  //     keepAllRange) is kept unconditionally (no spacing).
  //   - everything else: greens run the spine picker at ~S-st spacing as
  //     usual; blues/yellows go to the fill pass.
  // The spine is the union of (in-range kept-all) ∪ (out-of-range spaced),
  // sorted by midi. The blue/yellow fill pass downstream uses the union as
  // its excludeFrom set so fills don't crowd the dense in-range section.
  const keepLo = cfg.keepAllRangeLowMidi != null ? cfg.keepAllRangeLowMidi : cfg.keepAllGreenLowMidi;
  const keepHi = cfg.keepAllRangeHighMidi != null ? cfg.keepAllRangeHighMidi : cfg.keepAllGreenHighMidi;
  const keepTiers = cfg.keepAllRange ? new Set(['green', 'blue', 'yellow']) : new Set(['green']);
  const kept = (keepLo != null && keepHi != null)
    ? usable.filter(r => r.midi >= keepLo && r.midi <= keepHi && keepTiers.has(r.tier))
    : [];
  const keptNotes = new Set(kept.map(r => r.note));
  const greens = usable.filter(r => r.tier === 'green' && !keptNotes.has(r.note));
  let spine = [];
  if (greens.length > 0 || kept.length > 0) {
    /* Out-of-range portion still gets the ~S-st spacing treatment, with one
       caveat: a single-side gap adjacent to the kept-all block shouldn't
       drop a pick that's <S semitones from the block edge. spacedPick walks
       startMidi → endMidi targeting at +S each iteration; setting startMidi
       to the first available midi (and endMidi to the last) keeps that
       behavior, and the subsequent .concat + sort + fill pass exclusion
       naturally guards against duplicates. */
    const spaced = greens.length > 0
      ? spacedPick(greens, greens[0].midi, greens[greens.length - 1].midi)
      : [];
    spine = kept.concat(spaced);
  }
  spine.sort((a,b) => a.midi - b.midi);

  // Pass 2: fill gaps > S semitones from every usable sample the spine
  // didn't take — including greens the window vote skipped (the tiebreak
  // already ranks green > blue > yellow, so a skipped green outranks any
  // blue/yellow in the same gap). Head/tail edges count as gaps too (we
  // want coverage out to the lowest and highest usable note). Each fill
  // must sit ≥2 semitones from every spine pick AND every other fill —
  // strict enough to block stacking (a yellow at midi N+1 landing right
  // next to a green at N+0, no coverage gain) but loose enough that a
  // 5-semitone gap can still be filled at the only spacing available (one
  // fill at distance 2 from one boundary, 3 from the other).
  const spineNotes = new Set(spine.map(r => r.note));
  const fillTier = usable.filter(r => !spineNotes.has(r.note));
  const minMidi = usable[0].midi;
  const maxMidi = usable[usable.length - 1].midi;
  const FILL_MIN_SEP = 2;
  const gaps = [];
  if (spine.length === 0) {
    // No green spine — fill the entire usable range with blue+yellow.
    // head+tail flags matter: without isHead the fill walk starts at
    // lowExcl+S and the LOWEST usable note falls outside the first ±HALF
    // window, silently dropping the bottom of the range (phil-cello v3:
    // a zero-green run lost C2 — the one note Intonalogy cannot lose).
    gaps.push({ lowExcl: minMidi - 1, highExcl: maxMidi + 1, isHead: true, isTail: true });
  } else {
    if (spine[0].midi - minMidi > S) gaps.push({ lowExcl: minMidi - 1, highExcl: spine[0].midi, isHead: true, isTail: false });
    for (let i = 1; i < spine.length; i++) {
      if (spine[i].midi - spine[i - 1].midi > S) {
        gaps.push({ lowExcl: spine[i - 1].midi, highExcl: spine[i].midi, isHead: false, isTail: false });
      }
    }
    const last = spine[spine.length - 1];
    if (maxMidi - last.midi > S) gaps.push({ lowExcl: last.midi, highExcl: maxMidi + 1, isHead: false, isTail: true });
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
         lowExcl+S up to the highest in-gap candidate.
       - middle: walk from lowExcl+S up to highExcl-1, centered between
         the two spine boundaries.
       Empty-spine case is a single "head+tail" gap covering everything. */
    const startTarget = gap.isHead ? inGap[0].midi : gap.lowExcl + S;
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
  if (cfg.emitShipped) {
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
  /* crossfadeSec: analyzer-chosen seam crossfade for this sample (the
     residual-gated window search — see selectSegments). Omitted when it
     matches the engine default (0.030) so legacy entries stay byte-stable. */
  const xf = r.res.stats && r.res.stats.crossfadeSec;
  const xfStr = (xf != null && xf !== 0.030) ? `,crossfadeSec:${fmt(xf, 3)}` : '';
  return `        {name:'${r.note}',freq:${freqStr}${gainStr}${fileStr},segments:${segsStr},trimStart:${fmt(r.res.trimStart, 7)}${trendStr}${xfStr}}`;
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
  if (cfg.emitShipped) {
    lines.push(`      name:'${cfg.displayName}',source:'hki-shipped',bundleUrl:'/samples/${cfg.instrumentKey}.hki',`);
  } else {
    lines.push(`      name:'${cfg.displayName}',baseUrl:'${cfg.baseUrl}',`);
  }
  const decayFlag = cfg.decays ? 'decays:true' : 'decays:false';
  const loopFlag  = cfg.decays ? 'loop:false' : 'loop:true';
  /* ext: only meaningful for CDN entries (used for default {NOTE}{ext}
     filePattern substitution). HKI-shipped entries carry per-sample file
     fields exclusively, so ext is omitted for them. */
  let header = (cfg.emitShipped)
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
  lines.push(`## Picks (${picks.length}, ~${cfg.pickSpacing}-semitone spacing)`);
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
    lines.push(`| Note | Labeled (Hz) | Measured (Hz) | Drift (¢) | segments | SCC | bridges | xf (ms) | worstRes (dB) | steady (s) | LUFS | gain | tier |`);
    lines.push(`| --- | ---: | ---: | ---: | ---: | :---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |`);
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
      const xf = (s.crossfadeSec != null) ? (s.crossfadeSec * 1000).toFixed(0) : '—';
      const wres = (s.worstResDb != null) ? s.worstResDb.toFixed(1) : '—';
      const steady = (s.steadyDurSec != null) ? s.steadyDurSec.toFixed(2) : '—';
      lines.push(`| ${p.note} | ${labStr} | ${detStr} | ${drift} | ${nSeg} | ${scc} | ${br} | ${xf} | ${wres} | ${steady} | ${gainColLoop(p)} | ${p.tier} |`);
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

/* Machine-readable per-run summary (out/<key>-summary.json). Batch runners
   aggregate these instead of parsing report.md. */
function buildSummary(results, picks, cfg, hkiPath) {
  const tiers = { green: 0, blue: 0, yellow: 0, red: 0, fail: 0 };
  for (const r of results) tiers[r.tier] = (tiers[r.tier] || 0) + 1;
  return {
    instrumentKey: cfg.instrumentKey,
    displayName: cfg.displayName,
    path: cfg.decays ? 'decay' : 'loop',
    vibrato: !!cfg.vibrato,
    pickSpacing: cfg.pickSpacingSet ? cfg.pickSpacing : null,
    analyzed: results.length,
    picked: picks.length,
    pickedNotes: picks.map(p => p.note),
    /* Loop path: loudest kept-seam residual across all picks (dB rel. signal)
       and the distribution of analyzer-chosen crossfade windows. */
    worstResDb: cfg.decays ? null : picks.reduce((m, p) => {
      const w = p.res.stats && p.res.stats.worstResDb;
      return (w != null && (m == null || w > m)) ? w : m;
    }, null),
    crossfades: cfg.decays ? null : picks.reduce((acc, p) => {
      const xf = p.res.stats && p.res.stats.crossfadeSec;
      if (xf != null) { const k = (xf * 1000).toFixed(0) + 'ms'; acc[k] = (acc[k] || 0) + 1; }
      return acc;
    }, {}),
    tiers,
    fails: results
      .filter(r => r.tier === 'fail' || r.tier === 'red')
      .map(r => ({
        note: r.note,
        tier: r.tier,
        reason: (r.res && (r.res.failReason || (r.res.stats && r.res.stats.failReason))) || null,
      })),
    bundleBytes: (hkiPath && fs.existsSync(hkiPath)) ? fs.statSync(hkiPath).size : null,
    createdAt: new Date().toISOString(),
  };
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
      const tier = cfg.decays ? classifyDecay(res) : classifyLoop(res, cfg);
      const d = buf.getChannelData();
      const stereo = loadStereoRaw(fetched.rawStereo);
      const meas = cfg.decays ? measureDecay(stereo, d) : measureRmsLoop(stereo, d, res);
      const rms = meas ? meas.rms : null;
      const peak = meas ? meas.peak : null;
      const lufs = (meas && typeof meas.lufs === 'number') ? meas.lufs : null;
      const gain = computeGain(meas);
      const rec = { note: n.note, midi: n.midi, labeledFreq: n.labeledFreq, matchedFile: fetched.matchedFile, rawPath: fetched.raw, res, tier, rms, peak, lufs, gain, durationSec: buf.length / SR };
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
  /* Loudness-evenness correction (cfg.loudnessEvenness > 0, loop path only).
     Sones are computed per pick over its segment span AT ITS NORMALIZED GAIN
     (the level users hear), compared against the pick-set median, and notes
     above median are attenuated by evenness × 10·log2(rel) dB — the phon-dB
     heuristic (×2 sones ≈ 10 phon ≈ 10 dB at moderate levels). One-shot, not
     iterated: the model is uncalibrated in absolute level, so the blend
     factor is the ear-trim knob, not the exponent. Runs BEFORE bundle cut /
     block / report emission so every consumer sees the corrected gain. */
  if (!cfg.decays && cfg.loudnessEvenness > 0 && picks.length >= 3) {
    const measured = picks.map((r) => {
      const segs = r.res && r.res.segments;
      if (!segs || !segs.length || typeof r.gain !== 'number' || !r.rawPath) return null;
      const mono = loadRaw(r.rawPath).getChannelData();
      const a = Math.min(...segs.map((g) => g.a)), b = Math.max(...segs.map((g) => g.b));
      const m = sustainSones(mono, SR, Math.round(a * SR), Math.round(b * SR), r.gain);
      return m ? m.sones : null;
    });
    const vals = measured.filter((v) => v != null).sort((x, y) => x - y);
    if (vals.length >= 3) {
      const median = vals[vals.length >> 1];
      for (let i = 0; i < picks.length; i++) {
        if (measured[i] == null) continue;
        const rel = measured[i] / median;
        if (rel <= 1) continue;
        const corrDb = -cfg.loudnessEvenness * 10 * Math.log2(rel);
        picks[i].gain = Math.max(GAIN_MIN, picks[i].gain * Math.pow(10, corrDb / 20));
        picks[i]._evennessDb = corrDb;
        console.error(`evenness ${picks[i].note}: rel ${rel.toFixed(2)}x -> ${corrDb.toFixed(2)} dB (gain ${picks[i].gain.toFixed(4)})`);
      }
    } else {
      console.error('evenness: skipped (fewer than 3 measurable picks)');
    }
  }
  /* Bundle tail-cut (loop path): audio past the last segment's b never plays
     by design — the engine's furthest read is maxB + crossfade during the
     wrap plus the release tail after noteOff. Mark the cut point on every
     pick whose source runs longer; bundle.js executes the trim (stream-copy
     for lossy sources, trimmed Opus encode for lossless), so the archive
     keeps only audio that can actually sound. Decay instruments play their
     full length and are never cut. */
  if (!cfg.decays) {
    const XF_MAX = 0.030, TAIL_MARGIN = 0.1;
    for (const p of picks) {
      const segs = (p.res && p.res.segments) || [];
      if (!segs.length || !p.durationSec) continue;
      const maxB = segs.reduce((m, s) => Math.max(m, s.b), 0);
      const cutSec = maxB + XF_MAX + cfg.releaseTime + TAIL_MARGIN;
      if (cutSec < p.durationSec) p.bundleCutSec = +cutSec.toFixed(3);
    }
  }
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
  let hkiPath = null;
  if (cfg.bundle && picks.length > 0) {
    const { buildBundle } = await import('./bundle.js');
    const cacheDir = path.join(CACHE_DIR, cfg.configName);
    const built = buildBundle(cfg, picks, OUT_DIR, cacheDir);
    hkiPath = built.hkiPath;
    console.error(`wrote: ${built.hkiPath}`);
    console.error(`wrote: ${built.defPath}`);
  }
  const summaryPath = path.join(OUT_DIR, `${cfg.instrumentKey}-summary.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(buildSummary(results, picks, cfg, hkiPath), null, 2) + '\n');
  console.error(`wrote: ${summaryPath}`);
})();
