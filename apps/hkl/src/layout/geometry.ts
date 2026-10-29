// Hex lattice → screen geometry. The tilt angle is selectable at runtime via
// setRotation():
//   verticalFreq — average log-frequency gradient is screen-vertical
//                  (q-axis: log(2)·COLUMN_STEP/12 per step — log(2)/3 Euler,
//                  /6 Wicki-Hayden, /12 chromatic; r-axis: midpoint of 5-limit
//                  log(3/2) and 7-limit log(3/2)-log(81/80)/6)
//   lumatone     — the Lumatone case row (the (+7, −2) board step, posed by the
//                  alignment) is screen-horizontal
//   piano        — q-axis is screen-horizontal (octaves tile left-to-right)
//
// Vertical Freq and Piano are properties of the lattice, so they pin it: under
// a non-vertical alignment the outline turns instead. Lumatone is a property of
// the instrument, so it pins the outline and the lattice turns.
//
// tiltAngle/cosT/sinT are `let` exports; ES module live bindings propagate
// updates to every importer without re-importing.

import type { Alignment, HexSize, Mapping, RotationMode } from '../state/persistence.js';
import { COLUMN_STEP } from '@hkl/shared/mapping.js';
import { poseOffset } from './physical.js';

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

/* `qStep` = average log-frequency per q step. The r-axis gradient subtracts
   half of it because each row is offset half a column. */
function verticalFreqTilt(qStep: number): number {
  const avgR = Math.log(3 / 2) - Math.log(81 / 80) / 12;
  const gx = qStep / dxH;
  const gy = (avgR - qStep / 2) / dyH;
  return Math.PI / 2 - Math.atan2(gy, gx);
}
const TILT_VERTICAL_FREQ = verticalFreqTilt(Math.log(2) / 3);
/* The tilt that levels the Lumatone case row — the (+7, −2) board step as the
   alignment poses it — computed from that vector's own pixel direction, so it
   is exact although dxH:dyH is not a regular hexagon's 2:√3. x > 0 in every
   pose, so atan(y/x) is the angle (and reproduces atan(dyH / 3dxH) bit for bit
   in the vertical pose). */
function caseLevelTilt(pose: Alignment): number {
  const [q, r] = poseOffset(pose, 7, -2);
  return -Math.atan((r * dyH) / ((q + r * 0.5) * dxH));
}
const TILT_PIANO = 0;

export let tiltAngle = TILT_VERTICAL_FREQ;
export let cosT = Math.cos(tiltAngle);
export let sinT = Math.sin(tiltAngle);
/** Currently-active rotation mode. Live-binding so canvas-bounds lookups
 *  (which can't be derived from tilt alone if two modes coincidentally
 *  share a tilt value) read the canonical name. */
export let currentRotationMode: RotationMode = 'verticalFreq';

/** `pose`: the visible outline's pose (layout/physical.ts outlinePose), read
 *  only by the Lumatone rotation. */
export function setRotation(mode: RotationMode, mapping: Mapping, pose: Alignment): void {
  currentRotationMode = mode;
  switch (mode) {
    case 'lumatone': tiltAngle = caseLevelTilt(pose); break;
    case 'piano': tiltAngle = TILT_PIANO; break;
    default: tiltAngle = verticalFreqTilt(Math.log(2) * COLUMN_STEP[mapping] / 12);
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
