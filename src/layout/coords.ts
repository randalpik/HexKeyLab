// Pure lattice coordinate helpers.
// q-axis is major thirds (5:4); r-axis is fifths (3:2). Bands are 3 keys wide along q.

export function bandOf(q: number): number { return Math.floor((q + 1) / 3); }
export function posInBand(q: number): number { return ((q + 1) % 3 + 3) % 3; }
