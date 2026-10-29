// Syntonic ('S') / Polysyntonic ('Y') oracle (docs/architecture.md → Tuning modes, Syntonic / Polysyntonic; color: → Color scheme).
//
// Pure Node gate — imports the REAL @hkl/shared modules through the repo's TS
// loader and checks every rule the spec states, under every mapping, over a
// wide cell window and a spread of anchors (incl. far beyond the Lumatone's ±3):
//   A  home band = Pythagorean exactly; every band = P · (81/80)^k(band − anchor),
//      the band being the one whose offset the cell carries (pitchBandOf: a
//      chromatic column copied from the band to its left keeps that band's)
//   B  k: Syntonic 0,+1,0,−1 (period 4), Polysyntonic = band distance (unbounded)
//   C  (+band, 0) band step: Polysyntonic 81/40 everywhere; Syntonic 81/40,
//      160/81, 160/81, 81/40 by transition (Wicki-Hayden 6-band, chromatic
//      12-band; Euler 3-band step is P's 2/1 times the same comma)
//   D  re-anchoring: Polysyntonic = global shift by −n·SC; Syntonic = period 4
//   E  color: hue = P's hue + 2k steps (mod 7); septimal never; white/black =
//      MIDI pitch class
//   F  HEJI: syn5 = −k (up-arrows raised), sept7 = 0; hejiChain renders |k| ≤ 4
//
//   node --import ./test/orchestrator-smoke/register-ts.mjs test/syntonic/oracle.mjs
//
// Exits non-zero on any failure.

import { coordExps, coordToMidi, anchorOf, bandOffset } from '../../packages/shared/src/freq.ts';
import { bandOfCell, pitchBandOf, bandWidth, COLUMN_STEP, MAPPINGS } from '../../packages/shared/src/mapping.ts';
import { keyColor } from '../../packages/shared/src/keycolor.ts';
import { hueCycleOrder, hueIdx } from '../../packages/shared/src/colors.ts';
import { hejiCommasFor, hejiChain } from '../../packages/shared/src/heji.ts';

const SC = [-4, 4, -1, 0];
const ANCHORS = [-9, -4, -3, -1, 0, 1, 2, 5, 8];

let pass = 0, fail = 0;
const failures = [];
function check(name, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  if (failures.length < 25) failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
const sub = (a, b) => a.map((x, i) => x - b[i]);
const addK = (a, k) => a.map((x, i) => x + k * SC[i]);
const eq = (a, b) => a.every((x, i) => x === b[i]);
const mod = (a, n) => ((a % n) + n) % n;
function ratio(e) {
  const PR = [2n, 3n, 5n, 7n];
  let n = 1n, d = 1n;
  e.forEach((x, i) => { if (x > 0) n *= PR[i] ** BigInt(x); else if (x < 0) d *= PR[i] ** BigInt(-x); });
  return `${n}/${d}`;
}

for (const mapping of MAPPINGS) {
  const W = bandWidth(mapping);                    /* band width in q */
  const QR = 20 * 4 / COLUMN_STEP[mapping];
  for (const mode of ['S', 'Y']) {
    for (const anchor of ANCHORS) {
      for (let q = -QR; q <= QR; q++) {
        for (let r = -10; r <= 10; r++) {
          const tag = `${mode} ${mapping} a=${anchor} (${q},${r})`;
          const d = pitchBandOf(q, mapping) - anchor;
          const k = bandOffset(mode, d);
          const e = coordExps(q, r, mode, mapping, anchor, true);
          const p = coordExps(q, r, 'P', mapping, anchor, true);
          /* A + B */
          check(`A ${tag} = P·SC^k`, eq(e, addK(p, k)), true);
          if (d === 0) check(`A ${tag} home band unaltered`, eq(e, p), true);
          check(`B ${tag} k`, k, mode === 'Y' ? d : [0, 1, 0, -1][mod(d, 4)]);
          /* D */
          if (mode === 'Y') {
            check(`D ${tag} global shift`, eq(coordExps(q, r, mode, mapping, anchor + 3, true), addK(e, -3)), true);
          } else {
            check(`D ${tag} period 4`, eq(coordExps(q, r, mode, mapping, anchor + 4, true), e), true);
          }
          /* E */
          const c = keyColor(q, r, mode, mapping, anchor, true);
          const cp = keyColor(q, r, 'P', mapping, anchor, true);
          check(`E ${tag} hue +2k`, c.hue, hueCycleOrder[mod(hueIdx[cp.hue] + 2 * k, 7)]);
          check(`E ${tag} not septimal`, c.isSept, false);
          check(`E ${tag} white/black`, c.isW, [0, 2, 4, 5, 7, 9, 11].includes(mod(coordToMidi(q, r, mapping), 12)));
          /* F */
          const h = hejiCommasFor(mode, q, r, mapping, anchor, true);
          check(`F ${tag} syn5`, h.syn5, -k);
          check(`F ${tag} sept7`, h.sept7, 0);
        }
      }
      /* C: the band step (+W, 0) across each transition */
      for (let b = anchor - 6; b <= anchor + 6; b++) {
        const q0 = b * W - W / 3;                                /* first column of band b */
        const step = sub(coordExps(q0 + W, 0, mode, mapping, anchor, true), coordExps(q0, 0, mode, mapping, anchor, true));
        const kStep = bandOffset(mode, b + 1 - anchor) - bandOffset(mode, b - anchor);
        const pStep = sub(coordExps(q0 + W, 0, 'P', mapping, anchor, true), coordExps(q0, 0, 'P', mapping, anchor, true));
        check(`C ${mode} ${mapping} a=${anchor} band ${b}→${b + 1}`, ratio(step), ratio(addK(pStep, kStep)));
        if (mapping !== 'euler') {
          const want = kStep === 1 ? '81/40' : kStep === -1 ? '160/81' : '2/1';
          check(`C ${mode} ${mapping} a=${anchor} band ${b}→${b + 1} ratio`, ratio(step), want);
        }
      }
    }
  }
}

/* anchorOf = the reference's own-frame (spatial) band — the clicked band becomes home */
for (const mapping of MAPPINGS) {
  for (let q = -30; q <= 30; q++) check(`anchorOf ${mapping} ${q}`, anchorOf(q, mapping), bandOfCell(q, mapping));
}
/* HEJI chains for ±1…±4 commas on every conventional alteration render */
for (let alter = -2; alter <= 2; alter++) {
  for (let s = -4; s <= 4; s++) {
    const chain = hejiChain(alter, s, 0);
    check(`F chain alter ${alter} syn5 ${s} nonempty`, s === 0 && alter === 0 ? true : chain.length > 0, true);
  }
}

console.log(`${pass}/${pass + fail} checks passed`);
if (fail) {
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
