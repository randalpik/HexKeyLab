// Note-name mapping: how lattice coordinates are arranged on the hex grid.
// Every layout samples the chromatic frame: cell (q, r) is the chromatic cell
// (c·q + s·r, r) — or, INVERTED, (c·q + s·r, −r) raised r exact octaves — with c
// the column step in semitones and s the shear in chromatic columns per row.
// layoutOf(id) derives each layout's (c, s, invert) from its three defining
// values, (division, shear, invert): the eight presets by name, every other
// valid triple by a custom id (docs/architecture.md → Note-name mapping → The
// layout matrix).
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

/** The eight named layouts. In Euler, Wicki-Hayden and Chromatic r is the fifths
 *  axis; the other five are sheared or inverted
 *  (docs/architecture.md → Sheared and inverted layouts). */
export type PresetMapping = 'euler' | 'wickiHayden' | 'chromatic' | 'gerhard' | 'janko' | 'accordion' | 'randal' | 'park';

/** A layout that is not a preset, named by its values: `<division>:<shear>`,
 *  plus `:i` when inverted (`6:-2:i`). */
export type CustomMapping = `${number}:${number}` | `${number}:${number}:i`;

/** A layout id. A layout IS its (division, shear, invert) (`LayoutSpec`): a
 *  preset's values go by the preset's name and every other valid triple by its
 *  custom id, so each layout has exactly one id and ids compare with `===`. */
export type Mapping = PresetMapping | CustomMapping;

/** The presets, in dropdown order (Max, 2026-11-01): the fifths layouts, their
 *  sheared forms (Gerhard Euler's cells, Janko Wicki-Hayden's, the Accordion
 *  Park's), then the fourths layouts. */
export const MAPPINGS: ReadonlyArray<PresetMapping> = [
  'euler', 'wickiHayden', 'chromatic', 'gerhard', 'janko', 'accordion', 'randal', 'park',
];

export function isPresetMapping(x: unknown): x is PresetMapping {
  return (MAPPINGS as ReadonlyArray<unknown>).includes(x);
}

export const MAPPING_LABELS: Readonly<Record<PresetMapping, string>> = {
  euler: 'Euler',
  wickiHayden: 'Wicki-Hayden',
  chromatic: 'Chromatic',
  gerhard: 'Gerhard',
  janko: 'Janko',
  accordion: 'Accordion',
  randal: 'Randal',
  park: 'Park',
};

/** A layout's label: the preset's name, or "Custom". */
export function mappingLabel(layout: Mapping): string {
  return isPresetMapping(layout) ? MAPPING_LABELS[layout] : 'Custom';
}

/** A layout's three defining values. */
export interface LayoutSpec {
  /** Keys per octave along a row (the band width W): 3, 4, 6 or 12. A column
   *  step is 12/division semitones. */
  readonly division: number;
  /** Whole keys each row slides right of the row below (negative: left). The
   *  pure line is (shear, 1). */
  readonly shear: number;
  /** The pure line is a fourth instead of a fifth; the row step drops by 2. */
  readonly invert: boolean;
}

/** The octave divisions: the band widths that divide 12 (2 and 1 are degenerate). */
export const DIVISIONS: ReadonlyArray<number> = [3, 4, 6, 12];

export const PRESETS: Readonly<Record<PresetMapping, LayoutSpec>> = {
  euler: { division: 3, shear: 0, invert: false },
  wickiHayden: { division: 6, shear: 0, invert: false },
  chromatic: { division: 12, shear: 0, invert: false },
  gerhard: { division: 3, shear: 1, invert: false },
  janko: { division: 6, shear: 3, invert: false },
  accordion: { division: 6, shear: 1, invert: true },
  randal: { division: 3, shear: 0, invert: true },
  park: { division: 6, shear: 0, invert: true },
};

/** Semitones from one row to the next, the step of (0, 1): a fifth (a fourth,
 *  inverted) less the shear's columns. */
function rowStepOf(spec: LayoutSpec): number {
  return (spec.invert ? 5 : 7) - spec.shear * (12 / spec.division);
}

/** The one bound on a layout: the row step ascends by 1 to 12 semitones and
 *  differs from the column step (equal steps collapse the third axis to a
 *  unison). Every pitch class is then reachable. */
export function isValidSpec(spec: LayoutSpec): boolean {
  if (!DIVISIONS.includes(spec.division) || !Number.isInteger(spec.shear)) return false;
  const step = rowStepOf(spec);
  return step >= 1 && step <= 12 && step !== 12 / spec.division;
}

/** The valid shears for `division` and `invert`, as [lowest, highest]; every
 *  whole shear between them is valid. */
export function shearRange(division: number, invert: boolean): readonly [number, number] {
  let lo = 0, hi = 0;
  while (isValidSpec({ division, shear: lo - 1, invert })) lo--;
  while (isValidSpec({ division, shear: hi + 1, invert })) hi++;
  return [lo, hi];
}

/** `shear` moved to the nearest valid value for `division` and `invert`. */
export function clampShear(division: number, shear: number, invert: boolean): number {
  const [lo, hi] = shearRange(division, invert);
  return Math.min(hi, Math.max(lo, shear));
}

function presetOf(spec: LayoutSpec): PresetMapping | null {
  for (const m of MAPPINGS) {
    const p = PRESETS[m];
    if (p.division === spec.division && p.shear === spec.shear && p.invert === spec.invert) return m;
  }
  return null;
}

const CUSTOM_ID = /^(3|4|6|12):(0|-?[1-9]\d?)(:i)?$/;

/** The values a custom id names, or null: not the canonical form, out of
 *  bounds, or a preset's values (those go by the preset's name). */
function parseCustom(id: string): LayoutSpec | null {
  const m = CUSTOM_ID.exec(id);
  if (!m) return null;
  const spec: LayoutSpec = { division: +m[1], shear: +m[2], invert: m[3] !== undefined };
  return isValidSpec(spec) && !presetOf(spec) ? spec : null;
}

/** The id of the layout with these values: the preset's name where they are a
 *  preset's, otherwise the custom id. Throws on values outside the bound. */
export function mappingOf(spec: LayoutSpec): Mapping {
  if (!isValidSpec(spec)) throw new Error(`mappingOf: (${spec.division}, ${spec.shear}, ${spec.invert}) is not a layout`);
  return presetOf(spec) ?? (`${spec.division}:${spec.shear}${spec.invert ? ':i' : ''}` as CustomMapping);
}

/** A layout's (division, shear, invert). */
export function specOf(layout: Mapping): LayoutSpec {
  const spec = isPresetMapping(layout) ? PRESETS[layout] : parseCustom(layout);
  if (!spec) throw new Error(`specOf: "${layout}" is not a layout`);
  return spec;
}

/** True for a preset name or a custom id in canonical form and within the bound. */
export function isMapping(x: unknown): x is Mapping {
  return isPresetMapping(x) || (typeof x === 'string' && parseCustom(x) !== null);
}

/** Every layout: the presets in dropdown order, then every other valid
 *  (division, shear, invert), by division, plain before inverted, by shear. */
export function allMappings(): Mapping[] {
  const out: Mapping[] = [...MAPPINGS];
  for (const division of DIVISIONS) for (const invert of [false, true]) {
    const [lo, hi] = shearRange(division, invert);
    for (let shear = lo; shear <= hi; shear++) {
      const id = mappingOf({ division, shear, invert });
      if (!isPresetMapping(id)) out.push(id);
    }
  }
  return out;
}

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

/** Derived matrices by id: a memo of a pure function of the id. */
const MATRICES: Record<string, LayoutMatrix> = Object.create(null);

/** A layout's matrix into the chromatic frame: c = 12/division, s = −shear·c. */
export function layoutOf(layout: Mapping): LayoutMatrix {
  const known = MATRICES[layout];
  if (known) return known;
  const spec = specOf(layout);
  const c = 12 / spec.division;
  return (MATRICES[layout] = { c, s: 0 - spec.shear * c, invert: spec.invert });
}

/** The chromatic cell [Q, R] that cell (q, r) of `layout` samples, and the exact
 *  octaves `oct` it sounds above that cell. */
export function toChromatic(q: number, r: number, layout: Mapping): [number, number, number] {
  const { c, s, invert } = layoutOf(layout);
  return invert ? [c * q + s * r, 0 - r, r] : [c * q + s * r, r, 0];
}

/** Columns per octave band: 12 / c (3 Euler, 6 Wicki-Hayden, 12 chromatic). */
export function bandWidth(layout: Mapping): number {
  return 12 / layoutOf(layout).c;
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
  const L = layoutOf(layout);
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
  const { c, s, invert } = layoutOf(layout);
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
  const L = layoutOf(layout);
  return chromaticBand(L.c * q + L.s * r);
}

/** Position of cell (q, r) within its band, 0 … W−1: its chromatic position
 *  (Q + 4) mod 12 in column steps. A3's qm0 column is W/3 where that is whole. */
export function posInBandOf(q: number, r: number, layout: Mapping): number {
  const { c, s } = layoutOf(layout);
  return Math.floor((((c * q + s * r + 4) % 12) + 12) % 12 / c);
}

/** The band whose Syntonic / Polysyntonic offset cell (q, r) carries. A
 *  chromatic odd column is an unadjusted copy of (Q−5, R−1), so it keeps that
 *  column's band — one band lower for F# and G# (positions 1 and 3), its own
 *  otherwise. Every other column carries its own band. Read only by the S/Y band
 *  term and the unbanded respelling. */
export function pitchBandOf(q: number, r: number, layout: Mapping): number {
  const L = layoutOf(layout);
  return chromaticPitchBand(L.c * q + L.s * r);
}

/** The spelled-octave vector of `layout`'s frame — the step to the same spelled
 *  note one octave up. Banded it is the band step (W, 0). Unbanded a band step
 *  is a 12-fifth respelling, not an octave (docs/architecture.md → Unbanded
 *  layout); the spelled octave is the vector whose chromatic image is the
 *  chromatic frame's (−2, 2) — or (2, −2) plus two octaves, inverted — where
 *  that is a lattice vector: (−1, 2) Wicki-Hayden, (−2, 2) chromatic, (5, 2)
 *  Janko, (3, 2) Accordion, (1, 2) Park. Null where it isn't:
 *  Euler, Gerhard, Randal. */
export function octaveVector(layout: Mapping, banded: boolean): readonly [number, number] | null {
  if (banded) return [bandWidth(layout), 0];
  const { c, s, invert } = layoutOf(layout);
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
  const { c, s, invert } = layoutOf(layout);
  const row = invert ? 0 - dr : dr;
  const n = 4 * dq - (invert ? s + 12 : s) * row;
  return n % c === 0 ? [n / c, row] : null;
}

/** The cell of `layout` that samples chromatic cell (Q, R) raised `oct`
 *  octaves, or null. */
function fromChromatic(Q: number, R: number, oct: number, layout: Mapping): [number, number] | null {
  const { c, s, invert } = layoutOf(layout);
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
