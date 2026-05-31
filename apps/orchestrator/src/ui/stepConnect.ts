// Connect step — pick a MIDI output + audio input (or the synthetic loopback),
// build the CaptureDevice, and test it with a probe note + live level meter.
// On success the device is stored in the session and the wizard can advance.

import { el, clear } from './dom.js';
import { MidiOut } from '../device/midiOut.js';
import { AudioInput, listAudioInputs } from '../device/audioIn.js';
import { RealDevice, midiToFreq } from '../device/device.js';
import { LoopbackDevice } from '../device/loopback.js';
import { setDevice, getSession } from '../state.js';
import { loadPersisted, patchPersisted } from '../persist.js';
import type { CaptureDevice } from '../device/types.js';

const SYNTHETIC = '__synthetic__';

let midi: MidiOut | null = null;
let audio: AudioInput | null = null;

function dbBar(rms: number): number {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db + 60) / 60));   // -60dBFS..0dBFS → 0..1
}

export async function renderConnect(host: HTMLElement, onConnected: () => void): Promise<void> {
  clear(host);
  const panel = el('div', { class: 'step-panel active' });
  panel.append(el('h2', { text: '1 · Connect' }));
  panel.append(el('p', { class: 'muted', text:
    'Route the instrument’s audio output into an audio interface input, and pick the MIDI output that triggers it. Or choose the synthetic loopback to try the flow without hardware.' }));

  const midiSel = el('select', { id: 'midiSel' });
  const audioSel = el('select', { id: 'audioSel' });
  const status = el('span', { class: 'muted', text: 'idle' });

  // MIDI outputs (+ synthetic option).
  midi = new MidiOut();
  try {
    await midi.requestAccess();
    const refresh = () => {
      const cur = (midiSel as HTMLSelectElement).value;
      clear(midiSel);
      midiSel.append(el('option', { value: SYNTHETIC, text: 'Synthetic (loopback — no hardware)' }));
      for (const p of midi!.listOutputs()) midiSel.append(el('option', { value: p.id, text: p.name }));
      if (cur) (midiSel as HTMLSelectElement).value = cur;
    };
    refresh();
    midi.onStateChange(refresh);
  } catch (e) {
    midiSel.append(el('option', { value: SYNTHETIC, text: 'Synthetic (loopback — no hardware)' }));
    status.textContent = 'Web MIDI unavailable: ' + (e as Error).message + ' — synthetic only.';
  }

  // Audio inputs (labels appear after a permission grant).
  const refreshInputs = async () => {
    const cur = (audioSel as HTMLSelectElement).value;
    clear(audioSel);
    audioSel.append(el('option', { value: '', text: 'Default input' }));
    for (const d of await listAudioInputs()) audioSel.append(el('option', { value: d.deviceId, text: d.label }));
    if (cur) (audioSel as HTMLSelectElement).value = cur;
  };
  await refreshInputs();

  // Pre-select last-used devices (survives reloads/HMR; ignored if now absent).
  const persisted = loadPersisted();
  if (persisted.midiOutId) (midiSel as HTMLSelectElement).value = persisted.midiOutId;
  if (persisted.audioInId != null) (audioSel as HTMLSelectElement).value = persisted.audioInId;

  const grantBtn = el('button', { type: 'button', onclick: async () => {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach(t => t.stop());
      await refreshInputs();
      status.textContent = 'Microphone access granted — input names listed.';
    } catch (e) { status.textContent = 'Mic permission denied: ' + (e as Error).message; }
  }, text: 'Enable mic access (to list input names)' });

  // Meter + test.
  const meterFill = el('div', { class: 'meter-fill' });
  const meter = el('div', { class: 'meter' }, [meterFill]);
  let unlevel: (() => void) | null = null;

  const connectBtn = el('button', { type: 'button', onclick: async () => {
    connectBtn.setAttribute('disabled', '');
    status.textContent = 'Connecting…';
    try {
      let device: CaptureDevice;
      const midiId = (midiSel as HTMLSelectElement).value;
      if (midiId === SYNTHETIC) {
        device = await LoopbackDevice.create();
        setDevice(device, 'Synthetic (loopback)');
      } else {
        if (!midi) throw new Error('no MIDI access');
        midi.selectOutput(midiId);
        audio = new AudioInput();
        await audio.start((audioSel as HTMLSelectElement).value || undefined);
        device = new RealDevice(midi, audio);
        const name = midi.listOutputs().find(p => p.id === midiId)?.name ?? 'MIDI device';
        setDevice(device, name);
      }
      patchPersisted({ midiOutId: midiId, audioInId: (audioSel as HTMLSelectElement).value });
      device.setMeter(true);
      if (unlevel) unlevel();
      unlevel = device.onLevel(rms => { meterFill.style.width = (dbBar(rms) * 100).toFixed(1) + '%'; });
      status.textContent = 'Connected: ' + getSession().deviceLabel + '. Play a test note.';
      testBtn.removeAttribute('disabled');
      onConnected();
    } catch (e) {
      status.textContent = 'Connect failed: ' + (e as Error).message;
    } finally {
      connectBtn.removeAttribute('disabled');
    }
  }, text: 'Connect' });

  const testBtn = el('button', { type: 'button', disabled: true, onclick: async () => {
    const dev = getSession().device;
    if (!dev) return;
    dev.allNotesOff();
    dev.noteOn(60, 100);
    status.textContent = 'Test note (C4, vel 100)…';
    setTimeout(() => { dev.noteOff(60); status.textContent = 'Connected: ' + getSession().deviceLabel + '. Test note played (~' + midiToFreq(60).toFixed(1) + ' Hz).'; }, 1000);
  }, text: 'Test note' });

  const row = (label: string, ...controls: Node[]) =>
    el('div', { class: 'field-row' }, [el('label', { text: label }), ...controls]);

  panel.append(
    row('MIDI output', midiSel),
    row('Audio input', audioSel, grantBtn),
    el('div', { class: 'field-row' }, [connectBtn, testBtn]),
    row('Level', meter),
    el('div', { class: 'field-row' }, [status]),
  );
  host.append(panel);
}
