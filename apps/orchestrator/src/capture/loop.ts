// Sequential capture loop: record each job (one note ringing at a time —
// overlap would pollute the recording), store the lossless PCM, run the gates +
// normalization assessment, and report progress. Abortable; individual jobs can
// be re-captured.
//
// Auto-retry-once: a take is re-recorded a single time when it comes out
// "yellow" — a failed gate, a post-gain noise floor over the skip threshold (its
// boosted hiss would be audible), OR a local gain OUTLIER (abnormally quiet
// take: gain far above its same-velocity neighbours, usually a soft/mis-struck
// strike a fresh take fixes). The cleaner of the two takes is kept. Layers that
// are still too noisy after retry are dropped at export (buildHki), not here.

import { record } from '../device/recorder.js';
import { putCapture } from './store.js';
import { runGates, type GateResult } from './gates.js';
import { assessRaw, POSTGAIN_NOISE_SKIP_DB } from '../analysis/clean.js';
import type { CaptureDevice, CaptureRecord } from '../device/types.js';
import type { CaptureJob } from './plan.js';

export interface JobOutcome {
  job: CaptureJob;
  gate: GateResult;
  /** Flat-normalization gain (post-cleaning). */
  gain?: number;
  /** Post-gain noise floor, dBFS — the skip/retry predictor. */
  postGainNoiseDb?: number;
  /** Predicted to be dropped at export (post-gain noise over threshold). */
  willSkip?: boolean;
  /** Auto-retried once during the loop. */
  retried?: boolean;
}

export interface CaptureLoopOpts {
  holdMs?: number;
  /** Silence gap after each note so the room/interface tail settles. */
  gapMs?: number;
  /** Device whine profile — notched out before the noise assessment. */
  whineToneHz?: number[];
  onProgress?: (done: number, total: number, outcome: JobOutcome) => void;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Local-outlier detection: a take is an outlier when its gain exceeds
// OUTLIER_RATIO × the median of the last OUTLIER_WINDOW same-velocity gains
// (needs ≥ OUTLIER_MIN samples for a stable baseline). Same-velocity gains trend
// smoothly with pitch, so a genuine spike stands out without flagging the whole
// (legitimately quiet) top register.
const OUTLIER_RATIO = 1.6;
const OUTLIER_WINDOW = 4;
const OUTLIER_MIN = 3;

interface Take { rec: CaptureRecord; gate: GateResult; gain: number; postGainNoiseDb: number; }

async function captureTake(device: CaptureDevice, job: CaptureJob, holdMs: number, whineToneHz: number[], signal?: AbortSignal): Promise<Take> {
  device.allNotesOff();
  const rec = await record(device, { note: job.midi, velocity: job.velocity, holdMs, maxSec: 12, signal });
  const gate = runGates(rec, job.freq);
  const { gain, postGainNoiseDb } = assessRaw(rec.channels, rec.sampleRate, whineToneHz);
  return { rec, gate, gain, postGainNoiseDb };
}

/** Prefer a non-clipped take; among equals, the cleaner one (lower post-gain
 *  noise floor = higher signal / lower boosted hiss). */
function betterTake(a: Take, b: Take): Take {
  const aClip = a.gate.flags.includes('clip'), bClip = b.gate.flags.includes('clip');
  if (aClip !== bClip) return aClip ? b : a;
  return a.postGainNoiseDb <= b.postGainNoiseDb ? a : b;
}

function outcomeOf(job: CaptureJob, take: Take, retried: boolean): JobOutcome {
  return {
    job, gate: take.gate, gain: take.gain, postGainNoiseDb: take.postGainNoiseDb,
    willSkip: take.postGainNoiseDb > POSTGAIN_NOISE_SKIP_DB, retried,
  };
}

/** Record + gate + assess one job, storing its PCM (no retry). Used by UI
 *  single re-capture. */
export async function captureOne(device: CaptureDevice, job: CaptureJob, holdMs: number, whineToneHz: number[] = [], signal?: AbortSignal): Promise<JobOutcome> {
  const take = await captureTake(device, job, holdMs, whineToneHz, signal);
  putCapture(job.captureId, take.rec);
  return outcomeOf(job, take, false);
}

export async function runCaptureLoop(device: CaptureDevice, jobs: CaptureJob[], opts: CaptureLoopOpts = {}): Promise<JobOutcome[]> {
  const holdMs = opts.holdMs ?? 150;
  const gapMs = opts.gapMs ?? 700;
  const whineToneHz = opts.whineToneHz ?? [];
  const outcomes: JobOutcome[] = [];
  const recentGains = new Map<number, number[]>();   // per-velocity local baseline

  for (let i = 0; i < jobs.length; i++) {
    if (opts.signal?.aborted) { device.allNotesOff(); break; }
    const job = jobs[i];
    let take = await captureTake(device, job, holdMs, whineToneHz, opts.signal);

    const win = recentGains.get(job.velocity) ?? [];
    const median = win.length >= OUTLIER_MIN ? [...win].sort((a, b) => a - b)[win.length >> 1] : null;
    const outlier = median != null && take.gain > OUTLIER_RATIO * median;
    const yellow = !take.gate.pass || take.postGainNoiseDb > POSTGAIN_NOISE_SKIP_DB || outlier;

    let retried = false;
    if (yellow && !opts.signal?.aborted) {
      await sleep(gapMs);
      take = betterTake(take, await captureTake(device, job, holdMs, whineToneHz, opts.signal));
      retried = true;
    }
    putCapture(job.captureId, take.rec);

    const w = recentGains.get(job.velocity) ?? [];
    w.push(take.gain);
    if (w.length > OUTLIER_WINDOW) w.shift();
    recentGains.set(job.velocity, w);

    const outcome = outcomeOf(job, take, retried);
    outcomes.push(outcome);
    opts.onProgress?.(i + 1, jobs.length, outcome);
    await sleep(gapMs);
  }
  return outcomes;
}
