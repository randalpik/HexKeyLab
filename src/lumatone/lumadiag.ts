// Lumatone per-board calibration overlay (dev-only).
//
// Toggled via the "Calibrate Keys" checkbox in the Lumatone toolbar. Lazy:
// ensureLumaDiag() builds DOM on first call; setLumaDiagVisible toggles
// display. A Shift+\ hotkey is also wired — when pressed it invokes the
// registered hotkey callback so init.ts can keep the checkbox + pref in sync.
//
// Lets the user adjust per-board key thresholds and CC/aftertouch sensitivity
// live from HKL, bypassing the macro-button-driven calibration routine
// (CMD 0x24) — useful when those buttons are partly broken. There is no SysEx
// command for per-key threshold tuning; the firmware-internal "SET_KEY_*"
// commands (0x29–0x2C, 0x32) are board-scoped, so per-board is the ceiling
// without the macro buttons.
//
// CRITICAL: two of the SET commands pack two values per message:
//   • 0x29 sets (maxThreshold, aftertouchThreshold) together
//   • 0x2A sets (minHigh, minLow) together
// We MUST fetch the real device values via 0x3A / 0x3B before sending those
// commands, or moving one slider would clobber its companion with a placeholder
// and break note registration on that board. Sliders stay disabled until the
// device has responded.
//
// Sliders fire SysEx on `change` (release), not `input` (drag), to be gentle
// on the single-in-flight SysEx queue. All sends route through
// sysex.enqueueControl so they share the ACK/busy/retry path.

import { midi } from '../state/midi.js';
import { sysex } from './sysex.js';
import {
  sysexBoardMap,
  SYSEX_ACK,
  SYSEX_CMD_RESET_VELOCITY_CONFIG,
  SYSEX_CMD_RESET_AFTERTOUCH_CONFIG,
  SYSEX_CMD_SET_KEY_FADER_SENS,
  SYSEX_CMD_SET_KEY_AT_SENS,
  SYSEX_CMD_SET_CC_ACTIVE_THRESHOLD,
  SYSEX_CMD_RESET_LUMATOUCH_CONFIG,
  SYSEX_CMD_RESET_BOARD_THRESHOLDS,
  SYSEX_CMD_GET_BOARD_THRESHOLDS,
  SYSEX_CMD_GET_BOARD_SENSITIVITY,
  buildRequestSysEx,
  buildBoardRequestSysEx,
  buildSetMaxThreshold,
  buildSetMinThreshold,
  buildSetBoardSens,
  buildSetVelocityLut,
  buildSetVelocityIntervalConfig,
} from './protocol.js';
import { velocityCal, DEFAULT_CAL, DEFAULT_INTERVAL_CURVE, STATS_MIN_N, STATS_HIGH_CV } from '../audio/velocityCal.js';
import { baseKeys } from '../layout/baseKeys.js';

/* Build (q,r-string) → board_group lookup once. Used by the per-key stats
   scatter to color dots by board. */
const STATS_KEY_TO_BOARD: Map<string, number> = (() => {
  const m = new Map<string, number>();
  for (let i = 0; i < baseKeys.length; i++) {
    m.set(baseKeys[i][0] + ',' + baseKeys[i][1], Math.floor(i / 56));
  }
  return m;
})();

/* Per-board palette for the scatter. Five visually distinct hues. */
const STATS_BOARD_COLORS = ['#5af', '#9c5', '#fc5', '#f95', '#c5f'];

/* Per-board values, mirrored from the device. `null` = not yet fetched; the
   corresponding slider stays disabled until the read-back populates it. */
interface BoardState {
  minHigh: number | null;
  minLow: number | null;
  max: number | null;
  atThresh: number | null;
  ccThresh: number | null;
  ccSens: number | null;
  atSens: number | null;
}

type FieldKey = keyof BoardState;

/* Field metadata. Tooltip notes for each describe direction: per Terpstra
   firmware, threshold values are "abs. distance from MAX/MIN ADC" — larger =
   key triggers earlier in the press (more sensitive). */
const FIELDS: { key: FieldKey; label: string; tip: string }[] = [
  { key: 'max',      label: 'max',      tip: 'CMD 0x29 byte A — distance from MAX ADC; larger = key triggers earlier in press' },
  { key: 'atThresh', label: 'AT thr',   tip: 'CMD 0x29 byte B — aftertouch trigger distance from MAX ADC' },
  { key: 'minHigh',  label: 'min hi',   tip: 'CMD 0x2A byte A — distance from MIN ADC, upper hysteresis' },
  { key: 'minLow',   label: 'min lo',   tip: 'CMD 0x2A byte B — distance from MIN ADC, lower hysteresis' },
  { key: 'ccThresh', label: 'CC thr',   tip: 'CMD 0x32 — distance from MIN ADC for CC events' },
  { key: 'ccSens',   label: 'CC sens',  tip: 'CMD 0x2B — fader/CC output sensitivity' },
  { key: 'atSens',   label: 'AT sens',  tip: 'CMD 0x2C — aftertouch output sensitivity' },
];

let domBuilt = false;
let panel: HTMLDivElement | null = null;
let hotkeyCallback: (() => void) | null = null;
const boardStates: BoardState[] = [];
const valueLabels: Record<string, HTMLSpanElement> = {};
const sliders: Record<string, HTMLInputElement> = {};

function hex(v: number): string {
  return '0x' + v.toString(16).toUpperCase().padStart(2, '0');
}

/* Logical board (0..4) → SysEx board byte (1, 2, 3, 5, 4 — boards 3 & 4 are
   physically swapped on Max's unit). */
function sysexBoardFor(logical: number): number {
  return sysexBoardMap[logical];
}

function makeBlankState(): BoardState {
  return { minHigh: null, minLow: null, max: null, atThresh: null,
    ccThresh: null, ccSens: null, atSens: null };
}

function makeSliderRow(logical: number, field: FieldKey, labelText: string, tip: string): HTMLDivElement {
  const row = document.createElement('div');
  Object.assign(row.style, {
    display: 'grid',
    gridTemplateColumns: '60px 1fr 52px',
    alignItems: 'center',
    gap: '6px',
    margin: '2px 0',
  });
  const lbl = document.createElement('span');
  lbl.textContent = labelText;
  lbl.title = tip;
  Object.assign(lbl.style, { fontSize: '11px', color: 'rgba(255,255,255,0.75)' });
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '15';
  slider.step = '1';
  slider.value = '7';
  slider.disabled = true;  /* enabled by refreshSliders once value is loaded */
  Object.assign(slider.style, { width: '100%' });
  const val = document.createElement('span');
  val.textContent = '----';
  Object.assign(val.style, {
    fontSize: '11px', fontFamily: 'monospace', textAlign: 'right',
    color: 'rgba(255,255,255,0.6)',
  });
  const k = logical + '.' + field;
  valueLabels[k] = val;
  sliders[k] = slider;
  /* Live value label update on drag; SysEx only on release. */
  slider.addEventListener('input', () => {
    const v = parseInt(slider.value, 10);
    boardStates[logical][field] = v;
    val.textContent = hex(v);
  });
  slider.addEventListener('change', () => {
    sendBoardField(logical, field);
  });
  row.appendChild(lbl);
  row.appendChild(slider);
  row.appendChild(val);
  return row;
}

/* Compose and send the appropriate SysEx for a single field change. The packed
   commands (0x29 max+atThresh, 0x2A minHigh+minLow) refuse to send if either
   companion field is not yet loaded — sending with a placeholder would clobber
   the real device value. */
function sendBoardField(logical: number, field: FieldKey): void {
  const board = sysexBoardFor(logical);
  const s = boardStates[logical];
  let msg;
  if (field === 'max' || field === 'atThresh') {
    if (s.max == null || s.atThresh == null) {
      console.warn('[lumadiag] board ' + (logical + 1)
        + ': max/AT-thresh not loaded yet — click Get first');
      return;
    }
    msg = buildSetMaxThreshold(board, s.max, s.atThresh);
  } else if (field === 'minHigh' || field === 'minLow') {
    if (s.minHigh == null || s.minLow == null) {
      console.warn('[lumadiag] board ' + (logical + 1)
        + ': minHigh/minLow not loaded yet — click Get first');
      return;
    }
    msg = buildSetMinThreshold(board, s.minHigh, s.minLow);
  } else if (field === 'ccThresh') {
    if (s.ccThresh == null) return;
    msg = buildSetBoardSens(board, SYSEX_CMD_SET_CC_ACTIVE_THRESHOLD, s.ccThresh);
  } else if (field === 'ccSens') {
    if (s.ccSens == null) return;
    msg = buildSetBoardSens(board, SYSEX_CMD_SET_KEY_FADER_SENS, s.ccSens);
  } else {
    if (s.atSens == null) return;
    msg = buildSetBoardSens(board, SYSEX_CMD_SET_KEY_AT_SENS, s.atSens);
  }
  const ok = sysex.enqueueControl(msg);
  if (!ok) console.warn('[lumadiag] no Lumatone connected — change not sent');
  else console.log('[lumadiag] board ' + (logical + 1) + ' ' + field + ' → ' + hex(s[field]!));
}

/* Send a board-addressed RESET (0x34) for one logical board. After the reset
   ACKs, fetch the new values so the sliders reflect factory state. */
function resetBoard(logical: number): void {
  const board = sysexBoardFor(logical);
  console.log('[lumadiag] reset board ' + (logical + 1) + ' (SysEx board ' + board + ')');
  const msg = buildBoardRequestSysEx(board, SYSEX_CMD_RESET_BOARD_THRESHOLDS);
  msg.onResponse = () => { window.setTimeout(() => getBoardValues(logical), 50); };
  const ok = sysex.enqueueControl(msg);
  if (!ok) console.warn('[lumadiag] no Lumatone connected — reset not sent');
}

/* Parse a CMD 3Ah response (5 packed 8-bit values: 10 payload nibbles). */
function parse3AResponse(logical: number, data: Uint8Array): boolean {
  /* F0 00 21 50 <board> 3A <status> <10 nibble bytes> F7 = 18 bytes */
  if (data.length < 18) return false;
  if (data[6] !== SYSEX_ACK) return false;
  const off = 7;
  const u = (i: number): number => ((data[off + i * 2] & 0xF) << 4) | (data[off + i * 2 + 1] & 0xF);
  const s = boardStates[logical];
  s.minHigh = u(0);
  s.minLow = u(1);
  s.max = u(2);
  s.atThresh = u(3);
  s.ccThresh = u(4);
  return true;
}

/* Parse a CMD 3Bh response (2 packed 8-bit values: 4 payload nibbles). */
function parse3BResponse(logical: number, data: Uint8Array): boolean {
  /* F0 00 21 50 <board> 3B <status> <4 nibble bytes> F7 = 12 bytes */
  if (data.length < 12) return false;
  if (data[6] !== SYSEX_ACK) return false;
  const off = 7;
  const u = (i: number): number => ((data[off + i * 2] & 0xF) << 4) | (data[off + i * 2 + 1] & 0xF);
  const s = boardStates[logical];
  s.ccSens = u(0);
  s.atSens = u(1);
  return true;
}

function logRawResponse(label: string, data: Uint8Array): void {
  const hexBytes: string[] = [];
  for (let i = 0; i < data.length; i++) hexBytes.push(('0' + data[i].toString(16)).slice(-2));
  console.warn('[lumadiag] ' + label + ' raw=' + hexBytes.join(' '));
}

function getBoardValues(logical: number): void {
  const board = sysexBoardFor(logical);
  const tMsg = buildBoardRequestSysEx(board, SYSEX_CMD_GET_BOARD_THRESHOLDS);
  tMsg.onResponse = (data: Uint8Array) => {
    if (parse3AResponse(logical, data)) refreshSliders(logical);
    else logRawResponse('board ' + (logical + 1) + ' 0x3A parse failed', data);
  };
  const sMsg = buildBoardRequestSysEx(board, SYSEX_CMD_GET_BOARD_SENSITIVITY);
  sMsg.onResponse = (data: Uint8Array) => {
    if (parse3BResponse(logical, data)) refreshSliders(logical);
    else logRawResponse('board ' + (logical + 1) + ' 0x3B parse failed', data);
  };
  sysex.enqueueControl(tMsg);
  sysex.enqueueControl(sMsg);
}

/* Apply current boardStates[logical] values to the slider DOM. Programmatic
   .value writes do NOT fire 'input' or 'change' events, so no SysEx echo. */
function refreshSliders(logical: number): void {
  for (const f of FIELDS) {
    const k = logical + '.' + f.key;
    const slider = sliders[k]; const label = valueLabels[k];
    if (!slider || !label) continue;
    const v = boardStates[logical][f.key];
    if (v != null) {
      slider.value = String(v);
      slider.disabled = false;
      label.textContent = hex(v);
      label.style.color = 'rgba(255,255,255,0.9)';
    } else {
      slider.disabled = true;
      label.textContent = '----';
      label.style.color = 'rgba(255,255,255,0.6)';
    }
  }
}

function makeBoardSection(logical: number): HTMLDivElement {
  const sec = document.createElement('div');
  Object.assign(sec.style, {
    borderTop: '1px solid rgba(255,255,255,0.12)',
    padding: '6px 8px',
  });
  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: '4px',
  });
  const title = document.createElement('strong');
  title.textContent = 'Board ' + (logical + 1) + ' (SysEx ' + sysexBoardFor(logical) + ')';
  Object.assign(title.style, { fontSize: '12px', color: '#9cf' });
  const btns = document.createElement('div');
  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.title = 'CMD 0x34 — factory thresholds + sensitivity for this board';
  resetBtn.addEventListener('click', () => resetBoard(logical));
  const getBtn = document.createElement('button');
  getBtn.textContent = 'Get';
  getBtn.title = 'CMD 0x3A + 0x3B — fetch current values from device';
  getBtn.addEventListener('click', () => getBoardValues(logical));
  for (const b of [resetBtn, getBtn]) {
    Object.assign(b.style, {
      fontSize: '11px', padding: '1px 6px', marginLeft: '4px',
      background: 'rgba(255,255,255,0.08)', color: '#eee',
      border: '1px solid rgba(255,255,255,0.2)', borderRadius: '2px',
      cursor: 'pointer',
    });
    btns.appendChild(b);
  }
  header.appendChild(title);
  header.appendChild(btns);
  sec.appendChild(header);
  for (const f of FIELDS) sec.appendChild(makeSliderRow(logical, f.key, f.label, f.tip));
  return sec;
}

function makeGlobalFooter(): HTMLDivElement {
  const foot = document.createElement('div');
  Object.assign(foot.style, {
    borderTop: '1px solid rgba(255,255,255,0.2)',
    padding: '8px',
    display: 'flex', flexWrap: 'wrap', gap: '4px',
  });
  const mkBtn = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    Object.assign(b.style, {
      fontSize: '11px', padding: '2px 6px',
      background: 'rgba(255,255,255,0.08)', color: '#eee',
      border: '1px solid rgba(255,255,255,0.2)', borderRadius: '2px',
      cursor: 'pointer',
    });
    b.addEventListener('click', onClick);
    return b;
  };
  foot.appendChild(mkBtn('Reset velocity LUT', 'CMD 0x0A',
    () => sysex.enqueueControl(buildRequestSysEx(SYSEX_CMD_RESET_VELOCITY_CONFIG))));
  foot.appendChild(mkBtn('Reset AT LUT', 'CMD 0x12',
    () => sysex.enqueueControl(buildRequestSysEx(SYSEX_CMD_RESET_AFTERTOUCH_CONFIG))));
  foot.appendChild(mkBtn('Reset Lumatouch LUT', 'CMD 0x2F',
    () => sysex.enqueueControl(buildRequestSysEx(SYSEX_CMD_RESET_LUMATOUCH_CONFIG))));
  foot.appendChild(mkBtn('Reset all 5 boards', 'CMD 0x34 × 5',
    () => { for (let i = 0; i < 5; i++) resetBoard(i); }));
  foot.appendChild(mkBtn('Get all values', 'CMD 0x3A + 0x3B × 5',
    () => { for (let i = 0; i < 5; i++) getBoardValues(i); }));
  return foot;
}

/* Velocity calibration UI: hardware LUT push, HKL curve sliders, per-key gain
   auto-capture. Built once; element refs cached so external state changes can
   refresh the displayed values. */
const velCalUi: {
  floorSlider?: HTMLInputElement;
  floorVal?: HTMLSpanElement;
  ceilingSlider?: HTMLInputElement;
  ceilingVal?: HTMLSpanElement;
  gammaSlider?: HTMLInputElement;
  gammaVal?: HTMLSpanElement;
  preview?: HTMLCanvasElement;
  captureBtn?: HTMLButtonElement;
  captureStatus?: HTMLSpanElement;
  calKeyCount?: HTMLSpanElement;
  targetSlider?: HTMLInputElement;
  targetVal?: HTMLSpanElement;
  intLowSlider?: HTMLInputElement;
  intLowVal?: HTMLSpanElement;
  intHighSlider?: HTMLInputElement;
  intHighVal?: HTMLSpanElement;
  intGammaSlider?: HTMLInputElement;
  intGammaVal?: HTMLSpanElement;
  intervalPreview?: HTMLCanvasElement;
  observedCount?: HTMLSpanElement;
} = {};

let captureTicker: number | null = null;

function pushIdentityVelocityLut(): void {
  /* "Identity-from-1" LUT: lut[i] = max(1, i), slowest bin → vel 1, fastest →
     vel 127. We clamp at 1 instead of letting bin 127 emit vel 0, because a
     played note that emits MIDI velocity 0 is interpreted by every receiver
     as a note-off — not what the user wants from their softest press.
     buildSetVelocityLut reverses internally to match the firmware wire order. */
  const lut: number[] = new Array(128);
  for (let i = 0; i < 128; i++) lut[i] = i === 0 ? 1 : i;
  const msg = buildSetVelocityLut(lut);
  const ok = sysex.enqueueControl(msg);
  if (ok) console.log('[lumadiag] pushed identity velocity LUT to Lumatone (CMD 0x08, range 1..127)');
  else console.warn('[lumadiag] no Lumatone connected — identity LUT not sent');
}

function pushVelocityIntervalTable(): void {
  /* CMD 0x20: 127 × 12-bit press-time thresholds. Generated from the parametric
     low/high/gamma curve in velocityCal. */
  const table = velocityCal.buildIntervalTable();
  const msg = buildSetVelocityIntervalConfig(table);
  const ok = sysex.enqueueControl(msg);
  if (ok) console.log('[lumadiag] pushed velocity interval table to Lumatone (CMD 0x20): low='
    + velocityCal.intervalCurveLow + ' high=' + velocityCal.intervalCurveHigh
    + ' gamma=' + velocityCal.intervalCurveGamma.toFixed(2));
  else console.warn('[lumadiag] no Lumatone connected — interval table not sent');
}

function refreshObservedCounter(): void {
  if (velCalUi.observedCount) {
    velCalUi.observedCount.textContent = String(velocityCal.getObservedVelocityCount());
  }
}

/* Plot-area margins used by both curve preview canvases. Left margin holds
   y-axis tick labels (right-aligned + tick marks) plus a rotated axis name.
   Bottom margin holds x-axis tick labels + axis name. The canvas footprint
   matches the per-key scatter (PREVIEW_W) so all three graphs line up in the
   velocity panel. */
const PREVIEW_W = 290;
const PREVIEW_H = 120;
const PREVIEW_PAD_L = 28;
const PREVIEW_PAD_R = 6;
const PREVIEW_PAD_T = 6;
const PREVIEW_PAD_B = 22;

function drawCurvePreview(): void {
  const cv = velCalUi.preview;
  if (!cv) return;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const w = cv.width, h = cv.height;
  ctx.clearRect(0, 0, w, h);
  const px = PREVIEW_PAD_L, py = PREVIEW_PAD_T;
  const pw = w - PREVIEW_PAD_L - PREVIEW_PAD_R;
  const ph = h - PREVIEW_PAD_T - PREVIEW_PAD_B;
  /* Frame around plot area + identity diagonal reference. */
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(px + 0.5, py + 0.5, pw, ph);
  ctx.beginPath();
  ctx.moveTo(px, py + ph);
  ctx.lineTo(px + pw, py);
  ctx.stroke();
  /* Y-axis: audio gain 0..1. Three ticks, right-aligned in the left margin. */
  ctx.font = '9px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (const t of [0, 0.5, 1.0]) {
    const y = py + ph - t * ph;
    ctx.fillText(t.toFixed(1), px - 3, y);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath(); ctx.moveTo(px - 2, y); ctx.lineTo(px, y); ctx.stroke();
  }
  /* X-axis: velocity 0..127. */
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  for (const t of [0, 64, 127]) {
    const x = px + (t / 127) * pw;
    ctx.fillText(String(t), x, py + ph + 3);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath(); ctx.moveTo(x, py + ph); ctx.lineTo(x, py + ph + 2); ctx.stroke();
  }
  /* Axis names. */
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText('input velocity', px + pw / 2, py + ph + 12);
  ctx.save();
  ctx.translate(8, py + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('audio gain', 0, 0);
  ctx.restore();
  /* Curve. */
  ctx.strokeStyle = '#9cf';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let x = 0; x <= pw; x++) {
    const v = (x / pw) * 127;
    const g = velocityCal.curveGain(v);
    const y = py + ph - g * ph;
    if (x === 0) ctx.moveTo(px + x, y); else ctx.lineTo(px + x, y);
  }
  ctx.stroke();
}

function refreshCurveUi(): void {
  if (velCalUi.floorSlider) {
    velCalUi.floorSlider.value = String(Math.round(velocityCal.floor * 100));
    velCalUi.floorVal!.textContent = velocityCal.floor.toFixed(2);
  }
  if (velCalUi.ceilingSlider) {
    velCalUi.ceilingSlider.value = String(Math.round(velocityCal.ceiling * 100));
    velCalUi.ceilingVal!.textContent = velocityCal.ceiling.toFixed(2);
  }
  if (velCalUi.gammaSlider) {
    velCalUi.gammaSlider.value = String(Math.round(velocityCal.gamma * 100));
    velCalUi.gammaVal!.textContent = velocityCal.gamma.toFixed(2);
  }
  if (velCalUi.calKeyCount) {
    velCalUi.calKeyCount.textContent = String(velocityCal.calibratedKeyCount);
  }
  if (velCalUi.intLowSlider) {
    velCalUi.intLowSlider.value = String(velocityCal.intervalCurveLow);
    velCalUi.intLowVal!.textContent = String(velocityCal.intervalCurveLow);
  }
  if (velCalUi.intHighSlider) {
    velCalUi.intHighSlider.value = String(velocityCal.intervalCurveHigh);
    velCalUi.intHighVal!.textContent = String(velocityCal.intervalCurveHigh);
  }
  if (velCalUi.intGammaSlider) {
    velCalUi.intGammaSlider.value = String(Math.round(velocityCal.intervalCurveGamma * 100));
    velCalUi.intGammaVal!.textContent = velocityCal.intervalCurveGamma.toFixed(2);
  }
  drawCurvePreview();
  drawIntervalCurvePreview();
  refreshObservedCounter();
}

/* Terpstra factory default interval table (KeyboardDataStructure.cpp:49). Used
   for the faint reference trace on the interval curve preview canvas. */
const FACTORY_INTERVAL_TABLE: readonly number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
  41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 60, 61,
  62, 63, 64, 66, 67, 68, 70, 71, 72, 73, 74, 76, 77, 79, 81, 82, 84, 86, 88, 90,
  92, 94, 96, 98, 101, 104, 107, 111, 115, 119, 124, 129, 134, 140, 146, 152, 159, 170, 171, 175,
  180, 185, 190, 195, 200, 205, 210, 215, 220, 225, 230, 235, 240, 245, 250, 255, 260, 265, 270, 275,
  280, 285, 290, 295, 300, 305, 310,
];

function drawIntervalCurvePreview(): void {
  const cv = velCalUi.intervalPreview;
  if (!cv) return;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const w = cv.width, h = cv.height;
  ctx.clearRect(0, 0, w, h);
  const px = PREVIEW_PAD_L, py = PREVIEW_PAD_T;
  const pw = w - PREVIEW_PAD_L - PREVIEW_PAD_R;
  const ph = h - PREVIEW_PAD_T - PREVIEW_PAD_B;
  /* Y-scale covers both user curve and factory reference so neither clips. */
  const yMax = Math.max(velocityCal.intervalCurveHigh, 310);
  const yMin = 0;
  /* Frame. */
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(px + 0.5, py + 0.5, pw, ph);
  /* Y-axis ticks. Round to a nice number for the midpoint readout. */
  ctx.font = '9px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  const yTicks = [yMin, Math.round(yMax / 2), yMax];
  for (const t of yTicks) {
    const y = py + ph - ((t - yMin) / (yMax - yMin)) * ph;
    ctx.fillText(String(t), px - 3, y);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath(); ctx.moveTo(px - 2, y); ctx.lineTo(px, y); ctx.stroke();
  }
  /* X-axis ticks: bin index 126..0 (reversed so the right edge corresponds to
     louder output, matching the audio curve's left-to-right velocity axis). */
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  for (const t of [126, 63, 0]) {
    const x = px + ((126 - t) / 126) * pw;
    ctx.fillText(String(t), x, py + ph + 3);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath(); ctx.moveTo(x, py + ph); ctx.lineTo(x, py + ph + 2); ctx.stroke();
  }
  /* Axis names. */
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText('bin index (slow/soft → fast/loud)', px + pw / 2, py + ph + 12);
  ctx.save();
  ctx.translate(8, py + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('press-time ticks', 0, 0);
  ctx.restore();
  /* Factory trace (dim). X-axis reversed: bin i plots at the (126-i) screen
     position so bin 0 (fast/loud) lands on the right. */
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < 127; i++) {
    const x = px + ((126 - i) / 126) * pw;
    const y = py + ph - ((FACTORY_INTERVAL_TABLE[i] - yMin) / (yMax - yMin)) * ph;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  /* User curve (bright). */
  const table = velocityCal.buildIntervalTable();
  ctx.strokeStyle = '#fd9';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < 127; i++) {
    const x = px + ((126 - i) / 126) * pw;
    const y = py + ph - ((table[i] - yMin) / (yMax - yMin)) * ph;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  /* Legend in the top-RIGHT of the plot area — with the reversed X, the curve
     runs top-left (slow/soft, large ticks) to bottom-right (fast/loud, small
     ticks), so top-right is the empty quadrant. */
  ctx.font = '9px sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const lx = px + pw - 60, ly = py + 4;
  ctx.strokeStyle = '#fd9'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(lx, ly + 4); ctx.lineTo(lx + 10, ly + 4); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText('your curve', lx + 13, ly);
  ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(lx, ly + 14); ctx.lineTo(lx + 10, ly + 14); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillText('factory', lx + 13, ly + 10);
}

function startCaptureTicker(): void {
  if (captureTicker !== null) return;
  captureTicker = window.setInterval(() => {
    if (velCalUi.captureStatus) {
      velCalUi.captureStatus.textContent = velocityCal.capturedKeyCount
        + ' / 280 keys recorded';
    }
  }, 250);
}

function stopCaptureTicker(): void {
  if (captureTicker !== null) { clearInterval(captureTicker); captureTicker = null; }
}

function makeVelocityCalSection(): HTMLDivElement {
  const sec = document.createElement('div');
  Object.assign(sec.style, {
    borderTop: '2px solid rgba(255,255,255,0.25)',
    padding: '8px',
    background: 'rgba(80,160,255,0.04)',
  });
  const title = document.createElement('strong');
  title.textContent = 'Velocity calibration';
  Object.assign(title.style, { fontSize: '12px', color: '#9cf', display: 'block', marginBottom: '6px' });
  sec.appendChild(title);

  /* ── Hardware foundation ── */
  const hwBlock = document.createElement('div');
  Object.assign(hwBlock.style, { marginBottom: '8px' });
  const hwLabel = document.createElement('div');
  hwLabel.textContent = 'Hardware foundation';
  Object.assign(hwLabel.style, { fontSize: '11px', color: 'rgba(255,255,255,0.6)', marginBottom: '2px' });
  const hwHint = document.createElement('div');
  hwHint.textContent = 'Push identity LUT so the firmware emits its full 0–127 range — gives HKL the maximum input resolution to shape from.';
  Object.assign(hwHint.style, { fontSize: '10px', color: 'rgba(255,255,255,0.5)', marginBottom: '4px', lineHeight: '1.3' });
  const hwBtn = document.createElement('button');
  hwBtn.textContent = 'Push identity LUT to Lumatone (CMD 0x08)';
  Object.assign(hwBtn.style, {
    fontSize: '11px', padding: '2px 6px',
    background: 'rgba(255,255,255,0.08)', color: '#eee',
    border: '1px solid rgba(255,255,255,0.2)', borderRadius: '2px',
    cursor: 'pointer', width: '100%',
  });
  hwBtn.addEventListener('click', pushIdentityVelocityLut);
  hwBlock.appendChild(hwLabel);
  hwBlock.appendChild(hwHint);
  hwBlock.appendChild(hwBtn);

  sec.appendChild(hwBlock);

  /* Unique-velocity counter + reset. The expected count under identity 0x08
     plus an integer-range CMD 0x20 curve is ~(high − low + 2): one velocity
     per integer threshold, plus the two open-ended boundary bins. */
  const counterRow = document.createElement('div');
  Object.assign(counterRow.style, {
    display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px',
    fontSize: '11px', color: 'rgba(255,255,255,0.7)',
    marginBottom: '8px', marginTop: '4px', alignItems: 'center',
  });
  const observedCell = document.createElement('span');
  observedCell.title = 'Distinct MIDI velocities emitted since last reset. Should converge to ~(high − low + 2) as you play across the full dynamic range.';
  const observedVal = document.createElement('span');
  Object.assign(observedVal.style, { fontFamily: 'monospace', color: '#fd9' });
  observedCell.appendChild(document.createTextNode('Distinct velocities observed: '));
  observedCell.appendChild(observedVal);
  velCalUi.observedCount = observedVal;
  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.title = 'Clear observed-velocity counter.';
  Object.assign(resetBtn.style, {
    fontSize: '11px', padding: '1px 8px',
    background: 'rgba(255,255,255,0.08)', color: '#eee',
    border: '1px solid rgba(255,255,255,0.2)', borderRadius: '2px',
    cursor: 'pointer',
  });
  resetBtn.addEventListener('click', () => {
    velocityCal.clearObservedVelocities();
    refreshObservedCounter();
  });
  counterRow.appendChild(observedCell);
  counterRow.appendChild(resetBtn);
  sec.appendChild(counterRow);

  const hwResetHint = document.createElement('div');
  hwResetHint.textContent = '(Use "Reset velocity LUT" below to revert to factory firmware curve.)';
  Object.assign(hwResetHint.style, { fontSize: '10px', color: 'rgba(255,255,255,0.4)', marginTop: '2px', marginBottom: '8px', lineHeight: '1.2' });
  sec.appendChild(hwResetHint);

  /* ── Hardware velocity intervals (CMD 0x20) ──
     Designs the 127-threshold press-time → bin table and pushes it to the
     firmware. This is the real bin-distribution lever (CMD 0x08 stays at
     identity; that's the output relabeling). Phase A's HKL-side input curve
     is now a defensive identity layer with no UI — the firmware does the
     shaping. */
  const intLabel = document.createElement('div');
  intLabel.textContent = 'Hardware velocity intervals (CMD 0x20)';
  Object.assign(intLabel.style, { fontSize: '11px', color: 'rgba(255,255,255,0.6)', marginBottom: '2px' });
  sec.appendChild(intLabel);
  const intHint = document.createElement('div');
  intHint.textContent = 'Shapes press-time → velocity bin thresholds INSIDE the firmware. Tightening into your keyboard’s actual press-time range gives more distinct velocities. Faint trace = factory default. Push to apply.';
  Object.assign(intHint.style, { fontSize: '10px', color: 'rgba(255,255,255,0.5)', marginBottom: '4px', lineHeight: '1.3' });
  sec.appendChild(intHint);

  const intPreviewWrap = document.createElement('div');
  Object.assign(intPreviewWrap.style, { display: 'flex', justifyContent: 'center', marginBottom: '6px' });
  const intPreview = document.createElement('canvas');
  intPreview.width = PREVIEW_W; intPreview.height = PREVIEW_H;
  Object.assign(intPreview.style, { background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.15)' });
  intPreviewWrap.appendChild(intPreview);
  sec.appendChild(intPreviewWrap);
  velCalUi.intervalPreview = intPreview;

  const mkIntSlider = (
    label: string, tip: string, min: number, max: number, step: number,
    valueOf: () => number, setter: (v: number) => void, format: (v: number) => string,
  ): { row: HTMLDivElement; slider: HTMLInputElement; val: HTMLSpanElement } => {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'grid', gridTemplateColumns: '50px 1fr 44px',
      alignItems: 'center', gap: '6px', margin: '2px 0',
    });
    const lbl = document.createElement('span');
    lbl.textContent = label;
    lbl.title = tip;
    Object.assign(lbl.style, { fontSize: '11px', color: 'rgba(255,255,255,0.75)' });
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(min); slider.max = String(max); slider.step = String(step);
    slider.value = String(valueOf());
    Object.assign(slider.style, { width: '100%' });
    const val = document.createElement('span');
    val.textContent = format(valueOf());
    Object.assign(val.style, {
      fontSize: '11px', fontFamily: 'monospace', textAlign: 'right',
      color: 'rgba(255,255,255,0.9)',
    });
    slider.addEventListener('input', () => {
      const raw = parseFloat(slider.value);
      setter(raw);
      val.textContent = format(raw);
      drawIntervalCurvePreview();
    });
    row.appendChild(lbl);
    row.appendChild(slider);
    row.appendChild(val);
    return { row, slider, val };
  };

  /* Interval curve sliders. Tick counts are 12-bit integers (0..4095) but in
     practice the usable range is 0..~500 for fast keyboards, up to ~2000 for
     very slow. gamma is × 100 to give 0.5..5.0 resolution on the slider. */
  const intLowUi = mkIntSlider(
    'low', 'Fastest-press threshold (tick count for highest velocity bin). Tighten toward your keyboard’s minimum press-time.',
    0, 100, 1,
    () => velocityCal.intervalCurveLow,
    (v: number) => velocityCal.setIntervalCurveLow(v),
    (v: number) => String(Math.round(v)),
  );
  const intHighUi = mkIntSlider(
    'high', 'Slowest-press threshold (tick count for lowest velocity bin). Tighten toward your keyboard’s maximum press-time.',
    0, 200, 1,
    () => velocityCal.intervalCurveHigh,
    (v: number) => velocityCal.setIntervalCurveHigh(v),
    (v: number) => String(Math.round(v)),
  );
  const intGammaUi = mkIntSlider(
    'gamma', 'Distribution exponent (×100). >1 concentrates bins at fast presses; <1 at slow. Factory ≈ 2.1.',
    50, 500, 5,
    () => velocityCal.intervalCurveGamma * 100,
    (v: number) => velocityCal.setIntervalCurveGamma(v / 100),
    (v: number) => (v / 100).toFixed(2),
  );
  velCalUi.intLowSlider = intLowUi.slider; velCalUi.intLowVal = intLowUi.val;
  velCalUi.intHighSlider = intHighUi.slider; velCalUi.intHighVal = intHighUi.val;
  velCalUi.intGammaSlider = intGammaUi.slider; velCalUi.intGammaVal = intGammaUi.val;
  sec.appendChild(intLowUi.row);
  sec.appendChild(intHighUi.row);
  sec.appendChild(intGammaUi.row);

  const intBtnRow = document.createElement('div');
  Object.assign(intBtnRow.style, { display: 'flex', gap: '4px', marginTop: '4px', marginBottom: '8px' });
  const intPushBtn = document.createElement('button');
  intPushBtn.textContent = 'Push to Lumatone (CMD 0x20)';
  Object.assign(intPushBtn.style, {
    fontSize: '11px', padding: '2px 6px',
    background: 'rgba(255,255,255,0.08)', color: '#eee',
    border: '1px solid rgba(255,255,255,0.2)', borderRadius: '2px',
    cursor: 'pointer', flex: '1 1 auto',
  });
  intPushBtn.addEventListener('click', pushVelocityIntervalTable);
  const intResetBtn = document.createElement('button');
  intResetBtn.textContent = 'Reset (factory ' + DEFAULT_INTERVAL_CURVE.low + '/'
    + DEFAULT_INTERVAL_CURVE.high + '/' + DEFAULT_INTERVAL_CURVE.gamma.toFixed(1) + ')';
  Object.assign(intResetBtn.style, {
    fontSize: '11px', padding: '2px 6px',
    background: 'rgba(255,255,255,0.08)', color: '#eee',
    border: '1px solid rgba(255,255,255,0.2)', borderRadius: '2px',
    cursor: 'pointer',
  });
  intResetBtn.addEventListener('click', () => {
    velocityCal.resetIntervalCurve();
    refreshCurveUi();
  });
  intBtnRow.appendChild(intPushBtn);
  intBtnRow.appendChild(intResetBtn);
  sec.appendChild(intBtnRow);

  /* ── HKL curve ── */
  const curveLabel = document.createElement('div');
  curveLabel.textContent = 'HKL curve';
  Object.assign(curveLabel.style, { fontSize: '11px', color: 'rgba(255,255,255,0.6)', marginBottom: '4px' });
  sec.appendChild(curveLabel);

  const previewWrap = document.createElement('div');
  Object.assign(previewWrap.style, { display: 'flex', justifyContent: 'center', marginBottom: '6px' });
  const preview = document.createElement('canvas');
  preview.width = PREVIEW_W; preview.height = PREVIEW_H;
  Object.assign(preview.style, { background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.15)' });
  previewWrap.appendChild(preview);
  sec.appendChild(previewWrap);
  velCalUi.preview = preview;

  const mkCurveSlider = (
    label: string, tip: string, min: number, max: number, step: number,
    valueOf: () => number, setter: (v: number) => void, format: (v: number) => string,
  ): { row: HTMLDivElement; slider: HTMLInputElement; val: HTMLSpanElement } => {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'grid', gridTemplateColumns: '50px 1fr 44px',
      alignItems: 'center', gap: '6px', margin: '2px 0',
    });
    const lbl = document.createElement('span');
    lbl.textContent = label;
    lbl.title = tip;
    Object.assign(lbl.style, { fontSize: '11px', color: 'rgba(255,255,255,0.75)' });
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(min); slider.max = String(max); slider.step = String(step);
    slider.value = String(valueOf());
    Object.assign(slider.style, { width: '100%' });
    const val = document.createElement('span');
    val.textContent = format(valueOf());
    Object.assign(val.style, {
      fontSize: '11px', fontFamily: 'monospace', textAlign: 'right',
      color: 'rgba(255,255,255,0.9)',
    });
    slider.addEventListener('input', () => {
      setter(parseFloat(slider.value));
      val.textContent = format(parseFloat(slider.value));
      drawCurvePreview();
    });
    row.appendChild(lbl);
    row.appendChild(slider);
    row.appendChild(val);
    return { row, slider, val };
  };
  /* Sliders work in integer hundredths (0..100, 0..300, etc.) so HTML range
     resolution is fine. Setters convert back to fractional. */
  const floorUi = mkCurveSlider(
    'floor', 'Audio gain at velocity 1 (× 100)',
    0, 30, 1,
    () => velocityCal.floor * 100,
    (v: number) => velocityCal.setFloor(v / 100),
    (v: number) => (v / 100).toFixed(2),
  );
  const ceilingUi = mkCurveSlider(
    'ceiling', 'Audio gain at velocity 127 (× 100)',
    60, 127, 1,
    () => velocityCal.ceiling * 100,
    (v: number) => velocityCal.setCeiling(v / 100),
    (v: number) => (v / 100).toFixed(2),
  );
  const gammaUi = mkCurveSlider(
    'gamma', 'Curve exponent (× 100). >1 = soft notes get quieter (piano-like). High values (10+) only make sense when CMD 0x20 high is set near 130, giving 1:1 tick→velocity mapping; with the default high=50, γ above ~3 over-compresses.',
    50, 2000, 5,
    () => velocityCal.gamma * 100,
    (v: number) => velocityCal.setGamma(v / 100),
    (v: number) => (v / 100).toFixed(2),
  );
  velCalUi.floorSlider = floorUi.slider; velCalUi.floorVal = floorUi.val;
  velCalUi.ceilingSlider = ceilingUi.slider; velCalUi.ceilingVal = ceilingUi.val;
  velCalUi.gammaSlider = gammaUi.slider; velCalUi.gammaVal = gammaUi.val;
  sec.appendChild(floorUi.row);
  sec.appendChild(ceilingUi.row);
  sec.appendChild(gammaUi.row);

  const curveResetBtn = document.createElement('button');
  curveResetBtn.textContent = 'Reset curve (' + DEFAULT_CAL.floor.toFixed(2) + ' / '
    + DEFAULT_CAL.gamma.toFixed(2) + ' / ' + DEFAULT_CAL.ceiling.toFixed(2) + ')';
  Object.assign(curveResetBtn.style, {
    fontSize: '11px', padding: '1px 6px', marginTop: '4px',
    background: 'rgba(255,255,255,0.08)', color: '#eee',
    border: '1px solid rgba(255,255,255,0.2)', borderRadius: '2px',
    cursor: 'pointer',
  });
  curveResetBtn.addEventListener('click', () => {
    velocityCal.resetCurve();
    refreshCurveUi();
  });
  sec.appendChild(curveResetBtn);

  /* ── Per-key auto-capture ── */
  const capLabel = document.createElement('div');
  capLabel.textContent = 'Per-key auto-capture';
  Object.assign(capLabel.style, { fontSize: '11px', color: 'rgba(255,255,255,0.6)', marginTop: '10px', marginBottom: '4px' });
  sec.appendChild(capLabel);

  const capHint = document.createElement('div');
  capHint.textContent = 'Start, press every problem key at the loudness you intend "pp" to be, stop. HKL computes per-key gain so they all land at the target velocity. Push identity LUT first for best results.';
  Object.assign(capHint.style, { fontSize: '10px', color: 'rgba(255,255,255,0.5)', marginBottom: '6px', lineHeight: '1.3' });
  sec.appendChild(capHint);

  const targetUi = mkCurveSlider(
    'target', 'Desired output velocity for a "pp" press during capture',
    5, 50, 1,
    () => 25,
    () => {}, /* setter no-op; value read on stop */
    (v: number) => String(Math.round(v)),
  );
  velCalUi.targetSlider = targetUi.slider;
  velCalUi.targetVal = targetUi.val;
  /* Override the input handler: target is read-on-demand, no curve preview update. */
  targetUi.slider.oninput = () => { targetUi.val.textContent = targetUi.slider.value; };
  sec.appendChild(targetUi.row);

  const capRow = document.createElement('div');
  Object.assign(capRow.style, { display: 'flex', gap: '4px', alignItems: 'center', marginTop: '4px' });
  const captureBtn = document.createElement('button');
  captureBtn.textContent = 'Start capture';
  Object.assign(captureBtn.style, {
    fontSize: '11px', padding: '2px 6px',
    background: 'rgba(255,255,255,0.08)', color: '#eee',
    border: '1px solid rgba(255,255,255,0.2)', borderRadius: '2px',
    cursor: 'pointer',
  });
  const status = document.createElement('span');
  status.textContent = '0 / 280 keys recorded';
  Object.assign(status.style, { fontSize: '11px', color: 'rgba(255,255,255,0.6)' });
  captureBtn.addEventListener('click', () => {
    if (!velocityCal.capturing) {
      velocityCal.startCapture();
      captureBtn.textContent = 'Stop & compute';
      captureBtn.style.background = 'rgba(255,140,0,0.25)';
      status.textContent = '0 / 280 keys recorded';
      startCaptureTicker();
    } else {
      const target = parseFloat(velCalUi.targetSlider!.value);
      const n = velocityCal.stopCaptureAndCompute(target);
      stopCaptureTicker();
      captureBtn.textContent = 'Start capture';
      captureBtn.style.background = 'rgba(255,255,255,0.08)';
      status.textContent = n + ' key' + (n === 1 ? '' : 's') + ' calibrated (target ' + target + ')';
      refreshCurveUi();
    }
  });
  velCalUi.captureBtn = captureBtn;
  velCalUi.captureStatus = status;
  capRow.appendChild(captureBtn);
  capRow.appendChild(status);
  sec.appendChild(capRow);

  const totalRow = document.createElement('div');
  Object.assign(totalRow.style, {
    display: 'flex', gap: '8px', alignItems: 'center',
    marginTop: '6px', fontSize: '11px', color: 'rgba(255,255,255,0.7)',
  });
  const totalLabel = document.createElement('span');
  totalLabel.textContent = 'Currently calibrated keys: ';
  const totalVal = document.createElement('span');
  totalVal.textContent = String(velocityCal.calibratedKeyCount);
  Object.assign(totalVal.style, { fontFamily: 'monospace', color: '#9cf' });
  velCalUi.calKeyCount = totalVal;
  const clearBtn = document.createElement('button');
  clearBtn.textContent = 'Clear all per-key';
  Object.assign(clearBtn.style, {
    fontSize: '11px', padding: '1px 6px', marginLeft: 'auto',
    background: 'rgba(255,255,255,0.08)', color: '#eee',
    border: '1px solid rgba(255,255,255,0.2)', borderRadius: '2px',
    cursor: 'pointer',
  });
  clearBtn.addEventListener('click', () => {
    velocityCal.clearPerKey();
    refreshCurveUi();
  });
  totalRow.appendChild(totalLabel);
  totalRow.appendChild(totalVal);
  totalRow.appendChild(clearBtn);
  sec.appendChild(totalRow);

  drawCurvePreview();
  drawIntervalCurvePreview();
  return sec;
}

/* ── Per-key velocity statistics section ──────────────────────────────────
   Always-on rolling sample collection (when enabled), scatter visualization
   of (mean, CV) per key, top-N outlier lists (high-CV → noisy; mean-drift →
   per-key gain candidates), and a sticky per-key inspector with histogram
   sparkline. Refreshed 1Hz while panel exists. */

interface StatsUi {
  enableCheckbox: HTMLInputElement;
  status: HTMLSpanElement;
  scatter: HTMLCanvasElement;
  inspector: HTMLDivElement;
  highCvList: HTMLDivElement;
  meanDriftList: HTMLDivElement;
}

let statsUi: StatsUi | null = null;
let statsInspectorKey: string | null = null;
let statsTickerId: number | null = null;

const STATS_SCATTER_W = 290;
const STATS_SCATTER_H = 180;
const STATS_SCATTER_PAD = 12;

/* Scatter axes: x = p5 (low-end floor), y = p95 (high-end ceiling).
   Both 0..127. Ideal key sits TOP-LEFT (low floor, high ceiling — full range).
   Cluster A (saturated high) ends up top-right. Cluster B (stuck middle)
   clusters near the diagonal in the center. */
function scatterXY(p5: number, p95: number): [number, number] {
  const p5c = Math.min(127, Math.max(0, p5));
  const p95c = Math.min(127, Math.max(0, p95));
  const x = STATS_SCATTER_PAD + (p5c / 127) * (STATS_SCATTER_W - 2 * STATS_SCATTER_PAD);
  const y = (STATS_SCATTER_H - STATS_SCATTER_PAD) - (p95c / 127) * (STATS_SCATTER_H - 2 * STATS_SCATTER_PAD);
  return [x, y];
}

function findKeyAtScatterPos(mx: number, my: number): string | null {
  let bestKey: string | null = null;
  let bestDist = 36;  // squared 6px
  for (const { key, stats } of velocityCal.getAllStats()) {
    if (stats.n < STATS_MIN_N) continue;
    const [x, y] = scatterXY(stats.p5, stats.p95);
    const dx = x - mx, dy = y - my;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist) { bestDist = d2; bestKey = key; }
  }
  return bestKey;
}

const STATS_LOW_FLOOR = 30;   // p5 above this = "can't play quiet"
const STATS_HIGH_CEIL = 100;  // p95 below this = "can't play loud"
const STATS_MIN_RANGE = 60;   // (p95 - p5) below this = "narrow range"

function drawScatter(): void {
  if (!statsUi) return;
  const cv = statsUi.scatter;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, STATS_SCATTER_W, STATS_SCATTER_H);

  /* The y = x diagonal is the impossibility boundary (p95 must exceed p5).
     Dim it so the eye knows valid space is above-left. */
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const [diag0x, diag0y] = scatterXY(0, 0);
  const [diag1x, diag1y] = scatterXY(127, 127);
  ctx.moveTo(diag0x, diag0y);
  ctx.lineTo(diag1x, diag1y);
  ctx.stroke();

  /* Threshold lines: vertical at p5=STATS_LOW_FLOOR, horizontal at
     p95=STATS_HIGH_CEIL. The TARGET ZONE is the upper-left rectangle
     bounded by these (low floor + high ceiling). */
  ctx.strokeStyle = 'rgba(255,120,80,0.30)';
  const [floorX] = scatterXY(STATS_LOW_FLOOR, 0);
  ctx.beginPath();
  ctx.moveTo(floorX, STATS_SCATTER_PAD);
  ctx.lineTo(floorX, STATS_SCATTER_H - STATS_SCATTER_PAD);
  ctx.stroke();
  const [, ceilY] = scatterXY(0, STATS_HIGH_CEIL);
  ctx.beginPath();
  ctx.moveTo(STATS_SCATTER_PAD, ceilY);
  ctx.lineTo(STATS_SCATTER_W - STATS_SCATTER_PAD, ceilY);
  ctx.stroke();

  /* Soft tint on the ideal-zone rectangle (above ceilY, left of floorX). */
  ctx.fillStyle = 'rgba(120,255,120,0.04)';
  ctx.fillRect(STATS_SCATTER_PAD, STATS_SCATTER_PAD,
    floorX - STATS_SCATTER_PAD, ceilY - STATS_SCATTER_PAD);

  /* Axis tick labels. */
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '9px sans-serif';
  for (const v of [0, 32, 64, 96, 127]) {
    const [tx] = scatterXY(v, 0);
    ctx.fillText(String(v), tx - 6, STATS_SCATTER_H - 1);
    const [, ty] = scatterXY(0, v);
    ctx.fillText(String(v), 0, ty + 3);
  }

  /* Per-key dots. Selected (inspector) key drawn last with a white outline. */
  let selectedDot: { x: number; y: number; color: string } | null = null;
  for (const { key, stats } of velocityCal.getAllStats()) {
    if (stats.n < STATS_MIN_N) continue;
    const [x, y] = scatterXY(stats.p5, stats.p95);
    const board = STATS_KEY_TO_BOARD.get(key) ?? 0;
    const color = STATS_BOARD_COLORS[board];
    if (key === statsInspectorKey) {
      selectedDot = { x, y, color };
      continue;
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  if (selectedDot) {
    ctx.fillStyle = selectedDot.color;
    ctx.beginPath();
    ctx.arc(selectedDot.x, selectedDot.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function refreshInspector(): void {
  if (!statsUi) return;
  const inspector = statsUi.inspector;
  inspector.innerHTML = '';
  if (!statsInspectorKey) {
    inspector.textContent = velocityCal.statsEnabled
      ? 'Hover a dot to inspect.'
      : '(stats off)';
    return;
  }
  const stats = velocityCal.getKeyStats(statsInspectorKey);
  if (!stats) {
    inspector.textContent = statsInspectorKey + ': no data';
    return;
  }
  const board = (STATS_KEY_TO_BOARD.get(statsInspectorKey) ?? 0) + 1;
  const range = stats.p95 - stats.p5;
  /* Two lines: primary range info, then variance/cv as a secondary indicator. */
  const line1 = document.createElement('div');
  line1.textContent = '(' + statsInspectorKey + ')  brd ' + board
    + '  n=' + stats.n
    + '  p5=' + stats.p5.toFixed(0)
    + '  p95=' + stats.p95.toFixed(0)
    + '  range=' + range.toFixed(0);
  inspector.appendChild(line1);
  const cvStr = stats.cv < 0 ? '—' : stats.cv.toFixed(2);
  const line2 = document.createElement('div');
  line2.textContent = '  μ=' + stats.mean.toFixed(1)
    + '  σ=' + stats.stddev.toFixed(1)
    + '  CV=' + cvStr;
  Object.assign(line2.style, { color: 'rgba(255,255,255,0.55)', fontSize: '10px' });
  inspector.appendChild(line2);

  /* Histogram sparkline (live samples only), with p5/p95 markers overlaid. */
  const hist = velocityCal.getKeyHistogram(statsInspectorKey, 32);
  const sparkW = 270, sparkH = 26;
  const spark = document.createElement('canvas');
  spark.width = sparkW; spark.height = sparkH;
  Object.assign(spark.style, {
    display: 'block', marginTop: '4px',
    background: 'rgba(0,0,0,0.3)',
  });
  const sctx = spark.getContext('2d');
  if (sctx) {
    let maxCount = 1;
    for (let i = 0; i < hist.length; i++) if (hist[i] > maxCount) maxCount = hist[i];
    const barW = sparkW / hist.length;
    sctx.fillStyle = '#9fc';
    for (let i = 0; i < hist.length; i++) {
      const bh = (hist[i] / maxCount) * (sparkH - 4);
      sctx.fillRect(i * barW, sparkH - bh, barW - 1, bh);
    }
    /* p5 / p95 vertical markers. Map velocity 0..127 to sparkline x. */
    sctx.strokeStyle = 'rgba(255,200,80,0.85)';
    sctx.lineWidth = 1;
    for (const v of [stats.p5, stats.p95]) {
      const x = (v / 127) * sparkW;
      sctx.beginPath();
      sctx.moveTo(x, 0); sctx.lineTo(x, sparkH);
      sctx.stroke();
    }
  }
  inspector.appendChild(spark);
}

function drawOutlierLists(): void {
  if (!statsUi) return;
  const all = velocityCal.getAllStats();
  const valid = all.filter(({ stats }) => stats.n >= STATS_MIN_N);

  /* Reuse two existing container divs for three action-oriented lists:
     can't-play-quiet + narrow-range packed into the first slot, can't-play-loud
     into the second. (Keeps the existing DOM shape; cheaper than reflowing.) */
  const mkRow = (
    key: string,
    color: string,
    text: string,
  ): HTMLDivElement => {
    const row = document.createElement('div');
    row.textContent = text;
    Object.assign(row.style, {
      fontSize: '10px', fontFamily: 'monospace',
      color, cursor: 'pointer',
    });
    row.addEventListener('click', () => {
      statsInspectorKey = key;
      refreshInspector();
      drawScatter();
    });
    return row;
  };

  const mkHeader = (text: string, topGap: boolean): HTMLDivElement => {
    const h = document.createElement('div');
    h.textContent = text;
    Object.assign(h.style, {
      fontSize: '11px',
      color: 'rgba(255,255,255,0.65)',
      marginTop: topGap ? '6px' : '0',
      marginBottom: '2px',
    });
    return h;
  };

  const mkEmpty = (text: string): HTMLDivElement => {
    const e = document.createElement('div');
    e.textContent = text;
    Object.assign(e.style, { fontSize: '10px', color: 'rgba(255,255,255,0.4)' });
    return e;
  };

  /* List 1 container: "Can't play quiet" + "Narrow range" stacked. */
  statsUi.highCvList.innerHTML = '';

  statsUi.highCvList.appendChild(mkHeader("Can't play quiet (p5 high → raise MAX):", false));
  const byFloor = valid.slice().sort((a, b) => b.stats.p5 - a.stats.p5);
  const floorHits = byFloor.filter(({ stats }) => stats.p5 > STATS_LOW_FLOOR).slice(0, 5);
  if (floorHits.length === 0) {
    statsUi.highCvList.appendChild(mkEmpty('  (none)'));
  } else {
    for (const { key, stats } of floorHits) {
      const board = (STATS_KEY_TO_BOARD.get(key) ?? 0) + 1;
      const flagged = stats.p5 >= 50;
      statsUi.highCvList.appendChild(mkRow(key,
        flagged ? '#f95' : 'rgba(255,255,255,0.7)',
        '  (' + key + ')  brd ' + board
        + '  p5=' + stats.p5.toFixed(0)
        + '  p95=' + stats.p95.toFixed(0)
        + '  n=' + stats.n));
    }
  }

  statsUi.highCvList.appendChild(mkHeader('Narrow range (range < ' + STATS_MIN_RANGE
    + ' → raise MAX, accept hardware ceiling):', true));
  const byRange = valid.slice().sort((a, b) => (a.stats.p95 - a.stats.p5) - (b.stats.p95 - b.stats.p5));
  const rangeHits = byRange.filter(({ stats }) => (stats.p95 - stats.p5) < STATS_MIN_RANGE).slice(0, 5);
  if (rangeHits.length === 0) {
    statsUi.highCvList.appendChild(mkEmpty('  (none)'));
  } else {
    for (const { key, stats } of rangeHits) {
      const board = (STATS_KEY_TO_BOARD.get(key) ?? 0) + 1;
      const r = stats.p95 - stats.p5;
      const flagged = r < 40;
      statsUi.highCvList.appendChild(mkRow(key,
        flagged ? '#f95' : 'rgba(255,255,255,0.7)',
        '  (' + key + ')  brd ' + board
        + '  range=' + r.toFixed(0)
        + '  [' + stats.p5.toFixed(0) + '..' + stats.p95.toFixed(0) + ']'
        + '  n=' + stats.n));
    }
  }

  /* List 2 container: "Can't play loud". */
  statsUi.meanDriftList.innerHTML = '';
  statsUi.meanDriftList.appendChild(mkHeader("Can't play loud (p95 < " + STATS_HIGH_CEIL
    + ' → raise MIN):', false));
  const byCeil = valid.slice().sort((a, b) => a.stats.p95 - b.stats.p95);
  const ceilHits = byCeil.filter(({ stats }) => stats.p95 < STATS_HIGH_CEIL).slice(0, 5);
  if (ceilHits.length === 0) {
    statsUi.meanDriftList.appendChild(mkEmpty('  (none)'));
  } else {
    for (const { key, stats } of ceilHits) {
      const board = (STATS_KEY_TO_BOARD.get(key) ?? 0) + 1;
      const flagged = stats.p95 < 80;
      statsUi.meanDriftList.appendChild(mkRow(key,
        flagged ? '#f95' : 'rgba(255,255,255,0.7)',
        '  (' + key + ')  brd ' + board
        + '  p5=' + stats.p5.toFixed(0)
        + '  p95=' + stats.p95.toFixed(0)
        + '  n=' + stats.n));
    }
  }
}

function refreshStatsSection(): void {
  if (!statsUi) return;
  /* Sync any new samples to snapshots — persists to localStorage when dirty. */
  velocityCal.syncStatsSnapshot();

  const total = velocityCal.getTotalSamples();
  const enough = velocityCal.getKeyCountWithEnoughSamples();
  statsUi.status.textContent = velocityCal.statsEnabled
    ? enough + ' keys · ' + total + ' samples'
    : 'off';

  drawScatter();
  refreshInspector();
  drawOutlierLists();
}

function makePerKeyStatsSection(): HTMLDivElement {
  const sec = document.createElement('div');
  Object.assign(sec.style, {
    borderTop: '2px solid rgba(255,255,255,0.25)',
    padding: '8px',
    background: 'rgba(160,255,80,0.04)',
  });
  const title = document.createElement('strong');
  title.textContent = 'Per-key velocity statistics';
  Object.assign(title.style, { fontSize: '12px', color: '#9fc', display: 'block', marginBottom: '6px' });
  sec.appendChild(title);

  /* Controls row: enable toggle, clear button, status line. */
  const controls = document.createElement('div');
  Object.assign(controls.style, {
    display: 'flex', alignItems: 'center', gap: '6px',
    marginBottom: '6px', fontSize: '11px',
  });
  const enableCb = document.createElement('input');
  enableCb.type = 'checkbox';
  enableCb.id = 'lmDiagStatsEnable';
  enableCb.checked = velocityCal.statsEnabled;
  Object.assign(enableCb.style, { cursor: 'pointer' });
  enableCb.addEventListener('change', () => {
    velocityCal.setStatsEnabled(enableCb.checked);
    refreshStatsSection();
  });
  const enableLbl = document.createElement('label');
  enableLbl.htmlFor = 'lmDiagStatsEnable';
  enableLbl.textContent = 'Collect';
  Object.assign(enableLbl.style, { cursor: 'pointer', color: 'rgba(255,255,255,0.75)' });
  const clearBtn = document.createElement('button');
  clearBtn.textContent = 'Clear';
  Object.assign(clearBtn.style, {
    fontSize: '11px', padding: '1px 6px',
    background: 'rgba(255,255,255,0.08)', color: '#eee',
    border: '1px solid rgba(255,255,255,0.2)', borderRadius: '2px',
    cursor: 'pointer',
  });
  clearBtn.addEventListener('click', () => {
    if (!window.confirm('Clear all per-key velocity statistics?')) return;
    velocityCal.clearStats();
    statsInspectorKey = null;
    refreshStatsSection();
  });
  const status = document.createElement('span');
  Object.assign(status.style, {
    color: 'rgba(255,255,255,0.6)', marginLeft: 'auto',
    fontFamily: 'monospace',
  });
  status.textContent = '—';
  controls.appendChild(enableCb);
  controls.appendChild(enableLbl);
  controls.appendChild(clearBtn);
  controls.appendChild(status);
  sec.appendChild(controls);

  /* Scatter plot canvas. */
  const scatterWrap = document.createElement('div');
  Object.assign(scatterWrap.style, { display: 'flex', justifyContent: 'center', marginBottom: '4px' });
  const scatter = document.createElement('canvas');
  scatter.width = STATS_SCATTER_W;
  scatter.height = STATS_SCATTER_H;
  Object.assign(scatter.style, {
    background: 'rgba(0,0,0,0.4)',
    border: '1px solid rgba(255,255,255,0.15)',
    cursor: 'crosshair',
  });
  scatterWrap.appendChild(scatter);
  sec.appendChild(scatterWrap);

  const axisHint = document.createElement('div');
  axisHint.textContent = 'x: p5 (floor) · y: p95 (ceiling). Green-tinted zone = ideal. '
    + 'Right of red line: can\'t play quiet (raise MAX). Below red line: can\'t play loud (raise MIN).';
  Object.assign(axisHint.style, {
    fontSize: '10px', color: 'rgba(255,255,255,0.5)',
    marginBottom: '6px', textAlign: 'center', lineHeight: '1.3',
  });
  sec.appendChild(axisHint);

  /* Per-key inspector — sticky on hover; reused for histogram. */
  const inspector = document.createElement('div');
  Object.assign(inspector.style, {
    fontSize: '11px', color: 'rgba(255,255,255,0.85)',
    background: 'rgba(0,0,0,0.3)', padding: '4px 6px',
    borderRadius: '2px', marginBottom: '6px',
    minHeight: '40px', fontFamily: 'monospace',
  });
  inspector.textContent = 'Hover a dot to inspect.';
  sec.appendChild(inspector);

  /* Outlier lists. */
  const highCvList = document.createElement('div');
  sec.appendChild(highCvList);
  const meanDriftList = document.createElement('div');
  sec.appendChild(meanDriftList);

  /* Wire interactions on scatter. */
  scatter.addEventListener('mousemove', (e: MouseEvent) => {
    const rect = scatter.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = findKeyAtScatterPos(mx, my);
    if (hit) {
      statsInspectorKey = hit;
      refreshInspector();
      drawScatter();
    }
  });

  statsUi = { enableCheckbox: enableCb, status, scatter, inspector, highCvList, meanDriftList };
  refreshStatsSection();

  /* 1Hz refresh while the panel exists. Cheap; pauses are handled by the
     stats functions short-circuiting when disabled. */
  if (statsTickerId === null) {
    statsTickerId = window.setInterval(() => {
      if (!panel || panel.style.display === 'none') return;
      refreshStatsSection();
      refreshObservedCounter();
    }, 1000);
  }

  return sec;
}

function onKey(e: KeyboardEvent): void {
  const tag = (document.activeElement?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  if (e.altKey || e.metaKey || e.ctrlKey) return;
  if (e.code === 'Backslash' && e.shiftKey) {
    e.preventDefault();
    /* Defer to init.ts so it can flip the checkbox + savePrefs alongside the
       visibility toggle — keeps the checkbox and overlay in sync. */
    if (hotkeyCallback) hotkeyCallback();
  }
}

export function setLumaDiagHotkeyCallback(fn: (() => void) | null): void {
  hotkeyCallback = fn;
}

export function setLumaDiagVisible(visible: boolean): void {
  if (!panel) return;
  panel.style.display = visible ? 'block' : 'none';
}

export function ensureLumaDiag(): void {
  if (domBuilt) return;
  domBuilt = true;
  for (let i = 0; i < 5; i++) boardStates.push(makeBlankState());

  panel = document.createElement('div');
  panel.id = 'lumaDiagOverlay';
  Object.assign(panel.style, {
    position: 'fixed',
    top: '8px',
    left: '8px',
    width: '320px',
    maxHeight: 'calc(100vh - 16px)',
    overflowY: 'auto',
    background: 'rgba(0,0,0,0.82)',
    color: 'rgba(255,255,255,0.9)',
    font: '12px sans-serif',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: '4px',
    zIndex: '10001',
    pointerEvents: 'auto',
    userSelect: 'none',
    display: 'none',
  });
  const header = document.createElement('div');
  header.textContent = 'lumadiag · per-board calibration';
  Object.assign(header.style, {
    padding: '6px 8px',
    background: 'rgba(255,255,255,0.06)',
    borderBottom: '1px solid rgba(255,255,255,0.2)',
    fontWeight: 'bold',
    fontSize: '12px',
  });
  panel.appendChild(header);
  for (let i = 0; i < 5; i++) panel.appendChild(makeBoardSection(i));
  panel.appendChild(makeVelocityCalSection());
  panel.appendChild(makePerKeyStatsSection());
  panel.appendChild(makeGlobalFooter());
  document.body.appendChild(panel);

  window.addEventListener('keydown', onKey);

  /* Auto-fetch real values after a short delay so MIDI access has time to
     resolve. Sliders remain disabled until each board's response arrives. */
  window.setTimeout(() => {
    if (midi.midiOut) {
      console.log('[lumadiag] fetching real per-board values from device');
      for (let i = 0; i < 5; i++) getBoardValues(i);
    } else {
      console.log('[lumadiag] no Lumatone yet — click "Get all values" once connected');
    }
  }, 1500);

  console.log('%c[lumadiag] built · Shift+\\ toggles visibility · sliders enable once values are read from device',
    'color:#0ff;font-weight:bold');
}
