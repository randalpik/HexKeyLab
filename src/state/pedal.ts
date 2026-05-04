// Expression pedal calibration state.
// CMD 38h (Lumatone CALIBRATE_EXPRESSION_PEDAL) puts the firmware into a mode
// where it emits spontaneous CMD 3Eh status packets every ~100ms with the
// running ADC min/max bounds + a "valid" flag. Stopping calibration commits
// the bounds to firmware. CC 4 is the runtime expression-pedal output (hardcoded
// in firmware, not user-configurable).

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
} = {
  calibrating: false,
  debug: false,
  lastMin: null,
  lastMax: null,
  lastValid: null,
  packetCount: 0,
  lastCC4Value: null,
  lastCC4Time: 0,
};
