// Loop-seam diagnostics overlay (dev-only).
//
// Visualizes the master output amplitude envelope (RMS, dB scale) on a
// scrolling canvas, with vertical markers at every loop-seam crossfade. Lets
// us see whether audible volume dips fall ON seams (sample/seam-data issue)
// or BETWEEN them (crossfade gain-curve issue).
//
// Activate with `?loopdiag=1` in the URL. Off by default — zero overhead.
// Hotkeys (when enabled): D = freeze · Shift+D = console-dump JSON ·
// Ctrl+D = hide/show canvas.
//
// Tap point is sampleMaster (samples-only output, not oscillators), exposed
// by SampleEngine.tapMaster.

export type SeamEvent = {
  ctxTime: number;       // audioCtx time of crossfade center (= actualSwitchTime)
  voiceKey: string;
  sampleName: string;    // e.g., "B3"
  rate: number;          // playbackRate at the moment of switching
  fromBIdx: number;      // index into loopPts we jumped FROM
  toAIdx: number;        // index into loopPts we jumped TO
  fromTime: number;      // pts[fromBIdx] (seconds into source buffer)
  toTime: number;        // pts[toAIdx]
  xfadeDur: number;      // crossfade duration (seconds)
  /* Filled in deferred by measureSeams() once the envelope buffer covers the
     window around this seam. midpointRms is the master-output RMS at
     switchTime+xfadeDur/2 (the analyzer's xfadeDev midpoint); baselineRms
     averages RMS at switchTime±50ms to anchor the measurement against slow
     drift. dipDb = 20*log10(midpoint/baseline). */
  midpointRms?: number;
  baselineRms?: number;
  dipDb?: number;
  measured?: boolean;
};

interface SampleEngineSurface {
  tapMaster(node: AudioNode): void;
}

const ENV_CAP = 1800;      // ~30 s at 60 Hz (we keep more than the visible window)
const SEAM_CAP = 300;      // plenty for a long single-note hold
const WINDOW_SEC = 15;
const MIN_DB = -60;
const MAX_DB = 0;
/* Dip thresholds (dB). Markers are coloured by measured midpoint dip:
   green (clean) > YELLOW_DB ≥ yellow (small) > RED_DB ≥ red (audible). */
const YELLOW_DB = -0.5;
const RED_DB = -2.0;
const COLOR_CLEAN = '#0f8';     // green
const COLOR_SMALL = '#fc0';     // yellow
const COLOR_AUDIBLE = '#f44';   // red
const COLOR_UNMEASURED = '#888'; // grey — measurement window not covered yet

let enabled = false;
let frozen = false;
let audioCtx: AudioContext | null = null;
/* Per-channel taps. We split the master output into L and R, run an
   AnalyserNode on each, and combine via energy-summed RMS in tick(). The
   default Web Audio "speakers" downmix to mono uses 0.5*(L+R), which reads
   ~3 dB low for mono-content-in-stereo samples (instrument samples are
   recorded mono and packed into stereo containers — both channels are
   nearly equal, so amplitude-averaging halves their energy contribution).
   Energy-summed per-channel RMS matches the analyzer's ffmpeg `-ac 1`
   measurement and is the convention used by ITU-R BS.1770 / LUFS for
   loudness perception. */
let analyserL: AnalyserNode | null = null;
let analyserR: AnalyserNode | null = null;
let timeBufL: Float32Array<ArrayBuffer> | null = null;
let timeBufR: Float32Array<ArrayBuffer> | null = null;
let canvas: HTMLCanvasElement | null = null;
let cctx: CanvasRenderingContext2D | null = null;
let rafId = 0;

const envelopeBuf: { ctxTime: number; rms: number }[] = [];
const seamBuf: SeamEvent[] = [];

export function isLoopDiagEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('loopdiag') === '1';
  } catch {
    return false;
  }
}

/* No-op when overlay isn't initialized. Call sites in samples.ts always invoke
   this; the cost when off is one function call returning early. */
export function recordSeamEvent(ev: SeamEvent): void {
  if (!enabled) return;
  seamBuf.push(ev);
  if (seamBuf.length > SEAM_CAP) seamBuf.shift();
}

export function initLoopOverlay(ac: AudioContext, sampleEngine: SampleEngineSurface): void {
  if (enabled) return;
  enabled = true;
  audioCtx = ac;
  /* ChannelSplitter routes each input channel to a separate output. We tap
     sampleMaster into the splitter, then connect each output to its own
     mono AnalyserNode. The analysers each see one channel of the stereo
     master signal — no downmix happens, getFloatTimeDomainData returns the
     raw per-channel waveform. */
  const splitter = ac.createChannelSplitter(2);
  analyserL = ac.createAnalyser();
  analyserR = ac.createAnalyser();
  analyserL.fftSize = 2048;
  analyserR.fftSize = 2048;
  analyserL.smoothingTimeConstant = 0;
  analyserR.smoothingTimeConstant = 0;
  sampleEngine.tapMaster(splitter);
  splitter.connect(analyserL, 0);
  splitter.connect(analyserR, 1);
  /* Construct from explicit ArrayBuffers so the type is Float32Array<ArrayBuffer>,
     which is what AnalyserNode.getFloatTimeDomainData expects under TS 5.7+ libs. */
  timeBufL = new Float32Array(new ArrayBuffer(analyserL.fftSize * 4));
  timeBufR = new Float32Array(new ArrayBuffer(analyserR.fftSize * 4));

  canvas = document.createElement('canvas');
  canvas.id = 'loopDiagOverlay';
  Object.assign(canvas.style, {
    position: 'fixed',
    left: '0',
    bottom: '0',
    width: '100vw',
    height: '220px',
    pointerEvents: 'none',
    zIndex: '9999',
    background: 'rgba(0,0,0,0.78)',
  });
  document.body.appendChild(canvas);
  cctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('keydown', onKey);

  console.log('%c[loopdiag] enabled · D=freeze · Shift+D=dump · \\=hide',
    'color:#0ff;font-weight:bold');
  rafId = requestAnimationFrame(tick);
}

function resizeCanvas(): void {
  if (!canvas || !cctx) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  canvas.width = Math.max(1, Math.floor(cssW * dpr));
  canvas.height = Math.max(1, Math.floor(cssH * dpr));
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function onKey(e: KeyboardEvent): void {
  /* Don't steal keys from form fields — the toolbar owns those. */
  const tag = (document.activeElement?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  if (e.altKey || e.metaKey || e.ctrlKey) return;
  /* Use e.code for Backslash so dead-key / layout differences don't matter.
     Backslash is not bound by the QWERTY note input, and the browser doesn't
     intercept the bare key (unlike Ctrl+D, which is the bookmark shortcut). */
  if (e.code === 'Backslash' && !e.shiftKey) {
    e.preventDefault();
    if (canvas) canvas.style.display = canvas.style.display === 'none' ? 'block' : 'none';
  } else if (e.key === 'D' && e.shiftKey) {
    e.preventDefault();
    /* Single-line JSON keeps this paste-friendly into other tools. */
    console.log(JSON.stringify({ envelope: envelopeBuf.slice(), seams: seamBuf.slice() }));
  } else if (e.key === 'd' && !e.shiftKey) {
    e.preventDefault();
    frozen = !frozen;
  }
}

function tick(): void {
  rafId = requestAnimationFrame(tick);
  if (!analyserL || !analyserR || !audioCtx || !timeBufL || !timeBufR) return;
  if (!frozen) {
    analyserL.getFloatTimeDomainData(timeBufL);
    analyserR.getFloatTimeDomainData(timeBufR);
    let sumL = 0, sumR = 0;
    for (let i = 0; i < timeBufL.length; i++) {
      sumL += timeBufL[i] * timeBufL[i];
      sumR += timeBufR[i] * timeBufR[i];
    }
    const N = timeBufL.length;
    const rmsSqL = sumL / N;
    const rmsSqR = sumR / N;
    /* Energy-summed RMS: sqrt(rmsL² + rmsR²). Matches ITU-R BS.1770 / LUFS
       channel summation and the analyzer's ffmpeg `-ac 1` energy-preserving
       downmix. For mono-content-in-stereo this reads +3 dB above either
       channel alone, capturing the full energy that hits the listener. */
    const rms = Math.sqrt(rmsSqL + rmsSqR);
    /* Center the envelope timestamp on the analyzer window so the dip's x
       position lines up with the audio sample that produced it. */
    const ctxTime = audioCtx.currentTime - (N / audioCtx.sampleRate) * 0.5;
    envelopeBuf.push({ ctxTime, rms });
    if (envelopeBuf.length > ENV_CAP) envelopeBuf.shift();
    measureSeams();
  }
  draw();
}

/* Linear-interpolated RMS lookup at a given audioCtx time. Returns 0 if the
   buffer is empty or t falls outside its coverage. */
function rmsAt(t: number): number {
  const n = envelopeBuf.length;
  if (n === 0) return 0;
  if (t <= envelopeBuf[0].ctxTime) return envelopeBuf[0].rms;
  if (t >= envelopeBuf[n - 1].ctxTime) return envelopeBuf[n - 1].rms;
  /* Linear scan from the end — measurement queries are typically the most
     recent few samples, so this terminates fast. */
  for (let i = n - 1; i > 0; i--) {
    if (envelopeBuf[i - 1].ctxTime <= t && envelopeBuf[i].ctxTime >= t) {
      const a = envelopeBuf[i - 1], b = envelopeBuf[i];
      const span = b.ctxTime - a.ctxTime;
      if (span <= 0) return a.rms;
      return a.rms + (b.rms - a.rms) * ((t - a.ctxTime) / span);
    }
  }
  return envelopeBuf[n - 1].rms;
}

const BASELINE_LEAD_SEC = 0.050;   // sample baseline RMS this far before/after the crossfade

/* Walk unmeasured seam events and fill in midpointRms / baselineRms / dipDb
   once the envelope ring has covered the window around each seam.
   Idempotent — events with measured=true are skipped. */
function measureSeams(): void {
  if (!audioCtx || envelopeBuf.length === 0) return;
  const now = audioCtx.currentTime;
  for (const ev of seamBuf) {
    if (ev.measured) continue;
    const tEnd = ev.ctxTime + ev.xfadeDur + BASELINE_LEAD_SEC;
    /* Wait an extra ~one frame past tEnd so the envelope buffer definitely
       has a sample at or past tEnd. */
    if (now < tEnd + 0.020) continue;
    const before = rmsAt(ev.ctxTime - BASELINE_LEAD_SEC);
    const mid = rmsAt(ev.ctxTime + ev.xfadeDur / 2);
    const after = rmsAt(ev.ctxTime + ev.xfadeDur + BASELINE_LEAD_SEC);
    const baseline = 0.5 * (before + after);
    ev.midpointRms = mid;
    ev.baselineRms = baseline;
    ev.dipDb = baseline > 1e-6 ? 20 * Math.log10(mid / baseline) : 0;
    ev.measured = true;
  }
}

function colorForDip(dipDb: number | undefined): string {
  if (dipDb === undefined) return COLOR_UNMEASURED;
  if (dipDb > YELLOW_DB) return COLOR_CLEAN;
  if (dipDb > RED_DB) return COLOR_SMALL;
  return COLOR_AUDIBLE;
}

function draw(): void {
  if (!canvas || !cctx || !audioCtx) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  cctx.clearRect(0, 0, w, h);
  if (envelopeBuf.length === 0) {
    cctx.fillStyle = 'rgba(255,255,255,0.4)';
    cctx.font = '12px sans-serif';
    cctx.fillText('loopdiag · waiting for audio…', 8, 16);
    return;
  }

  const tNow = frozen
    ? envelopeBuf[envelopeBuf.length - 1].ctxTime
    : audioCtx.currentTime;
  const tStart = tNow - WINDOW_SEC;

  const xOf = (t: number): number => ((t - tStart) / WINDOW_SEC) * w;
  /* Layout: dedicated 14px header strip at the top for seam labels (so they
     don't collide with the "0 dB" grid label), then the plot, then a 16px
     time-axis strip at the bottom. */
  const labelStripBottom = 14;
  const plotTop = labelStripBottom + 4;
  const plotBottom = h - 16;
  const yOfDb = (db: number): number => {
    const c = Math.max(MIN_DB, Math.min(MAX_DB, db));
    return plotBottom - ((c - MIN_DB) / (MAX_DB - MIN_DB)) * (plotBottom - plotTop);
  };

  /* dB grid */
  cctx.lineWidth = 1;
  cctx.font = '10px sans-serif';
  for (let db = MIN_DB; db <= MAX_DB; db += 10) {
    const y = yOfDb(db);
    cctx.strokeStyle = 'rgba(255,255,255,0.10)';
    cctx.beginPath(); cctx.moveTo(0, y); cctx.lineTo(w, y); cctx.stroke();
    cctx.fillStyle = 'rgba(255,255,255,0.45)';
    cctx.fillText(db + ' dB', 4, y - 2);
  }

  /* 1-second vertical grid */
  for (let s = Math.ceil(tStart); s <= Math.floor(tNow); s++) {
    const x = xOf(s);
    cctx.strokeStyle = 'rgba(255,255,255,0.06)';
    cctx.beginPath(); cctx.moveTo(x, plotTop); cctx.lineTo(x, plotBottom); cctx.stroke();
    cctx.fillStyle = 'rgba(255,255,255,0.3)';
    cctx.fillText((s - tNow).toFixed(0) + 's', x + 2, plotBottom + 12);
  }

  /* Seam markers: vertical lines through the plot, labels in the header strip
     at the top (above the dB grid so they don't share a row with grid labels).
     Marker colour encodes the measured midpoint dip: green clean, yellow
     small, red audible, grey if the measurement window hasn't fully arrived
     yet (e.g., the most recent seam < 50 ms ago). */
  const distinctVoiceKeys: Record<string, true> = {};
  for (const ev of seamBuf) {
    if (ev.ctxTime < tStart || ev.ctxTime > tNow) continue;
    distinctVoiceKeys[ev.voiceKey] = true;
    const x = xOf(ev.ctxTime);
    const c = colorForDip(ev.dipDb);
    cctx.strokeStyle = c;
    cctx.globalAlpha = 0.55;
    cctx.beginPath(); cctx.moveTo(x, plotTop); cctx.lineTo(x, plotBottom); cctx.stroke();
    cctx.globalAlpha = 1;
    cctx.fillStyle = c;
    /* Annotate audible-dip seams with the measured dB; keep the label compact
       for clean ones to reduce visual noise. */
    let label = ev.fromBIdx + '→' + ev.toAIdx;
    if (ev.dipDb !== undefined && ev.dipDb <= RED_DB) {
      label += ' ' + ev.dipDb.toFixed(1) + 'dB';
    }
    cctx.fillText(label, x + 2, labelStripBottom - 2);
  }

  /* Envelope line in dB. */
  cctx.strokeStyle = '#0ff';
  cctx.lineWidth = 1.5;
  cctx.beginPath();
  let started = false;
  for (let i = 0; i < envelopeBuf.length; i++) {
    const e = envelopeBuf[i];
    if (e.ctxTime < tStart) continue;
    const db = 20 * Math.log10(e.rms + 1e-6);
    const x = xOf(e.ctxTime);
    const y = yOfDb(db);
    if (!started) { cctx.moveTo(x, y); started = true; } else cctx.lineTo(x, y);
  }
  cctx.stroke();

  /* Status line: total seams in window broken out by dip bucket, plus
     last-seam summary with measured dB if available. */
  let seamsInWindow = 0, nGreen = 0, nYellow = 0, nRed = 0, nUnmeasured = 0;
  for (const ev of seamBuf) {
    if (ev.ctxTime < tStart || ev.ctxTime > tNow) continue;
    seamsInWindow++;
    if (ev.dipDb === undefined) nUnmeasured++;
    else if (ev.dipDb > YELLOW_DB) nGreen++;
    else if (ev.dipDb > RED_DB) nYellow++;
    else nRed++;
  }
  const last = seamBuf[seamBuf.length - 1];
  const lastDipStr = (last && last.dipDb !== undefined)
    ? ' (' + last.dipDb.toFixed(1) + 'dB)' : '';
  const lastInfo = last
    ? '  last: ' + last.sampleName + ' ' + last.fromBIdx + '→' + last.toAIdx + lastDipStr
    : '';
  /* Multi-voice caveat: when more than one voiceKey appears in the visible
     window, the master-RMS measurement reflects the sum of all voices, so
     per-seam dipDb numbers are unreliable. Surface this so the user knows
     to switch to single-note testing for accurate per-seam data. */
  const voiceCount = Object.keys(distinctVoiceKeys).length;
  const multiVoice = voiceCount > 1
    ? '  ⚠ ' + voiceCount + ' voices — dipDb is master sum'
    : '';
  cctx.fillStyle = 'rgba(255,255,255,0.7)';
  cctx.font = '11px sans-serif';
  const bucketStr = ' (' + nGreen + 'G/' + nYellow + 'Y/' + nRed + 'R'
    + (nUnmeasured > 0 ? '/' + nUnmeasured + '?' : '') + ')';
  const status = 'loopdiag  ' + seamsInWindow + ' seams' + bucketStr + ' / ' + WINDOW_SEC + 's'
    + lastInfo + multiVoice + (frozen ? '  [FROZEN]' : '');
  const tw = cctx.measureText(status).width;
  /* Bottom-right next to the time-axis ticks — keeps the top label strip
     reserved for seam labels exclusively. */
  cctx.fillText(status, w - tw - 8, h - 4);
}
