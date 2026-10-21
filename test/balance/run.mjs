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
import {
  balanceSection, dpPartition, greedyLines, fillsOf, boundariesChanged,
  greedyStarts, reachBackCurve, distinctLayouts, pickLayout, partitionSection, sectionAtoms, lineFills,
  PARTITION_GAMMA, FINAL_GREEDY_BELOW,
} from '../../apps/composer/src/render/balance.ts';
import { makeSeg, curve as simCurve } from './partition-f.mjs';
import { distinctLayouts as simDistinct, pick as simPick } from './curve-batch.mjs';

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

/* ── F: the reach-back curve (partition spec Phase 1) ─────────────────────
 * The function both load and edit will run (balance.ts "F"). Inputs: the
 * sonata as dumped by sonata-probes/partition-inputs.js (per-measure naturals
 * and sigWForLine, so each line pays its OWN leading block), plus random
 * sections. The simulation twin (partition-f.mjs + curve-batch.mjs) is the
 * reference the app's port must reproduce exactly. */
const S = JSON.parse(readFileSync(join(here, 'sonata-inputs.json'), 'utf8'));
const unitOfS = (i) => { let hi = i; while (hi + 1 < S.measures && S.unitLo[hi + 1] === S.unitLo[i]) hi++; return [S.unitLo[i], hi]; };
const sBounds = [0, ...S.hard, S.measures];
const sonata = [];
for (let s = 0; s + 1 < sBounds.length; s++) {
  const lo = sBounds[s], hi = sBounds[s + 1];
  const at = sectionAtoms(lo, hi, S.budget, (i) => S.naturals[i], (i) => S.sig[i], unitOfS);
  /* curve-batch.mjs's own atom construction, kept independent on purpose. */
  const ws = [], sigs = [];
  for (let i = lo; i < hi;) { let j = i; while (j + 1 < hi && S.unitLo[j + 1] === i) j++; let w = 0; for (let k = i; k <= j; k++) w += S.naturals[k]; ws.push(w / S.budget); sigs.push(S.sig[i] / S.budget); i = j + 1; }
  sonata.push({ at, sim: { ws, sigs }, final: s + 2 === sBounds.length, lo, hi });
}
const sdOf = (fs) => { const mu = fs.reduce((a, b) => a + b, 0) / fs.length; return fs.reduce((a, b) => a + (b - mu) ** 2, 0); };
const sameLayouts = (a, b) => a.length === b.length && a.every((r, i) => r.starts.join() === b[i].starts.join()
  && r.changes === b[i].chg && r.kFrom === b[i].kFrom && r.kTo === b[i].kTo && r.lines === b[i].lines
  && Math.abs(r.min - b[i].min) < 1e-12 && Math.abs(r.sd - b[i].sd) < 1e-12);

/* F1. The sonata at γ 0.03 reproduces the spec's Phase 0 picks (Max's own:
 *     I 1 change, II 0, III 3, IV 1) with their min / spread. */
{
  const want = [[1, 0.672, 0.089], [0, 0.862, 0.020], [3, 0.693, 0.082], [1, 0.691, 0.051]];
  sonata.forEach((sec, si) => {
    check(`F sonata movement ${si + 1}: atoms built (no missing width)`, sec.at !== null);
    if (!sec.at) return;
    check(`F sonata movement ${si + 1}: sectionAtoms ≡ the simulation's atoms`,
      sec.at.ws.length === sec.sim.ws.length && sec.at.ws.every((w, i) => w === sec.sim.ws[i]) && sec.at.sigs.every((g, i) => g === sec.sim.sigs[i]));
    const t0 = performance.now();
    const r = partitionSection(sec.at, sec.final);
    const ms = performance.now() - t0;
    const [chg, mn, sd] = want[si];
    check(`F sonata movement ${si + 1}: pick = ${chg} change(s), min ${mn}, sd ${sd}`,
      r.layout.changes === chg && r.layout.min.toFixed(3) === mn.toFixed(3) && r.layout.sd.toFixed(3) === sd.toFixed(3),
      `${r.layout.changes} changes, min ${r.layout.min.toFixed(3)} sd ${r.layout.sd.toFixed(3)}, ${r.greedy.length} lines, ${r.layouts} layouts, ${ms.toFixed(2)} ms`);
  });
}

/* F2. The port ≡ the simulation: every distinct layout (starts, reach, changes,
 *     score) and the pick, on the sonata and on random sections with per-atom
 *     leading blocks and the occasional over-wide atom. */
let rngState = 20261020;
const rnd = () => { rngState = (rngState * 1664525 + 1013904223) >>> 0; return rngState / 2 ** 32; };
const randomSection = () => {
  const M = 1 + Math.floor(rnd() * 60);
  const sigSet = [0.035, 0.05, 0.072];
  let sg = sigSet[Math.floor(rnd() * 3)];
  const ws = [], sigs = [];
  for (let a = 0; a < M; a++) {
    if (rnd() < 0.05) sg = sigSet[Math.floor(rnd() * 3)];            // a key change
    ws.push(rnd() < 0.03 ? 1.0 + rnd() * 0.6 : 0.03 + rnd() * (rnd() < 0.5 ? 0.15 : 0.42));
    sigs.push(a === 0 && rnd() < 0.3 ? 0 : sg);                       // a document's first line
  }
  return { ws: Object.freeze(ws), sigs: Object.freeze(sigs) };
};
const randoms = Array.from({ length: 600 }, randomSection);
{
  let bad = [], badPick = [];
  const all = [...sonata.map((s) => s.sim), ...randoms];
  all.forEach((sec, i) => {
    const app = distinctLayouts(sec).layouts;
    const sim = simDistinct(makeSeg(sec.ws, sec.sigs)).rows;
    const simMapped = sim.map((r) => ({ ...r, kFrom: r.kFrom, kTo: r.kTo }));
    if (!sameLayouts(app, simMapped)) bad.push(i);
    if (partitionSection(sec, false).starts.join() !== simPick(sim, PARTITION_GAMMA).starts.join()) badPick.push(i);
  });
  check(`F ≡ simulation: distinct layouts on ${all.length} sections (4 sonata + random)`, bad.length === 0, bad.slice(0, 8).join(','));
  check(`F ≡ simulation: the pick on ${all.length} sections`, badPick.length === 0, badPick.slice(0, 8).join(','));
}

/* F3. Purity: a pure function of the atoms — same answer twice, inputs
 *     untouched (frozen: a write would throw), no incumbent to depend on. */
{
  let bad = 0;
  for (const sec of randoms.slice(0, 200)) {
    const a = partitionSection(sec, false), b = partitionSection({ ws: [...sec.ws], sigs: [...sec.sigs] }, false);
    if (a.starts.join() !== b.starts.join()) bad++;
  }
  check('F purity: identical answers on equal inputs (frozen originals, fresh copies)', bad === 0, `${bad} differ`);
}

/* F4–F5. Every curve point has greedy's line count; every line ≤ 1.00 except a
 *     lone over-wide atom; starts are strictly increasing atom indices from 0. */
{
  let count = 0, cap = 0, shape = 0, pickCount = 0;
  for (const sec of [...sonata.map((s) => s.at), ...randoms]) {
    const { greedy, points } = reachBackCurve(sec);
    for (const p of points) {
      if (p.starts.length !== greedy.length) count++;
      if (p.starts[0] !== 0 || p.starts.some((x, k) => k > 0 && x <= p.starts[k - 1]) || p.starts[p.starts.length - 1] >= sec.ws.length) shape++;
      p.fills.forEach((f, k) => {
        const len = (k + 1 < p.starts.length ? p.starts[k + 1] : sec.ws.length) - p.starts[k];
        if (f > 1.0 + 1e-12 && len > 1) cap++;
      });
    }
    if (partitionSection(sec, false).starts.length !== greedyStarts(sec).length) pickCount++;
  }
  check('F line count: every curve point and every pick has greedy\'s count', count === 0 && pickCount === 0, `${count} points, ${pickCount} picks`);
  check('F no compression: every line ≤ 1.00 unless it is one over-wide atom', cap === 0, `${cap} lines`);
  check('F shape: starts strictly increase from atom 0', shape === 0, `${shape} points`);
}

/* F6. The curve's far end (k = N) IS the full balance: against dpPartition at
 *     [0, 1.00] on constant-leading-block sections (where Σ(1−f)² and variance
 *     rank identically), and against brute force over every N-line split on
 *     small sections with varying blocks. */
{
  let badDp = 0, tried = 0;
  for (const sec of randoms) {
    if (sec.ws.some((w) => w > 0.95)) continue;
    const ws = sec.ws, sig = 0.05, sigFirst = sec.sigs[0] === 0 ? 0 : sig;
    const sigs = ws.map((_, a) => (a === 0 ? sigFirst : sig));
    const at = { ws, sigs };
    const { greedy, points } = reachBackCurve(at);
    const far = points[points.length - 1];
    const dp = dpPartition(ws, sig, greedy.length, new Set(), { minFill: 0, fitMax: 1.0, softMax: 1.0, lambda: 0 }, sigFirst);
    tried++;
    if (!dp || Math.abs(sdOf(far.fills) - sdOf(fillsOf(ws, sig, dp, sigFirst))) > 1e-9) badDp++;
  }
  check(`F far end ≡ dpPartition full balance at [0, 1.00] (${tried} sections)`, badDp === 0, `${badDp} differ`);
  let badBrute = 0, n = 0;
  for (const sec of randoms) {
    const M = sec.ws.length;
    if (M > 12) continue;
    const N = greedyStarts(sec).length;
    let best = Infinity;
    for (let mask = 0; mask < 1 << (M - 1); mask++) {
      const st = [0];
      for (let a = 1; a < M; a++) if (mask & (1 << (a - 1))) st.push(a);
      if (st.length !== N) continue;
      const fs = lineFills(sec, st);
      if (fs.some((f, k) => f > 1.0 && (k + 1 < N ? st[k + 1] : M) - st[k] > 1)) continue;
      best = Math.min(best, fs.reduce((a, f) => a + (1 - f) ** 2, 0));
    }
    const far = reachBackCurve(sec).points[N - 1];
    n++;
    if (Math.abs(far.fills.reduce((a, f) => a + (1 - f) ** 2, 0) - best) > 1e-9) badBrute++;
  }
  check(`F far end = brute-force min Σ(1−f)² at greedy's count (${n} small sections)`, badBrute === 0, `${badBrute} differ`);
}

/* F7. Final-section rule: a FINAL section of fewer than 3 greedy lines stays
 *     greedy; the same content before another section (or a lock) is balanced
 *     — the just-over-one-line section becomes two lines, never one
 *     compressed one. */
{
  const at = { ws: Array(8).fill(0.13), sigs: Array(8).fill(0.05) };   // 1.09 natural: greedy 7 + 1
  const g = partitionSection(at, true), b = partitionSection(at, false);
  check('F final section under 3 lines stays greedy (stub kept)', FINAL_GREEDY_BELOW === 3
    && g.exempt && g.starts.join() === '0,7', `[${g.starts}] ${lineFills(at, g.starts).map((f) => f.toFixed(2))}`);
  const bf = lineFills(at, b.starts);
  check('F just-over-one-line section before a break → two even lines (no compression)',
    !b.exempt && b.starts.length === 2 && Math.min(...bf) >= 0.5 && Math.max(...bf) <= 1.0,
    `[${b.starts}] ${bf.map((f) => f.toFixed(2))}`);
  const at3 = { ws: Array(20).fill(0.13), sigs: Array(20).fill(0.05) }; // greedy 7+7+6: 3 lines
  check('F final section of 3+ lines is picked, not exempt', !partitionSection(at3, true).exempt);
  const one = { ws: [0.2, 0.2], sigs: [0.05, 0.05] };
  check('F one-line section: one line, final or not (exempt only when final)',
    partitionSection(one, true).starts.join() === '0' && partitionSection(one, false).starts.join() === '0'
    && partitionSection(one, true).exempt && !partitionSection(one, false).exempt);
  check('F empty section: no lines', partitionSection({ ws: [], sigs: [] }, false).starts.length === 0);
}

/* F8. Atoms never split: a multirest run is one atom (sectionAtoms), so no
 *     line can start inside it, and a missing width refuses the section. */
{
  const nat = Array(30).fill(2000);
  const unitOf = (i) => (i >= 5 && i <= 11 ? [5, 11] : i >= 20 && i <= 22 ? [20, 22] : [i, i]);
  const at = sectionAtoms(0, 30, 19000, (i) => nat[i], () => 900, unitOf);
  check('F sectionAtoms: one atom per render unit', at !== null && at.ws.length === 30 - 6 - 2
    && at.atomStart.join() === [0, 1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 20, 23, 24, 25, 26, 27, 28, 29].join()
    && Math.abs(at.ws[5] - 7 * 2000 / 19000) < 1e-12);
  let inside = 0;
  for (let lo = 0; lo < 25; lo += 3) {
    const a = sectionAtoms(lo, 30, 19000, (i) => nat[i], () => 900, unitOf);
    for (const final of [false, true]) {
      for (const st of partitionSection(a, final).starts.map((x) => a.atomStart[x])) {
        const [uLo] = unitOf(st);
        if (uLo < st && uLo >= lo) inside++;
      }
    }
  }
  check('F atoms never split: no line starts inside a multirest run', inside === 0, `${inside} starts`);
  check('F sectionAtoms: a missing natural or leading block refuses the section',
    sectionAtoms(0, 30, 19000, (i) => (i === 17 ? undefined : nat[i]), () => 900, unitOf) === null
    && sectionAtoms(0, 30, 19000, (i) => nat[i], (i) => (i === 12 ? null : 900), unitOf) === null);
}

/* F9. A measure wider than a line sits alone, at every point of the curve. */
{
  const at = { ws: [0.3, 0.3, 1.3, 0.3, 0.3, 0.3, 0.2, 0.2, 0.2], sigs: Array(9).fill(0.05) };
  const alone = reachBackCurve(at).points.every((p) => p.starts.includes(2) && p.starts.includes(3));
  const pick = partitionSection(at, false).starts;
  check('F over-wide measure sits alone on every curve point and in the pick', alone && pick.includes(2) && pick.includes(3), `[${pick}]`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall ok');
process.exit(failures ? 1 : 0);
