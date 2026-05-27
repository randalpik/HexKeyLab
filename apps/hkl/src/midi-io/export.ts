// .hkr → MIDI export. Single-track, format-0 MIDI with MPE configuration:
//   • Channel 1 (manager) carries MPE config + CC4 + CC64
//   • Channels 2..16 (members) carry one voice each, with ±48-semitone bend
//
// Tempo is fixed at 120 BPM; PPQ = 960. Timing resolution after tick rounding
// is ~0.5 ms, sufficient given that the .hkr stays the canonical record.

import { writeMidi } from 'midi-file';
import type { MidiEvent, MidiData } from 'midi-file';
import { MpeAllocator } from './allocator.js';
import { coordToMidi } from './mpe.js';
import type { HkrSession } from '../recording/types.js';
import type { KeyId } from '../types.js';

const PPQ = 960;
const TEMPO_US_PER_BEAT = 500000; /* 120 BPM */
const TICKS_PER_SEC = (PPQ * 1_000_000) / TEMPO_US_PER_BEAT;
const MASTER_CH0 = 0;             /* channel 1 in 1-indexed terms */
const MPE_NUM_MEMBERS = 15;
const PITCH_BEND_RANGE_SEMIS = 48;

interface TimedEvent { t: number; ord: number; event: MidiEvent }

function ctrl(ch0: number, type: number, value: number): MidiEvent {
  return { deltaTime: 0, type: 'controller', channel: ch0, controllerType: type, value };
}

function setBendRange(ch0: number, semitones: number, out: MidiEvent[]): void {
  out.push(ctrl(ch0, 101, 0));            /* RPN MSB = 0 */
  out.push(ctrl(ch0, 100, 0));            /* RPN LSB = 0 (pitch bend range) */
  out.push(ctrl(ch0, 6, semitones));      /* Data Entry MSB = semitones */
  out.push(ctrl(ch0, 38, 0));             /* Data Entry LSB = cents */
}

function mpeConfigurationMessage(out: MidiEvent[]): void {
  /* RPN 6 (MPE Configuration Message) on the manager channel.
     value = number of member channels in the zone (15 = full lower zone). */
  out.push(ctrl(MASTER_CH0, 101, 0));
  out.push(ctrl(MASTER_CH0, 100, 6));
  out.push(ctrl(MASTER_CH0, 6, MPE_NUM_MEMBERS));
  out.push(ctrl(MASTER_CH0, 38, 0));
}

export function sessionToMidi(session: HkrSession): Uint8Array {
  const allocator = new MpeAllocator();
  const heldNote: Map<KeyId, number> = new Map(); /* coord -> MIDI note for off-emission */
  const timed: TimedEvent[] = [];
  let ord = 0;

  /* ── Preamble (all at t=0) ───────────────────────────────────────────── */
  const preamble: MidiEvent[] = [];
  mpeConfigurationMessage(preamble);
  for (let ch0 = 1; ch0 <= MPE_NUM_MEMBERS; ch0++) {
    setBendRange(ch0, PITCH_BEND_RANGE_SEMIS, preamble);
  }

  /* ── Walk session events ─────────────────────────────────────────────── */
  for (const ev of session.events) {
    switch (ev.k) {
      case 'on': {
        const key: KeyId = ev.q + ',' + ev.r;
        const { channel, evicted } = allocator.acquire(key);
        const ch0 = channel - 1;
        if (evicted) {
          const prevNote = heldNote.get(evicted);
          if (prevNote !== undefined) {
            timed.push({ t: ev.t, ord: ord++, event: {
              deltaTime: 0, type: 'noteOff', channel: ch0,
              noteNumber: prevNote, velocity: 0,
            }});
            heldNote.delete(evicted);
          }
        }
        const { note, bend14 } = coordToMidi(ev.q, ev.r, session.snapshot);
        timed.push({ t: ev.t, ord: ord++, event: {
          deltaTime: 0, type: 'pitchBend', channel: ch0, value: bend14 - 8192,
        }});
        timed.push({ t: ev.t, ord: ord++, event: {
          deltaTime: 0, type: 'noteOn', channel: ch0, noteNumber: note, velocity: ev.v,
        }});
        heldNote.set(key, note);
        break;
      }
      case 'off': {
        const key: KeyId = ev.q + ',' + ev.r;
        const ch = allocator.channelOf(key);
        if (ch !== null) {
          const note = heldNote.get(key);
          if (note !== undefined) {
            timed.push({ t: ev.t, ord: ord++, event: {
              deltaTime: 0, type: 'noteOff', channel: ch - 1,
              noteNumber: note, velocity: 0,
            }});
            heldNote.delete(key);
          }
          allocator.release(key);
        }
        break;
      }
      case 'pa': {
        const key: KeyId = ev.q + ',' + ev.r;
        const ch = allocator.channelOf(key);
        const note = heldNote.get(key);
        if (ch !== null && note !== undefined) {
          timed.push({ t: ev.t, ord: ord++, event: {
            deltaTime: 0, type: 'noteAftertouch', channel: ch - 1,
            noteNumber: note, amount: ev.p,
          }});
        }
        break;
      }
      case 'cc4': {
        timed.push({ t: ev.t, ord: ord++, event:
          ctrl(MASTER_CH0, 4, Math.max(0, Math.min(127, Math.round(ev.v * 127)))) });
        break;
      }
      case 'cc64': {
        timed.push({ t: ev.t, ord: ord++, event:
          ctrl(MASTER_CH0, 64, ev.v >= 0.5 ? 127 : 0) });
        break;
      }
      case 'warn':
        /* Diagnostic events are not exported to MIDI. */
        break;
    }
  }

  /* Stable sort: primary on t, secondary on insertion order (preserves
     pitchBend-before-noteOn invariant we built above). */
  timed.sort((a, b) => (a.t - b.t) || (a.ord - b.ord));

  /* ── Build the track: tempo → time sig → preamble → timed events → EOT ── */
  const track: MidiEvent[] = [];
  track.push({ deltaTime: 0, type: 'setTempo', microsecondsPerBeat: TEMPO_US_PER_BEAT });
  track.push({ deltaTime: 0, type: 'timeSignature',
    numerator: 4, denominator: 4, metronome: 24, thirtyseconds: 8 });
  for (const e of preamble) track.push(e);

  let lastTick = 0;
  for (const te of timed) {
    const tick = Math.max(0, Math.round(te.t * TICKS_PER_SEC));
    te.event.deltaTime = Math.max(0, tick - lastTick);
    track.push(te.event);
    lastTick = tick;
  }

  track.push({ deltaTime: 0, type: 'endOfTrack' });

  const midiData: MidiData = {
    header: { format: 0, numTracks: 1, ticksPerBeat: PPQ },
    tracks: [track],
  };
  return new Uint8Array(writeMidi(midiData));
}
