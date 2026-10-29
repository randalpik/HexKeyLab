// Lattice color regression gate (docs/architecture.md → Color scheme).
//
// Color is one function of the pitch. This gate pins what that function
// produces: for every mode × mapping over a wide cell window it records each
// cell's (hue, white/black, septimal) as one code character, and once per
// distinct code the exact hexes the three public outputs give — lattice
// (keyColorHex), dark-surface notehead (lightSourceHex) and ink-on-paper
// notehead (darkColorHex). A check run recomputes everything through HKL's
// public color API and requires an exact match.
//
//   node --import ./test/orchestrator-smoke/register-ts.mjs test/color-gate/gate.mjs           # check
//   node --import ./test/orchestrator-smoke/register-ts.mjs test/color-gate/gate.mjs --write   # re-seed
//
// Re-seed only for an intended color change. Exits non-zero on any mismatch.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TUNING_MODES } from '../../packages/shared/src/freq.ts';
import { MAPPINGS } from '../../packages/shared/src/mapping.ts';
import { hueCycle } from '../../packages/shared/src/colors.ts';
import { tuning } from '../../apps/hkl/src/state/tuning.ts';
import { keyColorVariant, keyColorHex, lightSourceHex } from '../../apps/hkl/src/render/colors.ts';
import { darkColorHex } from '../../apps/hkl/src/transcription/pitch.ts';

const SNAP = fileURLToPath(new URL('./snapshot.json', import.meta.url));
const W = 40;

function setLayout(mode, mapping) {
  tuning.mode = mode;
  tuning.equalEnabled = mode === 'E';
  tuning.septimalEnabled = mode === '7';
  tuning.mapping = mapping;
}

/* code = hue index (hueCycle) · 4 + white · 2 + septimal → one char from '0' */
function codeOf(v) {
  return String.fromCharCode(48 + hueCycle.indexOf(v.hue) * 4 + (v.isW ? 2 : 0) + (v.half ? 1 : 0));
}

function capture() {
  const grids = {};
  const hexes = {};
  for (const mode of TUNING_MODES) {
    for (const mapping of MAPPINGS) {
      setLayout(mode, mapping);
      let s = '';
      for (let q = -W; q <= W; q++) {
        for (let r = -W; r <= W; r++) {
          const c = codeOf(keyColorVariant(q, r));
          s += c;
          const h = [keyColorHex(q, r), lightSourceHex(q, r), darkColorHex(q, r)].join(' ');
          if (hexes[c] === undefined) hexes[c] = h;
          else if (hexes[c] !== h) throw new Error(`code ${c} maps to two hex triples: ${hexes[c]} vs ${h} at ${mode}/${mapping} (${q},${r})`);
        }
      }
      grids[`${mode}/${mapping}`] = s;
    }
  }
  return { window: W, grids, hexes };
}

const now = capture();
if (process.argv.includes('--write')) {
  writeFileSync(SNAP, JSON.stringify(now, null, 1) + '\n');
  console.log(`color-gate: wrote ${Object.keys(now.grids).length} grids × ${(2 * W + 1) ** 2} cells, ${Object.keys(now.hexes).length} codes`);
  process.exit(0);
}

const want = JSON.parse(readFileSync(SNAP, 'utf8'));
let fail = 0;
const msgs = [];
for (const key of Object.keys(want.grids)) {
  const a = want.grids[key], b = now.grids[key];
  if (b === undefined) { fail++; msgs.push(`${key}: missing`); continue; }
  let n = 0, first = '';
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      if (!n) first = ` first at (${Math.floor(i / (2 * W + 1)) - W},${(i % (2 * W + 1)) - W}) want ${a[i]} got ${b[i]}`;
      n++;
    }
  }
  if (n) { fail += n; msgs.push(`${key}: ${n} cells differ;${first}`); }
}
for (const [c, h] of Object.entries(now.hexes)) {
  if (want.hexes[c] !== undefined && want.hexes[c] !== h) { fail++; msgs.push(`code ${c}: hexes ${h}, want ${want.hexes[c]}`); }
}
const cells = Object.keys(want.grids).length * (2 * W + 1) ** 2;
if (fail) {
  console.log(`color-gate: FAIL — ${fail} mismatches over ${cells} cells`);
  for (const m of msgs.slice(0, 30)) console.log('  ' + m);
  process.exit(1);
}
console.log(`color-gate: PASS — ${cells} cells, ${Object.keys(now.hexes).length} color codes identical`);
