// Probe 8: Phase C-A gate battery on the sonata.
//  0) enablement parity: natural pins + breaks:'line' vs today's smartSb0 —
//     per-measure x/width delta (item 1b analog; expect ~rounding only)
//  1) edit battery: for each edit — refill path used? rendered == pins?
//     untouched lines' measures keep IDENTICAL x/width (the A visual gate)?
//     cascade length, wall time.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model, reRender = H.reRender;
const pb = r['pageBreaks'];
const V = window.verovio;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 60000, step = 80) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const errs = [];
const oe = console.error; console.error = (...a) => { errs.push(a.join(' ').slice(0, 200)); oe(...a); };

const out = { errs };
out.adopted = await waitFor(() => pb['startIds'] !== null, 40000, 200);
if (!out.adopted) return out;

/* ── 0) enablement parity: pins+'line' vs smartSb0, offscreen ── */
{
  const mei = model.serialize({ hejiEnabled: model.getHejiEnabled() }, null);
  const optsSmart = r['buildOptions']('smartSb0');
  const optsLine = { ...r['buildOptions']('auto'), breaks: 'line' };
  const lb = await import('/composer/src/render/linebreaks.ts');
  const pinned = lb.injectPins(mei, pb['startIds'], null);
  const geom = (tk, pagesToCheck) => {
    const m = new Map();
    for (const p of pagesToCheck) {
      if (p > tk.getPageCount()) continue;
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:-99999px;top:0';
      host.innerHTML = tk.renderToSVG(p, {});
      document.body.appendChild(host);
      for (const el of host.querySelectorAll('g.measure')) {
        const b = el.getBBox();
        m.set(el.id, { x: b.x, w: b.width });
      }
      host.remove();
    }
    return m;
  };
  const tkS = new V.toolkit(); tkS.setOptions(optsSmart); tkS.loadData(mei);
  const tkL = new V.toolkit(); tkL.setOptions(optsLine); tkL.loadData(pinned);
  const pages = [1, 5, 12, 20, 30];
  const gs = geom(tkS, pages), gl = geom(tkL, pages);
  let maxDx = 0, maxDw = 0, compared = 0;
  for (const [id, a] of gs) {
    const b = gl.get(id);
    if (!b) continue;
    compared++;
    maxDx = Math.max(maxDx, Math.abs(a.x - b.x));
    maxDw = Math.max(maxDw, Math.abs(a.w - b.w));
  }
  out.enablement = {
    pagesEqual: tkS.getPageCount() === tkL.getPageCount(),
    compared, maxDx: +maxDx.toFixed(1), maxDw: +maxDw.toFixed(1),
  };
}

/* ── helpers for the edit battery ── */
const mountPages = async (upTo) => {
  for (const page of Array.from(document.querySelectorAll('#score .score-page'))) {
    if (+page.dataset.page > upTo) break;
    page.scrollIntoView();
    await sleep(40);
  }
  document.getElementById('score').scrollTop = 0;
  await sleep(200);
};
const liveGeom = () => {
  const m = new Map();
  for (const el of document.querySelectorAll('#score .score-page:not(.score-page-pending) g.measure')) {
    const b = el.getBBox();
    m.set(el.id, { x: +b.x.toFixed(2), w: +b.width.toFixed(2) });
  }
  return m;
};
const renderedPinCheck = () => {
  const pos = new Map(pb['startIds'].map((id, i) => [id, i]));
  let prevEnd = -1;
  for (const page of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
    const starts = [];
    for (const sys of page.querySelectorAll('g.system')) {
      const m = sys.querySelector('g.measure');
      if (m && m.id) starts.push(m.id);
    }
    if (!starts.length) continue;
    const at = pos.get(starts[0]);
    if (at == null || at <= prevEnd) return false;
    for (let i = 1; i < starts.length; i++) if (pos.get(starts[i]) !== at + i) return false;
    prevEnd = at + starts.length - 1;
  }
  return true;
};
const lineRangeOf = (startIds, ids, idIdx) => {
  // measure-index span per line index
  const spans = [];
  for (let li = 0; li < startIds.length; li++) {
    const a = idIdx.get(startIds[li]);
    const b = li + 1 < startIds.length ? idIdx.get(startIds[li + 1]) : ids.length;
    spans.push([a, b]);
  }
  return spans;
};

const battery = [];
const runEdit = async (name, editFn) => {
  const entry = { name };
  const before = pb['startIds'].slice();
  const idsB = model.allMeasures().map((m) => m.getAttribute('xml:id'));
  await mountPages(37);
  const geomB = liveGeom();
  const t0 = performance.now();
  const okEdit = editFn();
  reRender();
  await waitFor(() => badgeHidden() && r['pendingDirty'] === 'none', 40000, 50);
  entry.wallMs = Math.round(performance.now() - t0);
  entry.editOk = okEdit !== false && okEdit !== null;
  entry.refillLines = pb.lastRefillLines;
  entry.derive = pb['adoption'] !== null;   // derive re-arms idle adoption
  if (entry.derive) await waitFor(() => pb['startIds'] !== null, 40000, 200);
  const after = pb['startIds'].slice();
  // changed line-start ids (set diff, order-aware alignment is overkill here)
  const bs = new Set(before), as = new Set(after);
  entry.startsAdded = after.filter((id) => !bs.has(id)).length;
  entry.startsRemoved = before.filter((id) => !as.has(id)).length;
  entry.renderedMatchesPins = renderedPinCheck();
  // untouched-line stability: measures of lines whose (start id, member span)
  // survived unchanged must keep identical x/w
  await mountPages(37);
  const geomA = liveGeom();
  const ids = model.allMeasures().map((m) => m.getAttribute('xml:id'));
  const idIdx = new Map(ids.map((id, i) => [id, i]));
  const idIdxB = new Map(idsB.map((id, i) => [id, i]));
  const spansA = lineRangeOf(after, ids, idIdx);
  const spansB = lineRangeOf(before.filter((id) => idIdxB.has(id)), idsB, idIdxB);
  const lineByStartB = new Map(before.map((id, i) => [id, i]));
  let maxDx = 0, maxDw = 0, cmp = 0;
  for (let li = 0; li < after.length; li++) {
    const bi = lineByStartB.get(after[li]);
    if (bi == null) continue;
    const [a0, a1] = spansA[li];
    const [b0, b1] = spansB[bi] ?? [];
    if (a0 == null || b0 == null) continue;
    const memA = ids.slice(a0, a1).join();
    const memB = idsB.slice(b0, b1).join();
    if (memA !== memB) continue;   // line content changed → excluded
    for (const id of ids.slice(a0, a1)) {
      const ga = geomA.get(id), gb = geomB.get(id);
      if (!ga || !gb) continue;
      cmp++;
      maxDx = Math.max(maxDx, Math.abs(ga.x - gb.x));
      maxDw = Math.max(maxDw, Math.abs(ga.w - gb.w));
    }
  }
  entry.untouchedCompared = cmp;
  entry.untouchedMaxDx = +maxDx.toFixed(2);
  entry.untouchedMaxDw = +maxDw.toFixed(2);
  battery.push(entry);
};

const curAt = (mi) => { model.setCursor(model.getMeasureStartCursor(1, mi), 1); };

// endings + key-change landmarks
const ids0 = model.allMeasures().map((m) => m.getAttribute('xml:id'));
const endingMi = (() => {
  const e = model.getDoc().querySelector('ending measure');
  return e ? ids0.indexOf(e.getAttribute('xml:id')) : -1;
})();

// 1: delete mid-line (measure 100 middle)
await runEdit('delete-mid-line', () => { curAt(100); return model.deleteAtCursor(); });
// 2: delete at a line start (line 30's start measure)
await runEdit('delete-line-start', () => {
  const mi = ids0.indexOf(pb['startIds'][30]);
  curAt(mi >= 0 ? mi : 120);
  return model.deleteAtCursor();
});
// 3: widen a measure (insert a rest → overflow ripple)
await runEdit('insert-rest-overflow', () => { curAt(150); return model.insertRestAtCursor({ duration: '8', dots: 0 }); });
// 4: edit inside the volta line
await runEdit('edit-near-volta', () => { curAt(Math.max(0, endingMi - 1)); return model.deleteAtCursor(); });
// 5: edit right before the first section break (region-final line)
await runEdit('edit-region-end', () => {
  // first hard start = first measure preceded by a section sb
  const sec = model.getDoc().querySelectorAll('section > sb');
  let mi = 200;
  if (sec.length) {
    const nm = sec[0].nextElementSibling;
    const id = nm && nm.localName === 'measure' ? nm.getAttribute('xml:id') : null;
    const k = id ? model.allMeasures().map((m) => m.getAttribute('xml:id')).indexOf(id) : -1;
    if (k > 1) mi = k - 2;
  }
  curAt(mi);
  return model.deleteAtCursor();
});
// 6: edit near doc end
await runEdit('edit-doc-end', () => { curAt(model.allMeasures().length - 3); return model.deleteAtCursor(); });

out.battery = battery;
console.error = oe;
return out;
