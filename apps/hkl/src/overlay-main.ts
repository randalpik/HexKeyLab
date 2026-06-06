// Entry point for the lean OBS-overlay build (vite.overlay.config.ts → dist-overlay/).
//
// Unlike src/main.ts (which conditionally imports the full app OR the overlay
// subscriber), this entry imports ONLY the subscriber — so its bundle excludes
// the audio engine, MIDI, sample loading, recording, and the toolbar. It's what
// the standalone distributable (apps/overlay-host) serves to OBS's CEF.
//
// overlay-subscribe.ts does everything at module load (adds html.overlay, goes
// transparent, connects the WebSocket, renders), so this is a one-line entry.

import './bridge/overlay-subscribe.js';
