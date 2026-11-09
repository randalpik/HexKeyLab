// Lumatone sync state (the user-facing "auto-sync" + cached device colors).
//
// Note: SysEx queue/in-flight/timer state lives inside lumatone/sysex.ts as
// private encapsulated state — not here. Only state that other modules need
// to read/write directly belongs here.

export const lumatone: {
  /** user's Auto-sync checkbox state */
  autoSyncEnabled: boolean;
  /** 280-length array of '#RRGGBB' or null for unknown */
  deviceColors: (string | null)[] | null;
  /** true after CHANGE_KEY_NOTE × 280 + flags sent this connection */
  fixedLayoutSent: boolean;
  /** [major, minor, revision] from the connect-time firmware query; null until it answers */
  firmware: number[] | null;
} = {
  autoSyncEnabled: false,
  deviceColors: null,
  fixedLayoutSent: false,
  firmware: null,
};
