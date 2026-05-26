// Sample table — per-slot rows with tier color, diagnostics, checkbox,
// play/stop button, and an Inspect expander that mounts the chart canvas.
//
// Rebuilds the entire <tbody> on each state change. With ≤30 samples
// (single-instrument focus), this is cheap enough; the alternative — diffing
// rows individually — adds complexity without measurable benefit.
//
// Audition wiring: clicking a row's ▶ button starts audition for that slot;
// clicking again (now showing ■) stops it. A transparent playhead canvas is
// layered over the diagnostic canvas in the inspect pane and is driven by
// the audition module's onAuditionPosition subscription.

import { getState, onChange, updateSampleByName } from './stage.js';
import type { SampleSlot } from './state.js';
import { drawSlotChart } from './charts.js';
import {
  audition,
  stopAudition,
  onAuditionPosition,
  onAuditionStop,
  activeAuditionId,
} from './audition.js';
import { ensureAudioBuffer } from './pipeline.js';
import { computeTMax, drawPlayhead, clearPlayhead } from './playhead.js';

const expandedRows = new Set<string>();

/* Map<slotName, {canvas, tMax}> of currently-mounted inspect playhead
 * canvases. Rebuilt on every renderTable; the audition position callback
 * looks up by slot name to find where to draw. */
const playheadCanvases = new Map<string, { canvas: HTMLCanvasElement; tMax: number }>();

function $<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function paintPlayButton(btn: HTMLButtonElement, isPlaying: boolean): void {
  btn.textContent = isPlaying ? '■' : '▶';
  btn.title = isPlaying ? 'Stop' : 'Audition';
  btn.style.color = isPlaying ? '#FF4C79' : '';
}

/** Start audition for the given slot, decoding the audio buffer first if
 *  the state was just hydrated from a draft (audioBuffers don't persist).
 *  Decoded buffers are written back into state.samples by ensureAudioBuffer,
 *  so subsequent plays don't re-decode. */
async function startAuditionForSlot(slot: SampleSlot): Promise<void> {
  let buf = slot.audioBuffer;
  if (!buf) {
    buf = await ensureAudioBuffer(slot) ?? undefined;
    if (!buf) return; /* decode failed; ensureAudioBuffer set slot.status */
    /* ensureAudioBuffer wrote audioBuffer into state via updateSampleByName;
       re-read so the audition gets the fresh slot. */
    const fresh = getState().samples.find(s => s.name === slot.name);
    if (fresh) slot = fresh;
  }
  audition(slot.name, buf, {
    gain: slot.gain,
    segments: slot.result?.segments,
    releaseTime: getState().config.releaseTime,
    trimStart: slot.result?.trimStart,
  });
  syncPlayButtonsToAudition();
}

/** Sync every play button's glyph to the current activeAuditionId without
 *  re-rendering the table (preserves the inspect-pane canvases). */
function syncPlayButtonsToAudition(): void {
  const active = activeAuditionId();
  document.querySelectorAll<HTMLButtonElement>('#sampleTableBody .play-btn').forEach(btn => {
    paintPlayButton(btn, btn.dataset.slotName === active);
  });
}

function formatNumber(v: number | undefined, digits: number): string {
  if (v == null) return '—';
  return v.toFixed(digits);
}

function buildRow(slot: SampleSlot): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.dataset.name = slot.name;
  if (slot.tier) tr.classList.add('tier-' + slot.tier);

  /* Cell 0: pick checkbox. */
  const c0 = tr.insertCell();
  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.checked = slot.picked;
  chk.disabled = !slot.tier || slot.tier === 'fail' || slot.tier === 'red';
  chk.addEventListener('change', () => {
    updateSampleByName(slot.name, { picked: chk.checked });
  });
  c0.appendChild(chk);

  /* Cells 1..7: data. */
  tr.insertCell().textContent = slot.name;
  tr.insertCell().textContent = slot.result?.freqActual
    ? slot.result.freqActual.toFixed(2)
    : slot.freq.toFixed(2);

  const tierCell = tr.insertCell();
  tierCell.className = 'tier-cell';
  tierCell.textContent = slot.tier ?? slot.state;

  const segs = slot.result?.segments ?? [];
  const segCount = segs.length;
  tr.insertCell().textContent = segCount > 0 ? String(segCount) : '—';

  const span = segCount > 0 ? (segs[segCount - 1].b - segs[0].a) : 0;
  tr.insertCell().textContent = segCount > 0 ? span.toFixed(2) : '—';

  tr.insertCell().textContent = formatNumber(slot.gain, 3);
  tr.insertCell().textContent = slot.status ?? '';

  /* Cell 8: action buttons (Play/Stop + Inspect). */
  const cAct = tr.insertCell();
  cAct.style.textAlign = 'right';

  const btnPlay = document.createElement('button');
  btnPlay.className = 'btn play-btn';
  btnPlay.dataset.slotName = slot.name;
  /* Audition needs a source (file or URL). audioBuffer may be missing on a
     freshly-hydrated draft — we decode on demand at click time. */
  btnPlay.disabled = !slot.audioBuffer && !slot.file && !slot.url;
  btnPlay.style.padding = '1px 8px';
  btnPlay.style.marginRight = '4px';
  btnPlay.style.minWidth = '28px';
  paintPlayButton(btnPlay, activeAuditionId() === slot.name);
  btnPlay.addEventListener('click', () => {
    if (activeAuditionId() === slot.name) {
      stopAudition();
      return;
    }
    void startAuditionForSlot(slot);
  });
  cAct.appendChild(btnPlay);

  const btnInspect = document.createElement('button');
  btnInspect.className = 'btn';
  btnInspect.textContent = expandedRows.has(slot.name) ? '▾' : '▸';
  btnInspect.title = 'Inspect — show diagnostic chart';
  btnInspect.disabled = !slot.result || !slot.result.diag;
  btnInspect.style.padding = '1px 8px';
  btnInspect.addEventListener('click', () => {
    if (expandedRows.has(slot.name)) {
      expandedRows.delete(slot.name);
    } else {
      expandedRows.add(slot.name);
    }
    renderTable();
  });
  cAct.appendChild(btnInspect);

  return tr;
}

function buildInspectRow(slot: SampleSlot): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.classList.add('expanded');
  const td = document.createElement('td');
  td.colSpan = 9;
  td.className = 'inspect-cell';
  const pane = document.createElement('div');
  pane.className = 'inspect-pane';

  /* Stacked canvases: diagCanvas holds HKLViz's plots, playheadCanvas is a
     transparent overlay we redraw each rAF tick during audition. */
  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  wrap.style.display = 'inline-block';
  wrap.style.maxWidth = '100%';
  const diagCanvas = document.createElement('canvas');
  diagCanvas.className = 'diag-canvas';
  diagCanvas.width = 1080;
  diagCanvas.height = 520;
  diagCanvas.style.display = 'block';
  diagCanvas.style.maxWidth = '100%';
  diagCanvas.style.height = 'auto';
  const playheadCanvas = document.createElement('canvas');
  playheadCanvas.className = 'playhead-canvas';
  playheadCanvas.width = 1080;
  playheadCanvas.height = 520;
  playheadCanvas.style.position = 'absolute';
  playheadCanvas.style.left = '0';
  playheadCanvas.style.top = '0';
  playheadCanvas.style.width = '100%';
  playheadCanvas.style.height = '100%';
  playheadCanvas.style.pointerEvents = 'none';
  /* Override the .inspect-pane canvas CSS that sets a dark background —
     this canvas is a transparent overlay so the diag chart below shows. */
  playheadCanvas.style.background = 'transparent';
  wrap.appendChild(diagCanvas);
  wrap.appendChild(playheadCanvas);

  const info = document.createElement('div');
  info.className = 'info';
  pane.appendChild(wrap);
  pane.appendChild(info);
  td.appendChild(pane);
  tr.appendChild(td);

  const tMax = computeTMax(slot.result);
  playheadCanvases.set(slot.name, { canvas: playheadCanvas, tMax });

  /* Draw asynchronously so the row is mounted before HKLViz queries
     canvas dimensions. */
  requestAnimationFrame(() => {
    drawSlotChart(slot, diagCanvas, info);
    /* If this slot is the one currently playing, paint an initial playhead
       so it's visible immediately (before the next rAF tick from audition). */
    if (activeAuditionId() === slot.name) {
      /* Position will be repainted on the next audition tick; the initial
         draw uses trimStart as a sensible "starts here" hint. */
      drawPlayhead(playheadCanvas, slot.result?.trimStart ?? 0, tMax);
    }
  });

  return tr;
}

function renderTable(): void {
  const tbody = $<HTMLTableSectionElement>('sampleTableBody');
  const section = $<HTMLElement>('samplesSection');
  if (!tbody || !section) return;
  playheadCanvases.clear();
  const state = getState();
  if (state.samples.length === 0) {
    section.classList.add('hidden');
    tbody.innerHTML = '';
    return;
  }
  section.classList.remove('hidden');
  tbody.innerHTML = '';
  for (const slot of state.samples) {
    tbody.appendChild(buildRow(slot));
    if (expandedRows.has(slot.name) && slot.result?.diag) {
      tbody.appendChild(buildInspectRow(slot));
    }
  }
}

export function initSampleTable(): void {
  /* Audition position → playhead redraw. */
  onAuditionPosition((id, t) => {
    const entry = playheadCanvases.get(id);
    if (!entry) return;
    drawPlayhead(entry.canvas, t, entry.tMax);
  });

  /* Audition stop → clear playhead + flip button glyph back. */
  onAuditionStop((id) => {
    const entry = playheadCanvases.get(id);
    if (entry) clearPlayhead(entry.canvas);
    /* Update button glyphs in-place; don't rebuild the table (would
       destroy the inspect pane's canvases). */
    syncPlayButtonsToAudition();
  });

  onChange(renderTable);
  renderTable();

  /* Make sure audition halts when the page closes. */
  window.addEventListener('beforeunload', stopAudition);
}
