import type { SysexMessage } from '../types.js';

// Lumatone SysEx protocol constants and message builders.
//
// Envelope: F0 00 21 50 <board> <cmd> <data...> F7
//
// Hardware quirk: boards 3 & 4 are physically swapped on Max's unit, so the
// baseKeys group index → SysEx board index mapping is [1,2,3,5,4]. Don't
// "fix" this with the naïve [1,2,3,4,5] — it'll light the wrong physical
// boards. (See CLAUDE.md.)

export const SYSEX_MANU = [0x00, 0x21, 0x50] as const;

export const SYSEX_CMD_CHANGE_KEY_NOTE = 0x00;
export const SYSEX_CMD_SET_COLOUR = 0x01;
export const SYSEX_CMD_SET_LIGHT_ON_KEYSTROKES = 0x07;
export const SYSEX_CMD_SET_AFTERTOUCH_FLAG = 0x0E;
export const SYSEX_CMD_GET_FIRMWARE_REVISION = 0x31;

/* v0.9 pedal calibration commands (Terpstra firmware reference) */
export const SYSEX_CMD_SET_FOOT_CONTROLLER_SENSITIVITY = 0x03;
export const SYSEX_CMD_INVERT_FOOT_CONTROLLER = 0x04;
export const SYSEX_CMD_CALIBRATE_EXPRESSION_PEDAL = 0x38;
export const SYSEX_CMD_RESET_EXPRESSION_PEDAL_BOUNDS = 0x39;
export const SYSEX_CMD_PERIPHERAL_CALIBRATION_DATA = 0x3E;

export const SYSEX_NACK = 0x00;
export const SYSEX_ACK = 0x01;
export const SYSEX_BUSY = 0x02;

/* baseKeys group index (0-4) → SysEx board index (1-based). Groups 3,4 swapped. */
export const sysexBoardMap = [1, 2, 3, 5, 4] as const;

/* fixed MIDI layout: channels 0-4 (0-indexed in SysEx, firmware uses byte directly) */
export const fixedMidiChannelMap = [0, 1, 2, 3, 4] as const;

// ── message builders ────────────────────────────────────────────────────────

export function buildNoteSysEx(board: number, keyIdx: number, note: number, channel: number, typeByte: number): SysexMessage {
  /* F0 00 21 50 <board> 00 <key> <note> <ch> <type> F7 */
  return new Uint8Array([
    0xF0,
    SYSEX_MANU[0], SYSEX_MANU[1], SYSEX_MANU[2],
    board, SYSEX_CMD_CHANGE_KEY_NOTE, keyIdx,
    note, channel, typeByte,
    0xF7,
  ]) as SysexMessage;
}

export function buildColorSysEx(board: number, keyIdx: number, hexCol: string, deviceIdx: number): SysexMessage {
  /* hexCol is '#RRGGBB'. deviceIdx is the 0-279 baseKeys index for ACK routing. */
  const r = parseInt(hexCol.slice(1, 3), 16);
  const g = parseInt(hexCol.slice(3, 5), 16);
  const b = parseInt(hexCol.slice(5, 7), 16);
  const msg = new Uint8Array([
    0xF0,
    SYSEX_MANU[0], SYSEX_MANU[1], SYSEX_MANU[2],
    board, SYSEX_CMD_SET_COLOUR, keyIdx,
    (r >> 4) & 0xF, r & 0xF,
    (g >> 4) & 0xF, g & 0xF,
    (b >> 4) & 0xF, b & 0xF,
    0xF7,
  ]) as SysexMessage;
  msg.keyIdx = deviceIdx;
  msg.color = hexCol;
  return msg;
}

export function buildToggleSysEx(cmd: number, value: number | boolean): SysexMessage {
  /* F0 00 21 50 00 <cmd> <value> 00 00 00 F7 — sendSysExToggle format */
  return new Uint8Array([
    0xF0,
    SYSEX_MANU[0], SYSEX_MANU[1], SYSEX_MANU[2],
    0x00, cmd, value ? 1 : 0, 0x00, 0x00, 0x00,
    0xF7,
  ]) as SysexMessage;
}

export function buildRequestSysEx(cmd: number): SysexMessage {
  /* F0 00 21 50 00 <cmd> 00 00 00 00 F7 — sendSysExRequest format */
  return new Uint8Array([
    0xF0,
    SYSEX_MANU[0], SYSEX_MANU[1], SYSEX_MANU[2],
    0x00, cmd, 0x00, 0x00, 0x00, 0x00,
    0xF7,
  ]) as SysexMessage;
}
