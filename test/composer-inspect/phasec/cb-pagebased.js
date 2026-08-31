// Decisive check: does the partition read from page-based getMEI EQUAL the one
// the SVG walk produces? If so, adoption stops costing a ~2 s page-by-page
// render walk and becomes one ~110 ms synchronous call — which in turn makes it
// affordable to adopt AND re-render 'encoded' in the same block, so the user
// never sees the castoff render's spacing at all (Max: "force Verovio to always
// use the same break algorithm we are").
const H = window.__hkl_composer;
const r = H.renderer, model = H.model;
const pb = r['pageBreaks'];
const V = window.verovio;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 150) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const out = {};
out.adopted = await waitFor(() => pb['startIds'] !== null, 60000, 200);
if (!out.adopted) return out;
const lb = await import('/composer/src/render/linebreaks.ts');

const mei = model.serialize({ hejiEnabled: model.getHejiEnabled() }, null);
const base = r['buildOptions']('auto');
const patch = (xml) => (/xmlns:hkl=/.test(xml) ? xml : xml.replace(/<mei\s/, '<mei xmlns:hkl="http://www.hexkeylab.org/ns" '));

/* ── the castoff pass (what a derive render loads today) ── */
const tk = new V.toolkit();
tk.setOptions({ ...base, breaks: 'smart', breaksSmartSb: 0 });
let t = performance.now();
if (!tk.loadData(mei)) return { error: 'castoff loadData failed' };
out.castoffLoadMs = Math.round(performance.now() - t);

/* ── A: today's adoption — render every page to SVG and read system starts ── */
t = performance.now();
const walkLines = [], walkPages = [];
for (let p = 1; p <= tk.getPageCount(); p++) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0';
  host.innerHTML = tk.renderToSVG(p, {});
  document.body.appendChild(host);
  try {
    const starts = [];
    for (const sys of host.querySelectorAll('g.system')) {
      const m = sys.querySelector('g.measure');
      if (m && m.id) starts.push(m.id);
    }
    if (starts.length) walkPages.push(starts[0]);
    walkLines.push(...starts);
  } finally { host.remove(); }
}
out.svgWalkMs = Math.round(performance.now() - t);

/* ── B: page-based getMEI ── */
t = performance.now();
const xml = tk.getMEI({ scoreBased: false });
const getMs = performance.now() - t;
t = performance.now();
const doc = new DOMParser().parseFromString(patch(xml), 'application/xml');
const parseMs = performance.now() - t;
const perr = doc.querySelector('parsererror');
if (perr) return { ...out, error: 'parse: ' + perr.textContent.slice(0, 160) };
t = performance.now();
const meiLines = [], meiPages = [];
for (const page of Array.from(doc.getElementsByTagNameNS('*', 'page'))) {
  let firstOfPage = null;
  for (const sys of Array.from(page.getElementsByTagNameNS('*', 'system'))) {
    const m = sys.getElementsByTagNameNS('*', 'measure')[0];
    const id = m ? m.getAttribute('xml:id') : null;
    if (!id) continue;
    meiLines.push(id);
    if (!firstOfPage) firstOfPage = id;
  }
  if (firstOfPage) meiPages.push(firstOfPage);
}
const readMs = performance.now() - t;
out.getMeiPath = {
  getMeiMs: Math.round(getMs), parseMs: Math.round(parseMs), readMs: Math.round(readMs),
  totalMs: Math.round(getMs + parseMs + readMs),
};
out.speedup = +(out.svgWalkMs / (getMs + parseMs + readMs)).toFixed(1);

out.counts = { walk: { lines: walkLines.length, pages: walkPages.length },
               getMei: { lines: meiLines.length, pages: meiPages.length } };
out.linesIdentical = walkLines.join() === meiLines.join();
out.pagesIdentical = walkPages.join() === meiPages.join();
if (!out.linesIdentical) {
  for (let i = 0; i < Math.max(walkLines.length, meiLines.length); i++) {
    if (walkLines[i] !== meiLines[i]) { out.firstLineDiff = { i, walk: walkLines[i] ?? null, getMei: meiLines[i] ?? null }; break; }
  }
}

/* ── C: end-to-end — pin THAT partition and render encoded; does it reproduce
       the partition and pagination it claims? ── */
if (out.linesIdentical && out.pagesIdentical) {
  const pinned = lb.injectPins(mei, meiLines, new Set(meiPages));
  if (!pinned) { out.encodedCheck = { error: 'pin injection failed' }; }
  else {
    const tk2 = new V.toolkit();
    tk2.setOptions({ ...base, breaks: 'encoded' });
    t = performance.now();
    const ok = tk2.loadData(pinned);
    const encLoadMs = Math.round(performance.now() - t);
    if (!ok) out.encodedCheck = { error: 'encoded loadData failed' };
    else {
      const encLines = [], encPages = [];
      for (let p = 1; p <= tk2.getPageCount(); p++) {
        const host = document.createElement('div');
        host.style.cssText = 'position:absolute;left:-99999px;top:0';
        host.innerHTML = tk2.renderToSVG(p, {});
        document.body.appendChild(host);
        try {
          const starts = [];
          for (const sys of host.querySelectorAll('g.system')) {
            const m = sys.querySelector('g.measure');
            if (m && m.id) starts.push(m.id);
          }
          if (starts.length) encPages.push(starts[0]);
          encLines.push(...starts);
        } finally { host.remove(); }
      }
      out.encodedCheck = {
        encLoadMs, pages: tk2.getPageCount(),
        linesMatch: encLines.join() === meiLines.join(),
        pagesMatch: encPages.join() === meiPages.join(),
      };
      out.projectedLoad = {
        todayFirstPaintMs: out.castoffLoadMs,
        todayIdleWalkMs: out.svgWalkMs,
        newFirstPaintMs: out.castoffLoadMs + out.getMeiPath.totalMs + encLoadMs,
        newIdleWalkMs: 0,
      };
    }
  }
}
return out;
