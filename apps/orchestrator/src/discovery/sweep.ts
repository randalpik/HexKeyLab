// Velocity sweep: at one probe note, record a short fixed-length tone at every
// stride-th velocity across 1..127 and fingerprint each. Feeds detectBins().

import { record } from '../device/recorder.js';
import { computeFingerprint, type Fingerprint } from './fingerprint.js';
import type { CaptureDevice } from '../device/types.js';

export interface SweepOpts {
  probeNote: number;
  stride?: number;
  probeSec?: number;
  gapMs?: number;
  /** Throwaway note before the measured sweep, to let the audio chain settle —
   *  the first capture of a cold device/interface is often unreliable. */
  warmupMs?: number;
  onProgress?: (done: number, total: number, velocity: number) => void;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function sweepVelocities(stride: number): number[] {
  const vels: number[] = [];
  for (let v = 1; v <= 127; v += stride) vels.push(v);
  if (vels[vels.length - 1] !== 127) vels.push(127);
  return vels;
}

export async function runSweep(device: CaptureDevice, opts: SweepOpts): Promise<Fingerprint[]> {
  const stride = opts.stride ?? 4;
  const probeSec = opts.probeSec ?? 1;
  // The gap must exceed the instrument's ring-out so a probe never captures the
  // PREVIOUS note's decay tail — otherwise every probe but the first is polluted
  // by its predecessor's ring, and the (unpolluted) first probe reads as a false
  // boundary at the low end.
  const gapMs = opts.gapMs ?? 700;
  const vels = sweepVelocities(stride);

  // Warm-up: a discarded real capture so the audio graph/interface is fully
  // settled before the first measured probe (a cold first capture can be silent
  // → garbage fingerprint). Followed by a full gap to clear its ring-out.
  const warmupMs = opts.warmupMs ?? 300;
  if (warmupMs > 0) {
    device.allNotesOff();
    await record(device, { note: opts.probeNote, velocity: 80, fixedDuration: true, maxSec: warmupMs / 1000, signal: opts.signal });
    await sleep(gapMs);
  }

  const fps: Fingerprint[] = [];
  for (let i = 0; i < vels.length; i++) {
    if (opts.signal?.aborted) throw new Error('sweep aborted');
    device.allNotesOff();
    const rec = await record(device, {
      note: opts.probeNote,
      velocity: vels[i],
      fixedDuration: true,
      maxSec: probeSec,
      signal: opts.signal,
    });
    fps.push(computeFingerprint(rec, vels[i]));
    opts.onProgress?.(i + 1, vels.length, vels[i]);
    await new Promise(r => setTimeout(r, gapMs));
  }
  return fps;
}
