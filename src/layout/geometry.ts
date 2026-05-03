// @ts-nocheck
// Hex lattice → screen geometry. Tilt angle is computed once from the
// average log-frequency gradient across band seams and 5/7-limit modes:
//   q-axis: log(2)/3 per step (octave constraint over 3-wide bands, not within-band log(5/4))
//   r-axis: midpoint of 5-limit log(3/2) and 7-limit log(3/2)-log(81/80)/6

export const hexR = 16;
export const dxH = hexR * 1.78;
export const dyH = hexR * 1.54;

export const tiltAngle = (function () {
  const avgR = Math.log(3 / 2) - Math.log(81 / 80) / 12;
  const gx = Math.log(2) / (3 * dxH);
  const gy = (avgR - Math.log(2) / 6) / dyH;
  return Math.PI / 2 - Math.atan2(gy, gx);
})();
export const cosT = Math.cos(tiltAngle);
export const sinT = Math.sin(tiltAngle);

/* lattice (q, r) → rotated screen offset from center */
export function hexToScreen(q, r) {
  const x = q * dxH + r * dxH * 0.5;
  const y = r * dyH;
  return { sx: x * cosT - y * sinT, sy: -(x * sinT + y * cosT) };
}
