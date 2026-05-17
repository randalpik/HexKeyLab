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
import { renderer } from './render.js';
import { cursor } from './cursor.js';
import { initInput, getInputState } from './input.js';
import { saveHkc, loadHkcFromFile, downloadMusicXml } from './save.js';
import { buildPlayback, highlightElement, clearHighlights } from './playback.js';
import { openSetupDialog } from './setupDialog.js';

const $ = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

let hklConnected = false;
let lastHeldKeys: ReadonlyArray<ResolvedNote> = [];
let isPlaying = false;
/* Editing cursor snapshot taken at playback start, restored on stop/finish. */
let preplaybackVoice: 1 | 2 | 3 | 4 = 1;
let preplaybackCursor = 0;

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
  const v = $('voiceIndicator');         if (v) v.textContent = String(voice);
  const d = $('durationIndicator');      if (d) d.textContent = s.duration;
  const m = $('modeIndicator');          if (m) m.textContent = s.mode === 'insert' ? 'INS' : 'OVR';
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
       as a sibling of the rendered SVG inside #score, sized to match so it
       covers the same scrollable area. Both scroll together as children of
       #score. */
    const scoreEl = $('score');
    if (!scoreEl) return;
    const verovioSvg = scoreEl.querySelector('svg:not(#cursorOverlay)') as SVGSVGElement | null;
    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.id = 'cursorOverlay';
    if (verovioSvg) {
      const w = verovioSvg.getAttribute('width');
      const h = verovioSvg.getAttribute('height');
      if (w) overlay.setAttribute('width', w);
      if (h) overlay.setAttribute('height', h);
    }
    scoreEl.appendChild(overlay);
    cursor.attach(overlay);
    cursor.update(model, getInputState().mode);
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

initInput(model, {
  getHeldKeys: () => lastHeldKeys,
  onChange: () => {
    reRender();
  },
  onStateChange: () => {
    refreshIndicators();
    cursor.update(model, getInputState().mode);
  },
  setStatus: (msg) => setStatus(msg),
  isPlaybackActive: () => isPlaying,
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
  const events = buildPlayback(model);
  if (events.length === 0) {
    setStatus('Nothing to play.');
    return;
  }
  /* Snapshot editing cursor before playback so we can restore on stop/finish. */
  preplaybackVoice = model.getCurrentVoice();
  preplaybackCursor = model.getCursor();
  isPlaying = true;
  cursor.setPlaybackMode(true);
  cursor.update(model, getInputState().mode);
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
  cursor.update(model, getInputState().mode);
  refreshIndicators();
  refreshPlayButton();
  setStatus(statusMsg);
}

$('btnPlay')?.addEventListener('click', () => {
  if (isPlaying) stopPlayback();
  else startPlayback();
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
});
$('btnViewScroll')?.addEventListener('click', () => {
  renderer.setViewMode('scroll');
  applyViewModeClass('scroll');
  $('btnViewScroll')?.classList.add('active');
  $('btnViewPage')?.classList.remove('active');
  reRender();
});

/* Initial state matches the default view mode (page). */
applyViewModeClass('page');

/* ── boot ────────────────────────────────────────────────────────────────── */

void bootRenderer();

/* DevTools handle. */
(window as unknown as { __hkl_composer: unknown }).__hkl_composer = {
  bridge, model, renderer, cursor,
  getHeldKeys: () => lastHeldKeys,
  isHklConnected: () => hklConnected,
  inputState: getInputState,
};
