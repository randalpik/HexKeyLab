// Dynamic markings ↔ MIDI velocity. Pure data, shared between HKL (audio
// engine, MIDI out, recording fallbacks) and HKC (score-playback dynamic
// resolution, setup dialog). No imports, no side effects.
//
// These are CANONICAL MUSICAL VELOCITIES (the same domain as keyVelocity post-
// refactor): a velocity here is mapped to audio gain by the gentle house curve
// (velocityCal, floor 0.05 / ceiling 1.0 / γ 1.5) at playback, and is sent
// unchanged to an external synth. The values were re-derived from the OLD map
// (which clustered at 96..127 because it was pre-corrected for the steep γ≈15.5
// audio curve) via v_new = houseCurve⁻¹(steepCurve(v_old)), so each mark's
// loudness through HKL's own audio is preserved while the velocities now span a
// natural musical range. Re-tune by ear if a mark feels off. Approx gain:
//   fff 127  0 dB        ff 101 −3 dB       f 74 −7 dB (QWERTY / mouse anchor)
//   mf  55 −10 dB (default/no-marking)      mp 42 −13 dB
//   p   33 −15 dB        pp 25 −18 dB       ppp 21 −19 dB

/** Loudest → softest order, matching Finale's Shift+1..Shift+8 entry order. */
export const DYNAMIC_NAMES: ReadonlyArray<string> = ['fff', 'ff', 'f', 'mf', 'mp', 'p', 'pp', 'ppp'];

export const DEFAULT_DYNAMIC_MAP: Readonly<Record<string, number>> = Object.freeze({
  fff: 127, ff: 101, f: 74, mf: 55, mp: 42, p: 33, pp: 25, ppp: 21,
});
