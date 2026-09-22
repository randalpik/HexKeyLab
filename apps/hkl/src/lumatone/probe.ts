// Lumatone liveness-probe instrument (diagnostic; not wired into any hot path).
//
// Exists to answer two questions before the power-off note guard is designed:
//
//   1. How long does a SysEx probe round trip take? That is the latency every
//      quarantined note would pay in the device-is-alive case, so it decides
//      whether quarantining on a velocity-127 note is viable at all.
//   2. Does the BBB stop answering when the keybed dies? Every sysexResponse*
//      handler in the firmware answers from the BBB's own kbd_preset_params
//      memory — getMaxPic/getMinPic/getValidPic are reachable only from
//      writeToPic, i.e. the main poll loop — so NO SysEx command forces a PIC
//      round trip. A probe can only prove the BBB is alive. If the BBB
//      outlives the octave boards, probe-based confirmation cannot work and
//      the guard needs a different mechanism.
//
// `watch()` answers (2) directly and in the terms the design cares about:
// it probes continuously across a power-off and timestamps both the probe
// results and the inbound note-ons, so the burst can be read against the last
// answered probe.
//
// Console API (also logged on load):
// OUTCOME (2026-09-21): probe-based confirmation was ABANDONED. Under load the
// measured round trip reaches hundreds of ms because it is timestamped on
// HKL's own main thread — it reports our jank, not the device — and Web MIDI
// is unavailable in workers, so the clock cannot be moved off that thread.
// The instrument is kept because it is the only Lumatone timing/teardown
// probe we have, and it attaches its MIDI monitor only while a run is active.
//
//   lumaprobe.latency()            — round-trip stats per board
//   lumaprobe.watch()              — start the power-off watch, then cut power
//   lumaprobe.dump()               — print the correlated timeline
//   lumaprobe.stop()               — stop the watch
//
// GET_BOARD_THRESHOLDS (0x3A) is used as the probe: verified pure-read in the
// firmware (sysexResponseKeyThreshold calls only sysexFillResponsePreamble,
// sysexFrameBytetoNibble and writeToMidi), so it is safe to fire repeatedly.

import { midi } from '../state/midi.js';
import { setMidiMonitor } from '../midi/handler.js';
import { sysex } from './sysex.js';
import {
  SYSEX_MANU, SYSEX_ACK, SYSEX_NACK, SYSEX_BUSY,
  SYSEX_CMD_GET_BOARD_THRESHOLDS, SYSEX_CMD_GET_FIRMWARE_REVISION,
  buildBoardRequestSysEx, sysexBoardFor,
} from './protocol.js';

const DEFAULT_TIMEOUT_MS = 500;

interface Pending {
  board: number;
  cmd: number;
  t0: number;
  resolve: (r: ProbeResult) => void;
  timer: number;
}
export interface ProbeResult {
  board: number;
  cmd: number;
  ok: boolean;
  ms: number;
  /** ACK / NACK / BUSY / STATE(0x04) / other byte, or 'timeout' */
  status: string;
}

let pending: Pending[] = [];

function statusName(b: number): string {
  if (b === SYSEX_ACK) return 'ACK';
  if (b === SYSEX_NACK) return 'NACK';
  if (b === SYSEX_BUSY) return 'BUSY';
  if (b === 0x04) return 'STATE';
  return '0x' + b.toString(16).padStart(2, '0');
}

/* Passive monitor, registered onto the MIDI handler. Never consumes: the
   message still flows on to the normal routing, so the SysEx queue is
   completely unaffected by this module being active. */
export function probeMonitor(data: Uint8Array): void {
  const now = performance.now();
  if (data[0] === 0xF0) {
    if (data.length < 7) return;
    if (data[1] !== SYSEX_MANU[0] || data[2] !== SYSEX_MANU[1] || data[3] !== SYSEX_MANU[2]) return;
    const i = pending.findIndex((p) => p.board === data[4] && p.cmd === data[5]);
    if (i < 0) return;
    const p = pending[i];
    pending.splice(i, 1);
    clearTimeout(p.timer);
    p.resolve({ board: p.board, cmd: p.cmd, ok: data[6] === SYSEX_ACK, ms: now - p.t0, status: statusName(data[6]) });
    return;
  }
  /* note-on: what we are trying to catch the device emitting at power-off */
  if (watching && (data[0] & 0xf0) === 0x90 && data.length > 2 && data[2] > 0) {
    timeline.push({ t: now, kind: 'note', text: 'ch=' + ((data[0] & 0x0f) + 1) + ' note=' + data[1] + ' vel=' + data[2] });
    if (probeOnNote) {
      const vel = data[2];
      void probeOnce(1, SYSEX_CMD_GET_BOARD_THRESHOLDS, 150).then((r) => {
        noteProbes.push({ noteT: now, status: r.status, ms: r.ms });
        timeline.push({
          t: performance.now(), kind: 'noteprobe',
          text: `${r.status} ${r.ms.toFixed(1)}ms  (probe fired at note vel=${vel}, t+${(performance.now() - now).toFixed(1)}ms)`,
        });
      });
    }
  }
}

export function probeOnce(board: number, cmd = SYSEX_CMD_GET_BOARD_THRESHOLDS,
                          timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProbeResult> {
  return new Promise((resolve) => {
    if (!midi.midiOut) { resolve({ board, cmd, ok: false, ms: 0, status: 'no-port' }); return; }
    const t0 = performance.now();
    const timer = window.setTimeout(() => {
      pending = pending.filter((p) => p.t0 !== t0);
      resolve({ board, cmd, ok: false, ms: performance.now() - t0, status: 'timeout' });
    }, timeoutMs);
    pending.push({ board, cmd, t0, resolve, timer });
    try {
      midi.midiOut.send(buildBoardRequestSysEx(board, cmd));
    } catch (e) {
      clearTimeout(timer);
      pending = pending.filter((p) => p.t0 !== t0);
      resolve({ board, cmd, ok: false, ms: performance.now() - t0, status: 'send-threw' });
    }
  });
}

function stats(xs: number[]): string {
  if (!xs.length) return 'n/a';
  const s = xs.slice().sort((a, b) => a - b);
  const q = (f: number) => s[Math.min(s.length - 1, Math.floor(s.length * f))];
  return `min ${s[0].toFixed(2)}  med ${q(0.5).toFixed(2)}  p95 ${q(0.95).toFixed(2)}  max ${s[s.length - 1].toFixed(2)}`;
}

/** Round-trip stats. Sequential (never overlapping) so each sample is a clean
 *  round trip rather than a pipelined one. */
export async function latency(iterations = 30): Promise<void> {
  if (!midi.midiOut) { console.warn('[lumaprobe] no Lumatone output port'); return; }
  if (sysex.isInProgress) console.warn('[lumaprobe] a SysEx push is in progress — results will be skewed; retry when Idle');
  console.log(`[lumaprobe] ${iterations} probes per target…`);
  setMidiMonitor(probeMonitor);
  try {
  const rows: string[] = [];
  /* board 0 + firmware revision = the BBB-only baseline */
  const targets: { label: string; board: number; cmd: number }[] = [
    { label: 'GET_FIRMWARE_REVISION (global)', board: 0x00, cmd: SYSEX_CMD_GET_FIRMWARE_REVISION },
  ];
  for (let g = 0; g < 5; g++) {
    targets.push({ label: `GET_BOARD_THRESHOLDS board ${sysexBoardFor(g)} (group ${g})`, board: sysexBoardFor(g), cmd: SYSEX_CMD_GET_BOARD_THRESHOLDS });
  }
  for (const t of targets) {
    const ms: number[] = [];
    const statusCount: Record<string, number> = {};
    for (let i = 0; i < iterations; i++) {
      const r = await probeOnce(t.board, t.cmd);
      statusCount[r.status] = (statusCount[r.status] ?? 0) + 1;
      if (r.status !== 'timeout') ms.push(r.ms);
      await new Promise((r2) => setTimeout(r2, 10));
    }
    const statuses = Object.entries(statusCount).map(([k, v]) => `${k}×${v}`).join(' ');
    rows.push(`${t.label.padEnd(42)} ${stats(ms).padEnd(52)} ${statuses}`);
  }
  console.log('[lumaprobe] round-trip (ms)\n' + rows.join('\n'));
  } finally { setMidiMonitor(null); }
}

/* ---- power-off watch ---- */
interface Entry { t: number; kind: 'probe' | 'note' | 'noteprobe'; text: string }
let timeline: Entry[] = [];
let watching = false;
let watchTimer: number | null = null;
/* When set, every inbound note-on immediately fires its own probe. This is the
   guard's actual decision, measured: "if a probe is sent the instant a
   suspicious note arrives, does the device still answer?" A timer tick cannot
   answer that — the burst lasts ~7ms and falls between ticks. */
let probeOnNote = false;
const noteProbes: { noteT: number; status: string; ms: number }[] = [];

/** Probe continuously and record note-ons alongside, so the burst can be read
 *  against the last answered probe. Start this, then power the unit off. */
export function watch(intervalMs = 50, autoStopMs = 120000): void {
  if (!midi.midiOut) { console.warn('[lumaprobe] no Lumatone output port'); return; }
  timeline = [];
  noteProbes.length = 0;
  watching = true;
  setMidiMonitor(probeMonitor); /* attached only for the duration of a run */
  let busy = false;
  watchTimer = window.setInterval(async () => {
    if (busy) return;
    busy = true;
    const r = await probeOnce(1, SYSEX_CMD_GET_BOARD_THRESHOLDS, 400);
    timeline.push({ t: performance.now(), kind: 'probe', text: `${r.status} ${r.ms.toFixed(1)}ms` });
    busy = false;
  }, intervalMs);
  window.setTimeout(() => { if (watching) { stop(); console.log('[lumaprobe] watch auto-stopped'); } }, autoStopMs);
  console.log(`[lumaprobe] watching every ${intervalMs}ms. Power the Lumatone OFF now, then run lumaprobe.dump()`);
}

/** The decisive experiment. Probes on EVERY note-on (exactly as the guard
 *  would), plus a slow background tick for context. Start it, play a few real
 *  notes as a control, then cut power. */
export function watchGuard(backgroundMs = 100, autoStopMs = 120000): void {
  probeOnNote = true;
  watch(backgroundMs, autoStopMs);
  console.log('[lumaprobe] GUARD SIMULATION: every note-on fires its own probe.');
  console.log('[lumaprobe] play a few real notes first (control), THEN power off. Then lumaprobe.dump()');
}

export function stop(): void {
  probeOnNote = false;
  watching = false;
  setMidiMonitor(null);
  if (watchTimer !== null) { clearInterval(watchTimer); watchTimer = null; }
}

export function dump(): void {
  if (!timeline.length) { console.log('[lumaprobe] timeline empty — run lumaprobe.watch() first'); return; }
  const t0 = timeline[0].t;
  const lines = timeline.map((e) => `${(e.t - t0).toFixed(1).padStart(10)}ms  ${e.kind.padEnd(5)}  ${e.text}`);
  const notes = timeline.filter((e) => e.kind === 'note');
  const lastOk = [...timeline].reverse().find((e) => e.kind === 'probe' && e.text.startsWith('ACK'));
  const firstBad = timeline.find((e) => e.kind === 'probe' && !e.text.startsWith('ACK'));
  const out: string[] = ['[lumaprobe] timeline', ...lines, ''];
  out.push(`notes seen: ${notes.length}`);
  if (notes.length) out.push(`first note at ${(notes[0].t - t0).toFixed(1)}ms, last at ${(notes[notes.length - 1].t - t0).toFixed(1)}ms`);
  if (lastOk) out.push(`last ACKed probe at ${(lastOk.t - t0).toFixed(1)}ms`);
  if (firstBad) out.push(`first non-ACK probe at ${(firstBad.t - t0).toFixed(1)}ms  (${firstBad.text})`);
  if (noteProbes.length) {
    const acked = noteProbes.filter((n) => n.status === 'ACK').length;
    out.push('', `note-triggered probes: ${noteProbes.length}  (${acked} ACKed, ${noteProbes.length - acked} not)`);
    for (const n of noteProbes) out.push(`   note at ${(n.noteT - t0).toFixed(1)}ms -> ${n.status} in ${n.ms.toFixed(1)}ms`);
    const lastAcked = noteProbes.filter((n) => n.status === 'ACK').map((n) => n.noteT).pop();
    const firstNot = noteProbes.filter((n) => n.status !== 'ACK').map((n) => n.noteT)[0];
    if (lastAcked !== undefined && firstNot !== undefined && lastAcked < firstNot) {
      out.push(`\n=> the device kept ACKing for ${(lastAcked - notes[0].t).toFixed(1)}ms after the first note of the burst.`);
      out.push('   A single probe is NOT sufficient: the confirmation window must exceed that.');
    } else if (firstNot !== undefined && lastAcked === undefined) {
      out.push('\n=> NO note-triggered probe was answered. A single probe at the trigger note is sufficient.');
    }
  }
  if (notes.length && firstBad) {
    const d = notes[0].t - firstBad.t;
    out.push(d > 0
      ? `\n=> probes FAILED ${d.toFixed(1)}ms BEFORE the first garbage note — probe-based confirmation WOULD catch it`
      : `\n=> first garbage note arrived ${(-d).toFixed(1)}ms BEFORE probes failed — the BBB outlived the keybed, so a probe alone CANNOT confirm death`);
  }
  console.log(out.join('\n'));
}

interface ProbeWindow extends Window { lumaprobe?: Record<string, unknown> }
(window as ProbeWindow).lumaprobe = { latency, watch, watchGuard, stop, dump, probeOnce };
console.log('%c[lumaprobe] lumaprobe.latency() · lumaprobe.watchGuard() · lumaprobe.dump()', 'color:#0ff;font-weight:bold');
