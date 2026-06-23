/* In-page brain for the Phase B2 spike. Defines window.__spike. Injected once
   by spike-b2.mjs; runs inside the Composer page so it can reach
   window.__hkl_composer and a fresh Verovio toolkit (window.verovio). */
(() => {
  const S = {};               // shared state across phases
  const MEI_NS = 'http://www.music-encoding.org/ns/mei';

  /* round to 0.01 for stable JSON */
  const r2 = (x) => Math.round(x * 100) / 100;

  /* ── geometry from the persistent full-render SVG ─────────────────────────── */

  /* Per-staff line extent (top/bottom of the 5 staff-line <path>s) within a
     measure group. Staff lines are direct <path> children of g.staff. */
  function staffLineExtent(staffEl) {
    let top = Infinity, bot = -Infinity;
    for (const p of staffEl.querySelectorAll(':scope > path')) {
      const r = p.getBoundingClientRect();
      if (r.top < top) top = r.top;
      if (r.bottom > bot) bot = r.bottom;
    }
    return { top, bot };
  }

  /* Full content extent of a staff group within a measure (lines + notes +
     ledgers + anything Verovio nested under g.staff). */
  function staffContentExtent(staffEl) {
    const r = staffEl.getBoundingClientRect();
    return { top: r.top, bot: r.bottom };
  }

  /* Build the per-measure geometry table from the persistent #score SVG. The
     per-gap clearance accounts for ALL content (notes, ledgers, dynamics,
     dir, hairpins, fingerings) — every leaf element in the measure binned by
     the full-render gap midpoint — not just g.staff (which misses measure-level
     markings between staves; those drive the inter-instrument gap). */
  /* Spacing-relevant inter-staff markings Verovio reserves vertical room for.
     NOT slurs/ties/beams/phrase/octave — Verovio lets those enter the gap, so
     including them produces false-positive proppers (they don't drive spacing). */
  const MARK_SEL = 'g.dynam, g.dir, g.hairpin, g.tempo, g.fing, g.harm, g.mordent, g.trill, g.fermata, g.ornam';

  function captureGeometry() {
    const container = document.getElementById('score');
    const svg = container.querySelector('svg');
    const measureEls = Array.from(container.querySelectorAll('g.measure'));
    const nStaves = measureEls.length
      ? measureEls[0].querySelectorAll(':scope g.staff').length : 0;

    /* Persistent staff line Ys: from the first measure's staff-line paths
       (constant down the single system — vertical layout is immutable). */
    const firstStaves = Array.from(measureEls[0].querySelectorAll(':scope g.staff'));
    const staffLineYs = firstStaves.map(staffLineExtent);
    const fullGaps = [];
    const mids = [];
    for (let k = 0; k < nStaves - 1; k++) {
      fullGaps.push(r2(staffLineYs[k + 1].top - staffLineYs[k].bot));
      mids.push((staffLineYs[k].bot + staffLineYs[k + 1].top) / 2);
    }

    /* Per measure, per gap k: clearance = top-of-lower-region − bottom-of-upper-
       region, where the regions start as the g.staff content extents and are
       EXTENDED by spacing-relevant markings binned by the gap midpoint. Smaller
       clearance = tighter = props the gap wider. */
    const measures = measureEls.map((el, idx) => {
      const rect = el.getBoundingClientRect();
      const staves = Array.from(el.querySelectorAll(':scope g.staff')).map(staffContentExtent);
      const aboveBot = new Array(nStaves - 1).fill(-Infinity);
      const belowTop = new Array(nStaves - 1).fill(Infinity);
      for (let k = 0; k < nStaves - 1; k++) {
        if (staves[k]) aboveBot[k] = staves[k].bot;
        if (staves[k + 1]) belowTop[k] = staves[k + 1].top;
      }
      for (const mark of el.querySelectorAll(MARK_SEL)) {
        const r = mark.getBoundingClientRect();
        if (r.height === 0 && r.width === 0) continue;
        const cy = (r.top + r.bottom) / 2;
        for (let k = 0; k < nStaves - 1; k++) {
          if (cy <= staffLineYs[k].top || cy >= staffLineYs[k + 1].bot) continue;
          if (cy <= mids[k]) { if (r.bottom > aboveBot[k]) aboveBot[k] = r.bottom; }
          else { if (r.top < belowTop[k]) belowTop[k] = r.top; }
        }
      }
      const gapClear = new Array(nStaves - 1).fill(Infinity);
      for (let k = 0; k < nStaves - 1; k++) {
        if (aboveBot[k] === -Infinity || belowTop[k] === Infinity) gapClear[k] = Infinity;
        else gapClear[k] = belowTop[k] - aboveBot[k];
      }
      return { idx, id: el.getAttribute('id') || el.id, x: rect.left, right: rect.right, gapClear };
    });

    S.container = container;
    S.svg = svg;
    S.measures = measures;
    S.nStaves = nStaves;
    S.staffLineYs = staffLineYs.map((s) => ({ top: r2(s.top), bot: r2(s.bot) }));
    S.fullGaps = fullGaps;
  }

  /* propper[k] = the measure with the LEAST clearance for gap k. Its presence
     in a sub-render reproduces the full gap. */
  function findProppers() {
    const { measures, nStaves } = S;
    const proppers = [];
    for (let k = 0; k < nStaves - 1; k++) {
      let best = null;
      const all = [];
      for (const m of measures) {
        const clearance = m.gapClear[k];
        if (!isFinite(clearance)) continue;
        all.push({ idx: m.idx, clearance });
        if (!best || clearance < best.clearance) best = { idx: m.idx, id: m.id, clearance };
      }
      all.sort((x, y) => x.clearance - y.clearance);
      proppers.push({
        gap: k,
        propperIdx: best.idx,
        propperId: best.id,
        clearance: r2(best.clearance),
        runnersUp: all.slice(0, 6).map((e) => ({ idx: e.idx, clearance: r2(e.clearance) })),
      });
    }
    S.proppers = proppers;
    return proppers;
  }

  /* x-aware collision-clearance finder. For each measure & gap, sweep x in
     buckets; clearance = min over buckets (both sides present) of
     (lowerTop − upperBot). Excludes collision-exempt spanners. */
  const EXEMPT_SEL = 'g.slur, g.tie, g.phrase, g.octave, g.bracketSpan, g.gliss, g.lv';
  const LEAF2_SEL = 'use, path, rect, ellipse, text, polygon';
  const BIN = 4; // px

  function findProppers2D() {
    const { measures, nStaves, staffLineYs } = S;
    const mids = [];
    for (let k = 0; k < nStaves - 1; k++) mids.push((staffLineYs[k].bot + staffLineYs[k + 1].top) / 2);

    const out = [];
    for (let k = 0; k < nStaves - 1; k++) {
      const lo = staffLineYs[k].top, hi = staffLineYs[k + 1].bot;
      let best = null;
      const all = [];
      for (const m of measures) {
        const el = document.getElementById(m.id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const x0 = rect.left, nb = Math.max(1, Math.ceil(rect.width / BIN));
        const upperBot = new Float64Array(nb).fill(-Infinity);
        const lowerTop = new Float64Array(nb).fill(Infinity);
        for (const leaf of el.querySelectorAll(LEAF2_SEL)) {
          if (leaf.closest(EXEMPT_SEL)) continue;
          const r = leaf.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          const cy = (r.top + r.bottom) / 2;
          if (cy <= lo || cy >= hi) continue;
          const b0 = Math.max(0, Math.floor((r.left - x0) / BIN));
          const b1 = Math.min(nb - 1, Math.floor((r.right - x0) / BIN));
          if (cy <= mids[k]) { for (let b = b0; b <= b1; b++) if (r.bottom > upperBot[b]) upperBot[b] = r.bottom; }
          else { for (let b = b0; b <= b1; b++) if (r.top < lowerTop[b]) lowerTop[b] = r.top; }
        }
        let clr = Infinity;
        for (let b = 0; b < nb; b++) {
          if (upperBot[b] === -Infinity || lowerTop[b] === Infinity) continue;
          const c = lowerTop[b] - upperBot[b];
          if (c < clr) clr = c;
        }
        if (!isFinite(clr)) continue;
        all.push({ idx: m.idx, clearance: clr });
        if (!best || clr < best.clearance) best = { idx: m.idx, id: m.id, clearance: clr };
      }
      all.sort((a, b) => a.clearance - b.clearance);
      out.push({
        gap: k, propperIdx: best.idx, propperId: best.id, clearance: r2(best.clearance),
        runnersUp: all.slice(0, 6).map((e) => ({ idx: e.idx, clearance: r2(e.clearance) })),
      });
    }
    S.proppers2D = out;
    return out;
  }

  /* ── gap-mechanism experiment (synthetic spacer characterization) ────────── */

  /* Minimal braced 2-staff, 1-measure MEI. `s1`/`s2` are the layer-content XML
     for staff 1 / staff 2; `mExtra` is measure-level control events. Rendered
     through the live toolkit (real scroll options) so px scale matches. */
  function minimalMei(s1, s2, mExtra) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="${MEI_NS}" meiversion="5.0"><music><body><mdiv><score>
<scoreDef midi.bpm="120"><staffGrp symbol="brace" bar.thru="true">
<staffDef n="1" lines="5" clef.shape="G" clef.line="2"/>
<staffDef n="2" lines="5" clef.shape="F" clef.line="4"/>
</staffGrp></scoreDef>
<section><measure n="1" xml:id="mm1">
<staff n="1"><layer n="1">${s1}</layer></staff>
<staff n="2"><layer n="1">${s2}</layer></staff>
${mExtra || ''}
</measure></section>
</score></mdiv></body></music></mei>`;
  }

  /* Render a minimal MEI offscreen, return the inter-staff gap (staff2 line-top
     − staff1 line-bot) and per-staff line extents. */
  function measureMinimalGap(mei) {
    const tk = S.C.renderer.toolkit();
    if (!tk.loadData(mei)) return { gap: null, err: 'loadData failed' };
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-99999px;top:0';
    host.innerHTML = tk.renderToSVG(1, {});
    document.body.appendChild(host);
    const staves = Array.from(host.querySelectorAll('g.measure')[0]
      ? host.querySelectorAll('g.measure')[0].querySelectorAll(':scope g.staff') : []).map(staffLineExtent);
    host.remove();
    if (staves.length < 2) return { gap: null, err: 'staves=' + staves.length };
    return { gap: r2(staves[1].top - staves[0].bot), s1: { top: r2(staves[0].top), bot: r2(staves[0].bot) }, s2: { top: r2(staves[1].top), bot: r2(staves[1].bot) } };
  }

  function sweep(label, params, build) {
    return { label, points: params.map((p) => ({ p, ...measureMinimalGap(build(p)) })) };
  }

  S.setup = function setup() {
    const C = window.__hkl_composer;
    S.C = C;
    C.renderer.setViewMode('scroll');
    window.__composerImportMusicXml(window.__sonataXml);
    C.reRender();
    /* Capture the MEI that produced the persistent render (no view filter →
       all staves, matching the default toolbar state). */
    S.mei = C.model.serialize({ hejiEnabled: C.model.getHejiEnabled() }, null);
    /* Parse it once for sub-MEI building. */
    S.meiDoc = new DOMParser().parseFromString(S.mei, 'application/xml');
    S.section = S.meiDoc.querySelector('section');
    S.meiMeasures = Array.from(S.section.children).filter((c) => c.localName === 'measure');
    captureGeometry();
    return { nMeasures: S.measures.length, nStaves: S.nStaves, gaps: S.nStaves - 1 };
  };

  /* ── sub-MEI builder (corrected: preserves interior scoreDefs) ────────────── */

  /* Running clef-per-staff + key/meter as of measure `target`, walking the
     section in document order. Reads clef changes from BOTH inline
     staff>layer>clef AND interior scoreDef>staffDef clef.* (the old chunk code
     missed the latter). */
  function computeRunningCtx(target) {
    const ctx = { keySig: null, mode: null, meterCount: null, meterUnit: null, meterSym: null, clefByStaff: new Map() };
    const targetEl = S.meiMeasures[target];
    for (const node of Array.from(S.section.children)) {
      if (node === targetEl) break;
      if (node.localName === 'scoreDef') {
        const ks = node.getAttribute('key.sig'); if (ks !== null) ctx.keySig = ks;
        const md = node.getAttribute('mode'); if (md !== null) ctx.mode = md;
        const mc = node.getAttribute('meter.count'); if (mc !== null) ctx.meterCount = mc;
        const mu = node.getAttribute('meter.unit'); if (mu !== null) ctx.meterUnit = mu;
        const ms = node.getAttribute('meter.sym'); if (mc !== null || mu !== null) ctx.meterSym = ms;
        for (const sd of node.querySelectorAll('staffDef')) {
          const sn = sd.getAttribute('n') ?? '1';
          const shape = sd.getAttribute('clef.shape');
          if (shape) ctx.clefByStaff.set(sn, {
            shape, line: sd.getAttribute('clef.line') ?? '2',
            dis: sd.getAttribute('clef.dis'), disPlace: sd.getAttribute('clef.dis.place'),
          });
        }
      } else if (node.localName === 'measure') {
        for (const staff of node.querySelectorAll('staff')) {
          const sn = staff.getAttribute('n') ?? '1';
          const clefs = staff.querySelectorAll('layer > clef');
          const c = clefs[clefs.length - 1];
          if (c) ctx.clefByStaff.set(sn, {
            shape: c.getAttribute('shape') ?? 'G', line: c.getAttribute('line') ?? '2',
            dis: c.getAttribute('dis'), disPlace: c.getAttribute('dis.place'),
          });
        }
      }
    }
    return ctx;
  }

  /* Stamp running ctx onto a scoreDef element's existing staffDefs + top attrs. */
  function stampScoreDef(sd, ctx) {
    if (ctx.keySig !== null) sd.setAttribute('key.sig', ctx.keySig);
    if (ctx.mode !== null) sd.setAttribute('mode', ctx.mode);
    if (ctx.meterCount !== null) sd.setAttribute('meter.count', ctx.meterCount);
    if (ctx.meterUnit !== null) sd.setAttribute('meter.unit', ctx.meterUnit);
    if (ctx.meterSym) sd.setAttribute('meter.sym', ctx.meterSym); else sd.removeAttribute('meter.sym');
    for (const staffDef of sd.querySelectorAll('staffDef')) {
      const sn = staffDef.getAttribute('n') ?? '1';
      const c = ctx.clefByStaff.get(sn);
      if (c) {
        staffDef.setAttribute('clef.shape', c.shape);
        staffDef.setAttribute('clef.line', c.line);
        if (c.dis) { staffDef.setAttribute('clef.dis', c.dis); if (c.disPlace) staffDef.setAttribute('clef.dis.place', c.disPlace); }
        else { staffDef.removeAttribute('clef.dis'); staffDef.removeAttribute('clef.dis.place'); }
      }
    }
  }

  /* Build a sub-MEI string for measures [lo..hi] (interior scoreDefs preserved,
     head scoreDef stamped with running ctx as of lo) + each propper measure not
     already in the run appended as a spacer carrying its own running clef ctx. */
  function buildSubMei(lo, hi, propperIdxs) {
    const sub = S.meiDoc.cloneNode(true);
    const subSection = sub.querySelector('section');

    /* Walk section children, tracking measures-seen, keep/drop. */
    let seen = 0;
    for (const node of Array.from(subSection.children)) {
      if (node.localName === 'measure') {
        if (seen < lo || seen > hi) node.remove();
        seen++;
      } else {
        /* keep interior non-measure nodes only: strictly after run start,
           not past the last kept measure. */
        if (!(seen > lo && seen <= hi)) node.remove();
      }
    }

    /* Stamp head scoreDef with running ctx as of lo. */
    const headSd = sub.querySelector('scoreDef');
    if (headSd) stampScoreDef(headSd, computeRunningCtx(lo));

    /* Append proppers (outside the run) as spacers, each preceded by a fresh
       scoreDef establishing its running clef/key/meter context. */
    const spacerIds = [];
    for (const p of propperIdxs) {
      if (p >= lo && p <= hi) continue;     // already in the run
      const ctxP = computeRunningCtx(p);
      /* Clone the head scoreDef shape for a valid interior scoreDef, stamp ctx. */
      const spacerSd = headSd.cloneNode(true);
      stampScoreDef(spacerSd, ctxP);
      subSection.appendChild(spacerSd);
      const measClone = S.meiMeasures[p].cloneNode(true);
      subSection.appendChild(measClone);
      spacerIds.push(measClone.getAttribute('xml:id') || measClone.getAttribute('id'));
    }
    return { mei: new XMLSerializer().serializeToString(sub), spacerIds };
  }

  /* Render a sub-MEI through the live toolkit (already holding buildOptions
     ('none') from the persistent scroll render) into an offscreen host. Returns
     per-staff line Y extents of the FIRST measure (the run's lo measure). */
  function renderSubOffscreen(mei) {
    const tk = S.C.renderer.toolkit();
    tk.loadData(mei);
    const svgStr = tk.renderToSVG(1, {});
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-99999px;top:0';
    host.innerHTML = svgStr;
    document.body.appendChild(host);
    const staves = Array.from(host.querySelectorAll('g.measure'))[0]
      ? Array.from(host.querySelectorAll('g.measure')[0].querySelectorAll(':scope g.staff'))
      : [];
    const lineYs = staves.map(staffLineExtent);
    return { host, lineYs, svgStr };
  }

  /* ── phases ───────────────────────────────────────────────────────────────── */

  const PHASES = {
    probe() {
      const proppers = findProppers();
      return {
        phase: 'probe',
        nMeasures: S.measures.length,
        nStaves: S.nStaves,
        staffLineYs: S.staffLineYs,
        fullGaps: S.fullGaps,
        proppers,
        firstMeasureIds: S.measures.slice(0, 5).map((m) => m.id),
      };
    },
    spacer() {
      /* Ground-truth proppers (from the `truth` solo-render argmax) to isolate
         the spacer mechanism from the (separately broken) cheap finder. */
      const propperIdxs = [300, 268];
      /* Full-render relative staff offsets (staff k top − staff 0 top). */
      const fullRel = S.staffLineYs.map((s) => r2(s.top - S.staffLineYs[0].top));

      const ranges = [
        { label: 'far-from-proppers m10', lo: 10, hi: 10 },
        { label: 'mid m200', lo: 200, hi: 200 },
        { label: 'adjacent-to-propper m299', lo: 299, hi: 299 },
        { label: 'is-propper m300', lo: 300, hi: 300 },
        { label: 'is-other-propper m349', lo: 349, hi: 349 },
        { label: 'near-end m440', lo: 440, hi: 440 },
        { label: 'multi m100-104', lo: 100, hi: 104 },
      ];
      const results = [];
      for (const rg of ranges) {
        const built = buildSubMei(rg.lo, rg.hi, propperIdxs);
        const { host, lineYs } = renderSubOffscreen(built.mei);
        let report;
        if (lineYs.length !== S.nStaves) {
          report = { error: 'sub has ' + lineYs.length + ' staves, expected ' + S.nStaves };
        } else {
          const subRel = lineYs.map((s) => r2(s.top - lineYs[0].top));
          const dy = subRel.map((v, k) => r2(v - fullRel[k]));
          const subGaps = [];
          for (let k = 0; k < S.nStaves - 1; k++) subGaps.push(r2(lineYs[k + 1].top - lineYs[k].bot));
          const gapErr = subGaps.map((g, k) => r2(g - S.fullGaps[k]));
          report = { subRel, fullRel, dy, subGaps, fullGaps: S.fullGaps, gapErr, spacers: built.spacerIds.length };
        }
        host.remove();
        results.push({ ...rg, ...report });
      }
      return { phase: 'spacer', propperIdxs, results };
    },
    /* Ground-truth propper finder: render each measure SOLO (running ctx, no
       spacers) and record its per-gap demand. True propper for gap k = argmax
       solo gap. Reveals whether any single measure explains the full gap, and
       what my cheap metric mis-ranked. */
    truth() {
      findProppers();
      const t0 = performance.now();
      const tk = S.C.renderer.toolkit();
      /* Cheap solo template: doc clone with the section emptied of measures. */
      const tmpl = S.meiDoc.cloneNode(true);
      const tmplSection = tmpl.querySelector('section');
      for (const c of Array.from(tmplSection.children)) c.remove();
      const tmplHead = tmpl.querySelector('scoreDef');

      const nGap = S.nStaves - 1;
      const soloGap = S.measures.map(() => new Array(nGap).fill(null));
      const N = S.measures.length;
      for (let i = 0; i < N; i++) {
        stampScoreDef(tmplHead, computeRunningCtx(i));
        /* swap the single measure */
        for (const c of Array.from(tmplSection.children)) c.remove();
        tmplSection.appendChild(S.meiMeasures[i].cloneNode(true));
        tk.loadData(new XMLSerializer().serializeToString(tmpl));
        const host = document.createElement('div');
        host.style.cssText = 'position:absolute;left:-99999px;top:0';
        host.innerHTML = tk.renderToSVG(1, {});
        document.body.appendChild(host);
        const mEl = host.querySelector('g.measure');
        if (mEl) {
          const st = Array.from(mEl.querySelectorAll(':scope g.staff')).map(staffLineExtent);
          for (let k = 0; k < nGap; k++) {
            if (st[k] && st[k + 1]) soloGap[i][k] = r2(st[k + 1].top - st[k].bot);
          }
        }
        host.remove();
      }
      /* argmax per gap + my-metric comparison. */
      const out = [];
      for (let k = 0; k < nGap; k++) {
        const ranked = soloGap
          .map((g, i) => ({ idx: i, gap: g[k] }))
          .filter((e) => e.gap != null)
          .sort((a, b) => b.gap - a.gap);
        const myPropper = S.proppers ? S.proppers[k].propperIdx : null;
        out.push({
          gap: k,
          fullGap: S.fullGaps[k],
          truePropperIdx: ranked[0].idx,
          maxSoloGap: ranked[0].gap,
          top: ranked.slice(0, 8),
          myMetricPropperIdx: myPropper,
          myMetricSoloGap: myPropper != null ? soloGap[myPropper][k] : null,
        });
      }
      return { phase: 'truth', soloRenderMs: r2(performance.now() - t0), nRenders: N, gaps: out };
    },
    /* Dump gap-1 region contents of specific measures from the FULL render to
       see what drives m268's demand that the cheap metric missed. */
    gapdump() {
      const k = 1; // gap between staff 2 (idx1) and staff 3 (idx2)
      const lo = S.staffLineYs[k].top, hi = S.staffLineYs[k + 1].bot;
      const out = {};
      for (const idx of [268, 308, 349, 89, 316]) {
        const el = S.measures[idx] && S.measures[idx].id
          ? document.getElementById(S.measures[idx].id) : null;
        if (!el) { out[idx] = 'not found'; continue; }
        const staves = Array.from(el.querySelectorAll(':scope g.staff'));
        const items = [];
        /* every g.* group with a class, plus g.staff itself */
        for (const g of el.querySelectorAll('g[class]')) {
          const r = g.getBoundingClientRect();
          const cy = (r.top + r.bottom) / 2;
          if (r.height === 0) continue;
          if (cy <= lo || cy >= hi) continue;
          items.push({ cls: g.getAttribute('class'), top: r2(r.top), bot: r2(r.bottom) });
        }
        items.sort((a, b) => a.top - b.top);
        out[idx] = {
          staff2Bot: staves[k] ? r2(staffContentExtent(staves[k]).bot) : null,
          staff3Top: staves[k + 1] ? r2(staffContentExtent(staves[k + 1]).top) : null,
          items: items.slice(0, 25),
        };
      }
      return { phase: 'gapdump', gapRegion: { lo: r2(lo), hi: r2(hi) }, measures: out };
    },
    /* x-aware (2D) propper finder: clearance = min over x-buckets of (top of
       lower-region content − bottom of upper-region content), so vertically-
       overlapping-but-horizontally-separated content (m349) doesn't count as a
       collision. Excludes collision-exempt spanners (slur/tie/phrase/octave). */
    finder() {
      const t0 = performance.now();
      const proppers = findProppers2D();
      const ms = r2(performance.now() - t0);
      findProppers(); // 1D, for comparison
      return {
        phase: 'finder',
        finderMs: ms,
        groundTruth: { gap0: 300, gap1: 268 },
        proppers2D: proppers,
        proppers1D: S.proppers.map((p) => ({ gap: p.gap, idx: p.propperIdx })),
      };
    },
    /* Why does the 2D metric flag m82 in gap 0? Dump leaf elements (with x) in
       the gap-0 collision band for the false positive vs the true propper. */
    why82() {
      const k = 0;
      const lo = S.staffLineYs[k].top, hi = S.staffLineYs[k + 1].bot;
      const mid = (S.staffLineYs[k].bot + S.staffLineYs[k + 1].top) / 2;
      const out = {};
      for (const idx of [82, 300, 324]) {
        const el = document.getElementById(S.measures[idx].id);
        const x0 = el.getBoundingClientRect().left;
        const ups = [], lows = [];
        for (const leaf of el.querySelectorAll(LEAF2_SEL)) {
          if (leaf.closest(EXEMPT_SEL)) continue;
          const r = leaf.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          const cy = (r.top + r.bottom) / 2;
          if (cy <= lo || cy >= hi) continue;
          const par = leaf.parentElement;
          const rec = { tag: leaf.tagName, parent: par && par.getAttribute('class'),
            x: r2(r.left - x0), w: r2(r.width), top: r2(r.top), bot: r2(r.bottom) };
          if (cy <= mid) ups.push(rec); else lows.push(rec);
        }
        ups.sort((a, b) => b.bot - a.bot); lows.sort((a, b) => a.top - b.top);
        out[idx] = { lowestUpper: ups.slice(0, 4), highestLower: lows.slice(0, 4) };
      }
      return { phase: 'why82', mid: r2(mid), band: { lo: r2(lo), hi: r2(hi) }, measures: out };
    },
    /* Optimized render-based finder: render contiguous BLOCKS of `blk` measures
       (each running-ctx-correct), find blocks whose gap == global gap, then
       solo-render only the measures in those winning blocks to pick the exact
       argmax propper. Correct by construction; far fewer renders than naive. */
    blockfind() {
      const t0 = performance.now();
      const tk = S.C.renderer.toolkit();
      const N = S.measures.length, nGap = S.nStaves - 1;
      const blk = 32, EPS = 1.5;

      /* cheap solo template */
      const tmpl = S.meiDoc.cloneNode(true);
      const tmplSection = tmpl.querySelector('section');
      const tmplHead = tmpl.querySelector('scoreDef');

      function renderRangeGaps(loI, hiI) {
        stampScoreDef(tmplHead, computeRunningCtx(loI));
        for (const c of Array.from(tmplSection.children)) c.remove();
        for (let i = loI; i <= hiI; i++) tmplSection.appendChild(S.meiMeasures[i].cloneNode(true));
        tk.loadData(new XMLSerializer().serializeToString(tmpl));
        const host = document.createElement('div');
        host.style.cssText = 'position:absolute;left:-99999px;top:0';
        host.innerHTML = tk.renderToSVG(1, {});
        document.body.appendChild(host);
        const st = Array.from(host.querySelectorAll('g.measure')[0]
          ? host.querySelectorAll('g.measure')[0].querySelectorAll(':scope g.staff') : []).map(staffLineExtent);
        host.remove();
        const gaps = [];
        for (let k = 0; k < nGap; k++) gaps.push(st[k] && st[k + 1] ? st[k + 1].top - st[k].bot : null);
        return gaps;
      }

      /* 1. block pass */
      let nRenders = 0;
      const blocks = [];
      for (let lo = 0; lo < N; lo += blk) {
        const hi = Math.min(N - 1, lo + blk - 1);
        blocks.push({ lo, hi, gaps: renderRangeGaps(lo, hi) }); nRenders++;
      }
      /* 2. per gap: winning blocks (gap ≈ global), then solo within them */
      const result = [];
      for (let k = 0; k < nGap; k++) {
        const globalGap = S.fullGaps[k];
        const winners = blocks.filter((b) => b.gaps[k] != null && Math.abs(b.gaps[k] - globalGap) <= EPS);
        let best = null;
        for (const w of winners) {
          for (let i = w.lo; i <= w.hi; i++) {
            const g = renderRangeGaps(i, i)[k]; nRenders++;
            if (g != null && (!best || g > best.gap)) best = { idx: i, gap: r2(g) };
          }
        }
        result.push({ gap: k, globalGap, winnerBlocks: winners.map((w) => [w.lo, w.hi]), propperIdx: best && best.idx, propperGap: best && best.gap });
      }
      return { phase: 'blockfind', blockfindMs: r2(performance.now() - t0), nRenders, groundTruth: { gap0: 300, gap1: 268 }, result };
    },
    /* Characterize candidate synthetic-spacer mechanisms: how does the
       inter-staff gap respond to each parameter? Looking for continuous /
       fine-grained + monotonic control. */
    gapmech() {
      const baseS1 = '<note dur="4" oct="4" pname="g"/>';
      const baseS2 = '<note dur="4" oct="3" pname="c"/>';
      const baseline = measureMinimalGap(minimalMei(baseS1, baseS2, ''));

      const sweeps = [];

      /* 1. Ledger depth: low note in staff 1 → ledger lines below → bigger gap.
            Quantized by diatonic step. */
      const pitches = [
        ['g', 4], ['e', 4], ['c', 4], ['a', 3], ['f', 3], ['d', 3], ['b', 2], ['g', 2], ['e', 2], ['c', 2], ['a', 1], ['f', 1],
      ];
      sweeps.push(sweep('ledgerDepth(staff1 low note)', pitches,
        ([pn, oc]) => minimalMei(`<note dur="4" oct="${oc}" pname="${pn}"/>`, baseS2, '')));

      /* 2. stem.len on a top-line note with downward stem (overflow below). */
      sweeps.push(sweep('stem.len', [0, 2, 4, 6, 8, 12, 16, 24, 40],
        (x) => minimalMei(`<note dur="4" oct="5" pname="b" stem.dir="down" stem.len="${x}"/>`, baseS2, '')));

      /* 3. dynam below staff 1 with vertical offset @vo (continuous?). */
      sweeps.push(sweep('dynam@vo(below staff1)', [0, 2, 4, 8, 12, 16, 24, 40],
        (x) => minimalMei(baseS1, baseS2, `<dynam staff="1" tstamp="1" place="below" vo="${x}">f</dynam>`)));

      /* 4. dir below staff 1 with @vo. */
      sweeps.push(sweep('dir@vo(below staff1)', [0, 4, 8, 16, 24, 40],
        (x) => minimalMei(baseS1, baseS2, `<dir staff="1" tstamp="1" place="below" vo="${x}">x</dir>`)));

      /* 5. fingering rows / fb? quick: multiple-line dir text. */
      sweeps.push(sweep('dir multi-line', [1, 2, 3, 4, 5],
        (n) => minimalMei(baseS1, baseS2,
          `<dir staff="1" tstamp="1" place="below">${Array.from({ length: n }, () => 'x').join('<lb/>')}</dir>`)));

      return { phase: 'gapmech', baseline, sweeps };
    },
    /* Fine characterization of stem.len → gap. Is it continuous (fractional
       units honored) and linear above a threshold? If so it's exact px control. */
    stemlen() {
      const baseS2 = '<note dur="4" oct="3" pname="c"/>';
      const build = (x) => minimalMei(`<note dur="4" oct="5" pname="b" stem.dir="down" stem.len="${x}"/>`, baseS2, '');
      const coarse = [];
      for (let x = 14; x <= 60; x += 1) coarse.push(x);
      const frac = [24, 24.25, 24.5, 24.75, 25, 25.1, 25.25, 25.5, 25.75, 26, 30, 30.5, 31, 31.5];
      const c = sweep('stem.len 14..60 step1', coarse, build);
      const f = sweep('stem.len fractional', frac, build);
      /* derive slope over the clearly-linear region from the coarse sweep */
      const pts = c.points.filter((p) => p.gap != null);
      const lin = pts.filter((p) => p.gap > 130);
      let slope = null, intercept = null;
      if (lin.length >= 2) {
        const a = lin[0], b = lin[lin.length - 1];
        slope = r2((b.gap - a.gap) / (b.p - a.p));
        intercept = r2(a.gap - slope * a.p);
      }
      return { phase: 'stemlen', slope, intercept, coarse: c.points, fractional: f.points };
    },
    /* THE NEW APPROACH: synthetic spacer measure. Build a sub-MEI = edited real
       measure + ONE synthetic spacer whose per-gap stem.len content reproduces
       each full-render gap exactly. Calibrate the linear law (2 samples), solve
       stem.len per gap for the target gaps, verify dy≈0 + edited-measure note
       positions match the full render. */
    synth() {
      const nStaves = S.nStaves, nGap = nStaves - 1;

      /* Build one synthetic spacer measure. We force a LOCAL treble clef on every
         staff (the change is confined to this discarded dummy measure, so the
         real clefs are irrelevant) and put the control note on one fixed line —
         f5, the treble top line — with a downward stem of length stem.len[k].
         The down-stem protrudes only BELOW the staff (into gap k), never above,
         and the construction is clef-independent. Each staff s (1..nGap) drives
         gap (s-1); the bottom staff is a non-protruding filler. dur="4" (NOT
         whole — whole notes have no stem, so stem.len is a no-op). */
      function synthMeasure(sl) {
        let staves = '';
        for (let s = 1; s <= nStaves; s++) {
          const clef = '<clef shape="G" line="2"/>';
          const note = s <= nGap
            ? `<note dur="4" oct="5" pname="f" stem.dir="down" stem.len="${sl[s - 1]}"/>`
            : `<note dur="4" oct="5" pname="f"/>`;
          staves += `<staff n="${s}"><layer n="1">${clef}${note}</layer></staff>`;
        }
        return `<measure n="9999" xml:id="hkl-spacer">${staves}</measure>`;
      }

      /* sub-MEI: stamped head scoreDef + edited measure [lo] + synth spacer. */
      function buildSynthSub(lo, hi, sl) {
        const sub = S.meiDoc.cloneNode(true);
        const subSection = sub.querySelector('section');
        let seen = 0;
        for (const node of Array.from(subSection.children)) {
          if (node.localName === 'measure') { if (seen < lo || seen > hi) node.remove(); seen++; }
          else if (!(seen > lo && seen <= hi)) node.remove();
        }
        const headSd = sub.querySelector('scoreDef');
        if (headSd) stampScoreDef(headSd, computeRunningCtx(lo));
        const frag = new DOMParser().parseFromString(
          `<x xmlns="${MEI_NS}">${synthMeasure(sl)}</x>`, 'application/xml');
        subSection.appendChild(sub.importNode(frag.documentElement.firstChild, true));
        return new XMLSerializer().serializeToString(sub);
      }

      /* measure all gaps of a sub-MEI's FIRST (edited) measure region. */
      function gapsOf(mei) {
        const tk = S.C.renderer.toolkit();
        tk.loadData(mei);
        const host = document.createElement('div');
        host.style.cssText = 'position:absolute;left:-99999px;top:0';
        host.innerHTML = tk.renderToSVG(1, {});
        document.body.appendChild(host);
        const st = Array.from(host.querySelectorAll('g.measure')[0]
          ? host.querySelectorAll('g.measure')[0].querySelectorAll(':scope g.staff') : []).map(staffLineExtent);
        host.remove();
        const gaps = [];
        for (let k = 0; k < nGap; k++) gaps.push(st[k] && st[k + 1] ? r2(st[k + 1].top - st[k].bot) : null);
        return gaps;
      }

      /* calibrate ONCE (context-independent: the spacer dominates the gap). */
      const calA = 30, calB = 45;
      const gA = gapsOf(buildSynthSub(200, 200, new Array(nGap).fill(calA)));
      const gB = gapsOf(buildSynthSub(200, 200, new Array(nGap).fill(calB)));
      const law = [], sl = [];
      for (let k = 0; k < nGap; k++) {
        const m = (gB[k] - gA[k]) / (calB - calA);
        const b = gA[k] - m * calA;
        law.push({ gap: k, slope: r2(m), intercept: r2(b) });
        sl.push((S.fullGaps[k] - b) / m);
      }

      /* claim-3 + latency over several edit positions, reusing the one law. */
      function verify(lo, hi) {
        const t0 = performance.now();
        const subMei = buildSynthSub(lo, hi, sl);
        const tk = S.C.renderer.toolkit();
        tk.loadData(subMei);
        const svg = tk.renderToSVG(1, {});
        const buildRenderMs = r2(performance.now() - t0);
        const host = document.createElement('div');
        host.style.cssText = 'position:absolute;left:-99999px;top:0';
        host.innerHTML = svg;
        document.body.appendChild(host);
        const st = Array.from(host.querySelectorAll('g.measure')[0].querySelectorAll(':scope g.staff')).map(staffLineExtent);
        const finalGaps = []; for (let k = 0; k < nGap; k++) finalGaps.push(r2(st[k + 1].top - st[k].bot));
        const gapErr = finalGaps.map((g, k) => r2(g - S.fullGaps[k]));
        const subS0Top = st[0].top, fullS0Top = S.staffLineYs[0].top;
        let maxDy = 0, n = 0;
        for (let i = lo; i <= hi; i++) {
          const el = host.querySelector('#' + CSS.escape(S.measures[i].id));
          if (!el) continue;
          for (const nn of Array.from(el.querySelectorAll('g.note'))) {
            const fe = document.getElementById(nn.getAttribute('id'));
            if (!fe) continue;
            const dy = Math.abs((nn.getBoundingClientRect().top - subS0Top) - (fe.getBoundingClientRect().top - fullS0Top));
            if (dy > maxDy) maxDy = dy; n++;
          }
        }
        host.remove();
        return { range: [lo, hi], buildRenderMs, gapErr, maxNoteDyRel: r2(maxDy), notesChecked: n };
      }

      const cases = [[10, 10], [200, 200], [268, 268], [349, 349], [440, 440], [100, 104], [50, 60]];
      const results = cases.map(([lo, hi]) => verify(lo, hi));

      return {
        phase: 'synth', fullGaps: S.fullGaps,
        calib: { calA, calB, gA, gB }, law, solvedStemLen: sl.map(r2), results,
      };
    },
    /* LIVE proof: drive the REAL renderer (with the new splice.ts) through a
       single-measure edit, then full-re-render the same MEI and compare. */
    live() {
      const C = S.C;
      const editIdx = 200;
      const mei0 = S.mei;
      /* Build mei1: bump the first note's octave in measure editIdx. */
      const doc = new DOMParser().parseFromString(mei0, 'application/xml');
      const measures = Array.from(doc.querySelector('section').children).filter((c) => c.localName === 'measure');
      const note = measures[editIdx].querySelector('note');
      const before = note ? note.getAttribute('color') : null;
      /* color-only edit: changes the measure signature (forces a splice) without
         moving any glyph — isolates the splice MECHANISM from layout-changing
         edits (oct/ties/beams). A correct splice ⇒ maxNoteDyRel 0. */
      if (note) note.setAttribute('color', '#ff0000');
      const mei1 = new XMLSerializer().serializeToString(doc);
      const editId = measures[editIdx].getAttribute('xml:id') || measures[editIdx].getAttribute('id');
      const afterId = measures[editIdx + 1].getAttribute('xml:id') || measures[editIdx + 1].getAttribute('id');

      const relPositions = (mId) => {
        const sysStaff0 = document.querySelectorAll('#score g.measure')[0].querySelectorAll(':scope g.staff')[0];
        const s0 = staffLineExtent(sysStaff0).top;
        const m = document.getElementById(mId);
        if (!m) return null;
        const notes = Array.from(m.querySelectorAll('g.note')).map((n) => {
          const head = n.querySelector(':scope > g.notehead') || n;
          return { id: n.getAttribute('id'), y: r2(head.getBoundingClientRect().top - s0) };
        });
        return notes;
      };
      const gapsNow = () => {
        const st = Array.from(document.querySelectorAll('#score g.measure')[0].querySelectorAll(':scope g.staff')).map(staffLineExtent);
        const g = []; for (let k = 0; k < S.nStaves - 1; k++) g.push(r2(st[k + 1].top - st[k].bot));
        return g;
      };
      const leftOf = (mId) => { const m = document.getElementById(mId); return m ? r2(m.getBoundingClientRect().left) : null; };

      /* SPLICE path. */
      const svgRef = document.querySelector('#score svg');
      const t0 = performance.now();
      C.renderer.render(mei1);
      const spliceMs = r2(performance.now() - t0);
      const svgSame = document.querySelector('#score svg') === svgRef;     // not replaced ⇒ spliced
      /* diagnostics: where did the spliced measure land vertically vs its
         unchanged neighbour 199 (the true system staff Y)? */
      const staff0TopOf = (mId) => {
        const m = document.getElementById(mId);
        if (!m) return null;
        const s = m.querySelectorAll(':scope g.staff')[0];
        return s ? r2(staffLineExtent(s).top) : null;
      };
      const neighId = measures[editIdx - 1].getAttribute('xml:id') || measures[editIdx - 1].getAttribute('id');
      const snapshot = () => {
        const m0s0 = document.querySelectorAll('#score g.measure')[0].querySelectorAll(':scope g.staff')[0];
        const note0 = document.getElementById(editId) ? document.getElementById(editId).querySelector('g.note') : null;
        return {
          m0Staff0Abs: r2(staffLineExtent(m0s0).top),
          editStaff0Abs: staff0TopOf(editId),
          neigh199Staff0Abs: staff0TopOf(neighId),
          note0Id: note0 ? note0.getAttribute('id') : null,
          note0Abs: note0 ? r2(note0.getBoundingClientRect().top) : null,
        };
      };
      const diag = {
        editTransform: (document.getElementById(editId) || {}).getAttribute?.('transform'),
        spliced: snapshot(),
      };
      const splicedNotes = relPositions(editId);
      const splicedGaps = gapsNow();
      const splicedAfterLeft = leftOf(afterId);
      const splicedEditLeft = leftOf(editId);

      /* FULL re-render of the SAME mei1 for comparison. */
      C.renderer.forceFullRerender();
      C.renderer.render(mei1);
      diag.full = snapshot();
      const fullNotes = relPositions(editId);
      const fullGaps = gapsNow();
      const fullAfterLeft = leftOf(afterId);
      const fullEditLeft = leftOf(editId);

      /* compare note positions by id */
      let maxNoteDy = 0; const fm = new Map((fullNotes || []).map((n) => [n.id, n.y]));
      const perNote = [];
      for (const n of splicedNotes || []) if (fm.has(n.id)) { const d = r2(n.y - fm.get(n.id)); perNote.push({ id: n.id, d }); maxNoteDy = Math.max(maxNoteDy, Math.abs(d)); }
      perNote.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
      const gapDiff = splicedGaps.map((g, k) => r2(g - fullGaps[k]));

      return {
        phase: 'live', editIdx, octBefore: before,
        spliceMs, svgNotReplaced: svgSame, diag,
        nSplicedNotes: (splicedNotes || []).length, nFullNotes: (fullNotes || []).length,
        maxNoteDyRel: r2(maxNoteDy), perNoteTop: perNote.slice(0, 8), perNoteBottom: perNote.slice(-4), gapDiff,
        editLeft: { spliced: splicedEditLeft, full: fullEditLeft, diff: r2(splicedEditLeft - fullEditLeft) },
        afterLeft: { spliced: splicedAfterLeft, full: fullAfterLeft, diff: r2(splicedAfterLeft - fullAfterLeft) },
      };
    },
    /* Perform ONE color-splice at editIdx, scroll it into view, and leave it on
       screen (no full re-render after) so the harness can screenshot the result. */
    liveshot() {
      const C = S.C;
      const editIdx = 200;
      const doc = new DOMParser().parseFromString(S.mei, 'application/xml');
      const measures = Array.from(doc.querySelector('section').children).filter((c) => c.localName === 'measure');
      const note = measures[editIdx].querySelector('note');
      if (note) note.setAttribute('color', '#ff0000');
      const mei1 = new XMLSerializer().serializeToString(doc);
      const editId = measures[editIdx].getAttribute('xml:id') || measures[editIdx].getAttribute('id');
      C.renderer.render(mei1);
      const m = document.getElementById(editId);
      const left = m ? m.getBoundingClientRect().left : 0;
      const score = document.getElementById('score');
      score.scrollLeft = (score.scrollLeft + left) - 400;
      return { editIdx, scrolledTo: score.scrollLeft, editId };
    },
    /* Full re-render of the same color-edit, scrolled to editIdx — the
       ground-truth visual to compare against liveshot. */
    fullshot() {
      const C = S.C;
      const editIdx = 200;
      const doc = new DOMParser().parseFromString(S.mei, 'application/xml');
      const measures = Array.from(doc.querySelector('section').children).filter((c) => c.localName === 'measure');
      const note = measures[editIdx].querySelector('note');
      if (note) note.setAttribute('color', '#ff0000');
      const mei1 = new XMLSerializer().serializeToString(doc);
      const editId = measures[editIdx].getAttribute('xml:id') || measures[editIdx].getAttribute('id');
      C.renderer.forceFullRerender();
      C.renderer.render(mei1);
      const m = document.getElementById(editId);
      const left = m ? m.getBoundingClientRect().left : 0;
      const score = document.getElementById('score');
      score.scrollLeft = (score.scrollLeft + left) - 400;
      return { editIdx, scrolledTo: score.scrollLeft, editId };
    },
    /* Inspect glyph-symbol + <use> formats in the persistent render. */
    defprobe() {
      const svg = document.querySelector('#score svg');
      const defs = svg.querySelector('defs');
      const syms = defs ? Array.from(defs.querySelectorAll('symbol')) : [];
      const uses = svg.querySelectorAll('use');
      const sampleUse = svg.querySelector('g.notehead use') || svg.querySelector('use');
      const href = sampleUse ? (sampleUse.getAttribute('xlink:href') || sampleUse.getAttribute('href')) : null;
      const tgt = href ? document.getElementById(href.slice(1)) : null;
      // chain from target up to svg
      const chain = [];
      let n = tgt;
      while (n && n !== svg) { chain.push(n.tagName + (n.getAttribute && n.getAttribute('class') ? '.' + n.getAttribute('class') : '')); n = n.parentElement; }
      // all <defs> in the svg + their direct child element tag counts
      const allDefs = Array.from(svg.querySelectorAll('defs')).map((d) => ({
        parent: d.parentElement.tagName + (d.parentElement.getAttribute('class') ? '.' + d.parentElement.getAttribute('class') : ''),
        childTags: Array.from(new Set(Array.from(d.children).map((c) => c.tagName))),
        nChildren: d.children.length,
        firstChildId: d.children[0] ? d.children[0].getAttribute('id') : null,
      }));
      return {
        defsFound: !!defs, nSymbols: syms.length, nUses: uses.length,
        sampleNoteheadHref: href,
        targetTag: tgt ? tgt.tagName : null,
        targetParentChain: chain,
        allDefs,
      };
    },
    /* REAL-PATH latency probe on the sonata: is serialize byte-stable for
       unchanged content, and does a real model edit splice or full-render? */
    reallatency() {
      const C = S.C;
      const m = C.model;
      const ser = () => m.serialize({ hejiEnabled: m.getHejiEnabled() }, null);
      /* 1. determinism: serialize twice, no edit. */
      const a = ser(), b = ser();
      const detEqual = a === b;
      /* per-measure dirty count between two no-edit serializes */
      const measuresOf = (mei) => {
        const d = new DOMParser().parseFromString(mei, 'application/xml');
        const sx = new XMLSerializer();
        return Array.from(d.querySelector('section').children)
          .filter((c) => c.localName === 'measure')
          .map((mm) => ({ id: mm.getAttribute('xml:id') || mm.getAttribute('id'), sig: sx.serializeToString(mm) }));
      };
      const ma = measuresOf(a), mb = measuresOf(b);
      let dirtyNoEdit = 0;
      for (let i = 0; i < Math.min(ma.length, mb.length); i++) if (ma[i].sig !== mb[i].sig) dirtyNoEdit++;

      /* 2. real edit (append at past-end) + real reRender path. */
      const svgRef = document.querySelector('#score svg');
      const meiBefore = ser();
      m.setCursor(m.getVoiceLength(1), 1);
      const id = m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      const meiAfter = ser();
      /* dirty-run size between before/after (prefix+suffix by sig) */
      const A = measuresOf(meiBefore), Bm = measuresOf(meiAfter);
      let P = 0; while (P < Math.min(A.length, Bm.length) && A[P].id === Bm[P].id && A[P].sig === Bm[P].sig) P++;
      let Sx = 0; while (Sx < Math.min(A.length, Bm.length) - P && A[A.length - 1 - Sx].id === Bm[Bm.length - 1 - Sx].id && A[A.length - 1 - Sx].sig === Bm[Bm.length - 1 - Sx].sig) Sx++;
      const dirtyRun = (Bm.length - Sx) - P;
      /* what changed in the FIRST (untouched) measure? */
      let firstDiff = null;
      if (A[0].sig !== Bm[0].sig) {
        let k = 0; while (k < A[0].sig.length && A[0].sig[k] === Bm[0].sig[k]) k++;
        firstDiff = {
          idBefore: A[0].id, idAfter: Bm[0].id,
          divergeAt: k,
          before: A[0].sig.slice(Math.max(0, k - 20), k + 60),
          after: Bm[0].sig.slice(Math.max(0, k - 20), k + 60),
        };
      }
      const t0 = performance.now();
      C.reRender();
      const reRenderMs = r2(performance.now() - t0);
      const svgSame = document.querySelector('#score svg') === svgRef;

      return {
        phase: 'reallatency',
        serializeDeterministic: detEqual,
        dirtyMeasuresWithNoEdit: dirtyNoEdit,
        totalMeasures: ma.length,
        editApplied: id !== null,
        voiceLen: m.getVoiceLength(1),
        dirtyRunMeasures: dirtyRun,
        measuresBefore: A.length, measuresAfter: Bm.length,
        reRenderMs,
        svgNotReplaced: svgSame,   // false ⇒ full re-engrave happened (the bug)
        firstMeasureDiff: firstDiff,
      };
    },
    /* Reproduce Max's case: delete a note mid-score, measure latency, inspect SVG. */
    realdelete() {
      const C = S.C, m = C.model;
      const ser = () => m.serialize({ hejiEnabled: m.getHejiEnabled() }, null);
      const measuresOf = (mei) => {
        const d = new DOMParser().parseFromString(mei, 'application/xml');
        const sx = new XMLSerializer();
        return Array.from(d.querySelector('section').children).filter((c) => c.localName === 'measure')
          .map((mm) => ({ id: mm.getAttribute('xml:id') || mm.getAttribute('id'), sig: sx.serializeToString(mm) }));
      };
      const svgRef = document.querySelector('#score svg');
      const meiBefore = ser();
      m.setCursor(100, 1);
      const tDel = performance.now();
      const deleted = m.deleteAtCursor();
      const deleteMs = r2(performance.now() - tDel);   // where normalizeTies runs
      const meiAfter = ser();
      const A = measuresOf(meiBefore), B = measuresOf(meiAfter);
      let P = 0; while (P < Math.min(A.length, B.length) && A[P].id === B[P].id && A[P].sig === B[P].sig) P++;
      let Sx = 0; while (Sx < Math.min(A.length, B.length) - P && A[A.length - 1 - Sx].id === B[B.length - 1 - Sx].id && A[A.length - 1 - Sx].sig === B[B.length - 1 - Sx].sig) Sx++;
      const dirtyRun = (B.length - Sx) - P;

      const t0 = performance.now();
      C.renderer.renderComposer(m, null);
      const renderComposerMs = r2(performance.now() - t0);
      const t1b = performance.now();
      C.reRender();
      const fullReRenderMs = r2(performance.now() - t1b);
      const reRenderMs = renderComposerMs;

      const mEls = Array.from(document.querySelectorAll('#score g.measure'));
      const ids = mEls.map((x) => x.id);
      const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
      const lefts = mEls.map((x) => r2(x.getBoundingClientRect().left));
      let nonMono = 0, firstNonMono = -1;
      for (let i = 1; i < lefts.length; i++) if (lefts[i] < lefts[i - 1] - 1) { nonMono++; if (firstNonMono < 0) firstNonMono = i; }

      /* scroll to the edited measure for the screenshot */
      const editId = B[Math.max(0, P)] && B[Math.max(0, P)].id;
      const el = editId ? document.getElementById(editId) : null;
      const score = document.getElementById('score');
      if (el) score.scrollLeft = (score.scrollLeft + el.getBoundingClientRect().left) - 400;

      return {
        phase: 'realdelete', deleted, deleteMs, dirtyRun, dirtyRunStartP: P,
        renderComposerMs, fullReRenderMs, postRenderOverheadMs: r2(fullReRenderMs),
        reRenderMs, svgNotReplaced: svgRef === document.querySelector('#score svg'),
        measureCount: mEls.length, expectedMeasureCount: B.length,
        duplicateIdCount: dup.length, dupSample: dup.slice(0, 6),
        nonMonotonicX: nonMono, firstNonMonoIdx: firstNonMono,
        leftsAroundEdit: lefts.slice(Math.max(0, P - 2), P + 6),
      };
    },
    /* Time the O(total) pieces of one edit on the sonata. */
    breakdown() {
      const C = S.C, m = C.model;
      const mei = m.serialize({ hejiEnabled: m.getHejiEnabled() }, null);
      const time = (fn) => { const t = performance.now(); const v = fn(); return [r2(performance.now() - t), v]; };

      const [tSerialize] = time(() => m.serialize({ hejiEnabled: m.getHejiEnabled() }, null));
      const [tParse, doc] = time(() => new DOMParser().parseFromString(mei, 'application/xml'));
      const section = doc.querySelector('section');
      const meiMeasures = Array.from(section.children).filter((c) => c.localName === 'measure');
      const ser = new XMLSerializer();
      const [tPerMeasureSig] = time(() => { for (const mm of meiMeasures) ser.serializeToString(mm); });
      const [tClone] = time(() => doc.cloneNode(true));
      const [tStringSplit] = time(() => mei.split('</measure>'));
      const [tFullSerializeReparse] = time(() => new XMLSerializer().serializeToString(doc));
      return {
        phase: 'breakdown', meiBytes: mei.length, nMeasures: meiMeasures.length,
        tSerialize, tParse, tPerMeasureSig, tCloneWholeDoc: tClone, tStringSplit, tFullSerialize: tFullSerializeReparse,
      };
    },
    /* Does getElementById resolve xml:id in the live MEI doc? (determines whether
       expandForSpanners can resolve spanner endpoints in O(1) without an O(notes) map) */
    idtest() {
      const live = S.C.model.getDoc();
      const note = live.querySelector('note[xml\\:id]') || live.querySelector('note');
      const id = note ? (note.getAttribute('xml:id') || note.getAttribute('id')) : null;
      const viaGetById = id ? live.getElementById(id) : null;
      const slur = live.querySelector('slur');
      const startid = slur ? slur.getAttribute('startid') : null;
      return {
        sampleNoteId: id,
        getElementByIdWorks: !!viaGetById && viaGetById === note,
        viaGetByIdTag: viaGetById ? viaGetById.tagName : null,
        sampleSlurStartid: startid,
        startidResolves: startid ? !!live.getElementById(startid.replace('#', '')) : null,
      };
    },
    splice() { return { todo: 'splice' }; },
    latency() { return { todo: 'latency' }; },
    all() { return { todo: 'all' }; },
  };

  S.run = function run(phase) {
    const fn = PHASES[phase];
    if (!fn) return { __error: 'unknown phase ' + phase };
    return fn();
  };

  window.__spike = S;
})();
