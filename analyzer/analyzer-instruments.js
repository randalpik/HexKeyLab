/* HexKeyLab Analyzer — instrument config data + helpers.
   Sample-library metadata (DEFAULT_CONFIGS) plus the chromatic note tables
   and URL/range helpers consumed by the analyzer's enumeration step. Pure
   data + stateless utilities; no DOM, no Web Audio. */

window.HKLInstruments = (function () {
/* ═══ Default instrument configs — range-based chromatic enumeration ═══
   Each instrument lists its baseUrl and octave range. The analyzer tries every
   chromatic note in the range and silently skips any that return 404.

   Config fields:
     baseUrl     — URL prefix, appended with the filename from filePattern
     lowOct/highOct — MIDI octave range to enumerate (C4 = MIDI 60)
     filePattern — template with {NOTE} placeholder. Default '{NOTE}.mp3'.
     noteStyle   — 'flat' (C,Db,D,Eb,...), 'sharp' (C,C#,D,D#,...), or
                   'sharp_lower' (c,c#,d,d#,... — for SSO and other sources
                   with lowercase filenames). Default 'flat'.
     noteSemis   — optional [0..11] subset of chromatic semitones to enumerate.
                   Use for sparsely-sampled sources, e.g. SSO minor-third
                   sampling at [1,4,7,10] (C#, E, G, A#). Default: all 12.
     transpose   — integer ratio between filename pitch and actual audio pitch.
                   FatBoy drawbar files are labeled an octave above their content
                   (filename A4.mp3 contains audio at 220Hz). Set transpose:2 so
                   the analyzer sees the actual fundamental (labeled / 2) for
                   period refinement and ZC analysis. The emitted output uses
                   the actual audio fundamental as `freq`, paired with the
                   original filename in `name` — the runtime engine plays each
                   file at native rate=1.0 for its closest pitch, preserving
                   the recorded vibrato speed. No `transpose` field needed in
                   samples.ts.

   VCSL samples (sgossner/VCSL) use sharp notation and WAV format, served via
   raw.githubusercontent.com. Gleitz soundfonts (FluidR3_GM, MusyngKite, FatBoy)
   use flat notation and MP3 format. */
var DEFAULT_CONFIGS={
  /* Strings carry pitch vibrato that decorrelates a 3-period waveform window
     against itself; corrThreshold:0.90 + corrWindowPeriods:2 reproduces the
     old prepareLoopVibrato defaults to keep candidates flowing. */
  violin:      {baseUrl:'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/violin-mp3/',      lowOct:2, highOct:7,
    gateOpts:{corrThreshold:0.90, corrWindowPeriods:2}},
  viola:       {baseUrl:'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/viola-mp3/',       lowOct:2, highOct:7,
    gateOpts:{corrThreshold:0.90, corrWindowPeriods:2}},
  cello:       {baseUrl:'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/cello-mp3/',       lowOct:1, highOct:6,
    gateOpts:{corrThreshold:0.90, corrWindowPeriods:2}},
  /* ── Problematic Iowa MIS strings — currently shipping with only 1/9/6/3 picks ──
     The 2014 ff arco recordings have bow-direction envelope dips inside each
     ~3 s sustain that defeat prepareLoop's rmsStepThreshold/slopeStepThreshold
     gates: candidates either side of a bow change look like "one rising
     through env=0.5, one falling," so the pair-wise gate rejects them. Loosening
     corrThreshold/min[Backward|Forward]Sec only marginally helped.
     Filenames vary the sul-string prefix per pitch (sulG/sulD/sulA/sulE), which
     the headless runner handles via filePatterns[] fallback — but this browser
     analyzer only accepts a single filePattern, so each entry below targets a
     single sul. Audition each sul-range separately and consider whether to add
     pitch-detection-based seam discovery (the current slope gate assumes
     monotone-or-mild envelopes, which bowed strings violate).

     URLs go through the Vite dev server's /iowa-mis proxy (see vite.config.ts)
     because theremin.music.uiowa.edu sends no Access-Control-Allow-* headers.
     Load this analyzer via http://localhost:5173/tools/HexKeyLab-analyzer.html
     after `npm run dev`. Opening as file:// or against a different origin will
     fail on every fetch — that's CORS, not a config bug. */
  iowa_violin_sulG:{baseUrl:'/iowa-mis/Strings/Violin/', filePattern:'Violin.arco.ff.sulG.{NOTE}.stereo.aif', lowOct:3, highOct:4, noteStyle:'flat',
    gateOpts:{corrThreshold:0.80, minBackwardSec:0.10, minForwardSec:0.20}},
  iowa_violin_sulD:{baseUrl:'/iowa-mis/Strings/Violin/', filePattern:'Violin.arco.ff.sulD.{NOTE}.stereo.aif', lowOct:4, highOct:5, noteStyle:'flat',
    gateOpts:{corrThreshold:0.80, minBackwardSec:0.10, minForwardSec:0.20}},
  iowa_violin_sulA:{baseUrl:'/iowa-mis/Strings/Violin/', filePattern:'Violin.arco.ff.sulA.{NOTE}.stereo.aif', lowOct:4, highOct:6, noteStyle:'flat',
    gateOpts:{corrThreshold:0.80, minBackwardSec:0.10, minForwardSec:0.20}},
  iowa_violin_sulE:{baseUrl:'/iowa-mis/Strings/Violin/', filePattern:'Violin.arco.ff.sulE.{NOTE}.stereo.aif', lowOct:5, highOct:7, noteStyle:'flat',
    gateOpts:{corrThreshold:0.80, minBackwardSec:0.10, minForwardSec:0.20}},
  iowa_viola_sulC: {baseUrl:'/iowa-mis/Strings/Viola/',  filePattern:'Viola.arco.ff.sulC.{NOTE}.stereo.aif', lowOct:3, highOct:4, noteStyle:'flat',
    gateOpts:{corrThreshold:0.80, minBackwardSec:0.10, minForwardSec:0.20}},
  iowa_viola_sulG: {baseUrl:'/iowa-mis/Strings/Viola/',  filePattern:'Viola.arco.ff.sulG.{NOTE}.stereo.aif', lowOct:3, highOct:5, noteStyle:'flat',
    gateOpts:{corrThreshold:0.80, minBackwardSec:0.10, minForwardSec:0.20}},
  iowa_viola_sulD: {baseUrl:'/iowa-mis/Strings/Viola/',  filePattern:'Viola.arco.ff.sulD.{NOTE}.stereo.aif', lowOct:4, highOct:5, noteStyle:'flat',
    gateOpts:{corrThreshold:0.80, minBackwardSec:0.10, minForwardSec:0.20}},
  iowa_viola_sulA: {baseUrl:'/iowa-mis/Strings/Viola/',  filePattern:'Viola.arco.ff.sulA.{NOTE}.stereo.aif', lowOct:4, highOct:6, noteStyle:'flat',
    gateOpts:{corrThreshold:0.80, minBackwardSec:0.10, minForwardSec:0.20}},
  iowa_cello_sulC: {baseUrl:'/iowa-mis/Strings/Cello/',  filePattern:'Cello.arco.ff.sulC.{NOTE}.stereo.aif', lowOct:2, highOct:3, noteStyle:'flat',
    gateOpts:{corrThreshold:0.80, minBackwardSec:0.10, minForwardSec:0.20}},
  iowa_cello_sulG: {baseUrl:'/iowa-mis/Strings/Cello/',  filePattern:'Cello.arco.ff.sulG.{NOTE}.stereo.aif', lowOct:2, highOct:4, noteStyle:'flat',
    gateOpts:{corrThreshold:0.80, minBackwardSec:0.10, minForwardSec:0.20}},
  iowa_cello_sulD: {baseUrl:'/iowa-mis/Strings/Cello/',  filePattern:'Cello.arco.ff.sulD.{NOTE}.stereo.aif', lowOct:3, highOct:4, noteStyle:'flat',
    gateOpts:{corrThreshold:0.80, minBackwardSec:0.10, minForwardSec:0.20}},
  iowa_cello_sulA: {baseUrl:'/iowa-mis/Strings/Cello/',  filePattern:'Cello.arco.ff.sulA.{NOTE}.stereo.aif', lowOct:3, highOct:6, noteStyle:'flat',
    gateOpts:{corrThreshold:0.80, minBackwardSec:0.10, minForwardSec:0.20}},
  iowa_bass_sulE:  {baseUrl:'/iowa-mis/Strings/Double%20Bass/', filePattern:'Bass.arco.ff.sulE.{NOTE}.stereo.aif', lowOct:1, highOct:2, noteStyle:'flat',
    gateOpts:{corrThreshold:0.80, minBackwardSec:0.10, minForwardSec:0.20}},
  iowa_bass_sulA:  {baseUrl:'/iowa-mis/Strings/Double%20Bass/', filePattern:'Bass.arco.ff.sulA.{NOTE}.stereo.aif', lowOct:1, highOct:3, noteStyle:'flat',
    gateOpts:{corrThreshold:0.80, minBackwardSec:0.10, minForwardSec:0.20}},
  iowa_bass_sulD:  {baseUrl:'/iowa-mis/Strings/Double%20Bass/', filePattern:'Bass.arco.ff.sulD.{NOTE}.stereo.aif', lowOct:2, highOct:3, noteStyle:'flat',
    gateOpts:{corrThreshold:0.80, minBackwardSec:0.10, minForwardSec:0.20}},
  iowa_bass_sulG:  {baseUrl:'/iowa-mis/Strings/Double%20Bass/', filePattern:'Bass.arco.ff.sulG.{NOTE}.stereo.aif', lowOct:2, highOct:4, noteStyle:'flat',
    gateOpts:{corrThreshold:0.80, minBackwardSec:0.10, minForwardSec:0.20}},
  /* SSO solo Violin — purpose-built sample-library material with steady-state
     legato sustains, in contrast to Iowa's musical-performance recordings.
     Sampled at minor thirds: G3, A#3, C#4, E4, G4, A#4, ... C#7 (one note per
     octave-step, four per octave) — noteSemis below picks exactly those four
     semitones so the analyzer doesn't 404-spam the 8 we know aren't there.
     Filenames are lowercase (violin-a#4.wav); jsdelivr is case-sensitive,
     uppercase 403s. noteStyle:'sharp_lower' produces the lowercased note
     names with literal `#` (URL-encoded to %23 at fetch time). Vibrato hint
     still applies — SSO strings carry pitch vibrato. */
  sso_violin: {baseUrl:'https://cdn.jsdelivr.net/gh/peastman/sso@master/Sonatina%20Symphonic%20Orchestra/Samples/Violin/',
    filePattern:'violin-{NOTE}.wav', lowOct:3, highOct:7, noteStyle:'sharp_lower',
    noteSemis:[1,4,7,10],
    gateOpts:{corrThreshold:0.90, corrWindowPeriods:2}},
  /* VCSL Didgeridoo — unlabeled drone files. Currently shipping as a
     single-sample instrument (Db2 ≈ 68 Hz, measured by analyzer/didgeridoo.js).
     If pitch detection improves, the engine could carry multiple drones at
     different pitches; for now, this lets you load any of the three Sus*
     takes in the analyzer and compare their fundamentals by ear/eye.
     Filename overrides the {NOTE} template — same trick as didgeridoo.js. */
  didgeridoo_sus2:{baseUrl:'https://cdn.jsdelivr.net/gh/sgossner/VCSL@master/Aerophones/Lip%20Aerophones/Didgeridoo/', filePattern:'Didgeridoo1_Sus2_Main.wav', lowOct:2, highOct:2, noteStyle:'flat'},
  didgeridoo_sus3:{baseUrl:'https://cdn.jsdelivr.net/gh/sgossner/VCSL@master/Aerophones/Lip%20Aerophones/Didgeridoo/', filePattern:'Didgeridoo1_Sus3_Main.wav', lowOct:2, highOct:2, noteStyle:'flat'},
  didgeridoo_sus8:{baseUrl:'https://cdn.jsdelivr.net/gh/sgossner/VCSL@master/Aerophones/Lip%20Aerophones/Didgeridoo/', filePattern:'Didgeridoo1_Sus8_Main.wav', lowOct:2, highOct:2, noteStyle:'flat'},
  trombone:    {baseUrl:'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/trombone-mp3/',    lowOct:1, highOct:5,
    /* corrThreshold: bumped to 0.99 (default 0.95). Trombone's harmonic
       structure varies just enough across the sample that 0.95 admits picks
       whose 3-period waveform correlates "OK but not perfect" with the
       anchor — the resulting seams sound mostly clean but show audible
       inconsistencies on long sustained chords. 0.99 is strict enough to
       force phase-perfect coherence and Trombone has more than enough valid
       picks to support that.
       rmsStepThreshold: 0.08 (default 0.25). Trombone has gradual breath-
       pressure drift across each 3s sample, so loop pairs from "far apart"
       endpoints can be phase-coherent but volume-mismatched. cliqueThreshold
       misses that (phase OK), rmsStepThreshold catches it. */
    gateOpts:{corrThreshold:0.99, rmsStepThreshold:0.08}},
  flute:       {baseUrl:'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/flute-mp3/',       lowOct:3, highOct:7,
    gateOpts:{corrThreshold:0.90, corrWindowPeriods:2}},
  /* ── Organ candidates — v0.8 research ──
     Three diverse sources. Analyzer silently 404-skips missing notes so it's
     fine if some ranges don't fully populate.

     Gleitz: MusyngKite (rendered from Musyng Kite.sfpack, 1.75GB source —
     different from FluidR3's 148MB source, so different samples) and FatBoy
     (320MB source, also distinct). Drawbar = Hammond-style, simpler harmonics;
     reed_organ = harmonium-like single-reed, typically very clean loops.

     VCSL: sgossner's CC0 pipe organ, wholetone-sampled (expect ~50% 404 rate),
     sharp-note filenames. Multiple articulations: Loud/Quiet, Pedal, Man3Open. */
  drawbar_organ_fatboy:{baseUrl:'https://gleitz.github.io/midi-js-soundfonts/FatBoy/drawbar_organ-mp3/',lowOct:1, highOct:7, transpose:2,
    /* Leslie-modulated; corrThreshold:0.90 admits the harmonic shape variation
       across the rotor cycle. Slope gate handles modulation-phase pairing. */
    gateOpts:{corrThreshold:0.90, corrWindowPeriods:2}},
  reed_organ_fatboy:{baseUrl:'https://gleitz.github.io/midi-js-soundfonts/FatBoy/reed_organ-mp3/',lowOct:1, highOct:7,
    /* corrThreshold left at 0.95 default — reed organ's harmonic structure
       shifts more than trombone's, so 0.99 would over-reject good picks.
       cliqueThreshold 0.15 (from 0.25) — final seam midpoint-RMS dev ≤15%.
       minSpacingSec 0.075 (from 0.050) — 75ms between loop points for variety.
       Left alone: minBackwardSec/minForwardSec (those govern loop LENGTH,
       not seam quality). */
    gateOpts:{cliqueThreshold:0.15, minSpacingSec:0.075}},
};

/* Chromatic note arrays — flat for FluidR3/MusyngKite/FatBoy, sharp for VCSL,
   sharp_lower for SSO (filenames like violin-a#4.wav — jsdelivr is case-
   sensitive, uppercase 403s). Keep these in sync with the headless analyzer
   in generate-samples.js. */
var CHROMATIC_FLAT       =['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
var CHROMATIC_SHARP      =['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
var CHROMATIC_SHARP_LOWER=['c','c#','d','d#','e','f','f#','g','g#','a','a#','b'];
var CHROMATIC=CHROMATIC_FLAT; /* legacy alias; freq lookup uses index, not name */

/* A4 = 440Hz (MIDI 69). C4 = MIDI 60. Octave n starts at MIDI 12*(n+1). */
function noteFreq(chromaticIdx, octave){
  var midi=12*(octave+1)+chromaticIdx;
  return 440*Math.pow(2,(midi-69)/12);
}
/* Build filename from template, substituting {NOTE} with chosen spelling.
   URL-encode sharps: `#` is a URL fragment separator, so unencoded `C#4.wav`
   truncates server-side to `C` and 404s. Targeted replacement is safe here
   because spelledName can only be [A-G][#b]?[0-9]. */
function buildUrl(cfg, spelledName){
  var pattern=cfg.filePattern||'{NOTE}.mp3';
  var filename=pattern.replace('{NOTE}',spelledName).replace(/#/g,'%23');
  return cfg.baseUrl+filename;
}
function enumerateRange(lowOct, highOct, noteStyle, noteSemis){
  var names = noteStyle==='sharp'       ? CHROMATIC_SHARP
            : noteStyle==='sharp_lower' ? CHROMATIC_SHARP_LOWER
            :                             CHROMATIC_FLAT;
  /* noteSemis: optional [0..11] subset to enumerate (e.g. [1,4,7,10] for
     SSO's minor-third sampling of C#/E/G/A#). Avoids 404-spamming the
     analyzer console for soundfonts that aren't chromatically sampled. */
  var semis = noteSemis || [0,1,2,3,4,5,6,7,8,9,10,11];
  var out=[];
  for(var o=lowOct;o<=highOct;o++){
    for(var k=0;k<semis.length;k++){
      var i=semis[k];
      out.push({name:names[i]+o, freq:+noteFreq(i,o).toFixed(2)});
    }
  }
  return out;
}

  return {
    DEFAULT_CONFIGS: DEFAULT_CONFIGS,
    CHROMATIC_FLAT: CHROMATIC_FLAT,
    CHROMATIC_SHARP: CHROMATIC_SHARP,
    CHROMATIC_SHARP_LOWER: CHROMATIC_SHARP_LOWER,
    CHROMATIC: CHROMATIC,
    noteFreq: noteFreq,
    buildUrl: buildUrl,
    enumerateRange: enumerateRange
  };
})();
