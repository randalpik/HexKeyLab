// Standalone proof of the OBS-overlay WS relay (apps/overlay-host/src/overlay-relay.mjs):
//   1. fan-out — a message from the publisher reaches the subscriber, not the
//      sender;
//   2. retain + replay — a LATE-joining subscriber immediately receives the
//      last value of each retained message type (this is what lets an OBS
//      Browser Source opened mid-performance reconstruct current state);
//   3. handshake gate — a browser Origin not on the allowlist, or a foreign
//      Host, is refused before it can read retained state or inject frames; a
//      handshake with no Origin (a local non-browser process) is admitted;
//   4. host wiring — the real server.mjs, spawned on a throwaway port, admits
//      the HKL app origins and its own origin and refuses a foreign one.
//
// Pure Node: a throwaway http server on a unique port + attachOverlayRelay, two
// native-WebSocket clients, raw upgrade requests for exact headers, and one
// spawned host. No dev-proxy, no browser — never touches :5170 or :5190.
//
//   node test/overlay-inspect/relay-roundtrip.mjs

import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { attachOverlayRelay } from '../../apps/overlay-host/src/overlay-relay.mjs';

const PORT = 5191 + Math.floor(Math.random() * 50);
const HOST_PORT = 5300 + Math.floor(Math.random() * 200);
const SERVER = fileURLToPath(new URL('../../apps/overlay-host/src/server.mjs', import.meta.url));
let host = null;   // the spawned server.mjs (section 4) — the only PID this script kills
const fail = (m) => { console.error('✗ ' + m); host?.kill(); process.exit(1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nextMsg = (ws) => new Promise((res) => ws.addEventListener('message', (e) => res(JSON.parse(e.data)), { once: true }));
const open = (ws) => new Promise((res) => ws.addEventListener('open', res, { once: true }));

/** Raw upgrade handshake with exact headers → the HTTP status (101 = admitted). */
function handshake(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/overlay-ws',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), ...headers,
      },
    });
    req.on('upgrade', (res, sock) => { sock.destroy(); resolve(res.statusCode); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
}

async function expectStatus(port, headers, want, label) {
  const got = await handshake(port, headers);
  if (got !== want) fail(`${label}: expected ${want}, got ${got}`);
  console.log(`✓ ${label} → ${got}`);
}

const server = http.createServer((_, res) => { res.statusCode = 426; res.end('upgrade'); });
const relay = attachOverlayRelay(server, '/overlay-ws', { origins: ['https://hexkeylab.com'] });
server.on('upgrade', (req, sock, head) => {
  if (relay.owns(req.url)) relay.handleUpgrade(req, sock, head);
  else sock.destroy();
});

await new Promise((r) => server.listen(PORT, r));
const url = `ws://127.0.0.1:${PORT}/overlay-ws`;

try {
  /* ── 1. fan-out + retain to an already-connected subscriber ── */
  const pub = new WebSocket(url);
  const sub = new WebSocket(url);
  await Promise.all([open(pub), open(sub)]);

  const snap = { t: 'snapshot', data: { tuning: 'V', litKeys: ['0,0', '1,2'] } };
  const got = nextMsg(sub);
  pub.send(JSON.stringify(snap));
  const recv = await got;
  if (recv.t !== 'snapshot' || recv.data.tuning !== 'V') fail('fan-out: subscriber did not get the snapshot');
  console.log('✓ fan-out: subscriber received publisher snapshot');

  /* publisher should NOT receive its own message */
  let echoed = false;
  pub.addEventListener('message', () => { echoed = true; });
  pub.send(JSON.stringify({ t: 'keys', keys: ['3,4'] }));
  await wait(80);
  if (echoed) fail('publisher received its own message (no self-echo expected)');
  console.log('✓ no self-echo to publisher');

  /* Composer-frame state the overlay needs to size its render. An unretained
     composer-zoom would leave a Browser Source that reconnects (or opens
     mid-performance) rendering the score at the frame's 50 % default while
     Composer sits at 100 % — the exact failure the retain list exists to
     prevent, and one nothing else would catch until it was on stream. */
  pub.send(JSON.stringify({ t: 'composer-zoom', zoom: 100 }));
  await wait(40);

  /* ── 2. retained replay to a LATE subscriber ── */
  const late = new WebSocket(url);
  await open(late);
  const seen = new Map();
  late.addEventListener('message', (e) => { const m = JSON.parse(e.data); seen.set(m.t, m); });
  await wait(120);
  if (!seen.has('snapshot')) fail('late subscriber did not get retained snapshot');
  if (seen.get('snapshot').data.tuning !== 'V') fail('retained snapshot is stale/wrong');
  if (!seen.has('keys') || seen.get('keys').keys[0] !== '3,4') fail('late subscriber did not get retained keys');
  if (!seen.has('composer-zoom') || seen.get('composer-zoom').zoom !== 100) fail('late subscriber did not get retained composer-zoom');
  console.log('✓ retained replay: late subscriber reconstructed snapshot + keys + composer-zoom');

  /* ── 3. handshake gate ── */
  await expectStatus(PORT, {}, 101, 'gate: no Origin (local non-browser process)');
  await expectStatus(PORT, { Origin: 'https://hexkeylab.com' }, 101, 'gate: allowlisted Origin');
  await expectStatus(PORT, { Origin: 'https://evil.example' }, 403, 'gate: foreign Origin');
  await expectStatus(PORT, { Origin: 'https://hexkeylab.com', Host: `evil.example:${PORT}` }, 403, 'gate: foreign Host (DNS rebinding)');

  /* ── 4. host wiring: server.mjs's allowlist ── */
  host = spawn(process.execPath, [SERVER], {
    env: { ...process.env, HKL_OVERLAY_PORT: String(HOST_PORT), HKL_FS_PICKER: 'none' }, stdio: 'ignore',
  });
  for (let i = 0; ; i++) {
    if (await fetch(`http://127.0.0.1:${HOST_PORT}/`).then((r) => r.ok, () => false)) break;
    if (i > 100) fail('spawned host never came up');
    await wait(50);
  }
  await expectStatus(HOST_PORT, { Origin: 'http://localhost:5170' }, 101, 'host: dev performer origin');
  await expectStatus(HOST_PORT, { Origin: `http://127.0.0.1:${HOST_PORT}` }, 101, 'host: its own origin (OBS overlay page)');
  await expectStatus(HOST_PORT, { Origin: `http://localhost:${HOST_PORT}` }, 101, 'host: its own origin via localhost');
  await expectStatus(HOST_PORT, { Origin: 'https://evil.example' }, 403, 'host: foreign Origin');

  console.log('\nALL RELAY CHECKS PASSED');
} catch (e) {
  fail(e.stack ?? String(e));
} finally {
  host?.kill();
  server.close();
}
process.exit(0);
