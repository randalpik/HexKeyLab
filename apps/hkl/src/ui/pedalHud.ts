// Pedal HUD: tiny fixed-position readout of CC 4 / CC 64 / damper / sustained
// counts, plus a console-accessible ring-buffer dump and a "force clear" helper.
//
// All three were added to chase an intermittent stuck-sustain bug: the user
// reports notes occasionally ringing loudly after release until the pedal is
// pressed once more, which means cc4Depth or cc64Depth diverged from the
// physical pedal position (a single MIDI CC release message was lost upstream
// of the handler — see the plan file for the full brainstorm).
//
// What this module does NOT do:
//   • It does not change any audio behaviour.
//   • It does not auto-clear stuck state (we want the bug observable, not
//     papered over). pedal.clear() is a manual workaround / hypothesis test.
//
// Build is lazy via ensurePedalHud(); setPedalHudVisible() toggles display.
// On module load, the debug helpers are attached to the pedal state object
// (so DevTools sees `pedal.dumpRecent()` and `pedal.clear()`), and the pedal
// object is mirrored to `window.pedal` for console reach.

import { audio } from '../state/audio.js';
import { pedal } from '../state/pedal.js';
import {
  setDamperDepth, sostenutoOff,
} from '../audio/engine.js';
import { onSelectionChanged } from '../effects/onSelectionChanged.js';

let domBuilt = false;
let enabled = false;
let panel: HTMLDivElement | null = null;
let rafId = 0;

/* Tick rate is throttled to ~20 Hz — the readout is for human consumption,
   not signal analysis, so the rAF loop does its work then skips frames. The
   damper smoothing happens in the audio engine; HUD just samples state. */
const TICK_INTERVAL_MS = 50;
let lastTick = 0;

export function ensurePedalHud(): void {
  if (domBuilt) return;
  domBuilt = true;
  panel = document.createElement('div');
  panel.id = 'pedalHud';
  Object.assign(panel.style, {
    position: 'fixed',
    top: '8px',
    right: '8px',
    color: 'rgba(255,255,255,0.9)',
    font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
    background: 'rgba(0,0,0,0.72)',
    padding: '6px 10px',
    borderRadius: '4px',
    zIndex: '10000',
    pointerEvents: 'none',
    userSelect: 'none',
    whiteSpace: 'pre',
    lineHeight: '1.35',
    display: 'none',
  });
  document.body.appendChild(panel);
  console.log('%c[pedaldiag] HUD built · pedal.dumpRecent() · pedal.clear()',
    'color:#0ff;font-weight:bold');
}

export function setPedalHudVisible(visible: boolean): void {
  if (!domBuilt) return;
  enabled = visible;
  if (panel) panel.style.display = visible ? 'block' : 'none';
  if (visible && rafId === 0) {
    rafId = requestAnimationFrame(tick);
  } else if (!visible && rafId !== 0) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

function tick(t: number): void {
  if (!enabled) { rafId = 0; return; }
  rafId = requestAnimationFrame(tick);
  if (t - lastTick < TICK_INTERVAL_MS) return;
  lastTick = t;
  if (!panel) return;
  const cc4 = pedal.lastCC4Value;
  const cc4Pct = (pedal.cc4Depth * 100).toFixed(1);
  const cc64 = pedal.lastCC64Value;
  const cc64State = pedal.cc64Depth > 0 ? 'on' : 'off';
  const depth = audio.damperDepth.toFixed(3);
  const susCount = audio.sustainedKeys.size;
  const sosCount = audio.sostenutoLockedKeys.size;
  /* When depth is non-zero but no CC of any kind has arrived recently, we
     tint the panel — most likely the divergence we're hunting. The user
     uses both jacks (CC 4 or CC 64), so look at the ring buffer tail
     rather than lastCC4Time to cover both. 1.5 s is well past any realistic
     in-flight pedal motion. */
  const lastEvt = pedal.recentEvents.length
    ? pedal.recentEvents[pedal.recentEvents.length - 1]
    : null;
  const sinceLastCC = lastEvt ? performance.now() - lastEvt.t : Infinity;
  const stale = audio.damperDepth > 0.005 && sinceLastCC > 1500;
  panel.style.color = stale ? '#fa6' : 'rgba(255,255,255,0.9)';
  panel.textContent =
    'CC4:   ' + (cc4 === null ? '—' : String(cc4).padStart(3, ' ')) + '  (' + cc4Pct.padStart(5, ' ') + '%)\n' +
    'CC64:  ' + (cc64 === null ? '—' : String(cc64).padStart(3, ' ')) + '  (' + cc64State + ')\n' +
    'depth: ' + depth + (stale ? '  ⚠ stale' : '') + '\n' +
    'sus:   ' + susCount + '   sostenuto: ' + sosCount + '\n' +
    'mode:  ' + pedal.mode;
}

/* Pretty-print the tail of the ring buffer. Default tail = 30 entries; pass
   a larger n to see more. Times are shown as ms-relative-to-now so the eye
   can scan for the "no recent release" pattern at a glance. */
function dumpPedalRecent(n: number = 30): void {
  const buf = pedal.recentEvents;
  if (buf.length === 0) {
    console.log('[pedaldiag] recentEvents is empty');
    return;
  }
  const tail = buf.slice(Math.max(0, buf.length - n));
  const now = performance.now();
  /* Use console.table for a readable grid in DevTools. Add a relative-time
     column ahead of the raw t for quick scanning. */
  const rows = tail.map((e) => ({
    'Δt (ms)': (e.t - now).toFixed(0),
    cc: e.cc,
    value: e.value,
    ch: e.ch,
    depthAfter: e.depthAfter.toFixed(3),
  }));
  console.log('[pedaldiag] last ' + rows.length + ' of ' + buf.length + ' pedal CCs:');
  console.table(rows);
}

/* Force pedal state to "fully released" and run the engine release loop.
   Intended as both an in-the-moment workaround when the bug happens and a
   diagnostic: if this restores normal behaviour, the bug is definitively
   software-state divergence (lost CC). If it doesn't, the cause is
   elsewhere (sostenuto lock, voice graph, etc.) and the user should
   capture audio.sustainedKeys / audio.sostenutoLockedKeys for inspection. */
function clearPedalState(): void {
  pedal.cc4Depth = 0;
  pedal.cc64Depth = 0;
  /* setDamperDepth handles releasing sustainedKeys via the normal path and
     calls onSelectionChanged when keys actually release. */
  setDamperDepth();
  /* sostenutoOff is a no-op if not active, and itself decides whether to
     release locked keys based on current damperDepth. After the cc clears
     above damperDepth is 0, so any keys locked by sostenuto will release. */
  sostenutoOff();
  /* If neither setDamperDepth nor sostenutoOff fired onSelectionChanged
     (e.g. sustainedKeys was already empty when called) the visual still
     needs to reflect the cleared state — fire once explicitly. */
  onSelectionChanged();
  console.log('[pedaldiag] cleared pedal state');
}

/* Attach helpers to the pedal object so DevTools usage is `pedal.dumpRecent()`
   and `pedal.clear()`. Also bridge pedal to window so `pedal` is reachable
   from the console without an import. Always wired regardless of HUD
   visibility — the helpers are useful even when the panel is hidden. */
pedal.dumpRecent = dumpPedalRecent;
pedal.clear = clearPedalState;
interface PedalWindow extends Window {
  pedal?: typeof pedal;
}
(window as PedalWindow).pedal = pedal;
