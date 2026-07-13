// Whine calibration: record a few seconds of the device's idle output, detect
// its fixed tonal artifact comb, and return the tone frequencies (the whine
// profile). Stored on the session and notched out of every capture before NR
// (see analysis/dewhine + analysis/buildHki). One calibration per device;
// re-run if the device or its master volume changes.

import { recordIdle } from '../device/recorder.js';
import { detectCombTones } from '../analysis/dewhine.js';
import { buildMonoDownmix } from '../analysis/shim.js';
import type { CaptureDevice } from '../device/types.js';

export interface WhineCalOpts {
  /** Idle recording length (s). Longer → more spectral averaging → cleaner
   *  detection; 3 s at 44.1/48 k gives ~10 Welch frames at the default FFT. */
  seconds?: number;
  signal?: AbortSignal;
}

export interface WhineCalResult {
  toneHz: number[];
  seconds: number;
  sampleRate: number;
}

export async function calibrateWhine(device: CaptureDevice, opts: WhineCalOpts = {}): Promise<WhineCalResult> {
  const seconds = opts.seconds ?? 3;
  const rec = await recordIdle(device, seconds, opts.signal);
  const mono = buildMonoDownmix(rec.channels);
  const toneHz = detectCombTones(mono, rec.sampleRate);
  return { toneHz, seconds, sampleRate: rec.sampleRate };
}
