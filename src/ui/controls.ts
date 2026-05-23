// Toolbar/keyboard control handlers: tuning select, clear selection,
// transpose-by-(dq, dr) buttons.
//
// Each handler mutates state then fires a single `effects/on…Changed()` for
// the fan-out — replaces the old chained sync-call pattern. The transpose
// buttons wire repeat-on-hold timers (400ms initial delay, 80ms tick) and
// defer expensive color syncs until the user releases.

import { tuning } from '../state/tuning.js';
import { selection } from '../state/selection.js';
import { audio } from '../state/audio.js';
import { referenceNote, clearSelection as clearRefSelection } from '../state/reference.js';
import { savePrefs } from '../state/persistence.js';
import type { OutlineMode, RotationMode, TuningMode } from '../state/persistence.js';
import { refSpine } from '../tuning/refspine.js';
import { dxH, dyH, cosT, sinT, setRotation } from '../layout/geometry.js';
import { recomputeCanvasBounds, computePianoViewCenter } from '../render/canvas.js';
import { view } from '../state/view.js';
import { keyFreq } from '../tuning/frequency.js';
import { SampleEngine } from '../audio/samples.js';
import {
  noteOff, syncAudio,
  instrReplaysOnTranspose,
} from '../audio/engine.js';
import { stopAllMidi, syncMidi } from '../midi/engine.js';
import { animation } from '../render/animation.js';
import { cv, draw, startLayoutAnim, currentMidi64Cell, buildHexLayerForTween, snapViewForOutline, validateRefNoteCandidate } from '../render/draw.js';
import { onTuningChanged } from '../effects/onTuningChanged.js';
import { onRefChanged } from '../effects/onRefChanged.js';
import { broadcastFootprint } from '../bridge/hkl-side.js';
import type { KeyId, Voice } from '../types.js';

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
       kbAnchor lands at the outline's center. kbAnchor is only updated by
       user-driven ref changes — Composer-driven changes leave it (and thus
       the visible layout) untouched. */
    targetQ = view.kbAnchorQ;
    targetR = view.kbAnchorR;
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
  const val = (document.getElementById('selTuning') as HTMLSelectElement).value as TuningMode;
  const prevMode = tuning.mode;
  tuning.mode = val;
  tuning.equalEnabled = val === 'E';
  tuning.septimalEnabled = val === '7';
  /* Mode change can orphan a ref note that was valid in the old bucket but
     not the new one (each mode has its own picker output and therefore its
     own valid-ref set). Conservative: on any mode change, re-check the ref
     against the new bucket and clear if invalid. Tuning-mode change is
     user-driven, so re-anchor kbAnchor to the new effective ref (now A3
     after the clear) — otherwise the Lumatone/QWERTY layout would stay
     pinned to a ref the user just abandoned. */
  if (prevMode !== val) {
    if (validateRefNoteCandidate(referenceNote.q, referenceNote.r) !== null) {
      /* Capture kbAnchor BEFORE the clear+reset so we can pass the delta to
         onRefChanged. Without this, held physical voices stay at their old
         (q,r) while the lattice slides under them — releasing the key resolves
         noteOff through the NEW anchor, leaving orphan voices in audio. See
         lessons: ref-tier reset that shifts kbAnchor without voice migration. */
      const oldAQ = view.kbAnchorQ, oldAR = view.kbAnchorR;
      clearRefSelection();
      savePrefs({ manualRef: undefined });
      const sp = refSpine(referenceNote.q, referenceNote.r);
      view.kbAnchorQ = sp.q;
      view.kbAnchorR = sp.r;
      onRefChanged(sp.q - oldAQ, sp.r - oldAR);
    }
  }
  onTuningChanged();
  (document.getElementById('selTuning') as HTMLSelectElement).blur();
  savePrefs({ tuning: val });
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
  /* Outline switches the active footprint set Composer sees as the
     constraint overlay. Previously this rode along on the rAF poll; with
     event-driven broadcasts the switch must be announced explicitly. */
  broadcastFootprint();
}

export function transposeSelection(dq: number, dr: number): void {
  if (selection.selectedKeys.size === 0) return;
  /* vertical bounds check — block if any note's center would leave the canvas */
  const cyC = view.CH / 2 + view.kbOffY;
  const vq = view.viewQ, vr = view.viewR;
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
