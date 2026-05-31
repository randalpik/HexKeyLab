// Orchestrator-side bridge to HKL. Same-origin BroadcastChannel
// ('hkl-orchestrator-bridge'), parallel to Composer↔HKL and Analyzer↔HKL.
//
// One import payload: built .hki bundles, bytes inlined in the message. HKL
// writes them to its IndexedDB via InstrumentRegistry.importBundle() on receive
// and acks with `import-ack { instrumentKey, ok, error? }`. Inlining (vs shared
// IDB) keeps this app from importing HKL's src/state/ — the bridge stays a
// stateless message boundary. Mirrors apps/analyzer/src/bridge.ts.

import {
  createHklOrchestratorBridge,
  ORCHESTRATOR_PROTOCOL_VERSION,
  type HklOrchestratorBridge,
} from '@hkl/bridge/channel.js';
import type { HklOrchestratorEvent } from '@hkl/bridge/orchestrator-protocol.js';
import { writeHki, type HkiBundle } from '@hkl/shared/hki.js';

let _bridge: HklOrchestratorBridge | null = null;
let _hklConnected = false;
type ConnListener = (connected: boolean) => void;
const connListeners = new Set<ConnListener>();
const pending = new Map<string, (msg: HklOrchestratorEvent & { type: 'import-ack' }) => void>();

function getBridge(): HklOrchestratorBridge {
  if (_bridge) return _bridge;
  _bridge = createHklOrchestratorBridge();
  _bridge.on((msg: HklOrchestratorEvent) => {
    switch (msg.type) {
      case 'hkl-hello':
        if (!_hklConnected) { _hklConnected = true; fireConn(true); }
        break;
      case 'hkl-bye':
        if (_hklConnected) { _hklConnected = false; fireConn(false); }
        break;
      case 'import-ack': {
        const resolver = pending.get(msg.instrumentKey);
        if (resolver) { pending.delete(msg.instrumentKey); resolver(msg); }
        break;
      }
    }
  });
  return _bridge;
}

function fireConn(connected: boolean): void {
  for (const fn of connListeners) {
    try { fn(connected); } catch (e) { console.error('bridge conn listener', e); }
  }
}

/** Subscribe to HKL connect/disconnect changes. Returns unsubscribe. */
export function onConnectionChange(fn: ConnListener): () => void {
  connListeners.add(fn);
  return () => connListeners.delete(fn);
}

export function isHklConnected(): boolean {
  return _hklConnected;
}

/** Wait up to `timeoutMs` for an import-ack matching `instrumentKey`. */
function waitForAck(instrumentKey: string, timeoutMs = 10000): Promise<HklOrchestratorEvent & { type: 'import-ack' }> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(instrumentKey);
      reject(new Error('No ack from HKL within ' + (timeoutMs / 1000).toFixed(1) + 's'));
    }, timeoutMs);
    pending.set(instrumentKey, (msg) => {
      window.clearTimeout(timer);
      resolve(msg);
    });
  });
}

/** Send a built .hki bundle to HKL. Serializes via writeHki, ships bytes inline;
 *  HKL writes to its IDB + auto-selects. Resolves once HKL acks ok. */
export async function sendHkiToHkl(bundle: HkiBundle): Promise<void> {
  if (!_hklConnected) throw new Error('HKL is not connected (open / in another tab on the same origin)');
  const bytes = writeHki(bundle);
  const instrumentKey = bundle.manifest.instrumentKey;
  const ackPromise = waitForAck(instrumentKey);
  getBridge().send({ type: 'import-hki', instrumentKey, bytes });
  const ack = await ackPromise;
  if (!ack.ok) throw new Error('HKL refused .hki: ' + (ack.error ?? 'unknown'));
}

/** Initialize the bridge: create channel, send orchestrator-hello, wire the
 *  top-bar connection badge. Idempotent — main.ts calls this once at boot. */
export function initBridge(): void {
  const bridge = getBridge();
  bridge.send({ type: 'orchestrator-hello', version: ORCHESTRATOR_PROTOCOL_VERSION });

  const badge = document.getElementById('hklConn');
  const updateBadge = (connected: boolean) => {
    if (badge) {
      badge.textContent = connected ? 'HKL connected' : 'no HKL';
      badge.className = connected ? 'conn connected' : 'conn';
    }
  };
  updateBadge(_hklConnected);
  onConnectionChange(updateBadge);

  window.addEventListener('beforeunload', () => {
    try { bridge.send({ type: 'orchestrator-bye' }); } catch { /* best-effort */ }
  });
}
