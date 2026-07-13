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
import { cleanCapture, findOnsetSec, postGainNoiseDb, POSTGAIN_NOISE_SKIP_DB } from './clean.js';
import { velocityCurveGain } from '@hkl/shared/velocity.js';
import type { VelocityResponse } from '../state.js';
import { getCapture } from '../capture/store.js';
import type { CaptureRecord } from '../device/types.js';
import type { HkiBundle, HkiManifest, HkiSampleEntry } from '@hkl/shared/hki.js';
import type { CaptureConfig } from '../state.js';
import type { JobOutcome } from '../capture/loop.js';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteName(midi: number): string {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
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
  /** Layers dropped because their post-gain noise floor exceeded
   *  POSTGAIN_NOISE_SKIP_DB (can't be cleanly boosted). e.g. ["A6_v24"].
   *  Playback falls back to the note's nearest surviving layer via pickLayer. */
  skippedLayers: string[];
}

/** Per-reference-velocity SOFTENING scale for velocity-layered notes, derived by
 *  comparing the device's MEASURED velocity→loudness (`resp`, the discovery
 *  sweep) against the house velocity curve HKL plays back with.
 *
 *  For each layer velocity v the residual r(v) = L(v)/houseCurve(v) is how much
 *  louder the KEYBOARD actually is at v than our curve already applies. Anchoring
 *  at the max residual gives a scale ≤ 1 that ONLY attenuates: the layer where
 *  the keyboard is loudest-relative-to-our-curve keeps its flat-normalized gain;
 *  the others are pulled down by exactly the keyboard's own relative deficit.
 *  Net effect: the house curve keeps owning the bulk of the velocity dynamics
 *  (we don't touch our "proven" system), and the residual — baked per layer —
 *  reproduces the keyboard's real inter-layer balance, so a brighter layer no
 *  longer reads as a perceived-loudness tier. Multiplies the flat normalization
 *  gain, so it never lifts a layer toward clipping.
 *
 *  Returns velocity→scale for `vels`; a missing/degenerate `resp` ⇒ all 1.0. */
export function layerSofteningScale(resp: VelocityResponse | null | undefined, vels: number[]): Map<number, number> {
  const scale = new Map<number, number>();
  for (const v of vels) scale.set(v, 1.0);
  if (!resp || resp.length < 2 || vels.length < 2) return scale;

  const sorted = [...resp].sort((a, b) => a.velocity - b.velocity);
  const levelDbAt = (v: number): number => {
    if (v <= sorted[0].velocity) return sorted[0].levelDb;
    const last = sorted[sorted.length - 1];
    if (v >= last.velocity) return last.levelDb;
    for (let i = 1; i < sorted.length; i++) {
      if (v <= sorted[i].velocity) {
        const a = sorted[i - 1], b = sorted[i];
        const t = (v - a.velocity) / (b.velocity - a.velocity);
        return a.levelDb + t * (b.levelDb - a.levelDb);   // linear interp in dB
      }
    }
    return last.levelDb;
  };

  const residual = new Map<number, number>();
  let maxR = -Infinity;
  for (const v of vels) {
    const kbdLin = Math.pow(10, levelDbAt(v) / 20);   // keyboard's measured level
    const curve = velocityCurveGain(v);               // what our curve already applies
    const r = curve > 0 ? kbdLin / curve : 0;
    residual.set(v, r);
    if (r > maxR) maxR = r;
  }
  if (!(maxR > 0)) return scale;
  for (const v of vels) scale.set(v, (residual.get(v) ?? maxR) / maxR);
  return scale;
}

/** Build a v2 layered .hki bundle from the passing capture outcomes.
 *  `whineToneHz` (the device's calibrated whine profile) is notched out of each
 *  raw capture before broadband NR — empty ⇒ no de-whine.
 *  `velocityResponse` (the discovery sweep's measured velocity→loudness) softens
 *  brighter velocity layers vs the house curve — null ⇒ no per-layer softening. */
export function buildBundle(outcomes: JobOutcome[], config: CaptureConfig, deviceLabel: string, whineToneHz: number[] = [], velocityResponse: VelocityResponse | null = null): BuildResult {
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
  const skippedLayers: string[] = [];
  let layerCount = 0;

  // Perceptual softening scale, over the reference velocities of the MULTI-layer
  // notes only (a single-layer note has no timbre-tier to soften).
  const layeredVels = new Set<number>();
  for (const list of byNote.values()) if (list.length > 1) for (const o of list) layeredVels.add(o.job.velocity);
  const softening = layerSofteningScale(velocityResponse, [...layeredVels]);

  // Clean a capture in two stages, then analyze + encode the CLEAN audio (so
  // gain/freq and the stored WAV all reflect it):
  //   1. De-whine — notch the device's fixed tonal comb out of the RAW capture,
  //      where it's at full strength. Pure tones → notch, not subtraction (no
  //      musical noise). Runs first so the pre-roll used for the NR profile is
  //      already tone-free.
  //   2. Broadband NR — decision-directed Wiener, profiled from the pre-attack
  //      silence, pulls the hiss down without the musical-noise birdies plain
  //      spectral subtraction left (which stacked across soft chords).
  const cleanCache = new Map<string, CaptureRecord | null>();
  const cleanOf = (captureId: string): CaptureRecord | null => {
    if (cleanCache.has(captureId)) return cleanCache.get(captureId)!;
    const rec = getCapture(captureId);
    if (!rec) { cleanCache.set(captureId, null); return null; }
    const clean = cleanCapture(rec.channels, rec.sampleRate, whineToneHz);
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

    // Assess every layer, then drop any whose post-gain noise floor is too high
    // to boost cleanly (a soft high note whose required gain amplifies its hiss
    // into audibility). Skip is per-layer — playback falls back to the note's
    // nearest surviving layer via pickLayer — but never empties a note: if every
    // layer is over threshold, keep the single least-noisy one (a quiet-ish note
    // beats a hole that pitch-shifts a neighbour).
    interface Cand { layer: JobOutcome; clean: CaptureRecord; gain: number; trimStart: number; pgn: number; }
    const cands: Cand[] = [];
    for (const layer of layers) {
      const clean = cleanOf(layer.job.captureId);
      if (!clean) continue;
      const a = analyzeCapture(clean.channels, clean.sampleRate);
      // Soften brighter layers by the keyboard-vs-house-curve residual (multi-
      // layer notes only). ≤ 1, so it only attenuates the flat normalization.
      const soften = layers.length > 1 ? (softening.get(layer.job.velocity) ?? 1) : 1;
      const gain = a.gain * soften;
      cands.push({ layer, clean, gain, trimStart: a.trimStart, pgn: postGainNoiseDb(clean, gain) });
    }
    if (cands.length === 0) continue;
    const clean = cands.filter(c => c.pgn <= POSTGAIN_NOISE_SKIP_DB);
    const keep = clean.length > 0 ? clean : [cands.reduce((m, c) => (c.pgn < m.pgn ? c : m))];
    const keepSet = new Set(keep);

    for (const c of cands) {
      const vel = c.layer.job.velocity;
      if (!keepSet.has(c)) { skippedLayers.push(`${name}_v${vel}`); continue; }
      const file = `samples/${name}_v${vel}.wav`;
      const entry: HkiSampleEntry = { name, file, freq: noteFreq, gain: c.gain };
      // Only tag `vel` when the note actually has multiple layers — a single-layer
      // note stays a plain (vel-less) v1-style entry.
      if (layers.length > 1) entry.vel = vel;
      if (c.trimStart > 0) entry.trimStart = c.trimStart;
      samples.push(entry);
      audio[file] = encodeWavFloat32(fadeOutTail(c.clean.channels, c.clean.sampleRate), c.clean.sampleRate);
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

  return { bundle, noteCount: byNote.size, layerCount, skippedLayers };
}
