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
import type { HklEvent, ResolvedNote } from '../bridge/protocol.js';
import { ComposerModel } from './model.js';
import { renderer, ZOOM_PRESETS, type ZoomLevel } from './render.js';
import { cursor } from './cursor.js';
import { initInput, getInputState } from './input.js';
import type { CursorUpdateOpts } from './cursor.js';
import { saveHkc, loadHkcFromFile, downloadMusicXml } from './save.js';
import { buildPlayback, highlightElement, clearHighlights, readTempo, tickMsFromTempo } from './playback.js';
import { openSetupDialog } from './setupDialog.js';

const $ = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

let hklConnected = false;
let lastHeldKeys: ReadonlyArray<ResolvedNote> = [];
let isPlaying = false;
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

function setStatus(text: string): void {
  const el = $('composerStatus');
  if (el) el.textContent = text;
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
  return { entryMode: s.mode, cursorMode: s.cursorMode, exprCursor: s.exprCursor };
}

/* ── model + bridge ──────────────────────────────────────────────────────── */

const model = new ComposerModel();
const bridge = createComposerBridge();

bridge.on((msg: HklEvent) => {
  switch (msg.type) {
    case 'hkl-hello':
      hklConnected = true;
      setConn('connected');
      setStatus('HKL v' + msg.version + ' connected.');
      break;
    case 'hkl-bye':
      hklConnected = false;
      setConn('no-hkl');
      setStatus('HKL closed. Standalone mode.');
      lastHeldKeys = [];
      stopPlayback();
      break;
    case 'held-keys':
      lastHeldKeys = msg.keys;
      /* Optional status echo when held; quiet otherwise to avoid spamming. */
      if (msg.keys.length > 0) {
        setStatus('held: ' + msg.keys.map((k) => k.pname.toUpperCase() + (k.accid || '') + k.oct).join(' '));
      }
      break;
    case 'tuning-changed':
      /* No status update — tuning changes are HKL-internal and Composer
         already gets resolved (q,r,pname,...) per chord. */
      break;
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
  }
});

bridge.send({ type: 'composer-hello', version: PROTOCOL_VERSION });
bridge.send({ type: 'request-state' });

window.setTimeout(() => {
  if (!hklConnected) {
    setConn('standalone');
    setStatus('No HKL — running standalone. Open index.html in another tab to enable entry.');
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
    cursor.update(model, cursorOpts());
  } catch (e) {
    setStatus('render error: ' + (e as Error).message);
  }
}

async function bootRenderer(): Promise<void> {
  const scoreEl = $('score');
  if (!scoreEl) {
    setStatus('FATAL: #score element missing.');
    return;
  }
  setStatus('Loading Verovio WASM…');
  try {
    await renderer.ready();
  } catch (e) {
    setStatus('Verovio failed to load: ' + (e as Error).message);
    return;
  }
  renderer.attach(scoreEl);
  reRender();
  setStatus('Ready. Verovio ' + renderer.getVersion() + '. ' +
    (hklConnected ? 'HKL connected.' : 'Standalone — open HKL in another tab to enter notes.'));
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
    setStatus('Zoom ' + cur + '% (' + (dir === 'in' ? 'max' : 'min') + ').');
    return;
  }
  renderer.setZoom(next);
  reRender();
  maybeScrollMeasureIntoView(visualCursorMeasure());
  setStatus('Zoom ' + next + '%.');
}

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
  },
  onStateChange: () => {
    refreshIndicators();
    cursor.update(model, cursorOpts());
  },
  setStatus: (msg) => setStatus(msg),
  isPlaybackActive: () => isPlaying,
  onZoomChange: (dir) => stepZoom(dir),
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
    setStatus('Open HKL in another tab to enable playback (it owns the audio engine).');
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
    setStatus(startMs > 0 ? 'Nothing left to play from cursor.' : 'Nothing to play.');
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
  setStatus('Playing ' + events.length + ' event(s)…');
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
  setStatus(statusMsg);
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
  setStatus('Cursor at start.');
});

$('btnSetup')?.addEventListener('click', () => {
  openSetupDialog(model, () => {
    reRender();
    refreshIndicators();
    setStatus('Setup applied.');
  });
});

/* ── save / load / export ────────────────────────────────────────────────── */

$('btnSave')?.addEventListener('click', () => {
  try {
    saveHkc(model);
    setStatus('Saved .hkc.');
  } catch (e) {
    setStatus('Save failed: ' + (e as Error).message);
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
    reRender();
    refreshIndicators();
    maybeScrollMeasureIntoView(visualCursorMeasure());
    setStatus('Loaded ' + file.name);
  } catch (err) {
    setStatus('Load failed: ' + (err as Error).message);
  } finally {
    input.value = '';
  }
});

$('btnExportXml')?.addEventListener('click', () => {
  try {
    downloadMusicXml(model);
    setStatus('Exported .musicxml.');
  } catch (e) {
    setStatus('Export failed: ' + (e as Error).message);
  }
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
};
