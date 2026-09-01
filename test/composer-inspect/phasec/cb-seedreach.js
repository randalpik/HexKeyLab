// Does the MEASURE you edit inside a line change how many SYSTEMS get replaced?
//
// The splice replaces whole systems, but the set of systems is derived from a
// MEASURE-level closure of the changed measures, rounded to lines:
//     [rLo,rHi] = expandForSpannersOnce(changedRun.lo, changedRun.hi)
//     a = lineOf(rLo), b = lineOf(rHi)
// so where in the line the edit lands decides whether that closure crosses a
// line boundary. This probe seeds the closure at EVERY measure individually and
// reports how often it reaches into the previous/next line, split by the
// measure's position within its line. Read-only, no renders.
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
const n = meas.length;
const ver = model.docVersion();
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

const buckets = { first: [], middle: [], last: [], only: [] };
for (let mi = 0; mi < n; mi++) {
  const li = lineOf(mi);
  const [s0, s1] = spansLine[li];
  const isFirst = mi === s0, isLast = mi === s1 - 1;
  const where = (isFirst && isLast) ? 'only' : isFirst ? 'first' : isLast ? 'last' : 'middle';
  let [lo, hi] = sp.expandForSpannersOnce(meas, mi, mi, ver);
  [lo, hi] = sp.expandForEndings(meas, lo, hi);
  buckets[where].push({
    measure: mi, line: li,
    back: lineOf(lo) < li,
    fwd: lineOf(hi) > li,
    systems: lineOf(hi) - lineOf(lo) + 1,
  });
}
const stat = (arr) => {
  if (!arr.length) return null;
  const back = arr.filter((x) => x.back).length;
  const fwd = arr.filter((x) => x.fwd).length;
  const sys = arr.map((x) => x.systems);
  const hist = sys.reduce((h, v) => { h[v] = (h[v] ?? 0) + 1; return h; }, {});
  return {
    n: arr.length,
    reachesPrevLine: back, pctBack: +(100 * back / arr.length).toFixed(1),
    reachesNextLine: fwd, pctFwd: +(100 * fwd / arr.length).toFixed(1),
    meanSystems: +(sys.reduce((a, b) => a + b, 0) / arr.length).toFixed(2),
    systemsHistogram: hist,
  };
};
out.byPositionInLine = {
  first: stat(buckets.first),
  middle: stat(buckets.middle),
  last: stat(buckets.last),
  only: stat(buckets.only),
};
return out;
