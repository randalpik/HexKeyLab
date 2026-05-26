// HKL ↔ Analyzer bridge protocol — same shape as src/bridge/protocol.ts but
// for the second same-origin client (the user-facing Analyzer UI). Carried
// over a separate BroadcastChannel('hkl-analyzer-bridge') so Analyzer messages
// don't have to be filtered out of HKL's Composer dispatch (and vice-versa).
//
// Direction conventions:
//   AnalyzerEvent     — Analyzer announces / commands; HKL receives.
//   HklAnalyzerEvent  — HKL announces / acks; Analyzer receives.
//
// Messages are POJOs (structured-cloneable). The `import-cdn-config` event
// inlines the full CdnInstrumentConfig (~few KB typical) — small enough to
// ride through structured clone without IDB indirection. The `import-hki`
// event carries only the instrument key — the bundle bytes were already
// written by Analyzer into the shared `hkl-instrument-registry` IDB before
// this message was sent; HKL reads them via InstrumentRegistry.reload().

import type { CdnInstrumentConfig } from '../shared/cdnConfig.js';

export const ANALYZER_CHANNEL_NAME = 'hkl-analyzer-bridge';
export const ANALYZER_PROTOCOL_VERSION = 1;

/* ── Analyzer → HKL ────────────────────────────────────────────────────────── */

export type AnalyzerEvent =
  /** Sent on Analyzer load. HKL responds with hkl-hello. */
  | { type: 'analyzer-hello'; version: number }
  /** Sent on Analyzer unload (best-effort). */
  | { type: 'analyzer-bye' }
  /** Analyzer ships the .hki bytes inline. HKL calls
   *  InstrumentRegistry.importBundle() on receive (same path as its
   *  `+ .hki` file picker). Structured clone handles Uint8Array — typical
   *  bundles are 10–50 MB, transfer cost is negligible.
   *  (Kept on the message boundary instead of via shared IDB to keep
   *  src/analyzer/ from importing src/state/.) */
  | { type: 'import-hki'; instrumentKey: string; bytes: Uint8Array }
  /** Analyzer built a CDN-source instrument config. HKL writes it directly
   *  to cdnConfigRegistry.importConfig(); the INSTRUMENTS proxy will resolve
   *  the key thereafter. */
  | { type: 'import-cdn-config'; instrumentKey: string; config: CdnInstrumentConfig };

/* ── HKL → Analyzer ────────────────────────────────────────────────────────── */

export type HklAnalyzerEvent =
  /** Sent on HKL load, and in response to analyzer-hello. */
  | { type: 'hkl-hello'; version: number }
  /** Sent on HKL unload (best-effort). */
  | { type: 'hkl-bye' }
  /** Per-import acknowledgement. `ok:false` carries an error string the
   *  Analyzer surfaces in its status bar. */
  | { type: 'import-ack'; instrumentKey: string; ok: boolean; error?: string };

export type AnalyzerBridgeMessage = AnalyzerEvent | HklAnalyzerEvent;
