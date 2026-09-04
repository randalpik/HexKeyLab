// Preconditions for docs/composer-staff-quantization-plan.md, verified BEFORE
// any code is written (plan §5). Four questions:
//   P1 the page-margin origin sits at a KNOWN device phase, across zoom/pageScale
//      (step 1's arithmetic replaces a per-staff getScreenCTM with y-only maths)
//   P2 all g.staff of ONE staff ROW in a system share a phase (measureExtents
//      reads only the first measure's staves; the snap touches every measure's)
//   P3 barline phases (baseline, to compare after the change)
//   P4 section-header band geometry (baseline)
const H = window.__hkl_composer; const r = H.renderer;
const pb = r['pageBreaks'];
const container = document.getElementById('score');
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
const waitFor = async (fn, ms = 90000, step = 20) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
await waitFor(() => pb['startIds'] !== null, 120000, 100);
await waitFor(badgeHidden, 90000, 40);
for (let i = 0; i < 3 && !pb.ownershipActive(); i++) { H.reRender(); await waitFor(badgeHidden, 60000, 30); }

const frac = (x) => +(((x % 1) + 1) % 1).toFixed(4);
const out = { P1: [], P2: [], P3: [], P4: [] };

/* ── P1: margin origin phase + scale exactness, per zoom × pageScale ── */
for (const z of [100, 75, 50]) {
  for (const ps of [1, 1.4]) {
    r.setZoom(z); r.setPageScale(ps);
    H.reRender(); await waitFor(badgeHidden, 90000, 40);
    for (let i = 0; i < 2 && !pb.ownershipActive(); i++) { H.reRender(); await waitFor(badgeHidden, 60000, 30); }
    const rows = [];
    for (const pgEl of Array.from(container.querySelectorAll('.score-page:not(.score-page-pending)')).slice(0, 4)) {
      const margin = pgEl.querySelector('svg g.page-margin');
      if (!margin) continue;
      const ctm = margin.getScreenCTM ? margin.getScreenCTM() : null;
      if (!ctm) continue;
      rows.push({ page: +pgEl.dataset.page, dsCtm: +ctm.d.toFixed(6), originFrac: frac(ctm.f) });
    }
    out.P1.push({ zoom: z, pageScale: ps, expectedDs: +(z / 1000).toFixed(6), pages: rows,
      originFracs: [...new Set(rows.map((x) => x.originFrac))] });
  }
}
r.setZoom(100); r.setPageScale(1);
H.reRender(); await waitFor(badgeHidden, 90000, 40);
for (let i = 0; i < 2 && !pb.ownershipActive(); i++) { H.reRender(); await waitFor(badgeHidden, 60000, 30); }

/* ── P2/P3/P4 on a RAW (unsnapped) render, which is what step 1 must correct ── */
const ctx = r['pageSpliceCtx']();
const mei = r['pinnedMeiForCurrentModel']();
ctx.toolkit.setOptions(ctx.liveOptions());
if (mei && ctx.toolkit.loadData(mei)) {
  for (const pn of [2, 9, 23]) {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden';
    host.innerHTML = ctx.toolkit.renderToSVG(pn, {});
    document.body.appendChild(host);
    r['postProcessRendered'](host);          /* NO snap: raw phases */
    const sysRows = [];
    Array.from(host.querySelectorAll('g.system')).forEach((sy, si) => {
      /* group every g.staff by its staff-row y (rounded), collect phases */
      const byRow = new Map();
      for (const st of Array.from(sy.querySelectorAll('g.staff'))) {
        let line = null;
        for (const p of Array.from(st.querySelectorAll(':scope > path'))) {
          let h = Infinity; try { h = p.getBBox().height; } catch (e) { continue; }
          if (h < 1) { line = p; break; }
        }
        if (!line) continue;
        const ctm = line.getScreenCTM(); if (!ctm) continue;
        const devY = ctm.f + line.getBBox().y * ctm.d;
        const key = Math.round(line.getBBox().y / 10) * 10;
        if (!byRow.has(key)) byRow.set(key, []);
        byRow.get(key).push(frac(devY));
      }
      const rows = [...byRow.entries()].map(([y, phases]) => ({
        rowY: y, n: phases.length, distinct: [...new Set(phases)].length, phases: [...new Set(phases)].slice(0, 4),
      }));
      sysRows.push({ sys: si, rows });
    });
    out.P2.push({ page: pn, systems: sysRows,
      anyRowWithMixedPhase: sysRows.some((s) => s.rows.some((x) => x.distinct > 1)) });
    /* P3 barlines */
    const bl = [];
    for (const b of Array.from(host.querySelectorAll('g.barLine path')).slice(0, 8)) {
      const ctm = b.getScreenCTM(); if (!ctm) continue;
      let bb; try { bb = b.getBBox(); } catch (e) { continue; }
      bl.push(frac(ctm.e + bb.x * ctm.a));
    }
    out.P3.push({ page: pn, barlineXPhases: [...new Set(bl)] });
    host.remove();
  }
}
/* ── P4: header bands on live pages ── */
for (const pgEl of Array.from(container.querySelectorAll('.score-page:not(.score-page-pending)')).slice(0, 3)) {
  const margin = pgEl.querySelector('svg g.page-margin');
  const hd = margin ? margin.querySelector(':scope > g.pgHead') : null;
  let bb = null; if (hd) { try { bb = hd.getBBox(); } catch (e) {} }
  out.P4.push({ page: +pgEl.dataset.page, hasHead: !!hd, headBottom: bb ? +(bb.y + bb.height).toFixed(2) : null,
    titles: margin ? margin.querySelectorAll(':scope > text[data-for]').length : 0 });
}
return out;
