// Analysis + v2 .hki assembly. Each captured layer is normalized to the shared
// TARGET (−18 dBFS, −3 dB peak ceiling) with the analyzer's gain finder, encoded
// lossless to WAV, and emitted as one FLAT samples[] row tagged with its
// reference velocity (`vel`). Layers of one note share a single measured `freq`
// (so the engine groups them) and each carries its own normalize gain — so the
// engine picks the nearest layer by velocity, then the velocity curve owns
// loudness (see Phase 1 / .hki v2).
//
// Decay instruments only (sustained is out of HKLO scope): loop:false, decays:true.

import { computeGain, measureDecay, buildInterleavedStereo, buildMonoDownmix } from './shim.js';
import { denoiseChannels } from './denoise.js';
import { getCapture } from '../capture/store.js';
import type { CaptureRecord } from '../device/types.js';
import type { HkiBundle, HkiManifest, HkiSampleEntry } from '@hkl/shared/hki.js';
import type { CaptureConfig } from '../state.js';
import type { JobOutcome } from '../capture/loop.js';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteName(midi: number): string {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

const ONSET_THRESH = 0.003;
function findOnsetSec(mono: Float32Array, sr: number): number {
  for (let i = 0; i < mono.length; i++) if (Math.abs(mono[i]) > ONSET_THRESH) return i / sr;
  return 0;
}

const TAIL_FADE_MS = 30;
/** Raised-cosine fade-out over the last TAIL_FADE_MS of each channel, returned
 *  as NEW arrays (originals untouched, so the gain/trim analysis that runs on the
 *  full signal upstream is unaffected). The recorder stops capture when the decay
 *  reaches the noise floor; for low-SNR (very soft) layers that stop point is only
 *  a few dB below peak, and per-layer normalization then boosts the abrupt
 *  buffer-end to an audible level — a click/cutoff on playback. Fading the tail to
 *  true zero makes every sample end smoothly regardless of where the stop fired. */
function fadeOutTail(channels: Float32Array[], sr: number): Float32Array[] {
  const n = channels[0]?.length ?? 0;
  const fadeN = Math.min(Math.round((TAIL_FADE_MS * sr) / 1000), Math.floor(n / 4));
  return channels.map(ch => {
    const out = ch.slice();
    for (let i = 0; i < fadeN; i++) {
      // i=0 → g≈1 (first faded sample), i=fadeN-1 → g=0 (last sample is true zero)
      const g = 0.5 * (1 + Math.cos((Math.PI * (i + 1)) / fadeN));
      out[n - fadeN + i] *= g;
    }
    return out;
  });
}

/** Lossless 32-bit float WAV (IEEE float, format 3) — bit-exact from the Float32
 *  capture, decodable by AudioContext.decodeAudioData, deflated inside the .hki. */
export function encodeWavFloat32(channels: Float32Array[], sampleRate: number): Uint8Array {
  const nCh = channels.length;
  const n = channels[0]?.length ?? 0;
  const blockAlign = nCh * 4;
  const dataLen = n * blockAlign;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 3, true); // 3 = IEEE float
  dv.setUint16(22, nCh, true); dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * blockAlign, true); dv.setUint16(32, blockAlign, true); dv.setUint16(34, 32, true);
  str(36, 'data'); dv.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nCh; c++) { dv.setFloat32(off, channels[c][i], true); off += 4; }
  return new Uint8Array(buf);
}

interface LayerAnalysis { gain: number; trimStart: number; }

function analyzeCapture(channels: Float32Array[], sr: number): LayerAnalysis {
  const stereo = buildInterleavedStereo(channels);
  const mono = buildMonoDownmix(channels);
  const trimStart = findOnsetSec(mono, sr);
  const meas = measureDecay(stereo, mono, sr);
  const gain = computeGain(meas) ?? 1.0;
  // Pitch is NOT detected here: we trust the claimed MIDI→12-TET frequency for
  // the stored `freq` (see below). The instrument holds equal temperament more
  // accurately than period-detection, which is biased sharp by piano
  // inharmonicity and noisy at low SNR.
  return { gain, trimStart };
}

export interface BuildResult {
  bundle: HkiBundle;
  noteCount: number;
  layerCount: number;
}

/** Build a v2 layered .hki bundle from the passing capture outcomes. */
export function buildBundle(outcomes: JobOutcome[], config: CaptureConfig, deviceLabel: string): BuildResult {
  const passing = outcomes.filter(o => o.gate.pass);
  if (passing.length === 0) throw new Error('No passing captures to export.');

  // Group passing layers by MIDI note.
  const byNote = new Map<number, JobOutcome[]>();
  for (const o of passing) {
    const list = byNote.get(o.job.midi) ?? [];
    list.push(o);
    byNote.set(o.job.midi, list);
  }

  const samples: HkiSampleEntry[] = [];
  const audio: Record<string, Uint8Array> = {};
  let layerCount = 0;

  // Noise-reduce a capture using the pre-attack silence as its noise profile,
  // then analyze + encode the CLEAN audio (so gain/freq and the stored WAV all
  // reflect the denoised signal).
  const cleanCache = new Map<string, CaptureRecord | null>();
  const cleanOf = (captureId: string): CaptureRecord | null => {
    if (cleanCache.has(captureId)) return cleanCache.get(captureId)!;
    const rec = getCapture(captureId);
    if (!rec) { cleanCache.set(captureId, null); return null; }
    const onsetSec = findOnsetSec(buildMonoDownmix(rec.channels), rec.sampleRate);
    const clean: CaptureRecord = { channels: denoiseChannels(rec.channels, rec.sampleRate, onsetSec), sampleRate: rec.sampleRate };
    cleanCache.set(captureId, clean);
    return clean;
  };

  for (const midi of [...byNote.keys()].sort((a, b) => a - b)) {
    const layers = byNote.get(midi)!.sort((a, b) => a.job.velocity - b.job.velocity);
    const name = noteName(midi);
    // Trust the claimed MIDI→12-TET pitch (A440) — identical for every layer of
    // the note, and more accurate than per-note detection. The JI correction is
    // computed from the tuning system at playback, landing the fundamental
    // exactly on target. (Mirrors the analyzer's trustLabeledPitch, default-on
    // for local sources.)
    const noteFreq = layers[0].job.freq;

    for (const layer of layers) {
      const clean = cleanOf(layer.job.captureId);
      if (!clean) continue;
      const a = analyzeCapture(clean.channels, clean.sampleRate);
      const file = `samples/${name}_v${layer.job.velocity}.wav`;
      const entry: HkiSampleEntry = { name, file, freq: noteFreq, gain: a.gain };
      // Only tag `vel` when the note actually has multiple layers — a single-layer
      // note stays a plain (vel-less) v1-style entry.
      if (layers.length > 1) entry.vel = layer.job.velocity;
      if (a.trimStart > 0) entry.trimStart = a.trimStart;
      samples.push(entry);
      audio[file] = encodeWavFloat32(fadeOutTail(clean.channels, clean.sampleRate), clean.sampleRate);
      layerCount++;
    }
  }

  const manifest: HkiManifest = {
    version: 2,
    instrumentKey: config.instrumentKey,
    name: config.displayName || config.instrumentKey,
    loop: false,
    decays: true,
    releaseTime: 0.15,
    volume: 1.0,
    samples,
  };

  const bundle: HkiBundle = {
    manifest,
    audio,
    provenance: {
      source: 'orchestrator',
      generator: 'hkl-orchestrator@1',
      createdAt: new Date().toISOString(),
      device: deviceLabel,
    },
  };

  return { bundle, noteCount: byNote.size, layerCount };
}
