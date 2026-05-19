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

export const colorTable: ReadonlyArray<ReadonlyArray<Hue>> = [
  ['PU','PK','PK','OR','YE','YE','GR','GR','TE','BL','BL','PU'],
  ['PK','PK','OR','OR','YE','GR','GR','TE','TE','BL','BL','PU'],
  ['PU','PK','PK','OR','OR','YE','YE','GR','TE','TE','BL','BL'],
];

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

/* hue cycle for octave-based color and diaschisma shifts */
export const hueCycleOrder: ReadonlyArray<Hue> = ['PU', 'PK', 'OR', 'YE', 'GR', 'TE', 'BL'];
export const hueIdx: Record<Hue, number> = {} as Record<Hue, number>;
for (let hi = 0; hi < 7; hi++) hueIdx[hueCycleOrder[hi]] = hi;

/* 3-hue octave cycle for Equal mode (A3=PU) */
export const equalHueCycle: ReadonlyArray<Hue> = ['BL', 'PU', 'PK'];
