// Partition function F — the SIMULATION twin of apps/composer/src/render/
// balance.ts (docs/composer-partition-consistency-spec.md, Phase 0): the
// reach-back curve, written independently of the app so test/balance/run.mjs
// can hold the port to it; curve-batch.mjs adds the distinct layouts and the
// pick. Pure, DOM-free.
//
// A segment is atoms (render units) with fills ws[k] = natural / budget and
// sigs[k] = the leading-block fill a line STARTING at atom k pays. Line k of a
// partition is atoms [starts[k], starts[k+1]).
//
// The rejected Phase 0 candidates (greedy + one target T with deficit windows,
// the page-causal partition, anchored balances) and their comparisons against
// the pre-F balancer were removed with that balancer on 2026-10-20; their
// measurements are in the spec's "Phase 0 results" (git history has the code).

export function makeSeg(ws, sigs) {
  const M = ws.length, pre = new Float64Array(M + 1);
  for (let i = 0; i < M; i++) pre[i + 1] = pre[i] + ws[i];
  return { ws, sigs, pre, M };
}

export const fill = (g, a, b) => g.sigs[a] + g.pre[b] - g.pre[a];

export function lineEnds(g, starts) { return starts.map((s, k) => (k + 1 < starts.length ? starts[k + 1] : g.M)); }
export function fillsOf(g, starts) { const e = lineEnds(g, starts); return starts.map((s, k) => fill(g, s, e[k])); }

/** Greedy breaks at cap S: a line breaks before an atom that would push it
 *  past S, unless the line is still empty (an over-wide atom sits alone). */
export function greedyStarts(g, S) {
  const st = [0]; let f = g.sigs[0];
  for (let k = 0; k < g.M; k++) {
    const w = g.ws[k];
    if (f + w > S && k > st[st.length - 1]) { st.push(k); f = g.sigs[k] + w; } else f += w;
  }
  return st;
}

/* ── reach-back curve ──────────────────────────────────────────────────── */

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
