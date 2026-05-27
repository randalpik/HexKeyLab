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
//
// `recentEvents` is a ring buffer for diagnosing the intermittent stuck-sustain
// bug: every CC 4 / CC 64 message pushes an entry so that, when the bug shows
// up, the user can dump the tail and check whether a release message ever
// arrived. `dumpRecent` and `clear` are attached at runtime by ui/pedalHud
// (they need access to the audio engine which would otherwise cycle imports).

export interface PedalEvent {
  /** performance.now() at push time */
  t: number;
  /** which CC — 4 (expression) or 64 (sustain) */
  cc: 4 | 64;
  /** raw 0..127 byte */
  value: number;
  /** 1-indexed MIDI channel */
  ch: number;
  /** combined damper depth (max of cc4/cc64) AFTER applying this event */
  depthAfter: number;
}

/** Cap on the ring buffer — 100 messages is roughly the last 10–20 seconds of
 * pedal activity even under fast actuation. */
const RECENT_EVENTS_CAP = 100;

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
  /** ring buffer of recent pedal CC messages; tail is most recent */
  recentEvents: PedalEvent[];
  /** Attached by ui/pedalHud at app boot. Console helper that prints the
   * tail of recentEvents in a human-readable table. */
  dumpRecent?: (n?: number) => void;
  /** Attached by ui/pedalHud at app boot. Console helper / live workaround
   * that forces cc4Depth and cc64Depth to 0, fires the release loop, and
   * clears any sostenuto lock. */
  clear?: () => void;
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
  recentEvents: [],
};

/** Push a CC 4 / CC 64 event onto the ring buffer. Called from the MIDI
 * handler on every relevant message. depthAfter should be the combined
 * damper depth AFTER the event was applied (max of cc4Depth/cc64Depth),
 * so that browsing the tail makes the state divergence obvious. */
export function pushPedalEvent(e: PedalEvent): void {
  pedal.recentEvents.push(e);
  if (pedal.recentEvents.length > RECENT_EVENTS_CAP) pedal.recentEvents.shift();
}
