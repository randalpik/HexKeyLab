/* HexKeyLab Analyzer — visualization + table-row rendering.
   Receives prepareLoop's result and diag, draws the per-row diagnostic
   canvas (envelope, slope, segments, candidates), builds status text,
   and owns the per-row DOM lifecycle. Calls dumpSegmentGraph as a
   debug-console diagnostic. */

window.HKLViz = (function () {
/* ═══ dumpSegmentGraph — diagnostic for the segment-based pipeline ═══
   Prints the per-sample segment list plus an overlap-chain audit. The
   "perpetual cycle" check is now structural — segments form one SCC iff
   sorted by `a`, every consecutive pair has b_i ≥ a_{i+1}. The bridge
   count tells us how many segments are non-removable without breaking
   the chain (informational, not a fail signal). */
function dumpSegmentGraph(noteName, res){
  var segs=res.segments||[];
  var st=res.stats||{};
  if(segs.length===0){
    console.log('[segments]',noteName,'no segments ('+(st.failReason||'unknown')+')');
    return;
  }
  /* Sort by a, audit consecutive overlaps. */
  var sorted=segs.slice().sort(function(p,q){return p.a-q.a;});
  var overlaps=0,breaks=[];
  for(var i=0;i<sorted.length-1;i++){
    if(sorted[i].b>=sorted[i+1].a)overlaps++;
    else breaks.push(i);
  }
  /* Bridge count: segment i is a bridge if b_{i-1} < a_{i+1}. */
  var bridges=0;
  for(var i=1;i<sorted.length-1;i++){
    if(sorted[i-1].b<sorted[i+1].a)bridges++;
  }
  var span=sorted[sorted.length-1].b-sorted[0].a;
  var totalLen=0;
  for(var i=0;i<sorted.length;i++)totalLen+=sorted[i].b-sorted[i].a;
  var header='[segments] '+noteName+
    '  n='+sorted.length+
    '  span='+span.toFixed(3)+'s'+
    '  scc='+(breaks.length===0?'OK':('broken at '+breaks.join(',')))+
    '  bridges='+bridges+
    '  avgLen='+(totalLen/sorted.length).toFixed(3)+'s'+
    '  steady='+(st.steadyDurSec!=null?st.steadyDurSec+'s':'?');
  console.log(header);
  console.log('  segments [a, b, dist]:',sorted.map(function(s){return [+s.a.toFixed(4),+s.b.toFixed(4),+(s.b-s.a).toFixed(4)];}));
  if(st.nValidPairs!=null)console.log('  pipeline: nCandidates='+st.nCandidates+' nInSteady='+st.nInSteady+' nValidPairs='+st.nValidPairs+' nSegments='+st.nSegments);
  var sd=res.diag&&res.diag.segDiag;
  if(sd){
    console.log('  pair rejects: rms='+sd.rejectByRms+' slope='+sd.rejectBySlope+' corr='+sd.rejectByCorr+' xfade='+sd.rejectByXfade+' pitch='+(sd.rejectByPitch||0)+' tilt='+(sd.rejectByTilt||0));
    if(sd.distHistogram){
      var h=sd.distHistogram;
      console.log('  pair-distance histogram (s): min='+h.min+' p25='+h.p25+' p50='+h.p50+' p75='+h.p75+' max='+h.max);
    }
    if(sd.pitchStepHistogram){
      var ph=sd.pitchStepHistogram;
      console.log('  pair pitch-step histogram (¢): min='+ph.min+' p25='+ph.p25+' p50='+ph.p50+' p75='+ph.p75+' p95='+ph.p95+' max='+ph.max);
    }
    if(sd.tiltStepHistogram){
      var th=sd.tiltStepHistogram;
      console.log('  pair tilt-step histogram: min='+th.min+' p25='+th.p25+' p50='+th.p50+' p75='+th.p75+' p95='+th.p95+' max='+th.max);
    }
    if(sd.selectedSeamStats){
      var sss=sd.selectedSeamStats.map(function(x){return '['+x.a.toFixed(3)+'→'+x.b.toFixed(3)+': p='+(x.pitchStep!=null?x.pitchStep+'¢':'-')+' t='+(x.tiltStep!=null?x.tiltStep:'-')+']';}).join(' ');
      console.log('  selected seams:',sss);
    }
    console.log('  selection rejects: byMinLength='+(sd.nRejectedByMinLength||0)+' bySeparation='+(sd.nRejectedBySeparation||0)+' (kept '+(sd.nSelectedPrePrune!=null?sd.nSelectedPrePrune:'?')+' before SCC prune)');
  }
  if(res.diag&&res.diag.pitchStats){
    var ps=res.diag.pitchStats;
    console.log('  pitch (¢): mean='+ps.mean+' std='+ps.std+' spread(p5-p95)='+ps.spread);
  }
  if(res.diag&&res.diag.tiltStats){
    var ts=res.diag.tiltStats;
    var driftPct=ts.mean>1e-9?(100*(ts.max-ts.min)/ts.mean).toFixed(1):'?';
    console.log('  tilt: mean='+ts.mean+' std='+ts.std+' drift(max-min)/mean='+driftPct+'%');
  }
}
/* Build the long "ok (T Xms, ...)" status string from a prepareLoop result.
   Extracted so both analyzeAll and reAnalyzeAll produce identical formatting. */
function buildStatusText(res){
  if(!res||!res.stats)return 'ok';
  var s=res.stats;
  /* Status line for the segments pipeline. Includes the candidate funnel
     (+ZCs → in steady → valid pairs → segments), trim + steady spans,
     T_actual, drift cents, SCC integrity, and bridge count. */
  var trimNote=' [trim '+s.trimStartSec+'..'+s.trimEndSec+'s]';
  var steadyStr=(s.steadyStartSec!=null)
    ? ' [steady '+s.steadyStartSec+'..'+s.steadyEndSec+'s = '+s.steadyDurSec+'s]'
    : '';
  var sccStr=s.sccOk?'SCC OK':'SCC BROKEN';
  return 'ok (T '+s.tActual+'ms, '+
    (s.tDriftCents>=0?'+':'')+s.tDriftCents+'¢'+trimNote+steadyStr+', '+
    s.nCandidates+' +ZCs → '+(s.nInSteady!=null?s.nInSteady:'?')+' in steady → '+(s.nValidPairs!=null?s.nValidPairs:'?')+' valid pairs → '+s.nSegments+' segments, '+
    sccStr+', '+s.bridgeCount+' bridges)';
}

/* Render or re-render the table row for one analyzed entry. Reused by
   analyzeAll (initial display) and reAnalyzeAll (after threshold changes).
   Rebuilds all cells; the checkbox and graph button are persisted on the
   entry so their state survives re-renders. */
function renderRow(entry){
  var row=entry.row;
  var res=entry.result;
  var s=entry.sample;
  while(row.cells.length>0)row.deleteCell(0);
  row.className='';
  /* Cell 0: checkbox + graph toggle (graph only when rawRes has diag). */
  var c0=row.insertCell();
  c0.appendChild(entry.chk);
  if(entry.rawRes&&entry.rawRes.diag){
    if(!entry.graphBtn){
      var b=document.createElement('button');
      b.textContent='📊';
      b.title='Show envelope graph + candidate points';
      b.style.cssText='margin-left:4px;padding:0 4px;font-size:11px;cursor:pointer';
      b.addEventListener('click',function(){toggleGraph(entry);});
      entry.graphBtn=b;
    }
    c0.appendChild(entry.graphBtn);
  }
  row.insertCell().textContent=s.name;
  row.insertCell().textContent=s.freq;
  if(res){
    var st=res.stats||{};
    /* Per-row columns (segments pipeline):
         Count       segments selected
         Span (s)    last segment's b − first segment's a (post-sort)
         Min gap     shortest segment duration (b−a) in ms
         Max gap     longest segment duration in ms
         Quality     "seg N · SCC OK|BRK · br B"
         Modulation  repurposed → "steady X.XXs" (steady-region duration) */
    var segs=(res.segments||[]).slice().sort(function(p,q){return p.a-q.a;});
    var nSeg=segs.length;
    var lo=nSeg?segs[0].a:0,hi=nSeg?segs[nSeg-1].b:0;
    var dists=segs.map(function(p){return p.b-p.a;});
    var minDist=dists.length?Math.min.apply(null,dists):0;
    var maxDist=dists.length?Math.max.apply(null,dists):0;
    row.insertCell().textContent=nSeg;
    row.insertCell().textContent=(hi-lo).toFixed(2);
    row.insertCell().textContent=Math.round(minDist*1000)+'ms';
    row.insertCell().textContent=Math.round(maxDist*1000)+'ms';
    var qc=row.insertCell();
    qc.textContent='seg '+nSeg+' · '+(st.sccOk?'SCC':'BRK')+' · br '+(st.bridgeCount||0);
    var mc=row.insertCell();
    mc.textContent=(st.steadyDurSec!=null)?('steady '+st.steadyDurSec.toFixed(2)+'s'):'';
    row.insertCell().textContent=buildStatusText(res);
    /* Tier:
         fail/red: 0–1 segments OR SCC broken (no perpetual cycle)
         yellow:   2–3 segments (low variety)
         blue:     4+ segments, SCC OK, ≥half are bridges (constrained variety)
         green:    4+ segments, SCC OK, fewer than half bridges (real variety) */
    if(nSeg<2||!st.sccOk)row.className='tier-red';
    else if(nSeg<4)row.className='tier-yellow';
    else if((st.bridgeCount||0)*2>=nSeg)row.className='tier-blue';
    else row.className='tier-green';
    entry.chk.disabled=false;
    if(entry.chk.checked)row.classList.add('selected');
  }else{
    for(var k=0;k<6;k++)row.insertCell().textContent='-';
    row.insertCell().textContent=entry.failReason||'fail';
    row.className='fail';
    entry.chk.disabled=true;
    entry.chk.checked=false;
  }
  /* If a graph panel is currently expanded for this entry, refresh it. */
  if(entry.graphRow){
    renderGraphForEntry(entry);
  }
}

/* Toggle the inline envelope-graph panel for an entry. The panel lives in a
   separate <tr> sibling of the result row (full-width via colspan). Click
   the 📊 button again to close. */
function toggleGraph(entry){
  if(entry.graphRow){
    entry.graphRow.parentNode.removeChild(entry.graphRow);
    entry.graphRow=null;entry.graphCanvas=null;entry.graphInfo=null;
    return;
  }
  var gr=document.createElement('tr');
  var td=document.createElement('td');
  td.colSpan=10;
  td.style.padding='8px';
  td.style.background='#fafafa';
  td.style.border='1px solid #ccc';
  var canvas=document.createElement('canvas');
  canvas.width=1080;
  canvas.height=520;
  canvas.style.cssText='background:#fff;border:1px solid #ddd;display:block;max-width:100%';
  td.appendChild(canvas);
  var info=document.createElement('div');
  info.style.cssText='font-size:11px;color:#444;margin-top:6px;font-family:monospace;white-space:pre-wrap';
  td.appendChild(info);
  gr.appendChild(td);
  entry.row.parentNode.insertBefore(gr,entry.row.nextSibling);
  entry.graphRow=gr;
  entry.graphCanvas=canvas;
  entry.graphInfo=info;
  renderGraphForEntry(entry);
}

/* Draw the envelope diagnostic graph for an entry into its open canvas.
   Plots:
   • Background bands: attack region (yellow), steady region (green)
   • Envelope curve as the gate sees it (blue stroke) — moving-average RMS
     with the fundamental-period window
   • Boundary lines: trimStart (grey), smartStart (orange), steadyEnd (grey)
   • Per-candidate dots: green filled = in final clique, yellow hollow =
     rejected by pair gates (rms, slope, xfade, or amp-step)
   • Slope tangent line at each candidate: slope of the env curve, visually
     scaled so a 1% change per 40ms shows as a small but readable angle */
function renderGraphForEntry(entry){
  if(!entry.graphCanvas)return;
  var diag=entry.rawRes&&entry.rawRes.diag;
  var ctx=entry.graphCanvas.getContext('2d');
  var W=entry.graphCanvas.width;
  var H=entry.graphCanvas.height;
  ctx.clearRect(0,0,W,H);
  if(!diag){
    if(entry.graphInfo)entry.graphInfo.textContent='no diag (analysis failed before reaching the gate stage)';
    return;
  }
  /* Four stacked panels share the time axis so candidate positions line up
     vertically: env (loudest signal — segment bars, candidates, trend
     overlays), slope, pitch (cents from T_actual), tilt (RMS(Δd)/RMS(d)).
     Pitch and tilt only render if their curves are present. */
  var ml=50,mr=18,mt=12,mb=22;
  var pw=W-ml-mr;
  var totalPh=H-mt-mb;
  var gap=8;
  var hasPitch=!!(diag.pitchCurve&&diag.pitchCurve.values&&diag.pitchCurve.values.length);
  var hasTilt=!!(diag.tiltCurve&&diag.tiltCurve.values&&diag.tiltCurve.values.length);
  var nExtra=(hasPitch?1:0)+(hasTilt?1:0);
  var gapsTotal=(1+nExtra)*gap;
  var panelTotal=totalPh-gapsTotal;
  var envPh,slopePh,pitchPh=0,tiltPh=0;
  if(nExtra===2){envPh=Math.round(panelTotal*0.40);slopePh=Math.round(panelTotal*0.20);pitchPh=Math.round(panelTotal*0.20);tiltPh=panelTotal-envPh-slopePh-pitchPh;}
  else if(nExtra===1){envPh=Math.round(panelTotal*0.50);slopePh=Math.round(panelTotal*0.25);if(hasPitch)pitchPh=panelTotal-envPh-slopePh;else tiltPh=panelTotal-envPh-slopePh;}
  else{envPh=Math.round(panelTotal*0.60);slopePh=panelTotal-envPh;}
  var envTop=mt;
  var envBot=envTop+envPh;
  var slopeTop=envBot+gap;
  var slopeBot=slopeTop+slopePh;
  var pitchTop=slopeBot+gap;
  var pitchBot=pitchTop+pitchPh;
  var tiltTop=(hasPitch?pitchBot:slopeBot)+gap;
  var tiltBot=tiltTop+tiltPh;
  var envCurve=diag.envCurve;
  var totalSec=envCurve.startSec+envCurve.values.length*envCurve.hopSec;
  var tMax=Math.max(totalSec,diag.trimEndSec+0.1);
  function xs(t){return ml+(t/tMax)*pw;}
  /* Env axis: 0 .. maxEnv */
  var maxEnv=0;
  for(var i=0;i<envCurve.values.length;i++)if(envCurve.values[i]>maxEnv)maxEnv=envCurve.values[i];
  if(maxEnv<1e-6)maxEnv=0.001;
  function ys(v){return envTop+envPh-(v/maxEnv)*envPh;}
  /* Slope axis: symmetric around 0. Use the 98th percentile of |slope| across
     the post-trim region as the y-range, with a floor at 4×slopeStepThreshold
     so the threshold band is always visible even on very steady samples. */
  var slopeCurve=diag.slopeCurve;
  var slopeAbsList=[];
  if(slopeCurve&&slopeCurve.values){
    var sStart=diag.trimStartSec, sEnd=diag.trimEndSec;
    for(var i=0;i<slopeCurve.values.length;i++){
      var t=slopeCurve.startSec+i*slopeCurve.hopSec;
      if(t<sStart||t>sEnd)continue;
      slopeAbsList.push(Math.abs(slopeCurve.values[i]));
    }
    slopeAbsList.sort(function(a,b){return a-b;});
  }
  var slopeRange=slopeAbsList.length?slopeAbsList[Math.floor(slopeAbsList.length*0.98)]:0;
  slopeRange=Math.max(slopeRange*1.2,(diag.slopeStepThreshold||0.005)*4);
  function ysSlope(v){
    var clamped=Math.max(-slopeRange,Math.min(slopeRange,v));
    return slopeTop+slopePh/2-(clamped/slopeRange)*(slopePh/2);
  }
  /* Pitch axis: symmetric ±cents range centered on 0 (= T_actual). Scale to
     the 95th percentile of |values| inside the steady region rather than the
     max — that way the panel stays readable when a handful of cycles produce
     outliers (those still appear in the data, they just go off the top of
     the chart). 30¢ floor avoids hyper-zoom on very steady samples; 200¢
     cap prevents a pathological tail from dwarfing real vibrato. */
  var pitchRange=0;
  var ysPitch=null;
  if(hasPitch){
    var pc=diag.pitchCurve;
    var sStartP=diag.steadyStartSec!=null?diag.steadyStartSec:diag.trimStartSec;
    var sEndP=diag.steadyEndSec!=null?diag.steadyEndSec:diag.trimEndSec;
    var absP=[];
    for(var i=0;i<pc.values.length;i++){
      var t=pc.startSec+i*pc.hopSec;
      if(t<sStartP||t>sEndP)continue;
      var v=pc.values[i];
      if(typeof v!=='number'||isNaN(v))continue;
      absP.push(Math.abs(v));
    }
    if(absP.length){
      absP.sort(function(a,b){return a-b;});
      pitchRange=absP[Math.floor(0.95*(absP.length-1))];
    }
    pitchRange=Math.max(30,Math.min(200,pitchRange*1.2));
    ysPitch=function(v){
      var clamped=Math.max(-pitchRange,Math.min(pitchRange,v));
      return pitchTop+pitchPh/2-(clamped/pitchRange)*(pitchPh/2);
    };
  }
  /* Tilt axis: [min, max] inside the steady region across BOTH the fine and
     trend curves with 10% padding and a 0.01-wide floor. Lower bound clamped
     to 0 (tilt is non-negative). The fine curve always has wider range than
     the trend, so it dominates the axis. */
  var tiltLo=0,tiltHi=1;
  var ysTilt=null;
  if(hasTilt){
    var tc=diag.tiltCurve;
    var tt=diag.tiltTrendCurve;
    var sStartT=diag.steadyStartSec!=null?diag.steadyStartSec:diag.trimStartSec;
    var sEndT=diag.steadyEndSec!=null?diag.steadyEndSec:diag.trimEndSec;
    var tMinV=Infinity,tMaxV=-Infinity;
    function scan(curve){
      if(!curve||!curve.values)return;
      for(var i=0;i<curve.values.length;i++){
        var t=curve.startSec+i*curve.hopSec;
        if(t<sStartT||t>sEndT)continue;
        var v=curve.values[i];
        if(typeof v!=='number'||isNaN(v))continue;
        if(v<tMinV)tMinV=v;
        if(v>tMaxV)tMaxV=v;
      }
    }
    scan(tc);scan(tt);
    if(tMinV===Infinity){tMinV=0;tMaxV=0.1;}
    var span=tMaxV-tMinV;
    if(span<0.01){var ctr=(tMinV+tMaxV)/2;tMinV=ctr-0.005;tMaxV=ctr+0.005;span=0.01;}
    var pad=span*0.10;
    tiltLo=Math.max(0,tMinV-pad);
    tiltHi=tMaxV+pad;
    ysTilt=function(v){
      var clamped=Math.max(tiltLo,Math.min(tiltHi,v));
      return tiltTop+tiltPh-(clamped-tiltLo)/(tiltHi-tiltLo)*tiltPh;
    };
  }
  /* Active region (post-trim) bands across every panel. */
  var panels=[{top:envTop,h:envPh},{top:slopeTop,h:slopePh}];
  if(hasPitch)panels.push({top:pitchTop,h:pitchPh});
  if(hasTilt)panels.push({top:tiltTop,h:tiltPh});
  ctx.fillStyle='#f4f9f0';
  for(var pi=0;pi<panels.length;pi++)ctx.fillRect(xs(diag.trimStartSec),panels[pi].top,xs(diag.trimEndSec)-xs(diag.trimStartSec),panels[pi].h);
  /* Steady region (segments pipeline only) — darker shade INSIDE the trim
     band so the user can see exactly which slice the segment selector was
     allowed to draw from. */
  if(diag.pipeline==='segments'&&diag.steadyStartSec!=null){
    ctx.fillStyle='#d6ecc6';
    for(var pi2=0;pi2<panels.length;pi2++)ctx.fillRect(xs(diag.steadyStartSec),panels[pi2].top,xs(diag.steadyEndSec)-xs(diag.steadyStartSec),panels[pi2].h);
  }
  /* Panel frames */
  ctx.strokeStyle='#bbb';
  ctx.lineWidth=1;
  for(var pi3=0;pi3<panels.length;pi3++)ctx.strokeRect(ml,panels[pi3].top,pw,panels[pi3].h);
  /* SLOW envelope curve in env panel */
  var envSlow=diag.envCurveSlow;
  if(envSlow&&envSlow.values&&envSlow.values.length){
    ctx.strokeStyle='#bbb';
    ctx.lineWidth=2.5;
    ctx.beginPath();
    for(var i=0;i<envSlow.values.length;i++){
      var t=envSlow.startSec+i*envSlow.hopSec;
      var x=xs(t),y=ys(envSlow.values[i]);
      if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
    }
    ctx.stroke();
  }
  /* FAST envelope curve (the gate's view) */
  ctx.strokeStyle='#0066cc';
  ctx.lineWidth=1.5;
  ctx.beginPath();
  for(var i=0;i<envCurve.values.length;i++){
    var t=envCurve.startSec+i*envCurve.hopSec;
    var x=xs(t),y=ys(envCurve.values[i]);
    if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
  }
  ctx.stroke();
  /* Trend & normalized overlays (sustained loop, trend normalization active).
     - Trend curve: dashed red, on the raw env y-scale (multiply mean-normalized
       value by meanRmsOverSteady).
     - Normalized fast env: solid purple. Values are already in raw-RMS units
       (RMS of d/trend averages to meanRmsOverSteady over steady), so plot
       directly. */
  var trendOn=diag.trendNormalize&&diag.trendNormalize.applied;
  if(trendOn&&diag.trendCurve&&diag.trendCurve.values&&diag.trendCurve.values.length){
    var trC=diag.trendCurve;
    var meanS=diag.trendNormalize.meanRmsOverSteady||1;
    ctx.strokeStyle='#d33';
    ctx.lineWidth=1.5;
    ctx.setLineDash([5,3]);
    ctx.beginPath();
    for(var i=0;i<trC.values.length;i++){
      var t=trC.startSec+i*trC.hopSec;
      var x=xs(t),y=ys(trC.values[i]*meanS);
      if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if(trendOn&&diag.envCurveNorm&&diag.envCurveNorm.values&&diag.envCurveNorm.values.length){
    var envN=diag.envCurveNorm;
    ctx.strokeStyle='#8e44ad';
    ctx.lineWidth=1.5;
    ctx.beginPath();
    for(var i=0;i<envN.values.length;i++){
      var t=envN.startSec+i*envN.hopSec;
      var x=xs(t),y=ys(envN.values[i]);
      if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
    }
    ctx.stroke();
  }
  /* Mean-RMS reference + steady-region threshold lines (segments pipeline). */
  if(diag.pipeline==='segments'&&diag.meanRms!=null){
    /* Mean RMS — solid grey line across steady region only. */
    var meanY=ys(diag.meanRms);
    ctx.strokeStyle='#888';
    ctx.lineWidth=1;
    ctx.setLineDash([4,3]);
    ctx.beginPath();
    ctx.moveTo(xs(diag.steadyStartSec),meanY);
    ctx.lineTo(xs(diag.steadyEndSec),meanY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle='#888';ctx.font='9px monospace';
    ctx.fillText('mean',xs(diag.steadyStartSec)-28,meanY+3);
    /* Threshold (e.g. 0.5 × mean) — light red line that the steady-region
       detector required smoothed RMS to stay above. */
    var thY=ys(diag.rmsThresh);
    ctx.strokeStyle='#c44';
    ctx.lineWidth=1;
    ctx.setLineDash([2,3]);
    ctx.beginPath();
    ctx.moveTo(xs(diag.trimStartSec),thY);
    ctx.lineTo(xs(diag.trimEndSec),thY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle='#c44';ctx.font='9px monospace';
    ctx.fillText('thresh',xs(diag.trimStartSec)-32,thY+3);
  }
  /* Segment bars (segments pipeline). One bar per segment, stacked from the
     bottom of the env panel. Each bar spans [a, b] in time; vertical ticks
     mark the endpoints. Color: filled green, dark outline. The picker plays
     forward from `a` to `b`, then loops back to `a` — drawing the bar as
     a directional arrow from a to b makes that visually explicit. */
  if(diag.pipeline==='segments'&&diag.segments&&diag.segments.length){
    var segs=diag.segments.slice().sort(function(p,q){return p.a-q.a;});
    var rowH=Math.min(8,Math.max(4,Math.floor((envPh-24)/Math.max(segs.length,1))));
    var barBase=envBot-4;
    for(var si=0;si<segs.length;si++){
      var sg=segs[si];
      var xa=xs(sg.a),xb=xs(sg.b);
      var yRow=barBase-si*(rowH+2);
      if(yRow<envTop+8)yRow=envTop+8+((si*(rowH+2))%(envPh-16));
      /* Bar fill */
      ctx.fillStyle='rgba(50,150,80,0.45)';
      ctx.fillRect(xa,yRow-rowH/2,xb-xa,rowH);
      /* Bar outline */
      ctx.strokeStyle='#1f6e3c';
      ctx.lineWidth=1;
      ctx.strokeRect(xa,yRow-rowH/2,xb-xa,rowH);
      /* Endpoint vertical ticks rising up to the env curve so the user can
         see which envelope value each endpoint actually sits at. */
      ctx.strokeStyle='rgba(31,110,60,0.5)';
      ctx.lineWidth=1;
      ctx.setLineDash([2,2]);
      ctx.beginPath();
      ctx.moveTo(xa,yRow);ctx.lineTo(xa,envTop+8);
      ctx.moveTo(xb,yRow);ctx.lineTo(xb,envTop+8);
      ctx.stroke();
      ctx.setLineDash([]);
      /* Direction arrow at the right end of the bar: > pointing into b. */
      ctx.beginPath();
      ctx.moveTo(xb-3,yRow-rowH/2);
      ctx.lineTo(xb,yRow);
      ctx.lineTo(xb-3,yRow+rowH/2);
      ctx.strokeStyle='#1f6e3c';
      ctx.lineWidth=1.2;
      ctx.stroke();
    }
  }
  /* Slope panel: zero reference line + slope-threshold band */
  var thr=diag.slopeStepThreshold||0.005;
  if(thr<slopeRange){
    ctx.fillStyle='#f0f8f0';
    ctx.fillRect(ml,ysSlope(thr/2),pw,ysSlope(-thr/2)-ysSlope(thr/2));
  }
  ctx.strokeStyle='#666';
  ctx.lineWidth=1;
  ctx.beginPath();
  ctx.moveTo(ml,ysSlope(0));ctx.lineTo(ml+pw,ysSlope(0));
  ctx.stroke();
  /* Slope curve (black stroke) */
  if(slopeCurve&&slopeCurve.values){
    ctx.strokeStyle='#000';
    ctx.lineWidth=1.2;
    ctx.beginPath();
    for(var i=0;i<slopeCurve.values.length;i++){
      var t=slopeCurve.startSec+i*slopeCurve.hopSec;
      var x=xs(t),y=ysSlope(slopeCurve.values[i]);
      if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
    }
    ctx.stroke();
  }
  /* Normalized slope (dashed purple, on top of raw). */
  if(trendOn&&diag.slopeCurveNorm&&diag.slopeCurveNorm.values){
    var slN=diag.slopeCurveNorm;
    ctx.strokeStyle='#8e44ad';
    ctx.lineWidth=1.2;
    ctx.setLineDash([4,3]);
    ctx.beginPath();
    for(var i=0;i<slN.values.length;i++){
      var t=slN.startSec+i*slN.hopSec;
      var x=xs(t),y=ysSlope(slN.values[i]);
      if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  /* ── Pitch panel ───────────────────────────────────────────────────────
     0-cent center line = T_actual. Mean over steady = dashed grey. Curve
     in teal. NaN gaps break the polyline (use moveTo to skip). */
  if(hasPitch){
    var pc2=diag.pitchCurve;
    /* Zero reference */
    ctx.strokeStyle='#666';
    ctx.lineWidth=1;
    ctx.beginPath();
    ctx.moveTo(ml,ysPitch(0));ctx.lineTo(ml+pw,ysPitch(0));
    ctx.stroke();
    /* Mean over steady region (if available) */
    if(diag.pitchStats&&diag.steadyStartSec!=null){
      var pMy=ysPitch(diag.pitchStats.mean);
      ctx.strokeStyle='#888';
      ctx.lineWidth=1;
      ctx.setLineDash([4,3]);
      ctx.beginPath();
      ctx.moveTo(xs(diag.steadyStartSec),pMy);
      ctx.lineTo(xs(diag.steadyEndSec),pMy);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    /* Pitch curve */
    ctx.strokeStyle='#0a8e8e';
    ctx.lineWidth=1.2;
    ctx.beginPath();
    var started=false;
    for(var i=0;i<pc2.values.length;i++){
      var v=pc2.values[i];
      var t=pc2.startSec+i*pc2.hopSec;
      var x=xs(t);
      if(typeof v!=='number'||isNaN(v)){started=false;continue;}
      var y=ysPitch(v);
      if(!started){ctx.moveTo(x,y);started=true;}
      else ctx.lineTo(x,y);
    }
    ctx.stroke();
  }
  /* ── Tilt panel ────────────────────────────────────────────────────────
     Fine curve (100ms window, light brown) shows vibrato-scale brightness
     modulation. Trend curve (600ms window, bold dark brown) shows slow drift
     — THIS is what the gate compares. Mean over steady = dashed grey.
     Candidate dots in this panel sit on the trend value, since that's what
     the gate sees. */
  if(hasTilt){
    var tc2=diag.tiltCurve;
    var tt2=diag.tiltTrendCurve;
    if(diag.tiltStats&&diag.steadyStartSec!=null){
      var tMy=ysTilt(diag.tiltStats.mean);
      ctx.strokeStyle='#888';
      ctx.lineWidth=1;
      ctx.setLineDash([4,3]);
      ctx.beginPath();
      ctx.moveTo(xs(diag.steadyStartSec),tMy);
      ctx.lineTo(xs(diag.steadyEndSec),tMy);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    /* Fine curve — thin, lighter */
    ctx.strokeStyle='#d4a079';
    ctx.lineWidth=1;
    ctx.beginPath();
    for(var i=0;i<tc2.values.length;i++){
      var t=tc2.startSec+i*tc2.hopSec;
      var x=xs(t);
      var v=tc2.values[i];
      var y=ysTilt(v);
      if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
    }
    ctx.stroke();
    /* Trend curve — thicker, darker, on top */
    if(tt2&&tt2.values&&tt2.values.length){
      ctx.strokeStyle='#a85a2a';
      ctx.lineWidth=1.8;
      ctx.beginPath();
      for(var i=0;i<tt2.values.length;i++){
        var t=tt2.startSec+i*tt2.hopSec;
        var x=xs(t);
        var v=tt2.values[i];
        var y=ysTilt(v);
        if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
      }
      ctx.stroke();
    }
  }
  /* Boundary lines across every panel */
  function vLine(t,color,label){
    if(t<0||t>tMax)return;
    var x=xs(t);
    ctx.strokeStyle=color;
    ctx.lineWidth=1;
    ctx.beginPath();
    for(var pix=0;pix<panels.length;pix++){
      ctx.moveTo(x,panels[pix].top);ctx.lineTo(x,panels[pix].top+panels[pix].h);
    }
    ctx.stroke();
    ctx.fillStyle=color;
    ctx.font='10px monospace';
    ctx.fillText(label,x+3,envTop+10);
  }
  vLine(diag.trimStartSec,'#888','trimStart');
  vLine(diag.trimEndSec,'#888','trimEnd');
  /* Candidate dots — three tiers (segments pipeline):
       GREEN filled  = used as a segment endpoint (inSegment)
       BLUE filled   = endpoint of a pair that passed min-length but was
                       rejected by the separation rule (inSeparationRejected,
                       and not already a segment endpoint). Visually shows
                       "almost picked, bumped by 100 ms-spacing".
       YELLOW hollow = outside the steady region (rare context dots)
     Candidates inside the steady region but not in either of the first two
     tiers (i.e. only ever appeared in min-length-rejected pairs, or never
     formed a valid pair at all) are intentionally NOT drawn — they're not
     useful for tuning and just clutter the canvas.
     Drawing order: lowest tier first so high-tier dots paint on top. */
  var nFinal=0,nPartner=0,nIsolated=0,nHidden=0;
  function dotStyleFor(c){
    if(c.inSegment)return{fill:'#0a0',stroke:'#060',rEnv:5,rSlp:4,rPit:4,rTlt:4,lw:1.2,connectRgba:'rgba(0,170,0,0.45)'};
    if(c.inSeparationRejected)return{fill:'#3498db',stroke:'#1e5e8a',rEnv:3,rSlp:2.5,rPit:2.5,rTlt:2.5,lw:1,connectRgba:'rgba(52,152,219,0.25)'};
    return{fill:null,stroke:'#aa8000',rEnv:2.5,rSlp:2,rPit:2,rTlt:2,lw:0.8,connectRgba:'rgba(170,140,0,0.15)'};
  }
  function dot(x,y,r,fill,stroke,lw){
    ctx.beginPath();
    ctx.arc(x,y,r,0,2*Math.PI);
    if(fill){ctx.fillStyle=fill;ctx.fill();}
    ctx.strokeStyle=stroke;ctx.lineWidth=lw;ctx.stroke();
  }
  function drawCandTier(predicate){
    for(var i=0;i<diag.candidates.length;i++){
      var c=diag.candidates[i];
      if(!predicate(c))continue;
      var st=dotStyleFor(c);
      var x=xs(c.posSec);
      var yEnv=ys(c.env);
      var ySlp=c.slope!=null?ysSlope(c.slope):null;
      var yPit=(hasPitch&&c.pitch!=null)?ysPitch(c.pitch):null;
      var yTlt=(hasTilt&&c.tilt!=null)?ysTilt(c.tilt):null;
      /* Connect line: vertical guide from the env panel through each
         subsequent panel where the candidate has a value, so the user can
         trace a single candidate's fingerprint visually. */
      ctx.strokeStyle=st.connectRgba;
      ctx.lineWidth=1;
      var prevY=yEnv;
      var segments=[];
      if(ySlp!=null){segments.push([prevY,ySlp]);prevY=ySlp;}
      if(yPit!=null){segments.push([prevY,yPit]);prevY=yPit;}
      if(yTlt!=null){segments.push([prevY,yTlt]);prevY=yTlt;}
      if(segments.length){
        ctx.beginPath();
        for(var k=0;k<segments.length;k++){
          ctx.moveTo(x,segments[k][0]);ctx.lineTo(x,segments[k][1]);
        }
        ctx.stroke();
      }
      dot(x,yEnv,st.rEnv,st.fill,st.stroke,st.lw);
      if(ySlp!=null)dot(x,ySlp,st.rSlp,st.fill,st.stroke,st.lw);
      if(yPit!=null)dot(x,yPit,st.rPit,st.fill,st.stroke,st.lw);
      if(yTlt!=null)dot(x,yTlt,st.rTlt,st.fill,st.stroke,st.lw);
    }
  }
  /* Yellow: only candidates OUTSIDE the steady region. (Inside-steady-but-
     uninteresting candidates are skipped — see nHidden count below.) */
  drawCandTier(function(c){return !c.inSteady&&!c.inSegment&&!c.inSeparationRejected;});
  drawCandTier(function(c){return c.inSeparationRejected&&!c.inSegment;});
  drawCandTier(function(c){return c.inSegment;});
  for(var i=0;i<diag.candidates.length;i++){
    var c=diag.candidates[i];
    if(c.inSegment)nFinal++;
    else if(c.inSeparationRejected)nPartner++;
    else if(!c.inSteady)nIsolated++;
    else nHidden++;
  }
  /* Axes labels */
  ctx.fillStyle='#444';
  ctx.font='10px monospace';
  ctx.fillText(maxEnv.toFixed(3),3,envTop+10);
  ctx.fillText('0',3,envBot-2);
  ctx.fillText('+'+slopeRange.toFixed(3),3,slopeTop+10);
  ctx.fillText('0',3,slopeTop+slopePh/2+3);
  ctx.fillText('-'+slopeRange.toFixed(3),3,slopeBot-2);
  if(hasPitch){
    ctx.fillText('+'+pitchRange.toFixed(0)+'¢',3,pitchTop+10);
    ctx.fillText('0¢',3,pitchTop+pitchPh/2+3);
    ctx.fillText('-'+pitchRange.toFixed(0)+'¢',3,pitchBot-2);
  }
  if(hasTilt){
    ctx.fillText(tiltHi.toFixed(3),3,tiltTop+10);
    ctx.fillText(tiltLo.toFixed(3),3,tiltBot-2);
  }
  var axisBot=hasTilt?tiltBot:(hasPitch?pitchBot:slopeBot);
  ctx.fillText('0s',ml,axisBot+14);
  ctx.fillText(tMax.toFixed(2)+'s',ml+pw-32,axisBot+14);
  /* Info line */
  if(entry.graphInfo){
    var title=entry.sample.name+' ('+entry.sample.freq+'Hz)';
    var pcCount=diag.candidates.length;
    var stx=entry.rawRes.stats||{};
    var segCount=(diag.segments&&diag.segments.length)||0;
    var sccStr=diag.sccOk?'SCC OK':'SCC broken';
    var bridgeStr='bridges='+(diag.bridgeCount||0);
    var pickInfo=pcCount+' +ZCs · '+(stx.nValidPairs||0)+' valid pairs → '+segCount+' segments · '+sccStr+' · '+bridgeStr+
      ' · dots: '+nFinal+' green / '+nPartner+' blue / '+nIsolated+' yellow / '+nHidden+' hidden';
    var legend='env: blue=fast env, gray=1000ms avg, dashed grey=meanRMS, dashed red=amp trend, purple=normalized env.  slope: black=raw, purple-dashed=normalized.  pitch: teal=cents from T_actual, dashed grey=mean.  tilt: tan=fine (100ms), brown=slow trend (600ms, gate uses this), dashed grey=mean.  bars: green segments span [a,b], arrow→b.  dots: green=segment endpoint, blue=separation-rejected, yellow=outside steady.';
    var paramInfo='envWin='+(diag.envWinSec*1000).toFixed(1)+'ms  slopeStride=±'+((diag.slopeHSec||0)*1000).toFixed(1)+'ms  rmsThresh='+diag.rmsStepThreshold+'  slopeThresh='+diag.slopeStepThreshold;
    if(diag.pitchStepThresholdCents!=null&&isFinite(diag.pitchStepThresholdCents))paramInfo+='  pitchThresh='+diag.pitchStepThresholdCents+'¢';
    if(diag.tiltStepThreshold!=null&&isFinite(diag.tiltStepThreshold))paramInfo+='  tiltThresh='+diag.tiltStepThreshold;
    if(diag.steadyStartSec!=null){
      paramInfo+='  steady=['+diag.steadyStartSec.toFixed(2)+'–'+diag.steadyEndSec.toFixed(2)+']s';
    }
    var trendInfo='';
    if(diag.trendNormalize){
      if(diag.trendNormalize.applied){
        var tn=diag.trendNormalize;
        var raw=tn.rawCV,nrm=tn.normCV;
        trendInfo='\ntrend: ';
        if(raw!=null&&nrm!=null){
          var ratio=nrm>1e-9?(raw/nrm):0;
          trendInfo+='rawCV='+raw.toFixed(3)+' normCV='+nrm.toFixed(3)+
            ' (compressed '+ratio.toFixed(1)+'×)  win='+Math.round(tn.windowMs)+'ms';
        } else {
          trendInfo+='applied (win='+Math.round(tn.windowMs)+'ms)';
        }
        if(tn.underconstrained) trendInfo+='  ⚠underconstrained';
      } else {
        trendInfo='\ntrend: not applied ('+diag.trendNormalize.reason+')';
      }
    }
    /* Pitch + tilt steady-region summary and per-selected-seam steps.
       Vibrato amplitude (p95-p5) is what you hear as the modulation depth;
       tilt drift / mean is the relative brightness change across steady. */
    var pitchTiltInfo='';
    if(diag.pitchStats){
      var ps=diag.pitchStats;
      pitchTiltInfo+='\npitch: mean='+ps.mean.toFixed(1)+'¢ std='+ps.std.toFixed(1)+'¢ vibrato(p5–p95)='+ps.spread.toFixed(1)+'¢';
    }
    if(diag.tiltStats){
      var ts=diag.tiltStats;
      var drift=ts.mean>1e-9?(100*(ts.max-ts.min)/ts.mean):0;
      pitchTiltInfo+='\ntilt trend (600ms): mean='+ts.mean.toFixed(3)+' drift=(max-min)/mean='+drift.toFixed(1)+'%';
      if(diag.tiltFineStats){
        var tfs=diag.tiltFineStats;
        var fineMod=tfs.mean>1e-9?(100*(tfs.p95-tfs.p5)/tfs.mean):0;
        pitchTiltInfo+='   ·   fine (100ms) vibrato mod (p5-p95)/mean='+fineMod.toFixed(1)+'%';
      }
    }
    /* Per-selected-segment seam steps — what the runtime hears at each wrap.
       Helps spot which specific (a,b) is likely the audible offender. */
    var sd=diag.segDiag;
    if(sd&&sd.selectedSeamStats&&sd.selectedSeamStats.length){
      var seams=sd.selectedSeamStats;
      var seamLine=seams.map(function(s){
        var p=s.pitchStep!=null?s.pitchStep.toFixed(1)+'¢':'-';
        var t=s.tiltStep!=null?(s.tiltStep*100).toFixed(1)+'%':'-';
        return p+'/'+t;
      }).join(' ');
      var maxPitch=0,maxTilt=0;
      for(var k=0;k<seams.length;k++){
        if(seams[k].pitchStep!=null&&seams[k].pitchStep>maxPitch)maxPitch=seams[k].pitchStep;
        if(seams[k].tiltStep!=null&&seams[k].tiltStep>maxTilt)maxTilt=seams[k].tiltStep;
      }
      pitchTiltInfo+='\nseam steps (Δ¢/Δtilt%): '+seamLine+'  (max '+maxPitch.toFixed(1)+'¢ / '+(maxTilt*100).toFixed(1)+'%)';
    }
    if(sd&&(sd.pitchStepHistogram||sd.tiltStepHistogram)){
      var rej='';
      if(sd.rejectByPitch)rej+=' rejByPitch='+sd.rejectByPitch;
      if(sd.rejectByTilt)rej+=' rejByTilt='+sd.rejectByTilt;
      var hist='';
      if(sd.pitchStepHistogram)hist+=' pitch p50='+sd.pitchStepHistogram.p50+'¢ p95='+sd.pitchStepHistogram.p95+'¢';
      if(sd.tiltStepHistogram)hist+=' tilt p50='+(sd.tiltStepHistogram.p50*100).toFixed(1)+'% p95='+(sd.tiltStepHistogram.p95*100).toFixed(1)+'%';
      pitchTiltInfo+='\nvalid pairs:'+hist+rej;
    }
    entry.graphInfo.textContent=title+'  ·  '+pickInfo+'\n'+legend+'\n'+paramInfo+trendInfo+pitchTiltInfo;
  }
}

  return {
    dumpSegmentGraph: dumpSegmentGraph,
    renderRow: renderRow,
    toggleGraph: toggleGraph,
    renderGraphForEntry: renderGraphForEntry,
    buildStatusText: buildStatusText
  };
})();
