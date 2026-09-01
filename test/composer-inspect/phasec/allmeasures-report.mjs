#!/usr/bin/env node
// Merge the chunk files written by allmeasures.sh and answer the questions the
// exhaustive sweep exists to answer:
//
//   1. Is the splice outcome a function of the REPLACED SET alone? (conflicts)
//   2. Does a multi-line replaced set ever fail when every one of its
//      constituent lines splices on its own? (the decisive test for whether
//      mid-line sampling is a complete inventory of failure CAUSES)
//   3. What is the full inventory of refusal causes on this document?
//   4. Does the measure's position within its line affect the outcome rate?
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? join(process.env.TMPDIR ?? '/tmp', 'hkl-allmeasures');
const files = readdirSync(dir).filter((f) => /^allm-\d+\.json$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
if (!files.length) { console.error('no chunk files in ' + dir); process.exit(1); }

let rows = [], skipped = 0;
for (const f of files) {
  const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  if (j.__error) { console.error(f + ': ' + j.__error); process.exit(1); }
  for (const r of j.rows) { if (r.skip) skipped++; else rows.push(r); }
}
const edited = rows.filter((x) => x.outcome && x.changed);
const rate = (a) => (a.length ? +(a.filter((x) => x.outcome === 'spliced').length / a.length * 100).toFixed(1) : null);
console.log(`chunks ${files.length} | measures ${rows.length + skipped} | no note/chord ${skipped} ` +
  `| edited ${edited.length} | cursor-move only ${rows.filter((x) => x.outcome && !x.changed).length}`);
console.log('splice rate: ' + rate(edited) + '%');
for (const w of ['first', 'middle', 'last', 'only']) {
  const g = edited.filter((x) => x.where === w);
  if (g.length) console.log(`  ${w.padEnd(7)} n=${String(g.length).padEnd(4)} ${rate(g)}%`);
}

const V = new Map();
for (const x of edited) {
  const k = x.run ? x.run[0] + '-' + x.run[1] : 'none';
  if (!V.has(k)) V.set(k, { sp: 0, rf: 0, reasons: new Set(), wheres: new Set() });
  const v = V.get(k);
  if (x.outcome === 'spliced') v.sp++; else { v.rf++; v.reasons.add(x.reason); }
  v.wheres.add(x.where);
}
const conflicts = [...V].filter(([, v]) => v.sp > 0 && v.rf > 0);
console.log(`\ndistinct replaced sets: ${V.size}`);
console.log(`(1) same set, different verdict — CONFLICTS: ${conflicts.length}`);
for (const [k, v] of conflicts) console.log(`    ${k}: spliced ${v.sp}, refused ${v.rf} (${[...v.reasons].join('; ')})`);

const ok = (k) => V.has(k) && V.get(k).rf === 0 && V.get(k).sp > 0;
const bad = (k) => V.has(k) && V.get(k).rf > 0;
const multi = [...V.keys()].filter((k) => { const [a, b] = k.split('-').map(Number); return b > a; });
const hits = [], inherited = [], undet = [];
for (const k of multi.filter(bad)) {
  const [a, b] = k.split('-').map(Number);
  const parts = []; for (let i = a; i <= b; i++) parts.push(i + '-' + i);
  const missing = parts.filter((p) => !V.has(p));
  if (missing.length) undet.push({ set: k, missing });
  else if (parts.every(ok)) hits.push({ set: k, reasons: [...V.get(k).reasons] });
  else inherited.push({ set: k, failingParts: parts.filter(bad) });
}
console.log(`\n(2) multi-line sets: ${multi.length} observed, ${multi.filter(bad).length} failing`);
console.log(`    FAILS while every constituent line splices: ${hits.length}` + (hits.length ? ' ' + JSON.stringify(hits) : ''));
console.log(`    inherited from a failing constituent:       ${inherited.length} ${JSON.stringify(inherited)}`);
console.log(`    undetermined (constituent unsampled):       ${undet.length} ${JSON.stringify(undet)}`);

const hist = edited.reduce((h, x) => { const k = x.outcome === 'spliced' ? 'spliced' : x.reason; h[k] = (h[k] ?? 0) + 1; return h; }, {});
console.log('\n(3) refusal inventory:');
for (const [k, n] of Object.entries(hist).sort((a, b) => b[1] - a[1])) if (k !== 'spliced') console.log(`    ${String(n).padStart(3)}  ${k}`);
const midR = new Set(edited.filter((x) => x.where === 'middle' && x.outcome !== 'spliced').map((x) => x.reason));
const edgeOnly = [...new Set(edited.filter((x) => x.where !== 'middle' && x.outcome !== 'spliced').map((x) => x.reason))].filter((r) => !midR.has(r));
const midKeys = new Set(edited.filter((x) => x.where === 'middle').map((x) => (x.run ? x.run[0] + '-' + x.run[1] : 'none')));
console.log(`\n(4) reasons a MID-LINE-only sweep would miss: ${edgeOnly.length} ${JSON.stringify(edgeOnly)}`);
console.log(`    replaced sets unreachable from mid-line: ${[...V.keys()].filter((k) => !midKeys.has(k)).length} of ${V.size}`);
