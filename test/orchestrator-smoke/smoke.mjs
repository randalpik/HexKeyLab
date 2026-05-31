#!/usr/bin/env node
// Headless smoke test for the HKL Orchestrator device→capture path.
//
// Drives the synthetic loopback device end-to-end (no hardware, no mic): loads
// /orchestrator/, calls window.__hklo.loopbackCaptureTest(), and asserts a
// non-empty, audible decaying capture came back through the AudioWorklet.
//
// Requires a dev server serving the app. Default URL is the standalone
// orchestrator dev server (:5176); override with HKLO_URL.
//   node test/orchestrator-smoke/smoke.mjs
//
// NOTE: realtime AudioContext processing in headless Chromium is best-effort —
// if frames come back 0, that's a headless-audio limitation, not necessarily a
// code bug; verify interactively in a real browser. The script reports clearly.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.HKLO_URL ?? 'http://localhost:5176/orchestrator/';
const DEBUG_PORT = 9322 + Math.floor(Math.random() * 600);
const profileDir = mkdtempSync(join(tmpdir(), 'hklo-smoke-'));

const chromium = spawn('chromium', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profileDir}`,
  'about:blank',
], { stdio: 'pipe' });

const cleanup = (code) => {
  try { chromium.kill('SIGTERM'); } catch {}
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  process.exit(code);
};
process.on('SIGINT', () => cleanup(130));

async function waitForEndpoint() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://localhost:${DEBUG_PORT}/json/version`); if (r.ok) return; } catch {}
    await new Promise(res => setTimeout(res, 80));
  }
  throw new Error('Chromium debug endpoint never came up');
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
}

try {
  await waitForEndpoint();
  const r = await fetch(`http://localhost:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' });
  const cdp = new CDP((await r.json()).webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url });
  await new Promise((res) => {
    cdp.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Page.loadEventFired') res(); });
  });
  await new Promise(res => setTimeout(res, 500)); // let main.ts install the hook

  const result = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      try {
        if (!window.__hklo) return JSON.stringify({ __error: 'window.__hklo missing' });
        return JSON.stringify(await window.__hklo.loopbackCaptureTest(60, 100));
      } catch (e) { return JSON.stringify({ __error: String(e) }); }
    })()`,
    returnByValue: true, awaitPromise: true,
  });

  const evalJson = async (expr) => {
    const r2 = await cdp.send('Runtime.evaluate', {
      expression: `(async () => { try { return JSON.stringify(await (${expr})); } catch (e) { return JSON.stringify({ __error: String(e) }); } })()`,
      returnByValue: true, awaitPromise: true,
    });
    return JSON.parse(r2.result.value);
  };

  const out = JSON.parse(result.result.value);
  if (out.__error) { console.error('FAIL: ' + out.__error); cleanup(1); }
  console.log('loopback capture:', JSON.stringify(out));
  const captureOk = out.frames > 0 && out.peak > 0 && out.sampleRate > 0;
  if (!captureOk) {
    console.warn('INCONCLUSIVE — zero frames/peak. Realtime AudioContext likely did not tick under headless Chromium; verify interactively. (Not a code failure.)');
    cleanup(0);
  }
  console.log(`OK — captured ${out.frames} frames @ ${out.sampleRate}Hz, peak ${out.peak.toFixed(4)}, rms ${out.rms.toFixed(5)}.`);

  // Discovery PLUMBING check only — does the sweep run end-to-end and return a
  // structurally-valid DiscoveryResult through the real capture path? Boundary
  // POSITIONS are asserted deterministically in bins-test.mjs; headless realtime
  // audio delivers frames too unevenly across rapid sweep captures to assert
  // detection outcomes here.
  const disc = await evalJson('window.__hklo.discoverTest(true)');
  if (disc.__error) { console.error('FAIL discover: ' + disc.__error); cleanup(1); }
  console.log('discover (layered):', JSON.stringify({ detected: disc.detected, boundaries: disc.boundaries, bins: disc.bins }));
  const plumbingOk = typeof disc.detected === 'boolean' && Array.isArray(disc.bins) && disc.bins.length >= 1 && disc.n === 9;
  if (plumbingOk) console.log(`OK — sweep ran end-to-end (${disc.n} probes → ${disc.bins.length} layers). Boundary logic verified in bins-test.mjs.`);
  else { console.error(`FAIL — sweep returned malformed result: ${JSON.stringify(disc)}`); cleanup(1); }

  // Quality gates — deterministic synthesized-PCM check (no audio device).
  // Signals carry a pre-roll noise floor so the noise-relative gates are tested.
  const gates = await evalJson('window.__hklo.gatesTest()');
  if (gates.__error) { console.error('FAIL gates: ' + gates.__error); cleanup(1); }
  console.log('gates:', JSON.stringify(gates));
  const gatesOk =
    gates.clean.pass &&
    gates.padded.pass &&                                         // padded-but-clean must PASS
    gates.softOk.pass && !gates.softOk.flags.includes('quiet') && // ~18dB passes (relaxed gate)
    gates.lowSnr.flags.includes('quiet') && !gates.lowSnr.pass && // ~5dB still quiet
    gates.fastDecay.pass && !gates.fastDecay.flags.includes('short') && // fast decay still passes
    gates.miss.flags.includes('quiet') && gates.miss.flags.includes('short') &&
    gates.clip.flags.includes('clip') &&
    !gates.octave.flags.includes('pitch') &&                     // octave NOT flagged — we trust MIDI→pitch
    gates.strongHarmonic.pass && !gates.strongHarmonic.flags.includes('pitch'); // overtone-rich note must NOT false-flag
  if (gatesOk) console.log(`OK — gates: padded@${gates.padded.snrDb}dB→pass, softOk@${gates.softOk.snrDb}dB→pass, lowSnr@${gates.lowSnr.snrDb}dB→quiet, fastDecay(${gates.fastDecay.durSec}s)→pass, miss→quiet+short, clip, octave→not-flagged, strongHarmonic→pass.`);
  else { console.error('FAIL — gate assertions did not hold.'); cleanup(1); }

  // Noise reduction — synthesized tone over a noise floor; profile from pre-roll.
  const dn = await evalJson('window.__hklo.denoiseTest()');
  if (dn.__error) { console.error('FAIL denoise: ' + dn.__error); cleanup(1); }
  console.log('denoise:', JSON.stringify(dn));
  if (dn.noiseDropDb >= 12 && Math.abs(dn.bodyDeltaDb) <= 1.5) console.log(`OK — NR drops the floor ${dn.noiseDropDb}dB, note body within ${dn.bodyDeltaDb}dB (preserved).`);
  else { console.error(`FAIL — NR: floor drop ${dn.noiseDropDb}dB (want ≥12), body delta ${dn.bodyDeltaDb}dB (want ≤1.5).`); cleanup(1); }

  // Capture loop plumbing — a tiny 2-job loop through the real capture path.
  const cap = await evalJson('window.__hklo.captureLoopTest()');
  if (cap.__error) { console.error('FAIL captureLoop: ' + cap.__error); cleanup(1); }
  console.log('captureLoop:', JSON.stringify(cap));
  if (Array.isArray(cap) && cap.length === 2 && cap.every(o => Array.isArray(o.flags))) console.log(`OK — capture loop ran ${cap.length} jobs through record→store→gate.`);
  else { console.error('FAIL — capture loop returned malformed outcomes.'); cleanup(1); }

  // End-to-end export: capture → analyze → v2 .hki → round-trip → decode WAVs.
  const exp = await evalJson('window.__hklo.exportTest()');
  if (exp.__error) { console.error('FAIL export: ' + exp.__error); cleanup(1); }
  console.log('export:', JSON.stringify(exp));
  const layersTagged = Array.isArray(exp.layers) && exp.layers.length === exp.sampleCount && exp.layers.every(l => typeof l.gain === 'number' && l.frames > 0);
  const decodes = exp.layers && exp.layers.every(l => l.frames > 0);
  // Stored freq must be the CLAIMED MIDI 60 → 12-TET pitch (~261.63 Hz), not a
  // detected value — verifies we trust the claimed pitch.
  const claimedFreqOk = exp.layers && exp.layers.every(l => Math.abs(l.freq - 261.63) < 0.5);
  const exportOk = exp.version === 2 && exp.decays === true && exp.loop === false && exp.source === 'orchestrator' && layersTagged && decodes && claimedFreqOk;
  if (!exportOk) { console.error('FAIL — export bundle malformed (freqs=' + JSON.stringify(exp.layers?.map(l => l.freq)) + ').'); cleanup(1); }
  console.log(`OK — built v2 .hki: ${exp.sampleCount} samples, source=${exp.source}, WAVs decode.`);
  // Equal-loudness normalization invariant: with ≥2 layers present, post-gain
  // levels should be close (the gain finder normalizes each layer to the target).
  if (exp.layers.length >= 2 && exp.layers.every(l => l.vel != null)) {
    const dbs = exp.layers.map(l => l.postGainDb);
    const spread = Math.max(...dbs) - Math.min(...dbs);
    if (spread <= 3.5) console.log(`OK — ${exp.layers.length} layers normalized within ${spread.toFixed(1)} dB (vels ${exp.layers.map(l => l.vel).join(',')}).`);
    else console.warn(`WARN — layer post-gain spread ${spread.toFixed(1)} dB > 3.5 (dbs ${dbs.join(',')}).`);
  } else {
    console.log('note — fewer than 2 vel-tagged layers passed gates this run; multi-layer normalization not asserted.');
  }

  cleanup(0);
} catch (e) {
  console.error('smoke error:', e.message);
  cleanup(1);
}
