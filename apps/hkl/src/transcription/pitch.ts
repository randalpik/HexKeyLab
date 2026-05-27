// Color helpers for transcription: darken a lattice hex color for ink-on-paper
// notehead readability. Reuses the codebase's lattice-driven note naming
// elsewhere; spelling itself lives in @hkl/shared. The screen palette (tuned for
// a dark UI) is remapped per-hue here so noteheads read on white paper.

import { keyColorHex } from '../render/colors.js';

/* ── color helpers: darken a hex color for ink-on-paper readability ─────── */

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const cl = (x: number): string => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return '#' + cl(r) + cl(g) + cl(b);
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rN = r / 255, gN = g / 255, bN = b / 255;
  const max = Math.max(rN, gN, bN), min = Math.min(rN, gN, bN);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rN) h = ((gN - bN) / d + (gN < bN ? 6 : 0)) / 6;
  else if (max === gN) h = ((bN - rN) / d + 2) / 6;
  else h = ((rN - gN) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hue2rgb(p, q, h + 1 / 3) * 255,
    hue2rgb(p, q, h) * 255,
    hue2rgb(p, q, h - 1 / 3) * 255,
  ];
}

/* Per-hue profiles for ink-on-white-paper noteheads. The screen palette is
   tuned for a dark UI; on paper the same hues fight each other (pink/orange
   collide, teal/green collide, pure yellow is unreadable). Each profile
   identifies an input hue bucket and maps it to its own (H, S, L) target. */
interface HueProfile { centerDeg: number; H: number; S: number; L: number }
const HUE_PROFILES: HueProfile[] = [
  { centerDeg: 20,  H: 25,  S: 1.00, L: 0.46 }, /* OR — warm orange, brighter */
  { centerDeg: 58,  H: 42,  S: 0.85, L: 0.40 }, /* YE — goldenrod */
  { centerDeg: 117, H: 95,  S: 0.90, L: 0.38 }, /* GR — shifted toward yellow-green */
  { centerDeg: 157, H: 178, S: 0.95, L: 0.40 }, /* TE — shifted toward cyan */
  { centerDeg: 215, H: 215, S: 0.95, L: 0.42 }, /* BL — unchanged */
  { centerDeg: 282, H: 282, S: 0.95, L: 0.42 }, /* PU — unchanged */
  { centerDeg: 344, H: 333, S: 0.95, L: 0.50 }, /* PK — pinker, brighter */
];

function profileForHue(h01: number): HueProfile {
  const deg = h01 * 360;
  let best = HUE_PROFILES[0];
  let bestDist = 360;
  for (const p of HUE_PROFILES) {
    let d = Math.abs(deg - p.centerDeg);
    if (d > 180) d = 360 - d;
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

/** Lattice color, remapped per-hue for ink-on-white-paper readability. */
export function darkColorHex(q: number, r: number): string {
  const hex = keyColorHex(q, r);
  const [r0, g0, b0] = hexToRgb(hex);
  const [h] = rgbToHsl(r0, g0, b0);
  const p = profileForHue(h);
  const [r1, g1, b1] = hslToRgb(p.H / 360, p.S, p.L);
  return rgbToHex(r1, g1, b1);
}
