// Lattice color palette — pure data tables. Shared between HKL (lattice
// rendering, MIDI feedback, screen readback) and HKC (notehead colors via
// data-q/data-r → resolved color through the bridge). No runtime state, no
// tuning dependency — stateful color computation (computeHue, keyColorHex)
// lives in src/render/colors.ts and reads tuning state.
//
// The septimal-variant fields (`sl`/`sd`) are populated by the load-time IIFE
// at the bottom of this file by linear-interpolating each hue toward the next
// in the warm direction (PK→PU→BL→TE→GR→YE→OR→PK). They start undefined and
// become fully populated before any consumer reads them.

export type Hue = 'PK' | 'PU' | 'BL' | 'TE' | 'GR' | 'YE' | 'OR';

export interface HueColors {
  /** light variant — natural pitch class */
  l: string;
  /** dark variant — accidental pitch class */
  d: string;
  /** septimal-light (B-band) variant — set by load-time IIFE */
  sl?: string;
  /** septimal-dark (B-band) variant — set by load-time IIFE */
  sd?: string;
}

/* No `colorTable` cache — `computeHue(q, r)` in src/render/colors.ts is
   invariant under (q→q+3) and (r→r+12), so it depends only on (qmod3, r%12)
   and is the single source of base hue. */

export const hueC: Record<Hue, HueColors> = {
  PK: { l: '#FF4C79', d: '#59002C' },
  PU: { l: '#C94CFF', d: '#3E0059' },
  BL: { l: '#4C96FF', d: '#002559' },
  TE: { l: '#4CFFBA', d: '#005937' },
  GR: { l: '#55FF4C', d: '#045900' },
  YE: { l: '#FFF94C', d: '#595600' },
  OR: { l: '#FF884C', d: '#591D00' },
};

/* septimal hue variants: each hue shifted 1/2 toward the next in cycle (warm direction) */
export const hueCycle: ReadonlyArray<Hue> = ['PK', 'PU', 'BL', 'TE', 'GR', 'YE', 'OR'];

(function () {
  function lerpHex(a: string, b: string, t: number): string {
    const ar = parseInt(a.slice(1, 3), 16), ag = parseInt(a.slice(3, 5), 16), ab = parseInt(a.slice(5, 7), 16);
    const br = parseInt(b.slice(1, 3), 16), bg = parseInt(b.slice(3, 5), 16), bb = parseInt(b.slice(5, 7), 16);
    const rr = Math.round(ar + (br - ar) * t), rg = Math.round(ag + (bg - ag) * t), rb = Math.round(ab + (bb - ab) * t);
    return '#' + ((1 << 24) + (rr << 16) + (rg << 8) + rb).toString(16).slice(1);
  }
  for (let i = 0; i < hueCycle.length; i++) {
    const cur = hueCycle[i], nxt = hueCycle[(i + 1) % hueCycle.length];
    hueC[cur].sl = lerpHex(hueC[cur].l, hueC[nxt].l, 1 / 2);
    hueC[cur].sd = lerpHex(hueC[cur].d, hueC[nxt].d, 1 / 2);
  }
})();

export const whiteSet: ReadonlySet<number> = new Set([0, 2, 4, 5, 7, 9, 11]);

/* hueCycle walked backward, starting at the A3 hue (PU). Used as the index
   space for octave-based coloring and SC redirects in computeHue. */
export const hueCycleOrder: ReadonlyArray<Hue> = (() => {
  const start = hueCycle.indexOf('PU');
  return Array.from({ length: 7 }, (_, i) => hueCycle[((start - i) % 7 + 7) % 7]);
})();
export const hueIdx: Record<Hue, number> = {} as Record<Hue, number>;
for (let hi = 0; hi < 7; hi++) hueIdx[hueCycleOrder[hi]] = hi;

/* 3-hue octave cycle for Equal mode (A3=PU) */
export const equalHueCycle: ReadonlyArray<Hue> = ['BL', 'PU', 'PK'];

/* ── ink-on-paper hue profiles + sanctioned reverse-map ────────────────────
   Notehead colors on white paper (light theme) are computed by darkColorHex
   (apps/hkl): remap the lattice hue to one of these 7 per-hue (H,S,L) targets.
   So the set of sanctioned INK colors is exactly {hslToRgb(profile)} — 7 fixed
   hexes. On a DARK surface noteheads instead use the bright light-source hue
   (hueC.l / .sl). When a file is imported WITHOUT the baked light variant we
   reverse-map its ink color to the sanctioned light color via these tables; an
   unrecognized color isn't approximated (the renderer flags it white/black so a
   bad import is obvious). darkColorHex shares these helpers + profiles so its
   outputs match the map keys exactly. */

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const cl = (x: number): string => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return '#' + cl(r) + cl(g) + cl(b);
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
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

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
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
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

export interface HueProfile { centerDeg: number; H: number; S: number; L: number; hue: Hue }
export const HUE_PROFILES: ReadonlyArray<HueProfile> = [
  { centerDeg: 20,  H: 25,  S: 1.00, L: 0.46, hue: 'OR' }, /* warm orange, brighter */
  { centerDeg: 58,  H: 42,  S: 0.85, L: 0.40, hue: 'YE' }, /* goldenrod */
  { centerDeg: 117, H: 95,  S: 0.90, L: 0.38, hue: 'GR' }, /* yellow-green */
  { centerDeg: 157, H: 178, S: 0.95, L: 0.40, hue: 'TE' }, /* toward cyan */
  { centerDeg: 215, H: 215, S: 0.95, L: 0.42, hue: 'BL' },
  { centerDeg: 282, H: 282, S: 0.95, L: 0.42, hue: 'PU' },
  { centerDeg: 344, H: 333, S: 0.95, L: 0.50, hue: 'PK' }, /* pinker, brighter */
];

/** Nearest ink-on-paper profile for an input hue (h in [0,1]). */
export function profileForHue(h01: number): HueProfile {
  const deg = h01 * 360;
  let best = HUE_PROFILES[0], bestDist = 360;
  for (const p of HUE_PROFILES) {
    let d = Math.abs(deg - p.centerDeg);
    if (d > 180) d = 360 - d;
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

/** Sanctioned ink hex (a darkColorHex output) → sanctioned light-source hex.
 *  Keys/values lowercase. Built with the SAME hsl→rgb→hex path darkColorHex
 *  uses, so the keys match its outputs exactly. */
export const SANCTIONED_INK_TO_LIGHT: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const p of HUE_PROFILES) {
    const [r, g, b] = hslToRgb(p.H / 360, p.S, p.L);
    m.set(rgbToHex(r, g, b).toLowerCase(), hueC[p.hue].l.toLowerCase());
  }
  return m;
})();

/** Every sanctioned light-source notehead hex (base .l + septimal .sl). */
export const SANCTIONED_LIGHT: ReadonlySet<string> = (() => {
  const s = new Set<string>();
  for (const h of hueCycle) {
    s.add(hueC[h].l.toLowerCase());
    if (hueC[h].sl) s.add(hueC[h].sl!.toLowerCase());
  }
  return s;
})();

/** Reverse-map a baked ink color to its sanctioned light-source variant, or
 *  null if it isn't one of our sanctioned ink colors (caller flags it). */
export function sanctionedLightForInk(inkHex: string): string | null {
  return SANCTIONED_INK_TO_LIGHT.get(inkHex.trim().toLowerCase()) ?? null;
}
