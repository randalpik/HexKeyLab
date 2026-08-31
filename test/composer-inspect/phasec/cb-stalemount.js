// Does a page mounted AFTER a system splice draw the edited document?
// A splice edits the mounted pages in place without re-loading the toolkit, so
// before the pageVirt.stale fix a lazily-mounted page rendered PRE-EDIT
// content. Edits a measure on a page that is NOT mounted-and-visible, then
// mounts that page fresh and checks the rendered notes against the model.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model;
const pb = r['pageBreaks'];
const ps = r['pageSplicer'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 50) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const out = {};
out.adopted = await waitFor(() => pb['startIds'] !== null, 60000, 200);
if (!out.adopted) return out;

const st = () => r['pageVirt'];
const del = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));

/* Pick a measure on a page well past the viewport, mount that page so the
   edit can splice, edit it, then UNMOUNT it (rebuild the placeholder) and
   mount it again from the toolkit — the lazy-mount path. */
const ids = model.allMeasures().map((m) => m.getAttribute('xml:id'));
const MI = 120;
const targetId = ids[MI];
r['ensureTkHoldsPageLayout']();
const page = r['tk'].getPageWithElement(targetId);
out.page = page;
/* Mount the target page AND its neighbours: the splice needs every changed
   and context line mounted (context lines can sit on the previous page). */
for (const p of [page - 1, page, page + 1]) if (p >= 1) r['mountPage'](p);
await sleep(50);
/* First edit in a region may still fall back (e.g. a spanner-closed run
   reaching an unmounted page); do a warm-up edit + undo so the second is the
   steady-state one we want to observe. */
{
  const c0 = model.getFirstVisualCursorInMeasure(1, MI, 'overwrite');
  model.setCursor(c0, 1);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
  await waitFor(badgeHidden);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  await waitFor(badgeHidden);
  out.warmup = { outcome: ps.lastOutcome, skip: ps.lastSkipReason };
}

/* Notes rendered in the target measure BEFORE the edit. */
const renderedNotes = () => {
  const el = document.querySelector('#' + CSS.escape(targetId));
  return el ? el.querySelectorAll('g.note').length : -1;
};
const modelNotes = () => {
  const m = model.allMeasures()[MI];
  return m ? m.querySelectorAll('note').length : -1;
};
out.before = { rendered: renderedNotes(), model: modelNotes() };

const cur = model.getFirstVisualCursorInMeasure(1, MI, 'overwrite');
model.setCursor(cur, 1);
del();
await waitFor(badgeHidden);
out.spliceOutcome = ps.lastOutcome;
out.spliceSkip = ps.lastSkipReason;
out.staleFlag = st() ? st().stale : null;
out.afterEdit = { rendered: renderedNotes(), model: modelNotes() };

/* Force the page back to a placeholder and re-mount it via the normal path. */
const div = document.querySelector('#score .score-page[data-page="' + page + '"]');
div.innerHTML = '';
div.classList.add('score-page-pending');
div.style.width = st().pageW + 'px';
div.style.height = st().pageH + 'px';
st().mounted.delete(page);
const t0 = performance.now();
r['mountPage'](page);
out.remountMs = Math.round(performance.now() - t0);
await sleep(50);
out.afterRemount = { rendered: renderedNotes(), model: modelNotes() };
out.ok = out.afterRemount.rendered === out.afterRemount.model
  && out.afterRemount.rendered === out.afterEdit.rendered;
return out;
