// Shared capture cleaning + normalization assessment, used by both the export
// path (buildHki: clean → gain → skip) and the capture loop (loop: clean →
// assess → auto-retry). Kept in its own module so the loop doesn't have to
// import the whole bundle builder (and to avoid a loop↔buildHki cycle).

import { computeGain, measureDecay, buildInterleavedStereo, buildMonoDownmix } from './shim.js';
import { dewhineChannels } from './dewhine.js';
import { wienerDenoiseChannels } from './wiener.js';
import type { CaptureRecord } from '../device/types.js';

const ONSET_THRESH = 0.003;
const NOISE_WIN_SEC = 0.08;

/** First sample above a small absolute threshold, in seconds (leading-silence
 *  trim boundary + the noise-profile boundary for the Wiener stage). */
export function findOnsetSec(mono: Float32Array, sr: number): number {
  for (let i = 0; i < mono.length; i++) if (Math.abs(mono[i]) > ONSET_THRESH) return i / sr;
  return 0;
}

/** The export cleaning chain: de-whine (notch the device comb) → Wiener broadband
 *  NR (profiled from the pre-attack silence, now tone-free). Returns a new record. */
export function cleanCapture(channels: Float32Array[], sr: number, whineToneHz: number[]): CaptureRecord {
  const dewhined = dewhineChannels(channels, sr, whineToneHz);
  const onsetSec = findOnsetSec(buildMonoDownmix(dewhined), sr);
  return { channels: wienerDenoiseChannels(dewhined, sr, onsetSec), sampleRate: sr };
}

/** Pre-attack noise floor of a cleaned capture, dBFS (linear RMS over the first
 *  NOISE_WIN_SEC — the recorder's pre-roll). */
export function noiseFloorDbOf(clean: CaptureRecord): number {
  const mono = buildMonoDownmix(clean.channels);
  const win = Math.min(Math.round(NOISE_WIN_SEC * clean.sampleRate), Math.floor(mono.length * 0.2));
  if (win <= 0) return -140;
  let sq = 0;
  for (let i = 0; i < win; i++) sq += mono[i] * mono[i];
  const rms = Math.sqrt(sq / win);
  return rms > 0 ? 20 * Math.log10(rms) : -140;
}

/** Post-gain noise floor (dBFS) = the cleaned pre-roll floor lifted by `gain`.
 *  This is what a played note's boosted broadband hiss actually measures — the
 *  reliable predictor of an audible whine (see the −45 dBFS skip threshold). */
export function postGainNoiseDb(clean: CaptureRecord, gain: number): number {
  return noiseFloorDbOf(clean) + (gain > 0 ? 20 * Math.log10(gain) : -140);
}

/** Above this post-gain noise floor, a layer can't be cleanly boosted — the
 *  boosted hiss is audible — so it's dropped (export) / retried (capture). */
export const POSTGAIN_NOISE_SKIP_DB = -45;

/** Flat-normalization gain of a cleaned capture (measureDecay + computeGain, with
 *  the short-decay RMS fallback; never null → defaults 1.0). NB: this is the
 *  pre-softening gain — the loop's retry heuristic doesn't have the whole-note
 *  context softening needs, and soft layers (the failure cases) soften ≈ 1 anyway. */
export function cleanGain(clean: CaptureRecord): number {
  const stereo = buildInterleavedStereo(clean.channels);
  const mono = buildMonoDownmix(clean.channels);
  return computeGain(measureDecay(stereo, mono, clean.sampleRate)) ?? 1.0;
}

/** Clean a raw capture and return its gain + post-gain noise floor — the
 *  loop-side assessment for auto-retry. */
export function assessRaw(channels: Float32Array[], sr: number, whineToneHz: number[]): { gain: number; postGainNoiseDb: number } {
  const clean = cleanCapture(channels, sr, whineToneHz);
  const gain = cleanGain(clean);
  return { gain, postGainNoiseDb: postGainNoiseDb(clean, gain) };
}
