// RealDevice — composes a selected MIDI output (MidiOut) with the audio input
// (AudioInput) into the CaptureDevice surface the recorder drives. The Connect
// step owns the MidiOut/AudioInput instances (for enumeration + selection) and
// wraps them here once both are chosen.

import type { CaptureDevice, CaptureRecord } from './types.js';
import type { MidiOut } from './midiOut.js';
import type { AudioInput } from './audioIn.js';

export class RealDevice implements CaptureDevice {
  constructor(private midi: MidiOut, private audio: AudioInput) {}
  get sampleRate(): number { return this.audio.sampleRate; }
  noteOn(note: number, velocity: number, channel = 0): void { this.midi.noteOn(note, velocity, channel); }
  noteOff(note: number, channel = 0): void { this.midi.noteOff(note, channel); }
  allNotesOff(): void { this.midi.allNotesOff(); }
  arm(): void { this.audio.arm(); }
  take(): CaptureRecord { return this.audio.take(); }
  trailingRms(windowSec?: number): number { return this.audio.trailingRms(windowSec); }
  setMeter(on: boolean): void { this.audio.setMeter(on); }
  onLevel(cb: (rms: number) => void): () => void { return this.audio.onLevel(cb); }
  teardown(): void { this.midi.teardown(); this.audio.teardown(); }
}

/** Standard 12-TET pitch for a MIDI note (A4=440). Used by the loopback tone
 *  and the capture gates' expected-fundamental check. */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
