// HexKeyLab — entry point.
//
// Normal mode: all wiring lives in ui/init.ts; pulling that in triggers the
// full bootstrap (audio init, MIDI access, canvas listeners, first paint,
// window-bridge for inline HTML handlers).
//
// ?overlay mode (OBS Browser Source): skip the full bootstrap entirely and load
// the passive overlay subscriber instead — transparent, chrome-free, render-
// only, driven by the WebSocket mirror. See bridge/overlay-subscribe.ts.

import { isOverlayMode } from './bridge/overlay-mode.js';

if (isOverlayMode()) {
  await import('./bridge/overlay-subscribe.js');
} else {
  await import('./ui/init.js');
}
