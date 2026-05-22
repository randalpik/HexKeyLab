// Tuning-mode state. Mutate `tuning.x` directly from any module; importers
// see the updated value because the const reference is shared.

export const tuning = {
  curLayout: 1,
  septimalEnabled: false,
  equalEnabled: false,
  septimalShift: 0,
  /* band width: alternating A/B regions along lattice r axis (constant) */
  septimalW: 3,
  /* Septimal layout mode. 'global' = legacy global septimal-shift behavior
     (alternating A/B bands per septimalShift); used for the hidden
     '7-legacy' tuning option. 'uniform' = every qm=2 cell is B-d1-upper
     (the new '7' default), giving each Pythag-spine note its harmonic 7th
     two rows up in qm=2 — fully key-symmetric. Only meaningful when
     septimalEnabled. */
  septimalMode: 'global' as 'global' | 'uniform',
};
