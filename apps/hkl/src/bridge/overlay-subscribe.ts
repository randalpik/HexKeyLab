// OBS-overlay subscriber bootstrap (?overlay). A passive, render-only HKL
// instance: it reconstructs the performing instance's lattice + Composer-frame
// state from the WebSocket mirror and draws it transparent + chrome-free. No
// audio, no MIDI, no input — main.ts loads this INSTEAD of ui/init.ts.
//
// State reconstruction uses the ENGINE-FREE render primitives in
// render/controls-core.ts (applyRotation / applyHexSize / applyTuningRender /
// applyOutlineRender) plus direct state writes — deliberately NOT ui/controls.ts,
// which statically imports the audio/MIDI engines. This is what keeps the
// overlay bundle lean: nothing here transitively reaches audio/midi/lumatone/
// recording. View pan + lit keys are overridden to the streamed exact values.

import { OverlayChannel } from '@hkl/bridge/overlay-ws.js';
import type { OverlayMsg, OverlaySnapshot } from '@hkl/bridge/overlay-protocol.js';
import type { RotationMode, HexSize, OutlineMode, TuningMode } from '../state/persistence.js';
import { view } from '../state/view.js';
import { selection } from '../state/selection.js';
import { tuning } from '../state/tuning.js';
import { setSelectionFromManual } from '../state/reference.js';
import {
  applyRotation, applyHexSize, applyTuningRender, applyOutlineRender,
} from '../render/controls-core.js';
import { cv, draw, requestDraw, setTransparentBg } from '../render/draw.js';
import {
  setComposerScore, setComposerPlaybackBars, renderComposerFrame,
} from '../render/composer-frame.js';

/* Transparent + chrome-free from the first frame. The class lives on <html> so
   the page-root background goes transparent too (see index.html html.overlay). */
document.documentElement.classList.add('overlay');
setTransparentBg(true);

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function applySnapshot(s: OverlaySnapshot): void {
  /* 1. Prime the DOM controls the apply functions read from. */
  $<HTMLInputElement>('cbNotes').checked = s.showNotes;
  $<HTMLInputElement>('cbBands').checked = s.showBands;
  $<HTMLInputElement>('cbExtend').checked = s.extendPattern;
  $<HTMLInputElement>('cbHeji').checked = s.heji;
  $<HTMLSelectElement>('selTuning').value = s.tuning;
  $<HTMLSelectElement>('selOutline').value = s.outline;
  $<HTMLSelectElement>('selRotation').value = s.rotation;
  $<HTMLSelectElement>('selHexSize').value = s.hexSize;
  document.body.classList.toggle('composer-view', s.composerView);
  document.body.classList.toggle('staff-dark', s.staffDark);

  /* 2. Set tuning state directly (mirrors setTuning's core, minus the audio
     retune / ref auto-clear / savePrefs that the full app does), then run the
     engine-free render primitives. tuning.mode must be set before
     applyTuningRender (re-colors/respells) and before applyRotation/applyHexSize
     (recomputeCanvasBounds varies CH by mode). */
  tuning.mode = s.tuning as TuningMode;
  tuning.equalEnabled = s.tuning === 'E';
  tuning.septimalEnabled = s.tuning === '7';
  tuning.hejiEnabled = s.heji;
  setSelectionFromManual(s.refQ, s.refR);
  applyRotation(s.rotation as RotationMode);
  applyHexSize(s.hexSize as HexSize);
  applyTuningRender();
  applyOutlineRender(s.outline as OutlineMode);

  /* 3. Override pan + anchors + lit keys to the streamed exact values. */
  view.kbAnchorQ = s.kbAnchorQ;
  view.kbAnchorR = s.kbAnchorR;
  view.kbOffY = s.kbOffY;
  view.viewQ = s.viewQ;
  view.viewR = s.viewR;
  selection.selectedKeys = new Set(s.litKeys);

  view.hexDirty = true;
  view.textDirty = true;
  draw();
  if (s.composerView) renderComposerFrame();
}

function handle(msg: OverlayMsg): void {
  switch (msg.t) {
    case 'snapshot':
      applySnapshot(msg.data);
      break;
    case 'keys':
      selection.selectedKeys = new Set(msg.keys);
      requestDraw();
      break;
    case 'view':
      view.viewQ = msg.viewQ;
      view.viewR = msg.viewR;
      view.kbOffY = msg.kbOffY;
      requestDraw();
      break;
    case 'composer-view':
      document.body.classList.toggle('composer-view', msg.on);
      renderComposerFrame();
      break;
    case 'composer-score':
      setComposerScore(msg.mei);
      break;
    case 'composer-playback':
      /* Bars only (no editing caret in the overlay, by design): we never feed
         setComposerCursor here, so the read-only playback bars are the only
         cursor shown — exactly what's wanted in a performance capture. */
      setComposerPlaybackBars(msg.on, msg.bars);
      break;
    /* 'request-snapshot' is publisher-bound; never received here. */
  }
}

const channel = new OverlayChannel();
channel.on(handle);
/* Belt-and-suspenders: the relay replays retained state on connect, but a
   re-open after a relay restart also nudges a fresh replay. */
channel.onOpen(() => channel.send({ t: 'request-snapshot' }));

/* Size to the window like the normal boot's resize path (the canvas internal
   size tracks devicePixelRatio in draw(); the OBS source resolution should be
   set to the logical CW×CH). */
window.addEventListener('resize', () => {
  view.hexDirty = true;
  view.textDirty = true;
  requestDraw();
});

/* First paint before any snapshot arrives — a transparent canvas. */
cv.style.width = view.CW + 'px';
draw();
