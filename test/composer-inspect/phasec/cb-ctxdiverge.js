// Root-causing `context line ... diverged` refusals: edit one seed line per
// requested line, and when the splicer refuses on a context line, dump
// EVERYTHING it recorded — the window it built (lines, measures, leader/trailer,
// courtesy extension), the full per-measure x/width diff of the diverged
// context line (`profilesMatch` only names the FIRST mismatch, which is where
// the drift became VISIBLE, not where it started), a glyph census of window vs
// live for every measure of that line, and the clef glyphs each render drew.
//
// It also checks the two things a sub-document can get wrong at its edges:
//   - the range's HEAD scoreDef (key/meter/per-staff clef) against the state
//     the full render has at the start of the window's first line, including
//     that measure's own leading clef (which `relocateInitialClefs(_, true)`
//     drops from the range);
//   - the measure just BEYOND the window: does a signature change begin there
//     (section-level scoreDef, possibly behind an <sb>, or a leading
//     clef/keySig/meterSig on ANY staff), i.e. would the live page draw an
//     end-of-line courtesy the window cannot know about?
//
//   --arg "seeds=54;55;57;59@241;77@326;115"   edit-seed LINES (one edit each);
//        `line@measure` pins the target measure (default: the line's first
//        middle measure — the replaced set, and so the context lines, depend
//        on which measure's spanners the edit touches)
// Every edit is undone via restoreSnapshot before the next. Also reports, per
// window, every range measure whose serialized MEI differs from the full
// serialize()'s (the range serializer must reproduce the full render measure
// for measure), and the raw window MEI of the diverged line's last measure.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model, reRender = H.reRender;
const pb = r['pageBreaks'];
const ps = r['pageSplicer'];
const container = document.getElementById('score');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
const waitFor = async (fn, ms = 90000, step = 50) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const args = {};
for (const kv of String(window.__probeArg ?? '').split(',')) {
  const [k, v] = kv.split('='); if (k) args[k.trim()] = v === undefined ? '1' : v.trim();
}
const SEEDS = String(args.seeds ?? '54;55;57;59;77;115').split(/[;|]/).filter(Boolean).map((t) => {
  const [l, m] = t.split('@'); return { line: Number(l), measure: m !== undefined ? Number(m) : null };
});

const out = { seeds: SEEDS, results: [] };
out.adopted = await waitFor(() => pb['startIds'] !== null, 120000, 200);
if (!out.adopted) return out;
await waitFor(badgeHidden, 90000, 40);

const heji = { hejiEnabled: model.getHejiEnabled() };
const sids = pb['startIds'];
const nLines = sids.length;
const meas = model.allMeasures();
const ids = meas.map((m) => m.getAttribute('xml:id'));
const idIdx = new Map(ids.map((id, i) => [id, i]));
const spans = sids.map((id, li) => [idIdx.get(id), li + 1 < nLines ? idIdx.get(sids[li + 1]) : ids.length]);
const psl = pb.pageStarts().map((id) => sids.indexOf(id)).filter((i) => i >= 0).sort((a, b) => a - b);
const pageOfLine = (li) => { let p = 1; for (let i = 0; i < psl.length; i++) if (psl[i] <= li) p = i + 1; return p; };

const scrollToPage = async (p) => {
  const div = container.querySelector('.score-page[data-page="' + p + '"]');
  if (!div) return false;
  container.scrollTop = Math.max(0, div.offsetTop - 40);
  await raf();
  await waitFor(() => !div.classList.contains('score-page-pending'), 15000, 40);
  await raf();
  return !div.classList.contains('score-page-pending');
};
/* Same target rule as cb-startzone.js: prefer a middle measure of the line. */
const findTarget = (LINE, pin) => {
  const ms = model.allMeasures();
  const [mi0, lineEnd] = spans[LINE];
  const order = [];
  if (pin !== null) order.push(pin);
  else { for (let k = mi0 + 1; k < lineEnd; k++) order.push(k); order.push(mi0); }
  const rank = new Map(order.map((k, i) => [ms[k], i]));
  let best = null;
  for (const voice of [1, 2, 3, 4]) {
    let flat; try { flat = model['flatChildren'](voice); } catch { continue; }
    for (let i = 0; i < flat.length; i++) {
      const el = flat[i];
      if (el.localName !== 'note' && el.localName !== 'chord') continue;
      const r0 = rank.get(el.closest('measure'));
      if (r0 === undefined) continue;
      if (!best || r0 < best.rank) best = { rank: r0, voice, cursor: i, measureIdx: ms.indexOf(el.closest('measure')) };
      if (best.rank === 0) break;
    }
  }
  return best;
};

/* ── structural helpers over the LIVE model ── */
const leadingSig = (m) => {
  const res = {};
  for (const st of Array.from(m.querySelectorAll(':scope > staff'))) {
    const s = [];
    const scan = (p) => { for (const c of Array.from(p.children)) {
      const ln = c.localName;
      if (ln === 'clef') s.push('clef:' + c.getAttribute('shape') + (c.getAttribute('line') ?? ''));
      else if (ln === 'keySig') s.push('keySig:' + (c.getAttribute('sig') ?? ''));
      else if (ln === 'meterSig') s.push('meterSig:' + c.getAttribute('count') + '/' + c.getAttribute('unit'));
      else if (ln === 'layer') { if (scan(c)) return true; }
      else if (['note', 'chord', 'rest', 'mRest', 'beam', 'tuplet', 'space', 'multiRest'].includes(ln)) return true;
    } return false; };
    scan(st);
    if (s.length) res[st.getAttribute('n')] = s;
  }
  return res;
};
const sdSummary = (sd) => {
  const a = {};
  for (const k of ['key.sig', 'meter.count', 'meter.unit', 'meter.sym']) if (sd.hasAttribute(k)) a[k] = sd.getAttribute(k);
  const clefs = {};
  for (const sdf of Array.from(sd.querySelectorAll('staffDef'))) {
    clefs[sdf.getAttribute('n')] = (sdf.getAttribute('clef.shape') ?? '?') + (sdf.getAttribute('clef.line') ?? '');
  }
  a.clefs = clefs;
  return a;
};
const beforeChain = (m) => {
  let top = m; while (top.parentElement && top.parentElement.localName !== 'section') top = top.parentElement;
  const chain = [];
  let p = top.previousElementSibling;
  while (p && p.localName !== 'measure' && !p.querySelector?.('measure') && chain.length < 5) {
    chain.unshift(p.localName === 'scoreDef' ? { scoreDef: sdSummary(p) } : p.localName + (p.getAttribute('data-hkl-section') ? '[section]' : ''));
    p = p.previousElementSibling;
  }
  return chain;
};
/* Effective key/meter/clef state at the START of measure `mi` in the FULL
   render — scoreDefs before it applied, and mi's OWN leading clefs applied too
   (a leading clef is drawn as the line-start clef when mi begins a line). */
const effectiveState = (mi) => {
  const section = meas[0].ownerDocument.querySelector('section');
  const head = meas[0].ownerDocument.querySelector('score > scoreDef');
  const st = { key: head?.getAttribute('key.sig') ?? null, meter: (head?.getAttribute('meter.count') ?? '?') + '/' + (head?.getAttribute('meter.unit') ?? '?'), clefs: {} };
  for (const sdf of Array.from(head?.querySelectorAll('staffDef') ?? [])) st.clefs[sdf.getAttribute('n')] = (sdf.getAttribute('clef.shape') ?? '?') + (sdf.getAttribute('clef.line') ?? '');
  const stream = [];
  for (const node of Array.from(section.children)) {
    if (node.localName !== 'measure' && node.localName !== 'scoreDef' && node.querySelector('measure')) stream.push(...Array.from(node.children));
    else stream.push(node);
  }
  const target = meas[mi];
  const applySd = (sd) => {
    if (sd.hasAttribute('key.sig')) st.key = sd.getAttribute('key.sig');
    if (sd.hasAttribute('meter.count')) st.meter = sd.getAttribute('meter.count') + '/' + sd.getAttribute('meter.unit');
    for (const sdf of Array.from(sd.querySelectorAll('staffDef'))) if (sdf.hasAttribute('clef.shape')) st.clefs[sdf.getAttribute('n')] = sdf.getAttribute('clef.shape') + (sdf.getAttribute('clef.line') ?? '');
  };
  for (const node of stream) {
    if (node.localName === 'scoreDef') { applySd(node); continue; }
    if (node.localName !== 'measure') continue;
    if (node === target) {
      /* only LEADING clefs of the target count as line-start state */
      const lead = leadingSig(node);
      for (const [sn, arr] of Object.entries(lead)) for (const x of arr) if (x.startsWith('clef:')) st.clefs[sn] = x.slice(5);
      break;
    }
    for (const staff of Array.from(node.querySelectorAll('staff'))) {
      const clefs = staff.querySelectorAll('layer > clef');
      const c = clefs[clefs.length - 1];
      if (c) st.clefs[staff.getAttribute('n')] = (c.getAttribute('shape') ?? 'G') + (c.getAttribute('line') ?? '2');
    }
  }
  return st;
};

const fullMeasureXml = () => {
  const full = new DOMParser().parseFromString(model.serialize(heji, null), 'application/xml');
  const map = new Map();
  const ser = new XMLSerializer();
  for (const m of Array.from(full.querySelectorAll('measure'))) map.set(m.getAttribute('xml:id'), ser.serializeToString(m));
  return map;
};
const firstDiff = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return { at: i, win: a.slice(Math.max(0, i - 80), i + 160), full: b.slice(Math.max(0, i - 80), i + 160) }; };

for (const seed of SEEDS) {
  const LINE = seed.line;
  const res = { line: LINE, pinnedMeasure: seed.measure ?? undefined, lineMeasures: spans[LINE] ? [spans[LINE][0], spans[LINE][1] - 1] : null, page: pageOfLine(LINE) };
  out.results.push(res);
  if (!(LINE >= 0 && LINE < nLines)) { res.error = 'no such line'; continue; }
  res.pageMounted = await scrollToPage(res.page);
  const target = findTarget(LINE, seed.measure);
  if (!target) { res.error = 'no note/chord on line'; continue; }
  res.target = { measureIdx: target.measureIdx, voice: target.voice };
  const snap = model.snapshotState();
  model.setCursor(target.cursor, target.voice);
  r.scheduleMountWindow(target.measureIdx);
  await waitFor(() => r['mountWindowHandle'] === null, 5000, 20);
  await raf();
  const ver0 = model.docVersion();
  const t0 = performance.now();
  model.deleteAtCursor();
  reRender();
  await waitFor(badgeHidden, 90000, 30);
  res.wallMs = Math.round(performance.now() - t0);
  res.editOk = model.docVersion() !== ver0;
  res.outcome = ps.lastOutcome;
  res.skipReason = ps.lastSkipReason;
  res.run = ps.lastRun;
  res.window = ps.lastWindow;
  const cd = ps.lastContextDiff;
  if (cd) {
    res.ctx = {
      side: cd.side, line: cd.line, lineMeasures: [spans[cd.line][0], spans[cd.line][1] - 1],
      rows: cd.rows.map((x) => ({
        id: x.id, dRelX: +(x.winRelX - x.liveRelX).toFixed(1), dW: +(x.winW - x.liveW).toFixed(1),
        winW: +x.winW.toFixed(1), liveW: +x.liveW.toFixed(1),
        census: Object.keys(x.census).length ? x.census : undefined,
        clefs: (x.clefs[0].join(' ') !== x.clefs[1].join(' ')) ? x.clefs : (x.clefs[0].length ? x.clefs[0].join(' ') : undefined),
      })),
      sumDW: +cd.rows.reduce((s, x) => s + (x.winW - x.liveW), 0).toFixed(1),
    };
  }
  /* ── edge checks on the window the splicer actually built (on the POST-edit
        model, which is what the window serialized) ── */
  const w = ps.lastWindow;
  if (w) {
    const measNow = model.allMeasures();
    const idsNow = measNow.map((m) => m.getAttribute('xml:id'));
    /* head of the range vs the full render's state at mLo */
    const rangeMei = model.serializeRangeForRender(w.mLo, w.mHi, heji, null);
    const rdoc = new DOMParser().parseFromString(rangeMei, 'application/xml');
    const rhead = rdoc.querySelector('scoreDef');
    const rfirst = rdoc.querySelector('measure');
    res.rangeHead = rhead ? sdSummary(rhead) : null;
    res.rangeFirstMeasure = { id: rfirst?.getAttribute('xml:id'), leading: rfirst ? leadingSig(rfirst) : null, before: rfirst ? beforeChain(rfirst) : null };
    res.liveAtMLo = { id: idsNow[w.mLo], leading: leadingSig(measNow[w.mLo]), before: beforeChain(measNow[w.mLo]) };
    /* effectiveState walks `meas` (pre-edit list) — indices are stable because
       a delete never removes a measure. */
    const eff = effectiveState(w.mLo);
    res.effectiveAtMLo = eff;
    const headClefs = res.rangeHead?.clefs ?? {};
    const clefMismatch = Object.entries(eff.clefs).filter(([sn, c]) => headClefs[sn] !== c).map(([sn, c]) => sn + ': head=' + headClefs[sn] + ' live=' + c);
    res.headClefMismatch = clefMismatch.length ? clefMismatch : undefined;
    /* the measure just beyond the window's last line */
    if (w.wHi + 1 < nLines) {
      const mb = spans[w.wHi + 1][0];
      res.beyondBelow = { measure: mb, id: idsNow[mb], before: beforeChain(measNow[mb]), leading: leadingSig(measNow[mb]) };
    }
    /* and the measure just before the window's first line */
    if (w.mLo > 0) {
      res.beforeAbove = { measure: w.mLo - 1, id: idsNow[w.mLo - 1], trailingClefs: (() => {
        const o = {}; for (const st of Array.from(measNow[w.mLo - 1].querySelectorAll(':scope > staff'))) {
          const c = st.querySelectorAll('layer > clef'); if (c.length) o[st.getAttribute('n')] = Array.from(c).map((x) => x.getAttribute('shape') + (x.getAttribute('line') ?? '')); }
        return Object.keys(o).length ? o : undefined; })() };
    }
    /* every range measure vs the full serialize() — must be identical */
    const fullMap = fullMeasureXml();
    const ser = new XMLSerializer();
    const diffs = [];
    for (const m of Array.from(rdoc.querySelectorAll('measure'))) {
      const id = m.getAttribute('xml:id');
      const a = ser.serializeToString(m), b = fullMap.get(id);
      if (b === undefined) { diffs.push({ id, note: 'not in full' }); continue; }
      if (a !== b) diffs.push({ id, idx: idsNow.indexOf(id), ...firstDiff(a, b) });
    }
    res.rangeVsFull = diffs.length ? diffs : 'identical';
    /* raw window MEI of the diverged context line's LAST measure + the one after */
    if (cd && ps.lastWindowMei) {
      const wdoc = new DOMParser().parseFromString(ps.lastWindowMei, 'application/xml');
      const lastId = cd.rows[cd.rows.length - 1].id;
      const el = Array.from(wdoc.querySelectorAll('measure')).find((m) => m.getAttribute('xml:id') === lastId);
      const strip = (x) => x ? ser.serializeToString(x).replace(/<note\b[^>]*\/>|<note\b[^>]*>[\s\S]*?<\/note>/g, '<note/>').replace(/<rest\b[^>]*\/>/g, '<rest/>').replace(/\s+/g, ' ').slice(0, 1800) : null;
      res.winMeiLastCtxMeasure = strip(el);
      let nx = el?.nextElementSibling; while (nx && nx.localName !== 'measure' && !nx.querySelector?.('measure')) nx = nx.nextElementSibling;
      res.winMeiBetween = el ? (() => { const arr = []; let q = el.nextElementSibling; while (q && q.localName !== 'measure') { arr.push(q.localName + ':' + Array.from(q.attributes).map((a) => a.name + '=' + a.value).join(',')); q = q.nextElementSibling; } return arr; })() : null;
      res.winMeiNextMeasure = strip(nx?.localName === 'measure' ? nx : nx?.querySelector('measure'));
    }
    /* interior scoreDefs the range kept */
    res.rangeScoreDefs = Array.from(rdoc.querySelectorAll('section scoreDef')).map((sd) => ({ ...sdSummary(sd), beforeMeasure: (() => { let n = sd.nextElementSibling; while (n && n.localName !== 'measure') n = n.nextElementSibling; return n?.getAttribute('xml:id'); })() }));
  }
  model.restoreSnapshot(snap);
  reRender();
  await waitFor(badgeHidden, 90000, 30);
}
return out;
