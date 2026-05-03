// @ts-nocheck
// Polyphonic aftertouch → per-voice volume, anchored on strike velocity.
//
// Observed Lumatone behavior: aftertouch only starts firing once pressure
// exceeds roughly what the velocity-80 zone represents, and aftertouch 127
// ≈ velocity 127. So we treat aftertouch [0..127] as an "equivalent velocity"
// remap onto [FLOOR..CEIL], then pressureGain = baseVol(eqVel) / baseVol(strikeVel)
// so the voice's effective volume tracks what a matching strike would produce.
// Decaying instruments (piano, harp) ignore aftertouch entirely.

export const AFTERTOUCH_VEL_FLOOR = 72;       /* velocity equivalent of aftertouch = 0   */
export const AFTERTOUCH_VEL_CEIL = 127;       /* velocity equivalent of aftertouch = 127 */
export const AFTERTOUCH_RAMP_S = 0.020;       /* per-message smoothing (zipper noise) */

/* First-arrival handover grows with |log(target)|, simulating travel from the
   strike point into the aftertouch region. Small target changes get a quick
   handover; extreme ratios (e.g. very soft strike → firm press) get a longer
   ramp so the volume climb feels like a crescendo rather than a jump. */
export const AFTERTOUCH_HANDOVER_BASE_S = 0.075;  /* minimum handover duration */
export const AFTERTOUCH_HANDOVER_SCALE_S = 0.375; /* added time per unit |log(target)| */
export const AFTERTOUCH_HANDOVER_MAX_S = 0.750;   /* cap for extreme ratios */

/* velocity → baseVol, mirroring SampleEngine's internal curve so ratios line up. */
export function velocityBaseVol(v) {
  v = Math.max(1, Math.min(127, v));
  const vn = v / 127;
  return 0.10 + 0.90 * vn * vn;
}

/* target pressureGain multiplier for a given pressure and this voice's strike velocity */
export function aftertouchTargetGain(pressure, strikeVel) {
  const t = Math.max(0, Math.min(127, pressure)) / 127;
  const eqVel = AFTERTOUCH_VEL_FLOOR + t * (AFTERTOUCH_VEL_CEIL - AFTERTOUCH_VEL_FLOOR);
  return velocityBaseVol(eqVel) / velocityBaseVol(strikeVel || 100);
}

/* handover duration scales with |log(target)| — pressureGain starts at 1.0 on
   every voice so distance to target equals |log(target/1.0)| = |log(target)|. */
export function aftertouchHandoverDuration(target) {
  if (target <= 0) return AFTERTOUCH_HANDOVER_BASE_S;
  const dist = Math.abs(Math.log(target));
  return Math.min(
    AFTERTOUCH_HANDOVER_MAX_S,
    AFTERTOUCH_HANDOVER_BASE_S + dist * AFTERTOUCH_HANDOVER_SCALE_S,
  );
}
