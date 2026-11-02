// Note-name mapping: how lattice coordinates are arranged on the hex grid.
// Every layout samples the chromatic frame: cell (q, r) is the chromatic cell
// (c·q + s·r, r) — or, INVERTED, (c·q + s·r, −r) raised r exact octaves — with c
// the column step in semitones and s the shear in chromatic columns per row.
// LAYOUT holds each layout's (c, s, invert) (docs/architecture.md → Note-name
// mapping → The layout matrix).
//
//   'euler'        c 4 — the Harmonic-Table lattice: q = major thirds, 3-wide
//                  octave bands (docs/architecture.md → Tuning system).
//   'wickiHayden'  c 2 — after every fifths column, a column holding the same notes
//                  shifted down 2 cells and exactly one octave — rows step in
//                  whole tones, bands are 6 wide.
//   'chromatic'    c 1 — Wicki-Hayden plus, right of every column, the column one
//                  (5,1) octave-vector to its left (5 columns left, 1 row down),
//                  up an exact octave — rows step in semitones, bands are 12 wide
//                  (docs/architecture.md → Note-name mapping).
//
// In those three the r axis is the fifths axis, and each doubles q: Euler (q, r)
// = Wicki-Hayden (2q, r) = chromatic (4q, r). A sheared layout keeps a pure fifth
// along (−s/c, 1), and an inverted one a pure fourth there.
// A cell's coordinates are its own in its mapping; the mapping is part of the
// coordinate frame, like the tuning mode. Every cell has an Euler-EQUIVALENT
// cell with the same name, spelled octave, nominal MIDI and — in every
// band-uniform mode — the same pitch. The mapping-aware primitives (freq.ts,
// notes.ts, heji.ts) resolve through it.
//
// Column order within a band of width W, by position (q + W/3) mod W:
//   Wicki-Hayden  0 qm2 · 1 qm2′ · 2 qm0 · 3 qm0′ · 4 qm1 · 5 qm1′    (′ = copy)
//   chromatic     0 qm2 · 2 qm2′ · 4 qm0 · 6 qm0′ · 8 qm1 · 10 qm1′, odd positions new
//                 (A's row: F F# G G# A Bb B C C# D D# E)
// A3 sits at (0,0) — the qm0 column, chromatic position 4 — in every layout.

/** Every layout the matrix model defines. In Euler, Wicki-Hayden and Chromatic
 *  r is the fifths axis; the other six are sheared or inverted
 *  (docs/architecture.md → Sheared and inverted layouts). */
export type Mapping = 'euler' | 'wickiHayden' | 'chromatic' | 'gerhard' | 'janko' | 'accordion' | 'randal' | 'park' | 'bass';

/** Every mapping, in dropdown order (Max, 2026-11-01): the fifths layouts, their
 *  sheared forms (Gerhard Euler's cells, Janko Wicki-Hayden's, the Accordion
 *  Park's), then the fourths layouts. */
export const MAPPINGS: ReadonlyArray<Mapping> = [
  'euler', 'wickiHayden', 'chromatic', 'gerhard', 'janko', 'accordion', 'randal', 'park', 'bass',
];

export function isMapping(x: unknown): x is Mapping {
  return (MAPPINGS as ReadonlyArray<unknown>).includes(x);
}

export const MAPPING_LABELS: Readonly<Record<Mapping, string>> = {
  euler: 'Euler',
  wickiHayden: 'Wicki-Hayden',
  chromatic: 'Chromatic',
  gerhard: 'Gerhard',
  janko: 'Janko',
  accordion: 'Accordion',
  randal: 'Randal',
  park: 'Park',
  bass: 'Bass',
};

export interface LayoutMatrix {
  /** Semitones per column step (+1, 0); the octave band is 12/c columns. */
  readonly c: number;
  /** Shear: chromatic columns per row, −k·c for k keys per row. c | s keeps the
   *  pure line a lattice vector, so seams run along it and never cut it. */
  readonly s: number;
  /** Rows descend the fifths axis and rise one exact octave each: the pure line
   *  is a fourth. */
  readonly invert: boolean;
}

/** Each layout's matrix into the chromatic frame. */
export const LAYOUT: Readonly<Record<Mapping, LayoutMatrix>> = {
  euler: { c: 4, s: 0, invert: false },
  wickiHayden: { c: 2, s: 0, invert: false },
  chromatic: { c: 1, s: 0, invert: false },
  gerhard: { c: 4, s: -4, invert: false },
  janko: { c: 2, s: -6, invert: false },
  accordion: { c: 2, s: -2, invert: true },
  randal: { c: 4, s: 0, invert: true },
  park: { c: 2, s: 0, invert: true },
  bass: { c: 1, s: 0, invert: true },
};

/** The chromatic cell [Q, R] that cell (q, r) of `layout` samples, and the exact
 *  octaves `oct` it sounds above that cell. */
export function toChromatic(q: number, r: number, layout: Mapping): [number, number, number] {
  const { c, s, invert } = LAYOUT[layout];
  return invert ? [c * q + s * r, 0 - r, r] : [c * q + s * r, r, 0];
}

/** Columns per octave band: 12 / c (3 Euler, 6 Wicki-Hayden, 12 chromatic). */
export function bandWidth(layout: Mapping): number {
  return 12 / LAYOUT[layout].c;
}

export interface EulerCell {
  q: number;
  r: number;
}

/** Euler-equivalent of chromatic cell (Q, R), Q = 4k + j: j=0 the original
 *  (k, R); j=1 its m2 above, (k+2, R−1); j=2 the Wicki-Hayden copy (k−3, R+2);
 *  j=3 the original's m3 above, (k−1, R+1). Odd j is the cell at (Q−5, R−1) up
 *  an exact octave. Returns a fresh object. */
export function chromaticEuler(Q: number, R: number): EulerCell {
  const k = Math.floor(Q / 4);
  switch (Q - 4 * k) {
    case 0: return { q: k, r: R };
    case 1: return { q: k + 2, r: R - 1 };
    case 2: return { q: k - 3, r: R + 2 };
    default: return { q: k - 1, r: R + 1 };
  }
}

/** Spatial band of chromatic column Q (see `bandOfCell`). */
export function chromaticBand(Q: number): number {
  return Math.floor((Q + 4) / 12);
}

/** Pitch band of chromatic column Q (see `pitchBandOf`): an odd column keeps
 *  the band of its source column Q − 5. */
export function chromaticPitchBand(Q: number): number {
  return Math.floor(((Q % 2 !== 0 ? Q - 5 : Q) + 4) / 12);
}

/** The chromatic cells sharing one Euler-equivalent, by column type j: the
 *  equivalent (A, B) is sampled by Q = 4(A + dk) + j, R = B + dR. */
const CHROMATIC_TWINS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [1, -2, 1], [2, 3, -2], [3, 1, -1],
];

/** Euler-equivalent of cell (q, r) under `layout`: its chromatic cell's,
 *  raised its `oct` octaves (one Euler band each). This is also the frame
 *  conversion to Euler: exact in every band-uniform mode; in V/S/Y a copy lands
 *  where its Euler-equivalent's band puts it. Under Wicki-Hayden an even column
 *  Q is Euler column Q/2, and an odd column (a copy of column (Q−1)/2, 2 cells
 *  down and an octave down) is ((Q−1)/2 − 3, R+2). */
export function eulerOf(q: number, r: number, layout: Mapping): EulerCell {
  const L = LAYOUT[layout];
  if (!L.invert) return chromaticEuler(L.c * q + L.s * r, r);
  const e = chromaticEuler(L.c * q + L.s * r, 0 - r);
  e.q += 3 * r;
  return e;
}

/** The cell of `layout` holding Euler cell (q, r): same name, spelled octave
 *  and nominal MIDI, and the same pitch in every band-uniform mode — in every
 *  mode for Euler, Wicki-Hayden and chromatic, whose original columns are
 *  Euler's own, (4/c)·q. Of the four chromatic cells with that equivalent, the
 *  first the layout samples. */
export function fromEuler(q: number, r: number, layout: Mapping): [number, number] {
  const { c, s, invert } = LAYOUT[layout];
  for (const [j, dk, dR] of CHROMATIC_TWINS) {
    const R = r + dR, row = invert ? 0 - R : R, oct = invert ? row : 0;
    const n = 4 * (q - 3 * oct + dk) + j - s * row;
    if (n % c === 0) return [n / c, row];
  }
  throw new Error(`fromEuler: ${layout} samples none of (${q},${r})'s chromatic cells`);
}

/** Octave band of cell (q, r): the chromatic band of the column it samples,
 *  floor((Q + 4) / 12) with Q = c·q + s·r — floor((q+1)/3) Euler, floor((q+2)/6)
 *  Wicki-Hayden, floor((q+4)/12) chromatic. Seams therefore run along the pure
 *  line, slanting −s/c keys per row. Every key is 2:1 (Schismatic: 2:1 +
 *  schisma) above the key one band-width to its left. This is the SPATIAL band:
 *  seams, position in band, the reference spine, the S/Y anchor and the
 *  Schismatic schisma count all use it. */
export function bandOfCell(q: number, r: number, layout: Mapping): number {
  const L = LAYOUT[layout];
  return chromaticBand(L.c * q + L.s * r);
}

/** Position of cell (q, r) within its band, 0 … W−1: its chromatic position
 *  (Q + 4) mod 12 in column steps. A3's qm0 column is W/3 where that is whole. */
export function posInBandOf(q: number, r: number, layout: Mapping): number {
  const { c, s } = LAYOUT[layout];
  return Math.floor((((c * q + s * r + 4) % 12) + 12) % 12 / c);
}

/** The band whose Syntonic / Polysyntonic offset cell (q, r) carries. A
 *  chromatic odd column is an unadjusted copy of (Q−5, R−1), so it keeps that
 *  column's band — one band lower for F# and G# (positions 1 and 3), its own
 *  otherwise. Every other column carries its own band. Read only by the S/Y band
 *  term and the unbanded respelling. */
export function pitchBandOf(q: number, r: number, layout: Mapping): number {
  const L = LAYOUT[layout];
  return chromaticPitchBand(L.c * q + L.s * r);
}

/** The spelled-octave vector of `layout`'s frame — the step to the same spelled
 *  note one octave up. Banded it is the band step (W, 0). Unbanded a band step
 *  is a 12-fifth respelling, not an octave (docs/architecture.md → Unbanded
 *  layout); the spelled octave is the vector whose chromatic image is the
 *  chromatic frame's (−2, 2) — or (2, −2) plus two octaves, inverted — where
 *  that is a lattice vector: (−1, 2) Wicki-Hayden, (−2, 2) chromatic, (5, 2)
 *  Janko, (3, 2) Accordion, (1, 2) Park, (2, 2) Bass. Null where it isn't:
 *  Euler, Gerhard, Randal. */
export function octaveVector(layout: Mapping, banded: boolean): readonly [number, number] | null {
  if (banded) return [bandWidth(layout), 0];
  const { c, s, invert } = LAYOUT[layout];
  const n = (invert ? 2 : -2) - 2 * s;
  return n % c === 0 ? [n / c, 2] : null;
}

/** Euler lattice vector (dq, dr) expressed in `layout`: the vector that moves
 *  every cell's Euler-equivalent by exactly (dq, dr). It keeps the chromatic
 *  column type (Q mod 4), so the offset means the same Euler step from every
 *  column; in Euler, Wicki-Hayden and chromatic the q component just scales by
 *  4/c. Null where the layout has no such vector: every preset has them all,
 *  but a 4-wide band (c = 3) only has those whose dq is a multiple of 3. */
export function vecFromEuler(dq: number, dr: number, layout: Mapping): [number, number] | null {
  const { c, s, invert } = LAYOUT[layout];
  const row = invert ? 0 - dr : dr;
  const n = 4 * dq - (invert ? s + 12 : s) * row;
  return n % c === 0 ? [n / c, row] : null;
}

/** The cell of `layout` that samples chromatic cell (Q, R) raised `oct`
 *  octaves, or null. */
function fromChromatic(Q: number, R: number, oct: number, layout: Mapping): [number, number] | null {
  const { c, s, invert } = LAYOUT[layout];
  const row = invert ? 0 - R : R;
  if ((invert ? row : 0) !== oct) return null;
  const n = Q - s * row;
  return n % c === 0 ? [n / c, row] : null;
}

/** Re-express cell (q, r) of layout `from` in layout `to` — the frame
 *  conversion (Composer retune, the bridge, cross-score paste). A cell whose
 *  chromatic cell and octave `to` also samples maps to that same cell, exact in
 *  every mode (Euler ⊂ Wicki-Hayden ⊂ chromatic nest this way); any other cell
 *  goes through its Euler-equivalent — exact in every band-uniform mode, a
 *  schisma or a comma away in V/S/Y. Identity when the layouts agree. */
export function convertCell(q: number, r: number, from: Mapping, to: Mapping): [number, number] {
  if (from === to) return [q, r];
  const [Q, R, oct] = toChromatic(q, r, from);
  const same = fromChromatic(Q, R, oct, to);
  if (same) return same;
  const e = eulerOf(q, r, from);
  return fromEuler(e.q, e.r, to);
}
