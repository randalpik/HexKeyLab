// Is the line partition INVARIANT under zoom in page view?
//
// The A4 cache keys on (zoom, pageScale, heji). The zoom-round-trip probe found
// zoom 50 and zoom 100 producing an identical partition via two INDEPENDENT
// castoffs, which would mean zoom is pure magnification (buildOptions scales the
// page rectangle by the same factor as the content) and could leave the key —
// making even the FIRST zoom change skip the castoff.
//
// This forces a real castoff at every zoom preset and at two page scales, and
// hashes the resulting partition. Decisive either way:
//   - all zooms equal, page scales differ  → zoom can leave the key
//   - any zoom differs                     → zoom must stay
const H = window.__hkl_composer;
const r = H.renderer, model = H.model, reRender = H.reRender;
const pb = r['pageBreaks'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 120000, step = 60) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };

const out = { errs: [] };
const oe = console.error; console.error = (...a) => { out.errs.push(a.join(' ').slice(0, 200)); oe(...a); };
out.adopted = await waitFor(() => pb['startIds'] !== null, 120000, 200);
if (!out.adopted) { console.error = oe; return out; }

const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h; };

/* Force a genuine castoff by emptying the renderer's partition cache before
   each measurement, so no reading is a cache hit. */
const measure = async (label, zoom, pageScale) => {
  r['partitionCache'].clear();
  let castoffs = 0;
  const origAdopt = pb.adoptFromCastoff.bind(pb);
  pb.adoptFromCastoff = (...a) => { castoffs++; return origAdopt(...a); };
  r.setPageScale(pageScale);
  r.setZoom(zoom);
  r['forceFullRerender']();
  reRender();
  await waitFor(badgeHidden, 120000, 40);
  pb.adoptFromCastoff = origAdopt;
  const lines = pb.lineStarts();
  return {
    label, zoom, pageScale,
    castoffRan: castoffs > 0,
    lines: lines.length,
    pages: pb.pageStarts().length,
    partitionHash: hash(lines.join('|')),
  };
};

out.z50 = await measure('zoom 50', 50, 1);
out.z75 = await measure('zoom 75', 75, 1);
out.z100 = await measure('zoom 100', 100, 1);
out.z100_scale140 = await measure('zoom 100, pageScale 1.4', 100, 1.4);

out.verdict = {
  allCastoffsRan: [out.z50, out.z75, out.z100, out.z100_scale140].every((x) => x.castoffRan),
  zoomInvariant: out.z50.partitionHash === out.z75.partitionHash
    && out.z75.partitionHash === out.z100.partitionHash,
  pageScaleMatters: out.z100.partitionHash !== out.z100_scale140.partitionHash,
  lines: {
    z50: out.z50.lines, z75: out.z75.lines, z100: out.z100.lines,
    scale140: out.z100_scale140.lines,
  },
};

/* Restore. */
r.setPageScale(1);
r.setZoom(100);
r['forceFullRerender']();
reRender();
await waitFor(badgeHidden, 120000, 40);
console.error = oe;
return out;
