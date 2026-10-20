#!/usr/bin/env node
// Reach-back curve (2026-10-20, partition spec Phase 0, third round; Max's
// design). Per section: greedy lines at ≤ 1.00, then for every reach-back k
// (the last k lines re-divided, same count) the most even arrangement of
// those lines — k = 1 is greedy, k = N is the full balance. A selector picks
// k. No MIN_FILL: the only exception is a FINAL section of fewer than 3
// lines, which stays greedy. Lines are capped at 1.00 (a single atom wider
// than a line sits alone).
//
// "Most even" at a fixed count and fixed content = minimum Σ(1 − f)², which
// ranks arrangements exactly as variance does and needs no window mean, so
// ONE right-to-left DP gives every point of the curve.
//
// Edit churn is compared with TODAY's edit system, simulated as: the old lines
// before the first line of the edit's page are kept; balanceSection
// ([0.65, 1.45], today's constants) re-divides from there to the section end
// (linebreaks.ts balanceTouched; the repair loop before it only moves lines at
// or after the edit's line, all of which that rebalance recomputes).
//
//   node test/balance/curve-sim.mjs <inputs.json> [out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { balanceSection } from '../../apps/composer/src/render/balance.ts';
import { makeSeg, fillsOf, greedyStarts, curve } from './partition-f.mjs';

const D = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const outPath = process.argv[3];
const B = D.budget, CAP = 1.00;
const TODAY = { minFill: 0.65, fitMax: 1.45, softMax: 1.00, lambda: 0 };
const KINDS = ['delete', 'duplicate', 'narrow15', 'widen15', 'narrow5', 'widen5'];
const SCALE = { narrow15: 0.85, widen15: 1.15, narrow5: 0.95, widen5: 1.05 };

/* ── the curve ───────────────────────────────────────────────────────── */

const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
/* Selectors: pure, relative to the section's own alternatives. */
const SELECTORS = {
  greedy: () => 1,
  full: (c) => c.pts.length,
  ...Object.fromEntries([0.02, 0.05, 0.10].map((d) => [`fullMin−${d}`, (c) => {
    const target = c.pts[c.pts.length - 1].winMin - d;
    return (c.pts.find((p) => p.winMin >= target - 1e-12) ?? c.pts[c.pts.length - 1]).k;
  }])),
  ...Object.fromEntries([0.10, 0.15, 0.20].map((d) => [`median−${d}`, (c) => {
    const fs = c.pts[0].fs; const target = median(fs.slice(0, Math.max(1, fs.length - 1))) - d;
    return (c.pts.find((p) => p.winMin >= target - 1e-12) ?? c.pts[c.pts.length - 1]).k;
  }])),
};

/* ── document ────────────────────────────────────────────────────────── */

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
  const isFinal = s + 2 === bounds.length;
  /* today's committed lines + pages, as atom indices of this segment */
  const at = new Map(ids.map((id, a) => [id, a]));
  const committed = D.starts.filter((x) => x >= lo && x < hi).map((x) => at.get(x));
  const pageSet = new Set(D.pageStarts);
  const pageLines = committed.map((a, k) => (pageSet.has(ids[a]) ? k : -1)).filter((k) => k >= 0);
  segs.push({ lo, hi, ids, ws, sigs, isFinal, committed, pageLines });
}

function solveF(g, isFinal, sel) {
  const gr = greedyStarts(g, CAP);
  if (isFinal && gr.length < 3) return { starts: gr, k: 1 };
  const c = curve(g); const k = SELECTORS[sel](c);
  return { starts: c.pts[k - 1].starts, k, c };
}

/* Today's edit: old prefix before the edit page's first line + suffix balance. */
function todayEdit(sg, p, m, kind) {
  const old = sg.committed;
  let Lm = 0; for (let k = 0; k < old.length; k++) if (old[k] <= m) Lm = k;
  let lo = 0; for (const pl of sg.pageLines) if (pl <= Lm && pl > lo) lo = pl;
  const a0 = old[lo];
  const shift = (a) => (kind === 'delete' ? (a > m ? a - 1 : a) : kind === 'duplicate' ? (a > m ? a + 1 : a) : a);
  const a0n = shift(a0);
  const ws = p.ws.slice(a0n), sigs = p.sigs.slice(a0n);
  const sigSec = a0n === 0 && sg.lo === 0 ? D.sig[1] / B : sigs[0];
  const r = balanceSection(ws, sigSec, [ws.length], TODAY, sigs[0]);
  if (!r) return { starts: old.map(shift).filter((a, i, arr) => arr.indexOf(a) === i), fellBack: true, pageFirst: lo };
  const suf = []; let acc = a0n; for (const L of r.lens) { suf.push(acc); acc += L; }
  return { starts: old.slice(0, lo).concat(suf), fellBack: false, pageFirst: lo };
}

function perturb(sg, m, kind) {
  const ws = sg.ws.slice(), sigs = sg.sigs.slice(), ids = sg.ids.slice();
  if (kind === 'delete') { ws.splice(m, 1); sigs.splice(m, 1); ids.splice(m, 1); }
  else if (kind === 'duplicate') { ws.splice(m + 1, 0, ws[m]); sigs.splice(m + 1, 0, sigs[m]); ids.splice(m + 1, 0, sg.ids[m] + 0.5); }
  else ws[m] *= SCALE[kind];
  return { ws, sigs, ids };
}
const pairs = (starts, ids) => starts.map((s, k) => `${ids[s]}:${k + 1 < starts.length ? ids[starts[k + 1]] : 'end'}`);
function churn(before, beforeIds, after, afterIds, m) {
  const oldP = pairs(before, beforeIds), newP = new Set(pairs(after, afterIds));
  let Lm = 0; for (let k = 0; k < before.length; k++) if (before[k] <= m) Lm = k;
  let changed = 0, back = 0, fwd = 0, backReach = 0;
  oldP.forEach((p, k) => { if (newP.has(p)) return; changed++; if (k < Lm) { back++; backReach = Math.max(backReach, Lm - k); } else if (k > Lm) fwd++; });
  return { changed, back, fwd, backReach };
}
const q = (xs, p) => { if (!xs.length) return 0; const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const dist = (xs) => `${q(xs, 0.5)}/${q(xs, 0.9)}/${q(xs, 0.99)}/${xs.length ? Math.max(...xs) : 0}`;
const r3 = (x) => (Math.round(x * 1000) / 1000).toFixed(3);
const sdv = (fs) => { const mu = fs.reduce((a, b) => a + b, 0) / fs.length; return Math.sqrt(fs.reduce((a, b) => a + (b - mu) ** 2, 0) / fs.length); };

/* ── 1. curves on the document ───────────────────────────────────────── */
const curves = segs.map((sg) => ({ seg: `${sg.lo}-${sg.hi - 1}`, c: curve(makeSeg(sg.ws, sg.sigs)) }));
console.log('1. Curve per movement: k (reach-back lines) → sparsest re-divided line / last line / line starts that differ from greedy');
for (const { seg, c } of curves) {
  const show = c.pts.filter((p) => p.k <= 8 || p.k === c.pts.length || p.k % 5 === 0);
  console.log(`  ${seg} (${c.pts.length} lines; greedy last ${r3(c.pts[0].last)}; full balance sparsest ${r3(c.pts[c.pts.length - 1].winMin)})`);
  console.log('    ' + show.map((p) => `k${p.k}:${r3(p.winMin)}/${r3(p.last)}/${diffCount(c.greedy, p.starts)}`).join('  '));
}
function diffCount(a, b) { const A = new Set(a); let n = 0; for (const x of b) if (!A.has(x)) n++; return n; }

/* ── 2. selectors on the document vs the full balance ─────────────────── */
console.log('\n2. Selector on the document: per movement k chosen, sparsest line, last line, fill sd  (full balance in brackets)');
for (const sel of Object.keys(SELECTORS)) {
  const row = segs.map((sg, i) => {
    const g = makeSeg(sg.ws, sg.sigs); const r = solveF(g, sg.isFinal, sel); const fs = fillsOf(g, r.starts);
    const full = curves[i].c.pts[curves[i].c.pts.length - 1];
    return `k${r.k} ${r3(Math.min(...fs))} ${r3(fs[fs.length - 1])} ${r3(sdv(fs))} [${r3(full.winMin)} ${r3(full.last)} ${r3(sdv(full.fs))}]`;
  });
  console.log(`  ${sel.padEnd(14)} ` + row.join(' | '));
}

/* ── 3. edit churn: selectors (pure F before → after) vs today's edit ─── */
const results = {};
const bucketOf = (sg, m) => { const t = m / sg.ws.length; return t < 1 / 3 ? 'early' : t < 2 / 3 ? 'mid' : 'late'; };
const systems = ['today-edit', ...Object.keys(SELECTORS)];
for (const s of systems) results[s] = {};
let todayNull = 0;
for (const sg of segs) {
  const g0 = makeSeg(sg.ws, sg.sigs);
  const before = Object.fromEntries(Object.keys(SELECTORS).map((sel) => [sel, solveF(g0, sg.isFinal, sel).starts]));
  for (let m = 0; m < sg.ws.length; m++) for (const kind of KINDS) {
    if ((kind === 'delete' || kind === 'duplicate') && m === 0) continue;
    const p = perturb(sg, m, kind), g = makeSeg(p.ws, p.sigs);
    const b = bucketOf(sg, m);
    const rec = (s, c) => { const key = `${kind}|${b}`; (results[s][key] ??= []).push(c); };
    const t = todayEdit(sg, p, m, kind); if (t.fellBack) todayNull++;
    rec('today-edit', churn(sg.committed, sg.ids, t.starts, p.ids, m));
    const cv = curve(g);
    for (const sel of Object.keys(SELECTORS)) {
      const gr = cv.greedy;
      const after = sg.isFinal && gr.length < 3 ? gr : cv.pts[SELECTORS[sel](cv) - 1].starts;
      rec(sel, churn(before[sel], sg.ids, after, p.ids, m));
    }
  }
}
console.log(`\n3. Lines changed per edit, med/p90/p99/max (back-reach p99/max) — today's edit fell back on ${todayNull}`);
for (const kindSet of [['delete', 'duplicate'], ['narrow15', 'widen15'], ['narrow5', 'widen5']]) {
  console.log(`  ${kindSet.join('+')}:`);
  console.log('    ' + 'system'.padEnd(14) + ['early', 'mid', 'late'].map((b) => b.padEnd(28)).join(''));
  for (const s of systems) {
    const cells = ['early', 'mid', 'late'].map((b) => {
      const xs = kindSet.flatMap((k) => results[s][`${k}|${b}`] ?? []);
      return `${dist(xs.map((c) => c.changed))} (${q(xs.map((c) => c.backReach), 0.99)}/${Math.max(0, ...xs.map((c) => c.backReach))})`.padEnd(28);
    });
    console.log('    ' + s.padEnd(14) + cells.join(''));
  }
}
if (outPath) writeFileSync(outPath, JSON.stringify({ curves: curves.map(({ seg, c }) => ({ seg, greedy: c.greedy, pts: c.pts.map((p) => ({ k: p.k, winMin: p.winMin, last: p.last, sd: sdv(p.fs), starts: p.starts })) })) }, null, 1));

/* VARIANTS_OUT=<path>: write each selector's document partition (line-start
   measure indices) for test/composer-inspect/sonata-probes/apply-partition.js. */
if (process.env.VARIANTS_OUT) {
  const variants = {};
  for (const sel of Object.keys(SELECTORS)) {
    variants[sel] = segs.flatMap((sg) => solveF(makeSeg(sg.ws, sg.sigs), sg.isFinal, sel).starts.map((a) => sg.ids[a]));
  }
  writeFileSync(process.env.VARIANTS_OUT, JSON.stringify(variants));
}
