// Sequential capture loop: record each job (one note ringing at a time —
// overlap would pollute the recording), store the lossless PCM, run the gates,
// and report progress. Abortable; individual jobs can be re-captured.

import { record } from '../device/recorder.js';
import { putCapture } from './store.js';
import { runGates, type GateResult } from './gates.js';
import type { CaptureDevice } from '../device/types.js';
import type { CaptureJob } from './plan.js';

export interface JobOutcome { job: CaptureJob; gate: GateResult; }

export interface CaptureLoopOpts {
  holdMs?: number;
  /** Silence gap after each note so the room/interface tail settles. */
  gapMs?: number;
  onProgress?: (done: number, total: number, outcome: JobOutcome) => void;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Record + gate one job, storing its PCM. Used by the loop and by re-capture. */
export async function captureOne(device: CaptureDevice, job: CaptureJob, holdMs: number, signal?: AbortSignal): Promise<JobOutcome> {
  device.allNotesOff();
  const rec = await record(device, { note: job.midi, velocity: job.velocity, holdMs, maxSec: 12, signal });
  putCapture(job.captureId, rec);
  return { job, gate: runGates(rec, job.freq) };
}

export async function runCaptureLoop(device: CaptureDevice, jobs: CaptureJob[], opts: CaptureLoopOpts = {}): Promise<JobOutcome[]> {
  const holdMs = opts.holdMs ?? 150;
  const gapMs = opts.gapMs ?? 700;
  const outcomes: JobOutcome[] = [];
  for (let i = 0; i < jobs.length; i++) {
    if (opts.signal?.aborted) { device.allNotesOff(); break; }
    const outcome = await captureOne(device, jobs[i], holdMs, opts.signal);
    outcomes.push(outcome);
    opts.onProgress?.(i + 1, jobs.length, outcome);
    await sleep(gapMs);
  }
  return outcomes;
}
