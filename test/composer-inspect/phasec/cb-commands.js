// Command inventory (2026-09-02): which USER COMMANDS splice and which derive.
//
// The refill is command-agnostic by design — it diffs the live document against
// its own per-measure signature baseline, so nothing needs per-path splice
// support. But nothing ASSERTED that a given command splices either, and two
// paths were found deriving silently on the same guard (`user breaks changed`):
// M insert-measure (Ctrl+M until 2026-09-11) and section headers. This probe fires every
// document-mutating command on the sonata from the same baseline and reports
// outcome + derive reason + wall, so the inventory is data instead of guesswork.
//
// Commands with a dialog are driven at the MODEL level (the mutation the dialog
// would commit); everything else goes through the real keydown path.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model, reRender = H.reRender;
const pb = r['pageBreaks'], ps = r['pageSplicer'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const waitFor = async (fn, ms = 90000, step = 15) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const badgeHidden = () => { const b = document.getElementById('renderBusy'); return !b || b.hidden; };
await waitFor(() => pb['startIds'] !== null, 120000, 100);
await waitFor(badgeHidden, 90000, 40);

const key = (k, mods = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...mods }));
const measures = () => model.allMeasures().length;
const MI = Math.max(0, Math.floor(measures() / 2));

/* Cursor onto a note in measure MI, voice 1 — the shared starting position. */
const park = () => {
  const cur = model.getFirstVisualCursorInMeasure(1, MI, 'overwrite');
  if (cur < 0) return false;
  model.setCursor(cur, 1);
  return true;
};
const mountAround = async () => {
  if (!r['ensureTkHoldsPageLayout']()) return;
  const ids = model.allMeasures().map((m) => m.getAttribute('xml:id'));
  const page = r['tk'].getPageWithElement(ids[Math.min(MI, ids.length - 1)]);
  for (const p of [page - 1, page, page + 1]) if (p >= 1) r['mountPage'](p);
  await sleep(60);
};

const mkNote = { q: 0, r: 0, pname: 'a', accid: '', oct: 3, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 };

/* Selection is INPUT state, not model state (input.ts `state.selection`), and
   it is entered by Shift+arrow: left/right = beat selection, up/down = measure
   selection. Drive the real keys. */
const selectBeat    = () => { key('ArrowRight', { shiftKey: true }); return true; };
const selectMeasure = () => { key('ArrowDown',  { shiftKey: true }); return true; };
const escape        = () => key('Escape');

/* `h` hides a REST, so the cursor has to be on one. Find the nearest measure to
   MI whose voice-1 layer holds a rest and park there. */
const parkOnRest = () => {
  const all = model.allMeasures();
  for (let d = 0; d < all.length; d++) {
    for (const mi of [MI + d, MI - d]) {
      if (mi < 0 || mi >= all.length) continue;
      if (!all[mi].querySelector('staff > layer > rest')) continue;
      const cur = model.getFirstVisualCursorInMeasure(1, mi, 'overwrite');
      if (cur < 0) continue;
      model.setCursor(cur, 1);
      /* Step right until the cursor's element IS the rest. */
      for (let k = 0; k < 24; k++) {
        const el = model.getCurrentElement(1, 'overwrite');
        if (el && el.localName === 'rest') return true;
        model.setCursor(model.getCursor(1) + 1, 1);
      }
    }
  }
  return false;
};

/* Clipboard: Ctrl+C/Ctrl+X only stage the text (input.ts keeps
   `pendingClipboardText`); the browser's copy/cut event carries it out, and
   paste arrives as a `paste` ClipboardEvent, never as Ctrl+V. So harvest the
   text through a real copy event and hand it back through a real paste event. */
let clip = null;
const harvest = (type) => {
  const dt = new DataTransfer();
  document.dispatchEvent(new ClipboardEvent(type, { clipboardData: dt, bubbles: true, cancelable: true }));
  const text = dt.getData('text/plain');
  if (text) clip = text;
  return text;
};
const pasteClip = () => {
  if (!clip) return false;
  const dt = new DataTransfer();
  dt.setData('text/plain', clip);
  document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  return true;
};
/* Stage a measure copy from measure MI, then park the cursor two measures on so
   the paste lands somewhere else. */
const stageMeasureCopy = () => {
  if (!park()) return false;
  selectMeasure();
  key('c', { ctrlKey: true });
  const text = harvest('copy');
  escape();
  return !!text;
};

/* Each case: how to mutate. `viaKey` goes through the real handler (which
   re-renders itself); a `model` case mutates then re-renders explicitly. */
const CASES = [
  { name: 'delete-note (Backspace)',    kind: 'key',   run: () => key('Backspace') },
  { name: 'insert-measure (M)',         kind: 'key',   run: () => key('m') },
  { name: 'page-break (Ctrl+B)',        kind: 'key',   run: () => key('b', { ctrlKey: true }) },
  { name: 'tuplet (Ctrl+8)',            kind: 'key',   run: () => key('8', { ctrlKey: true }) },
  { name: 'trill (Ctrl+R)',             kind: 'key',   run: () => key('r', { ctrlKey: true }) },
  { name: 'hide-rest (h)',              kind: 'key',   pre: parkOnRest, run: () => key('h') },
  { name: 'paren-caut (p)',             kind: 'key',   run: () => key('p') },
  { name: 'tie (=)',                    kind: 'key',   run: () => key('=') },
  { name: 'pedal down (P)',             kind: 'key',   run: () => key('P', { shiftKey: true }) },
  { name: 'section-header (model)',     kind: 'model', run: () => model.setSectionHeaderAt(MI, 'PROBE') },
  { name: 'tempo (model)',              kind: 'model', run: () => model.setTempo(120, '4', 0, 'Probe') },
  { name: 'double-bar (model)',         kind: 'model', run: () => model.toggleDoubleBarAt(MI) },
  { name: 'append-note-at-end (model)', kind: 'model', run: () => { model.setCursor(model['flatChildren'](1).length, 1); return model.insertChordAtCursor({ notes: [mkNote], duration: '4', dots: 0 }); } },
  { name: 'replace-note (model)',       kind: 'model', run: () => model.replaceChordAtCursor({ notes: [mkNote], duration: '4', dots: 0 }) },
  /* Selection-mode commands: enter the selection through the real keys first. */
  { name: 'delete-selection (Bksp)',    kind: 'key',   pre: selectMeasure, run: () => key('Backspace') },
  { name: 'volta/ending (Ctrl+E)',      kind: 'key',   pre: () => { selectMeasure(); key('ArrowDown', { shiftKey: true }); return true; }, run: () => key('e', { ctrlKey: true }) },
  { name: 'slur (Ctrl+L)',              kind: 'key',   pre: selectBeat,    run: () => key('l', { ctrlKey: true }) },
  /* Clipboard: copy is staged in a prior step, so only the PASTE mutates. */
  { name: 'cut measure (Ctrl+X)',       kind: 'key',   pre: selectMeasure, run: () => { key('x', { ctrlKey: true }); return harvest('cut'); } },
  { name: 'paste measure (paste evt)',  kind: 'key',   pre: () => { if (!stageMeasureCopy()) return false; const cur = model.getFirstVisualCursorInMeasure(1, Math.min(MI + 2, measures() - 1), 'overwrite'); if (cur < 0) return false; model.setCursor(cur, 1); return true; }, run: () => pasteClip() },
  { name: 'paste into selection',       kind: 'key',   pre: () => { if (!stageMeasureCopy()) return false; const cur = model.getFirstVisualCursorInMeasure(1, Math.min(MI + 2, measures() - 1), 'overwrite'); if (cur < 0) return false; model.setCursor(cur, 1); selectMeasure(); return true; }, run: () => pasteClip() },
  /* Dialog-driven commands, at the model level the dialog commits to. These are
     the SIGNATURE RANGES the refill folds into the changed run (sigranges.ts). */
  { name: 'time-sig mid-piece (model)', kind: 'model', run: () => model.setTimeSigAt ? model.setTimeSigAt(MI, 3, 4) : model.setTimeSig(3, 4) },
  { name: 'key-sig mid-piece (model)',  kind: 'model', run: () => model.setKeySigAt(MI, '2s', 'major') },
  { name: 'clef mid-piece (model)',     kind: 'model', run: () => model.setClefAt('C', '3', null, null) },
  { name: 'pickup (model)',             kind: 'model', run: () => model.setPickupAt(model.sectionStartIdxForCursor(), 2) },
  { name: 'add instrument (model)',     kind: 'model', run: () => { model.addInstrument({ name: 'Probe', staffCount: 1 }); return true; } },
  /* Undo / redo of a plain note delete: the restore path, not an edit path. */
  { name: 'undo (Ctrl+Z)',              kind: 'key',   pre: () => { if (!park()) return false; key('Backspace'); return true; }, run: () => key('z', { ctrlKey: true }) },
  { name: 'redo (Ctrl+Y)',              kind: 'key',   pre: () => { if (!park()) return false; key('Backspace'); key('z', { ctrlKey: true }); return true; }, run: () => key('y', { ctrlKey: true }) },
];

const out = { measures: measures(), lines: pb['startIds'].length, editMeasure: MI, rows: [] };
const ow = console.warn, oe = console.error;
const warns = [];
console.warn = (...a) => { const t = a.join(' '); if (!/^\[Warning\]/.test(t)) warns.push(t); };
console.error = (...a) => warns.push('ERROR ' + a.join(' '));

for (const c of CASES) {
  await mountAround();
  if (!park()) { out.rows.push({ name: c.name, error: 'no cursor in measure ' + MI }); continue; }
  const snap = model.snapshotState();
  /* Preconditions (a selection, a staged clipboard, a prior edit to undo) run
     BEFORE the stopwatch and may themselves render; the wall must not include
     them, and their outcome must not be mistaken for the command's. */
  if (c.pre) {
    let preOk = false;
    try { preOk = c.pre() !== false; } catch (e) { preOk = false; }
    await waitFor(badgeHidden, 60000, 10);
    if (!preOk) { out.rows.push({ name: c.name, error: 'precondition failed' }); model.restoreSnapshot(snap); reRender(); await waitFor(badgeHidden, 60000, 20); continue; }
  }
  const ver0 = model.docVersion();
  const m0 = measures(), l0 = pb['startIds'] ? pb['startIds'].length : 0;
  r.clearRenderLedger?.();
  warns.length = 0;
  ps.lastOutcome = ''; ps.lastSkipReason = ''; pb.lastDeriveReason = '';
  const t0 = performance.now();
  let threw = null;
  try {
    const res = c.run();
    if (c.kind === 'model') { if (res === false || res === null) threw = 'model call rejected'; reRender(); }
  } catch (e) { threw = String(e && e.message || e); }
  await waitFor(badgeHidden, 60000, 10);
  const wall = Math.round(performance.now() - t0);
  const mutated = model.docVersion() !== ver0;
  out.rows.push({
    name: c.name, kind: c.kind, wallMs: wall, mutated,
    outcome: ps.lastOutcome || '(none)', skipReason: ps.lastSkipReason || '',
    deriveReason: pb.lastDeriveReason || '',
    measuresDelta: measures() - m0,
    linesDelta: (pb['startIds'] ? pb['startIds'].length : 0) - l0,
    spliceLines: ps.lastStats ? ps.lastStats.lines : null,
    windowMeasures: ps.lastStats ? ps.lastStats.windowMeasures : null,
    cascade: r.lastCascade ? { ...r.lastCascade } : null,
    ledger: r.renderLedger ? r.renderLedger().map((x) => (x.full ? 'FULL:' + (x.deriveReason || x.skipReason || '?') : x.outcome)) : null,
    error: threw, warns: warns.slice(0, 3),
  });
  /* Back to the shared baseline (document swap → the partition re-derives). */
  model.restoreSnapshot(snap);
  reRender();
  await waitFor(badgeHidden, 60000, 20);
  await waitFor(() => pb['startIds'] !== null, 60000, 50);
}
console.warn = ow; console.error = oe;

const mutating = out.rows.filter((x) => x.mutated);
out.summary = {
  cases: out.rows.length,
  mutating: mutating.length,
  spliced: mutating.filter((x) => x.outcome === 'spliced').length,
  derived: mutating.filter((x) => x.outcome !== 'spliced').length,
  deriveReasons: Object.fromEntries(Object.entries(mutating.filter((x) => x.outcome !== 'spliced')
    .reduce((m, x) => { const k = x.deriveReason || x.skipReason || x.outcome; m[k] = (m[k] ?? 0) + 1; return m; }, {}))),
  nonMutating: out.rows.filter((x) => !x.mutated).map((x) => x.name),
};
return out;
