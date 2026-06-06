// Hex lattice → screen geometry. The tilt angle is selectable at runtime via
// setRotation():
//   verticalFreq — average log-frequency gradient is screen-vertical
//                  (q-axis: log(2)/3 per step; r-axis: midpoint of 5-limit
//                  log(3/2) and 7-limit log(3/2)-log(81/80)/6)
//   lumatone     — (+7q, -2r) direction is screen-horizontal (Lumatone case row)
//   piano        — q-axis is screen-horizontal (octaves tile left-to-right)
//
// tiltAngle/cosT/sinT are `let` exports; ES module live bindings propagate
// updates to every importer without re-importing.

import type { HexSize, RotationMode } from '../state/persistence.js';

/* Hex inradius (px) and derived axis pitches. `let` exports: setHexSize()
   reassigns them and ES module live bindings propagate to every importer.
   The tilt block below uses dxH/dyH only as ratios, so it's scale-invariant
   and is NOT recomputed on a size change. */
export let hexR = 16;
export let dxH = hexR * 1.78;
export let dyH = hexR * 1.54;
/** Stroke/dash scale factor = hexR / 16 (the medium baseline). Multiply
 *  hardcoded canvas line widths and dash lengths by this so they stay
 *  visually balanced at every preset. */
export let hexScale = 1;

const HEX_PX: Record<HexSize, number> = { small: 12, medium: 16, large: 24 };

/** Apply a hex-size preset: reassign inradius, axis pitches, and the stroke
 *  scale factor. Callers must then rebuild scale-dependent caches
 *  (render/draw.ts rebuildScaleGeometry) + recompute canvas bounds + redraw. */
export function setHexSize(size: HexSize): void {
  hexR = HEX_PX[size];
  dxH = hexR * 1.78;
  dyH = hexR * 1.54;
  hexScale = hexR / 16;
}

const TILT_VERTICAL_FREQ = (function (): number {
  const avgR = Math.log(3 / 2) - Math.log(81 / 80) / 12;
  const gx = Math.log(2) / (3 * dxH);
  const gy = (avgR - Math.log(2) / 6) / dyH;
  return Math.PI / 2 - Math.atan2(gy, gx);
})();
const TILT_LUMATONE = Math.atan(dyH / (3 * dxH));
const TILT_PIANO = 0;

export let tiltAngle = TILT_VERTICAL_FREQ;
export let cosT = Math.cos(tiltAngle);
export let sinT = Math.sin(tiltAngle);
/** Currently-active rotation mode. Live-binding so canvas-bounds lookups
 *  (which can't be derived from tilt alone if two modes coincidentally
 *  share a tilt value) read the canonical name. */
export let currentRotationMode: RotationMode = 'verticalFreq';

export function setRotation(mode: RotationMode): void {
  currentRotationMode = mode;
  switch (mode) {
    case 'lumatone': tiltAngle = TILT_LUMATONE; break;
    case 'piano': tiltAngle = TILT_PIANO; break;
    default: tiltAngle = TILT_VERTICAL_FREQ;
  }
  cosT = Math.cos(tiltAngle);
  sinT = Math.sin(tiltAngle);
}

export interface ScreenPoint {
  /** screen-space x relative to view center */
  sx: number;
  /** screen-space y (inverted: positive is up before tilt rotation) */
  sy: number;
}

/** lattice (q, r) → rotated screen offset from center */
export function hexToScreen(q: number, r: number): ScreenPoint {
  const x = q * dxH + r * dxH * 0.5;
  const y = r * dyH;
  return { sx: x * cosT - y * sinT, sy: -(x * sinT + y * cosT) };
}
