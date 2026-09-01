// Every-measure splice sweep: is the outcome a function of the REPLACED SET?
//
// cb-sweep.js samples one mid-line measure per line, which is the easiest
// position (mean 1.01 systems replaced vs 1.47 at a line edge — cb-seedreach.js).
// Max's question: does splice refusal depend on anything beyond which lines end
// up in the replaced set? If it does not, a mid-line sweep plus the replaced-set
// algebra is a complete inventory and edge measures only re-derive adjacent
// lines. If it does, we need every measure.
//
// So: edit EVERY measure that has deletable content, record (replacedSet,
// outcome, reason), and check whether rows sharing a replaced set agree.
// Scrolling/mounting is done once per LINE; each edit is undone before the next.
// Args: --arg "stride=1,limit=0,from=0"
const H = window.__hkl_composer;
const r = H.renderer, model = H.model, reRender = H.reRender;
const pb = r['pageBreaks'];
const ps = r['pageSplicer'];
const container = document.getElementById('score');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
const waitFor = async (fn, ms = 60000, step = 40) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const errs = []; const oe = console.error; console.error = (...a) => { errs.push(a.join(' ').slice(0, 160)); oe(...a); };
const args = {};
for (const kv of String(window.__probeArg ?? '').split(',')) {
  const [k, v] = kv.split('='); if (k) args[k.trim()] = (v ?? '1').trim();
}
const STRIDE = Math.max(1, Number(args.stride ?? 1));
const LIMIT = Number(args.limit ?? 0) || Infinity;
const FROM = Number(args.from ?? 0);

const out = { errs, rows: [] };
out.adopted = await waitFor(() => pb['startIds'] !== null, 120000, 200);
if (!out.adopted) { console.error = oe; return out; }
await waitFor(badgeHidden, 60000, 40);

const sids = pb['startIds'];
const nLines = sids.length;
const ids0 = () => model.allMeasures().map((x) => x.getAttribute('xml:id'));
const idsInit = ids0();
const spans = [];
for (let li = 0; li < nLines; li++) {
  spans.push([idsInit.indexOf(sids[li]), li + 1 < nLines ? idsInit.indexOf(sids[li + 1]) : idsInit.length]);
}
const lineOf = (mi) => { let lo = 0, hi = nLines - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (spans[mid][0] <= mi) lo = mid; else hi = mid - 1; } return lo; };
const pageStartLines = pb.pageStarts().map((id) => sids.indexOf(id)).filter((i) => i >= 0).sort((a, b) => a - b);
const pageOfLine = (li) => { let p = 1; for (let i = 0; i < pageStartLines.length; i++) if (pageStartLines[i] <= li) p = i + 1; return p; };

const scrollToPage = async (p) => {
  const div = container.querySelector('.score-page[data-page="' + p + '"]');
  if (!div) return false;
  container.scrollTop = Math.max(0, div.offsetTop - 40);
  await raf();
  await waitFor(() => !div.classList.contains('score-page-pending'), 8000, 40);
  return true;
};
/* First note/chord inside measure `mi`, in whichever voice has one. */
const targetIn = (mi) => {
  const measures = model.allMeasures();
  const meas = measures[mi];
  if (!meas) return null;
  for (const voice of [1, 2, 3, 4]) {
    let flat; try { flat = model['flatChildren'](voice); } catch { continue; }
    for (let i = 0; i < flat.length; i++) {
      const el = flat[i];
      if ((el.localName === 'note' || el.localName === 'chord') && el.closest('measure') === meas) {
        return { voice, cursor: i };
      }
    }
  }
  return null;
};

let lastPage = -1, done = 0;
const total = idsInit.length;
for (let mi = FROM; mi < total && done < LIMIT; mi += STRIDE) {
  const li = lineOf(mi);
  const page = pageOfLine(li);
  if (page !== lastPage) { await scrollToPage(page); lastPage = page; }
  const t = targetIn(mi);
  const [s0, s1] = spans[li];
  const where = (mi === s0 && mi === s1 - 1) ? 'only' : mi === s0 ? 'first' : mi === s1 - 1 ? 'last' : 'middle';
  if (!t) { out.rows.push({ measure: mi, line: li, where, skip: 'no note/chord' }); done++; continue; }

  const snap = model.snapshotState();
  model.setCursor(t.cursor, t.voice);
  r.scheduleMountWindow(mi);
  await waitFor(() => r['mountWindowHandle'] === null, 3000, 20);
  const ver0 = model.docVersion();
  const t0 = performance.now();
  model.deleteAtCursor();
  reRender();
  await waitFor(badgeHidden, 60000, 30);
  const row = {
    measure: mi, line: li, where, voice: t.voice,
    changed: model.docVersion() !== ver0,
    wallMs: Math.round(performance.now() - t0),
    outcome: ps.lastOutcome, reason: ps.lastSkipReason,
    run: ps.lastRun ? [ps.lastRun.a, ps.lastRun.b] : null,
    winLines: ps.lastStats ? ps.lastStats.windowLines : null,
    refill: pb.lastRefillLines,
  };
  out.rows.push(row);
  model.restoreSnapshot(snap);
  reRender();
  await waitFor(badgeHidden, 60000, 30);
  done++;
}

/* ── analysis ── */
const rows = out.rows.filter((x) => x.outcome && x.changed);
const key = (x) => (x.run ? x.run[0] + '-' + x.run[1] : 'none');
const groups = new Map();
for (const x of rows) {
  const k = key(x);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(x);
}
/* Does a given replaced set always produce the same verdict? */
const conflicts = [];
for (const [k, g] of groups) {
  const verdicts = new Set(g.map((x) => (x.outcome === 'spliced' ? 'spliced' : 'refused:' + x.reason)));
  if (verdicts.size > 1) {
    conflicts.push({ replacedSet: k, n: g.length, verdicts: [...verdicts],
      members: g.map((x) => ({ measure: x.measure, where: x.where, voice: x.voice, outcome: x.outcome, reason: x.reason })) });
  }
}
const byWhere = (w) => rows.filter((x) => x.where === w);
const rate = (a) => a.length ? +(a.filter((x) => x.outcome === 'spliced').length / a.length).toFixed(3) : null;
/* Which replaced sets would a MID-LINE-ONLY sweep never produce? */
const midKeys = new Set(byWhere('middle').map(key));
const edgeOnly = [...groups.keys()].filter((k) => !midKeys.has(k));
out.analysis = {
  measuresEdited: rows.length,
  skipped: out.rows.filter((x) => x.skip).length,
  unchanged: out.rows.filter((x) => x.outcome && !x.changed).length,
  hitRate: rate(rows),
  byPosition: { first: { n: byWhere('first').length, rate: rate(byWhere('first')) },
    middle: { n: byWhere('middle').length, rate: rate(byWhere('middle')) },
    last: { n: byWhere('last').length, rate: rate(byWhere('last')) },
    only: { n: byWhere('only').length, rate: rate(byWhere('only')) } },
  distinctReplacedSets: groups.size,
  replacedSetsUnreachableFromMidLine: edgeOnly.length,
  /* THE question: same replaced set, different verdict? */
  conflictingReplacedSets: conflicts.length,
  conflicts: conflicts.slice(0, 12),
  reasonHistogram: rows.reduce((h, x) => { const k = x.outcome === 'spliced' ? 'spliced' : x.reason; h[k] = (h[k] ?? 0) + 1; return h; }, {}),
  reasonsOnlySeenAtEdges: (() => {
    const mid = new Set(byWhere('middle').map((x) => (x.outcome === 'spliced' ? 'spliced' : x.reason)));
    const edge = rows.filter((x) => x.where !== 'middle');
    return [...new Set(edge.filter((x) => x.outcome !== 'spliced' && !mid.has(x.reason)).map((x) => x.reason))];
  })(),
};
console.error = oe;
return out;
