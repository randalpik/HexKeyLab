// Typed BroadcastChannel wrapper. Each side calls its factory and gets a
// channel typed for the messages it receives and sends. Two physical channels
// exist (Composer + Analyzer); each factory passes its own name to the
// generic BridgeChannel class.

import {
  CHANNEL_NAME, PROTOCOL_VERSION,
  ComposerEvent, HklEvent,
} from './protocol.js';
import {
  ANALYZER_CHANNEL_NAME, ANALYZER_PROTOCOL_VERSION,
  AnalyzerEvent, HklAnalyzerEvent,
} from './analyzer-protocol.js';

class BridgeChannel<In, Out> {
  private ch: BroadcastChannel;
  private handlers = new Set<(msg: In) => void>();

  constructor(channelName: string) {
    this.ch = new BroadcastChannel(channelName);
    this.ch.addEventListener('message', (e: MessageEvent) => {
      const msg = e.data as In;
      for (const h of this.handlers) h(msg);
    });
  }

  /** Subscribe. Returns an unsubscribe callback. */
  on(handler: (msg: In) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  send(msg: Out): void {
    this.ch.postMessage(msg);
  }

  close(): void {
    this.ch.close();
    this.handlers.clear();
  }
}

/* ── HKL ↔ Composer ─────────────────────────────────────────────────────── */

/** From HKL's perspective: receive Composer events, send HKL events. */
export type HklBridge = BridgeChannel<ComposerEvent, HklEvent>;
export function createHklBridge(): HklBridge {
  return new BridgeChannel<ComposerEvent, HklEvent>(CHANNEL_NAME);
}

/** From Composer's perspective: receive HKL events, send Composer events. */
export type ComposerBridge = BridgeChannel<HklEvent, ComposerEvent>;
export function createComposerBridge(): ComposerBridge {
  return new BridgeChannel<HklEvent, ComposerEvent>(CHANNEL_NAME);
}

/* ── HKL ↔ Analyzer ─────────────────────────────────────────────────────── */

/** From HKL's perspective: receive Analyzer events, send HKL→Analyzer events. */
export type AnalyzerHklBridge = BridgeChannel<AnalyzerEvent, HklAnalyzerEvent>;
export function createAnalyzerHklBridge(): AnalyzerHklBridge {
  return new BridgeChannel<AnalyzerEvent, HklAnalyzerEvent>(ANALYZER_CHANNEL_NAME);
}

/** From Analyzer's perspective: receive HKL→Analyzer events, send Analyzer events. */
export type HklAnalyzerBridge = BridgeChannel<HklAnalyzerEvent, AnalyzerEvent>;
export function createHklAnalyzerBridge(): HklAnalyzerBridge {
  return new BridgeChannel<HklAnalyzerEvent, AnalyzerEvent>(ANALYZER_CHANNEL_NAME);
}

export { PROTOCOL_VERSION, CHANNEL_NAME, ANALYZER_PROTOCOL_VERSION, ANALYZER_CHANNEL_NAME };
