// Local-source picker. Drag-drop + file-input multi-select.
//
// Reverses HKLInstruments noteStyle parsing to extract a labeled
// (note, octave) from each filename. Files that don't parse are still
// shown (in red) so the user can rename them. Parsed slots become
// SampleSlot entries in state.samples with state='pending'.

import { getState, onChange, setSource, setSamples, setStatus } from './stage.js';
import type { SampleSlot } from './state.js';
import type { NoteStyle } from '@hkl/shared/cdnConfig.js';

const LETTER_TO_SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

interface ParsedNote {
  semi: number;
  octave: number;
  name: string;     // canonical "C4", "Db4", etc.
  midi: number;
}

/** Try to parse a filename stem against a noteStyle hint. Falls through
 *  to a generic regex if hint doesn't match.
 *
 *  Returns null when the filename has no recognizable note in it. */
function parseFilename(stem: string, hint: NoteStyle): ParsedNote | null {
  /* Strip common prefixes some libraries put before the note label
     (e.g. "VC_C4.wav", "fluidR3-Db5.mp3"). The regex below pulls the FIRST
     match of [letter][optional accidental][octave] anywhere in the stem. */
  let re: RegExp;
  switch (hint) {
    case 'flat':
      re = /([A-G])(b|♭)?(-?\d+)/;
      break;
    case 'sharp':
      re = /([A-G])(#|♯)?(-?\d+)/;
      break;
    case 'sharp_s':
      re = /([A-G])(s)?(-?\d+)/;
      break;
    case 'sharp_lower':
      re = /([a-g])(#|♯)?(-?\d+)/;
      break;
    case 'salamander':
      re = /([A-G])(s)?(-?\d+)/;
      break;
    default:
      re = /([A-Ga-g])([#bs♭♯]?)(-?\d+)/;
  }
  let m = stem.match(re);
  if (!m) {
    /* Last-ditch: try a generic case-insensitive match. */
    m = stem.match(/([A-Ga-g])([#bs♭♯]?)(-?\d+)/);
    if (!m) return null;
  }
  const letter = m[1].toUpperCase();
  const accidRaw = m[2] || '';
  const octave = parseInt(m[3], 10);
  if (!(letter in LETTER_TO_SEMI)) return null;
  let semi = LETTER_TO_SEMI[letter];
  if (accidRaw === '#' || accidRaw === '♯' || accidRaw === 's') semi += 1;
  else if (accidRaw === 'b' || accidRaw === '♭') semi -= 1;
  const midi = 12 * (octave + 1) + semi;
  return { semi, octave, name: canonicalNoteName(semi, octave, hint), midi };
}

const FLAT  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
const SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const SHARP_S = ['C','Cs','D','Ds','E','F','Fs','G','Gs','A','As','B'];
const SHARP_LOWER = ['c','c#','d','d#','e','f','f#','g','g#','a','a#','b'];

function canonicalNoteName(semi: number, octave: number, style: NoteStyle): string {
  const s = ((semi % 12) + 12) % 12;
  switch (style) {
    case 'sharp':       return SHARP[s] + octave;
    case 'sharp_s':     return SHARP_S[s] + octave;
    case 'sharp_lower': return SHARP_LOWER[s] + octave;
    case 'salamander':  /* salamander is sparse; salamander filenames use C/Ds/Fs/A */
                        return (SHARP_S[s] || FLAT[s]) + octave;
    case 'flat':
    default:            return FLAT[s] + octave;
  }
}

function noteFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function stemOf(name: string): string {
  const slash = name.lastIndexOf('/');
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

interface FileRow {
  file: File;
  parsed: ParsedNote | null;
}

function rebuildLocalSamples(files: File[]): { slots: SampleSlot[]; rows: FileRow[] } {
  const state = getState();
  const hint = state.config.noteStyle;
  const semis = state.config.transposeSemis ?? 0;
  /* Audio freq = labeled freq × 2^(semis/12). semis<0 → audio below label.
     slot.midi stays the LABELED midi (matches filename, used for {MIDI}
     placeholder); slot.freq is the AUDIO freq (analyzer hint + output). */
  const semFactor = Math.pow(2, semis / 12);
  const rows: FileRow[] = files.map(f => ({ file: f, parsed: parseFilename(stemOf(f.name), hint) }));
  const slots: SampleSlot[] = [];
  for (const row of rows) {
    if (!row.parsed) continue;
    const labeledMidi = row.parsed.midi;
    const labeledFreq = noteFreq(labeledMidi);
    const audioFreq = labeledFreq * semFactor;
    slots.push({
      name: row.parsed.name,
      freq: +audioFreq.toFixed(2),
      midi: labeledMidi,
      file: row.file,
      originalFileName: row.file.name,
      picked: false,
      state: 'pending',
    });
  }
  slots.sort((a, b) => a.midi - b.midi);
  return { slots, rows };
}

function renderFileList(rows: FileRow[]): void {
  const host = document.getElementById('sourceFileList');
  if (!host) return;
  host.innerHTML = '';
  if (rows.length === 0) {
    host.textContent = '';
    return;
  }
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'row' + (r.parsed ? '' : ' unparsed');
    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = r.parsed ? r.parsed.name : '(unparsed)';
    const fname = document.createElement('span');
    fname.textContent = r.file.name + ' · ' + Math.round(r.file.size / 1024) + ' KB';
    row.appendChild(note);
    row.appendChild(fname);
    host.appendChild(row);
  }
}

function ingestFiles(files: File[]): void {
  setSource({ mode: 'local', files });
  const { slots, rows } = rebuildLocalSamples(files);
  setSamples(slots);
  renderFileList(rows);
  const parsed = slots.length;
  const total = files.length;
  if (parsed === 0) {
    setStatus(`0/${total} files parsed. Check the note style — none of the filenames matched.`, 0);
  } else if (parsed < total) {
    setStatus(`${parsed}/${total} files parsed. ${total - parsed} couldn't be matched to a note.`, 0);
  } else {
    setStatus(`Loaded ${parsed} files. Ready to analyze.`, 0);
  }
}

function renderFromState(): void {
  const state = getState();
  if (state.source.mode !== 'local') { renderFileList([]); return; }
  /* Don't replace state.samples here — they were already restored from the
     draft. Just re-render the file list display from state.source.files. */
  const { rows } = rebuildLocalSamples(state.source.files);
  renderFileList(rows);
}

/** Initialize the local-source UI. */
export function initSourcePicker(): void {
  const dropZone = document.getElementById('sourceLocalDrop');
  const input = document.getElementById('sourceLocalInput') as HTMLInputElement | null;
  if (!dropZone || !input) return;

  dropZone.addEventListener('click', () => { input.value = ''; input.click(); });
  input.addEventListener('change', () => {
    const files = input.files ? Array.from(input.files) : [];
    if (files.length > 0) ingestFiles(files);
  });

  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('dragging');
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragging');
  });
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragging');
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
    if (files.length > 0) ingestFiles(files);
  });

  /* When the source mode tab flips, mirror state into the file list. */
  document.addEventListener('analyzer-source-mode', (e: Event) => {
    const detail = (e as CustomEvent<string>).detail;
    if (detail !== 'local') {
      renderFileList([]);
    } else {
      renderFromState();
    }
  });

  /* Initial paint from any hydrated state. */
  renderFromState();

  /* Watch for state changes that should re-render the file list — most
     importantly the Clear button's reset (state.source.files goes empty). */
  const initSrc = getState().source;
  let lastFilesLen = initSrc.mode === 'local' ? initSrc.files.length : -1;
  onChange(() => {
    const src = getState().source;
    if (src.mode !== 'local') return;
    if (src.files.length !== lastFilesLen) {
      lastFilesLen = src.files.length;
      renderFromState();
    }
  });

  /* If the user changes noteStyle or transposeSemis after dropping files,
     rebuild the slot list so re-parsing happens. */
  let lastStyle = getState().config.noteStyle;
  let lastSemis = getState().config.transposeSemis;
  onChange(() => {
    const state = getState();
    if (state.source.mode !== 'local') return;
    if (state.config.noteStyle === lastStyle && state.config.transposeSemis === lastSemis) return;
    lastStyle = state.config.noteStyle;
    lastSemis = state.config.transposeSemis;
    const { slots, rows } = rebuildLocalSamples(state.source.files);
    setSamples(slots);
    renderFileList(rows);
  });
}
