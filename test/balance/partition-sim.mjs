#!/usr/bin/env node
// Phase 0 of docs/composer-partition-consistency-spec.md: simulate F on a
// partition-inputs dump (test/composer-inspect/sonata-probes/partition-inputs.js)
// and report quality, window reach, no-window cases and edit churn per T /
// lambda / fallback, against today's load answer (balanceSection per section).
//
//   node test/balance/partition-sim.mjs <inputs.json> [out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { makeSeg, F, fillsOf, todaySection, greedyStarts } from './partition-f.mjs';

const D = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const outPath = process.argv[3];
const B = D.budget;
const BASE = { S: 1.00, minFill: 0.65, fitMax: 1.45, mergeMax: 1.45 };
const TS = [0.70, 0.75, 0.80, 0.85, 0.90];
/* λ (D2) only at one T: windows shift every interior boundary, so a penalty per
   moved start costs every arrangement alike (identical rows in the first run). */
const LAMBDA_CHECK_T = 0.75;
/* Fallbacks (D3): today's whole-section ladder, or a local window one line
   shorter whose lines may compress up to mergeMax. */
const FALLBACKS = [['section', null], ['merge', 1.45], ['merge', 1.20], ['merge', 1.10]];

/* Segments of atoms (render units). Atom ids = first measure index. */
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
  /* balanceSectionLines' one block per section: sigWAt(first). The dump holds
     sigWForLine, which differs only at measure 0 (the label indent); there the
     next measure's context stands in. */
  const sigSec = (lo === 0 ? D.sig[1] : D.sig[lo]) / B;
  segs.push({ lo, hi, ids, ws, sigs, sigSec });
}

const stats = (fs) => { const n = fs.length, mu = fs.reduce((a, b) => a + b, 0) / n; return { n, mean: mu, sd: Math.sqrt(fs.reduce((a, b) => a + (b - mu) ** 2, 0) / n), min: Math.min(...fs), max: Math.max(...fs), tail: fs[n - 1] }; };
const q = (xs, p) => { if (!xs.length) return 0; const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r3 = (x) => Math.round(x * 1000) / 1000;

/* 0. Sanity: today's load answer recomputed here equals the committed layout. */
const committed = new Set(D.starts);
let sane = true; const saneRows = [];
for (const sg of segs) {
  const g = makeSeg(sg.ws, sg.sigs);
  const t = todaySection(g, sg.sigSec, BASE).map((a) => sg.ids[a]);
  const c = D.starts.filter((x) => x >= sg.lo && x < sg.hi);
  const ok = t.join() === c.join(); if (!ok) sane = false;
  saneRows.push({ seg: `${sg.lo}-${sg.hi - 1}`, ok, sim: t.length, committed: c.length });
}

/* Perturbations: id-space mapping from new atom index to old id. */
function perturb(sg, m, kind) {
  const ws = sg.ws.slice(), sigs = sg.sigs.slice(), ids = sg.ids.slice();
  if (kind === 'delete') { ws.splice(m, 1); sigs.splice(m, 1); ids.splice(m, 1); }
  else if (kind === 'duplicate') { ws.splice(m + 1, 0, ws[m]); sigs.splice(m + 1, 0, sigs[m]); ids.splice(m + 1, 0, sg.ids[m] + 0.5); }
  else ws[m] *= SCALE[kind];
  return { ws, sigs, ids };
}
const SCALE = { narrow15: 0.85, widen15: 1.15, narrow5: 0.95, widen5: 1.05 };
const pairs = (starts, ids, M) => starts.map((s, k) => `${ids[s]}:${k + 1 < starts.length ? ids[starts[k + 1]] : 'end'}`);

function churn(sg, before, after, afterIds, m) {
  const oldP = pairs(before, sg.ids, sg.ws.length), newP = new Set(pairs(after, afterIds, afterIds.length));
  let Lm = 0; for (let k = 0; k < before.length; k++) if (before[k] <= m) Lm = k;
  let back = 0, backReach = 0, fwd = 0, fwdReach = 0, self = 0;
  oldP.forEach((p, k) => {
    if (newP.has(p)) return;
    if (k < Lm) { back++; backReach = Math.max(backReach, Lm - k); }
    else if (k > Lm) { fwd++; fwdReach = Math.max(fwdReach, k - Lm); }
    else self++;
  });
  return { back, backReach, fwd, fwdReach, self, changed: back + fwd + self };
}

function runConfig(name, solve) {
  const quality = [], windows = [], noWindow = [], times = [];
  const ch = { delete: [], duplicate: [], narrow15: [], widen15: [], narrow5: [], widen5: [] };
  for (const sg of segs) {
    const g = makeSeg(sg.ws, sg.sigs);
    const t0 = performance.now(); const r = solve(g, sg.sigSec); times.push(performance.now() - t0);
    const fs = fillsOf(g, r.starts);
    quality.push({ seg: `${sg.lo}-${sg.hi - 1}`, ...stats(fs), over1: fs.filter((x) => x > 1.0005).length, fellBack: r.fellBack ?? null, fs });
    for (const w of r.windows ?? []) windows.push(w.lines);
    for (const n of r.noWindow ?? []) noWindow.push({ seg: sg.lo, measure: sg.ids[n.start], fill: r3(n.fill) });
    for (let m = 0; m < sg.ws.length; m++) {
      for (const kind of Object.keys(ch)) {
        if ((kind === 'delete' || kind === 'duplicate') && m === 0) continue;
        const p = perturb(sg, m, kind);
        const g2 = makeSeg(p.ws, p.sigs);
        const t1 = performance.now(); const r2 = solve(g2, sg.sigSec); times.push(performance.now() - t1);
        const c = churn(sg, r.starts, r2.starts, p.ids, m);
        c.noWindow = (r2.noWindow ?? []).length; c.fellBack = r2.fellBack ?? null; c.measure = sg.ids[m];
        ch[kind].push(c);
      }
    }
  }
  const all = Object.values(ch).flat();
  const summ = (xs, f) => ({ med: q(xs.map(f), 0.5), p90: q(xs.map(f), 0.9), p99: q(xs.map(f), 0.99), max: Math.max(0, ...xs.map(f)) });
  return {
    name, quality, windowLens: { n: windows.length, ...summ(windows.map((x) => ({ x })), (o) => o.x) }, noWindow,
    churn: {
      changed: summ(all, (c) => c.changed), back: summ(all, (c) => c.back), backReach: summ(all, (c) => c.backReach),
      fwdReach: summ(all, (c) => c.fwdReach),
      editsReachingBack: all.filter((c) => c.back > 0).length, edits: all.length,
      editsHittingNoWindow: all.filter((c) => c.noWindow > 0).length,
      editsFallingBack: all.filter((c) => c.fellBack === 'section').length,
      byKind: Object.fromEntries(Object.entries(ch).map(([k, xs]) => [k, { changed: summ(xs, (c) => c.changed), backReach: summ(xs, (c) => c.backReach), fwdReach: summ(xs, (c) => c.fwdReach) }])),
      worstBack: all.slice().sort((a, b) => b.backReach - a.backReach).slice(0, 5).map((c) => ({ m: c.measure, backReach: c.backReach, changed: c.changed })),
    },
    ms: { med: r3(q(times, 0.5)), p99: r3(q(times, 0.99)), max: r3(Math.max(...times)) },
    _ch: ch,
  };
}

const results = [];
results.push(runConfig('today (balanceSection per section)', (g, sigSec) => ({ starts: todaySection(g, sigSec, BASE) ?? greedyStarts(g, BASE.S) })));
for (const T of TS) for (const [fallback, mergeMax] of FALLBACKS)
  results.push(runConfig(`F T=${T} ${fallback}${mergeMax ? '≤' + mergeMax : ''}`, (g, sigSec) => F(g, { ...BASE, T, lambda: 0, fallback, mergeMax: mergeMax ?? BASE.mergeMax }, sigSec)));
results.push(runConfig(`F T=${LAMBDA_CHECK_T} merge≤1.2 λ=0.02`, (g, sigSec) => F(g, { ...BASE, T: LAMBDA_CHECK_T, lambda: 0.02, fallback: 'merge', mergeMax: 1.2 }, sigSec)));

console.log(`sanity (today recomputed == committed): ${sane ? 'ok' : 'MISMATCH'}`, JSON.stringify(saneRows));
console.log('config'.padEnd(30), 'lines sd(seg)   min    max  >1.0  #noWin  lines<T win n/med/p90/max | backReach p90/p99/max edits-back noWinEdits fellBack | ms med/max');
for (const r of results) {
  const sd = r.quality.reduce((a, x) => a + x.sd, 0) / r.quality.length;
  const mn = Math.min(...r.quality.map((x) => x.min)), tl = Math.min(...r.quality.map((x) => x.tail));
  const c = r.churn, w = r.windowLens;
  const mx = Math.max(...r.quality.map((x) => x.max)), over = r.quality.reduce((a, x) => a + x.over1, 0), lines = r.quality.reduce((a, x) => a + x.n, 0);
  const T = Number(r.name.match(/T=([\d.]+)/)?.[1] ?? 0);
  console.log(r.name.padEnd(30), String(lines).padStart(5), r3(sd).toFixed(3).padStart(7), r3(mn).toFixed(3).padStart(6), r3(mx).toFixed(3).padStart(6), String(over).padStart(5), String(r.noWindow.length).padStart(7),
    String(T ? r.quality.reduce((a, x) => a + x.fs.filter((f) => f < T - 1e-9).length, 0) : '-').padStart(10),
    `${w.n}/${w.med}/${w.p90}/${w.max}`.padStart(14), ' |', `${c.backReach.p90}/${c.backReach.p99}/${c.backReach.max}`.padStart(12), `${c.editsReachingBack}/${c.edits}`.padStart(10),
    String(c.editsHittingNoWindow).padStart(10), String(c.editsFallingBack).padStart(8), ' |', `${r.ms.med}/${r.ms.max}`);
}
console.log('\nchanged lines per edit, by kind (med/p90/max) — forward reach in lines (p90/max)');
for (const r of results) {
  const k = r.churn.byKind;
  console.log(r.name.padEnd(30), Object.entries(k).map(([n, v]) => `${n} ${v.changed.med}/${v.changed.p90}/${v.changed.max} fwd ${v.fwdReach.p90}/${v.fwdReach.max}`).join('  |  '));
}
if (outPath) writeFileSync(outPath, JSON.stringify({ sane, saneRows, results: results.map(({ _ch, quality, ...r }) => ({ ...r, quality: quality.map(({ fs, ...x }) => x) })) }, null, 1));
