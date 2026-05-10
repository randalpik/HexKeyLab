// Info-panel renderer. Reads selection + tuning state, formats note cards,
// chord analysis, and intervals into the #infoLine element.

import { tuning } from '../state/tuning.js';
import { selection } from '../state/selection.js';
import { keyFreq } from '../tuning/frequency.js';
import { posInBand } from '../layout/coords.js';
import { fmtNote, noteName, keyOctave, parseNote } from '../tuning/notes.js';
import { jiRatio, intervalTier } from '../tuning/ratios.js';
import {
  intervalName, shortenInterval, equalIntervalName, letterIdx,
} from '../tuning/intervals.js';
import { analyzeChord } from '../tuning/chords.js';
import { computeHue, hueC } from './colors.js';

interface InfoKey {
  q: number;
  r: number;
  freq: number;
  name: string;
  oct: number;
  col: string;
  inB: boolean;
}

interface IntervalCellEqual {
  i: number;
  j: number;
  semis: number;
  intNum: number;
}

interface IntervalCellJI {
  i: number;
  j: number;
  rat: ReturnType<typeof jiRatio>;
  intNum: number;
}

type IntervalCell = IntervalCellEqual | IntervalCellJI;

export function updateInfo(): void {
  const el = document.getElementById('infoLine')!;
  const showAnalysis = (
    document.getElementById("cbAnalysis") as HTMLInputElement
  ).checked;
  if (selection.selectedKeys.size === 0 || !showAnalysis) {
    el.innerHTML =
      '<span class="hint">Click any key to select · shift+click for exclusive select</span>';
    return;
  }
  const keys: InfoKey[] = [];
  selection.selectedKeys.forEach(function (k) {
    const parts = k.split(','); const q = +parts[0], r = +parts[1];
    const f = keyFreq(q, r);
    const inB = tuning.septimalEnabled && ((Math.floor((r - tuning.septimalShift) / tuning.septimalW) & 1) !== 0);
    const mh = computeHue(q, r);
    const col = inB ? hueC[mh].sl! : hueC[mh].l;
    keys.push({ q, r, freq: f, name: fmtNote(noteName(q, r)), oct: keyOctave(q, r), col, inB });
  });
  keys.sort(function (a, b) { return a.freq - b.freq; });

  let html = '';
  const showCoords = (document.getElementById('cbCoords') as HTMLInputElement).checked;
  /* note cards */
  keys.forEach(function (k, i) {
    if (i > 0) html += ' ';
    const bTag = k.inB ? '<span style="color:#E44CBC;font-size:9px;font-weight:700;margin-left:2px">7</span>' : '';
    const coordTag = showCoords ? '<span style="color:#666;font-size:10px;margin-left:4px">(q=' + k.q + ' r=' + k.r + ' p=' + posInBand(k.q) + ')</span>' : '';
    html += '<span class="note-tag"><span class="note-name" style="color:' + k.col + '">' + k.name + k.oct + '</span>' + bTag + coordTag + ' <span class="freq">' + k.freq.toFixed(2) + ' Hz</span></span>';
  });

  /* chord analysis (above intervals) */
  if (keys.length >= 3) {
    const chord = analyzeChord(keys);
    if (chord) {
      html += '<div class="info-break"></div>';
      html += '<span class="chord-tag"><span style="color:' + chord.rootCol + '">' + chord.root + '</span><span class="chord-quality">' + (tuning.equalEnabled ? chord.quality.replace(/^(?:septimal|Pythagorean) /, '') : chord.quality) + (chord.invName ? ' ' + chord.invName : '') + '</span>';
      if (!tuning.equalEnabled) html += '<span class="chord-detail">' + chord.ratio + '</span>';
      html += '</span>';
    }
  }

  /* intervals — sorted by generic interval size, rows per size group */
  if (keys.length >= 2) {
    const ivls: IntervalCell[] = [];
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const nn1 = noteName(keys[i].q, keys[i].r), nn2 = noteName(keys[j].q, keys[j].r);
        const li1 = letterIdx[parseNote(nn1).letter], li2 = letterIdx[parseNote(nn2).letter];
        const o1 = keyOctave(keys[i].q, keys[i].r), o2 = keyOctave(keys[j].q, keys[j].r);
        let p1 = li1 + 7 * o1, p2 = li2 + 7 * o2;
        if (p2 < p1) { const tmp = p1; p1 = p2; p2 = tmp; }
        const intNum = p2 - p1 + 1;
        if (tuning.equalEnabled) {
          const semis = Math.abs(4 * (keys[j].q - keys[i].q) + 7 * (keys[j].r - keys[i].r));
          ivls.push({ i, j, semis, intNum });
        } else {
          const rat = jiRatio(keys[i].q, keys[i].r, keys[j].q, keys[j].r);
          ivls.push({ i, j, rat, intNum });
        }
      }
    }
    ivls.sort(function (a, b) { return a.intNum !== b.intNum ? a.intNum - b.intNum : a.i - b.i; });
    let prevNum = -1;
    const shortIvl = (document.getElementById('cbShortIvl') as HTMLInputElement).checked;
    for (let idx = 0; idx < ivls.length; idx++) {
      const iv = ivls[idx];
      if (iv.intNum !== prevNum) { html += '<div class="info-break"></div>'; prevNum = iv.intNum; }
      if (tuning.equalEnabled) {
        const eqIv = iv as IntervalCellEqual;
        const cStr = (eqIv.semis * 100).toFixed(1) + '¢';
        const iname = shortenInterval(equalIntervalName(keys[iv.i].q, keys[iv.i].r, keys[iv.j].q, keys[iv.j].r), shortIvl);
        /* rational interval (= octave multiple, incl. enharmonics like d2, A7) → green */
        const pureOct = eqIv.semis % 12 === 0;
        html += '<span class="ratio-tag tier-' + (pureOct ? 'green' : 'red') + '">';
        html += '<span style="color:' + keys[iv.i].col + '">' + keys[iv.i].name + keys[iv.i].oct + '</span>';
        html += '–';
        html += '<span style="color:' + keys[iv.j].col + '">' + keys[iv.j].name + keys[iv.j].oct + '</span>';
        html += ' <span class="cents">' + cStr + '</span>';
        html += ' <span class="interval-name">' + iname + '</span>';
      } else {
        const jiIv = iv as IntervalCellJI;
        const cents = 1200 * Math.log2(jiIv.rat.num / jiIv.rat.den);
        const cStr = cents.toFixed(1) + '¢';
        const iname = shortenInterval(intervalName(jiIv.rat.num, jiIv.rat.den, jiIv.rat.e), shortIvl);
        const tier = intervalTier(jiIv.rat.num, jiIv.rat.den);
        /* for large ratios, show prime-power form (e.g. 3^36:2^57) rather
           than sprawling integers; 2^32 threshold keeps typical intervals
           in plain num:den while compacting anything beyond ~21 fifths */
        let ratioStr: string;
        const BIG = 4294967296; /* 2^32 */
        if (jiIv.rat.num <= BIG && jiIv.rat.den <= BIG) {
          ratioStr = jiIv.rat.num + ':' + jiIv.rat.den;
        } else {
          const primes = [2, 3, 5, 7], nParts: string[] = [], dParts: string[] = [];
          for (let pi = 0; pi < 4; pi++) {
            const pe = jiIv.rat.e[pi];
            if (pe > 0) nParts.push(pe === 1 ? String(primes[pi]) : primes[pi] + '^' + pe);
            else if (pe < 0) dParts.push(-pe === 1 ? String(primes[pi]) : primes[pi] + '^' + (-pe));
          }
          ratioStr = (nParts.join('·') || '1') + ':' + (dParts.join('·') || '1');
        }
        html += '<span class="ratio-tag tier-' + tier + '">';
        html += '<span style="color:' + keys[iv.i].col + '">' + keys[iv.i].name + keys[iv.i].oct + '</span>';
        html += '–';
        html += '<span style="color:' + keys[iv.j].col + '">' + keys[iv.j].name + keys[iv.j].oct + '</span>';
        html += ' <span class="cents">' + cStr + '</span> ' + ratioStr;
        html += ' <span class="interval-name">' + iname + '</span>';
      }
      html += '</span> ';
    }
  }

  el.innerHTML = html;
}

