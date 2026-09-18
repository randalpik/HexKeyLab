#!/usr/bin/env node
// Section balancer unit test — pure, no browser. Imports the TypeScript module
// directly (Node ≥ 23.6 strips erasable type syntax natively).
//
//   node test/balance/run.mjs
//
// The balancer is the PARTITION AUTHORITY (balance.ts header): line count from
// `greedyLines` at BALANCE_SOFT_MAX, arrangement from the minimum-variance DP,
// both functions of the widths alone. The cases below are organised around the
// properties that buys — purity, agreement with castoff's line count, evenness
// — plus the small-document rule and infeasibility.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { balanceSection, dpPartition, greedyLines, fillsOf, boundariesChanged } from '../../apps/composer/src/render/balance.ts';

const here = dirname(fileURLToPath(import.meta.url));
const D = JSON.parse(readFileSync(join(here, 'sonata-fills.json'), 'utf8'));
/* Mirrors linebreaks.ts: MIN_FILL, FIT_MAX, BALANCE_SOFT_MAX, BALANCE_LAMBDA. */
const P = { minFill: 0.65, fitMax: 1.45, softMax: 1.00, lambda: 0 };
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };
const stats = (fs) => { const mu = fs.reduce((a, b) => a + b, 0) / fs.length; return { min: Math.min(...fs), max: Math.max(...fs), mean: mu, sd: Math.sqrt(fs.reduce((a, b) => a + (b - mu) ** 2, 0) / fs.length) }; };
const fmt = (s) => `min ${s.min.toFixed(3)} max ${s.max.toFixed(3)} sd ${s.sd.toFixed(3)}`;

const bounds = []; { let from = 0; for (const h of D.hardIdx) { bounds.push([from, h]); from = h; } bounds.push([from, D.w.length]); }
const lensOf = (lo, hi) => { const s = D.starts.filter((x) => x >= lo && x < hi); return s.map((x, k) => (k + 1 < s.length ? s[k + 1] : hi) - x); };

/* 1. greedyLines is the exact minimum contiguous partition under a cap. */
{
  check('greedyLines: empty-ish', greedyLines([0.5], 0.03, 1.0) === 1);
  check('greedyLines: exact fit', greedyLines([0.3, 0.3, 0.3], 0.1, 1.0) === 1, '0.1+0.9 = 1.0');
  check('greedyLines: one over', greedyLines([0.3, 0.3, 0.3, 0.3], 0.1, 1.0) === 2);
  /* A single measure wider than the cap still occupies a line rather than
     looping forever (the `f > sigFill` guard). */
  check('greedyLines: oversize measure', greedyLines([2.0, 2.0], 0.03, 1.0) === 2);
  /* Brute force against the true minimum on random widths. */
  let bad = 0;
  for (let t = 0; t < 300; t++) {
    const n = 2 + Math.floor(Math.random() * 9);
    const ws = Array.from({ length: n }, () => 0.05 + Math.random() * 0.5);
    const want = greedyLines(ws, 0.03, 1.0);
    let best = Infinity;
    for (let mask = 0; mask < (1 << (n - 1)); mask++) {
      const lens = []; let c = 1;
      for (let i = 1; i < n; i++) { if (mask & (1 << (i - 1))) { lens.push(c); c = 1; } else c++; }
      lens.push(c);
      if (Math.max(...fillsOf(ws, 0.03, lens)) <= 1.0) best = Math.min(best, lens.length);
    }
    if (best !== Infinity && best !== want) bad++;
  }
  check('greedyLines: minimal over 300 random widths', bad === 0, `${bad} disagreements`);
}

/* 2. THE single-authority property: the result does not depend on the
 *    incumbent partition. A derive (which has castoff's partition in hand) and
 *    an edit (which has the previous edit's) must land on the same layout. */
bounds.forEach(([lo, hi], si) => {
  const ws = D.w.slice(lo, hi);
  const fromCastoff = balanceSection(ws, D.sig, lensOf(lo, hi), P);
  const fromEven = balanceSection(ws, D.sig, [ws.length], P);
  const fromSilly = balanceSection(ws, D.sig, Array(ws.length).fill(1), P);
  check(`movement ${si + 1}: partition is independent of the incumbent`,
    fromCastoff !== null && fromEven !== null && fromSilly !== null
      && fromCastoff.lens.join() === fromEven.lens.join()
      && fromCastoff.lens.join() === fromSilly.lens.join(),
    fromCastoff ? `[${fromCastoff.lens.slice(0, 6).join(',')}…]` : 'null');
});

/* 3. Sonata movements: line count agrees with castoff's, every line legal,
 *    evenness strictly better than castoff's. */
bounds.forEach(([lo, hi], si) => {
  const ws = D.w.slice(lo, hi); const cur = lensOf(lo, hi);
  const before = stats(fillsOf(ws, D.sig, cur));
  const res = balanceSection(ws, D.sig, cur, P);
  if (!res) { check(`movement ${si + 1} balances`, false, 'null'); return; }
  const fs = fillsOf(ws, D.sig, res.lens); const after = stats(fs);
  check(`movement ${si + 1}: line count matches castoff (no page moves)`,
    res.lens.length === cur.length, `${cur.length} → ${res.lens.length}`);
  check(`movement ${si + 1}: every line legal, evenness improved (${before.min.toFixed(2)} → ${fmt(after)})`,
    after.min >= P.minFill && after.max <= P.fitMax && after.sd < before.sd);
  check(`movement ${si + 1}: measure count preserved`,
    res.lens.reduce((a, b) => a + b, 0) === ws.length);
  /* The soft ceiling chooses the line COUNT; the DP then minimises variance at
     that count, so an individual line may sit a little above it (the mean is
     fixed once N is). What must hold is that nothing approaches FIT_MAX — the
     sprawling 1.42 line is the defect being fixed. */
  check(`movement ${si + 1}: no line near the legality ceiling`, after.max <= P.softMax + 0.1,
    `max fill ${after.max.toFixed(3)}`);
});

/* 4. Idempotence: balancing an already-balanced section moves nothing. That is
 *    what makes an edit's rebalance cost proportional to the edit, and what
 *    guarantees no first-edit settling on a document balanced pre-paint. */
bounds.forEach(([lo, hi], si) => {
  const ws = D.w.slice(lo, hi);
  const once = balanceSection(ws, D.sig, lensOf(lo, hi), P);
  const twice = balanceSection(ws, D.sig, once.lens, P);
  check(`movement ${si + 1}: idempotent`, boundariesChanged(once.lens, twice.lens) === 0);
});

/* 5. Append trace on the measured widths of an empty 4/4 score (the reported
 *    bug: 4,5,5,5,5,9 with a first line frozen at fill 0.70). Every step must
 *    be even — no line more than one measure off its neighbours — and the
 *    layout must equal what a fresh derive of the same bar count produces. */
{
  const B = 19014, SIG = 546.72 / B;
  const widths = (n) => Array.from({ length: n }, (_, i) => (i === 0 ? 3963 : i === n - 1 ? 3074 : 2930) / B);
  let prev = null, ragged = [], disagree = [];
  for (let n = 8; n <= 40; n++) {
    const ws = widths(n);
    /* The edit path carries the partition across first: the appended measure
       joins the last line, exactly as `repartition` does by membership. */
    const carried = prev ? [...prev.slice(0, -1), prev[prev.length - 1] + 1] : [n];
    const edit = balanceSection(ws, SIG, carried, P);
    const derive = balanceSection(ws, SIG, [n], P);
    if (!edit || !derive) { ragged.push(`${n}:null`); continue; }
    prev = edit.lens;
    if (edit.lens.join() !== derive.lens.join()) disagree.push(n);
    if (Math.max(...edit.lens) - Math.min(...edit.lens) > 1) ragged.push(`${n}:[${edit.lens.join(',')}]`);
  }
  check('append 8..40 bars: every step even (spread ≤ 1 measure)', ragged.length === 0, ragged.join(' '));
  check('append 8..40 bars: edit path ≡ fresh derive at every count', disagree.length === 0, disagree.join(','));
}

/* 6. Small documents (Max's rule 2): too little content for two legal lines
 *    keeps its stub — the balancer declines rather than inventing a layout. */
{
  const ws = [0.25, 0.25, 0.25];                       // T = 0.75 + sig: one line only
  /* The balancer reports the one-line answer; whether a one-line DOCUMENT is
     ownable is the caller's rule (linebreaks.ts 'single-line result'). */
  const r1 = balanceSection(ws, D.sig, [3], P);
  check('too small for two legal lines → one line, not null',
    r1 !== null && r1.lens.length === 1 && r1.lens[0] === 3, JSON.stringify(r1));
  /* The same shape as a lock remainder: 7 narrow measures have no legal
     2-line split, so they belong on one compressed line (was the merge rule). */
  const ws7 = [0.208, 0.154, 0.154, 0.154, 0.154, 0.154, 0.154];
  const r7 = balanceSection(ws7, D.sig, [6, 1], P);
  check('lock remainder folds to one line rather than 6+1',
    r7 !== null && r7.lens.length === 1, JSON.stringify(r7));
  const ws2 = [0.3, 0.3, 0.3, 0.3, 0.1];               // 1.30: two legal lines exist
  const r2 = balanceSection(ws2, D.sig, [3, 2], P);
  check('two legal lines are found when they exist', r2 !== null && r2.lens.length === 2
    && Math.min(...fillsOf(ws2, D.sig, r2.lens)) >= P.minFill - 1e-9,
    r2 ? fillsOf(ws2, D.sig, r2.lens).map((f) => f.toFixed(2)).join(',') : 'null');
}

/* 7. A measure too wide for the soft ceiling: greedy undercounts (it cannot
 *    split one measure), so N0+1 is what makes the rest legal. */
{
  const ws = [1.30, 0.3, 0.3, 0.3, 0.3];
  const res = balanceSection(ws, D.sig, [5], P);
  const fs = res ? fillsOf(ws, D.sig, res.lens) : [];
  check('oversize measure: still legal via the N+1 candidate',
    res !== null && Math.max(...fs) <= P.fitMax && Math.min(...fs) >= P.minFill - 1e-9,
    res ? `[${res.lens.join(',')}] ${fs.map((f) => f.toFixed(2)).join(',')}` : 'null');
}

/* 8. Infeasible at every candidate count → null, and the caller keeps what it
 *    had (a stub survives rather than becoming an illegal layout). */
{
  const ws = Array(41).fill(0.3); ws.push(0.02);
  const res = balanceSection(ws, D.sig, [...Array(10).fill(4), 2], P);
  const fs = res ? fillsOf(ws, D.sig, res.lens) : [];
  check('infeasible → null, or a fully legal spread',
    res === null || Math.min(...fs) >= P.minFill - 1e-9,
    res ? fs.map((f) => f.toFixed(2)).join(',') : 'null (kept)');
}

/* 9. dpPartition still honours λ when a caller asks for it (kept as the
 *    documented tuning surface even though every caller passes 0). */
{
  const ws = Array(20).fill(0.20);        // 4 bars = 0.83, 6 = 1.23: all legal
  const ref = new Set([0, 4, 9, 14]);
  const free = dpPartition(ws, 0.03, 4, ref, { ...P, lambda: 0 });
  const stuck = dpPartition(ws, 0.03, 4, ref, { ...P, lambda: 5 });
  check('λ still anchors the DP to the reference', free !== null && stuck !== null
    && boundariesChanged(stuck, [4, 5, 5, 6]) === 0, stuck ? stuck.join(',') : 'null');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall ok');
process.exit(failures ? 1 : 0);
