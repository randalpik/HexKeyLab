import type { KeyId, Voice } from '../types.js';

// Audio engine state. Mutate `audio.x` directly from any module.
//
// activeOscs maps "q,r" → { type: 'sample' | 'osc', ... } for currently sounding
// voices. keyVelocity is the most recent strike velocity per key (used by the
// aftertouch handover logic to anchor pressureGain on initial volume).
// sustainedKeys is the subset of keys held by either pedal — released when the
// damper depth falls to zero AND the key isn't sostenuto-locked.
//
// damperDepth (0..1) is the current damper position — driven by CC4 (continuous)
// and CC64-in-sustain-mode (binary). sustainPedalDown mirrors damperDepth > 0
// for the keep-or-release decision at note-off time. sostenutoLockedKeys is the
// snapshot of selectedKeys at sostenuto-on; locked keys ride through damper
// changes (their per-voice damperGain stays pinned at 1.0).
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
  damperDepth: number;
  sostenutoActive: boolean;
  sostenutoLockedKeys: Set<KeyId>;
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
  damperDepth: 0,
  sostenutoActive: false,
  sostenutoLockedKeys: new Set(),
  rearticulateFlashUntil: {},
  aftertouchSnapshot: {},
};
