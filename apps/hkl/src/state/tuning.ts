// Tuning-mode state. Mutate `tuning.x` directly from any module; importers
// see the updated value because the const reference is shared.
//
// `mode` is the canonical source of truth. `equalEnabled` / `septimalEnabled`
// are derived booleans (true iff mode === 'E' / '7' respectively), kept in
// lockstep by setTuning() in ui/controls.ts so legacy callers that only ask
// the binary question continue to work unchanged.

import type { TuningMode, Mapping } from './persistence.js';

/** The key of the precomputed per-layout tables (VALID_REF_TABLE,
 *  PIANO_BOUNDS_TABLE): the picker's footprint differs banded and unbanded. */
export type Banding = 'banded' | 'unbanded';
export const BANDINGS: ReadonlyArray<Banding> = ['banded', 'unbanded'];
export function bandingOf(banded: boolean): Banding {
  return banded ? 'banded' : 'unbanded';
}

export const tuning = {
  mode: '5' as TuningMode,
  /* Note-name mapping, orthogonal to `mode`: the coordinate frame every
     KeyId / (q, r) is interpreted in (@hkl/shared/mapping.js). Set by
     setMapping() in ui/controls.ts. */
  mapping: 'euler' as Mapping,
  /* Home band for Syntonic / Polysyntonic (anchorOf in @hkl/shared/freq.js):
     the band of the anchor reference (manual selection ?? score-ref ??
     default A3 — never the composer-source selection). Recomputed by
     state/reference.ts; read by every pitch function, ignored by the other
     modes while banded. */
  anchor: 0,
  /* Banded layout (default). false = unbanded: every seam retuned to one of
     the mode's own in-band steps and each band respelled 12 fifths from the
     anchor's (coordExps / noteName in @hkl/shared). Persisted in PrefsV1. */
  banded: true,
  septimalEnabled: false,
  equalEnabled: false,
  /* band width: alternating A/B regions along lattice r axis (constant) */
  septimalW: 3,
  /* HEJI display toggle — when on, lattice cell labels decorate the
     letter+accidental with syntonic-comma arrows / septimal-comma hooks
     drawn from Bravura. Persisted in PrefsV1. */
  hejiEnabled: false,
};
