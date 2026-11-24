// The Lumatone Calibration overlay.
//
// Toggled via the "Calibration" checkbox in the Lumatone toolbar. Lazy:
// ensureLumaDiag() builds DOM on first call; setLumaDiagVisible toggles
// display. A Shift+\ hotkey is also wired — when pressed it invokes the
// registered hotkey callback so init.ts can keep the checkbox + pref in sync.
// ("lumadiag" is this module's internal name; the player sees "Lumatone
// Calibration".)
//
// Top to bottom: the Lumatone velocity curve (with the state of the per-key
// press-time scales, which HKL makes from the device's calibration:
// lumatone/keyscales.ts); the firmware's own touch-learning calibration (keys
// 0x24, aftertouch 0x0F, ended from here with 0x52 on firmware 1.5.0+:
// lumatone/keycal.ts) and the factory reset of everything but what that routine
// learns; the per-board key thresholds and CC/aftertouch sensitivities; the
// board 3 ↔ 4 swap.
//
// There is no SysEx command that sets a per-key threshold; the firmware-internal
// "SET_KEY_*" commands (0x29–0x2C, 0x32) are board-scoped, so per-board is the
// ceiling for numeric control from here.
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
  sysexBoardFor,
  getBoards34Swapped,
  setBoards34Swapped,
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
  parseBoardThresholds,
} from './protocol.js';
import { velocityCal, DEFAULT_INPUT_CURVE } from '../audio/velocityCal.js';
import { lumatone } from '../state/lumatone.js';
import { savePrefs } from '../state/persistence.js';
import { resyncLumatoneDevice } from './sync.js';
import { startKeyCal, endKeyCal, keyCalStatus, onKeyCalChange } from './keycal.js';
import { refreshKeyScales, keyScaleStatus, onKeyScaleChange } from './keyscales.js';

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
let hotkeyListening = false;
const boardStates: BoardState[] = [];
const valueLabels: Record<string, HTMLSpanElement> = {};
const sliders: Record<string, HTMLInputElement> = {};
/* Per-board title <strong> refs so the swap toggle can rewrite the SysEx-board
   numbers in place when the routing flips. */
const boardTitles: HTMLElement[] = [];

function boardTitleText(logical: number): string {
  return 'Board ' + (logical + 1) + ' (SysEx ' + sysexBoardFor(logical) + ')';
}

function hex(v: number): string {
  return '0x' + v.toString(16).toUpperCase().padStart(2, '0');
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
  /* `max` and `min lo` are part of every key's timing window. */
  if (field === 'max' || field === 'minLow') msg.onResponse = scheduleKeyScaleRefresh;
  const ok = sysex.enqueueControl(msg);
  if (!ok) console.warn('[lumadiag] no Lumatone connected — change not sent');
  else console.log('[lumadiag] board ' + (logical + 1) + ' ' + field + ' → ' + hex(s[field]!));
}

/* The key scales follow the per-board thresholds. Several changes in a row (a
   reset of all five boards) make one read. */
let scaleRefreshTimer: number | null = null;
function scheduleKeyScaleRefresh(): void {
  if (scaleRefreshTimer !== null) clearTimeout(scaleRefreshTimer);
  scaleRefreshTimer = window.setTimeout(() => { scaleRefreshTimer = null; refreshKeyScales(); }, 400);
}

/* Send a board-addressed RESET (0x34) for one logical board. After the reset
   ACKs, fetch the new values so the sliders reflect factory state. */
function resetBoard(logical: number): void {
  const board = sysexBoardFor(logical);
  console.log('[lumadiag] reset board ' + (logical + 1) + ' (SysEx board ' + board + ')');
  const msg = buildBoardRequestSysEx(board, SYSEX_CMD_RESET_BOARD_THRESHOLDS);
  msg.onResponse = () => {
    window.setTimeout(() => getBoardValues(logical), 50);
    scheduleKeyScaleRefresh();
  };
  const ok = sysex.enqueueControl(msg);
  if (!ok) console.warn('[lumadiag] no Lumatone connected — reset not sent');
}

/* A CMD 3Ah response into the board's state. */
function parse3AResponse(logical: number, data: Uint8Array): boolean {
  const t = parseBoardThresholds(data);
  if (!t) return false;
  Object.assign(boardStates[logical], t);
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

/* Every board's values, read when the panel is built or shown: the device may
   have been power-cycled, or changed from elsewhere, since the last look. */
let boardsReadAt = -Infinity;
function getAllBoardValues(): void {
  if (!midi.midiOut || performance.now() - boardsReadAt < 1000) return;
  boardsReadAt = performance.now();
  for (let i = 0; i < 5; i++) getBoardValues(i);
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

/* The factory reset tools/reset-calibration.sh sends, plus the Lumatouch table:
   the velocity (0x0A), aftertouch (0x12) and Lumatouch (0x2F) tables and each
   board's thresholds and sensitivities (0x34). It does not touch the per-key
   thresholds a calibration learned. The device then holds its factory velocity
   table, which HKL's curve means nothing over, so the setup is sent again (the
   two velocity tables among it, and the key scales are read back). */
function resetAllCalibration(): void {
  if (!window.confirm('Reset the Lumatone\u2019s velocity, aftertouch and Lumatouch tables and every board\u2019s '
    + 'thresholds and sensitivities to their factory values?\n\nThe per-key thresholds a key calibration '
    + 'learned are kept. HKL sends its own velocity tables again afterwards.')) return;
  for (const cmd of [SYSEX_CMD_RESET_VELOCITY_CONFIG, SYSEX_CMD_RESET_AFTERTOUCH_CONFIG, SYSEX_CMD_RESET_LUMATOUCH_CONFIG]) {
    sysex.enqueueControl(buildRequestSysEx(cmd));
  }
  for (let i = 0; i < 5; i++) {
    const msg = buildBoardRequestSysEx(sysexBoardFor(i), SYSEX_CMD_RESET_BOARD_THRESHOLDS);
    if (i === 4) msg.onResponse = () => {
      resyncLumatoneDevice();
      boardsReadAt = -Infinity;
      getAllBoardValues();
    };
    if (!sysex.enqueueControl(msg)) { console.warn('[lumadiag] no Lumatone connected — reset not sent'); return; }
  }
  console.log('[lumadiag] reset all calibration: velocity, aftertouch and Lumatouch tables, five boards\u2019 thresholds');
}

/* Built-in touch calibration (lumatone/keycal.ts). Idle: the two start
   buttons and the factory reset. While a calibration runs they give way to
   Confirm / Cancel. When one has ended, the per-board values are read back. */
function makeBuiltinCalSection(): HTMLDivElement {
  const sec = document.createElement('div');
  Object.assign(sec.style, {
    borderTop: '1px solid rgba(255,255,255,0.12)',
    padding: '6px 8px',
  });
  const title = document.createElement('strong');
  title.textContent = 'Built-in calibration';
  Object.assign(title.style, { fontSize: '12px', color: '#9cf' });
  sec.appendChild(title);
  const hint = document.createElement('div');
  hint.textContent = 'The Lumatone learns each key\u2019s thresholds from your touch. Confirm replaces the '
    + 'per-key thresholds stored on it; Cancel changes nothing. Firmware 1.5.0+.';
  Object.assign(hint.style, {
    fontSize: '10px', color: 'rgba(255,255,255,0.55)', margin: '3px 0 5px',
  });
  sec.appendChild(hint);
  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', flexWrap: 'wrap', gap: '4px' });
  const mkBtn = (label: string, tip: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = tip;
    Object.assign(b.style, {
      fontSize: '11px', padding: '2px 6px',
      background: 'rgba(255,255,255,0.08)', color: '#eee',
      border: '1px solid rgba(255,255,255,0.2)', borderRadius: '2px',
      cursor: 'pointer',
    });
    b.addEventListener('click', onClick);
    row.appendChild(b);
    return b;
  };
  const startKey = mkBtn('Start key calibration', 'CMD 0x24 — all five boards learn key thresholds',
    () => startKeyCal('key'));
  const startAt = mkBtn('Start aftertouch calibration', 'CMD 0x0F — all five boards learn aftertouch thresholds',
    () => startKeyCal('aftertouch'));
  const confirm = mkBtn('Confirm (save)', 'CMD 0x52, value 1 — save the learned thresholds on the Lumatone',
    () => endKeyCal(true));
  const cancel = mkBtn('Cancel (discard)', 'CMD 0x52, value 0 — leave calibration; nothing is saved',
    () => endKeyCal(false));
  const resetAll = mkBtn('Reset all calibration\u2026', 'Factory values for the velocity, aftertouch and Lumatouch tables and '
    + 'every board\u2019s thresholds and sensitivities (CMD 0x0A, 0x12, 0x2F, 0x34 × 5). Asks first. The per-key '
    + 'thresholds a calibration learned are kept.', resetAllCalibration);
  sec.appendChild(row);
  const statusEl = document.createElement('div');
  Object.assign(statusEl.style, {
    fontSize: '11px', color: 'rgba(255,255,255,0.8)', marginTop: '5px', lineHeight: '1.35',
  });
  sec.appendChild(statusEl);
  let prev = lumatone.keyCal;
  const refresh = (): void => {
    const phase = lumatone.keyCal;
    const ending = phase !== 'idle' && phase !== 'starting'; /* running, or its end in flight */
    const busy = phase === 'starting' || phase === 'ending';
    for (const b of [startKey, startAt, resetAll]) b.style.display = ending ? 'none' : '';
    for (const b of [confirm, cancel]) b.style.display = ending ? '' : 'none';
    for (const b of [startKey, startAt, confirm, cancel, resetAll]) {
      b.disabled = busy;
      b.style.opacity = busy ? '0.5' : '1';
    }
    statusEl.textContent = keyCalStatus();
    statusEl.style.display = statusEl.textContent ? '' : 'none';
    if (phase === 'idle' && prev === 'ending') { boardsReadAt = -Infinity; getAllBoardValues(); }
    prev = phase;
  };
  onKeyCalChange(refresh);
  refresh();
  return sec;
}

/* Board 3↔4 routing swap. For units with boards 3 & 4 physically transposed,
   group 4/5's SysEx board byte must be flipped. Off by default (standard units
   need no swap); persisted. Flipping it re-pushes the fixed MIDI layout + all
   key colors so the now-relocated boards re-light correctly. */
function makeSwapSection(): HTMLDivElement {
  const sec = document.createElement('div');
  Object.assign(sec.style, {
    borderTop: '1px solid rgba(255,255,255,0.12)',
    padding: '6px 8px',
  });
  const label = document.createElement('label');
  Object.assign(label.style, {
    display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer',
    fontSize: '12px',
  });
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = getBoards34Swapped();
  cb.addEventListener('change', () => {
    setBoards34Swapped(cb.checked);
    savePrefs({ swapBoards34: cb.checked });
    /* Refresh the per-board SysEx labels to match the new routing. */
    for (let i = 0; i < boardTitles.length; i++) {
      if (boardTitles[i]) boardTitles[i].textContent = boardTitleText(i);
    }
    /* Re-light: the swap relocates groups 4/5, so the already-sent fixed layout
       and colors now sit on the wrong physical boards. Force a full re-push,
       not trusting a frame still in flight under the old board map. */
    resyncLumatoneDevice();
  });
  label.appendChild(cb);
  label.appendChild(document.createTextNode('Swap boards 3 ↔ 4 (this unit)'));
  sec.appendChild(label);
  const hint = document.createElement('div');
  hint.textContent = 'Off for standard units. Enable only if your boards 3 & 4 are physically transposed.';
  Object.assign(hint.style, {
    fontSize: '10px', color: 'rgba(255,255,255,0.55)', marginTop: '3px',
  });
  sec.appendChild(hint);
  return sec;
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
  title.textContent = boardTitleText(logical);
  boardTitles[logical] = title;
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

/* Under the last board: all five back to factory thresholds and sensitivities. */
function makeResetBoardsRow(): HTMLDivElement {
  const row = document.createElement('div');
  Object.assign(row.style, { padding: '0 8px 8px' });
  const b = document.createElement('button');
  b.textContent = 'Reset all 5 boards\u2026';
  b.title = 'CMD 0x34 × 5 — factory thresholds and sensitivities for every board. Asks first.';
  Object.assign(b.style, {
    fontSize: '11px', padding: '2px 6px',
    background: 'rgba(255,255,255,0.08)', color: '#eee',
    border: '1px solid rgba(255,255,255,0.2)', borderRadius: '2px',
    cursor: 'pointer',
  });
  b.addEventListener('click', () => {
    if (!window.confirm('Reset all five boards\u2019 thresholds and sensitivities to their factory values?')) return;
    for (let i = 0; i < 5; i++) resetBoard(i);
  });
  row.appendChild(b);
  return row;
}

/* The velocity curve's controls. Built once; element refs cached so external
   state changes can refresh the displayed values. */
const velCalUi: {
  fullSlider?: HTMLInputElement;
  fullVal?: HTMLSpanElement;
  cornerSlider?: HTMLInputElement;
  cornerVal?: HTMLSpanElement;
  gammaSlider?: HTMLInputElement;
  gammaVal?: HTMLSpanElement;
  preview?: HTMLCanvasElement;
  keyScales?: HTMLSpanElement;
} = {};

/* Plot-area margins of the curve preview canvas. Left margin holds y-axis tick
   labels (right-aligned + tick marks) plus a rotated axis name. Bottom margin
   holds x-axis tick labels + axis name. */
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
    /* Composite: device velocity → its press time → the Lumatone curve → musical →
       house curve → audio gain. This is the effective loudness response. */
    const g = velocityCal.curveGain(velocityCal.applyInputCurve(v));
    const y = py + ph - g * ph;
    if (x === 0) ctx.moveTo(px + x, y); else ctx.lineTo(px + x, y);
  }
  ctx.stroke();
}

function refreshCurveUi(): void {
  if (velCalUi.fullSlider) {
    velCalUi.fullSlider.value = String(Math.round(velocityCal.inputCurveFull * 10));
    velCalUi.fullVal!.textContent = velocityCal.inputCurveFull.toFixed(1);
  }
  if (velCalUi.cornerSlider) {
    velCalUi.cornerSlider.value = String(Math.round(velocityCal.inputCurveCorner * 10));
    velCalUi.cornerVal!.textContent = velocityCal.inputCurveCorner.toFixed(1) + ' dB';
  }
  if (velCalUi.gammaSlider) {
    velCalUi.gammaSlider.value = String(Math.round(velocityCal.inputCurveGamma * 100));
    velCalUi.gammaVal!.textContent = velocityCal.inputCurveGamma.toFixed(2);
  }
  drawCurvePreview();
  refreshKeyScaleLine();
}

/* Where the per-key scales stand (lumatone/keyscales.ts). */
function refreshKeyScaleLine(): void {
  const el = velCalUi.keyScales;
  if (!el) return;
  const st = keyScaleStatus();
  const kept = velocityCal.calibratedKeyCount;
  if (st.state === 'reading') el.textContent = 'reading the Lumatone\u2019s calibration\u2026';
  else if (st.state === 'read') {
    el.textContent = st.count + ' keys, ' + st.min.toFixed(2) + '\u2013' + st.max.toFixed(2)
      + (st.noWindow ? ' (' + st.noWindow + ' with no timing window)' : '');
  } else if (st.state === 'failed') el.textContent = 'not read; the last table is in use (' + kept + ' keys)';
  else el.textContent = kept ? 'the last table read (' + kept + ' keys)' : 'none yet';
}

/* ── Lumatone velocity curve ──
   The piano's law in the device's units, run up to full loudness, with the
   corner where they meet rounded (velocityCal.targetGainForTicks). `full` is
   the input velocity where the piano line (F ÷ ticks)^gamma reaches full;
   gamma 1 is the measured piano; `corner` is how many dB under that meeting
   point the curve passes, and moves nothing away from it. Internally the gain
   is converted to the canonical musical velocity that reproduces it through
   the house curve, so keyVelocity stays device-neutral; a gain under the house
   curve's floor plays as its quietest note. The preview is this exact curve
   against the input velocity (the hardware velocity after the key's scale:
   128 − ticks), which is the number the Diagnostics overlay plots and labels
   for a Lumatone strike. */
function makeVelocityCurveSection(): HTMLDivElement {
  const sec = document.createElement('div');
  Object.assign(sec.style, {
    borderTop: '1px solid rgba(255,255,255,0.12)',
    padding: '6px 8px',
  });
  const title = document.createElement('strong');
  title.textContent = 'Lumatone velocity curve';
  Object.assign(title.style, { fontSize: '12px', color: '#9cf', display: 'block', marginBottom: '6px' });
  sec.appendChild(title);

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
  /* `full` in tenths of an input velocity: on the default table 125.0 is 3 ticks. */
  const fullUi = mkCurveSlider(
    'full at', 'Where the piano line reaches full loudness, as an input velocity (the number the Diagnostics overlay shows: 128 − ticks, after the key\'s scale). Faster presses are full too. Lower = full loudness comes sooner and everything is louder.',
    1000, 1270, 1,
    () => Math.round(velocityCal.inputCurveFull * 10),
    (v: number) => velocityCal.setInputCurveFull(v / 10),
    (v: number) => (v / 10).toFixed(1),
  );
  const gammaUi = mkCurveSlider(
    'gamma', 'Exponent on the piano line. 1.00 is a piano: amplitude proportional to the speed of the press, 6 dB per doubling of press time. Higher = wider dynamic range (soft presses quieter); lower = narrower.',
    50, 200, 1,
    () => velocityCal.inputCurveGamma * 100,
    (v: number) => velocityCal.setInputCurveGamma(v / 100),
    (v: number) => (v / 100).toFixed(2),
  );
  const cornerUi = mkCurveSlider(
    'corner', 'Rounds the corner where the line meets full loudness: how many dB under that point the curve passes. 0 = a hard corner. Around 1 dB only the corner moves; several dB round a wide stretch of the line under it, so the loud end rises more gently.',
    0, 99, 1,
    () => Math.round(velocityCal.inputCurveCorner * 10),
    (v: number) => velocityCal.setInputCurveCorner(v / 10),
    (v: number) => (v / 10).toFixed(1) + ' dB',
  );
  velCalUi.fullSlider = fullUi.slider; velCalUi.fullVal = fullUi.val;
  velCalUi.gammaSlider = gammaUi.slider; velCalUi.gammaVal = gammaUi.val;
  velCalUi.cornerSlider = cornerUi.slider; velCalUi.cornerVal = cornerUi.val;
  sec.appendChild(fullUi.row);
  sec.appendChild(cornerUi.row);
  sec.appendChild(gammaUi.row);

  const curveResetBtn = document.createElement('button');
  curveResetBtn.textContent = 'Reset curve (full at ' + DEFAULT_INPUT_CURVE.full.toFixed(1)
    + ', corner ' + DEFAULT_INPUT_CURVE.corner.toFixed(1) + ' dB, gamma ' + DEFAULT_INPUT_CURVE.gamma.toFixed(2) + ')';
  Object.assign(curveResetBtn.style, {
    fontSize: '11px', padding: '1px 6px', marginTop: '4px',
    background: 'rgba(255,255,255,0.08)', color: '#eee',
    border: '1px solid rgba(255,255,255,0.2)', borderRadius: '2px',
    cursor: 'pointer',
  });
  curveResetBtn.addEventListener('click', () => {
    velocityCal.resetInputCurve();
    refreshCurveUi();
  });
  sec.appendChild(curveResetBtn);

  /* The per-key press-time scales: nothing to set, only where they stand. */
  const scaleRow = document.createElement('div');
  Object.assign(scaleRow.style, {
    marginTop: '8px', fontSize: '11px', color: 'rgba(255,255,255,0.7)', lineHeight: '1.35',
  });
  scaleRow.title = 'One number per key multiplies its press time before the curve, so the same touch sounds the same '
    + 'on every key. HKL makes them from the calibration the Lumatone holds and reads it again whenever it connects, '
    + 'after a calibration, and after a change to a board\u2019s max or min lo.';
  scaleRow.appendChild(document.createTextNode('Key scales: '));
  const scaleVal = document.createElement('span');
  Object.assign(scaleVal.style, { color: '#9cf' });
  scaleRow.appendChild(scaleVal);
  velCalUi.keyScales = scaleVal;
  sec.appendChild(scaleRow);
  onKeyScaleChange(refreshKeyScaleLine);

  drawCurvePreview();
  refreshKeyScaleLine();
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

/** Install the Shift+\ handler. The listener is registered here (at startup),
 *  not in ensureLumaDiag(): the hotkey must open the overlay before its DOM has
 *  ever been built. */
export function setLumaDiagHotkeyCallback(fn: (() => void) | null): void {
  hotkeyCallback = fn;
  if (!hotkeyListening) {
    hotkeyListening = true;
    window.addEventListener('keydown', onKey);
  }
}

export function setLumaDiagVisible(visible: boolean): void {
  if (!panel) return;
  panel.style.display = visible ? 'block' : 'none';
  if (!visible) return;
  getAllBoardValues();
  /* The scroll bar gets a strip of its own (`scrollbar-gutter`). A browser that
     draws its scroll bars over the content reserves nothing for them, so there
     the strip is padding. Measured once the panel is laid out. */
  if (!gutterChecked) {
    gutterChecked = true;
    if (panel.offsetWidth - panel.clientWidth <= 2) panel.style.paddingRight = SCROLLBAR_STRIP_PX + 'px';
  }
}
const SCROLLBAR_STRIP_PX = 12;
let gutterChecked = false;

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
    width: (320 + SCROLLBAR_STRIP_PX) + 'px',
    maxHeight: 'calc(100vh - 16px)',
    overflowY: 'auto',
    scrollbarGutter: 'stable',
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
  header.textContent = 'Lumatone Calibration';
  Object.assign(header.style, {
    padding: '6px 8px',
    background: 'rgba(255,255,255,0.06)',
    borderBottom: '1px solid rgba(255,255,255,0.2)',
    fontWeight: 'bold',
    fontSize: '12px',
  });
  panel.appendChild(header);
  panel.appendChild(makeVelocityCurveSection());
  panel.appendChild(makeBuiltinCalSection());
  for (let i = 0; i < 5; i++) panel.appendChild(makeBoardSection(i));
  panel.appendChild(makeResetBoardsRow());
  panel.appendChild(makeSwapSection());
  document.body.appendChild(panel);

  /* Read the per-board values after a short delay, so that a panel restored at
     page load finds MIDI access resolved. Sliders remain disabled until each
     board's response arrives; showing the panel reads them again. */
  window.setTimeout(getAllBoardValues, 1500);

  console.log('%c[lumadiag] built · Shift+\\ toggles visibility · sliders enable once values are read from device',
    'color:#0ff;font-weight:bold');
}
