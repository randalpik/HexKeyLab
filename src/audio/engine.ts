// Audio engine: voice lifecycle, sustain/aftertouch, waveform switching.
//
// Two voice paths:
//   • sample-based (piano + FluidR3 instruments) — delegates to SampleEngine
//     which owns the real complexity (loop scheduling, ramp sync, etc.).
//     See lessons.md for SampleEngine's invariants — never source.loop=true,
//     all wraps via scheduleSegmentSwitch, commitRampSync integrates in-flight.
//   • oscillator (sine/square/triangle) — direct Web Audio nodes here.
//
// Polyphonic aftertouch: handover ramp on first message anchored on strike
// velocity; thereafter short smoothing ramps track pressure. Decaying
// instruments (piano, harp) ignore aftertouch entirely.

import { audio } from '../state/audio.js';
import { pedal } from '../state/pedal.js';
import { selection } from '../state/selection.js';
import { savePrefs } from '../state/persistence.js';
import { keyFreq } from '../tuning/frequency.js';
import { SampleEngine } from './samples.js';
import { initCapture } from './capture.js';
import {
  AFTERTOUCH_RAMP_S,
  aftertouchTargetGain, inflightExpRampValue, velocityBaseVol,
} from './aftertouch.js';
import { draw } from '../render/draw.js';
import { onSelectionChanged } from '../effects/onSelectionChanged.js';
import {
  recordOn, recordOff, recordPa, recordPedalDepthsChange, recordSostenuto,
} from '../recording/capture.js';
import { DEFAULT_DYNAMIC_MAP } from '../shared/dynamics.js';
import type { KeyId } from '../types.js';

/* Damper smoothing time-constant for setTargetAtTime. CC4 arrives as 0–127
   integer steps (~127 distinct values); ~25ms exponential smoothing tracks
   without zipper noise and avoids scheduling fights with cancelScheduledValues. */
const DAMPER_SMOOTH_TAU = 0.025;
/* Below this depth, treat as "fully released" — releases sustained voices via
   the normal noteOff path so syncAudio + draw stay consistent. */
const DAMPER_RELEASE_FLOOR = 0.005;

/* Re-articulation flash: when a MIDI strike arrives on a key that's already
   sounding (typically sustain-captured), we stop the old voice and start a
   fresh one. This map holds "q,r" → performance.now() expiry timestamps so
   draw() can briefly render those keys as unselected, producing a visible
   off-on blink to confirm the re-trigger. */
const REARTICULATE_FLASH_MS = 60;
export function triggerRearticulateFlash(key: KeyId): void {
  audio.rearticulateFlashUntil[key] = performance.now() + REARTICULATE_FLASH_MS;
  setTimeout(draw, REARTICULATE_FLASH_MS + 5);
}

export function instrIsSample(): boolean { return !!SampleEngine.INSTRUMENTS[audio.activeWaveform]; }
export function instrDecays(): boolean {
  const i = SampleEngine.INSTRUMENTS[audio.activeWaveform];
  return i ? !!i.decays : false;
}
/* Combined predicate for transpose-style coordinate shifts: either the
   instrument decays naturally, or it's opted into stop+retrigger via
   replayOnTranspose (sustained keyboards whose looping samples sound
   phasey under crossfade). */
export function instrReplaysOnTranspose(): boolean {
  const i = SampleEngine.INSTRUMENTS[audio.activeWaveform];
  if (!i) return false;
  return !!i.decays || !!i.replayOnTranspose;
}

interface WebkitWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

export function initAudio(): void {
  if (audio.audioCtx) return;
  /* Force 44.1 kHz to match native mp3 sample rate; avoids Web Audio resampling
     (which would skew period calculations in prepareLoop on 48kHz systems). */
  const ACtor = window.AudioContext || (window as WebkitWindow).webkitAudioContext!;
  try { audio.audioCtx = new ACtor({ sampleRate: 44100 }); }
  catch (e) { audio.audioCtx = new ACtor(); } /* fallback if sampleRate option unsupported */
  if (audio.audioCtx.sampleRate !== 44100) {
    console.warn('AudioContext sampleRate is ' + audio.audioCtx.sampleRate + ' (requested 44100). '
      + 'Precomputed loop points were generated for 44100Hz; sample splices may click '
      + 'because loop-point times will map to non-zero-crossing samples after resampling.');
  } else {
    console.log('AudioContext sampleRate: 44100 ✓');
  }
  /* Master chain: all source buses → masterBus → highShelf → limiter → destination.
     Defaults are tuned to be near-bypass for a single voice (shelf 0 dB; limiter
     threshold −3 dB with hard knee — single voices at the −3 dBFS sample peak
     ceiling won't push it). The limiter prevents dense-chord clipping at the
     source; the high-shelf is opt-in tone-tilt for residual recorded HF hiss.
     Both params are dialed in live via the ?loopdiag=1 overlay (no persistence). */
  audio.masterBus = audio.audioCtx.createGain(); audio.masterBus.gain.value = 1.0;
  audio.highShelf = audio.audioCtx.createBiquadFilter();
  audio.highShelf.type = 'highshelf';
  audio.highShelf.frequency.value = 5600;
  audio.highShelf.gain.value = -12;
  audio.limiter = audio.audioCtx.createDynamicsCompressor();
  audio.limiter.threshold.value = -3;
  audio.limiter.ratio.value = 20;
  audio.limiter.attack.value = 0.003;
  audio.limiter.release.value = 0.25;
  audio.limiter.knee.value = 0;
  audio.masterBus.connect(audio.highShelf);
  audio.highShelf.connect(audio.limiter);
  audio.limiter.connect(audio.audioCtx.destination);
  /* Bus gains are pass-through (1.0). Per-waveform target amplitudes are baked
     into the per-note `vol` in noteOn so that single-note RMS lands at the same
     target (−18 dBFS) as sample-based instruments. The buses remain so future
     global mix tweaks have a single attachment point. */
  audio.oscGain = audio.audioCtx.createGain(); audio.oscGain.gain.value = 1.0; audio.oscGain.connect(audio.masterBus);
  audio.squareGain = audio.audioCtx.createGain(); audio.squareGain.gain.value = 1.0; audio.squareGain.connect(audio.masterBus);
  SampleEngine.init(audio.audioCtx, audio.masterBus); /* sampleMaster at 0.9 */
  /* Fire-and-forget worklet load for the audio-capture tap. Best-effort:
     a load failure leaves capture unsupported but doesn't affect the engine.
     Kept off the synchronous init path so existing callers (toggleAudio,
     on-demand instrument load) don't need to await anything. */
  void initCapture(audio.audioCtx);
}

export function noteOn(key: KeyId, velocity?: number): void {
  if (!audio.audioEnabled || !audio.audioCtx) return;
  if (audio.activeOscs[key]) return;
  const parts = key.split(','), q = +parts[0], r = +parts[1];
  const freq = keyFreq(q, r);
  const wf = audio.activeWaveform;
  /* `velocity` is the canonical musical velocity (per-device input normalization,
     incl. the Lumatone's per-key gain + decompression, already happened at input).
     The house curve (velocityBaseVol / SampleEngine) maps it to gain. */
  const adjVel = velocity ?? DEFAULT_DYNAMIC_MAP.mf;
  if (instrIsSample() && SampleEngine.isInstrumentLoaded(wf)) {
    SampleEngine.setInstrument(wf);
    /* Velocity drives initial volume (via baseVol in segGain); pressureGain stays
       at 1.0 until the first aftertouch message for a sustained instrument, then
       ramps to the aftertouch-dictated gain. */
    SampleEngine.noteOn(key, freq, adjVel);
    audio.activeOscs[key] = { type: 'sample', freq };
  } else if (!instrIsSample()) {
    const type = wf as OscillatorType;
    const osc = audio.audioCtx.createOscillator();
    const gain = audio.audioCtx.createGain();
    osc.type = type; osc.frequency.value = freq;
    const simple = (type === 'sine' || type === 'triangle');
    /* Target single-note RMS = −18 dBFS, matching the per-sample normalization
       baked into sample instruments. Peak amplitude derives from the
       waveform's RMS-to-peak ratio: sine = 1/√2, triangle = 1/√3, square = 1.
       (TARGET_RMS = 10^(−18/20) ≈ 0.1259) */
    let vol = (type === 'sine')     ? 0.1779   /* 0.1259 × √2  */
            : (type === 'triangle') ? 0.2179   /* 0.1259 × √3  */
            :                         0.1259;  /* square (RMS = peak) */
    /* Velocity scaling — mirrors SampleEngine's curve so oscillator dynamics
       line up with sample instruments, and so PA's baseVol(eqVel)/baseVol(strikeVel)
       ratio (handleAftertouch) lands voices at matching peak loudness regardless
       of strike velocity. velocityBaseVol consults velocityCal's user curve. */
    vol *= velocityBaseVol(adjVel);
    /* Low-frequency perceptual loudness compensation (Fletcher-Munson). Pure
       tones lose perceived loudness below ~440 Hz; recorded instrument samples
       don't need this because their natural recordings already capture the
       right spectral character. Capped at 3× to avoid clipping at the bottom
       of the range. Square excluded — its harmonic richness already lifts
       perceived bass. */
    if (simple) { const boost = Math.min(3, Math.sqrt(440 / freq)); vol *= boost; }
    const atk = simple ? 0.02 : 0.04;
    const now = audio.audioCtx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(vol, now + atk);
    const dest = (type === 'square') ? audio.squareGain! : audio.oscGain!;
    /* damperGain sits between envelope and pressureGain — modulated while the
       key is in sustainedKeys to attenuate ringing under partial damper.
       Defaults to 1.0; pinned to 1.0 for sostenuto-locked keys. */
    const damperGain = audio.audioCtx.createGain(); damperGain.gain.value = 1.0;
    /* pressureGain sits between damperGain and bus — modulated by poly aftertouch.
       Initialized to 1.0 so the note plays at its envelope-driven volume until
       the first aftertouch message arrives (if any). */
    const pressureGain = audio.audioCtx.createGain(); pressureGain.gain.value = 1.0;
    osc.connect(gain); gain.connect(damperGain); damperGain.connect(pressureGain); pressureGain.connect(dest);
    osc.start(now);
    audio.activeOscs[key] = { type: 'osc', osc, gain, damperGain, pressureGain, vol };
  }
  /* Seed PA from the held filter state when a voice is recreated under a
     still-pressed key — e.g. instrument switch via changeWaveform, or any
     other noteOff→noteOn while paFilter[key] is live. Lumatone fires PA only
     on change, so a held-steady key emits no fresh PA after the rebuild;
     without this, the new voice plays at velocity volume forever. We use
     the gated+smoothed value (filt.v) rather than the raw snapshot so that
     a held key whose pressure is currently below the gate threshold doesn't
     get spuriously seeded from sensor noise. Mark aftertouchSeen=true so
     the next incoming PA uses the short AFTERTOUCH_RAMP_S smoothing rather
     than the longer first-arrival handover ramp. Decaying instruments are
     skipped via handleAftertouch's instrDecays() early return. */
  const v = audio.activeOscs[key];
  const filt = audio.paFilter[key];
  if (v && filt && filt.open && filt.v > 0) {
    v.aftertouchSeen = true;
    handleAftertouch(key, filt.v);
  }
  /* Recording hook — fires only when a new voice was committed (the early
     returns above ensure this). Capture the velocity actually used by the
     audio engine, so playback reproduces the same dynamics. */
  recordOn(key, velocity ?? 100);
}

export function noteOff(key: KeyId): void {
  const e = audio.activeOscs[key]; if (!e) return;
  if (e.type === 'sample') {
    SampleEngine.noteOff(key);
  } else {
    const now = audio.audioCtx!.currentTime;
    e.gain.gain.cancelScheduledValues(now);
    e.gain.gain.setValueAtTime(e.gain.gain.value, now);
    e.gain.gain.linearRampToValueAtTime(0, now + 0.06);
    e.osc.stop(now + 0.08);
  }
  delete audio.activeOscs[key];
  /* aftertouchSnapshot is NOT deleted here — its lifecycle parallels
     keyVelocity's: it persists until the user fully releases the key
     (handler.ts unsustained note-off, releaseSustainedKey). Deleting on
     every voice teardown would wipe held-pressure state across instrument
     switches and leave the new voice playing at PA=0 forever. */
  recordOff(key);
}

export function stopAllNotes(): void { for (const k in audio.activeOscs) noteOff(k); }

/** Glide sounding voices from their old keys to new keys over `rampMs`,
 *  reusing the same voice (no re-attack) — the "transpose effect". This is the
 *  same handoff the live pitch-transpose performs (keyboard-notes.ts sustained
 *  branch): osc voices ramp `frequency`; sample voices crossfade via
 *  `slideAndFadeOut` → `noteOnFaded`. Two-pass for samples so every old voice
 *  is told to fade before any new voice starts (avoids key collisions when a
 *  pair's newKey equals another pair's oldKey). Re-keys `activeOscs` and
 *  `keyVelocity` old→new. Pairs whose oldKey isn't sounding are skipped.
 *
 *  Only the audio voice is migrated here; callers own any higher-level
 *  per-key bookkeeping (selection highlight, playback voice tags). */
export function glideVoices(pairs: ReadonlyArray<{ oldKey: KeyId; newKey: KeyId }>, rampMs: number): void {
  if (!audio.audioEnabled || !audio.audioCtx) return;
  const now = audio.audioCtx.currentTime;
  const rampDur = Math.max(0.001, rampMs / 1000);
  const sampleMoves: { oldKey: KeyId; newKey: KeyId; newFreq: number; vol?: number }[] = [];
  for (const p of pairs) {
    if (p.oldKey === p.newKey) continue;
    const e = audio.activeOscs[p.oldKey];
    if (!e) continue;
    const np = p.newKey.split(','), nq = +np[0], nr = +np[1];
    const newFreq = keyFreq(nq, nr);
    if (e.type === 'osc') {
      e.osc.frequency.cancelScheduledValues(now);
      e.osc.frequency.setValueAtTime(e.osc.frequency.value, now);
      e.osc.frequency.exponentialRampToValueAtTime(newFreq, now + rampDur);
      audio.activeOscs[p.newKey] = e;
      delete audio.activeOscs[p.oldKey];
    } else {
      sampleMoves.push({ oldKey: p.oldKey, newKey: p.newKey, newFreq });
    }
    if (audio.keyVelocity[p.oldKey] !== undefined) {
      audio.keyVelocity[p.newKey] = audio.keyVelocity[p.oldKey];
      delete audio.keyVelocity[p.oldKey];
    }
  }
  for (const mv of sampleMoves) mv.vol = SampleEngine.slideAndFadeOut(mv.oldKey, mv.newFreq, rampDur);
  for (const mv of sampleMoves) {
    SampleEngine.noteOnFaded(mv.newKey, mv.newFreq, mv.vol!, rampDur);
    audio.activeOscs[mv.newKey] = { type: 'sample', freq: mv.newFreq };
    delete audio.activeOscs[mv.oldKey];
  }
}

export function handleAftertouch(key: KeyId, pressure: number): void {
  if (!audio.audioEnabled || !audio.audioCtx || instrDecays()) return;
  const e = audio.activeOscs[key]; if (!e) return;
  /* Strike anchor = the musical velocity used at noteOn (per-key gain already
     applied at input, not here). */
  const strikeVel = audio.keyVelocity[key] !== undefined ? audio.keyVelocity[key] : DEFAULT_DYNAMIC_MAP.f;
  const target = aftertouchTargetGain(pressure, strikeVel);
  const now = audio.audioCtx.currentTime;
  /* Uniform short ramp on every PA message — the handover-duration scaling
     was producing a long pre-scheduled climb that didn't track input ("ramps
     quickly to the PA region without following actual pressure"). With each
     message getting AFTERTOUCH_RAMP_S, the gain chases the live target
     continuously: each new ramp picks up where the previous left off (via
     inflightExpRampValue), so the trajectory is continuous between messages
     and reflects the user's pressure input directly. */
  e.aftertouchSeen = true;
  const dur = AFTERTOUCH_RAMP_S;
  if (e.type === 'sample') {
    SampleEngine.setAftertouch(key, target, dur);
  } else if (e.type === 'osc' && e.pressureGain) {
    /* Same JS-tracked-ramp polyfill as sSetAftertouch — see samples.ts. */
    const tgt = Math.max(target, 0.0001);
    const anchor = e.paRampState ? inflightExpRampValue(e.paRampState, now) : e.pressureGain.gain.value;
    e.pressureGain.gain.cancelScheduledValues(now);
    e.pressureGain.gain.setValueAtTime(anchor, now);
    e.pressureGain.gain.exponentialRampToValueAtTime(tgt, now + dur);
    e.paRampState = { startVal: anchor, startTime: now, targetVal: tgt, endTime: now + dur };
  }
  recordPa(key, pressure);
}

export function replayActiveNotes(): void {
  const keys = Object.keys(audio.activeOscs);
  keys.forEach(function (k) { noteOff(k); });
  keys.forEach(function (k) { noteOn(k, audio.keyVelocity[k]); });
}

export function syncAudio(): void {
  if (!audio.audioEnabled) { stopAllNotes(); return; }
  for (const k in audio.activeOscs) {
    if (!selection.selectedKeys.has(k) && !audio.sustainedKeys.has(k)) noteOff(k);
  }
  selection.selectedKeys.forEach(function (k) {
    if (!audio.activeOscs[k]) noteOn(k, audio.keyVelocity[k]);
  });
}

export function toggleAudio(): void {
  audio.audioEnabled = (document.getElementById('cbAudio') as HTMLInputElement).checked;
  savePrefs({ audioEnabled: audio.audioEnabled });
  if (audio.audioEnabled) {
    initAudio();
    if (audio.audioCtx!.state === 'suspended') audio.audioCtx!.resume();
    syncAudio();
  } else {
    stopAllNotes();
  }
}

function wfStartLoading(sel: HTMLSelectElement, total: number): void {
  sel.classList.add('wf-loading'); sel.disabled = true;
  const opt = sel.options[sel.selectedIndex];
  opt.dataset.origText = opt.textContent ?? '';
  opt.textContent = '0/' + total;
}
function wfUpdateLoading(sel: HTMLSelectElement, loaded: number, total: number): void {
  sel.options[sel.selectedIndex].textContent = loaded + '/' + total;
}
function wfFinishLoading(sel: HTMLSelectElement, success: boolean): void {
  sel.classList.remove('wf-loading'); sel.disabled = false;
  for (let i = 0; i < sel.options.length; i++) {
    const ot = sel.options[i].dataset.origText;
    if (ot) { sel.options[i].textContent = ot; delete sel.options[i].dataset.origText; }
  }
  if (!success) sel.value = audio.activeWaveform;
  audio.wfLoadingKey = null;
}

export function changeWaveform(): void {
  const sel = document.getElementById('waveform') as HTMLSelectElement;
  const wf = sel.value;
  sel.blur();
  if (audio.wfLoadingKey) return;
  savePrefs({ waveform: wf });
  const instr = SampleEngine.INSTRUMENTS[wf];
  if (instr && !SampleEngine.isInstrumentLoaded(wf)) {
    /* on-demand load with progress — don't touch current audio until success */
    audio.wfLoadingKey = wf;
    initAudio();
    wfStartLoading(sel, instr.samples.length);
    SampleEngine.loadInstrument(wf, function (loaded: number, tot: number) {
      wfUpdateLoading(sel, loaded, tot);
    }).then(function () {
      console.log(instr.name + ' loaded');
      wfFinishLoading(sel, true);
      audio.activeWaveform = wf;
      const playing = Object.keys(audio.activeOscs);
      playing.forEach(function (k) { noteOff(k); });
      playing.forEach(function (k) { noteOn(k, audio.keyVelocity[k]); });
    }).catch(function (err: unknown) {
      console.error((instr.name || wf) + ' load failed:', err);
      SampleEngine.unloadInstrument(wf); /* ensure no partial buffers linger */
      wfFinishLoading(sel, false);
    });
    return;
  }
  /* already loaded or oscillator — switch immediately */
  audio.activeWaveform = wf;
  const playing = Object.keys(audio.activeOscs);
  playing.forEach(function (k) { noteOff(k); });
  playing.forEach(function (k) { noteOn(k, audio.keyVelocity[k]); });
}

/* Set a voice's damperGain target (with smoothing). Sample voices delegate to
   SampleEngine since their damperGain lives inside the engine's voice closure. */
function applyDamperToVoice(key: KeyId, target: number): void {
  if (!audio.audioCtx) return;
  const v = audio.activeOscs[key];
  if (!v) return;
  if (v.type === 'sample') {
    SampleEngine.setVoiceDamperDepth(key, target, DAMPER_SMOOTH_TAU);
  } else {
    const now = audio.audioCtx.currentTime;
    v.damperGain.gain.cancelScheduledValues(now);
    v.damperGain.gain.setTargetAtTime(target, now, DAMPER_SMOOTH_TAU);
  }
}

/* Pin damperGain to 1.0 immediately (no smoothing) — used when a key enters
   sostenutoLockedKeys so locked notes ring at full volume regardless of damper. */
function pinDamperToOne(key: KeyId): void {
  if (!audio.audioCtx) return;
  const v = audio.activeOscs[key];
  if (!v) return;
  if (v.type === 'sample') {
    SampleEngine.setVoiceDamperDepth(key, 1.0, 0); /* tau=0 → instant */
  } else {
    const now = audio.audioCtx.currentTime;
    v.damperGain.gain.cancelScheduledValues(now);
    v.damperGain.gain.setValueAtTime(1.0, now);
  }
}

/* Release a single sustained key through the normal teardown path. */
function releaseSustainedKey(key: KeyId): void {
  selection.selectedKeys.delete(key);
  delete audio.keyVelocity[key];
  delete audio.aftertouchSnapshot[key];
  delete audio.paFilter[key];
  audio.sustainedKeys.delete(key);
}

/* Damper-pedal entry point. Combines pedal.cc4Depth + pedal.cc64Depth via max,
   updates audio.damperDepth + sustainPedalDown, walks sustainedKeys to apply
   the new depth (skipping sostenuto-locked keys), and collapses to per-key
   release when depth crosses below DAMPER_RELEASE_FLOOR. */
export function setDamperDepth(): void {
  const depth = Math.max(pedal.cc4Depth, pedal.cc64Depth);
  audio.damperDepth = depth;
  audio.sustainPedalDown = depth > 0;
  recordPedalDepthsChange();
  if (depth > DAMPER_RELEASE_FLOOR) {
    audio.sustainedKeys.forEach(function (k) {
      if (!audio.sostenutoLockedKeys.has(k)) applyDamperToVoice(k, depth);
    });
    return;
  }
  /* depth dropped to ~0: release sustained keys not also locked by sostenuto */
  if (audio.sustainedKeys.size === 0) return;
  const toRelease: KeyId[] = [];
  audio.sustainedKeys.forEach(function (k) {
    if (!audio.sostenutoLockedKeys.has(k)) toRelease.push(k);
  });
  if (toRelease.length === 0) return;
  toRelease.forEach(releaseSustainedKey);
  onSelectionChanged();
}

/* Sostenuto-on: snapshot currently selected keys into the locked set and pin
   their damperGain to 1.0 (in case damper depth was non-zero at this moment).
   New strikes after this point are NOT locked. */
export function sostenutoOn(): void {
  audio.sostenutoLockedKeys = new Set(selection.selectedKeys);
  audio.sostenutoActive = true;
  audio.sostenutoLockedKeys.forEach(pinDamperToOne);
  recordSostenuto(true);
}

/* Sostenuto-off: clear the locked set. Previously-locked keys currently in
   sustainedKeys are now subject to damper — apply current depth, or release
   them if the damper is also up. */
export function sostenutoOff(): void {
  if (!audio.sostenutoActive) { recordSostenuto(false); return; }
  const wasLocked = audio.sostenutoLockedKeys;
  audio.sostenutoLockedKeys = new Set();
  audio.sostenutoActive = false;
  recordSostenuto(false);
  const depth = audio.damperDepth;
  if (depth > DAMPER_RELEASE_FLOOR) {
    /* damper still engaged — locked keys keep ringing under damper attenuation */
    wasLocked.forEach(function (k) {
      if (audio.sustainedKeys.has(k)) applyDamperToVoice(k, depth);
    });
    return;
  }
  /* damper is up — release any locked keys that are in sustainedKeys */
  let touched = false;
  wasLocked.forEach(function (k) {
    if (audio.sustainedKeys.has(k)) { releaseSustainedKey(k); touched = true; }
  });
  if (touched) onSelectionChanged();
}

/* ramp active voices — or retrigger for decaying instruments */
export function rampActiveFreqs(dur: number): void {
  if (!audio.audioEnabled || !audio.audioCtx) return;
  if (instrDecays()) { replayActiveNotes(); return; }
  const now = audio.audioCtx.currentTime;
  for (const k in audio.activeOscs) {
    const p = k.split(','), e = audio.activeOscs[k];
    if (e.type === 'osc') {
      e.osc.frequency.setValueAtTime(e.osc.frequency.value, now);
      e.osc.frequency.exponentialRampToValueAtTime(keyFreq(+p[0], +p[1]), now + dur);
    } else if (e.type === 'sample') {
      SampleEngine.rampFreq(k, keyFreq(+p[0], +p[1]), dur);
    }
  }
}
