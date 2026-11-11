// Lattice color palette — pure data tables. Shared between HKL (lattice
// rendering, MIDI feedback, screen readback) and HKC (notehead colors via
// data-q/data-r → resolved color through the bridge). No runtime state, no
// tuning dependency — the color function (pitch → hue) is keycolor.ts.
//
// A hue is a light / dark pair plus its ink on paper (`hueC`). A hue CYCLE is an ordered list of
// hues, one per spine (`FIFTHS_CYCLE`, `FOURTHS_CYCLE`): each of its steps
// carries the hue and its half-step (septimal) variants, halfway to the next
// warmer step of the same cycle, so a half step belongs to a cycle, not a hue.

export type Hue = 'PK' | 'PU' | 'BL' | 'TE' | 'GR' | 'YE' | 'OR' | 'DA' | 'SG';

export interface HueColors {
  /** light variant — natural pitch class */
  l: string;
  /** dark variant — accidental pitch class */
  d: string;
  /** ink on white paper (Composer's light theme): one per hue, for every
   *  variant of it, half steps included (lowercase, as baked into a score) */
  ink: string;
}

/* The seven hues, tuned by eye for the Lumatone's LEDs: equal steps round the
   wheel. Their inks are tuned for white paper, where the lattice hexes are too
   pale to read and pink / orange and teal / green would be confused (HSL:
   pink 333° .95 .50, pinker and brighter; purple 282° .95 .42; blue 215° .95
   .42; teal 178° .95 .40, toward cyan; green 95° .90 .38, yellow-green;
   yellow 42° .85 .40, goldenrod; orange 25° 1.00 .46, warm and brighter). */
const SEVEN = {
  PK: { l: '#FF4C79', d: '#59002C', ink: '#f90673' },
  PU: { l: '#C94CFF', d: '#3E0059', ink: '#9405d1' },
  BL: { l: '#4C96FF', d: '#002559', ink: '#055ad1' },
  TE: { l: '#4CFFBA', d: '#005937', ink: '#05c7c0' },
  GR: { l: '#55FF4C', d: '#045900', ink: '#52b80a' },
  YE: { l: '#FFF94C', d: '#595600', ink: '#bd890f' },
  OR: { l: '#FF884C', d: '#591D00', ink: '#eb6200' },
};

/** The hue `t` of the way from `a` to `b`: light, dark and ink alike. */
function between(a: HueColors, b: HueColors, t: number): HueColors {
  return { l: lerpHex(a.l, b.l, t).toUpperCase(), d: lerpHex(a.d, b.d, t).toUpperCase(), ink: lerpHex(a.ink, b.ink, t) };
}

export const hueC: Readonly<Record<Hue, HueColors>> = {
  ...SEVEN,
  /* Dandelion and spring green, the fourths cycle's two hues between pink and
     blue (Max, 2026-11-10). That stretch of the seven is five equal steps
     (pink, orange, yellow, green, teal, blue) and the two cut it in thirds:
     2/3 of the way from orange to yellow, 1/3 of the way from green to teal,
     their inks likewise from those hues' inks. */
  DA: between(SEVEN.OR, SEVEN.YE, 2 / 3),
  SG: between(SEVEN.GR, SEVEN.TE, 1 / 3),
};

/** Every hue in a fixed order: stable ids for gates and snapshots. Append only. */
export const HUES: ReadonlyArray<Hue> = ['PK', 'PU', 'BL', 'TE', 'GR', 'YE', 'OR', 'DA', 'SG'];

/** One step of a hue cycle. */
export interface CycleStep extends HueColors {
  hue: Hue;
  /** half-step light variant: halfway to the next warmer step of this cycle */
  sl: string;
  /** half-step dark variant */
  sd: string;
}

function lerpHex(a: string, b: string, t: number): string {
  const ar = parseInt(a.slice(1, 3), 16), ag = parseInt(a.slice(3, 5), 16), ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16), bg = parseInt(b.slice(3, 5), 16), bb = parseInt(b.slice(5, 7), 16);
  const rr = Math.round(ar + (br - ar) * t), rg = Math.round(ag + (bg - ag) * t), rb = Math.round(ab + (bb - ab) * t);
  return '#' + ((1 << 24) + (rr << 16) + (rg << 8) + rb).toString(16).slice(1);
}

/* A cycle in keycolor.ts's index space: index 0 is A3's hue, a syntonic comma
   is +2, and warm is −1, so step i's half-step variants lerp toward step i − 1. */
function buildCycle(hues: ReadonlyArray<Hue>): ReadonlyArray<CycleStep> {
  return hues.map((hue, i) => {
    const cur = hueC[hue], warm = hueC[hues[(i + hues.length - 1) % hues.length]];
    return { hue, ...cur, sl: lerpHex(cur.l, warm.l, 1 / 2), sd: lerpHex(cur.d, warm.d, 1 / 2) };
  });
}

/** The hue cycle of each spine (keycolor.ts). A cycle is as long as its spine
 *  step has semitones — the octaves twelve spine steps span, 7 for fifths and
 *  5 for fourths — so a Pythagorean comma is a whole turn on either. The two
 *  share purple and its neighbors, pink and blue, with the half steps between. */
export const FIFTHS_CYCLE: ReadonlyArray<CycleStep> = buildCycle(['PU', 'PK', 'OR', 'YE', 'GR', 'TE', 'BL']);
export const FOURTHS_CYCLE: ReadonlyArray<CycleStep> = buildCycle(['PU', 'PK', 'DA', 'SG', 'BL']);

/** The hue cycle of a layout's spine: fourths in an inverted layout. */
export function hueCycleOf(invert: boolean): ReadonlyArray<CycleStep> {
  return invert ? FOURTHS_CYCLE : FIFTHS_CYCLE;
}

export const whiteSet: ReadonlySet<number> = new Set([0, 2, 4, 5, 7, 9, 11]);

/* ── notehead colors a score may hold ──────────────────────────────────────
   On white paper (light theme) a notehead takes its hue's ink (`hueC[…].ink`,
   via inkColorHex in keycolor.ts); on a DARK surface it takes the bright
   light-source hue (.l / .sl). A score bakes both. When a file comes WITHOUT
   the baked light variant we reverse-map its ink to its hue's light color; an
   unrecognized color isn't approximated (the renderer flags it white/black so
   a bad import is obvious). */

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
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

/** Sanctioned ink hex (an inkColorHex output) → its hue's light-source hex.
 *  Keys/values lowercase. */
export const SANCTIONED_INK_TO_LIGHT: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const hue of HUES) m.set(hueC[hue].ink.toLowerCase(), hueC[hue].l.toLowerCase());
  return m;
})();

/** Every sanctioned light-source notehead hex: each cycle's .l and half-step .sl. */
export const SANCTIONED_LIGHT: ReadonlySet<string> = (() => {
  const s = new Set<string>();
  for (const cycle of [FIFTHS_CYCLE, FOURTHS_CYCLE]) {
    for (const step of cycle) {
      s.add(step.l.toLowerCase());
      s.add(step.sl.toLowerCase());
    }
  }
  return s;
})();

/** Reverse-map a baked ink color to its sanctioned light-source variant, or
 *  null if it isn't one of our sanctioned ink colors (caller flags it). */
export function sanctionedLightForInk(inkHex: string): string | null {
  return SANCTIONED_INK_TO_LIGHT.get(inkHex.trim().toLowerCase()) ?? null;
}
