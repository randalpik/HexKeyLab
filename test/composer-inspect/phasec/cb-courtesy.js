// B3: why does a CONTEXT line diverge from live by a width-only delta?
//
// The sweep's 11 `context line ... diverged` refusals all report dRelX=0.0 with
// dW 43-347 units, and ALL have refillLines 0 — no boundary moved, so this is
// not the design doc's framing ("a boundary moving next to a clef/key change").
//
// Hypothesis: Verovio draws an end-of-line COURTESY signature when the NEXT
// line begins with a clef/key/meter change. The splice window is a
// sub-document; the line beyond its last context line is not in it, so the
// courtesy is not generated and that line's final measure renders narrower than
// live. Same at the top edge for the first context line.
//
// This probe replays the real window rule per line (read-only) and asks, for
// each: does a signature change begin the line just BEYOND the window? Then it
// correlates with the observed divergences.
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

/* What begins a signature change at measure index i?
   - a section-level <scoreDef> immediately before it, or
   - a <clef>/<keySig>/<meterSig> inside its first staff (a mid-piece change). */
const sigAt = new Array(n).fill(null);
for (let i = 0; i < n; i++) {
  const m = meas[i];
  let top = m;
  while (top.parentElement && top.parentElement.localName !== 'section') top = top.parentElement;
  const prev = top.previousElementSibling;
  const kinds = [];
  if (prev && prev.localName === 'scoreDef') {
    for (const k of ['keySig', 'clef', 'meterSig']) {
      if (prev.querySelector(k) || prev.hasAttribute(k === 'keySig' ? 'key.sig' : k === 'clef' ? 'clef.shape' : 'meter.count')) kinds.push(k);
    }
    if (!kinds.length) kinds.push('scoreDef');
  }
  for (const k of ['clef', 'keySig', 'meterSig']) {
    if (m.querySelector(':scope > staff > ' + k) || m.querySelector(':scope > staff > layer > ' + k)) kinds.push('in-measure-' + k);
  }
  sigAt[i] = kinds.length ? kinds.join('+') : null;
}
out.sigChangeMeasures = sigAt.map((v, i) => v ? { measure: i, line: lineOf(i), what: v } : null).filter(Boolean);

/* Replay the window rule (one containment pass, ±1 context line). */
const expandOnce = (lo, hi) => {
  let [a, b] = sp.expandForSpannersOnce(meas, lo, hi, ver);
  [a, b] = sp.expandForEndings(meas, a, b);
  return [a, b];
};
const windowFor = (li) => {
  const [lLo, lHi] = expandOnce(spansLine[li][0], spansLine[li][1] - 1);
  const rLo = lineOf(lLo), rHi = lineOf(lHi);
  const [w0, w1] = expandOnce(spansLine[rLo][0], spansLine[rHi][1] - 1);
  return { a: rLo, b: rHi, wLo: Math.max(0, lineOf(w0) - 1), wHi: Math.min(nLines - 1, lineOf(w1) + 1) };
};

/* Lines the sweep observed diverging (this run's line numbers are stable —
   the partition is deterministic; only xml:ids are regenerated per import). */
const OBSERVED_BELOW = [24, 35, 38, 52, 54, 55, 82, 84, 94];
const OBSERVED_ABOVE = [60, 115];
const observed = new Set([...OBSERVED_BELOW, ...OBSERVED_ABOVE]);

const rows = [];
for (let li = 1; li < nLines; li++) {
  const w = windowFor(li);
  /* The line just beyond each window edge — the one whose leading signature
     change would make live draw a courtesy the window cannot know about. */
  const beyondBelow = w.wHi + 1 < nLines ? spansLine[w.wHi + 1][0] : null;
  const firstOfWindow = spansLine[w.wLo][0];
  rows.push({
    line: li, window: [w.wLo, w.wHi], replaced: [w.a, w.b],
    sigBeyondBelow: beyondBelow != null ? sigAt[beyondBelow] : null,
    sigAtWindowStart: sigAt[firstOfWindow],
    observedDiverge: observed.has(li),
  });
}
out.rows = rows;
const withSigBelow = rows.filter((x) => x.sigBeyondBelow);
const withSigStart = rows.filter((x) => x.sigAtWindowStart);
out.correlation = {
  observedDiverging: [...observed].length,
  linesWithSigJustBeyondWindow: withSigBelow.length,
  observedAndSigBeyond: withSigBelow.filter((x) => x.observedDiverge).length,
  observedButNoSigBeyond: rows.filter((x) => x.observedDiverge && !x.sigBeyondBelow && !x.sigAtWindowStart).length,
  sigBeyondButNotObserved: withSigBelow.filter((x) => !x.observedDiverge).map((x) => x.line),
  linesWithSigAtWindowStart: withSigStart.length,
  detailObserved: rows.filter((x) => x.observedDiverge)
    .map((x) => ({ line: x.line, window: x.window, sigBeyondBelow: x.sigBeyondBelow, sigAtWindowStart: x.sigAtWindowStart })),
};
return out;
