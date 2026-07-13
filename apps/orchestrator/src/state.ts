// Orchestrator session state — the active capture device, discovered velocity
// bins, and the capture config. A single mutable object with a pub/sub, mirroring
// the analyzer's stage.ts pattern (but smaller). The captured PCM itself is NOT
// held here (it lives in capture/store.ts — too big for the observable state).

import type { CaptureDevice } from './device/types.js';

/** One velocity layer the user will sample: a velocity range with a chosen
 *  representative sample velocity (the bin center the engine matches against). */
export interface VelocityBin { lo: number; hi: number; sampleVel: number; }

/** The device's tonal-whine profile: fixed narrowband artifact frequencies (Hz)
 *  detected from an idle recording, notched out of every capture before NR.
 *  Empty toneHz ⇒ no de-whine applied. */
export interface WhineProfile { toneHz: number[]; }

/** The device's measured velocity→loudness response from the discovery sweep
 *  (one dBFS level per swept velocity, at the probe note). Compared against the
 *  house velocity curve at export to soften brighter velocity layers so their
 *  timbre no longer reads as a perceived-loudness tier. Null ⇒ no sweep data
 *  (e.g. even-bin fallback) ⇒ no per-layer softening. */
export type VelocityResponse = Array<{ velocity: number; levelDb: number }>;

export interface CaptureConfig {
  instrumentKey: string;
  displayName: string;
  /** Inclusive MIDI note range to sample. */
  lowMidi: number;
  highMidi: number;
  /** Capture every Nth semitone (1 = every note). */
  semitoneStride: number;
  /** Velocity at which discovery probes the device. */
  probeNote: number;
  /** Minimum time (ms) the note is held before the silence early-out may stop
   *  the capture — skips the attack transient. The note is held through the
   *  whole decay regardless; note-off is sent at the stop, not here. */
  holdMs: number;
}

export interface OrchestratorSession {
  device: CaptureDevice | null;
  deviceLabel: string;
  bins: VelocityBin[];
  config: CaptureConfig;
  /** Null until the user runs whine calibration (or a persisted one loads). */
  whineProfile: WhineProfile | null;
  /** Null until a discovery sweep runs (captured from its fingerprints). */
  velocityResponse: VelocityResponse | null;
}

function initialConfig(): CaptureConfig {
  return {
    instrumentKey: '',
    displayName: '',
    lowMidi: 36,   // C2
    highMidi: 96,  // C7
    semitoneStride: 3,
    probeNote: 60, // C4
    holdMs: 150,
  };
}

const session: OrchestratorSession = {
  device: null,
  deviceLabel: '',
  bins: [],
  config: initialConfig(),
  whineProfile: null,
  velocityResponse: null,
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function getSession(): OrchestratorSession { return session; }

export function onSessionChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(): void {
  for (const fn of listeners) { try { fn(); } catch (e) { console.error('session listener', e); } }
}

export function setDevice(device: CaptureDevice | null, label: string): void {
  if (session.device && session.device !== device) {
    try { session.device.teardown(); } catch { /* ignore */ }
  }
  session.device = device;
  session.deviceLabel = label;
  emit();
}

export function setBins(bins: VelocityBin[]): void {
  session.bins = bins;
  emit();
}

export function setWhineProfile(profile: WhineProfile | null): void {
  session.whineProfile = profile;
  emit();
}

export function setVelocityResponse(resp: VelocityResponse | null): void {
  session.velocityResponse = resp;
  emit();
}

export function updateConfig(patch: Partial<CaptureConfig>): void {
  Object.assign(session.config, patch);
  emit();
}
