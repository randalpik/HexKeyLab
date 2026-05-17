// HKL ↔ Composer bridge protocol — single source of truth for the cross-tab
// message boundary. Both sides import these types and the channel name.
//
// Direction conventions:
//   HklEvent      — HKL announces / responds; Composer receives.
//   ComposerEvent — Composer requests / commands; HKL receives.
//
// Messages are POJOs (structured-cloneable). No methods, no Dates, no class
// instances — they cross the BroadcastChannel and must survive structuredClone.

export const CHANNEL_NAME = 'hkl-composer-bridge';
export const PROTOCOL_VERSION = 1;

/** A note as resolved by HKL: lattice coord + spelling + color + MIDI. */
export interface ResolvedNote {
  /** Lattice coord. Origin: A3 at (0, 0). */
  q: number;
  r: number;
  /** MEI pname letter (lowercase 'a'..'g'). */
  pname: 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g';
  /** MEI-style count-form accidental string. Examples:
   *    ''       — no accidental
   *    's'      — single sharp     'f'       — single flat
   *    'ss'     — double sharp     'ff'      — double flat
   *    'sss'    — triple sharp     'fff'     — triple flat
   *    'ssss'+  — quadruple+       'ffff'+   — quadruple+
   *    'n'      — explicit natural (with visible sign)
   *  Composer parses the count to an integer alter and emits canonical MEI
   *  glyph(s). HKL does NOT clamp at ±2; the full alteration reaches
   *  Composer so it can decompose into the right combination of x / ff /
   *  ts / tf glyphs (with multi-`<accid>` child stacking for ±4+). */
  accid: string;
  /** Scientific octave (middle C = 4). */
  oct: number;
  /** 12-TET nominal MIDI note = 57 + 4q + 7r. */
  midi: number;
  /** Notehead color, hex '#rrggbb'. Pre-darkened for paper readability. */
  colorHex: string;
  /** MIDI velocity 0..127 (most recent strike). */
  velocity: number;
}

/** A coordinate-only reference to a key on HKL's lattice. Used for playback
 *  commands where HKL re-resolves the current tuning's frequency. */
export interface CoordRef { q: number; r: number; }

/** A single scheduled chord in a playback queue. */
export interface PlaybackEvent {
  /** Onset time relative to playback start, in milliseconds. */
  atMs: number;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Notes in the chord, by lattice coord. */
  notes: ReadonlyArray<CoordRef>;
  /** Optional MEI id so HKL can echo a playback-position back keyed to it. */
  meiId?: string;
}

/* ── HKL → Composer ───────────────────────────────────────────────────────── */

export type HklEvent =
  /** Sent on HKL load, and in response to composer-hello / request-state. */
  | { type: 'hkl-hello'; version: number }
  /** Sent on HKL unload (best-effort). */
  | { type: 'hkl-bye' }
  /** Currently-held keys, fully resolved. Fires on every change. */
  | { type: 'held-keys'; keys: ReadonlyArray<ResolvedNote> }
  /** Playback advance ack. meiId is the MEI element id of the chord now
   *  sounding; null when between events or finished. */
  | { type: 'playback-position'; meiId: string | null; timeMs: number }
  /** Playback queue exhausted. */
  | { type: 'playback-finished' }
  /** Tuning state changed (informational; Composer can update status text). */
  | { type: 'tuning-changed'; mode: string; description: string };

/* ── Composer → HKL ───────────────────────────────────────────────────────── */

export type ComposerEvent =
  /** Sent on Composer load. HKL responds with hkl-hello. */
  | { type: 'composer-hello'; version: number }
  /** Sent on Composer unload. */
  | { type: 'composer-bye' }
  /** Ask HKL to re-broadcast hkl-hello + current held-keys + tuning. */
  | { type: 'request-state' }
  /** Play a sequence of chords with HKL-driven timing. HKL will broadcast
   *  playback-position events as it advances. */
  | { type: 'play-score'; events: ReadonlyArray<PlaybackEvent> }
  /** Stop any in-progress playback. */
  | { type: 'stop-playback' };

export type BridgeMessage = HklEvent | ComposerEvent;
