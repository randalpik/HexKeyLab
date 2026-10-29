// Note-name mapping: how lattice coordinates are arranged on the hex grid. The
// r axis is always fifths; a column step (+1, 0) is COLUMN_STEP semitones:
//
//   'euler'        4 — the Harmonic-Table lattice: q = major thirds, 3-wide
//                  octave bands (docs/architecture.md → Tuning system).
//   'wickiHayden'  2 — after every fifths column, a column holding the same notes
//                  shifted down 2 cells and exactly one octave — rows step in
//                  whole tones, bands are 6 wide.
//   'chromatic'    1 — Wicki-Hayden plus, right of every column, the column one
//                  (5,1) octave-vector to its left (5 columns left, 1 row down),
//                  up an exact octave — rows step in semitones, bands are 12 wide
//                  (docs/architecture.md → Note-name mapping).
//
// Each mapping doubles q: Euler (q, r) = Wicki-Hayden (2q, r) = chromatic (4q, r).
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
// A3 sits at (0,0) — qm0, position W/3 — in every mapping.

export type Mapping = 'euler' | 'wickiHayden' | 'chromatic';

export const MAPPINGS: ReadonlyArray<Mapping> = ['euler', 'wickiHayden', 'chromatic'];

export function isMapping(x: unknown): x is Mapping {
  return (MAPPINGS as ReadonlyArray<unknown>).includes(x);
}

export const MAPPING_LABELS: Readonly<Record<Mapping, string>> = {
  euler: 'Euler',
  wickiHayden: 'Wicki-Hayden',
  chromatic: 'Chromatic',
};

/** Semitones per column step (+1, 0): a major third, a whole tone, a semitone. */
export const COLUMN_STEP: Readonly<Record<Mapping, number>> = {
  euler: 4,
  wickiHayden: 2,
  chromatic: 1,
};

/** Columns per octave band: 12 / COLUMN_STEP (3, 6, 12). */
export function bandWidth(mapping: Mapping): number {
  return 12 / COLUMN_STEP[mapping];
}

export interface EulerCell {
  q: number;
  r: number;
}

/** Euler-equivalent of cell (q, r) under `mapping`. This is also the frame
 *  conversion to Euler: exact in every band-uniform mode; in V/S/Y a copy
 *  lands where its Euler-equivalent's band puts it.
 *  - Wicki-Hayden: an even column Q is Euler column Q/2; an odd column (a copy
 *    of column (Q−1)/2, 2 cells down and an octave down) is ((Q−1)/2 − 3, R+2).
 *  - Chromatic, Q = 4k + j: j=0 the original (k, R); j=1 its m2 above,
 *    (k+2, R−1); j=2 the Wicki-Hayden copy (k−3, R+2); j=3 the original's m3
 *    above, (k−1, R+1). Odd j is the cell at (Q−5, R−1) up an exact octave. */
export function eulerOf(q: number, r: number, mapping: Mapping): EulerCell {
  if (mapping === 'euler') return { q, r };
  if (mapping === 'wickiHayden') {
    const k = Math.floor(q / 2);
    return q === 2 * k ? { q: k, r } : { q: k - 3, r: r + 2 };
  }
  const k = Math.floor(q / 4);
  switch (q - 4 * k) {
    case 0: return { q: k, r };
    case 1: return { q: k + 2, r: r - 1 };
    case 2: return { q: k - 3, r: r + 2 };
    default: return { q: k - 1, r: r + 1 };
  }
}

/** The cell in `mapping` holding Euler cell (q, r): its original column,
 *  (4/COLUMN_STEP)·q. Exact in every mode (Euler → frame conversion). */
export function fromEuler(q: number, r: number, mapping: Mapping): [number, number] {
  return [(4 / COLUMN_STEP[mapping]) * q, r];
}

/** Octave band of column q: floor((q + W/3) / W) with W = bandWidth —
 *  floor((q+1)/3) Euler, floor((Q+2)/6) Wicki-Hayden, floor((Q+4)/12)
 *  chromatic. Every key is 2:1 (Schismatic: 2:1 + schisma) above the key one
 *  band-width to its left. This is the SPATIAL band: seams, position in band,
 *  the reference spine, the S/Y anchor and the Schismatic schisma count all
 *  use it. */
export function bandOfCell(q: number, mapping: Mapping): number {
  const w = bandWidth(mapping);
  return Math.floor((q + w / 3) / w);
}

/** Position of column q within its band, 0 … W−1; A3's column (qm0) is W/3. */
export function posInBandOf(q: number, mapping: Mapping): number {
  const w = bandWidth(mapping);
  return (((q + w / 3) % w) + w) % w;
}

/** The band whose Syntonic / Polysyntonic offset column q carries. A chromatic
 *  new column is an unadjusted copy of (Q−5, R−1), so it keeps that column's
 *  band — one band lower for F# and G# (positions 1 and 3), its own otherwise.
 *  Every other column carries its own band. Read only by the S/Y band term. */
export function pitchBandOf(q: number, mapping: Mapping): number {
  return bandOfCell(mapping === 'chromatic' && q % 2 !== 0 ? q - 5 : q, mapping);
}

/** Unbanded, a band step is a 12-fifth respelling, not an octave: the spelled
 *  octave is (−1, 2) in Wicki-Hayden, (−2, 2) in chromatic, and Euler has none
 *  (docs/architecture.md → Unbanded layout). */
const UNBANDED_OCTAVE: Readonly<Record<Mapping, readonly [number, number] | null>> = {
  euler: null,
  wickiHayden: [-1, 2],
  chromatic: [-2, 2],
};

/** The spelled-octave vector of `mapping`'s frame — the step to the same
 *  spelled note one octave up: the band step (W, 0) banded, UNBANDED_OCTAVE
 *  unbanded (null: the frame has none). */
export function octaveVector(mapping: Mapping, banded: boolean): readonly [number, number] | null {
  return banded ? [bandWidth(mapping), 0] : UNBANDED_OCTAVE[mapping];
}

/** Euler lattice vector (dq, dr) expressed in `mapping`: the q component
 *  scales by 4/COLUMN_STEP. That preserves the column's class (q mod 2 under
 *  Wicki-Hayden, q mod 4 under chromatic), so the offset means the same Euler
 *  step from every column. */
export function vecFromEuler(dq: number, dr: number, mapping: Mapping): [number, number] {
  return [(4 / COLUMN_STEP[mapping]) * dq, dr];
}

/** Re-express cell (q, r) of mapping `from` in mapping `to` — the frame
 *  conversion (Composer retune, the bridge, cross-score paste). The frames nest
 *  (Euler ⊂ Wicki-Hayden ⊂ chromatic, q scaling by the column-step ratio), so a
 *  cell that exists in `to` maps to that same cell, exact in every mode; any
 *  other cell goes through its Euler-equivalent — exact in every band-uniform
 *  mode, a schisma or a comma away in V/S/Y. Identity when the mappings agree. */
export function convertCell(q: number, r: number, from: Mapping, to: Mapping): [number, number] {
  if (from === to) return [q, r];
  const nested = (q * COLUMN_STEP[from]) / COLUMN_STEP[to];
  if (Number.isInteger(nested)) return [nested, r];
  const e = eulerOf(q, r, from);
  return fromEuler(e.q, e.r, to);
}
