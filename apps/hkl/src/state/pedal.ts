// Expression pedal calibration + runtime routing state.
//
// CMD 38h (Lumatone CALIBRATE_EXPRESSION_PEDAL) puts the firmware into a mode
// where it emits spontaneous CMD 3Eh status packets every ~100ms with the
// running ADC min/max bounds + a "valid" flag. Stopping calibration commits
// the bounds to firmware. CC 4 is the runtime expression-pedal output (hardcoded
// in firmware, not user-configurable); CC 64 is the sustain jack (binary).
//
// Each jack has its own role (`roles`), chosen in its own dropdown: nothing, a
// sostenuto, a damper (Sustain), or the ref-edit modifier (Ctrl). `position` is
// where each pedal is; midi/pedals.ts derives from the two what each jack is
// doing and is the only writer of `roles`, `position` and the jacks' two
// `damper` entries.
//
// `damper` holds the damper depth every source contributes, one entry per
// writer so none can overwrite another's: the two jacks (when their role is
// Sustain), the piano-input device's own pedal (midi/piano.ts), Composer
// playback (bridge/hkl-side.ts) and recording playback (recording/playback.ts).
// The engine's damper depth is their max (audio/engine.ts setDamperDepth).
//
// `recentEvents` is a ring buffer for diagnosing the intermittent stuck-sustain
// bug: every CC 4 / CC 64 message pushes an entry so that, when the bug shows
// up, the user can dump the tail and check whether a release message ever
// arrived. `dumpRecent` and `clear` are attached at runtime by ui/pedalHud
// (they need access to the audio engine which would otherwise cycle imports).

/** What a pedal jack does. */
export type PedalRole = 'none' | 'sostenuto' | 'sustain' | 'ctrl';
/** Every role, in the order the dropdowns list them. */
export const PEDAL_ROLES: readonly PedalRole[] = ['none', 'sostenuto', 'sustain', 'ctrl'];
/** The Lumatone's two pedal jacks: expression (CC 4, continuous) and sustain
 *  (CC 64, binary). */
export type PedalJack = 'expr' | 'sus';
/** Everything that can hold the damper down. */
export type DamperSource = PedalJack | 'piano' | 'composer' | 'playback';

export interface PedalEvent {
  /** performance.now() at push time */
  t: number;
  /** which CC — 4 (expression) or 64 (sustain) */
  cc: 4 | 64;
  /** raw 0..127 byte */
  value: number;
  /** 1-indexed MIDI channel */
  ch: number;
  /** combined damper depth (max over every source) AFTER applying this event */
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
  /** what each jack does */
  roles: Record<PedalJack, PedalRole>;
  /** where each pedal is, 0..1: expr = CC 4 / 127 (a CC 4 of 0 or 1 reads as
   *  0), sus = 1 from CC 64 ≥ 64, else 0. Kept whatever the role, so a role
   *  changed mid-press is re-read from it. */
  position: Record<PedalJack, number>;
  /** damper depth each source contributes; the engine takes the max */
  damper: Record<DamperSource, number>;
  /** raw last CC 64 byte from the Lumatone, for the HUD */
  lastCC64Value: number | null;
  /** ring buffer of recent pedal CC messages; tail is most recent */
  recentEvents: PedalEvent[];
  /** Attached by ui/pedalHud at app boot. Console helper that prints the
   * tail of recentEvents in a human-readable table. */
  dumpRecent?: (n?: number) => void;
  /** Attached by ui/pedalHud at app boot. Console helper / live workaround
   * that forces both jacks and every damper source to released, fires the
   * release loop, and clears any sostenuto lock. */
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
  roles: { expr: 'sustain', sus: 'sustain' },
  position: { expr: 0, sus: 0 },
  damper: { expr: 0, sus: 0, piano: 0, composer: 0, playback: 0 },
  lastCC64Value: null,
  recentEvents: [],
};

/** Push a CC 4 / CC 64 event onto the ring buffer. Called from the MIDI
 * handler on every relevant message. depthAfter should be the combined
 * damper depth AFTER the event was applied (audio.damperDepth),
 * so that browsing the tail makes the state divergence obvious. */
export function pushPedalEvent(e: PedalEvent): void {
  pedal.recentEvents.push(e);
  if (pedal.recentEvents.length > RECENT_EVENTS_CAP) pedal.recentEvents.shift();
}
