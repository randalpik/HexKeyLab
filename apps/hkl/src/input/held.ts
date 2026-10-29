// Held physical inputs — one registry for every source that plays notes from
// a physical key: the Lumatone ("ch,note"), the computer keyboard (event.code),
// and the piano keyboard (MIDI note number).
//
// Each held input records the KeyId it actually struck. Release, aftertouch
// and forced release resolve through that record — never by recomputing the
// key from the current anchor — so an anchor change that does not migrate a
// voice can never orphan it. Ref-change migration (migrateHeld) is the one
// place a record moves, and it moves the voice with it.
//
// Source handlers keep only what is specific to them (Lumatone velocity
// calibration and Composer strike broadcast, piano footprint resolution and
// status text, QWERTY focus/repeat gating) and delegate the shared note-on /
// note-off bodies here.

import { audio } from '../state/audio.js';
import { selection } from '../state/selection.js';
import { noteOn, noteOff, instrReplaysOnTranspose } from '../audio/engine.js';
import { SampleEngine } from '../audio/samples.js';
import { keyFreq } from '../tuning/frequency.js';
import { animation } from '../render/animation.js';
import { flashKey } from '../render/key-flash.js';
import { restrikePianoOut } from '../midi/piano-out.js';
import { onSelectionChanged } from '../effects/onSelectionChanged.js';
import type { KeyId } from '../types.js';

export type HeldSource = 'lumatone' | 'qwerty' | 'piano';

const held: Record<HeldSource, Map<string, KeyId>> = {
  lumatone: new Map(),
  qwerty: new Map(),
  piano: new Map(),
};

/** The KeyId physical input `id` struck, if it is still held. */
export function heldKey(source: HeldSource, id: string): KeyId | undefined {
  return held[source].get(id);
}

export function heldCount(source: HeldSource): number {
  return held[source].size;
}

/** Forget every record for `source` without touching audio or selection.
 *  Test/reset hook. */
export function clearHeld(source: HeldSource): void {
  held[source].clear();
}

/** Forget every record of every source. Called by the Clear button after it
 *  has silenced and deselected everything: a key still physically down then
 *  releases as a no-op instead of deselecting whatever now occupies its cell,
 *  and stops counting as "held" for migration and the Lumatone heartbeat. */
export function clearAllHeld(): void {
  held.lumatone.clear();
  held.qwerty.clear();
  held.piano.clear();
}

/** Strike `key` for physical input `id`. A voice already sounding on `key`
 *  (typically held by the sustain pedal) is re-articulated: stopped, flashed,
 *  and re-attacked at the new velocity by the selection sync. */
export function pressHeld(source: HeldSource, id: string, key: KeyId, velocity: number): void {
  if (audio.activeOscs[key]) {
    noteOff(key);
    flashKey(key);
  }
  audio.sustainedKeys.delete(key); /* re-struck while sustained → back to normal */
  selection.selectedKeys.add(key);
  audio.keyVelocity[key] = velocity;
  held[source].set(id, key);
  restrikePianoOut(key); /* re-attack on the external synth if already sounding */
  onSelectionChanged();
}

/** Release physical input `id`. The damper or a sostenuto lock keeps the note
 *  sounding (moved to sustainedKeys); otherwise it is deselected and its
 *  per-key state cleared. No-op for an input that is not held. */
export function releaseHeld(source: HeldSource, id: string): void {
  const key = held[source].get(id);
  if (key === undefined) return;
  held[source].delete(id);
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

/** Release every held input of `source` as ordinary note-offs (pedal and
 *  sostenuto still apply). Used when the source loses its key events, e.g.
 *  window blur for the computer keyboard. */
export function releaseAllHeld(source: HeldSource): void {
  /* snapshot first since releaseHeld mutates the map */
  Array.from(held[source].keys()).forEach((id) => { releaseHeld(source, id); });
}

/** Force-release every held input of `source`, ignoring pedal and sostenuto:
 *  the source is gone (device departure, input disabled, port switched) and
 *  can never deliver its note-offs. Clears selection and per-key state and
 *  returns the released keys; the caller runs onSelectionChanged (after any
 *  pedal reset of its own), which stops the voices. */
export function dropHeld(source: HeldSource): KeyId[] {
  const keys = Array.from(held[source].values());
  held[source].clear();
  keys.forEach((key) => {
    selection.selectedKeys.delete(key);
    audio.sustainedKeys.delete(key);
    delete audio.keyVelocity[key];
    delete audio.aftertouchSnapshot[key];
    delete audio.paFilter[key];
  });
  return keys;
}

/** Ref-change migration: re-resolve each held input of `source` under the new
 *  lattice anchor and move its voice, velocity, selection and sustain state
 *  from the old cell to the new one, so a held key keeps its relative pitch.
 *  Returns the number of voices moved; the caller runs onSelectionChanged. */
export function migrateHeld(source: HeldSource, resolve: (id: string) => KeyId | null): number {
  const pairs: { oldKey: KeyId; newKey: KeyId }[] = [];
  held[source].forEach((oldKey, id) => {
    const newKey = resolve(id);
    if (!newKey || newKey === oldKey) return;
    pairs.push({ oldKey, newKey });
    held[source].set(id, newKey);
  });
  if (pairs.length) moveVoices(pairs);
  return pairs.length;
}

/** Re-express every record of `source` through `convert` without touching
 *  voices or selection (a mapping switch moves those itself). */
export function rekeyHeld(source: HeldSource, convert: (key: KeyId) => KeyId): void {
  held[source].forEach((key, id) => { held[source].set(id, convert(key)); });
}

/** True iff `key` is the struck key of a held input of `source`. */
export function isHeldKey(source: HeldSource, key: KeyId): boolean {
  for (const k of held[source].values()) if (k === key) return true;
  return false;
}

/** Move each voice, its velocity, selection and sustain entry from oldKey to
 *  newKey: replay instruments re-attack, sustained ones ramp (oscillator) or
 *  crossfade (sample) over the animation duration. The caller runs
 *  onSelectionChanged.
 *
 *  Two phases — detach every old key, then attach every new one — so chained
 *  moves (A→B while B→C: an octave-sized anchor shift with two keys held an
 *  octave apart, or a mapping switch) never overwrite a voice that is itself
 *  moving. Every newKey must be free of voices that are NOT moving. */
export function moveVoices(pairs: { oldKey: KeyId; newKey: KeyId }[]): void {
  const vel = pairs.map((p) => audio.keyVelocity[p.oldKey]);
  pairs.forEach((p) => { delete audio.keyVelocity[p.oldKey]; });
  pairs.forEach((p, i) => { if (vel[i] !== undefined) audio.keyVelocity[p.newKey] = vel[i]!; });
  if (audio.audioEnabled && audio.audioCtx) {
    const moving = pairs.filter((p) => audio.activeOscs[p.oldKey]);
    if (instrReplaysOnTranspose()) {
      /* decaying instruments (piano, etc.) or replay-on-transpose
         (organs): stop the old voice at its old pitch and re-attack at
         the new one. Limited to the migrated pairs so other held /
         sustained voices are untouched. */
      moving.forEach((p) => { noteOff(p.oldKey); });
      moving.forEach((p) => { noteOn(p.newKey, audio.keyVelocity[p.newKey]); });
    } else {
      /* sustained: smooth ramp over animation duration */
      const now = audio.audioCtx.currentTime;
      const rampDur = animation.duration / 1000;
      const entries = moving.map((p) => audio.activeOscs[p.oldKey]);
      moving.forEach((p) => { delete audio.activeOscs[p.oldKey]; });
      const sampleMoves: { oldKey: KeyId; newKey: KeyId; nq: number; nr: number; newFreq: number; instr: string; vel: number; vol?: number }[] = [];
      moving.forEach((p, i) => {
        const e = entries[i];
        const np = p.newKey.split(','), nq = +np[0], nr = +np[1];
        if (e.type === 'osc') {
          e.osc.frequency.setValueAtTime(e.osc.frequency.value, now);
          e.osc.frequency.exponentialRampToValueAtTime(keyFreq(nq, nr), now + rampDur);
          e.q = nq; e.r = nr;
          audio.activeOscs[p.newKey] = e;
        } else if (e.type === 'sample') {
          sampleMoves.push({ oldKey: p.oldKey, newKey: p.newKey, nq, nr, newFreq: keyFreq(nq, nr), instr: e.instr, vel: e.vel });
        }
      });
      sampleMoves.forEach((m) => { m.vol = SampleEngine.slideAndFadeOut(m.oldKey, m.newFreq, rampDur); });
      sampleMoves.forEach((m) => {
        SampleEngine.noteOnFaded(m.newKey, m.newFreq, m.vol!, rampDur, m.instr);
        audio.activeOscs[m.newKey] = { type: 'sample', freq: m.newFreq, instr: m.instr, q: m.nq, r: m.nr, vel: m.vel };
      });
    }
  }
  /* migrate selection + sustain entries so the highlight follows the key */
  const wasSelected = pairs.map((p) => selection.selectedKeys.delete(p.oldKey));
  const wasSustained = pairs.map((p) => audio.sustainedKeys.delete(p.oldKey));
  pairs.forEach((p, i) => {
    if (wasSelected[i]) selection.selectedKeys.add(p.newKey);
    if (wasSustained[i]) audio.sustainedKeys.add(p.newKey);
  });
}
