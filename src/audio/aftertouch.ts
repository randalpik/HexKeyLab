// Polyphonic aftertouch → per-voice volume, anchored on strike velocity.
//
// Observed Lumatone behavior: aftertouch only starts firing once pressure
// exceeds roughly what the velocity-80 zone represents, and aftertouch 127
// ≈ velocity 127. So we treat aftertouch [0..127] as an "equivalent velocity"
// remap onto [FLOOR..CEIL], then pressureGain = baseVol(eqVel) / baseVol(strikeVel)
// so the voice's effective volume tracks what a matching strike would produce.
// Decaying instruments (piano, harp) ignore aftertouch entirely.
//
// Lumatone PA also has two artifacts at the input layer that filterPA() addresses
// before the value is fed into the gain pipeline:
//   1. Onset oscillation 0↔1 as the sensor flickers around its detection
//      threshold. A hysteresis gate (open above OPEN_THRESH, close below
//      CLOSE_THRESH) drops these to a clean zero.
//   2. Coarse 7-bit MIDI quantization producing audible stair-steps as
//      pressure increases. A time-based EWMA smooths the transitions.

import { audio } from '../state/audio.js';
import type { KeyId } from '../types.js';

export const AFTERTOUCH_VEL_FLOOR = 72;       /* velocity equivalent of aftertouch = 0   */
export const AFTERTOUCH_VEL_CEIL = 127;       /* velocity equivalent of aftertouch = 127 */
/* Per-message exp-ramp duration. Each PA message commits to a ramp of
   this length from the in-flight value toward the new target; successive
   messages cancel and restart from the live in-flight value (via
   inflightExpRampValue), so the actual perceived "speed" of the climb is
   set by this value. 0.5s gives a gentle, audible crescendo from velocity
   volume to the PA region without feeling pre-scheduled (because each
   message redirects the trajectory to track live pressure). */
export const AFTERTOUCH_RAMP_S = 0.250;

/* First-arrival handover grows with |log(target)|, simulating travel from the
   strike point into the aftertouch region. Small target changes get a quick
   handover; extreme ratios (e.g. very soft strike → firm press) get a longer
   ramp so the volume climb feels like a crescendo rather than a jump. */
export const AFTERTOUCH_HANDOVER_BASE_S = 0.075;  /* minimum handover duration */
export const AFTERTOUCH_HANDOVER_SCALE_S = 0.375; /* added time per unit |log(target)| */
export const AFTERTOUCH_HANDOVER_MAX_S = 0.750;   /* cap for extreme ratios */

/* velocity → baseVol, mirroring SampleEngine's internal curve so ratios line up. */
export function velocityBaseVol(v: number): number {
  v = Math.max(1, Math.min(127, v));
  const vn = v / 127;
  return 0.10 + 0.90 * vn * vn;
}

/* target pressureGain multiplier for a given pressure and this voice's strike velocity */
export function aftertouchTargetGain(
  pressure: number,
  strikeVel: number,
): number {
  /* pressure=0 → no PA modulation. Reached when filterPA's hysteresis gate
     has closed (raw < CLOSE_THRESH); gain ramps back to velocity-only volume. */
  if (pressure <= 0) return 1.0;
  const t = Math.max(0, Math.min(127, pressure)) / 127;
  const eqVel =
    AFTERTOUCH_VEL_FLOOR + t * (AFTERTOUCH_VEL_CEIL - AFTERTOUCH_VEL_FLOOR);
  return velocityBaseVol(eqVel) / velocityBaseVol(strikeVel || 100);
}

/* handover duration scales with |log(target)| — pressureGain starts at 1.0 on
   every voice so distance to target equals |log(target/1.0)| = |log(target)|.
   No longer used at runtime — handleAftertouch now uses AFTERTOUCH_RAMP_S
   uniformly so the gain tracks input rather than following a pre-scheduled
   long climb. Kept here so the constants tell the original-design story. */
export function aftertouchHandoverDuration(target: number): number {
  if (target <= 0) return AFTERTOUCH_HANDOVER_BASE_S;
  const dist = Math.abs(Math.log(target));
  return Math.min(
    AFTERTOUCH_HANDOVER_MAX_S,
    AFTERTOUCH_HANDOVER_BASE_S + dist * AFTERTOUCH_HANDOVER_SCALE_S,
  );
}

/* Compute the in-flight value of an exponentialRampToValueAtTime analytically
   from JS-tracked ramp state. Used as a polyfill for cancelAndHoldAtTime
   (unavailable in our Firefox): when a new PA message arrives mid-ramp, we
   anchor at the actual in-flight value rather than reading gain.value (which
   can return the prior fixed anchor on cancel-and-anchor patterns, causing
   audible backward steps). dB-linear curve: gain(t) = start * (target/start)^t. */
export function inflightExpRampValue(rs: import('../types.js').PaRampState, now: number): number {
  if (now <= rs.startTime) return rs.startVal;
  if (now >= rs.endTime) return rs.targetVal;
  const t = (now - rs.startTime) / (rs.endTime - rs.startTime);
  return rs.startVal * Math.pow(rs.targetVal / rs.startVal, t);
}

/* Hysteresis-gate thresholds for filterPA. OPEN must be > CLOSE so the
   sensor's 0/1 onset flicker (raw range typically [0,1]) is rejected
   without false re-triggers when pressure briefly dips during play. */
export const PA_GATE_OPEN_THRESH = 5;
export const PA_GATE_CLOSE_THRESH = 2;

/* Hysteresis gate only — input-level EWMA was tried and produced visible
   lag without meaningfully smoothing the trace, because the discrete
   samples persist at message boundaries either way. The smoothness the
   user perceives is in the AUDIO output, where setTargetAtTime
   interpolates continuously between PA updates regardless of input
   shape. So we leave the input value as-is past the gate and let the
   audio path do the smoothing. */
export function filterPA(key: KeyId, raw: number, ctxTime: number): number {
  const st = audio.paFilter[key];
  const wasOpen = st ? st.open : false;
  if (!wasOpen) {
    if (raw < PA_GATE_OPEN_THRESH) {
      audio.paFilter[key] = { open: false, v: 0, t: ctxTime };
      return 0;
    }
    audio.paFilter[key] = { open: true, v: raw, t: ctxTime };
    return raw;
  }
  if (raw < PA_GATE_CLOSE_THRESH) {
    audio.paFilter[key] = { open: false, v: 0, t: ctxTime };
    return 0;
  }
  audio.paFilter[key] = { open: true, v: raw, t: ctxTime };
  return raw;
}
