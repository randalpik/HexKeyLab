// Hue and key-color computation. Reads tuning state (live bindings).
// Reduces to lookupHue when septimal disabled (pair=0).

import { bandOf } from '../layout/coords.js';
import { tuning } from '../state/tuning.js';

type Hue = 'PK' | 'PU' | 'BL' | 'TE' | 'GR' | 'YE' | 'OR';

interface HueColors {
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

export function lookupHue(q: number, r: number): Hue {
  return colorTable[((q % 3) + 3) % 3][((r % 12) + 12) % 12];
}

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

/* Unified hue computation from three rules:
   Rule 1 (octave congruence): hue(q,r)=hue(q+3,r) → bandOf(q) cancels midi shift
   Rule 2 (merge matching): syntonic partners in same pair share hue → 2*pair term
   Rule 3 (octave rule in cells): floor(midi/12) determines hue within each 3×6 cell
   Formula: hueCycle[(floor(midi/12) - bandOf(q) - 2*pairOf(r-septimalShift) - 4) % 7]
   Pairs shift with septimalShift. Reduces to lookupHue when septimal disabled (pair=0). */
export function computeHue(q: number, r: number): Hue {
  const midi = 57 + 4 * q + 7 * r;
  if (tuning.equalEnabled) return equalHueCycle[((Math.floor(midi / 12) % 3) + 3) % 3];
  const b = bandOf(q);
  const p = tuning.septimalEnabled ? Math.floor((r - tuning.septimalShift + 3.5) / 6) : 0;
  return hueCycleOrder[(((Math.floor(midi / 12) - b - 2 * p - 4) % 7) + 7) % 7];
}

/* returns hex color string for key at lattice (q,r) under current tuning/layout state */
export function keyColorHex(q: number, r: number): string {
  const midi = 57 + 4 * q + 7 * r;
  const pc = ((midi % 12) + 12) % 12;
  const isW = whiteSet.has(pc);
  const mh = computeHue(q, r);
  const inB = tuning.septimalEnabled && ((Math.floor((r - tuning.septimalShift) / tuning.septimalW) & 1) !== 0);
  return inB ? (isW ? hueC[mh].sl! : hueC[mh].sd!) : (isW ? hueC[mh].l : hueC[mh].d);
}
