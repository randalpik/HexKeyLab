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

import { createComposerBridge, PROTOCOL_VERSION } from '@hkl/bridge/channel.js';
import type { HklEvent, ResolvedNote, FootprintCell } from '@hkl/bridge/protocol.js';
import { ComposerModel, type Voice } from './model/index.js';
import { renderer, ZOOM_PRESETS, type ZoomLevel, type ViewMode, type ScoreTheme } from './render/render.js';
import { cursor, resolveVoiceCursorAnchor } from './cursor/cursor.js';
import { initInput, getInputState, setViewInstr, installSCTransposeImpl, clearChordInternalSel, resetToVoiceMode, selectLayerElementById } from './input.js';
import { scTransposeChordNote, type FootprintColorMap } from './notation/scTranspose.js';
import { HistoryManager } from './history.js';
import type { CursorUpdateOpts } from './cursor/cursor.js';
import { selectionOverlay } from './selection/selectionOverlay.js';
import { saveHkc, loadHkcFromFile, downloadMusicXml, downloadPdf, exportMusicXml } from './save.js';
import { importMusicXml } from './importMusicXml.js';
import { buildPlayback, buildPedalEvents, playbackStartMs, highlightElement, clearHighlights, readTempo, tickMsFromTempo, PIZZ_VARIANTS } from './render/playback.js';
import { PerformanceMatcher } from './render/performance.js';
import { addDir } from './expressions.js';
import { openSetupDialog } from './setupDialog.js';
import { openHelpDialog } from './helpDialog.js';
import { attachScoreClickHandler } from './click.js';
import {
  computePrevNoteRef,
  refNoteChanged, invalidateRefNoteCache,
  scoreRefChanged, invalidateScoreRefCache,
} from './cursor/refNote.js';

const $ = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

let hklConnected = false;
let lastHeldKeys: ReadonlyArray<ResolvedNote> = [];
let isPlaying = false;
/* Performance mode (input-driven playback): the player plays the Lumatone live
 * and Composer advances each voice's bar as its notes are struck (see
 * render/performance.ts). Mutually exclusive with clock-driven `isPlaying`;
 * both share the per-voice playback bars + the pre-playback cursor snapshot. */
let performanceActive = false;
let perfMatcher: PerformanceMatcher | null = null;
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

/* Cached HKL footprint: each cell carries q, r, and fresh ink + light colors.
 *   - `null` while we haven't received a footprint yet (no constraint).
 *   - empty Map means outline='none' on HKL — also "no constraint".
 * scTranspose uses this both for layout validation AND to write the new
 * `color` / `data-light-color` attributes on a transposed note, keeping
 * HKL/Composer in sync. */
let footprintColors: FootprintColorMap = null;
/* Editing cursor snapshot taken at playback start, restored on stop/finish. */
let preplaybackVoice: Voice = 1;
let preplaybackCursor = 0;
/* The most-recently-played element's meiId in the preplaybackVoice. Updated
 * on every `playback-position` broadcast; consumed by stopPlaybackAtHead()
 * (bound to plain ←/→ during playback) so the cursor lands on the audible
 * element rather than snapping back to its pre-playback position. */
let lastPlaybackHeadId: string | null = null;
/* Count of `stop-playback` messages Composer has sent whose corresponding
 * `playback-finished` ack should be SUPPRESSED. Every stop we initiate
 * (Stop button, plain-arrow stop-at-head, seek) bumps this counter and
 * runs finalizePlaybackEnd locally; HKL then echoes one playback-finished
 * per stop, and we decrement instead of finalizing again. Without this,
 * a seek sequence (stop-playback + play-score) races: HKL acks the stop
 * AFTER Composer has started the new session, and the stale ack
 * incorrectly stops Composer's UI mid-playback. Real natural-end acks
 * have counter == 0 and finalize as usual. */
let pendingStopAcks = 0;
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
  /* Scroll mode: the target measure may be off-screen and thus unmounted —
     mount its chunk so rectForId can resolve it (no-op in page mode). */
  renderer.ensureMeasureMounted(measureIdx);
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
  /* Every transient message — info cues, post-action reports, errors — goes
     stale the moment the user does anything else, so all clear on the next
     keystroke. Only 'state' (blue) survives: it describes ongoing context
     (selection range, pending hairpin/slur/tuplet, held keys) and clears via
     its own mechanism. The resting 'Ready.' default is already cleared, so skip
     it to avoid pointless DOM churn. */
  if (statusKind === 'state' || statusSource === 'default') return;
  resetStatus();
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
  const v = $('voiceIndicator');         if (v) v.textContent = s.cursorMode === 'expr' ? 'E' : s.cursorMode === 'pedal' ? 'P' : s.cursorMode === 'tempo' ? 'T' : String(voice);
  const m = $('modeIndicator');          if (m) m.textContent = s.mode === 'insert' ? 'INS' : 'OVR';
}

function cursorOpts(): CursorUpdateOpts {
  const s = getInputState();
  return {
    entryMode: s.mode,
    cursorMode: s.cursorMode,
    exprCursor: s.exprCursor,
    exprInstrIdx: s.exprInstrIdx,
    pedalCursor: s.pedalCursor,
    pedalInstrIdx: s.pedalInstrIdx,
    tempoCursor: s.tempoCursor,
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
      invalidateScoreRefCache();
      lastBroadcastInstrKey = null;
      lastBroadcastInstrSet = null;
      maybeBroadcastReference();
      maybeBroadcastScoreRef();
      maybeBroadcastInstruments();
      maybeBroadcastActiveInstrument();
      broadcastLayoutReq();
      lastScoreInstrKey = null;
      broadcastComposerView();
      break;
    }
    case 'hkl-bye':
      hklConnected = false;
      setConn('no-hkl');
      lastHeldKeys = [];
      stopPlayback();
      stopPerformance('HKL disconnected.');
      invalidateRefNoteCache();
      invalidateScoreRefCache();
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
    case 'player-note-struck':
      onPlayerNoteStruck(msg.note);
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
      /* meiId null + voice set = clear that one voice's bar (its content ended
         before the score did). Handled before highlightElement so this doesn't
         disturb the single note-playing highlight other voices still own. */
      if (!msg.meiId && msg.voice != null) {
        cursor.setPlaybackPosition(msg.voice, null);
        break;
      }
      highlightElement(msg.meiId, $('score'));
      /* Route per-voice: each voice gets its own cursor bar at the chord
         it's currently sounding. The editing cursor stays parked at the
         pre-playback position. */
      if (msg.meiId) {
        const loc = model.findElement(msg.meiId);
        if (loc) {
          cursor.setPlaybackPosition(loc.voice, msg.meiId);
          /* Track the latest played element in the pre-playback voice so a
             plain ←/→ stop lands at the audible head. */
          if (loc.voice === preplaybackVoice) lastPlaybackHeadId = msg.meiId;
        }
        const mIdx = model.getMeasureIdxForId(msg.meiId);
        if (mIdx >= 0) maybeScrollMeasureIntoView(mIdx);
      }
      break;
    case 'playback-finished':
      /* If Composer initiated a stop (Stop / plain-arrow / seek) and
         already finalized locally, the matching HKL ack must NOT finalize
         again — it could land mid-new-session and stop the UI while audio
         is still playing. */
      if (pendingStopAcks > 0) {
        pendingStopAcks--;
        break;
      }
      finalizePlaybackEnd('Playback finished.');
      break;
    case 'footprint-changed': {
      /* Rebuild the cache. Empty cells = outline='none' = no constraint. */
      const map: NonNullable<FootprintColorMap> = new Map();
      for (const cell of msg.cells) {
        map.set(cell[0] + ',' + cell[1], { ink: cell[2], light: cell[3] });
      }
      footprintColors = map;
      break;
    }
    case 'import-score': {
      /* A transcription is a whole score → replace, not merge. Confirm first
         if the current doc has content so we don't silently lose unsaved work. */
      if (model.hasNotes()
        && !window.confirm('Replace the current score with the imported transcription from HKL?')) {
        break;
      }
      try {
        applyLoadedDocument(msg.mei, 'Imported transcription from HKL.');
      } catch (err) {
        setStatus('Import failed: ' + (err as Error).message, 'error');
      }
      break;
    }
  }
});

/** Read the cached footprint. Returns null when HKL hasn't broadcast one
 *  yet (treat as "no constraint"), an empty map when HKL's outline is set
 *  to 'none' (also "no constraint" — caller decides whether to allow), or
 *  a populated map keyed by "q,r" with the fresh per-cell color. */
export function getFootprintColors(): FootprintColorMap {
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

/** Send the score's Setup-dialog ref coordinates to HKL's score-ref tier.
 *  Called on connect / hello and on Setup save / file load, NOT on every
 *  cursor move — the score ref is independent of cursor. HKL decides (per its
 *  Sync-to-Composer toggle) whether this also clears its selection tier. */
function maybeBroadcastScoreRef(): void {
  const lr = model.getLayoutReq();
  const coord = { q: lr.refQ, r: lr.refR };
  if (scoreRefChanged(coord)) {
    bridge.send({ type: 'set-score-ref', q: coord.q, r: coord.r });
  }
}

/** Last instrument SET broadcast to HKL (diff filter). */
let lastBroadcastInstrSet: string | null = null;
/** Tell HKL the full set of instruments in the score so it can proactively
 *  load them all (when Sync is on) — so cursor-follow during note entry is
 *  always ready in the right timbre. Multi-instrument only; a single-instrument
 *  score sends [] (HKL keeps the user's chosen instrument). Diff-filtered. */
function maybeBroadcastInstruments(): void {
  const baseKeys = model.instruments().length > 1
    ? [...new Set(model.instruments().map((i) => i.instrKey))]
    : [];
  /* Include every pizzicato variant in the library so HKL preloads them before
     playback (noteOn never falls back to a different timbre — an unloaded
     variant goes silent). Any instrument can switch to ANY library pizz via the
     pizz-fallback, so we preload the whole pizz set, not just per-instrument. */
  const keys = baseKeys.length > 0
    ? [...new Set([...baseKeys, ...PIZZ_VARIANTS])]
    : [];
  const sig = keys.join(',');
  if (sig !== lastBroadcastInstrSet) {
    lastBroadcastInstrSet = sig;
    bridge.send({ type: 'composer-instruments', instrumentKeys: keys });
  }
}

/** Resolve the active single-part view filter to a list of staff @n, or null
 *  (= show all). Clamps a stale index (instrument removed) to null. */
function viewStavesFilter(): number[] | null {
  const idx = getInputState().viewInstrIdx;
  if (idx == null) return null;
  const inst = model.instruments()[idx];
  return inst ? inst.staffNs.slice() : null;
}

/** Rebuild the toolbar instrument-view selector from the current instrument
 *  set. Shows the group only for multi-instrument scores (single-part view is
 *  meaningless with one instrument). Diff-filtered on the instrument signature
 *  so repeated calls during nav are cheap no-ops. Resets a now-invalid
 *  selection to "All". */
let lastViewSelectorSig: string | null = null;
function refreshViewSelector(): void {
  const sel = $('viewInstrSelect') as HTMLSelectElement | null;
  if (!sel) return;
  const insts = model.instruments();
  const sig = insts.map((i) => i.name).join('|');
  const multi = insts.length > 1;
  sel.style.display = multi ? '' : 'none';
  if (!multi) {
    /* Collapsing to one instrument drops any active single-part view. */
    if (getInputState().viewInstrIdx != null) { setViewInstr(model, null); }
    lastViewSelectorSig = sig;
    return;
  }
  const cur = getInputState().viewInstrIdx;
  if (sig !== lastViewSelectorSig) {
    lastViewSelectorSig = sig;
    sel.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = 'all'; allOpt.textContent = 'All parts';
    sel.appendChild(allOpt);
    insts.forEach((inst, i) => {
      const opt = document.createElement('option');
      opt.value = String(i); opt.textContent = inst.name;
      sel.appendChild(opt);
    });
  }
  sel.value = cur == null ? 'all' : String(cur);
}

/** Last instrument key broadcast to HKL (diff filter for the cursor-follow). */
let lastBroadcastInstrKey: string | null = null;
/** Tell HKL which instrument the editing cursor sits in, so Sync-to-Composer
 *  can preview note entry in the right timbre. Only for multi-instrument scores
 *  (a single-instrument score has no per-instrument concept — HKL keeps its own
 *  active instrument). Diff-filtered so it fires only on instrument changes. */
function maybeBroadcastActiveInstrument(): void {
  if (model.instruments().length <= 1) { lastBroadcastInstrKey = null; return; }
  const key = model.instrumentOf(model.getCurrentVoice()).instrKey;
  if (key !== lastBroadcastInstrKey) {
    lastBroadcastInstrKey = key;
    bridge.send({ type: 'composer-active-instrument', instrumentKey: key });
  }
}

/* ── Composer-view-in-HKL broadcasts ──────────────────────────────────────
 * HKL's optional bottom-bar "Composer view" frame renders the cursor
 * instrument's part (grand staff is the target; multi-instrument degrades to
 * the one part at the cursor) and auto-scrolls to follow the editing cursor.
 * Two streams: the single-instrument MEI (on content / instrument change) and
 * the cursor position (on cursor move). Both gated on hklConnected. */

/** Staff @n filter for the instrument the editing cursor currently sits in
 *  (vs. viewStavesFilter, which follows the toolbar "View" selector). */
function cursorStavesFilter(): number[] | null {
  const inst = model.instrumentOf(model.getCurrentVoice());
  return inst ? inst.staffNs.slice() : null;
}

let lastComposerScoreSig: string | null = null;
/** Serialize the cursor instrument's part and broadcast it if it changed.
 *  Called on content changes and instrument switches — NOT on every cursor
 *  move (serializing per keystroke-nav would be wasteful); the string diff
 *  makes redundant calls cheap no-ops anyway. */
function maybeBroadcastComposerScore(): void {
  if (!hklConnected) return;
  const mei = model.serialize({ hejiEnabled: model.getHejiEnabled() }, cursorStavesFilter());
  if (mei !== lastComposerScoreSig) {
    lastComposerScoreSig = mei;
    bridge.send({ type: 'composer-score', mei });
  }
}

let lastComposerCursorSig: string | null = null;
/** Broadcast the editing cursor so HKL's frame can draw a PIXEL-IDENTICAL bar
 *  (via the shared computeVoiceCursorRect over its identical re-render) and
 *  scroll to follow. Sends the resolved render-agnostic anchor (the same one
 *  Composer's own cursor.ts uses). During playback HKL draws per-voice playback
 *  bars from its scheduler instead. Diff-gated. */
function maybeBroadcastComposerCursor(): void {
  if (!hklConnected) return;
  const curVoice = model.getCurrentVoice();
  const mode = getInputState().mode;
  const anchor = resolveVoiceCursorAnchor(model, curVoice, mode);
  const measureIdx = model.cursorMeasureIdx(curVoice, mode);
  const meiId = model.allMeasures()[measureIdx]?.getAttribute('xml:id') ?? null;
  const sig = curVoice + '|' + measureIdx + '|' + JSON.stringify(anchor);
  if (sig !== lastComposerCursorSig) {
    lastComposerCursorSig = sig;
    bridge.send({ type: 'composer-cursor', meiId, measureIdx, voice: curVoice, anchor });
  }
}

let lastComposerPlaybackSig: string | null = null;
/** Broadcast the complete per-voice playback overlay (mode + bars) so HKL's
 *  frame mirrors it. Single source of truth: Composer's `Cursor` self-publishes
 *  this (via `onPlaybackChange`) on every mode / bar change, so clock playback,
 *  Performance mode, and any future cursor source reflect in both views with no
 *  per-feature wiring. Diff-gated. */
function maybeBroadcastComposerPlayback(): void {
  if (!hklConnected) return;
  const on = cursor.isPlaybackMode();
  const bars = [...cursor.getPlaybackPositions()].map(([voice, meiId]) => ({ voice, meiId }));
  const sig = on + '|' + bars.map((b) => b.voice + ':' + b.meiId).sort().join(',');
  if (sig !== lastComposerPlaybackSig) {
    lastComposerPlaybackSig = sig;
    bridge.send({ type: 'composer-playback', on, bars });
  }
}

/** Cursor-instrument key tracked so onStateChange re-broadcasts the score only
 *  when the part being viewed actually changes (cheap guard before serialize). */
let lastScoreInstrKey: string | null = null;
function maybeBroadcastComposerScoreOnInstrChange(): void {
  if (!hklConnected) return;
  const key = model.instruments().length > 1
    ? model.instrumentOf(model.getCurrentVoice()).instrKey
    : '<single>';
  if (key !== lastScoreInstrKey) {
    lastScoreInstrKey = key;
    maybeBroadcastComposerScore();
  }
}

/** Fire all Composer-view broadcasts (score + cursor + playback overlay). Used
 *  on (re)connect. */
function broadcastComposerView(): void {
  lastComposerScoreSig = null; /* force a fresh score push on connect */
  lastComposerPlaybackSig = null; /* force a fresh playback-overlay push too */
  maybeBroadcastComposerScore();
  maybeBroadcastComposerCursor();
  maybeBroadcastComposerPlayback();
}

window.setTimeout(() => {
  if (!hklConnected) {
    setConn('standalone');
  }
}, 1000);

window.addEventListener('beforeunload', () => {
  bridge.send({ type: 'composer-bye' });
});

/* Re-handshake on focus / tab-visible. BroadcastChannel doesn't buffer, and
   each side otherwise sends its hello only once at load — so when both tabs
   (re)load together (e.g. shared-package HMR reloading Composer + HKL at once)
   each one-shot hello can land in the other's pre-listener window and both are
   lost, leaving the apps wedged until one is reopened. Re-sending hello +
   request-state on focus lets HKL's hkl-hello reply re-drive broadcastComposerView
   (main.ts:218-246), so the handshake self-heals on focus. Debounced so
   focus+visibilitychange (often fired together) coalesce; the broadcasts it
   ultimately triggers are diff-gated, so repeats are cheap. */
let reHandshakeHandle: number | undefined;
function scheduleReHandshake(): void {
  if (reHandshakeHandle !== undefined) return;
  reHandshakeHandle = window.setTimeout(() => {
    reHandshakeHandle = undefined;
    bridge.send({ type: 'composer-hello', version: PROTOCOL_VERSION });
    bridge.send({ type: 'request-state' });
  }, 100);
}
window.addEventListener('focus', scheduleReHandshake);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleReHandshake();
});

/* ── render pipeline ─────────────────────────────────────────────────────── */

/* Inject composer name (right-aligned, below title block) and footer
 * (centered, bottom) into each rendered page SVG. Subtitle is rendered
 * by Verovio's auto-header from `<title type="subtitle">`; the composer
 * y position is computed DYNAMICALLY to sit below the full title block
 * (title + optional subtitle) with breathing room before the first system.
 *
 * Coordinate system: we append into Verovio's `g.page-margin` group
 * (translate(1400, 1400) for the page margin). Inside that group, the
 * usable inner area runs (0, 0) to (pageWidth−2*margin, pageHeight−2*margin)
 * = (18790, 25140). */
const PAGE_INNER_W = 21590 - 2 * 1400; /* 18790 — usable width inside page-margin */
const PAGE_INNER_H = 27940 - 2 * 1400; /* 25140 — usable height inside page-margin */
/* Composer placement anchors to the FIRST SYSTEM's top edge rather than
 * the title block's bottom. The system's y is what Verovio guarantees
 * non-collision against (the layout reserves system-top whitespace); the
 * title block extends only as far down as its content. With subtitle, the
 * system moves further down naturally — so this anchor adapts. Padding is
 * the gap between composer's baseline and the system's top edge. */
const COMPOSER_FONT_SIZE = 324;
const COMPOSER_SYSTEM_GAP = 120;        /* baseline-to-system-top */
const COMPOSER_FALLBACK_Y = 900;        /* when no system has rendered yet */
const FOOTER_Y = PAGE_INNER_H - 200;    /* hug page bottom */
const HKL_SVG_NS = 'http://www.w3.org/2000/svg';

function injectHeaderFooter(scoreEl: HTMLElement, composer: string, footer: string): void {
  const margins = scoreEl.querySelectorAll('.score-page svg.definition-scale > g.page-margin');
  for (const pageMargin of Array.from(margins)) {
    if (composer) {
      let existing = pageMargin.querySelector(':scope > text.hkl-injected-composer');
      if (existing) existing.parentNode?.removeChild(existing);
      /* Place the composer baseline `COMPOSER_SYSTEM_GAP` above the first
         system's bbox.y — sits just above the staff regardless of title /
         subtitle height. Falls back to a constant when no system has
         rendered (empty doc). */
      let y = COMPOSER_FALLBACK_Y;
      const system = pageMargin.querySelector(':scope ~ g.system, :scope g.system')
        ?? scoreEl.querySelector('.score-page g.system');
      if (system) {
        try {
          const bb = (system as SVGGraphicsElement).getBBox();
          if (bb.height > 0) y = bb.y - COMPOSER_SYSTEM_GAP;
        } catch { /* getBBox may throw if element isn't fully laid out yet */ }
      }
      const t = pageMargin.ownerDocument!.createElementNS(HKL_SVG_NS, 'text');
      t.setAttribute('class', 'hkl-injected-composer');
      t.setAttribute('x', String(PAGE_INNER_W));
      t.setAttribute('y', String(y));
      t.setAttribute('text-anchor', 'end');
      t.setAttribute('font-size', String(COMPOSER_FONT_SIZE));
      t.setAttribute('font-family', 'Times, serif');
      t.textContent = composer;
      pageMargin.appendChild(t);
    }
    if (footer) {
      let existing = pageMargin.querySelector(':scope > text.hkl-injected-footer');
      if (existing) existing.parentNode?.removeChild(existing);
      const t = pageMargin.ownerDocument!.createElementNS(HKL_SVG_NS, 'text');
      t.setAttribute('class', 'hkl-injected-footer');
      t.setAttribute('x', String(PAGE_INNER_W / 2));
      t.setAttribute('y', String(FOOTER_Y));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('font-size', '320px');
      t.setAttribute('font-family', 'Times, serif');
      t.setAttribute('fill', '#555');
      t.textContent = footer;
      pageMargin.appendChild(t);
    }
  }
}

/* Section headers (movement titles): a centered, space-reserving title above
 * the system that begins the section. The section's first measure carries
 * `data-hkl-section-title` (+ a forced <sb> so it starts a new system). We
 * find that measure's rendered <g.system>, translate it (and everything below
 * it in the page) DOWN to reserve room, grow the page, and inject the centered
 * title into the freed space. */
const SECTION_HEADER_FONT = 560;
const SECTION_HEADER_RESERVE = 900;  /* vertical space carved out (Verovio units) */
const SECTION_HEADER_BASELINE = 360; /* title baseline below the reserved top */

function injectSectionHeaders(scoreEl: HTMLElement, model: ComposerModel): void {
  const doc = model.getDoc();
  const headers = Array.from(doc.querySelectorAll('measure[data-hkl-section-title]'));
  for (const meas of headers) {
    const id = meas.getAttribute('xml:id');
    const title = meas.getAttribute('data-hkl-section-title');
    if (!id || !title) continue;
    const escId = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(id) : id;
    const rendered = scoreEl.querySelector('g.measure#' + escId);
    if (!rendered) continue;
    const system = rendered.closest('g.system') as SVGGraphicsElement | null;
    const pageMargin = rendered.closest('g.page-margin') as SVGGraphicsElement | null;
    if (!system || !pageMargin) continue;
    let sysbb: DOMRect;
    try { sysbb = system.getBBox(); } catch { continue; }
    if (!(sysbb.height > 0)) continue;

    /* Reserve space: shift this system and every later system in the same page
       down by SECTION_HEADER_RESERVE, then grow the page's height so nothing
       clips. (The first system never gets a header — measureIdx 0 is rejected
       — so there is always a system above to break from.) */
    const systems = Array.from(pageMargin.querySelectorAll(':scope > g.system')) as SVGGraphicsElement[];
    const fromIdx = systems.indexOf(system);
    const headerTop = sysbb.y;
    for (let i = fromIdx; i < systems.length; i++) {
      const s = systems[i];
      const base = s.transform.baseVal.consolidate();
      const ty = base ? base.matrix.f : 0;
      const tx = base ? base.matrix.e : 0;
      s.setAttribute('transform', `translate(${tx}, ${ty + SECTION_HEADER_RESERVE})`);
    }
    /* Inject the centered title in the freed band above the (now lower) system. */
    pageMargin.querySelector(`:scope > text.hkl-section-header[data-for="${id}"]`)?.remove();
    const t = pageMargin.ownerDocument!.createElementNS(HKL_SVG_NS, 'text');
    t.setAttribute('class', 'hkl-section-header');
    t.setAttribute('data-for', id);
    /* Centered on the page (not the system — a short final section would
       otherwise pull the title to the left margin). */
    t.setAttribute('x', String(PAGE_INNER_W / 2));
    t.setAttribute('y', String(headerTop + SECTION_HEADER_BASELINE));
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-size', String(SECTION_HEADER_FONT));
    t.setAttribute('font-family', 'Times, serif');
    t.textContent = title;
    pageMargin.appendChild(t);

    /* Grow the page so the downshifted content isn't clipped. */
    const pageSvg = pageMargin.closest('svg.definition-scale') as SVGSVGElement | null;
    if (pageSvg) {
      const vb = pageSvg.getAttribute('viewBox');
      if (vb) {
        const parts = vb.split(/\s+/).map(Number);
        if (parts.length === 4) {
          parts[3] += SECTION_HEADER_RESERVE;
          pageSvg.setAttribute('viewBox', parts.join(' '));
          const h = parseFloat(pageSvg.getAttribute('height') ?? '0');
          if (h) pageSvg.setAttribute('height', String(h + SECTION_HEADER_RESERVE * (h / parts[3])));
        }
      }
    }
  }
}

/* Verovio draws volta (1st/2nd ending) numbers in a large, heavy default.
 * Restyle the innermost numeric tspan to a lighter serif and append the
 * conventional trailing period ("1." / "2."). */
const VOLTA_NUMBER_FONT = 300;

function styleVoltaNumbers(scoreEl: HTMLElement): void {
  for (const vb of Array.from(scoreEl.querySelectorAll('g.voltaBracket'))) {
    for (const ts of Array.from(vb.querySelectorAll('text tspan'))) {
      /* The innermost tspan holds the bare number (no element children). */
      if (ts.children.length > 0) continue;
      const txt = (ts.textContent ?? '').trim();
      if (!/^\d+\.?$/.test(txt)) continue;
      ts.setAttribute('font-size', String(VOLTA_NUMBER_FONT));
      ts.setAttribute('font-weight', 'normal');
      ts.setAttribute('font-family', 'Times, serif');
      if (!txt.endsWith('.')) ts.textContent = txt + '.';
    }
  }
}

function reRender(): void {
  try {
    /* Keep the instrument-view selector in sync with the current instrument
       set on every render (diff-filtered, so cheap) — robust regardless of
       which code path mutated the instruments. */
    refreshViewSelector();
    renderer.render(model.serialize({ hejiEnabled: model.getHejiEnabled() }, viewStavesFilter()));
    /* After Verovio's output lands, inject composer (right-aligned) + footer
       (centered, bottom of page). Subtitle is handled by Verovio itself once
       <title type="subtitle"> is present. Only affects page view (the
       .score-page wrapper); scroll view skips the page header/footer. */
    const isScroll = renderer.getViewMode() === 'scroll';
    const scoreElForInject = $('score');
    /* Page-only post-render injections (header/footer/section headers/volta/
       crisp snap) operate on the .score-page page structure; scroll view has
       a virtualized chunk canvas instead, so skip them there. */
    if (scoreElForInject && !isScroll) {
      injectHeaderFooter(scoreElForInject, model.getComposer(), model.getFooter());
      injectSectionHeaders(scoreElForInject, model);
      styleVoltaNumbers(scoreElForInject);
      /* Land every system's staff lines on the device-pixel grid (crisp). Must
         run AFTER the injections above that move systems (section-header reserve
         shift) and before the cursor overlay geometry is measured below. */
      renderer.snapSystems(scoreElForInject);
    }
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
    /* Size the overlay to cover EVERY page SVG, not just the first — in page
       view with a page break there are multiple .score-page svgs stacked
       vertically, and a cursor on a later page would otherwise fall outside
       the overlay's bounds and not draw. */
    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.id = 'cursorOverlay';
    /* Size the overlay to cover every rendered SVG (scroll = one wide single-
       system SVG; page = stacked .score-page svgs) in #score's content frame, so
       cursor markers drawn at rectForId's container-local coords land correctly.
       Adding scrollLeft/scrollTop converts the on-screen rect to content coords. */
    {
      const verovioSvgs = Array.from(
        scoreEl.querySelectorAll('svg:not(#cursorOverlay)'),
      ) as SVGSVGElement[];
      if (verovioSvgs.length) {
        const scoreRect = scoreEl.getBoundingClientRect();
        let overlayW = 0;
        let overlayH = 0;
        for (const svg of verovioSvgs) {
          const r = svg.getBoundingClientRect();
          overlayW = Math.max(overlayW, r.right - scoreRect.left + scoreEl.scrollLeft);
          overlayH = Math.max(overlayH, r.bottom - scoreRect.top + scoreEl.scrollTop);
        }
        overlay.setAttribute('width', String(Math.max(0, overlayW)));
        overlay.setAttribute('height', String(Math.max(0, overlayH)));
      }
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
  /* Warm BravuraText before the first render so HEJI / stacked-accidental
     injection draws real glyphs instead of tofu (see injectHejiGlyphs). */
  try { await document.fonts.load('100px BravuraText'); } catch { /* fall through */ }
  reRender();
  /* Wire click-to-position. Lives in main.ts because it needs both the
     model and the same onChange hook the keyboard handler uses. */
  attachScoreClickHandler(scoreEl, model, {
    onChange: (placedVoiceCursor) => {
      /* Placing a voice cursor by click must behave exactly like an arrow-key
         move: drop any active selection / chord-internal selection and return
         to voice mode BEFORE refreshing, so a stale alt-selection doesn't
         linger. (The layer-element path passes false — onSelectLayerElement
         has already set the right expression mode.) */
      if (placedVoiceCursor) resetToVoiceMode();
      /* Click-to-position changes no content — same path as arrow-key nav:
         overlays + bridge cursor + scroll into view, no reRender. */
      composerOnCursorMove();
    },
    setStatus: (msg, kind) => setStatus(msg, kind),
    isPlaybackActive: () => isPlaying || performanceActive,
    onSelectLayerElement: (id) => selectLayerElementById(model, id, setStatus),
  });
  console.log('Verovio ' + renderer.getVersion());
  resetStatus();
  refreshIndicators();
  refreshViewSelector();
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
    setStatus('Zoom ' + cur + '% (' + (dir === 'in' ? 'max' : 'min') + ').', 'info');
    return;
  }
  renderer.setZoom(next);
  reRender();
  maybeScrollMeasureIntoView(visualCursorMeasure());
  setStatus('Zoom ' + next + '%.', 'info');
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

/** Content changed (insert/delete) or cursor moved within the rendered score:
 *  re-render, scroll into view, and push the affected bridge state. Shared by
 *  the keyboard handler AND click-to-select so both update HKL identically. */
function composerOnContentChange(): void {
  reRender();
  /* Scroll-into-view belongs after reRender so it sees the new layout —
     crucial for reflow (a new measure created by insertion at past-end, or an
     addition that pushes the current measure to a new system). Several call
     sites fire onStateChange before onChange, so running scroll here ensures it
     always sees the post-reRender geometry regardless of caller order. */
  if (!isPlaying) maybeScrollMeasureIntoView(visualCursorMeasure());
  /* Content change: most recent prior-to-cursor element may have changed
     (insert/delete) → recompute the reference note and broadcast. The score
     changed, so push the updated part to HKL's Composer-view frame too. */
  if (hklConnected) { maybeBroadcastReference(); maybeBroadcastComposerScore(); maybeBroadcastComposerCursor(); }
}

/** Cursor/voice/mode changed (no necessarily content): refresh indicators +
 *  overlays and push cursor/instrument bridge state. Shared by keyboard + click
 *  so click-to-select updates the HKL cursor exactly like the arrow keys. */
function composerOnCursorMove(): void {
  composerOnStateChange();
  if (!isPlaying) maybeScrollMeasureIntoView(visualCursorMeasure());
}

function composerOnStateChange(): void {
  refreshIndicators();
  refreshViewSelector();
  /* Scroll mode: a cursor move may target an off-screen (unmounted) chunk;
     mount it so the overlay can resolve the cursor's rect (no-op in page mode). */
  renderer.ensureMeasureMounted(visualCursorMeasure());
  cursor.update(model, cursorOpts());
  selectionOverlay.update(model, getInputState().selection);
  /* Cursor or voice may have moved — recompute reference. The diff filter
     short-circuits when (q, r) hasn't actually changed. maybeBroadcastInstruments
     catches add/remove/reorder (diff-filtered, so it's a no-op otherwise). */
  if (hklConnected) {
    maybeBroadcastReference(); maybeBroadcastInstruments(); maybeBroadcastActiveInstrument();
    maybeBroadcastComposerScoreOnInstrChange(); maybeBroadcastComposerCursor();
  }
}

/* Single source of truth for the HKL frame's playback bars: the Cursor object
   self-publishes its overlay on every mode/bar change, so no cursor feature
   needs to remember to sync the frame. */
cursor.onPlaybackChange = () => maybeBroadcastComposerPlayback();

initInput(model, {
  getHeldKeys: () => lastHeldKeys,
  onChange: composerOnContentChange,
  onStateChange: composerOnStateChange,
  onCursorMove: composerOnCursorMove,
  setStatus: (msg, kind) => setStatus(msg, kind),
  clearStatusIfTransient: () => clearStatusIfTransient(),
  isPlaybackActive: () => isPlaying || performanceActive,
  spaceTransport: () => {
    if (isPlaying) stopPlayback();
    else if (performanceActive) stopPerformance('Performance mode off.');
    else startPlayback();
  },
  shiftSpaceTransport: () => {
    if (isPlaying || performanceActive) return;
    startPerformance();
  },
  stopPlaybackAtHead: () => stopPlaybackAtHead(),
  seekPlaybackByMeasure: (dir) => seekPlaybackByMeasure(dir),
  onZoomChange: (dir) => stepZoom(dir),
  getHklTuningMode: () => hklTuningMode,
  requestApplyLayout: () => requestApplyLayout(),
  history,
});

/* ── playback ────────────────────────────────────────────────────────────── */

/* Transport glyphs drawn as 13×15 SVG shapes (not font characters) so they
   center exactly and stay uniform across the transport buttons. currentColor
   picks up the .playing accent. Both transports share one STOP square. */
const svgGlyph = (inner: string): string =>
  '<svg width="13" height="15" viewBox="0 0 13 15" aria-hidden="true">' + inner + '</svg>';
const GLYPH_PLAY = svgGlyph('<polygon points="3,3 3,12 11.5,7.5" fill="currentColor"/>');
const GLYPH_STOP = svgGlyph('<rect x="2.5" y="3" width="8" height="9" rx="1" fill="currentColor"/>');
const GLYPH_RECORD = svgGlyph('<circle cx="6.5" cy="7.5" r="4.6" fill="currentColor"/>');

function refreshPlayButton(): void {
  const btn = $('btnPlay');
  if (!btn) return;
  btn.innerHTML = isPlaying ? GLYPH_STOP : GLYPH_PLAY;
  btn.title = isPlaying ? 'Stop playback' : 'Play from cursor (Rewind to play from start)';
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
  const startMs = playbackStartMs(model, startTicks);
  const events = buildPlayback(model, startMs);
  if (events.length === 0) {
    setStatus(startMs > 0 ? 'Nothing left to play from cursor.' : 'Nothing to play.', 'error');
    return;
  }
  const pedalEvents = buildPedalEvents(model, startMs);
  /* Snapshot editing cursor before playback so we can restore on stop/finish. */
  preplaybackVoice = v;
  preplaybackCursor = model.getCursor();
  lastPlaybackHeadId = null;
  isPlaying = true;
  cursor.setPlaybackMode(true);
  cursor.update(model, cursorOpts());
  refreshPlayButton();
  bridge.send({ type: 'play-score', events, pedalEvents });
  setStatus('Playing ' + events.length + ' event(s)…', 'state');
}

function stopPlayback(): void {
  if (!isPlaying) return;
  bridge.send({ type: 'stop-playback' });
  pendingStopAcks++;
  finalizePlaybackEnd('Playback stopped.');
}

/** True iff ANY voice's playback head currently sits on the first content
 *  element of its measure (= it's about to play / has just played the
 *  first note/chord/rest of that measure). Used by Ctrl+← seek to decide
 *  whether to jump back one extra measure: if a voice has just entered
 *  measure M, the user usually wants to rewind to M-1, not back to M. */
function anyPlaybackHeadAtMeasureStart(): boolean {
  for (const [voice, meiId] of cursor.getPlaybackPositions()) {
    const loc = model.findElement(meiId);
    if (!loc) continue;
    const flat = model.flatChildren(voice);
    const elem = flat[loc.index];
    if (!elem) continue;
    const measure = elem.closest('measure');
    if (!measure) continue;
    const layer = model.layerInMeasure(measure, voice);
    if (!layer) continue;
    const cc = Array.from(layer.children).filter((c) =>
      c.localName === 'note' || c.localName === 'chord'
      || c.localName === 'rest' || c.localName === 'tuplet');
    if (cc.length === 0) continue;
    const slot = elem.parentElement?.localName === 'chord' ? elem.parentElement : elem;
    if (cc[0] === slot) return true;
  }
  return false;
}

/** Seek the audible playback head to the next/previous measure boundary.
 *  Per Max's spec: "stop playback, place cursor at the position where it
 *  stopped, jump cursor by 1 measure, resume playback — repeatable, no
 *  special logic." Composes stopPlaybackAtHead + setCursor + startPlayback;
 *  the stop's stale `playback-finished` ack is suppressed by the
 *  pendingStopAcks counter so it doesn't terminate the new session.
 *
 *  Ctrl+← extra step: if ANY voice's playhead is at the start of its
 *  current measure ("just crossed into M"), Ctrl+← jumps to M-1 instead
 *  of M. Without this, the user-expected "back one measure" feels like
 *  a no-op because the standard `boundary < cur` lands on the very
 *  measure they just entered. */
function seekPlaybackByMeasure(dir: 'left' | 'right'): void {
  if (!isPlaying) return;
  const wantsExtraStepBack = dir === 'left' && anyPlaybackHeadAtMeasureStart();
  /* Step 1: stop playback at the audible head (parks cursor on the
     currently-sounding element in preplaybackVoice). */
  stopPlaybackAtHead();
  /* Step 2: jump cursor by one measure boundary from where it landed. */
  const v = model.getCurrentVoice();
  const boundaries = model.measureBoundaryCursors(v);
  const cur = model.getCursor(v);
  let target: number | undefined;
  if (dir === 'right') {
    target = boundaries.find((b) => b > cur);
  } else {
    for (const b of boundaries) {
      if (b < cur) target = b;
      else break;
    }
    /* Boundary-start case: an extra step back. The first `target` above
       is the start of the CURRENT measure (just past the playhead). One
       more pass below finds the boundary BEFORE that = start of M-1. */
    if (wantsExtraStepBack && target !== undefined) {
      let prevPrev: number | undefined;
      for (const b of boundaries) {
        if (b < target) prevPrev = b;
        else break;
      }
      if (prevPrev !== undefined) target = prevPrev;
    }
  }
  if (target === undefined || target === cur) return; /* edge of score */
  model.setCursor(target, v);
  /* Step 3: resume playback from the new cursor. */
  startPlayback();
}

/** Stop playback and leave the editing cursor at the most-recent playback head
 *  in the user's pre-playback voice (instead of snapping back to the cursor's
 *  pre-playback position). Wired to plain ←/→ during playback so the user can
 *  punch out exactly where they hear the music. Falls back to a normal stop
 *  if no playback-position has arrived yet (e.g. very early plain-arrow). */
function stopPlaybackAtHead(): void {
  if (!isPlaying) return;
  bridge.send({ type: 'stop-playback' });
  pendingStopAcks++;
  if (lastPlaybackHeadId) {
    const loc = model.findElement(lastPlaybackHeadId);
    if (loc) {
      /* Override preplaybackVoice/cursor so finalize positions the cursor at
         the head rather than restoring the pre-playback snapshot. */
      preplaybackVoice = loc.voice;
      preplaybackCursor = loc.index;
    }
  }
  finalizePlaybackEnd('Playback stopped at playhead.');
}

function finalizePlaybackEnd(statusMsg: string): void {
  if (!isPlaying) return;
  isPlaying = false;
  restoreEditingTransport(statusMsg);
}

/** Shared transport teardown for both clock playback and performance mode:
 *  drop the per-voice bars, restore the editing cursor to its pre-playback
 *  snapshot, resync HKL's frame, and refresh UI. The caller has already cleared
 *  its own active flag (isPlaying / performanceActive). */
function restoreEditingTransport(statusMsg: string): void {
  cursor.setPlaybackMode(false);
  /* Restore the editing cursor's pre-playback voice + position. */
  model.setVoice(preplaybackVoice);
  model.setCursor(preplaybackCursor);
  clearHighlights($('score'));
  cursor.update(model, cursorOpts());
  /* Resync HKL's read-only frame cursor to the restored editing position.
     This bypasses composerOnStateChange (the usual cursor-broadcast path), so
     without this HKL is never told the cursor left the playback position — its
     frame redraws a stale anchor (the last note it played). Force past the
     diff-gate so it fires even when the restored position equals the
     pre-playback one HKL last saw. */
  if (hklConnected) { lastComposerCursorSig = null; maybeBroadcastComposerCursor(); }
  refreshIndicators();
  refreshPlayButton();
  refreshPerformButton();
  maybeScrollMeasureIntoView(visualCursorMeasure());
  /* Transport end is not a model edit — info, not action. */
  setStatus(statusMsg, 'info');
}

function refreshPerformButton(): void {
  const btn = $('btnPerform');
  if (!btn) return;
  btn.innerHTML = performanceActive ? GLYPH_STOP : GLYPH_RECORD;
  btn.title = performanceActive
    ? 'Stop Performance mode'
    : 'Performance mode: play your part live, the score follows (single-instrument)';
  btn.classList.toggle('playing', performanceActive);
}

/** Enter Performance mode. Builds the matcher from the whole score, parks each
 *  voice's bar on its first expected element, and tells HKL to forward live
 *  strikes. Audio is the live instrument — we send no play-score. */
function startPerformance(): void {
  if (isPlaying) stopPlayback();
  if (!hklConnected) {
    setStatus('Open HKL in another tab to enable Performance mode (it owns the input + audio).', 'error');
    return;
  }
  if (model.instruments().length !== 1) {
    setStatus('Performance mode is only available on single-instrument scores.', 'error');
    return;
  }
  const matcher = new PerformanceMatcher(model);
  if (!matcher.hasContent()) {
    setStatus('Nothing to perform.', 'error');
    return;
  }
  /* Snapshot the editing cursor so we can restore it on exit. */
  preplaybackVoice = model.getCurrentVoice();
  preplaybackCursor = model.getCursor();
  lastPlaybackHeadId = null;
  perfMatcher = matcher;
  performanceActive = true;
  cursor.setPlaybackMode(true);
  for (const a of matcher.initialPositions()) cursor.setPlaybackPosition(a.voice, a.meiId);
  cursor.update(model, cursorOpts());
  refreshPerformButton();
  bridge.send({ type: 'start-performance' });
  setStatus('Performance mode — play your part to advance.', 'state');
}

function stopPerformance(statusMsg: string): void {
  if (!performanceActive) return;
  performanceActive = false;
  perfMatcher = null;
  bridge.send({ type: 'stop-performance' });
  restoreEditingTransport(statusMsg);
}

/** Handle one live strike in Performance mode. Feeds the matcher; each voice it
 *  advances repositions that voice's playback bar (and scrolls into view). A
 *  strike that matches no current-frontier voice is a no-op. Finishing the last
 *  voice ends the mode. */
function onPlayerNoteStruck(note: ResolvedNote): void {
  if (!performanceActive || !perfMatcher) return;
  for (const a of perfMatcher.onStrike(note)) {
    cursor.setPlaybackPosition(a.voice, a.meiId);
    if (a.meiId) {
      if (a.voice === preplaybackVoice) lastPlaybackHeadId = a.meiId;
      const mIdx = model.getMeasureIdxForId(a.meiId);
      if (mIdx >= 0) maybeScrollMeasureIntoView(mIdx);
    }
  }
  if (perfMatcher.isFinished()) stopPerformance('Performance finished.');
}

/* The transport BUTTONS are switch-to-this-transport controls (distinct from
   the Space / Shift+Space keys): each shows the STOP glyph while its own
   transport runs, and pressing one while the other is active deactivates the
   other and activates this one. btnPerform gets that for free — startPerformance
   stops playback first — so only btnPlay needs an explicit stopPerformance. */
$('btnPlay')?.addEventListener('click', () => {
  if (isPlaying) { stopPlayback(); return; }
  if (performanceActive) stopPerformance('Performance mode off.');
  startPlayback();
});

$('btnPerform')?.addEventListener('click', () => {
  if (performanceActive) stopPerformance('Performance mode off.');
  else startPerformance();
});

$('btnRewind')?.addEventListener('click', () => {
  if (isPlaying) stopPlayback();
  clearChordInternalSel();
  model.setCursor(0);
  reRender();
  refreshIndicators();
  maybeScrollMeasureIntoView(visualCursorMeasure());
  setStatus('Cursor at start.', 'info');
});

$('btnSetup')?.addEventListener('click', () => {
  openSetupDialog(model, (layoutChanged) => {
    /* Instruments may have been added/removed/reordered via the modal — a
       stale single-part view must be dropped and the selector rebuilt before
       rendering (else viewStavesFilter() points at the wrong staves). */
    if (model.instruments()[getInputState().viewInstrIdx ?? -1] == null) setViewInstr(model, null);
    refreshViewSelector();
    reRender();
    refreshIndicators();
    setStatus('Setup applied.', 'action');
    /* The Setup ref coordinates may have changed — broadcast the score-ref
     * tier. Do NOT re-broadcast the selection (reference-note) tier here: it's
     * cursor-driven, and triggering it from a Setup apply is what would let an
     * unrelated event clobber a user's manual Ctrl+click selection on HKL. */
    if (hklConnected) maybeBroadcastScoreRef();
    /* Instruments may have changed (add / remove / reorder via the Instruments
       modal routes through here) — re-broadcast the set + the cursor's
       instrument so HKL can (pre)load and follow. Diff-filtered. */
    if (hklConnected) { maybeBroadcastInstruments(); maybeBroadcastActiveInstrument(); }
    /* Layout requirement may have changed — informational broadcast to HKL.
       HKL caches it; whether HKL applies depends on its Sync toggle. */
    if (layoutChanged) {
      broadcastLayoutReq();
      refreshLayoutMatchIndicator();
    }
  }, history);
});

$('btnHelp')?.addEventListener('click', () => {
  openHelpDialog();
});

/* ── save / load / export ────────────────────────────────────────────────── */

$('btnSave')?.addEventListener('click', () => {
  try {
    saveHkc(model);
    setStatus('Saved .hkc.', 'info');
  } catch (e) {
    setStatus('Save failed: ' + (e as Error).message, 'error');
  }
});

$('btnLoad')?.addEventListener('click', () => {
  $<HTMLInputElement>('fileInputHkc')?.click();
});

/** Swap in a whole new document (file load or HKL transcription import) and run
 *  the identical post-load wiring: reset history, re-render, refresh indicators,
 *  scroll the cursor into view, and treat the loaded layoutReq as authoritative
 *  (disabling blank-score auto-adopt so a stray hkl-layout-state can't overwrite
 *  it) before telling HKL about it. */
function applyLoadedDocument(meiXml: string, statusMsg: string): void {
  model.replaceDocument(meiXml);
  /* File load resets editing history — undo must not cross document boundaries. */
  history.clear();
  /* A new document may have a different instrument set — drop any single-part
     view and rebuild the selector before rendering. */
  setViewInstr(model, null);
  refreshViewSelector();
  reRender();
  refreshIndicators();
  maybeScrollMeasureIntoView(visualCursorMeasure());
  autoAdoptedHklLayout = true;
  broadcastLayoutReq();
  if (hklConnected) maybeBroadcastScoreRef();
  refreshLayoutMatchIndicator();
  /* Loading replaces the doc and clears history — not an undoable edit. */
  setStatus(statusMsg, 'info');
}

$<HTMLInputElement>('fileInputHkc')?.addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const loaded = await loadHkcFromFile(file);
    applyLoadedDocument(loaded.serialize(), 'Loaded ' + file.name);
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

$('btnImportXml')?.addEventListener('click', () => {
  $<HTMLInputElement>('fileInputMusicXml')?.click();
});

$<HTMLInputElement>('fileInputMusicXml')?.addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    applyLoadedDocument(importMusicXml(text), 'Imported ' + file.name);
  } catch (err) {
    setStatus('Import failed: ' + (err as Error).message, 'error');
  } finally {
    input.value = '';
  }
});

/* Test hook: drive import without a file picker (headless verification). */
(window as unknown as { __composerImportMusicXml?: (xml: string) => void })
  .__composerImportMusicXml = (xml: string) => {
    applyLoadedDocument(importMusicXml(xml), 'Imported MusicXML (test)');
  };

$('btnExportXml')?.addEventListener('click', () => {
  try {
    downloadMusicXml(model);
    setStatus('Exported .musicxml.', 'info');
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
    await downloadPdf(model, renderer.toolkit(), () => reRender(), viewStavesFilter());
    setStatus('Exported .pdf.', 'info');
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

const THEME_KEY = 'hkl.composer.theme';
const VIEWMODE_KEY = 'hkl.composer.viewMode';

function applyViewMode(mode: ViewMode): void {
  renderer.setViewMode(mode);
  applyViewModeClass(mode);
  reRender();
  maybeScrollMeasureIntoView(visualCursorMeasure());
}
$('viewModeSelect')?.addEventListener('change', (e) => {
  const mode = (e.target as HTMLSelectElement).value as ViewMode;
  applyViewMode(mode);
  try { localStorage.setItem(VIEWMODE_KEY, mode); } catch { /* private mode / quota — ignore */ }
});
$('themeSelect')?.addEventListener('change', (e) => {
  const theme = (e.target as HTMLSelectElement).value as ScoreTheme;
  renderer.setTheme(theme);
  reRender();
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
});
$('viewInstrSelect')?.addEventListener('change', (e) => {
  const val = (e.target as HTMLSelectElement).value;
  const idx = val === 'all' ? null : parseInt(val, 10);
  setViewInstr(model, idx);
  reRender();
  refreshIndicators();
  cursor.update(model, cursorOpts());
  selectionOverlay.update(model, getInputState().selection);
  refreshViewSelector();
  maybeScrollMeasureIntoView(visualCursorMeasure());
  if (hklConnected) maybeBroadcastActiveInstrument();
  const name = idx == null ? 'All parts' : model.instruments()[idx]?.name;
  setStatus(idx == null ? 'Showing all parts.' : 'Viewing ' + name + ' only.', 'info');
});

/* Restore persisted view mode + theme (defaults: page / light). Set on the
   renderer before the boot render so the first paint already reflects them. */
{
  let savedMode: ViewMode = 'page';
  let savedTheme: ScoreTheme = 'light';
  try {
    const m = localStorage.getItem(VIEWMODE_KEY);
    if (m === 'page' || m === 'scroll') savedMode = m;
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark' || t === 'transparent') savedTheme = t;
  } catch { /* ignore */ }
  renderer.setViewMode(savedMode);
  renderer.setTheme(savedTheme);
  applyViewModeClass(savedMode);
  const vmSel = $('viewModeSelect') as HTMLSelectElement | null;
  if (vmSel) vmSel.value = savedMode;
  const thSel = $('themeSelect') as HTMLSelectElement | null;
  if (thSel) thSel.value = savedTheme;
}

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
  buildPedalEvents,
  exportMusicXml,
  /* Test-only: add an expressive-text <dir> directly (bypasses the async modal
     flow) so fixtures can place pizz./arco cues deterministically. */
  __addDir: (measureIdx: number, tstamp: number, text: string, staff: number): void => {
    addDir(model.getDoc(), { measureIdx, tstamp }, { text, staff });
  },
  /* Test-only reset: clears main.ts module state that RESET_SNIPPET in the
   * Composer test runner can't reach (isPlaying, hklConnected). Without this,
   * a fixture that starts playback or simulates an hkl-hello leaks state into
   * every subsequent fixture (playback gates input.ts arrow handlers; hello
   * state gates bridge broadcasts). Not for production use. */
  __testReset: () => {
    if (isPlaying) finalizePlaybackEnd('Test reset.');
    if (performanceActive) stopPerformance('Test reset.');
    /* A fixture that stops/seeks playback leaves pendingStopAcks > 0 (the test
       mock never sends the matching HKL ack), which would otherwise swallow the
       next fixture's playback-finished. Clear it like the other playback state. */
    pendingStopAcks = 0;
    hklConnected = false;
    hklTuningMode = null;
    autoAdoptedHklLayout = false;
    footprintColors = null;
    setConn('no-hkl');
  },
  /* Test-only: stage playback-active state pointing at a specific meiId so
   * subsequent plain-arrow can exercise stopPlaybackAtHead without an actual
   * BroadcastChannel round-trip with a real HKL. Snapshots the current cursor
   * as the pre-playback position (matches startPlayback's behavior) and
   * synchronously force-sets hklConnected so a seek's startPlayback doesn't
   * bail on the connection gate. */
  __simulatePlaybackAt: (meiId: string): void => {
    const loc = model.findElement(meiId);
    if (!loc) return;
    hklConnected = true;
    setConn('connected');
    preplaybackVoice = model.getCurrentVoice();
    preplaybackCursor = model.getCursor();
    lastPlaybackHeadId = meiId;
    isPlaying = true;
    cursor.setPlaybackMode(true);
    cursor.setPlaybackPosition(loc.voice, meiId);
    refreshPlayButton();
  },
  /* Test-only Performance-mode driver. Drives the REAL startPerformance +
   * strike handler + stopPerformance synchronously (no BroadcastChannel
   * round-trip, which is async and wouldn't settle inside a sync fixture
   * setup). `start` force-connects like __simulatePlaybackAt so the
   * single-instrument + connection gates pass. */
  __performance: {
    start: (): void => {
      hklConnected = true;
      setConn('connected');
      startPerformance();
    },
    strike: (note: ResolvedNote): void => { onPlayerNoteStruck(note); },
    isActive: (): boolean => performanceActive,
    positions: (): Record<number, string> =>
      Object.fromEntries(cursor.getPlaybackPositions()) as Record<number, string>,
  },
};
