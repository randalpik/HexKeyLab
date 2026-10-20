#!/usr/bin/env node
// Greedy-anchored full balance vs the full balance (2026-10-20, partition
// spec Phase 0, second round). Both are `balanceSection` at [MIN_FILL, 1.00]:
// the REFERENCE with λ = 0, the candidate with λ per line start absent from
// the GREEDY partition (a pure, prefix-causal anchor — an edit never moves a
// greedy break before it). Validation is against the reference:
//   1. static — the candidate vs the reference on the document AND on every
//      edited state: boundaries that differ, Δ fill sd / min / max, Δ lines;
//   2. churn — lines changed per edit, by kind, candidate vs reference on the
//      same edit.
//
//   node test/balance/anchor-sim.mjs <inputs.json> [out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { balanceSection, boundariesChanged } from '../../apps/composer/src/render/balance.ts';
import { makeSeg, fillsOf } from './partition-f.mjs';

const D = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const outPath = process.argv[3];
const B = D.budget;
const P0 = { minFill: 0.65, fitMax: 1.00, softMax: 1.00, lambda: 0 };
const LAMBDAS = [0.001, 0.002, 0.005, 0.01, 0.02];
/* Anchors: 'L' = greedy from the section start (prefix-causal: an edit never
   moves an L break before it); 'R' = greedy packed from the section END
   (suffix-causal: never moves an R break after it); 'LR' = their union, so an
   unchanged anchor family exists on BOTH sides of any edit. */
const ANCHORS = (process.env.ANCHORS ?? 'L,R,LR').split(',');
const ONLY_LAMBDAS = process.env.LAMBDAS ? process.env.LAMBDAS.split(',').map(Number) : LAMBDAS;
const SCALE = { narrow15: 0.85, widen15: 1.15, narrow5: 0.95, widen5: 1.05 };
const KINDS = ['delete', 'duplicate', 'narrow15', 'widen15', 'narrow5', 'widen5'];

const bounds = [0, ...D.hard, D.measures];
const segs = [];
for (let s = 0; s + 1 < bounds.length; s++) {
  const lo = bounds[s], hi = bounds[s + 1];
  const ids = [], ws = [], sigs = [];
  for (let i = lo; i < hi;) {
    let j = i; while (j + 1 < hi && D.unitLo[j + 1] === i) j++;
    let w = 0; for (let k = i; k <= j; k++) w += D.naturals[k];
    ids.push(i); ws.push(w / B); sigs.push(D.sig[i] / B);
    i = j + 1;
  }
  segs.push({ lo, hi, ids, ws, sigs, sigSec: (lo === 0 ? D.sig[1] : D.sig[lo]) / B });
}

/* Greedy lens at 1.00 with balanceSection's own sig model (sigFirst, then sigSec). */
function greedyLens(ws, sigSec, sigFirst) {
  const lens = []; let n = 0, f = sigFirst;
  for (const w of ws) {
    if (f + w > P0.softMax && n > 0) { lens.push(n); n = 1; f = sigSec + w; } else { f += w; n++; }
  }
  lens.push(n); return lens;
}
/* Greedy packed from the end: each line takes as many trailing atoms as fit.
   Every line pays sigSec except one that reaches atom 0 (sigFirst). */
function greedyLensFromEnd(ws, sigSec, sigFirst) {
  const lens = []; let n = 0, f = sigSec;
  for (let i = ws.length - 1; i >= 0; i--) {
    const w = ws[i];
    const lead = i === 0 ? sigFirst : sigSec;
    if (n > 0 && f - sigSec + lead + w > P0.softMax) { lens.unshift(n); n = 1; f = sigSec + w; } else { f += w; n++; }
  }
  lens.unshift(n); return lens;
}
const startsOfLens = (lens) => { const s = []; let a = 0; for (const L of lens) { s.push(a); a += L; } return s; };
const lensOfStarts = (st, M) => st.map((s, k) => (k + 1 < st.length ? st[k + 1] : M) - s);
/* balanceSection reads the anchor as line lengths (refLens) and penalises any
   start absent from startsOf(refLens); a UNION of two partitions is not a
   partition, so the union goes in as the lengths between its sorted starts. */
function anchorLens(ws, sigSec, sigFirst, anchor) {
  const st = new Set();
  if (anchor.includes('L')) for (const s of startsOfLens(greedyLens(ws, sigSec, sigFirst))) st.add(s);
  if (anchor.includes('R')) for (const s of startsOfLens(greedyLensFromEnd(ws, sigSec, sigFirst))) st.add(s);
  return lensOfStarts([...st].sort((a, b) => a - b), ws.length);
}
function solve(ws, sigs, sigSec, lambda, anchor = 'L') {
  const ref = lambda > 0 ? anchorLens(ws, sigSec, sigs[0], anchor) : [ws.length];
  const r = balanceSection(ws, sigSec, ref, { ...P0, lambda }, sigs[0]);
  return r ? startsOfLens(r.lens) : null;
}

function perturb(sg, m, kind) {
  const ws = sg.ws.slice(), sigs = sg.sigs.slice(), ids = sg.ids.slice();
  if (kind === 'delete') { ws.splice(m, 1); sigs.splice(m, 1); ids.splice(m, 1); }
  else if (kind === 'duplicate') { ws.splice(m + 1, 0, ws[m]); sigs.splice(m + 1, 0, sigs[m]); ids.splice(m + 1, 0, sg.ids[m] + 0.5); }
  else ws[m] *= SCALE[kind];
  return { ws, sigs, ids };
}
const pairs = (starts, ids, M) => starts.map((s, k) => `${ids[s]}:${k + 1 < starts.length ? ids[starts[k + 1]] : 'end'}`);
function churn(before, beforeIds, after, afterIds, m) {
  const oldP = pairs(before, beforeIds), newP = new Set(pairs(after, afterIds));
  let Lm = 0; for (let k = 0; k < before.length; k++) if (before[k] <= m) Lm = k;
  let changed = 0, backReach = 0;
  oldP.forEach((p, k) => { if (newP.has(p)) return; changed++; if (k < Lm) backReach = Math.max(backReach, Lm - k); });
  return { changed, backReach };
}
const sd = (fs) => { const mu = fs.reduce((a, b) => a + b, 0) / fs.length; return Math.sqrt(fs.reduce((a, b) => a + (b - mu) ** 2, 0) / fs.length); };
const qstats = (fs) => ({ n: fs.length, sd: sd(fs), min: Math.min(...fs), max: Math.max(...fs) });
const q = (xs, p) => { if (!xs.length) return 0; const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const dist = (xs) => `${q(xs, 0.5)}/${q(xs, 0.9)}/${q(xs, 0.99)}/${xs.length ? Math.max(...xs) : 0}`;
const r3 = (x) => (Math.round(x * 1000) / 1000).toFixed(3);

/* Every state: the document plus each edited state, with the reference on it. */
const states = [];
let nulls = 0;
for (const sg of segs) {
  const g0 = makeSeg(sg.ws, sg.sigs);
  const ref0 = solve(sg.ws, sg.sigs, sg.sigSec, 0);
  states.push({ seg: sg, kind: 'doc', m: -1, ws: sg.ws, sigs: sg.sigs, ids: sg.ids, ref: ref0, g: g0 });
  for (let m = 0; m < sg.ws.length; m++) for (const kind of KINDS) {
    if ((kind === 'delete' || kind === 'duplicate') && m === 0) continue;
    const p = perturb(sg, m, kind);
    const ref = solve(p.ws, p.sigs, sg.sigSec, 0);
    if (!ref) nulls++;
    states.push({ seg: sg, kind, m, ...p, ref, g: makeSeg(p.ws, p.sigs) });
  }
}

const results = [];
const CONFIGS = [[0, '-'], ...ANCHORS.flatMap((a) => ONLY_LAMBDAS.map((l) => [l, a]))];
for (const [lambda, anchor] of CONFIGS) {
  const docRows = [], staticDiff = [], dSd = [], dMin = [], lineDiff = [];
  const ch = Object.fromEntries(KINDS.map((k) => [k, { changed: [], back: [], worse: 0, n: 0 }]));
  const base = new Map();
  let t = 0, calls = 0;
  for (const st of states) {
    const t0 = performance.now();
    const cand = lambda === 0 ? st.ref : solve(st.ws, st.sigs, st.seg.sigSec, lambda, anchor);
    t += performance.now() - t0; calls++;
    st.cand = cand;
    if (!cand || !st.ref) continue;
    const fc = qstats(fillsOf(st.g, cand)), fr = qstats(fillsOf(st.g, st.ref));
    const diff = boundariesChanged(lensOfStarts(cand, st.ws.length), lensOfStarts(st.ref, st.ws.length));
    staticDiff.push(diff); dSd.push(fc.sd - fr.sd); dMin.push(fr.min - fc.min); lineDiff.push(fc.n - fr.n);
    if (st.kind === 'doc') { base.set(st.seg, { cand, ref: st.ref }); docRows.push({ seg: `${st.seg.lo}-${st.seg.hi - 1}`, lines: fc.n, sd: fc.sd, min: fc.min, max: fc.max, diffVsRef: diff }); }
  }
  for (const st of states) {
    if (st.kind === 'doc' || !st.ref) continue;
    const b = base.get(st.seg);
    const cand = st.cand;
    if (!cand) continue;
    const c = churn(b.cand, st.seg.ids, cand, st.ids, st.m);
    const r = churn(b.ref, st.seg.ids, st.ref, st.ids, st.m);
    const k = ch[st.kind]; k.n++; k.changed.push(c.changed); k.back.push(c.backReach); if (c.changed > r.changed) k.worse++;
  }
  results.push({ lambda, anchor, docRows, staticDiff, dSd, dMin, lineDiff, ch, ms: t / calls });
}

console.log(`states: ${states.length} (reference null on ${nulls})`);
console.log('\n1. Document: per movement lines / fill sd / min / max / boundaries differing from the reference');
for (const r of results) console.log(`${r.anchor.padEnd(2)} λ=${String(r.lambda).padEnd(5)}`, r.docRows.map((d) => `${d.seg}: ${d.lines} ${r3(d.sd)} ${r3(d.min)} ${r3(d.max)} ≠${d.diffVsRef}`).join(' | '));
console.log('\n2. Every state (document + each edited state) vs the reference on that state');
console.log('anchor λ  boundaries≠ref med/p90/p99/max  states≠ref   Δsd p99/max     min-fill lower p99/max  line count ≠');
for (const r of results) {
  const ne = r.staticDiff.filter((x) => x > 0).length;
  console.log((r.anchor + ' ' + r.lambda).padEnd(9), dist(r.staticDiff).padStart(22), `${ne}/${r.staticDiff.length}`.padStart(14),
    `${r3(q(r.dSd, 0.99))}/${r3(Math.max(...r.dSd))}`.padStart(16), `${r3(q(r.dMin, 0.99))}/${r3(Math.max(...r.dMin))}`.padStart(20), String(r.lineDiff.filter((x) => x !== 0).length).padStart(10));
}
console.log('\n3. Churn per edit (lines changed med/p90/p99/max; back-reach p90/p99/max; edits changing MORE lines than the reference does)');
for (const r of results) {
  console.log(`${r.anchor} λ=${r.lambda}  (${r.ms.toFixed(2)} ms/solve)`);
  for (const k of KINDS) { const c = r.ch[k]; console.log(`   ${k.padEnd(9)} changed ${dist(c.changed).padEnd(12)} back ${dist(c.back).split('/').slice(1).join('/').padEnd(9)} worse ${c.worse}/${c.n}`); }
}
if (outPath) writeFileSync(outPath, JSON.stringify(results.map(({ staticDiff, dSd, dMin, lineDiff, ch, ...r }) => ({ ...r, ch: Object.fromEntries(Object.entries(ch).map(([k, v]) => [k, { n: v.n, worse: v.worse, changed: dist(v.changed), back: dist(v.back) }])) })), null, 1));
