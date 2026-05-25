// HKL Composer entry point. Wires the bridge, model, renderer, cursor, and
// keyboard input into one running app.
//
// Lifecycle:
//   1. Construct ComposerModel (empty score).
//   2. Attach renderer to #score; cursor overlay to #cursorOverlay.
//   3. Open BroadcastChannel; respond to held-keys / hkl-hello / etc.
//   4. Wait for Verovio WASM to load (CDN script tag injected by render.ts).
//   5. Render initial empty staff.
//   6. Wire keyboard input.
//   7. Re-render + update cursor on any model change.

import { createComposerBridge, PROTOCOL_VERSION } from '../bridge/channel.js';
import type { HklEvent, ResolvedNote, FootprintCell } from '../bridge/protocol.js';
import { ComposerModel } from './model/index.js';
import { renderer, ZOOM_PRESETS, type ZoomLevel } from './render/render.js';
import { cursor } from './cursor/cursor.js';
import { initInput, getInputState, installSCTransposeImpl } from './input.js';
import { scTransposeChordNote } from './notation/scTranspose.js';
import { HistoryManager } from './history.js';
import type { CursorUpdateOpts } from './cursor/cursor.js';
import { selectionOverlay } from './selection/selectionOverlay.js';
import { saveHkc, loadHkcFromFile, downloadMusicXml, downloadPdf } from './save.js';
import { buildPlayback, highlightElement, clearHighlights, readTempo, tickMsFromTempo } from './render/playback.js';
import { openSetupDialog } from './setupDialog.js';
import {
  computePrevNoteRef, computeSongKeyRef,
  refNoteChanged, invalidateRefNoteCache,
  songKeyChanged, invalidateSongKeyCache,
} from './cursor/refNote.js';

const $ = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

let hklConnected = false;
let lastHeldKeys: ReadonlyArray<ResolvedNote> = [];
let isPlaying = false;
/* HKL's current tuning mode, cached from the `tuning-changed` broadcast. Null
 * until first broadcast arrives. Used by the entry-mismatch gate (input.ts)
 * to compare against the score's pinned layoutReq.tuningMode. */
let hklTuningMode: string | null = null;
/* Latched once we've consumed the first hkl-layout-state at this session's
 * startup. The first arrival of that message on a blank score silently adopts
 * HKL's tuning + ref into the score's layoutReq, so the user doesn't have to
 * open Setup and copy it manually. Subsequent state changes leave the score
 * alone (so a manual Setup edit is preserved). Reset when a file is loaded so
 * the loaded layoutReq isn't overwritten. */
let autoAdoptedHklLayout = false;

/* Cached HKL footprint: each cell carries q, r, and a fresh colorHex.
 *   - `null` while we haven't received a footprint yet (no constraint).
 *   - empty Map means outline='none' on HKL — also "no constraint".
 * scTranspose uses this both for layout validation AND to write the new
 * `color` attribute on a transposed note, keeping HKL/Composer in sync. */
let footprintColors: Map<string, string> | null = null;
/* Editing cursor snapshot taken at playback start, restored on stop/finish. */
let preplaybackVoice: 1 | 2 | 3 | 4 = 1;
let preplaybackCursor = 0;
const SCROLL_PAD = 24;

/* Visibility-checked on every call: cheap (one getBoundingClientRect +
   comparisons) and idempotent — when the measure is already in view, no
   scrollTo fires. Skipping a same-measure-idx debounce was deliberate:
   in page view, adding to a measure can reflow it to a new system, moving
   the cursor off-screen even though the measure index hasn't changed. */
function maybeScrollMeasureIntoView(measureIdx: number): void {
  if (measureIdx < 0) return;
  const measures = model.allMeasures();
  if (measureIdx >= measures.length) return;
  const id = measures[measureIdx]?.getAttribute('xml:id');
  if (!id) return;
  const rect = renderer.rectForId(id);
  const score = $('score');
  if (!rect || !score) return;
  const PAD = SCROLL_PAD;
  const cw = score.clientWidth;
  const ch = score.clientHeight;
  const visibleL = score.scrollLeft;
  const visibleR = visibleL + cw;
  const visibleT = score.scrollTop;
  const visibleB = visibleT + ch;

  /* Minimal-scroll: align the nearest off-screen edge to the viewport edge
     (plus PAD breathing room), rather than always aligning the top/left.
     Without this, scrolling to the last system in page view aligns its
     top to the viewport top — overshooting badly when the system is
     already mostly in view at the bottom. When the measure is larger than
     the viewport (with PAD reserved), fall back to top/left alignment. */
  let targetLeft = score.scrollLeft;
  if (rect.width + 2 * PAD > cw) {
    targetLeft = Math.max(0, rect.left - PAD);
  } else if (rect.left < visibleL + PAD) {
    targetLeft = Math.max(0, rect.left - PAD);
  } else if (rect.right > visibleR - PAD) {
    targetLeft = Math.max(0, rect.right - cw + PAD);
  }

  let targetTop = score.scrollTop;
  if (rect.height + 2 * PAD > ch) {
    targetTop = Math.max(0, rect.top - PAD);
  } else if (rect.top < visibleT + PAD) {
    targetTop = Math.max(0, rect.top - PAD);
  } else if (rect.bottom > visibleB - PAD) {
    targetTop = Math.max(0, rect.bottom - ch + PAD);
  }

  if (targetLeft !== score.scrollLeft || targetTop !== score.scrollTop) {
    score.scrollTo({ left: targetLeft, top: targetTop, behavior: 'smooth' });
  }
}

function visualCursorMeasure(): number {
  const s = getInputState();
  return model.cursorMeasureIdx(model.getCurrentVoice(), s.mode);
}

type StatusKind = 'info' | 'error' | 'state' | 'action';
type StatusSource = 'default' | 'held-keys' | 'other';

let statusKind: StatusKind = 'info';
let statusSource: StatusSource = 'default';
const STATUS_CLASSES = ['status-error', 'status-state', 'status-action'];

function setStatus(text: string, kind: StatusKind = 'info', source: StatusSource = 'other'): void {
  const el = $('composerStatus');
  if (!el) return;
  el.textContent = text;
  el.classList.remove(...STATUS_CLASSES);
  if (kind === 'error')  el.classList.add('status-error');
  if (kind === 'state')  el.classList.add('status-state');
  if (kind === 'action') el.classList.add('status-action');
  statusKind = kind;
  statusSource = source;
}

function resetStatus(): void {
  setStatus('Ready.', 'info', 'default');
}

function clearStatusIfTransient(): void {
  /* Errors and post-action reports both go stale the moment the user does
     anything else — clear both on the next keystroke. State messages
     (blue) describe ongoing context (selection range, pending hairpin,
     held keys, etc.) and clear via their own mechanisms instead. */
  if (statusKind === 'error' || statusKind === 'action') resetStatus();
}

function clearStatusIfHeldKeys(): void {
  if (statusSource === 'held-keys') resetStatus();
}

function setConn(state: 'no-hkl' | 'connected' | 'standalone'): void {
  const el = $('connStatus');
  if (!el) return;
  el.classList.remove('connected', 'standalone');
  if (state === 'connected') {
    el.textContent = 'HKL connected';
    el.classList.add('connected');
  } else if (state === 'standalone') {
    el.textContent = 'standalone';
    el.classList.add('standalone');
  } else {
    el.textContent = 'no HKL';
  }
}

function refreshIndicators(): void {
  const s = getInputState();
  const voice = model.getCurrentVoice();
  const v = $('voiceIndicator');         if (v) v.textContent = s.cursorMode === 'expr' ? 'E' : String(voice);
  const d = $('durationIndicator');      if (d) d.textContent = s.duration;
  const m = $('modeIndicator');          if (m) m.textContent = s.mode === 'insert' ? 'INS' : 'OVR';
}

function cursorOpts(): CursorUpdateOpts {
  const s = getInputState();
  return {
    entryMode: s.mode,
    cursorMode: s.cursorMode,
    exprCursor: s.exprCursor,
    chordInternalSel: s.chordInternalSel
      ? { noteId: s.chordInternalSel.noteId }
      : null,
  };
}

/* ── model + bridge ──────────────────────────────────────────────────────── */

const model = new ComposerModel();
const bridge = createComposerBridge();
const history = new HistoryManager();

bridge.on((msg: HklEvent) => {
  switch (msg.type) {
    case 'hkl-hello': {
      /* Re-announce ourselves so HKL learns Composer is present when HKL
         boots second. Composer's load-time composer-hello was lost (no HKL
         listening yet); without this echo HKL would never set
         composerConnected and the toolbar group stays hidden. Gate on the
         pre-existing hklConnected flag so we ONLY echo on a fresh
         connection — otherwise HKL's announce() (which it fires on every
         composer-hello) ricochets back here as a second hkl-hello and we'd
         echo composer-hello again, creating an infinite handshake loop. */
      const wasConnected = hklConnected;
      hklConnected = true;
      setConn('connected');
      if (!wasConnected) {
        bridge.send({ type: 'composer-hello', version: PROTOCOL_VERSION });
      }
      invalidateRefNoteCache();
      invalidateSongKeyCache();
      maybeBroadcastReference();
      maybeBroadcastSongKey();
      broadcastLayoutReq();
      break;
    }
    case 'hkl-bye':
      hklConnected = false;
      setConn('no-hkl');
      lastHeldKeys = [];
      stopPlayback();
      invalidateRefNoteCache();
      invalidateSongKeyCache();
      break;
    case 'held-keys':
      lastHeldKeys = msg.keys;
      /* Echo held-keys as STATE while any are down; clear back to default
         when the user releases — but only if the bar is still showing the
         held-keys echo (don't clobber an unrelated state/action message). */
      if (msg.keys.length > 0) {
        setStatus(
          'held: ' + msg.keys.map((k) => k.pname.toUpperCase() + (k.accid || '') + k.oct).join(' '),
          'state',
          'held-keys',
        );
      } else {
        clearStatusIfHeldKeys();
      }
      break;
    case 'tuning-changed':
      /* Cache HKL's current tuning mode for the entry-mismatch gate. The
         layoutReq pins what the score requires; comparing the two tells us
         whether entry/playback would change pitch from what the user expects. */
      hklTuningMode = msg.mode;
      refreshLayoutMatchIndicator();
      break;
    case 'hkl-layout-state': {
      /* Blank-score auto-adopt: first arrival of HKL's full layout state on
         a score with no notes silently mirrors HKL's tuning + ref into the
         score's layoutReq. Reduces friction when starting a new piece against
         a connected HKL instance. Latch so we only do this once per session;
         a subsequent ref or tuning change on HKL doesn't override a Setup
         edit the user may have made in between. */
      hklTuningMode = msg.tuningMode;
      if (!autoAdoptedHklLayout && !model.hasNotes()) {
        autoAdoptedHklLayout = true;
        const isMode = (s: string): s is 'E' | '5' | 'P' | 'D' | '7' | 'V' =>
          s === 'E' || s === '5' || s === 'P' || s === 'D' || s === '7' || s === 'V';
        const tuningMode = isMode(msg.tuningMode) ? msg.tuningMode : '5';
        model.setLayoutReq({ tuningMode, refQ: msg.refQ, refR: msg.refR });
        broadcastLayoutReq();
      }
      refreshLayoutMatchIndicator();
      break;
    }
    case 'playback-position':
      highlightElement(msg.meiId, $('score'));
      /* Route per-voice: each voice gets its own cursor bar at the chord
         it's currently sounding. The editing cursor stays parked at the
         pre-playback position. */
      if (msg.meiId) {
        const loc = model.findElement(msg.meiId);
        if (loc) cursor.setPlaybackPosition(loc.voice, msg.meiId);
        const mIdx = model.getMeasureIdxForId(msg.meiId);
        if (mIdx >= 0) maybeScrollMeasureIntoView(mIdx);
      }
      break;
    case 'playback-finished':
      finalizePlaybackEnd('Playback finished.');
      break;
    case 'footprint-changed': {
      /* Rebuild the cache. Empty cells = outline='none' = no constraint. */
      const map = new Map<string, string>();
      for (const cell of msg.cells) {
        map.set(cell[0] + ',' + cell[1], cell[2]);
      }
      footprintColors = map;
      break;
    }
  }
});

/** Read the cached footprint. Returns null when HKL hasn't broadcast one
 *  yet (treat as "no constraint"), an empty map when HKL's outline is set
 *  to 'none' (also "no constraint" — caller decides whether to allow), or
 *  a populated map keyed by "q,r" with the fresh per-cell color. */
export function getFootprintColors(): Map<string, string> | null {
  return footprintColors;
}

/** HKL's most-recently-broadcast tuning mode, or null if no broadcast yet.
 *  Used by the entry-mismatch gate to compare against the score's required
 *  tuning. */
export function getHklTuningMode(): string | null {
  return hklTuningMode;
}

/** Broadcast the score's pinned layout requirement to HKL. Called on
 *  composer-hello and on Setup save / file load. Idempotent on HKL side. */
function broadcastLayoutReq(): void {
  if (!hklConnected) return;
  const lr = model.getLayoutReq();
  bridge.send({
    type: 'layout-req-changed',
    tuningMode: lr.tuningMode,
    refQ: lr.refQ,
    refR: lr.refR,
  });
}

/** Tell HKL to apply this exact layout right now, regardless of its Sync
 *  setting. Used by the entry-mismatch prompt after the user confirms Apply.
 *  HKL will emit a `tuning-changed` we can re-check against. */
export function requestApplyLayout(): void {
  if (!hklConnected) return;
  const lr = model.getLayoutReq();
  bridge.send({
    type: 'apply-layout',
    tuningMode: lr.tuningMode,
    refQ: lr.refQ,
    refR: lr.refR,
  });
}

/** Update the toolbar match indicator. Visible only when HKL is connected. */
function refreshLayoutMatchIndicator(): void {
  const el = $('layoutMatch');
  if (!el) return;
  if (!hklConnected || hklTuningMode === null) {
    el.textContent = '';
    return;
  }
  const lr = model.getLayoutReq();
  el.textContent = hklTuningMode === lr.tuningMode ? '✓' : '⚠ mismatch';
  el.classList.toggle('mismatch', hklTuningMode !== lr.tuningMode);
}

bridge.send({ type: 'composer-hello', version: PROTOCOL_VERSION });
bridge.send({ type: 'request-state' });

/** Send the current "most-recent-prior-to-cursor" note to HKL's selection
 *  tier — but ONLY if such a note exists. If the cursor has no prior note,
 *  stay silent (HKL retains whatever selection it already holds, possibly a
 *  user Ctrl+click). The diff filter drops redundant broadcasts cheaply. */
function maybeBroadcastReference(): void {
  const coord = computePrevNoteRef(model);
  if (coord !== null && refNoteChanged(coord)) {
    bridge.send({ type: 'set-reference-note', q: coord.q, r: coord.r });
  } else if (coord === null) {
    /* Mark cache so the next non-null coord re-broadcasts even if equal to
       the prior broadcast (HKL's tier may have been cleared meanwhile). */
    refNoteChanged(null);
  }
}

/** Send the current key-sig tonic to HKL's song-key tier. Called on
 *  connect / hello and on explicit key-signature change (Setup dialog),
 *  NOT on every cursor move — the key sig is independent of cursor and
 *  re-broadcasting it through cursor-driven paths risks the same "clobbers
 *  manual" failure mode that motivated dropping set-reference-note's
 *  key-sig fallback. */
function maybeBroadcastSongKey(): void {
  const coord = computeSongKeyRef(model);
  if (songKeyChanged(coord)) {
    bridge.send({ type: 'set-song-key', q: coord.q, r: coord.r });
  }
}

window.setTimeout(() => {
  if (!hklConnected) {
    setConn('standalone');
  }
}, 1000);

window.addEventListener('beforeunload', () => {
  bridge.send({ type: 'composer-bye' });
});

/* ── render pipeline ─────────────────────────────────────────────────────── */

function reRender(): void {
  try {
    renderer.render(model.serialize());
    /* Verovio just rewrote #score's innerHTML — re-attach the cursor overlay
       as a sibling of the rendered SVG (in scroll mode) or as a sibling of
       the .score-page wrappers (in page mode), positioned absolute at #score's
       (0, 0). The overlay is sized to cover from (0, 0) to the Verovio SVG's
       bottom-right in container-local coords. That way, cursor markers drawn
       at the container-local coordinates returned by renderer.rectForId()
       land at the correct visual position over the SVG even when the SVG is
       offset from #score's origin by a .score-page wrapper's margin. */
    const scoreEl = $('score');
    if (!scoreEl) return;
    const verovioSvg = scoreEl.querySelector('svg:not(#cursorOverlay)') as SVGSVGElement | null;
    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.id = 'cursorOverlay';
    if (verovioSvg) {
      const scoreRect = scoreEl.getBoundingClientRect();
      const svgRect = verovioSvg.getBoundingClientRect();
      const overlayW = svgRect.right - scoreRect.left + scoreEl.scrollLeft;
      const overlayH = svgRect.bottom - scoreRect.top + scoreEl.scrollTop;
      overlay.setAttribute('width', String(Math.max(0, overlayW)));
      overlay.setAttribute('height', String(Math.max(0, overlayH)));
    }
    scoreEl.appendChild(overlay);
    cursor.attach(overlay);
    selectionOverlay.attach(overlay);
    cursor.update(model, cursorOpts());
    selectionOverlay.update(model, getInputState().selection);
  } catch (e) {
    setStatus('render error: ' + (e as Error).message, 'error');
  }
}

async function bootRenderer(): Promise<void> {
  const scoreEl = $('score');
  if (!scoreEl) {
    setStatus('FATAL: #score element missing.', 'error');
    return;
  }
  setStatus('Loading Verovio WASM…', 'info');
  try {
    await renderer.ready();
  } catch (e) {
    setStatus('Verovio failed to load: ' + (e as Error).message, 'error');
    return;
  }
  renderer.attach(scoreEl);
  reRender();
  console.log('Verovio ' + renderer.getVersion());
  resetStatus();
  refreshIndicators();
}

/* ── input wiring ────────────────────────────────────────────────────────── */

function stepZoom(dir: 'in' | 'out'): void {
  const cur = renderer.getZoom();
  const idx = ZOOM_PRESETS.indexOf(cur);
  const nextIdx = dir === 'in'
    ? Math.min(ZOOM_PRESETS.length - 1, idx + 1)
    : Math.max(0, idx - 1);
  const next: ZoomLevel = ZOOM_PRESETS[nextIdx];
  if (next === cur) {
    setStatus('Zoom ' + cur + '% (' + (dir === 'in' ? 'max' : 'min') + ').', 'action');
    return;
  }
  renderer.setZoom(next);
  reRender();
  maybeScrollMeasureIntoView(visualCursorMeasure());
  setStatus('Zoom ' + next + '%.', 'action');
}

/* Install the SC-transpose implementation that the Alt+Left/Right handler
   in input.ts dispatches to. Wires via the indirection there to keep
   input.ts free of a hard import on scTranspose (so the keystroke wiring
   can be tested independently). */
installSCTransposeImpl((m, hooks, sel, dir) => {
  const before = m.snapshotState();
  const result = scTransposeChordNote(m, hooks, sel, dir, footprintColors);
  if (!result.ok) return;
  history.push(before, m.snapshotState(), 'sc-transpose');
  hooks.onStateChange();
  hooks.onChange();
  /* Audible preview: play the full vertical slice at the chord's start
     moment (every sounding note in every voice) so the user hears how the
     SC shift retuned the chord's harmony. Only fires when HKL is connected
     — Composer doesn't own the audio engine. */
  if (hklConnected && result.previewNotes.length > 0) {
    const tickMs = tickMsFromTempo(readTempo(m.getDoc()));
    const durationMs = Math.max(250, result.previewTicks * tickMs);
    bridge.send({
      type: 'play-score',
      events: [{
        atMs: 0,
        durationMs,
        notes: result.previewNotes,
      }],
    });
  }
});

initInput(model, {
  getHeldKeys: () => lastHeldKeys,
  onChange: () => {
    reRender();
    /* Scroll-into-view belongs after reRender so it sees the new layout —
       crucial for reflow (a new measure created by insertion at past-end,
       or an addition that pushes the current measure to a new system).
       Several input.ts call sites fire onStateChange before onChange, so
       running scroll in onChange ensures it always sees the post-reRender
       geometry regardless of caller order. */
    if (!isPlaying) maybeScrollMeasureIntoView(visualCursorMeasure());
    /* Content change: most recent prior-to-cursor element may have changed
       (insert/delete) → recompute the reference note and broadcast. */
    if (hklConnected) maybeBroadcastReference();
  },
  onStateChange: () => {
    refreshIndicators();
    cursor.update(model, cursorOpts());
    selectionOverlay.update(model, getInputState().selection);
    /* Cursor or voice may have moved — recompute reference. The diff filter
       short-circuits when (q, r) hasn't actually changed. */
    if (hklConnected) maybeBroadcastReference();
  },
  setStatus: (msg, kind) => setStatus(msg, kind),
  clearStatusIfTransient: () => clearStatusIfTransient(),
  isPlaybackActive: () => isPlaying,
  togglePlayback: () => { if (isPlaying) stopPlayback(); else startPlayback(); },
  onZoomChange: (dir) => stepZoom(dir),
  getHklTuningMode: () => hklTuningMode,
  requestApplyLayout: () => requestApplyLayout(),
  history,
});

/* ── playback ────────────────────────────────────────────────────────────── */

function refreshPlayButton(): void {
  const btn = $('btnPlay');
  if (!btn) return;
  btn.textContent = isPlaying ? '■ Stop' : '▶ Play';
  btn.classList.toggle('playing', isPlaying);
}

function startPlayback(): void {
  if (!hklConnected) {
    setStatus('Open HKL in another tab to enable playback (it owns the audio engine).', 'error');
    return;
  }
  /* Compute startMs from the current cursor's absolute tick offset so
     playback begins exactly where the cursor sits. cursor === 0 yields
     startMs === 0 (identical to old "from start" behavior). */
  const v = model.getCurrentVoice();
  const startTicks = model.getCursorAbsoluteTicks(v);
  const tempo = readTempo(model.getDoc());
  const tickMs = tickMsFromTempo(tempo);
  const startMs = startTicks * tickMs;
  const events = buildPlayback(model, startMs);
  if (events.length === 0) {
    setStatus(startMs > 0 ? 'Nothing left to play from cursor.' : 'Nothing to play.', 'error');
    return;
  }
  /* Snapshot editing cursor before playback so we can restore on stop/finish. */
  preplaybackVoice = v;
  preplaybackCursor = model.getCursor();
  isPlaying = true;
  cursor.setPlaybackMode(true);
  cursor.update(model, cursorOpts());
  refreshPlayButton();
  bridge.send({ type: 'play-score', events });
  setStatus('Playing ' + events.length + ' event(s)…', 'state');
}

function stopPlayback(): void {
  if (!isPlaying) return;
  bridge.send({ type: 'stop-playback' });
  finalizePlaybackEnd('Playback stopped.');
}

function finalizePlaybackEnd(statusMsg: string): void {
  if (!isPlaying) return;
  isPlaying = false;
  cursor.setPlaybackMode(false);
  /* Restore the editing cursor's pre-playback voice + position. */
  model.setVoice(preplaybackVoice);
  model.setCursor(preplaybackCursor);
  clearHighlights($('score'));
  cursor.update(model, cursorOpts());
  refreshIndicators();
  refreshPlayButton();
  maybeScrollMeasureIntoView(visualCursorMeasure());
  setStatus(statusMsg, 'action');
}

$('btnPlay')?.addEventListener('click', () => {
  if (isPlaying) stopPlayback();
  else startPlayback();
});

$('btnRewind')?.addEventListener('click', () => {
  if (isPlaying) stopPlayback();
  model.setCursor(0);
  reRender();
  refreshIndicators();
  maybeScrollMeasureIntoView(visualCursorMeasure());
  setStatus('Cursor at start.', 'action');
});

$('btnSetup')?.addEventListener('click', () => {
  openSetupDialog(model, (layoutChanged) => {
    reRender();
    refreshIndicators();
    setStatus('Setup applied.', 'action');
    /* Key signature may have changed — broadcast the song-key tier. Do NOT
     * re-broadcast the selection (reference-note) tier here: the key sig is
     * independent of cursor position, and triggering the selection broadcast
     * from a key-sig change is what would let an unrelated event clobber a
     * user's manual Ctrl+click selection on HKL. */
    if (hklConnected) maybeBroadcastSongKey();
    /* Layout requirement may have changed — informational broadcast to HKL.
       HKL caches it; whether HKL applies depends on its Sync toggle. */
    if (layoutChanged) {
      broadcastLayoutReq();
      refreshLayoutMatchIndicator();
    }
  }, history);
});

/* ── save / load / export ────────────────────────────────────────────────── */

$('btnSave')?.addEventListener('click', () => {
  try {
    saveHkc(model);
    setStatus('Saved .hkc.', 'action');
  } catch (e) {
    setStatus('Save failed: ' + (e as Error).message, 'error');
  }
});

$('btnLoad')?.addEventListener('click', () => {
  $<HTMLInputElement>('fileInputHkc')?.click();
});

$<HTMLInputElement>('fileInputHkc')?.addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const loaded = await loadHkcFromFile(file);
    model.replaceDocument(loaded.serialize());
    /* File load resets editing history — undo must not cross file boundaries. */
    history.clear();
    reRender();
    refreshIndicators();
    maybeScrollMeasureIntoView(visualCursorMeasure());
    /* Treat the loaded layoutReq as authoritative — disable any future
       blank-score auto-adopt so a stray hkl-layout-state can't overwrite it. */
    autoAdoptedHklLayout = true;
    /* The loaded file's layoutReq is now in the model; tell HKL. */
    broadcastLayoutReq();
    refreshLayoutMatchIndicator();
    setStatus('Loaded ' + file.name, 'action');
  } catch (err) {
    setStatus('Load failed: ' + (err as Error).message, 'error');
  } finally {
    input.value = '';
  }
});

function hideExportMenu(): void {
  (document.getElementById('exportMenu') as HTMLElement & { hidePopover?: () => void } | null)
    ?.hidePopover?.();
}

$('btnExportXml')?.addEventListener('click', () => {
  try {
    downloadMusicXml(model);
    setStatus('Exported .musicxml.', 'action');
  } catch (e) {
    setStatus('Export failed: ' + (e as Error).message, 'error');
  } finally {
    hideExportMenu();
  }
});

$('btnExportPdf')?.addEventListener('click', async () => {
  setStatus('Rendering PDF…', 'info');
  hideExportMenu();
  try {
    await downloadPdf(model, renderer.toolkit(), () => reRender());
    setStatus('Exported .pdf.', 'action');
  } catch (e) {
    setStatus('PDF export failed: ' + (e as Error).message, 'error');
  }
});

/* Position the popover under its trigger on each open. CSS anchor
   positioning isn't stable in Firefox yet, so do it in JS. */
document.getElementById('exportMenu')?.addEventListener('beforetoggle', (ev) => {
  const e = ev as Event & { newState?: string };
  if (e.newState !== 'open') return;
  const anchor = document.getElementById('btnExportMenu');
  const menu = ev.currentTarget as HTMLElement | null;
  if (!anchor || !menu) return;
  const r = anchor.getBoundingClientRect();
  menu.style.top = (r.bottom + 4) + 'px';
  menu.style.left = r.left + 'px';
});

/* ── view-mode toggle in toolbar ─────────────────────────────────────────── */

function applyViewModeClass(mode: 'page' | 'scroll'): void {
  const el = $('score');
  if (!el) return;
  el.classList.toggle('view-page', mode === 'page');
  el.classList.toggle('view-scroll', mode === 'scroll');
}

$('btnViewPage')?.addEventListener('click', () => {
  renderer.setViewMode('page');
  applyViewModeClass('page');
  $('btnViewPage')?.classList.add('active');
  $('btnViewScroll')?.classList.remove('active');
  reRender();
  maybeScrollMeasureIntoView(visualCursorMeasure());
});
$('btnViewScroll')?.addEventListener('click', () => {
  renderer.setViewMode('scroll');
  applyViewModeClass('scroll');
  $('btnViewScroll')?.classList.add('active');
  $('btnViewPage')?.classList.remove('active');
  reRender();
  maybeScrollMeasureIntoView(visualCursorMeasure());
});

/* Initial state matches the default view mode (page). */
applyViewModeClass('page');

/* ── boot ────────────────────────────────────────────────────────────────── */

void bootRenderer();

/* DevTools handle. */
(window as unknown as { __hkl_composer: unknown }).__hkl_composer = {
  bridge, model, renderer, cursor, reRender,
  getHeldKeys: () => lastHeldKeys,
  isHklConnected: () => hklConnected,
  inputState: getInputState,
  history,
  buildPlayback,
  /* Test-only reset: clears main.ts module state that RESET_SNIPPET in the
   * Composer test runner can't reach (isPlaying, hklConnected). Without this,
   * a fixture that starts playback or simulates an hkl-hello leaks state into
   * every subsequent fixture (playback gates input.ts arrow handlers; hello
   * state gates bridge broadcasts). Not for production use. */
  __testReset: () => {
    if (isPlaying) finalizePlaybackEnd('Test reset.');
    hklConnected = false;
    hklTuningMode = null;
    autoAdoptedHklLayout = false;
    footprintColors = null;
    setConn('no-hkl');
  },
};
