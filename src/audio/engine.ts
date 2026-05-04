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
import { selection } from '../state/selection.js';
import { keyFreq } from '../tuning/frequency.js';
import { SampleEngine } from './samples.js';
import {
  AFTERTOUCH_RAMP_S,
  aftertouchTargetGain, aftertouchHandoverDuration,
} from './aftertouch.js';
import { draw } from '../render/draw.js';
import { onSelectionChanged } from '../effects/onSelectionChanged.js';
import type { KeyId } from '../types.js';

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
  audio.oscGain = audio.audioCtx.createGain(); audio.oscGain.gain.value = 0.35; audio.oscGain.connect(audio.audioCtx.destination);
  audio.squareGain = audio.audioCtx.createGain(); audio.squareGain.gain.value = 0.25; audio.squareGain.connect(audio.audioCtx.destination);
  SampleEngine.init(audio.audioCtx, audio.audioCtx.destination); /* sampleMaster at 0.9 */
}

export function noteOn(key: KeyId, velocity?: number): void {
  if (!audio.audioEnabled || !audio.audioCtx) return;
  if (audio.activeOscs[key]) return;
  const parts = key.split(','), q = +parts[0], r = +parts[1];
  const freq = keyFreq(q, r);
  const wf = audio.activeWaveform;
  if (instrIsSample() && SampleEngine.isInstrumentLoaded(wf)) {
    SampleEngine.setInstrument(wf);
    /* Velocity drives initial volume (via baseVol in segGain); pressureGain stays
       at 1.0 until the first aftertouch message for a sustained instrument, then
       ramps to the aftertouch-dictated gain. */
    SampleEngine.noteOn(key, freq, velocity || 100);
    audio.activeOscs[key] = { type: 'sample', freq };
  } else if (!instrIsSample()) {
    const type = wf as OscillatorType;
    const osc = audio.audioCtx.createOscillator();
    const gain = audio.audioCtx.createGain();
    osc.type = type; osc.frequency.value = freq;
    const simple = (type === 'sine' || type === 'triangle');
    let vol = simple ? 0.7 : 0.3;
    if (simple) { const boost = Math.min(3, Math.sqrt(440 / freq)); vol *= boost; }
    const atk = simple ? 0.02 : 0.04;
    const now = audio.audioCtx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(vol, now + atk);
    const dest = (type === 'square') ? audio.squareGain! : audio.oscGain!;
    /* pressureGain sits between envelope and bus — modulated by poly aftertouch.
       Initialized to 1.0 so the note plays at its envelope-driven volume until
       the first aftertouch message arrives (if any). */
    const pressureGain = audio.audioCtx.createGain(); pressureGain.gain.value = 1.0;
    osc.connect(gain); gain.connect(pressureGain); pressureGain.connect(dest);
    osc.start(now);
    audio.activeOscs[key] = { type: 'osc', osc, gain, pressureGain, vol };
  }
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
  delete audio.aftertouchSnapshot[key];
}

export function stopAllNotes(): void { for (const k in audio.activeOscs) noteOff(k); }

export function handleAftertouch(key: KeyId, pressure: number): void {
  if (!audio.audioEnabled || !audio.audioCtx || instrDecays()) return;
  const e = audio.activeOscs[key]; if (!e) return;
  const strikeVel = audio.keyVelocity[key] !== undefined ? audio.keyVelocity[key] : 100;
  const target = aftertouchTargetGain(pressure, strikeVel);
  const now = audio.audioCtx.currentTime;
  const wasSeen = !!e.aftertouchSeen;
  let dur: number;
  if (!wasSeen) {
    /* first aftertouch for this voice → schedule the handover ramp */
    e.aftertouchSeen = true;
    dur = aftertouchHandoverDuration(target);
    e.handoverEndTime = now + dur;
  } else if (e.handoverEndTime !== undefined && now < e.handoverEndTime) {
    /* still inside the handover window — use remaining time so the travel
       duration is preserved even as subsequent messages adjust the target */
    dur = Math.max(AFTERTOUCH_RAMP_S, e.handoverEndTime - now);
  } else {
    /* past the handover → short smoothing ramp tracks pressure changes */
    dur = AFTERTOUCH_RAMP_S;
  }
  if (e.type === 'sample') {
    SampleEngine.setAftertouch(key, target, dur);
  } else if (e.type === 'osc' && e.pressureGain) {
    e.pressureGain.gain.cancelScheduledValues(now);
    e.pressureGain.gain.setValueAtTime(e.pressureGain.gain.value, now);
    e.pressureGain.gain.linearRampToValueAtTime(target, now + dur);
  }
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
  /* auto-enable audio */
  if (!audio.audioEnabled) {
    (document.getElementById('cbAudio') as HTMLInputElement).checked = true;
    audio.audioEnabled = true;
    initAudio();
    if (audio.audioCtx!.state === 'suspended') audio.audioCtx!.resume();
  }
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

/* sustain pedal: hold notes that would otherwise release */
export function sustainPedalOn(): void { audio.sustainPedalDown = true; }
export function sustainPedalOff(): void {
  audio.sustainPedalDown = false;
  if (audio.sustainedKeys.size === 0) return;
  audio.sustainedKeys.forEach(function (k) {
    selection.selectedKeys.delete(k);
    delete audio.keyVelocity[k];
  });
  audio.sustainedKeys.clear();
  onSelectionChanged();
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
