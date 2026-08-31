// Settles "how does zoom change the line count?" and gates the layout-input
// cache key.
//
// Mechanism (from the code): pageWidth is scaled by pageScale ONLY, never by
// zoom, and `unit` (staff half-space in MEI units) comes from the crisp preset.
// Verovio's `scale` is device magnification with NO layout effect, so
// measures-per-line is governed by pageWidth/unit. Presets are now a constant
// unit 8 at scales 50/75/100 (staff-space 8/12/16 px).
//
// SUPERSEDED EXPECTATIONS (2026-08-31): this probe was written when the crisp
// presets used unit 9 at 50/100 and unit 10 at 75, so zoom 75 re-broke the
// score (118 → 134 lines) and needed its own cache entry. The presets now use a
// CONSTANT unit 8 at scales 50/75/100, so the expectations are:
//   1. ALL zooms produce an IDENTICAL partition (116 lines on the sonata).
//   2. All zooms share ONE cache key, so every zoom change is a CACHE HIT and
//      no castoff runs (`switch_to_75_ranCastoff: false` is now CORRECT — the
//      field name is historical).
//   3. Wall time is uniform across switches (~730 ms), with no ~2.1 s outlier.
// Kept as the regression gate for zoom layout-neutrality: if `zoom75_differs`
// ever goes true again, a preset has reintroduced a per-zoom `unit`.
//
// Unlike the earlier cb-zoominvariant probe, this waits for ADOPTION to
// complete before reading the partition — that probe only waited for the busy
// badge, so a derive that fell back to the idle walk could be read mid-flight.
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
const oe = console.error; console.error = (...a) => { out.errs.push(a.join(' ').slice(0, 160)); oe(...a); };
out.adopted = await waitFor(() => pb['startIds'] !== null, 120000, 200);
if (!out.adopted) { console.error = oe; return out; }

const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h; };

let restores = 0, castoffs = 0;
const origRestore = pb.restorePartition.bind(pb);
pb.restorePartition = (...a) => { restores++; return origRestore(...a); };
const origAdopt = pb.adoptFromCastoff.bind(pb);
pb.adoptFromCastoff = (...a) => { castoffs++; return origAdopt(...a); };

/* One zoom/pageScale visit. `fresh` clears the cache first (forcing a real
   castoff) so the MECHANISM can be measured independently of the cache. */
const visit = async (label, zoom, pageScale, fresh) => {
  if (fresh) r['partitionCache'].clear();
  restores = 0; castoffs = 0;
  r.setPageScale(pageScale);
  r.setZoom(zoom);
  if (fresh) r['forceFullRerender']();
  const t0 = performance.now();
  reRender();
  await waitFor(badgeHidden, 120000, 40);
  /* THE FIX over cb-zoominvariant: wait for a partition to actually exist, and
     for any idle adoption walk to finish, before reading it. */
  await waitFor(() => pb['startIds'] !== null && pb['adoption'] === null, 60000, 100);
  const lines = pb.lineStarts();
  return {
    label, zoom, pageScale,
    key: r['partitionKey'](model),
    wallMs: Math.round(performance.now() - t0),
    castoffRan: castoffs > 0,
    cacheHit: restores > 0,
    lines: lines.length,
    pages: pb.pageStarts().length,
    partitionHash: hash(lines.join('|')),
  };
};

/* ── Part 1: the mechanism. Every visit forced fresh (real castoff). ── */
out.mechanism = {};
out.mechanism.z100 = await visit('fresh 100', 100, 1, true);
out.mechanism.z50 = await visit('fresh 50', 50, 1, true);
out.mechanism.z75 = await visit('fresh 75', 75, 1, true);
out.mechanism.z100_ps140 = await visit('fresh 100 @ pageScale 1.4', 100, 1.4, true);

out.mechanismVerdict = {
  allFreshRanCastoff: ['z100', 'z50', 'z75', 'z100_ps140']
    .every((k) => out.mechanism[k].castoffRan),
  /* 1. 50 and 100 share the unit → identical partition (always did) */
  zoom50_equals_zoom100: out.mechanism.z50.partitionHash === out.mechanism.z100.partitionHash,
  /* 2. MUST be false now: a constant unit makes every zoom identical */
  zoom75_differs: out.mechanism.z75.partitionHash !== out.mechanism.z100.partitionHash,
  lines: {
    z50: out.mechanism.z50.lines,
    z75: out.mechanism.z75.lines,
    z100: out.mechanism.z100.lines,
    z100_pageScale140: out.mechanism.z100_ps140.lines,
  },
  zoom75_lineIncreasePct: +(((out.mechanism.z75.lines / out.mechanism.z100.lines) - 1) * 100).toFixed(1),
  /* keys: with a constant unit, ALL zooms share one key */
  keys: {
    z50: out.mechanism.z50.key, z75: out.mechanism.z75.key,
    z100: out.mechanism.z100.key, z100_ps140: out.mechanism.z100_ps140.key,
  },
  zoom50_shares_key_with_zoom100: out.mechanism.z50.key === out.mechanism.z100.key,
  zoom75_sharesKey: out.mechanism.z75.key === out.mechanism.z100.key,
  pageScale_has_own_key: out.mechanism.z100_ps140.key !== out.mechanism.z100.key,
  /* pageScale: NOT exercised by this probe — the app's reRender path re-syncs
     pageScale from the model, so setPageScale here does not stick (both the key
     and the partition come back identical). It stays in the key on the
     conservative argument in partitionKey, not on this measurement. */
  pageScale_changes_partition:
    out.mechanism.z100_ps140.partitionHash !== out.mechanism.z100.partitionHash,
};

/* ── Part 2: the cache behaviour the key is supposed to produce. ── */
r.setPageScale(1);
r['partitionCache'].clear();
await visit('seed 100', 100, 1, true);           // seeds the single key u8|s1
out.cache = {};
out.cache.to50 = await visit('100 → 50 (same unit — cache expected)', 50, 1, false);
out.cache.to75 = await visit('… → 75 (same unit — cache expected)', 75, 1, false);
out.cache.back100 = await visit('… → 100 (cache expected)', 100, 1, false);

out.cacheVerdict = {
  switch_to_50_hitCache: out.cache.to50.cacheHit && !out.cache.to50.castoffRan,
  switch_to_75_hitCache: out.cache.to75.cacheHit && !out.cache.to75.castoffRan,
  switch_back_to_100_hitCache: out.cache.back100.cacheHit && !out.cache.back100.castoffRan,
  wall: { to50: out.cache.to50.wallMs, to75: out.cache.to75.wallMs, back100: out.cache.back100.wallMs },
};

r.setPageScale(1);
r.setZoom(100);
r['forceFullRerender']();
reRender();
await waitFor(badgeHidden, 120000, 40);
pb.restorePartition = origRestore;
pb.adoptFromCastoff = origAdopt;
console.error = oe;
return out;
