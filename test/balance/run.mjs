#!/usr/bin/env node
// Partition F unit test (apps/composer/src/render/balance.ts) — pure, no
// browser. Imports the TypeScript module directly (Node ≥ 23.6 strips erasable
// type syntax natively).
//
//   node test/balance/run.mjs
//
// F is the partition both load and edit run (docs/composer-partition-
// consistency-spec.md). The cases hold the app's port to the Phase 0
// simulation twin (partition-f.mjs + curve-batch.mjs) on the sonata and 600
// random sections, and check F's own rules: the sonata picks, purity, line
// count, no compression, far end = full balance, the final-section rule,
// atoms never split, an over-wide atom alone.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  greedyStarts, reachBackCurve, distinctLayouts, partitionSection, sectionAtoms, lineFills,
  PARTITION_GAMMA, FINAL_GREEDY_BELOW,
} from '../../apps/composer/src/render/balance.ts';
import { makeSeg } from './partition-f.mjs';
import { distinctLayouts as simDistinct, pick as simPick } from './curve-batch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

/* The pre-F balancer's minimum-variance DP — Σ(f − μ)² at exactly N lines,
   every line ≤ cap — kept here as F6's independent reference for the full
   balance after the balancer itself was removed (2026-10-20). Lens or null. */
function varianceDp(ws, sig, sigFirst, N, cap) {
  const M = ws.length, pre = new Float64Array(M + 1);
  for (let i = 0; i < M; i++) pre[i + 1] = pre[i] + ws[i];
  const mu = (pre[M] + sigFirst + (N - 1) * sig) / N, INF = Number.POSITIVE_INFINITY;
  let prev = new Float64Array(M + 1).fill(INF);
  prev[0] = 0;
  const back = [];
  for (let k = 1; k <= N; k++) {
    const cur = new Float64Array(M + 1).fill(INF), bk = new Int32Array(M + 1).fill(-1);
    for (let j = k; j <= M; j++) {
      for (let i = k - 1; i < j; i++) {
        if (prev[i] === INF) continue;
        const f = pre[j] - pre[i] + (i === 0 ? sigFirst : sig);
        if (f > cap) continue;
        const c = prev[i] + (f - mu) * (f - mu);
        if (c < cur[j]) { cur[j] = c; bk[j] = i; }
      }
    }
    back.push(bk);
    prev = cur;
  }
  if (prev[M] === INF) return null;
  const lens = new Array(N);
  let j = M;
  for (let k = N - 1; k >= 0; k--) { const i = back[k][j]; lens[k] = j - i; j = i; }
  return lens;
}
const startsOfLens = (lens) => { const st = []; let acc = 0; for (const L of lens) { st.push(acc); acc += L; } return st; };

/* ── F: the reach-back curve (partition spec Phase 1) ─────────────────────
 * The function both load and edit run (balance.ts). Inputs: the
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

/* F6. The curve's far end (k = N) IS the full balance: against the variance DP at
 *     [0, 1.00] (`varianceDp`) on constant-leading-block sections (where
 *     Σ(1−f)² and variance rank identically), and against brute force over
 *     every N-line split on small sections with varying blocks. */
{
  let badDp = 0, tried = 0;
  for (const sec of randoms) {
    if (sec.ws.some((w) => w > 0.95)) continue;
    const ws = sec.ws, sig = 0.05, sigFirst = sec.sigs[0] === 0 ? 0 : sig;
    const sigs = ws.map((_, a) => (a === 0 ? sigFirst : sig));
    const at = { ws, sigs };
    const { greedy, points } = reachBackCurve(at);
    const far = points[points.length - 1];
    const dp = varianceDp(ws, sig, sigFirst, greedy.length, 1.0);
    tried++;
    if (!dp || Math.abs(sdOf(far.fills) - sdOf(lineFills(at, startsOfLens(dp)))) > 1e-9) badDp++;
  }
  check(`F far end ≡ the minimum-variance DP's full balance at [0, 1.00] (${tried} sections)`, badDp === 0, `${badDp} differ`);
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
