// LilyPond emission. Builds a grand-staff score with colored noteheads.
// Single-color chords use a leading \tweak that paints NoteHead and Stem;
// multi-color chords paint per-notehead inside the < > and leave the stem
// default. Tied atoms append `~`; rests render `r` with the same duration
// tokens.
//
// Source-onset IDs ride as `% onset-ids: [...]` comments above each chord
// so a future correction UI can locate raw events from a rendered notehead.

import type { QNote, QNoteAtom, VoicedScore } from './types.js';

interface EmitMeta {
  numerator: number;
  bpm: number;
  title: string;
}

function escapeLyString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function hexToScheme(hex: string): string {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return '(rgb-color ' + r.toFixed(3) + ' ' + g.toFixed(3) + ' ' + b.toFixed(3) + ')';
}

function colorTweak(hex: string): string {
  return '\\tweak NoteHead.color #' + hexToScheme(hex);
}

function durToken(a: QNoteAtom): string {
  return a.notation.base + (a.notation.dots > 0 ? '.' : '');
}

function emitRest(q: QNote): string {
  return q.atoms.map((a) => 'r' + durToken(a)).join(' ');
}

function emitSingle(q: QNote): string {
  const tweak = colorTweak(q.colors[0]);
  const p = q.lyPitches[0];
  return q.atoms
    .map((a) => tweak + ' ' + p + durToken(a) + (a.notation.tied ? '~' : ''))
    .join(' ');
}

function emitChord(q: QNote): string {
  const colors = q.colors;
  const homogeneous = colors.every((c) => c === colors[0]);
  if (homogeneous) {
    const tweak = colorTweak(colors[0]);
    const body = q.lyPitches.join(' ');
    return q.atoms
      .map((a) => tweak + ' <' + body + '>' + durToken(a) + (a.notation.tied ? '~' : ''))
      .join(' ');
  }
  const body = q.lyPitches
    .map((p, i) => '\\tweak NoteHead.color #' + hexToScheme(colors[i]) + ' ' + p)
    .join(' ');
  return q.atoms
    .map((a) => '<' + body + '>' + durToken(a) + (a.notation.tied ? '~' : ''))
    .join(' ');
}

function emitQNote(q: QNote): string {
  if (q.isRest) return emitRest(q);
  if (q.pitches.length === 0) return emitRest(q);
  const idComment = '% onset-ids: [' + q.sourceOnsetIds.join(',') + ']\n  ';
  const body = q.pitches.length === 1 ? emitSingle(q) : emitChord(q);
  return idComment + body;
}

function emitVoice(notes: QNote[]): string {
  return notes.map(emitQNote).join('\n  ');
}

export function emitLilypond(voiced: VoicedScore, meta: EmitMeta): string {
  const treble = emitVoice(voiced.treble);
  const bass = emitVoice(voiced.bass);
  const title = escapeLyString(meta.title);
  const bpm = Math.max(1, Math.round(meta.bpm));
  const num = Math.max(1, Math.round(meta.numerator));

  return `\\version "2.24.0"
\\language "nederlands"

\\header {
  title = "${title}"
  composer = "HexKeyLab"
}

\\paper {
  #(set-paper-size "letter")
}

\\score {
  \\new PianoStaff <<
    \\new Staff = "RH" {
      \\clef treble
      \\time ${num}/4
      \\tempo 4 = ${bpm}
      ${treble}
    }
    \\new Staff = "LH" {
      \\clef bass
      \\time ${num}/4
      ${bass}
    }
  >>
  \\layout {}
}
`;
}
