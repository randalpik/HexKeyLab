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
} from './protocol.js';
import { velocityCal, DEFAULT_CAL, STATS_MIN_N, STATS_HIGH_CV } from '../audio/velocityCal.js';
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
} = {};

let captureTicker: number | null = null;

function pushIdentityVelocityLut(): void {
  /* Identity LUT: lut[i] = i, slowest (i=0) → softest, fastest (i=127) → loudest.
     buildSetVelocityLut reverses internally to match the firmware wire order. */
  const lut: number[] = [];
  for (let i = 0; i < 128; i++) lut.push(i);
  const msg = buildSetVelocityLut(lut);
  const ok = sysex.enqueueControl(msg);
  if (ok) console.log('[lumadiag] pushed identity velocity LUT to Lumatone (CMD 0x08)');
  else console.warn('[lumadiag] no Lumatone connected — identity LUT not sent');
}

function drawCurvePreview(): void {
  const cv = velCalUi.preview;
  if (!cv) return;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const w = cv.width, h = cv.height;
  ctx.clearRect(0, 0, w, h);
  /* Frame + diagonal reference (identity floor=0, ceiling=1, gamma=1). */
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(w, 0);
  ctx.stroke();
  /* Curve. */
  ctx.strokeStyle = '#9cf';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let x = 0; x <= w; x++) {
    const v = (x / w) * 127;
    const g = velocityCal.curveGain(v);
    const y = h - g * h;
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
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
  drawCurvePreview();
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
  const hwResetHint = document.createElement('div');
  hwResetHint.textContent = '(Use "Reset velocity LUT" below to revert to factory firmware curve.)';
  Object.assign(hwResetHint.style, { fontSize: '10px', color: 'rgba(255,255,255,0.4)', marginTop: '2px', marginBottom: '8px', lineHeight: '1.2' });
  sec.appendChild(hwResetHint);

  /* ── HKL curve ── */
  const curveLabel = document.createElement('div');
  curveLabel.textContent = 'HKL curve';
  Object.assign(curveLabel.style, { fontSize: '11px', color: 'rgba(255,255,255,0.6)', marginBottom: '4px' });
  sec.appendChild(curveLabel);

  const previewWrap = document.createElement('div');
  Object.assign(previewWrap.style, { display: 'flex', justifyContent: 'center', marginBottom: '6px' });
  const preview = document.createElement('canvas');
  preview.width = 200; preview.height = 80;
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
    'gamma', 'Curve exponent (× 100). >1 = soft notes get quieter (piano-like).',
    50, 300, 5,
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

function scatterXY(mean: number, cv: number): [number, number] {
  const cvClamped = Math.min(1.0, Math.max(0, cv));
  const x = STATS_SCATTER_PAD + (mean / 127) * (STATS_SCATTER_W - 2 * STATS_SCATTER_PAD);
  const y = (STATS_SCATTER_H - STATS_SCATTER_PAD) - cvClamped * (STATS_SCATTER_H - 2 * STATS_SCATTER_PAD);
  return [x, y];
}

function findKeyAtScatterPos(mx: number, my: number): string | null {
  let bestKey: string | null = null;
  let bestDist = 36;  // squared 6px
  for (const { key, stats } of velocityCal.getAllStats()) {
    if (stats.n < STATS_MIN_N || stats.cv < 0) continue;
    const [x, y] = scatterXY(stats.mean, stats.cv);
    const dx = x - mx, dy = y - my;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist) { bestDist = d2; bestKey = key; }
  }
  return bestKey;
}

function drawScatter(): void {
  if (!statsUi) return;
  const cv = statsUi.scatter;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, STATS_SCATTER_W, STATS_SCATTER_H);

  /* Reference grid: CV=0.3 (noisy threshold), keyboard-wide mean. */
  ctx.strokeStyle = 'rgba(255,80,80,0.25)';
  ctx.lineWidth = 1;
  const [, cv3y] = scatterXY(0, STATS_HIGH_CV);
  ctx.beginPath();
  ctx.moveTo(STATS_SCATTER_PAD, cv3y);
  ctx.lineTo(STATS_SCATTER_W - STATS_SCATTER_PAD, cv3y);
  ctx.stroke();
  const global = velocityCal.getGlobalStats();
  if (global.nKeys >= 2) {
    const [meanX] = scatterXY(global.meanOfMeans, 0);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.moveTo(meanX, STATS_SCATTER_PAD);
    ctx.lineTo(meanX, STATS_SCATTER_H - STATS_SCATTER_PAD);
    ctx.stroke();
  }

  /* Axis labels. */
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '9px sans-serif';
  for (const m of [0, 32, 64, 96, 127]) {
    const [tx] = scatterXY(m, 0);
    ctx.fillText(String(m), tx - 6, STATS_SCATTER_H - 1);
  }
  for (const c of [0.25, 0.5, 0.75]) {
    const [, ty] = scatterXY(0, c);
    ctx.fillText(c.toFixed(2), 0, ty + 3);
  }

  /* Per-key dots, color-coded by board. Selected (inspector) key drawn last
     with a white outline so it's visible. */
  let selectedDot: { x: number; y: number; color: string } | null = null;
  for (const { key, stats } of velocityCal.getAllStats()) {
    if (stats.n < STATS_MIN_N || stats.cv < 0) continue;
    const [x, y] = scatterXY(stats.mean, stats.cv);
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
  const cvStr = stats.cv < 0 ? '—' : stats.cv.toFixed(3);
  const line = document.createElement('div');
  line.textContent = '(' + statsInspectorKey + ')  brd ' + board
    + '  n=' + stats.n
    + '  μ=' + stats.mean.toFixed(1)
    + '  σ=' + stats.stddev.toFixed(1)
    + '  CV=' + cvStr;
  inspector.appendChild(line);

  /* Histogram sparkline (live samples only). */
  const hist = velocityCal.getKeyHistogram(statsInspectorKey, 32);
  const sparkW = 270, sparkH = 24;
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
      const bh = (hist[i] / maxCount) * (sparkH - 2);
      sctx.fillRect(i * barW, sparkH - bh, barW - 1, bh);
    }
  }
  inspector.appendChild(spark);
}

function drawOutlierLists(): void {
  if (!statsUi) return;
  const all = velocityCal.getAllStats();
  const valid = all.filter(({ stats }) => stats.n >= STATS_MIN_N && stats.cv >= 0);

  /* High-CV: top 5, only show entries with CV >= half-threshold to avoid noise. */
  statsUi.highCvList.innerHTML = '';
  const h1 = document.createElement('div');
  h1.textContent = 'Top noisy (high CV → raise hardware MIN):';
  Object.assign(h1.style, { fontSize: '11px', color: 'rgba(255,255,255,0.65)', marginBottom: '2px' });
  statsUi.highCvList.appendChild(h1);
  const byCv = valid.slice().sort((a, b) => b.stats.cv - a.stats.cv).slice(0, 5);
  const cvHits = byCv.filter(({ stats }) => stats.cv >= STATS_HIGH_CV * 0.5);
  if (cvHits.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = '  (none yet)';
    Object.assign(empty.style, { fontSize: '10px', color: 'rgba(255,255,255,0.4)' });
    statsUi.highCvList.appendChild(empty);
  }
  for (const { key, stats } of cvHits) {
    const row = document.createElement('div');
    const board = (STATS_KEY_TO_BOARD.get(key) ?? 0) + 1;
    const flagged = stats.cv >= STATS_HIGH_CV;
    row.textContent = '  (' + key + ')  brd ' + board
      + '  CV=' + stats.cv.toFixed(2)
      + '  μ=' + stats.mean.toFixed(0)
      + '  n=' + stats.n;
    Object.assign(row.style, {
      fontSize: '10px', fontFamily: 'monospace',
      color: flagged ? '#f95' : 'rgba(255,255,255,0.7)',
      cursor: 'pointer',
    });
    row.addEventListener('click', () => {
      statsInspectorKey = key;
      refreshInspector();
      drawScatter();
    });
    statsUi.highCvList.appendChild(row);
  }

  /* Mean drift: keys whose mean deviates from keyboard average by ≥1.5σ. */
  statsUi.meanDriftList.innerHTML = '';
  const h2 = document.createElement('div');
  h2.textContent = 'Top mean-drift (per-key gain candidates):';
  Object.assign(h2.style, { fontSize: '11px', color: 'rgba(255,255,255,0.65)', marginTop: '4px', marginBottom: '2px' });
  statsUi.meanDriftList.appendChild(h2);
  const global = velocityCal.getGlobalStats();
  if (global.nKeys < 5 || global.stddevOfMeans <= 0) {
    const empty = document.createElement('div');
    empty.textContent = '  (need more data)';
    Object.assign(empty.style, { fontSize: '10px', color: 'rgba(255,255,255,0.4)' });
    statsUi.meanDriftList.appendChild(empty);
    return;
  }
  const byDrift = valid
    .map(({ key, stats }) => ({
      key, stats,
      drift: (stats.mean - global.meanOfMeans) / global.stddevOfMeans,
    }))
    .sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift))
    .slice(0, 5);
  for (const { key, stats, drift } of byDrift) {
    const row = document.createElement('div');
    const board = (STATS_KEY_TO_BOARD.get(key) ?? 0) + 1;
    const flagged = Math.abs(drift) >= 1.5;
    row.textContent = '  (' + key + ')  brd ' + board
      + '  μ=' + stats.mean.toFixed(0)
      + '  Δσ=' + (drift >= 0 ? '+' : '') + drift.toFixed(1)
      + '  n=' + stats.n;
    Object.assign(row.style, {
      fontSize: '10px', fontFamily: 'monospace',
      color: flagged ? '#f95' : 'rgba(255,255,255,0.7)',
      cursor: 'pointer',
    });
    row.addEventListener('click', () => {
      statsInspectorKey = key;
      refreshInspector();
      drawScatter();
    });
    statsUi.meanDriftList.appendChild(row);
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
  axisHint.textContent = 'x: mean velocity · y: CV. Red line = CV=0.30 (noisy). Top-right needs higher hardware MIN.';
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
