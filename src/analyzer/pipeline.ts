// Main-thread analysis orchestrator.
//
// Owns:
//   - The Web Worker (created lazily on first analyze, kept alive).
//   - The AudioContext for decodeAudioData() + audition.
//   - The "Analyze all samples" button wiring.
//
// Flow:
//   1. For each slot: ensure audioBuffer (fetch + decode if missing).
//   2. Copy per-channel Float32Arrays, post to worker as transferables.
//   3. On 'result' message: classify tier, update slot, run auto-select if enabled.
//   4. On 'error' message: mark slot as failed with reason.
//
// One worker, sequential dispatch. Single-instrument focus keeps the queue
// small (≤30 samples typical); a pool can come later if needed.

// @ts-ignore - .js module
import { HKLInstruments } from '../../analyzer/analyzer-instruments.js';
import {
  getState,
  onChange,
  setStatus,
  setAutoSelectEnabled,
  updateSampleByName,
  updateSamples,
} from './stage.js';
import { classifyTier } from './tier.js';
import { pickSamples } from './autoSelect.js';
import type { AnalysisResult, GateOpts, SampleSlot } from './state.js';
import type { WorkerResultMessage, WorkerErrorMessage } from './pipeline-worker.js';

// @ts-ignore Vite resolves ?worker into a Worker constructor at build time
import AnalyzerWorker from './pipeline-worker.ts?worker';

let _worker: Worker | null = null;
let _ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (_ctx) return _ctx;
  const AC = (window as unknown as { AudioContext: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
    .AudioContext
    || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  _ctx = new AC();
  return _ctx;
}

function getWorker(): Worker {
  if (_worker) return _worker;
  _worker = new AnalyzerWorker() as Worker;
  return _worker;
}

/** Per-sample analysis with the worker. Resolves with the worker's result
 *  message (or rejects on error message). Listener registered per call so
 *  multiple analyses can coexist. */
function analyzeInWorker(
  sampleId: string,
  channels: Float32Array[],
  sampleRate: number,
  duration: number,
  labeledFreq: number,
  decays: boolean,
  vibrato: boolean,
  opts: GateOpts,
): Promise<WorkerResultMessage> {
  const worker = getWorker();
  return new Promise<WorkerResultMessage>((resolve, reject) => {
    const onMsg = (e: MessageEvent<WorkerResultMessage | WorkerErrorMessage>) => {
      if (e.data.sampleId !== sampleId) return;
      worker.removeEventListener('message', onMsg);
      if (e.data.type === 'error') reject(new Error(e.data.message));
      else resolve(e.data);
    };
    worker.addEventListener('message', onMsg);
    /* Transfer the channel ArrayBuffers — they're copies of AudioBuffer
       data, so transferring is safe (AudioBuffer keeps its own backing
       storage). */
    const transferables = channels.map(c => c.buffer);
    worker.postMessage({
      type: 'analyze',
      sampleId,
      channels,
      sampleRate,
      duration,
      labeledFreq,
      decays,
      vibrato,
      opts,
    }, transferables);
  });
}

/** Iowa-MIS dev-proxy rewrite passthrough. Lets CDN URLs that point at
 *  Iowa's MIS resolve through the Vite middleware that transcodes AIFF →
 *  WAV. No-op for other URLs. */
function rewriteUrl(baseUrl: string): string {
  return (HKLInstruments as { rewriteIowaBaseUrl?: (s: string) => string }).rewriteIowaBaseUrl?.(baseUrl) ?? baseUrl;
}

/** Build candidate URLs for a CDN sample. Reuses HKLInstruments.buildUrls
 *  so placeholder semantics ({NOTE}, {NOTE_LETTER}, {NOTE_LOWER}, {MIDI})
 *  match the engine. */
function buildCandidateUrls(slot: SampleSlot): string[] {
  const state = getState();
  if (state.source.mode !== 'cdn') return [];
  const baseUrl = rewriteUrl(state.source.baseUrl);
  const cfg = {
    baseUrl,
    filePatterns: state.source.filePatterns,
    filePattern: state.source.filePatterns[0],
  };
  return (HKLInstruments as { buildUrls: (cfg: unknown, name: string, midi: number) => string[] })
    .buildUrls(cfg, slot.name, slot.midi);
}

async function fetchFirstHit(urls: string[]): Promise<{ url: string; bytes: ArrayBuffer } | null> {
  for (const url of urls) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      return { url, bytes: await r.arrayBuffer() };
    } catch {
      /* swallow — try next */
    }
  }
  return null;
}

/* File → ArrayBuffer, fast path. Copy into a fresh Uint8Array so the buffer
 * is detached from any File-backing storage — same pattern samples-engine.ts:213
 * uses for .hki bundle bytes that decode reliably in Firefox. */
async function readLocalBytesFast(file: File): Promise<ArrayBuffer> {
  const ab = await file.arrayBuffer();
  if (ab.byteLength === 0) throw new Error('file is empty');
  const copy = new Uint8Array(ab.byteLength);
  copy.set(new Uint8Array(ab));
  return copy.buffer;
}

/* Fallback: route the file through a Blob URL + fetch. This produces an
 * ArrayBuffer whose underlying buffer was allocated by Firefox's network
 * pipeline rather than the File API, which avoids the Firefox-specific
 * "unknown content type" decodeAudioData refusal on certain File-derived
 * buffers — most notably MP3s. CDN fetches don't hit this issue, which is
 * why the same bytes decode fine when served from a URL but fail when
 * read locally via File.arrayBuffer(). */
async function readLocalBytesViaBlobUrl(file: File): Promise<ArrayBuffer> {
  const url = URL.createObjectURL(file);
  try {
    const r = await fetch(url);
    return await r.arrayBuffer();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function ensureAudioBuffer(slot: SampleSlot): Promise<AudioBuffer | null> {
  if (slot.audioBuffer) return slot.audioBuffer;
  const ctx = getCtx();

  /* CDN path: single fetch, single decode attempt. */
  if (!slot.file) {
    updateSampleByName(slot.name, { state: 'fetching' });
    const candidates = buildCandidateUrls(slot);
    const hit = await fetchFirstHit(candidates);
    if (!hit) {
      updateSampleByName(slot.name, {
        state: 'failed',
        tier: 'fail',
        status: 'fetch failed (404 across all candidate URLs)',
      });
      return null;
    }
    updateSampleByName(slot.name, { state: 'decoding', url: hit.url });
    try {
      const buf = await ctx.decodeAudioData(hit.bytes);
      updateSampleByName(slot.name, { audioBuffer: buf });
      return buf;
    } catch (e) {
      updateSampleByName(slot.name, {
        state: 'failed',
        tier: 'fail',
        status: 'decode failed: ' + (e as Error).message,
      });
      return null;
    }
  }

  /* Local file path: try the fast (copy-in-place) read first; on
   * decodeAudioData failure, retry via the Blob-URL route. */
  updateSampleByName(slot.name, { state: 'decoding' });
  let firstError: Error | null = null;
  try {
    const bytes = await readLocalBytesFast(slot.file);
    const buf = await ctx.decodeAudioData(bytes);
    updateSampleByName(slot.name, { audioBuffer: buf });
    return buf;
  } catch (e) {
    firstError = e as Error;
    /* fall through to fallback */
  }
  try {
    const bytes = await readLocalBytesViaBlobUrl(slot.file);
    const buf = await ctx.decodeAudioData(bytes);
    updateSampleByName(slot.name, { audioBuffer: buf });
    return buf;
  } catch (e) {
    const fallbackMsg = (e as Error).message;
    updateSampleByName(slot.name, {
      state: 'failed',
      tier: 'fail',
      status: 'decode failed: ' + fallbackMsg
        + (firstError && firstError.message !== fallbackMsg ? ' (fast: ' + firstError.message + ')' : ''),
    });
    return null;
  }
}

/** Copy AudioBuffer channels into fresh Float32Arrays. Necessary because
 *  transferring AudioBuffer.getChannelData()'s underlying buffer would
 *  detach the AudioBuffer (breaking later audition + chart rendering). */
function copyChannels(buf: AudioBuffer): Float32Array[] {
  const out: Float32Array[] = [];
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const orig = buf.getChannelData(ch);
    const copy = new Float32Array(orig.length);
    copy.set(orig);
    out.push(copy);
  }
  return out;
}

async function analyzeOneSlot(slot: SampleSlot): Promise<void> {
  const buf = await ensureAudioBuffer(slot);
  if (!buf) return;
  const state = getState();
  const channels = copyChannels(buf);
  updateSampleByName(slot.name, { state: 'analyzing' });
  try {
    const msg = await analyzeInWorker(
      slot.name,
      channels,
      buf.sampleRate,
      buf.duration,
      slot.freq,
      state.config.decays,
      state.config.vibrato,
      state.opts,
    );
    const tier = classifyTier(msg.result, state.config.decays);
    const status = summarizeStatus(msg.result, tier);
    updateSampleByName(slot.name, {
      state: 'done',
      result: msg.result,
      gain: msg.gain ?? undefined,
      measuredLevel: msg.measuredLevel ?? undefined,
      tier,
      status,
    });
  } catch (e) {
    updateSampleByName(slot.name, {
      state: 'failed',
      tier: 'fail',
      status: 'worker error: ' + (e as Error).message,
    });
  }
}

function summarizeStatus(res: AnalysisResult, tier: string): string {
  if (res.failReason) return res.failReason;
  if (res.segments && Array.isArray(res.segments)) {
    const n = res.segments.length;
    const span = (n > 0) ? (res.segments[n - 1].b - res.segments[0].a) : 0;
    const stats = (res.stats || {}) as { bridgeCount?: number };
    const bridges = stats.bridgeCount ?? 0;
    return `${tier} · ${n} segments · span ${span.toFixed(2)}s · bridges ${bridges}`;
  }
  if (typeof res.freqActual === 'number') {
    const drift = ((res.stats || {}) as { driftCents?: number }).driftCents;
    return drift != null ? `${tier} · drift ${drift.toFixed(1)}¢` : `${tier} · ${res.freqActual.toFixed(2)} Hz`;
  }
  return tier;
}

/** Run analysis across every slot in state.samples sequentially. Updates
 *  status + progress as each completes. Runs auto-select at the end if
 *  enabled. */
export async function analyzeAll(): Promise<void> {
  const slots = getState().samples;
  if (slots.length === 0) {
    setStatus('No samples to analyze. Add files or a CDN URL first.', 0);
    return;
  }
  setStatus(`Analyzing 0/${slots.length}…`, 0);
  let done = 0;
  for (const slot of slots) {
    /* Re-read the latest slot (state.samples is replaced on update). */
    const current = getState().samples.find(s => s.name === slot.name);
    if (!current) continue;
    await analyzeOneSlot(current);
    done++;
    setStatus(`Analyzing ${done}/${slots.length}…`, done / slots.length);
  }
  applyAutoSelectIfEnabled();
  setStatus(`Analyzed ${done}/${slots.length}. Review picks and download output.`, 1);
}

/** Apply auto-select to current state.samples picks. Idempotent. */
export function applyAutoSelectIfEnabled(): void {
  const state = getState();
  if (!state.autoSelectEnabled) return;
  const picked = new Set(pickSamples(state.samples, state.config.decays, {
    keepAllGreenLowMidi: state.opts.keepAllGreenRange ? midiFromNoteName(state.opts.keepAllGreenRange[0]) : null,
    keepAllGreenHighMidi: state.opts.keepAllGreenRange ? midiFromNoteName(state.opts.keepAllGreenRange[1]) : null,
  }));
  updateSamples(slot => ({ picked: picked.has(slot.name) }));
}

function midiFromNoteName(name: string): number | null {
  /* Accepts "C4", "F#3", "Eb5" — same conventions as HKLInstruments.
     Returns null on unparseable input. */
  const m = name.match(/^([A-Ga-g])([#bs♭♯]?)(-?\d+)$/);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const accid = m[2];
  const octave = parseInt(m[3], 10);
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let semi = base[letter];
  if (accid === '#' || accid === 's' || accid === '♯') semi += 1;
  else if (accid === 'b' || accid === '♭') semi -= 1;
  return 12 * (octave + 1) + semi;
}

/** Wire the "Analyze all samples" button. Called from main.ts. */
export function initAnalyzeControls(): void {
  const btn = document.getElementById('btnAnalyze') as HTMLButtonElement | null;
  const cbAuto = document.getElementById('cbAutoSelect') as HTMLInputElement | null;
  if (!btn) return;
  btn.addEventListener('click', () => {
    btn.disabled = true;
    void analyzeAll().finally(() => {
      btn.disabled = false;
    });
  });
  if (cbAuto) {
    cbAuto.addEventListener('change', () => {
      if (getState().autoSelectEnabled === cbAuto.checked) return;
      setAutoSelectEnabled(cbAuto.checked);
      applyAutoSelectIfEnabled();
    });
  }
  /* Update progress bar from state. */
  onChange(() => {
    const state = getState();
    const bar = document.querySelector<HTMLDivElement>('#analyzeProgress .bar');
    if (bar) bar.style.width = (state.progress * 100).toFixed(1) + '%';
    const status = document.getElementById('analyzeStatus');
    if (status) status.textContent = state.status;
    /* Enable analyze button only when there's at least one sample loaded. */
    if (btn) btn.disabled = state.samples.length === 0;
  });
}
