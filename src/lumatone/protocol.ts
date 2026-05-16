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

/* Velocity / aftertouch curve LUTs. 0x08 = SET, 0x0A = RESET to factory. */
export const SYSEX_CMD_SET_VELOCITY_CONFIG = 0x08;

/* Per-board threshold & sensitivity calibration (firmware 1.0.7+ / 1.0.10+).
   The "SET_KEY_*" names are firmware-internal but apply to all keys on the
   target board — there is no true per-key threshold command. */
export const SYSEX_CMD_RESET_VELOCITY_CONFIG = 0x0A;
export const SYSEX_CMD_RESET_AFTERTOUCH_CONFIG = 0x12;
export const SYSEX_CMD_SET_KEY_MAX_THRESHOLD = 0x29;  /* packs (max, atThresh) */
export const SYSEX_CMD_SET_KEY_MIN_THRESHOLD = 0x2A;  /* packs (minHigh, minLow) */
export const SYSEX_CMD_SET_KEY_FADER_SENS = 0x2B;
export const SYSEX_CMD_SET_KEY_AT_SENS = 0x2C;
export const SYSEX_CMD_RESET_LUMATOUCH_CONFIG = 0x2F;
export const SYSEX_CMD_SET_CC_ACTIVE_THRESHOLD = 0x32;
export const SYSEX_CMD_RESET_BOARD_THRESHOLDS = 0x34;
export const SYSEX_CMD_GET_BOARD_THRESHOLDS = 0x3A;
export const SYSEX_CMD_GET_BOARD_SENSITIVITY = 0x3B;

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

/* Board-addressed request: F0 00 21 50 <board> <cmd> 00 00 00 00 F7.
   Used for per-board RESET and GET commands (0x34, 0x3A, 0x3B, etc.). */
export function buildBoardRequestSysEx(board: number, cmd: number): SysexMessage {
  return new Uint8Array([
    0xF0,
    SYSEX_MANU[0], SYSEX_MANU[1], SYSEX_MANU[2],
    board, cmd, 0x00, 0x00, 0x00, 0x00,
    0xF7,
  ]) as SysexMessage;
}

/* Empirically (verified on Max's unit), the firmware only honors the low
   nibble of each threshold/sensitivity value — non-zero high nibbles break
   the board. The Terpstra driver source claims 8-bit (0..0xFE), but the
   shipping firmware appears to truncate. So we clamp to 4 bits and always
   send the high nibble as 0. The nibble-pair envelope is preserved (hi, lo)
   for protocol compatibility. */
const clamp4 = (v: number): number => v < 0 ? 0 : v > 0xF ? 0xF : (v | 0);

/* CMD 0x29: per-board max threshold + aftertouch threshold (4-bit each). */
export function buildSetMaxThreshold(board: number, maxThresh: number, atMax: number): SysexMessage {
  const m = clamp4(maxThresh);
  const a = clamp4(atMax);
  return new Uint8Array([
    0xF0,
    SYSEX_MANU[0], SYSEX_MANU[1], SYSEX_MANU[2],
    board, SYSEX_CMD_SET_KEY_MAX_THRESHOLD,
    (m >> 4) & 0xF, m & 0xF,
    (a >> 4) & 0xF, a & 0xF,
    0xF7,
  ]) as SysexMessage;
}

/* CMD 0x2A: per-board min threshold pair (high + low hysteresis). 4-bit each. */
export function buildSetMinThreshold(board: number, minHigh: number, minLow: number): SysexMessage {
  const h = clamp4(minHigh);
  const l = clamp4(minLow);
  return new Uint8Array([
    0xF0,
    SYSEX_MANU[0], SYSEX_MANU[1], SYSEX_MANU[2],
    board, SYSEX_CMD_SET_KEY_MIN_THRESHOLD,
    (h >> 4) & 0xF, h & 0xF,
    (l >> 4) & 0xF, l & 0xF,
    0xF7,
  ]) as SysexMessage;
}

/* CMD 0x08 SET_VELOCITY_CONFIG: 128-byte velocity lookup table (7-bit values).
   Caller passes the LUT in natural order — `lut[i] = output_velocity_at_input_i`
   where i=0 is the slowest press and i=127 is the fastest. The firmware wants
   the table reversed on the wire (per Terpstra driver sendVelocityConfig, lines
   212–223: "shortest ticks count is the highest velocity"). */
export function buildSetVelocityLut(lut: number[]): SysexMessage {
  if (lut.length !== 128) throw new Error('velocity LUT must have 128 entries');
  const bytes: number[] = [
    0xF0,
    SYSEX_MANU[0], SYSEX_MANU[1], SYSEX_MANU[2],
    0x00, SYSEX_CMD_SET_VELOCITY_CONFIG,
  ];
  for (let i = 0; i < 128; i++) bytes.push(lut[127 - i] & 0x7F);
  bytes.push(0xF7);
  return new Uint8Array(bytes) as SysexMessage;
}

/* CMD 0x2B / 0x2C / 0x32: per-board single-value 4-bit setting (CC sensitivity,
   AT sensitivity, or CC active threshold). Sent as 2 nibbles + two zero pads. */
export function buildSetBoardSens(board: number, cmd: number, sensitivity: number): SysexMessage {
  const s = clamp4(sensitivity);
  return new Uint8Array([
    0xF0,
    SYSEX_MANU[0], SYSEX_MANU[1], SYSEX_MANU[2],
    board, cmd,
    (s >> 4) & 0xF, s & 0xF, 0x00, 0x00,
    0xF7,
  ]) as SysexMessage;
}
