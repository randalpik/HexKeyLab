// Capture plan: enumerate the (note × velocity-layer) jobs to record from the
// config + chosen velocity bins.

import { midiToFreq } from '../device/device.js';
import type { CaptureConfig, VelocityBin } from '../state.js';

export interface CaptureJob {
  /** Stable id, e.g. "60_v100". */
  captureId: string;
  midi: number;
  /** Expected 12-TET fundamental (Hz) — the gate's reference pitch. */
  freq: number;
  velocity: number;
}

export function enumerateJobs(config: CaptureConfig, bins: VelocityBin[]): CaptureJob[] {
  const jobs: CaptureJob[] = [];
  const stride = Math.max(1, config.semitoneStride | 0);
  const velocities = bins.map(b => b.sampleVel);
  for (let midi = config.lowMidi; midi <= config.highMidi; midi += stride) {
    for (const velocity of velocities) {
      jobs.push({ captureId: `${midi}_v${velocity}`, midi, freq: midiToFreq(midi), velocity });
    }
  }
  return jobs;
}

/** Note count × layer count, for the "this is N captures / ~M minutes" warning. */
export function jobCount(config: CaptureConfig, bins: VelocityBin[]): number {
  const stride = Math.max(1, config.semitoneStride | 0);
  const notes = Math.floor((config.highMidi - config.lowMidi) / stride) + 1;
  return Math.max(0, notes) * bins.length;
}
