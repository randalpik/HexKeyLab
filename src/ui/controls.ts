// Toolbar/keyboard control handlers: tuning select, seam shift up/down,
// layout switch (♭/♮/♯), clear selection, transpose-by-(dq, dr) buttons.
//
// Each handler mutates state then fires a single `effects/on…Changed()` for
// the fan-out — replaces the old chained sync-call pattern. The seam-shift
// and transpose buttons also wire repeat-on-hold timers (400ms initial delay,
// 80ms tick) and defer expensive color syncs until the user releases.

import { tuning } from '../state/tuning.js';
import { selection } from '../state/selection.js';
import { audio } from '../state/audio.js';
import { layoutShifts } from '../layout/baseKeys.js';
import { dxH, dyH, cosT, sinT } from '../layout/geometry.js';
import { view } from '../state/view.js';
import { keyFreq } from '../tuning/frequency.js';
import { SampleEngine } from '../audio/samples.js';
import {
  noteOff, stopAllNotes, syncAudio, replayActiveNotes,
  instrDecays,
} from '../audio/engine.js';
import { stopAllMidi, syncMidi } from '../midi/engine.js';
import { animation } from '../render/animation.js';
import { draw, startLayoutAnim } from '../render/draw.js';
import { syncLumatoneColors } from '../lumatone/sync.js';
import { onTuningChanged } from '../effects/onTuningChanged.js';
import { onLayoutChanged } from '../effects/onLayoutChanged.js';
import type { KeyId, Voice } from '../types.js';

export function setTuning(): void {
  const val = (document.getElementById('selTuning') as HTMLSelectElement).value;
  tuning.equalEnabled = val === 'E';
  tuning.septimalEnabled = val === '7';
  (document.getElementById('seamShiftCtrl') as HTMLElement).style.display = tuning.septimalEnabled ? '' : 'none';
  onTuningChanged();
  (document.getElementById('selTuning') as HTMLSelectElement).blur();
}

export function shiftSeams(dir: number): void {
  tuning.septimalShift = ((tuning.septimalShift + dir + 21) % 42 + 42) % 42 - 21;
  document.getElementById('seamShiftInd')!.textContent = String(tuning.septimalShift);
  onTuningChanged({ colorSync: false });
}

/* key-repeat for seam shift buttons */
(function () {
  let tid: number | null = null, iid: number | null = null;
  function startRepeat(dir: number): void {
    stopRepeat();
    shiftSeams(dir);
    tid = window.setTimeout(function () { iid = window.setInterval(function () { shiftSeams(dir); }, 80); }, 400);
  }
  function stopRepeat(): void {
    /* only fire sync if a repeat was actually active — this runs on every document mouseup */
    const wasActive = !!(tid || iid);
    if (tid !== null) { clearTimeout(tid); tid = null; }
    if (iid !== null) { clearInterval(iid); iid = null; }
    if (wasActive) syncLumatoneColors();
  }
  ['btnSeamUp', 'btnSeamDn'].forEach(function (id) {
    const dir = id === 'btnSeamUp' ? 1 : -1;
    const el = document.getElementById(id)!;
    el.addEventListener('mousedown', function (e) { e.preventDefault(); startRepeat(dir); });
    el.addEventListener('touchstart', function (e) { e.preventDefault(); startRepeat(dir); }, { passive: false });
  });
  document.addEventListener('mouseup', stopRepeat);
  document.addEventListener('touchend', stopRepeat);
})();

export function transposeSelection(dq: number, dr: number): void {
  if (selection.selectedKeys.size === 0) return;
  /* vertical bounds check — block if any note's center would leave the canvas */
  const cyC = view.CH / 2 + view.kbOffY;
  const vq = layoutShifts[tuning.curLayout][0], vr = layoutShifts[tuning.curLayout][1];
  let blocked = false;
  selection.selectedKeys.forEach(function (key) {
    const p = key.split(','), nq = +p[0] + dq, nr = +p[1] + dr;
    const ux = (nq - vq) * dxH + (nr - vr) * dxH * 0.5, uy = -(nr - vr) * dyH;
    const sy = -ux * sinT + uy * cosT + cyC;
    if (sy < 0 || sy > view.CH) blocked = true;
  });
  if (blocked) return;
  /* re-key audio */
  if (audio.audioEnabled && audio.audioCtx) {
    if (instrDecays()) {
      /* decaying instrument: stop old, let syncAudio retrigger after selection shift */
      for (const k in audio.activeOscs) noteOff(k);
      audio.activeOscs = {};
    } else {
      /* sustained instrument: smooth ramp */
      const newOscs: Record<KeyId, Voice> = {};
      const sampleMoves: { oldKey: KeyId; newKey: KeyId; newFreq: number; vol?: number }[] = [];
      const now = audio.audioCtx.currentTime;
      for (const k in audio.activeOscs) {
        const p = k.split(','), nq = +p[0] + dq, nr = +p[1] + dr;
        const e = audio.activeOscs[k];
        if (e.type === 'osc') {
          e.osc.frequency.setValueAtTime(e.osc.frequency.value, now);
          e.osc.frequency.exponentialRampToValueAtTime(keyFreq(nq, nr), now + 0.1);
          newOscs[nq + ',' + nr] = e;
        } else if (e.type === 'sample') {
          sampleMoves.push({ oldKey: k, newKey: nq + ',' + nr, newFreq: keyFreq(nq, nr) });
        }
      }
      sampleMoves.forEach(function (m) { m.vol = SampleEngine.slideAndFadeOut(m.oldKey, m.newFreq, 0.1); });
      sampleMoves.forEach(function (m) {
        SampleEngine.noteOnFaded(m.newKey, m.newFreq, m.vol, 0.1);
        newOscs[m.newKey] = { type: 'sample', freq: m.newFreq };
      });
      audio.activeOscs = newOscs;
    }
  }
  /* shift selection */
  const shifted = new Set<KeyId>();
  selection.selectedKeys.forEach(function (k) { const p = k.split(','); shifted.add((+p[0] + dq) + ',' + (+p[1] + dr)); });
  selection.selectedKeys = shifted;
  stopAllMidi(); syncMidi();
  if (instrDecays()) syncAudio(); /* retrigger at new coords */
  draw();
}

/* key-repeat for transpose buttons */
(function () {
  let tid: number | null = null, iid: number | null = null;
  function startRepeat(dq: number, dr: number): void {
    stopRepeat();
    transposeSelection(dq, dr);
    tid = window.setTimeout(function () { iid = window.setInterval(function () { transposeSelection(dq, dr); }, 80); }, 400);
  }
  function stopRepeat(): void {
    if (tid !== null) { clearTimeout(tid); tid = null; }
    if (iid !== null) { clearInterval(iid); iid = null; }
  }
  document.querySelectorAll<HTMLElement>('.tpab[data-dq]').forEach(function (btn) {
    const dq = +(btn.dataset.dq ?? '0'), dr = +(btn.dataset.dr ?? '0');
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); startRepeat(dq, dr); });
    btn.addEventListener('touchstart', function (e) { e.preventDefault(); startRepeat(dq, dr); }, { passive: false });
  });
  document.addEventListener('mouseup', stopRepeat);
  document.addEventListener('touchend', stopRepeat);
})();

export function setLayout(n: number): void {
  if (n === tuning.curLayout) return;
  const oldSh = layoutShifts[tuning.curLayout], newSh = layoutShifts[n];
  const dq = newSh[0] - oldSh[0], dr = newSh[1] - oldSh[1];
  /* ramp audio or retrigger for decaying instruments */
  if (audio.audioEnabled && audio.audioCtx && Object.keys(audio.activeOscs).length > 0) {
    const newOscs: Record<KeyId, Voice> = {};
    if (instrDecays()) {
      /* decaying: re-key dict to new coords, then retrigger immediately so
         new pitches sound as soon as the shift initiates — matches the
         selection-indicator move. */
      for (const k in audio.activeOscs) {
        const p = k.split(','), nq = +p[0] + dq, nr = +p[1] + dr;
        newOscs[nq + ',' + nr] = audio.activeOscs[k];
      }
      audio.activeOscs = newOscs;
      replayActiveNotes();
    } else {
      /* sustained: smooth ramp over animation duration */
      const now = audio.audioCtx.currentTime;
      const rampDur = animation.duration / 1000;
      const layoutMoves: { oldKey: KeyId; newKey: KeyId; newFreq: number; vol?: number }[] = [];
      for (const k in audio.activeOscs) {
        const p = k.split(','), nq = +p[0] + dq, nr = +p[1] + dr;
        const e = audio.activeOscs[k];
        if (e.type === 'osc') {
          e.osc.frequency.setValueAtTime(e.osc.frequency.value, now);
          e.osc.frequency.exponentialRampToValueAtTime(keyFreq(nq, nr), now + rampDur);
          newOscs[nq + ',' + nr] = e;
        } else if (e.type === 'sample') {
          layoutMoves.push({ oldKey: k, newKey: nq + ',' + nr, newFreq: keyFreq(nq, nr) });
        }
      }
      layoutMoves.forEach(function (m) { m.vol = SampleEngine.slideAndFadeOut(m.oldKey, m.newFreq, rampDur); });
      layoutMoves.forEach(function (m) {
        SampleEngine.noteOnFaded(m.newKey, m.newFreq, m.vol, rampDur);
        newOscs[m.newKey] = { type: 'sample', freq: m.newFreq };
      });
    }
    audio.activeOscs = newOscs;
  } else {
    stopAllNotes();
  }
  stopAllMidi();
  if (selection.selectedKeys.size > 0) {
    const shifted = new Set<KeyId>();
    selection.selectedKeys.forEach(function (k) { const p = k.split(','); shifted.add((+p[0] + dq) + ',' + (+p[1] + dr)); });
    selection.selectedKeys = shifted;
  }
  animation.tweenTo(newSh[0], newSh[1]);
  tuning.curLayout = n;
  /* fire the color push as early as possible — runs in parallel with the 500ms
     view animation and the subsequent audio/MIDI sync */
  onLayoutChanged();
  document.querySelectorAll('.lbtn').forEach(function (b) { b.classList.remove('active'); });
  document.getElementById('lb' + n)!.classList.add('active');
  startLayoutAnim();
}

export function clearSelection(): void {
  selection.selectedKeys.clear();
  audio.sustainedKeys.clear();
  if (audio.audioCtx) {
    const now = audio.audioCtx.currentTime;
    for (const k in audio.activeOscs) {
      const e = audio.activeOscs[k];
      if (e.type === 'sample') {
        const v = (SampleEngine.getActiveVoices() as Record<string, any>)[k];
        if (v) {
          if (v.loopTimer) { clearTimeout(v.loopTimer); v.loopTimer = null; }
          if (v.alive) {
            v.voiceGain.gain.cancelScheduledValues(now);
            v.voiceGain.gain.setValueAtTime(v.voiceGain.gain.value, now);
            v.voiceGain.gain.linearRampToValueAtTime(0, now + 0.05);
            try { v.source.stop(now + 0.07); } catch (ex) { /* */ }
          }
          delete (SampleEngine.getActiveVoices() as Record<string, any>)[k];
        }
      } else if (e.type === 'osc') {
        e.gain.gain.cancelScheduledValues(now);
        e.gain.gain.setValueAtTime(e.gain.gain.value, now);
        e.gain.gain.linearRampToValueAtTime(0, now + 0.05);
        e.osc.stop(now + 0.07);
      }
    }
  }
  audio.activeOscs = {};
  stopAllMidi();
  draw();
}
