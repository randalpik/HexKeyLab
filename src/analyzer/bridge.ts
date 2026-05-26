// Phase 2 stub — bridge handoff from Analyzer to HKL.
//
// Per the plan: in Phase 2, the analyzer writes the .hki bundle to the same
// IndexedDB store HKL uses for user imports (via InstrumentRegistry.importBundle),
// then posts a small ping on a new BroadcastChannel('hkl-analyzer-bridge')
// with { type: 'analyzer-import-ready', instrumentKey }. HKL refreshes its
// registry, dropdown rebuilds, optionally auto-selects.
//
// This Phase 1 stub just leaves the "Send to HKL" button disabled with a
// "Coming soon" tooltip. Wiring lives here so Phase 2 has a clear seam.

export function initBridgeStub(): void {
  /* No-op for Phase 1. The button stays disabled per its initial HTML state.
     Phase 2 will:
       1. Drop the `disabled` attribute and update the tooltip.
       2. On click: call await buildHkiBundle() → writeHki(); register via
          a future analyzer-side InstrumentRegistry-equivalent or via a
          message to HKL.
       3. Open a same-origin BroadcastChannel('hkl-analyzer-bridge') and
          post { type: 'analyzer-import-ready', instrumentKey }.
       4. Listen for { type: 'analyzer-import-ack' } and surface success/
          failure in the status bar. */
}

export function sendImportReady(_instrumentKey: string): void {
  /* Phase 2 implementation site. */
}
