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
} from './protocol.js';

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
