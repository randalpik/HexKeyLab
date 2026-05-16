// Recording UI: transport controls (record/play/save/load/export/import) wired
// to capture.ts + playback.ts + hkr.ts + midi-io/*. DOM glue only — no
// recording logic lives here.

import { audio } from '../state/audio.js';
import {
  isRecording, startRecording, stopRecording,
} from '../recording/capture.js';
import {
  isPlaying, startPlayback, stopPlayback,
  getPlaybackStartTime, getPlaybackSession,
} from '../recording/playback.js';
import { snapshotMatchesLive } from '../recording/snapshot.js';
import { applySnapshot } from '../recording/apply.js';
import { serializeHkr, parseHkr, HkrParseError } from '../recording/hkr.js';
import { sessionToMidi } from '../midi-io/export.js';
import { midiToSession, selfTestRoundTrip } from '../midi-io/import.js';
import { sessionToLilypond } from '../transcription/index.js';
import {
  startCapture, stopCapture, isCapturing, isCaptureSupported,
} from '../audio/capture.js';
import { loadPrefs, savePrefs } from '../state/persistence.js';
import type { HkrSession } from '../recording/types.js';

const $ = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

let curSession: HkrSession | null = null;
let recordingStartCtxTime = 0;
let statusRaf: number | null = null;

function fmtTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return m + ':' + r.toString().padStart(2, '0');
}

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -5);
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsText(file);
  });
}
function readFileAsBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsArrayBuffer(file);
  });
}

function setStatusText(text: string): void {
  const el = $('recStatus');
  if (el) {
    el.textContent = text;
    /* Mirror the sync-status pattern: dim when idle, blue-bordered when there's
       anything to read (recording/playing/loaded/error). */
    el.classList.toggle('active', text !== 'Idle');
  }
}

function updateButtons(): void {
  const rec = isRecording();
  const play = isPlaying();
  const hasSession = curSession !== null;
  const btnRec = $<HTMLButtonElement>('btnRecord');
  const btnPlay = $<HTMLButtonElement>('btnPlay');
  const btnSave = $<HTMLButtonElement>('btnSaveHkr');
  const btnLoad = $<HTMLButtonElement>('btnLoadHkr');
  const btnExport = $<HTMLButtonElement>('btnExportMidi');
  const btnImport = $<HTMLButtonElement>('btnImportMidi');
  const btnLy = $<HTMLButtonElement>('btnExportLilypond');
  if (btnRec) {
    btnRec.textContent = rec ? '■ Stop' : '● Rec';
    btnRec.classList.toggle('recording', rec);
    btnRec.disabled = play;
  }
  if (btnPlay) {
    btnPlay.textContent = play ? '■ Stop' : '▶ Play';
    btnPlay.classList.toggle('playing', play);
    btnPlay.disabled = rec || !hasSession;
  }
  if (btnSave) btnSave.disabled = !hasSession || rec || play;
  if (btnLoad) btnLoad.disabled = rec || play;
  if (btnExport) btnExport.disabled = !hasSession || rec || play;
  /* Import requires a loaded .hkr to merge MIDI into (see onImportMidiClick). */
  if (btnImport) btnImport.disabled = !hasSession || rec || play;
  if (btnLy) btnLy.disabled = !hasSession || rec || play;
}

function updateStatus(): void {
  if (isRecording()) {
    const ctx = audio.audioCtx;
    const elapsed = ctx ? ctx.currentTime - recordingStartCtxTime : 0;
    setStatusText('Recording ' + fmtTime(elapsed));
  } else if (isPlaying()) {
    const ctx = audio.audioCtx;
    const elapsed = ctx ? ctx.currentTime - getPlaybackStartTime() : 0;
    const sess = getPlaybackSession();
    const dur = sess ? sess.durationSec : 0;
    setStatusText('Playing ' + fmtTime(elapsed) + ' / ' + fmtTime(dur));
  } else if (curSession) {
    setStatusText('Loaded ' + fmtTime(curSession.durationSec));
  } else {
    setStatusText('Idle');
  }
}

function startStatusLoop(): void {
  if (statusRaf !== null) return;
  const tick = (): void => {
    updateStatus();
    if (isRecording() || isPlaying()) {
      statusRaf = requestAnimationFrame(tick);
    } else {
      statusRaf = null;
      updateStatus();
      updateButtons();
    }
  };
  statusRaf = requestAnimationFrame(tick);
}

function requireAudio(): boolean {
  if (audio.audioEnabled && audio.audioCtx) return true;
  setStatusText('Enable Audio first');
  return false;
}

function captureEnabled(): boolean {
  return loadPrefs().captureAudio && isCaptureSupported();
}

/* Buffer for ~1.5 s after stop so sample release tails / oscillator envelope
   releases land in the WAV. Reads small (post-decay) is cheaper than a tighter
   timer that clips audible tails. */
const CAPTURE_TAIL_MS = 1500;

function finishCapture(): void {
  if (!isCapturing()) return;
  setTimeout(async () => {
    const blob = await stopCapture();
    if (!blob) return;
    downloadBlob('hkl-' + isoStamp() + '.wav', blob);
  }, CAPTURE_TAIL_MS);
}

function onRecordClick(): void {
  if (isRecording()) {
    curSession = stopRecording();
    finishCapture();
    updateButtons();
    updateStatus();
    return;
  }
  if (isPlaying()) return;
  if (!requireAudio()) return;
  startRecording();
  if (captureEnabled()) startCapture();
  recordingStartCtxTime = audio.audioCtx ? audio.audioCtx.currentTime : 0;
  updateButtons();
  startStatusLoop();
}

function onPlayClick(): void {
  if (isPlaying()) {
    stopPlayback();
    finishCapture();
    updateButtons();
    updateStatus();
    return;
  }
  if (isRecording() || !curSession) return;
  if (!requireAudio()) return;
  /* Apply snapshot if it diverges from live state (async — instrument load).
     Disable buttons during apply to avoid double-clicks. */
  const btnPlay = $<HTMLButtonElement>('btnPlay');
  if (btnPlay) btnPlay.disabled = true;
  setStatusText('Preparing…');
  const sess = curSession;
  (async (): Promise<void> => {
    try {
      if (!snapshotMatchesLive(sess.snapshot)) {
        await applySnapshot(sess.snapshot);
      }
    } catch (err) {
      setStatusText((err as Error).message);
      updateButtons();
      return;
    }
    if (captureEnabled()) startCapture();
    startPlayback(sess, () => {
      finishCapture();
      updateButtons();
      updateStatus();
    });
    updateButtons();
    startStatusLoop();
  })();
}

function onSaveHkrClick(): void {
  if (!curSession) return;
  const text = serializeHkr(curSession);
  downloadBlob('hkl-' + isoStamp() + '.hkr',
    new Blob([text], { type: 'application/json' }));
}

function onLoadHkrClick(): void {
  if (isRecording() || isPlaying()) return;
  const inp = $<HTMLInputElement>('fileInputHkr');
  if (inp) { inp.value = ''; inp.click(); }
}

async function onLoadHkrChange(e: Event): Promise<void> {
  const inp = e.target as HTMLInputElement;
  const file = inp.files && inp.files[0];
  if (!file) return;
  try {
    const text = await readFileAsText(file);
    curSession = parseHkr(text);
    updateButtons();
    updateStatus();
  } catch (err) {
    const msg = err instanceof HkrParseError ? err.message : (err as Error).message;
    setStatusText('Load failed: ' + msg);
  } finally {
    inp.value = '';
  }
}

function onExportMidiClick(): void {
  if (!curSession) return;
  const bytes = sessionToMidi(curSession);
  downloadBlob('hkl-' + isoStamp() + '.mid',
    new Blob([bytes as BlobPart], { type: 'audio/midi' }));
}

function onImportMidiClick(): void {
  if (isRecording() || isPlaying()) return;
  if (!curSession) {
    setStatusText('Load matching .hkr first');
    return;
  }
  const inp = $<HTMLInputElement>('fileInputMidi');
  if (inp) { inp.value = ''; inp.click(); }
}

function onExportLilypondClick(): void {
  if (!curSession || isRecording() || isPlaying()) return;
  const dlg = $<HTMLDialogElement>('lyExportDialog');
  if (!dlg) return;
  const titleInp = $<HTMLInputElement>('lyTitle');
  const numInp = $<HTMLInputElement>('lyNumerator');
  const bpmInp = $<HTMLInputElement>('lyBpm');
  if (titleInp && titleInp.value.trim() === '') titleInp.value = 'Untitled';
  if (numInp && numInp.value.trim() === '') numInp.value = '4';
  if (bpmInp) bpmInp.value = '';
  dlg.showModal();
}

function onLyExportSubmit(e: Event): void {
  e.preventDefault();
  const dlg = $<HTMLDialogElement>('lyExportDialog');
  if (!curSession || !dlg) { dlg?.close(); return; }
  const title = ($<HTMLInputElement>('lyTitle')?.value ?? 'Untitled').trim() || 'Untitled';
  const numerator = Math.max(1, Math.round(parseFloat($<HTMLInputElement>('lyNumerator')?.value ?? '4') || 4));
  const bpmRaw = $<HTMLInputElement>('lyBpm')?.value ?? '';
  const bpmHint = bpmRaw.trim() === '' ? null : (parseFloat(bpmRaw) || null);
  try {
    const result = sessionToLilypond(curSession, { numerator, bpmHint, title });
    downloadBlob('hkl-' + isoStamp() + '.ly',
      new Blob([result.ly], { type: 'text/plain' }));
    dlg.close();
  } catch (err) {
    setStatusText('LilyPond export failed: ' + (err as Error).message);
    dlg.close();
  }
}

function onLyCancel(): void {
  $<HTMLDialogElement>('lyExportDialog')?.close();
}

async function onImportMidiChange(e: Event): Promise<void> {
  const inp = e.target as HTMLInputElement;
  const file = inp.files && inp.files[0];
  if (!file) return;
  if (!curSession) { setStatusText('Load matching .hkr first'); inp.value = ''; return; }
  try {
    const bytes = await readFileAsBytes(file);
    curSession = midiToSession(bytes, curSession.snapshot);
    updateButtons();
    updateStatus();
  } catch (err) {
    setStatusText('Import failed: ' + (err as Error).message);
  } finally {
    inp.value = '';
  }
}

export function initRecorderUI(): void {
  const btnRec = $<HTMLButtonElement>('btnRecord');
  if (btnRec) btnRec.addEventListener('click', onRecordClick);
  const btnPlay = $<HTMLButtonElement>('btnPlay');
  if (btnPlay) btnPlay.addEventListener('click', onPlayClick);
  const btnSave = $<HTMLButtonElement>('btnSaveHkr');
  if (btnSave) btnSave.addEventListener('click', onSaveHkrClick);
  const btnLoad = $<HTMLButtonElement>('btnLoadHkr');
  if (btnLoad) btnLoad.addEventListener('click', onLoadHkrClick);
  const btnExport = $<HTMLButtonElement>('btnExportMidi');
  if (btnExport) btnExport.addEventListener('click', onExportMidiClick);
  const btnImport = $<HTMLButtonElement>('btnImportMidi');
  if (btnImport) btnImport.addEventListener('click', onImportMidiClick);
  const btnLy = $<HTMLButtonElement>('btnExportLilypond');
  if (btnLy) btnLy.addEventListener('click', onExportLilypondClick);
  const lyForm = $<HTMLFormElement>('lyExportForm');
  if (lyForm) lyForm.addEventListener('submit', onLyExportSubmit);
  const lyCancel = $<HTMLButtonElement>('lyCancelBtn');
  if (lyCancel) lyCancel.addEventListener('click', onLyCancel);
  const fiH = $<HTMLInputElement>('fileInputHkr');
  if (fiH) fiH.addEventListener('change', (e) => { void onLoadHkrChange(e); });
  const fiM = $<HTMLInputElement>('fileInputMidi');
  if (fiM) fiM.addEventListener('change', (e) => { void onImportMidiChange(e); });
  const cbCap = $<HTMLInputElement>('cbCaptureAudio');
  if (cbCap) {
    cbCap.checked = loadPrefs().captureAudio;
    cbCap.addEventListener('change', () => savePrefs({ captureAudio: cbCap.checked }));
  }

  /* Debug handle gated on URL param ?hklrec=1 — exposes the current session
     and MIDI round-trip self-test for in-DevTools verification. */
  if (new URLSearchParams(location.search).has('hklrec')) {
    (window as unknown as { __hkl_rec: unknown }).__hkl_rec = {
      getSession: (): HkrSession | null => curSession,
      setSession: (s: HkrSession): void => { curSession = s; updateButtons(); updateStatus(); },
      selfTestRoundTrip: (): unknown => curSession ? selfTestRoundTrip(curSession.snapshot) : [],
      transcribe: (opts?: { numerator?: number; bpmHint?: number | null; title?: string }): unknown =>
        curSession ? sessionToLilypond(curSession, {
          numerator: opts?.numerator ?? 4,
          bpmHint: opts?.bpmHint ?? null,
          title: opts?.title ?? 'Untitled',
        }) : null,
    };
  }

  updateButtons();
  updateStatus();
}
