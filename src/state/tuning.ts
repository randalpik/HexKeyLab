// Tuning-mode state. Mutate `tuning.x` directly from any module; importers
// see the updated value because the const reference is shared.

export const tuning = {
  curLayout: 1,
  septimalEnabled: false,
  equalEnabled: false,
  septimalShift: 0,
  /* band width: alternating A/B regions along lattice r axis (constant) */
  septimalW: 3,
  /* QWERTY-only transpose, integer in [-3, 3]. Each step shifts the QWERTY
     slab by (+2q, -r) — one chromatic semitone (25:24, 1 step in 12-TET).
     Applies on top of layoutShifts[curLayout] for input mapping and outline
     position. Lumatone, MIDI-out, and selection are unaffected. */
  qwertyTranspose: 0,
};
