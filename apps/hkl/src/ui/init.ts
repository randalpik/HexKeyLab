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
import { getComposerRequiredLayout, applyComposerLayout, reconcileSelectionOnSyncEnable, preloadComposerInstruments } from '../bridge/hkl-side.js';
import { tuning } from '../state/tuning.js';
import { selection } from '../state/selection.js';
import { view } from '../state/view.js';
import { pedal, type PedalJack, type PedalRole } from '../state/pedal.js';
import { setJackRole } from '../midi/pedals.js';
import { audio } from '../state/audio.js';
import { lumatone } from '../state/lumatone.js';
import { loadPrefs, savePrefs, clearPrefs, DEFAULT_PREFS } from '../state/persistence.js';
import type { PrefsV1 } from '../state/persistence.js';
import { setSelectionFromManual, setAnchorListener, setRefListener } from '../state/reference.js';
import { onAnchorChanged } from '../effects/onAnchorChanged.js';
import { refitCanvasWidth } from '../render/controls-core.js';
import { cv, draw, hexAtPoint, activeFootprintSet, validateRefNoteCandidate } from '../render/draw.js';
import { updateInfo } from '../render/info.js';
import { renderStaffInset } from '../render/staff-inset.js';
import { renderComposerFrame } from '../render/composer-frame.js';
import { initAudio, changeWaveform, toggleAudio } from '../audio/engine.js';
import { requestMidi, setLumatoneConnectionHandler } from '../midi/engine.js';
import { handleMidiMessage } from '../midi/handler.js';
import { initPiano } from '../midi/piano.js';
import { initPianoOut } from '../midi/piano-out.js';
import {
  setTuning, setMapping, applyMapping, buildMappingSelect, showMappingInSelect, setBanded, syncBandedControls, setOutline, clearSelection,
  applyRotation, setRotationFromDom,
  applyAlignment, setAlignmentFromDom,
  applyHexSize, setHexSizeFromDom,
} from './controls.js';
import './keyboard.js';
import { isRefEditHeld, setRefEditListener } from '../input/ref-edit.js';
import { pickRef } from '../input/ref-pick.js';
import '../input/keyboard-notes.js';
import {
  togglePedalCalibration, resetPedalBounds,
} from '../lumatone/calibration.js';
import { toggleAutoSync, syncLumatoneKeyEffects, toggleLumatoneKeyEffects } from '../lumatone/sync.js';
import { setBoards34Swapped } from '../lumatone/protocol.js';
import {
  ensureLumaDiag, setLumaDiagVisible, setLumaDiagHotkeyCallback,
} from '../lumatone/lumadiag.js';
import {
  ensureLoopOverlay, setLoopOverlayVisible,
} from '../audio/diagnostics/loopOverlay.js';
import { ensurePedalHud, setPedalHudVisible } from './pedalHud.js';
/* Lumatone liveness-probe instrument: attaches its passive MIDI monitor and
   exposes window.lumaprobe. Diagnostic only — nothing calls into it. */
import '../lumatone/probe.js';
import { SampleEngine } from '../audio/samples.js';
import { applyToolbarVisibility, initToolbarSelector } from './toolbars.js';
import { initSecrets, renderSecrets } from './secrets.js';
import { hearKeyPress } from '../games/discovery.js';
import { gameClick } from '../games/mode.js';
import { applyTooltips } from './tooltips.js';
import { onSelectionChanged } from '../effects/onSelectionChanged.js';
import { markFirstNote } from '../input/first-note.js';
import { initHklBridge } from '../bridge/hkl-side.js';
import { setOverlayPublishing, publishComposerView } from '../bridge/overlay-publish.js';
import { initRecorderUI } from './recorder.js';
import * as InstrumentRegistry from '../state/instrumentRegistry.js';
import * as CdnConfigRegistry from '../state/cdnConfigRegistry.js';
import { initInstrumentBundlesUi } from './instrumentBundles.js';
import { initAboutUi } from './about.js';
import { initLayoutBuilderUi } from './layoutBuilder.js';

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

/* Apply persisted prefs to the DOM controls. Called before listener
   attachment so set-value mutations don't trigger any handlers (they don't
   fire change events anyway, but it keeps the priming step clean and
   single-purpose). */
function applyPrefsToDom(p: PrefsV1): void {
  $<HTMLInputElement>('cbNotes').checked = p.showNotes;
  $<HTMLInputElement>('cbBanded').checked = p.banded;
  $<HTMLInputElement>('cbBands').checked = p.showBands;
  $<HTMLInputElement>('cbAnalysis').checked = p.showAnalysis;
  $<HTMLInputElement>('cbExtend').checked = p.extendPattern;
  $<HTMLInputElement>('cbValidRefBounds').checked = p.validRefBounds;
  $<HTMLInputElement>('cbSyncToComposer').checked = p.syncToComposer;
  $<HTMLInputElement>('cbCoords').checked = p.showCoords;
  $<HTMLInputElement>('cbFactors').checked = p.showFactors;
  $<HTMLInputElement>('cbShortIvl').checked = p.shortIvl;
  $<HTMLInputElement>('cbHeji').checked = p.hejiEnabled;
  $<HTMLInputElement>('cbStaff').checked = p.showStaffNotation;
  document.body.classList.toggle('staff-on', p.showStaffNotation);
  $<HTMLInputElement>('cbStaffDark').checked = p.staffNotationDark;
  document.body.classList.toggle('staff-dark', p.staffNotationDark);
  $<HTMLInputElement>('cbComposerView').checked = p.composerView;
  document.body.classList.toggle('composer-view', p.composerView);
  $<HTMLSelectElement>('selOutline').value = p.outline;
  $<HTMLSelectElement>('selRotation').value = p.rotation;
  $<HTMLSelectElement>('selAlignment').value = p.alignment;
  $<HTMLSelectElement>('selTuning').value = p.tuning;
  buildMappingSelect();
  showMappingInSelect(p.mapping);
  $<HTMLSelectElement>('selHexSize').value = p.hexSize;
  $<HTMLInputElement>('cbAudio').checked = p.audioEnabled;
  $<HTMLSelectElement>('waveform').value = p.waveform;
  $<HTMLSelectElement>('pedalExpr').value = p.pedalExpr;
  $<HTMLSelectElement>('pedalSus').value = p.pedalSus;
  $<HTMLInputElement>('cbAutoSync').checked = p.autoSync;
  $<HTMLInputElement>('cbLumaKeyEffects').checked = p.lumatoneKeyEffects;
  $<HTMLInputElement>('cbShowDiag').checked = p.showDiagnostics;
  /* Hidden while no Lumatone is connected, and never checked while hidden:
     the connection handler below applies the saved pref on connect. */
  $<HTMLInputElement>('cbCalibrateKeys').checked = p.calibrateKeys && calibrateKeysShown();
}

/** Whether the Calibrate Keys checkbox is on screen (`luma-conn-only`). */
function calibrateKeysShown(): boolean {
  return !!document.getElementById('tb-group-lumatone')?.classList.contains('lumatone-connected');
}

/* Imported .hki bundles: open the IndexedDB-backed registry and append the
   "Imported (.hki)" optgroup to the #waveform select BEFORE we apply the
   persisted waveform value below. If the user's last session was on an
   imported instrument, the optgroup has to exist or `<select>.value =
   prefs.waveform` silently falls back to the first option. Top-level await
   blocks the rest of bootstrap on this — IDB open is a one-time ~50ms delay
   that's acceptable for a one-shot page load. */
await InstrumentRegistry.init();
await CdnConfigRegistry.init();
initInstrumentBundlesUi();
initAboutUi();
initLayoutBuilderUi();

const prefs = loadPrefs();
applyPrefsToDom(prefs);
/* The persisted mapping is the frame every other persisted coordinate
   (manualRef) was saved in: set it directly — no frame conversion — before
   anything reads coordinates (the verticalFreq tilt below included). */
tuning.mapping = prefs.mapping;
tuning.banded = prefs.banded;
syncBandedControls();
/* Apply the persisted alignment, then rotation, before first paint — poses
   the physical layout, then resets geometry tilt, canvas bounds, and
   cv.style.height to match the saved mode. */
applyAlignment(prefs.alignment);
applyRotation(prefs.rotation);
/* Apply persisted hex size before first paint — rescales geometry, rebuilds
   scale-dependent outline/snap caches, and recomputes bounds at the saved
   scale. After applyRotation so its bounds recompute reads the active mode. */
applyHexSize(prefs.hexSize);
applyToolbarVisibility(prefs.toolbars);
initToolbarSelector();
initSecrets();   /* the Secrets button and toolbar, if a game has been discovered */
/* Static tooltips for every toolbar control — text lives in tooltips.ts. */
applyTooltips();

/* State fields with no DOM mirror — set directly before any handlers run. */
pedal.roles.expr = prefs.pedalExpr;
pedal.roles.sus = prefs.pedalSus;
tuning.hejiEnabled = prefs.hejiEnabled;
/* Seed the board-routing swap before the first Lumatone sync. The toggle lives
   in the Calibrate Keys overlay, but the routing must be correct even if it's
   never opened. */
setBoards34Swapped(prefs.swapBoards34);

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

/* Piano output: mirror playback to an external synth (e.g. SP-250) via
   per-channel RPN just-intonation tuning. Output port auto-matches the
   selected piano input device by name. */
initPianoOut();

/* HKL ↔ Composer bridge: the listener is installed at module-load time
   (top-level bridge.on() in hkl-side.ts) so Composer messages already arrive.
   initHklBridge() only fires the initial announce() — defer until after
   prefs are restored (manualRef + tuning) so the first hkl-layout-state we
   broadcast reflects the user's actual state, not the default. Without this,
   Composer's blank-score auto-adopt grabbed the default (0,0) and echoed it
   back as a layoutReq before the restore happened. See `initHklBridge()`
   call at end of init.ts. */

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
/* The checkbox is hidden while no Lumatone is connected, so it is unchecked
   then and the overlay closed with it: an open overlay would have no visible
   control to close it. The pref is left alone, so the overlay comes back when
   the Lumatone does, and a saved pref opens it on connect rather than at
   startup. */
setLumatoneConnectionHandler((connected) => {
  const cb = $<HTMLInputElement>('cbCalibrateKeys');
  const next = connected && loadPrefs().calibrateKeys;
  if (cb.checked === next) return;
  cb.checked = next;
  applyCalibrateKeys(next);
});

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
  /* Ctrl/Cmd+click, or any click while the ref-edit modifier is held (a pedal
     in its Ctrl role holds it without a ctrlKey on the event): pick the
     reference note (input/ref-pick.ts). Does NOT touch the play selection. */
  if (e.ctrlKey || e.metaKey || isRefEditHeld()) {
    const [qs, rs] = key.split(',');
    pickRef(+qs, +rs);
    return;
  }
  /* A running hidden game takes a click on one of the Lumatone's keys
     (games/mode.ts), and it selects nothing. */
  if (gameClick(key)) return;
  if (e.shiftKey) { selection.selectedKeys.clear(); selection.selectedKeys.add(key); }
  else {
    if (selection.selectedKeys.has(key)) selection.selectedKeys.delete(key);
    else selection.selectedKeys.add(key);
  }
  const struck = selection.selectedKeys.has(key);
  if (struck) markFirstNote('pointer');
  onSelectionChanged();
  if (struck) hearKeyPress(key);   /* a click that selects a key is a strike to the motif listener */
});

cv.addEventListener('mousemove', function (e: MouseEvent) {
  const rect = cv.getBoundingClientRect();
  const key = hexAtPoint(e.clientX - rect.left, e.clientY - rect.top);
  if (key !== selection.hoverKey) { selection.hoverKey = key; draw(); syncLumatoneKeyEffects(); }
});
cv.addEventListener('mouseleave', function () {
  if (selection.hoverKey !== null) { selection.hoverKey = null; draw(); syncLumatoneKeyEffects(); }
});

// ── Toolbar wiring ──

// View-toggle checkboxes (each persists its own field)
$<HTMLInputElement>('cbNotes').addEventListener('change', (e) => {
  view.textDirty = true; draw();
  savePrefs({ showNotes: (e.target as HTMLInputElement).checked });
});
$<HTMLInputElement>('cbBanded').addEventListener('change', setBanded);
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
$<HTMLInputElement>('cbSyncToComposer').addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked;
  savePrefs({ syncToComposer: on });
  /* If turning Sync ON and Composer already has a different required layout
     cached, apply immediately so the user doesn't have to flip a switch and
     then trigger a separate action. */
  if (on) {
    const req = getComposerRequiredLayout();
    if (req && req.tuningMode !== tuning.mode) {
      /* Re-broadcast trick: send a manufactured layout-req-changed to our own
         handler? Simpler: just dispatch the apply via the same path as the
         message handler. The handler re-reads prefs.syncToComposer, so we
         only need to nudge it. Re-broadcast a request-state to ourselves
         won't work (Composer is the source). Use the exported applier. */
      applyComposerLayout();
    }
    /* The lattice must now match the score: drop any selection (manual or
       cursor) that differs from the score's ref so the score-ref tier becomes
       the effective ref. No-op if Composer isn't connected or it already
       matches. */
    reconcileSelectionOnSyncEnable();
    /* Eagerly load the score's instruments + switch to the cursor's, so
       note-entry preview is immediately in the right timbre (never the wrong
       one while a sample-set is still loading). */
    preloadComposerInstruments();
  }
});
$<HTMLInputElement>('cbAnalysis').addEventListener('change', (e) => {
  updateInfo();
  savePrefs({ showAnalysis: (e.target as HTMLInputElement).checked });
});
$<HTMLInputElement>('cbCoords').addEventListener('change', (e) => {
  updateInfo();
  savePrefs({ showCoords: (e.target as HTMLInputElement).checked });
});
$<HTMLInputElement>('cbFactors').addEventListener('change', (e) => {
  updateInfo();
  savePrefs({ showFactors: (e.target as HTMLInputElement).checked });
});
$<HTMLInputElement>('cbHeji').addEventListener('change', (e) => {
  const checked = (e.target as HTMLInputElement).checked;
  tuning.hejiEnabled = checked;
  view.textDirty = true;
  draw();
  savePrefs({ hejiEnabled: checked });
});
$<HTMLInputElement>('cbShortIvl').addEventListener('change', (e) => {
  updateInfo();
  savePrefs({ shortIvl: (e.target as HTMLInputElement).checked });
});
$<HTMLInputElement>('cbStaff').addEventListener('change', (e) => {
  const checked = (e.target as HTMLInputElement).checked;
  document.body.classList.toggle('staff-on', checked);
  savePrefs({ showStaffNotation: checked });
  renderStaffInset();
});
$<HTMLInputElement>('cbStaffDark').addEventListener('change', (e) => {
  const checked = (e.target as HTMLInputElement).checked;
  document.body.classList.toggle('staff-dark', checked);
  savePrefs({ staffNotationDark: checked });
  renderStaffInset();
  renderComposerFrame();
});
$<HTMLInputElement>('cbComposerView').addEventListener('change', (e) => {
  const checked = (e.target as HTMLInputElement).checked;
  document.body.classList.toggle('composer-view', checked);
  savePrefs({ composerView: checked });
  /* Paint the cached mirrored score when turning the frame on. */
  if (checked) renderComposerFrame();
  /* Mirror the frame on/off to the OBS overlay. */
  publishComposerView(checked);
});

// Tuning + outline + clear
$<HTMLSelectElement>('selTuning').addEventListener('change', setTuning);
$<HTMLSelectElement>('selMapping').addEventListener('change', setMapping);

$<HTMLSelectElement>('selOutline').addEventListener('change', () => setOutline());
$<HTMLSelectElement>('selRotation').addEventListener('change', setRotationFromDom);
$<HTMLSelectElement>('selAlignment').addEventListener('change', setAlignmentFromDom);
$<HTMLSelectElement>('selHexSize').addEventListener('change', setHexSizeFromDom);
$<HTMLButtonElement>('btnClear').addEventListener('click', clearSelection);

// Audio
$<HTMLInputElement>('cbAudio').addEventListener('change', toggleAudio);
$<HTMLSelectElement>('waveform').addEventListener('change', changeWaveform);

// Pedal roles: what each Lumatone pedal jack does. setJackRole re-reads the
// pedal's position under the new role, so a change made while the pedal is
// down strands nothing (midi/pedals.ts).
function wirePedalRole(jack: PedalJack, id: string): void {
  $<HTMLSelectElement>(id).addEventListener('change', (e) => {
    const role = (e.target as HTMLSelectElement).value as PedalRole;
    setJackRole(jack, role);
    savePrefs(jack === 'expr' ? { pedalExpr: role } : { pedalSus: role });
  });
}
wirePedalRole('expr', 'pedalExpr');
wirePedalRole('sus', 'pedalSus');

// Calibration & auto-sync
$<HTMLButtonElement>('btnCalibPedal').addEventListener('click', togglePedalCalibration);
$<HTMLButtonElement>('btnResetPedal').addEventListener('click', resetPedalBounds);
$<HTMLInputElement>('cbAutoSync').addEventListener('change', toggleAutoSync);
$<HTMLInputElement>('cbLumaKeyEffects').addEventListener('change', toggleLumatoneKeyEffects);

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
  renderSecrets();   /* the cleared prefs hold no discovered game */
  applyShowDiagnostics(p.showDiagnostics);
  applyCalibrateKeys(p.calibrateKeys);

  /* The pedal roles have no handler fired above; a pedal that is down is
     re-read under its default role. */
  setJackRole('expr', p.pedalExpr);
  setJackRole('sus', p.pedalSus);

  setTuning();
  applyMapping(p.mapping);  /* back to Euler: a real switch, so held notes convert */
  setBanded();   /* back to banded, if it was off */
  setOutline();  /* user-initiated path; tween view to new home position */
  setAlignmentFromDom();  /* held keys follow, LEDs resync, if it changed */
  applyRotation(p.rotation);
  applyHexSize(p.hexSize);

  if (audio.audioEnabled !== p.audioEnabled) toggleAudio();
  if (audio.activeWaveform !== p.waveform) changeWaveform();
  if (lumatone.autoSyncEnabled !== p.autoSync) toggleAutoSync();
  if (lumatone.keyEffects !== p.lumatoneKeyEffects) toggleLumatoneKeyEffects();

  /* View-toggle checkboxes have no handler we fired above — drive their
     side effects directly so cbNotes/cbBands/cbExtend/cbCoords/cbFactors/cbShortIvl
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
/* Every ref-tier change fans out through onRefChanged from here on (the
   restore below re-anchors and re-centers through it). */
setRefListener(onRefChanged);
/* The ref-edit modifier went down or up (input/ref-edit.ts): the canvas dims or
   restores the cells that cannot be a ref, and with Key effects on so does the
   Lumatone. */
setRefEditListener(() => { draw(); syncLumatoneKeyEffects('sync'); });
setTuning();
if (prefs.manualRef) {
  /* Silently drop a persisted manualRef that no longer validates (outside
     the piano range in the persisted mapping's frame). */
  const invalid = validateRefNoteCandidate(prefs.manualRef.q, prefs.manualRef.r);
  if (invalid) {
    savePrefs({ manualRef: undefined });
  } else {
    /* kbAnchor follows (reference.ts): the Lumatone/QWERTY layout comes back
       anchored to the persisted ref, not at the default (0, 0). */
    setSelectionFromManual(prefs.manualRef.q, prefs.manualRef.r);
  }
}
setOutline();
if (prefs.audioEnabled) toggleAudio();
lumatone.keyEffects = prefs.lumatoneKeyEffects; /* before Auto-sync's first push */
if (prefs.autoSync) toggleAutoSync();
/* Apply showDiagnostics now that audio is initialized — the loop overlay
   needs audioCtx, which exists after the toggleAudio() / initAudio() path
   above (or after first interaction if audio is off). */
if (prefs.showDiagnostics) applyShowDiagnostics(true);

draw();

/* Bridge announce: deferred until prefs are restored above so the first
   hkl-layout-state reflects user state, not the boot-time default. */
initHklBridge();

/* OBS overlay publishing: always attempt. A refused connection (no relay
   running) is silent on Chromium — the LNA permission prompt only fires once a
   connection is actually established, i.e. when a relay is genuinely present
   (see docs/decisions.md). So there's no checkbox: non-OBS visitors get a few
   silent connection-refused tries then giveUpAfter stops; an OBS user running
   the relay gets the prompt exactly when it's warranted. Seed the cached
   Composer-frame on/off so the first snapshot matches current state. */
setOverlayPublishing(true);
publishComposerView(prefs.composerView);

/* Anchor changes (Syntonic / Polysyntonic re-anchoring) retune from here on;
   the boot-time anchor was already read by the first render. */
setAnchorListener(onAnchorChanged);

function onResize(): void {
  const oldCW = view.CW;
  refitCanvasWidth();
  if (view.CW !== oldCW) draw();
}
window.addEventListener('resize', onResize);
/* The lattice's scroll box changes size without a window resize when toolbars
   open or close; a classic scrollbar appearing or going narrows or widens it. */
new ResizeObserver(onResize).observe($<HTMLElement>('cvScroll'));
