#!/usr/bin/env node
// Section balancer unit test — pure, no browser. Imports the TypeScript module
// directly (Node ≥ 23.6 strips erasable type syntax natively).
//
//   node test/balance/run.mjs
//
// Cases: the four sonata movements at their castoff line counts (every balanced
// line legal, spread ≤ one bar, line count kept), the small-document rule
// (T≈1.2 lines → stub kept; T≈2.0/2.6 → balanced), the merge rule and the λ
// locality on a delete-at-section-end sequence, and infeasible → null.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { balanceSection, dpPartition, fillsOf, boundariesChanged } from '../../apps/composer/src/render/balance.ts';

const here = dirname(fileURLToPath(import.meta.url));
const D = JSON.parse(readFileSync(join(here, 'sonata-fills.json'), 'utf8'));
const P = { minFill: 0.65, fitMax: 1.45, lambda: 0.02, mergeMax: 1.2 };
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };
const stats = (fs) => { const mu = fs.reduce((a, b) => a + b, 0) / fs.length; return { min: Math.min(...fs), max: Math.max(...fs), mean: mu, sd: Math.sqrt(fs.reduce((a, b) => a + (b - mu) ** 2, 0) / fs.length) }; };
const fmt = (s) => `min ${s.min.toFixed(3)} max ${s.max.toFixed(3)} mean ${s.mean.toFixed(3)} sd ${s.sd.toFixed(3)}`;

/* Sections from the castoff partition. */
const bounds = []; { let from = 0; for (const h of D.hardIdx) { bounds.push([from, h]); from = h; } bounds.push([from, D.w.length]); }
const lensOf = (lo, hi) => { const s = D.starts.filter((x) => x >= lo && x < hi); return s.map((x, k) => (k + 1 < s.length ? s[k + 1] : hi) - x); };

/* 1. Every sonata movement at its castoff N, λ = 0 (nothing painted yet — the
 *    adoption path's setting): legal, even (spread ≤ one bar), fewer or equal
 *    lines (the merge rule folds a stub into its neighbour), sd improves. */
const P0 = { ...P, lambda: 0 };
bounds.forEach(([lo, hi], si) => {
  const ws = D.w.slice(lo, hi); const cur = lensOf(lo, hi);
  const before = stats(fillsOf(ws, D.sig, cur));
  const res = balanceSection(ws, D.sig, cur, P0);
  if (!res) { check(`movement ${si + 1} balances (λ=0)`, false, 'null'); return; }
  const fs = fillsOf(ws, D.sig, res.lens); const after = stats(fs);
  check(`movement ${si + 1} balances, λ=0 (${before.min.toFixed(2)} → ${fmt(after)})`,
    res.lens.length <= cur.length && res.lens.length >= cur.length - 1 && after.min >= P.minFill && after.max <= P.fitMax && after.max - after.min <= 0.35 && after.sd < before.sd,
    `N ${cur.length}→${res.lens.length}, boundaries changed ${boundariesChanged(cur, res.lens)}`);
  check(`movement ${si + 1} measure count preserved`, res.lens.reduce((a, b) => a + b, 0) === ws.length);
  /* λ = 0.02 (a mounted section): the same defect is fixed with a handful of boundaries. */
  const resL = balanceSection(ws, D.sig, cur, P);
  const fsL = resL ? fillsOf(ws, D.sig, resL.lens) : [];
  check(`movement ${si + 1} balances, λ=0.02: legal and local`, resL !== null && Math.min(...fsL) >= P.minFill && Math.max(...fsL) <= P.fitMax && boundariesChanged(cur, resL.lens) <= 4,
    resL ? `boundaries changed ${boundariesChanged(cur, resL.lens)}, ${fmt(stats(fsL))}` : 'null');
});

/* 2. Small documents: castoff = greedy pack at fill ≤ 1.0. */
const greedy = (ws) => { const lens = []; let acc = D.sig, c = 0; for (const x of ws) { if (acc + x > 1.0 && c > 0) { lens.push(c); acc = D.sig; c = 0; } acc += x; c++; } lens.push(c); return lens; };
const smallDoc = (T) => { const n = Math.max(1, Math.round(T / 0.2)); const ws = Array(n).fill(0.2); ws[n - 1] = Math.max(0.05, T - 0.2 * (n - 1)); return ws; };
{
  const ws = smallDoc(1.2); const lens = greedy(ws);          // [0.85, 0.45]
  const res = balanceSection(ws, D.sig, lens, P0);
  check('T=1.2: two 0.65 lines is the only legal balance (MIN_FILL exactly)', res !== null && res.lens.length === 2 && Math.min(...fillsOf(ws, D.sig, res.lens)) >= P.minFill - 1e-9, res ? fillsOf(ws, D.sig, res.lens).map((f) => f.toFixed(2)).join(',') : 'null');
}
{
  const ws = smallDoc(1.1); const lens = greedy(ws);          // [0.85, 0.35]: 1.15 ≤ MERGE_MAX → one line
  const res = balanceSection(ws, D.sig, lens, P0);
  check('T=1.1: folds into one 1.15 line (caller applies the single-line rule)', res !== null && res.lens.length === 1, res ? JSON.stringify(res) : 'null');
}
{
  const ws = [0.3, 0.3, 0.3, 0.3, 0.1]; const lens = [3, 2];  // 0.95 + 0.45: merged 1.35 > MERGE_MAX, split needs two ≥ 0.65 lines → 0.65/0.75 exists
  const res = balanceSection(ws, D.sig, lens, P0);
  check('0.95+0.45: rebalanced into two legal lines', res !== null && res.lens.length === 2 && Math.min(...fillsOf(ws, D.sig, res.lens)) >= P.minFill - 1e-9, res ? fillsOf(ws, D.sig, res.lens).map((f) => f.toFixed(2)).join(',') : 'null');
}
{
  const ws = [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.05]; const lens = [3, 3, 3];  // 0.95, 0.95, 0.70... make the last sparse:
  const ws2 = [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.05, 0.05]; const lens2 = [3, 3, 3, 3]; // last = 0.3+0.05+0.05+sig = 0.45 → merged 1.40 > MERGE_MAX
  const res = balanceSection(ws2, D.sig, lens2, P0);
  const fs = res ? fillsOf(ws2, D.sig, res.lens) : [];
  check('sparse doc-final line with no merge → DP at N spreads it', res !== null && res.lens.length === 4 && Math.min(...fs) >= P.minFill - 1e-9, fs.map((f) => f.toFixed(2)).join(','));
}
{
  const ws = smallDoc(1.05); const lens = greedy(ws);         // [0.85, 0.25] → merged 1.05 ≤ MERGE_MAX → one line
  const res = balanceSection(ws, D.sig, lens, P0);
  check('T=1.05: one line', res !== null && res.lens.length === 1, res ? JSON.stringify(res) : 'null');
}
{
  const ws = [0.25, 0.25, 0.25, 0.25, 0.1]; const lens = [4, 1];   // 1.05 + 0.15: merge → 1.15 ≤ 1.2 → one line; but 5 bars at 0.65/0.55 → no 2-line split
  const res = balanceSection(ws, D.sig, lens, P0);
  check('1.05 + 0.15 stub folds (MERGE_MAX 1.2)', res !== null && res.lens.length === 1, res ? JSON.stringify(res) : 'null');
}
{
  const ws = [0.3, 0.3, 0.3, 0.3, 0.3, 0.05]; const lens = [4, 2];  // 1.25 + 0.40: merged 1.60 > MERGE_MAX; DP at 2: any split has a line < 0.65 or > 1.45? [3,3]=0.95,0.70 ok
  const res = balanceSection(ws, D.sig, lens, P0);
  check('1.25 + 0.40: DP finds 0.95/0.70', res !== null && res.lens.length === 2 && Math.min(...fillsOf(ws, D.sig, res.lens)) >= P.minFill - 1e-9, res ? fillsOf(ws, D.sig, res.lens).map((f) => f.toFixed(2)).join(',') : 'null');
}
{
  const ws = [0.35, 0.35, 0.35, 0.35, 0.02]; const lens = [3, 2];  // 1.10 + 0.42: merged 1.47 > MERGE_MAX; splits: [2,3]=0.75,0.77 ✓
  const res = balanceSection(ws, D.sig, lens, P0);
  check('1.10 + 0.42: DP finds 0.75/0.77', res !== null && Math.min(...fillsOf(ws, D.sig, res.lens)) >= P.minFill - 1e-9, res ? fillsOf(ws, D.sig, res.lens).map((f) => f.toFixed(2)).join(',') : 'null');
}
{
  const ws = [0.5, 0.5, 0.5, 0.1]; const lens = [2, 2];             // 1.05 + 0.65 legal → not defective; but pass it: last ≥ MIN_FILL → balancer still runs the DP (caller gates on the trigger)
  const ws3 = [0.45, 0.45, 0.45, 0.45, 0.45, 0.05]; const lens3 = [3, 3];  // 1.40 + 0.95 fine
  check('caller-side trigger: a legal final line is not the balancer\'s business', fillsOf(ws3, D.sig, lens3)[1] >= P.minFill);
}
{
  const ws = [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.02];
  const lens = [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 2];                 // ten 1.25 lines + 0.37: merged 1.57 > MERGE_MAX; every 2-bar line 0.65 legal, 3-bar 0.95, 4-bar 1.25, 5-bar 1.55 ✗
  const res = balanceSection(ws, D.sig, lens, P0);
  const fs = res ? fillsOf(ws, D.sig, res.lens) : [];
  check('doc-final infeasible → null keeps the stub, or a legal spread', res === null || Math.min(...fs) >= P.minFill - 1e-9, res ? fs.map((f) => f.toFixed(2)).join(',') : 'null (stub kept)');
}

/* 3. Merge rule: a 0.3 final line after a 0.8 line folds into one 1.05 line. */
{
  const ws = [0.25, 0.25, 0.25, 0.25];                        // 0.8 (3 bars) + 0.3 (1 bar)
  const res = balanceSection(ws, D.sig, [3, 1], P);
  check('merge rule folds a sparse final line under MERGE_MAX', res !== null && res.lens.length === 1 && res.removed === 1, JSON.stringify(res));
}
{
  const ws = [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.2];             // 0.95 + 0.95 + 0.25: merged 1.15 ≤ 1.2 → merge
  const res = balanceSection(ws, D.sig, [3, 3, 1], P);
  check('merge then DP at N−1 keeps lines legal', res !== null && res.lens.length === 2 && Math.min(...fillsOf(ws, D.sig, res.lens)) >= P.minFill, res ? fillsOf(ws, D.sig, res.lens).map((f) => f.toFixed(2)).join(',') : 'null');
}

/* 4. λ locality: deleting bars from the end of movement I, one at a time, must
 *    never move more than a handful of boundaries per step. */
{
  const [lo, hi] = bounds[0]; let ws = D.w.slice(lo, hi);
  let lens = balanceSection(ws, D.sig, lensOf(lo, hi), P).lens;
  let worst = 0; const trace = [];
  for (let d = 0; d < 12; d++) {
    ws = ws.slice(0, -1); lens = lens.slice(); lens[lens.length - 1]--; if (lens[lens.length - 1] === 0) lens.pop();
    const fs = fillsOf(ws, D.sig, lens);
    if (fs[fs.length - 1] >= P.minFill) { trace.push('-'); continue; }
    const res = balanceSection(ws, D.sig, lens, P);
    if (!res) { trace.push('null'); continue; }
    const ch = boundariesChanged(lens, res.lens); worst = Math.max(worst, ch); trace.push(String(ch));
    lens = res.lens;
  }
  check('delete-at-section-end stays local (≤ 4 boundaries per step)', worst <= 4, trace.join(' '));
  check('section stays legal and even after 12 deletions', (() => { const s = stats(fillsOf(ws, D.sig, lens)); return s.min >= P.minFill && s.max <= P.fitMax && s.max - s.min <= 0.35; })(), fmt(stats(fillsOf(ws, D.sig, lens))));
}

/* 5. dpPartition edge cases. */
check('dpPartition N > M → null', dpPartition([0.5, 0.5], D.sig, 3, new Set(), P) === null);
check('dpPartition infeasible (one 0.4 bar alone) → null', dpPartition([0.4], D.sig, 1, new Set(), P) === null);
check('dpPartition single legal line', JSON.stringify(dpPartition([0.4, 0.4], D.sig, 1, new Set(), P)) === '[2]');
check('balanceSection rejects lens that do not sum to M', balanceSection([0.3, 0.3], D.sig, [1], P) === null);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
