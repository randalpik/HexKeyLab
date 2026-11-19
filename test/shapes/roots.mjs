// Shape-guide roots gate (docs/architecture/hkl.md → Lattice shapes → Starting note).
//
// Pure Node, no dev server. The guide can start on any of the fifteen major-key tonics
// (MAJOR_TONICS, C♭ … C♯). Its reference is then that tonic's key, placed as Composer places a
// key's reference (findTonicCoord, @hkl/shared/tonic.js), with the anchor on that key's band.
// The claim: a root's guide is C's guide with other names on the keys (a shape may start on any
// key of the keyboard; which note it starts on moves with the root). Checked for all eight
// preset mappings in the six tunings the guide is made for, every root, every structure and
// interval of the catalog:
//   K1  the tonic's key: named for the root, on the spine column of its band, 3-limit from A3 in
//       Ptolemaic (a key of the Pythagorean chain, in some octave), inside HKL's reference range
//       (MIDI 21 to 108; in fact 54 to 65), and the root's plainest key (no comma marks on it)
//   K2  a shape is held from every root or from none
//   K3  from every root a shape is the one it is from C, key for key from its bass: its keys, its
//       path keys, its seams, the positions it starts from and the one drawn, the comma marks on
//       every key, and the same choices left to scan order (test/shapes/oracle.mjs pins those)
//   K4  HKL names every interval and every chord the same from every root
//   K5  the keys' names are the root's: each key is as many fifths from its bass as from C, and
//       the bass is the note as many fifths from the root as C's guide starts from C (a shape
//       starts on the root wherever C's guide starts it on C, and on the root's G where that
//       starts on G)
// Printed, not pinned: the most accidentals a root puts on a key name, and the hues of its
// starting keys (color goes with pitch, so those do change with the root).
//
// The solver's lookups are forgotten after each root (forgetShapes); without that this run
// outgrows a 2 GB heap. Several minutes.
//
// Run: node --import ./test/orchestrator-smoke/register-ts.mjs test/shapes/roots.mjs

import { solve, forgetShapes } from '../../apps/hkl/src/shapes/solve.ts';
import { rootedLayout, buildGuide } from '../../apps/hkl/src/shapes/guide.ts';
import { STRUCTURES, UNISON, intervalSet, ratioOf } from '../../apps/hkl/src/shapes/catalog.ts';
import { analyzeChord } from '../../apps/hkl/src/tuning/chords.ts';
import { intervalNameFromCoords } from '../../apps/hkl/src/tuning/intervals.ts';
import { coordExps, coordToMidi, SHAPE_GUIDE_MODES } from '../../packages/shared/src/freq.ts';
import { MAPPINGS, posInBandOf, layoutOf } from '../../packages/shared/src/mapping.ts';
import { noteName } from '../../packages/shared/src/notes.ts';
import { keyColor } from '../../packages/shared/src/keycolor.ts';
import { hejiCommasFor } from '../../packages/shared/src/heji.ts';
import { MAJOR_TONICS, findTonicCoord, tonicId, tonicOfId, tonicLabel } from '../../packages/shared/src/tonic.ts';

let checks = 0, fails = 0;
function check(label, got, want) {
  checks++;
  if (got !== want) { fails++; if (fails <= 40) console.log(`FAIL ${label}: got ${got}, want ${want}`); }
}

check('K the roots', MAJOR_TONICS.join(' '), 'Cb Gb Db Ab Eb Bb F C G D A E B F# C#');
check('K their URL ids', MAJOR_TONICS.map(tonicId).join(' '), 'Cb Gb Db Ab Eb Bb F C G D A E B Fs Cs');
check('K their labels', MAJOR_TONICS.map(tonicLabel).join(' '), 'C♭ G♭ D♭ A♭ E♭ B♭ F C G D A E B F♯ C♯');
check('K ids read back, and nothing else does', MAJOR_TONICS.every((t) => tonicOfId(tonicId(t)) === t) && tonicOfId('F#') === null && tonicOfId('H') === null && tonicOfId(null) === null, true);

const all = [...STRUCTURES.map((s) => ({ name: s.name, kind: s.kind, members: s.members })), ...intervalSet().map((e) => ({ name: ratioOf(e).join(':'), kind: 'interval', members: [UNISON, e] }))];
/* a key's place on the chain of fifths, from its name: F C G D A E B, seven more per sharp */
const fifths = (name) => 'FCGDAEB'.indexOf(name[0]) + 7 * [...name.slice(1)].reduce((n, c) => n + (c === '#' ? 1 : c === 'b' ? -1 : 0), 0);
const most = new Map(), hues = new Map();
let solves = 0;

for (const mapping of MAPPINGS) {
  const spineColumn = Math.floor(4 / layoutOf(mapping).c);
  for (const mode of SHAPE_GUIDE_MODES) {
    const tag = `K ${mapping} ${mode}`;
    const state = (anchor) => ({ mode, mapping, anchor, banded: true, equalEnabled: false, septimalEnabled: mode === '7', septimalW: 1 });
    /* a root's guide: every structure and interval solved from it, as the guide solves them */
    const guideOf = (root) => {
      const { layout: l, ref } = rootedLayout({ mode, mapping, banded: true }, root);
      const marks = (k) => { const h = hejiCommasFor(mode, k[0], k[1], mapping, l.anchor, true); return h.syn5 + '/' + h.sept7; };
      /* K1 */
      const t = findTonicCoord(root, mapping);
      check(`${tag} ${root}: the reference is the tonic's key`, String(ref), `${t.q},${t.r}`);
      check(`${tag} ${root}: it is named for the root`, noteName(ref[0], ref[1], mapping, l.anchor, true), root);
      check(`${tag} ${root}: on the spine column`, posInBandOf(ref[0], ref[1], mapping), spineColumn);
      check(`${tag} ${root}: 3-limit in Ptolemaic`, coordExps(ref[0], ref[1], '5', mapping, l.anchor, true).slice(2).join(), '0,0');
      check(`${tag} ${root}: a valid HKL reference, near C4`, coordToMidi(ref[0], ref[1], mapping) >= 54 && coordToMidi(ref[0], ref[1], mapping) <= 65, true);
      check(`${tag} ${root}: it carries no comma mark`, marks(ref), '0/0');
      const out = all.map((a) => {
        const sh = solve(a.members, l, root, ref);
        solves++;
        if (!sh) return null;
        const rel = (cs) => cs.map((k) => [k[0] - sh.bass[0], k[1] - sh.bass[1]]).join(' ');
        const keys = [...sh.cells, ...sh.path], names = keys.map((k) => noteName(k[0], k[1], mapping, l.anchor, true));
        const said = a.kind === 'interval' ? intervalNameFromCoords(sh.cells[0][0], sh.cells[0][1], sh.cells[1][0], sh.cells[1][1], state(l.anchor))
          : a.kind === 'chord' ? (() => { const res = analyzeChord(sh.cells.map(([q, r]) => ({ q, r, name: '', col: '' })), state(l.anchor)); return res ? `${res.quality} ${res.invName ?? ''} ${res.ratio}` : 'none'; })()
            : sh.cells.slice(1).map((k, i) => intervalNameFromCoords(sh.cells[i][0], sh.cells[i][1], k[0], k[1], state(l.anchor))).join(', ');
        const m = most.get(root) ?? { n: 0, name: '' };
        for (const n of names) if (n.length - 1 > m.n) { m.n = n.length - 1; m.name = n; }
        most.set(root, m);
        if (mapping === 'randal' && mode === '5') hues.set(root, new Set([...(hues.get(root) ?? []), keyColor(sh.bass[0], sh.bass[1], mode, mapping, l.anchor, true).hue]));
        return { shape: [rel(sh.cells), rel(sh.path), sh.seams.map((pair) => rel(pair)).join(';'), sh.positions.join(), sh.position, keys.map(marks).join(' ')].join(' # '),
          undecided: sh.undecided.join(), said, bassFrom: fifths(names[0]) - fifths(root), steps: names.map((n) => fifths(n) - fifths(names[0])).join() };
      });
      forgetShapes();
      return out;
    };
    const fromC = guideOf('C');
    for (const root of MAJOR_TONICS) {
      if (root === 'C') continue;
      const g = guideOf(root);
      for (let i = 0; i < all.length; i++) {
        const a = all[i];
        check(`${tag} ${root}, ${a.name}: K2 held as from C`, !!g[i], !!fromC[i]);
        if (!g[i] || !fromC[i]) continue;
        check(`${tag} ${root}, ${a.name}: K3 the shape it is from C`, g[i].shape, fromC[i].shape);
        check(`${tag} ${root}, ${a.name}: K3 what is left to scan order is what is from C`, g[i].undecided, fromC[i].undecided);
        check(`${tag} ${root}, ${a.name}: K4 named as from C`, g[i].said, fromC[i].said);
        check(`${tag} ${root}, ${a.name}: K5 starts as many fifths from the root as from C`, g[i].bassFrom, fromC[i].bassFrom);
        check(`${tag} ${root}, ${a.name}: K5 each key as many fifths from its bass as from C`, g[i].steps, fromC[i].steps);
      }
    }
  }
}
/* the guide itself, one layout: the entries of a root's guide are C's, with the same text */
{
  const at = { mode: '5', mapping: 'randal', banded: true }, c = buildGuide(at), e = buildGuide(at, 'Eb'), f = buildGuide(at, 'F#');
  const text = (g) => g.map((x) => [x.name, x.subtitle, x.ratio, x.cents, x.start, x.steps.join(' '), x.others.join(' ')].join('|')).join('\n');
  check('K the guide from E♭ reads as from C', text(e), text(c));
  check('K the guide from F♯ reads as from C', text(f), text(c));
  check('K every entry from E♭ starts on E♭ (as every entry of this layout starts on C)', e.every((x) => noteName(x.shape.bass[0], x.shape.bass[1], 'randal', rootedLayout(at, 'Eb').layout.anchor, true) === 'Eb'), true);
  forgetShapes();
}
console.log(`  ${solves} shapes solved: ${MAPPINGS.length * SHAPE_GUIDE_MODES.length} layouts, ${MAJOR_TONICS.length} roots`);
console.log('  most accidentals on a key name, by root: ' + MAJOR_TONICS.map((t) => `${tonicLabel(t)} ${most.get(t).n} (${most.get(t).name})`).join(', '));
console.log('  hues of the starting keys, Randal in Ptolemaic: ' + MAJOR_TONICS.map((t) => `${tonicLabel(t)} ${[...hues.get(t)].join('/')}`).join(', '));
console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
