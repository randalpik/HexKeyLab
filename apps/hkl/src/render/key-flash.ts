// Brief off-on blink on an already-lit key.
//
// WHAT IT IS. When a strike arrives on a key that is already sounding (a
// sustain-captured note re-struck under the pedal, typically), the key stays in
// selection.selectedKeys the whole time — nothing about the selection changed.
// To make the re-strike visible we paint that key as UNSELECTED for a few
// frames: draw() subtracts anything in selection.flashUntil from both the
// selection fill and the selection ring.
//
// WHY IT LIVES IN render/. This is a render instruction, not an audio fact. It
// used to be `audio.rearticulateFlashUntil` in state/audio.ts, set by a helper
// in audio/engine.ts — the only purely-visual field in a module of
// AudioContext / GainNode / BiquadFilterNode references, and engine.ts's only
// reason to import the renderer at all. That misplacement is what broke the OBS
// overlay: the overlay renders keys but excludes the audio engine by design
// (that exclusion is what keeps the lean bundle lean), so it had no way to
// reach the state or the setter, and re-strikes silently never blinked there.
// Mirroring it would have meant the overlay's subscriber writing into
// audio-engine state to make a key blink.
//
// So the dependency runs one way: audio and MIDI CALL flashKey(); nothing in
// render imports audio to make this work. The overlay subscriber calls
// applyKeyFlash() with no audio import at all.
//
// NAMING. "Rearticulation" is the audio event; the flash is the visual. Named
// for the visual so a future non-audio trigger (a cue, a count-in beat) doesn't
// need another round of this.

import type { KeyId } from '../types.js';
import { selection } from '../state/selection.js';
import { draw, requestDraw } from './draw.js';
import { publishKeyFlash } from '../bridge/overlay-publish.js';

/** How long a key paints as unselected. Short enough to read as a blink rather
 *  than a dropped note; the OBS overlay reproduces this duration locally from
 *  its own clock, so it never stretches with relay jitter. */
export const KEY_FLASH_MS = 60;

/** Blink `key` off briefly, and mirror it to the OBS overlay. This is the entry
 *  point for every local trigger (audio re-articulation, MIDI re-strike, the
 *  Composer bridge), so publishing from in here covers all of them by
 *  construction rather than by remembering to add a call at each site. */
export function flashKey(key: KeyId): void {
  applyKeyFlash(key);
  publishKeyFlash([key]);
}

/** Local half of flashKey, without the publish. The overlay subscriber uses
 *  this for a MIRRORED flash: it must not re-publish what it just received. */
export function applyKeyFlash(key: KeyId): void {
  selection.flashUntil[key] = performance.now() + KEY_FLASH_MS;
  /* Two draws: one now for the off-frame, one after expiry to restore. The
     immediate one is rAF-coalesced and is what makes this self-sufficient —
     the overlay has no other reason to redraw here, since the mirrored
     selection set did not change. Expired entries are swept by draw(). */
  requestDraw();
  setTimeout(draw, KEY_FLASH_MS + 5);
}
