// Is a delete + Ctrl+Z byte-identical at the MODEL level? (cb-noreflow2 showed
// the post-undo DOM matches a full render of the current doc within 4 units,
// so any geometry that didn't come back must be a document difference.)
const H = window.__hkl_composer;
const model = H.model, reRender = H.reRender;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 50) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
};
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
const ser = new XMLSerializer();
const snap = () => {
  const ms = model.allMeasures();
  return {
    ids: ms.map((m) => m.getAttribute('xml:id')),
    src: ms.map((m) => ser.serializeToString(m)),
    doc: model.serialize({ hejiEnabled: model.getHejiEnabled() }, null),
  };
};
const diff = (a, b) => {
  const out = { measures: a.src.length + '→' + b.src.length, docEqual: a.doc === b.doc, changed: [] };
  const n = Math.min(a.src.length, b.src.length);
  for (let i = 0; i < n && out.changed.length < 3; i++) {
    if (a.src[i] !== b.src[i]) {
      out.changed.push({
        idx: i, idA: a.ids[i], idB: b.ids[i],
        lenA: a.src[i].length, lenB: b.src[i].length,
        a: a.src[i].slice(0, 400), b: b.src[i].slice(0, 400),
      });
    }
  }
  out.changedCount = (() => { let c = 0; for (let i = 0; i < n; i++) if (a.src[i] !== b.src[i]) c++; return c; })();
  return out;
};
const undo = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));

const out = { cycles: [] };
const MI = 100;
for (let c = 1; c <= 2; c++) {
  const before = snap();
  model.setCursor(model.getMeasureStartCursor(1, MI), 1);
  const cursorFlat = model.getCursor ? model.getCursor(1) : null;
  const okEdit = model.deleteAtCursor() !== false;
  reRender();
  await waitFor(badgeHidden);
  const mid = snap();
  undo();
  await waitFor(badgeHidden);
  await sleep(60);
  const after = snap();
  out.cycles.push({
    cycle: c, okEdit, cursorFlat,
    editChangedMeasures: diff(before, mid).changedCount,
    editMeasureCount: before.src.length + '→' + mid.src.length,
    undoRoundTrip: diff(before, after),
  });
}
return out;
