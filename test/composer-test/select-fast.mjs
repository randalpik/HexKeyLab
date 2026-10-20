#!/usr/bin/env node
// Choose the fast tier from a coverage map and write fast-tier.json.
//
// Usage:
//   node test/composer-test/select-fast.mjs [--map out/coverage-map.json]
//        [--budget-s 40] [--min-gain 20] [--dry-run]
//
// The fast tier is the safety net under `run.mjs affected`: the affected set
// already covers every fixture that executes changed code, so the fast tier is
// there for what coverage cannot see — non-JS changes, a stale map, and code
// whose execution depends on timing (idle slices, observers, deferred renders).
// That calls for breadth, so it is picked in two passes over the executed
// source lines in the map (each fixture's cost = its measured wall time):
//   1. floor: until every category is represented, add the fixture from an
//      unrepresented category with the most new lines per second; then make
//      sure every category with visual baselines has one visual fixture
//      (pixels are what line coverage cannot see);
//   2. greedy: among fixtures adding at least --min-gain new lines, add the one
//      with the most new lines per second, until the budget is spent or none
//      is left.
// Fixtures that failed during the coverage run are not eligible.
// Regenerate after a large change to the suite or the source:
//   node test/composer-test/run.mjs full --coverage && node test/composer-test/select-fast.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { b64ToBitset, hasBit } from './lib/coverage.mjs';
import { FIXTURES } from './fixtures/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const mapPath = arg('--map', join(__dirname, 'out', 'coverage-map.json'));
const budgetMs = Number(arg('--budget-s', 40)) * 1000;
const minGain = Number(arg('--min-gain', 20));
const dryRun = args.includes('--dry-run');

const map = JSON.parse(readFileSync(mapPath, 'utf8'));

/* Global line index: (file, line) → unit id. */
const unitBase = new Map();
let nUnits = 0;
for (const [path, info] of Object.entries(map.files)) { unitBase.set(path, nUnits); nUnits += info.content.split('\n').length + 1; }
const fixtures = Object.entries(map.fixtures).map(([name, f]) => {
  const units = [];
  for (const [path, b64] of Object.entries(f.files)) {
    const bits = b64ToBitset(b64), base = unitBase.get(path);
    for (let i = 0; i < bits.length * 8; i++) if (hasBit(bits, i)) units.push(base + i);
  }
  return { name, category: f.category, ms: Math.max(f.ms ?? 1, 1), ok: f.ok !== false && !!FIXTURES[name],
    visual: !!FIXTURES[name]?.visualBaseline, units: Uint32Array.from(units) };
});
const covered = new Uint8Array(nUnits);
const fullUnion = new Uint8Array(nUnits);
for (const f of fixtures) for (const u of f.units) fullUnion[u] = 1;
const totalUnion = fullUnion.reduce((n, x) => n + x, 0);

const gainOf = (f) => { let g = 0; for (const u of f.units) if (!covered[u]) g++; return g; };
const take = (f) => { for (const u of f.units) covered[u] = 1; };
const eligible = fixtures.filter((f) => f.ok);
const chosen = [];
let spent = 0, have = 0;
const pick = (f, pass) => { const g = gainOf(f); take(f); chosen.push({ ...f, gain: g, pass }); spent += f.ms; have += g; };

/* Pass 1: category floor. */
const cats = new Set(eligible.map((f) => f.category));
const represented = new Set();
while (represented.size < cats.size) {
  let best = null, bestScore = -1;
  for (const f of eligible) {
    if (represented.has(f.category) || chosen.some((c) => c.name === f.name)) continue;
    const s = gainOf(f) / f.ms;
    if (s > bestScore) { bestScore = s; best = f; }
  }
  pick(best, 'floor');
  represented.add(best.category);
}

/* Pass 1b: visual floor — pixels are what line coverage cannot see (CSS,
   fonts, glyph metrics), so every category with a visual baseline keeps one. */
for (const cat of new Set(eligible.filter((f) => f.visual).map((f) => f.category))) {
  if (chosen.some((c) => c.category === cat && c.visual)) continue;
  let best = null, bestScore = -1;
  for (const f of eligible) {
    if (f.category !== cat || !f.visual || chosen.some((c) => c.name === f.name)) continue;
    const s = (gainOf(f) + 1) / f.ms;
    if (s > bestScore) { bestScore = s; best = f; }
  }
  pick(best, 'visual');
}

/* Pass 2: greedy by new lines per second. */
for (;;) {
  let best = null, bestScore = -1;
  for (const f of eligible) {
    if (chosen.some((c) => c.name === f.name) || spent + f.ms > budgetMs) continue;
    const g = gainOf(f), s = g / f.ms;
    if (g >= minGain && s > bestScore) { bestScore = s; best = f; }
  }
  if (!best) break;
  pick(best, 'greedy');
}

const pct = (n) => (100 * n / totalUnion).toFixed(1) + '%';
console.log(`coverage map ${map.generated?.slice(0, 16)} — ${fixtures.length} fixtures, ${totalUnion} executed lines in ${unitBase.size} modules`);
console.log(`fast tier: ${chosen.length} fixtures, ${(spent / 1000).toFixed(1)} s measured, ${have} lines = ${pct(have)} of the full suite's executed lines`);
let cum = 0, cumMs = 0;
for (const c of chosen) {
  cum += c.gain; cumMs += c.ms;
  console.log(`  ${c.pass.padEnd(6)} ${String(c.gain).padStart(6)} +lines  ${String(c.ms).padStart(5)} ms  ${pct(cum).padStart(6)} @ ${(cumMs / 1000).toFixed(1).padStart(5)} s  ${c.category}/${c.name}`);
}

/* Where the remaining gap is: lines only non-fast fixtures execute, by module. */
const gapByFile = [];
for (const [path, base] of unitBase) {
  const n = map.files[path].content.split('\n').length + 1;
  let gap = 0, all = 0;
  for (let i = 0; i < n; i++) { if (fullUnion[base + i]) { all++; if (!covered[base + i]) gap++; } }
  if (gap) gapByFile.push([path, gap, all]);
}
gapByFile.sort((a, b) => b[1] - a[1]);
console.log(`\nlines the full suite executes but the fast tier does not, by module (top 25 of ${gapByFile.length}):`);
for (const [path, gap, all] of gapByFile.slice(0, 25)) console.log(`  ${String(gap).padStart(5)} / ${String(all).padStart(5)}  ${path}`);

if (!dryRun) {
  const out = {
    note: 'Generated by select-fast.mjs from a coverage map — do not hand-edit; regenerate.',
    generated: new Date().toISOString(),
    map: { generated: map.generated, commit: map.commit },
    budgetS: budgetMs / 1000,
    coverage: { lines: have, ofFull: totalUnion, pct: Number((100 * have / totalUnion).toFixed(1)) },
    measuredS: Number((spent / 1000).toFixed(1)),
    fixtures: chosen.map((c) => c.name),
  };
  writeFileSync(join(__dirname, 'fast-tier.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`\nwrote fast-tier.json (${chosen.length} fixtures)`);
}
