// Tuning-mode state. Mutate `tuning.x` directly from any module; importers
// see the updated value because the const reference is shared.
//
// `mode` is the canonical source of truth. `equalEnabled` / `septimalEnabled`
// are derived booleans (true iff mode === 'E' / '7' respectively), kept in
// lockstep by setTuning() in ui/controls.ts so legacy callers that only ask
// the binary question continue to work unchanged.

import type { TuningMode, Mapping } from './persistence.js';

export const tuning = {
  mode: '5' as TuningMode,
  /* Note-name mapping, orthogonal to `mode`: the coordinate frame every
     KeyId / (q, r) is interpreted in (@hkl/shared/mapping.js). Set by
     setMapping() in ui/controls.ts. */
  mapping: 'euler' as Mapping,
  septimalEnabled: false,
  equalEnabled: false,
  /* band width: alternating A/B regions along lattice r axis (constant) */
  septimalW: 3,
  /* HEJI display toggle — when on, lattice cell labels decorate the
     letter+accidental with syntonic-comma arrows / septimal-comma hooks
     drawn from Bravura. Persisted in PrefsV1. */
  hejiEnabled: false,
};
