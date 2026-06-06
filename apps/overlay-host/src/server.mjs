// HKL OBS-overlay host — the standalone distributable.
//
// One small local server that (a) serves the embedded lean read-only overlay
// build (apps/hkl/dist-overlay, copied into ./embedded by assemble-overlay-host)
// and (b) hosts the WebSocket relay at /overlay-ws — both on ONE local origin.
//
// Why local-served: OBS Browser Source is its own Chromium (CEF). Since Chrome
// 142/147, a PUBLIC page (Netlify) → ws://127.0.0.1 is blocked by Local Network
// Access (a permission prompt CEF can't show). Serving the overlay page locally
// makes page + relay the same local origin (local→local), so LNA never applies.
// The PERFORMER stays on production HKL (Netlify, Firefox) and reaches this
// relay fine (Firefox exempts localhost WebSockets).
//
// Run:  node apps/overlay-host/src/server.mjs   (or `pnpm --filter @hkl/overlay-host start`)
//   OBS Browser Source → http://127.0.0.1:5190/?overlay
// Verovio WASM + the Bravura font load from CDNs, so the host needs internet
// (fine for a streaming box).

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachOverlayRelay } from './overlay-relay.mjs';
import { staticHandler } from './static.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');

/* Default port. MUST match OVERLAY_RELAY_PORT in
   packages/bridge/src/overlay-protocol.ts — the production (Netlify) performer
   hardcodes that value when dialing this relay. Override via HKL_OVERLAY_PORT
   env or first CLI arg only if you also set localStorage.hklOverlayPort in the
   performing HKL tab. */
const PORT = Number(process.env.HKL_OVERLAY_PORT ?? process.argv[2] ?? 5190);
const HOST = '127.0.0.1';

const serveStatic = staticHandler(path.join(appRoot, 'embedded'));

const server = http.createServer((req, res) => { serveStatic(req, res); });

const relay = attachOverlayRelay(server, '/overlay-ws');
server.on('upgrade', (req, socket, head) => {
  if (relay.owns(req.url || '')) relay.handleUpgrade(req, socket, head);
  else socket.destroy();
});

server.listen(PORT, HOST, () => {
  console.log(`\n  HKL OBS overlay host → http://${HOST}:${PORT}/`);
  console.log(`    OBS Browser Source  → http://${HOST}:${PORT}/?overlay`);
  console.log(`    relay               → ws://${HOST}:${PORT}/overlay-ws`);
  console.log(`    performer (Netlify) dials ws://127.0.0.1:${PORT}/overlay-ws\n`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is in use — set HKL_OVERLAY_PORT or pass a port arg (and set localStorage.hklOverlayPort in the performing tab to match)`);
  } else {
    console.error('overlay host error:', e.message);
  }
  process.exit(1);
});
