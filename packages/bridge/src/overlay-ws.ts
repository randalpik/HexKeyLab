// Browser WebSocket client for the OBS-overlay relay. Symmetric: both the
// publisher (performing HKL) and the subscriber (overlay HKL) use the same
// class — publishers call send(), subscribers call on(). Auto-reconnects with
// capped backoff so the overlay survives the performer reloading, and the
// performer survives the relay restarting.
//
// URL resolution by origin:
//  - Local page (localhost / 127.0.0.1 — dev-proxy OR the distributable's own
//    overlay): same-origin /overlay-ws.
//  - Remote page (production/Netlify performer): dial the local distributable
//    directly at ws://127.0.0.1:<OVERLAY_RELAY_PORT> (localStorage override
//    `hklOverlayPort`). Allowed because loopback is mixed-content-exempt and
//    Firefox doesn't LNA-gate localhost WebSockets.
//
// `giveUpAfter`: a never-opened socket stops retrying after N attempts (used by
// the publisher, so a public Netlify visitor not running the distributable
// doesn't poke localhost forever). Once opened, reconnect is unbounded.

import { OVERLAY_WS_PATH, OVERLAY_RELAY_PORT, type OverlayMsg } from './overlay-protocol.js';

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 5000;

function readPortOverride(): number | null {
  /* Explicit override (precedence over origin): `?obsrelay=PORT` on the page URL
     or localStorage.hklOverlayPort. Lets a LOCAL performer (e.g. dev
     localhost:5170) target the standalone distributable's relay (127.0.0.1:5190)
     for end-to-end testing without deploying to a remote origin. */
  try {
    const q = Number(new URLSearchParams(location.search).get('obsrelay'));
    if (Number.isInteger(q) && q > 0 && q < 65536) return q;
  } catch { /* */ }
  try {
    const ls = Number(localStorage.getItem('hklOverlayPort'));
    if (Number.isInteger(ls) && ls > 0 && ls < 65536) return ls;
  } catch { /* localStorage may be unavailable */ }
  return null;
}

function resolveOverlayWsUrl(path: string): string {
  /* There is ONE relay: the standalone overlay-host (apps/overlay-host). */
  const override = readPortOverride();
  if (override !== null) return `ws://127.0.0.1:${override}${path}`;

  /* The overlay page that the host itself serves carries a flag (set in the
     lean build's index.html). It uses SAME-ORIGIN so it tracks whatever port
     the host runs on — including a non-default HKL_OVERLAY_PORT. */
  if ((globalThis as { __HKL_OVERLAY_SAME_ORIGIN?: unknown }).__HKL_OVERLAY_SAME_ORIGIN) {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${location.host}${path}`;
  }

  /* Everyone else — the performer (dev localhost:5170 OR production Netlify) and
     any non-host overlay — dials the host at its default port. */
  return `ws://127.0.0.1:${OVERLAY_RELAY_PORT}${path}`;
}

export interface OverlayChannelOpts {
  path?: string;
  /** Stop retrying after this many failed connects if the socket NEVER opened.
   *  Default Infinity (retry forever — the subscriber). */
  giveUpAfter?: number;
}

export class OverlayChannel {
  private ws: WebSocket | null = null;
  private handlers = new Set<(msg: OverlayMsg) => void>();
  private openHandlers = new Set<() => void>();
  private url: string;
  private closed = false;
  private backoff = MIN_BACKOFF_MS;
  private giveUpAfter: number;
  private everOpened = false;
  private failedAttempts = 0;
  /** Buffer sends issued before the socket is open; flushed on open. */
  private pending: string[] = [];

  constructor(opts: OverlayChannelOpts = {}) {
    this.giveUpAfter = opts.giveUpAfter ?? Infinity;
    this.url = resolveOverlayWsUrl(opts.path ?? OVERLAY_WS_PATH);
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.everOpened = true;
      this.failedAttempts = 0;
      this.backoff = MIN_BACKOFF_MS;
      for (const raw of this.pending) { try { ws.send(raw); } catch { /* */ } }
      this.pending = [];
      for (const h of this.openHandlers) h();
    });
    ws.addEventListener('message', (e: MessageEvent) => {
      let msg: OverlayMsg;
      try { msg = JSON.parse(String(e.data)) as OverlayMsg; } catch { return; }
      for (const h of this.handlers) h(msg);
    });
    ws.addEventListener('close', () => { this.ws = null; this.scheduleReconnect(); });
    ws.addEventListener('error', () => { try { ws.close(); } catch { /* */ } });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    /* Bounded give-up — only while the socket has NEVER opened (e.g. a public
       Netlify visitor with no local relay). Once it has opened, reconnect is
       unbounded (the relay merely restarted). */
    if (!this.everOpened && ++this.failedAttempts >= this.giveUpAfter) {
      this.closed = true;
      return;
    }
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    setTimeout(() => this.connect(), delay);
  }

  /** Subscribe to inbound messages. Returns an unsubscribe callback. */
  on(handler: (msg: OverlayMsg) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  /** Run a callback every time the socket (re)opens — used by the publisher to
   *  resend its full snapshot after a relay restart. */
  onOpen(handler: () => void): () => void {
    this.openHandlers.add(handler);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) handler();
    return () => { this.openHandlers.delete(handler); };
  }

  send(msg: OverlayMsg): void {
    const raw = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(raw); } catch { /* */ }
    } else {
      /* Only buffer transient one-shots; the publisher resends a full snapshot
         on reconnect, so dropping deltas while down is harmless. Keep the
         buffer tiny to avoid a flood on a long outage. */
      if (this.pending.length < 32) this.pending.push(raw);
    }
  }

  close(): void {
    this.closed = true;
    this.handlers.clear();
    this.openHandlers.clear();
    if (this.ws) { try { this.ws.close(); } catch { /* */ } this.ws = null; }
  }
}
