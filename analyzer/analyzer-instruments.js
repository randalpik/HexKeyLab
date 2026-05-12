/* HexKeyLab Analyzer — instrument config helpers.
   Stateless utilities for enumerating chromatic note tables and building
   sample URLs from a config object. The configs themselves live in
   analyzer/configs/*.json (the single source of truth) and are loaded by the
   page from the Vite dev server's /analyzer-configs-manifest endpoint. No DOM,
   no Web Audio.

   Config schema (matches generate-samples.js — only the analysis-relevant
   subset is consumed here):
     baseUrl     — URL prefix, appended with each filename pattern
     lowOct/highOct — MIDI octave range to enumerate (C4 = MIDI 60)
     filePattern — single template with placeholders. Default '{NOTE}.mp3'.
     filePatterns— optional array of templates, tried in order until one
                   doesn't 404. Used for Iowa MIS strings where the sul-string
                   prefix varies per pitch.
     noteStyle   — 'flat' (C,Db,D,Eb,...), 'sharp' (C,C#,D,...),
                   'sharp_lower' (c,c#,d,...), 'sharp_s' (C,Cs,D,Ds,...),
                   or 'salamander' (sparse: only 0/3/6/9 mapped). Default 'flat'.
     noteSemis   — optional [0..11] subset of chromatic semitones to enumerate
                   (e.g. SSO minor-third sampling [1,4,7,10]). Default: all 12.
     transpose   — integer ratio between filename pitch and actual audio pitch
                   (FatBoy drawbar files are labeled an octave above content,
                   transpose:2 makes the analyzer compare against the actual
                   fundamental).
     gateOpts    — per-instrument prepareLoop threshold overrides.

   Placeholders supported in filePattern / filePatterns entries (mirrors
   generate-samples.js applyPlaceholders):
     {NOTE}        — full note with octave (e.g. "F#4", "Bb3")
     {NOTE_LETTER} — letter without octave (e.g. "F#", "Bb")
     {NOTE_LOWER}  — full note lowercased (SSO violin: "violin-c4.wav")
     {MIDI}        — 3-digit zero-padded MIDI number ("060", "069")
   '#' is URL-encoded to '%23' after substitution. */

export const HKLInstruments = (function () {
  /* Chromatic note arrays — keep these in sync with the headless analyzer in
     generate-samples.js. SALAMANDER_NOTES is sparse on purpose (the source
     only ships C/Ds/Fs/A per octave); enumerateRange treats missing semis as
     skipped, which works because every salamander config sets noteSemis to
     [0,3,6,9] anyway. */
  var CHROMATIC_FLAT        = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
  var CHROMATIC_SHARP       = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  var CHROMATIC_SHARP_S     = ['C','Cs','D','Ds','E','F','Fs','G','Gs','A','As','B'];
  var CHROMATIC_SHARP_LOWER = ['c','c#','d','d#','e','f','f#','g','g#','a','a#','b'];
  var SALAMANDER_NOTES      = { 0:'C', 3:'Ds', 6:'Fs', 9:'A' };
  var CHROMATIC = CHROMATIC_FLAT; /* legacy alias; freq lookup uses index, not name */

  /* A4 = 440Hz (MIDI 69). C4 = MIDI 60. Octave n starts at MIDI 12*(n+1). */
  function noteFreq(chromaticIdx, octave) {
    var midi = 12 * (octave + 1) + chromaticIdx;
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function noteNameForSemi(noteStyle, semi) {
    if (noteStyle === 'salamander')   return SALAMANDER_NOTES[semi];        /* sparse — may be undefined */
    if (noteStyle === 'sharp')        return CHROMATIC_SHARP[semi];
    if (noteStyle === 'sharp_s')      return CHROMATIC_SHARP_S[semi];
    if (noteStyle === 'sharp_lower')  return CHROMATIC_SHARP_LOWER[semi];
    return CHROMATIC_FLAT[semi];
  }

  /* Substitute the four supported placeholders, then URL-encode any literal
     '#' to '%23'. Mirrors generate-samples.js:113-128 exactly — keep them in
     sync if either gains new placeholders. */
  function applyPlaceholders(pattern, spelledName, midi) {
    var letter = spelledName.replace(/\d+$/, '');
    var midiStr = String(midi).padStart(3, '0');
    return pattern
      .replace(/\{NOTE_LETTER\}/g, letter)
      .replace(/\{NOTE_LOWER\}/g, spelledName.toLowerCase())
      .replace(/\{MIDI\}/g, midiStr)
      .replace(/\{NOTE\}/g, spelledName)
      .replace(/#/g, '%23');
  }

  /* Returns the ordered candidate URLs for a single note. The harness fetches
     them in sequence and uses the first non-404. Single-pattern configs come
     back as a length-1 array — caller doesn't branch. */
  function buildUrls(cfg, spelledName, midi) {
    var patterns = cfg.filePatterns || [cfg.filePattern || '{NOTE}.mp3'];
    var out = [];
    for (var i = 0; i < patterns.length; i++) {
      out.push(cfg.baseUrl + applyPlaceholders(patterns[i], spelledName, midi));
    }
    return out;
  }

  /* Back-compat single-URL wrapper for any caller still on the old signature.
     Returns the first candidate (= the only one for non-filePatterns configs). */
  function buildUrl(cfg, spelledName, midi) {
    return buildUrls(cfg, spelledName, midi)[0];
  }

  function enumerateRange(lowOct, highOct, noteStyle, noteSemis) {
    /* noteSemis: optional [0..11] subset to enumerate (e.g. [1,4,7,10] for
       SSO's minor-third sampling of C#/E/G/A#). Avoids 404-spamming the
       analyzer console for soundfonts that aren't chromatically sampled.
       Salamander noteStyle is sparse — semitones outside {0,3,6,9} yield
       undefined names and are skipped silently. */
    var semis = noteSemis || [0,1,2,3,4,5,6,7,8,9,10,11];
    var out = [];
    for (var o = lowOct; o <= highOct; o++) {
      for (var k = 0; k < semis.length; k++) {
        var semi = semis[k];
        var name = noteNameForSemi(noteStyle, semi);
        if (!name) continue;
        var midi = 12 * (o + 1) + semi;
        out.push({ name: name + o, midi: midi, freq: +noteFreq(semi, o).toFixed(2) });
      }
    }
    return out;
  }

  /* Iowa MIS configs are written with their canonical theremin.music.uiowa.edu
     URLs (correct for the Node-side generate-samples.js, which is CORS-free).
     The browser can't fetch those — both because of CORS and because Firefox's
     Web Audio doesn't decode AIFF. Rewrite to the Vite dev server's /iowa-mis
     (2014 chromatic tree) or /iowa-mis-legacy (everything else under /MIS/,
     including the Piano set) so the existing middleware transcodes to WAV on
     the fly. Order matters — try the more-specific 2014 prefix first. */
  var IOWA_PROXY_RULES = [
    { from: 'https://theremin.music.uiowa.edu/sound%20files/MIS%20Pitches%20-%202014/', to: '/iowa-mis/' },
    { from: 'https://theremin.music.uiowa.edu/sound%20files/MIS/',                      to: '/iowa-mis-legacy/' },
  ];
  function rewriteIowaBaseUrl(baseUrl) {
    for (var i = 0; i < IOWA_PROXY_RULES.length; i++) {
      var rule = IOWA_PROXY_RULES[i];
      if (baseUrl.indexOf(rule.from) === 0) return rule.to + baseUrl.slice(rule.from.length);
    }
    return baseUrl;
  }

  return {
    CHROMATIC_FLAT: CHROMATIC_FLAT,
    CHROMATIC_SHARP: CHROMATIC_SHARP,
    CHROMATIC_SHARP_S: CHROMATIC_SHARP_S,
    CHROMATIC_SHARP_LOWER: CHROMATIC_SHARP_LOWER,
    SALAMANDER_NOTES: SALAMANDER_NOTES,
    CHROMATIC: CHROMATIC,
    noteFreq: noteFreq,
    buildUrl: buildUrl,
    buildUrls: buildUrls,
    enumerateRange: enumerateRange,
    rewriteIowaBaseUrl: rewriteIowaBaseUrl
  };
})();
