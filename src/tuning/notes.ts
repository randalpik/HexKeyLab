// Algorithmic note naming — handles any r value with no lookup table.

export const letterSemi: Record<string, number> = { A: 0, B: 2, C: 3, D: 5, E: 7, F: 8, G: 10 };

export function accToVal(a: string): number {
  let v = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '#') v++;
    else if (a[i] === 'b') v--;
  }
  return v;
}

export function valToAcc(v: number): string {
  if (v === 0) return '';
  if (v > 0) {
    let s = '';
    for (let i = 0; i < v; i++) s += '#';
    return s;
  }
  let s = '';
  for (let i = 0; i < -v; i++) s += 'b';
  return s;
}

export interface ParsedNote {
  letter: string;
  acc: string;
}

export function parseNote(n: string): ParsedNote {
  return { letter: n[0], acc: n.slice(1) };
}

export function m3up(n: string): string {
  const p = parseNote(n);
  const L = 'ABCDEFG';
  const i = L.indexOf(p.letter);
  const nl = L[(i + 2) % 7];
  const nat = (letterSemi[nl] - letterSemi[p.letter] + 12) % 12;
  const nv = 4 - nat + accToVal(p.acc);
  return nl + valToAcc(nv);
}

export function m3dn(n: string): string {
  const p = parseNote(n);
  const L = 'ABCDEFG';
  const i = L.indexOf(p.letter);
  const nl = L[((i - 2) % 7 + 7) % 7];
  const nat = (letterSemi[p.letter] - letterSemi[nl] + 12) % 12;
  const nv = -(4 - nat) + accToVal(p.acc);
  return nl + valToAcc(nv);
}

/* compute note name for r-th fifth above A (works for any integer r) */
export function fifthName(r: number): string {
  if (r >= 0) {
    const letter = 'AEBFCGD'[r % 7];
    const acc = Math.floor(r / 7) + ((r % 7 >= 3) ? 1 : 0);
    return letter + valToAcc(acc);
  } else {
    const rr = -r;
    const letter = 'ADGCFBE'[rr % 7];
    const acc = Math.floor(rr / 7) + ((rr % 7 >= 5) ? 1 : 0);
    return letter + valToAcc(-acc);
  }
}

export function noteName(q: number, r: number): string {
  const fn = fifthName(r);
  const pos = ((q + 1) % 3 + 3) % 3;
  if (pos === 1) return fn;
  if (pos === 2) return m3up(fn);
  return m3dn(fn);
}

export const SHARP = '♯';
export const DBLSHARP = '\u{1D12A}';
export const FLAT = '♭';
export const DBLFLAT = '\u{1D12B}';

export function fmtNote(name: string): string {
  if (name === '?') return '?';
  const p = parseNote(name);
  const v = accToVal(p.acc);
  if (v === 0) return p.letter;
  let s = p.letter;
  const abs = Math.abs(v);
  const single = v > 0 ? SHARP : FLAT;
  const dbl = v > 0 ? DBLSHARP : DBLFLAT;
  if (abs % 2 === 1) s += single;
  for (let i = 0; i < Math.floor(abs / 2); i++) s += dbl;
  return s;
}

/* octave boundary is determined by letter name only, ignoring accidentals:
   Cb4 is octave 4 (C-letter), B#3 is octave 3 (B-letter) */
export function keyOctave(q: number, r: number): number {
  const name = noteName(q, r);
  const v = accToVal(parseNote(name).acc);
  const natMidi = 57 + 4 * q + 7 * r - v; /* strip accidental to get natural-letter MIDI */
  return Math.floor(natMidi / 12) - 1;
}
