// HKL ↔ Composer bridge protocol — single source of truth for the cross-tab
// message boundary. Both sides import these types and the channel name.
//
// Direction conventions:
//   HklEvent      — HKL announces / responds; Composer receives.
//   ComposerEvent — Composer requests / commands; HKL receives.
//
// Messages are POJOs (structured-cloneable). No methods, no Dates, no class
// instances — they cross the BroadcastChannel and must survive structuredClone.

import type { VoiceCursorAnchor } from '@hkl/shared/cursor-geom.js';
export type { VoiceCursorAnchor };

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
  /** Notehead color, hex '#rrggbb'. Pre-darkened for paper readability —
   *  the ink-on-white variant, used as the notehead color in light theme. */
  colorHex: string;
  /** Notehead color, hex '#rrggbb' — HKL's bright "light source" lattice
   *  variant (the on-screen palette). Used as the notehead color in dark
   *  theme, where the ink variant would be too dark to read on a dark
   *  background. Composer bakes this alongside `colorHex` so a themed render
   *  can pick the readable variant without re-deriving it from (q, r). */
  lightColorHex: string;
  /** MIDI velocity 0..127 (most recent strike). */
  velocity: number;
}

/** A coordinate-only reference to a key on HKL's lattice. Used for playback
 *  commands where HKL re-resolves the current tuning's frequency. */
export interface CoordRef { q: number; r: number; }


/** A single scheduled chord in a playback queue. An empty `notes` array
 *  represents a silent rest pulse — HKL skips audio dispatch but still
 *  acks `playback-position` with `meiId` at `atMs`, so Composer's per-voice
 *  cursor advances through rests. */
export interface PlaybackEvent {
  /** Onset time relative to playback start, in milliseconds. */
  atMs: number;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Notes in the chord, by lattice coord. Empty array = silent rest pulse. */
  notes: ReadonlyArray<CoordRef>;
  /** Optional MEI id so HKL can echo a playback-position back keyed to it. */
  meiId?: string;
  /** Optional MIDI velocity (0..127). When set, HKL uses this for noteOn
   *  instead of the falling-back per-key value. Composer's playback walker
   *  computes this from the document's dynamics + hairpin interpolation. */
  velocity?: number;
  /** Composer voice (1..4) that emitted this attack. Lets HKL group a voice's
   *  attacks into a sequence so slurs can connect consecutive notes. */
  voice?: number;
  /** True when this attack is joined under a slur to the NEXT attack in the
   *  same voice. HKL realizes the join per the active instrument: a brief
   *  pitch glide (one continuous voice) for replay-on-transpose:false
   *  instruments, or a slight note-proportional overlap for the rest
   *  (decay + replay-on-transpose). */
  slurredToNext?: boolean;
  /** Sample-set key of the instrument this attack belongs to (multi-instrument
   *  scores). When set and loaded, HKL plays this attack with that instrument's
   *  timbre; absent ⇒ HKL falls back to its current active instrument (the
   *  historic single-instrument behavior). */
  instrumentKey?: string;
}

/** A sustain-pedal transition in a playback timeline. HKL maps `dir` to the
 *  damper engine (down → hold released notes in audio.sustainedKeys; up →
 *  release them) and mirrors it to external MIDI as CC 64 (down=127, up=0).
 *  Anchored by `atMs` on the same playback clock as PlaybackEvent. */
export interface PedalEvent {
  /** Onset time relative to playback start, in milliseconds. */
  atMs: number;
  /** Pedal transition direction. */
  dir: 'down' | 'up';
  /** Sample-set key of the grand-staff instrument this pedal belongs to. HKL
   *  captures only that instrument's note-offs (per-instrument damper). Absent
   *  ⇒ applies globally (single-instrument behavior). */
  instrumentKey?: string;
}

/** Compact footprint cell tuple: [q, r, colorHex, lightColorHex]. Used by
 *  footprint-changed to ship the full active layout outline + per-cell colors
 *  in one message. `colorHex` is the ink-on-white variant (light theme);
 *  `lightColorHex` is the bright lattice variant (dark theme). Compact-array
 *  form (vs object form) cuts payload across the ~280-cell Lumatone footprint. */
export type FootprintCell = readonly [number, number, string, string];

/* ── HKL → Composer ───────────────────────────────────────────────────────── */

export type HklEvent =
  /** Sent on HKL load, and in response to composer-hello / request-state. */
  | { type: 'hkl-hello'; version: number }
  /** Sent on HKL unload (best-effort). */
  | { type: 'hkl-bye' }
  /** Currently-held keys, fully resolved. Fires on every change. */
  | { type: 'held-keys'; keys: ReadonlyArray<ResolvedNote> }
  /** Playback advance ack. meiId is the MEI element id of the chord now
   *  sounding; null when finished (clears all bars). When meiId is null AND
   *  `voice` is set, it clears ONLY that voice's bar — emitted at a voice's
   *  last note's written end so a voice that stops before the score ends
   *  doesn't leave an orphaned bar stuck for the rest of playback. */
  | { type: 'playback-position'; meiId: string | null; voice?: number; timeMs: number }
  /** Playback queue exhausted. */
  | { type: 'playback-finished' }
  /** Tuning state changed (informational; Composer can update status text). */
  | { type: 'tuning-changed'; mode: string; description: string }
  /** Full HKL layout state: tuning mode + ref-note (q, r). Sent on handshake
   *  and whenever either field changes. Distinct from `tuning-changed` (which
   *  carries only the mode + human description for status text) — this message
   *  exists so Composer can mirror HKL's full layout when opening a blank
   *  score, and so the match indicator can re-check on ref changes (which
   *  don't fire `tuning-changed`). */
  | { type: 'hkl-layout-state'; tuningMode: string; refQ: number; refR: number }
  /** Active layout outline + per-cell color, broadcast whenever the footprint
   *  composition or colors change (layout switch, outline mode change, QWERTY
   *  transpose, tuning toggle). Composer uses this to validate SC shifts
   *  against the outline AND to compute fresh colors when a note's (q, r)
   *  is rewritten. Empty `cells` means outline='none' — no constraint. */
  | { type: 'footprint-changed'; cells: ReadonlyArray<FootprintCell> }
  /** Import a whole score into Composer — the result of transcribing an HKL
   *  recording. `mei` is a complete `.hkc` (MEI 5) document string. Composer
   *  confirms-if-dirty, then replaceDocument(mei) + re-render + adopts the
   *  score's layoutReq. One-directional (HKL→Composer); the file-download
   *  transport carries the same string. */
  | { type: 'import-score'; mei: string };

/* ── Composer → HKL ───────────────────────────────────────────────────────── */

export type ComposerEvent =
  /** Sent on Composer load. HKL responds with hkl-hello. */
  | { type: 'composer-hello'; version: number }
  /** Sent on Composer unload. */
  | { type: 'composer-bye' }
  /** Ask HKL to re-broadcast hkl-hello + current held-keys + tuning. */
  | { type: 'request-state' }
  /** Play a sequence of chords with HKL-driven timing. HKL will broadcast
   *  playback-position events as it advances. `pedalEvents`, when present,
   *  is the parallel sustain-pedal timeline (down/up transitions on the same
   *  atMs clock); HKL drives its damper engine + external CC 64 from it. */
  | { type: 'play-score'; events: ReadonlyArray<PlaybackEvent>; pedalEvents?: ReadonlyArray<PedalEvent> }
  /** Stop any in-progress playback. */
  | { type: 'stop-playback' }
  /** Set the SELECTION tier of HKL's reference-note state to (q, r). Composer
   *  derives this from its cursor position: most-recent-prior note or chord
   *  bass. Composer broadcasts ONLY when such a prior note exists; if the
   *  voice has no prior note Composer stays silent (it must not clear,
   *  otherwise a key-sig-change broadcast cycle would blow away a manual
   *  Ctrl+click selection the user just made). Tier clearing happens only on
   *  HKL via Ctrl+click of the current ref or via composer-bye. */
  | { type: 'set-reference-note'; q: number; r: number }
  /** Set the SONG-KEY tier of HKL's reference-note state to (q, r) — the
   *  lattice cell whose noteName matches the major-key tonic of the current
   *  key signature, closest to the origin by taxicab. Composer sends this
   *  on connect / hello / request-state, and whenever the key signature
   *  changes (Setup dialog apply). Not sent on every cursor move — see
   *  set-reference-note docstring for why broadcasting must be conservative. */
  | { type: 'set-song-key'; q: number; r: number }
  /** Inform HKL of the score's pinned layout requirement. Sent on
   *  composer-hello / request-state and whenever the user saves Setup. HKL
   *  caches this and uses it to gate playback (prompt on mismatch). When
   *  HKL's "Sync to Composer" toggle is on, HKL aggressively applies this
   *  layout on receipt; otherwise it's informational until the user takes
   *  an action that requires the layouts to match. tuningMode is the hard
   *  gate (it determines (q,r)→Hz). refQ/refR are informational — they only
   *  affect physical-key→(q,r) mapping during entry, not playback frequency. */
  | { type: 'layout-req-changed'; tuningMode: string; refQ: number; refR: number }
  /** Tell HKL to apply this layout immediately. Sent by Composer after the
   *  user confirms an entry-side mismatch prompt with "Apply". Distinct from
   *  layout-req-changed: that one is informational (apply only if Sync is on);
   *  this one is an explicit user-driven command. HKL switches tuning + ref
   *  and emits tuning-changed so Composer can re-check and unblock entry. */
  | { type: 'apply-layout'; tuningMode: string; refQ: number; refR: number }
  /** The instrument (sample-set key) the Composer editing cursor currently sits
   *  in. Sent on cursor moves between instruments in voice mode (multi-instrument
   *  scores). When HKL's "Sync to Composer" toggle is on, HKL switches its active
   *  playback instrument to this so note-entry preview is heard in the correct
   *  timbre; otherwise it's ignored. Absent instrumentKey ⇒ the score's single
   *  instrument (no follow needed). */
  | { type: 'composer-active-instrument'; instrumentKey: string }
  /** The distinct instrument (sample-set) keys of EVERY instrument in the
   *  score. Sent on connect and whenever the instrument set changes (add /
   *  remove / reorder). When Sync-to-Composer is on, HKL proactively loads them
   *  all so cursor-follow during note entry is always ready in the right
   *  timbre. Empty for single-instrument scores (no per-instrument follow). */
  | { type: 'composer-instruments'; instrumentKeys: ReadonlyArray<string> }
  /** The current single-instrument MEI of the instrument the editing cursor
   *  sits in — the score HKL renders in its read-only "Composer view" frame.
   *  Composer serializes only the cursor instrument's staves (grand staff is
   *  the target; multi-instrument scores degrade to showing the one part at
   *  the cursor). Re-sent only when the document or the cursor instrument
   *  changes (signature-gated), not on every cursor move. */
  | { type: 'composer-score'; mei: string }
  /** The Composer editing cursors, so HKL's Composer-view frame can auto-scroll
   *  to follow live composition AND draw read-only per-voice cursor bars. One
   *  `CursorBar` per in-use voice (each bar spans only ITS staff, not the whole
   *  grand staff): `anchorId` + `edge` give the horizontal position (the bar
   *  sits at the left/right edge of that element — a note/chord/rest/tuplet/
   *  measure), and `staffId` gives the vertical extent (the voice's `<staff>`).
   *  All ids are resolved in HKL's OWN render of the same MEI, so positions are
   *  exact regardless of scale/justification. `voice` is the active editing
   *  voice (highlighted + scroll target); `meiId`/`measureIdx` are its measure
   *  (scroll target). Throttled / diff-gated. The playback head needs no
   *  message — HKL drives playback and already knows the sounding meiId. */
  | { type: 'composer-cursor'; meiId: string | null; measureIdx: number; voice: number; anchor: VoiceCursorAnchor };

export type BridgeMessage = HklEvent | ComposerEvent;
