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
import { referenceNote, clearSelection as clearRefSelection } from '../state/reference.js';
import { savePrefs } from '../state/persistence.js';
import type { LayoutId, OutlineMode, RotationMode, TuningMode } from '../state/persistence.js';
import { layoutShifts } from '../layout/baseKeys.js';
import { refSpine } from '../tuning/refspine.js';
import { dxH, dyH, cosT, sinT, setRotation } from '../layout/geometry.js';
import { recomputeCanvasBounds, computePianoViewCenter } from '../render/canvas.js';
import { view } from '../state/view.js';
import { keyFreq } from '../tuning/frequency.js';
import { SampleEngine } from '../audio/samples.js';
import {
  noteOff, stopAllNotes, syncAudio, replayActiveNotes,
  instrReplaysOnTranspose,
} from '../audio/engine.js';
import { stopAllMidi, syncMidi } from '../midi/engine.js';
import { animation } from '../render/animation.js';
import { cv, draw, startLayoutAnim, currentMidi64Cell, buildHexLayerForTween, snapViewForOutline, validateRefNoteCandidate } from '../render/draw.js';
import { syncLumatoneColors } from '../lumatone/sync.js';
import { onTuningChanged } from '../effects/onTuningChanged.js';
import { onLayoutChanged } from '../effects/onLayoutChanged.js';
import type { KeyId, Voice } from '../types.js';

/* In piano-outline mode the view is locked to the reference note (the lattice
   scrolls so refNote stays at canvas center) — Layout buttons are meaningless
   because each refNote position is its own freeform layout. With the
   ref-driven layout system the buttons are gone entirely; this stub is
   retained only because setOutline still calls it. */
function updateLayoutButtonsForOutline(_outline: OutlineMode): void {
  /* no-op */
}

/* Compute the view-center the active outline wants and animate to it.
   - piano: solve for the viewport that places refNote at screen-X = 0
     (horizontal center) AND MIDI 64's cell at screen-Y = 0 (vertical
     center). The 2×2 linear system in lattice coords is tilt-aware —
     under any rotation the outline's vertical extent stays minimized
     (MIDI 64 is at the midpoint of the 88-key pitch range) while the
     lattice shifts horizontally as refNote moves.
   - other outlines: the layout-shift center as usual.
   For piano-mode tweens we pre-rebuild the hex layer covering BOTH
   endpoints (start + target) — animating through a region the layer
   wasn't rebuilt for produces the cut-off-borders artifact. The expanded
   layer survives the whole tween and shrinks back on the next normal
   rebuild. `immediate` skips the tween and snaps; used at init so a
   fresh load lands without a startup animation, and for outline-switch
   transitions (where snap was already the design). */
export function syncViewToOutline(outline: OutlineMode, immediate: boolean): void {
  let targetQ: number, targetR: number;
  if (outline === 'piano') {
    const [m64Q, m64R] = currentMidi64Cell();
    [targetQ, targetR] = computePianoViewCenter(referenceNote.q, referenceNote.r, m64Q, m64R);
  } else {
    /* Lumatone / QWERTY / none: lattice slides under the static outline so
       the ref's qm=0-normalized spine cell lands at the outline's center. */
    const sp = refSpine(referenceNote.q, referenceNote.r);
    targetQ = sp.q;
    targetR = sp.r;
  }
  if (immediate) {
    view.viewQ = targetQ;
    view.viewR = targetR;
    return;
  }
  if (view.viewQ === targetQ && view.viewR === targetR) return;
  /* Build the hex layer to cover [view → target] before the tween fires so
     each animation frame blits from a layer that actually has the in-flight
     view position covered. Applies to all outline modes now — Lumatone /
     QWERTY use ref-driven shifts that can move the view anywhere on the
     lattice, same as piano mode does. */
  buildHexLayerForTween(view.viewQ, view.viewR, targetQ, targetR);
  animation.tweenTo(targetQ, targetR);
  startLayoutAnim();
}

export function setTuning(): void {
  const val = (document.getElementById('selTuning') as HTMLSelectElement).value;
  const wasSeptimal = tuning.septimalEnabled;
  const wasMode = tuning.septimalMode;
  tuning.equalEnabled = val === 'E';
  tuning.septimalEnabled = val === '7' || val === '7-legacy';
  tuning.septimalMode = val === '7-legacy' ? 'global' : 'uniform';
  /* Seam shift only meaningful in legacy septimal mode (global alternating
     bands). Hidden in the new uniform '7' which has no shift parameter. */
  (document.getElementById('seamShiftCtrl') as HTMLElement).style.display =
    (tuning.septimalEnabled && tuning.septimalMode === 'global') ? '' : 'none';
  /* Bucket switch can orphan a ref note placed in the old gate but invalid
     in the new one. Three gates: V5 (non-septimal), V7-uniform (new '7'),
     V7-legacy ('7-legacy'). 5-limit ↔ 12-TET share V5 so no reset needed
     there; everything else needs a re-validate. songKey tier is left intact
     (15 keys clustered around A3=220, far inside any gate). */
  const bucketChanged =
    wasSeptimal !== tuning.septimalEnabled ||
    (wasSeptimal && tuning.septimalEnabled && wasMode !== tuning.septimalMode);
  if (bucketChanged) {
    if (validateRefNoteCandidate(referenceNote.q, referenceNote.r) !== null) {
      clearRefSelection();
      savePrefs({ manualRef: undefined });
    }
  }
  onTuningChanged();
  (document.getElementById('selTuning') as HTMLSelectElement).blur();
  savePrefs({ tuning: val as TuningMode });
}

export function applyRotation(mode: RotationMode): void {
  setRotation(mode);
  recomputeCanvasBounds();
  cv.style.height = view.CH + 'px';
  /* Piano viewport solves a tilt-dependent linear system to place
     refNote at sx=0 and MIDI 64 at sy=0. After a rotation change the
     stale viewQ/viewR no longer satisfies that, so cells (and the
     polygon translate) drift away from the canvas center, leaving the
     dark-overlay rect with the wrong origin. Re-snap unconditionally —
     it's a no-op for non-piano outlines beyond setting view to the
     current layout-shift center (which it already is). */
  const sel = document.getElementById('selOutline') as HTMLSelectElement | null;
  const outline = (sel?.value === 'qwerty' || sel?.value === 'piano' || sel?.value === 'none')
    ? sel.value as OutlineMode : 'lumatone';
  snapViewForOutline(outline);
  view.hexDirty = true;
  view.textDirty = true;
}

export function setRotationFromDom(): void {
  const sel = document.getElementById('selRotation') as HTMLSelectElement;
  const mode = sel.value as RotationMode;
  applyRotation(mode);
  draw();
  sel.blur();
  savePrefs({ rotation: mode });
}

export function setOutline(): void {
  /* When the outline is None, Extend off would clamp the canvas to an
     undefined region (no bounds), so we force the renderer to act as if
     Extend is on and disable the checkbox to communicate that. */
  const sel = document.getElementById('selOutline') as HTMLSelectElement;
  const newOutline = sel.value as OutlineMode;
  const cbExtend = document.getElementById('cbExtend') as HTMLInputElement;
  cbExtend.disabled = newOutline === 'none';
  updateLayoutButtonsForOutline(newOutline);
  /* Each outline has its own canvas bounds — resize before redrawing. */
  recomputeCanvasBounds(newOutline);
  cv.style.height = view.CH + 'px';
  view.hexDirty = true;
  view.textDirty = true;
  /* Snap the view to the new outline's "home" position (refNote for piano,
     layout-shift for the others) WITHOUT animation. The canvas height also
     changes instantly on outline switch, so animating just the view position
     looks half-broken — content tweens while the canvas resizes around it.
     Outline changes are otherwise not animated, so this matches convention.
     Animated view changes only happen for refNote scroll in piano mode (see
     bridge/hkl-side.ts where syncViewToOutline is called with immediate=false). */
  syncViewToOutline(newOutline, true);
  draw();
  sel.blur();
  savePrefs({ outline: newOutline });
}

export function shiftSeams(dir: number): void {
  tuning.septimalShift = ((tuning.septimalShift + dir + 21) % 42 + 42) % 42 - 21;
  document.getElementById('seamShiftInd')!.textContent = String(tuning.septimalShift);
  onTuningChanged({ colorSync: false });
  savePrefs({ septimalShift: tuning.septimalShift });
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
    if (instrReplaysOnTranspose()) {
      /* decaying instrument or opt-in replayOnTranspose (organs):
         stop old, let syncAudio retrigger after selection shift */
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
        SampleEngine.noteOnFaded(m.newKey, m.newFreq, m.vol!, 0.1);
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
  if (instrReplaysOnTranspose()) syncAudio(); /* retrigger at new coords */
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

/* Legacy setLayout: kept for recording playback back-compat (old .hkr files
   store a curLayout 1/2/3 that we still parse). With ref-driven layouts the
   visible region is fully determined by ref, so this becomes a no-op apart
   from tracking curLayout for the persisted snapshot. */
export function setLayout(n: number): void {
  if (n === tuning.curLayout) return;
  tuning.curLayout = n;
  savePrefs({ curLayout: n as LayoutId });
}

/* Init-time no-op kept as a stable export until the recording schema drops
   curLayout outright. */
export function applyLayoutImmediate(n: number): void {
  tuning.curLayout = n;
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
