// Partition function F — SIMULATION copy for Phase 0 of
// docs/composer-partition-consistency-spec.md (greedy lines, then deficit
// windows right to left). Pure, DOM-free; Phase 1 moves the adopted variant
// into apps/composer/src/render/balance.ts.
//
// A segment is atoms (render units) with fills ws[k] = natural / budget and
// sigs[k] = the leading-block fill a line STARTING at atom k pays. Line k of a
// partition is atoms [starts[k], starts[k+1]).
//
// Params: S (greedy cap, BALANCE_SOFT_MAX), T (target), minFill, fitMax,
// lambda (window penalty per line start absent from the GREEDY partition — D2),
// fallback: what a deficit with no window does (D3):
//   'keep'    — stays as greedy made it (recorded);
//   'section' — the whole segment takes balanceSection's answer at the
//               legality bounds (today's load ladder N, N+1, N−1), else greedy;
//   'merge'   — grow the window again allowing ONE line fewer, ceiling
//               mergeMax; if none, keep.

import { balanceSection } from '../../apps/composer/src/render/balance.ts';

export function makeSeg(ws, sigs) {
  const M = ws.length, pre = new Float64Array(M + 1);
  for (let i = 0; i < M; i++) pre[i + 1] = pre[i] + ws[i];
  let minSig = Infinity; for (const s of sigs) minSig = Math.min(minSig, s);
  return { ws, sigs, pre, M, minSig };
}

export const fill = (g, a, b) => g.sigs[a] + g.pre[b] - g.pre[a];

export function lineEnds(g, starts) { return starts.map((s, k) => (k + 1 < starts.length ? starts[k + 1] : g.M)); }
export function fillsOf(g, starts) { const e = lineEnds(g, starts); return starts.map((s, k) => fill(g, s, e[k])); }

/** Greedy breaks at cap S (greedyLines' rule: a line breaks before an atom that
 *  would push it past S, unless the line is still empty). */
export function greedyStarts(g, S) {
  const st = [0]; let f = g.sigs[0];
  for (let k = 0; k < g.M; k++) {
    const w = g.ws[k];
    if (f + w > S && k > st[st.length - 1]) { st.push(k); f = g.sigs[k] + w; } else f += w;
  }
  return st;
}

/** Right-anchored reachability: R[c] = Uint8Array, R[c][x] = 1 when atoms
 *  [x, b) split into c lines with every fill in [lo, hi]. Grown on demand. */
function reacher(g, b, lo, hi) {
  const R = [null];
  const r1 = new Uint8Array(b);
  for (let x = b - 1; x >= 0; x--) {
    if (g.pre[b] - g.pre[x] + g.minSig > hi) break;
    const f = fill(g, x, b); if (f >= lo && f <= hi) r1[x] = 1;
  }
  R.push(r1);
  let dead = !r1.some((v) => v);
  return {
    get(c) {
      while (R.length <= c) {
        const prev = R[R.length - 1], nx = new Uint8Array(b);
        let any = false;
        if (!dead) for (let y = b - 1; y > 0; y--) {
          if (!prev[y]) continue;
          for (let x = y - 1; x >= 0; x--) {
            if (g.pre[y] - g.pre[x] + g.minSig > hi) break;
            const f = fill(g, x, y); if (f >= lo && f <= hi) { nx[x] = 1; any = true; }
          }
        }
        if (!any) dead = true;
        R.push(nx);
      }
      return R[c];
    },
    dead: () => dead,
  };
}

/** Minimum-variance split of atoms [a, b) into exactly c lines in [lo, hi],
 *  penalising starts absent from `ref` by lambda. Returns c starts or null. */
export function windowDP(g, a, b, c, lo, hi, ref, lambda) {
  const n = b - a, INF = Infinity;
  const mu = (g.pre[b] - g.pre[a] + c * g.sigs[a]) / c;
  let prev = new Float64Array(n + 1).fill(INF); prev[0] = 0;
  const back = [];
  for (let k = 1; k <= c; k++) {
    const cur = new Float64Array(n + 1).fill(INF), bk = new Int32Array(n + 1).fill(-1);
    for (let x = k; x <= n; x++) {
      let best = INF, bi = -1;
      for (let y = x - 1; y >= k - 1; y--) {
        if (g.pre[a + x] - g.pre[a + y] + g.minSig > hi) break;
        const base = prev[y]; if (base === INF) continue;
        const f = fill(g, a + y, a + x); if (f < lo || f > hi) continue;
        const d = f - mu;
        const cost = base + d * d + (y > 0 && lambda > 0 && !ref.has(a + y) ? lambda : 0);
        if (cost < best) { best = cost; bi = y; }
      }
      cur[x] = best; bk[x] = bi;
    }
    back.push(bk); prev = cur;
  }
  if (prev[n] === INF) return null;
  const out = new Array(c); let x = n;
  for (let k = c - 1; k >= 0; k--) { const y = back[k][x]; out[k] = a + y; x = y; }
  return out;
}

/** Today's load answer for one segment (balanceSection, one leading block per
 *  segment as balanceSectionLines passes it: sigSec = sigWAt(first), sigFirst
 *  = sigWForLine(first)). `sigSec` is supplied by the caller. Starts or null. */
export function todaySection(g, sigSec, P) {
  const res = balanceSection(Array.from(g.ws), sigSec, [g.M],
    { minFill: P.minFill, fitMax: P.fitMax, softMax: P.S, lambda: 0 }, g.sigs[0]);
  if (!res) return null;
  const st = []; let acc = 0; for (const L of res.lens) { st.push(acc); acc += L; }
  return st;
}

/** F over one segment. Returns { starts, windows, noWindow, fellBack }. */
export function F(g, P, sigSec = g.sigs[0]) {
  if (g.M === 0) return { starts: [], windows: [], noWindow: [], fellBack: null };
  const greedy = greedyStarts(g, P.S);
  const ref = new Set(greedy);
  const st = greedy.slice();
  const windows = [], noWindow = [];
  let i = st.length - 1;
  while (i >= 0) {
    const b = i + 1 < st.length ? st[i + 1] : g.M;
    const f = fill(g, st[i], b);
    if (f >= P.T) { i--; continue; }
    let done = false;
    const R = reacher(g, b, P.T, P.S);
    for (let j = i - 1; j >= 0 && !R.dead(); j--) {
      const c = i - j + 1;
      if (R.get(c)[st[j]]) {
        const w = windowDP(g, st[j], b, c, P.T, P.S, ref, P.lambda ?? 0);
        st.splice(j, c, ...w);
        windows.push({ line: i, from: j, lines: c, merged: false, deficit: f });
        i = j - 1; done = true; break;
      }
    }
    if (done) continue;
    noWindow.push({ line: i, start: st[i], fill: f });
    if (P.fallback === 'merge') {
      const RM = reacher(g, b, P.T, P.mergeMax);
      for (let j = i - 1; j >= 0 && !RM.dead(); j--) {
        const c = i - j + 1;
        if (RM.get(c - 1)[st[j]]) {
          const w = windowDP(g, st[j], b, c - 1, P.T, P.mergeMax, ref, P.lambda ?? 0);
          st.splice(j, c, ...w);
          windows.push({ line: i, from: j, lines: c, merged: true, deficit: f });
          i = j - 1; done = true; break;
        }
      }
      if (done) continue;
    }
    i--;
  }
  if (P.fallback === 'section' && noWindow.length) {
    const t = todaySection(g, sigSec, P);
    return { starts: t ?? st, windows, noWindow, fellBack: t ? 'section' : 'stub' };
  }
  return { starts: st, windows, noWindow, fellBack: null };
}

/* ── reach-back curve (curve-sim.mjs) ──────────────────────────────────── */

/** best[c][x] = min Σ(1−f)² splitting atoms [x, M) into c lines ≤ cap (a
 *  single atom wider than the cap sits alone). At a fixed count and fixed
 *  content this ranks arrangements exactly as variance does. */
export function curveTable(g, N, cap = 1.0) {
  const M = g.M, INF = Infinity;
  const best = [new Float64Array(M + 1).fill(INF)]; best[0][M] = 0;
  const back = [null];
  for (let c = 1; c <= N; c++) {
    const cur = new Float64Array(M + 1).fill(INF), bk = new Int32Array(M + 1).fill(-1), prev = best[c - 1];
    for (let x = M - 1; x >= 0; x--) {
      let bv = INF, by = -1;
      for (let y = x + 1; y <= M; y++) {
        const f = fill(g, x, y);
        if (f > cap && y > x + 1) break;
        const rest = prev[y]; if (rest === INF) continue;
        const v = (1 - f) * (1 - f) + rest;
        if (v < bv) { bv = v; by = y; }
      }
      cur[x] = bv; bk[x] = by;
    }
    best.push(cur); back.push(bk);
  }
  return { best, back };
}

/** Every point of the reach-back curve for one section: k = 1..N, the last k
 *  greedy lines re-divided (same count) into their most even arrangement. */
export function curve(g, cap = 1.0) {
  const gr = greedyStarts(g, cap), N = gr.length;
  const { back } = curveTable(g, N, cap);
  const pts = [];
  for (let k = 1; k <= N; k++) {
    const x0 = gr[N - k], win = [];
    let x = x0;
    for (let c = k; c >= 1; c--) { win.push(x); x = back[c][x]; }
    const starts = gr.slice(0, N - k).concat(win);
    const fs = fillsOf(g, starts), wf = fs.slice(N - k);
    pts.push({ k, starts, fs, winMin: Math.min(...wf), last: fs[N - 1] });
  }
  return { greedy: gr, pts };
}
