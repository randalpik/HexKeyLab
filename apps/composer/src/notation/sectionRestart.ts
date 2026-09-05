// No courtesy METER signature across a section (movement) break (2026-09-04/05).
//
// Verovio draws a cautionary key + meter signature at the end of a system
// whenever the next system starts with a new <scoreDef> — right for a
// mid-movement change, wrong at a movement boundary, where the new movement
// simply begins in its own key and meter (backlog, Opinionation). Verovio has
// no option for this. What the 6.3 source and the probes allow:
//   • `@meter.form="invis"` on the scoreDef blanks EVERY meter drawn from it —
//     the courtesy included — while a layer-level <meterSig> in the section's
//     first measure draws a visible meter exactly where the scoreDef's would sit
//     (after clef + key) and does not leak into later systems or later meter
//     changes (probed). So the METER courtesy is gone.
//   • The KEY courtesy has no such switch: `keysig.visible` is ignored, a
//     layer-level <keySig> does not persist to later systems, and the only
//     mechanism that drops it — `<section restart="true">` — also redraws the
//     full instrument labels and indents the system like the score's first
//     (Verovio's restart semantics; a restart scoreDef carrying empty labels,
//     bare staffDefs, or empty <labelAbbr> in the head all still label — probed
//     2026-09-05). Max ruled the restated names unacceptable, so the restart
//     wrapper was removed the same day and the key courtesy stays until Verovio
//     grows a switch (two lines in `SetCautionaryScoreDefFunctor::VisitStaff`).
// Runs on the render clone only; the saved document keeps its flat
// `scoreDef > sb > measure` shape.

const MEI_NS = 'http://www.music-encoding.org/ns/mei';

const BREAKISH = new Set(['sb', 'pb', 'scoreDef']);

/** Blank the courtesy meter at every section boundary whose scoreDef changes
 *  the meter, drawing the visible meter from layer 1 of the first measure
 *  instead. Idempotent. */
export function blankSectionCourtesyMeters(doc: Document): void {
  for (const meas of Array.from(doc.querySelectorAll('measure[data-hkl-section-title]'))) {
    /* The section-level node carrying this measure (an <ending> may wrap it). */
    let top: Element = meas;
    while (top.parentElement && top.parentElement.localName !== 'section') top = top.parentElement;
    /* The run of breaks/scoreDef directly before it — the model emits either
       `scoreDef > sb > measure` or `sb > scoreDef > measure`. */
    let sd: Element | null = null;
    let n = top.previousElementSibling;
    while (n && BREAKISH.has(n.localName)) {
      if (n.localName === 'scoreDef') { if (sd) break; sd = n; }
      n = n.previousElementSibling;
    }
    if (!sd) continue;
    const hasMeter = sd.hasAttribute('meter.count') || sd.hasAttribute('meter.unit') || sd.hasAttribute('meter.sym');
    if (!hasMeter || sd.getAttribute('meter.form') === 'invis') continue;
    sd.setAttribute('meter.form', 'invis');
    for (const staff of Array.from(meas.children)) {
      if (staff.localName !== 'staff') continue;
      const layer = Array.from(staff.children).find((c) => c.localName === 'layer');
      if (!layer) continue;
      const ms = doc.createElementNS(MEI_NS, 'meterSig');
      const count = sd.getAttribute('meter.count'); if (count) ms.setAttribute('count', count);
      const unit = sd.getAttribute('meter.unit'); if (unit) ms.setAttribute('unit', unit);
      const sym = sd.getAttribute('meter.sym'); if (sym) ms.setAttribute('sym', sym);
      layer.insertBefore(ms, layer.firstChild);
    }
  }
}
