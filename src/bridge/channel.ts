// Typed BroadcastChannel wrapper. Each side calls its factory and gets a
// channel typed for the messages it receives and sends. Internally a single
// BroadcastChannel('hkl-composer-bridge') carries both directions; the
// generics give per-side type safety.

import {
  CHANNEL_NAME, PROTOCOL_VERSION,
  ComposerEvent, HklEvent,
} from './protocol.js';

class BridgeChannel<In, Out> {
  private ch: BroadcastChannel;
  private handlers = new Set<(msg: In) => void>();

  constructor() {
    this.ch = new BroadcastChannel(CHANNEL_NAME);
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

/** From HKL's perspective: receive Composer events, send HKL events. */
export type HklBridge = BridgeChannel<ComposerEvent, HklEvent>;
export function createHklBridge(): HklBridge {
  return new BridgeChannel<ComposerEvent, HklEvent>();
}

/** From Composer's perspective: receive HKL events, send Composer events. */
export type ComposerBridge = BridgeChannel<HklEvent, ComposerEvent>;
export function createComposerBridge(): ComposerBridge {
  return new BridgeChannel<HklEvent, ComposerEvent>();
}

export { PROTOCOL_VERSION, CHANNEL_NAME };
