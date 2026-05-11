#!/usr/bin/env node
/**
 * backfill-patterns.js — populate the .pattern sidecars next to cached audio
 * files so emitSampleEntry can write the correct per-sample `file` field
 * without re-downloading the audio.
 *
 * The cache layout that pre-dates filePatterns sidecars looks like:
 *   analyzer/.cache/<key>/<note>.<ext>     ← audio
 * The current loader expects:
 *   analyzer/.cache/<key>/<note>.<ext>     ← audio
 *   analyzer/.cache/<key>/<note>.pattern   ← which filePattern matched
 *
 * Without the sidecar, emitSampleEntry guesses the first filePattern, which
 * is wrong for ~75% of Iowa violin notes (different sul-string per pitch).
 * This script HEAD-checks each filePattern in order — same logic the fetch
 * loop uses — and writes the matched filename into the sidecar. Cheap: one
 * HEAD per pattern per note.
 *
 * Usage: node analyzer/backfill-patterns.js analyzer/configs/<name>.json [<name>.json ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const CACHE_DIR  = path.join(__dirname, '.cache');

const NOTES_FLAT  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
const NOTES_SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const NOTES_SHARP_S = ['C','Cs','D','Ds','E','F','Fs','G','Gs','A','As','B'];
const NOTES_SHARP_LOWER = ['c','c#','d','d#','e','f','f#','g','g#','a','a#','b'];
const SALAMANDER_NOTES = { 0:'C', 3:'Ds', 6:'Fs', 9:'A' };
const SEMI = {C:0,'C#':1,Cs:1,Db:1,D:2,'D#':3,Ds:3,Eb:3,E:4,F:5,'F#':6,Fs:6,Gb:6,G:7,'G#':8,Gs:8,Ab:8,A:9,'A#':10,As:10,Bb:10,B:11};

function applyPlaceholders(pattern, note, midi) {
  const letter = note.replace(/\d+$/, '');
  const midiStr = String(midi).padStart(3, '0');
  return pattern
    .replace(/\{NOTE_LETTER\}/g, letter)
    .replace(/\{NOTE_LOWER\}/g, note.toLowerCase())
    .replace(/\{MIDI\}/g, midiStr)
    .replace(/\{NOTE\}/g, note)
    .replace(/#/g, '%23');
}

function enumerateNotes(cfg) {
  const out = [];
  const semis = cfg.noteSemis || [0,1,2,3,4,5,6,7,8,9,10,11];
  for (let oct = cfg.lowOct; oct <= cfg.highOct; oct++) {
    for (const semi of semis) {
      let name;
      if (cfg.noteStyle === 'salamander') name = SALAMANDER_NOTES[semi];
      else if (cfg.noteStyle === 'sharp') name = NOTES_SHARP[semi];
      else if (cfg.noteStyle === 'sharp_s') name = NOTES_SHARP_S[semi];
      else if (cfg.noteStyle === 'sharp_lower') name = NOTES_SHARP_LOWER[semi];
      else                                 name = NOTES_FLAT[semi];
      if (!name) continue;
      const midi = 12*(oct+1) + semi;
      out.push({ note: name + oct, midi });
    }
  }
  return out;
}

function headOk(url) {
  const r = spawnSync('curl', ['-sILo', '/dev/null', '-w', '%{http_code}', url], { encoding: 'utf8' });
  return r.stdout.trim() === '200';
}

for (const cfgPath of process.argv.slice(2)) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const dir = path.join(CACHE_DIR, cfg.instrumentKey);
  if (!fs.existsSync(dir)) { console.error(`no cache for ${cfg.instrumentKey}, skipping`); continue; }
  const notes = enumerateNotes(cfg);
  const patterns = cfg.filePatterns || [cfg.filePattern];
  let nWritten = 0, nKept = 0, nProbed = 0, nMissing = 0;
  for (const n of notes) {
    const audioFile = path.join(dir, `${n.note}${cfg.ext}`);
    const patFile = path.join(dir, `${n.note}.pattern`);
    if (!fs.existsSync(audioFile)) continue;
    if (fs.existsSync(patFile)) { nKept++; continue; }
    let matched = null;
    if (patterns.length === 1) {
      // Single pattern — no ambiguity. Just record it.
      matched = applyPlaceholders(patterns[0], n.note, n.midi);
    } else {
      // Multi-pattern — HEAD each in order until one returns 200.
      for (const pattern of patterns) {
        const fname = applyPlaceholders(pattern, n.note, n.midi);
        if (headOk(cfg.baseUrl + fname)) { matched = fname; break; }
        nProbed++;
      }
    }
    if (matched) {
      fs.writeFileSync(patFile, matched);
      nWritten++;
    } else {
      nMissing++;
      console.error(`  ${cfg.instrumentKey}/${n.note}: no pattern hit despite cached audio?!`);
    }
  }
  console.error(`${cfg.instrumentKey}: wrote ${nWritten} sidecars, ${nKept} already present, ${nProbed} HEADs, ${nMissing} unresolved`);
}
