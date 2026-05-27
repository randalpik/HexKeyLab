#!/usr/bin/env node
/**
 * bundle.js — assemble a .hki bundle from the picks produced by generate-samples.js.
 *
 * Called from generate-samples.js:main() when cfg.source==='local' or --bundle
 * is passed. Reads cached source audio from analyzer/.cache/<configName>/,
 * applies the encoding policy (keep lossy verbatim, encode lossless to
 * OGG/Opus via ffmpeg), assembles a manifest, and writes
 * analyzer/out/<key>.hki.
 *
 * Encoding policy:
 *   .mp3 / .ogg / .opus / .aac / .m4a → kept verbatim (no re-encode of lossy)
 *   .wav / .aiff / .aif / .flac       → encoded to OGG/Opus (128 kbps)
 *   anything else                     → kept verbatim
 *
 * The format spec lives in packages/shared/src/hki.ts; we import its writer so the
 * bundle is produced by exactly the same code path that the browser uses to
 * read it. fflate runs in both Node and the browser.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeHki, HKI_MANIFEST_VERSION } from '../packages/shared/src/hki.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const LOSSY_EXTS = new Set(['.mp3', '.ogg', '.opus', '.aac', '.m4a']);
const LOSSLESS_EXTS = new Set(['.wav', '.aiff', '.aif', '.flac']);

/** Pick the encoded extension for a given source extension. */
function targetExt(srcExt) {
  const e = srcExt.toLowerCase();
  if (LOSSY_EXTS.has(e)) return e;     /* keep as-is */
  if (LOSSLESS_EXTS.has(e)) return '.opus';
  return e; /* unknown — keep as-is, let the engine try to decode it */
}

/** Encode a lossless source to OGG/Opus. ffmpeg writes a .ogg container with
 *  Opus inside — this is the conventional encoding for "OGG/Opus" and is
 *  what every modern browser's decodeAudioData accepts. */
function encodeOpus(srcPath, dstPath) {
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-y',
    '-i', srcPath,
    '-c:a', 'libopus',
    '-b:a', '128k',
    '-ar', '48000',         /* Opus's preferred sample rate */
    '-vbr', 'on',
    dstPath,
  ], { stdio: 'inherit' });
}

/** Read whatever the source file is (no transcoding for lossy sources). */
function readVerbatim(srcPath) {
  return fs.readFileSync(srcPath);
}

/**
 * Build a `.hki` bundle from analyzer picks.
 *
 * @param {object} cfg - the parsed analyzer config (with .instrumentKey, .ext, etc.)
 * @param {Array}  picks - the kept samples (from pickSamples in generate-samples.js).
 *                         Each pick has { note, midi, matchedFile, labeledFreq, res, gain, ... }.
 * @param {string} outDir - directory to write the bundle into.
 * @param {string} cacheDir - directory holding the cached source audio
 *                            (analyzer/.cache/<configName>).
 * @returns {string} - the absolute path to the written .hki.
 */
export function buildBundle(cfg, picks, outDir, cacheDir) {
  fs.mkdirSync(outDir, { recursive: true });
  /* Staging dir for transcoded audio (so re-running the bundler reuses
     already-encoded .opus files when the source hasn't changed). */
  const stage = path.join(cacheDir, '_bundle');
  fs.mkdirSync(stage, { recursive: true });

  const audio = {};                            /* archive-relative path → bytes */
  const sampleEntries = [];
  const originalFiles = {};                    /* sample.name → source filename */

  for (const p of picks) {
    /* The cached source file is at cacheDir/<matchedFile> — fetchOne always
       writes here regardless of source. */
    const srcPath = path.join(cacheDir, p.matchedFile);
    if (!fs.existsSync(srcPath)) {
      throw new Error(`bundle: cached source missing for ${p.note}: ${srcPath}`);
    }
    const srcExt = path.extname(p.matchedFile);
    const outExt = targetExt(srcExt);
    const archiveFile = `samples/${p.note}${outExt}`;

    let bytes;
    if (outExt === srcExt) {
      /* Lossy passthrough. Read once; no transcoding. */
      bytes = readVerbatim(srcPath);
    } else {
      /* Lossless → Opus. Cache the encoded result by source mtime — if the
         source hasn't changed since the last encode, reuse. */
      const stagedPath = path.join(stage, `${p.note}${outExt}`);
      const srcMtime = fs.statSync(srcPath).mtimeMs;
      const stagedFresh = fs.existsSync(stagedPath) && fs.statSync(stagedPath).mtimeMs >= srcMtime;
      if (!stagedFresh) encodeOpus(srcPath, stagedPath);
      bytes = fs.readFileSync(stagedPath);
    }
    audio[archiveFile] = bytes;

    /* Per-sample manifest entry — mirrors what emit-block builds for
       samples-data.ts, with `file` pointing into the archive instead of a
       CDN-relative filename. Pitch source:
         - cfg.trustLabeledPitch (default for source:"local"): labeled ET.
           Use when the samples have been externally pitch-validated.
         - else: analyzer-detected freqActual, falling back to labeled if
           detection failed.
       See generate-samples.js:loadConfig for the rationale. */
    const detected = (typeof p.res.freqActual === 'number') ? p.res.freqActual : null;
    const labeled = p.labeledFreq / (cfg.transpose || 1);
    const freq = cfg.trustLabeledPitch ? labeled : (detected != null ? detected : labeled);
    const entry = { name: p.note, file: archiveFile, freq: round(freq, 3) };
    if (typeof p.gain === 'number') entry.gain = round(p.gain, 4);
    if (!cfg.decays) {
      const segs = (p.res.segments || []).slice().sort((a, b) => a.a - b.a);
      entry.segments = segs.map(s => ({ a: round(s.a, 7), b: round(s.b, 7) }));
      entry.trimStart = round(p.res.trimStart || 0, 7);
      const trend = p.res.trend;
      if (trend && trend.applied && trend.values && trend.values.length) {
        entry.trend = trend.values.map(v => round(v, 4));
        entry.trendHopMs = trend.hopMs;
        entry.trendStartSec = round(trend.startSec, 4);
      }
    }
    sampleEntries.push(entry);
    originalFiles[p.note] = p.matchedFile;
  }

  const manifest = {
    version: HKI_MANIFEST_VERSION,
    instrumentKey: cfg.instrumentKey,
    name: cfg.displayName,
    loop: !cfg.decays,
    decays: !!cfg.decays,
    releaseTime: cfg.releaseTime,
    volume: cfg.volume,
    samples: sampleEntries,
  };
  if (cfg.transpose && cfg.transpose !== 1) manifest.transpose = cfg.transpose;
  if (cfg.replayOnTranspose) manifest.replayOnTranspose = true;
  if (cfg.vibrato) manifest.vibrato = true;

  const provenance = {
    source: cfg.source || 'cdn',
    sourceUrl: cfg.baseUrl,
    sourceDir: cfg.sourceDir,
    originalFiles,
    generator: 'analyzer/bundle.js@v1',
    createdAt: new Date().toISOString(),
  };

  const bytes = writeHki({ manifest, audio, provenance });
  const outPath = path.join(outDir, `${cfg.instrumentKey}.hki`);
  fs.writeFileSync(outPath, bytes);
  return outPath;
}

function round(x, n) {
  return +Number(x).toFixed(n);
}
