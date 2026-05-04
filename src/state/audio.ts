import type { KeyId, Voice } from '../types.js';

// Audio engine state. Mutate `audio.x` directly from any module.
//
// activeOscs maps "q,r" → { type: 'sample' | 'osc', ... } for currently sounding
// voices. keyVelocity is the most recent strike velocity per key (used by the
// aftertouch handover logic to anchor pressureGain on initial volume).
// sustainedKeys is the subset of keys held only by the sustain pedal — they
// release when the pedal goes up.
//
// rearticulateFlashUntil holds "q,r" → performance.now() expiry timestamps for
// the brief off-on blink when a MIDI strike re-triggers an already-sounding
// voice. aftertouchSnapshot is "q,r" → latest pressure value, for debug polling.

export const audio: {
  audioCtx: AudioContext | null;
  oscGain: GainNode | null;
  squareGain: GainNode | null;
  audioEnabled: boolean;
  activeWaveform: string;
  wfLoadingKey: string | null;
  activeOscs: Record<KeyId, Voice>;
  keyVelocity: Record<KeyId, number>;
  sustainPedalDown: boolean;
  sustainedKeys: Set<KeyId>;
  rearticulateFlashUntil: Record<KeyId, number>;
  aftertouchSnapshot: Record<KeyId, number>;
} = {
  audioCtx: null,
  oscGain: null,
  squareGain: null,
  audioEnabled: false,
  activeWaveform: 'piano',
  wfLoadingKey: null,
  activeOscs: {},
  keyVelocity: {},
  sustainPedalDown: false,
  sustainedKeys: new Set(),
  rearticulateFlashUntil: {},
  aftertouchSnapshot: {},
};
