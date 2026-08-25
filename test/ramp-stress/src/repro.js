// Automated capture+detect mode for handoff/hkle-inflight-crossfade-cut.md.
// Registers window.__repro; driven headlessly by run.mjs over CDP.
//
// Design: every engine call goes through call(), which snapshots the voice's
// pendingSwitch BEFORE invoking — since every cancelPendingSwitch is triggered
// by one of OUR calls (sNoteOff / sRampFreq / sNoteOnFaded's sHardStop), the
// event log lets the detector infer each cancel and whether the voice was
// inside the vulnerable window [switchTime, switchTime + xfDur + 5ms], with no
// engine-side hooks. The engine under test stays pristine (workspace source).
//
// PCM capture: an AudioWorklet recorder fed from the engine's samples-only
// master via tapMaster() (its existing diagnostics tap). The worklet's output
// is silence, connected to destination only so the render graph pulls it.
// Chunks carry the worklet's currentFrame at capture start, so
// sampleIndex ↔ ctx.currentTime alignment is exact.

import {
  sNoteOn, sNoteOnFaded, sNoteOff, sRampFreq, getActiveVoices, tapMaster,
} from '@hkl/engine/index.js';
import { ensureEngine, getCtx, loadBundle, onSeam } from './engine-setup.js';

const BASE = 220;
const INSTRUMENT_FILE = 'strings';

// ── recorder ──────────────────────────────────────────────────────────────
// Blob-URL worklet: keeps the processor source in this file and out of the
// bundler's asset pipeline (nothing to resolve, works identically in dev).
const WORKLET_SRC = `
registerProcessor('hkl-recorder', class extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.startFrame = null;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.on = true; this.startFrame = null; }
      else if (e.data === 'stop') { this.on = false; this.port.postMessage({ stopped: true }); }
    };
  }
  process(inputs) {
    if (this.on) {
      if (this.startFrame === null) {
        this.startFrame = currentFrame;
        this.port.postMessage({ startFrame: currentFrame });
      }
      const ch = inputs[0] && inputs[0][0];
      // Copy — the engine reuses the render buffer. A disconnected/silent
      // input yields no channel data; push zeros to keep the stream gapless.
      this.port.postMessage(ch ? ch.slice(0) : new Float32Array(128));
    }
    return true;
  }
});
`;

let recNode = null;
let chunks = [];
let startFrame = null;
let stopAck = null;

async function initRecorder(ctx) {
  if (recNode) return;
  const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  recNode = new AudioWorkletNode(ctx, 'hkl-recorder', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
  });
  tapMaster(recNode);
  recNode.connect(ctx.destination); // silent output; pulled so process() runs
  recNode.port.onmessage = (e) => {
    const d = e.data;
    if (d instanceof Float32Array) chunks.push(d);
    else if (d && d.startFrame != null) startFrame = d.startFrame;
    else if (d && d.stopped && stopAck) { const r = stopAck; stopAck = null; r(); }
  };
}

function startCapture() {
  chunks = [];
  startFrame = null;
  recNode.port.postMessage('start');
}

// Port messages are ordered: the 'stopped' ack arrives after every chunk the
// processor posted before it, so awaiting the ack means chunks[] is complete.
function stopCapture() {
  return new Promise((resolve) => {
    stopAck = resolve;
    recNode.port.postMessage('stop');
  });
}

function concatCapture() {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ── timing helpers ────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sub-ms yield: MessageChannel posts are not subject to the ~4ms nested
// setTimeout clamp, so tight spins around a switchTime stay tight.
function tick() {
  return new Promise((resolve) => {
    const mc = new MessageChannel();
    mc.port1.onmessage = () => { mc.port1.close(); resolve(); };
    mc.port2.postMessage(0);
  });
}

// Wait until ctx.currentTime >= t: coarse setTimeout to just short of the
// target, then MessageChannel spin. currentTime itself quantizes at the render
// boundary (~2.9ms @ 44100/128) — the report's recipes tolerate that; actual
// call times are what the event log records.
async function untilCtxTime(t, spinLeadMs = 8) {
  const ctx = getCtx();
  const lead = (t - ctx.currentTime) * 1000 - spinLeadMs;
  if (lead > 0) await sleep(lead);
  while (ctx.currentTime < t) await tick();
}

// ── event log ─────────────────────────────────────────────────────────────
let events = [];

function snapVoice(key) {
  const v = getActiveVoices()[key];
  if (!v) return null;
  const ps = v.pendingSwitch;
  return {
    alive: !!v.alive,
    vol: v.vol,
    pendingSwitch: ps ? { switchTime: ps.switchTime, xfDur: ps.xfDur } : null,
  };
}

/* Record {t, call, key, args, pre-call voice snapshot}, then invoke. `t` is a
   JS-thread currentTime read — stale exactly the way the engine's own reads
   are, which is fine: the correlator matches with a ±few-ms window. `args`
   lets the correlator recover scheduled times (sNoteOn startAt / sNoteOnFaded
   atTime) for onset classification. */
function call(name, fn, key, ...args) {
  const ev = { t: getCtx().currentTime, call: name, key, args, pre: snapVoice(key) };
  events.push(ev);
  const ret = fn(key, ...args);
  return ret;
}

// ── shared scenario state ─────────────────────────────────────────────────
let instrKey = null;

async function setup() {
  const ctx = await ensureEngine();
  await ctx.resume();
  await initRecorder(ctx);
  if (!instrKey) {
    const { key } = await loadBundle(INSTRUMENT_FILE);
    instrKey = key;
    onSeam((ev) => events.push({
      t: ev.ctxTime, call: 'seamCommit', key: ev.voiceKey, kind: ev.kind, xfDur: ev.xfadeDur,
      deferredMs: ev.deferredMs || 0,
    }));
  }
  return ctx;
}

async function waitPendingSwitch(key, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const ps = getActiveVoices()[key]?.pendingSwitch;
    if (ps) return { switchTime: ps.switchTime, xfDur: ps.xfDur };
    if (performance.now() > deadline) throw new Error(`no pendingSwitch on '${key}' within ${timeoutMs}ms`);
    await sleep(5);
  }
}

/* A pendingSwitch whose cut target is safely aimable: switchTime − clearSec is
   still comfortably in the future. When the current switch is already too
   close (or in flight — a stale read after a long sleep landed the first
   'clean' run's note-off at 78% of a live fade, instantly reproducing the
   bug), wait for it to commit and aim at the NEXT one instead. */
async function waitAimablePendingSwitch(key, clearSec) {
  const ctx = getCtx();
  for (;;) {
    const ps = await waitPendingSwitch(key);
    if (ps.switchTime - clearSec > ctx.currentTime + 0.030) return ps;
    await untilCtxTime(ps.switchTime + ps.xfDur + 0.020);
    await sleep(10); // let the commit timer fire and re-schedule
  }
}

// ── scenarios ─────────────────────────────────────────────────────────────
const SCENARIOS = {

  /* Clean hold: one note, no interference, note-off placed 150ms clear of the
     upcoming switch (cancel takes its safe before-branch). Baseline for the
     detector's injection validation, and a categorical-zero control. */
  async clean({ holdSec = 10 } = {}) {
    const key = 'clean';
    call('sNoteOn', sNoteOn, key, BASE, 100, instrKey);
    await sleep(holdSec * 1000);
    const ps = await waitAimablePendingSwitch(key, 0.150);
    await untilCtxTime(ps.switchTime - 0.150);
    call('sNoteOff', sNoteOff, key);
    await sleep(400);
    return { holdSec };
  },

  /* R1 — the on-demand note-switch click. Aim sNoteOff to land at
     switchTime + xfDur×offset, inside the crossfade. Expected pre-fix: a
     defect EVERY time, amplitude growing with offset. */
  async r1({ reps = 4, offsets = [0.25, 0.5, 0.75], control = false } = {}) {
    const cuts = [];
    let i = 0;
    for (let rep = 0; rep < reps; rep++) {
      for (const off of offsets) {
        const key = `r1-${i++}`;
        call('sNoteOn', sNoteOn, key, BASE, 100, instrKey);
        const ps = await waitAimablePendingSwitch(key, control ? 0.150 : 0);
        const target = control ? ps.switchTime - 0.150 : ps.switchTime + ps.xfDur * off;
        await untilCtxTime(target);
        const tCut = getCtx().currentTime;
        call('sNoteOff', sNoteOff, key);
        cuts.push({
          key, switchTime: ps.switchTime, xfDur: ps.xfDur,
          intendedOffset: control ? null : off, tCut,
          actualOffset: control ? null : (tCut - ps.switchTime) / ps.xfDur,
        });
        await sleep(450); // release (150ms) + old-source tail + settle
      }
    }
    return { cuts, control };
  },

  /* R1-control — same shape, note-off 150ms clear of any switch window.
     Expected: categorical zero. */
  async 'r1-control'(opts = {}) {
    return SCENARIOS.r1({ ...opts, control: true });
  },

  /* R2 — the tuning race, exactly the consumer cadence: sRampFreq(f·(1±δ))
     every `periodMs` for `durationSec`. Clicks cluster at seam switchTimes. */
  async r2({ durationSec = 60, periodMs = 20, rampSec = 0.045, delta = 0.003 } = {}) {
    const key = 'r2';
    call('sNoteOn', sNoteOn, key, BASE, 100, instrKey);
    await sleep(300);
    let up = false, nCalls = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < durationSec * 1000) {
      up = !up;
      call('sRampFreq', sRampFreq, key, BASE * (up ? 1 + delta : 1 - delta), rampSec);
      nCalls++;
      await sleep(periodMs);
    }
    call('sNoteOff', sNoteOff, key);
    await sleep(400);
    return { nCalls, durationSec, periodMs };
  },

  /* R2-sharpened — hammer sRampFreq at sub-ms cadence across each
     [switchTime−10ms, switchTime+10ms] window so calls whose JS clock read
     straddles the boundary take the cancel path on a started source. */
  async 'r2-sharpened'({ seams = 40, delta = 0.003, rampSec = 0.045 } = {}) {
    const key = 'r2s';
    call('sNoteOn', sNoteOn, key, BASE, 100, instrKey);
    const ctx = getCtx();
    let hammered = 0, nCalls = 0, up = false;
    const tEnd = performance.now() + 90_000; // hard wall so a stall can't hang the run
    while (hammered < seams && performance.now() < tEnd) {
      const ps = getActiveVoices()[key]?.pendingSwitch;
      if (!ps) { await sleep(5); continue; }
      if (ps.switchTime - ctx.currentTime > 0.020) {
        await untilCtxTime(ps.switchTime - 0.012);
        continue;
      }
      const windowEnd = ps.switchTime + 0.010;
      while (ctx.currentTime < windowEnd) {
        up = !up;
        call('sRampFreq', sRampFreq, key, BASE * (up ? 1 + delta : 1 - delta), rampSec);
        nCalls++;
        await tick(); await tick();
      }
      hammered++;
      await sleep(40); // let the (possibly re-scheduled) seam settle before re-arming
    }
    call('sNoteOff', sNoteOff, key);
    await sleep(400);
    return { hammered, nCalls };
  },

  /* R2-snipe — the surgical Cause-2 experiment. The hammer variant defers the
     seam it aims at: every pre-boundary sRampFreq reschedules the switch with
     scheduleSegmentSwitch's now+5ms clamp, so the fade never starts under it.
     And currentTime only publishes AFTER a block renders, so the true race
     window per seam is the audio callback's compute span (control-message
     drain → currentTime publish) — sub-ms on desktop. So: ONE call per seam,
     fired one quantum after an observed currentTime flip when switchTime sits
     inside the block being rendered next, aiming the stop-post into that
     window. Hits are cuts a few ms into the fade; count categorically. */
  async 'r2-snipe'({ attempts = 60, delta = 0.003, rampSec = 0.045 } = {}) {
    const key = 'r2sn';
    call('sNoteOn', sNoteOn, key, BASE, 100, instrKey);
    const ctx = getCtx();
    const quantumMs = (128 / ctx.sampleRate) * 1000;
    let sniped = 0, up = false;
    const tEnd = performance.now() + 120_000; // hard wall
    while (sniped < attempts && performance.now() < tEnd) {
      const ps = getActiveVoices()[key]?.pendingSwitch;
      if (!ps) { await sleep(5); continue; }
      if (ps.switchTime - ctx.currentTime > 0.030) {
        await untilCtxTime(ps.switchTime - 0.020);
        continue;
      }
      // Observe a fresh currentTime publish…
      const v0 = ctx.currentTime;
      while (ctx.currentTime === v0) await tick();
      const v1 = ctx.currentTime;
      const wallFlip = performance.now();
      // …and snipe only when the fade block is the NEXT one to render.
      if (!(v1 < ps.switchTime && ps.switchTime <= v1 + quantumMs / 1000)) continue;
      while (performance.now() - wallFlip < quantumMs * 0.98) { /* sync spin — no yield */ }
      up = !up;
      call('sRampFreq', sRampFreq, key, BASE * (up ? 1 + delta : 1 - delta), rampSec);
      sniped++;
      await sleep(60); // clear the (possibly deferred/committed) seam
    }
    call('sNoteOff', sNoteOff, key);
    await sleep(400);
    return { sniped };
  },

  /* Cadence sweep — same total pitch trajectory (triangle drag, ±spanCents
     per leg), issued at three cadences:
       pair40 — a call every 40ms, 45ms ramps (Intonalogy's throttle)
       p100   — a call every 100ms, 105ms ramps
       single — ONE call per leg with a leg-long ramp (continuous-API proxy)
     Quantifies how much the command-hammering workaround contributes. */
  async cadence({ mode = 'pair40', spanCents = 50, legSec = 2, legs = 20 } = {}) {
    const key = `cad-${mode}`;
    call('sNoteOn', sNoteOn, key, BASE, 100, instrKey);
    await sleep(300);
    const cfg = {
      pair40: { periodMs: 40, rampSec: 0.045 },
      p100: { periodMs: 100, rampSec: 0.105 },
      single: null,
    }[mode];
    if (cfg === undefined) throw new Error(`unknown cadence mode '${mode}'`);
    let nCalls = 0;
    for (let leg = 0; leg < legs; leg++) {
      const fromCents = (leg % 2 === 0) ? 0 : spanCents;
      const toCents = (leg % 2 === 0) ? spanCents : 0;
      if (!cfg) {
        call('sRampFreq', sRampFreq, key, BASE * Math.pow(2, toCents / 1200), legSec);
        nCalls++;
        await sleep(legSec * 1000);
      } else {
        const steps = Math.round((legSec * 1000) / cfg.periodMs);
        for (let s = 1; s <= steps; s++) {
          const c = fromCents + (toCents - fromCents) * (s / steps);
          call('sRampFreq', sRampFreq, key, BASE * Math.pow(2, c / 1200), cfg.rampSec);
          nCalls++;
          await sleep(cfg.periodMs);
        }
      }
    }
    call('sNoteOff', sNoteOff, key);
    await sleep(400);
    return { mode, nCalls, legs, legSec };
  },

  /* Melody-shaped run — mirrors the consumer exactly: sustained drone plus a
     note every 0.5s (first plain sNoteOn, rest sNoteOnFaded(vol, 0.1), each
     strike landing where its predecessor releases); note-offs from wall
     timers at their due times. Every detected click should coincide with a
     note-off whose voice had pendingSwitch set in-window. */
  async melody({ passes = 8, noteSec = 0.5 } = {}) {
    const notes = [220, 247.5, 264, 293.33, 330, 264]; // JI walk around A3
    for (let p = 0; p < passes; p++) {
      const drone = `mel${p}-drone`;
      call('sNoteOn', sNoteOn, drone, 110, 90, instrKey);
      const t0 = getCtx().currentTime + 0.15;
      notes.forEach((f, i) => {
        const key = `mel${p}-${i}`;
        const at = t0 + i * noteSec;
        if (i === 0) call('sNoteOn', sNoteOn, key, f, 100, instrKey, at);
        else call('sNoteOnFaded', sNoteOnFaded, key, f, 0.79, 0.1, instrKey, at);
      });
      await Promise.all(notes.map(async (f, i) => {
        const key = `mel${p}-${i}`;
        const due = t0 + (i + 1) * noteSec;
        await untilCtxTime(due);
        call('sNoteOff', sNoteOff, key, due);
      }));
      await untilCtxTime(t0 + notes.length * noteSec + 0.1);
      call('sNoteOff', sNoteOff, drone);
      await sleep(500);
    }
    return { passes, notes };
  },
};

// ── driver surface ────────────────────────────────────────────────────────
let lastPcm = null;

window.__repro = {
  /* Sanity probe for the driver: engine up, clock advancing, tap audible. */
  async smoke() {
    const ctx = await setup();
    events = [];
    startCapture();
    call('sNoteOn', sNoteOn, 'smoke', BASE, 100, instrKey);
    await sleep(500);
    call('sNoteOff', sNoteOff, 'smoke');
    await sleep(300);
    await stopCapture();
    const pcm = concatCapture();
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
    return {
      ctxTime: ctx.currentTime, sampleRate: ctx.sampleRate,
      captured: pcm.length, peak,
      ok: ctx.currentTime > 0.5 && pcm.length > 0.5 * ctx.sampleRate && peak > 0.01,
    };
  },

  async run(name, opts = {}) {
    if (!SCENARIOS[name]) throw new Error(`unknown scenario '${name}'`);
    await setup();
    events = [];
    startCapture();
    const info = await SCENARIOS[name](opts);
    await sleep(300); // capture the tail
    await stopCapture();
    lastPcm = concatCapture();
    return {
      scenario: name, info, events,
      startFrame, sampleRate: getCtx().sampleRate, length: lastPcm.length,
    };
  },

  /* Base64 chunk transfer of the last run's Float32 PCM (offset/count in
     float32 samples). The driver reassembles and writes the WAV. */
  pcmChunk(offset, count) {
    const n = Math.min(count, lastPcm.length - offset);
    if (n <= 0) return '';
    const bytes = new Uint8Array(lastPcm.buffer, lastPcm.byteOffset + offset * 4, n * 4);
    let s = '';
    const STEP = 0x8000;
    for (let i = 0; i < bytes.length; i += STEP) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + STEP, bytes.length)));
    }
    return btoa(s);
  },
};
