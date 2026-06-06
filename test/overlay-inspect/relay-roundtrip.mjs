// Standalone proof of the OBS-overlay WS relay (apps/overlay-host/src/overlay-relay.mjs):
//   1. fan-out — a message from the publisher reaches the subscriber, not the
//      sender;
//   2. retain + replay — a LATE-joining subscriber immediately receives the
//      last value of each retained message type (this is what lets an OBS
//      Browser Source opened mid-performance reconstruct current state).
//
// Pure Node: a throwaway http server on a unique port + attachOverlayRelay, two
// native-WebSocket clients. No dev-proxy, no browser — never touches :5170.
//
//   node test/overlay-inspect/relay-roundtrip.mjs

import http from 'node:http';
import { attachOverlayRelay } from '../../apps/overlay-host/src/overlay-relay.mjs';

const PORT = 5191 + Math.floor(Math.random() * 50);
const fail = (m) => { console.error('✗ ' + m); process.exit(1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nextMsg = (ws) => new Promise((res) => ws.addEventListener('message', (e) => res(JSON.parse(e.data)), { once: true }));
const open = (ws) => new Promise((res) => ws.addEventListener('open', res, { once: true }));

const server = http.createServer((_, res) => { res.statusCode = 426; res.end('upgrade'); });
const relay = attachOverlayRelay(server, '/overlay-ws');
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

  /* ── 2. retained replay to a LATE subscriber ── */
  const late = new WebSocket(url);
  await open(late);
  const seen = new Map();
  late.addEventListener('message', (e) => { const m = JSON.parse(e.data); seen.set(m.t, m); });
  await wait(120);
  if (!seen.has('snapshot')) fail('late subscriber did not get retained snapshot');
  if (seen.get('snapshot').data.tuning !== 'V') fail('retained snapshot is stale/wrong');
  if (!seen.has('keys') || seen.get('keys').keys[0] !== '3,4') fail('late subscriber did not get retained keys');
  console.log('✓ retained replay: late subscriber reconstructed snapshot + keys');

  console.log('\nALL RELAY CHECKS PASSED');
} finally {
  server.close();
  process.exit(0);
}
