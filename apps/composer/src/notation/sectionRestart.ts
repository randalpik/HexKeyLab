// No courtesy signatures across a section (movement) break (2026-09-04).
//
// Verovio draws a cautionary key + meter signature at the end of a system
// whenever the next system starts with a new <scoreDef> — right for a
// mid-movement change, wrong at a movement boundary, where the new movement
// simply begins in its own key and meter (backlog, Opinionation). Verovio has
// no option for this; the mechanism, read from the 6.3 source
// (`ScoreDefSetCurrentFunctor::VisitMeasure/VisitScoreDef`):
//   • the standard cautionary is skipped when the scoreDef "is a section
//     restart" — its previous sibling is a `<section restart="true">` — but a
//     restart still sets a cautionary scoreDef with ONLY the key signature
//     suppressed (`SetCautionaryScoreDefFunctor(…, restart=true)`), so the
//     meter courtesy survives;
//   • `@meter.form="invis"` on the scoreDef blanks every meter drawn from it —
//     the courtesy AND the one at the new section's start (which the restart
//     redraws) — while a layer-level <meterSig> in the first measure draws a
//     visible meter exactly where the scoreDef's would sit (after clef + key)
//     and does not leak into later systems or later meter changes (probed).
// So, on the render clone only, each section-start boundary's scoreDef is
// wrapped in a content-less nested `<section restart="true">` placed before the
// break, and a meter change gets the invisible form + an injected <meterSig>
// in layer 1 of every staff of the section's first measure.
//
// Side effects, all Verovio's restart semantics, accepted 2026-09-04: the new
// section's first system draws full instrument labels and is indented like
// the score's first system (a new movement restates its instruments); the
// blanked meter still reserves about half a staff space before the visible
// one; in scroll view (one system) the restart measure also draws a clef.
// The document itself keeps the flat `scoreDef > sb > measure` shape every
// section-walking pass depends on — the wrapper holds no measure, so
// `querySelector('section')`, the break pinning and the range clones all see
// the measures where they always were.

const MEI_NS = 'http://www.music-encoding.org/ns/mei';

const BREAKISH = new Set(['sb', 'pb', 'scoreDef']);

/** Wrap every section-boundary scoreDef in a restart section and blank +
 *  re-draw its meter (see module comment). Idempotent. */
export function applySectionRestarts(doc: Document): void {
  for (const meas of Array.from(doc.querySelectorAll('measure[data-hkl-section-title]'))) {
    /* The section-level node carrying this measure (an <ending> may wrap it). */
    let top: Element = meas;
    while (top.parentElement && top.parentElement.localName !== 'section') top = top.parentElement;
    const parent = top.parentElement;
    if (!parent) continue;
    /* The run of breaks/scoreDef directly before it — the model emits either
       `scoreDef > sb > measure` or `sb > scoreDef > measure`. */
    let sd: Element | null = null;
    let runStart: Element = top;
    let n = top.previousElementSibling;
    while (n && BREAKISH.has(n.localName)) {
      if (n.localName === 'scoreDef') { if (sd) break; sd = n; }
      runStart = n;
      n = n.previousElementSibling;
    }
    if (!sd) continue;
    const hasKey = sd.hasAttribute('key.sig');
    const hasMeter = sd.hasAttribute('meter.count') || sd.hasAttribute('meter.unit') || sd.hasAttribute('meter.sym');
    if (!hasKey && !hasMeter) continue;
    const wrapper = doc.createElementNS(MEI_NS, 'section');
    wrapper.setAttribute('restart', 'true');
    parent.insertBefore(wrapper, runStart);
    wrapper.appendChild(sd);
    if (!hasMeter) continue;
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
