// Expression pedal calibration + runtime routing state.
//
// CMD 38h (Lumatone CALIBRATE_EXPRESSION_PEDAL) puts the firmware into a mode
// where it emits spontaneous CMD 3Eh status packets every ~100ms with the
// running ADC min/max bounds + a "valid" flag. Stopping calibration commits
// the bounds to firmware. CC 4 is the runtime expression-pedal output (hardcoded
// in firmware, not user-configurable); CC 64 is the sustain jack (binary).
//
// `mode` decides what CC 64 means: 'sustain' (CC 64 = binary damper, default
// for users without a continuous expression pedal) or 'sostenuto' (CC 64 =
// binary sostenuto, when an expression pedal is providing continuous damper
// on CC 4). cc4Depth/cc64Depth are kept separately so setDamperDepth can
// combine them via max().

export const pedal: {
  /** true while CMD 38h is in "on" state */
  calibrating: boolean;
  /** verbose console logging — auto-on during cal */
  debug: boolean;
  /** last reported ADC min from CMD 3Eh */
  lastMin: number | null;
  /** last reported ADC max from CMD 3Eh */
  lastMax: number | null;
  /** last "valid" flag from CMD 3Eh */
  lastValid: number | null;
  /** count of 3Eh packets received this session */
  packetCount: number;
  /** most recent CC 4 (expression pedal) value */
  lastCC4Value: number | null;
  /** timestamp of last CC 4 (for rate calc) */
  lastCC4Time: number;
  /** how the sustain jack is interpreted */
  mode: 'sustain' | 'sostenuto';
  /** last CC 4 value, normalized to 0..1 */
  cc4Depth: number;
  /** last CC 64 value mapped to 0 or 1 (sustain mode only) */
  cc64Depth: number;
  /** raw last CC 64 byte — used to re-evaluate when mode flips mid-press */
  lastCC64Value: number | null;
} = {
  calibrating: false,
  debug: false,
  lastMin: null,
  lastMax: null,
  lastValid: null,
  packetCount: 0,
  lastCC4Value: null,
  lastCC4Time: 0,
  mode: 'sustain',
  cc4Depth: 0,
  cc64Depth: 0,
  lastCC64Value: null,
};
