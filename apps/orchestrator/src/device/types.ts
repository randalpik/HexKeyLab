// Shared device-layer types.

/** A lossless captured recording: raw Float32 PCM channels + the sample rate
 *  they were captured at. This is the intermediate format the orchestrator
 *  holds before handing samples to @hkl/analysis for normalization + .hki
 *  packaging (see docs/lessons.md "lossless intermediate before the analyzer"). */
export interface CaptureRecord {
  channels: Float32Array[];
  sampleRate: number;
}

/** A device the recorder can drive: send MIDI notes and capture the resulting
 *  audio. Implemented by RealDevice (selected MIDI output + audio input) and by
 *  LoopbackDevice (synthetic oscillator, for hardware-free testing). */
export interface CaptureDevice {
  readonly sampleRate: number;
  /** Send a MIDI note-on at the given velocity (1..127). */
  noteOn(note: number, velocity: number, channel?: number): void;
  /** Send a MIDI note-off (or note-on velocity 0). */
  noteOff(note: number, channel?: number): void;
  /** All-notes-off panic across channels. */
  allNotesOff(): void;
  /** Begin collecting audio frames (clears any prior capture). */
  arm(): void;
  /** Stop collecting and return everything captured since arm(). */
  take(): CaptureRecord;
  /** Trailing-window RMS (linear) over the most recent `windowSec`, for the
   *  level meter and the recorder's silence-based stop condition. */
  trailingRms(windowSec?: number): number;
  /** Enable/disable the lightweight always-on level meter. */
  setMeter(on: boolean): void;
  /** Subscribe to per-quantum RMS updates (meter). Returns unsubscribe. */
  onLevel(cb: (rms: number) => void): () => void;
  /** Tear down audio + MIDI resources. */
  teardown(): void;
}
