// Why does the whole note sit further right under 'encoded'? (Max, on the
// phase3_section_header baseline: "the whole note in the first system moves
// unnaturally to the right ... why the new method moves it off the left side
// of the measure", plus "the system after the section header switches to a
// much smaller width".)
//
// Rebuilds that fixture's document (m1 = one whole note, m2 = empty with a
// section header forcing an <sb>), renders it under smartSb0 and encoded, and
// reports per system: measure box, the leading clef/meter block, the note's
// position relative to both the measure left edge and the end of that block,
// and the system's right edge. Run with --no-sonata.
const H = window.__hkl_composer;
const r = H.renderer, model = H.model;
const pb = r['pageBreaks'];
const V = window.verovio;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const out = {};

/* ── build the fixture document ── */
model.setCursor(0, 1);
model.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '1', dots: 0 });
model.appendMeasure();
model.setCursor(model.getMeasureStartCursor(1, 1), 1);
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'H', ctrlKey: true, shiftKey: true, bubbles: true }));
await sleep(120);
const dlg = document.getElementById('textEntryDialog');
if (!dlg) return { error: 'section-header dialog did not open' };
dlg.querySelector('[data-field="title"]').value = 'II. Andante';
dlg.querySelector('form').requestSubmit(dlg.querySelector('.te-ok'));
await sleep(300);
H.reRender();
await sleep(300);

const lb = await import('/composer/src/render/linebreaks.ts');
const mei = model.serialize({ hejiEnabled: model.getHejiEnabled() }, null);
out.measures = model.allMeasures().length;
out.docHasSb = /<sb[ \/>]/.test(mei);

const base = r['buildOptions']('auto');

/* Adopt the castoff partition so we can pin it for the encoded render. */
const tkC = new V.toolkit();
tkC.setOptions({ ...base, breaks: 'smart', breaksSmartSb: 0 });
if (!tkC.loadData(mei)) return { error: 'castoff loadData failed' };
const adopted = pb.adoptFromCastoff(model, tkC);
out.adopted = adopted;
out.partition = { lines: pb['startIds'] ? pb['startIds'].length : 0, pages: pb.pageStarts().length };

function profile(label, data, opts) {
  const tk = new V.toolkit();
  tk.setOptions(opts);
  if (!tk.loadData(data)) return { label, error: 'loadData failed' };
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0';
  host.innerHTML = tk.renderToSVG(1, {});
  document.body.appendChild(host);
  const systems = [];
  try {
    for (const sys of host.querySelectorAll('g.system')) {
      const sysBox = sys.getBBox();
      const rows = [];
      for (const meas of sys.querySelectorAll('g.measure')) {
        const mb = meas.getBBox();
        /* leading clef / meter / key block inside this measure */
        let sigRight = -Infinity;
        for (const g of meas.querySelectorAll('g.clef, g.meterSig, g.keySig')) {
          const b = g.getBBox();
          if (b.x + b.width > sigRight) sigRight = b.x + b.width;
        }
        const notes = [];
        for (const n of meas.querySelectorAll('g.note, g.rest, g.mRest')) {
          const b = n.getBBox();
          notes.push({
            kind: n.getAttribute('class'),
            xFromMeasureLeft: +(b.x - mb.x).toFixed(1),
            xFromSigEnd: isFinite(sigRight) ? +(b.x - sigRight).toFixed(1) : null,
            w: +b.width.toFixed(1),
          });
        }
        rows.push({
          id: meas.id,
          x: +mb.x.toFixed(1), w: +mb.width.toFixed(1),
          sigBlockEnd: isFinite(sigRight) ? +(sigRight - mb.x).toFixed(1) : null,
          notes,
        });
      }
      systems.push({
        firstId: rows.length ? rows[0].id : null,
        sysX: +sysBox.x.toFixed(1), sysW: +sysBox.width.toFixed(1),
        measures: rows,
      });
    }
  } finally { host.remove(); }
  return { label, pages: tk.getPageCount(), systems };
}

out.smartSb0 = profile('smartSb0', mei, { ...base, breaks: 'smart', breaksSmartSb: 0 });
if (adopted) {
  const pinned = lb.injectPins(mei, pb['startIds'], pb.paginationOwned() ? new Set(pb.pageStarts()) : null);
  out.encoded = pinned ? profile('encoded', pinned, { ...base, breaks: 'encoded' }) : { error: 'pin injection failed' };
  /* Control: same pinned data under 'line' — isolates mode from pins. */
  out.line = pinned ? profile('line', pinned, { ...base, breaks: 'line' }) : null;
}
return out;
