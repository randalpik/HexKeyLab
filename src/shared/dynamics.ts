// Dynamic markings ↔ MIDI velocity. Pure data, shared between HKL (audio
// engine, MIDI out, recording fallbacks) and HKC (score-playback dynamic
// resolution, setup dialog). No imports, no side effects.
//
// Values calibrated to the audio-stage curve in DEFAULT_CAL
// (floor=0.03, ceiling=1.00, γ=13.9 — see docs/decisions.md
// "Velocity calibration final form"). Approximate dB at each mark, relative
// to fff=0 dB:
//   fff 127   0 dB
//   ff  124  −3 dB
//   f   120  −7 dB    (QWERTY / mouse-click anchor)
//   mf  116 −11 dB    (default playback / no-marking anchor)
//   mp  112 −14 dB
//   p   108 −18 dB
//   pp  103 −22 dB
//   ppp  96 −26 dB    (4 dB above the curve floor; below this the curve
//                      asymptotes and lower velocity values stop sounding
//                      audibly softer)

/** Loudest → softest order, matching Finale's Shift+1..Shift+8 entry order. */
export const DYNAMIC_NAMES: ReadonlyArray<string> = ['fff', 'ff', 'f', 'mf', 'mp', 'p', 'pp', 'ppp'];

export const DEFAULT_DYNAMIC_MAP: Readonly<Record<string, number>> = Object.freeze({
  fff: 127, ff: 124, f: 120, mf: 116, mp: 112, p: 108, pp: 103, ppp: 96,
});
