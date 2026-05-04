// Tuning-mode state. Mutate `tuning.x` directly from any module; importers
// see the updated value because the const reference is shared.

export const tuning = {
  curLayout: 1,
  septimalEnabled: false,
  equalEnabled: false,
  septimalShift: 0,
  /* band width: alternating A/B regions along lattice r axis (constant) */
  septimalW: 3,
};
