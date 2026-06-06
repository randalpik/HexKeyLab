// OBS-overlay mirror protocol — the message boundary between the performing HKL
// instance (publisher) and a second HKL instance loaded as an OBS Browser
// Source (subscriber, ?overlay). Carried over a localhost WebSocket relay
// (apps/overlay-host) rather than the same-origin BroadcastChannel bridge,
// because the OBS Browser Source is a separate browser.
//
// HKL is the only node: it holds the lattice state natively AND the composer-
// frame state (mirrored from Composer over the BroadcastChannel bridge), and
// re-broadcasts both here. The composer-frame messages reuse the exact
// `composer-score` / `composer-playback` payload shapes from the bridge
// protocol (re-exported below) so there's a single source of truth.
//
// Pure data only — no DOM, no runtime — so @hkl/bridge stays import-safe.
// Outline / rotation / hex-size are HKL-app string enums; typed as `string`
// here (the app casts on apply) to avoid reaching into an app package.

/** Full lattice render state — everything the overlay needs to reproduce the
 *  hex lattice identically. Sent on publisher (re)connect and whenever any
 *  structural field changes. Live note highlights + view pan stream as the
 *  lighter `keys` / `view` deltas; this carries their current value too so a
 *  fresh snapshot is self-sufficient. */
export interface OverlaySnapshot {
  /** TuningMode ('E'|'5'|'P'|'D'|'7'|'V'). */
  tuning: string;
  /** HEJI accidentals enabled. */
  heji: boolean;
  /** Effective reference-note lattice coord. */
  refQ: number;
  refR: number;
  /** OutlineMode ('lumatone'|'qwerty'|'piano'|'none'). */
  outline: string;
  /** RotationMode. */
  rotation: string;
  /** HexSize preset. */
  hexSize: string;
  showNotes: boolean;
  showBands: boolean;
  extendPattern: boolean;
  /** HKL "Composer view" frame on (body.composer-view). */
  composerView: boolean;
  /** "Dark staff notation" on (body.staff-dark) — drives composer-frame theme. */
  staffDark: boolean;
  /** Static-outline lattice anchor + vertical offset. */
  kbAnchorQ: number;
  kbAnchorR: number;
  kbOffY: number;
  /** View center (lattice space). */
  viewQ: number;
  viewR: number;
  /** Currently-lit keys (selection.selectedKeys), as "q,r" KeyId strings. */
  litKeys: ReadonlyArray<string>;
}

/** A per-voice playback bar — mirrors `composer-playback`.bars in protocol.ts. */
export interface OverlayPlaybackBar {
  voice: number;
  meiId: string;
}

export type OverlayMsg =
  /** Full lattice render state (publisher → subscriber). */
  | { t: 'snapshot'; data: OverlaySnapshot }
  /** Lit-key set changed — full set each time (≤ a few dozen entries). */
  | { t: 'keys'; keys: ReadonlyArray<string> }
  /** View center / vertical offset changed (streams per-frame during tweens). */
  | { t: 'view'; viewQ: number; viewR: number; kbOffY: number }
  /** HKL "Composer view" frame toggled on/off. */
  | { t: 'composer-view'; on: boolean }
  /** Mirrored Composer score (single-instrument MEI) — same string Composer
   *  ships as `composer-score`.mei. Fed to composer-frame's setComposerScore. */
  | { t: 'composer-score'; mei: string }
  /** Mirrored Composer playback overlay — same shape as `composer-playback`.
   *  Fed to composer-frame's setComposerPlaybackBars. */
  | { t: 'composer-playback'; on: boolean; bars: ReadonlyArray<OverlayPlaybackBar> }
  /** Subscriber → relay: replay all retained state to me (post-reconnect). */
  | { t: 'request-snapshot' };

/** Default relay endpoint path, relative to the current origin. */
export const OVERLAY_WS_PATH = '/overlay-ws';

/** Default port the standalone overlay-host distributable listens on. A page
 *  loaded from a REMOTE origin (the production/Netlify performer) dials the
 *  local relay at ws://127.0.0.1:<this>; a locally-served page (dev-proxy or
 *  the distributable's own overlay) uses its same origin instead. MUST match
 *  the default PORT in apps/overlay-host/src/server.mjs. Overridable per-tab via
 *  localStorage.hklOverlayPort. */
export const OVERLAY_RELAY_PORT = 5190;
