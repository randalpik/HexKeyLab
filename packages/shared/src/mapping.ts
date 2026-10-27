// Note-name mapping: how lattice coordinates are arranged on the hex grid.
//
//   'euler'        the Harmonic-Table lattice: q = major thirds, r = fifths,
//                  3-wide octave bands (docs/architecture.md → Tuning system).
//   'wickiHayden'  after every fifths column, a column holding the same notes
//                  shifted down 2 cells and exactly one octave — rows step in
//                  whole tones, bands are 6 wide (docs/architecture.md → Note-name mapping).
//
// A cell's coordinates are its own in its mapping; the mapping is part of the
// coordinate frame, like the tuning mode. Every Wicki-Hayden cell has an
// Euler-EQUIVALENT cell with the same name, spelled octave, nominal MIDI and —
// except a Schismatic copy, one schisma higher — the same pitch. The
// mapping-aware primitives (freq.ts, notes.ts, heji.ts) resolve through it.
//
// Wicki-Hayden column order within a 6-band, by ((Q+2) mod 6):
//   0 qm2 · 1 qm2′ · 2 qm0 · 3 qm0′ · 4 qm1 · 5 qm1′      (′ = copy column)
// A3 sits at (0,0) (qm0) in both mappings.

export type Mapping = 'euler' | 'wickiHayden';

export const MAPPINGS: ReadonlyArray<Mapping> = ['euler', 'wickiHayden'];

export function isMapping(x: unknown): x is Mapping {
  return x === 'euler' || x === 'wickiHayden';
}

export interface EulerCell {
  q: number;
  r: number;
  /** A Wicki-Hayden copy column (odd Q). Always false under 'euler'. */
  copy: boolean;
}

/** Euler-equivalent of cell (q, r) under `mapping`. Wicki-Hayden: an even
 *  column Q is Euler column Q/2; an odd column (a copy of column (Q−1)/2,
 *  2 cells down and an octave down) is ((Q−1)/2 − 3, R + 2). This is also
 *  the Wicki-Hayden → Euler frame conversion: exact in every mode except
 *  Schismatic copies, which land one schisma (≈1.95¢) lower. */
export function eulerOf(q: number, r: number, mapping: Mapping): EulerCell {
  if (mapping === 'euler') return { q, r, copy: false };
  const k = Math.floor(q / 2);
  return q === 2 * k ? { q: k, r, copy: false } : { q: k - 3, r: r + 2, copy: true };
}

/** The cell in `mapping` holding Euler cell (q, r): under Wicki-Hayden its
 *  original column (2q, r). Exact in every mode (Euler → frame conversion). */
export function fromEuler(q: number, r: number, mapping: Mapping): [number, number] {
  return mapping === 'euler' ? [q, r] : [2 * q, r];
}

/** The column cell a Wicki-Hayden copy was taken from — one octave ABOVE the
 *  copy, in the same 6-band. A copy keeps its column's colour (in Schismatic
 *  the hue encodes the band's schisma count, which the copy shares). Identity
 *  for originals and under 'euler'. */
export function columnSourceOf(q: number, r: number, mapping: Mapping): [number, number] {
  if (mapping === 'euler') return [q, r];
  const k = Math.floor(q / 2);
  return q === 2 * k ? [k, r] : [k, r + 2];
}

/** Octave band of column q: 3-wide under 'euler' (floor((q+1)/3)), 6-wide
 *  under 'wickiHayden' (floor((Q+2)/6)). Every key is 2:1 (Schismatic: 2:1 +
 *  schisma) above the key one band-width to its left. */
export function bandOfCell(q: number, mapping: Mapping): number {
  return mapping === 'euler' ? Math.floor((q + 1) / 3) : Math.floor((q + 2) / 6);
}

/** Euler lattice vector (dq, dr) expressed in `mapping`. Under Wicki-Hayden
 *  the q component doubles; that preserves column parity, so the offset means
 *  the same Euler step from originals and copies alike. */
export function vecFromEuler(dq: number, dr: number, mapping: Mapping): [number, number] {
  return mapping === 'euler' ? [dq, dr] : [2 * dq, dr];
}

/** Re-express cell (q, r) of mapping `from` in mapping `to` — the frame
 *  conversion (Composer retune, the bridge, cross-score paste). Exact in every
 *  mode except a Schismatic Wicki-Hayden copy going to Euler, which lands one
 *  schisma lower. Identity when the mappings agree. */
export function convertCell(q: number, r: number, from: Mapping, to: Mapping): [number, number] {
  if (from === to) return [q, r];
  const e = eulerOf(q, r, from);
  return fromEuler(e.q, e.r, to);
}
