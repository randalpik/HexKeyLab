// HKL dev umbrella. Spawns the three app vite servers and reverse-proxies them
// under ONE origin (http://localhost:5170) so the BroadcastChannel bridge and
// the per-origin IndexedDB instrument registry work across HKL / Composer /
// Analyzer tabs. Path-prefix routing:
//
//   /composer/*  -> :5174   (apps/composer, base /composer/)
//   /analyzer/*  -> :5175   (apps/analyzer, base /analyzer/)
//   everything   -> :5173   (apps/hkl,      base /)
//
// HMR websockets ride the same prefixes (each app's vite hmr.path matches its
// base; hmr.clientPort is 5170 so the browser dials the proxy). The dev-only
// /iowa-mis* and /analyzer-configs-manifest endpoints are mounted here at the
// origin, so any app's absolute fetch reaches them regardless of base.
//
// Run via `pnpm dev`. Standalone per-app dev (`pnpm --filter @hkl/<app> dev`)
// still works for pure UI work, minus the cross-app bridge + those endpoints.

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { iowaMisTranscodeMiddleware, analyzerConfigsManifest } from './middleware.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const PROXY_PORT = 5170;
const HKL = 5173, COMPOSER = 5174, ANALYZER = 5175;

const APPS = [
  ['@hkl/hkl', HKL],
  ['@hkl/composer', COMPOSER],
  ['@hkl/analyzer', ANALYZER],
];

/* ── spawn the three app dev servers ── */
const children = [];
for (const [name] of APPS) {
  const child = spawn('pnpm', ['--filter', name, 'dev'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = name.replace('@hkl/', '').padEnd(8);
  const pipe = (stream, sink) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) sink.write(`[${tag}] ${l}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  children.push(child);
}

function shutdown() {
  for (const c of children) { try { c.kill('SIGTERM'); } catch {} }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/* ── origin-level dev endpoints (run before proxying) ── */
const endpoints = [
  iowaMisTranscodeMiddleware('/iowa-mis', 'https://theremin.music.uiowa.edu/sound%20files/MIS%20Pitches%20-%202014', path.join(repoRoot, '.iowa-cache')),
  iowaMisTranscodeMiddleware('/iowa-mis-legacy', 'https://theremin.music.uiowa.edu/sound%20files/MIS', path.join(repoRoot, '.iowa-cache')),
  analyzerConfigsManifest(path.join(repoRoot, 'apps/analyzer/configs')),
];

function runEndpoints(req, res, done) {
  let i = 0;
  const next = () => {
    const mw = endpoints[i++];
    if (!mw) return done();
    mw(req, res, next);
  };
  next();
}

function targetFor(url) {
  if (url.startsWith('/composer')) return COMPOSER;
  if (url.startsWith('/analyzer')) return ANALYZER;
  return HKL;
}

function proxyHttp(req, res, port) {
  const pReq = http.request(
    { hostname: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers },
    (pRes) => { res.writeHead(pRes.statusCode || 502, pRes.headers); pRes.pipe(res); },
  );
  pReq.on('error', (e) => { res.statusCode = 502; res.end(`dev-proxy: ${e.message}`); });
  req.pipe(pReq);
}

const server = http.createServer((req, res) => {
  runEndpoints(req, res, () => proxyHttp(req, res, targetFor(req.url || '/')));
});

/* ── HMR websocket upgrades, routed by the same prefixes ── */
server.on('upgrade', (req, socket, head) => {
  const port = targetFor(req.url || '/');
  const pReq = http.request({ hostname: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers });
  pReq.on('upgrade', (pRes, pSocket, pHead) => {
    const lines = [`HTTP/1.1 ${pRes.statusCode} ${pRes.statusMessage}`];
    for (const [k, v] of Object.entries(pRes.headers)) {
      if (Array.isArray(v)) for (const vv of v) lines.push(`${k}: ${vv}`);
      else lines.push(`${k}: ${v}`);
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (pHead && pHead.length) socket.write(pHead);
    pSocket.pipe(socket);
    socket.pipe(pSocket);
    pSocket.on('error', () => socket.destroy());
    socket.on('error', () => pSocket.destroy());
  });
  pReq.on('error', () => socket.destroy());
  pReq.end();
});

server.listen(PROXY_PORT, () => {
  console.log(`\n  HKL dev umbrella → http://localhost:${PROXY_PORT}/`);
  console.log(`    /          → HKL      (:${HKL})`);
  console.log(`    /composer/ → Composer (:${COMPOSER})`);
  console.log(`    /analyzer/ → Analyzer (:${ANALYZER})\n`);
});
