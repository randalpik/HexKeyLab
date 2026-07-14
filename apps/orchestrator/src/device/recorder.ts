// One capture. Sampling a DECAY instrument means holding the key and recording
// the NATURAL decay (releasing early would engage a damper and truncate it), so
// we hold note-on for the whole capture and send note-off only at the stop. The
// analyzer trims leading silence itself, so we arm first (capturing pre-attack
// silence) and let the downstream trim drop the pre-roll.
//
// Stop conditions (whichever first):
//   • elapsed since note-on ≥ maxSec (default 12 s), OR
//   • after a minimum hold (skips the attack transient), the trailing RMS stays
//     below the stop floor for silenceHoldMs. The stop floor is the MAX of the
//     measured noise floor (+1 dB), a peak-relative decay floor (note peak −70 dB),
//     and a low absolute backstop — so the tail rings all the way down to the
//     capture's real floor regardless of level, instead of a fixed −60 dBFS that
//     truncated quiet notes (see the stop-threshold comment below).
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
  // Stop threshold is the MAX of three floors, so the decay rings all the way
  // down but we never record pure noise or over-record a clean tail:
  //   • noise-floor relative — 1 dB above the measured pre-roll floor, so we stop
  //     right where the note sinks into the capture's actual floor;
  //   • peak relative — DECAY_RANGE_DB below the note's own peak, a bounded,
  //     level-independent natural decay (governs when the floor is very low, e.g.
  //     the loopback, so we don't chase noise forever);
  //   • a low absolute backstop for a truly silent floor.
  // The previous −60 dBFS backstop was the bug: it sits ABOVE a real clean
  // capture's floor, so it overrode the noise-floor-relative stop and truncated
  // quiet notes at −60 dBFS raw — which, once boosted ~40 dB at playback for a
  // soft high note, is still clearly audible (a −60 raw cut plays at ~−20 dBFS).
  // Residual floor in the captured tail is removed by the noise-reduction step.
  const STOP_MARGIN = Math.pow(10, 1 / 20);            // +1 dB over the noise floor
  const DECAY_RANGE_DB = 70;                            // note peak → this far down = "faded"
  const DECAY_FLOOR = Math.pow(10, -DECAY_RANGE_DB / 20);
  const STOP_BACKSTOP = Math.pow(10, (opts.silenceDbfs ?? -90) / 20);  // near-zero floor (loopback)

  if (opts.signal?.aborted) throw new Error('record aborted');

  device.arm();
  await sleep(prerollMs);
  const noiseFloor = device.trailingRms(0.1);   // measured over the armed pre-roll
  const noiseStop = noiseFloor * STOP_MARGIN;

  device.noteOn(opts.note, opts.velocity, channel);
  const tOn = performance.now();
  let belowSince = -1;
  let notePeak = 0;   // running peak of the trailing RMS (the note's attack level)

  try {
    for (;;) {
      await sleep(POLL_MS);
      const elapsedMs = performance.now() - tOn;

      if (opts.signal?.aborted) { device.noteOff(opts.note, channel); throw new Error('record aborted'); }
      if (elapsedMs >= maxSec * 1000) break;
      if (opts.fixedDuration) continue;   // hold the full duration (discovery probe)

      // Track the note's peak (attack) every poll so the peak-relative floor is
      // established before the decay stop can fire.
      const rms = device.trailingRms(0.05);
      if (rms > notePeak) notePeak = rms;

      // Hold the key; once past the attack, stop when the decay reaches the
      // highest of the three floors (noise-relative / peak-relative / backstop).
      if (elapsedMs >= minHoldMs) {
        const stopThresh = Math.max(noiseStop, notePeak * DECAY_FLOOR, STOP_BACKSTOP);
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

/** Record `sec` seconds of IDLE output — device on, no note played — for whine
 *  calibration. No note-on/off; just arm, wait, take. The result's steady tonal
 *  content is the device's ever-present artifact comb (see analysis/dewhine). */
export async function recordIdle(device: CaptureDevice, sec: number, signal?: AbortSignal): Promise<CaptureRecord> {
  if (signal?.aborted) throw new Error('record aborted');
  device.allNotesOff();
  device.arm();
  const tStart = performance.now();
  while (performance.now() - tStart < sec * 1000) {
    if (signal?.aborted) throw new Error('record aborted');
    await sleep(50);
  }
  await sleep(40);   // flush trailing quanta
  return device.take();
}
