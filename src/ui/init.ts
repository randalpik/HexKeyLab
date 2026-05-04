// Bootstrap: top-level wiring that runs at module load.
//
// 1. Initialize audio (creates AudioContext, loads default instrument).
// 2. Request MIDI access; on success, auto-detect Lumatone, wire input.
// 3. Attach canvas mouse listeners for click selection + hover lighten.
// 4. First paint + info-panel size.
// 5. Window resize handler.
// 6. Phase 1 inline-handler bridge: the HTML still uses inline onclick=/
//    onchange= attributes pointing to globals (setLayout, toggleAudio, etc.).
//    ES modules don't reach window, so we expose the relevant handlers via
//    Object.assign(window, {...}). This will go away when index.html gets
//    converted to addEventListener wiring.

import { selection } from '../state/selection.js';
import { view } from '../state/view.js';
import { sizeCanvas } from '../render/canvas.js';
import { cv, draw, hexAtPoint } from '../render/draw.js';
import { sizeInfoPanel, updateInfo } from '../render/info.js';
import { initAudio, changeWaveform, toggleAudio } from '../audio/engine.js';
import { requestMidi } from '../midi/engine.js';
import { handleMidiMessage } from '../midi/handler.js';
import {
  setTuning, shiftSeams, setLayout, clearSelection, transposeSelection,
} from './controls.js';
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

// ── Phase 1 inline-handler bridge ──
// The HTML uses inline onclick=/onchange= attributes that reference these names.
// In a <script type="module"> context, top-level functions are module-scoped,
// so we have to expose them on window. To be removed once index.html is
// converted to addEventListener wiring.
function cbNotesChanged(): void { view.textDirty = true; draw(); }
function cbExtendChanged(): void { view.hexDirty = true; view.textDirty = true; draw(); }
Object.assign(window, {
  setLayout, setTuning, toggleAudio, changeWaveform,
  togglePedalCalibration, toggleAutoSync, clearSelection, resetPedalBounds,
  draw, updateInfo,
  cbNotesChanged, cbExtendChanged,
});
