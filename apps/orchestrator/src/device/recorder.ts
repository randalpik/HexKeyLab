// One capture. Sampling a DECAY instrument means holding the key and recording
// the NATURAL decay (releasing early would engage a damper and truncate it), so
// we hold note-on for the whole capture and send note-off only at the stop. The
// analyzer trims leading silence itself, so we arm first (capturing pre-attack
// silence) and let the downstream trim drop the pre-roll.
//
// Stop conditions (whichever first):
//   • elapsed since note-on ≥ maxSec (default 12 s), OR
//   • after a minimum hold (skips the attack transient), trailing RMS <
//     silenceDbfs (default −60 dBFS) held continuously for silenceHoldMs.
// fixedDuration mode (discovery probes) holds exactly maxSec, then note-off.

import type { CaptureDevice, CaptureRecord } from './types.js';

export interface RecordOptions {
  note: number;
  velocity: number;
  channel?: number;
  /** Minimum hold before the silence early-out can fire (skips the attack). */
  holdMs?: number;
  maxSec?: number;
  silenceDbfs?: number;
  silenceHoldMs?: number;
  prerollMs?: number;
  fixedDuration?: boolean;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function record(device: CaptureDevice, opts: RecordOptions): Promise<CaptureRecord> {
  const channel = opts.channel ?? 0;
  const minHoldMs = opts.holdMs ?? 300;
  const maxSec = opts.maxSec ?? 12;
  const silenceHoldMs = opts.silenceHoldMs ?? 250;
  // ~120 ms pre-roll: captures pre-attack silence AND gives a stable noise-floor
  // estimate (the gates self-measure the floor from this region too).
  const prerollMs = opts.prerollMs ?? 120;
  const POLL_MS = 25;
  // Stop once the decay has faded essentially into the noise floor (1 dB above
  // it) — we want the tail to ring all the way down so it sounds like it's
  // fading to silence, not cut off while still audible. Noise-floor relative
  // (not absolute −60 dBFS) so this holds regardless of the capture level. The
  // residual floor in the captured tail is removed by the noise-reduction step.
  const STOP_MARGIN = Math.pow(10, 1 / 20);
  const STOP_BACKSTOP = Math.pow(10, (opts.silenceDbfs ?? -60) / 20);  // when noise ≈ 0 (loopback)

  if (opts.signal?.aborted) throw new Error('record aborted');

  device.arm();
  await sleep(prerollMs);
  const noiseFloor = device.trailingRms(0.1);   // measured over the armed pre-roll
  const stopThresh = Math.max(noiseFloor * STOP_MARGIN, STOP_BACKSTOP);

  device.noteOn(opts.note, opts.velocity, channel);
  const tOn = performance.now();
  let belowSince = -1;

  try {
    for (;;) {
      await sleep(POLL_MS);
      const elapsedMs = performance.now() - tOn;

      if (opts.signal?.aborted) { device.noteOff(opts.note, channel); throw new Error('record aborted'); }
      if (elapsedMs >= maxSec * 1000) break;
      if (opts.fixedDuration) continue;   // hold the full duration (discovery probe)

      // Hold the key; once past the attack, stop when the natural decay falls
      // to within ~8 dB of the noise floor.
      if (elapsedMs >= minHoldMs) {
        const rms = device.trailingRms(0.05);
        if (rms < stopThresh) {
          if (belowSince < 0) belowSince = performance.now();
          else if (performance.now() - belowSince >= silenceHoldMs) break;
        } else {
          belowSince = -1;
        }
      }
    }
  } finally {
    device.noteOff(opts.note, channel);
  }

  // Let the last few quanta flush from the audio thread before finalizing.
  await sleep(40);
  return device.take();
}
