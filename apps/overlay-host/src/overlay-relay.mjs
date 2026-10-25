// OBS-overlay WebSocket relay. A tiny pub/sub fan-out that lets the performing
// HKL instance (in Firefox) mirror its render state to a second HKL instance
// loaded as an OBS Browser Source (?overlay) — a separate browser, so the
// same-origin BroadcastChannel bridge can't reach it.
//
// Topology: any client may send; every message is (a) retained as the
// last-value for its message type `t`, and (b) broadcast to all OTHER clients.
// On connect, a newcomer is immediately replayed every retained message — so a
// late-joining OBS source (the overlay is usually opened after the performer)
// reconstructs the current lattice + composer-frame state with no round-trip.
//
// In practice the performing instance is the sole publisher and the overlay is
// the sole subscriber, but the relay is symmetric and doesn't care.
//
// Runs in `noServer` mode: the caller owns the HTTP server and forwards
// `/overlay-ws` upgrades here. The ONLY caller is this app's server.mjs — the
// overlay-host is the single relay for both dev and production (in dev, run
// `pnpm overlay:host` alongside `pnpm dev`; the 5170 tabs dial it).
//
// Handshake gate. WebSockets are exempt from CORS and Firefox lets any public
// page dial localhost, so without a gate any site could read the retained
// state (lattice, the mirrored score's MEI) and inject frames the OBS overlay
// draws. Before upgrading:
//   1. Host is 127.0.0.1/localhost:<listen port>   (defeats DNS rebinding)
//   2. Origin, when present, is on `origins`        (fail-closed: empty = no
//      browser page at all). A handshake with NO Origin is admitted: every
//      browser sends one, so none means a local non-browser process (the test
//      tools), which already has the user's rights.

import { WebSocketServer } from 'ws';

/** Message types whose last value is retained + replayed to new subscribers.
 *  `request-snapshot` is transient (a subscriber nudge) and never retained. */
const RETAINED = new Set([
  'snapshot', 'keys', 'view', 'composer-view', 'composer-score', 'composer-playback',
  'composer-zoom',
]);

/** Attach the overlay relay to an existing HTTP server. Returns a predicate the
 *  caller uses to decide whether an upgrade belongs to the relay.
 *  `origins`: the browser Origins allowed to connect (see the gate above). */
export function attachOverlayRelay(server, pathPrefix = '/overlay-ws', { origins = [] } = {}) {
  const wss = new WebSocketServer({ noServer: true });
  const allowed = new Set(origins);
  /** Last value per retained message type. */
  const retained = new Map();

  wss.on('connection', (ws) => {
    /* Replay retained state to the newcomer (snapshot first if present, then
       the rest — order within the map is insertion order, which is fine since
       the subscriber tolerates deltas before/after the snapshot). */
    const snap = retained.get('snapshot');
    if (snap) { try { ws.send(snap); } catch { /* */ } }
    for (const [t, raw] of retained) {
      if (t === 'snapshot') continue;
      try { ws.send(raw); } catch { /* */ }
    }

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const raw = data.toString();
      let t;
      try { t = JSON.parse(raw).t; } catch { return; }
      if (t === 'request-snapshot') {
        /* A subscriber explicitly asked for current state (e.g. after a
           publisher reconnect). Replay retained to just this client. */
        for (const [rt, rraw] of retained) {
          if (rt === 'snapshot') continue;
          try { ws.send(rraw); } catch { /* */ }
        }
        const s = retained.get('snapshot');
        if (s) { try { ws.send(s); } catch { /* */ } }
        return;
      }
      if (RETAINED.has(t)) retained.set(t, raw);
      for (const client of wss.clients) {
        if (client !== ws && client.readyState === 1 /* OPEN */) {
          try { client.send(raw); } catch { /* */ }
        }
      }
    });
  });

  function admits(req) {
    const port = server.address()?.port;
    const hostOk = req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
    const origin = req.headers.origin;
    return hostOk && (origin === undefined || allowed.has(origin));
  }

  function handleUpgrade(req, socket, head) {
    if (!admits(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }

  function owns(url) {
    return (url || '').startsWith(pathPrefix);
  }

  return { handleUpgrade, owns, wss };
}
