// Baseline of the WINDOW WALK: how many lines does each system drag in, and why?
//
// `window too many lines` is the biggest single splice refusal on the sonata
// (cb-sweep.js: 12 of 50), and it fires even for runs that replace ONE line.
// Max's hypothesis: the window keeps growing because each newly-added CONTEXT
// line brings its own spanners, which drag in the next line, and so on — a slur
// at the far end of an untouched context line is irrelevant to the lines being
// re-rendered, but the loop cannot tell.
//
// There are two stacked amplifiers to separate:
//   1. expandForSpanners is ALREADY a transitive closure at the MEASURE level
//      (its inner guard loop re-scans every span against the grown range), so a
//      chain of overlapping spanners closes within one call;
//   2. trySplice then ROUNDS OUT TO LINE BOUNDARIES and re-expands, so rounding
//      adds measures nobody asked for whose spanners feed the next iteration.
//
// This probe replays the real algorithm per line (read-only — no edits) and
// compares it against:
//   - CLOSURE:  what the replaced region's own spanners genuinely require;
//   - PROPOSED: that, plus ONE context line each side, no iteration (Max's rule).
// It also reports the largest connected spanner component anywhere in the
// document, which answers "is anything actually 9 lines long?" directly.
const H = window.__hkl_composer;
const model = H.model, r = H.renderer;
const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 120000, step = 100) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const out = {};
out.adopted = await waitFor(() => pb['startIds'] !== null);
if (!out.adopted) return out;
await waitFor(() => { const b = document.getElementById('renderBusy'); return !b || b.hidden; }, 60000, 40);

const sp = await import('/composer/src/render/splice.ts');
const meas = model.allMeasures();
const ver = model.docVersion();
const ids = meas.map((m) => m.getAttribute('xml:id'));
const idIdx = new Map(ids.map((id, i) => [id, i]));
const sids = pb['startIds'];
const nLines = sids.length;
const spans = [];
for (let li = 0; li < nLines; li++) {
  const a0 = idIdx.get(sids[li]);
  spans.push([a0, li + 1 < nLines ? idIdx.get(sids[li + 1]) : ids.length]);
}
const lineOf = (mi) => {
  let lo = 0, hi = nLines - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (spans[mid][0] <= mi) lo = mid; else hi = mid - 1; }
  return lo;
};
const expand = (lo, hi) => {
  let [a, b] = sp.expandForSpanners(meas, lo, hi, ver);
  [a, b] = sp.expandForEndings(meas, a, b);
  return [a, b];
};

/* ── 1. How long is the longest spanner chain anywhere? ── */
const perMeasureLines = [];
for (let mi = 0; mi < meas.length; mi++) {
  const [a, b] = expand(mi, mi);
  perMeasureLines.push(lineOf(b) - lineOf(a) + 1);
}
out.spannerComponent = {
  maxLines: Math.max(...perMeasureLines),
  histogram: perMeasureLines.reduce((h, v) => { h[v] = (h[v] ?? 0) + 1; return h; }, {}),
  worstMeasures: perMeasureLines
    .map((v, i) => ({ measure: i, lines: v }))
    .sort((a, b) => b.lines - a.lines).slice(0, 8),
};

/* ── 2. Replay the real walk for a single-line edit on every line ── */
const MAX_WINDOW_LINES = 9;
const rows = [];
for (let li = 1; li < nLines; li++) {
  /* CLOSURE: what the replaced line itself genuinely needs (this is also how
     trySplice picks the replaced set L). */
  const [cLo, cHi] = expand(spans[li][0], spans[li][1] - 1);
  const rLo = lineOf(cLo), rHi = lineOf(cHi);

  /* CURRENT: window = L±1, then iterate expand + round-to-line until fixed. */
  let wLo = Math.max(0, rLo - 1), wHi = Math.min(nLines - 1, rHi + 1);
  const trace = [[wLo, wHi]];
  let iters = 0;
  for (let guard = 0; guard < 8; guard++) {
    const [lo2, hi2] = expand(spans[wLo][0], spans[wHi][1] - 1);
    const nLo = lineOf(lo2), nHi = lineOf(hi2);
    if (nLo === wLo && nHi === wHi) break;
    wLo = nLo; wHi = nHi; iters++;
    trace.push([wLo, wHi]);
  }
  /* PROPOSED: the closure's lines, plus one context line each side. Stop. */
  const pLo = Math.max(0, rLo - 1), pHi = Math.min(nLines - 1, rHi + 1);
  rows.push({
    line: li,
    replacedLines: rHi - rLo + 1,
    current: wHi - wLo + 1,
    proposed: pHi - pLo + 1,
    iters,
    trace: iters ? trace.map(([a, b]) => b - a + 1) : undefined,
  });
}
out.rows = rows;
const hist = (key) => rows.reduce((h, x) => { h[x[key]] = (h[x[key]] ?? 0) + 1; return h; }, {});
const over = (key) => rows.filter((x) => x[key] > MAX_WINDOW_LINES).length;
out.summary = {
  lines: nLines,
  cap: MAX_WINDOW_LINES,
  replacedLines: hist('replacedLines'),
  currentWindow: hist('current'),
  proposedWindow: hist('proposed'),
  overCapCurrent: over('current'),
  overCapProposed: over('proposed'),
  iterated: rows.filter((x) => x.iters > 0).length,
  maxCurrent: Math.max(...rows.map((x) => x.current)),
  maxProposed: Math.max(...rows.map((x) => x.proposed)),
  meanCurrent: +(rows.reduce((a, x) => a + x.current, 0) / rows.length).toFixed(2),
  meanProposed: +(rows.reduce((a, x) => a + x.proposed, 0) / rows.length).toFixed(2),
  worst: rows.slice().sort((a, b) => b.current - a.current).slice(0, 10)
    .map((x) => ({ line: x.line, replaced: x.replacedLines, current: x.current, proposed: x.proposed, iters: x.iters, trace: x.trace })),
};
return out;
