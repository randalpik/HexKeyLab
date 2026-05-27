/* HexKeyLab Analyzer — signal analysis pipeline.
   Pure DOM-free signal processing. Consumes AudioBuffer + a labeled
   fundamental; returns loop-point segments and the diagnostics that the
   visualization module renders. */

export const HKLAnalysis = (function () {
/* ═══ selectSegments — segment-based loop selector ═══
   The only loop-point selector. The runtime's state machine is
   "play to b, loop back to a, pick next segment, repeat" — perpetual looping
   requires the chosen (a, b) pairs to overlap into ONE strongly-connected
   component when sorted by a. This function delivers exactly that.

   Pipeline:
     1. Restrict +ZC candidates to those inside the steady region passed in.
     2. Compute envelope RMS + slope at each candidate (frequency-adaptive
        envelope window) — same per-candidate stats the dot overlay uses.
     3. Enumerate every (a, b) pair with a < b; apply the per-pair gates:
        rmsStepThreshold, slopeStepThreshold, pitch/tilt/tiltSlope (all O(1)
        and short-circuited before the only O(window) gate), then a final
        correlateWaveforms phase-coherence check at corrThreshold.
     4. Sort valid pairs by (b − a) descending. Greedy-select: accept iff
        (a) pair length ≥ minPairLengthSec, (b) both endpoints ≥ minEndpoint-
        SepSec from every endpoint of an already-selected pair. No 8-pair cap
        at this stage — collect exhaustively.
     5. Sort selected pairs by a. SCC == single overlap chain: b_i ≥ a_{i+1}
        for every consecutive i. If multi-component, keep the component
        covering the most total time (union of ranges).
     6. Prune non-bridges down to ≤ 8 segments. A bridge is a segment whose
        removal breaks the consecutive-overlap chain; never removed. Among
        non-bridges, drop the shortest (least seam-to-seam play time) first.
        If only bridges remain and count still > 8, accept the larger count
        (better to have a longer perpetual cycle than to drop it).

   Returns:
     { segments: [{a, b}, ...], diag: {...} }
   where segments are sorted by a. */
function selectSegments(buf, candidates, opts){
  opts=opts||{};
  var sr=buf.sampleRate,d=buf.getChannelData(0),len=buf.length;
  var rmsStepThreshold=opts.rmsStepThreshold!==undefined?opts.rmsStepThreshold:0.01;
  var slopeStepThreshold=opts.slopeStepThreshold!==undefined?opts.slopeStepThreshold:0.01;
  var slopeStrideSec=opts.slopeStrideSec!==undefined?opts.slopeStrideSec:0.030;
  var corrThreshold=opts.corrThreshold!==undefined?opts.corrThreshold:0.95;
  var corrWindowPeriods=opts.corrWindowPeriods||3;
  var tActualSec=opts.tActualSec;
  var minPairLengthSec=opts.minPairLengthSec!==undefined?opts.minPairLengthSec:0.10;
  var minEndpointSepSec=opts.minEndpointSepSec!==undefined?opts.minEndpointSepSec:0.10;
  var maxSegments=opts.maxSegments||8;
  /* Pitch/tilt pair gates. Default Infinity = no gating (curves are still
     measured + visualized; only this layer chooses to admit / reject pairs).
     pitchStepThresholdCents: max |Δpitch| in cents between (a, b) candidate
       positions, sampled from the per-buffer pitch curve.
     tiltStepThreshold: max relative |Δtilt| / max(tilt_a, tilt_b).
     tiltSlopeStepThreshold: max |Δ(tilt-slope)| between (a, b). Tilt-slope is
       the finite-difference derivative of the smoothed tilt trend curve — two
       points can match in tilt magnitude but disagree on trajectory (one
       rising, one falling), which still produces an audible seam. Gating on
       this confines selection to where brightness is changing consistently. */
  var pitchAtCandidates=opts.pitchAtCandidates||null;
  var tiltAtCandidates=opts.tiltAtCandidates||null;
  var tiltSlopeAtCandidates=opts.tiltSlopeAtCandidates||null;
  /* Defaults chosen to give meaningful seam-quality gating out of the box:
       5¢   — under one-quarter of a typical vibrato cycle width; tight enough
              to keep wrap discontinuities below the pitch-just-noticeable
              difference for sustained tones.
       0.05 — 5% relative tilt step is at the edge of perceptible brightness
              change for most sustained instruments.
       0.05 — same magnitude for the dimensionless tilt-slope difference;
              starts as a soft gate that rejects only the worst mismatches. */
  var pitchStepThresholdCents=opts.pitchStepThresholdCents!==undefined?opts.pitchStepThresholdCents:5;
  var tiltStepThreshold=opts.tiltStepThreshold!==undefined?opts.tiltStepThreshold:0.05;
  var tiltSlopeStepThreshold=opts.tiltSlopeStepThreshold!==undefined?opts.tiltSlopeStepThreshold:0.05;
  var _debug=opts._debug?{greedyAccepted:[],components:[],keptComponentIdx:-1,nonBridgePrunings:[]}:null;

  var n=candidates.length;
  if(n<2)return{segments:[],diag:{failReason:'<2 candidates after steady-region restriction',nCandidates:n}};

  var envWinPeriods=opts.envWinPeriods!==undefined?opts.envWinPeriods:4;
  var envWin=(tActualSec&&tActualSec>0)?Math.max(32,Math.round(envWinPeriods*tActualSec*sr)):Math.round(sr*0.05);
  var envHalf=envWin>>1;
  function rmsAt(p){
    var lo=p-envHalf;if(lo<0)lo=0;
    var hi=p+envHalf;if(hi>len)hi=len;
    if(hi<=lo)return 0;
    var sum=0;
    for(var s=lo;s<hi;s++)sum+=d[s]*d[s];
    return Math.sqrt(sum/(hi-lo+1e-9));
  }
  /* Envelope at each candidate. */
  var envRms=new Array(n);
  for(var ei=0;ei<n;ei++)envRms[ei]=rmsAt(Math.round(candidates[ei]*sr));
  /* Slope (normalized finite difference). */
  var slopeRel=null,envMeanFn=0;
  if(tActualSec&&tActualSec>0){
    var h=Math.max(32,Math.round(slopeStrideSec*sr));
    for(var ei=0;ei<n;ei++)envMeanFn+=envRms[ei];
    envMeanFn=(n>0)?envMeanFn/n:0;
    if(envMeanFn>1e-9){
      slopeRel=new Array(n);
      for(var ei=0;ei<n;ei++){
        var pi=Math.round(candidates[ei]*sr);
        var ePlus=rmsAt(pi+h),eMinus=rmsAt(pi-h);
        slopeRel[ei]=(ePlus-eMinus)/(2*envMeanFn);
      }
    }
  }
  function ampStepDev(i,j){
    var a=envRms[i],b=envRms[j];
    var mx=(a>b)?a:b;
    return Math.abs(a-b)/(mx+1e-9);
  }
  function slopeStepDev(i,j){
    if(!slopeRel)return 0;
    return Math.abs(slopeRel[i]-slopeRel[j]);
  }
  /* ── 3. Enumerate valid (a, b) pairs ────────────────────────────────── */
  var corrWinSamples=Math.max(32,Math.round(corrWindowPeriods*(tActualSec||0.005)*sr));
  var validPairs=[];
  var rejectByRms=0,rejectBySlope=0,rejectByCorr=0;
  var rejectByPitch=0,rejectByTilt=0,rejectByTiltSlope=0;
  function pitchStepDev(i,j){
    if(!pitchAtCandidates)return 0;
    var pa=pitchAtCandidates[j],pb=pitchAtCandidates[i];
    if(pa==null||pb==null||isNaN(pa)||isNaN(pb))return 0;
    return Math.abs(pa-pb);
  }
  function tiltStepDev(i,j){
    if(!tiltAtCandidates)return 0;
    var ta=tiltAtCandidates[j],tb=tiltAtCandidates[i];
    if(ta==null||tb==null||isNaN(ta)||isNaN(tb))return 0;
    var mx=Math.max(ta,tb);
    return mx>1e-9?Math.abs(ta-tb)/mx:0;
  }
  /* Absolute difference (not ratio) because tilt-slope is signed and its
     sign is informative — a rising-to-falling pair is worse than two
     same-sign slopes of equal magnitude. The slope values are already
     normalized by trend mean inside computeTiltSlopeCurve, so this is
     dimensionless. Missing values (null/NaN at one or both endpoints —
     happens near steady-region edges where the stride-window straddles
     undefined trend samples) return Infinity, which rejects the pair
     whenever the gate is in place. If the gate is disabled
     (tiltSlopeStepThreshold = Infinity), Infinity > Infinity is false and
     the pair passes. The whole-array null guard returns 0 because then
     there is no gate to honor. */
  function tiltSlopeStepDev(i,j){
    if(!tiltSlopeAtCandidates)return 0;
    var sa=tiltSlopeAtCandidates[j],sb=tiltSlopeAtCandidates[i];
    if(sa==null||sb==null||isNaN(sa)||isNaN(sb))return Infinity;
    return Math.abs(sa-sb);
  }
  /* Gate order: every O(1) check runs before the only O(corrWinSamples)
     gate, so pairs rejected by the cheap metrics never pay for correlation.
     For low-pitched long samples (cello-class, ≥10 s steady) this is what
     keeps the n²·corrWin term from blowing up — correlation is by far the
     dominant cost when it runs on every surviving pair. */
  for(var i=1;i<n;i++){
    for(var j=0;j<i;j++){
      /* a < b by construction: j < i so pair is (a=j, b=i) */
      if(ampStepDev(i,j)>rmsStepThreshold){rejectByRms++;continue;}
      if(slopeStepDev(i,j)>slopeStepThreshold){rejectBySlope++;continue;}
      var psd=pitchStepDev(i,j);
      if(psd>pitchStepThresholdCents){rejectByPitch++;continue;}
      var tsd=tiltStepDev(i,j);
      if(tsd>tiltStepThreshold){rejectByTilt++;continue;}
      var tssd=tiltSlopeStepDev(i,j);
      if(tssd>tiltSlopeStepThreshold){rejectByTiltSlope++;continue;}
      var pi=Math.round(candidates[i]*sr),pj=Math.round(candidates[j]*sr);
      var pc=correlateWaveforms(d,pi,pj,corrWinSamples);
      if(pc<corrThreshold){rejectByCorr++;continue;}
      validPairs.push({a:candidates[j],b:candidates[i],aIdx:j,bIdx:i,dist:candidates[i]-candidates[j],pc:pc,pitchStep:psd,tiltStep:tsd,tiltSlopeStep:tssd});
    }
  }
  if(validPairs.length===0){
    return{segments:[],diag:{
      failReason:'no valid pairs',
      nCandidates:n,
      rejectByRms:rejectByRms,rejectBySlope:rejectBySlope,
      rejectByCorr:rejectByCorr,
      rejectByPitch:rejectByPitch,rejectByTilt:rejectByTilt,
      rejectByTiltSlope:rejectByTiltSlope
    }};
  }
  /* ── 4. Distance-descending greedy selection ─────────────────────────── */
  validPairs.sort(function(p,q){return q.dist-p.dist;});
  var selected=[];
  var endpoints=[];  /* every a or b of every selected pair */
  var nRejectedByMinLength=0;
  var nRejectedBySeparation=0;
  /* Track which candidate times appear as endpoints of pairs that PASSED
     the min-length filter but were REJECTED by the separation rule. The
     analyzer's per-row canvas uses this to visually distinguish "almost
     picked, but bumped by separation" candidates from "in steady but
     never part of a long-enough pair" candidates. */
  var separationRejectedTimes={};
  for(var k=0;k<validPairs.length;k++){
    var pr=validPairs[k];
    if(pr.dist<minPairLengthSec){nRejectedByMinLength++;continue;}
    var ok=true;
    for(var e=0;e<endpoints.length;e++){
      if(Math.abs(pr.a-endpoints[e])<minEndpointSepSec){ok=false;break;}
      if(Math.abs(pr.b-endpoints[e])<minEndpointSepSec){ok=false;break;}
    }
    if(!ok){
      nRejectedBySeparation++;
      separationRejectedTimes[+pr.a.toFixed(7)]=true;
      separationRejectedTimes[+pr.b.toFixed(7)]=true;
      continue;
    }
    selected.push(pr);
    endpoints.push(pr.a);endpoints.push(pr.b);
    if(_debug)_debug.greedyAccepted.push({a:pr.a,b:pr.b,dist:pr.dist});
  }
  /* Distance distribution among the valid pairs (min/p25/p50/p75/max).
     Useful for diagnosing "lots of valid pairs but few segments" — if the
     histogram is heavily skewed below minPairLengthSec, the length floor
     is the bottleneck; if it's well-distributed, the separation rule is. */
  function quantile(sortedArr,p){
    if(sortedArr.length===0)return 0;
    var idx=Math.floor(p*(sortedArr.length-1));
    return sortedArr[idx];
  }
  var distsSorted=validPairs.map(function(p){return p.dist;}).slice().sort(function(a,b){return a-b;});
  var distHistogram={
    min:+quantile(distsSorted,0).toFixed(4),
    p25:+quantile(distsSorted,0.25).toFixed(4),
    p50:+quantile(distsSorted,0.50).toFixed(4),
    p75:+quantile(distsSorted,0.75).toFixed(4),
    max:+quantile(distsSorted,1).toFixed(4)
  };
  /* Pitch/tilt step distributions across the pairs that survived every
     per-pair gate (rms/slope/pitch/tilt/tiltSlope/corr). The histogram
     reports what the current set of accepted pairs looks like along
     pitch/tilt so the user can pick a useful gate. */
  function quantHist(arr){
    if(!arr.length)return null;
    var s=arr.slice().sort(function(a,b){return a-b;});
    return{
      min:+quantile(s,0).toFixed(4),
      p25:+quantile(s,0.25).toFixed(4),
      p50:+quantile(s,0.50).toFixed(4),
      p75:+quantile(s,0.75).toFixed(4),
      p95:+quantile(s,0.95).toFixed(4),
      max:+quantile(s,1).toFixed(4)
    };
  }
  var pitchHist=pitchAtCandidates?quantHist(validPairs.map(function(p){return p.pitchStep;})):null;
  var tiltHist=tiltAtCandidates?quantHist(validPairs.map(function(p){return p.tiltStep;})):null;
  var tiltSlopeHist=tiltSlopeAtCandidates?quantHist(validPairs.map(function(p){return p.tiltSlopeStep;})):null;
  /* Sort selected by a for SCC analysis. */
  selected.sort(function(p,q){return p.a-q.a;});

  /* ── 5. Overlap-graph component split ─────────────────────────────────
     Two pairs overlap iff their [a, b] ranges intersect. Connected
     components in the overlap graph correspond to gaps in the UNION of
     ranges. After sorting by a, sweep and track the running max-b-so-far;
     a new component starts only when the next pair's a exceeds it. The
     naive "consecutive overlap" check (b_i ≥ a_{i+1}) is INSUFFICIENT —
     a short pair tucked inside an earlier longer pair can have a small b
     that's less than the next pair's a, but the earlier long pair still
     bridges them. The running-max sweep catches that. */
  var componentBreaks=[];
  if(selected.length>0){
    var runMaxB=selected[0].b;
    for(var ci=0;ci<selected.length-1;ci++){
      if(selected[ci].b>runMaxB)runMaxB=selected[ci].b;
      if(runMaxB<selected[ci+1].a)componentBreaks.push(ci);
    }
  }
  var components=[];
  if(selected.length>0){
    var start=0;
    for(var b=0;b<componentBreaks.length;b++){
      components.push(selected.slice(start,componentBreaks[b]+1));
      start=componentBreaks[b]+1;
    }
    components.push(selected.slice(start));
  }
  /* Coverage = end of union - start of union (single component is contiguous
     by construction since consecutive overlaps within). */
  function componentCoverage(comp){
    if(comp.length===0)return 0;
    var lo=comp[0].a,hi=comp[0].b;
    for(var i=1;i<comp.length;i++){
      if(comp[i].b>hi)hi=comp[i].b;
    }
    return hi-lo;
  }
  var keptComponent=null,keptComponentIdx=-1;
  for(var ci2=0;ci2<components.length;ci2++){
    if(!keptComponent||componentCoverage(components[ci2])>componentCoverage(keptComponent)){
      keptComponent=components[ci2];keptComponentIdx=ci2;
    }
  }
  if(_debug){
    for(var ci3=0;ci3<components.length;ci3++){
      _debug.components.push({
        coverage:+componentCoverage(components[ci3]).toFixed(4),
        pairs:components[ci3].map(function(p){return{a:+p.a.toFixed(4),b:+p.b.toFixed(4),dist:+p.dist.toFixed(4)};})
      });
    }
    _debug.keptComponentIdx=keptComponentIdx;
  }
  if(!keptComponent||keptComponent.length===0){
    return{segments:[],diag:{
      failReason:'no SCC component after selection',
      nCandidates:n,nValidPairs:validPairs.length,nSelected:selected.length,
      nRejectedByMinLength:nRejectedByMinLength,
      nRejectedBySeparation:nRejectedBySeparation,
      distHistogram:distHistogram,
      componentCount:components.length
    }};
  }
  /* ── 6. Prune non-bridges down to ≤maxSegments ─────────────────────────
     A segment i is a "bridge" iff b_{i-1} < a_{i+1} (its neighbors don't
     overlap each other; removing it splits the chain). Remove the most
     redundant non-bridge first (shortest by dist, then most-overlapped).
     If only bridges remain and we're still > maxSegments, keep them all. */
  /* Correct bridge test: pair idx is a bridge iff removing it disconnects the
     overlap graph. We remove idx and run the same running-max-b sweep used
     in the component split — if a gap appears, idx was the only thing
     bridging two regions. The old test only checked whether idx-1 and idx+1
     in sorted order overlap directly, which is wrong: a far-earlier pair
     with a large b can still bridge them through the overlap graph. */
  function isBridge(arr, idx){
    if(arr.length<=2)return false; /* with ≤2 pairs, no pair can be a bridge */
    var rem=[];
    for(var ri=0;ri<arr.length;ri++)if(ri!==idx)rem.push(arr[ri]);
    if(rem.length<2)return false;
    var rMaxB=rem[0].b;
    for(var ri2=0;ri2<rem.length-1;ri2++){
      if(rem[ri2].b>rMaxB)rMaxB=rem[ri2].b;
      if(rMaxB<rem[ri2+1].a)return true;
    }
    return false;
  }
  function overlapWithNeighbors(arr, idx){
    /* Sum of intersection length with left + right neighbor. Higher = more
       redundant (same audio is covered by other segments). */
    var ov=0;
    if(idx>0){
      var loL=Math.max(arr[idx-1].a,arr[idx].a),hiL=Math.min(arr[idx-1].b,arr[idx].b);
      if(hiL>loL)ov+=hiL-loL;
    }
    if(idx<arr.length-1){
      var loR=Math.max(arr[idx+1].a,arr[idx].a),hiR=Math.min(arr[idx+1].b,arr[idx].b);
      if(hiR>loR)ov+=hiR-loR;
    }
    return ov;
  }
  var work=keptComponent.slice();
  while(work.length>maxSegments){
    /* Find non-bridges. */
    var nonBridgeIdxs=[];
    for(var i=0;i<work.length;i++)if(!isBridge(work,i))nonBridgeIdxs.push(i);
    if(nonBridgeIdxs.length===0)break; /* only bridges remain — stop */
    /* Pick the most redundant: shortest dist, tiebreak max overlap. */
    var worst=nonBridgeIdxs[0],worstDist=work[worst].dist,worstOv=overlapWithNeighbors(work,worst);
    for(var k=1;k<nonBridgeIdxs.length;k++){
      var idx=nonBridgeIdxs[k];
      var dist=work[idx].dist;
      var ov=overlapWithNeighbors(work,idx);
      if(dist<worstDist||(dist===worstDist&&ov>worstOv)){
        worst=idx;worstDist=dist;worstOv=ov;
      }
    }
    if(_debug)_debug.nonBridgePrunings.push({a:+work[worst].a.toFixed(4),b:+work[worst].b.toFixed(4),dist:+work[worst].dist.toFixed(4)});
    work.splice(worst,1);
  }
  /* Final output. */
  var segments=work.map(function(p){return{a:p.a,b:p.b};});
  /* Bridge count for diag (after pruning). */
  var bridges=0;
  for(var i=0;i<work.length;i++)if(isBridge(work,i))bridges++;
  /* Connectivity sanity check after non-bridge prune — same running-max-b
     sweep as the component split. The old check only compared consecutive
     pairs in sorted order, which would erroneously fail on legitimate
     overlap-connected sets containing "nested" short pairs after a longer
     earlier pair. */
  var sccOk=true;
  if(work.length>1){
    var sccRunMaxB=work[0].b;
    for(var i=0;i<work.length-1;i++){
      if(work[i].b>sccRunMaxB)sccRunMaxB=work[i].b;
      if(sccRunMaxB<work[i+1].a){sccOk=false;break;}
    }
  }
  /* Per-selected-segment seam stats — what the user actually hears at each
     wrap point. Reports |Δpitch| (cents) and |Δtilt| (relative) at every
     (a, b) of the kept segments. Useful for spotting which specific seams
     are likely audible. */
  var selectedSeamStats=null;
  if(pitchAtCandidates||tiltAtCandidates||tiltSlopeAtCandidates){
    selectedSeamStats=segments.map(function(sg){
      /* Find pair in `work` by matching a/b. */
      var pair=null;
      for(var k=0;k<work.length;k++){if(work[k].a===sg.a&&work[k].b===sg.b){pair=work[k];break;}}
      return{
        a:sg.a,b:sg.b,
        pitchStep:pair?+pair.pitchStep.toFixed(2):null,
        tiltStep:pair?+pair.tiltStep.toFixed(4):null,
        tiltSlopeStep:pair?+pair.tiltSlopeStep.toFixed(5):null
      };
    });
  }
  /* "Ghost" endpoints — pairs that the greedy loop SELECTED (so their endpoints
     went into the `endpoints[]` array that drove the separation gate) but
     later got DISCARDED by SCC component pruning or by the non-bridge filter.
     These don't appear as green dots in the visualization but they DID
     contribute to the separation rejection of nearby candidates. Exposing
     them lets the user see why blue dots are clustered around regions of the
     steady span that no longer have a visible segment endpoint. */
  var finalEndpointKeys={};
  for(var fi=0;fi<work.length;fi++){
    finalEndpointKeys[+work[fi].a.toFixed(7)]=true;
    finalEndpointKeys[+work[fi].b.toFixed(7)]=true;
  }
  var ghostEndpointTimes={};
  for(var gi=0;gi<selected.length;gi++){
    var ga=+selected[gi].a.toFixed(7),gb=+selected[gi].b.toFixed(7);
    if(!finalEndpointKeys[ga])ghostEndpointTimes[ga]=true;
    if(!finalEndpointKeys[gb])ghostEndpointTimes[gb]=true;
  }
  var nGhostEndpoints=Object.keys(ghostEndpointTimes).length;
  return{
    segments:segments,
    diag:{
      nCandidates:n,
      nValidPairs:validPairs.length,
      rejectByRms:rejectByRms,rejectBySlope:rejectBySlope,
      rejectByCorr:rejectByCorr,
      rejectByPitch:rejectByPitch,rejectByTilt:rejectByTilt,
      rejectByTiltSlope:rejectByTiltSlope,
      nRejectedByMinLength:nRejectedByMinLength,
      nRejectedBySeparation:nRejectedBySeparation,
      separationRejectedTimes:separationRejectedTimes,
      ghostEndpointTimes:ghostEndpointTimes,
      nGhostEndpoints:nGhostEndpoints,
      _debug:_debug,
      distHistogram:distHistogram,
      pitchStepHistogram:pitchHist,
      tiltStepHistogram:tiltHist,
      tiltSlopeStepHistogram:tiltSlopeHist,
      selectedSeamStats:selectedSeamStats,
      nSelectedPrePrune:keptComponent.length,
      componentCount:components.length,
      sccOk:sccOk,
      bridgeCount:bridges,
      envWin:envWin,
      envMean:envMeanFn,
      minPairLengthSec:minPairLengthSec,
      minEndpointSepSec:minEndpointSepSec
    }
  };
}

/* ═══ applyConfigDefaults ═══
   Derives the prepareLoop opts object from a config's gateOpts, layering in
   the vibrato hint and trend-normalization defaults. Both the Node-side
   runner and the in-browser harness call this so they apply the same
   per-config defaults — without it, the browser would skip the vibrato
   hint entirely (corrWindowPeriods stays at the prepareLoop default 3
   instead of the vibrato-friendly 2), producing systematically tighter
   correlation gates than the headless run and landing many Iowa-string
   notes in "< 2 segments → fail" that the headless gets through.

   Precedence: cfg.gateOpts < cfg.vibrato defaults < trend defaults. The
   browser harness then layers user-form overrides on top via
   mergeGlobalThresholds, which spread-merges this output and then writes
   any non-empty form inputs over the result. */
function applyConfigDefaults(cfg, baseOpts){
  var opts={};
  if(baseOpts) for(var k in baseOpts) opts[k]=baseOpts[k];
  if(cfg && cfg.vibrato){
    if(opts.corrThreshold===undefined)opts.corrThreshold=0.90;
    if(opts.corrWindowPeriods===undefined)opts.corrWindowPeriods=2;
  }
  if(opts.trendNormalize===undefined)opts.trendNormalize=true;
  if(opts.trendWindowMs===undefined)opts.trendWindowMs=600;
  return opts;
}

/* ═══ trimSilence ═══
   Returns {trimStart, trimEnd} in original-buffer samples. Used to bound
   every downstream signal-analysis step plus, critically, to set the runtime
   playback start offset emitted into samples.ts — every ms of leading silence
   left in the trim becomes audible silence when a key is triggered.

   Implementation: windowed RMS test rather than first-sample-over-bar.
     • A single noise spike crossing an absolute amplitude bar is enough to
       commit trimStart in the latter, which leaves up to several hundred ms
       of pre-onset floor noise in samples whose actual onset is far later
       (Iowa MIS viola/C4 was the motivating case: a stray 0.00298-amplitude
       spike at 0.159 s committed the trim, but the real bow attack doesn't
       cross 0.005 RMS until 0.426 s).
     • A 20 ms RMS window integrates one-off spikes and lifts the bar above
       the Iowa MIS floor (≈ 0.003 peak / 0.0003 RMS) by enough margin to
       reject pre-onset noise without cutting into genuine soft onsets.
     • For fast-onset instruments (brass, oboe, bassoon, plucked) the new
       trim is typically 5-20 ms EARLIER than the old per-sample check —
       the old check missed the rising edge of the onset until the envelope
       crossed 0.003 absolute; the windowed RMS sees the rise.

   Tunable via opts (defaults tuned on Iowa MIS strings + winds + brass):
     trimWindowMs    — RMS window length in ms (default 20)
     trimRmsThresh   — RMS threshold (default 0.005)
     trimHopMs       — search hop in ms (default 5; window/4) */
function trimSilence(d, sr, opts){
  opts=opts||{};
  var winMs=opts.trimWindowMs!==undefined?opts.trimWindowMs:20;
  var thresh=opts.trimRmsThresh!==undefined?opts.trimRmsThresh:0.005;
  var hopMs=opts.trimHopMs!==undefined?opts.trimHopMs:Math.max(1,winMs/4);
  var win=Math.max(1,Math.round(sr*winMs/1000));
  var hop=Math.max(1,Math.round(sr*hopMs/1000));
  var len=d.length;
  var sqThresh=thresh*thresh*win;  /* compare sum-of-squares to threshold² * win to avoid per-window sqrt */
  /* Forward scan: first window whose RMS ≥ thresh. */
  var trimStart=0;
  for(var s=0;s+win<=len;s+=hop){
    var sum=0;
    for(var k=0;k<win;k++)sum+=d[s+k]*d[s+k];
    if(sum>=sqThresh){trimStart=s;break;}
  }
  /* Backward scan: last window whose RMS ≥ thresh. */
  var trimEnd=len;
  for(var s=len-win;s>=0;s-=hop){
    var sum=0;
    for(var k=0;k<win;k++)sum+=d[s+k]*d[s+k];
    if(sum>=sqThresh){trimEnd=s+win;break;}
  }
  return{trimStart:trimStart,trimEnd:trimEnd};
}

/* ═══ findSteadyRegion ═══
   Returns the steady-state span of a sustained sample as sampleStart/End in
   original-buffer samples plus secStart/secEnd for callers. Used by the
   segment-based loop selector as a hard inclusion constraint on +ZC
   candidates — anything outside the returned span is dropped before pair-
   validity work.

   Two-pass detector, run on a single smoothed RMS curve (default smoothing
   ≥ max(3·T_actual, 0.30s) so 5–7 Hz vibrato integrates out):

     Pass 1 — flatness (preferred). Median-anchored amplitude bar plus a
     relative-slope gate. The amplitude bar (default 0.7 × median) is
     robust against onset/decay distortion because the steady region
     dominates the curve by duration, so the median tracks steady RMS even
     when mean is pulled down. The slope gate (default ≤ 0.5 / sec) is
     computed on a second-pass-smoothed copy of the curve (extra 500 ms)
     to integrate out vibrato AM that survives the first pass; this
     directly measures "is the smoothed envelope flat here?" — the
     property we actually care about for both noisy onsets (string
     overshoot-and-settle) and smooth ones (clarinet slow rise).

     Pass 2 — amplitude-only fallback. The original mean-anchored algorithm:
     longest contiguous run with rms ≥ steadyRmsRatio · meanRMS (default
     0.5). Less precise but never collapses on vibrato-heavy bowed samples
     where the slope gate over-rejects.

   Fallback rule: if Pass 1 yields a duration < steadyFallbackRatio × the
   Pass 2 duration (default 0.5), use Pass 2. This handles Iowa
   violin/viola/double-bass where bow + vibrato AM is intrinsically too
   variable for slope-based steady detection; everything else (cello,
   clarinet, oboe, bassoon, flute, brass) benefits from the tighter
   flatness trim.

   Tunable via opts (all read off cfg.gateOpts in production):
     steadySmoothingSec       — first-pass smoothing window (s)
     steadyMedianRatio        — Pass 1 amplitude bar (0.7 = 70% of median)
     steadyMaxRelSlopePerSec  — Pass 1 slope bar (0.5 = 50%/sec)
     steadySlopeWindowSec     — Pass 1 forward/back slope-measurement half-window
     steadySlopeExtraSmoothMs — Pass 1 extra smoothing applied to slope basis
     steadyRmsRatio           — Pass 2 amplitude bar (0.5 = 50% of mean)
     steadyFallbackRatio      — Pass 1 → Pass 2 trip point (0.5) */

/* Pass 2 detector: longest run ≥ ratio·meanRMS. Existing semantics. */
function _findSteadyByAmplitudeBar(rmsCurve, ratio, firstCrossingIdx){
  var meanRms=0;
  for(var i=0;i<rmsCurve.length;i++)meanRms+=rmsCurve[i].rms;
  meanRms/=rmsCurve.length;
  if(meanRms<0.001)return{failReason:'sample silent/inaudible (meanRms='+meanRms.toExponential(2)+')',meanRms:meanRms};
  var rmsThresh=meanRms*ratio;
  var runStart=-1,bestStart=-1,bestEnd=-1,bestLen=0;
  /* Skip any index before the smoothed-RMS curve first crosses its own
     median. Prevents the mean-anchored bar (which is pulled down by the
     decay tail) from admitting the lower half of a gradual onset. */
  for(var i=0;i<rmsCurve.length;i++){
    if(i<firstCrossingIdx){runStart=-1;continue;}
    if(rmsCurve[i].rms>=rmsThresh){
      if(runStart<0)runStart=i;
      if(i-runStart>bestLen){bestLen=i-runStart;bestStart=runStart;bestEnd=i;}
    } else runStart=-1;
  }
  if(bestStart<0)return{failReason:'no steady region above '+(ratio*100).toFixed(0)+'% of meanRMS past first-median-crossing',meanRms:meanRms};
  return{start:bestStart,end:bestEnd,meanRms:meanRms,rmsThresh:rmsThresh};
}

/* Pass 1 detector: longest run where the smoothed RMS is both above a
   median-anchored bar AND its derivative is below a relative-slope bar.
   Median is computed once in the wrapper and passed in. */
function _findSteadyByFlatness(rmsCurve, hopSec, median, medianRatio, slopeBar, slopeWinSec, extraSmoothMs, firstCrossingIdx){
  if(median<0.001)return{failReason:'sample silent/inaudible (median='+median.toExponential(2)+')',median:median};
  var rmsBar=median*medianRatio;
  /* Slope basis: second smoothing pass over the already-smoothed curve so
     5-7 Hz vibrato AM (which the first pass partially admits) integrates
     out before differentiation. */
  var slopeBasis=rmsCurve.map(function(c){return c.rms;});
  if(extraSmoothMs>0){
    var smHalf=Math.max(1,Math.round(extraSmoothMs/(1000*hopSec*2)));
    var sm=new Array(slopeBasis.length);
    for(var i=0;i<slopeBasis.length;i++){
      var lo=Math.max(0,i-smHalf),hi=Math.min(slopeBasis.length,i+smHalf+1),sum=0;
      for(var j=lo;j<hi;j++)sum+=slopeBasis[j];
      sm[i]=sum/(hi-lo);
    }
    slopeBasis=sm;
  }
  var dk=Math.max(1,Math.round(slopeWinSec/hopSec));
  var slope=new Array(rmsCurve.length);
  for(var i=0;i<rmsCurve.length;i++){
    var lo=Math.max(0,i-dk),hi=Math.min(slopeBasis.length-1,i+dk);
    var dt=(hi-lo)*hopSec;
    slope[i]=dt>0?(slopeBasis[hi]-slopeBasis[lo])/dt/Math.max(slopeBasis[i],1e-6):0;
  }
  /* Longest run satisfying both gates AND past the first median crossing
     (the wrapper-computed boundary that keeps any detector from admitting
     pre-mean-crossing onset region). */
  var runStart=-1,bestStart=-1,bestEnd=-1,bestLen=0;
  for(var i=0;i<rmsCurve.length;i++){
    if(i<firstCrossingIdx){runStart=-1;continue;}
    if(rmsCurve[i].rms>=rmsBar && Math.abs(slope[i])<=slopeBar){
      if(runStart<0)runStart=i;
      if(i-runStart>bestLen){bestLen=i-runStart;bestStart=runStart;bestEnd=i;}
    } else runStart=-1;
  }
  if(bestStart<0)return{failReason:'no flat steady region under slope='+slopeBar.toFixed(2)+'/s + median bar='+rmsBar.toExponential(2)+' past first-median-crossing',median:median,rmsBar:rmsBar,slopeBar:slopeBar};
  return{start:bestStart,end:bestEnd,median:median,rmsBar:rmsBar,slopeBar:slopeBar};
}

function findSteadyRegion(d, sr, trimStart, trimEnd, opts){
  opts=opts||{};
  var rmsWin=Math.round(sr*0.05),rmsHop=Math.round(sr*0.01);
  if(trimEnd-trimStart<rmsWin*3) return{failReason:'post-trim region too short'};
  var rmsCurve=[];
  for(var s=trimStart;s+rmsWin<trimEnd;s+=rmsHop){
    var sum=0;for(var k=0;k<rmsWin;k++)sum+=d[s+k]*d[s+k];
    rmsCurve.push({pos:s+Math.floor(rmsWin/2),rms:Math.sqrt(sum/rmsWin)});
  }
  if(rmsCurve.length<3)return{failReason:'RMS curve too short'};
  /* First-pass smoothing — wide enough to integrate out 5-7 Hz vibrato. */
  var smoothMs;
  if(opts.steadySmoothingSec!==undefined){
    smoothMs=opts.steadySmoothingSec*1000;
  }else{
    var tActualMs=(opts.tActualSec||0)*1000;
    smoothMs=Math.max(3*tActualMs,300);
  }
  if(smoothMs>0){
    var smHalf=Math.max(1,Math.round(smoothMs/20));
    var smoothed=new Array(rmsCurve.length);
    for(var i=0;i<rmsCurve.length;i++){
      var lo=Math.max(0,i-smHalf),hi=Math.min(rmsCurve.length,i+smHalf+1),sum2=0;
      for(var j=lo;j<hi;j++)sum2+=rmsCurve[j].rms;
      smoothed[i]=sum2/(hi-lo);
    }
    for(var i=0;i<rmsCurve.length;i++)rmsCurve[i].rms=smoothed[i];
  }
  var hopSec=rmsHop/sr;
  var medianRatio=opts.steadyMedianRatio!==undefined?opts.steadyMedianRatio:0.7;
  var slopeBar=opts.steadyMaxRelSlopePerSec!==undefined?opts.steadyMaxRelSlopePerSec:0.5;
  var slopeWinSec=opts.steadySlopeWindowSec!==undefined?opts.steadySlopeWindowSec:0.05;
  var extraSmoothMs=opts.steadySlopeExtraSmoothMs!==undefined?opts.steadySlopeExtraSmoothMs:500;
  var fallbackRatio=opts.steadyFallbackRatio!==undefined?opts.steadyFallbackRatio:0.5;
  var ampRatio=opts.steadyRmsRatio!==undefined?opts.steadyRmsRatio:0.5;
  /* Median over the smoothed curve + first index at which the curve crosses
     it. This boundary is the hard floor on where steady can start — both
     detectors honor it. Median (not arithmetic mean) tracks the typical
     steady level since the steady region usually dominates the curve by
     duration; arithmetic mean is pulled down by the decay tail and would
     cross too early on samples like Iowa viola/C4. */
  var sortedRms=rmsCurve.map(function(c){return c.rms;}).slice().sort(function(a,b){return a-b;});
  var medianRms=sortedRms[Math.floor(sortedRms.length/2)];
  var firstCrossingIdx=0;
  while(firstCrossingIdx<rmsCurve.length && rmsCurve[firstCrossingIdx].rms<medianRms) firstCrossingIdx++;
  var flat=_findSteadyByFlatness(rmsCurve,hopSec,medianRms,medianRatio,slopeBar,slopeWinSec,extraSmoothMs,firstCrossingIdx);
  var amp =_findSteadyByAmplitudeBar(rmsCurve,ampRatio,firstCrossingIdx);
  /* Pick the flatness result unless it's too short relative to the
     amplitude-bar result (vibrato-heavy bowed string cases — see Iowa
     violin/viola where the AM defeats the slope gate). If amplitude-bar
     also failed, we have nothing to return. */
  var picked=null,method='none';
  if(!amp.failReason){
    if(!flat.failReason && (flat.end-flat.start)>=fallbackRatio*(amp.end-amp.start)){
      picked=flat;method='flat';
    }else{
      picked=amp;method='amp-fallback';
    }
  }else if(!flat.failReason){
    picked=flat;method='flat';
  }
  if(!picked){
    return{failReason:flat.failReason||amp.failReason,meanRms:amp.meanRms,median:flat.median};
  }
  var ss=rmsCurve[picked.start].pos,se=rmsCurve[picked.end].pos;
  /* firstCrossingSec — the wall-clock moment the smoothed RMS curve first
     reaches the median. steady.secStart will be >= this by construction. */
  var firstCrossingSec=firstCrossingIdx<rmsCurve.length?rmsCurve[firstCrossingIdx].pos/sr:null;
  return{
    steadyStart:ss,steadyEnd:se,
    secStart:ss/sr,secEnd:se/sr,
    method:method,
    meanRms:amp.meanRms||0,
    median:flat.median||0,
    firstCrossingSec:firstCrossingSec,
    /* rmsThresh kept for back-compat with diagnostic emit (line 1188). For
       the flatness path it reflects the median-anchored bar; for the
       amplitude fallback it reflects the meanRMS bar — same field, two
       semantics distinguished by `method`. */
    rmsThresh:method==='flat'?(flat.rmsBar||0):(amp.rmsThresh||0),
    slopeBar:flat.slopeBar||0,
    smoothMs:smoothMs,
    rmsCurve:rmsCurve,
    /* Both detectors' raw spans exposed for diagnostics. */
    flatSpan:flat.failReason?null:{start:flat.start,end:flat.end},
    ampSpan: amp.failReason ?null:{start:amp.start, end:amp.end}
  };
}
/* Back-compat alias — kept so the old export name still resolves if any
   external consumer ever surfaces. Currently nothing outside this file
   uses it. */
var findSteadyRegionMeanThreshold = findSteadyRegion;

/* ═══ computeTrendCurve — slow-amplitude trend for sustained samples ═══
   Estimates the slow-varying amplitude trend (bow-pressure / breath drift)
   so segment selection can run on a normalized signal. Strictly for the
   loop pipeline; never invoked on decay-instrument paths.

   Algorithm:
     1. Pick smoothing window: clamp(opts.trendWindowMs ?? 600,
        max(8·T_actual_ms, 500), min(2000, 0.4·steadyDurMs)).
        Floor guarantees ≥ ~4–5 vibrato cycles smoothed; ceiling keeps the
        curve from collapsing to flat on short steady regions.
     2. Build coarse RMS curve at 10ms hop over [trimStart, trimEnd] using
        cumulative-sum-of-squares (O(N)).
     3. Compute meanTrendOverSteady (mean curve value within steady span).
     4. Divide curve by it (mean ≈ 1 over steady).
     5. Apply floor 0.05 — caps 1/trend gain at 20×.
     6. Linearly interpolate to per-sample Float32Array; trend = 1 outside
        the trimmed region.
   Returns one of:
     { applied:true, dense, hopCurve:{values,hopSec,startSec},
       meanRmsOverSteady, effectiveWinMs, underconstrained, windowMs, floor }
     { applied:false, reason }                                            */
function computeTrendCurve(d, sr, trimStart, trimEnd, steady, opts){
  opts=opts||{};
  var steadyDurSec=steady.secEnd-steady.secStart;
  if(steadyDurSec<0.2) return{applied:false,reason:'steady region < 200ms'};
  var T_actual_sec=opts.tActualSec||0;
  var requestedWinMs=opts.trendWindowMs!==undefined?opts.trendWindowMs:600;
  var floorVal=opts.trendFloor!==undefined?opts.trendFloor:0.05;
  var minWinMs=Math.max(8*T_actual_sec*1000,500);
  var maxWinMs=Math.min(2000,0.4*steadyDurSec*1000);
  if(maxWinMs<minWinMs) maxWinMs=minWinMs;
  var effectiveWinMs=Math.min(Math.max(requestedWinMs,minWinMs),maxWinMs);
  var underconstrained=(effectiveWinMs<4*T_actual_sec*1000);
  var winSamp=Math.max(2,Math.round(effectiveWinMs*0.001*sr));
  var hopSamp=Math.max(1,Math.round(0.010*sr)); /* 10ms hop */
  var halfWin=winSamp>>1;
  var len=d.length;
  /* Cumulative sum-of-squares over the full buffer — O(N) once. */
  var cumSumSq=new Float64Array(len+1);
  for(var i=0;i<len;i++)cumSumSq[i+1]=cumSumSq[i]+d[i]*d[i];
  function rmsRange(lo,hi){
    if(lo<0)lo=0;if(hi>len)hi=len;
    if(hi<=lo)return 0;
    return Math.sqrt((cumSumSq[hi]-cumSumSq[lo])/(hi-lo));
  }
  /* Build the coarse curve over [trimStart, trimEnd]. */
  var curveStartSamp=trimStart;
  var curveVals=[];
  for(var s=trimStart;s<trimEnd;s+=hopSamp){
    curveVals.push(rmsRange(s-halfWin,s+halfWin));
  }
  if(curveVals.length<3) return{applied:false,reason:'trim region too short for trend curve'};
  /* Mean over the steady span (in coarse-curve index space). */
  var idxStart=Math.max(0,Math.round((steady.steadyStart-trimStart)/hopSamp));
  var idxEnd=Math.min(curveVals.length-1,Math.round((steady.steadyEnd-trimStart)/hopSamp));
  if(idxEnd<=idxStart) return{applied:false,reason:'steady span maps to empty curve range'};
  var sumS=0,cntS=0;
  for(var i=idxStart;i<=idxEnd;i++){sumS+=curveVals[i];cntS++;}
  var meanRmsOverSteady=cntS>0?sumS/cntS:0;
  if(meanRmsOverSteady<1e-4) return{applied:false,reason:'trend mean below floor'};
  /* Normalize to mean ≈ 1 over steady, then floor.
     OUTSIDE the steady span (onset and post-steady tail) we hold the curve
     at exactly 1 so the natural amplitude envelope passes through
     unmodified — the buffer-divide is gain=1 and nothing changes. Without
     this clamp, the windowed RMS underestimates true amplitude near the
     onset (its window straddles silent pre-onset samples), and dividing
     by it would amplify a precise onset above the steady RMS — audibly
     wrong for instruments like the clarinet whose onset rises cleanly to
     steady without overshooting. We only want to flatten slow drift
     *within* the loop area, not reshape the attack. The dense
     interpolation below produces a one-hop (≈10 ms) ramp between the
     held 1.0 and the first natural in-steady value, straddling the
     boundary — smooth enough to avoid clicks. */
  var normalized=new Array(curveVals.length);
  for(var i=0;i<curveVals.length;i++){
    if(i<idxStart||i>idxEnd){normalized[i]=1;continue;}
    var v=curveVals[i]/meanRmsOverSteady;
    if(v<floorVal)v=floorVal;
    normalized[i]=v;
  }
  /* Linearly interpolate to per-sample resolution. Trend = 1 outside trim. */
  var dense=new Float32Array(len);
  for(var i=0;i<len;i++)dense[i]=1;
  for(var s=trimStart;s<trimEnd;s++){
    var fIdx=(s-curveStartSamp)/hopSamp;
    var i0=Math.floor(fIdx);
    if(i0<0){dense[s]=normalized[0];continue;}
    if(i0>=normalized.length-1){dense[s]=normalized[normalized.length-1];continue;}
    var frac=fIdx-i0;
    dense[s]=normalized[i0]*(1-frac)+normalized[i0+1]*frac;
  }
  return{
    applied:true,
    dense:dense,
    hopCurve:{values:normalized,hopSec:hopSamp/sr,startSec:trimStart/sr},
    meanRmsOverSteady:meanRmsOverSteady,
    effectiveWinMs:effectiveWinMs,
    underconstrained:underconstrained,
    windowMs:effectiveWinMs,
    floor:floorVal
  };
}

/* ═══ buildVisualCurves — env/slope curves for the per-row canvas ═══
   Returns the `envCurve`, `envCurveSlow`, `slopeCurve` triple that
   renderGraphForEntry consumes, plus the envelope-mean used to normalize
   the slope finite-difference. One O(N) cumulative-sum-of-squares pass
   powers all three. */
function buildVisualCurves(d, sr, len, trimStart, trimEnd, T_actual_sec, envWinDiag, slopeStrideSec, envMeanHint){
  var diagHop=Math.max(1,Math.round(envWinDiag/4));
  var cumSumSq=new Float64Array(len+1);
  for(var i=0;i<len;i++)cumSumSq[i+1]=cumSumSq[i]+d[i]*d[i];
  function rmsRange(lo,hi){
    if(lo<0)lo=0;if(hi>len)hi=len;
    if(hi<=lo)return 0;
    return Math.sqrt((cumSumSq[hi]-cumSumSq[lo])/(hi-lo));
  }
  var envHalfDiag=envWinDiag>>1;
  function rmsDiag(p){return rmsRange(p-envHalfDiag,p+envHalfDiag);}
  var envValues=[];
  for(var s=trimStart;s<len;s+=diagHop)envValues.push(+rmsDiag(s).toFixed(6));
  /* Slow env: 1000ms window, 10ms hop — purely visualization */
  var slowWin=Math.round(1.0*sr);
  var slowHalf=slowWin>>1;
  var slowHop=Math.max(1,Math.round(0.010*sr));
  var slowValues=[];
  for(var s=trimStart;s<len;s+=slowHop)slowValues.push(+rmsRange(s-slowHalf,s+slowHalf).toFixed(6));
  /* Slope = (rms(p+h) - rms(p-h)) / (2 * envMean). envMeanHint lets the
     caller hand in the gate's exact envMean; fall back to curve mean. */
  var hSamp=Math.max(32,Math.round((slopeStrideSec||0.020)*sr));
  var envMeanCurve=envMeanHint;
  if(!envMeanCurve||envMeanCurve<1e-9){
    var sumM=0;for(var i=0;i<envValues.length;i++)sumM+=envValues[i];
    envMeanCurve=envValues.length>0?sumM/envValues.length:1e-9;
  }
  var slopeValues=[];
  for(var s=trimStart;s<len;s+=diagHop){
    var ep=rmsRange(s+hSamp-envHalfDiag,s+hSamp+envHalfDiag);
    var em=rmsRange(s-hSamp-envHalfDiag,s-hSamp+envHalfDiag);
    slopeValues.push(+((ep-em)/(2*envMeanCurve)).toFixed(5));
  }
  return{
    envCurve:{startSec:+(trimStart/sr).toFixed(4),hopSec:+(diagHop/sr).toFixed(5),values:envValues},
    envCurveSlow:{startSec:+(trimStart/sr).toFixed(4),hopSec:+(slowHop/sr).toFixed(5),winSec:1.0,values:slowValues},
    slopeCurve:{startSec:+(trimStart/sr).toFixed(4),hopSec:+(diagHop/sr).toFixed(5),values:slopeValues},
    envMean:envMeanCurve,
    envWinSec:+(envWinDiag/sr).toFixed(5),
    slopeHSec:+(hSamp/sr).toFixed(5),
    diagHopSamples:diagHop
  };
}
/* ═══ refineFundamentalPeriod ═══
   Refines the labeled fundamental period to T_actual via autocorrelation,
   searching the band [hintT·(1−range), hintT·(1+range)] for the peak of
   R(τ) = Σ d[s] · d[s+τ] over a 100ms window in the middle of the steady
   region. Sub-sample precision via parabolic interpolation around the
   integer-lag peak. Returns T_actual in seconds, or null if no strong peak
   (≥ minPeakRatio · zero-lag energy) is found in the band. */
function refineFundamentalPeriod(d, sr, hintFreq, steadyStart, steadyEnd, opts){
  opts=opts||{};
  var refineRange=opts.tRefineRange!==undefined?opts.tRefineRange:0.05;
  var minPeakRatio=opts.minPeakRatio!==undefined?opts.minPeakRatio:0.80;
  var hintT_samp=sr/hintFreq;
  var minLag=Math.max(1,Math.floor(hintT_samp*(1-refineRange)));
  var maxLag=Math.ceil(hintT_samp*(1+refineRange));
  /* 100ms autocorrelation window centered in steady region. Need extra maxLag
     samples past the window for the τ-shifted reads. */
  var targetWin=Math.round(sr*0.10);
  var available=steadyEnd-steadyStart-maxLag-1;
  if(available<hintT_samp*5)return null;
  var winLen=Math.min(targetWin,available);
  var windowMid=(steadyStart+steadyEnd)>>1;
  var winStart=windowMid-(winLen>>1);
  if(winStart<steadyStart)winStart=steadyStart;
  if(winStart+winLen+maxLag>steadyEnd)winStart=steadyEnd-winLen-maxLag;
  if(winStart<0)return null;
  /* Zero-lag energy = autocorrelation at τ=0, used as the normalization
     reference for the peak-strength check. */
  var r0=0;
  for(var s=0;s<winLen;s++){var v=d[winStart+s];r0+=v*v;}
  if(r0<1e-9)return null;
  var rArr=new Float64Array(maxLag-minLag+1);
  var bestLag=-1,bestR=-Infinity;
  for(var tau=minLag;tau<=maxLag;tau++){
    var sum=0;
    for(var s2=0;s2<winLen;s2++)sum+=d[winStart+s2]*d[winStart+s2+tau];
    rArr[tau-minLag]=sum;
    if(sum>bestR){bestR=sum;bestLag=tau;}
  }
  if(bestR<r0*minPeakRatio)return null;
  /* Parabolic interpolation around the integer-lag peak for sub-sample
     precision. */
  var idx=bestLag-minLag;
  var lagFrac=bestLag;
  if(idx>0&&idx<rArr.length-1){
    var ym1=rArr[idx-1],y0=rArr[idx],y1=rArr[idx+1];
    var denom=ym1-2*y0+y1;
    if(Math.abs(denom)>1e-9)lagFrac=bestLag+0.5*(ym1-y1)/denom;
  }
  return lagFrac/sr;
}

/* ═══ correlateWaveforms ═══
   Pearson correlation between two equal-length windows of the buffer.
   Phase-sensitive (unlike magnitude-spectrum comparison): two windows at
   different fundamental phases produce different shapes and correlate low
   even when their RMS / spectral envelopes match. p1, p2 are integer sample
   indices; returns a value in [-1, 1] or 0 on out-of-range / degenerate. */
function correlateWaveforms(d, p1, p2, lenSamples){
  if(p1<0||p2<0||p1+lenSamples>d.length||p2+lenSamples>d.length)return 0;
  var n=lenSamples;
  var s1=0,s2=0,s1s=0,s2s=0,sp=0;
  for(var i=0;i<n;i++){
    var v1=d[p1+i],v2=d[p2+i];
    s1+=v1;s2+=v2;
    s1s+=v1*v1;s2s+=v2*v2;
    sp+=v1*v2;
  }
  var m1=s1/n,m2=s2/n;
  var num=sp-n*m1*m2;
  var d1=s1s-n*m1*m1,d2=s2s-n*m2*m2;
  if(d1<1e-12||d2<1e-12)return 0;
  return num/Math.sqrt(d1*d2);
}

/* ═══ computePitchCurve — instantaneous pitch via per-cycle +ZC spacing ═══
   String vibrato IS pitch modulation: the player rolls the finger so the
   string length changes cycle by cycle, modulating f0 at ~5-7 Hz with depths
   of ±10-25¢. Tracking this needs sub-cycle temporal resolution.

   An autocorrelation window long enough for clean lag-peak parabolic interp
   (e.g. 200 ms = full 5 Hz vibrato cycle) integrates the FM signal back to
   its MEAN period — the peak position settles at ⟨T⟩ no matter where the
   window centers within the modulation cycle. That's wrong for our purpose:
   we'd see a flat pitch curve while amp / tilt show the same vibrato
   exactly because amplitude metrics integrate differently (the body-coupled
   AM/FM modulation survives a long average; pitch FM doesn't).

   Per-cycle period from consecutive +ZCs gives the right thing for free.
   Each fundamental period produces one +ZC near phase 0; the spacing
   between consecutive +ZCs IS the instantaneous period at that cycle.
   At 440 Hz that's 440 pitch readings per second — vastly oversampled for
   any musical vibrato rate.

   We then median-smooth at hop resolution to reject jitter (one bad +ZC
   doesn't ruin the curve) and resample onto a regular hop grid for easy
   visualization + per-candidate sampling.

   Input zcTimes is an array of fractional-sample +ZC times in seconds.
   pairs whose spacing falls outside ±25 % of T_actual are dropped (attack
   transients, sub-period harmonic crossings, missed +ZCs). The resulting
   curve has NaN gaps in regions where no clean cycles were available. */
function computePitchCurve(zcTimes, T_actual_sec, sr, trimStart, trimEnd, opts){
  opts=opts||{};
  var hopSec=opts.pitchHopSec!==undefined?opts.pitchHopSec:0.020;
  /* Smoothing window: floor 30ms (≥13 cycles for typical violin range),
     scales to 6·T at low frequencies so we always have enough cycles in the
     window for the median to reject one-off bad pairs. At 65Hz that's 92ms;
     6 Hz vibrato (167ms cycle) is attenuated by ~17% — acceptable. */
  var smoothSec=opts.pitchSmoothSec!==undefined?opts.pitchSmoothSec:Math.max(0.030,6*T_actual_sec);
  /* Period tolerance: pair spacing must fall in [T·(1−tol), T·(1+tol)].
     0.08 caps individual cycle cents at ≈+100¢ / −89¢. Real musical vibrato
     peaks at ±50¢ even in extreme cases, so this leaves >2× margin while
     refusing the wild excursions a default of ±25% would admit. */
  var spreadTol=opts.pitchSpreadTol!==undefined?opts.pitchSpreadTol:0.08;
  var hopSamp=Math.max(1,Math.round(hopSec*sr));
  var halfWin=smoothSec/2;
  /* Per-cycle pitch via "nearest +ZC ≈ one period later" pairing.
     We don't pair every consecutive +ZC — instruments with a strong 2nd
     harmonic can produce a sub-period crossing in some vibrato phases,
     and rejecting those consecutive pairs at the threshold would carve
     half the vibrato cycle into NaN gaps. Instead, for each anchor +ZC
     we scan forward and pick whichever later +ZC has spacing closest
     to T_actual (within ±spreadTol). That selects the fundamental cycle
     while skipping past any harmonic crossings between them. */
  var minSec=T_actual_sec*(1-spreadTol);
  var maxSec=T_actual_sec*(1+spreadTol);
  var times=[],pitches=[];
  for(var i=0;i<zcTimes.length-1;i++){
    var anchor=zcTimes[i];
    var bestDt=null,bestErr=Infinity;
    for(var j=i+1;j<zcTimes.length;j++){
      var dt=zcTimes[j]-anchor;
      if(dt>maxSec)break;
      if(dt<minSec)continue;
      var err=Math.abs(dt-T_actual_sec);
      if(err<bestErr){bestErr=err;bestDt=dt;}
    }
    if(bestDt==null)continue;
    times.push(anchor+bestDt/2);
    pitches.push(1200*Math.log2(T_actual_sec/bestDt));
  }
  var values=[];
  var startSec=trimStart/sr;
  if(times.length<2){
    return{startSec:+startSec.toFixed(5),hopSec:+(hopSamp/sr).toFixed(5),winSec:+smoothSec.toFixed(5),values:values};
  }
  /* Sliding median over a ±halfWin window. times[] is monotone, so we can
     advance lo / hi indices linearly across the hop loop instead of doing a
     binary search each time. */
  var lo=0,hi=0;
  for(var s=trimStart;s<trimEnd;s+=hopSamp){
    var t=s/sr;
    while(lo<times.length&&times[lo]<t-halfWin)lo++;
    while(hi<times.length&&times[hi]<=t+halfWin)hi++;
    if(hi<=lo){values.push(NaN);continue;}
    /* Median; small slices (typically ≤ a few hundred entries per hop). */
    var slice=pitches.slice(lo,hi);
    slice.sort(function(a,b){return a-b;});
    var med=slice.length%2===1?slice[slice.length>>1]:(slice[(slice.length>>1)-1]+slice[slice.length>>1])/2;
    values.push(+med.toFixed(3));
  }
  return{startSec:+startSec.toFixed(5),hopSec:+(hopSamp/sr).toFixed(5),winSec:+smoothSec.toFixed(5),values:values};
}

/* ═══ computeTiltCurve — spectral brightness proxy ═══
   tilt(t) = RMS( d[n] - d[n-1] | t ) / RMS( d[n] | t )
   Differenced-signal RMS is a first-order high-pass-emphasis measure; the
   ratio is dimensionless, bounded, and (to first order) invariant under
   slow amplitude scaling — so trend normalization doesn't change it. For
   a pure sine at frequency f, tilt ≈ 2·sin(π f / sr). For broadband or
   harmonic-rich signals it scales with the centroid of the spectrum, so
   it's a cheap brightness proxy.
   Cumulative-sum-of-squares of d and Δd gives O(N + numHops). */
function computeTiltCurve(d, sr, trimStart, trimEnd, opts){
  opts=opts||{};
  var winSec=opts.tiltWinSec!==undefined?opts.tiltWinSec:0.10;
  var hopSec=opts.tiltHopSec!==undefined?opts.tiltHopSec:0.020;
  var winSamp=Math.max(32,Math.round(winSec*sr));
  var hopSamp=Math.max(1,Math.round(hopSec*sr));
  var halfWin=winSamp>>1;
  var len=d.length;
  var cumSq=new Float64Array(len+1);
  var cumDiffSq=new Float64Array(len+1);
  for(var i=0;i<len;i++){
    cumSq[i+1]=cumSq[i]+d[i]*d[i];
    var diff=(i>0)?(d[i]-d[i-1]):0;
    cumDiffSq[i+1]=cumDiffSq[i]+diff*diff;
  }
  function rmsRange(cum,lo,hi){
    if(lo<0)lo=0;if(hi>len)hi=len;
    if(hi<=lo)return 0;
    return Math.sqrt((cum[hi]-cum[lo])/(hi-lo));
  }
  var values=[];
  for(var s=trimStart;s<trimEnd;s+=hopSamp){
    var rLow=rmsRange(cumSq,s-halfWin,s+halfWin);
    var rHigh=rmsRange(cumDiffSq,s-halfWin,s+halfWin);
    values.push(+(rLow>1e-9?rHigh/rLow:0).toFixed(5));
  }
  return{startSec:+(trimStart/sr).toFixed(5),hopSec:+(hopSamp/sr).toFixed(5),winSec:+(winSamp/sr).toFixed(5),values:values};
}

/* ═══ computeTiltSlopeCurve — derivative of the smoothed tilt trend ═══
   Finite-difference derivative of an existing tilt curve (intended to be the
   slow trend, not the fine curve). Normalized by the trend mean over the
   curve's own valid range, so the result is dimensionless (1/sec) and
   comparable across instruments — same treatment RMS-slope gets via envMean.

   stride: hop count on each side of the centered finite difference. The
     effective window width is (2 * stride) hops; with hopSec ≈ 20ms and a
     default 0.30s stride that's ≈600ms — wide enough to ride over residual
     vibrato wobble in the trend curve.

   The output values are signed: positive = brightness rising, negative =
   falling. Both signs are informative; the gate uses |Δ slope| (absolute,
   not ratio) so a rising-to-falling pair scores higher than two same-sign
   slopes of equal magnitude. */
function computeTiltSlopeCurve(tiltCurve, opts){
  opts=opts||{};
  if(!tiltCurve||!tiltCurve.values||tiltCurve.values.length<3){
    return{startSec:tiltCurve?tiltCurve.startSec:0,hopSec:tiltCurve?tiltCurve.hopSec:0.020,winSec:0,values:[]};
  }
  var v=tiltCurve.values;
  var hopSec=tiltCurve.hopSec;
  var strideSec=opts.tiltSlopeStrideSec!==undefined?opts.tiltSlopeStrideSec:0.30;
  var h=Math.max(1,Math.round(strideSec/hopSec));
  /* Mean over non-NaN values — defensive against NaN gaps from the underlying
     tilt computation (rare but possible if RMS hits zero). */
  var meanSum=0,meanCount=0;
  for(var i=0;i<v.length;i++){
    var vi=v[i];
    if(typeof vi==='number'&&!isNaN(vi)){meanSum+=vi;meanCount++;}
  }
  var mean=meanCount>0?meanSum/meanCount:0;
  var out=new Array(v.length);
  var denom=(2*h*hopSec*mean);
  for(var i=0;i<v.length;i++){
    var iPlus=i+h,iMinus=i-h;
    if(iPlus>=v.length||iMinus<0||mean<1e-9){out[i]=NaN;continue;}
    var vp=v[iPlus],vm=v[iMinus];
    if(typeof vp!=='number'||isNaN(vp)||typeof vm!=='number'||isNaN(vm)){out[i]=NaN;continue;}
    out[i]=+((vp-vm)/denom).toFixed(5);
  }
  return{
    startSec:tiltCurve.startSec,
    hopSec:hopSec,
    winSec:+(2*h*hopSec).toFixed(5),
    values:out
  };
}

/* Linear-interpolated sample of a {startSec, hopSec, values} curve at time
   t. Returns null outside the curve range, or when both neighbors are NaN;
   if one neighbor is NaN, returns the other. Used to fold pitch/tilt onto
   per-candidate diagnostics. */
function sampleCurve(curve, t){
  if(!curve||!curve.values||!curve.values.length)return null;
  var idx=(t-curve.startSec)/curve.hopSec;
  if(idx<0||idx>curve.values.length-1)return null;
  var i0=Math.floor(idx);
  if(i0>=curve.values.length-1){
    var lv=curve.values[curve.values.length-1];
    return(typeof lv==='number'&&!isNaN(lv))?lv:null;
  }
  var frac=idx-i0;
  var v0=curve.values[i0],v1=curve.values[i0+1];
  var v0ok=(typeof v0==='number')&&!isNaN(v0);
  var v1ok=(typeof v1==='number')&&!isNaN(v1);
  if(!v0ok&&!v1ok)return null;
  if(!v0ok)return v1;
  if(!v1ok)return v0;
  return v0*(1-frac)+v1*frac;
}

/* ═══ prepareLoop — segment-based loop-point detection ═══
   The runtime's looping state machine plays (a, b) segments and loops back
   from b to a at every wrap, picking a random new segment after each wrap.
   This function produces the segment list. The pipeline:

     1. Trim silence + refine fundamental T_actual via autocorrelation.
     2. Enumerate +ZC candidates (dedup at T_actual/4).
     3. Find the largest contiguous steady region where smoothed RMS stays
        ≥ steadyRmsRatio × meanRMS (default 0.5×). Hard inclusion: candidates
        outside this region are excluded before pair-validity work.
     4. Run selectSegments (per-pair gates → distance-descending greedy with
        100ms endpoint separation → keep largest overlap-chain SCC → prune
        non-bridges to ≤ maxLoopPts).
     5. Build a viewable diag on every return path so the analyzer canvas
        renders even when fewer than 2 segments survive.

   Critical for runtime: the segments form one strongly-connected component
   when sorted by `a` — every consecutive pair satisfies b_i ≥ a_{i+1} —
   so the picker can perpetually wander among them. validateSegments
   double-checks this; sccOk in the returned stats signals it.

   Earlier versions had a clique + validStartsByEnd path that this replaces;
   the only path that remains here is steady-region + selectSegments. */
function prepareLoop(buf, freq, opts){
  opts=opts||{};
  var maxLoopPts=opts.maxLoopPts||8;
  var tRefineRange=opts.tRefineRange!==undefined?opts.tRefineRange:0.05;
  /* Mono downmix safety net — applies when a multichannel buffer reaches
     prepareLoop directly (e.g. a user-uploaded stereo file via the
     analyzer's "Analyze custom file" path, or any future caller that
     hasn't already downmixed). For the primary Iowa-MIS pipeline the Vite
     middleware now does `ffmpeg -ac 1` so the WAV arrives mono and this
     block is a no-op. Coefficient √(1/N) per channel matches ffmpeg's
     energy-preserving downmix (`-ac 1` uses sqrt(0.5) per channel for
     stereo) so analyses are signal-identical regardless of which path
     produced the mono. Single-channel buffers skip this entirely. */
  if(buf.numberOfChannels && buf.numberOfChannels>1){
    var nCh=buf.numberOfChannels;
    var coef=Math.sqrt(1/nCh);
    var dMono=new Float32Array(buf.length);
    for(var ch=0;ch<nCh;ch++){
      var cd=buf.getChannelData(ch);
      for(var s=0;s<buf.length;s++)dMono[s]+=cd[s]*coef;
    }
    buf={sampleRate:buf.sampleRate,length:buf.length,numberOfChannels:1,
         getChannelData:function(){return dMono;}};
  }
  var sr=buf.sampleRate,len=buf.length,d=buf.getChannelData(0);
  var period=sr/freq;  /* labeled period in samples — used only for the ZC
                          pre-check spacing and the autocorr search band. */
  /* ── FAST FAIL: silent sample. Cheap pre-check before the heavy work. ── */
  var peakAbs=0;
  for(var s=0;s<len;s++){
    var a=d[s];if(a<0)a=-a;
    if(a>peakAbs)peakAbs=a;
    if(peakAbs>=0.01)break;
  }
  if(peakAbs<0.001){
    return{trimStart:0,loopPts:null,failReason:'sample silent (peak='+peakAbs.toExponential(2)+')'};
  }
  /* 1. Trim silence at both ends. */
  var trim=trimSilence(d,sr);
  var trimStart=trim.trimStart,trimEnd=trim.trimEnd;
  if(trimEnd-trimStart<sr*0.3){
    return{trimStart:trimStart/sr,loopPts:null,
      stats:{failReason:'audio-active region too short: '+((trimEnd-trimStart)/sr).toFixed(2)+'s'}};
  }
  /* 2. Refine fundamental period via autocorrelation. Centered on the middle
     of the post-trim region — for normal musical samples that's mid-sustain,
     well clear of attack/decay transients. No explicit steady-region detection
     needed: the downstream pair gates (RMS step, slope step, phase coherence)
     reject attack/decay candidates structurally — they don't pair with sustain
     candidates because RMS, slope, and waveform shape all differ. */
  var T_actual_sec=refineFundamentalPeriod(d,sr,freq,trimStart,trimEnd,{tRefineRange:tRefineRange});
  if(T_actual_sec===null){
    return{trimStart:trimStart/sr,loopPts:null,
      stats:{failReason:'no fundamental at labeled freq ±'+(tRefineRange*100).toFixed(0)+'%'}};
  }
  var T_actual=T_actual_sec*sr; /* fractional samples */

  /* 3. Collect ALL +ZCs in the post-trim region (sub-sample fractional, dedup
     at T_actual/4 to drop near-duplicate noise crossings). selectSegments
     applies the pair-validity gates downstream. */
  var zcDedupSpacing=Math.max(1,Math.round(T_actual/4));
  var allZCs=[];
  var prevZCsamp=-zcDedupSpacing-1;
  for(var s=trimStart+1;s<trimEnd;s++){
    if(d[s]>0&&d[s-1]<=0&&(s-prevZCsamp)>=zcDedupSpacing){
      var fr=(d[s]===d[s-1])?0:-d[s-1]/(d[s]-d[s-1]);
      allZCs.push(s-1+fr);
      prevZCsamp=s;
    }
  }
  if(allZCs.length<2){
    return{trimStart:trimStart/sr,loopPts:null,stats:{failReason:'too few +ZCs in post-trim region: '+allZCs.length}};
  }
  /* Integer-snap and dedup at integer-sample resolution. The result is the
     final candidate set that flows into selectSegments. */
  var dedup=[];
  var seenKey={};
  for(var i=0;i<allZCs.length;i++){
    var samp=Math.floor(allZCs[i])+1;
    if(samp>=len)samp=len-1;
    if(seenKey[samp])continue;
    seenKey[samp]=1;
    dedup.push(samp/sr);
  }
  if(dedup.length<2){
    return{trimStart:trimStart/sr,loopPts:null,stats:{failReason:'collapsed after integer-snap'}};
  }

  /* ── 4. Build visualization curves NOW so every subsequent return —
         success OR failure — carries the env / slope panels. The fast env
         window is 4·T_actual; the slow overlay is fixed at 1000ms; the
         slope finite-difference uses slopeStrideSec (default 30ms). */
  var slopeStrideSec=opts.slopeStrideSec!==undefined?opts.slopeStrideSec:0.030;
  var envWinDiag=Math.max(32,Math.round(4*T_actual_sec*sr));
  var curves=buildVisualCurves(d,sr,len,trimStart,trimEnd,T_actual_sec,envWinDiag,slopeStrideSec,null);
  /* Pitch & tilt curves — both amplitude-trend invariant (pitch is purely
     temporal; tilt is a RMS ratio that scales out under any slow gain
     envelope), so they're computed once on the raw buffer. Pitch reads
     the fractional-sample +ZCs directly: each consecutive pair within
     ±25 % of T_actual is one cycle, and the spacing IS the instantaneous
     period. */
  var zcTimesSec=allZCs.map(function(z){return z/sr;});
  var pitchCurve=computePitchCurve(zcTimesSec,T_actual_sec,sr,trimStart,trimEnd,{
    pitchHopSec:opts.pitchHopSec,
    pitchSmoothSec:opts.pitchSmoothSec,
    pitchSpreadTol:opts.pitchSpreadTol
  });
  /* Two tilt curves at different timescales:
       tiltCurve       fine 100ms window — shows the cycle-to-cycle brightness
                       modulation coupled to vibrato. Visualization context.
       tiltTrendCurve  slow 1200ms window (default) — averages out ≥6 vibrato
                       cycles so only the slow brightness drift across the
                       steady region remains. THIS is what the gate and
                       seam-step stats compare, because slow drift is what
                       makes a seam audibly shift; the vibrato wobble is the
                       same at every cycle phase and isn't the audible
                       offender. The wider default (was 600ms) better resists
                       vibrato pull-around on strings. */
  var tiltCurve=computeTiltCurve(d,sr,trimStart,trimEnd,{
    tiltWinSec:opts.tiltWinSec,
    tiltHopSec:opts.tiltHopSec
  });
  var tiltTrendCurve=computeTiltCurve(d,sr,trimStart,trimEnd,{
    tiltWinSec:opts.tiltTrendWinSec!==undefined?opts.tiltTrendWinSec:1.20,
    tiltHopSec:opts.tiltHopSec
  });
  /* Tilt-slope curve = finite-difference derivative of the trend. The gate
     compares |slope_a - slope_b| between pair candidates: two points with
     matching tilt but differing slope (rising vs falling brightness) still
     produce an audible seam, and pairing them is what we want to reject. */
  var tiltSlopeCurve=computeTiltSlopeCurve(tiltTrendCurve,{
    tiltSlopeStrideSec:opts.tiltSlopeStrideSec
  });
  /* Gate-side references. Reassigned after trend computation if normalization
     is applied — `selectSegments`, `buildCandidates`, and the per-candidate
     slope computation all flow through these. */
  var bufGate=buf, dGate=d, curvesGate=curves;
  var envHalfDiag=envWinDiag>>1;
  function rmsAtDiag(p){
    var lo=p-envHalfDiag;if(lo<0)lo=0;
    var hi=p+envHalfDiag;if(hi>len)hi=len;
    if(hi<=lo)return 0;
    var sum=0;
    for(var s=lo;s<hi;s++)sum+=dGate[s]*dGate[s];
    return Math.sqrt(sum/(hi-lo+1e-9));
  }
  var hSamp=Math.max(32,Math.round(slopeStrideSec*sr));
  /* Per-candidate diag flags:
       inSteady              candidate lies inside [secStart, secEnd]
       inSegment             matches an endpoint of a selected segment
       inSeparationRejected  matches an endpoint of a pair that passed the
                             min-length filter but failed the separation rule
                             (visually: "almost picked, but bumped").
     All default false when no steady region / no segments are available
     (e.g. early-return failures). */
  function buildCandidates(segments, steady, sepRejTimes, ghostTimes){
    var segEndpointSamps={};
    if(segments){
      for(var i=0;i<segments.length;i++){
        segEndpointSamps[Math.round(segments[i].a*sr)]=true;
        segEndpointSamps[Math.round(segments[i].b*sr)]=true;
      }
    }
    var out=[];
    for(var i=0;i<dedup.length;i++){
      var samp=Math.round(dedup[i]*sr);
      var t=+dedup[i].toFixed(7);
      var inSteady=steady?(dedup[i]>=steady.secStart&&dedup[i]<=steady.secEnd):false;
      var inSeg=!!segEndpointSamps[samp];
      var inSepRej=!!(sepRejTimes&&sepRejTimes[t]);
      /* Ghost endpoint: this candidate was picked as a segment endpoint during
         the greedy loop (so it gated separation rejections nearby) but its
         pair was later pruned by SCC or non-bridge filters. Visualizing these
         is what explains blue clusters far from visible green dots. */
      var inGhost=!!(ghostTimes&&ghostTimes[t]);
      var env=rmsAtDiag(samp);
      var slope=null;
      if(curvesGate.envMean>1e-9){
        var ep=rmsAtDiag(samp+hSamp),em=rmsAtDiag(samp-hSamp);
        slope=(ep-em)/(2*curvesGate.envMean);
      }
      var pitch=sampleCurve(pitchCurve,dedup[i]);
      /* Candidate `.tilt` reads the TREND curve (slow drift), not the fine
         curve — that's the value the gate and seam-step diagnostics compare,
         and it's what the user's ear actually hears as a brightness step at
         the wrap. The fine curve stays available in diag.tiltCurve for the
         visualization overlay. */
      var tilt=sampleCurve(tiltTrendCurve,dedup[i]);
      var tiltSlope=sampleCurve(tiltSlopeCurve,dedup[i]);
      out.push({
        posSec:t,
        env:+env.toFixed(6),
        slope:slope!=null?+slope.toFixed(5):null,
        pitch:pitch!=null?+pitch.toFixed(2):null,
        tilt:tilt!=null?+tilt.toFixed(4):null,
        tiltSlope:tiltSlope!=null?+tiltSlope.toFixed(5):null,
        inSteady:inSteady,
        inSegment:inSeg,
        inSeparationRejected:inSepRej,
        inGhostEndpoint:inGhost
      });
    }
    return out;
  }
  function baseDiag(){
    return{
      pipeline:'segments',
      trimStartSec:+(trimStart/sr).toFixed(4),
      trimEndSec:+(trimEnd/sr).toFixed(4),
      tActualSec:+T_actual_sec.toFixed(6),
      envWinSec:curves.envWinSec,
      slopeHSec:curves.slopeHSec,
      slopeStrideSec:slopeStrideSec,
      rmsStepThreshold:opts.rmsStepThreshold!==undefined?opts.rmsStepThreshold:0.01,
      slopeStepThreshold:opts.slopeStepThreshold!==undefined?opts.slopeStepThreshold:0.01,
      pitchStepThresholdCents:opts.pitchStepThresholdCents!==undefined?opts.pitchStepThresholdCents:5,
      tiltStepThreshold:opts.tiltStepThreshold!==undefined?opts.tiltStepThreshold:0.05,
      tiltSlopeStepThreshold:opts.tiltSlopeStepThreshold!==undefined?opts.tiltSlopeStepThreshold:0.05,
      tiltSlopeStrideSec:opts.tiltSlopeStrideSec!==undefined?opts.tiltSlopeStrideSec:0.30,
      tiltTrendWinSec:opts.tiltTrendWinSec!==undefined?opts.tiltTrendWinSec:1.20,
      envCurve:curves.envCurve,
      envCurveSlow:curves.envCurveSlow,
      slopeCurve:curves.slopeCurve,
      pitchCurve:pitchCurve,
      tiltCurve:tiltCurve,
      tiltTrendCurve:tiltTrendCurve,
      tiltSlopeCurve:tiltSlopeCurve
    };
  }
  function addSteadyToDiag(diag, steady){
    diag.steadyStartSec=+steady.secStart.toFixed(4);
    diag.steadyEndSec=+steady.secEnd.toFixed(4);
    diag.meanRms=+steady.meanRms.toFixed(6);
    diag.rmsThresh=+steady.rmsThresh.toFixed(6);
    diag.steadyDiag=steady;
    return diag;
  }
  /* ── 5. Detect steady region. */
  var steady=findSteadyRegion(d,sr,trimStart,trimEnd,{
    tActualSec:T_actual_sec,
    steadyRmsRatio:opts.steadyRmsRatio,
    steadySmoothingSec:opts.steadySmoothingSec,
    steadyMedianRatio:opts.steadyMedianRatio,
    steadyMaxRelSlopePerSec:opts.steadyMaxRelSlopePerSec,
    steadySlopeWindowSec:opts.steadySlopeWindowSec,
    steadySlopeExtraSmoothMs:opts.steadySlopeExtraSmoothMs,
    steadyFallbackRatio:opts.steadyFallbackRatio
  });
  if(steady.failReason){
    var dFail=baseDiag();
    dFail.candidates=buildCandidates(null,null);
    dFail.steadyDiag=steady;
    return{trimStart:trimStart/sr,loopPts:null,segments:[],
      stats:{mode:'segments',
        failReason:'steady region: '+steady.failReason,
        nCandidates:dedup.length,
        trimStartSec:+(trimStart/sr).toFixed(3),trimEndSec:+(trimEnd/sr).toFixed(3),
        tActual:+(T_actual_sec*1000).toFixed(3),tLabeled:+(period/sr*1000).toFixed(3),
        tDriftCents:+((1200*Math.log2(T_actual_sec/(period/sr))).toFixed(1))},
      diag:dFail};
  }
  /* ── 5b. Trend normalization (sustained loop instruments only).
       Estimate the slow amplitude drift and divide it out before pair-gate
       matching. selectSegments is unchanged — we just hand it a flatter
       buffer. Raw `d` is retained for +ZC enumeration, pitch refinement,
       and steady-region detection; trend is positive everywhere so +ZC
       locations are identical. */
  var trendRes={applied:false,reason:'disabled by opts'};
  var dNorm=null,bufNorm=null,curvesNorm=null;
  var trendEnabled=opts.trendNormalize!==false;
  if(trendEnabled){
    trendRes=computeTrendCurve(d,sr,trimStart,trimEnd,steady,{
      tActualSec:T_actual_sec,
      trendWindowMs:opts.trendWindowMs,
      trendFloor:opts.trendFloor
    });
    if(trendRes.applied){
      dNorm=new Float32Array(len);
      var td=trendRes.dense;
      for(var ti=0;ti<len;ti++)dNorm[ti]=d[ti]/td[ti];
      bufNorm={sampleRate:sr,length:len,getChannelData:function(){return dNorm;}};
      curvesNorm=buildVisualCurves(dNorm,sr,len,trimStart,trimEnd,T_actual_sec,envWinDiag,slopeStrideSec,null);
      /* Swap gate references onto the normalized signal so selectSegments,
         buildCandidates, and the slope diagnostic all see the flatter curve. */
      bufGate=bufNorm; dGate=dNorm; curvesGate=curvesNorm;
    }
  }
  /* ── 6. Restrict +ZCs to inside the steady region. */
  var inSteadyCands=[];
  for(var ci=0;ci<dedup.length;ci++){
    if(dedup[ci]>=steady.secStart&&dedup[ci]<=steady.secEnd)inSteadyCands.push(dedup[ci]);
  }
  if(inSteadyCands.length<2){
    var dFew=addSteadyToDiag(baseDiag(),steady);
    dFew.candidates=buildCandidates(null,steady);
    if(trendRes.applied){
      dFew.trendCurve=trendRes.hopCurve;
      dFew.trendNormalize={applied:true,windowMs:trendRes.effectiveWinMs,floor:trendRes.floor,
        meanRmsOverSteady:trendRes.meanRmsOverSteady,
        underconstrained:trendRes.underconstrained};
      dFew.envCurveNorm=curvesNorm.envCurve;
      dFew.envCurveSlowNorm=curvesNorm.envCurveSlow;
      dFew.slopeCurveNorm=curvesNorm.slopeCurve;
    } else {
      dFew.trendNormalize={applied:false,reason:trendRes.reason};
    }
    return{trimStart:trimStart/sr,loopPts:null,segments:[],
      stats:{mode:'segments',
        failReason:'too few +ZCs in steady region ('+inSteadyCands.length+'/'+dedup.length+')',
        nCandidates:dedup.length,nInSteady:inSteadyCands.length,
        trimStartSec:+(trimStart/sr).toFixed(3),trimEndSec:+(trimEnd/sr).toFixed(3),
        steadyStartSec:+steady.secStart.toFixed(3),steadyEndSec:+steady.secEnd.toFixed(3),
        steadyDurSec:+(steady.secEnd-steady.secStart).toFixed(3),
        tActual:+(T_actual_sec*1000).toFixed(3),tLabeled:+(period/sr*1000).toFixed(3),
        tDriftCents:+((1200*Math.log2(T_actual_sec/(period/sr))).toFixed(1))},
      diag:dFew};
  }
  /* ── 7. selectSegments. */
  var pitchAtInSteady=inSteadyCands.map(function(t){return sampleCurve(pitchCurve,t);});
  /* Gate samples from the TREND curve. See buildCandidates above for why. */
  var tiltAtInSteady=inSteadyCands.map(function(t){return sampleCurve(tiltTrendCurve,t);});
  var tiltSlopeAtInSteady=inSteadyCands.map(function(t){return sampleCurve(tiltSlopeCurve,t);});
  var segRes=selectSegments(bufGate,inSteadyCands,{
    tActualSec:T_actual_sec,
    rmsStepThreshold:opts.rmsStepThreshold,
    slopeStepThreshold:opts.slopeStepThreshold,
    slopeStrideSec:slopeStrideSec,
    corrThreshold:opts.corrThreshold,
    corrWindowPeriods:opts.corrWindowPeriods,
    minPairLengthSec:opts.minPairLengthSec,
    minEndpointSepSec:opts.minEndpointSepSec,
    maxSegments:maxLoopPts,
    pitchAtCandidates:pitchAtInSteady,
    tiltAtCandidates:tiltAtInSteady,
    tiltSlopeAtCandidates:tiltSlopeAtInSteady,
    pitchStepThresholdCents:opts.pitchStepThresholdCents,
    tiltStepThreshold:opts.tiltStepThreshold,
    tiltSlopeStepThreshold:opts.tiltSlopeStepThreshold,
    _debug:opts._debug
  });
  /* ── 8. Build endpoint list, then unify all post-selection state into
         one return whether or not segments survived. Both success and
         "fewer than 2 segments" carry the same full diag so the analyzer's
         per-row canvas always renders. */
  var endptSet={};
  for(var i=0;i<segRes.segments.length;i++){
    endptSet[+segRes.segments[i].a.toFixed(7)]=segRes.segments[i].a;
    endptSet[+segRes.segments[i].b.toFixed(7)]=segRes.segments[i].b;
  }
  var endptList=[];
  for(var k in endptSet)endptList.push(endptSet[k]);
  endptList.sort(function(a,b){return a-b;});
  var diagFinal=addSteadyToDiag(baseDiag(),steady);
  diagFinal.candidates=buildCandidates(segRes.segments,steady,segRes.diag.separationRejectedTimes,segRes.diag.ghostEndpointTimes);
  diagFinal.segments=segRes.segments;
  diagFinal.sccOk=!!segRes.diag.sccOk;
  diagFinal.bridgeCount=segRes.diag.bridgeCount||0;
  diagFinal.segDiag=segRes.diag;
  /* Pitch + tilt summary stats over the steady region. Vibrato amplitude
     is the 95th–5th percentile spread (cents) — robust to occasional
     mistracked frames. Tilt drift is (max − min) / mean over the steady
     span. Used by the analyzer's per-row info text. */
  function statsOverSteady(curve){
    if(!curve||!curve.values||!curve.values.length)return null;
    var iLo=Math.max(0,Math.floor((steady.secStart-curve.startSec)/curve.hopSec));
    var iHi=Math.min(curve.values.length-1,Math.ceil((steady.secEnd-curve.startSec)/curve.hopSec));
    if(iHi<=iLo)return null;
    var vals=[];
    for(var i=iLo;i<=iHi;i++){
      var v=curve.values[i];
      if(typeof v==='number'&&!isNaN(v))vals.push(v);
    }
    if(vals.length<3)return null;
    vals.sort(function(a,b){return a-b;});
    function q(p){return vals[Math.floor(p*(vals.length-1))];}
    var sum=0;for(var i=0;i<vals.length;i++)sum+=vals[i];
    var mean=sum/vals.length;
    var sq=0;for(var i=0;i<vals.length;i++){var dv=vals[i]-mean;sq+=dv*dv;}
    var std=Math.sqrt(sq/vals.length);
    return{
      mean:+mean.toFixed(4),
      std:+std.toFixed(4),
      min:+q(0).toFixed(4),
      p5:+q(0.05).toFixed(4),
      p50:+q(0.50).toFixed(4),
      p95:+q(0.95).toFixed(4),
      max:+q(1).toFixed(4),
      spread:+(q(0.95)-q(0.05)).toFixed(4)
    };
  }
  diagFinal.pitchStats=statsOverSteady(pitchCurve);
  /* tiltStats reports the SLOW drift across steady (what matters for seams);
     tiltFineStats is for the fine vibrato-scale modulation if anyone wants it.
     tiltSlopeStats is the signed-slope distribution — its spread tells you
     how much the brightness trajectory varies inside the steady region. */
  diagFinal.tiltStats=statsOverSteady(tiltTrendCurve);
  diagFinal.tiltFineStats=statsOverSteady(tiltCurve);
  diagFinal.tiltSlopeStats=statsOverSteady(tiltSlopeCurve);
  /* Trend metadata (analyzer-side only — runtime application is a later task).
     Downsample the 10ms-hop curve to ~50ms for compact emission. */
  var trendForEmit=null;
  if(trendRes.applied){
    diagFinal.trendCurve=trendRes.hopCurve;
    diagFinal.trendNormalize={applied:true,windowMs:trendRes.effectiveWinMs,floor:trendRes.floor,
      meanRmsOverSteady:trendRes.meanRmsOverSteady,
      underconstrained:trendRes.underconstrained};
    diagFinal.envCurveNorm=curvesNorm.envCurve;
    diagFinal.envCurveSlowNorm=curvesNorm.envCurveSlow;
    diagFinal.slopeCurveNorm=curvesNorm.slopeCurve;
    /* Compute flatness CV (raw vs normalized slow env over steady span). */
    function cvOverSteady(curve){
      if(!curve||!curve.values||!curve.values.length)return null;
      var st=curve.startSec,hop=curve.hopSec;
      var iLo=Math.max(0,Math.floor((steady.secStart-st)/hop));
      var iHi=Math.min(curve.values.length-1,Math.ceil((steady.secEnd-st)/hop));
      if(iHi<=iLo)return null;
      var sum=0,n=0;
      for(var i=iLo;i<=iHi;i++){sum+=curve.values[i];n++;}
      var mean=sum/n;
      if(mean<1e-9)return null;
      var sq=0;
      for(var i=iLo;i<=iHi;i++){var dv=curve.values[i]-mean;sq+=dv*dv;}
      return Math.sqrt(sq/n)/mean;
    }
    diagFinal.trendNormalize.rawCV=cvOverSteady(curves.envCurveSlow);
    diagFinal.trendNormalize.normCV=cvOverSteady(curvesNorm.envCurveSlow);
    /* Downsample 10ms-hop normalized trend to 50ms for emit. */
    var emitHopMs=50;
    var stride=Math.max(1,Math.round(emitHopMs/(trendRes.hopCurve.hopSec*1000)));
    var emitVals=[];
    for(var i=0;i<trendRes.hopCurve.values.length;i+=stride){
      var lo=i, hi=Math.min(trendRes.hopCurve.values.length,i+stride);
      var s=0;for(var j=lo;j<hi;j++)s+=trendRes.hopCurve.values[j];
      emitVals.push(s/(hi-lo));
    }
    trendForEmit={
      applied:true,
      values:emitVals,
      hopMs:emitHopMs,
      startSec:trendRes.hopCurve.startSec
    };
  } else {
    diagFinal.trendNormalize={applied:false,reason:trendRes.reason};
  }
  var stats={
    mode:'segments',
    method:'segments',
    tLabeled:+(period/sr*1000).toFixed(3),
    tActual:+(T_actual_sec*1000).toFixed(3),
    tDriftCents:+((1200*Math.log2(T_actual_sec/(period/sr))).toFixed(1)),
    trimStartSec:+(trimStart/sr).toFixed(3),
    trimEndSec:+(trimEnd/sr).toFixed(3),
    steadyStartSec:+steady.secStart.toFixed(3),
    steadyEndSec:+steady.secEnd.toFixed(3),
    steadyDurSec:+(steady.secEnd-steady.secStart).toFixed(3),
    nCandidates:dedup.length,
    nInSteady:inSteadyCands.length,
    nValidPairs:segRes.diag.nValidPairs||0,
    nSegments:segRes.segments.length,
    bridgeCount:segRes.diag.bridgeCount||0,
    sccOk:!!segRes.diag.sccOk,
    kept:endptList.length
  };
  if(segRes.segments.length<2){
    stats.failReason='segments: '+(segRes.diag.failReason||'fewer than 2 segments survived');
    return{trimStart:trimStart/sr,loopPts:null,segments:segRes.segments,stats:stats,diag:diagFinal,trend:trendForEmit};
  }
  /* freqActual via pitch-curve median over the steady region.
     pitchCurve.values[i] is the cents offset (positive = sharper than
     T_actual_sec) of the per-cycle period at hop index i. Median of valid
     hops inside the steady region recovers the mean fundamental: for vibrato
     instruments it integrates the FM signal over many cycles (immune to
     the 100ms-autocorrelation-window phase bias that previously made
     adjacent vibrato samples disagree by tens of cents); for non-vibrato
     instruments it averages over hundreds of clean cycles (at least as
     precise as the single autocorrelation window). Falls back to the
     autocorrelation value when fewer than 10 valid hops are inside the
     steady region (defensive — pitch curve gaps on attack/decay-dominated
     samples are normal but a near-empty curve indicates +ZC pairing broke
     down and the autocorrelation value is the safer estimate). */
  var freqActualEmitted=1/T_actual_sec;
  if(pitchCurve&&Array.isArray(pitchCurve.values)&&pitchCurve.values.length>0){
    var pcStart=pitchCurve.startSec,pcHop=pitchCurve.hopSec;
    var lo2=Math.max(0,Math.ceil((steady.secStart-pcStart)/pcHop));
    var hi2=Math.min(pitchCurve.values.length,Math.floor((steady.secEnd-pcStart)/pcHop)+1);
    var inSteady=[];
    for(var pi=lo2;pi<hi2;pi++){
      var v=pitchCurve.values[pi];
      if(typeof v==='number'&&!isNaN(v))inSteady.push(v);
    }
    if(inSteady.length>=10){
      inSteady.sort(function(a,b){return a-b;});
      var medCents=inSteady.length%2===1?inSteady[inSteady.length>>1]:(inSteady[(inSteady.length>>1)-1]+inSteady[inSteady.length>>1])/2;
      /* pitchCurve cents are 1200*log2(T_actual/bestDt) — positive cents
         means bestDt < T_actual i.e. higher frequency. Apply: */
      freqActualEmitted=(1/T_actual_sec)*Math.pow(2,medCents/1200);
      stats.pitchCurveMedianCents=+medCents.toFixed(2);
      stats.pitchCurveNValid=inSteady.length;
    } else {
      stats.pitchCurveNValid=inSteady.length;
      stats.pitchCurveFallback='autocorr (insufficient pitch-curve coverage)';
    }
  }
  return{
    trimStart:trimStart/sr,
    loopPts:endptList,
    segments:segRes.segments,
    freqActual:freqActualEmitted,
    stats:stats,
    diag:diagFinal,
    trend:trendForEmit
  };
}

  return {
    prepareLoop: prepareLoop,
    selectSegments: selectSegments,
    findSteadyRegion: findSteadyRegion,
    findSteadyRegionMeanThreshold: findSteadyRegion, /* back-compat alias */
    trimSilence: trimSilence,
    applyConfigDefaults: applyConfigDefaults,
    computeTrendCurve: computeTrendCurve,
    buildVisualCurves: buildVisualCurves,
    computePitchCurve: computePitchCurve,
    computeTiltCurve: computeTiltCurve,
    sampleCurve: sampleCurve,
    refineFundamentalPeriod: refineFundamentalPeriod,
    correlateWaveforms: correlateWaveforms
  };
})();
