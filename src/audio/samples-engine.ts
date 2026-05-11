// Sample engine: voice lifecycle, loop scheduling, segment-switching.
// Do not refactor internals without reading docs/lessons.md
// (sample-loop invariants: never source.loop=true, all wraps via
// scheduleSegmentSwitch, commitRampSync integrates in-flight ramp position).

import { recordSeamEvent } from './diagnostics/loopOverlay.js';
import { inflightExpRampValue } from './aftertouch.js';
import { INSTRUMENTS } from './samples-data.js';

const RELEASE_SCALE = 0.5;

/* Dev-only: route Iowa MIS fetches through the Vite middleware (see
   vite.config.ts → iowaMisTranscodeMiddleware). Two reasons to bridge:
     (1) theremin.music.uiowa.edu sends no Access-Control-Allow-* headers,
         so direct browser fetch() fails cross-origin.
     (2) Iowa ships AIFF only; Firefox's decodeAudioData won't decode AIFF.
   The middleware proxies the upstream AIFF, transcodes to WAV via ffmpeg,
   caches it, and returns Content-Type: audio/wav (the URL path keeps its
   .aif/.aiff suffix — decodeAudioData reads the MIME, not the extension).
   Mirrors the analyzer's /iowa-mis usage. Production builds are unaffected:
   import.meta.env.DEV is false in `vite build` output. */
function rewriteIowaUrl(url: string): string {
  if (!import.meta.env.DEV) return url;
  const PITCHES_2014 = 'https://theremin.music.uiowa.edu/sound%20files/MIS%20Pitches%20-%202014/';
  const LEGACY_MIS   = 'https://theremin.music.uiowa.edu/sound%20files/MIS/';
  if (url.startsWith(PITCHES_2014)) return '/iowa-mis/' + url.slice(PITCHES_2014.length);
  if (url.startsWith(LEGACY_MIS))   return '/iowa-mis-legacy/' + url.slice(LEGACY_MIS.length);
  return url;
}

let ctx: any = null;
let master: any = null;
let sampleMaster: any = null;
let currentInstrument: any = null;
const buffers: Record<string, any> = {};
const activeVoices: Record<string, any> = {};

  export function init(audioCtx: AudioContext, destNode: AudioNode): void {
    ctx=audioCtx;
    sampleMaster=ctx.createGain();
    sampleMaster.gain.value=1.0;
    sampleMaster.connect(destNode);
    master=sampleMaster;
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
  export function loadInstrument(key: string, onProgress?: (loaded: number, total: number, name: string) => void): Promise<void> {
    return new Promise<void>(function(resolve,reject){
      var instr=INSTRUMENTS[key];
      if(!instr)return reject(new Error('Unknown instrument: '+key));
      if(buffers[key]){currentInstrument=key;return resolve();}
      var loaded=0,total=instr.samples.length,result: any[] = [];
      var aborted=false;
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
        /* Per-sample s.file wins: the analyzer records the exact filename it
           fetched per note, which is the only safe option when an instrument's
           filePatterns array tries multiple URL templates (Iowa strings'
           sul-string prefixes, VCSL harpsichord's Low/High registers) and
           different notes resolved to different templates. For legacy
           instruments without s.file, fall back to pattern substitution. */
        var url;
        if(s.file){
          url=instr.baseUrl+s.file.replace(/#/g,'%23');
        } else {
          var pat=instr.filePattern||('{NOTE}'+instr.ext);
          url=instr.baseUrl+pat.replace('{NOTE}',s.name).replace(/#/g,'%23');
        }
        var timer=setTimeout(function(){aborted=true;delete buffers[key];reject(new Error("Timeout loading "+s.name));},10000);
        fetch(rewriteIowaUrl(url)).then(function(r){
          if(!r.ok)throw new Error('HTTP '+r.status);return r.arrayBuffer();
        }).then(function(ab){return ctx.decodeAudioData(ab);}).then(function(buf){
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
          /* trim silence for decaying instruments too */
          if(!instr.loop){var _d=buf.getChannelData(0);for(var _s=0;_s<buf.length;_s++){if(Math.abs(_d[_s])>0.003){lp.trimStart=_s/buf.sampleRate;break;}}}
          result[i]={buffer:buf,freq:s.freq,gain:(typeof s.gain==='number')?s.gain:1.0,lp:lp,name:s.name};loaded++;
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
            currentInstrument=key;resolve();
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
            else{currentInstrument=key;resolve();}}
        });
      });
    });
  }
  function findNearest(freq: number): any {
    var samps=buffers[currentInstrument];
    if(!samps||samps.length===0)return null;
    var best=0,bestDist=Infinity;
    for(var i=0;i<samps.length;i++){var dist=Math.abs(Math.log2(freq/samps[i].freq));if(dist<bestDist){bestDist=dist;best=i;}}
    return samps[best];
  }
  /* Range attenuation: pure function of frequency (no state). Returns gain factor
     for a given frequency — 1.0 within range, reducing toward 0.5 as freq exceeds
     the highest sample. Used identically by sNoteOn and sNoteOnFaded so that
     transposing up and back down fully restores the original gain. */
  function rangeAttenuation(freq: number): number {
    var samps=buffers[currentInstrument];
    if(!samps||samps.length===0)return 1.0;
    var highestFreq=samps[samps.length-1].freq;
    if(freq<=highestFreq)return 1.0;
    var overshoot=freq/highestFreq; /* 1.0 at top, 1.5 = fifth up, 2.0 = octave up */
    /* gentle taper: 1.0 → 1.0, 1.5 → 0.82, 2.0 → 0.64, ≥2.4 → 0.5 (clamped) */
    return Math.max(0.5,1.0-(overshoot-1.0)*0.36);
  }
  export function sNoteOn(voiceKey: string, freq: number, velocity: number): void {
    if(!ctx||!currentInstrument)return;
    if(activeVoices[voiceKey])sNoteOff(voiceKey);
    var nearest=findNearest(freq);
    if(!nearest)return;
    var instr=INSTRUMENTS[currentInstrument];
    var rate=freq*(instr.transpose||1)/nearest.freq;
    var vel=(velocity!==undefined)?velocity/127:0.85;
    var instrVol=instr.volume||1.0;
    var baseVol=(0.10+0.90*vel*vel)*instrVol;
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
    var vol=baseVol*rangeAttenuation(freq)*(nearest.gain!=null?nearest.gain:1.0);
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
    /* Schedule the source FIRST_SOURCE_LEAD seconds in the future, not at
       currentTime, and record sourceStartTime as the same future moment.
       Reason: source.start(t, ...) with t < ctx.currentTime gets clamped by
       Web Audio to the actual currentTime at processing — which can be one
       render quantum (~2.7ms) or more past `t` if JS stalls between
       capturing currentTime and the audio thread consuming the schedule.
       Recording sourceStartTime as the JS-captured time then under-records
       the actual start moment, throwing off the switchTime computation in
       scheduleSegmentSwitch. The mismatch produces a phase-shifted crossfade
       on the first switch that the analyzer never validated → audible dip.
       Pre-scheduling far enough ahead makes start exact (no clamping). The
       lead must comfortably exceed any plausible JS stall on the note-on
       path (event handler, click logic, redraw, possible GC pause) — 50ms
       is well above the worst case while still imperceptible (≪100ms) as
       note-onset latency. Subsequent sources (created in scheduleSegmentSwitch)
       already pre-schedule with even more lead; this brings the first source
       in line. */
    /* Snap `when` to the integer-sample grid; pairs with the load-time
       trimStart/pts snapping so rate=1 reads avoid interpolation. */
    var startT=Math.ceil((ctx.currentTime+0.050)*ctx.sampleRate)/ctx.sampleRate;
    segGain.gain.setValueAtTime(vol,startT);
    var source=ctx.createBufferSource();source.buffer=nearest.buffer;
    source.playbackRate.value=rate;
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
    var voice={source:source,segGain:segGain,voiceGain:voiceGain,damperGain:damperGain,pressureGain:pressureGain,freq:freq,sampleFreq:nearest.freq,transpose:(instr.transpose||1),sampleName:nearest.name,
      vol:vol,baseVol:baseVol,alive:true,loopPts:pts,validStartsByEnd:vsbe,segments:segs,loopTimer:null,buffer:nearest.buffer,instr:instr,
      slopeCV:(nearest.lp&&typeof nearest.lp.slopeCV==='number')?nearest.lp.slopeCV:0.5,
      sourceStartTime:startT,sourceOffset:startOffset,
      sourceLoopA:initialA,
      sourceLoopB:initialB,
      sourceLoopAIdx:initialAIdx,
      sourceLoopBIdx:initialBIdx,
      currentSegIdx:initialSegIdx>=0?initialSegIdx:undefined,
      sourceRate:rate};
    source.onended=function(){voice.alive=false;};
    activeVoices[voiceKey]=voice;
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
      var segs=v.segments;
      var curIdx=v.currentSegIdx;
      if(curIdx==null||curIdx<0||curIdx>=segs.length)curIdx=0;
      var aTime=segs[curIdx].a;  /* loop back to current segment's a */
      /* Reachable next-targets: any segment whose b lies past where we just
         looped to. Include current segment in the candidate set so a
         single-segment SCC still works (replay same pair). */
      var cands:number[]=[];
      for(var i=0;i<segs.length;i++){
        if(segs[i].b>aTime)cands.push(i);
      }
      if(cands.length===0)cands.push(curIdx); /* dead-end fallback: replay */
      var nextIdx=cands[Math.floor(Math.random()*cands.length)];
      return {a:aTime,b:segs[nextIdx].b,nextSegIdx:nextIdx};
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
    var rate=v.sourceRate||v.source.playbackRate.value||1;
    var now=ctx.currentTime;
    /* The current source wraps at this time. ALWAYS switch at every wrap. */
    var switchTime=v.sourceStartTime+(v.sourceLoopB-v.sourceOffset)/rate;
    /* If we're already past the wrap (extreme JS stall during a prior call),
       push a few ms forward so setValueAtTime / source.start are valid. */
    if(switchTime<now+0.005)switchTime=now+0.005;

    var picked=pickNextSeam(v,pts);
    /* picked.a, picked.b are TIMES (in seconds within the buffer). For the
       segments pipeline picked also carries `nextSegIdx`; for the legacy
       pipeline it carries `aIdx`/`bIdx`. commitPendingSwitch dispatches on
       which set is present. */
    var aTime=picked.a,bTime=picked.b;

    /* 30ms linear crossfade — gives |cos(Δφₖ/2)| at midpoint per harmonic,
       no +3dB boost at phase-aligned fundamental (equal-power would). */
    var xfDur=0.030;
    var newSrc=ctx.createBufferSource();newSrc.buffer=v.buffer;
    newSrc.loopStart=aTime;newSrc.loopEnd=bTime;
    newSrc.playbackRate.value=v.source.playbackRate.value;
    var newSG=ctx.createGain();
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
      fromTime:v.sourceLoopB,toTime:aTime
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
    v.sourceRate=p.newSrc.playbackRate.value;
    recordSeamEvent({ctxTime:p.switchTime,voiceKey:voiceKey,sampleName:v.sampleName||'?',
      rate:v.sourceRate||1,
      fromBIdx:p.bIdx!=null?v.sourceLoopBIdx:-1,toAIdx:p.aIdx!=null?p.aIdx:-1,
      fromTime:p.fromTime,toTime:p.toTime,xfadeDur:p.xfDur});
    p.newSrc.onended=function(){v.alive=false;};
    v.pendingSwitch=null;
  }

  /* Cancel a pre-scheduled switch (called from sRampFreq/sNoteOff/sHardStop
     before they mutate v.source). Stops the new source, disconnects its
     graph, and restores the old segGain to v.vol via a brief 5ms ramp so
     mid-crossfade cancellation doesn't click. */
  function cancelPendingSwitch(v: any): void {
    if(!v.pendingSwitch)return;
    var p=v.pendingSwitch;
    /* stop(0) clamps to currentTime per spec — works whether newSrc has
       already started (cancel after switchTime) or not (cancel before). */
    try{p.newSrc.stop(0);}catch(e){}
    try{p.newSrc.disconnect();}catch(e){}
    try{p.newSG.disconnect();}catch(e){}
    var now=ctx.currentTime;
    p.oldSegGain.gain.cancelScheduledValues(now);
    p.oldSegGain.gain.setValueAtTime(p.oldSegGain.gain.value,now);
    p.oldSegGain.gain.linearRampToValueAtTime(v.vol,now+0.005);
    v.pendingSwitch=null;
  }
  export function sNoteOff(voiceKey: string): void {
    var v=activeVoices[voiceKey];if(!v)return;
    if(v.loopTimer){clearTimeout(v.loopTimer);v.loopTimer=null;}
    if(v.reAnchorTimer){clearTimeout(v.reAnchorTimer);v.reAnchorTimer=null;}
    /* If a switch was pre-scheduled but not yet committed, tear it down so the
       new source doesn't continue playing (silently, behind the released
       voiceGain) and leak the BufferSource node. */
    if(v.pendingSwitch)cancelPendingSwitch(v);
    var instr=INSTRUMENTS[currentInstrument];
    var release=(((instr&&instr.releaseTime)||0.3)*RELEASE_SCALE);var now=ctx.currentTime;
    if(v.alive){
      /* fade voiceGain — silences ALL sources routed through it */
      v.voiceGain.gain.cancelScheduledValues(now);
      v.voiceGain.gain.setValueAtTime(v.voiceGain.gain.value,now);
      v.voiceGain.gain.linearRampToValueAtTime(0,now+release);
      try{v.source.stop(now+release+0.05);}catch(e){}
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
    var xfDur=0.030;
    var newSrc=ctx.createBufferSource();newSrc.buffer=v.buffer;
    newSrc.loopStart=aTime;newSrc.loopEnd=bTime;
    newSrc.playbackRate.value=v.source.playbackRate.value;
    var newSG=ctx.createGain();
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
    v.sourceRate=newSrc.playbackRate.value;
    recordSeamEvent({ctxTime:st,voiceKey:voiceKey,sampleName:v.sampleName||'?',
      rate:v.sourceRate||1,
      fromBIdx:picked.bIdx!=null?v.sourceLoopBIdx:-1,toAIdx:picked.aIdx!=null?picked.aIdx:-1,
      fromTime:fromTime,toTime:aTime,xfadeDur:xfDur});
    newSrc.onended=function(){v.alive=false;};
    return true;
  }
  /* ══ commitRampSync ══
     Synchronously advance the voice's anchor to time `now`, correctly
     handling an in-flight rate ramp. Necessary when a new sRampFreq fires
     while a prior ramp's re-anchor setTimeout is still pending — without
     this, the prior re-anchor runs with stale ramp parameters (its ramp
     was cancelled by the new one) and corrupts anchor state, which
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
    if(!v.alive){var pv=v.vol;delete activeVoices[voiceKey];sNoteOn(voiceKey,newFreq,Math.round(((pv-0.3)/0.7)*127));return true;}
    var now=ctx.currentTime;
    /* ── COMMIT ANY IN-FLIGHT RAMP ──
       If a prior ramp's re-anchor setTimeout is still pending, cancel it
       and commit the prior ramp's state up to `now` synchronously. This
       prevents the stale-snapshot race where the prior re-anchor would
       fire later with ramp parameters that no longer reflect reality
       (its ramp is about to be cancelled by our cancelScheduledValues). */
    if(v.reAnchorTimer){
      clearTimeout(v.reAnchorTimer);
      v.reAnchorTimer=null;
      commitRampSync(v,now);
    }
    /* Cancel any pre-scheduled segment switch — its audio events were anchored
       on the old rate and pre-ramp state, which is about to change. The
       reAnchorTimer below will schedule a fresh one after the ramp settles. */
    if(v.pendingSwitch)cancelPendingSwitch(v);
    var newRate=newFreq*(v.transpose||1)/v.sampleFreq;
    var oldRate=v.sourceRate||v.source.playbackRate.value||1;
    /* ── WRAP-DURING-RAMP PROTECTION (position-based) ──
       If the ramp will carry the playhead past loopB, the source plays
       into post-loop buffer content (no native loop). Project position:
         pos_at_ramp_end = sourceOffset + (oldRate+newRate)/2 * durSec
         pos_at_settle   = + newRate * 0.06  (covers 20ms re-anchor delay + margin)
       After commitRampSync above, sourceStartTime === now, so sourceOffset
       is the actual current position. Compare against loopB; if exceeded,
       fire a synchronous immediate switch to re-anchor at pts[a_new]
       with a fresh full-loop ahead.

       Position-based catches fast upward ramps (e.g., 1→8×) that blow
       past loopB inside durSec — the old timeToWrap-at-oldRate check
       missed these because rampAdvance far exceeds oldRate*durSec. */
    if(v.loopPts&&v.loopPts.length>=2&&v.sourceLoopB!==undefined){
      /* Current playhead position: if commitRampSync just ran above,
         v.sourceStartTime === now and the correction is 0. If no prior
         ramp existed, the anchor may be from a past scheduleSegmentSwitch;
         correct for elapsed time at the steady-state rate. */
      var currentPos=v.sourceOffset+oldRate*(now-v.sourceStartTime);
      var rampAdvance=(oldRate+newRate)*0.5*durSec;
      var settlementAdvance=newRate*0.06;
      var projectedPos=currentPos+rampAdvance+settlementAdvance;
      if(projectedPos>=v.sourceLoopB){
        if(v.loopTimer){clearTimeout(v.loopTimer);v.loopTimer=null;}
        doImmediateSwitch(voiceKey);
        v=activeVoices[voiceKey];
        if(!v||!v.alive)return false;
        /* After switch: v.source is NEW, v.sourceStartTime ≈ now+8ms,
           sourceOffset=pts[a_new]. oldRate unchanged (ramp hasn't started). */
        oldRate=v.sourceRate||v.source.playbackRate.value||oldRate;
      }
    }
    /* Start the rate ramp on the current (possibly freshly-switched) source. */
    v.source.playbackRate.cancelScheduledValues(now);
    v.source.playbackRate.setValueAtTime(oldRate,now);
    v.source.playbackRate.linearRampToValueAtTime(newRate,now+durSec);
    v.freq=newFreq;
    /* Record pending ramp for commitRampSync. */
    v.pendingRampStart=now;
    v.pendingRampEnd=now+durSec;
    v.pendingRampR0=oldRate;
    v.pendingRampR1=newRate;
    /* ── RE-ANCHOR AFTER RAMP ──
       Cancel any stale scheduleSegmentSwitch timer (its switchTime was
       computed with oldRate). At ramp-end, call commitRampSync (handles
       post-ramp case: now ≥ re, so anchor = post-ramp position at newRate),
       fold into loop range for clean wrap scheduling, then reschedule. */
    if(v.loopTimer){clearTimeout(v.loopTimer);v.loopTimer=null;}
    var rampStartTime=now;
    var rampEndTime=now+durSec;
    v.reAnchorTimer=setTimeout(function(){
      var v2=activeVoices[voiceKey];
      if(!v2)return;
      v2.reAnchorTimer=null;
      if(!v2.alive)return;
      if(!v2.loopPts||v2.loopPts.length<2)return;
      /* Stale check: if pendingRamp was cleared/replaced (e.g., commitRampSync
         ran already via another sRampFreq), we shouldn't re-commit. */
      if(v2.pendingRampStart!==rampStartTime||v2.pendingRampEnd!==rampEndTime)return;
      var tNow=ctx.currentTime;
      commitRampSync(v2,tNow>rampEndTime?tNow:rampEndTime);
      /* Post-ramp: if source has played past loopB (wrap-during-ramp check
         didn't fire — position was within margin but ramp drift pushed it
         over), the anchor's sourceOffset is past loopB. Fold into loop:
         scheduleSegmentSwitch's switchTime math expects sourceOffset<loopB. */
      var loopA=v2.sourceLoopA,loopB=v2.sourceLoopB;
      if(loopA!==undefined&&loopB!==undefined&&v2.sourceOffset>loopB){
        var loopSpan=loopB-loopA;
        while(v2.sourceOffset>loopB)v2.sourceOffset-=loopSpan;
      }
      scheduleSegmentSwitch(voiceKey);
    },durSec*1000+20);
    return true;
  }
  export function sSlideAndFadeOut(voiceKey: string, targetFreq: number, dur: number): number {
    var v=activeVoices[voiceKey];if(!v)return 0.7;
    /* Return baseVol (pre-attenuation) so the caller can pass it to sNoteOnFaded,
       which will reapply attenuation based on the NEW frequency. Falls back to v.vol
       for voices created before baseVol was tracked. */
    var savedVol=(v.baseVol!==undefined)?v.baseVol:v.vol;
    /* Tear down any pre-scheduled switch first; the rate ramp below would
       leave its switchTime/playbackRate stale, and the voice is being
       deleted anyway. */
    if(v.pendingSwitch)cancelPendingSwitch(v);
    if(v.loopTimer){clearTimeout(v.loopTimer);v.loopTimer=null;}
    var now=ctx.currentTime;
    if(v.alive){
      var targetRate=targetFreq*(v.transpose||1)/v.sampleFreq;
      v.source.playbackRate.cancelScheduledValues(now);
      v.source.playbackRate.setValueAtTime(v.source.playbackRate.value,now);
      v.source.playbackRate.linearRampToValueAtTime(targetRate,now+dur);
      v.voiceGain.gain.cancelScheduledValues(now);
      v.voiceGain.gain.setValueAtTime(v.voiceGain.gain.value,now);
      v.voiceGain.gain.linearRampToValueAtTime(0,now+dur);
      try{v.source.stop(now+dur+0.05);}catch(e){}
    }
    delete activeVoices[voiceKey];return savedVol;
  }
  export function sNoteOnFaded(voiceKey: string, freq: number, vol: number, dur: number): void {
    if(!ctx||!currentInstrument)return;
    if(activeVoices[voiceKey])sHardStop(voiceKey);
    var nearest=findNearest(freq);if(!nearest)return;
    var instr=INSTRUMENTS[currentInstrument];
    var rate=freq*(instr.transpose||1)/nearest.freq;
    /* vol param is treated as baseVol (without range attenuation or per-sample
       gain); apply attenuation + the new sample's gain fresh based on current
       freq and nearest sample. The slide may have moved to a different sample,
       which can carry a different normalization gain. */
    var baseVol=vol;
    vol=baseVol*rangeAttenuation(freq)*(nearest.gain!=null?nearest.gain:1.0);
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
    source.playbackRate.value=rate;
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
       load-time trimStart/pts snapping so rate=1 reads avoid interpolation). */
    var startT=Math.ceil((ctx.currentTime+0.050)*ctx.sampleRate)/ctx.sampleRate;
    segGain.gain.setValueAtTime(0,startT);segGain.gain.linearRampToValueAtTime(vol,startT+dur);
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
    var voice={source:source,segGain:segGain,voiceGain:voiceGain,damperGain:damperGain,pressureGain:pressureGain,freq:freq,sampleFreq:nearest.freq,transpose:(instr.transpose||1),sampleName:nearest.name,vol:vol,baseVol:baseVol,alive:true,
      loopPts:pts,validStartsByEnd:vsbeFaded||null,segments:segsFaded,loopTimer:null,buffer:nearest.buffer,instr:instr,
      slopeCV:(nearest.lp&&typeof nearest.lp.slopeCV==='number')?nearest.lp.slopeCV:0.5,
      sourceStartTime:startT,sourceOffset:startOffset,
      sourceLoopA:initAF,sourceLoopB:initBF,
      sourceLoopAIdx:initAIdxF,sourceLoopBIdx:initBIdxF,
      currentSegIdx:initSegIdxF>=0?initSegIdxF:undefined,
      sourceRate:rate};
    source.onended=function(){voice.alive=false;};
    activeVoices[voiceKey]=voice;
    if(instr.loop&&pts&&pts.length>=2){
      scheduleSegmentSwitch(voiceKey);
    }
  }
  export function sHardStop(voiceKey: string): void {
    var v=activeVoices[voiceKey];if(!v)return;
    if(v.loopTimer){clearTimeout(v.loopTimer);v.loopTimer=null;}
    if(v.reAnchorTimer){clearTimeout(v.reAnchorTimer);v.reAnchorTimer=null;}
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

export function getActiveVoices(): Record<string, any> { return activeVoices; }
export function isLoaded(): boolean { return !!(currentInstrument && buffers[currentInstrument]); }
export function setInstrument(k: string): void { if (buffers[k]) currentInstrument = k; }
export function isInstrumentLoaded(k: string): boolean { return !!buffers[k]; }
export function unloadInstrument(k: string): void { delete buffers[k]; }
/* Diagnostics: lets loopOverlay attach an AnalyserNode to the samples-only
   master so envelope visualization captures sample voices without
   oscillator content. Connects in parallel to the existing destination. */
export function tapMaster(node: AudioNode): void { if (master) master.connect(node); }
