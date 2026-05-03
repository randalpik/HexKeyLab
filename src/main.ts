// @ts-nocheck
// HexKeyLab v0.9 — Phase 2 of TS+Vite migration: pure tuning/layout modules
// extracted; render/audio/midi/lumatone/ui still inline; will move out next.

import { baseKeys, layoutShifts } from './layout/baseKeys.js';
import { bandOf, posInBand } from './layout/coords.js';
import { hexR, dxH, dyH, hexToScreen, tiltAngle, cosT, sinT } from './layout/geometry.js';
import {
  letterSemi, accToVal, valToAcc, parseNote, m3up, m3dn,
  fifthName, noteName, SHARP, DBLSHARP, FLAT, DBLFLAT, fmtNote, keyOctave,
} from './tuning/notes.js';
import { regionBandIdx, isRegionB, regionInfo } from './tuning/regions.js';
import { gcd, jiRatio, intervalTier } from './tuning/ratios.js';
import { keyFreq } from './tuning/frequency.js';
import {
  curLayout, septimalEnabled, equalEnabled, septimalShift, septimalW,
  setCurLayout, setSeptimalEnabled, setEqualEnabled, setSeptimalShift,
} from './state/tuning.js';
import {
  colorTable, lookupHue, hueC, hueCycle, whiteSet,
  hueCycleOrder, hueIdx, equalHueCycle, computeHue, keyColorHex,
} from './render/colors.js';
import { sizeCanvas, getVisibleRange } from './render/canvas.js';
import { CW, CH, kbMinW, kbOffY } from './state/view.js';
import { selectedKeys, drawnKeys, setSelectedKeys, setDrawnKeys } from './state/selection.js';
import { SampleEngine } from './audio/samples.js';
import {
  AFTERTOUCH_RAMP_S,
  velocityBaseVol, aftertouchTargetGain, aftertouchHandoverDuration,
} from './audio/aftertouch.js';
import {
  SYSEX_MANU,
  SYSEX_CMD_CHANGE_KEY_NOTE, SYSEX_CMD_SET_COLOUR,
  SYSEX_CMD_SET_LIGHT_ON_KEYSTROKES, SYSEX_CMD_SET_AFTERTOUCH_FLAG,
  SYSEX_CMD_GET_FIRMWARE_REVISION,
  SYSEX_CMD_SET_FOOT_CONTROLLER_SENSITIVITY, SYSEX_CMD_INVERT_FOOT_CONTROLLER,
  SYSEX_CMD_CALIBRATE_EXPRESSION_PEDAL, SYSEX_CMD_RESET_EXPRESSION_PEDAL_BOUNDS,
  SYSEX_CMD_PERIPHERAL_CALIBRATION_DATA,
  SYSEX_NACK, SYSEX_ACK, SYSEX_BUSY,
  sysexBoardMap, fixedMidiChannelMap,
  buildNoteSysEx, buildColorSysEx, buildToggleSysEx, buildRequestSysEx,
} from './lumatone/protocol.js';

/* ── audio engine ── */
var audioCtx=null,oscGain=null,squareGain=null,activeOscs={},audioEnabled=false;
var wfLoadingKey=null;
var activeWaveform='triangle';
var keyVelocity={}; /* "q,r" → velocity (0-127), populated by MIDI input */
var sustainPedalDown=false;
var sustainedKeys=new Set(); /* keys held only by the sustain pedal */
/* Re-articulation flash: when a MIDI strike arrives on a key that's already
   sounding (typically sustain-captured), we stop the old voice and start a
   fresh one. This map holds "q,r" → performance.now() expiry timestamps so
   draw() can briefly render those keys as unselected, producing a visible
   off-on blink to confirm the re-trigger. */
var rearticulateFlashUntil={};
var REARTICULATE_FLASH_MS=60;
function triggerRearticulateFlash(key){
  rearticulateFlashUntil[key]=performance.now()+REARTICULATE_FLASH_MS;
  setTimeout(draw,REARTICULATE_FLASH_MS+5);
}
var aftertouchSnapshot={};            /* "q,r" → latest pressure value (for debug polling) */
function instrIsSample(){return !!SampleEngine.INSTRUMENTS[activeWaveform];}
function instrDecays(){var i=SampleEngine.INSTRUMENTS[activeWaveform];return i?!!i.decays:false;}
function initAudio(){
  if(audioCtx)return;
  /* Force 44.1 kHz to match native mp3 sample rate; avoids Web Audio resampling
     (which would skew period calculations in prepareLoop on 48kHz systems). */
  var ACtor=window.AudioContext||window.webkitAudioContext;
  try{audioCtx=new ACtor({sampleRate:44100});}
  catch(e){audioCtx=new ACtor();} /* fallback if sampleRate option unsupported */
  if(audioCtx.sampleRate!==44100){
    console.warn('AudioContext sampleRate is '+audioCtx.sampleRate+' (requested 44100). '+
      'Precomputed loop points were generated for 44100Hz; sample splices may click '+
      'because loop-point times will map to non-zero-crossing samples after resampling.');
  } else {
    console.log('AudioContext sampleRate: 44100 ✓');
  }
  oscGain=audioCtx.createGain();oscGain.gain.value=0.35;oscGain.connect(audioCtx.destination);
  squareGain=audioCtx.createGain();squareGain.gain.value=0.25;squareGain.connect(audioCtx.destination);
  SampleEngine.init(audioCtx,audioCtx.destination); /* sampleMaster at 0.9 */
}
function noteOn(key,velocity){
  if(!audioEnabled||!audioCtx)return;
  if(activeOscs[key])return;
  var parts=key.split(','),q=+parts[0],r=+parts[1];
  var freq=keyFreq(q,r);
  var wf=activeWaveform;
  if(instrIsSample()&&SampleEngine.isInstrumentLoaded(wf)){
    SampleEngine.setInstrument(wf);
    /* Velocity drives initial volume (via baseVol in segGain); pressureGain stays
       at 1.0 until the first aftertouch message for a sustained instrument, then
       ramps to the aftertouch-dictated gain. */
    SampleEngine.noteOn(key,freq,velocity||100);
    activeOscs[key]={type:'sample',freq:freq};
  } else if(!instrIsSample()){
    var type=wf;
    var osc=audioCtx.createOscillator();
    var gain=audioCtx.createGain();
    osc.type=type;osc.frequency.value=freq;
    var simple=(type==='sine'||type==='triangle');
    var vol=simple?0.7:0.3;
    if(simple){var boost=Math.min(3,Math.sqrt(440/freq));vol*=boost;}
    var atk=simple?0.02:0.04;
    var now=audioCtx.currentTime;
    gain.gain.setValueAtTime(0,now);
    gain.gain.linearRampToValueAtTime(vol,now+atk);
    var dest=(type==='square')?squareGain:oscGain;
    /* pressureGain sits between envelope and bus — modulated by poly aftertouch.
       Initialized to 1.0 so the note plays at its envelope-driven volume until
       the first aftertouch message arrives (if any). */
    var pressureGain=audioCtx.createGain();pressureGain.gain.value=1.0;
    osc.connect(gain);gain.connect(pressureGain);pressureGain.connect(dest);
    osc.start(now);
    activeOscs[key]={type:'osc',osc:osc,gain:gain,pressureGain:pressureGain,vol:vol};
  }
}
function noteOff(key){
  var e=activeOscs[key];if(!e)return;
  if(e.type==='sample'){
    SampleEngine.noteOff(key);
  } else {
    var now=audioCtx.currentTime;
    e.gain.gain.cancelScheduledValues(now);
    e.gain.gain.setValueAtTime(e.gain.gain.value,now);
    e.gain.gain.linearRampToValueAtTime(0,now+0.06);
    e.osc.stop(now+0.08);
  }
  delete activeOscs[key];
  delete aftertouchSnapshot[key];
}
function stopAllNotes(){for(var k in activeOscs)noteOff(k);}
function handleAftertouch(key,pressure){
  if(!audioEnabled||!audioCtx||instrDecays())return;
  var e=activeOscs[key];if(!e)return;
  var strikeVel=keyVelocity[key]!==undefined?keyVelocity[key]:100;
  var target=aftertouchTargetGain(pressure,strikeVel);
  var now=audioCtx.currentTime;
  var wasSeen=!!e.aftertouchSeen;
  var dur;
  if(!wasSeen){
    /* first aftertouch for this voice → schedule the handover ramp */
    e.aftertouchSeen=true;
    dur=aftertouchHandoverDuration(target);
    e.handoverEndTime=now+dur;
  } else if(e.handoverEndTime!==undefined&&now<e.handoverEndTime){
    /* still inside the handover window — use remaining time so the travel
       duration is preserved even as subsequent messages adjust the target */
    dur=Math.max(AFTERTOUCH_RAMP_S,e.handoverEndTime-now);
  } else {
    /* past the handover → short smoothing ramp tracks pressure changes */
    dur=AFTERTOUCH_RAMP_S;
  }
  if(e.type==='sample'){
    SampleEngine.setAftertouch(key,target,dur);
  } else if(e.type==='osc'&&e.pressureGain){
    e.pressureGain.gain.cancelScheduledValues(now);
    e.pressureGain.gain.setValueAtTime(e.pressureGain.gain.value,now);
    e.pressureGain.gain.linearRampToValueAtTime(target,now+dur);
  }
}
function replayActiveNotes(){
  var keys=Object.keys(activeOscs);
  keys.forEach(function(k){noteOff(k);});
  keys.forEach(function(k){noteOn(k,keyVelocity[k]);});
}
function syncAudio(){
  if(!audioEnabled){stopAllNotes();return;}
  for(var k in activeOscs){if(!selectedKeys.has(k)&&!sustainedKeys.has(k))noteOff(k);}
  selectedKeys.forEach(function(k){if(!activeOscs[k])noteOn(k,keyVelocity[k]);});
}
function toggleAudio(){
  audioEnabled=document.getElementById('cbAudio').checked;
  if(audioEnabled){initAudio();if(audioCtx.state==='suspended')audioCtx.resume();syncAudio();}
  else{stopAllNotes();}
}
function wfStartLoading(sel,total){
  sel.classList.add('wf-loading');sel.disabled=true;
  var opt=sel.options[sel.selectedIndex];
  opt.dataset.origText=opt.textContent;
  opt.textContent='0/'+total;
}
function wfUpdateLoading(sel,loaded,total){
  sel.options[sel.selectedIndex].textContent=loaded+'/'+total;
}
function wfFinishLoading(sel,success){
  sel.classList.remove('wf-loading');sel.disabled=false;
  for(var i=0;i<sel.options.length;i++){
    var ot=sel.options[i].dataset.origText;
    if(ot){sel.options[i].textContent=ot;delete sel.options[i].dataset.origText;}
  }
  if(!success)sel.value=activeWaveform;
  wfLoadingKey=null;
}
function changeWaveform(){
  var sel=document.getElementById('waveform');
  var wf=sel.value;
  sel.blur();
  if(wfLoadingKey)return;
  /* auto-enable audio */
  if(!audioEnabled){
    document.getElementById('cbAudio').checked=true;
    audioEnabled=true;
    initAudio();if(audioCtx.state==='suspended')audioCtx.resume();
  }
  var instr=SampleEngine.INSTRUMENTS[wf];
  if(instr&&!SampleEngine.isInstrumentLoaded(wf)){
    /* on-demand load with progress — don't touch current audio until success */
    wfLoadingKey=wf;
    initAudio();
    wfStartLoading(sel,instr.samples.length);
    SampleEngine.loadInstrument(wf,function(loaded,tot){
      wfUpdateLoading(sel,loaded,tot);
    }).then(function(){
      console.log(instr.name+' loaded');
      wfFinishLoading(sel,true);
      activeWaveform=wf;
      var playing=Object.keys(activeOscs);
      playing.forEach(function(k){noteOff(k);});
      playing.forEach(function(k){noteOn(k,keyVelocity[k]);});
    }).catch(function(err){
      console.error((instr.name||wf)+' load failed:',err);
      SampleEngine.unloadInstrument(wf); /* ensure no partial buffers linger */
      wfFinishLoading(sel,false);
    });
    return;
  }
  /* already loaded or oscillator — switch immediately */
  activeWaveform=wf;
  var playing=Object.keys(activeOscs);
  playing.forEach(function(k){noteOff(k);});
  playing.forEach(function(k){noteOn(k,keyVelocity[k]);});
}

/* sustain pedal: hold notes that would otherwise release */
function sustainPedalOn(){sustainPedalDown=true;}
function sustainPedalOff(){
  sustainPedalDown=false;
  if(sustainedKeys.size===0)return;
  sustainedKeys.forEach(function(k){selectedKeys.delete(k);delete keyVelocity[k];});
  sustainedKeys.clear();
  syncOutput();draw();
}
/* trigger initial instrument load (piano is default selected) */
initAudio();
changeWaveform();
/* ramp active voices — or retrigger for decaying instruments */
function rampActiveFreqs(dur){
  if(!audioEnabled||!audioCtx)return;
  if(instrDecays()){replayActiveNotes();return;}
  var now=audioCtx.currentTime;
  for(var k in activeOscs){
    var p=k.split(','),e=activeOscs[k];
    if(e.type==='osc'){
      e.osc.frequency.setValueAtTime(e.osc.frequency.value,now);
      e.osc.frequency.exponentialRampToValueAtTime(keyFreq(+p[0],+p[1]),now+dur);
    } else if(e.type==='sample'){
      SampleEngine.rampFreq(k,keyFreq(+p[0],+p[1]),dur);
    }
  }
}
function setTuning(){
  var val=document.getElementById('selTuning').value;
  setEqualEnabled(val==='E');
  setSeptimalEnabled(val==='7');
  document.getElementById('seamShiftCtrl').style.display=septimalEnabled?'':'none';
  rampActiveFreqs(0.15);
  hexDirty=true;
  draw();
  syncLumatoneColors();
  document.getElementById('selTuning').blur();
}
function shiftSeams(dir){
  setSeptimalShift(((septimalShift+dir+21)%42+42)%42-21);
  document.getElementById('seamShiftInd').textContent=septimalShift;
  rampActiveFreqs(0.15);
  hexDirty=true;
  draw();
}
/* key-repeat for seam shift buttons */
(function(){
  var tid=null,iid=null;
  function startRepeat(dir){
    stopRepeat();
    shiftSeams(dir);
    tid=setTimeout(function(){iid=setInterval(function(){shiftSeams(dir);},80);},400);
  }
  function stopRepeat(){
    /* only fire sync if a repeat was actually active — this runs on every document mouseup */
    var wasActive=!!(tid||iid);
    if(tid){clearTimeout(tid);tid=null;}
    if(iid){clearInterval(iid);iid=null;}
    if(wasActive)syncLumatoneColors();
  }
  ['btnSeamUp','btnSeamDn'].forEach(function(id){
    var dir=id==='btnSeamUp'?1:-1;
    var el=document.getElementById(id);
    el.addEventListener('mousedown',function(e){e.preventDefault();startRepeat(dir);});
    el.addEventListener('touchstart',function(e){e.preventDefault();startRepeat(dir);},{passive:false});
  });
  document.addEventListener('mouseup',stopRepeat);
  document.addEventListener('touchend',stopRepeat);
})();

/* ── chord transposition ── */
function transposeSelection(dq,dr){
  if(selectedKeys.size===0)return;
  /* vertical bounds check — block if any note's center would leave the canvas */
  var cyC=CH/2+kbOffY;
  var vq=layoutShifts[curLayout][0],vr=layoutShifts[curLayout][1];
  var blocked=false;
  selectedKeys.forEach(function(key){
    var p=key.split(','),nq=+p[0]+dq,nr=+p[1]+dr;
    var ux=(nq-vq)*dxH+(nr-vr)*dxH*0.5,uy=-(nr-vr)*dyH;
    var sy=-ux*sinT+uy*cosT+cyC;
    if(sy<0||sy>CH)blocked=true;
  });
  if(blocked)return;
  /* re-key audio */
  if(audioEnabled&&audioCtx){
    if(instrDecays()){
      /* decaying instrument: stop old, let syncAudio retrigger after selection shift */
      for(var k in activeOscs)noteOff(k);
      activeOscs={};
    } else {
      /* sustained instrument: smooth ramp */
      var newOscs={},sampleMoves=[];
      var now=audioCtx.currentTime;
      for(var k in activeOscs){
        var p=k.split(','),nq=+p[0]+dq,nr=+p[1]+dr;
        var e=activeOscs[k];
        if(e.type==='osc'){
          e.osc.frequency.setValueAtTime(e.osc.frequency.value,now);
          e.osc.frequency.exponentialRampToValueAtTime(keyFreq(nq,nr),now+0.1);
          newOscs[nq+','+nr]=e;
        } else if(e.type==='sample'){
          sampleMoves.push({oldKey:k,newKey:nq+','+nr,newFreq:keyFreq(nq,nr)});
        }
      }
      sampleMoves.forEach(function(m){m.vol=SampleEngine.slideAndFadeOut(m.oldKey,m.newFreq,0.1);});
      sampleMoves.forEach(function(m){SampleEngine.noteOnFaded(m.newKey,m.newFreq,m.vol,0.1);newOscs[m.newKey]={type:'sample',freq:m.newFreq};});
      activeOscs=newOscs;
    }
  }
  /* shift selection */
  var shifted=new Set();
  selectedKeys.forEach(function(k){var p=k.split(',');shifted.add((+p[0]+dq)+','+(+p[1]+dr));});
  setSelectedKeys(shifted);
  stopAllMidi();syncMidi();
  if(instrDecays())syncAudio(); /* retrigger at new coords */
  draw();
}
/* key-repeat for transpose buttons */
(function(){
  var tid=null,iid=null;
  function startRepeat(dq,dr){
    stopRepeat();
    transposeSelection(dq,dr);
    tid=setTimeout(function(){iid=setInterval(function(){transposeSelection(dq,dr);},80);},400);
  }
  function stopRepeat(){if(tid){clearTimeout(tid);tid=null;}if(iid){clearInterval(iid);iid=null;}}
  document.querySelectorAll('.tpab[data-dq]').forEach(function(btn){
    var dq=+btn.dataset.dq,dr=+btn.dataset.dr;
    btn.addEventListener('mousedown',function(e){e.preventDefault();startRepeat(dq,dr);});
    btn.addEventListener('touchstart',function(e){e.preventDefault();startRepeat(dq,dr);},{passive:false});
  });
  document.addEventListener('mouseup',stopRepeat);
  document.addEventListener('touchend',stopRepeat);
})();

/* ── keyboard shortcuts ──
   ←/→  : switch horizontal layouts (♭ ♮ ♯) with wrap-around. Browser auto-repeat
          is capped by the running layout animation (~500ms), so holding the key
          gives one shift per animation cycle. Discrete presses faster than that
          still land as distinct shifts.
   ↑/↓  : septimal seam shift, only in 7-limit mode (no-op otherwise). Uses our
          own 400ms/80ms repeat timer to exactly match the mouse click-and-hold
          cadence; browser auto-repeat events are ignored.
   Form controls (INPUT/SELECT/TEXTAREA) with focus bypass the handler so arrow
   keys still navigate them normally. */
(function(){
  var layoutOrder=[2,1,3]; /* visual left→right: flat, natural, sharp */
  /* keyboard seam-shift repeat state — mirrors the mouse IIFE's 400ms/80ms */
  var seamTid=null,seamIid=null,seamActiveKey=null;
  function seamKbStart(dir,key){
    /* clear any prior timer state without invoking the sync-on-release —
       seamKbStop is for external callers (keyup, blur) only. */
    if(seamTid){clearTimeout(seamTid);seamTid=null;}
    if(seamIid){clearInterval(seamIid);seamIid=null;}
    seamActiveKey=key;
    shiftSeams(dir);
    seamTid=setTimeout(function(){
      seamIid=setInterval(function(){shiftSeams(dir);},80);
    },400);
  }
  function seamKbStop(){
    var wasActive=!!(seamTid||seamIid);
    if(seamTid){clearTimeout(seamTid);seamTid=null;}
    if(seamIid){clearInterval(seamIid);seamIid=null;}
    seamActiveKey=null;
    if(wasActive)syncLumatoneColors();
  }
  /* SELECT/TEXTAREA (and text-like INPUTs) keep native arrow-key navigation;
     checkboxes and radios fall through so our handler can take priority. */
  function shouldIgnore(){
    var ae=document.activeElement;
    if(!ae)return false;
    if(ae.tagName==='SELECT'||ae.tagName==='TEXTAREA')return true;
    if(ae.tagName==='INPUT'){
      var t=(ae.type||'').toLowerCase();
      return t!=='checkbox'&&t!=='radio'&&t!=='button'&&t!=='submit'&&t!=='reset';
    }
    return false;
  }
  window.addEventListener('keydown',function(e){
    if(shouldIgnore())return;
    if(e.ctrlKey||e.metaKey||e.altKey||e.shiftKey)return;
    var isArrow=(e.key==='ArrowLeft'||e.key==='ArrowRight'||e.key==='ArrowUp'||e.key==='ArrowDown');
    /* release focus from any checkbox/radio before acting so our arrow handler
       keeps priority on subsequent presses. Tab remains available for nav. */
    if(isArrow&&document.activeElement&&document.activeElement.blur){
      document.activeElement.blur();
    }
    switch(e.key){
      case 'ArrowLeft':
      case 'ArrowRight':{
        e.preventDefault();
        /* cap auto-repeat to one shift per animation cycle — keeps held-arrow
           smooth. Discrete keypresses (e.repeat===false) always go through. */
        if(e.repeat&&layoutAnimId!==null)break;
        var i=layoutOrder.indexOf(curLayout);
        var dir=e.key==='ArrowLeft'?-1:1;
        setLayout(layoutOrder[(i+dir+3)%3]);
        break;
      }
      case 'ArrowUp':
        if(septimalEnabled){
          e.preventDefault();
          /* ignore browser auto-repeat — our own timer handles repeat */
          if(!e.repeat)seamKbStart(1,'ArrowUp');
        }
        break;
      case 'ArrowDown':
        if(septimalEnabled){
          e.preventDefault();
          if(!e.repeat)seamKbStart(-1,'ArrowDown');
        }
        break;
    }
  });
  window.addEventListener('keyup',function(e){
    /* only stop if this keyup matches the key that started the repeat */
    if((e.key==='ArrowUp'||e.key==='ArrowDown')&&seamActiveKey===e.key){
      seamKbStop();
    }
  });
  /* if the window loses focus mid-hold, the keyup may never arrive — clean up */
  window.addEventListener('blur',seamKbStop);
})();

/* ── MIDI engine ── */
/* build scale degree lookup: enumerate all unique pitch classes across all layouts */
var degreeMap={};
(function(){
  var pcList=[];var pcSeen={};
  [1,2,3].forEach(function(li){
    var sh=layoutShifts[li];
    baseKeys.forEach(function(k){
      var q=k[0]+sh[0],r=k[1]+sh[1];
      var p=posInBand(q)-1;
      var pk=r+','+p;
      if(!pcSeen[pk]){
        pcSeen[pk]=true;
        var cents=1200*(p*Math.log2(5/4)+r*Math.log2(3/2));
        cents=((cents%1200)+1200)%1200;
        pcList.push({pk:pk,cents:cents});
      }
    });
  });
  pcList.sort(function(a,b){return a.cents-b.cents;});
  pcList.forEach(function(pc,i){degreeMap[pc.pk]=i;});
})();

function keyToMidi(q,r){
  var p=posInBand(q)-1;
  var deg=degreeMap[r+','+p];
  if(deg===undefined)return null;
  var ratio=keyFreq(q,r)/220;
  var oct=Math.floor(Math.log2(ratio)+0.0001);
  var ch=oct+6;
  if(ch<1||ch>10)return null;
  return{note:deg,channel:ch};
}

/* reverse lookup: (note,channel) → "q,r" for MIDI input */
var midiToKey={};
function buildMidiReverse(){
  midiToKey={};
  var sh=layoutShifts[curLayout];
  baseKeys.forEach(function(k){
    var q=k[0]+sh[0],r=k[1]+sh[1];
    var m=keyToMidi(q,r);
    if(m)midiToKey[m.note+','+m.channel]=q+','+r;
  });
}
buildMidiReverse();

var midiAccess=null,midiOut=null,midiIn=null,activeMidiNotes={};

function midiNoteOn(key){
  if(!midiOut)return;
  var parts=key.split(',');
  var m=keyToMidi(+parts[0],+parts[1]);
  if(!m)return;
  midiOut.send([0x90+(m.channel-1),m.note,100]);
  activeMidiNotes[key]=m;
}
function midiNoteOff(key){
  var m=activeMidiNotes[key];
  if(!m||!midiOut)return;
  midiOut.send([0x80+(m.channel-1),m.note,0]);
  delete activeMidiNotes[key];
}
function stopAllMidi(){for(var k in activeMidiNotes)midiNoteOff(k);}
function syncMidi(){
  if(!midiOut){stopAllMidi();return;}
  for(var k in activeMidiNotes){if(!selectedKeys.has(k))midiNoteOff(k);}
  selectedKeys.forEach(function(k){if(!activeMidiNotes[k])midiNoteOn(k);});
}

function syncOutput(){syncAudio();syncMidi();}

function updateMidiPorts(){
  /* no-op: replaced by findLumatone auto-detect */
}
function findLumatone(){
  if(!midiAccess)return;
  var foundOut=null,foundIn=null;
  midiAccess.outputs.forEach(function(port){
    if(!foundOut&&port.name&&port.name.indexOf('Lumatone')!==-1&&port.state==='connected')foundOut=port;
  });
  midiAccess.inputs.forEach(function(port){
    if(!foundIn&&port.name&&port.name.indexOf('Lumatone')!==-1&&port.state==='connected')foundIn=port;
  });
  /* update output */
  var oldOut=midiOut;
  midiOut=foundOut||null;
  if(!midiOut&&oldOut){
    /* Lost connection: cancel any in-flight work and forget device state */
    stopAllMidi();
    sysexCancelAll();
    deviceColors=null;
    fixedLayoutSent=false;
  } else if(midiOut&&midiOut!==oldOut){
    syncMidi();
  }
  /* update input */
  if(midiIn)midiIn.onmidimessage=null;
  midiIn=foundIn||null;
  if(midiIn)midiIn.onmidimessage=handleMidiMessage;
  /* update UI */
  var statusEl=document.getElementById('lumaStatus');
  if(midiOut){
    var isNewConnection=!oldOut||oldOut!==midiOut;
    statusEl.textContent='Lumatone Connected';
    statusEl.className='luma-connected';
    if(isNewConnection){
      /* Silent firmware probe, then (only if user opted in) sync colors.
         We DO NOT auto-configure the device without Auto-sync checked. */
      queryFirmwareRevision();
      if(autoSyncEnabled)syncLumatoneColors();
    }
  } else {
    statusEl.textContent='Lumatone Not Connected';
    statusEl.className='luma-disconnected';
  }
  console.log('Lumatone search: out='+(midiOut?midiOut.name:'none')+', in='+(midiIn?midiIn.name:'none'));
}
function setMidiOutput(){
  /* no-op: replaced by findLumatone auto-detect */
}
function setMidiInput(){
  /* no-op: replaced by findLumatone auto-detect */
}
/* fixed MIDI: (channel 1-5, note 0-55) → baseKeys index → lattice (q,r) */
function fixedMidiToKey(ch,note){
  var idx=(ch-1)*56+note;
  if(idx<0||idx>=280)return null;
  var base=baseKeys[idx];
  var sh=layoutShifts[curLayout];
  return(base[0]+sh[0])+','+(base[1]+sh[1]);
}
function handleMidiMessage(e){
  /* route SysEx responses to push-color ACK handler, except spontaneous
     calibration packets (CMD 3Eh) which are not ACKs to a sent message
     but periodic firmware status emissions during calibration mode. */
  if(e.data[0]===0xF0){
    if(e.data.length>=6
       && e.data[1]===SYSEX_MANU[0] && e.data[2]===SYSEX_MANU[1] && e.data[3]===SYSEX_MANU[2]
       && e.data[5]===SYSEX_CMD_PERIPHERAL_CALIBRATION_DATA){
      handleCalibrationPacket(e.data);
      return;
    }
    sysexHandleResponse(e.data);
    return;
  }
  var status=e.data[0]&0xf0;
  var ch=(e.data[0]&0x0f)+1;
  var d1=e.data[1];
  var d2=e.data.length>2?e.data[2]:0;
  /* CC messages: handle sustain pedal (CC 64, sustain jack) and
     foot controller (CC 4, expression jack). The expression pedal's CC#
     is hardcoded to 4 in firmware and cannot be remapped via SysEx, so
     we route it here. For now both pedals collapse to the existing
     binary sustainPedalDown via a 0.5 threshold; continuous-damper
     audio modeling is a later v0.9 task once calibration is verified. */
  if(status===0xB0){
    if(d1===4){
      /* CC 4: expression pedal. Log every value during calibration mode
         (or first transition outside cal mode), and apply binary fallback. */
      var now=performance.now();
      var dt=lastCC4Time?(now-lastCC4Time):0;
      var changed=lastCC4Value!==d2;
      lastCC4Value=d2;lastCC4Time=now;
      if(pedalDebug){
        console.log('[Pedal CC4] value='+d2+' (depth='+(d2/127).toFixed(3)+')'
                    +(dt>0?' Δt='+dt.toFixed(0)+'ms':'')
                    +' ch='+ch);
        var liveEl=document.getElementById('calibLive');
        if(liveEl)liveEl.textContent=d2;
      } else if(changed&&(d2===0||d2===127)){
        /* outside cal mode, only log endpoint hits to keep console clean */
        console.log('[Pedal CC4] '+d2+' (ch='+ch+')');
      }
      /* binary fallback: depth >= 0.5 holds sustain. Mirrors CC 64 behavior. */
      if(d2>=64)sustainPedalOn();else sustainPedalOff();
      return;
    }
    if(d1===64){
      if(pedalDebug)console.log('[Pedal CC64] '+d2+' (ch='+ch+')');
      if(d2>=64)sustainPedalOn();else sustainPedalOff();
    }
    return;
  }
  /* Polyphonic aftertouch (0xA0): modulate per-voice volume via pressureGain */
  if(status===0xA0){
    var atKey=fixedMidiToKey(ch,d1);
    if(atKey){
      aftertouchSnapshot[atKey]=d2;
      handleAftertouch(atKey,d2);
    }
    return;
  }
  /* Note messages */
  var key=fixedMidiToKey(ch,d1);
  if(!key)return;
  if(status===0x90&&d2>0){
    if(activeOscs[key]){
      /* Voice is already playing — typically because sustain pedal is holding it.
         Stop the old voice so syncAudio creates a fresh one with the new velocity,
         and flash the selection briefly to confirm the re-trigger. */
      noteOff(key);
      triggerRearticulateFlash(key);
    }
    sustainedKeys.delete(key); /* re-struck while sustained → back to normal */
    selectedKeys.add(key);
    keyVelocity[key]=d2;
  } else if(status===0x80||(status===0x90&&d2===0)){
    if(sustainPedalDown){
      /* pedal is held — keep note sounding, mark as sustained */
      sustainedKeys.add(key);
    } else {
      selectedKeys.delete(key);
      delete keyVelocity[key];
    }
  } else return;
  syncOutput();
  draw();
}
/* ══════════════════════════════════════════════════════════════════════════
   Lumatone SysEx — live auto-sync architecture (v0.8)
   ──────────────────────────────────────────────────────────────────────────
   Protocol: F0 00 21 50 <board> <cmd> <data...> F7
     CHANGE_KEY_NOTE (0x00): configure (note, channel, keyType) per key
     SET_KEY_COLOUR (0x01): extended 8-bit color as 6 nibbles (RR GG BB)
     SET_AFTERTOUCH_FLAG (0x0E): enable polyphonic aftertouch globally
     SET_LIGHT_ON_KEYSTROKES (0x07): LED feedback on keypress
     GET_FIRMWARE_REVISION (0x31): returns major/minor/revision
   Boards 3 & 4 physically swapped → baseKeys groups 3,4 map to SysEx 5,4.
   Single-message-in-flight ACK queue; new syncs swap the queue in place
   (in-flight message completes naturally — Option B).
   ══════════════════════════════════════════════════════════════════════════ */

/* queue + in-flight state */
var sysexQueue=[];         /* array of Uint8Array messages */
var sysexWaiting=null;     /* message currently awaiting ACK */
var sysexTimer=null;       /* timeout id for ACK wait */
var sysexBusyTimer=null;   /* timeout id for busy-retry delay */
var pushTotal=0,pushSent=0,pushInProgress=false;
var pushSilent=false;      /* true = skip UI updates (e.g. firmware query) */
var SYSEX_TIMEOUT_MS=2000;
var SYSEX_BUSY_DELAY_MS=500;
var SYSEX_NOINPUT_DELAY_MS=35; /* fire-and-forget delay when no MIDI input */

/* sync state — what we believe is on the device right now */
var autoSyncEnabled=false;   /* user's Auto-sync checkbox state */
var deviceColors=null;       /* 280-length array of '#RRGGBB' or null for unknown */
var fixedLayoutSent=false;   /* true after CHANGE_KEY_NOTE × 280 + flags sent this connection */


/* ── queue machinery ─────────────────────────────────────────────────── */

function sysexSendNext(){
  if(sysexQueue.length===0){
    sysexWaiting=null;
    if(pushInProgress)pushFinish(true);
    return;
  }
  sysexWaiting=sysexQueue.shift();
  if(!midiOut){sysexWaiting=null;if(pushInProgress)pushFinish(false);return;}
  midiOut.send(sysexWaiting);
  pushSent++;
  pushUpdateUI();
  /* if no MIDI input for ACK, use fixed delay and best-effort device state update */
  if(!midiIn){
    sysexTimer=setTimeout(function(){
      sysexTimer=null;
      if(sysexWaiting&&sysexWaiting.keyIdx!==undefined&&deviceColors){
        deviceColors[sysexWaiting.keyIdx]=sysexWaiting.color;
      }
      sysexWaiting=null;
      sysexSendNext();
    },SYSEX_NOINPUT_DELAY_MS);
  } else {
    sysexTimer=setTimeout(sysexOnTimeout,SYSEX_TIMEOUT_MS);
  }
}

function sysexHandleResponse(data){
  if(!sysexWaiting)return;
  /* verify manufacturer ID + board + command match */
  if(data.length<7)return;
  if(data[1]!==SYSEX_MANU[0]||data[2]!==SYSEX_MANU[1]||data[3]!==SYSEX_MANU[2])return;
  if(data[4]!==sysexWaiting[4]||data[5]!==sysexWaiting[5])return;
  clearTimeout(sysexTimer);sysexTimer=null;
  var status=data[6];
  /* one-shot response callback (firmware query, etc.) */
  if(sysexWaiting.onResponse){
    try{sysexWaiting.onResponse(data);}catch(e){console.error(e);}
  }
  if(status===SYSEX_BUSY){
    /* retry after delay */
    sysexBusyTimer=setTimeout(function(){
      sysexBusyTimer=null;
      if(!midiOut){if(pushInProgress)pushFinish(false);return;}
      pushSent--; /* don't double-count */
      sysexQueue.unshift(sysexWaiting);
      sysexWaiting=null;
      sysexSendNext();
    },SYSEX_BUSY_DELAY_MS);
  } else {
    /* ACK, NACK, ERROR, STATE — move on (don't retry NACK/ERROR forever) */
    if(status===SYSEX_ACK&&sysexWaiting.keyIdx!==undefined&&deviceColors){
      deviceColors[sysexWaiting.keyIdx]=sysexWaiting.color;
    }
    sysexWaiting=null;
    sysexSendNext();
  }
}

function sysexOnTimeout(){
  sysexTimer=null;
  console.warn('SysEx: no response (timeout), continuing');
  sysexWaiting=null;
  sysexSendNext();
}

function sysexCancelAll(){
  clearTimeout(sysexTimer);sysexTimer=null;
  clearTimeout(sysexBusyTimer);sysexBusyTimer=null;
  sysexQueue=[];sysexWaiting=null;
  if(pushInProgress)pushFinish(false);
}

function pushUpdateUI(){
  var el=document.getElementById('syncStatus');
  if(!el)return;
  if(pushInProgress&&!pushSilent){
    el.textContent=pushSent+'/'+pushTotal;
    el.classList.add('pushing');
  } else {
    el.textContent='Idle';
    el.classList.remove('pushing');
  }
}

function pushFinish(ok){
  pushInProgress=false;
  pushSilent=false;
  pushUpdateUI();
  if(ok)console.log('Sync complete: '+pushSent+' messages sent');
  else console.warn('Sync aborted');
}

/* ── entry points ────────────────────────────────────────────────────── */

/* Query firmware revision silently at connect time; log result. */
function queryFirmwareRevision(){
  if(!midiOut)return;
  var msg=buildRequestSysEx(SYSEX_CMD_GET_FIRMWARE_REVISION);
  msg.onResponse=function(data){
    /* Response: F0 00 21 50 00 31 <ack> <major> <minor> <revision> F7 */
    if(data[6]===SYSEX_ACK&&data.length>=11){
      console.log('Lumatone firmware: v'+data[7]+'.'+data[8]+'.'+data[9]);
    } else if(data[6]===SYSEX_NACK){
      console.log('Lumatone firmware query: not acknowledged (pre-1.0.8 firmware?)');
    } else {
      console.log('Lumatone firmware query: unexpected response status 0x'+data[6].toString(16));
    }
  };
  /* Append to queue. If idle, start a silent push; otherwise it rides along. */
  if(!pushInProgress){
    sysexQueue=[msg];
    pushTotal=1;pushSent=0;
    pushInProgress=true;pushSilent=true;
    pushUpdateUI();
    sysexSendNext();
  } else {
    sysexQueue.push(msg);
    pushTotal++;
    pushUpdateUI();
  }
}

/* ── pedal calibration (v0.9) ────────────────────────────────────────────
   The Lumatone firmware exposes a calibration mode for the expression
   pedal jack: while active, it samples the ADC continuously and emits
   spontaneous CMD 3Eh status packets every 100ms with the running
   min/max ADC bounds plus a "valid" flag. Stopping calibration commits
   the learned bounds to firmware. CC 4 (Foot Controller) is the runtime
   output channel; this is hardcoded in firmware and not user-configurable.
   ──────────────────────────────────────────────────────────────────────── */
var pedalCalibrating=false;       /* true while CMD 38h is in "on" state */
var pedalDebug=false;              /* verbose console logging — auto-on during cal */
var pedalCalLastMin=null;          /* last reported ADC min from CMD 3Eh */
var pedalCalLastMax=null;          /* last reported ADC max from CMD 3Eh */
var pedalCalLastValid=null;        /* last "valid" flag from CMD 3Eh */
var pedalCalPacketCount=0;         /* count of 3Eh packets received this session */
var lastCC4Value=null;             /* most recent CC 4 (expression pedal) value */
var lastCC4Time=0;                 /* timestamp of last CC 4 (for rate calc) */

/* Enqueue an arbitrary SysEx message for sending. Mirrors the
   queryFirmwareRevision pattern: starts a silent push if idle, or
   appends to the existing queue if a push is already running. */
function sysexEnqueueControl(msg){
  if(!midiOut)return false;
  if(!pushInProgress){
    sysexQueue=[msg];
    pushTotal=1;pushSent=0;
    pushInProgress=true;pushSilent=true;
    pushUpdateUI();
    sysexSendNext();
  } else {
    sysexQueue.push(msg);
    pushTotal++;
    pushUpdateUI();
  }
  return true;
}

function togglePedalCalibration(){
  if(pedalCalibrating)stopPedalCalibration();
  else startPedalCalibration();
}

function startPedalCalibration(){
  if(!midiOut){
    console.warn('[Pedal Cal] No Lumatone connected — cannot start calibration');
    return;
  }
  pedalCalibrating=true;
  pedalDebug=true;
  pedalCalLastMin=null;
  pedalCalLastMax=null;
  pedalCalLastValid=null;
  pedalCalPacketCount=0;
  console.log('[Pedal Cal] ▶ Starting calibration mode — sweep pedal full range repeatedly');
  console.log('[Pedal Cal] Sending CMD 38h (CALIBRATE_EXPRESSION_PEDAL) value=1');
  sysexEnqueueControl(buildToggleSysEx(SYSEX_CMD_CALIBRATE_EXPRESSION_PEDAL, true));
  /* UI updates */
  var btn=document.getElementById('btnCalibPedal');
  if(btn){btn.textContent='Stop Calibration';btn.classList.add('active');}
  var panel=document.getElementById('calibPanel');
  if(panel)panel.classList.add('active');
  updateCalibUI();
}

function stopPedalCalibration(){
  if(!pedalCalibrating)return;
  console.log('[Pedal Cal] ■ Stopping calibration mode — bounds will be committed to firmware');
  console.log('[Pedal Cal] Sending CMD 38h (CALIBRATE_EXPRESSION_PEDAL) value=0');
  console.log('[Pedal Cal] Session totals: '+pedalCalPacketCount+' calibration packets, '
              +'final min='+pedalCalLastMin+' max='+pedalCalLastMax+' valid='+pedalCalLastValid);
  if(midiOut)sysexEnqueueControl(buildToggleSysEx(SYSEX_CMD_CALIBRATE_EXPRESSION_PEDAL, false));
  pedalCalibrating=false;
  pedalDebug=false;
  /* UI updates */
  var btn=document.getElementById('btnCalibPedal');
  if(btn){btn.textContent='Calibrate Pedal';btn.classList.remove('active');}
  var panel=document.getElementById('calibPanel');
  if(panel)panel.classList.remove('active');
}

function resetPedalBounds(){
  if(!midiOut){
    console.warn('[Pedal Cal] No Lumatone connected — cannot reset bounds');
    return;
  }
  console.log('[Pedal Cal] ↻ Resetting expression pedal bounds to factory defaults');
  console.log('[Pedal Cal] Sending CMD 39h (RESET_EXPRESSION_PEDAL_BOUNDS)');
  sysexEnqueueControl(buildRequestSysEx(SYSEX_CMD_RESET_EXPRESSION_PEDAL_BOUNDS));
}

/* Parse spontaneous CMD 3Eh calibration status packet.
   Format (inferred from Terpstra firmware unpackExpressionPedalCalibrationPayload):
     F0 00 21 50 <board> 3E <ack> <calib_mode> <12-bit nibbles...> F7
   The 12-bit values are packed as 3 nibbles each. minBound = first 12-bit,
   maxBound = second 12-bit, valid flag is a separate byte further into
   the payload. We log the raw bytes so any parser drift can be diagnosed. */
function handleCalibrationPacket(data){
  pedalCalPacketCount++;
  /* Log raw payload for diagnostic purposes — first packet always, then every 10th */
  if(pedalCalPacketCount===1||pedalCalPacketCount%10===0){
    var hex=[];
    for(var i=0;i<data.length;i++)hex.push(('0'+data[i].toString(16)).slice(-2));
    console.log('[Pedal Cal 3Eh #'+pedalCalPacketCount+'] raw: '+hex.join(' '));
  }
  /* Defensive parse: payload starts after F0 + 3 manu + board + cmd = byte 6.
     Byte 6 is typically ack/status byte. Calibration data follows from byte 7+. */
  if(data.length<13){
    if(pedalDebug)console.warn('[Pedal Cal 3Eh] packet too short ('+data.length+' bytes), skipping parse');
    return;
  }
  /* Try to extract two 12-bit values from nibbles starting at offset 7.
     Each value = (hi<<8) | (mid<<4) | lo from 3 successive bytes. */
  var off=7;
  var minBound=((data[off]&0xF)<<8)|((data[off+1]&0xF)<<4)|(data[off+2]&0xF);
  var maxBound=((data[off+3]&0xF)<<8)|((data[off+4]&0xF)<<4)|(data[off+5]&0xF);
  /* "valid" flag: location uncertain in firmware spec; try byte 13 (just after
     the two 12-bit values) and fall back to logging if it looks wrong. */
  var validByte=data.length>13?data[13]:0;
  /* Detect spurious large values — if either bound exceeds 12-bit max (4095),
     our parse offset is probably wrong. Log for diagnosis. */
  if(minBound>0xFFF||maxBound>0xFFF){
    if(pedalDebug)console.warn('[Pedal Cal 3Eh] suspicious bounds (min='+minBound+' max='+maxBound
                               +'), parse offset may be wrong — please check raw bytes above');
  }
  pedalCalLastMin=minBound;
  pedalCalLastMax=maxBound;
  pedalCalLastValid=validByte;
  updateCalibUI();
}

function updateCalibUI(){
  var minEl=document.getElementById('calibMin');
  var maxEl=document.getElementById('calibMax');
  var validEl=document.getElementById('calibValid');
  if(minEl)minEl.textContent=pedalCalLastMin!==null?pedalCalLastMin:'----';
  if(maxEl)maxEl.textContent=pedalCalLastMax!==null?pedalCalLastMax:'----';
  if(validEl){
    validEl.textContent=pedalCalLastValid!==null?pedalCalLastValid:'-';
    validEl.classList.toggle('valid',pedalCalLastValid===1);
    validEl.classList.toggle('invalid',pedalCalLastValid===0);
  }
}

/* Unified sync entry point. Builds the full queue (setup if needed + color diff),
   then either starts sending or swaps the queue if a push is already running. */
function syncLumatoneColors(){
  if(!midiOut||!autoSyncEnabled)return;

  /* Compute target colors for all 280 physical keys */
  var sh=layoutShifts[curLayout];
  var target=[];
  for(var i=0;i<280;i++){
    var q=baseKeys[i][0]+sh[0],r=baseKeys[i][1]+sh[1];
    target.push(keyColorHex(q,r));
  }
  if(!deviceColors)deviceColors=new Array(280).fill(null);

  /* Predicted post-ACK deviceColors: factor in the in-flight message.
     Without this, a color message on the wire can ACK after our new queue is
     already built, landing its (now-obsolete) color on the device and leaving
     that key stuck — because the new diff saw deviceColors before the ACK
     and decided the key didn't need an update. Prediction closes that race. */
  var predicted=deviceColors;
  if(sysexWaiting&&sysexWaiting.keyIdx!==undefined){
    predicted=deviceColors.slice();
    predicted[sysexWaiting.keyIdx]=sysexWaiting.color;
  }

  var newQ=[];

  /* One-time setup: fixed MIDI layout + aftertouch flag + keystroke-light flag */
  if(!fixedLayoutSent){
    var typeByte=(1<<4)|1; /* faderUpIsNull=1, keyType=noteOnNoteOff=1 → 0x11 */
    for(var i=0;i<280;i++){
      var group=Math.floor(i/56),keyIdx=i%56;
      var board=sysexBoardMap[group];
      var channel=fixedMidiChannelMap[group];
      newQ.push(buildNoteSysEx(board,keyIdx,keyIdx,channel,typeByte));
    }
    newQ.push(buildToggleSysEx(SYSEX_CMD_SET_AFTERTOUCH_FLAG,1));
    newQ.push(buildToggleSysEx(SYSEX_CMD_SET_LIGHT_ON_KEYSTROKES,1));
    fixedLayoutSent=true;
  }

  /* Diff predicted vs target — collect changed key indices */
  var changedIdx=[];
  for(var i=0;i<280;i++){
    if(predicted[i]===target[i])continue;
    changedIdx.push(i);
  }
  /* Sort left→right: +q overall, −r within same q (visual wipe) */
  changedIdx.sort(function(a,b){
    var dq=baseKeys[a][0]-baseKeys[b][0];
    if(dq!==0)return dq;
    return baseKeys[b][1]-baseKeys[a][1];
  });
  for(var j=0;j<changedIdx.length;j++){
    var i=changedIdx[j];
    var group=Math.floor(i/56),keyIdx=i%56;
    var board=sysexBoardMap[group];
    newQ.push(buildColorSysEx(board,keyIdx,target[i],i));
  }

  if(newQ.length===0)return; /* already in sync */

  /* Option B: swap queue in place, let in-flight message complete naturally.
     Reset counters so the visible progress reflects the new sync. */
  sysexQueue=newQ;
  pushTotal=newQ.length;
  pushSent=0;
  pushSilent=false;
  if(!pushInProgress){
    pushInProgress=true;
    pushUpdateUI();
    sysexSendNext();
  } else {
    pushUpdateUI();
  }
}

/* Auto-sync checkbox handler. */
function toggleAutoSync(){
  var cb=document.getElementById('cbAutoSync');
  autoSyncEnabled=cb.checked;
  if(autoSyncEnabled){
    /* OFF → ON: full initial sync (setup + all colors). If no device connected
       yet, this no-ops; findLumatone will pick up the state on next connection. */
    if(midiOut)syncLumatoneColors();
  } else {
    /* ON → OFF: cancel in-flight work. Leave device in whatever state it's in;
       deviceColors remains valid best-known state for a future re-enable. */
    sysexCancelAll();
  }
}

/* request MIDI access on load — controls appear only on success */
function showMidiControls(){
  document.getElementById('midiControls').style.display='';
}
function requestMidi(){
  if(!navigator.requestMIDIAccess){return;}
  navigator.requestMIDIAccess({sysex:true}).then(function(access){
    console.log('MIDI access granted');
    midiAccess=access;
    showMidiControls();
    findLumatone();
    access.onstatechange=function(e){
      console.log('MIDI state change:',e.port.name,e.port.state);
      findLumatone();
    };
  }).catch(function(err){console.error('MIDI access denied:',err);});
}
requestMidi();

/* ── canvas setup ── */
var cv=document.getElementById('cv');
sizeCanvas();
cv.style.width=CW+'px';cv.style.height=CH+'px';
cv.parentElement.style.minWidth='424px'; /* 400px canvas + 24px wrap padding */
var ctx=cv.getContext('2d');

/* ── view center & layout animation ── */
var viewQ=0,viewR=0; /* current view center in lattice coords */
var viewStartQ=0,viewStartR=0,viewTargetQ=0,viewTargetR=0;
var animStart=0,animDuration=500,layoutAnimId=null;

function animateLayout(){
  var t=(Date.now()-animStart)/animDuration;
  if(t>=1){viewQ=viewTargetQ;viewR=viewTargetR;layoutAnimId=null;
    draw();return;}
  var e=t*t*(3-2*t); /* smoothstep ease for position */
  viewQ=viewStartQ+(viewTargetQ-viewStartQ)*e;
  viewR=viewStartR+(viewTargetR-viewStartR)*e;
  draw();
  layoutAnimId=requestAnimationFrame(animateLayout);
}

function setLayout(n){
  if(n===curLayout)return;
  var oldSh=layoutShifts[curLayout],newSh=layoutShifts[n];
  var dq=newSh[0]-oldSh[0],dr=newSh[1]-oldSh[1];
  /* ramp audio or retrigger for decaying instruments */
  if(audioEnabled&&audioCtx&&Object.keys(activeOscs).length>0){
    var newOscs={};
    if(instrDecays()){
      /* decaying: re-key dict to new coords, then retrigger immediately so
         new pitches sound as soon as the shift initiates — matches the
         selection-indicator move. */
      for(var k in activeOscs){
        var p=k.split(','),nq=+p[0]+dq,nr=+p[1]+dr;
        newOscs[nq+','+nr]=activeOscs[k];
      }
      activeOscs=newOscs;
      replayActiveNotes();
    } else {
      /* sustained: smooth ramp over animation duration */
      var now=audioCtx.currentTime;
      var rampDur=animDuration/1000;
      var layoutMoves=[];
      for(var k in activeOscs){
        var p=k.split(','),nq=+p[0]+dq,nr=+p[1]+dr;
        var e=activeOscs[k];
        if(e.type==='osc'){
          e.osc.frequency.setValueAtTime(e.osc.frequency.value,now);
          e.osc.frequency.exponentialRampToValueAtTime(keyFreq(nq,nr),now+rampDur);
          newOscs[nq+','+nr]=e;
        } else if(e.type==='sample'){
          layoutMoves.push({oldKey:k,newKey:nq+','+nr,newFreq:keyFreq(nq,nr)});
        }
      }
      layoutMoves.forEach(function(m){m.vol=SampleEngine.slideAndFadeOut(m.oldKey,m.newFreq,rampDur);});
      layoutMoves.forEach(function(m){SampleEngine.noteOnFaded(m.newKey,m.newFreq,m.vol,rampDur);newOscs[m.newKey]={type:'sample',freq:m.newFreq};});
    }
    activeOscs=newOscs;
  } else {
    stopAllNotes();
  }
  stopAllMidi();
  if(selectedKeys.size>0){
    var shifted=new Set();
    selectedKeys.forEach(function(k){var p=k.split(',');shifted.add((+p[0]+dq)+','+(+p[1]+dr));});
    setSelectedKeys(shifted);
  }
  viewStartQ=viewQ;viewStartR=viewR;
  var newSh=layoutShifts[n];
  viewTargetQ=newSh[0];viewTargetR=newSh[1];
  animStart=Date.now();
  setCurLayout(n);
  /* fire the color push as early as possible — runs in parallel with the 500ms
     view animation and the subsequent audio/MIDI sync */
  syncLumatoneColors();
  buildMidiReverse();
  syncOutput();
  document.querySelectorAll('.lbtn').forEach(function(b){b.classList.remove('active');});
  document.getElementById('lb'+n).classList.add('active');
  if(layoutAnimId)cancelAnimationFrame(layoutAnimId);
  layoutAnimId=requestAnimationFrame(animateLayout);
}

/* precompute keyboard outline segments in baseKey screen space (constant) */
var kbBaseSet=new Set();baseKeys.forEach(function(k){kbBaseSet.add(k[0]+','+k[1]);});

/* outline geometry helpers (global for reuse by seam code) */
var outR=hexR+1;
var olDirs=[[1,0],[0,1],[-1,1],[-1,0],[0,-1],[1,-1]];
var hdx=[],hdy=[],epx=[],epy=[];
for(var _di=0;_di<6;_di++){
  var _rx=olDirs[_di][0]*dxH+olDirs[_di][1]*dxH*0.5,_ry=-olDirs[_di][1]*dyH;
  var _rl=Math.sqrt(_rx*_rx+_ry*_ry);
  hdx[_di]=_rx/_rl;hdy[_di]=_ry/_rl;
  epx[_di]=-hdy[_di];epy[_di]=hdx[_di];
}
function edgeIsect(hx1,hy1,d1,hx2,hy2,d2){
  var px1=hx1+outR*hdx[d1],py1=hy1+outR*hdy[d1];
  var px2=hx2+outR*hdx[d2],py2=hy2+outR*hdy[d2];
  var det=epx[d2]*epy[d1]-epx[d1]*epy[d2];
  if(Math.abs(det)<1e-9)return[px1,py1];
  var ddx=px2-px1,ddy=py2-py1;
  var t=(epx[d2]*ddy-epy[d2]*ddx)/det;
  return[px1+t*epx[d1],py1+t*epy[d1]];
}

var kbOutlinePaths=[]; /* array of closed polyline arrays [[x,y],[x,y],...] */
(function(){
  var eDirs=[[1,0],[0,1],[-1,1],[-1,0],[0,-1],[1,-1]];
  /* base positions */
  var bPos={};
  baseKeys.forEach(function(bk){
    bPos[bk[0]+','+bk[1]]={ux:bk[0]*dxH+bk[1]*dxH*0.5,uy:-bk[1]*dyH};
  });
  /* find boundary edges */
  var bEdges={};
  baseKeys.forEach(function(bk){
    var bq=bk[0],br=bk[1];
    for(var d=0;d<6;d++){
      if(!kbBaseSet.has((bq+eDirs[d][0])+','+(br+eDirs[d][1])))
        bEdges[bq+','+br+','+d]=true;
    }
  });
  function nextBEdge(q,r,d){
    var nd=(d+5)%6;
    for(var s=0;s<12;s++){
      if(bEdges[q+','+r+','+nd])return[q,r,nd];
      var nq=q+eDirs[nd][0],nr=r+eDirs[nd][1];
      nd=((nd+3)%6+5)%6;q=nq;r=nr;
    }
    return null;
  }
  /* trace chains */
  var bUsed={};
  for(var ek in bEdges){
    if(bUsed[ek])continue;
    var ep=ek.split(','),cq=+ep[0],cr=+ep[1],cd=+ep[2];
    var sq=cq,sr=cr,sd=cd;
    var chain=[];
    do{
      chain.push([cq,cr,cd]);
      bUsed[cq+','+cr+','+cd]=true;
      var nx=nextBEdge(cq,cr,cd);
      if(!nx)break;
      cq=nx[0];cr=nx[1];cd=nx[2];
    }while(cq!==sq||cr!==sr||cd!==sd);
    if(chain.length<3)continue;
    var poly=[];
    for(var ci=0;ci<chain.length;ci++){
      var cur=chain[ci],nxt=chain[(ci+1)%chain.length];
      var h1=bPos[cur[0]+','+cur[1]],h2=bPos[nxt[0]+','+nxt[1]];
      if(!h1||!h2)continue;
      var pt=edgeIsect(h1.ux,h1.uy,cur[2],h2.ux,h2.uy,nxt[2]);
      poly.push(pt);
    }
    if(poly.length>=3)kbOutlinePaths.push(poly);
  }
})();

function clearSelection(){
  selectedKeys.clear();sustainedKeys.clear();
  if(audioCtx){
    var now=audioCtx.currentTime;
    for(var k in activeOscs){var e=activeOscs[k];
      if(e.type==='sample'){
        var v=SampleEngine.getActiveVoices()[k];
        if(v){if(v.loopTimer){clearTimeout(v.loopTimer);v.loopTimer=null;}
          if(v.alive){v.voiceGain.gain.cancelScheduledValues(now);v.voiceGain.gain.setValueAtTime(v.voiceGain.gain.value,now);
            v.voiceGain.gain.linearRampToValueAtTime(0,now+0.05);try{v.source.stop(now+0.07);}catch(ex){}}
          delete SampleEngine.getActiveVoices()[k];}
      } else if(e.type==='osc'){
        e.gain.gain.cancelScheduledValues(now);e.gain.gain.setValueAtTime(e.gain.gain.value,now);
        e.gain.gain.linearRampToValueAtTime(0,now+0.05);e.osc.stop(now+0.07);
      }
    }
  }
  activeOscs={};stopAllMidi();draw();
}

/* ── hit-test + pointer handlers ── */
var hoverKey=null;
function hexAtPoint(mx,my){
  /* transform to unrotated coords */
  var dx=mx-CW/2,dy=my-(CH/2+kbOffY);
  var ux=dx*cosT-dy*sinT;
  var uy=dx*sinT+dy*cosT;
  /* find nearest hex by unrotated distance */
  var best=null,bestD=Infinity;
  for(var i=0;i<drawnKeys.length;i++){
    var k=drawnKeys[i];
    var ddx=ux-k.ux,ddy=uy-k.uy,d2=ddx*ddx+ddy*ddy;
    if(d2<bestD){bestD=d2;best=k;}
  }
  if(!best||bestD>hexR*hexR*1.5)return null;
  return best.q+','+best.r;
}
cv.addEventListener('mousedown',function(e){
  var rect=cv.getBoundingClientRect();
  var key=hexAtPoint(e.clientX-rect.left,e.clientY-rect.top);
  if(!key)return;
  if(e.shiftKey){selectedKeys.clear();selectedKeys.add(key);}
  else{if(selectedKeys.has(key))selectedKeys.delete(key);else selectedKeys.add(key);}
  syncOutput();
  draw();
});
cv.addEventListener('mousemove',function(e){
  var rect=cv.getBoundingClientRect();
  var key=hexAtPoint(e.clientX-rect.left,e.clientY-rect.top);
  if(key!==hoverKey){hoverKey=key;draw();}
});
cv.addEventListener('mouseleave',function(){
  if(hoverKey!==null){hoverKey=null;draw();}
});

/* ── drawing helpers ── */
function drawHexPath(cx,cy,r){ctx.beginPath();for(var i=0;i<6;i++){var a=Math.PI/6+i*Math.PI/3;ctx.lineTo(cx+r*Math.cos(a),cy+r*Math.sin(a));}ctx.closePath();}
function lightenHex(hex,amt){
  var r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  r=Math.min(255,r+amt);g=Math.min(255,g+amt);b=Math.min(255,b+amt);
  return '#'+((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1);
}
function drawNoteName(cx,cy,name,isW,isExt){
  if(name==='?')return;
  var p=parseNote(name);var v=accToVal(p.acc);var absV=Math.abs(v);
  ctx.fillStyle=isW?(isExt?'rgba(0,0,0,0.45)':'rgba(0,0,0,0.8)'):(isExt?'rgba(255,255,255,0.5)':'rgba(255,255,255,0.9)');
  var baseFontSize=14;
  ctx.font='500 '+baseFontSize+'px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
  if(v===0){ctx.fillText(p.letter,cx,cy);return;}
  /* decompose accidental into single+double glyphs */
  var single=v>0?SHARP:FLAT,dbl=v>0?DBLSHARP:DBLFLAT;
  var glyphs=[];
  if(absV%2===1)glyphs.push(single);
  for(var i=0;i<Math.floor(absV/2);i++)glyphs.push(dbl);
  /* measure total width at base size to determine scale factor */
  var dblFlatScale=0.90;
  var lw=ctx.measureText(p.letter).width;
  var totalW=lw;
  for(var i=0;i<glyphs.length;i++){
    var gScale=(glyphs[i]===DBLFLAT)?dblFlatScale:1;
    ctx.font='500 '+Math.round(baseFontSize*gScale)+'px sans-serif';
    totalW+=ctx.measureText(glyphs[i]).width+0.5;
    /* cascading nudge for double flats: count consecutive double flats */
    if(glyphs[i]===DBLFLAT){
      var dblIdx=0;for(var j=0;j<i;j++)if(glyphs[j]===DBLFLAT)dblIdx++;
      if(dblIdx>0)totalW-=baseFontSize*0.14*dblIdx;
    }
  }
  ctx.font='500 '+baseFontSize+'px sans-serif';
  var maxW=hexR*1.3;
  var scale=Math.min(1,maxW/totalW);
  var fontSize=Math.max(6,Math.round(baseFontSize*scale));
  /* compute nudges and glyph widths at final size */
  ctx.font='500 '+fontSize+'px sans-serif';
  var flw=ctx.measureText(p.letter).width;
  var gws=[],nudges=[];
  var dblCount=0;
  for(var i=0;i<glyphs.length;i++){
    var gScale=(glyphs[i]===DBLFLAT)?dblFlatScale:1;
    ctx.font='500 '+Math.round(fontSize*gScale)+'px sans-serif';
    gws.push(ctx.measureText(glyphs[i]).width);
    if(glyphs[i]===DBLFLAT){
      nudges.push(dblCount>0?-fontSize*0.14*dblCount:0);
      dblCount++;
    } else {
      nudges.push(0);
    }
  }
  ctx.font='500 '+fontSize+'px sans-serif';
  /* compute total rendered width for centering */
  var tw=flw;for(var i=0;i<gws.length;i++)tw+=gws[i]+0.5+nudges[i];
  var x=cx-tw/2+flw/2;
  ctx.fillText(p.letter,x,cy);
  x+=flw/2;
  for(var i=0;i<glyphs.length;i++){
    x+=0.5+gws[i]/2+nudges[i];
    if(glyphs[i]===DBLFLAT){
      ctx.font='500 '+Math.round(fontSize*dblFlatScale)+'px sans-serif';
      ctx.fillText(glyphs[i],x,cy-fontSize*0.04);
      ctx.font='500 '+fontSize+'px sans-serif';
    } else {
      var yOff=glyphs[i]===DBLSHARP?fontSize*0.22:0;
      ctx.fillText(glyphs[i],x,cy+yOff);
    }
    x+=gws[i]/2;
  }
}

/* ── offscreen layers: hexCanvas (fills) + textCanvas (labels) ── */
var hexCanvas=null,textCanvas=null,gridRefQ=0,gridRefR=0,gridPadX=0,gridPadY=0,gridW=0,gridH=0,gridDpr=1;
var hexDirty=true,textDirty=true;

/* keyboard extent across all layouts for tight bounds when Extend is off */
var kbQMin,kbQMax,kbRMin,kbRMax;
(function(){
  kbQMin=1e9;kbQMax=-1e9;kbRMin=1e9;kbRMax=-1e9;
  [1,2,3].forEach(function(li){
    var sh=layoutShifts[li];
    baseKeys.forEach(function(k){
      var q=k[0]+sh[0],r=k[1]+sh[1];
      if(q<kbQMin)kbQMin=q;if(q>kbQMax)kbQMax=q;
      if(r<kbRMin)kbRMin=r;if(r>kbRMax)kbRMax=r;
    });
  });
  kbQMin-=2;kbQMax+=2;kbRMin-=2;kbRMax+=2;
})();

function sizeGridCanvases(){
  gridRefQ=0;gridRefR=0;
  var mxDx=0,mxDy=0;
  [1,2,3].forEach(function(li){
    var sh=layoutShifts[li];
    var dux=sh[0]*dxH+sh[1]*dxH*0.5,duy=-sh[1]*dyH;
    mxDx=Math.max(mxDx,Math.abs(dux*cosT+duy*sinT));
    mxDy=Math.max(mxDy,Math.abs(-dux*sinT+duy*cosT));
  });
  gridPadX=Math.ceil(mxDx)+hexR*3;
  gridPadY=Math.ceil(mxDy)+hexR*3;
  gridW=CW+gridPadX*2;gridH=CH+gridPadY*2;
  gridDpr=window.devicePixelRatio||1;
}

function gridRange(extended){
  var gCorners=[[-gridW/2,-(gridH/2+kbOffY)],[gridW/2,-(gridH/2+kbOffY)],
                [gridW/2,gridH/2-kbOffY],[-gridW/2,gridH/2-kbOffY]];
  var qLo=1e9,qHi=-1e9,rLo=1e9,rHi=-1e9;
  gCorners.forEach(function(c){
    var ux=c[0]*cosT-c[1]*sinT,uy=c[0]*sinT+c[1]*cosT;
    var rRel=-uy/dyH,qRel=(ux-rRel*dxH*0.5)/dxH;
    if(qRel+gridRefQ<qLo)qLo=qRel+gridRefQ;if(qRel+gridRefQ>qHi)qHi=qRel+gridRefQ;
    if(rRel+gridRefR<rLo)rLo=rRel+gridRefR;if(rRel+gridRefR>rHi)rHi=rRel+gridRefR;
  });
  qLo=Math.floor(qLo)-2;qHi=Math.ceil(qHi)+2;rLo=Math.floor(rLo)-2;rHi=Math.ceil(rHi)+2;
  if(!extended){
    qLo=Math.max(qLo,kbQMin);qHi=Math.min(qHi,kbQMax);
    rLo=Math.max(rLo,kbRMin);rHi=Math.min(rHi,kbRMax);
  }
  return{qMin:qLo,qMax:qHi,rMin:rLo,rMax:rHi};
}

function buildGridKeys(range){
  var gcx=gridW/2,gcy=gridH/2+kbOffY;
  var kbSet=new Set();baseKeys.forEach(function(k){kbSet.add(k[0]+','+k[1]);});
  var gKeys=[];
  for(var r=range.rMax;r>=range.rMin;r--)for(var q=range.qMin;q<=range.qMax;q++){
    var isKb=kbSet.has(q+','+r);
    var ux=(q-gridRefQ)*dxH+(r-gridRefR)*dxH*0.5,uy=-(r-gridRefR)*dyH;
    var sx=ux*cosT+uy*sinT+gcx,sy=-ux*sinT+uy*cosT+gcy;
    if(sx<-hexR*3||sx>gridW+hexR*3||sy<-hexR*3||sy>gridH+hexR*3)continue;
    gKeys.push({q:q,r:r,ux:ux,uy:uy,sx:sx,sy:sy,isKb:isKb});
  }
  return gKeys;
}

function buildHexLayer(){
  sizeGridCanvases();
  var extended=document.getElementById('cbExtend').checked;
  var range=gridRange(extended);
  var gKeys=buildGridKeys(range);
  if(!hexCanvas)hexCanvas=document.createElement('canvas');
  hexCanvas.width=gridW*gridDpr;hexCanvas.height=gridH*gridDpr;
  var gc=hexCanvas.getContext('2d');
  gc.setTransform(gridDpr,0,0,gridDpr,0,0);
  gc.fillStyle='#111';gc.fillRect(0,0,gridW,gridH);
  var gcx=gridW/2,gcy=gridH/2+kbOffY;
  var savedCtx=ctx;ctx=gc;
  ctx.save();ctx.translate(gcx,gcy);ctx.rotate(-tiltAngle);
  ctx.fillStyle='#111';gKeys.forEach(function(k){if(k.isKb){drawHexPath(k.ux,k.uy,hexR+0.5);ctx.fill();}});
  gKeys.forEach(function(k){
    var midi=57+4*k.q+7*k.r;var pc=((midi%12)+12)%12;var isW=whiteSet.has(pc);
    var mh=computeHue(k.q,k.r);
    var inB=septimalEnabled&&((Math.floor((k.r-septimalShift)/septimalW)&1)!==0);
    var col=inB?(isW?hueC[mh].sl:hueC[mh].sd):(isW?hueC[mh].l:hueC[mh].d);
    drawHexPath(k.ux,k.uy,hexR-0.5);ctx.fillStyle=col;ctx.fill();
  });
  ctx.restore();
  ctx=savedCtx;
  hexDirty=false;
}

function buildTextLayer(){
  sizeGridCanvases();
  var extended=document.getElementById('cbExtend').checked;
  var range=gridRange(extended);
  var gKeys=buildGridKeys(range);
  if(!textCanvas)textCanvas=document.createElement('canvas');
  textCanvas.width=gridW*gridDpr;textCanvas.height=gridH*gridDpr;
  var gc=textCanvas.getContext('2d');
  gc.setTransform(gridDpr,0,0,gridDpr,0,0);
  /* transparent background — composites over hex layer */
  gc.clearRect(0,0,gridW,gridH);
  if(document.getElementById('cbNotes').checked){
    var savedCtx=ctx;ctx=gc;
    gKeys.forEach(function(k){
      var midi=57+4*k.q+7*k.r;var pc=((midi%12)+12)%12;var isW=whiteSet.has(pc);
      drawNoteName(k.sx,k.sy,noteName(k.q,k.r),isW,false);
    });
    ctx=savedCtx;
  }
  textDirty=false;
}

/* ── main draw ── */
function draw(){
  var dpr=window.devicePixelRatio||1;
  cv.width=CW*dpr;cv.height=CH*dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.fillStyle='#111';ctx.fillRect(0,0,CW,CH);
  var cyC=CH/2+kbOffY;
  var showN=document.getElementById('cbNotes').checked;
  var showB=document.getElementById('cbBands').checked;
  var showE=document.getElementById('cbExtend').checked;

  /* rebuild layers if needed (not during animation) */
  if(!layoutAnimId){
    if(hexDirty)buildHexLayer();
    if(textDirty)buildTextLayer();
  }

  /* blit hex + text layers at current view offset */
  if(hexCanvas){
    var dQ=viewQ-gridRefQ,dR=viewR-gridRefR;
    var dux=dQ*dxH+dR*dxH*0.5,duy=-dR*dyH;
    var offX=dux*cosT+duy*sinT;
    var offY=-dux*sinT+duy*cosT;
    var srcX=(gridPadX+offX)*gridDpr,srcY=(gridPadY+offY)*gridDpr,srcW=CW*gridDpr,srcH=CH*gridDpr;
    ctx.drawImage(hexCanvas,srcX,srcY,srcW,srcH,0,0,CW,CH);
    if(textCanvas)ctx.drawImage(textCanvas,srcX,srcY,srcW,srcH,0,0,CW,CH);
  }

  /* build allKeys for seams + click detection (arithmetic only, no rendering) */
  var kbShQ=layoutAnimId?Math.round(viewQ):layoutShifts[curLayout][0];
  var kbShR=layoutAnimId?Math.round(viewR):layoutShifts[curLayout][1];
  var kbSet=new Set();baseKeys.forEach(function(k){kbSet.add((k[0]+kbShQ)+','+(k[1]+kbShR));});
  var vis=getVisibleRange(viewQ,viewR);
  var allKeys=[];
  for(var r=vis.rMax;r>=vis.rMin;r--)for(var q=vis.qMin;q<=vis.qMax;q++){
    var isKb=kbSet.has(q+','+r);
    var ux=(q-viewQ)*dxH+(r-viewR)*dxH*0.5;
    var uy=-(r-viewR)*dyH;
    var sx=ux*cosT+uy*sinT+CW/2;
    var sy=-ux*sinT+uy*cosT+cyC;
    if(!isKb&&(sx<-hexR*3||sx>CW+hexR*3||sy<-hexR*3||sy>CH+hexR*3))continue;
    allKeys.push({q:q,r:r,ux:ux,uy:uy,sx:sx,sy:sy,isKb:isKb});
  }
  setDrawnKeys(allKeys);
  var posMap={};allKeys.forEach(function(k){posMap[k.q+','+k.r]=k;});
  kbSet.forEach(function(key){
    if(!posMap[key]){
      var p=key.split(','),q=+p[0],r=+p[1];
      var ux=(q-viewQ)*dxH+(r-viewR)*dxH*0.5,uy=-(r-viewR)*dyH;
      var sx=ux*cosT+uy*sinT+CW/2,sy=-ux*sinT+uy*cosT+cyC;
      var k={q:q,r:r,ux:ux,uy:uy,sx:sx,sy:sy,isKb:true};
      allKeys.push(k);posMap[key]=k;
    }
  });

  /* === selection highlights + seams (rotated context) === */
  ctx.save();
  ctx.translate(CW/2,cyC);
  ctx.rotate(-tiltAngle);

  /* hover: subtle lightening of the hex under the cursor (drawn under selection
     so a selected+hovered key still reads as selected). */
  if(hoverKey){
    var hk=posMap[hoverKey];
    if(hk){
      var hmidi=57+4*hk.q+7*hk.r;var hpc=((hmidi%12)+12)%12;var hW=whiteSet.has(hpc);
      var hmh=computeHue(hk.q,hk.r);
      var hInB=septimalEnabled&&((Math.floor((hk.r-septimalShift)/septimalW)&1)!==0);
      var hCol=hInB?(hW?hueC[hmh].sl:hueC[hmh].sd):(hW?hueC[hmh].l:hueC[hmh].d);
      drawHexPath(hk.ux,hk.uy,hexR-0.5);ctx.fillStyle=lightenHex(hCol,30);ctx.fill();
    }
  }

  /* selection: brightened hex fills */
  var flashNow=performance.now();
  var flashingSet=new Set();
  for(var fk in rearticulateFlashUntil){
    if(rearticulateFlashUntil[fk]>flashNow)flashingSet.add(fk);
    else delete rearticulateFlashUntil[fk];
  }
  selectedKeys.forEach(function(key){
    if(flashingSet.has(key))return;
    var k=posMap[key];if(!k)return;
    var midi=57+4*k.q+7*k.r;var pc=((midi%12)+12)%12;var isW=whiteSet.has(pc);
    var mh=computeHue(k.q,k.r);
    var inB=septimalEnabled&&((Math.floor((k.r-septimalShift)/septimalW)&1)!==0);
    var col=inB?(isW?hueC[mh].sl:hueC[mh].sd):(isW?hueC[mh].l:hueC[mh].d);
    col=lightenHex(col,90);
    drawHexPath(k.ux,k.uy,hexR-0.5);ctx.fillStyle=col;ctx.fill();
  });

  /* selection rings */
  selectedKeys.forEach(function(key){
    if(flashingSet.has(key))return;
    var k=posMap[key];if(!k)return;
    ctx.strokeStyle='#fff';ctx.lineWidth=2.5;
    drawHexPath(k.ux,k.uy,hexR-0.5);ctx.stroke();
  });

  /* lattice seams — skip in Equal mode (no seams) */
  if(showB&&!equalEnabled){
    var eHL=hexR*0.55;ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.lineCap='butt';
    var drawnSeams=new Set();var allSet=new Set(allKeys.map(function(k){return k.q+','+k.r;}));
    var dirs=[[1,0],[-1,0],[0,1],[0,-1],[-1,1],[1,-1]];
    var animT=layoutAnimId?Math.min(1,(Date.now()-animStart)/animDuration):-1;
    var seamBlend=animT<0?1:Math.pow(Math.abs(2*animT-1),6);
    var olOX=(kbShQ-viewQ)*dxH+(kbShR-viewR)*dxH*0.5;
    var olOY=-(kbShR-viewR)*dyH;
    function snapVtx(px,py){
      var bd=Infinity,bpx=0,bpy=0;
      for(var pi=0;pi<kbOutlinePaths.length;pi++){
        var poly=kbOutlinePaths[pi];
        for(var i=0;i<poly.length;i++){
          var vx=poly[i][0]+olOX,vy=poly[i][1]+olOY;
          var d2=(px-vx)*(px-vx)+(py-vy)*(py-vy);
          if(d2<bd){bd=d2;bpx=vx;bpy=vy;}
        }
      }
      return bd<36?{d:Math.sqrt(bd),x:bpx,y:bpy}:null;
    }
    var seamSegs=[];
    allKeys.forEach(function(k){dirs.forEach(function(d){
      var nq=k.q+d[0],nr=k.r+d[1],nk=nq+','+nr;
      if(!allSet.has(nk))return;
      var sameBand=bandOf(k.q)===bandOf(nq);
      var sameRegion=!septimalEnabled||((Math.floor((k.r-septimalShift)/septimalW)&1)===(Math.floor((nr-septimalShift)/septimalW)&1));
      if(sameBand&&sameRegion)return;
      var sk=k.q<nq||(k.q===nq&&k.r<nr)?k.q+','+k.r+'/'+nq+','+nr:nq+','+nr+'/'+k.q+','+k.r;
      if(drawnSeams.has(sk))return;drawnSeams.add(sk);
      var nb=posMap[nk];if(!nb)return;
      var mx=(k.ux+nb.ux)/2,my=(k.uy+nb.uy)/2;
      var dx2=nb.ux-k.ux,dy2=nb.uy-k.uy,len=Math.sqrt(dx2*dx2+dy2*dy2);
      var nx=-dy2/len,ny=dx2/len;
      var p1x=mx+nx*eHL,p1y=my+ny*eHL;
      var p2x=mx-nx*eHL,p2y=my-ny*eHL;
      if(seamBlend>0.01){
        var r1=snapVtx(p1x,p1y);
        if(r1){p1x+=(r1.x-p1x)*seamBlend;p1y+=(r1.y-p1y)*seamBlend;}
        var r2=snapVtx(p2x,p2y);
        if(r2){p2x+=(r2.x-p2x)*seamBlend;p2y+=(r2.y-p2y)*seamBlend;}
      }
      seamSegs.push([p1x,p1y,p2x,p2y]);
    });});
    if(seamSegs.length){
      ctx.beginPath();
      seamSegs.forEach(function(s){ctx.moveTo(s[0],s[1]);ctx.lineTo(s[2],s[3]);});
      ctx.stroke();
    }
  }

  ctx.restore();

  /* re-render text for selected keys on top of selection fills */
  if(showN&&selectedKeys.size>0){
    selectedKeys.forEach(function(key){
      if(flashingSet.has(key))return;
      var k=posMap[key];if(!k)return;
      var midi=57+4*k.q+7*k.r;var pc=((midi%12)+12)%12;var isW=whiteSet.has(pc);
      drawNoteName(k.sx,k.sy,noteName(k.q,k.r),isW,false);
    });
  }
  /* re-render hovered key's note name on top of hover fill (skip if already
     handled by the selection re-render above). */
  if(showN&&hoverKey&&!selectedKeys.has(hoverKey)){
    var hk=posMap[hoverKey];
    if(hk){
      var hmidi=57+4*hk.q+7*hk.r;var hpc=((hmidi%12)+12)%12;var hW=whiteSet.has(hpc);
      drawNoteName(hk.sx,hk.sy,noteName(hk.q,hk.r),hW,false);
    }
  }

  /* === overlay + outline (rotated context, on top of everything) === */
  ctx.save();
  ctx.translate(CW/2,cyC);
  ctx.rotate(-tiltAngle);

  var diag=Math.ceil(Math.sqrt(CW*CW+CH*CH));
  ctx.beginPath();
  ctx.rect(-diag,-diag,diag*2,diag*2);
  kbOutlinePaths.forEach(function(poly){
    for(var i=0;i<poly.length;i++){
      if(i===0)ctx.moveTo(poly[i][0],poly[i][1]);
      else ctx.lineTo(poly[i][0],poly[i][1]);
    }
    ctx.closePath();
  });
  ctx.fillStyle=showE?'rgba(17,17,17,0.65)':'rgba(17,17,17,1.0)';
  ctx.fill('evenodd');

  ctx.strokeStyle='#fff';ctx.lineWidth=3.5;ctx.lineCap='butt';ctx.lineJoin='round';
  ctx.beginPath();
  kbOutlinePaths.forEach(function(poly){
    for(var i=0;i<poly.length;i++){
      if(i===0)ctx.moveTo(poly[i][0],poly[i][1]);
      else ctx.lineTo(poly[i][0],poly[i][1]);
    }
    ctx.closePath();
  });
  ctx.stroke();

  ctx.restore();

  updateInfo();
}

/* ── interval naming: reference table + comma decomposition ── */
/* factor integer into 2^a × 3^b × 5^c × 7^d */
function factor7(n){var e=[0,0,0,0],p=[2,3,5,7];for(var i=0;i<4;i++)while(n%p[i]===0){e[i]++;n/=p[i];}return n===1?e:null;}
/* reference table: each entry is {n,d,name,e:[e2,e3,e5,e7],ord,comma,th} */
var REF=[];
(function(){
  function add(n,d,name,ord,comma){
    var fn=factor7(n),fd=factor7(d);
    REF.push({n:n,d:d,name:name,e:[fn[0]-fd[0],fn[1]-fd[1],fn[2]-fd[2],fn[3]-fd[3]],ord:ord,comma:comma,th:Math.log2(n*d)});
  }
  /* commas */
  add(32805,32768,'schisma',0,1);add(2048,2025,'diaschisma',0,1);
  add(81,80,'syntonic comma',0,1);add(531441,524288,'Pythagorean comma',0,1);
  add(64,63,'septimal comma',0,1);add(36,35,'septimal diesis',0,1);
  /* non-ordinal intervals */
  add(1,1,'perfect unison',1,0);add(128,125,'diesis',0,0);add(2187,2048,'apotome',0,0);
  add(25,24,'lesser chromatic semitone',0,0);add(135,128,'greater chromatic semitone',0,0);
  add(15,14,'septimal chromatic semitone',0,0);
  add(7,5,'lesser septimal tritone',0,0);add(10,7,'greater septimal tritone',0,0);
  /* 2nds */
  add(256,243,'Pythagorean minor 2nd',2,0);
  add(21,20,'septimal minor 2nd',2,0);add(16,15,'lesser minor 2nd',2,0);add(27,25,'greater minor 2nd',2,0);
  add(10,9,'lesser major 2nd',2,0);add(9,8,'greater major 2nd',2,0);add(8,7,'septimal major 2nd',2,0);
  add(75,64,'augmented 2nd',2,0);add(25,21,'septimal augmented 2nd',2,0);
  /* 3rds */
  add(256,225,'diminished 3rd',3,0);
  add(7,6,'septimal minor 3rd',3,0);add(32,27,'Pythagorean minor 3rd',3,0);add(6,5,'minor 3rd',3,0);
  add(5,4,'major 3rd',3,0);add(81,64,'Pythagorean major 3rd',3,0);add(9,7,'septimal major 3rd',3,0);
  /* 4ths */
  add(32,25,'diminished 4th',4,0);
  add(21,16,'septimal 4th',4,0);add(4,3,'perfect 4th',4,0);add(27,20,'wolf 4th',4,0);
  add(25,18,'lesser augmented 4th',4,0);add(45,32,'greater augmented 4th',4,0);
  /* 5ths */
  add(64,45,'lesser diminished 5th',5,0);add(36,25,'greater diminished 5th',5,0);
  add(40,27,'wolf 5th',5,0);add(3,2,'perfect 5th',5,0);add(32,21,'septimal 5th',5,0);
  add(25,16,'augmented 5th',5,0);
  /* 6ths */
  add(14,9,'septimal minor 6th',6,0);add(128,81,'Pythagorean minor 6th',6,0);add(8,5,'minor 6th',6,0);
  add(5,3,'major 6th',6,0);add(27,16,'Pythagorean major 6th',6,0);add(12,7,'septimal major 6th',6,0);
  add(225,128,'augmented 6th',6,0);
  /* 7ths */
  add(128,75,'diminished 7th',7,0);add(42,25,'septimal diminished 7th',7,0);
  add(7,4,'harmonic 7th',7,0);add(16,9,'lesser minor 7th',7,0);add(9,5,'greater minor 7th',7,0);
  add(50,27,'lesser major 7th',7,0);add(15,8,'greater major 7th',7,0);add(243,128,'Pythagorean major 7th',7,0);add(40,21,'septimal major 7th',7,0);
  /* octave-class */
  add(256,135,'lesser diminished octave',8,0);add(48,25,'greater diminished octave',8,0);add(28,15,'septimal diminished octave',8,0);
})();
/* solve difference vector for comma counts: s(syntonic) z(septimal) h(schisma)
   syntonic=(-4,4,-1,0) septimal=(6,-2,0,-1) schisma=(-15,8,1,0) */
function solveCommas(de){
  var z=-de[3],hN=de[1]+4*de[2]-2*de[3];
  if(hN%12!==0)return null;
  var h=hN/12,s=h-de[2];
  if(de[0]!==-4*s+6*z-15*h)return null;
  return[s,z,h];
}
/* substitute derived commas to minimize displayed count
   Pythagorean = syntonic+schisma, diaschisma = syntonic-schisma, sept.diesis = syntonic+septimal */
function optimizeCommas(s,z,h){
  /* try all 6 orderings of 3 substitution rules to minimize display groups */
  var orders=[[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
  var bestItems=null,bestGrps=99;
  for(var oi=0;oi<6;oi++){
    var cs=s,cz=z,ch=h,items=[];
    for(var si=0;si<3;si++){
      var rule=orders[oi][si];
      if(rule===0){/* septimal diesis: syn+sept same sign */
        while(cs>0&&cz>0){items.push([1,'septimal diesis']);cs--;cz--;}
        while(cs<0&&cz<0){items.push([-1,'septimal diesis']);cs++;cz++;}
      }else if(rule===1){/* Pythagorean: syn+sch same sign */
        while(cs>0&&ch>0){items.push([1,'Pythagorean comma']);cs--;ch--;}
        while(cs<0&&ch<0){items.push([-1,'Pythagorean comma']);cs++;ch++;}
      }else{/* diaschisma: syn and sch opposite sign */
        while(cs>0&&ch<0){items.push([1,'diaschisma']);cs--;ch++;}
        while(cs<0&&ch>0){items.push([-1,'diaschisma']);cs++;ch--;}
      }
    }
    while(cs>0){items.push([1,'syntonic comma']);cs--;}
    while(cs<0){items.push([-1,'syntonic comma']);cs++;}
    while(cz>0){items.push([1,'septimal comma']);cz--;}
    while(cz<0){items.push([-1,'septimal comma']);cz++;}
    while(ch>0){items.push([1,'schisma']);ch--;}
    while(ch<0){items.push([-1,'schisma']);ch++;}
    /* count display groups (distinct sign+name pairs) */
    var gk={};items.forEach(function(c){gk[c[0]+'|'+c[1]]=true;});
    var ng=Object.keys(gk).length;
    if(ng<bestGrps||(ng===bestGrps&&items.length<bestItems.length)){bestGrps=ng;bestItems=items.slice();}
  }
  return bestItems;
}
/* ordinal suffix for compound intervals */
function ordSuffix(n){
  if(n===1)return'unison';if(n===8)return'octave';
  var s=''+n,lt=n%100,l=n%10;
  if(lt>=11&&lt<=13)s+='th';else s+=(l===1?'st':l===2?'nd':l===3?'rd':'th');
  return s;
}
function octStr(n){return n===1?'octave':n+' octaves';}
/* compound ordinal: "minor 3rd" + 1 oct → "minor 10th" */
function compoundOrd(name,ord,extraOct){
  if(!extraOct)return name;
  return name.replace(ordSuffix(ord),ordSuffix(ord+7*extraOct));
}
/* format final interval name from decomposition result */
function fmtInterval(ref,commaItems,extraOct,isComp){
  /* if ref is a comma, fold it into comma list and use perfect unison as effective ref */
  if(ref.comma){
    commaItems=[].concat([[1,ref.name]],commaItems);
    ref={name:'perfect unison',ord:1,comma:0};
  }
  /* group same-sign same-name commas */
  var grps=[];
  commaItems.forEach(function(c){
    var last=grps.length?grps[grps.length-1]:null;
    if(last&&last.s===c[0]&&last.n===c[1])last.c++;
    else grps.push({s:c[0],n:c[1],c:1});
  });
  function fmtC(g,first){
    var cnt=g.c>1?g.c+'\u00d7 ':'';
    if(first)return cnt+g.n;
    return(g.s>0?'+ ':'\u2212 ')+cnt+g.n;
  }
  var isU=ref.name==='perfect unison';
  if(isComp){
    grps.forEach(function(g){g.s*=-1;});
    var totOct=extraOct+1;
    if(isU&&!grps.length)return octStr(totOct);
    if(isU){return octStr(totOct)+' '+grps.map(function(g){return fmtC(g,false);}).join(' ');}
    var base=octStr(totOct)+' \u2212 '+ref.name;
    if(!grps.length)return base;
    return base+' '+grps.map(function(g){return fmtC(g,false);}).join(' ');
  }
  /* direct match */
  if(isU){
    if(!grps.length)return extraOct?'perfect '+ordSuffix(7*extraOct+1):'perfect unison';
    var cs=grps.map(function(g,i){return fmtC(g,i===0);}).join(' ');
    return extraOct?octStr(extraOct)+' + '+cs:cs;
  }
  var base;
  if(ref.ord>0&&extraOct>0)base=compoundOrd(ref.name,ref.ord,extraOct);
  else if(extraOct>0)base=octStr(extraOct)+' + '+ref.name;
  else base=ref.name;
  if(!grps.length)return base;
  return base+' '+grps.map(function(g){return fmtC(g,false);}).join(' ');
}
function intervalName(num,den,preE){
  var e;
  if(preE){
    /* exponents passed in directly (from jiRatio) — exact even when num/den
       have overflowed float precision */
    e=[preE[0],preE[1],preE[2],preE[3]];
  } else {
    var fn=factor7(num),fd=factor7(den);
    if(!fn||!fd)return num+':'+den;
    e=[fn[0]-fd[0],fn[1]-fd[1],fn[2]-fd[2],fn[3]-fd[3]];
  }
  /* octave-reduce to [1,2) using log2(ratio) computed from exponents —
     robust for extreme exponents where num/den may be imprecise or overflow */
  var log2R=e[0]+e[1]*Math.log2(3)+e[2]*Math.log2(5)+e[3]*Math.log2(7);
  var extraOct=Math.max(0,Math.floor(log2R+1e-9));
  var re=[e[0]-extraOct,e[1],e[2],e[3]];
  /* count display groups for scoring */
  function cScore(items,isComp){var gk={};items.forEach(function(c){gk[c[0]+'|'+c[1]]=true;});return Object.keys(gk).length*100+items.length+(isComp?0.5:0);}
  /* try direct decomposition against all references */
  var best=null;
  for(var i=0;i<REF.length;i++){
    var ref=REF[i];
    var de=[re[0]-ref.e[0],re[1]-ref.e[1],re[2]-ref.e[2],re[3]-ref.e[3]];
    var sol=solveCommas(de);
    if(!sol)continue;
    var items=optimizeCommas(sol[0],sol[1],sol[2]);
    var score=cScore(items,false);
    if(!best||score<best.score||(score===best.score&&ref.th<best.ref.th))
      best={ref:ref,items:items,score:score,comp:false};
  }
  /* try complement decomposition (handles V=12 edge cases and octave-minus forms) */
  var ce=[1-re[0],-re[1],-re[2],-re[3]];
  for(var i=0;i<REF.length;i++){
    var ref=REF[i];
    var de=[ce[0]-ref.e[0],ce[1]-ref.e[1],ce[2]-ref.e[2],ce[3]-ref.e[3]];
    var sol=solveCommas(de);
    if(!sol)continue;
    var items=optimizeCommas(sol[0],sol[1],sol[2]);
    var score=cScore(items,true);
    if(!best||score<best.score||(score===best.score&&ref.th<best.ref.th))
      best={ref:ref,items:items,score:score,comp:true};
  }
  if(!best)return num+':'+den;
  return fmtInterval(best.ref,best.items,extraOct,best.comp);
}
/* abbreviate interval name for compact display */
function shortenInterval(name){
  if(!document.getElementById('cbShortIvl').checked)return name;
  /* phase 1: full-phrase special cases */
  name=name.replace(/lesser septimal tritone/g,'7d5');
  name=name.replace(/greater septimal tritone/g,'7A4');
  /* multi-word comma/interval phrases (before word-by-word) */
  name=name.replace(/syntonic comma/g,'SC');
  name=name.replace(/septimal comma/g,'7C');
  name=name.replace(/Pythagorean comma/g,'PC');
  name=name.replace(/septimal diesis/g,'7D');
  name=name.replace(/chromatic semitone/g,'A1');
  /* Pythagorean → P (no collision with 'perfect → P' since ordinals differ:
     Pm3/PM3/Pm6/PM6/Pm2/PM7 vs P1/P4/P5/P8) */
  name=name.replace(/\bPythagorean\b/g,'P');
  /* phase 2: word-by-word */
  name=name.replace(/\bperfect\b/g,'P');name=name.replace(/\bminor\b/g,'m');
  name=name.replace(/\bmajor\b/g,'M');name=name.replace(/\bdiminished\b/g,'d');
  name=name.replace(/\baugmented\b/g,'A');name=name.replace(/\bharmonic\b/g,'7m');
  name=name.replace(/\bseptimal\b/g,'7');name=name.replace(/\blesser\b/g,'&lt;');
  name=name.replace(/\bgreater\b/g,'&gt;');name=name.replace(/\bwolf\b/g,'W');
  name=name.replace(/\bunison\b/g,'1');
  name=name.replace(/(\d+) octaves\b/g,'$1\u00d7P8');
  name=name.replace(/\boctave\b/g,'P8');
  name=name.replace(/(\d+)(?:st|nd|rd|th)\b/g,'$1');
  name=name.replace(/\bdiaschisma\b/g,'Ds');name=name.replace(/\bschisma\b/g,'Sc');
  name=name.replace(/\bdiesis\b/g,'D');name=name.replace(/\bapotome\b/g,'A');
  name=name.replace(/\bcomma\b/g,'C');
  /* phase 3: structural cleanup */
  name=name.replace(/ /g,'');
  name=name.replace(/\+/g,' + ').replace(/\u2212/g,' \u2212 ');
  name=name.replace(/\u00d7 /g,'\u00d7');
  name=name.replace(/([7W])([45])(?!\d)/g,'$1P$2');
  return name;
}
/* ── Equal mode interval naming (from note spelling, no ratios) ── */
function equalIntervalName(q1,r1,q2,r2){
  var semis=4*(q2-q1)+7*(r2-r1);
  /* compute letter distance from actual note names + octaves */
  var nn1=noteName(q1,r1),nn2=noteName(q2,r2);
  var li1=letterIdx[parseNote(nn1).letter],li2=letterIdx[parseNote(nn2).letter];
  var o1=keyOctave(q1,r1),o2=keyOctave(q2,r2);
  var p1=li1+7*o1,p2=li2+7*o2;
  /* ensure ascending */
  if(p2<p1){var tmp=p1;p1=p2;p2=tmp;semis=-semis;}
  if(semis<0)semis=-semis;
  var letters=p2-p1;
  if(letters===0&&semis===0)return'perfect unison';
  var ordinal=letters+1;
  var generic=letters%7;
  var extraOct=Math.floor(letters/7);
  var nat=[0,2,4,5,7,9,11];
  var expected=nat[generic]+12*extraOct;
  var diff=semis-expected;
  var isPerfect=generic===0||generic===3||generic===4;
  var ord=ordSuffix(ordinal);
  if(isPerfect){
    if(diff===0)return'perfect '+ord;
    if(diff===1)return'augmented '+ord;
    if(diff===2)return'doubly augmented '+ord;
    if(diff===-1)return'diminished '+ord;
    if(diff===-2)return'doubly diminished '+ord;
    return(diff>0?'':'doubly ')+(Math.abs(diff)>2?Math.abs(diff)-1+'× ':'')+(diff>0?'augmented ':'diminished ')+ord;
  }
  if(diff===0)return'major '+ord;
  if(diff===-1)return'minor '+ord;
  if(diff===1)return'augmented '+ord;
  if(diff===-2)return'diminished '+ord;
  if(diff===2)return'doubly augmented '+ord;
  if(diff===-3)return'doubly diminished '+ord;
  return(diff>0?'':'doubly ')+(Math.abs(diff)>2?Math.abs(diff)-(diff>0?1:2)+'× ':'')+(diff>0?'augmented ':'diminished ')+ord;
}
var letterIdx={C:0,D:1,E:2,F:3,G:4,A:5,B:6};

/* ── chord analysis ── */
/* s = semitone intervals from root, g = generic letter intervals (0=unison,1=2nd,2=3rd,...6=7th) */
var chordTemplates=[
  /* triads */
  {s:[4,7],g:[2,4],name:'major triad'},{s:[3,7],g:[2,4],name:'minor triad'},
  {s:[3,6],g:[2,4],name:'diminished triad'},{s:[4,8],g:[2,4],name:'augmented triad'},
  {s:[5,7],g:[3,4],name:'suspended fourth chord'},{s:[2,7],g:[1,4],name:'suspended second chord'},
  /* seventh chords */
  {s:[4,7,11],g:[2,4,6],name:'major seventh'},{s:[4,7,10],g:[2,4,6],name:'dominant seventh'},
  {s:[3,7,10],g:[2,4,6],name:'minor seventh'},{s:[3,7,11],g:[2,4,6],name:'minor-major seventh'},
  {s:[3,6,9],g:[2,4,6],name:'diminished seventh'},{s:[3,6,10],g:[2,4,6],name:'half-diminished seventh'},
  {s:[4,8,10],g:[2,4,6],name:'augmented seventh'},{s:[4,8,11],g:[2,4,6],name:'augmented major seventh'},
  /* added */
  {s:[2,4,7],g:[1,2,4],name:'major added second chord'},{s:[2,3,7],g:[1,2,4],name:'minor added second chord'},
  /* augmented sixth chords */
  {s:[4,10],g:[2,5],name:'Italian augmented sixth chord'},
  {s:[4,6,10],g:[2,3,5],name:'French augmented sixth chord'},
  {s:[4,7,10],g:[2,4,5],name:'German augmented sixth chord'},
  /* incomplete sevenths (fifth omitted) */
  {s:[4,10],g:[2,6],name:'incomplete dominant seventh'},
  {s:[3,10],g:[2,6],name:'incomplete minor seventh'},
  {s:[4,11],g:[2,6],name:'incomplete major seventh'},
  {s:[3,11],g:[2,6],name:'incomplete minor-major seventh'},
  {s:[3,9],g:[2,6],name:'incomplete diminished seventh'}
];
var invNames=[null,'in first inversion','in second inversion','in third inversion'];
function isPow2(n){return n>0&&(n&(n-1))===0;}
function lcm(a,b){return a/gcd(a,b)*b;}
function analyzeChord(keys){
  /* keys already sorted by freq; each has q, r, name, col */
  var notes=keys.map(function(k){
    var midi=57+4*k.q+7*k.r;
    var nn=noteName(k.q,k.r);
    var li=letterIdx[parseNote(nn).letter];
    return{pc:((midi%12)+12)%12,midi:midi,name:k.name,col:k.col,rawName:nn,li:li,q:k.q,r:k.r};
  });
  notes.sort(function(a,b){return a.midi-b.midi;});
  /* reject if any same-name pair is not a pure octave multiple */
  var nameGroups={};
  notes.forEach(function(note){
    if(!nameGroups[note.rawName])nameGroups[note.rawName]=[];
    nameGroups[note.rawName].push(note);
  });
  for(var nm in nameGroups){
    var grp=nameGroups[nm];
    for(var i=0;i<grp.length;i++)for(var j=i+1;j<grp.length;j++){
      var rat=jiRatio(grp[i].q,grp[i].r,grp[j].q,grp[j].r);
      if(rat.den!==1||!isPow2(rat.num))return null;
    }
  }
  /* deduplicate by note name (keep lowest octave) */
  var seen={},unique=[];
  notes.forEach(function(note){
    if(!seen[note.rawName]){seen[note.rawName]=true;unique.push(note);}
  });
  notes=unique;
  var n=notes.length;
  if(n<3||n>4)return null;
  /* try each note as root */
  for(var ri=0;ri<n;ri++){
    var root=notes[ri];
    var pairs=[];
    for(var i=0;i<n;i++){
      if(i===ri)continue;
      pairs.push({
        s:((notes[i].pc-root.pc)%12+12)%12,
        g:((notes[i].li-root.li)%7+7)%7
      });
    }
    pairs.sort(function(a,b){return a.s-b.s;});
    /* match against templates (semitones + letter distances) */
    for(var ti=0;ti<chordTemplates.length;ti++){
      var t=chordTemplates[ti];
      if(t.s.length!==pairs.length)continue;
      var ok=true;
      for(var k=0;k<t.s.length;k++){
        if(pairs[k].s!==t.s[k]||pairs[k].g!==t.g[k]){ok=false;break;}
      }
      if(!ok)continue;
      /* matched — determine inversion */
      var chordPCs=[0].concat(t.s).map(function(s){return(root.pc+s)%12;});
      var bassPC=notes[0].pc;
      var inv=chordPCs.indexOf(bassPC);
      if(inv<0)inv=0;
      /* compute chord ratio in root position order */
      var rootMidi=root.midi;
      var chordRats=[];
      for(var ci=0;ci<n;ci++){
        if(ci===ri){chordRats.push({num:1,den:1});continue;}
        var rat=jiRatio(root.q,root.r,notes[ci].q,notes[ci].r);
        var rnum,rden;
        if(notes[ci].midi>=rootMidi){rnum=rat.num;rden=rat.den;}
        else{rnum=rat.den;rden=rat.num;}
        /* octave-reduce to [1, 2) above root */
        while(rnum>=2*rden)rden*=2;
        while(rnum<rden)rnum*=2;
        var cg=gcd(rnum,rden);
        chordRats.push({num:rnum/cg,den:rden/cg});
      }
      chordRats.sort(function(a,b){return a.num/a.den-b.num/b.den;});
      var L=1;
      chordRats.forEach(function(r){L=lcm(L,r.den);});
      var ints=chordRats.map(function(r){return r.num*L/r.den;});
      var g2=ints[0];
      for(var k=1;k<ints.length;k++)g2=gcd(g2,ints[k]);
      var ratioStr=ints.map(function(v){return v/g2;}).join(':');
      /* classify chord by prime content:
         - septimal: factor of 7 present AND max term ≤ 27 (gating keeps it rare)
         - Pythagorean: only primes 2 and 3 — 3-limit throughout (no gating needed,
           it's inherently rare since the lattice naturally surfaces 5-limit thirds) */
      var terms=ints.map(function(v){return v/g2;});
      var maxTerm=Math.max.apply(null,terms);
      var hasSeven=terms.some(function(v){return v%7===0;});
      var hasFive=terms.some(function(v){return v%5===0;});
      var hasSeptimal=hasSeven&&maxTerm<=27;
      var isPythagorean=!hasSeven&&!hasFive;
      var qName=hasSeptimal?'septimal '+t.name:(isPythagorean?'Pythagorean '+t.name:t.name);
      return{
        root:root.name,rootCol:root.col,
        quality:qName,
        invName:inv>0?invNames[inv]:null,
        ratio:ratioStr
      };
    }
  }
  return null;
}

/* ── info panel ── */
function updateInfo(){
  var el=document.getElementById('infoLine');
  if(selectedKeys.size===0){
    el.innerHTML='<span class="hint">Click any key to select \u00b7 shift+click for exclusive select</span>';
    return;
  }
  var keys=[];
  selectedKeys.forEach(function(k){
    var parts=k.split(',');var q=+parts[0],r=+parts[1];
    var f=keyFreq(q,r);
    var inB=septimalEnabled&&((Math.floor((r-septimalShift)/septimalW)&1)!==0);
    var mh=computeHue(q,r);
    var col=inB?hueC[mh].sl:hueC[mh].l;
    keys.push({q:q,r:r,freq:f,name:fmtNote(noteName(q,r)),oct:keyOctave(q,r),col:col,inB:inB});
  });
  keys.sort(function(a,b){return a.freq-b.freq;});

  var html='';
  var showCoords=document.getElementById('cbCoords').checked;
  /* note cards */
  keys.forEach(function(k,i){
    if(i>0)html+=' ';
    var bTag=k.inB?'<span style="color:#E44CBC;font-size:9px;font-weight:700;margin-left:2px">7</span>':'';
    var coordTag=showCoords?'<span style="color:#666;font-size:10px;margin-left:4px">(q='+k.q+' r='+k.r+' p='+posInBand(k.q)+')</span>':'';
    html+='<span class="note-tag"><span class="note-name" style="color:'+k.col+'">'+k.name+k.oct+'</span>'+bTag+coordTag+' <span class="freq">'+k.freq.toFixed(2)+' Hz</span></span>';
  });

  /* chord analysis (above intervals) */
  if(keys.length>=3){
    var chord=analyzeChord(keys);
    if(chord){
      html+='<div class="info-break"></div>';
      html+='<span class="chord-tag"><span style="color:'+chord.rootCol+'">'+chord.root+'</span><span class="chord-quality">'+(equalEnabled?chord.quality.replace(/^(?:septimal|Pythagorean) /,''):chord.quality)+(chord.invName?' '+chord.invName:'')+'</span>';
      if(!equalEnabled)html+='<span class="chord-detail">'+chord.ratio+'</span>';
      html+='</span>';
    }
  }

  /* intervals — sorted by generic interval size, rows per size group */
  if(keys.length>=2){
    var ivls=[];
    for(var i=0;i<keys.length;i++){
      for(var j=i+1;j<keys.length;j++){
        var nn1=noteName(keys[i].q,keys[i].r),nn2=noteName(keys[j].q,keys[j].r);
        var li1=letterIdx[parseNote(nn1).letter],li2=letterIdx[parseNote(nn2).letter];
        var o1=keyOctave(keys[i].q,keys[i].r),o2=keyOctave(keys[j].q,keys[j].r);
        var p1=li1+7*o1,p2=li2+7*o2;
        if(p2<p1){var tmp=p1;p1=p2;p2=tmp;}
        var intNum=p2-p1+1;
        if(equalEnabled){
          var semis=Math.abs(4*(keys[j].q-keys[i].q)+7*(keys[j].r-keys[i].r));
          ivls.push({i:i,j:j,semis:semis,intNum:intNum});
        } else {
          var rat=jiRatio(keys[i].q,keys[i].r,keys[j].q,keys[j].r);
          ivls.push({i:i,j:j,rat:rat,intNum:intNum});
        }
      }
    }
    ivls.sort(function(a,b){return a.intNum!==b.intNum?a.intNum-b.intNum:a.i-b.i;});
    var prevNum=-1;
    for(var idx=0;idx<ivls.length;idx++){
      var iv=ivls[idx];
      if(iv.intNum!==prevNum){html+='<div class="info-break"></div>';prevNum=iv.intNum;}
      if(equalEnabled){
        var cStr=(iv.semis*100).toFixed(1)+'\u00a2';
        var iname=shortenInterval(equalIntervalName(keys[iv.i].q,keys[iv.i].r,keys[iv.j].q,keys[iv.j].r));
        /* rational interval (= octave multiple, incl. enharmonics like d2, A7) → green */
        var pureOct=iv.semis%12===0;
        html+='<span class="ratio-tag tier-'+(pureOct?'green':'red')+'">';
        html+='<span style="color:'+keys[iv.i].col+'">'+keys[iv.i].name+keys[iv.i].oct+'</span>';
        html+='\u2013';
        html+='<span style="color:'+keys[iv.j].col+'">'+keys[iv.j].name+keys[iv.j].oct+'</span>';
        html+=' <span class="cents">'+cStr+'</span>';
        html+=' <span class="interval-name">'+iname+'</span>';
      } else {
        var cents=1200*Math.log2(iv.rat.num/iv.rat.den);
        var cStr=cents.toFixed(1)+'\u00a2';
        var iname=shortenInterval(intervalName(iv.rat.num,iv.rat.den,iv.rat.e));
        var tier=intervalTier(iv.rat.num,iv.rat.den);
        /* for large ratios, show prime-power form (e.g. 3^36:2^57) rather
           than sprawling integers; 2^32 threshold keeps typical intervals
           in plain num:den while compacting anything beyond ~21 fifths */
        var ratioStr;
        var BIG=4294967296; /* 2^32 */
        if(iv.rat.num<=BIG&&iv.rat.den<=BIG){
          ratioStr=iv.rat.num+':'+iv.rat.den;
        } else {
          var primes=[2,3,5,7],nParts=[],dParts=[];
          for(var pi=0;pi<4;pi++){
            var pe=iv.rat.e[pi];
            if(pe>0)nParts.push(pe===1?primes[pi]:primes[pi]+'^'+pe);
            else if(pe<0)dParts.push(-pe===1?primes[pi]:primes[pi]+'^'+(-pe));
          }
          ratioStr=(nParts.join('·')||'1')+':'+(dParts.join('·')||'1');
        }
        html+='<span class="ratio-tag tier-'+tier+'">';
        html+='<span style="color:'+keys[iv.i].col+'">'+keys[iv.i].name+keys[iv.i].oct+'</span>';
        html+='\u2013';
        html+='<span style="color:'+keys[iv.j].col+'">'+keys[iv.j].name+keys[iv.j].oct+'</span>';
        html+=' <span class="cents">'+cStr+'</span> '+ratioStr;
        html+=' <span class="interval-name">'+iname+'</span>';
      }
      html+='</span> ';
    }
  }

  el.innerHTML=html;
}

draw();

/* ── info panel height constraint ── */
var infoEl=document.getElementById('infoLine');
function sizeInfoPanel(){
  infoEl.style.maxHeight='';
  var rect=infoEl.getBoundingClientRect();
  var available=window.innerHeight-rect.top-12;
  infoEl.style.maxHeight=Math.max(120,available)+'px';
}
sizeInfoPanel();
function onResize(){
  var oldCW=CW;
  sizeCanvas();
  if(CW!==oldCW){cv.style.width=CW+'px';hexDirty=true;textDirty=true;draw();}
  sizeInfoPanel();
}
window.addEventListener('resize',onResize);

// ── Phase 1 inline-handler bridge ──
// The HTML uses inline onclick=/onchange= attributes that reference these names.
// In a <script type="module"> context, top-level functions are module-scoped,
// so we have to expose them on window. Phase 2 will move handlers to
// addEventListener and remove this bridge.
function cbNotesChanged(){ textDirty=true; draw(); }
function cbExtendChanged(){ hexDirty=true; textDirty=true; draw(); }
Object.assign(window, {
  setLayout, setTuning, toggleAudio, changeWaveform,
  togglePedalCalibration, toggleAutoSync, clearSelection, resetPedalBounds,
  draw, updateInfo,
  cbNotesChanged, cbExtendChanged,
});
