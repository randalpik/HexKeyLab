// Bootstrap: top-level wiring that runs at module load.
//
// 1. Initialize audio (creates AudioContext, loads default instrument).
// 2. Request MIDI access; on success, auto-detect Lumatone, wire input.
// 3. Attach canvas mouse listeners for click selection + hover lighten.
// 4. Wire toolbar controls (layout buttons, view checkboxes, tuning, audio,
//    calibration, auto-sync) via addEventListener.
// 5. First paint + info-panel size.
// 6. Window resize handler.

import { selection } from '../state/selection.js';
import { view } from '../state/view.js';
import { sizeCanvas } from '../render/canvas.js';
import { cv, draw, hexAtPoint } from '../render/draw.js';
import { sizeInfoPanel, updateInfo } from '../render/info.js';
import { initAudio, changeWaveform, toggleAudio } from '../audio/engine.js';
import { requestMidi } from '../midi/engine.js';
import { handleMidiMessage } from '../midi/handler.js';
import { setTuning, setLayout, clearSelection } from './controls.js';
import './keyboard.js';
import {
  togglePedalCalibration, resetPedalBounds,
} from '../lumatone/calibration.js';
import { toggleAutoSync } from '../lumatone/sync.js';
import { onSelectionChanged } from '../effects/onSelectionChanged.js';

/* trigger initial instrument load (piano is default selected) */
initAudio();
changeWaveform();

requestMidi(handleMidiMessage);

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
const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

// Layout buttons
$<HTMLButtonElement>('lb2').addEventListener('click', () => setLayout(2));
$<HTMLButtonElement>('lb1').addEventListener('click', () => setLayout(1));
$<HTMLButtonElement>('lb3').addEventListener('click', () => setLayout(3));

// View-toggle checkboxes
$<HTMLInputElement>('cbNotes').addEventListener('change', () => {
  view.textDirty = true; draw();
});
$<HTMLInputElement>('cbBands').addEventListener('change', () => draw());
$<HTMLInputElement>('cbExtend').addEventListener('change', () => {
  view.hexDirty = true; view.textDirty = true; draw();
});
$<HTMLInputElement>('cbCoords').addEventListener('change', updateInfo);
$<HTMLInputElement>('cbShortIvl').addEventListener('change', updateInfo);

// Tuning + clear
$<HTMLSelectElement>('selTuning').addEventListener('change', setTuning);
$<HTMLButtonElement>('btnClear').addEventListener('click', clearSelection);

// Audio
$<HTMLInputElement>('cbAudio').addEventListener('change', toggleAudio);
$<HTMLSelectElement>('waveform').addEventListener('change', changeWaveform);

// Calibration & auto-sync
$<HTMLButtonElement>('btnCalibPedal').addEventListener('click', togglePedalCalibration);
$<HTMLButtonElement>('btnResetPedal').addEventListener('click', resetPedalBounds);
$<HTMLInputElement>('cbAutoSync').addEventListener('change', toggleAutoSync);

draw();
sizeInfoPanel();

function onResize(): void {
  const oldCW = view.CW;
  sizeCanvas();
  if (view.CW !== oldCW) {
    cv.style.width = view.CW + 'px';
    view.hexDirty = true;
    view.textDirty = true;
    draw();
  }
  sizeInfoPanel();
}
window.addEventListener('resize', onResize);
