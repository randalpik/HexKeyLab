// Quality gates for a captured sample. The level/duration gates are NOISE-FLOOR
// RELATIVE, not absolute dBFS: the capture chain may be padded down (e.g. a
// cable's lo switch) and every sample is later normalized to a fixed target, so
// SNR (signal vs the measured noise floor) and decay-relative-to-peak are the
// quantities that survive normalization — absolute thresholds mis-fire.
//
// Flags (failure):
//   • quiet — SNR (peak − noise floor) below QUIET_SNR_DB (too close to the
//             floor to stay clean after normalization)
//   • clip  — any sample ≥ −0.1 dBFS (overdrive; this one IS absolute)
//   • short — audible-above-noise length below SHORT_SEC (missed/dead note;
//             a fast-decaying high note still clears this if its attack is real)
// Cents deviation is also measured but is INFORMATIONAL ONLY (never fails a
// sample): we trust the claimed MIDI→12-TET pitch (see buildHki), which a digital
// instrument holds more accurately than period-detection.
//
// The noise floor is measured from the pre-attack silence the recorder always
// captures (its ~120 ms pre-roll). A clean sample has no flags.

import { buildMonoDownmix, HKLAnalysis } from '../analysis/shim.js';
import type { CaptureRecord } from '../device/types.js';

export interface GateResult {
  pass: boolean;
  flags: string[];
  peakDb: number;
  noiseFloorDb: number;
  snrDb: number;
  durSec: number;
  driftCents: number | null;
}

const QUIET_SNR_DB = 12;                          // peak must clear the floor by this
// (12 dB, not 24: the noise-reduction step recovers ~15–20 dB of effective SNR,
//  so a sample that's only modestly above the floor is still usable post-denoise.)
const SHORT_SEC = 0.12;                           // audible length below this = a miss
const CLIP_LINEAR = Math.pow(10, -0.1 / 20);      // ≈ 0.989 (absolute)
const AUDIBLE_MARGIN = Math.pow(10, 8 / 20);      // "audible" = 8 dB above the noise floor
const AUDIBLE_BACKSTOP = 1e-4;                    // absolute floor when noise ≈ 0 (loopback)
const NOISE_WIN_SEC = 0.08;                       // pre-attack window for the noise estimate

function lastAbove(s: Float32Array, thresh: number): number {
  for (let i = s.length - 1; i >= 0; i--) if (Math.abs(s[i]) > thresh) return i;
  return -1;
}
function firstAbove(s: Float32Array, thresh: number): number {
  for (let i = 0; i < s.length; i++) if (Math.abs(s[i]) > thresh) return i;
  return -1;
}
function rmsOver(s: Float32Array, start: number, end: number): number {
  const n = Math.max(0, end - start);
  if (!n) return 0;
  let sq = 0;
  for (let i = start; i < end; i++) sq += s[i] * s[i];
  return Math.sqrt(sq / n);
}

export function runGates(rec: CaptureRecord, expectedFreq: number): GateResult {
  const sr = rec.sampleRate;
  const mono = buildMonoDownmix(rec.channels);
  const flags: string[] = [];

  // Peak + clip over the full capture.
  let peak = 0;
  for (let i = 0; i < mono.length; i++) { const a = Math.abs(mono[i]); if (a > peak) peak = a; }
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -120;

  // Noise floor from the pre-attack silence (the recorder's pre-roll). Assumes
  // the buffer opens with silence before note-on, which the recorder guarantees.
  const noiseWin = Math.min(Math.round(NOISE_WIN_SEC * sr), Math.floor(mono.length * 0.2));
  const noiseFloor = noiseWin > 0 ? rmsOver(mono, 0, noiseWin) : 0;
  const noiseFloorDb = noiseFloor > 0 ? 20 * Math.log10(noiseFloor) : -120;
  const snrDb = peakDb - noiseFloorDb;

  // Audible region = above the noise floor (+margin). Length judges "real note
  // vs miss"; it's relative so a padded-but-clean note isn't seen as silent.
  const audibleThresh = Math.max(noiseFloor * AUDIBLE_MARGIN, AUDIBLE_BACKSTOP);
  const onset = Math.max(0, firstAbove(mono, audibleThresh));
  const audibleEnd = lastAbove(mono, audibleThresh);
  const durSec = audibleEnd > onset ? (audibleEnd - onset) / sr : 0;

  if (peak >= CLIP_LINEAR) flags.push('clip');
  if (snrDb < QUIET_SNR_DB) flags.push('quiet');
  if (durSec < SHORT_SEC) flags.push('short');

  // Pitch is INFORMATIONAL ONLY — never a failure. We trust the claimed
  // MIDI→12-TET pitch for the stored sample frequency (a digital instrument holds
  // equal temperament more accurately than period-detection, which is biased
  // sharp by piano inharmonicity and noisy at low SNR — see buildHki). We still
  // measure the cents deviation here so the user can eyeball it in the capture
  // table, but it neither rejects a sample nor sets its stored pitch. Missed/dead
  // notes are caught by the quiet/short gates.
  let driftCents: number | null = null;
  const steadyStart = onset;
  const steadyEnd = Math.min(onset + Math.round(0.4 * sr), mono.length);
  const period = HKLAnalysis.refineFundamentalPeriod(mono, sr, expectedFreq, steadyStart, steadyEnd, {
    tRefineRange: 0.06, minPeakRatio: 0.5,
  });
  if (period != null && period > 0) driftCents = 1200 * Math.log2((1 / period) / expectedFreq);

  return {
    pass: flags.length === 0,
    flags,
    peakDb: Number(peakDb.toFixed(1)),
    noiseFloorDb: Number(noiseFloorDb.toFixed(1)),
    snrDb: Number(snrDb.toFixed(1)),
    durSec: Number(durSec.toFixed(2)),
    driftCents: driftCents == null ? null : Number(driftCents.toFixed(1)),
  };
}

/** UI tier for a gate result: green pass, yellow recoverable, red hard-fail. */
export function gateTier(g: GateResult): 'green' | 'yellow' | 'red' {
  if (g.pass) return 'green';
  if (g.flags.includes('clip')) return 'red';   // overdriven — unrecoverable
  return 'yellow';   // quiet / short — recoverable by adjusting input gain / re-capturing
}
