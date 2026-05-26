// Analyzer-side bridge to HKL. Same-origin BroadcastChannel
// ('hkl-analyzer-bridge'), parallel to Composer↔HKL.
//
// Two import payloads:
//   - .hki bundles: bytes are inlined in the message. HKL writes to its own
//     IndexedDB via InstrumentRegistry.importBundle() on receive. Structured
//     clone handles Uint8Array of 10–50 MB; transfer cost is negligible
//     relative to the analysis the user just ran.
//   - CDN configs (JSON): inlined; HKL writes to cdnConfigRegistry.
//
// HKL acks each import with `import-ack { instrumentKey, ok, error? }`.
//
// Why inline (not shared IDB): keeps src/analyzer/ from importing
// src/state/, matching the import-constraints in CLAUDE.md. The bridge
// stays a stateless message boundary.

import {
  createHklAnalyzerBridge,
  ANALYZER_PROTOCOL_VERSION,
  type HklAnalyzerBridge,
} from '../bridge/channel.js';
import type { HklAnalyzerEvent } from '../bridge/analyzer-protocol.js';
import { writeHki, type HkiBundle } from '../shared/hki.js';
import type { CdnInstrumentConfig } from '../shared/cdnConfig.js';
import { setStatus } from './stage.js';

let _bridge: HklAnalyzerBridge | null = null;
let _hklConnected = false;
type ConnListener = (connected: boolean) => void;
const connListeners = new Set<ConnListener>();
const pending = new Map<string, (msg: HklAnalyzerEvent & { type: 'import-ack' }) => void>();

function getBridge(): HklAnalyzerBridge {
  if (_bridge) return _bridge;
  _bridge = createHklAnalyzerBridge();
  _bridge.on((msg: HklAnalyzerEvent) => {
    switch (msg.type) {
      case 'hkl-hello':
        if (!_hklConnected) {
          _hklConnected = true;
          fireConn(true);
        }
        break;
      case 'hkl-bye':
        if (_hklConnected) {
          _hklConnected = false;
          fireConn(false);
        }
        break;
      case 'import-ack': {
        const resolver = pending.get(msg.instrumentKey);
        if (resolver) {
          pending.delete(msg.instrumentKey);
          resolver(msg);
        }
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
function waitForAck(instrumentKey: string, timeoutMs = 10000): Promise<HklAnalyzerEvent & { type: 'import-ack' }> {
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

/**
 * Send a built .hki bundle to HKL. Serializes via writeHki, ships bytes
 * inline through the bridge. HKL writes to its IDB + auto-selects.
 */
export async function sendHkiToHkl(bundle: HkiBundle): Promise<void> {
  if (!_hklConnected) throw new Error('HKL is not connected (open /index.html in another tab)');
  const bytes = writeHki(bundle);
  const instrumentKey = bundle.manifest.instrumentKey;
  const ackPromise = waitForAck(instrumentKey);
  getBridge().send({ type: 'import-hki', instrumentKey, bytes });
  const ack = await ackPromise;
  if (!ack.ok) throw new Error('HKL refused .hki: ' + (ack.error ?? 'unknown'));
}

/**
 * Send a CDN config to HKL. Inlined (configs are small). HKL writes to its
 * cdnConfigRegistry; the INSTRUMENTS proxy resolves the key thereafter.
 */
export async function sendCdnConfigToHkl(config: CdnInstrumentConfig): Promise<void> {
  if (!_hklConnected) throw new Error('HKL is not connected (open /index.html in another tab)');
  const ackPromise = waitForAck(config.instrumentKey);
  getBridge().send({ type: 'import-cdn-config', instrumentKey: config.instrumentKey, config });
  const ack = await ackPromise;
  if (!ack.ok) throw new Error('HKL refused CDN config: ' + (ack.error ?? 'unknown'));
}

/**
 * Initialize the bridge: create channel, send analyzer-hello, wire the
 * connection-status badge in the top bar. Idempotent — main.ts calls this
 * once at boot.
 */
export function initBridgeStub(): void {
  /* Name kept for back-compat with the Phase 1 main.ts call site. */
  const bridge = getBridge();
  bridge.send({ type: 'analyzer-hello', version: ANALYZER_PROTOCOL_VERSION });

  /* Top-bar connection badge. */
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
    try { bridge.send({ type: 'analyzer-bye' }); } catch {}
  });

  setStatus('Bridge ready.');
}

/** Phase 1 backward-compat alias. Replaced; kept for callers that may
 *  still import this name. */
export function sendImportReady(_instrumentKey: string): void { /* deprecated */ }
