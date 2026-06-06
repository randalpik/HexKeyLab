// Polyphonic aftertouch → per-voice volume, anchored on strike velocity.
//
// Model — "strike → ceiling, continuous dB swell": aftertouch swells the voice
// upward from its strike volume to a common loudness ceiling that sits a fixed
// headroom ABOVE the loudest possible strike (v127). The swell is dB-linear in
// pressure, so the multiplier is
//   pressureGain = (ceilGain / strikeGain) ^ (pressure/127)
// where ceilGain = baseVol(127) · 10^(HEADROOM_DB/20) and strikeGain =
// baseVol(strikeVel). Properties:
//   • pressure 0 → gain exactly 1.0 (continuous with the strike — no jump when
//     the hysteresis gate opens);
//   • full press → the common ceiling regardless of how hard the note was
//     struck, so EVERY strike — including a full-velocity one — swells. A v127
//     strike gains exactly HEADROOM_DB; softer strikes gain more (they start
//     lower but converge to the same ceiling). This is the headroom needed for
//     voicing — pressing a chord tone well above the others.
//   • dB-linear in pressure → a perceptually even crescendo.
// The ceiling exceeds v127's gain (which the master limiter, threshold −3 dBFS
// ratio 20, keeps from clipping). This supersedes the old fixed-floor remap
// onto [72..127] (pre-calibration "aftertouch starts at the velocity-80 zone")
// and its successor that capped the swell at v127 — both cramped expression now
// that onsets are calibrated and the post-onset pressure range is wide.
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
import { velocityCal } from './velocityCal.js';
import type { KeyId } from '../types.js';

/* Velocity whose gain anchors the swell ceiling (the loudest possible strike). */
export const AFTERTOUCH_VEL_CEIL = 127;
/* Headroom of the full-press ceiling ABOVE that v127 gain, in dB. A v127 strike
   swells by exactly this; softer strikes swell more (converging to the same
   ceiling). Sized for voicing headroom and to land near the −3 dBFS limiter at
   full press; the limiter (ratio 20) prevents any clipping past it. Re-tune by
   ear; a slider for this is a deferred lumadiag tunable. */
export const AFTERTOUCH_CEIL_HEADROOM_DB = 12;
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

/* velocity → baseVol, via the user-configurable velocityCal curve. Default
   parameters (floor 0.10, ceiling 1.0, gamma 2.0) reproduce the prior hardcoded
   quadratic 0.10 + 0.90·(v/127)² exactly. */
export function velocityBaseVol(v: number): number {
  return velocityCal.curveGain(v);
}

/* target pressureGain multiplier for a given pressure and this voice's strike
   velocity. dB-linear swell from the strike volume (pressure 0 → 1.0) to the
   common ceiling baseVol(127)·10^(HEADROOM_DB/20) at full press. The ratio
   (ceilGain/strikeGain) ≥ 1 always, so the swell is monotonic upward; a v127
   strike reaches exactly +HEADROOM_DB, softer strikes more. */
export function aftertouchTargetGain(
  pressure: number,
  strikeVel: number,
): number {
  /* pressure=0 → no PA modulation. Reached when filterPA's hysteresis gate
     has closed (raw < CLOSE_THRESH); gain ramps back to velocity-only volume. */
  if (pressure <= 0) return 1.0;
  const sv = strikeVel || 100;
  const t = Math.max(0, Math.min(127, pressure)) / 127;
  const strikeGain = velocityBaseVol(sv);
  if (strikeGain <= 0) return 1.0;
  const ceilGain = velocityBaseVol(AFTERTOUCH_VEL_CEIL) * Math.pow(10, AFTERTOUCH_CEIL_HEADROOM_DB / 20);
  return Math.pow(ceilGain / strikeGain, t);  /* dB-linear in pressure */
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
