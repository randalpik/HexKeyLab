// The probe that found the clef-propagation bug (2026-09-01). Builds the
// `pageSystemSpliceRelocatedClef` document (run with --no-sonata), sets a clef
// after the first chord of a line-start measure, renders, then deletes that
// chord (making the clef measure-initial, so `relocateInitialClefs` moves it
// onto the line above) and renders again. Reports, per system of page 1: the
// live staff tops BEFORE and AFTER the edit, the splicer's vertical plan, and a
// fresh full-render REFERENCE of the same model — with each system's height and
// clef glyph codepoints, so a wrong-clef line reads as `E062` where `E050` is
// expected and a +960 height. Pre-fix the PRE-edit page already disagreed with
// the reference (lines after the clef still in G): the incremental path had
// re-engraved only the clef's own line. Now the clef insertion derives.
const H = window.__hkl_composer; const m = H.model, r = H.renderer, reRender = H.reRender;
const pb = r['pageBreaks'], ps = r['pageSplicer'];
const V = window.verovio;
const container = document.getElementById('score');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 60000, step = 40) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const errs = []; const oe = console.error; console.error = (...a) => { errs.push(a.join(' ').slice(0, 300)); oe(...a); };
const out = { errs };
const heji = { hejiEnabled: m.getHejiEnabled() };
m.setCursor(0, 1);
const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
for (let i = 0; i < 200; i++) { const high = (Math.floor(i / 4) % 2) === 0; m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 }); }
reRender(); await waitFor(badgeHidden);
for (let i = 0; i < 3 && !pb.ownershipActive(); i++) { reRender(); await waitFor(badgeHidden); }
out.owned = pb.ownershipActive();
let startIds = pb['startIds'];
let ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
const mi = ids.indexOf(startIds[3]);
out.mi = mi;
out.setClef = m.setClefAtCursor(1, m.getMeasureStartCursor(1, mi) + 1, 'F', '4', null, null);
const layerKids = (k) => Array.from(m.allMeasures()[k].querySelector('staff[n="1"] > layer').children).map((c) => c.localName).join(',');
out.layerAfterSet = { [mi - 1]: layerKids(mi - 1), [mi]: layerKids(mi) };
reRender(); await waitFor(badgeHidden);
for (let i = 0; i < 3 && !pb.ownershipActive(); i++) { reRender(); await waitFor(badgeHidden); }
startIds = pb['startIds']; ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
out.lineOfMi = startIds.indexOf(ids[mi]);
out.pageStarts = pb.pageStarts().map((id) => startIds.indexOf(id));
const consolidate = (el) => { const b = el.transform && el.transform.baseVal && el.transform.baseVal.consolidate ? el.transform.baseVal.consolidate() : null; return b ? { tx: b.matrix.e, ty: b.matrix.f } : { tx: 0, ty: 0 }; };
const tops = (root) => Array.from(root.querySelectorAll('g.system')).map((sys) => {
  const t = consolidate(sys); const ms = Array.from(sys.querySelectorAll('g.measure'));
  const staff = ms[0] && ms[0].querySelector(':scope > g.staff'); const st = staff ? consolidate(staff) : { ty: 0 };
  let top = Infinity; if (staff) for (const p of Array.from(staff.querySelectorAll(':scope > path'))) { const b = p.getBBox(); if (b.y < top) top = b.y; }
  const box = sys.getBBox();
  return { first: ms[0] && ms[0].id, n: ms.length, staffTop: +(top + st.ty + t.ty).toFixed(1), bboxTop: +(box.y + t.ty).toFixed(1), bboxBot: +(box.y + box.height + t.ty).toFixed(1), h: +box.height.toFixed(1),
    clefs: ms.map((mm) => Array.from(mm.querySelectorAll('g.clef use')).map((u) => (u.getAttribute('xlink:href') || u.getAttribute('href') || '').replace(/^#/, '').split('-')[0]).join(' ')).join(' | ') };
});
const page1 = () => container.querySelector('.score-page[data-page="1"]');
out.preTops = tops(page1());
/* the edit */
m.setCursor(m.getMeasureStartCursor(1, mi), 1);
const ver = m.docVersion();
out.deleted = m.deleteAtCursor(); out.changed = m.docVersion() !== ver;
out.layerAfterDelete = { [mi - 1]: layerKids(mi - 1), [mi]: layerKids(mi) };
reRender(); await waitFor(badgeHidden);
out.outcome = ps.lastOutcome; out.skip = ps.lastSkipReason; out.run = ps.lastRun; out.window = ps.lastWindow; out.pages = ps.lastPages;
out.plan = ps.lastVertical ? { static: ps.lastVertical.static, dyFollow: +ps.lastVertical.dyFollow.toFixed(1), followId: ps.lastVertical.followId, liveTop: ps.lastVertical.liveTop.map((v) => +v.toFixed(1)), newTop: ps.lastVertical.newTop.map((v) => +v.toFixed(1)), startIds: ps.lastVertical.startIds } : null;
out.postTops = tops(page1());
/* reference */
const lb = await import('/composer/src/render/linebreaks.ts');
const refMei = lb.injectPins(m.serialize(heji, null), pb['startIds'], new Set(pb.pageStarts()));
const tk = new V.toolkit(); tk.setOptions(r['buildOptions'](pb.paginationOwned() ? 'encoded' : 'line', 'page'));
tk.loadData(refMei); out.refPages = tk.getPageCount();
const host = document.createElement('div'); host.style.cssText = 'position:absolute;left:-99999px;top:0'; host.innerHTML = tk.renderToSVG(1, {}); document.body.appendChild(host);
out.refTops = tops(host);
out.compare = out.postTops.map((p, i) => { const q = out.refTops[i]; return q ? { i, first: p.first.slice(0, 9), dStaffTop: +(p.staffTop - q.staffTop).toFixed(1), dH: +(p.h - q.h).toFixed(1), liveClefs: p.clefs, refClefs: q.clefs } : { i, first: p.first, missingInRef: true }; });
host.remove(); console.error = oe;
return out;
