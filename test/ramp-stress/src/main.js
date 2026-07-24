// Live-ramp stress harness — minimal repro of Intonalogy's retune buttons.
// One voice; holding +¢/−¢ steps the target pitch by `step-cents` every
// `step-ms`, each step issuing sRampFreq over `ramp-ms`. No engine behavior
// is altered here: this exists to reproduce the crackles/hiccups/wrong-pitch
// landings on our side before touching the engine.
//
// window.__ramp exposes the harness for headless driving (CDP):
//   __ramp.noteOn(), __ramp.noteOff(), __ramp.stepHold(dir, n) — n synchronous
//   interval-paced steps, __ramp.read() — current readout row values.

import {
  init, loadInstrument, sNoteOn, sNoteOff, sRampFreq,
  getActiveVoices, readHkiInstrument,
} from '@hkl/engine/index.js';

const $ = (id) => document.getElementById(id);
const VOICE = 'v';
const BASE = 220;

let ctx = null;
let noteIsOn = false;
let cents = 0;          // accumulated requested offset from BASE
let calls = 0, rejected = 0, seams = 0;
// The select carries FILE basenames (handoff/intonalogy naming); the engine
// instrument key comes from each bundle's own manifest, so renames of the
// staged files never break the harness.
const bundles = new Map();      // file basename → { key, def, audio }
const audioByKey = new Map();   // manifest instrumentKey → audio map (provider lookup)

async function fetchBundle(file) {
  if (bundles.has(file)) return bundles.get(file);
  const res = await fetch(`/${file}.hki`);
  // Vite's SPA fallback answers missing files with 200 + index.html — catch
  // that explicitly rather than letting readHki die on "invalid zip data".
  if (!res.ok || (res.headers.get('content-type') || '').includes('text/html')) {
    throw new Error(`/${file}.hki missing from handoff/intonalogy (got ${res.status} ${res.headers.get('content-type')})`);
  }
  const parsed = readHkiInstrument(new Uint8Array(await res.arrayBuffer()));
  bundles.set(file, parsed);
  audioByKey.set(parsed.key, parsed.audio);
  return parsed;
}

async function ensureEngine() {
  if (ctx) return;
  ctx = new AudioContext();
  init(ctx, ctx.destination, {
    instrumentProvider: async (k) => audioByKey.get(k) ?? null,
    velocityToGain: (v) => v / 127,
    onSeamEvent: () => { seams++; },
  });
}

function expectedFreq() { return BASE * Math.pow(2, cents / 1200); }

async function noteOn() {
  await ensureEngine();
  await ctx.resume();
  const file = $('instrument').value;
  const { key, def } = await fetchBundle(file);
  await loadInstrument(key, def);
  $('status').textContent = `${file}.hki → ${def.name} (key '${key}', ${def.samples.length} samples)`;
  cents = 0; calls = 0; rejected = 0; seams = 0;
  sNoteOn(VOICE, BASE, 100, key);
  noteIsOn = true;
  $('btn-note').textContent = 'Note off';
  $('btn-up').disabled = $('btn-down').disabled = false;
}

function noteOff() {
  sNoteOff(VOICE);
  noteIsOn = false;
  $('btn-note').textContent = 'Note on (A3 220 Hz)';
  $('btn-up').disabled = $('btn-down').disabled = true;
  stopHold();
}

function step(dir) {
  if (!noteIsOn) return;
  cents += dir * Number($('step-cents').value || 1);
  calls++;
  const ok = sRampFreq(VOICE, expectedFreq(), Number($('ramp-ms').value || 60) / 1000);
  if (ok === false) rejected++;
}

// ── hold-to-repeat (pointer + arrow keys) ──
let holdTimer = null;
function startHold(dir) {
  if (holdTimer) return;
  step(dir); // immediate first step, then the interval
  holdTimer = setInterval(() => step(dir), Number($('step-ms').value || 50));
}
function stopHold() {
  if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
}
for (const [id, dir] of [['btn-up', +1], ['btn-down', -1]]) {
  const el = $(id);
  el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); startHold(dir); });
  el.addEventListener('pointerup', stopHold);
  el.addEventListener('pointercancel', stopHold);
}
window.addEventListener('keydown', (e) => {
  if (e.repeat) return; // we pace ourselves; OS key-repeat would double-drive
  if (e.key === 'ArrowUp') startHold(+1);
  if (e.key === 'ArrowDown') startHold(-1);
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') stopHold();
});
window.addEventListener('blur', stopHold);

$('btn-note').addEventListener('click', () => (noteIsOn ? noteOff() : noteOn()));
$('instrument').addEventListener('change', () => { if (noteIsOn) noteOff(); });

// ── readout ──
function read() {
  const v = getActiveVoices()[VOICE];
  const expected = expectedFreq();
  const target = v?.freq ?? null;
  // sNoteOn computes rate = freq*transpose/sampleFreq, so invert for the
  // actually-sounding pitch (playbackRate.value is the audio thread's current
  // AudioParam value, ramps included).
  const sounding = v?.alive && v.source
    ? v.source.playbackRate.value * v.sampleFreq / (v.transpose || 1)
    : null;
  const drift = sounding ? 1200 * Math.log2(sounding / expected) : null;
  return { steps: cents, expected, target, sounding, drift, calls, rejected, seams };
}
function paint() {
  const r = read();
  $('steps').textContent = r.steps.toFixed(1) + ' ¢';
  $('expected').textContent = r.expected.toFixed(3);
  $('target').textContent = r.target != null ? r.target.toFixed(3) : '—';
  $('sounding').textContent = r.sounding != null ? r.sounding.toFixed(3) : '—';
  $('drift').textContent = r.drift != null ? r.drift.toFixed(2) : '—';
  $('drift').className = r.drift != null && Math.abs(r.drift) > 5 ? 'bad' : '';
  $('calls').textContent = `${r.calls} / ${r.rejected}`;
  $('seams').textContent = String(r.seams);
  requestAnimationFrame(paint);
}
requestAnimationFrame(paint);

$('status').textContent = 'Ready — Note on, then hold +¢/−¢ (or arrow keys).';
$('btn-note').disabled = false;

// Headless driving hooks. stepHold(dir, n, ms?) paces n steps like a held
// button (real setInterval cadence) and resolves when done.
window.__ramp = {
  noteOn, noteOff, read,
  stepHold: (dir, n, ms) => new Promise((resolve) => {
    const interval = ms ?? Number($('step-ms').value || 50);
    let done = 0;
    const t = setInterval(() => {
      step(dir);
      if (++done >= n) { clearInterval(t); resolve(read()); }
    }, interval);
  }),
};
