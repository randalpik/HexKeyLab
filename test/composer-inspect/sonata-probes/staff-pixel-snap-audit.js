// THE VISUAL QUESTION: is every staff on a live page actually snapped to the
// device-pixel grid? A staff off its target phase renders blurred, which is the
// whole reason snapping exists. Audits every g.staff of every mounted page and
// reports any that is off-phase, before and after an edit.
// Args: --arg "line=15"
const H = window.__hkl_composer; const r = H.renderer, model = H.model, reRender = H.reRender;
const pb = r['pageBreaks'], ps = r['pageSplicer'];
const container = document.getElementById('score');
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
const waitFor = async (fn, ms = 90000, step = 20) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const args = {}; for (const kv of String(window.__probeArg ?? '').split(',')) { const [k, v] = kv.split('='); if (k) args[k.trim()] = v === undefined ? '1' : v.trim(); }
await waitFor(() => pb['startIds'] !== null, 120000, 100);
await waitFor(badgeHidden, 90000, 40);
for (let i = 0; i < 3 && !pb.ownershipActive(); i++) { reRender(); await waitFor(badgeHidden, 60000, 30); }

const preset = { scale: 0, evenWidth: false };
try { const p = r['currentScale'] ? r['currentScale']() : 0; preset.scale = p; } catch (e) {}
const frac = (x) => ((x % 1) + 1) % 1;
/* the target phase a staff line must sit on: ½px for a 1px stroke, 0 for 2px */
const audit = () => {
  const bad = [];
  let total = 0;
  for (const pgEl of Array.from(container.querySelectorAll('.score-page:not(.score-page-pending)'))) {
    const pn = +pgEl.dataset.page;
    Array.from(pgEl.querySelectorAll('g.system')).forEach((sy, si) => {
      Array.from(sy.querySelectorAll('g.staff')).forEach((st) => {
        let line = null;
        for (const p of Array.from(st.querySelectorAll(':scope > path'))) {
          let h = Infinity; try { h = p.getBBox().height; } catch (e) { continue; }
          if (h < 1) { line = p; break; }
        }
        if (!line) return;
        const ctm = line.getScreenCTM(); if (!ctm) return;
        let bb; try { bb = line.getBBox(); } catch (e) { return; }
        const devY = ctm.f + bb.y * ctm.d;
        const w = +(line.getAttribute('stroke-width') || 0);
        const strokeDev = w * ctm.d;
        const even = Math.abs(strokeDev - Math.round(strokeDev)) < 0.01 && Math.round(strokeDev) % 2 === 0;
        const target = even ? 0 : 0.5;
        const ph = frac(devY);
        let d = frac(target - ph); if (d > 0.5) d -= 1;
        total++;
        if (Math.abs(d) > 0.02) {
          bad.push({ page: pn, sys: si, measure: (st.closest('g.measure') || {}).id?.slice(-8) || null,
            phase: +ph.toFixed(3), target, off: +d.toFixed(3), strokeDev: +strokeDev.toFixed(3) });
        }
      });
    });
  }
  return { total, offGrid: bad.length, sample: bad.slice(0, 12),
    pages: [...new Set(bad.map((b) => b.page))] };
};

const out = { beforeEdit: audit() };
const LINE = Math.max(1, Number(args.line ?? 15));
const ids = model.allMeasures().map((x) => x.getAttribute('xml:id'));
const mi = ids.indexOf(pb['startIds'][LINE]);
if (mi >= 0) {
  const cur = model.getFirstVisualCursorInMeasure(1, mi + 1, 'overwrite');
  if (cur >= 0) {
    model.setCursor(cur, 1);
    if (model.deleteAtCursor()) {
      reRender(); await waitFor(badgeHidden, 60000, 30);
      out.outcome = ps.lastOutcome;
      out.afterEdit = audit();
    }
  }
}
return out;
