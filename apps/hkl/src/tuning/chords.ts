// Template-based chord recognition with prime-content classification
// (septimal / Pythagorean / 5-limit).

import { gcd, jiRatioWithState } from './ratios.js';
import type { TuningStateLike } from './regions.js';
import { noteName, parseNote } from '@hkl/shared/notes.js';
import { letterIdx } from './intervals.js';
import { bandOf } from '../layout/coords.js';

interface ChordTemplate {
  /** semitone intervals from root */
  s: number[];
  /** generic letter intervals from root (0=unison, 1=2nd, 2=3rd, …, 6=7th) */
  g: number[];
  name: string;
}

export const chordTemplates: ChordTemplate[] = [
  /* triads */
  { s: [4, 7], g: [2, 4], name: 'major triad' },
  { s: [3, 7], g: [2, 4], name: 'minor triad' },
  { s: [3, 6], g: [2, 4], name: 'diminished triad' },
  { s: [4, 8], g: [2, 4], name: 'augmented triad' },
  { s: [5, 7], g: [3, 4], name: 'suspended fourth chord' },
  { s: [2, 7], g: [1, 4], name: 'suspended second chord' },
  /* seventh chords */
  { s: [4, 7, 11], g: [2, 4, 6], name: 'major seventh' },
  { s: [4, 7, 10], g: [2, 4, 6], name: 'dominant seventh' },
  { s: [3, 7, 10], g: [2, 4, 6], name: 'minor seventh' },
  { s: [3, 7, 11], g: [2, 4, 6], name: 'minor-major seventh' },
  { s: [3, 6, 9], g: [2, 4, 6], name: 'diminished seventh' },
  { s: [3, 6, 10], g: [2, 4, 6], name: 'half-diminished seventh' },
  { s: [4, 8, 10], g: [2, 4, 6], name: 'augmented seventh' },
  { s: [4, 8, 11], g: [2, 4, 6], name: 'augmented major seventh' },
  /* added */
  { s: [2, 4, 7], g: [1, 2, 4], name: 'major added second chord' },
  { s: [2, 3, 7], g: [1, 2, 4], name: 'minor added second chord' },
  /* augmented sixth chords */
  { s: [4, 10], g: [2, 5], name: 'Italian augmented sixth chord' },
  { s: [4, 6, 10], g: [2, 3, 5], name: 'French augmented sixth chord' },
  { s: [4, 7, 10], g: [2, 4, 5], name: 'German augmented sixth chord' },
  /* incomplete sevenths (fifth omitted) */
  { s: [4, 10], g: [2, 6], name: 'incomplete dominant seventh' },
  { s: [3, 10], g: [2, 6], name: 'incomplete minor seventh' },
  { s: [4, 11], g: [2, 6], name: 'incomplete major seventh' },
  { s: [3, 11], g: [2, 6], name: 'incomplete minor-major seventh' },
  { s: [3, 9], g: [2, 6], name: 'incomplete diminished seventh' },
];

export const invNames: (string | null)[] = [null, 'in first inversion', 'in second inversion', 'in third inversion'];

export function isPow2(n: number): boolean { return n > 0 && (n & (n - 1)) === 0; }
export function lcm(a: number, b: number): number { return a / gcd(a, b) * b; }

interface ChordInputKey {
  q: number;
  r: number;
  name: string;
  col: string;
}

interface ChordResult {
  root: string;
  rootCol: string;
  quality: string;
  invName: string | null;
  ratio: string;
  isSchismatic: boolean;
}

interface ChordNote {
  pc: number;
  midi: number;
  name: string;
  col: string;
  rawName: string;
  li: number;
  q: number;
  r: number;
}

export function analyzeChord(keys: ChordInputKey[], state: TuningStateLike): ChordResult | null {
  /* In V mode, chord-ratio math runs through a D-mode substitution so the
     schisma stack doesn't contaminate prime-content classification (each
     band-crossing schisma contributes e5+=1, which would otherwise trip
     hasFive and block the Pythagorean classification on intrinsically
     Pythagorean chords). The schismatic flag is layered on top via
     band-crossing detection, independent of the ratio math. */
  const mode = state.mode;
  const ratState: TuningStateLike = mode === 'V' ? { ...state, mode: 'D' } : state;
  /* keys already sorted by freq; each has q, r, name, col */
  let notes: ChordNote[] = keys.map(k => {
    const midi = 57 + 4 * k.q + 7 * k.r;
    const nn = noteName(k.q, k.r);
    const li = letterIdx[parseNote(nn).letter];
    return { pc: ((midi % 12) + 12) % 12, midi, name: k.name, col: k.col, rawName: nn, li, q: k.q, r: k.r };
  });
  notes.sort((a, b) => a.midi - b.midi);
  /* V mode: any band-crossing pair stacks a schisma. Detect on the pre-dedup
     notes so cross-band doublings (which get dedup'd later) still flag the
     voicing. */
  let isSchismatic = false;
  if (mode === 'V') {
    outer: for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        if (bandOf(notes[i].q) !== bandOf(notes[j].q)) { isSchismatic = true; break outer; }
      }
    }
  }
  /* reject if any same-name pair is not a pure octave multiple */
  const nameGroups: Record<string, ChordNote[]> = {};
  notes.forEach(note => {
    if (!nameGroups[note.rawName]) nameGroups[note.rawName] = [];
    nameGroups[note.rawName].push(note);
  });
  for (const nm in nameGroups) {
    const grp = nameGroups[nm];
    for (let i = 0; i < grp.length; i++) for (let j = i + 1; j < grp.length; j++) {
      /* With V→D substitution, same-name cells across bands give pure octaves. */
      const rat = jiRatioWithState(grp[i].q, grp[i].r, grp[j].q, grp[j].r, ratState);
      if (rat.den !== 1 || !isPow2(rat.num)) return null;
    }
  }
  /* deduplicate by note name (keep lowest octave) */
  const seen: Record<string, true> = {};
  const unique: ChordNote[] = [];
  notes.forEach(note => {
    if (!seen[note.rawName]) { seen[note.rawName] = true; unique.push(note); }
  });
  notes = unique;
  const n = notes.length;
  if (n < 3 || n > 4) return null;
  /* try each note as root */
  for (let ri = 0; ri < n; ri++) {
    const root = notes[ri];
    const pairs: { s: number; g: number }[] = [];
    for (let i = 0; i < n; i++) {
      if (i === ri) continue;
      pairs.push({
        s: ((notes[i].pc - root.pc) % 12 + 12) % 12,
        g: ((notes[i].li - root.li) % 7 + 7) % 7,
      });
    }
    pairs.sort((a, b) => a.s - b.s);
    /* match against templates (semitones + letter distances) */
    for (let ti = 0; ti < chordTemplates.length; ti++) {
      const t = chordTemplates[ti];
      if (t.s.length !== pairs.length) continue;
      let ok = true;
      for (let k = 0; k < t.s.length; k++) {
        if (pairs[k].s !== t.s[k] || pairs[k].g !== t.g[k]) { ok = false; break; }
      }
      if (!ok) continue;
      /* matched — determine inversion */
      const chordPCs = [0].concat(t.s).map(s => (root.pc + s) % 12);
      const bassPC = notes[0].pc;
      let inv = chordPCs.indexOf(bassPC);
      if (inv < 0) inv = 0;
      /* compute chord ratio in root position order */
      const rootMidi = root.midi;
      const chordRats: { num: number; den: number }[] = [];
      for (let ci = 0; ci < n; ci++) {
        if (ci === ri) { chordRats.push({ num: 1, den: 1 }); continue; }
        const rat = jiRatioWithState(root.q, root.r, notes[ci].q, notes[ci].r, ratState);
        let rnum: number, rden: number;
        if (notes[ci].midi >= rootMidi) { rnum = rat.num; rden = rat.den; }
        else { rnum = rat.den; rden = rat.num; }
        /* octave-reduce to [1, 2) above root */
        while (rnum >= 2 * rden) rden *= 2;
        while (rnum < rden) rnum *= 2;
        const cg = gcd(rnum, rden);
        chordRats.push({ num: rnum / cg, den: rden / cg });
      }
      chordRats.sort((a, b) => a.num / a.den - b.num / b.den);
      let L = 1;
      chordRats.forEach(r => { L = lcm(L, r.den); });
      const ints = chordRats.map(r => r.num * L / r.den);
      let g2 = ints[0];
      for (let k = 1; k < ints.length; k++) g2 = gcd(g2, ints[k]);
      const ratioStr = ints.map(v => v / g2).join(':');
      /* classify chord by prime content:
         - septimal: factor of 7 present AND max term ≤ 27 (gating keeps it rare)
         - Pythagorean: only primes 2 and 3 — 3-limit throughout (no gating needed,
           it's inherently rare since the lattice naturally surfaces 5-limit thirds) */
      const terms = ints.map(v => v / g2);
      const maxTerm = Math.max.apply(null, terms);
      const hasSeven = terms.some(v => v % 7 === 0);
      const hasFive = terms.some(v => v % 5 === 0);
      const hasSeptimal = hasSeven && maxTerm <= 27;
      const isPythagorean = !hasSeven && !hasFive;
      let qName = hasSeptimal ? 'septimal ' + t.name : (isPythagorean ? 'Pythagorean ' + t.name : t.name);
      if (isSchismatic) qName = 'schismatic ' + qName;
      return {
        root: root.name,
        rootCol: root.col,
        quality: qName,
        invName: inv > 0 ? invNames[inv] : null,
        ratio: ratioStr,
        isSchismatic,
      };
    }
  }
  return null;
}
