// Sample engine: voice lifecycle, loop scheduling, segment-switching.
// Do not refactor internals without reading docs/lessons.md
// (sample-loop invariants: never source.loop=true, all wraps via
// scheduleSegmentSwitch, commitRampSync integrates in-flight ramp position).

import { DEFAULT_DYNAMIC_MAP } from '@hkl/shared/dynamics.js';
import { readHki } from '@hkl/shared/hki.js';
import { pickNextSeam as pickSegmentSeam } from '@hkl/shared/segments.js';

/* ── Injected dependencies (set via init's config arg) ──
   The engine is decoupled from HKL app state: the host supplies an instrument
   audio provider, a velocity→gain curve, and an optional seam-event sink. This
   is what lets the engine be lifted into a standalone @hkl/engine package. */
export interface PaRampState { startVal: number; startTime: number; targetVal: number; endTime: number; }
export interface SeamEvent {
  ctxTime: number; voiceKey: string; sampleName: string; rate: number;
  fromBIdx: number; toAIdx: number; fromTime: number; toTime: number; xfadeDur: number;
  /** 'wrap' = pre-scheduled crossfade at the validated b→a pair (clean);
      'immediate' = synchronous splice from the current playhead (backstop —
      phase-unvalidated, audible under sustained tones; should be rare). */
  kind?: 'wrap' | 'immediate';
  /** Set (ms) when scheduleSegmentSwitch's now+5ms floor deferred this fade
      past the natural wrap — the old source played that far beyond its
      validated b before the crossfade began (phase-unvalidated content; the
      seam-dip class from handoff/hkle-inflight-crossfade-cut.md). Post-2.4.3
      this should only ever fire on a real JS stall: retune calls arriving
      inside XFADE_GUARD_S of the wrap ride the in-flight path instead of
      cancel+reschedule. Non-zero values under normal load are a bug. */
  deferredMs?: number;
}
export interface SampleEngineConfig {
  /** Audio bytes for an imported ('hki') instrument, keyed by sample file. */
  instrumentProvider?: (key: string) => Promise<Record<string, Uint8Array> | null>;
  /** Musical velocity (0–127) → linear gain. Defaults to a bare v/127 ramp. */
  velocityToGain?: (v: number) => number;
  /** Optional sink for loop-seam crossfade diagnostics. */
  onSeamEvent?: (ev: SeamEvent) => void;
  /** Fetch raw audio bytes for a URL — CDN samples and shipped `.hki` bundle
      URLs both route through here. Defaults to global `fetch`. Inject to load
      bytes however the host needs (e.g. a React Native consumer resolving
      expo-asset URIs, or a test harness serving fixtures). */
  audioFetch?: (url: string) => Promise<ArrayBuffer>;
}
let instrumentProvider: ((key: string) => Promise<Record<string, Uint8Array> | null>) | null = null;
let velocityToGain: (v: number) => number = (v) => v / 127;
let onSeamEvent: ((ev: SeamEvent) => void) | null = null;
let audioFetch: (url: string) => Promise<ArrayBuffer> =
  (url) => fetch(url).then((r) => {
    if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching ' + url);
    return r.arrayBuffer();
  });

/** Per-note sample within an instrument. Loosely typed — analyzer output varies
    by instrument and unknown fields pass through. */
export interface SampleDef {
  /** Note name (e.g. 'A4'); used for filePattern substitution + logging. */
  name: string;
  /** Reference frequency (Hz) the sample was recorded at. */
  freq: number;
  /** Exact filename for CDN fetch / archive lookup (wins over filePattern). */
  file?: string;
  /** Per-sample linear gain (normalization). */
  gain?: number;
  /** Loop-point times (sec) — legacy single-loop shape. */
  loopPts?: number[];
  /** Seam-switching loop segments [{a, b}, …] (sec). */
  segments?: { a: number; b: number }[];
  /** Discrete velocity layers (.hki v2); `vel` is the layer reference velocity. */
  layers?: Array<Record<string, unknown> & { vel?: number }>;
  /** Analyzer trend-normalization envelope (sustained loops). */
  trend?: number[];
  trendHopMs?: number;
  trendStartSec?: number;
  /** Analyzer-chosen seam crossfade duration (sec). Absent ⇒ 0.030. */
  crossfadeSec?: number;
  [k: string]: unknown;
}

/** An instrument definition consumed by `loadInstrument`. Either a CDN-fetched
    set (`baseUrl` + `filePattern` or per-sample `file`) or an `.hki` bundle
    (`source: 'hki' | 'hki-shipped'`; bytes via `instrumentProvider` / `bundleUrl`). */
export interface InstrumentDef {
  name: string;
  samples: SampleDef[];
  /** Sustained-loop (true) vs one-shot decay (false/absent). */
  loop?: boolean;
  /** Release fade time (sec). */
  releaseTime?: number;
  /** Bundle kind; absent = CDN. */
  source?: 'hki' | 'hki-shipped';
  baseUrl?: string;
  ext?: string;
  filePattern?: string;
  /** Shipped-bundle URL (source: 'hki-shipped'). */
  bundleUrl?: string;
  [k: string]: unknown;
}

/* Analytic in-flight value of an exponentialRampToValueAtTime, computed from
   JS-tracked ramp state — polyfill for cancelAndHoldAtTime (absent in Firefox).
   dB-linear curve: gain(t) = start·(target/start)^t. Pure; exported for the
   host's pre-call anchor computation (see engine.ts handleAftertouch). */
export function inflightExpRampValue(rs: PaRampState, now: number): number {
  if (now <= rs.startTime) return rs.startVal;
  if (now >= rs.endTime) return rs.targetVal;
  const t = (now - rs.startTime) / (rs.endTime - rs.startTime);
  return rs.startVal * Math.pow(rs.targetVal / rs.startVal, t);
}

/* Cache of shipped-bundle audio maps, keyed by instrument key. Each entry is
   a Promise<{file → bytes}> that resolves to the bundle's archive contents.
   Populated on first selection of a `source:'hki-shipped'` instrument; the
   resolved audio is kept in memory until page reload. */
const shippedBundleCache: Record<string, Promise<Record<string, Uint8Array>>> = {};

function fetchShippedBundle(instr: any): Promise<Record<string, Uint8Array>> {
  const url = instr.bundleUrl;
  if (!url) return Promise.reject(new Error('Shipped HKI instrument missing bundleUrl'));
  /* TS sees the indexed-access type as non-undefined, but a Record index that
     was never assigned IS undefined at runtime — guard explicitly with `in`. */
  if (url in shippedBundleCache) return shippedBundleCache[url];
  shippedBundleCache[url] = audioFetch(url).then(ab => {
    const bundle = readHki(new Uint8Array(ab));
    return bundle.audio;
  }).catch(err => {
    /* On failure, evict the cache entry so a retry on next selection can
       attempt the fetch again rather than re-throwing the cached error. */
    delete shippedBundleCache[url];
    throw err;
  });
  return shippedBundleCache[url];
}

const RELEASE_SCALE = 0.5;
/* "The crossfade is imminent or in flight" horizon. A pending switch closer
   than this must never be cancelled+rescheduled: scheduleSegmentSwitch's
   now+5ms floor would defer the fade past the validated wrap point — the old
   source plays phase-unvalidated content beyond b before fading into an `a`
   validated for b (measured −3..−6 dB seam dips under 20–40ms retune cadence;
   the ten deepest all at exactly the 5ms floor — see lessons.md 2026-08-25).
   Instead such calls take the in-flight path: ramp/stop events are applied to
   BOTH sounding sources and the fade completes at its already-scheduled,
   sample-aligned time. 12ms = the 5ms reschedule floor + TWO render quanta
   (~2.9ms each @ 44.1k/128 — the gate's clock read and scheduleSegmentSwitch's
   fresh read can straddle a boundary each) + JS execution budget between the
   two reads. An 8ms guard left 0.1ms of that budget and measurably still
   deferred under load (3 deferred seams, 0.497 dip, in the sub-ms hammer
   scenario). Trajectory cost of retuning this close to a scheduled fade is
   sub-sample (≤12ms × rate delta), vs up to 220 samples of misalignment from
   the deferral. */
const XFADE_GUARD_S = 0.012;
/* Short attack ramp applied to segGain on every note-on. The perceptual-onset
   trim (findPerceptualOnset) deliberately starts playback ON the rising edge of
   the strike, ~1–3 ms before the envelope reaches −9 dB rel. the attack peak, so
   the first played sample is a nonzero step of maybe −25…−12 dB rel. peak; and
   simultaneous soft layers (a Composer chord) would stack those steps into an
   audible click. A few ms of fade-in removes the discontinuity; ≤5 ms is below
   the threshold where it audibly softens a struck/percussive attack. */
const ATTACK_FADE_S = 0.004;
/* Perceptual-onset trim for decaying instruments (load time; see the trim block
   in loadInstrument). Replaces the former fixed amplitude gate (0.02 on the
   gain-normalized signal, ≈ −34 dBFS). An amplitude gate is not an onset
   detector: the 2026-09-12 audit of the Korg SP-250 .hki found every sample
   carries a low-level pre-strike segment (~−23 dB rel. the attack peak, harmonic
   to the note, 10–50 ms long, longer at higher velocity) that the gate tripped
   on, so playback started 10–50 ms BEFORE the perceptual onset, differently per
   note and per layer — the "inconsistent onset / lag" Max heard live. The
   detector instead measures a short RMS envelope over the attack, finds the
   attack peak, and starts where the envelope first reaches ONSET_REL_DB below
   that peak (the steep part of the strike), backed off ONSET_BACKOFF_S so the
   attack fade-in covers the rise. Tightly pre-cut sample sets (e.g. VCSL
   harpsichord, whose files start on the strike) land within a window or two of
   sample 0, byte-for-byte equivalent to the old gate there. */
const ONSET_LOW_GATE_NORM = 0.002;   /* −54 dBFS normalized: where the attack search begins */
const ONSET_SEARCH_S = 0.4;          /* attack peak is searched within this span after the low gate */
const ONSET_ENV_WIN_S = 0.002;       /* RMS envelope window */
const ONSET_ENV_HOP_S = 0.0005;      /* RMS envelope hop */
const ONSET_REL_DB = -9;             /* start where the envelope first reaches peak + this (dB) */
const ONSET_BACKOFF_S = 0.001;       /* then back off this far (never before the low gate) */
/* Raised-cosine fade baked INTO the decoded buffer from the onset (decay
   instruments, load time). Why, when sNoteOn already ramps segGain over
   ATTACK_FADE_S: that ramp lives on the automation timeline, anchored at the
   pre-scheduled startT, while the live-input path gives the source only a 5 ms
   lead — when the render thread has already passed startT, `source.start` is
   clamped to "now" and begins reading from the trim point, but the ramp has
   already (partly) run, so the first samples come out at (near) full gain: a
   step, i.e. a click. With the old −34 dBFS gate that step was inaudible; the
   perceptual onset sits at −25…−7 dB rel. peak, so the latent race became
   audible (Max, 2026-09-12: "occasional clicks on onsets"). A fade in the PCM
   itself starts from zero no matter when the source actually starts. Kept short
   so the combined attack (baked × ramp) stays below the ~5 ms softening line. */
const ONSET_BAKED_FADE_S = 0.003;

/* Apply the baked onset fade in place from `onsetIdx` on every channel of an
   AudioBuffer-like object (anything with numberOfChannels + getChannelData).
   Samples before onsetIdx are left untouched (never played: playback starts at
   trimStart). Pure w.r.t. everything but the buffer's PCM; exported for tests. */
export function bakeOnsetFade(buf: { numberOfChannels: number; length: number; sampleRate: number; getChannelData(c: number): Float32Array }, onsetIdx: number): void {
  var n=buf.length; if(onsetIdx<0||onsetIdx>=n)return;
  var fn=Math.min(Math.round(ONSET_BAKED_FADE_S*buf.sampleRate),n-onsetIdx);
  if(fn<=1)return;
  for(var c=0;c<buf.numberOfChannels;c++){
    var d=buf.getChannelData(c);
    for(var i=0;i<fn;i++){d[onsetIdx+i]*=0.5-0.5*Math.cos(Math.PI*i/fn);}
  }
}

/* Find the perceptual onset (sample index) of a decaying note. `gain` is the
   per-sample normalization gain applied at playback, so thresholds are on the
   NORMALIZED signal and every layer is judged on the same footing regardless of
   capture loudness. Returns 0 for silence / degenerate input. Pure; exported for
   headless verification (test/engine-smoke, and the .hki audit tooling). */
export function findPerceptualOnset(data: Float32Array, sr: number, gain: number): number {
  var n=data.length; if(n===0)return 0;
  var g=(typeof gain==='number'&&gain>0)?gain:1.0;
  var low=-1;
  for(var i=0;i<n;i++){if(Math.abs(data[i])*g>ONSET_LOW_GATE_NORM){low=i;break;}}
  if(low<0)return 0;
  var win=Math.max(1,Math.round(ONSET_ENV_WIN_S*sr));
  var hop=Math.max(1,Math.round(ONSET_ENV_HOP_S*sr));
  var end=Math.min(n,low+Math.round(ONSET_SEARCH_S*sr));
  if(end-low<win)return low;
  var count=Math.floor((end-low-win)/hop)+1;
  var env=new Float32Array(count);
  var peak=0;
  for(var k=0;k<count;k++){
    var st=low+k*hop,e=0;
    for(var j=0;j<win;j++){var v=data[st+j]*g;e+=v*v;}
    var r=Math.sqrt(e/win);env[k]=r;if(r>peak)peak=r;
  }
  if(peak<=0)return low;
  var thresh=peak*Math.pow(10,ONSET_REL_DB/20);
  var onset=low;
  for(var m=0;m<count;m++){if(env[m]>=thresh){onset=low+m*hop;break;}}
  onset-=Math.round(ONSET_BACKOFF_S*sr);
  if(onset<low)onset=low;
  return onset;
}

/* Equal-power crossfade base curves. cos/sin pair keeps Σ(g²)≈1 across the
   fade so summed voices stay at constant perceived loudness (linear ramps
   dip ~3 dB at the midpoint). Used by sSlideAndFadeOut (old voice → 0) and
   sNoteOnFaded (new voice 0 → vol) when sustained instruments transpose. */
const EQUAL_POWER_LEN = 64;
const _epFadeOut = new Float32Array(EQUAL_POWER_LEN);
const _epFadeIn = new Float32Array(EQUAL_POWER_LEN);
for (let i = 0; i < EQUAL_POWER_LEN; i++) {
  const t = i / (EQUAL_POWER_LEN - 1);
  _epFadeOut[i] = Math.cos(t * Math.PI / 2);
  _epFadeIn[i] = Math.sin(t * Math.PI / 2);
}

let ctx: any = null;
let master: any = null;
let sampleMaster: any = null;
const buffers: Record<string, any> = {};
const activeVoices: Record<string, any> = {};
const loadedInstruments: Record<string, any> = {};

  export function init(audioCtx: AudioContext, destNode: AudioNode, config?: SampleEngineConfig): void {
    ctx=audioCtx;
    sampleMaster=ctx.createGain();
    sampleMaster.gain.value=1.0;
    sampleMaster.connect(destNode);
    master=sampleMaster;
    if(config){
      if(config.instrumentProvider)instrumentProvider=config.instrumentProvider;
      if(config.velocityToGain)velocityToGain=config.velocityToGain;
      if(config.onSeamEvent)onSeamEvent=config.onSeamEvent;
      if(config.audioFetch)audioFetch=config.audioFetch;
    }
  }
  /* Bakes the analyzer-generated trend envelope into the decoded PCM in place.
     The trend array is mean-normalized to ~1 over the sample's steady region
     (with a 0.05 floor outside it), so dividing every channel sample by the
     linearly-interpolated trend value flattens the slow bow/breath drift
     while preserving average loudness inside the loop. Outside the curve's
     time range, samples pass through unchanged. Float32Array references from
     getChannelData() on a freshly-decoded buffer are writable; no fresh
     AudioBuffer needed. */
  function applyTrendNormalization(buf: any, trend: number[], hopMs: number, startSec: number): void {
    var sr=buf.sampleRate;
    var hopSec=hopMs/1000;
    if(hopSec<=0||trend.length<2)return;
    var nLast=trend.length-1;
    var startSample=Math.round(startSec*sr);
    var hopSamples=hopSec*sr;
    for(var ch=0;ch<buf.numberOfChannels;ch++){
      var d=buf.getChannelData(ch);
      for(var i=0;i<d.length;i++){
        var f=(i-startSample)/hopSamples;
        if(f<=0||f>=nLast)continue; /* outside curve range → trend = 1 (no change) */
        var i0=f|0;
        var frac=f-i0;
        var t=trend[i0]*(1-frac)+trend[i0+1]*frac;
        if(t>0)d[i]=d[i]/t;
      }
    }
  }
  export function loadInstrument(key: string, instrDef: InstrumentDef, onProgress?: (loaded: number, total: number, name: string) => void): Promise<void> {
    return new Promise<void>(function(resolve,reject){
      var instr: any=instrDef;loadedInstruments[key]=instrDef;
      if(!instr)return reject(new Error('Unknown instrument: '+key));
      if(buffers[key]){return resolve();}
      var loaded=0,total=instr.samples.length,result: any[] = [];
      var aborted=false;
      /* For HKI-backed instruments, pull all audio bytes up-front so the
         per-sample loop below can be synchronous. Two flavors:
           'hki'         user-imported, audio in IndexedDB (no network).
           'hki-shipped' canonical shipped bundle, audio in public/samples/
                         on first selection (network fetch, in-memory cached
                         for subsequent selections).
         CDN instruments skip this entirely. */
      var hkiAudioPromise: Promise<Record<string, Uint8Array> | null>;
      if (instr.source==='hki') {
        hkiAudioPromise = instrumentProvider ? instrumentProvider(key) : Promise.resolve(null);
      } else if (instr.source==='hki-shipped') {
        hkiAudioPromise = fetchShippedBundle(instr);
      } else {
        hkiAudioPromise = Promise.resolve(null);
      }
      hkiAudioPromise.then(function(hkiAudio){
        if((instr.source==='hki' || instr.source==='hki-shipped') &&
           (!hkiAudio || Object.keys(hkiAudio).length===0)){
          var src=instr.source==='hki-shipped' ? 'shipped bundle' : 'imported bundle';
          return reject(new Error('HKI instrument "'+key+'" has no audio in '+src+'.'));
        }
        runLoad(hkiAudio);
      }, function(err){ reject(err); });
      /* Body extracted so we can await hkiAudio above when applicable. */
      function runLoad(hkiAudio: Record<string, Uint8Array> | null): void {
      function logLoopReport(){
        console.log('=== Loop points for '+instr.name+' ===');
        var tableRows: any[] = [];
        for(var i=0;i<result.length;i++){
          var r=result[i];if(!r)continue;
          var pts=r.lp&&r.lp.loopPts;
          if(!pts||pts.length<2){
            var failRow: any = {sample:instr.samples[i].name,freq:r.freq,count:pts?pts.length:0,
              span_ms:'-',min_gap_ms:'-',max_gap_ms:'-',mean_gap_ms:'-'};
            if(r.lp&&r.lp.stats&&!r.lp.stats.precomputed){
              failRow.slopeCV=r.lp.stats.slopeCV||'-';
              failRow.crossings=r.lp.stats.crossings||'-';
              failRow.candidates=r.lp.stats.candidates||'-';
              failRow.correlated=r.lp.stats.correlated||'-';
              failRow.failReason=r.lp.stats.failReason||'-';
            }
            tableRows.push(failRow);
            continue;
          }
          var gaps=[];
          for(var j=1;j<pts.length;j++)gaps.push((pts[j]-pts[j-1])*1000);
          var span=(pts[pts.length-1]-pts[0])*1000;
          var minG=Math.min.apply(null,gaps),maxG=Math.max.apply(null,gaps);
          var meanG=gaps.reduce(function(a: number, b: number){return a+b;},0)/gaps.length;
          var row: any = {
            sample:instr.samples[i].name,freq:r.freq,
            count:pts.length,
            span_ms:Math.round(span),
            min_gap_ms:Math.round(minG),
            max_gap_ms:Math.round(maxG),
            mean_gap_ms:Math.round(meanG),
            slopeCV:r.lp.slopeCV!==undefined?(typeof r.lp.slopeCV==='number'?r.lp.slopeCV.toFixed(3):r.lp.slopeCV):'-'
          };
          /* Only show runtime-analysis stats for samples that weren't precomputed */
          if(r.lp.stats&&!r.lp.stats.precomputed){
            row.crossings=r.lp.stats.crossings;
            row.candidates=r.lp.stats.candidates;
            row.correlated=r.lp.stats.correlated;
            row.corr_thresh=r.lp.stats.corrThresh;
          }
          tableRows.push(row);
        }
        console.table(tableRows);
      }
      instr.samples.forEach(function(s: any, i: number){
        if(aborted)return;
        /* Two audio-source paths:
             CDN (source omitted or any non-'hki' value): fetch s.file (or
               filePattern-substituted name) from instr.baseUrl.
             HKI (source==='hki'): read s.file from the in-memory bundle audio
               map we awaited above. No network.
           Per-sample s.file wins for CDN: the analyzer records the exact
           filename it fetched per note, which is the only safe option when an
           instrument's filePatterns array tries multiple URL templates
           (Iowa strings' sul-string prefixes, VCSL harpsichord's Low/High
           registers) and different notes resolved to different templates. For
           legacy instruments without s.file, fall back to pattern substitution. */
        var timer=setTimeout(function(){aborted=true;delete buffers[key];reject(new Error("Timeout loading "+s.name));},10000);
        var arrayBufferPromise: Promise<ArrayBuffer>;
        if(instr.source==='hki' || instr.source==='hki-shipped'){
          var bytes=hkiAudio&&hkiAudio[s.file];
          if(!bytes){
            arrayBufferPromise=Promise.reject(new Error('Missing audio in bundle: '+s.file));
          } else {
            /* Copy into a fresh ArrayBuffer so decodeAudioData (which detaches
               its input) doesn't strand the registry's cached Uint8Array. */
            var copy=new Uint8Array(bytes.byteLength);
            copy.set(bytes);
            arrayBufferPromise=Promise.resolve(copy.buffer);
          }
        } else {
          var url;
          if(s.file){
            url=instr.baseUrl+s.file.replace(/#/g,'%23');
          } else {
            var pat=instr.filePattern||('{NOTE}'+instr.ext);
            url=instr.baseUrl+pat.replace('{NOTE}',s.name).replace(/#/g,'%23');
          }
          arrayBufferPromise=audioFetch(url);
        }
        arrayBufferPromise.then(function(ab){return ctx.decodeAudioData(ab);}).then(function(buf){
          clearTimeout(timer);if(aborted)return;
          /* Trend normalization — applied once at load, BEFORE loop-point
             snapping and silence-trim detection (both of which only read
             metadata fields, not PCM, so order is purely for clarity).
             Sustained-loop samples only; absent fields silently skip. */
          if(instr.loop&&Array.isArray(s.trend)&&typeof s.trendHopMs==='number'&&typeof s.trendStartSec==='number'){
            applyTrendNormalization(buf,s.trend,s.trendHopMs,s.trendStartSec);
          }
          var lp;
          if(instr.loop&&(s.loopPts||s.segments)){
            /* Trust the precomputed loop data as-is. The analyzer runs in
               the browser via decodeAudioData, so its points are already
               sample-aligned to the browser's decoded audio.

               Two loop-state shapes are accepted:
                 segments: [{a, b}, ...]
                   Each entry is a self-contained loop pair. The runtime
                   picker plays to a chosen b, crossfades back to that
                   segment's a, then chooses another segment whose b is
                   reachable. See pickNextSeam's segments branch.
                 loopPts + validStartsByEnd (legacy):
                   Clique-pipeline data. pickNextSeam's legacy branch picks
                   (a, b) indices into loopPts subject to the vsbe graph.

               Snap a/b/trimStart to integer audio samples — the paste-output
               rounded to 7 decimals, which loses sub-sample precision (e.g.
               trimStart=0.0094 round-trips to 414.54 instead of 414). At
               rate=1 a fractional offset forces buffer-read interpolation
               everywhere it propagates; snapping normalizes everything to
               the integer grid so for rate=1 every source reads at integer
               samples with no interpolation. */
            var sr=buf.sampleRate;
            var snappedTrim=Math.round((s.trimStart||0)*sr)/sr;
            lp=({trimStart:snappedTrim,slopeCV:s.slopeCV||0} as any);
            if(s.segments){
              lp.segments=s.segments.map(function(seg: any){
                return {a:Math.round(seg.a*sr)/sr,b:Math.round(seg.b*sr)/sr};
              });
              lp.stats={precomputed:true,segments:s.segments.length};
            }
            if(s.loopPts){
              lp.loopPts=s.loopPts.map(function(p: number){return Math.round(p*sr)/sr;});
              lp.validStartsByEnd=s.validStartsByEnd;
              lp.endsByStart=s.endsByStart;
              if(!lp.stats)lp.stats={precomputed:true,count:s.loopPts.length};
            }
          } else if(instr.loop){
            /* No runtime fallback — the analyzer must produce either segments
               or loopPts for any loop-mode instrument we ship. To regenerate:
                 node analyzer/generate-samples.js analyzer/configs/<key>.json
                 node analyzer/insert-instrument.js analyzer/configs/<key>.json */
            var msg='SampleEngine: instrument "'+key+'" sample "'+s.name+'" is loop-mode but has neither segments nor loopPts. Re-run the analyzer for this sample.';
            console.error(msg);
            aborted=true;
            delete buffers[key];
            reject(new Error(msg));
            return;
          } else {
            lp={trimStart:0};
          }
          /* Trim to the PERCEPTUAL onset for decaying instruments (the manifest
             trimStart is an analyzer/HKLO amplitude-gate value and is ignored
             here). Measured on the GAIN-APPLIED signal so every layer is judged
             at its playback level; see findPerceptualOnset for the rationale.
             The result is an integer sample index, so rate=1 reads stay on the
             integer grid; the attack fade-in (not a low threshold) handles the
             start step. */
          if(!instr.loop){var _g=(typeof s.gain==='number')?s.gain:1.0;var _d=buf.getChannelData(0);var _on=findPerceptualOnset(_d,buf.sampleRate,_g);lp.trimStart=_on/buf.sampleRate;bakeOnsetFade(buf,_on);}
          result[i]={buffer:buf,freq:s.freq,gain:(typeof s.gain==='number')?s.gain:1.0,vel:(typeof s.vel==='number')?s.vel:null,lp:lp,name:s.name,crossfadeSec:(typeof s.crossfadeSec==='number'&&s.crossfadeSec>0)?s.crossfadeSec:null};loaded++;
          if(onProgress)onProgress(loaded,total,s.name);
          if(loaded===total&&!aborted){
            buffers[key]=result.filter(function(x){
              if(x===null)return false;
              /* for looping instruments, exclude samples that failed to
                 produce loop data — accept EITHER segments (new pipeline)
                 OR loopPts (legacy). Without this both-format check, every
                 segments-only sample is filtered out at load time, leaving
                 an empty buffer array that findNearest reports as missing
                 even though isInstrumentLoaded returns true. */
              if(instr.loop&&(!x.lp||(!x.lp.loopPts&&!x.lp.segments)))return false;
              return true;
            });
            resolve();
          }
        }).catch(function(err){
          clearTimeout(timer);if(aborted)return;
          result[i]=null;loaded++;console.warn('Failed to load '+s.name+':',err);
          if(onProgress)onProgress(loaded,total,s.name+' \u2717');
          if(loaded===total&&!aborted){
            buffers[key]=result.filter(function(x){
              if(x===null)return false;
              if(instr.loop&&(!x.lp||(!x.lp.loopPts&&!x.lp.segments)))return false;
              return true;
            });
            if(buffers[key].length===0){delete buffers[key];reject(new Error('All samples failed'));}
            else{resolve();}}
        });
      });
      } /* end runLoad */
    });
  }
  /* Discrete velocity-layer pick: among the layers of one note (entries sharing
     a pitch), return the one whose reference velocity (`vel`) is nearest the input
     velocity. Single-layer notes (≤1 entry, or no `vel` on any entry) return the
     first entry unchanged — identical to pre-velocity-layer behavior. Ties resolve
     to the lower-velocity layer (strict `<`). Pure; exported for unit testing. */
  export function pickLayer(layers: any[], velocity: number): any {
    if(!layers||layers.length===0)return null;
    if(layers.length===1)return layers[0];
    var anyVel=false;
    for(var i=0;i<layers.length;i++){if(layers[i].vel!=null){anyVel=true;break;}}
    if(!anyVel)return layers[0];
    var v=(velocity!=null?velocity:64);
    var pick=layers[0],pickDist=Infinity;
    for(var k=0;k<layers.length;k++){
      var lv=(layers[k].vel!=null?layers[k].vel:64);
      var d=Math.abs(lv-v);
      if(d<pickDist){pickDist=d;pick=layers[k];}
    }
    return pick;
  }
  /* Quantize a frequency to a 5-cent bucket so the velocity layers of one note
     group together. Layers of a note share an exact freq (the analyzer reuses one
     measured fundamental across a note's layers), but bucketing on cents avoids
     float-equality fragility. Distinct notes are ≥100 cents apart, so one bucket
     ⟺ one note. */
  function freqKey(f: number): number { return Math.round(Math.log2(f)*1200/5); }
  function findNearest(freq: number, velocity: number | undefined, instrumentKey: string): any {
    var samps=buffers[instrumentKey];
    if(!samps||samps.length===0)return null;
    /* Stage 1: nearest sample by pitch (unchanged metric). */
    var best=0,bestDist=Infinity;
    for(var i=0;i<samps.length;i++){var dist=Math.abs(Math.log2(freq/samps[i].freq));if(dist<bestDist){bestDist=dist;best=i;}}
    /* Stage 2: among the layers sharing the chosen note's pitch, pick the layer
       whose reference velocity is nearest the input. A note with ≤1 row, or no
       `vel` on any row, short-circuits to the stage-1 pick — byte-for-byte
       identical to pre-velocity-layer behavior. */
    var chosenKey=freqKey(samps[best].freq);
    var layers:any[]=[];
    for(var j=0;j<samps.length;j++){if(freqKey(samps[j].freq)===chosenKey)layers.push(samps[j]);}
    if(layers.length<=1)return samps[best];
    return pickLayer(layers,(velocity!=null?velocity:64));
  }
  /* Range attenuation: pure function of frequency (no state). Returns gain factor
     for a given frequency — 1.0 within range, reducing toward 0.5 as freq exceeds
     the highest sample. Used identically by sNoteOn and sNoteOnFaded so that
     transposing up and back down fully restores the original gain. */
  function rangeAttenuation(freq: number, instrumentKey: string): number {
    var samps=buffers[instrumentKey];
    if(!samps||samps.length===0)return 1.0;
    var highestFreq=samps[samps.length-1].freq;
    if(freq<=highestFreq)return 1.0;
    var overshoot=freq/highestFreq; /* 1.0 at top, 1.5 = fifth up, 2.0 = octave up */
    /* gentle taper: 1.0 → 1.0, 1.5 → 0.82, 2.0 → 0.64, ≥2.4 → 0.5 (clamped) */
    return Math.max(0.5,1.0-(overshoot-1.0)*0.36);
  }
  export function sNoteOn(voiceKey: string, freq: number, velocity: number, instrumentKey: string, startAt?: number, pan?: number): void {
    if(!ctx||!instrumentKey||!buffers[instrumentKey])return;
    if(activeVoices[voiceKey])sNoteOff(voiceKey);
    /* Resolve velocity once: it both selects the velocity layer (findNearest)
       and drives the gain curve (baseVol). The curve supplies the overall
       dynamics; each layer's baked gain (s.gain) carries a perceptual softening
       (orchestrator buildHki) so brighter layers sit at the device's own
       relative loudness rather than a flat target. */
    var resolvedVel=(velocity!==undefined?velocity:DEFAULT_DYNAMIC_MAP.f);
    var nearest=findNearest(freq,resolvedVel,instrumentKey);
    if(!nearest)return;
    var instr=loadedInstruments[instrumentKey];
    var rate=freq*(instr.transpose||1)/nearest.freq;
    var instrVol=instr.volume||1.0;
    var baseVol=velocityToGain(resolvedVel)*instrVol;
    /* ── ABOVE-RANGE VIBRATO ATTENUATION ──
       When a note is requested above the highest sampled pitch, the sample gets
       pitch-shifted up — which also speeds up its vibrato (cello's ~5Hz vibrato
       at rate=1.68× becomes ~8.4Hz, sounds unnatural). We can't slow the vibrato
       without Melodyne-style time-stretching, but reducing overall gain makes the
       vibrato less prominent in proportion to its speed. Pure function of frequency
       (not stateful) so that transposing up and back down fully restores gain. */
    /* Per-sample RMS-normalization gain, baked in by the analyzer to bring
       the steady (loop) or attack-peak (decay) RMS to a uniform target across
       all instruments. Defaults to 1.0 if absent — see analyzer/backfill-gains.js. */
    var vol=baseVol*rangeAttenuation(freq,instrumentKey)*(nearest.gain!=null?nearest.gain:1.0);
    /* pressureGain: modulated by polyphonic aftertouch. Initialized to 1.0 so
       the note plays at its velocity-driven volume until the first aftertouch
       message arrives (which may be never, or well after onset). Placed outside
       voiceGain so it doesn't interfere with the release envelope. */
    var pressureGain=ctx.createGain();pressureGain.gain.value=1.0;pressureGain.connect(master);
    /* damperGain: continuous-damper modulation. Sits between voiceGain (release
       envelope) and pressureGain (aftertouch) — engine.ts ramps it via
       setVoiceDamperDepth while the key is in sustainedKeys, pins to 1.0 for
       sostenuto-locked keys. Default 1.0 = no attenuation. */
    var damperGain=ctx.createGain();damperGain.gain.value=1.0;damperGain.connect(pressureGain);
    /* voiceGain: persistent node for this voice — noteOff fades this to silence everything */
    var voiceGain=ctx.createGain();voiceGain.gain.value=1.0;voiceGain.connect(damperGain);
    var segGain=ctx.createGain();
    /* Schedule the source slightly in the future, not at currentTime, and
       record sourceStartTime as the same future moment.
       Reason: source.start(t, ...) with t < ctx.currentTime gets clamped by
       Web Audio to the actual currentTime at processing — which can be one
       render quantum (~2.7ms) or more past `t` if JS stalls between
       capturing currentTime and the audio thread consuming the schedule.
       Recording sourceStartTime as the JS-captured time then under-records
       the actual start moment, throwing off the switchTime computation in
       scheduleSegmentSwitch. The mismatch produces a phase-shifted crossfade
       on the first switch that the analyzer never validated → audible dip.
       Pre-scheduling ahead makes start exact (no clamping). The lead is
       note-onset latency the player hears, so it's split by instrument type:
         loop:  15ms — ~5 render quanta of margin over the normal 1–2-quanta
                currentTime-read → render-thread-delivery window. Worst case
                (an extreme GC pause inside that window) is a one-time subtle
                dip at the FIRST seam of that note only; subsequent sources
                are pre-scheduled on the audio clock in scheduleSegmentSwitch
                and stay exact regardless.
         decay: 5ms — segment switching is never armed (see the instr.loop
                guard below), so nothing depends on start-time exactness;
                sourceStartTime is only read by the retune-ramp position
                math, where a few-ms clamp error is inaudible. Minimal lead
                keeps struck/plucked attacks immediate.
       (History: this was a flat 50ms chosen to survive any plausible JS
       stall, but it read as constant, clearly perceptible onset latency on
       every sample instrument next to the osc path's start-at-now.) */
    /* Snap `when` to the integer-sample grid; pairs with the load-time
       trimStart/pts snapping so rate=1 reads avoid interpolation. If
       `startAt` is passed, the caller (e.g. the playback lookahead
       scheduler in hkl-side.ts) is anchoring the note on its own clock —
       trust it and use it directly. The default lead remains for live-input
       paths that don't pre-schedule. The +0.005 floor against currentTime
       covers very-late deliveries (a tardy scheduler should still produce
       sound, just at the floor — better than silent clamping). */
    var target=startAt!=null?startAt:ctx.currentTime+(instr.loop?0.015:0.005);
    var startT=Math.ceil(Math.max(target,ctx.currentTime+0.005)*ctx.sampleRate)/ctx.sampleRate;
    /* Attack fade-in: ramp segGain 0→vol over ATTACK_FADE_S so playback never
       starts on a nonzero sample step (click), independent of where the trim
       landed. Loop instruments get it too — harmless: the first segment switch
       creates its own segGain and crossfades, so this only shapes the first few
       ms of the very first source. The slide path (sNoteOnFaded) already uses an
       equal-power fade-in curve, so it needs no change. */
    segGain.gain.value=0; /* born silent — Firefox pre-ring guard, see scheduleSegmentSwitch */
    segGain.gain.setValueAtTime(0,0); /* t=0 timeline seed — deferred-setter guard, see scheduleSegmentSwitch */
    segGain.gain.setValueAtTime(0,startT);
    segGain.gain.linearRampToValueAtTime(vol,startT+ATTACK_FADE_S);
    var source=ctx.createBufferSource();source.buffer=nearest.buffer;
    source.playbackRate.value=rate;
    source.playbackRate.setValueAtTime(rate,0); /* t=0 timeline seed */
    /* The runtime now supports TWO loop-state formats per sample:
         segments: [{a, b}, ...]
           Each entry is a self-contained loop pair with a validated b→a
           seam. The picker plays to a chosen b, crossfades back to that
           segment's a, then chooses another segment whose b is reachable
           from the new position. Used by the segments-based analyzer
           (selectSegments → emit `segments` in samples.ts).
         loopPts + validStartsByEnd:
           Legacy format from the clique pipeline. Picker chooses (a, b)
           indices into loopPts subject to the validStartsByEnd graph.
       Both can coexist in samples.ts during the migration; per-sample
       detection here decides which path runs. */
    var segs=nearest.lp&&nearest.lp.segments;
    var pts=nearest.lp&&nearest.lp.loopPts;
    var vsbe=nearest.lp&&nearest.lp.validStartsByEnd;
    /* If segments are present but loopPts isn't, synthesize loopPts as the
       sorted union of endpoints so the guards in scheduleSegmentSwitch /
       doImmediateSwitch (`v.loopPts.length<2`) and any visualization code
       that reads v.loopPts still work. */
    if(segs&&segs.length>=1&&(!pts||pts.length<2)){
      var endptSet:any={};
      for(var si=0;si<segs.length;si++){
        endptSet[segs[si].a.toFixed(7)]=segs[si].a;
        endptSet[segs[si].b.toFixed(7)]=segs[si].b;
      }
      pts=[];
      for(var k in endptSet)pts.push(endptSet[k]);
      pts.sort(function(a:number,b:number){return a-b;});
    }
    if(!vsbe&&nearest.lp&&nearest.lp.endsByStart){
      /* Legacy conversion: invert endsByStart[a]=[b,...] into validStartsByEnd[b]=[a,...] */
      var legacyEBS=nearest.lp.endsByStart;
      vsbe=new Array(pts.length);
      for(var li=0;li<pts.length;li++)vsbe[li]=[];
      for(var la=0;la<legacyEBS.length;la++){
        var bs=legacyEBS[la]||[];
        for(var lk=0;lk<bs.length;lk++){
          var lb=bs[lk];
          if(lb>la&&lb<pts.length)vsbe[lb].push(la);
        }
      }
    }
    /* NO source.loop=true — we handle ALL looping via scheduleSegmentSwitch.
       The browser's native loop causes hard-cut wraps that click regardless
       of how close pts[a] and pts[b] are at the ZC+slope level (harmonic
       phase relationships still differ). Instead, scheduleSegmentSwitch
       fires a timer just before each wrap would occur, crossfades to a
       fresh source starting at the new pts[a], and stops the old source.
       If a timer fires late (rare), the old source plays forward past
       pts[b] into whatever audio follows — a natural fade-out into the
       sample's decay tail or silence rather than a click. */
    /* Still set loopStart/loopEnd so sourceOffset/wrap-time math is documented
       via these values, but loop=false means the browser doesn't act on them. */
    if(instr.loop&&pts&&pts.length>=2){
      source.loopStart=pts[0];source.loopEnd=pts[pts.length-1];
    }
    source.connect(segGain);segGain.connect(voiceGain);
    var startOffset=(nearest.lp&&nearest.lp.trimStart)?nearest.lp.trimStart:0;
    source.start(startT,startOffset);
    /* SOURCE ANCHOR (for wrap-aligned segment switching).
       sourceLoopB is the time the first switch will fire at. Initial pick:
         segments path:  pick the segment with the largest b (deepest forward
                         play before the first wrap)
         legacy path:    last loopPt (broadest possible first segment) */
    var initialA:number, initialB:number, initialSegIdx:number=-1;
    var initialAIdx:number=0, initialBIdx:number=0;
    if(segs&&segs.length>=1){
      initialSegIdx=0;
      for(var ii=1;ii<segs.length;ii++)if(segs[ii].b>segs[initialSegIdx].b)initialSegIdx=ii;
      initialA=segs[initialSegIdx].a;
      initialB=segs[initialSegIdx].b;
    } else {
      initialA=(pts&&pts.length>=2)?pts[0]:0;
      initialB=(pts&&pts.length>=2)?pts[pts.length-1]:0;
      initialBIdx=(pts&&pts.length>=2)?pts.length-1:0;
    }
    var voice={source:source,segGain:segGain,voiceGain:voiceGain,damperGain:damperGain,pressureGain:pressureGain,freq:freq,sampleFreq:nearest.freq,transpose:(instr.transpose||1),sampleName:nearest.name,sampleXfadeSec:(nearest.crossfadeSec||null),
      vol:vol,baseVol:baseVol,keyVelocity:resolvedVel,alive:true,loopPts:pts,validStartsByEnd:vsbe,segments:segs,loopTimer:null,buffer:nearest.buffer,instr:instr,instrKey:instrumentKey,
      slopeCV:(nearest.lp&&typeof nearest.lp.slopeCV==='number')?nearest.lp.slopeCV:0.5,
      sourceStartTime:startT,sourceOffset:startOffset,
      sourceLoopA:initialA,
      sourceLoopB:initialB,
      sourceLoopAIdx:initialAIdx,
      sourceLoopBIdx:initialBIdx,
      currentSegIdx:initialSegIdx>=0?initialSegIdx:undefined,
      sourceRate:rate,panNode:null};
    source.onended=function(){voice.alive=false;};
    activeVoices[voiceKey]=voice;
    /* Applied before startT (the ≥5ms scheduling lead), so the panner is wired
       and set before any audio renders — no rewire is ever audible here. */
    if(pan!=null)sSetVoicePan(voiceKey,pan);
    if(instr.loop&&pts&&pts.length>=2){
      /* Play through to the last loop point before the first switch —
         gives ~1-3s of pristine sustain before any crossfade artifacts
         can occur. scheduleSegmentSwitch reads source-anchor state for
         the first-wrap time, so no initial-delay arg is needed. */
      scheduleSegmentSwitch(voiceKey);
    }
  }
  /* Pick (a, b) for the NEXT loop segment, given the current voice state
     (specifically v.sourceLoopBIdx — the b we're jumping FROM). Logic shared
     between scheduleSegmentSwitch (pre-schedule path) and doImmediateSwitch
     (synchronous path) so both honor validStartsByEnd identically.

     ═══ Pick new pair (a_new, b_new) ═══
     TWO-STEP PROCESS with correct runtime separation of concerns:

     1. BACKWARD JUMP: we're at pts[b_cur] and need to jump backward to
        some a_new < b_cur where the seam is clean and the jump is
        meaningful (≥minBackwardSec distance). The clean-seam-candidates
        are pre-computed in validStartsByEnd[b_cur] — at analysis time
        the filter verified each a→b_cur crossfade and rejected pairs
        with audible phase-mismatch artifacts.

     2. FORWARD ENDPOINT: once a_new is chosen, b_new can be any point
        where pts[b_new] - pts[a_new] ≥ minForwardSec. No seam is
        involved here — it's just playing forward through the sample.
        The only requirement is that the loop segment is long enough to
        not churn (≥minForwardSec). */
  /* Returns the next loop pair as TIMES (not indices), plus path-specific
     state-tracking metadata so commitPendingSwitch can advance bookkeeping:
       segments path:  { a, b, nextSegIdx }
       legacy path:    { a, b, aIdx, bIdx }
     The caller (scheduleSegmentSwitch / doImmediateSwitch) uses `a`/`b`
     directly for source.start / loopStart / loopEnd. */
  function pickNextSeam(v: any, pts: any): {a: number, b: number, aIdx?: number, bIdx?: number, nextSegIdx?: number} {
    /* SEGMENTS PATH — runtime state machine:
         current source is heading toward sourceLoopB = segments[currentSegIdx].b
         at wrap: new source starts at segments[currentSegIdx].a (within-segment
                  loop-back; pair-seam validated at analyzer time)
         then we pick the NEXT target segment j with segments[j].b reachable
         (b > currentA = the a we just looped to) and play forward toward it.
       The new source's loop span is therefore (currentA, segments[j].b) —
       cross-segment, but we never crossfade across that gap; we only wrap
       at segments[j].b → segments[j].a in a future iteration, and that wrap
       is again within-segment. */
    if(v.segments&&v.segments.length>=1){
      /* Delegate the segments-branch algorithm to the shared picker
         (src/shared/segments.ts) so the analyzer's audition and any future
         extracted engine library use the same code path. The legacy
         validStartsByEnd branch below stays inline — it's samples-engine-
         specific (loopPts indexing for commitPendingSwitch). */
      return pickSegmentSeam(v.segments,v.currentSegIdx);
    }
    /* LEGACY PATH — validStartsByEnd-driven picker. Returns times AND the
       index pair so commit can update sourceLoopAIdx/BIdx. */
    var vsbeLocal=v.validStartsByEnd;
    var bCurIdx=v.sourceLoopBIdx;
    var a:number=0,b:number=pts.length-1;
    if(pts.length===2){return {a:pts[0],b:pts[1],aIdx:0,bIdx:1};}
    if(!vsbeLocal){
      /* Sample data without the graph — generate pairs on the fly.
         Constrain a < bCurIdx so we never produce a forward or same-point
         jump (the original implementation ignored bCurIdx, which manifested
         as audible "loop ran out faster" and unvalidated seams). */
      var minJumpSec=0.20,pairFound=false;
      for(var at=0;at<100;at++){
        if(bCurIdx<=0){a=0;b=pts.length-1;pairFound=true;break;}
        a=Math.floor(Math.random()*bCurIdx);
        b=a+1+Math.floor(Math.random()*(pts.length-a-1));
        if(b>=pts.length)b=pts.length-1;
        if(pts[b]-pts[a]>=minJumpSec){pairFound=true;break;}
      }
      if(!pairFound){a=0;b=pts.length-1;}
      return {a:pts[a],b:pts[b],aIdx:a,bIdx:b};
    }
    /* STEP 1: pick a_new uniformly from validStartsByEnd[bCurIdx] */
    var aCands=(bCurIdx<vsbeLocal.length&&vsbeLocal[bCurIdx])?vsbeLocal[bCurIdx]:[];
    if(aCands.length===0){
      return {a:v.sourceLoopA,b:v.sourceLoopB,aIdx:v.sourceLoopAIdx,bIdx:v.sourceLoopBIdx};
    }
    a=aCands[Math.floor(Math.random()*aCands.length)];
    /* STEP 2: pick b_new from points where the forward segment is long
       enough AND b_new is a "live" endpoint (has its own valid backward
       jumps) so we don't dead-end. */
    var minForwardSec=0.30;
    var bCands:number[]=[];
    for(var bi=a+1;bi<pts.length;bi++){
      if(pts[bi]-pts[a]<minForwardSec)continue;
      var isLive=(bi<vsbeLocal.length&&vsbeLocal[bi]&&vsbeLocal[bi].length>0);
      if(isLive||bi===pts.length-1)bCands.push(bi);
    }
    if(bCands.length===0){
      for(var bi2=a+1;bi2<pts.length;bi2++)bCands.push(bi2);
    }
    if(bCands.length===0){return {a:v.sourceLoopA,b:v.sourceLoopB,aIdx:v.sourceLoopAIdx,bIdx:v.sourceLoopBIdx};}
    b=bCands[Math.floor(Math.random()*bCands.length)];
    return {a:pts[a],b:pts[b],aIdx:a,bIdx:b};
  }

  /* ── ANALYTIC RATE / POSITION TRAJECTORY ──
     The voice's playback trajectory is fully described by its anchor
     (sourceStartTime t0, sourceOffset p0, sourceRate) plus the pending ramp
     (pendingRamp{Start,End,R0,R1}: linear r0→r1 over [rs, re], constant
     sourceRate on [t0, rs], constant r1 after re). These helpers evaluate it
     WITHOUT ever reading the playbackRate.value getter — mid-ramp, that
     getter's semantics are host-dependent (computed value on Chromium,
     last-set on some hosts, notably suspect on RNAA/Android), and a poisoned
     read at a seam sticks as the voice's rate. All seam scheduling and
     anchor math goes through these. */
  function rateAtTime(v: any, t: number): number {
    if(v.pendingRampStart===undefined)return v.sourceRate||1;
    var rs=v.pendingRampStart,re=v.pendingRampEnd,r0=v.pendingRampR0,r1=v.pendingRampR1;
    if(t<=rs)return r0;
    if(t>=re)return r1;
    return r0+(r1-r0)*((t-rs)/(re-rs));
  }
  function positionAtTime(v: any, t: number): number {
    var t0=v.sourceStartTime,p0=v.sourceOffset;
    if(v.pendingRampStart===undefined)return p0+(v.sourceRate||1)*(t-t0);
    var rs=v.pendingRampStart,re=v.pendingRampEnd,r0=v.pendingRampR0,r1=v.pendingRampR1;
    if(t<=rs)return p0+(v.sourceRate||r0||1)*(t-t0);
    var pos=p0+(v.sourceRate||r0||1)*(rs-t0);
    var tEnd=(t<re)?t:re;
    pos+=(r0+rateAtTime(v,tEnd))*0.5*(tEnd-rs);
    if(t>re)pos+=r1*(t-re);
    return pos;
  }
  /* Invert positionAtTime: the time the playhead reaches buffer position
     `target` (≥ current position). Piecewise: linear before/after the ramp,
     quadratic during it — 0.5·k·x² + r0·x = d with k=(r1−r0)/(re−rs); the
     (−r0+√(r0²+2kd))/k root is the forward crossing for both ramp signs. */
  function timeAtPosition(v: any, target: number): number {
    var t0=v.sourceStartTime,p0=v.sourceOffset;
    if(v.pendingRampStart===undefined)return t0+(target-p0)/(v.sourceRate||1);
    var rs=v.pendingRampStart,re=v.pendingRampEnd,r0=v.pendingRampR0,r1=v.pendingRampR1;
    var posRs=p0+(v.sourceRate||r0||1)*(rs-t0);
    if(target<=posRs)return t0+(target-p0)/(v.sourceRate||r0||1);
    var posRe=posRs+(r0+r1)*0.5*(re-rs);
    if(target>=posRe)return re+(target-posRe)/(r1||1);
    var k=(r1-r0)/(re-rs);
    if(Math.abs(k)<1e-9)return rs+(target-posRs)/(r0||1);
    var disc=r0*r0+2*k*(target-posRs);
    if(disc<0)disc=0;
    return rs+(-r0+Math.sqrt(disc))/k;
  }
  /* Carry the in-flight ramp onto a source scheduled to (re)start at `at`:
     without this, a seam mid-ramp freezes the new source at a constant
     snapshot — the audible pitch stops ramping at every wrap and, if no
     further ramp arrives, lands wrong. Schedules value-at + the remaining
     linear leg so old and new sources follow the SAME trajectory through
     the crossfade (phase-locked). */
  function carryRampOnto(v: any, param: any, at: number): number {
    var rAt=rateAtTime(v,at);
    param.value=rAt;
    param.setValueAtTime(rAt,0); /* t=0 timeline seed — deferred-setter guard, see scheduleSegmentSwitch */
    if(v.pendingRampStart!==undefined&&at<v.pendingRampEnd){
      param.setValueAtTime(rAt,at);
      param.linearRampToValueAtTime(v.pendingRampR1,v.pendingRampEnd);
    }
    return rAt;
  }
  /* Normalize anchor + pending-ramp bookkeeping after a seam that anchored
     the voice at `anchorTime` (commitPendingSwitch / doImmediateSwitch set
     sourceStartTime=anchorTime, sourceOffset=aTime before calling this).
     Keeps the trajectory invariant (constant sourceRate on [t0, rs]) true. */
  function normalizeRampAtAnchor(v: any, anchorTime: number): void {
    if(v.pendingRampStart===undefined){return;}
    if(v.pendingRampEnd<=anchorTime){
      v.sourceRate=v.pendingRampR1;
      v.pendingRampStart=undefined;v.pendingRampEnd=undefined;
      v.pendingRampR0=undefined;v.pendingRampR1=undefined;
    }else if(v.pendingRampStart<=anchorTime){
      var rAt=rateAtTime(v,anchorTime);
      v.pendingRampStart=anchorTime;v.pendingRampR0=rAt;
      v.sourceRate=rAt;
    }else{
      /* Ramp was issued after the seam's switchTime (mid-crossfade step):
         rs > t0. The [t0, rs] stretch actually followed the pre-ramp
         trajectory; approximating it as constant r0 costs micro-seconds of
         buffer position at cent-scale steps — far below seam tolerance. */
      v.sourceRate=v.pendingRampR0;
    }
  }

  /* ── WRAP-ALIGNED SEGMENT SWITCHING (every wrap is a switch) ──
     ALL looping is handled here — no browser-native loop is engaged. Each
     source plays a single pass through its [loopStart, loopEnd] segment,
     then is replaced at the pts[b] moment with a new source using a new
     (a, b) pair and a 30ms linear crossfade.

     Why no native-loop safety net: the browser's native loop produces a
     hard-cut wrap from loopEnd back to loopStart. Even with ZC+slope
     matching, the instantaneous harmonic phase configuration differs
     between those two points (macro-period samples match by spectral
     shape over a window, not sample-perfect), so the hard cut clicks.
     Crossfading over that click doesn't help because the click is in
     the OLD source's own output, not at the seam between old and new.

     ── PRE-SCHEDULE ON THE AUDIO CLOCK ──
     Critical: the crossfade audio events are scheduled HERE, at the moment
     scheduleSegmentSwitch is called, anchored exactly at switchTime — not
     in a setTimeout body that runs near switchTime. Web Audio scheduling
     is sample-accurate; setTimeout firing time is not. Anchoring on the
     audio clock makes the crossfade deterministic regardless of JS
     event-loop jitter (which would otherwise let the old source play past
     pts[b_old] into unvalidated buffer content for tens of ms before the
     ramp-out started — the source of intermittent same-seam dips).

     setTimeout's only job is JS-side state cleanup (commitPendingSwitch +
     re-schedule the next switch). Late firing is harmless because the
     audio has already played. cancelPendingSwitch undoes the pre-scheduled
     events if a rate ramp interrupts before commit.

     Relies on source-anchor state (sourceStartTime, sourceOffset,
     sourceLoopA, sourceLoopB, sourceRate) being accurate. Set by sNoteOn
     for initial source, by commitPendingSwitch for subsequent sources, and
     by sRampFreq after playbackRate ramps settle. */
  function scheduleSegmentSwitch(voiceKey: string, _initialDelayMs?: number): void {
    var v=activeVoices[voiceKey];
    if(!v||!v.alive||!v.loopPts||v.loopPts.length<2)return;
    /* Defensive: a stray pre-scheduled switch shouldn't exist here, but if
       it does (e.g., from a missed cancel path), tear it down before
       creating a new one to avoid double-stacking sources. */
    if(v.pendingSwitch)cancelPendingSwitch(v);
    var pts=v.loopPts;
    var now=ctx.currentTime;
    /* The current source wraps at this time. ALWAYS switch at every wrap.
       timeAtPosition is ramp-aware: with a pending rate ramp in flight the
       wrap moment shifts (integral of the ramped rate), and getting it wrong
       either splices early (mid-segment, phase-unvalidated) or lets the old
       source play past pts[b] into unvalidated content. */
    var switchTime=timeAtPosition(v,v.sourceLoopB);
    /* If we're already past the wrap (extreme JS stall during a prior call),
       push a few ms forward so setValueAtTime / source.start are valid. This
       DEFERS the fade past the validated b — record it so the seam event
       carries the evidence (SeamEvent.deferredMs). Post-2.4.3 the retune path
       can no longer land here (XFADE_GUARD_S diverts near-wrap calls to the
       in-flight path), so any non-zero deferral means a real JS stall. */
    var deferredMs=0;
    if(switchTime<now+0.005){deferredMs=(now+0.005-switchTime)*1000;switchTime=now+0.005;}

    var picked=pickNextSeam(v,pts);
    /* picked.a, picked.b are TIMES (in seconds within the buffer). For the
       segments pipeline picked also carries `nextSegIdx`; for the legacy
       pipeline it carries `aIdx`/`bIdx`. commitPendingSwitch dispatches on
       which set is present. */
    var aTime=picked.a,bTime=picked.b;

    /* Linear crossfade — gives |cos(Δφₖ/2)| at midpoint per harmonic,
       no +3dB boost at phase-aligned fundamental (equal-power would).
       Duration is per-sample when the analyzer chose one (residual-gated
       window search — shorter for material that diverges over the default
       30ms, e.g. vibrato voices); 30ms otherwise. */
    var xfDur=v.sampleXfadeSec||0.030;
    var newSrc=ctx.createBufferSource();newSrc.buffer=v.buffer;
    newSrc.loopStart=aTime;newSrc.loopEnd=bTime;
    carryRampOnto(v,newSrc.playbackRate,switchTime);
    var newSG=ctx.createGain();
    /* Born silent — NOT default 1. Two independent host behaviors make the
       double write (intrinsic .value=0 AND a setValueAtTime(0, 0) timeline
       seed) necessary:
       (1) Firefox: AudioBufferSourceNode at fractional playbackRate emits
       ~3-4 samples of resampler pre-ring BEFORE its scheduled start time;
       with the default gain (1) those samples pass at full level until the
       setValueAtTime(0, switchTime) event lands, then get truncated — a
       per-seam click whose loudness tracks the waveform amplitude at the
       seam entry (the "crackling on chords" bug, 2026-07). Chromium starts
       sample-accurately and rate=1 is unaffected, which is why it only
       surfaced with JI/thinned-rate playback in Firefox.
       (2) Deferred-setter hosts (react-native-audio-api 0.13.2): .value=
       is queued rather than applied, and evaluation at times before the
       first timeline event resolves from the param's CONSTRUCTOR DEFAULT
       (1.0), never the intrinsic value — so the source's first sample
       injected the raw buffer value at unity gain, one click per source
       start (2026-08, handoff/hkle-born-silent-gain-fix.md). The t=0 seed
       is unconditionally the earliest event, making the timeline
       authoritative from birth on every host.
       Same double-write guard applies to EVERY .value= write whose value
       can differ from the param default (playbackRate included); writes
       intended at the default (voiceGain etc. = 1.0) are exempt — there
       the wrong lookup still returns the right value. */
    newSG.gain.value=0;
    newSG.gain.setValueAtTime(0,0);
    newSG.gain.setValueAtTime(0,switchTime);
    newSG.gain.linearRampToValueAtTime(v.vol,switchTime+xfDur);
    newSrc.connect(newSG);newSG.connect(v.voiceGain);
    newSrc.start(switchTime,aTime);

    /* Pre-schedule the OLD source's gain ramp out at switchTime. Crucially,
       do NOT schedule oldSrc.stop() yet — stop() is one-shot and uncancellable,
       so deferring it to commitPendingSwitch keeps cancellation symmetric.
       Anchor the ramp at v.vol (the known steady-state level), not at
       oldSegGain.gain.value (race with future-scheduled events). */
    var oldSrc=v.source,oldSegGain=v.segGain;
    oldSegGain.gain.cancelScheduledValues(switchTime);
    oldSegGain.gain.setValueAtTime(v.vol,switchTime);
    oldSegGain.gain.linearRampToValueAtTime(0,switchTime+xfDur);

    /* Capture FROM/TO times for the seam-event log (works for both pipelines
       since we no longer round-trip through pts[idx]). */
    v.pendingSwitch={
      newSrc:newSrc,newSG:newSG,oldSrc:oldSrc,oldSegGain:oldSegGain,
      switchTime:switchTime,xfDur:xfDur,
      a:aTime,b:bTime,
      aIdx:picked.aIdx,bIdx:picked.bIdx,        /* legacy state update */
      nextSegIdx:picked.nextSegIdx,             /* segments state update */
      fromTime:v.sourceLoopB,toTime:aTime,
      deferredMs:deferredMs
    };

    /* JS-only timer: fires after the crossfade completes, with a small
       margin. Late firing is harmless. */
    var commitTimerMs=Math.max(0,(switchTime+xfDur-now)*1000)+5;
    v.loopTimer=setTimeout(function(){
      commitPendingSwitch(voiceKey);
      scheduleSegmentSwitch(voiceKey);
    },commitTimerMs);
  }

  /* Commit a pre-scheduled switch: advance JS-side voice state to the new
     source, schedule old-source cleanup, and emit the seam diagnostic event.
     Audio has already played its crossfade on the audio clock; this just
     reconciles JS state with the new reality. */
  function commitPendingSwitch(voiceKey: string): void {
    var v=activeVoices[voiceKey];
    if(!v||!v.pendingSwitch)return;
    var p=v.pendingSwitch;
    /* Schedule old source's stop now (its gain ramped to 0 at switchTime+xfDur). */
    try{p.oldSrc.stop(p.switchTime+p.xfDur+0.02);}catch(e){}
    p.oldSrc.onended=function(){
      try{p.oldSrc.disconnect();}catch(e){}
      try{p.oldSegGain.disconnect();}catch(e){}
    };
    /* Advance voice state to the new source. Times come from p.a / p.b
       directly (post-refactor — both pipelines store times in the pending
       switch). The index/segment bookkeeping is pipeline-specific. */
    v.source=p.newSrc;v.segGain=p.newSG;
    v.sourceStartTime=p.switchTime;
    v.sourceOffset=p.a;
    v.sourceLoopA=p.a;v.sourceLoopB=p.b;
    if(p.nextSegIdx!=null){
      /* Segments path: track which segment's b we're heading toward. */
      v.currentSegIdx=p.nextSegIdx;
    } else {
      /* Legacy path: keep the loopPts-indexed bookkeeping. */
      v.sourceLoopAIdx=p.aIdx;v.sourceLoopBIdx=p.bIdx;
    }
    /* Anchor rate analytically (never the .value getter — see rateAtTime).
       No pending ramp ⇒ sourceRate is already the settled truth; with one,
       normalize so the constant-rate-since-anchor invariant holds at the new
       (switchTime, aTime) anchor. */
    normalizeRampAtAnchor(v,p.switchTime);
    if(onSeamEvent)onSeamEvent({ctxTime:p.switchTime,voiceKey:voiceKey,sampleName:v.sampleName||'?',
      rate:v.sourceRate||1,kind:'wrap',
      fromBIdx:p.bIdx!=null?v.sourceLoopBIdx:-1,toAIdx:p.aIdx!=null?p.aIdx:-1,
      fromTime:p.fromTime,toTime:p.toTime,xfadeDur:p.xfDur,deferredMs:p.deferredMs||0});
    p.newSrc.onended=function(){v.alive=false;};
    v.pendingSwitch=null;
  }

  /* Cancel a pre-scheduled switch (called from sRampFreq/sNoteOff/sHardStop/
     sSlideAndFadeOut before they mutate v.source). Stops the new source,
     disconnects its graph, and undoes the events scheduleSegmentSwitch put on
     the old segGain.

     2.4.3 caller contract: sRampFreq/sNoteOff/sSlideAndFadeOut only call this
     when the crossfade is comfortably in the future (≥ XFADE_GUARD_S away) —
     in-flight or imminent fades are left running instead (stop(0) on an
     audibly-ramped incoming source is a step discontinuity, and rescheduling
     an imminent fade defers it past the validated wrap; see the guard const).
     The in-flight branch below survives for sHardStop (hard-cut semantics —
     voiceGain snaps to 0 in the same call, masking the source cut) and the
     defensive teardown paths.

     Anchor the undo at p.switchTime, NOT at `now`: segGain also carries the
     voice's own attack (sNoteOn's 4ms ramp / sNoteOnFaded's 100ms equal-power
     curve), which sits EARLIER on the timeline than the switch events. A
     now-anchored cancelScheduledValues(now) on a voice still attacking either
     deleted a not-yet-started attack outright (note began at full gain —
     click) or, with the attack curve in flight, made the follow-up
     setValueAtTime(now) land inside a live setValueCurveAtTime window (throws
     on strict hosts: Firefox, react-native-audio-api; Chromium silently snaps
     the attack instead). See handoff/hkle-cancel-pending-switch-attack.md.

     Crossfade not yet begun (now < switchTime): everything scheduleSegment-
     Switch put on oldSegGain sits at or after switchTime, so cancelling there
     removes exactly those events; there is nothing to restore, and the
     voice's own envelope is left alone.
     Crossfade in flight: restore to v.vol via a brief 5ms ramp so the
     mid-crossfade cancellation doesn't click (the case the restore was
     designed for — unchanged). */
  function cancelPendingSwitch(v: any): void {
    if(!v.pendingSwitch)return;
    var p=v.pendingSwitch;
    /* stop(0) clamps to currentTime per spec — works whether newSrc has
       already started (cancel after switchTime) or not (cancel before). */
    try{p.newSrc.stop(0);}catch(e){}
    try{p.newSrc.disconnect();}catch(e){}
    try{p.newSG.disconnect();}catch(e){}
    var now=ctx.currentTime;
    if(now<p.switchTime){
      p.oldSegGain.gain.cancelScheduledValues(p.switchTime);
    } else {
      p.oldSegGain.gain.cancelScheduledValues(now);
      p.oldSegGain.gain.setValueAtTime(p.oldSegGain.gain.value,now);
      p.oldSegGain.gain.linearRampToValueAtTime(v.vol,now+0.005);
    }
    v.pendingSwitch=null;
  }
  export function sNoteOff(voiceKey: string, releaseAt?: number): void {
    var v=activeVoices[voiceKey];if(!v)return;
    if(v.loopTimer){clearTimeout(v.loopTimer);v.loopTimer=null;}
    var instr=v.instr;
    var release=(((instr&&instr.releaseTime)||0.3)*RELEASE_SCALE);
    /* `releaseAt` (when provided) anchors the release on the audio clock —
       the playback lookahead scheduler uses this so the off time is sample-
       accurate, not pinned to JS-timer firing. Floor against currentTime
       (+1ms safety) so a slightly-stale releaseAt doesn't schedule in the
       past. voiceGain.value is always 1.0 on sample voices (only release
       modulates it), so setValueAtTime(1.0, releaseT) is correct regardless
       of how far in the future releaseT is. */
    var releaseT=Math.max(releaseAt!=null?releaseAt:ctx.currentTime,ctx.currentTime+0.001);
    /* Pre-scheduled switch handling. In flight or imminent (within
       XFADE_GUARD_S of switchTime): LEAVE THE CROSSFADE RUNNING — a stop(0)
       here cuts the incoming source at up to full voice volume mid-fade, a
       step discontinuity scaling with fade progress (inflight-crossfade-cut
       Cause 1: 12/12 reproduced). Both sources sit under voiceGain, whose
       release ramp below takes everything down, so no gain surgery is needed
       (and none is safe: reading gain.value mid-ramp is the documented
       footgun). The commit timer is already cleared above; just stop the
       incoming source alongside the old one after the release ends and hand
       it its disconnect cleanup. Comfortably pre-fade: tear down as before —
       the cancel removes only events ≥ switchTime and the source has plenty
       of buffer ahead to play linearly through the brief release window. */
    if(v.pendingSwitch){
      var p=v.pendingSwitch;
      if(ctx.currentTime>=p.switchTime-XFADE_GUARD_S){
        try{p.newSrc.stop(releaseT+release+0.05);}catch(e){}
        p.newSrc.onended=function(){
          try{p.newSrc.disconnect();}catch(e){}
          try{p.newSG.disconnect();}catch(e){}
        };
        v.pendingSwitch=null;
      }else{
        cancelPendingSwitch(v);
      }
    }
    if(v.alive){
      /* fade voiceGain — silences ALL sources routed through it */
      v.voiceGain.gain.cancelScheduledValues(releaseT);
      v.voiceGain.gain.setValueAtTime(1.0,releaseT);
      v.voiceGain.gain.linearRampToValueAtTime(0,releaseT+release);
      try{v.source.stop(releaseT+release+0.05);}catch(e){}
    }
    delete activeVoices[voiceKey];
  }
  /* Execute a segment switch SYNCHRONOUSLY and return immediately with all
     voice state updated. Unlike scheduleSegmentSwitch (which schedules a
     future setTimeout), this creates the new source and advances the voice
     state right now. The new source starts playing `startTime` seconds in
     the future (default: immediate + tiny lead), crossfading in over the
     same window the scheduled switches use. Used by sRampFreq to close the
     wrap-during-ramp coverage gap.
     
     Returns true on success, false if voice state can't support a switch. */
  function doImmediateSwitch(voiceKey: string, startTime?: number): boolean {
    var v=activeVoices[voiceKey];
    if(!v||!v.alive||!v.loopPts||v.loopPts.length<2)return false;
    var pts=v.loopPts;
    if(pts.length<2)return false;
    /* If a pre-scheduled switch is in flight, tear it down — we're about to
       create a different new source synchronously, and the pending one would
       layer on top and corrupt voice state. */
    if(v.pendingSwitch)cancelPendingSwitch(v);
    var fromTime=v.sourceLoopB;  /* where the old source was heading */
    var now=ctx.currentTime;
    var st: number = startTime===undefined?now+0.008:startTime;
    var picked=pickNextSeam(v,pts);
    var aTime=picked.a,bTime=picked.b;
    /* Create new source, crossfade, update voice state. */
    var xfDur=v.sampleXfadeSec||0.030;
    var newSrc=ctx.createBufferSource();newSrc.buffer=v.buffer;
    newSrc.loopStart=aTime;newSrc.loopEnd=bTime;
    carryRampOnto(v,newSrc.playbackRate,st);
    var newSG=ctx.createGain();
    newSG.gain.value=0; /* born silent — Firefox pre-ring guard, see scheduleSegmentSwitch */
    newSG.gain.setValueAtTime(0,0); /* t=0 timeline seed — deferred-setter guard, see scheduleSegmentSwitch */
    newSG.gain.setValueAtTime(0,st);
    newSG.gain.linearRampToValueAtTime(v.vol,st+xfDur);
    newSrc.connect(newSG);newSG.connect(v.voiceGain);
    newSrc.start(st,aTime);
    var oldSource=v.source,oldSegGain=v.segGain;
    oldSegGain.gain.cancelScheduledValues(st);
    oldSegGain.gain.setValueAtTime(v.vol,st);
    oldSegGain.gain.linearRampToValueAtTime(0,st+xfDur);
    oldSource.onended=function(){
      try{oldSource.disconnect();}catch(e){}
      try{oldSegGain.disconnect();}catch(e){}
    };
    try{oldSource.stop(st+xfDur+0.02);}catch(e){}
    /* Anchor for future wrap computation is (st, aTime, newRate). */
    v.source=newSrc;v.segGain=newSG;
    v.sourceStartTime=st;
    v.sourceOffset=aTime;
    v.sourceLoopA=aTime;v.sourceLoopB=bTime;
    if(picked.nextSegIdx!=null){
      v.currentSegIdx=picked.nextSegIdx;
    } else {
      v.sourceLoopAIdx=picked.aIdx;v.sourceLoopBIdx=picked.bIdx;
    }
    normalizeRampAtAnchor(v,st);
    if(onSeamEvent)onSeamEvent({ctxTime:st,voiceKey:voiceKey,sampleName:v.sampleName||'?',
      rate:v.sourceRate||1,kind:'immediate',
      fromBIdx:picked.bIdx!=null?v.sourceLoopBIdx:-1,toAIdx:picked.aIdx!=null?picked.aIdx:-1,
      fromTime:fromTime,toTime:aTime,xfadeDur:xfDur});
    newSrc.onended=function(){v.alive=false;};
    return true;
  }
  /* ══ commitRampSync ══
     Synchronously advance the voice's anchor to time `now`, correctly
     handling an in-flight rate ramp. sRampFreq calls this before recording
     each new ramp so r0 is the true in-flight rate and the rs===t0
     trajectory invariant holds; without it, anchor state corrupts and
     compounds across rapid transposes ("multiple octaves and back").

     Math: the pending ramp goes r0→r1 linearly over [rs, re]. Position
     integral from rs to min(now, re) is (r0+rateAtT)/2 * dt. Post-ramp
     (now > re) adds r1 * (now - re). Anchor is updated to this moment,
     with the current instantaneous rate.

     We do NOT fold position into [loopA, loopB] here. During a ramp the
     audio source plays forward without native looping, so the actual
     playhead IS at the unfolded position; if it exceeds loopB, the
     wrap-during-ramp check downstream must handle it via doImmediateSwitch.
     Folding would desync the anchor from reality. */
  function commitRampSync(v: any, now: number): void {
    if(v.pendingRampStart===undefined)return;
    var rs=v.pendingRampStart,re=v.pendingRampEnd;
    var r0=v.pendingRampR0,r1=v.pendingRampR1;
    /* Position at rs assuming constant r0 since the previous anchor — this
       is the invariant the anchor was set to maintain. */
    var posAtRs=v.sourceOffset+r0*(rs-v.sourceStartTime);
    var rt=(now<re)?now:re;
    var dt=rt-rs;
    var rampDur=re-rs;
    var rateAtRt=(dt<=0)?r0:(r0+(r1-r0)*(dt/rampDur));
    var advance=(r0+rateAtRt)*0.5*dt;
    var posAtRt=posAtRs+advance;
    if(now>re)posAtRt+=r1*(now-re);
    v.sourceStartTime=now;
    v.sourceOffset=posAtRt;
    v.sourceRate=(now<re)?rateAtRt:r1;
    v.pendingRampStart=undefined;
    v.pendingRampEnd=undefined;
    v.pendingRampR0=undefined;
    v.pendingRampR1=undefined;
  }
  export function sRampFreq(voiceKey: string, newFreq: number, durSec: number): boolean {
    var v=activeVoices[voiceKey];if(!v)return false;
    if(!v.alive){var pv=v.vol;var ik=v.instrKey;delete activeVoices[voiceKey];sNoteOn(voiceKey,newFreq,Math.round(((pv-0.3)/0.7)*127),ik);return true;}
    var now=ctx.currentTime;
    /* ── COMMIT ANY IN-FLIGHT RAMP ──
       Anchor the voice exactly at `now` (analytic — commitRampSync never
       reads the playbackRate.value getter) so the new ramp's r0 is the true
       in-flight rate and the rs===t0 trajectory invariant holds. No-op when
       no ramp is pending. */
    commitRampSync(v,now);
    var newRate=newFreq*(v.transpose||1)/v.sampleFreq;
    var oldRate=v.sourceRate||1;
    /* ── RAMP-AWARE SEAM HANDLING (every-step reschedule) ──
       A pre-scheduled switch's audio events were anchored on the OLD rate
       trajectory, which is about to change. Two cases:
         crossfade comfortably in the future (≥ XFADE_GUARD_S away) → tear it
           down; we re-schedule below under the new trajectory (timeAtPosition/
           carryRampOnto make the seam land on the validated b→a pair mid-ramp).
         crossfade in flight OR imminent (within XFADE_GUARD_S) → never yank
           it. In flight, a teardown cuts the audibly-ramped incoming source
           (inflight-crossfade-cut Cause 1); imminent, the reschedule's now+5ms
           floor would DEFER the fade past the validated wrap — the measured
           seam-dip bug (see XFADE_GUARD_S). Either way the ramp events below
           are applied to BOTH sources so they stay phase-locked through the
           fade, which completes at its already-scheduled sample-aligned time;
           the commit timer then reschedules the next wrap, ramp-aware via
           pendingRamp*. Trajectory shift of the wrap inside the guard window
           is sub-sample. */
    var xfInFlight=false;
    if(v.pendingSwitch){
      if(now>=v.pendingSwitch.switchTime-XFADE_GUARD_S){
        xfInFlight=true;
      }else{
        if(v.loopTimer){clearTimeout(v.loopTimer);v.loopTimer=null;}
        cancelPendingSwitch(v);
      }
    }
    /* Backstop: playhead already at/past the validated seam point — can only
       happen after an extreme JS stall (the every-step reschedule otherwise
       keeps a pending switch ahead of the playhead). Splice immediately,
       then ramp the fresh source. */
    if(!xfInFlight&&v.loopPts&&v.loopPts.length>=2&&v.sourceLoopB!==undefined
       &&positionAtTime(v,now)>=v.sourceLoopB){
      if(v.loopTimer){clearTimeout(v.loopTimer);v.loopTimer=null;}
      doImmediateSwitch(voiceKey);
      v=activeVoices[voiceKey];
      if(!v||!v.alive)return false;
      oldRate=v.sourceRate||oldRate;
    }
    /* Start the rate ramp — identical events on every sounding source of
       this voice (see xfInFlight above). */
    var rampParams=[v.source.playbackRate];
    if(xfInFlight)rampParams.push(v.pendingSwitch.newSrc.playbackRate);
    for(var pi=0;pi<rampParams.length;pi++){
      rampParams[pi].cancelScheduledValues(now);
      rampParams[pi].setValueAtTime(oldRate,now);
      rampParams[pi].linearRampToValueAtTime(newRate,now+durSec);
    }
    v.freq=newFreq;
    /* Record the pending ramp — the analytic trajectory helpers (rateAtTime /
       positionAtTime / timeAtPosition / carryRampOnto) and commitRampSync all
       read it; seam commits normalize it (normalizeRampAtAnchor). */
    v.pendingRampStart=now;
    v.pendingRampEnd=now+durSec;
    v.pendingRampR0=oldRate;
    v.pendingRampR1=newRate;
    /* Re-schedule the wrap under the NEW trajectory. There is no deferred
       "re-anchor after settle" step anymore — deferral is what starved the
       wrap-aligned path under continuous ramping (every seam degraded to the
       phase-unvalidated immediate splice: the Intonalogy hiccup). With the
       trajectory fully analytic, scheduling straight through the ramp is
       exact. In the xfInFlight case the commit timer owns rescheduling. */
    if(!xfInFlight&&v.loopPts&&v.loopPts.length>=2){
      if(v.loopTimer){clearTimeout(v.loopTimer);v.loopTimer=null;}
      scheduleSegmentSwitch(voiceKey);
    }
    return true;
  }
  export function sSlideAndFadeOut(voiceKey: string, targetFreq: number, dur: number, atTime?: number): number {
    var v=activeVoices[voiceKey];if(!v)return 0.7;
    /* Return baseVol (pre-attenuation) so the caller can pass it to sNoteOnFaded,
       which will reapply attenuation based on the NEW frequency. Falls back to v.vol
       for voices created before baseVol was tracked. */
    var savedVol=(v.baseVol!==undefined)?v.baseVol:v.vol;
    /* Pre-scheduled switch: same policy as sNoteOff. In flight or imminent —
       keep the crossfade (a teardown cuts the ramped incoming source; a
       reschedule would defer past the validated wrap); the glide ramp below
       is applied to BOTH sources so they stay phase-locked, and both stop
       when the fade-out ends. Comfortably pre-fade — tear down as before;
       the rate ramp below would leave its switchTime/playbackRate stale, and
       the voice is being deleted anyway. */
    var keptSwitch: any=null;
    if(v.pendingSwitch){
      if(ctx.currentTime>=v.pendingSwitch.switchTime-XFADE_GUARD_S){
        keptSwitch=v.pendingSwitch;
        v.pendingSwitch=null;
      }else{
        cancelPendingSwitch(v);
      }
    }
    if(v.loopTimer){clearTimeout(v.loopTimer);v.loopTimer=null;}
    /* `atTime` (when provided) anchors the slide on the audio clock instead
       of "now" — used by the playback lookahead scheduler so the glide
       boundary is sample-accurate, not pinned to JS-timer firing. Floor at
       currentTime+1ms so a stale target doesn't schedule in the past. */
    var anchor=Math.max(atTime!=null?atTime:ctx.currentTime,ctx.currentTime+0.001);
    if(v.alive){
      var targetRate=targetFreq*(v.transpose||1)/v.sampleFreq;
      /* exponential pitch glide: pitch perception is logarithmic so the
         rate ramp must be too. Endpoints are always > 0 (positive freqs).
         Pair with sNoteOnFaded's matching ramp (started at fromFreq) so
         the crossfade happens between pitch-locked voices — equal-power
         gain curves preserve constant amplitude. Identical events on every
         sounding source (kept in-flight seam crossfades included) so they
         stay phase-locked. */
      var anchorRate=v.source.playbackRate.value;
      var glideParams=[v.source.playbackRate];
      if(keptSwitch)glideParams.push(keptSwitch.newSrc.playbackRate);
      for(var gp=0;gp<glideParams.length;gp++){
        glideParams[gp].cancelScheduledValues(anchor);
        glideParams[gp].setValueAtTime(anchorRate,anchor);
        glideParams[gp].exponentialRampToValueAtTime(targetRate,anchor+dur);
      }
      /* equal-power fade-out: scaled cos curve from current gain → 0,
         spanning the full glide window. */
      var startVal=v.voiceGain.gain.value;
      var out=new Float32Array(EQUAL_POWER_LEN);
      for(var oi=0;oi<EQUAL_POWER_LEN;oi++)out[oi]=_epFadeOut[oi]*startVal;
      v.voiceGain.gain.cancelScheduledValues(anchor);
      v.voiceGain.gain.setValueCurveAtTime(out,anchor,dur);
      try{v.source.stop(anchor+dur+0.05);}catch(e){}
    }
    if(keptSwitch){
      try{keptSwitch.newSrc.stop(anchor+dur+0.05);}catch(e){}
      keptSwitch.newSrc.onended=function(){
        try{keptSwitch.newSrc.disconnect();}catch(e){}
        try{keptSwitch.newSG.disconnect();}catch(e){}
      };
    }
    delete activeVoices[voiceKey];return savedVol;
  }
  export function sNoteOnFaded(voiceKey: string, freq: number, vol: number, dur: number, instrumentKey: string, atTime?: number, fromFreq?: number, pan?: number): void {
    if(!ctx||!instrumentKey||!buffers[instrumentKey])return;
    if(activeVoices[voiceKey])sHardStop(voiceKey);
    /* Slide/glide path: only single-layer (sustained/loop) instruments slide —
       layered decay instruments retrigger — so the neutral 64 short-circuits to
       the single-layer pick, byte-identical to pre-velocity-layer behavior. */
    var nearest=findNearest(freq,64,instrumentKey);if(!nearest)return;
    var instr=loadedInstruments[instrumentKey];
    var rate=freq*(instr.transpose||1)/nearest.freq;
    /* vol param is treated as baseVol (without range attenuation or per-sample
       gain); apply attenuation + the new sample's gain fresh based on current
       freq and nearest sample. The slide may have moved to a different sample,
       which can carry a different normalization gain. */
    var baseVol=vol;
    vol=baseVol*rangeAttenuation(freq,instrumentKey)*(nearest.gain!=null?nearest.gain:1.0);
    /* See sNoteOn for the segments-vs-legacy dispatch — mirrored here. */
    var segsFaded=nearest.lp&&nearest.lp.segments;
    var pts=nearest.lp&&nearest.lp.loopPts;
    if(segsFaded&&segsFaded.length>=1&&(!pts||pts.length<2)){
      var endptSetF:any={};
      for(var si2=0;si2<segsFaded.length;si2++){
        endptSetF[segsFaded[si2].a.toFixed(7)]=segsFaded[si2].a;
        endptSetF[segsFaded[si2].b.toFixed(7)]=segsFaded[si2].b;
      }
      pts=[];
      for(var kk in endptSetF)pts.push(endptSetF[kk]);
      pts.sort(function(a:number,b:number){return a-b;});
    }
    var source=ctx.createBufferSource();source.buffer=nearest.buffer;
    /* If `fromFreq` is given (lookahead-scheduler slur glide), start the
       new voice at the predecessor's current pitch instead of the target.
       The matching ramp scheduled below at `startT` slides this voice
       from fromFreq to freq in lockstep with sSlideAndFadeOut's ramp on
       the old voice — both sources play at the same pitch throughout, so
       the equal-power crossfade behaves as it was designed (constant
       summed amplitude, no chord effect from pitch-mismatched mixing). */
    var startRate=(fromFreq!=null)?(fromFreq*(instr.transpose||1)/nearest.freq):rate;
    source.playbackRate.value=startRate;
    source.playbackRate.setValueAtTime(startRate,0); /* t=0 timeline seed */
    /* start from loop region (no attack re-trigger) */
    var startOffset;
    if(instr.loop&&pts&&pts.length>=2){
      /* No source.loop=true — scheduleSegmentSwitch handles all looping. */
      source.loopStart=pts[0];source.loopEnd=pts[pts.length-1];
      startOffset=pts[0]; /* start at loop point, not beginning */
    } else {
      startOffset=(nearest.lp&&nearest.lp.trimStart)?nearest.lp.trimStart:0;
    }
    var pressureGain=ctx.createGain();pressureGain.gain.value=1.0;pressureGain.connect(master);
    var damperGain=ctx.createGain();damperGain.gain.value=1.0;damperGain.connect(pressureGain);
    var voiceGain=ctx.createGain();voiceGain.gain.value=1.0;voiceGain.connect(damperGain);
    var segGain=ctx.createGain();
    /* Pre-schedule 50ms ahead so source.start isn't clamped under any
       plausible JS stall — see the longer comment in sNoteOn for the
       full rationale. Snap `when` to the integer-sample grid (pairs with
       load-time trimStart/pts snapping so rate=1 reads avoid interpolation).
       `atTime` (lookahead-scheduler glide path) anchors the new voice on
       the audio clock so the glide boundary is sample-accurate; live
       transpose paths omit it and get the 50ms default lead. */
    var fadedTarget=atTime!=null?atTime:ctx.currentTime+0.050;
    var startT=Math.ceil(Math.max(fadedTarget,ctx.currentTime+0.005)*ctx.sampleRate)/ctx.sampleRate;
    /* Matching pitch ramp: slide the new voice's playbackRate from
       startRate → rate over `dur`, anchored at startT to lock to the old
       voice's sSlideAndFadeOut ramp. Skip if same-pitch (startRate===rate)
       to avoid a no-op event that would still consume an AudioParam slot. */
    if(fromFreq!=null&&startRate!==rate){
      source.playbackRate.cancelScheduledValues(startT);
      source.playbackRate.setValueAtTime(startRate,startT);
      source.playbackRate.exponentialRampToValueAtTime(rate,startT+dur);
    }
    /* equal-power fade-in: scaled sin curve from 0 → vol. Pairs with the
       cos fade-out in sSlideAndFadeOut so summed gain is ~constant — and
       with the pitch-matched ramp above, summed pitch is also constant. */
    var fin=new Float32Array(EQUAL_POWER_LEN);
    for(var fi=0;fi<EQUAL_POWER_LEN;fi++)fin[fi]=_epFadeIn[fi]*vol;
    segGain.gain.value=0; /* born silent — Firefox pre-ring guard, see scheduleSegmentSwitch */
    segGain.gain.setValueAtTime(0,0); /* t=0 timeline seed — deferred-setter guard, see scheduleSegmentSwitch */
    segGain.gain.setValueCurveAtTime(fin,startT,dur);
    source.connect(segGain);segGain.connect(voiceGain);
    source.start(startT,startOffset);
    /* Graph: accept new validStartsByEnd or convert legacy endsByStart */
    var vsbeFaded=nearest.lp&&nearest.lp.validStartsByEnd;
    if(!vsbeFaded&&nearest.lp&&nearest.lp.endsByStart&&pts){
      var legacyEBS=nearest.lp.endsByStart;
      vsbeFaded=new Array(pts.length);
      for(var li=0;li<pts.length;li++)vsbeFaded[li]=[];
      for(var la=0;la<legacyEBS.length;la++){
        var bs=legacyEBS[la]||[];
        for(var lk=0;lk<bs.length;lk++){
          var lb=bs[lk];
          if(lb>la&&lb<pts.length)vsbeFaded[lb].push(la);
        }
      }
    }
    /* Initial loop anchor — segments path picks the segment with the
       largest b for deepest forward play; legacy path picks the broadest
       (a=pts[0], b=pts[last]) pair. See sNoteOn for the longer comment. */
    var initAF:number, initBF:number, initSegIdxF:number=-1;
    var initAIdxF:number=0, initBIdxF:number=0;
    if(segsFaded&&segsFaded.length>=1){
      initSegIdxF=0;
      for(var ii2=1;ii2<segsFaded.length;ii2++)if(segsFaded[ii2].b>segsFaded[initSegIdxF].b)initSegIdxF=ii2;
      initAF=segsFaded[initSegIdxF].a;
      initBF=segsFaded[initSegIdxF].b;
    } else {
      initAF=(pts&&pts.length>=2)?pts[0]:0;
      initBF=(pts&&pts.length>=2)?pts[pts.length-1]:0;
      initBIdxF=(pts&&pts.length>=2)?pts.length-1:0;
    }
    var voice={source:source,segGain:segGain,voiceGain:voiceGain,damperGain:damperGain,pressureGain:pressureGain,freq:freq,sampleFreq:nearest.freq,transpose:(instr.transpose||1),sampleName:nearest.name,sampleXfadeSec:(nearest.crossfadeSec||null),vol:vol,baseVol:baseVol,alive:true,
      loopPts:pts,validStartsByEnd:vsbeFaded||null,segments:segsFaded,loopTimer:null,buffer:nearest.buffer,instr:instr,instrKey:instrumentKey,
      slopeCV:(nearest.lp&&typeof nearest.lp.slopeCV==='number')?nearest.lp.slopeCV:0.5,
      sourceStartTime:startT,sourceOffset:startOffset,
      sourceLoopA:initAF,sourceLoopB:initBF,
      sourceLoopAIdx:initAIdxF,sourceLoopBIdx:initBIdxF,
      currentSegIdx:initSegIdxF>=0?initSegIdxF:undefined,
      sourceRate:rate,panNode:null};
    source.onended=function(){voice.alive=false;};
    activeVoices[voiceKey]=voice;
    /* Pre-start pan, same as sNoteOn — startT is ≥5ms out. */
    if(pan!=null)sSetVoicePan(voiceKey,pan);
    if(instr.loop&&pts&&pts.length>=2){
      scheduleSegmentSwitch(voiceKey);
    }
  }
  export function sHardStop(voiceKey: string): void {
    var v=activeVoices[voiceKey];if(!v)return;
    if(v.loopTimer){clearTimeout(v.loopTimer);v.loopTimer=null;}
    if(v.pendingSwitch)cancelPendingSwitch(v);
    if(v.alive){v.voiceGain.gain.cancelScheduledValues(ctx.currentTime);v.voiceGain.gain.setValueAtTime(0,ctx.currentTime);try{v.source.stop(ctx.currentTime);}catch(e){}}
    delete activeVoices[voiceKey];
  }
  export function sHardStopAll(): void {for(var k in activeVoices)sHardStop(k);}
  export function sStopAll(): void {for(var k in activeVoices)sNoteOff(k);}
  export function sSetAftertouch(voiceKey: string, targetGain: number, rampSec: number): void {
    var v=activeVoices[voiceKey];if(!v||!v.alive||!v.pressureGain)return;
    var now=ctx.currentTime;
    /* dB-linear exponential ramp. We can't use cancelAndHoldAtTime in
       Firefox, and reading gain.value during cancel can return the prior
       fixed anchor (not the in-flight ramp value) — that's the snap-back
       footgun that produced the audible drops. Polyfill: track the ramp
       in JS and compute the in-flight value analytically via
       inflightExpRampValue. Anchor at THAT, not gain.value, then exp-ramp
       to the new target. Math.max(target, 0.0001) satisfies expRamp's
       positive-target requirement. */
    var target=Math.max(targetGain,0.0001);
    var anchor=v.paRampState?inflightExpRampValue(v.paRampState,now):v.pressureGain.gain.value;
    v.pressureGain.gain.cancelScheduledValues(now);
    v.pressureGain.gain.setValueAtTime(anchor,now);
    v.pressureGain.gain.exponentialRampToValueAtTime(target,now+rampSec);
    v.paRampState={startVal:anchor,startTime:now,targetVal:target,endTime:now+rampSec};
  }
  /* Continuous-damper modulation. tau=0 → instant set (sostenuto pin), else
     setTargetAtTime exponential smoothing. Engine guarantees sample voices
     have a damperGain via sNoteOn/sNoteOnFaded. */
  export function sSetVoiceDamperDepth(voiceKey: string, depth: number, tau: number): void {
    var v=activeVoices[voiceKey];if(!v||!v.alive||!v.damperGain)return;
    var now=ctx.currentTime;
    v.damperGain.gain.cancelScheduledValues(now);
    if(tau<=0){v.damperGain.gain.setValueAtTime(depth,now);}
    else{v.damperGain.gain.setTargetAtTime(depth,now,tau);}
  }
  /* Per-voice StereoPannerNode, created LAZILY — only once a pan is actually
     specified (note-on `pan` arg or sSetVoicePan). A panner at pan=0 is NOT
     transparent for mono sources: the equal-power center law maps mono to
     cos(π/4)≈0.707 per channel, ~3 dB below the plain mono→stereo up-mix copy
     an unpanned voice gets. Lazy creation keeps the graph of consumers that
     never pan byte-identical to the pre-pan engine. Once created it is the
     voice's outermost node (pressureGain → panNode → master), so it persists
     across seam-crossfade source rotation and needs no teardown beyond the
     voice's own (same lifecycle as pressureGain/damperGain). */
  function ensureVoicePanNode(v: any): any {
    if(v.panNode)return v.panNode;
    if(!ctx||typeof ctx.createStereoPanner!=='function')return null; /* host without StereoPannerNode — pan unsupported */
    var panNode=ctx.createStereoPanner();
    /* Splice between pressureGain and master. Connect/disconnect apply
       atomically at a render-quantum boundary, and in the note-on path this
       runs before the source's scheduled start anyway. */
    v.pressureGain.disconnect(master);
    v.pressureGain.connect(panNode);
    panNode.connect(master);
    v.panNode=panNode;
    return panNode;
  }
  /* Stereo pan for one voice, Web Audio -1 (left) .. 1 (right). rampSec>0
     glides linearly; pan is a native AudioParam so the anchor is just the
     param's current value (none of sSetAftertouch's Firefox ramp-tracking
     polyfill applies). Silently no-ops when the context lacks
     createStereoPanner, matching the other per-voice setters' guard style. */
  export function sSetVoicePan(voiceKey: string, pan: number, rampSec?: number): void {
    var v=activeVoices[voiceKey];if(!v||!v.alive)return;
    var panNode=ensureVoicePanNode(v);if(!panNode)return;
    var target=Math.max(-1,Math.min(1,pan));
    var now=ctx.currentTime;
    panNode.pan.cancelScheduledValues(now);
    if(rampSec!=null&&rampSec>0){
      panNode.pan.setValueAtTime(panNode.pan.value,now);
      panNode.pan.linearRampToValueAtTime(target,now+rampSec);
    }else{
      panNode.pan.setValueAtTime(target,now);
    }
  }

export function getActiveVoices(): Record<string, any> { return activeVoices; }
export function isInstrumentLoaded(k: string): boolean { return !!buffers[k]; }
export function unloadInstrument(k: string): void { delete buffers[k]; }
/* Diagnostics: lets loopOverlay attach an AnalyserNode to the samples-only
   master so envelope visualization captures sample voices without
   oscillator content. Connects in parallel to the existing destination. */
export function tapMaster(node: AudioNode): void { if (master) master.connect(node); }
