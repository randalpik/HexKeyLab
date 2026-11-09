// OKLab conversions for Lumatone LED colors (Björn Ottosson's OKLab, linear-sRGB
// matrices). LED values are treated as linear light: the octave-board firmware
// (1.4.0 and 1.5.0) has no brightness lookup table, so a value drives the LED
// directly as far as we can tell (a curve computed in code is not ruled out).
//
// Used by the ref-slide sampler (sync.ts sampleField): blending in OKLab keeps
// perceived lightness constant through a slide, where blending LED values
// directly read 3–5 L* brighter at every half-step between a dark and a light
// key (docs/lessons.md, 2026-11-09).

export type Oklab = [number, number, number];

const cache = new Map<string, Oklab>();

/** '#RRGGBB' LED color (values as linear light, 0–255) → OKLab. */
export function hexToOklab(hex: string): Oklab {
  const hit = cache.get(hex);
  if (hit) return hit;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lab: Oklab = [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
  if (cache.size > 4096) cache.clear();
  cache.set(hex, lab);
  return lab;
}

/** OKLab → '#RRGGBB' LED color (uppercase, like the palette), clamped to gamut. */
export function oklabToHex([L, A, B]: Oklab): string {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  return '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16).padStart(2, '0').toUpperCase()).join('');
}
