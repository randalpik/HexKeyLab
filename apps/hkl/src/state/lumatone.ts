// Lumatone sync state (the user-facing "auto-sync" + cached device colors).
//
// Note: SysEx queue/in-flight/timer state lives inside lumatone/sysex.ts as
// private encapsulated state — not here. Only state that other modules need
// to read/write directly belongs here.

/** Built-in key / aftertouch calibration phase (lumatone/keycal.ts is the only
 *  writer). 'unknown' = the device was found in a calibration mode HKL did not
 *  start. Anything but 'idle' means the device answers STATE to every command
 *  except the calibration end, so color sync sends nothing. */
export type KeyCalPhase = 'idle' | 'starting' | 'key' | 'aftertouch' | 'unknown' | 'ending';

export const lumatone: {
  /** user's Auto-sync checkbox state */
  autoSyncEnabled: boolean;
  /** 280-length array of '#RRGGBB' or null for unknown */
  deviceColors: (string | null)[] | null;
  /** true after CHANGE_KEY_NOTE × 280 + flags sent this connection */
  fixedLayoutSent: boolean;
  /** [major, minor, revision] from the connect-time firmware query; null until it answers */
  firmware: number[] | null;
  /** user's Key effects checkbox: show the canvas's per-key effects on the device —
   *  the hover lightening, and the dimming of invalid refs while the ref-edit
   *  modifier is held (frame sync only) */
  keyEffects: boolean;
  /** built-in calibration phase; see KeyCalPhase */
  keyCal: KeyCalPhase;
} = {
  autoSyncEnabled: false,
  deviceColors: null,
  fixedLayoutSent: false,
  firmware: null,
  keyEffects: false,
  keyCal: 'idle',
};
