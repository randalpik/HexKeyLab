// MIDI → .hkr import. Requires the originating layout snapshot to recover
// lattice coordinates from (note, channel-bend) — the inverse uses a
// frequency index built over the lattice under the snapshot's tuning state.
//
// Out-of-tolerance matches (>25 cents) are rejected and a `warn` event is
// emitted in their place, so the user can inspect what got skipped.

import { parseMidi } from 'midi-file';
import type { MidiEvent } from 'midi-file';
import { coordToMidi, midiToFreq, snapshotToTuningState } from './mpe.js';
import { keyFreqWithState } from '../tuning/frequency.js';
import type { HkrSession, HkrEvent, LayoutSnapshot } from '../recording/types.js';

const TOLERANCE_CENTS = 25;
const Q_MIN = -30, Q_MAX = 30;
const R_MIN = -16, R_MAX = 16;

interface FreqIndexEntry { logF: number; q: number; r: number }

function buildFreqIndex(snapshot: LayoutSnapshot): FreqIndexEntry[] {
  const state = snapshotToTuningState(snapshot);
  const entries: FreqIndexEntry[] = [];
  for (let q = Q_MIN; q <= Q_MAX; q++) {
    for (let r = R_MIN; r <= R_MAX; r++) {
      const f = keyFreqWithState(q, r, state);
      if (f > 0 && Number.isFinite(f)) entries.push({ logF: Math.log(f), q, r });
    }
  }
  entries.sort((a, b) => a.logF - b.logF);
  return entries;
}

function lookupNearest(idx: FreqIndexEntry[], targetLog: number): FreqIndexEntry {
  /* Binary search for the closest log-freq entry. */
  let lo = 0, hi = idx.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (idx[mid].logF < targetLog) lo = mid + 1; else hi = mid;
  }
  const a = idx[lo];
  const b = lo > 0 ? idx[lo - 1] : a;
  return Math.abs(a.logF - targetLog) < Math.abs(b.logF - targetLog) ? a : b;
}

interface ParsedHeader {
  ppq: number;
  microsecondsPerBeat: number;
}

function readHeader(parsed: ReturnType<typeof parseMidi>): ParsedHeader {
  const ppq = parsed.header.ticksPerBeat ?? 480;
  /* Find first setTempo across all tracks (it should be at the start of track 0). */
  let mpb = 500000;
  for (const tr of parsed.tracks) {
    let acc = 0;
    for (const ev of tr) {
      acc += ev.deltaTime;
      if (ev.type === 'setTempo') { mpb = ev.microsecondsPerBeat; break; }
      if (acc > 0) break; /* only inspect the first tick window for the initial tempo */
    }
  }
  return { ppq, microsecondsPerBeat: mpb };
}

interface AbsEvent { t: number; event: MidiEvent }

function flattenAbsoluteEvents(parsed: ReturnType<typeof parseMidi>, header: ParsedHeader): AbsEvent[] {
  const ticksPerSec = (header.ppq * 1_000_000) / header.microsecondsPerBeat;
  const out: AbsEvent[] = [];
  for (const tr of parsed.tracks) {
    let acc = 0;
    for (const ev of tr) {
      acc += ev.deltaTime;
      out.push({ t: acc / ticksPerSec, event: ev });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/* Import a MIDI byte array, interpreting (note, bend) tuples against the
   supplied snapshot's lattice. Returns an HkrSession; the snapshot becomes
   that session's snapshot too (so save+load works without re-prompting). */
export function midiToSession(bytes: ArrayLike<number>, snapshot: LayoutSnapshot): HkrSession {
  const parsed = parseMidi(bytes);
  const header = readHeader(parsed);
  const abs = flattenAbsoluteEvents(parsed, header);

  const index = buildFreqIndex(snapshot);
  const bendByCh: number[] = new Array(16).fill(8192);
  /* Per-channel: which coord+note is currently sounding. Allows
     noteOff/aftertouch lookup to recover the originating coordinate. */
  const heldByCh: Map<number, { q: number; r: number; note: number }> = new Map();

  const events: HkrEvent[] = [];
  let durSec = 0;

  for (const { t, event: ev } of abs) {
    durSec = Math.max(durSec, t);
    if (ev.type === 'pitchBend') {
      /* midi-file's pitchBend.value is signed (-8192..+8191). Re-bias to 14-bit. */
      bendByCh[ev.channel] = 8192 + ev.value;
    } else if (ev.type === 'noteOn' && ev.velocity > 0) {
      const bend14 = bendByCh[ev.channel];
      const f = midiToFreq(ev.noteNumber, bend14);
      const entry = lookupNearest(index, Math.log(f));
      const cents = Math.abs(1200 * (Math.log2(f) - entry.logF / Math.LN2));
      if (cents > TOLERANCE_CENTS) {
        events.push({ t, k: 'warn',
          msg: 'note out of tolerance: ' + cents.toFixed(1) + 'c (note=' + ev.noteNumber + ', ch=' + (ev.channel + 1) + ')' });
        continue;
      }
      heldByCh.set(ev.channel, { q: entry.q, r: entry.r, note: ev.noteNumber });
      events.push({ t, k: 'on', q: entry.q, r: entry.r, v: ev.velocity });
    } else if (ev.type === 'noteOff' || (ev.type === 'noteOn' && ev.velocity === 0)) {
      const held = heldByCh.get(ev.channel);
      if (held && held.note === ev.noteNumber) {
        events.push({ t, k: 'off', q: held.q, r: held.r });
        heldByCh.delete(ev.channel);
      }
    } else if (ev.type === 'noteAftertouch') {
      const held = heldByCh.get(ev.channel);
      if (held && held.note === ev.noteNumber) {
        events.push({ t, k: 'pa', q: held.q, r: held.r, p: ev.amount });
      }
    } else if (ev.type === 'controller') {
      if (ev.controllerType === 4) {
        events.push({ t, k: 'cc4', v: ev.value / 127 });
      } else if (ev.controllerType === 64) {
        events.push({ t, k: 'cc64', v: ev.value >= 64 ? 1 : 0 });
      }
      /* Other CCs (RPN sequencing, MPE config) are ignored. */
    }
  }

  return {
    format: 'hkr',
    version: 1,
    createdAt: new Date().toISOString(),
    durationSec: durSec,
    timing: { unit: 'audioCtxSec', epoch: 0 },
    snapshot,
    events,
  };
}

/* Used by the verification harness — also tests that coordToMidi round-trips
   correctly under the saved snapshot. Returns a list of {q, r, cents} tuples
   where re-import disagreed by more than `epsilon` cents. */
export function selfTestRoundTrip(snapshot: LayoutSnapshot, epsilon = 0.5): Array<{ q: number; r: number; cents: number }> {
  const drift: Array<{ q: number; r: number; cents: number }> = [];
  const state = snapshotToTuningState(snapshot);
  for (let q = Q_MIN; q <= Q_MAX; q++) {
    for (let r = R_MIN; r <= R_MAX; r++) {
      const f0 = keyFreqWithState(q, r, state);
      const { note, bend14 } = coordToMidi(q, r, snapshot);
      const f1 = midiToFreq(note, bend14);
      const cents = 1200 * Math.abs(Math.log2(f1 / f0));
      if (cents > epsilon) drift.push({ q, r, cents });
    }
  }
  return drift;
}
