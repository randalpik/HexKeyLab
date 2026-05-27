// Piano output — mirror HKL playback to an external MIDI synth (e.g. Korg
// SP-250) at true just-intonation pitch.
//
// The target synths have no pitch bend and no MPE, but do honour RPN 0001
// (channel fine tuning, ±100¢ over 14 bits). A note-on re-applies the channel's
// current fine-tune to every voice on that channel, so distinct simultaneous
// tunings require distinct channels. We therefore allocate one voice per MIDI
// channel (steal-oldest when all 16 are busy), fine-tune the channel, then
// strike the note.
//
// Hook: syncPianoOut() is driven from syncOutput() (the audio/MIDI fan-out
// convergence point) and tracks selectedKeys ∪ sustainedKeys. It self-gates on
// the enabled flag and is independent of audioEnabled, so the external synth
// can be the sole sound source (mute Audio, enable Piano output). Sustain works
// for free because HKL defers engine note-off until pedal release — the synth
// sees note-off at the right time. Aftertouch is not forwarded (not received).

import { midi } from '../state/midi.js';
import { audio } from '../state/audio.js';
import { selection } from '../state/selection.js';
import { keyFreq } from '../tuning/frequency.js';
import { loadPrefs, savePrefs } from '../state/persistence.js';
import { MpeAllocator } from '../midi-io/allocator.js';
import { DEFAULT_DYNAMIC_MAP } from '../shared/dynamics.js';
import { whenMidiAccessReady } from './engine.js';
import type { KeyId } from '../types.js';

/* ── module state ──────────────────────────────────────────────────────────── */

let enabled = false;

/* The General-MIDI-style program last selected on the synth (captured from the
   Program Change it transmits on a front-panel sound change) — null until one
   is seen. Mirrored across all 16 channels so every voice of a chord uses the
   same instrument instead of channels 2..16 defaulting to piano. */
let currentProgram: number | null = null;

/* One voice per MIDI channel, full 1..16 (no MPE manager channel). Steal-oldest
   LRU when all 16 are in use. */
/* Channels 1..16 minus the SP-250's unusable ones, FIFO so a reused channel's
   release tail has had time to decay:
     - 10: General MIDI percussion (notes play as drums, not pitched).
     - 16: ignores note-off (hung notes) and won't accept RPN fine-tune (stuck
       at 0¢) on this unit — empirically dead for melodic use.
   Leaves 14 melodic channels. */
const alloc = new MpeAllocator(1, 16, 'fifo', [10, 16]);

/* KeyId → the MIDI note number we emitted for it (needed for note-off; the
   allocator only tracks the channel). */
const voiceNote: Map<KeyId, number> = new Map();

/* Wanted keys we've chosen NOT to sound because all melodic channels are busy
   (steal-oldest overflow). They stay OUT of the start loop so we don't
   re-trigger them every sync. Without this, an over-capacity selection
   thrashes catastrophically: each evicted-but-still-wanted key looks "missing"
   on the next pass, gets re-started, and evicts another — a note-off/note-on
   storm across the whole held set. Pruned as keys leave `want`. */
const shed: Set<KeyId> = new Set();

/* ── tuning conversion ─────────────────────────────────────────────────────── */

/** Convert a JI frequency to the nearest 12-TET MIDI note plus the RPN 0001
 *  fine-tune 14-bit value that pitches that note to the exact frequency.
 *  MIDI convention matches the rest of HKL: 69 = A4 = 440 Hz (A3 = 220 = 57).
 *  RPN 0001 spans ±100¢ over 0..16383, centred at 8192 → 81.92 steps/cent.
 *  Snapping to the nearest note keeps the offset within ±50¢, well in range. */
function freqToNoteFine(freq: number): { note: number; fine14: number } {
  const midiFloat = 69 + 12 * Math.log2(freq / 440);
  const note = Math.max(0, Math.min(127, Math.round(midiFloat)));
  const cents = (midiFloat - note) * 100;
  const fine14 = Math.max(0, Math.min(16383, Math.round(8192 + cents * 81.92)));
  return { note, fine14 };
}

/* ── raw MIDI sends ────────────────────────────────────────────────────────── */

function sendFineTune(ch0: number, fine14: number): void {
  const p = midi.pianoOut;
  if (!p) return;
  const cc = 0xb0 | (ch0 & 0x0f);
  p.send([cc, 101, 0x00]);              /* RPN MSB */
  p.send([cc, 100, 0x01]);              /* RPN LSB → RPN 0001 (fine tuning) */
  p.send([cc, 6, (fine14 >> 7) & 0x7f]); /* Data Entry MSB */
  p.send([cc, 38, fine14 & 0x7f]);       /* Data Entry LSB */
  p.send([cc, 101, 0x7f]);              /* RPN Null — deselect (hygiene) */
  p.send([cc, 100, 0x7f]);
}

function sendNoteOn(ch0: number, note: number, vel: number): void {
  midi.pianoOut?.send([0x90 | (ch0 & 0x0f), note, vel]);
}

function sendNoteOff(ch0: number, note: number): void {
  midi.pianoOut?.send([0x80 | (ch0 & 0x0f), note, 0]);
  lastOffAt[(ch0 & 0x0f) + 1] = nowMs();
}

/** All-Notes-Off (CC123) on every channel of a port — used when disabling or
 *  switching ports so nothing is left hanging on the synth. */
function silencePort(port: MIDIOutput): void {
  for (let ch = 0; ch < 16; ch++) port.send([0xb0 | ch, 123, 0]);
}

/** Push the current program to all 16 channels so every voice shares the synth's
 *  selected instrument. Sent outside the per-note bursts (the CH345 adapter drops
 *  bytes under load), and not per note. No-op until a program has been captured. */
function broadcastProgram(): void {
  const port = midi.pianoOut;
  if (!enabled || !port || currentProgram === null) return;
  for (let ch = 0; ch < 16; ch++) port.send([0xc0 | ch, currentProgram]);
}

/* GM treats each channel as an independent "part" with its own volume (CC7) and
   expression (CC11), so spreading voices across channels surfaces their differing
   levels as note-to-note volume jumps. Force every channel to the same level on
   enable/rebind/program-change (outside note bursts). */
const CHANNEL_VOLUME = 100;     // CC7, GM default
const CHANNEL_EXPRESSION = 127; // CC11, full
function broadcastChannelLevels(): void {
  const port = midi.pianoOut;
  if (!enabled || !port) return;
  for (let ch = 0; ch < 16; ch++) {
    port.send([0xb0 | ch, 7, CHANNEL_VOLUME]);
    port.send([0xb0 | ch, 11, CHANNEL_EXPRESSION]);
  }
}

function clampVel(v: number): number {
  return Math.max(1, Math.min(127, Math.round(v)));
}

/* ── temporary diagnostics (remove once the channel-reuse bug is settled) ────
   Set `window.__hklPianoOutLog = false` in the console to silence. The key
   signal is `reuse-gap`: ms since the channel a new note grabs last got a
   note-off. A gap shorter than a piano release tail (~1–2 s) means we reused a
   channel whose previous note is still ringing — the suspected collision. */
const T0 = typeof performance !== 'undefined' ? performance.now() : 0;
const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : 0);
/** ms timestamp of the last note-off we sent on each channel (index = 1..16). */
const lastOffAt: number[] = new Array(17).fill(0);

function plog(...args: unknown[]): void {
  if ((globalThis as { __hklPianoOutLog?: boolean }).__hklPianoOutLog === false) return;
  console.log(`[pout +${(nowMs() - T0).toFixed(0)}ms]`, ...args);
}

function allocSummary(): string {
  const s = alloc.debugState();
  const used = s.inUse.map(([k, ch]) => `ch${ch}=${k}`).join(' ') || '∅';
  return `inUse[${used}] free[${s.free.join(',')}]`;
}

/* ── voice management ──────────────────────────────────────────────────────── */

function startVoice(key: KeyId): void {
  const parts = key.split(',');
  const freq = keyFreq(+parts[0], +parts[1]);
  const { note, fine14 } = freqToNoteFine(freq);
  const { channel, evicted } = alloc.acquire(key);
  const ch0 = channel - 1;
  if (evicted !== null) {
    const en = voiceNote.get(evicted);
    if (en !== undefined) sendNoteOff(ch0, en);
    voiceNote.delete(evicted);
    shed.add(evicted); /* still wanted but now voiceless — don't re-trigger it */
    plog(`SHED ${evicted} (over 14-voice cap)`);
  }
  const vel = clampVel(audio.keyVelocity[key] ?? DEFAULT_DYNAMIC_MAP.mf);
  sendFineTune(ch0, fine14);
  sendNoteOn(ch0, note, vel);
  voiceNote.set(key, note);
  const gap = lastOffAt[channel] ? `${(nowMs() - lastOffAt[channel]).toFixed(0)}ms` : 'fresh';
  plog(
    `ON  ch${channel} note${note} vel${vel} key=${key} fine=${fine14}` +
    (evicted !== null ? ` EVICTED:${evicted}` : '') +
    ` | reuse-gap=${gap}`,
    '|', allocSummary(),
  );
}

function stopVoice(key: KeyId): void {
  const note = voiceNote.get(key);
  if (note === undefined) return;
  const channel = alloc.release(key);
  if (channel !== null) sendNoteOff(channel - 1, note);
  voiceNote.delete(key);
  plog(`OFF ch${channel} note${note} key=${key}`, '|', allocSummary());
}

function clearVoices(): void {
  voiceNote.clear();
  shed.clear();
  alloc.reset();
}

/* ── public sync ───────────────────────────────────────────────────────────── */

/** Reconcile the synth's sounding notes with selectedKeys ∪ sustainedKeys.
 *  Called from syncOutput() on every selection change. */
export function syncPianoOut(): void {
  if (!enabled || !midi.pianoOut) {
    if (voiceNote.size || shed.size) clearVoices();
    return;
  }
  const want = new Set<KeyId>(selection.selectedKeys);
  audio.sustainedKeys.forEach((k) => want.add(k));

  for (const key of [...voiceNote.keys()]) {
    if (!want.has(key)) stopVoice(key);
  }
  /* Forget shed keys that are no longer wanted, so a freed slot can take a new
     note (we deliberately don't resurrect shed keys — that would spuriously
     re-attack long-held notes). */
  for (const key of [...shed]) {
    if (!want.has(key)) shed.delete(key);
  }
  want.forEach((key) => {
    if (!voiceNote.has(key) && !shed.has(key)) startVoice(key);
  });
}

/** Force a re-attack of an already-sounding voice — e.g. a key re-struck while
 *  the sustain pedal is holding it. Membership in selected ∪ sustained doesn't
 *  change across a re-strike, so syncPianoOut's diff alone wouldn't re-fire the
 *  note. We tear the voice down here (note-off + free its channel); the
 *  syncPianoOut the caller triggers immediately after re-acquires the channel
 *  and re-strikes with the updated velocity. No-op if disabled or not sounding. */
export function restrikePianoOut(key: KeyId): void {
  if (!enabled || !midi.pianoOut) return;
  /* A re-struck key that was shed for being over-capacity should now compete
     for a channel again — drop it from shed so the following sync can steal one. */
  shed.delete(key);
  if (voiceNote.has(key)) stopVoice(key);
}

/* ── device binding (auto-match input device by name) ──────────────────────── */

/** Strip a verbose port name to its identity prefix (text before the first
 *  colon), so an input named "SP-250: Port 1" matches an output named
 *  "SP-250: Port 1" or "SP-250". Mirrors piano.ts's shortenDeviceName. */
function namePrefix(name: string | null | undefined): string {
  const raw = name ?? '';
  const colon = raw.indexOf(':');
  return (colon > 0 ? raw.slice(0, colon) : raw).trim();
}

/** Re-resolve midi.pianoOut to the output port matching the selected input
 *  device (midi.pianoIn) by name. Called on enable, on input-device change,
 *  and on MIDIAccess statechange. No-op while disabled. */
export function rebindPianoOut(): void {
  if (!enabled) return;
  let next: MIDIOutput | null = null;
  const access = midi.midiAccess;
  const inName = midi.pianoIn?.name ?? null;
  if (access && inName) {
    for (const out of access.outputs.values()) {
      if (out.name === inName) { next = out; break; }
    }
    if (!next) {
      const prefix = namePrefix(inName);
      for (const out of access.outputs.values()) {
        if (namePrefix(out.name) === prefix) { next = out; break; }
      }
    }
  }
  if (next === midi.pianoOut) return;
  const prev = midi.pianoOut;
  if (prev) silencePort(prev);
  midi.pianoOut = next;
  clearVoices();
  /* Explicitly open the output port. Unlike inputs (which wire their ALSA
     subscription the moment onmidimessage is set), an output isn't routed to
     hardware until open() — Chrome opens eagerly on send(), but Firefox does
     not, leaving the port connected to nothing and every send() silently
     dropped. open() returns a promise; we don't need to await it (the first
     note plays well after it resolves). */
  if (next) {
    next.open()
      .then(() => { broadcastChannelLevels(); broadcastProgram(); }) /* normalize levels + re-assert program once wired */
      .catch(() => { /* port vanished mid-open; statechange will re-resolve */ });
  }
}

/** Record the synth's selected program (from a Program Change on the input port)
 *  and mirror it across all output channels. Logged so the SP-250's
 *  program→instrument map can be built by ear. `srcChannel` is 0-indexed. */
export function setOutputProgram(program: number, srcChannel?: number): void {
  const p = program & 0x7f;
  console.log(
    `[piano-out] Program Change: ${p}` +
    (srcChannel !== undefined ? ` (received on ch ${srcChannel + 1})` : ''),
  );
  currentProgram = p;
  broadcastProgram();
  broadcastChannelLevels(); /* some synths reset controllers on program change */
}

/* ── enable / init ─────────────────────────────────────────────────────────── */

export function setPianoOutEnabled(on: boolean): void {
  enabled = on;
  savePrefs({ pianoOutputEnabled: on });
  if (on) {
    rebindPianoOut();
    syncPianoOut(); /* pick up any currently-held keys */
  } else {
    if (midi.pianoOut) silencePort(midi.pianoOut);
    clearVoices();
  }
}

export function isPianoOutEnabled(): boolean {
  return enabled;
}

export function initPianoOut(): void {
  enabled = loadPrefs().pianoOutputEnabled;

  const cb = document.getElementById('cbPianoOutput') as HTMLInputElement | null;
  if (cb) {
    cb.checked = enabled;
    cb.addEventListener('change', () => { setPianoOutEnabled(cb.checked); });
  }

  whenMidiAccessReady().then(
    (access) => {
      access.addEventListener('statechange', () => rebindPianoOut());
      if (enabled) rebindPianoOut();
    },
    () => { /* no Web MIDI / denied — stays unbound */ },
  );
}
