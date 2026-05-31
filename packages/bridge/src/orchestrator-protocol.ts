// HKL ↔ Orchestrator bridge protocol — the third same-origin client (the HKL
// Orchestrator UI, which samples a physical MIDI device into a velocity-layered
// .hki). Carried over a separate BroadcastChannel('hkl-orchestrator-bridge') so
// Orchestrator messages don't have to be filtered out of HKL's Composer/Analyzer
// dispatch (and vice-versa). Mirrors analyzer-protocol.ts.
//
// Direction conventions:
//   OrchestratorEvent     — Orchestrator announces / commands; HKL receives.
//   HklOrchestratorEvent  — HKL announces / acks; Orchestrator receives.
//
// The `import-hki` event inlines the full .hki bytes (structured-cloneable
// Uint8Array; orchestrator bundles are typically tens of MB). Same rationale as
// the Analyzer: keeps the producer app from importing HKL's src/state/.

export const ORCHESTRATOR_CHANNEL_NAME = 'hkl-orchestrator-bridge';
export const ORCHESTRATOR_PROTOCOL_VERSION = 1;

/* ── Orchestrator → HKL ──────────────────────────────────────────────────── */

export type OrchestratorEvent =
  /** Sent on Orchestrator load. HKL responds with hkl-hello. */
  | { type: 'orchestrator-hello'; version: number }
  /** Sent on Orchestrator unload (best-effort). */
  | { type: 'orchestrator-bye' }
  /** Orchestrator ships the built .hki bytes inline. HKL calls
   *  InstrumentRegistry.importBundle() on receive (same path as the Analyzer's
   *  import-hki and the `+ .hki` file picker). */
  | { type: 'import-hki'; instrumentKey: string; bytes: Uint8Array };

/* ── HKL → Orchestrator ──────────────────────────────────────────────────── */

export type HklOrchestratorEvent =
  /** Sent on HKL load, and in response to orchestrator-hello. */
  | { type: 'hkl-hello'; version: number }
  /** Sent on HKL unload (best-effort). */
  | { type: 'hkl-bye' }
  /** Per-import acknowledgement. `ok:false` carries an error string the
   *  Orchestrator surfaces in its status bar. */
  | { type: 'import-ack'; instrumentKey: string; ok: boolean; error?: string };

export type OrchestratorBridgeMessage = OrchestratorEvent | HklOrchestratorEvent;
