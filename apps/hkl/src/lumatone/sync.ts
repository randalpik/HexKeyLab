// Lumatone color sync: diff-based push of all 280 key colors over SysEx.
//
// Builds a fresh target snapshot from current tuning/layout state, computes
// the diff against `lumatone.deviceColors` (with the predicted snapshot
// trick from lessons.md to absorb the in-flight message), and hands the
// resulting message batch to the encapsulated SysEx queue.
//
// First-time-this-connection setup: a one-shot batch of 280 CHANGE_KEY_NOTE
// messages (fixed MIDI layout: channels 1-5 × notes 0-55) plus the global
// aftertouch + keystroke-light flags. Gated by lumatone.fixedLayoutSent so
// re-syncs don't repeat the setup.
//
// A preset switch on the device (one of its preset buttons) replaces all of
// that; watchPresetSwitch sees the firmware's end-of-switch marker and
// resyncLumatoneDevice repeats the setup and the colors.

import { midi } from '../state/midi.js';
import { lumatone } from '../state/lumatone.js';
import { selection } from '../state/selection.js';
import { savePrefs } from '../state/persistence.js';
import { view } from '../state/view.js';
import { lumatoneCell, lumatoneCells } from '../layout/physical.js';
import { animation, smoothstep } from '../render/animation.js';
/* The LED color is the same hueC variant the canvas lightens on hover, so applying
   HOVER_LIGHTEN here changes the device key exactly as the screen key changes. */
import { keyColorHex, lightenHex, HOVER_LIGHTEN } from '../render/colors.js';
import { isRefEditHeld } from "../input/ref-edit.js";
import { isValidRef } from "../state/reference.js";
import { gameKeyLook, GAME_DIM_LED } from "../games/display.js";
import {
  sysexBoardFor, fixedMidiChannelMap,
  SYSEX_CMD_SET_AFTERTOUCH_FLAG, SYSEX_CMD_SET_LIGHT_ON_KEYSTROKES,
  FRAME_FIRMWARE, firmwareAtLeast,
  buildNoteSysEx, buildColorSysEx, buildToggleSysEx, buildFrameSysEx,
} from './protocol.js';
import { sysex } from './sysex.js';
import { hexToOklab, oklabToHex, type Oklab } from './oklab.js';
import { orderColorSync } from './sync-order.js';
import type { SysexMessage } from '../types.js';

/* Firmware 1.5.0+ takes all 280 colors in one 55h frame (~17ms to land on every
   board); older firmware gets the per-key 01h wipe. */
export function frameSyncActive(): boolean {
  return firmwareAtLeast(lumatone.firmware, FRAME_FIRMWARE);
}

/* What a key effect shows changed: the canvas hover (ui/init.ts mousemove /
   mouseleave, cause 'hover') or the ref-edit modifier (input/ref-edit.ts, cause
   'sync'). Shown on the device only with the Key effects checkbox on, and only on
   the frame path. */
export function syncLumatoneKeyEffects(cause: 'hover' | 'sync' = 'hover'): void {
  if (lumatone.keyEffects && frameSyncActive()) syncLumatoneColors(cause);
}

/* Key effects checkbox handler. Re-syncs at once, so turning it off clears whatever
   effect the device is showing and turning it on shows the current ones. */
export function toggleLumatoneKeyEffects(): void {
  const cb = document.getElementById('cbLumaKeyEffects') as HTMLInputElement;
  lumatone.keyEffects = cb.checked;
  savePrefs({ lumatoneKeyEffects: lumatone.keyEffects });
  syncLumatoneColors();
}

/* Brightness a Lumatone key keeps while the ref-edit modifier is held and its cell
   cannot be the reference note: each channel scaled toward off. The device's own
   level, set by eye (Max) and darker than the canvas's cover (REF_DIM_FILL,
   render/colors.ts), which has note names to keep readable. */
export const REF_DIM_LED = 0.3;

/* `hex` with each LED channel scaled to `level` of its value. */
function ledDimHex(hex: string, level: number): string {
  const dim = (at: number): number => Math.round(parseInt(hex.slice(at, at + 2), 16) * level);
  return '#' + ((1 << 24) + (dim(1) << 16) + (dim(3) << 8) + dim(5)).toString(16).slice(1);
}

/* What Lumatone key `i` shows, given its layout color `c`: while a game runs
   (games/display.ts), the game's look of that key — white, the color darkened,
   or the color itself. Applied last, to whatever the key would otherwise show,
   so a game needs nothing from the layout: a ref change slides the darkened
   colors under it like any others. Both transports show it. */
function gameLedColor(i: number, c: string): string {
  const look = gameKeyLook(i);
  return look === 'white' ? '#ffffff' : look === 'dim' ? ledDimHex(c, GAME_DIM_LED) : c;
}

/* Color of lattice cell (q, r) as the frame path shows it: the key color, and with
   Key effects on, the canvas's two per-key effects — lightened when it is the
   hovered cell (the canvas's own amount), then dimmed when the ref-edit modifier
   is held and the cell cannot be a ref (the same cells as the canvas, at the
   device's own level; the canvas paints its dim over the hover too). */
function frameCellColor(q: number, r: number): string {
  let c = keyColorHex(q, r);
  if (!lumatone.keyEffects) return c;
  if (selection.hoverKey === q + "," + r) c = lightenHex(c, HOVER_LIGHTEN);
  if (isRefEditHeld() && !isValidRef(q, r)) c = ledDimHex(c, REF_DIM_LED);
  return c;
}

/* Barycentric weights of fractional lattice point (q, r) over the three cell
   centers around it. Hex centers form a triangular lattice that splits each unit
   rhombus along its m3 diagonal (1,0)–(0,1); barycentric weights are affine-
   invariant, so this equals interpolating on the physical layout, under any
   alignment or mapping. An integer point is its own cell with weight 1. */
export function barycentric(q: number, r: number): [number, number, number][] {
  const q0 = Math.floor(q), r0 = Math.floor(r);
  const a = q - q0, b = r - r0;
  if (a + b <= 1) return [[q0, r0, 1 - a - b], [q0 + 1, r0, a], [q0, r0 + 1, b]];
  return [[q0 + 1, r0 + 1, a + b - 1], [q0 + 1, r0, 1 - b], [q0, r0 + 1, 1 - a]];
}

/* The color field at a fractional lattice point: the barycentric blend of the
   three cells' colors, in OKLab (LED values as linear light; lumatone/oklab.ts).
   Blending the LED values directly redistributes light exactly but reads brighter
   whenever it is spread over several keys (perception is compressive), so a slide
   pulsed at every half-step; OKLab lightness tracks perceived lightness, and its
   blend keeps the board's perceived brightness constant. */
export function sampleField(q: number, r: number, color: (q: number, r: number) => string): string {
  const ws = barycentric(q, r);
  /* On a cell center, return the cell's own string: the diff compares strings, and
     an exact cell must match the non-sliding target byte for byte. */
  const solo = ws.find(([, , w]) => w === 1);
  if (solo) return color(solo[0], solo[1]);
  const mix: Oklab = [0, 0, 0];
  for (const [cq, cr, w] of ws) {
    if (w === 0) continue;
    const lab = hexToOklab(color(cq, cr));
    mix[0] += w * lab[0]; mix[1] += w * lab[1]; mix[2] += w * lab[2];
  }
  return oklabToHex(mix);
}

/* Device-side ref slide (frame path). While the canvas slides the lattice under
   the static outline, each Lumatone key shows what the screen shows beneath it:
   the color field at its cell offset plus a fractional anchor, eased from where
   the device was to kbAnchor on the canvas tween's clock (Date.now), duration and
   easing. Its own raf tick builds one target per animation frame; the queue sends
   the newest at each ACK (latest wins), and the landing frame is exact. */
interface Slide { fromQ: number; fromR: number; toQ: number; toR: number; start: number }
let slideState: Slide | null = null;
let slideRaf: number | null = null;

function slideAnchor(s: Slide, now: number): [number, number] {
  const e = smoothstep(Math.min(1, (now - s.start) / animation.duration));
  return [s.fromQ + (s.toQ - s.fromQ) * e, s.fromR + (s.toR - s.fromR) * e];
}

function slideTick(): void {
  slideRaf = null;
  if (!slideState) return;
  if (Date.now() - slideState.start >= animation.duration) slideState = null; /* land exactly */
  syncLumatoneColors('slide');
  if (slideState) slideRaf = requestAnimationFrame(slideTick);
}

/* The anchor moved by (dq, dr) and the canvas is sliding (effects/onRefChanged):
   slide the device too, from what it shows now — mid-slide, its interpolated
   anchor, so a redirect never jumps. Older firmware keeps the snap. */
export function beginLumatoneSlide(dq: number, dr: number): void {
  if (!frameSyncActive()) { cancelLumatoneSlide(); return; }
  const now = Date.now();
  const [fromQ, fromR] = slideState
    ? slideAnchor(slideState, now)
    : [view.kbAnchorQ - dq, view.kbAnchorR - dr];
  slideState = { fromQ, fromR, toQ: view.kbAnchorQ, toR: view.kbAnchorR, start: now };
  if (slideRaf === null) slideRaf = requestAnimationFrame(slideTick);
}

/* The canvas snapped, so the device snaps: the next sync sends the exact layout. */
export function cancelLumatoneSlide(): void {
  slideState = null;
  if (slideRaf !== null) { cancelAnimationFrame(slideRaf); slideRaf = null; }
}

/* Unified sync entry point. Builds the full queue (setup if needed + color diff),
   then either starts sending or swaps the queue if a push is already running. */
export function syncLumatoneColors(cause: 'hover' | 'sync' | 'slide' = 'sync'): void {
  if (!midi.midiOut || !lumatone.autoSyncEnabled) return;
  /* A device in its built-in calibration answers STATE to everything but the
     calibration end; keycal.ts re-syncs from scratch when the routine is over. */
  if (lumatone.keyCal !== "idle") return;
  const causeAt = performance.now();
  const frames = frameSyncActive();

  /* Compute target colors for all 280 physical keys: the color of the cell
     each key plays (layout/physical.ts). The Lumatone outline is statically
     positioned on screen; the lattice underneath shifts by kbAnchor (only
     updated by user-driven ref changes). On the frame path, with Key effects
     on, a key shows what the canvas does to its cell (frameCellColor: the hover
     lightening, the invalid-ref dimming); mid-slide, each key samples
     the field at its cell offset plus the slide's fractional anchor. A running
     game then has the last word on each key (gameLedColor). */
  const anchor =
    frames && slideState ? slideAnchor(slideState, Date.now()) : null;
  const target: string[] = [];
  for (let i = 0; i < 280; i++) {
    if (anchor) {
      const [u, v] = lumatoneCells[i];
      target.push(gameLedColor(i, sampleField(u + anchor[0], v + anchor[1], frameCellColor)));
      continue;
    }
    const [q, r] = lumatoneCell(i);
    target.push(gameLedColor(i, frames ? frameCellColor(q, r) : keyColorHex(q, r)));
  }
  if (!lumatone.deviceColors)
    lumatone.deviceColors = new Array<string | null>(280).fill(null);

  /* Predicted post-ACK lumatone.deviceColors: factor in the in-flight message.
     Without this, a color message on the wire can ACK after our new queue is
     already built, landing its (now-obsolete) color on the device and leaving
     that key stuck — because the new diff saw lumatone.deviceColors before the ACK
     and decided the key didn't need an update. Prediction closes that race. */
  let predicted: (string | null)[] = lumatone.deviceColors;
  const inFlight = sysex.inFlight;
  if (inFlight && inFlight.frameColors) {
    predicted = inFlight.frameColors;
  } else if (inFlight && inFlight.keyIdx !== undefined) {
    predicted = lumatone.deviceColors.slice();
    predicted[inFlight.keyIdx] = inFlight.color ?? null;
  }

  const newQ: SysexMessage[] = [];

  /* One-time setup: fixed MIDI layout + aftertouch flag + keystroke-light flag */
  if (!lumatone.fixedLayoutSent) {
    const typeByte =
      (1 << 4) | 1; /* faderUpIsNull=1, keyType=noteOnNoteOff=1 → 0x11 */
    for (let i = 0; i < 280; i++) {
      const group = Math.floor(i / 56),
        keyIdx = i % 56;
      const board = sysexBoardFor(group);
      const channel = fixedMidiChannelMap[group];
      newQ.push(buildNoteSysEx(board, keyIdx, keyIdx, channel, typeByte));
    }
    newQ.push(buildToggleSysEx(SYSEX_CMD_SET_AFTERTOUCH_FLAG, 1));
    newQ.push(buildToggleSysEx(SYSEX_CMD_SET_LIGHT_ON_KEYSTROKES, 1));
    lumatone.fixedLayoutSent = true;
  }

  /* Diff predicted vs target — collect changed key indices */
  const changedIdx: number[] = [];
  for (let i = 0; i < 280; i++) {
    if (predicted[i] === target[i]) continue;
    changedIdx.push(i);
  }
  if (frames) {
    /* One frame carries the whole target; latest wins (replaceQueue swaps out any
       frame still waiting behind the one in flight). */
    if (changedIdx.length) {
      const frame = buildFrameSysEx(target);
      frame.cause = cause;
      frame.causeAt = causeAt;
      newQ.push(frame);
    }
  } else {
    /* Top→bottom physical wipe with unconditional board alternation where
       possible. Setup precedes colors; otherwise the in-flight board seeds
       ordering so a mid-push replacement also avoids repeating that board. */
    const previousBoard = newQ.length
      ? newQ[newQ.length - 1][4]
      : inFlight?.[4];
    for (const i of orderColorSync(changedIdx, previousBoard)) {
      const group = Math.floor(i / 56),
        keyIdx = i % 56;
      const board = sysexBoardFor(group);
      newQ.push(buildColorSysEx(board, keyIdx, target[i], i));
    }
  }

  /* Already in sync with the device's predicted state. If a push is running,
     still replace the queue: colors queued behind the in-flight message are now
     stale (e.g. hover left and came back before the in-flight frame's ACK), and
     sending them would leave the device showing the wrong state. */
  if (newQ.length === 0 && !sysex.isInProgress) return;

  /* Option B: swap queue in place, let in-flight message complete naturally.
     The new queue takes over once the wire is free. */
  sysex.replaceQueue(newQ);
}

/* What the device holds can no longer be assumed (a preset was loaded on it; the
   board map changed): forget it and push the fixed layout, the flags and every
   color again. A color message still awaiting its ACK is voided as well, since it
   may have reached the device before the state changed under it. With Auto-sync
   off or a calibration running nothing is sent, and the next sync is a full one. */
export function resyncLumatoneDevice(): void {
  sysex.voidInFlight();
  lumatone.fixedLayoutSent = false;
  lumatone.deviceColors = null;
  syncLumatoneColors();
}

/* A preset button on the Lumatone reloads its key map, key types and colors from
   the preset, one board at a time, and HKL's writes are not held back meanwhile:
   one that reaches a board before its reload is ACKed and then overwritten. The
   firmware ends the switch, once every board has reloaded, with All Notes Off then
   Reset All Controllers on channel 1 (B0 7B 00, B0 79 00), which is the only
   signal that a re-push will stick (docs/lessons.md → "Macro buttons in normal
   mode"). Called with every inbound channel message (midi/handler.ts): the second
   message directly after the first re-pushes; anything in between disarms. */
let allNotesOffSeen = false;
export function watchPresetSwitch(data: Uint8Array): void {
  const armed = allNotesOffSeen;
  allNotesOffSeen = false;
  if (data.length !== 3 || data[0] !== 0xB0 || data[2] !== 0) return;
  if (data[1] === 123) allNotesOffSeen = true;
  else if (data[1] === 121 && armed) resyncLumatoneDevice();
}

/* Auto-sync checkbox handler. */
export function toggleAutoSync(): void {
  const cb = document.getElementById('cbAutoSync') as HTMLInputElement;
  lumatone.autoSyncEnabled = cb.checked;
  savePrefs({ autoSync: lumatone.autoSyncEnabled });
  if (lumatone.autoSyncEnabled) {
    /* OFF → ON: full initial sync (setup + all colors). If no device connected
       yet, this no-ops; findLumatone will pick up the state on next connection. */
    if (midi.midiOut) syncLumatoneColors();
  } else {
    /* ON → OFF: cancel in-flight work. Leave device in whatever state it's in;
       lumatone.deviceColors remains valid best-known state for a future re-enable. */
    sysex.cancel();
  }
}
