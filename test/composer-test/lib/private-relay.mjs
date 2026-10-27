// A private OBS-overlay relay for headless HKL pages.
//
// Every HKL page publishes its render state to the overlay relay, and without
// `?obsrelay=` it dials the user's live host on 127.0.0.1:5190 — so a headless
// gate's lattice, ref and pan land in the user's OBS overlay, where the relay
// retains them (2026-10-26). isolatedHklUrl() runs the real relay module
// in-process on an ephemeral port and returns the page URL pinned to it (a
// dead port instead would log a connection error the console gates count).
//
//   const URL = await isolatedHklUrl(process.env.HKL_URL ?? 'http://localhost:5170/');

import http from 'node:http';
import { attachOverlayRelay } from '../../../apps/overlay-host/src/overlay-relay.mjs';

/** `pageUrl` with ?obsrelay=<port of a private relay started for it>; a URL
 *  that already names a relay is returned unchanged. The relay lives until the
 *  process exits. */
export async function isolatedHklUrl(pageUrl) {
  const u = new URL(pageUrl);
  if (u.searchParams.has('obsrelay')) return pageUrl;
  const server = http.createServer();
  const relay = attachOverlayRelay(server, '/overlay-ws', { origins: [u.origin] });
  server.on('upgrade', (req, sock, head) => relay.owns(req.url) ? relay.handleUpgrade(req, sock, head) : sock.destroy());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  u.searchParams.set('obsrelay', String(server.address().port));
  return u.toString();
}
