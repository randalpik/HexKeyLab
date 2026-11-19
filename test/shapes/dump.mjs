// Text dump of the shape guide: every entry's name, ratio, intervals, starting position and keys,
// with a rough picture of its shape. For reading the guide's content before it is drawn.
//
// The picture is the lattice with rows level (+Q to the right, each row up half a key to the right,
// near the Lumatone rotation): [C ] a member, (E ) a path key, ‖ a seam where it passes between two
// keys' places in a pictured row. A seam's slanting segments, and any beyond the pictured rows, are
// not shown; the page (/shapes.html) draws the whole seam.
//
// Run: node --import ./test/orchestrator-smoke/register-ts.mjs test/shapes/dump.mjs [mapping] [mode]
//      (defaults: randal 5)

import { buildGuide } from '../../apps/hkl/src/shapes/guide.ts';
import { anchorOf } from '../../packages/shared/src/freq.ts';
import { noteName, keyOctave } from '../../packages/shared/src/notes.ts';
import { keyColor } from '../../packages/shared/src/keycolor.ts';
import { MAPPING_LABELS } from '../../packages/shared/src/mapping.ts';

const mapping = process.argv[2] ?? 'randal', mode = process.argv[3] ?? '5';
const L = { mode, mapping, anchor: anchorOf(0, 0, mapping), banded: true };
const name = ([q, r]) => noteName(q, r, mapping, L.anchor, L.banded);
const full = (c) => name(c) + keyOctave(c[0], c[1], mapping, L.anchor, L.banded);
const HUES = { PU: 'purple', PK: 'pink', DA: 'dandelion', SG: 'spring-green', BL: 'blue', TE: 'teal', GR: 'green', YE: 'yellow', OR: 'orange' };
const W = 6;

function picture(sh) {
  const shown = [...sh.cells, ...sh.path];
  const qLo = Math.min(...shown.map((c) => c[0])), rLo = Math.min(...shown.map((c) => c[1])), rHi = Math.max(...shown.map((c) => c[1]));
  const x = ([q, r]) => W * (q - qLo) + (W / 2) * (r - rLo);
  const lines = [];
  for (let r = rHi; r >= rLo; r--) {
    const row = [];
    const put = (at, text) => { for (let i = 0; i < text.length; i++) row[at + i] = text[i]; };
    for (const c of sh.cells) if (c[1] === r) put(x(c), '[' + name(c).padEnd(3) + ']');
    for (const c of sh.path) if (c[1] === r) put(x(c), '(' + name(c).padEnd(3) + ')');
    /* a seam segment between two keys of this row sits in the gap after the left one */
    for (const [a, b] of sh.seams) if (a[1] === r && b[1] === r) { const at = x(a[0] < b[0] ? a : b) + W - 1; if (at >= 0) put(at, '‖'); }
    lines.push('      ' + Array.from(row, (ch) => ch ?? ' ').join('').trimEnd());
  }
  return lines.join('\n');
}

const guide = buildGuide(L);
console.log(`Shape guide — ${MAPPING_LABELS[mapping] ?? mapping}, mode ${mode}, banded — ${guide.length} entries\n`);
let section = '';
guide.forEach((g, i) => {
  const head = g.kind === 'interval' ? 'INTERVALS' : g.kind === 'scale' ? 'SCALES' : g.members.length === 3 ? 'TRIADS' : 'SEVENTHS';
  if (head !== section) { section = head; console.log(`──── ${head} ────\n`); }
  console.log(`${String(i + 1).padStart(2)}. ${g.name} — ${g.ratio}${g.cents ? '  ' + g.cents : ''}`);
  const sh = g.shape, hue = keyColor(sh.bass[0], sh.bass[1], mode, mapping, L.anchor, L.banded).hue;
  if (g.steps.length) console.log(`      steps: ${g.steps.join(', ')}${g.others.length ? '   also: ' + g.others.join(', ') : ''}`);
  console.log(`      start: ${g.start}   (drawn from the ${HUES[hue] ?? hue} C, ${full(sh.bass)} at ${sh.bass})`);
  console.log(`      keys: ${sh.cells.map(full).join(' ')}${sh.path.length ? '   path: ' + sh.path.map(full).join(' ') : ''}`);
  console.log(picture(sh) + '\n');
});
