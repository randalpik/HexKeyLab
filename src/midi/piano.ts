// Piano-keyboard MIDI input. Subscribes to a user-selected Web MIDI input
// (separate from the Lumatone port) and translates incoming 12-TET note
// numbers into lattice (q, r) cells via the resolver in tuning/resolve.ts,
// using the current referenceNote as the JI anchor.
//
// Behavioral parity with Lumatone (handler.ts) once the cell is resolved:
//   - sustaining note re-strikes through noteOff + triggerRearticulateFlash
//   - selection.selectedKeys / audio.keyVelocity / sustained-keys all mutated
//     in the same way
//   - downstream onSelectionChanged() drives audio + MIDI sync + redraw
//
// Per-midiNote → KeyId mapping is tracked so the matching note-off releases
// the same cell that was struck, even if the reference note has changed in
// between (Composer feedback loop changes the reference after each note).

import { audio } from '../state/audio.js';
import { midi } from '../state/midi.js';
import { selection } from '../state/selection.js';
import { referenceNote } from '../state/reference.js';
import { loadPrefs, savePrefs } from '../state/persistence.js';
import { activeFootprintSet } from '../render/draw.js';
import { resolve12TetToCoord } from '../tuning/resolve.js';
import { normalizePianoVelocity } from '../audio/pianoVel.js';
import { noteOff, triggerRearticulateFlash } from '../audio/engine.js';
import { onSelectionChanged } from '../effects/onSelectionChanged.js';
import type { KeyId } from '../types.js';

/* ── module state ──────────────────────────────────────────────────────────── */

/** Map of midi-note (0..127) → KeyId currently struck on the lattice. Cleared
 *  on disable and on the matching note-off. Persists across reference-note
 *  changes (Composer feedback loop) so the right cell is released. */
const activeMidiToKey: Map<number, KeyId> = new Map();

let enabled = false;
let selectedDeviceId: string | null = null;
let statusEl: HTMLSpanElement | null = null;
let statusTimer: number | null = null;

/* ── status text helpers ───────────────────────────────────────────────────── */

function setStatus(text: string, cls: 'luma-connected' | 'luma-disconnected' = 'luma-disconnected'): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.toggle('luma-connected', cls === 'luma-connected');
  statusEl.classList.toggle('luma-disconnected', cls === 'luma-disconnected');
}

function flashStatus(text: string, ms = 1800): void {
  if (!statusEl) return;
  if (statusTimer !== null) clearTimeout(statusTimer);
  const prevText = statusEl.textContent ?? '';
  const wasConnected = statusEl.classList.contains('luma-connected');
  statusEl.textContent = text;
  statusEl.classList.remove('luma-connected');
  statusEl.classList.add('luma-disconnected');
  statusTimer = window.setTimeout(() => {
    statusTimer = null;
    if (!statusEl) return;
    statusEl.textContent = prevText;
    statusEl.classList.toggle('luma-connected', wasConnected);
    statusEl.classList.toggle('luma-disconnected', !wasConnected);
  }, ms);
}

const MIDI_NOTE_LETTERS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function midiName(n: number): string {
  const pc = ((n % 12) + 12) % 12;
  const oct = Math.floor(n / 12) - 1;
  return MIDI_NOTE_LETTERS[pc] + oct;
}

/* ── note handlers ─────────────────────────────────────────────────────────── */

function handleNoteOn(midiNote: number, vRaw: number): void {
  /* If this midi note is already mapped, treat the new event as a re-strike
     of the same physical cell — match Lumatone's re-articulation behavior. */
  const prev = activeMidiToKey.get(midiNote);
  if (prev) {
    if (audio.activeOscs[prev]) {
      noteOff(prev);
      triggerRearticulateFlash(prev);
    }
    audio.sustainedKeys.delete(prev);
    selection.selectedKeys.add(prev);
    audio.keyVelocity[prev] = normalizePianoVelocity(vRaw);
    onSelectionChanged();
    return;
  }
  const footprint = activeFootprintSet();
  if (!footprint) {
    /* Outline 'none' → no clipping target. Reject piano input rather than
       fall back to the full lattice; "none" is a render-only mode for the
       Lumatone outline display, and admitting unbounded resolution would
       defeat the user's choice. */
    flashStatus('Outline must be Lumatone or QWERTY for piano input');
    return;
  }
  const cell = resolve12TetToCoord(midiNote, referenceNote.q, referenceNote.r, footprint);
  if (!cell) {
    flashStatus(midiName(midiNote) + ' out of layout');
    return;
  }
  const key: KeyId = cell.q + ',' + cell.r;
  if (audio.activeOscs[key]) {
    /* The chosen cell is already sounding (e.g., from QWERTY/Lumatone). Match
       Lumatone behavior: noteOff + rearticulate flash. */
    noteOff(key);
    triggerRearticulateFlash(key);
  }
  audio.sustainedKeys.delete(key);
  selection.selectedKeys.add(key);
  audio.keyVelocity[key] = normalizePianoVelocity(vRaw);
  activeMidiToKey.set(midiNote, key);
  onSelectionChanged();
}

function handleNoteOff(midiNote: number): void {
  const key = activeMidiToKey.get(midiNote);
  if (!key) return;
  activeMidiToKey.delete(midiNote);
  if (audio.sustainPedalDown || audio.sostenutoLockedKeys.has(key)) {
    audio.sustainedKeys.add(key);
  } else {
    selection.selectedKeys.delete(key);
    delete audio.keyVelocity[key];
    delete audio.aftertouchSnapshot[key];
    delete audio.paFilter[key];
  }
  onSelectionChanged();
}

function pianoMessage(e: MIDIMessageEvent): void {
  if (!enabled) return;
  const data = e.data;
  if (!data || data.length < 2) return;
  const status = data[0] & 0xf0;
  /* Ignore the piano port's SysEx / CC / aftertouch entirely — those concerns
     belong to the Lumatone path. A piano keyboard is just note + velocity. */
  if (status === 0x90 && (data[2] ?? 0) > 0) {
    handleNoteOn(data[1], data[2]);
  } else if (status === 0x80 || (status === 0x90 && (data[2] ?? 0) === 0)) {
    handleNoteOff(data[1]);
  }
}

/* ── device binding ────────────────────────────────────────────────────────── */

function bindPort(port: MIDIInput | null): void {
  if (midi.pianoIn === port) return;
  /* Detach previous. */
  if (midi.pianoIn) {
    midi.pianoIn.onmidimessage = null;
  }
  /* Release any in-flight notes on the previous port. */
  for (const [, key] of activeMidiToKey) {
    if (audio.activeOscs[key]) noteOff(key);
    selection.selectedKeys.delete(key);
    delete audio.keyVelocity[key];
  }
  activeMidiToKey.clear();
  midi.pianoIn = port;
  if (port) {
    port.onmidimessage = pianoMessage;
    setStatus('Connected: ' + (port.name ?? port.id), 'luma-connected');
  } else {
    setStatus('No device');
  }
  onSelectionChanged();
}

function findPortById(id: string | null): MIDIInput | null {
  if (!id || !midi.midiAccess) return null;
  for (const port of midi.midiAccess.inputs.values()) {
    if (port.id === id) return port;
  }
  return null;
}

export function refreshDeviceList(): void {
  const sel = document.getElementById('selPianoDevice') as HTMLSelectElement | null;
  if (!sel) return;
  const prevValue = selectedDeviceId ?? sel.value;
  /* Rebuild options, preserving the placeholder. */
  while (sel.firstChild) sel.removeChild(sel.firstChild);
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '(none)';
  sel.appendChild(placeholder);
  if (midi.midiAccess) {
    for (const port of midi.midiAccess.inputs.values()) {
      const opt = document.createElement('option');
      opt.value = port.id;
      opt.textContent = port.name ?? port.id;
      sel.appendChild(opt);
    }
  }
  /* Restore the previous selection if the port still exists; otherwise
     fall back to (none) and re-bind. */
  const port = findPortById(prevValue);
  sel.value = port ? port.id : '';
  if (selectedDeviceId !== sel.value) {
    selectedDeviceId = sel.value || null;
    bindPort(port);
  } else if (!midi.pianoIn && port) {
    bindPort(port);
  } else if (midi.pianoIn && !port) {
    bindPort(null);
  }
}

export function setSelectedDevice(id: string | null): void {
  selectedDeviceId = id;
  savePrefs({ pianoInputDeviceId: id });
  bindPort(findPortById(id));
}

export function setEnabled(on: boolean): void {
  enabled = on;
  savePrefs({ pianoEnabled: on });
  /* When disabling, release any in-flight notes so we don't leave hanging
     selection state or stuck audio voices. */
  if (!on) {
    for (const [, key] of activeMidiToKey) {
      if (audio.activeOscs[key]) noteOff(key);
      selection.selectedKeys.delete(key);
      delete audio.keyVelocity[key];
    }
    activeMidiToKey.clear();
    onSelectionChanged();
  }
}

export function isPianoEnabled(): boolean {
  return enabled;
}

/* ── init ──────────────────────────────────────────────────────────────────── */

export function initPiano(): void {
  statusEl = document.getElementById('pianoStatus') as HTMLSpanElement | null;
  const prefs = loadPrefs();
  enabled = prefs.pianoEnabled;
  selectedDeviceId = prefs.pianoInputDeviceId;

  const cb = document.getElementById('cbPianoEnabled') as HTMLInputElement | null;
  if (cb) {
    cb.checked = enabled;
    cb.addEventListener('change', () => { setEnabled(cb.checked); });
  }

  const sel = document.getElementById('selPianoDevice') as HTMLSelectElement | null;
  if (sel) {
    sel.addEventListener('change', () => {
      setSelectedDevice(sel.value || null);
    });
  }

  refreshDeviceList();

  /* Hotplug: when MIDI access state changes (Chromium statechange fires; on
     Firefox the engine.ts hotplug poll periodically swaps midiAccess), the
     Lumatone wiring re-runs findLumatone which mutates midi.midiAccess. We
     observe that via a periodic refresh tied to access identity. */
  let lastAccess: MIDIAccess | null = null;
  setInterval(() => {
    if (midi.midiAccess !== lastAccess) {
      lastAccess = midi.midiAccess;
      if (lastAccess) {
        lastAccess.addEventListener('statechange', refreshDeviceList);
      }
      refreshDeviceList();
    }
  }, 1500);
}
