// House velocity curve — the device-independent musical-velocity → linear-gain
// mapping: `floor + (ceiling − floor)·(v/127)^gamma`. Single source of truth for
//   - HKL playback (apps/hkl velocityCal DEFAULT_CAL wraps this, adding the
//     per-device input curve + per-key trims on top), and
//   - the orchestrator's per-layer perceptual-gain normalization, which softens
//     a velocity-layered instrument's brighter layers by comparing the device's
//     MEASURED velocity→loudness (the discovery sweep) against THIS curve and
//     baking the residual into each layer's gain. Keeping one definition means
//     the baked gains and playback always assume the same curve.
//
// Pure math, no state — belongs in @hkl/shared.

export interface VelocityCurve {
  /** Linear gain at velocity 1 (smallest non-zero). */
  floor: number;
  /** Linear gain at velocity 127. */
  ceiling: number;
  /** Curve exponent (≈1.5 = gentle, synth-like). */
  gamma: number;
}

/** The proven house curve: floor 0.05, ceiling 1.0, gamma 1.5. */
export const HOUSE_VELOCITY_CURVE: VelocityCurve = { floor: 0.05, ceiling: 1.0, gamma: 1.5 };

/** Linear gain for musical velocity `v` (0..127) under `curve` (default house).
 *  v ≤ 0 → 0 (note-off). */
export function velocityCurveGain(v: number, curve: VelocityCurve = HOUSE_VELOCITY_CURVE): number {
  if (v <= 0) return 0;
  const vn = (v >= 127 ? 127 : v) / 127;
  return curve.floor + (curve.ceiling - curve.floor) * Math.pow(vn, curve.gamma);
}
