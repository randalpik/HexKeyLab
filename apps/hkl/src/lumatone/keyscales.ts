// Per-key press-time scales, made from the calibration the Lumatone holds.
//
// For the same touch a key's press time follows its timing window, the stretch
// of its travel the board times a press over (docs/lessons.md → "Press time
// follows the timing window"), and the windows a calibration learns differ from
// key to key by a factor of several. HKL evens that out with one number per key
// that multiplies the key's press time before the velocity curve
// (audio/velocityCal.ts → keyTicks).
//
// The numbers need each key's learned MAX and MIN and its board's `max` and
// `min lo` thresholds. All of it is read over SysEx (19h, 1Ah and 3Ah per board,
// read only), so the scales follow the device with no file and no step for the
// player: they are read with every setup, after a built-in calibration ends, and
// after a per-board threshold is changed from HKL. What velocityCal keeps is a
// copy of the last read, so a page opened before the device answers plays with
// the table it had.
//
// The arithmetic is tools/lumatone-cal/keydata-compare.py --scales, which works
// from a saved copy of the same values; test/hkl-midi/key-scale.mjs holds the
// two to the same table.

import { sysex } from './sysex.js';
import { lumatone } from '../state/lumatone.js';
import {
  sysexBoardFor, KEYS_PER_BOARD, SYSEX_BUSY,
  SYSEX_CMD_GET_KEY_MAX, SYSEX_CMD_GET_KEY_MIN, SYSEX_CMD_GET_BOARD_THRESHOLDS,
  buildBoardRequestSysEx, parseKeyParams, parseBoardThresholds,
} from './protocol.js';
import { velocityCal, KEY_SCALE_MIN, KEY_SCALE_MAX } from '../audio/velocityCal.js';
import type { LumatoneKeyId } from '../types.js';

/** One board's calibration: the 56 per-key MAX and MIN values, and the counts
 *  its thresholds leave out of every key's window (`max` + `min lo`). */
export interface BoardCalibration {
  max: number[];
  min: number[];
  overhead: number;
}

export interface KeyScales {
  /** The scale of every key that has a timing window, by physical key. */
  scales: Record<LumatoneKeyId, number>;
  /** The median window, in sensor counts: the key that keeps its feel. */
  reference: number;
  /** Keys whose window is zero or less (no press time to scale): left out. */
  noWindow: LumatoneKeyId[];
  /** Keys whose scale fell outside KEY_SCALE_MIN…KEY_SCALE_MAX and was held. */
  held: LumatoneKeyId[];
}

/** The scales of one calibration: the median window over each key's own window.
 *  `boards[g]` is board group g (0…4, HKL's channel − 1), whichever SysEx board
 *  that group is wired to. A key's window is MAX − MIN − (`max` + `min lo`): the
 *  press timer starts at MIN + `min lo` and the note-on fires above MAX − `max`. */
export function computeKeyScales(boards: readonly BoardCalibration[]): KeyScales {
  const windows: number[] = [];
  for (const b of boards) for (let k = 0; k < KEYS_PER_BOARD; k++) windows.push(b.max[k] - b.min[k] - b.overhead);
  const sorted = windows.slice().sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  const reference = sorted.length === 0 ? 0 : sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const out: KeyScales = { scales: {}, reference, noWindow: [], held: [] };
  windows.forEach((w, i) => {
    const key = (Math.floor(i / KEYS_PER_BOARD) + 1) + ',' + (i % KEYS_PER_BOARD);
    if (w <= 0) { out.noWindow.push(key); return; }
    if (!(reference > 0)) return; /* most keys have no window: nothing to scale to */
    let scale = reference / w;
    if (scale < KEY_SCALE_MIN || scale > KEY_SCALE_MAX) {
      out.held.push(key);
      scale = scale < KEY_SCALE_MIN ? KEY_SCALE_MIN : KEY_SCALE_MAX;
    }
    out.scales[key] = scale;
  });
  return out;
}

/** Where the scales in use came from. `read`: this session read them from the
 *  device. `reading`: a read is under way. `failed`: the last read did not
 *  complete, and the table from before it is still in use. `none`: no read has
 *  been tried this session (the table, if any, is the saved copy). */
export interface KeyScaleStatus {
  state: 'none' | 'reading' | 'read' | 'failed';
  /** Of the last completed read: keys scaled, the smallest and largest scale. */
  count: number;
  min: number;
  max: number;
  noWindow: number;
}

const status: KeyScaleStatus = { state: 'none', count: 0, min: 1, max: 1, noWindow: 0 };
const listeners: (() => void)[] = [];
let generation = 0;
let giveUpTimer: number | null = null;
const READ_TIMEOUT_MS = 15000;

function setState(state: KeyScaleStatus['state']): void {
  status.state = state;
  for (const fn of listeners) fn();
}

export function keyScaleStatus(): Readonly<KeyScaleStatus> { return status; }
export function onKeyScaleChange(fn: () => void): void { listeners.push(fn); }

/** Read the calibration from the device and replace the scales with what it
 *  gives. Fifteen read-only requests; a later call supersedes one still under
 *  way. Nothing is changed unless every board answers all three. Returns false
 *  when nothing was sent (no Lumatone, or one in its calibration routine, which
 *  answers nothing else: keycal.ts calls again when the routine is over). */
export function refreshKeyScales(): boolean {
  if (lumatone.keyCal !== 'idle') return false;
  const gen = ++generation;
  const boards: Partial<BoardCalibration>[] = [{}, {}, {}, {}, {}];
  let pending = 15;
  const fail = (): void => {
    if (gen !== generation) return;
    generation++; /* the rest of this read's replies are ignored */
    if (giveUpTimer !== null) { clearTimeout(giveUpTimer); giveUpTimer = null; }
    console.warn('[keyscales] the calibration read did not complete; key scales unchanged');
    setState('failed');
  };
  const done = (): void => {
    if (--pending > 0) return;
    if (giveUpTimer !== null) { clearTimeout(giveUpTimer); giveUpTimer = null; }
    const result = computeKeyScales(boards as BoardCalibration[]);
    velocityCal.setKeyScales(result.scales);
    const vals = Object.values(result.scales);
    status.count = vals.length;
    status.min = vals.length ? Math.min(...vals) : 1;
    status.max = vals.length ? Math.max(...vals) : 1;
    status.noWindow = result.noWindow.length;
    console.log('[keyscales] ' + vals.length + ' key scales from the device\'s calibration: reference window '
      + result.reference + ' counts, scales ' + status.min.toFixed(2) + '…' + status.max.toFixed(2)
      + (result.noWindow.length ? '; no timing window: ' + result.noWindow.join(' ') : '')
      + (result.held.length ? '; held to the range: ' + result.held.join(' ') : ''));
    setState('read');
  };
  /* A reply that is BUSY comes again after the queue's retry; any other refusal
     ends the read. */
  const request = (group: number, cmd: number, take: (data: Uint8Array) => boolean): boolean => {
    const msg = buildBoardRequestSysEx(sysexBoardFor(group), cmd);
    msg.onResponse = (data: Uint8Array) => {
      if (gen !== generation || data[6] === SYSEX_BUSY) return;
      if (take(data)) done(); else fail();
    };
    return sysex.enqueueControl(msg);
  };
  for (let g = 0; g < 5; g++) {
    const b = boards[g];
    const sent = request(g, SYSEX_CMD_GET_KEY_MAX, (d) => { const v = parseKeyParams(d); if (v) b.max = v; return !!v; })
      && request(g, SYSEX_CMD_GET_KEY_MIN, (d) => { const v = parseKeyParams(d); if (v) b.min = v; return !!v; })
      && request(g, SYSEX_CMD_GET_BOARD_THRESHOLDS, (d) => {
        const t = parseBoardThresholds(d);
        if (t) b.overhead = t.max + t.minLow;
        return !!t;
      });
    if (!sent) { generation++; return false; }
  }
  if (giveUpTimer !== null) clearTimeout(giveUpTimer);
  giveUpTimer = window.setTimeout(() => { giveUpTimer = null; fail(); }, READ_TIMEOUT_MS);
  setState('reading');
  return true;
}
