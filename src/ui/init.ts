// Bootstrap: top-level wiring that runs at module load.
//
// 1. Load persisted prefs and apply them to the DOM up front (so listener
//    attachment doesn't see autofilled values mid-init, and so primed DOM
//    state can be read by the handlers we fire below).
// 2. Initialize audio (creates AudioContext, loads the persisted instrument).
// 3. Request MIDI access; on success, auto-detect Lumatone, wire input.
// 4. Attach canvas mouse listeners for click selection + hover lighten.
// 5. Wire toolbar controls (layout buttons, view checkboxes, tuning, audio,
//    calibration, auto-sync) via addEventListener — each handler also writes
//    its mutated field to persistence.
// 6. Fire change-handlers once with the prefs-primed DOM so dependent visibility
//    (qwertyTransposeCtrl, seamShiftCtrl) and downstream state (audio, layout,
//    Lumatone color sync) line up with what the user had on their last reload.
// 7. First paint + info-panel size.
// 8. Window resize handler + Reset-prefs button.

import { selection } from '../state/selection.js';
import { view } from '../state/view.js';
import { pedal } from '../state/pedal.js';
import { tuning } from '../state/tuning.js';
import { audio } from '../state/audio.js';
import { lumatone } from '../state/lumatone.js';
import { loadPrefs, savePrefs, clearPrefs, DEFAULT_PREFS } from '../state/persistence.js';
import type { PrefsV1 } from '../state/persistence.js';
import { sizeCanvas } from '../render/canvas.js';
import { cv, draw, hexAtPoint, activeFootprintSet } from '../render/draw.js';
import { updateInfo } from '../render/info.js';
import {
  initAudio, changeWaveform, toggleAudio,
  setDamperDepth, sostenutoOn, sostenutoOff,
} from '../audio/engine.js';
import { requestMidi } from '../midi/engine.js';
import { handleMidiMessage } from '../midi/handler.js';
import { initPiano } from '../midi/piano.js';
import {
  setTuning, setOutline, setLayout, applyLayoutImmediate,
  setQwertyTranspose, clearSelection,
  applyRotation, setRotationFromDom,
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
tuning.septimalShift = prefs.septimalShift;
tuning.qwertyTranspose = prefs.qwertyTranspose;
pedal.mode = prefs.pedalMode;

/* Stepper indicator labels — no handler updates these from raw prefs. */
const seamShiftInd = document.getElementById('seamShiftInd');
if (seamShiftInd) seamShiftInd.textContent = String(prefs.septimalShift);
const qwertyTrInd = document.getElementById('qwertyTrInd');
if (qwertyTrInd) qwertyTrInd.textContent = String(prefs.qwertyTranspose);

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
   if no Composer tab is open. */
import('../bridge/hkl-side.js').then((m) => m.initHklBridge());

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
  if (e.shiftKey) { selection.selectedKeys.clear(); selection.selectedKeys.add(key); }
  else {
    if (selection.selectedKeys.has(key)) selection.selectedKeys.delete(key);
    else selection.selectedKeys.add(key);
  }
  onSelectionChanged();
});
cv.addEventListener('mousemove', function (e: MouseEvent) {
  const rect = cv.getBoundingClientRect();
  const key = hexAtPoint(e.clientX - rect.left, e.clientY - rect.top);
  if (key !== selection.hoverKey) { selection.hoverKey = key; draw(); }
});
cv.addEventListener('mouseleave', function () {
  if (selection.hoverKey !== null) { selection.hoverKey = null; draw(); }
});

// ── Toolbar wiring ──

// Layout buttons
$<HTMLButtonElement>('lb2').addEventListener('click', () => setLayout(2));
$<HTMLButtonElement>('lb1').addEventListener('click', () => setLayout(1));
$<HTMLButtonElement>('lb3').addEventListener('click', () => setLayout(3));

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
$<HTMLSelectElement>('selOutline').addEventListener('change', setOutline);
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

  /* Non-DOM state: pedal mode + seam shift get set directly. */
  pedal.mode = p.pedalMode;
  tuning.septimalShift = p.septimalShift;
  const ssi = document.getElementById('seamShiftInd');
  if (ssi) ssi.textContent = String(p.septimalShift);

  /* QWERTY transpose: route through setQwertyTranspose so any held QWERTY
     voices migrate cleanly to the new transpose. */
  if (tuning.qwertyTranspose !== p.qwertyTranspose) {
    setQwertyTranspose(p.qwertyTranspose - tuning.qwertyTranspose);
  }

  setTuning();
  setOutline();
  applyRotation(p.rotation);
  setLayout(p.curLayout);

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
   layout (color sync diffs against tuning state), outline visibility before
   first paint. ── */
setTuning();
setOutline();
applyLayoutImmediate(prefs.curLayout);
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
