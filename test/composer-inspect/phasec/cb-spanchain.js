// WHY does a line's spanner closure reach 5-6 lines when no single spanner is
// longer than 2?
//
// expandForSpanners requires every spanner OVERLAPPING the current range to be
// contained WHOLE, and re-scans after each growth — so it is a transitive
// closure at the MEASURE level. Overlapping slurs chain: slur A pulls the range
// left, which now overlaps slur B, which pulls it further, and so on. This
// probe rebuilds the same extents the splicer uses (buildSpannerExtents in
// render/splice.ts) but keeps each span's ELEMENT identity, then replays the
// closure step by step and attributes every growth to the element that caused
// it. Read-only.
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

const SPANNER_NAMES = new Set(['slur','tie','hairpin','phrase','gliss','bracketSpan','octave','lv','dynam','dir','trill','pedal']);
const meas = model.allMeasures();
const n = meas.length;
const sids = pb['startIds'];
const nLines = sids.length;
const ids = meas.map((m) => m.getAttribute('xml:id'));
const idIdx = new Map(ids.map((id, i) => [id, i]));
const spansLine = [];
for (let li = 0; li < nLines; li++) {
  spansLine.push([idIdx.get(sids[li]), li + 1 < nLines ? idIdx.get(sids[li + 1]) : n]);
}
const lineOf = (mi) => {
  let lo = 0, hi = nLines - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (spansLine[mid][0] <= mi) lo = mid; else hi = mid - 1; }
  return lo;
};

/* ── rebuild the extents, keeping element identity ── */
const noteMeasure = new Map();
const pending = [];
const tieT = new Array(n).fill(false), tieI = new Array(n).fill(false);
for (let i = 0; i < n; i++) {
  for (const el of meas[i].querySelectorAll('*')) {
    const ln = el.localName;
    if (SPANNER_NAMES.has(ln)) { pending.push([el, i]); continue; }
    if (ln === 'note' || ln === 'chord' || ln === 'rest') {
      const id = el.getAttribute('xml:id') || el.getAttribute('id');
      if (id) noteMeasure.set(id, i);
      if (ln === 'note') {
        const t = el.getAttribute('tie');
        if (t) { if (t.includes('t')) tieT[i] = true; if (t.includes('i')) tieI[i] = true; }
      }
    }
  }
}
const refMeasure = (ref) => {
  if (!ref) return null;
  const id = ref.startsWith('#') ? ref.slice(1) : ref;
  return noteMeasure.has(id) ? noteMeasure.get(id) : null;
};
const spans = [];
for (const [sp, mIdx] of pending) {
  const a = refMeasure(sp.getAttribute('startid'));
  const b = refMeasure(sp.getAttribute('endid'));
  const ends = [a, b].filter((x) => x != null);
  const t2 = sp.getAttribute('tstamp2');
  const t2m = t2 ? /^([0-9]+)m\+/.exec(t2) : null;
  if (t2m && Number(t2m[1]) > 0) ends.push(mIdx, mIdx + Number(t2m[1]));
  if (!ends.length) continue;
  spans.push({
    name: sp.localName, id: sp.getAttribute('xml:id') || '',
    lo: Math.max(0, Math.min(...ends)), hi: Math.min(n - 1, Math.max(...ends)),
  });
}
for (const s of spans) { s.lineLo = lineOf(s.lo); s.lineHi = lineOf(s.hi); s.lines = s.lineHi - s.lineLo + 1; }

/* ── how long is any INDIVIDUAL spanner? ── */
const byName = {};
for (const s of spans) {
  byName[s.name] = byName[s.name] ?? { n: 0, maxMeasures: 0, maxLines: 0, crossing: 0 };
  const e = byName[s.name];
  e.n++;
  e.maxMeasures = Math.max(e.maxMeasures, s.hi - s.lo + 1);
  e.maxLines = Math.max(e.maxLines, s.lines);
  if (s.lines > 1) e.crossing++;
}
out.spanners = {
  total: spans.length,
  maxLinesAnySingleSpanner: Math.max(...spans.map((s) => s.lines)),
  lineSpanHistogram: spans.reduce((h, s) => { h[s.lines] = (h[s.lines] ?? 0) + 1; return h; }, {}),
  byName,
  tieEdges: { terminus: tieT.filter(Boolean).length, initial: tieI.filter(Boolean).length },
};

/* ── replay the closure with attribution ── */
function closureTrace(lo, hi) {
  const steps = [];
  for (let guard = 0; guard < n; guard++) {
    let grew = false;
    for (const s of spans) {
      if (s.hi >= lo && s.lo <= hi) {
        if (s.lo < lo) { steps.push({ by: s.name + '#' + s.id, span: [s.lo, s.hi], dir: 'left', range: [lo, hi], to: s.lo }); lo = s.lo; grew = true; }
        if (s.hi > hi) { steps.push({ by: s.name + '#' + s.id, span: [s.lo, s.hi], dir: 'right', range: [lo, hi], to: s.hi }); hi = s.hi; grew = true; }
      }
    }
    if (lo > 0 && tieT[lo]) { steps.push({ by: '@tie terminus', dir: 'left', range: [lo, hi], to: lo - 1 }); lo--; grew = true; }
    if (hi < n - 1 && tieI[hi]) { steps.push({ by: '@tie initial', dir: 'right', range: [lo, hi], to: hi + 1 }); hi++; grew = true; }
    if (!grew) break;
  }
  return { lo, hi, steps };
}
/* ONE PASS only: contain the spanners that overlap the SEED, and stop. */
function onePass(lo, hi) {
  let a = lo, b = hi;
  for (const s of spans) {
    if (s.hi >= lo && s.lo <= hi) { if (s.lo < a) a = s.lo; if (s.hi > b) b = s.hi; }
  }
  if (lo > 0 && tieT[lo]) a = Math.min(a, lo - 1);
  if (hi < n - 1 && tieI[hi]) b = Math.max(b, hi + 1);
  return [a, b];
}

const HOT = [62, 63, 65, 66, 70, 71];
out.hot = HOT.map((li) => {
  const seedLo = spansLine[li][0], seedHi = spansLine[li][1] - 1;
  const full = closureTrace(seedLo, seedHi);
  const [oLo, oHi] = onePass(seedLo, seedHi);
  return {
    line: li, measures: [seedLo, seedHi],
    closureMeasures: [full.lo, full.hi],
    closureLines: lineOf(full.hi) - lineOf(full.lo) + 1,
    onePassLines: lineOf(oHi) - lineOf(oLo) + 1,
    growthSteps: full.steps.length,
    chain: full.steps.map((s) => s.by + ' ' + s.dir + ' ' + JSON.stringify(s.span ?? null) + ' →' + s.to),
  };
});

/* ── document-wide: transitive closure vs one pass, per line ── */
const cmp = [];
for (let li = 0; li < nLines; li++) {
  const seedLo = spansLine[li][0], seedHi = spansLine[li][1] - 1;
  const f = closureTrace(seedLo, seedHi);
  const [oLo, oHi] = onePass(seedLo, seedHi);
  cmp.push({
    line: li,
    transitive: lineOf(f.hi) - lineOf(f.lo) + 1,
    onePass: lineOf(oHi) - lineOf(oLo) + 1,
  });
}
/* ── THE RULE, measured: any spanner with one end inside the replaced set
      needs the window to cover its other end. Two single containment passes,
      no fixed point:
        L      = onePass(changed measures)            → lines
        window = onePass(L's measures) → lines, ±1 context line
      Seeded per MEASURE (what a real one-note edit does), and per LINE (the
      worst case, an edit touching every measure of a line). ── */
const CAP_SPLICE = 5, CAP_WINDOW = 9;
const twoPass = (seedLo, seedHi) => {
  const [lLo, lHi] = onePass(seedLo, seedHi);
  const rLo = lineOf(lLo), rHi = lineOf(lHi);
  const [wLo0, wHi0] = onePass(spansLine[rLo][0], spansLine[rHi][1] - 1);
  const wLo = Math.max(0, lineOf(wLo0) - 1), wHi = Math.min(nLines - 1, lineOf(wHi0) + 1);
  return { replaced: rHi - rLo + 1, window: wHi - wLo + 1 };
};
const current = (seedLo, seedHi) => {
  const f = closureTrace(seedLo, seedHi);
  const rLo = lineOf(f.lo), rHi = lineOf(f.hi);
  let wLo = Math.max(0, rLo - 1), wHi = Math.min(nLines - 1, rHi + 1);
  for (let g = 0; g < 8; g++) {
    const t = closureTrace(spansLine[wLo][0], spansLine[wHi][1] - 1);
    const nLo = lineOf(t.lo), nHi = lineOf(t.hi);
    if (nLo === wLo && nHi === wHi) break;
    wLo = nLo; wHi = nHi;
  }
  return { replaced: rHi - rLo + 1, window: wHi - wLo + 1 };
};
const tally = (seeds) => {
  const cur = [], prop = [];
  for (const [a, b] of seeds) { cur.push(current(a, b)); prop.push(twoPass(a, b)); }
  const hh = (arr, k) => arr.reduce((acc, x) => { acc[x[k]] = (acc[x[k]] ?? 0) + 1; return acc; }, {});
  const mx = (arr, k) => Math.max(...arr.map((x) => x[k]));
  const mean = (arr, k) => +(arr.reduce((s, x) => s + x[k], 0) / arr.length).toFixed(2);
  return {
    n: seeds.length,
    replaced: { currentHist: hh(cur, 'replaced'), proposedHist: hh(prop, 'replaced'),
      currentMax: mx(cur, 'replaced'), proposedMax: mx(prop, 'replaced'),
      currentMean: mean(cur, 'replaced'), proposedMean: mean(prop, 'replaced'),
      overCapCurrent: cur.filter((x) => x.replaced > CAP_SPLICE).length,
      overCapProposed: prop.filter((x) => x.replaced > CAP_SPLICE).length },
    window: { currentHist: hh(cur, 'window'), proposedHist: hh(prop, 'window'),
      currentMax: mx(cur, 'window'), proposedMax: mx(prop, 'window'),
      currentMean: mean(cur, 'window'), proposedMean: mean(prop, 'window'),
      overCapCurrent: cur.filter((x) => x.window > CAP_WINDOW).length,
      overCapProposed: prop.filter((x) => x.window > CAP_WINDOW).length },
  };
};
out.perMeasureSeed = tally(Array.from({ length: n }, (_, i) => [i, i]));
out.perLineSeed = tally(spansLine.map(([a, b]) => [a, b - 1]));

const h = (k) => cmp.reduce((acc, x) => { acc[x[k]] = (acc[x[k]] ?? 0) + 1; return acc; }, {});
out.replacedSetComparison = {
  transitiveHistogram: h('transitive'),
  onePassHistogram: h('onePass'),
  maxTransitive: Math.max(...cmp.map((x) => x.transitive)),
  maxOnePass: Math.max(...cmp.map((x) => x.onePass)),
  meanTransitive: +(cmp.reduce((a, x) => a + x.transitive, 0) / cmp.length).toFixed(2),
  meanOnePass: +(cmp.reduce((a, x) => a + x.onePass, 0) / cmp.length).toFixed(2),
  overSpliceCap5transitive: cmp.filter((x) => x.transitive > 5).length,
  overSpliceCap5onePass: cmp.filter((x) => x.onePass > 5).length,
};
return out;
