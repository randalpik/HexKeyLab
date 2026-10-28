// Toolbar/keyboard control handlers: tuning select, mapping select, clear
// selection, transpose-by-(dq, dr) buttons.
//
// Each handler mutates state then fires a single `effects/on…Changed()` for
// the fan-out — replaces the old chained sync-call pattern. The transpose
// buttons wire repeat-on-hold timers (400ms initial delay, 80ms tick) and
// defer expensive color syncs until the user releases.

import { tuning } from '../state/tuning.js';
import { selection } from '../state/selection.js';
import { audio } from '../state/audio.js';
import {
  referenceNote, clearSelection as clearRefSelection, recomputeReferenceForOutline,
  convertReferenceFrame, manualSelection,
} from '../state/reference.js';
import { savePrefs } from '../state/persistence.js';
import type { HexSize, Mapping, OutlineMode, RotationMode, TuningMode } from '../state/persistence.js';
import { eulerOf, fromEuler, vecFromEuler } from '@hkl/shared/mapping.js';
import { dxH, dyH, cosT, sinT, currentRotationMode } from '../layout/geometry.js';
import { view } from '../state/view.js';
import { keyFreq } from '../tuning/frequency.js';
import { SampleEngine } from '../audio/samples.js';
import {
  noteOff, syncAudio,
  instrReplaysOnTranspose,
} from '../audio/engine.js';
import { stopAllMidi, syncMidi, buildMidiReverse } from '../midi/engine.js';
import { draw, validateRefNoteCandidate, invalidatePianoOutline } from '../render/draw.js';
import { syncViewToOutline, applyRotation, applyHexSize, applyOutlineRender } from '../render/controls-core.js';
import { onTuningChanged } from '../effects/onTuningChanged.js';
import { onSelectionChanged } from '../effects/onSelectionChanged.js';
import { broadcastFootprint } from '../bridge/hkl-side.js';
import { coordOf } from '../types.js';
import { clearAllHeld, rekeyHeld, isHeldKey, moveVoices } from '../input/held.js';
import type { KeyId, Voice } from '../types.js';

/* Render-only primitives now live in render/controls-core.ts (engine-free, so
   the OBS-overlay subscriber can reuse them). Re-exported here so existing
   importers (ui/init.ts, bridge/hkl-side.ts) keep their import path unchanged. */
export { syncViewToOutline, applyRotation, applyHexSize };

export function setTuning(): void {
  const val = (document.getElementById('selTuning') as HTMLSelectElement).value as TuningMode;
  const prevMode = tuning.mode;
  tuning.mode = val;
  tuning.equalEnabled = val === 'E';
  tuning.septimalEnabled = val === '7';
  /* HEJI auto-on for Schismatic: V mode without HEJI is the documented
     unreadable case (stacked sharps with no comma context). Entering V
     auto-enables; leaving V leaves the user's preference alone — once they've
     seen HEJI on, they may want to keep it on in other modes too. The toolbar
     checkbox `cbHeji` reflects the new state immediately. */
  if (prevMode !== val && val === 'V' && !tuning.hejiEnabled) {
    tuning.hejiEnabled = true;
    const cb = document.getElementById('cbHeji') as HTMLInputElement | null;
    if (cb) cb.checked = true;
    savePrefs({ hejiEnabled: true });
    view.textDirty = true;
  }
  /* Mode change can orphan a ref note that was valid in the old bucket but
     not the new one (each mode has its own picker output and therefore its
     own valid-ref set). Conservative: on any mode change, re-check the ref
     against the new bucket and clear the selection if invalid. reference.ts
     re-anchors kbAnchor to the new effective ref and onRefChanged migrates
     held physical voices with it (lessons: ref-tier reset that shifts kbAnchor
     without voice migration). */
  if (prevMode !== val && validateRefNoteCandidate(referenceNote.q, referenceNote.r) !== null) {
    clearRefSelection();
    savePrefs({ manualRef: undefined });
  }
  onTuningChanged();
  (document.getElementById('selTuning') as HTMLSelectElement).blur();
  savePrefs({ tuning: val });
}

/** Switch the note-name mapping (docs/architecture.md → Note-name mapping). Every
 *  coordinate is in the active mapping's frame, so the switch re-expresses the
 *  reference, the keyboard anchor, and held mouse / piano-input / pedal-
 *  sustained notes in the new frame — same pitch (a Schismatic copy moves by
 *  one schisma). Held Lumatone / QWERTY voices keep their (q, r) and retune in
 *  place, as on a tuning-mode change; they release through the key they
 *  struck (input/held.ts), so the converted anchor cannot orphan them. */
export function setMapping(): void {
  const sel = document.getElementById('selMapping') as HTMLSelectElement;
  const val = sel.value as Mapping;
  const prev = tuning.mapping;
  sel.blur();
  if (val === prev) return;
  const convert = (q: number, r: number): [number, number] => {
    const e = eulerOf(q, r, prev);
    return fromEuler(e.q, e.r, val);
  };
  const convertKey = (k: KeyId): KeyId => {
    const p = k.split(',');
    const [q, r] = convert(+p[0], +p[1]);
    return q + ',' + r;
  };
  /* Notes that convert: everything live except keys a Lumatone / QWERTY key
     is physically holding (playback voices are composite VoiceIds, owned by
     the scheduler). Collected in the OLD frame. */
  const stays = (k: KeyId): boolean => isHeldKey('lumatone', k) || isHeldKey('qwerty', k);
  const converting = new Set<KeyId>();
  selection.selectedKeys.forEach((k) => { if (coordOf(k) === k && !stays(k)) converting.add(k); });
  audio.sustainedKeys.forEach((k) => { if (coordOf(k) === k && !stays(k)) converting.add(k); });

  tuning.mapping = val;
  rekeyHeld('piano', convertKey);
  const pairs: { oldKey: KeyId; newKey: KeyId }[] = [];
  converting.forEach((oldKey) => {
    const newKey = convertKey(oldKey);
    if (newKey === oldKey) return;
    if (stays(newKey)) {
      /* a physically held key already sounds that cell — it carries the note */
      noteOff(oldKey);
      selection.selectedKeys.delete(oldKey);
      audio.sustainedKeys.delete(oldKey);
      return;
    }
    pairs.push({ oldKey, newKey });
  });
  moveVoices(pairs);

  /* Reference tiers + both anchors in the new frame, a tier that fails
     validation there dropped. Silent — deliberately NOT onRefChanged: that
     would migrate held physical voices, which stay on their (q, r). */
  convertReferenceFrame(convert, (q, r) => validateRefNoteCandidate(q, r) === null);
  const manualRef = manualSelection();
  savePrefs({ manualRef: manualRef ? { q: manualRef.q, r: manualRef.r } : undefined });
  buildMidiReverse();
  invalidatePianoOutline();
  applyRotation(currentRotationMode); /* the verticalFreq tilt depends on the mapping */
  /* Retunes held physical voices in place, rebuilds the layers + footprint,
     resyncs Lumatone colors, broadcasts to Composer. */
  onTuningChanged();
  onSelectionChanged();
  savePrefs({ mapping: val });
}

export function setRotationFromDom(): void {
  const sel = document.getElementById('selRotation') as HTMLSelectElement;
  const mode = sel.value as RotationMode;
  applyRotation(mode);
  draw();
  sel.blur();
  savePrefs({ rotation: mode });
}

export function setHexSizeFromDom(): void {
  const sel = document.getElementById('selHexSize') as HTMLSelectElement;
  const size = sel.value as HexSize;
  applyHexSize(size);
  draw();
  sel.blur();
  savePrefs({ hexSize: size });
}

export function setOutline(): void {
  /* When the outline is None, Extend off would clamp the canvas to an
     undefined region (no bounds), so we force the renderer to act as if
     Extend is on and disable the checkbox to communicate that. */
  const sel = document.getElementById('selOutline') as HTMLSelectElement;
  const newOutline = sel.value as OutlineMode;
  const cbExtend = document.getElementById('cbExtend') as HTMLInputElement;
  cbExtend.disabled = newOutline === 'none';
  /* The Composer cursor slot only applies in the piano outline, so toggling
     between piano and non-piano can flip the effective ref; reference.ts
     re-derives it (onRefChanged fans out if it moved). */
  recomputeReferenceForOutline();
  /* Render fan-out: resize to the new outline's bounds + snap (immediate) +
     redraw. Shared with the overlay subscriber via render/controls-core. */
  applyOutlineRender(newOutline);
  sel.blur();
  savePrefs({ outline: newOutline });
  /* Outline switches the active footprint set Composer sees as the
     constraint overlay. Previously this rode along on the rAF poll; with
     event-driven broadcasts the switch must be announced explicitly. */
  broadcastFootprint();
}

export function transposeSelection(dq: number, dr: number): void {
  if (selection.selectedKeys.size === 0) return;
  /* The buttons name Euler intervals (P5, M3, m3, P8, SC); express the step in
     the active mapping's frame. */
  [dq, dr] = vecFromEuler(dq, dr, tuning.mapping);
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
    /* Transpose the user's LIVE voices only (VoiceId === coord); playback
       voices (composite VoiceIds) are owned by the scheduler and left in place. */
    const liveKeys = Object.keys(audio.activeOscs).filter((k) => coordOf(k) === k);
    if (instrReplaysOnTranspose()) {
      /* decaying instrument or opt-in replayOnTranspose (organs):
         stop old, let syncAudio retrigger after selection shift */
      for (const k of liveKeys) { noteOff(k); delete audio.activeOscs[k]; }
    } else {
      /* sustained instrument: smooth ramp */
      const newOscs: Record<KeyId, Voice> = {};
      const sampleMoves: { oldKey: KeyId; newKey: KeyId; nq: number; nr: number; newFreq: number; instr: string; vol?: number }[] = [];
      const now = audio.audioCtx.currentTime;
      for (const k of liveKeys) {
        const p = k.split(','), nq = +p[0] + dq, nr = +p[1] + dr;
        const e = audio.activeOscs[k];
        if (e.type === 'osc') {
          e.osc.frequency.setValueAtTime(e.osc.frequency.value, now);
          e.osc.frequency.exponentialRampToValueAtTime(keyFreq(nq, nr), now + 0.1);
          e.q = nq; e.r = nr;
          newOscs[nq + ',' + nr] = e;
        } else if (e.type === 'sample') {
          sampleMoves.push({ oldKey: k, newKey: nq + ',' + nr, nq, nr, newFreq: keyFreq(nq, nr), instr: e.instr });
        }
        delete audio.activeOscs[k];
      }
      sampleMoves.forEach(function (m) { m.vol = SampleEngine.slideAndFadeOut(m.oldKey, m.newFreq, 0.1); });
      sampleMoves.forEach(function (m) {
        SampleEngine.noteOnFaded(m.newKey, m.newFreq, m.vol!, 0.1, m.instr);
        newOscs[m.newKey] = { type: 'sample', freq: m.newFreq, instr: m.instr, q: m.nq, r: m.nr };
      });
      Object.assign(audio.activeOscs, newOscs);
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
  /* Only the user's live sustained/sounding voices are cleared; playback voices
     (composite VoiceIds) are owned by the scheduler and left untouched. */
  for (const k of Array.from(audio.sustainedKeys)) {
    if (coordOf(k) === k) audio.sustainedKeys.delete(k);
  }
  if (audio.audioCtx) {
    const now = audio.audioCtx.currentTime;
    for (const k in audio.activeOscs) {
      if (coordOf(k) !== k) continue; /* skip playback voices */
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
      delete audio.activeOscs[k];
    }
  }
  stopAllMidi();
  clearAllHeld();
  draw();
}
