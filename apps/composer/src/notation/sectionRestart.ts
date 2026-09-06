// Section (movement) breaks without courtesy signatures or restated names.
//
// Verovio draws a cautionary key + meter at the end of a system whenever the
// next system starts with a new <scoreDef> — right for a mid-movement change,
// wrong at a movement boundary, where the new movement simply begins in its own
// key and meter (backlog, Opinionation). There is no option. What Verovio 6.3
// allows (source + live probes, 2026-09-04/05):
//   • METER: `@meter.form="invis"` on the scoreDef blanks EVERY meter drawn from
//     it — the courtesy included — while a layer-level <meterSig> in the
//     section's first measure draws a visible meter exactly where the
//     scoreDef's would sit (after clef + key) and does not leak into later
//     systems or later meter changes.
//   • KEY: only `<section restart="true">` drops the courtesy — the scoreDef
//     must be the FIRST child of the restart section, hence the content-less
//     nested wrapper below (Verovio's milestone conversion makes the section
//     start the scoreDef's previous sibling and leaves every measure a direct
//     child of the outer section, which the break/splice pipeline assumes).
//     `SetCautionaryScoreDefFunctor(…, restart)` disables the key courtesy for
//     every staff the restart scoreDef does NOT name, and a restart redraws
//     clef + key + meter at its first measure.
//   • LABELS: a restart also draws the FULL instrument labels (indenting the
//     system like the score's first) — but `ScoreDefSetCurrentFunctor::
//     VisitStaffGrp` replaces the drawing labels from any <staffGrp> child of
//     the restart scoreDef whose `@n` matches a head staffGrp
//     (`ScoreDef::ReplaceDrawingLabels`), and `View::DrawLabels` draws nothing
//     and reserves no width for an empty label. So each labelled head group
//     gets an `@n` (render clone only) and the restart scoreDef a matching
//     <staffGrp n><label>ABBR</label> — the abbreviation the continuation
//     systems show, or nothing — so the restart system is indistinguishable
//     from any other continuation system. Two constraints shape WHERE that
//     staffGrp lives: the loader insists on a <staffDef> per staffGrp, and a
//     staffDef that names no real staff (or has no `@n`) draws a Verovio
//     console warning — while a staffDef naming a real staff inside the
//     RESTART scoreDef re-enables that staff's key courtesy (the restart's
//     suppression skips every staff the restart scoreDef names). And
//     `ScoreDef::IsSectionRestart` is "the nearest preceding section
//     milestone has @restart", so ANY scoreDef after the restart start counts
//     as a restart until another section milestone intervenes. Hence the
//     labels go in a SECOND scoreDef inside a second, plain nested <section>:
//     not a restart (no courtesy from its staffDefs, which name the group's
//     real first staff and carry nothing to replace), yet `m_restart` — set by
//     the first scoreDef and cleared only at the next measure — is still on
//     when its staffGrps are visited, so the labels are replaced. All probed
//     against the live 6.3.0 toolkit with console capture.
//   • CLEF (2026-09-06): a clef change at a section start is encoded as a
//     layer-initial <clef> in the section's first measure (importer and
//     native edits alike); `relocateInitialClefs` leaves it there for these
//     measures, and this pass folds it into a THIRD nested plain section's
//     scoreDef (`<staffGrp><staffDef n clef.shape clef.line/></staffGrp>`)
//     after the labels. Why a scoreDef of its own, after the restart: in
//     `ScoreDefSetCurrentFunctor::VisitScoreDef` the restart scoreDef runs the
//     cautionary functor on the previous measure at once (key suppressed,
//     meter blanked by `meter.form`), and the system-break cautionary in
//     `VisitMeasure` is gated on `!m_restart` — still set until that measure
//     — so a clef arriving in a LATER scoreDef of the same run sets
//     `DrawClef` on the upcoming staffDef and is never drawn as a courtesy;
//     the restart's `REDRAW_ALL` then draws it as the new system's clef. A
//     clef in the restart scoreDef itself would be caught by the restart's
//     own cautionary pass (it only clears the key), and a clef left in the
//     layer draws after the barline behind the old system clef.
// Runs on the render clone only; the saved document keeps its flat
// `scoreDef > sb > measure` shape.

const MEI_NS = 'http://www.music-encoding.org/ns/mei';

const BREAKISH = new Set(['sb', 'pb', 'scoreDef']);

interface LabelledGroup { n: string; abbr: string; staffN: string }

const directChild = (el: Element, name: string): Element | undefined =>
  Array.from(el.children).find((c) => c.localName === name);

/** The head scoreDef's staffGrps that carry a <label>, each guaranteed an `@n`
 *  (assigned on the clone when absent), with the abbreviation the continuation
 *  systems draw ('' when there is no <labelAbbr>) and the `@n` of the group's
 *  first real staff. */
function labelledGroups(doc: Document): LabelledGroup[] {
  const head = doc.querySelector('score > scoreDef') ?? doc.querySelector('scoreDef');
  if (!head) return [];
  const grps = Array.from(head.querySelectorAll('staffGrp'));
  const used = new Set(grps.map((g) => g.getAttribute('n')).filter((n): n is string => !!n));
  const out: LabelledGroup[] = [];
  let seq = 1;
  for (const g of grps) {
    const label = directChild(g, 'label');
    if (!label || !(label.textContent ?? '').trim()) continue;
    let n = g.getAttribute('n');
    if (!n) {
      while (used.has(`hkl${seq}`)) seq++;
      n = `hkl${seq++}`;
      used.add(n);
      g.setAttribute('n', n);
    }
    const staffN = Array.from(g.querySelectorAll('staffDef')).map((d) => d.getAttribute('n')).find((v) => !!v);
    if (!staffN) continue;
    out.push({ n, abbr: (directChild(g, 'labelAbbr')?.textContent ?? '').trim(), staffN });
  }
  return out;
}

interface LeadingClef { staffN: string; shape: string; line: string; dis: string | null; disPlace: string | null }

/** The layer-initial clefs of a section-start measure, one per staff (the
 *  first layer's wins), REMOVED from their layers — the caller writes them
 *  into the boundary scoreDef. */
function leadingClefs(meas: Element): LeadingClef[] {
  const out: LeadingClef[] = [];
  const seen = new Set<string>();
  for (const staff of Array.from(meas.children)) {
    if (staff.localName !== 'staff') continue;
    const staffN = staff.getAttribute('n') ?? '1';
    for (const layer of Array.from(staff.children)) {
      if (layer.localName !== 'layer') continue;
      const first = layer.firstElementChild;
      if (!first || first.localName !== 'clef') continue;
      const shape = first.getAttribute('shape'), line = first.getAttribute('line');
      if (shape && line && !seen.has(staffN)) {
        seen.add(staffN);
        out.push({ staffN, shape, line, dis: first.getAttribute('dis'), disPlace: first.getAttribute('dis.place') });
      }
      layer.removeChild(first);
    }
  }
  return out;
}

/** Wrap every section-boundary scoreDef that changes key, meter or clef in a restart
 *  section carrying continuation labels, and blank + re-draw its meter (see
 *  module comment). Idempotent. */
export function applySectionRestarts(doc: Document): void {
  let groups: LabelledGroup[] | null = null;
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
    const clefs = leadingClefs(meas);
    const hasKey = !!sd && sd.hasAttribute('key.sig');
    const hasMeter = !!sd && (sd.hasAttribute('meter.count') || sd.hasAttribute('meter.unit') || sd.hasAttribute('meter.sym'));
    if (!hasKey && !hasMeter && !clefs.length) continue;
    if (!sd) {
      /* A clef-only boundary: an attribute-less scoreDef is still a restart
         (`IsSectionRestart` looks at the section milestone, not its content). */
      sd = doc.createElementNS(MEI_NS, 'scoreDef');
      parent.insertBefore(sd, runStart);
      runStart = sd;
    }
    const wrapper = doc.createElementNS(MEI_NS, 'section');
    wrapper.setAttribute('restart', 'true');
    parent.insertBefore(wrapper, runStart);
    wrapper.appendChild(sd);
    let tail: Element = wrapper;
    if (!groups) groups = labelledGroups(doc);
    if (groups.length) {
      const labelSection = doc.createElementNS(MEI_NS, 'section');
      const labelDef = doc.createElementNS(MEI_NS, 'scoreDef');
      for (const { n: grpN, abbr, staffN } of groups) {
        const grp = doc.createElementNS(MEI_NS, 'staffGrp');
        grp.setAttribute('n', grpN);
        const label = doc.createElementNS(MEI_NS, 'label');
        if (abbr) label.textContent = abbr;
        grp.appendChild(label);
        const def = doc.createElementNS(MEI_NS, 'staffDef');
        def.setAttribute('n', staffN);
        grp.appendChild(def);
        labelDef.appendChild(grp);
      }
      labelSection.appendChild(labelDef);
      wrapper.after(labelSection);
      tail = labelSection;
    }
    if (clefs.length) {
      const clefSection = doc.createElementNS(MEI_NS, 'section');
      const clefDef = doc.createElementNS(MEI_NS, 'scoreDef');
      const grp = doc.createElementNS(MEI_NS, 'staffGrp');
      for (const c of clefs) {
        const def = doc.createElementNS(MEI_NS, 'staffDef');
        def.setAttribute('n', c.staffN);
        def.setAttribute('clef.shape', c.shape);
        def.setAttribute('clef.line', c.line);
        if (c.dis) { def.setAttribute('clef.dis', c.dis); def.setAttribute('clef.dis.place', c.disPlace ?? 'above'); }
        grp.appendChild(def);
      }
      clefDef.appendChild(grp);
      clefSection.appendChild(clefDef);
      tail.after(clefSection);
    }
    if (!hasMeter || sd.getAttribute('meter.form') === 'invis') continue;
    sd.setAttribute('meter.form', 'invis');
    for (const staff of Array.from(meas.children)) {
      if (staff.localName !== 'staff') continue;
      const layer = directChild(staff, 'layer');
      if (!layer) continue;
      const ms = doc.createElementNS(MEI_NS, 'meterSig');
      const count = sd.getAttribute('meter.count'); if (count) ms.setAttribute('count', count);
      const unit = sd.getAttribute('meter.unit'); if (unit) ms.setAttribute('unit', unit);
      const sym = sd.getAttribute('meter.sym'); if (sym) ms.setAttribute('sym', sym);
      layer.insertBefore(ms, layer.firstChild);
    }
  }
}
