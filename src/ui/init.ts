// Bootstrap: top-level wiring that runs at module load.
//
// 1. Load persisted prefs and apply them to the DOM up front (so listener
//    attachment doesn't see autofilled values mid-init, and so primed DOM
//    state can be read by the handlers we fire below).
// 2. Initialize audio (creates AudioContext, loads the persisted instrument).
// 3. Request MIDI access; on success, auto-detect Lumatone, wire input.
// 4. Attach canvas mouse listeners for click selection + hover lighten.
// 5. Wire toolbar controls (view checkboxes, tuning, audio, calibration,
//    auto-sync) via addEventListener — each handler also writes its mutated
//    field to persistence.
// 6. Fire change-handlers once with the prefs-primed DOM so downstream state
//    (audio, Lumatone color sync) lines up with what the user had on their
//    last reload.
// 7. First paint + info-panel size.
// 8. Window resize handler + Reset-prefs button.

import { onRefChanged } from '../effects/onRefChanged.js';
import { refSpine } from '../tuning/refspine.js';
import { selection } from '../state/selection.js';
import { view } from '../state/view.js';
import { pedal } from '../state/pedal.js';
import { audio } from '../state/audio.js';
import { lumatone } from '../state/lumatone.js';
import { loadPrefs, savePrefs, clearPrefs, DEFAULT_PREFS } from '../state/persistence.js';
import type { PrefsV1, OutlineMode } from '../state/persistence.js';
import {
  referenceNote, setSelectionFromManual,
  clearSelection as clearRefSelection,
} from '../state/reference.js';
import { sizeCanvas } from '../render/canvas.js';
import { cv, draw, hexAtPoint, activeFootprintSet, invalidatePianoOutline, validateRefNoteCandidate } from '../render/draw.js';
import { updateInfo } from '../render/info.js';
import {
  initAudio, changeWaveform, toggleAudio,
  setDamperDepth, sostenutoOn, sostenutoOff,
} from '../audio/engine.js';
import { requestMidi } from '../midi/engine.js';
import { handleMidiMessage } from '../midi/handler.js';
import { initPiano } from '../midi/piano.js';
import {
  setTuning, setOutline, clearSelection,
  applyRotation, setRotationFromDom, syncViewToOutline,
} from './controls.js';
import './keyboard.js';
import '../input/keyboard-notes.js';
import {
  togglePedalCalibration, resetPedalBounds,
} from '../lumatone/calibration.js';
import { toggleAutoSync } from '../lumatone/sync.js';
import {
  ensureLumaDiag, setLumaDiagVisible, setLumaDiagHotkeyCallback,
} from '../lumatone/lumadiag.js';
import {
  ensureLoopOverlay, setLoopOverlayVisible,
} from '../audio/diagnostics/loopOverlay.js';
import { ensurePedalHud, setPedalHudVisible } from './pedalHud.js';
import { SampleEngine } from '../audio/samples.js';
import { applyToolbarVisibility, initToolbarSelector } from './toolbars.js';
import { onSelectionChanged } from '../effects/onSelectionChanged.js';
import { initHklBridge } from '../bridge/hkl-side.js';
import { initRecorderUI } from './recorder.js';

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

/* Apply persisted prefs to the DOM controls. Called before listener
   attachment so set-value mutations don't trigger any handlers (they don't
   fire change events anyway, but it keeps the priming step clean and
   single-purpose). */
function applyPrefsToDom(p: PrefsV1): void {
  $<HTMLInputElement>('cbNotes').checked = p.showNotes;
  $<HTMLInputElement>('cbBands').checked = p.showBands;
  $<HTMLInputElement>('cbAnalysis').checked = p.showAnalysis;
  $<HTMLInputElement>('cbExtend').checked = p.extendPattern;
  $<HTMLInputElement>('cbValidRefBounds').checked = p.validRefBounds;
  $<HTMLInputElement>('cbCoords').checked = p.showCoords;
  $<HTMLInputElement>('cbShortIvl').checked = p.shortIvl;
  $<HTMLSelectElement>('selOutline').value = p.outline;
  $<HTMLSelectElement>('selRotation').value = p.rotation;
  $<HTMLSelectElement>('selTuning').value = p.tuning;
  $<HTMLInputElement>('cbAudio').checked = p.audioEnabled;
  $<HTMLSelectElement>('waveform').value = p.waveform;
  $<HTMLSelectElement>('pedalMode').value = p.pedalMode;
  $<HTMLInputElement>('cbAutoSync').checked = p.autoSync;
  $<HTMLInputElement>('cbShowDiag').checked = p.showDiagnostics;
  $<HTMLInputElement>('cbCalibrateKeys').checked = p.calibrateKeys;
}

const prefs = loadPrefs();
applyPrefsToDom(prefs);
/* Apply persisted rotation before first paint — resets geometry tilt,
   canvas bounds, and cv.style.height to match the saved mode. */
applyRotation(prefs.rotation);
applyToolbarVisibility(prefs.toolbars);
initToolbarSelector();

/* State fields with no DOM mirror — set directly before any handlers run. */
pedal.mode = prefs.pedalMode;

initAudio();
/* Load the persisted instrument. Fires regardless of audioEnabled so the
   sample buffers are ready by the time the user toggles Audio on (today's
   behavior was always-preload via the unconditional changeWaveform call). */
changeWaveform();

requestMidi(handleMidiMessage);

/* Piano-keyboard MIDI input dispatch. Shares MIDIAccess with the Lumatone
   path; selected device is held in midi.pianoIn separately. Hotplug aware
   via a 1.5s identity poll on midi.midiAccess. */
initPiano();

/* HKL ↔ Composer bridge — broadcasts held-keys for the companion composer.html
   surface, dispatches play-chord/play-score from Composer. Idempotent; safe
   if no Composer tab is open. Static import: the broadcast functions are
   pulled in by effects/* fan-outs anyway, so deferring init bought nothing. */
initHklBridge();

/* lumadiag overlay: lazy build + show driven by prefs/checkbox. Hotkey
   (Shift+\) defers to a callback so the checkbox + pref stay in sync. */
function applyCalibrateKeys(visible: boolean): void {
  if (visible) {
    ensureLumaDiag();
    setLumaDiagVisible(true);
  } else {
    setLumaDiagVisible(false);
  }
}
setLumaDiagHotkeyCallback(() => {
  const cb = $<HTMLInputElement>('cbCalibrateKeys');
  const next = !cb.checked;
  cb.checked = next;
  applyCalibrateKeys(next);
  savePrefs({ calibrateKeys: next });
});
if (prefs.calibrateKeys) applyCalibrateKeys(true);

/* Pedal HUD: opt-in diagnostic readout for the intermittent stuck-sustain
   bug. Enabled via `?pedaldiag=1` querystring; no toolbar/pref entry (this
   is debug instrumentation, not a feature). Importing pedalHud.js above
   also attaches `pedal.dumpRecent` and `pedal.clear` to the pedal object
   and bridges pedal to window — those work whether or not the HUD is shown. */
if (new URLSearchParams(location.search).has('pedaldiag')) {
  ensurePedalHud();
  setPedalHudVisible(true);
}

/* loopdiag overlay: lazy build + show driven by prefs/checkbox. Needs an
   AudioContext, so deferred until audio is initialized. */
function applyShowDiagnostics(visible: boolean): void {
  if (visible) {
    if (!audio.audioCtx) {
      console.warn('[hkl] Show diagnostics: enable Audio first');
      return;
    }
    ensureLoopOverlay(audio.audioCtx, SampleEngine);
    setLoopOverlayVisible(true);
  } else {
    setLoopOverlayVisible(false);
  }
}

cv.addEventListener('mousedown', function (e: MouseEvent) {
  const rect = cv.getBoundingClientRect();
  const key = hexAtPoint(e.clientX - rect.left, e.clientY - rect.top);
  if (!key) return;
  /* Ctrl/Cmd+click: manage the reference-note selection tier. Clicking the
     current effective ref clears the selection (revealing song-key tier or
     default); clicking anywhere else sets manual=that-cell. Does NOT touch
     the play selection. */
  if (e.ctrlKey || e.metaKey) {
    const [qs, rs] = key.split(',');
    const q = +qs, r = +rs;
    const isCurrentRef = (q === referenceNote.q && r === referenceNote.r);
    if (!isCurrentRef) {
      /* Validate the proposed refNote BEFORE mutating state. Rejected
         clicks flash an explanation and leave everything as-is. */
      const reason = validateRefNoteCandidate(q, r);
      if (reason) { flashInfoLine(reason); return; }
    }
    /* Compute old refSpine BEFORE mutation so onRefChanged can pass the
       delta to held-physical-voice migrators. */
    const oldSp = refSpine(referenceNote.q, referenceNote.r);
    const changed = isCurrentRef ? clearRefSelection() : setSelectionFromManual(q, r);
    if (changed) {
      const newSp = refSpine(referenceNote.q, referenceNote.r);
      onRefChanged(newSp.q - oldSp.q, newSp.r - oldSp.r);
      /* Persist or drop the manual ref. Composer-set selections do not persist. */
      if (isCurrentRef) savePrefs({ manualRef: undefined });
      else savePrefs({ manualRef: { q, r } });
      invalidatePianoOutline();
      syncViewToOutline(getOutlineSelValue(), false);
      draw();
    }
    return;
  }
  if (e.shiftKey) { selection.selectedKeys.clear(); selection.selectedKeys.add(key); }
  else {
    if (selection.selectedKeys.has(key)) selection.selectedKeys.delete(key);
    else selection.selectedKeys.add(key);
  }
  onSelectionChanged();
});

function getOutlineSelValue(): OutlineMode {
  const sel = document.getElementById('selOutline') as HTMLSelectElement | null;
  const v = sel?.value;
  if (v === 'qwerty' || v === 'piano' || v === 'none') return v;
  return 'lumatone';
}

let infoLineFlashTimer: number | null = null;
/** Briefly replace #infoLine with a transient message, then restore via
 *  updateInfo(). Used for ctrl+click validation rejections. */
function flashInfoLine(text: string, ms = 2000): void {
  const el = document.getElementById('infoLine');
  if (!el) return;
  if (infoLineFlashTimer !== null) clearTimeout(infoLineFlashTimer);
  el.innerHTML = '<span class="hint" style="color:#e88">' + text + '</span>';
  infoLineFlashTimer = window.setTimeout(() => {
    infoLineFlashTimer = null;
    updateInfo();
  }, ms);
}
cv.addEventListener('mousemove', function (e: MouseEvent) {
  const rect = cv.getBoundingClientRect();
  const key = hexAtPoint(e.clientX - rect.left, e.clientY - rect.top);
  if (key !== selection.hoverKey) { selection.hoverKey = key; draw(); }
});
cv.addEventListener('mouseleave', function () {
  if (selection.hoverKey !== null) { selection.hoverKey = null; draw(); }
});

// ── Toolbar wiring ──

// View-toggle checkboxes (each persists its own field)
$<HTMLInputElement>('cbNotes').addEventListener('change', (e) => {
  view.textDirty = true; draw();
  savePrefs({ showNotes: (e.target as HTMLInputElement).checked });
});
$<HTMLInputElement>('cbBands').addEventListener('change', (e) => {
  draw();
  savePrefs({ showBands: (e.target as HTMLInputElement).checked });
});
$<HTMLInputElement>('cbExtend').addEventListener('change', (e) => {
  const checked = (e.target as HTMLInputElement).checked;
  view.hexDirty = true; view.textDirty = true;
  /* Disabling extend pattern hides keys outside the outline; release any that
     were sounding (selected or pedal-sustained) so audio/MIDI mirror what's
     visible. fp===null means outline is 'none' → nothing to clip. */
  let selectionMutated = false;
  if (!checked) {
    const fp = activeFootprintSet();
    if (fp) {
      selection.selectedKeys.forEach((k) => {
        if (!fp.has(k)) { selection.selectedKeys.delete(k); selectionMutated = true; }
      });
      audio.sustainedKeys.forEach((k) => {
        if (!fp.has(k)) { audio.sustainedKeys.delete(k); selectionMutated = true; }
      });
    }
  }
  if (selectionMutated) onSelectionChanged(); else draw();
  savePrefs({ extendPattern: checked });
});
$<HTMLInputElement>('cbValidRefBounds').addEventListener('change', (e) => {
  draw();
  savePrefs({ validRefBounds: (e.target as HTMLInputElement).checked });
});
$<HTMLInputElement>('cbCoords').addEventListener('change', (e) => {
  updateInfo();
  savePrefs({ showCoords: (e.target as HTMLInputElement).checked });
});
$<HTMLInputElement>('cbShortIvl').addEventListener('change', (e) => {
  updateInfo();
  savePrefs({ shortIvl: (e.target as HTMLInputElement).checked });
});

// Tuning + outline + clear
$<HTMLSelectElement>('selTuning').addEventListener('change', setTuning);

$<HTMLSelectElement>('selOutline').addEventListener('change', () => setOutline());
$<HTMLSelectElement>('selRotation').addEventListener('change', setRotationFromDom);
$<HTMLButtonElement>('btnClear').addEventListener('click', clearSelection);

// Audio
$<HTMLInputElement>('cbAudio').addEventListener('change', toggleAudio);
$<HTMLSelectElement>('waveform').addEventListener('change', changeWaveform);

// Pedal mode (sustain jack role: damper vs sostenuto)
$<HTMLSelectElement>('pedalMode').addEventListener('change', function (e) {
  const next = (e.target as HTMLSelectElement).value as 'sustain' | 'sostenuto';
  const prev = pedal.mode;
  if (next === prev) return;
  pedal.mode = next;
  /* If sustain jack is currently held, re-evaluate it under the new mode so
     mid-press dropdown changes don't strand sustain or sostenuto state. */
  const lastCC64 = pedal.lastCC64Value;
  if (prev === 'sostenuto' && next === 'sustain') {
    /* leaving sostenuto: clear any locked set, then if CC64 is held, treat it as damper */
    sostenutoOff();
    pedal.cc64Depth = (lastCC64 !== null && lastCC64 >= 64) ? 1 : 0;
    setDamperDepth();
  } else if (prev === 'sustain' && next === 'sostenuto') {
    /* entering sostenuto: if CC64 was contributing to damper, drop that contribution
       and re-trigger sostenuto from the held state */
    pedal.cc64Depth = 0;
    setDamperDepth();
    if (lastCC64 !== null && lastCC64 >= 64) sostenutoOn();
    else sostenutoOff();
  }
  savePrefs({ pedalMode: next });
});

// Calibration & auto-sync
$<HTMLButtonElement>('btnCalibPedal').addEventListener('click', togglePedalCalibration);
$<HTMLButtonElement>('btnResetPedal').addEventListener('click', resetPedalBounds);
$<HTMLInputElement>('cbAutoSync').addEventListener('change', toggleAutoSync);

// Diagnostics toggles
$<HTMLInputElement>('cbShowDiag').addEventListener('change', (e) => {
  const checked = (e.target as HTMLInputElement).checked;
  applyShowDiagnostics(checked);
  savePrefs({ showDiagnostics: checked });
});
$<HTMLInputElement>('cbCalibrateKeys').addEventListener('change', (e) => {
  const checked = (e.target as HTMLInputElement).checked;
  applyCalibrateKeys(checked);
  savePrefs({ calibrateKeys: checked });
});

/* Reset prefs in-place: clear storage, then drive every control back to its
   default through the same handlers a user would fire. No reload — avoids the
   canvas resize flash that location.reload() causes. */
function resetToDefaults(): void {
  clearPrefs();
  const p = DEFAULT_PREFS;

  applyPrefsToDom(p);
  applyToolbarVisibility(p.toolbars);
  applyShowDiagnostics(p.showDiagnostics);
  applyCalibrateKeys(p.calibrateKeys);

  /* Non-DOM state: pedal mode is set directly. */
  pedal.mode = p.pedalMode;

  setTuning();
  setOutline();  /* user-initiated path; tween view to new home position */
  applyRotation(p.rotation);

  if (audio.audioEnabled !== p.audioEnabled) toggleAudio();
  if (audio.activeWaveform !== p.waveform) changeWaveform();
  if (lumatone.autoSyncEnabled !== p.autoSync) toggleAutoSync();

  /* View-toggle checkboxes have no handler we fired above — drive their
     side effects directly so cbNotes/cbBands/cbExtend/cbCoords/cbShortIvl
     visual changes take effect immediately. */
  view.hexDirty = true;
  view.textDirty = true;
  draw();
  updateInfo();
}

$<HTMLButtonElement>('btnResetPrefs').addEventListener('click', resetToDefaults);

initRecorderUI();

/* ── Init backfill: fire change-handlers so they read the prefs-primed DOM
   and propagate to JS state + side-effect targets (visibility toggles,
   layout view, color sync, etc.). Order is dependency-driven: tuning before
   layout (color sync diffs against tuning state) before manualRef restore
   + outline (setOutline's view-sync snaps to refNote in piano mode, which
   needs the persisted manualRef already in place). ── */
setTuning();
if (prefs.manualRef) {
  /* Silently drop a persisted manualRef that no longer validates under
     the current tuning (e.g. user changed limit/septimal between sessions
     and the stored cell would now require >±3 accidentals on some MIDI). */
  const invalid = validateRefNoteCandidate(prefs.manualRef.q, prefs.manualRef.r);
  if (invalid) {
    savePrefs({ manualRef: undefined });
  } else {
    setSelectionFromManual(prefs.manualRef.q, prefs.manualRef.r);
  }
}
setOutline();
if (prefs.audioEnabled) toggleAudio();
if (prefs.autoSync) toggleAutoSync();
/* Apply showDiagnostics now that audio is initialized — the loop overlay
   needs audioCtx, which exists after the toggleAudio() / initAudio() path
   above (or after first interaction if audio is off). */
if (prefs.showDiagnostics) applyShowDiagnostics(true);

draw();

function onResize(): void {
  const oldCW = view.CW;
  sizeCanvas();
  if (view.CW !== oldCW) {
    cv.style.width = view.CW + 'px';
    view.hexDirty = true;
    view.textDirty = true;
    draw();
  }
}
window.addEventListener('resize', onResize);
