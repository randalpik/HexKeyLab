// Part-aware engraving conventions applied to the RENDER CLONE only (the saved
// document keeps one score-global mark and no forced fermata side).
//
// Two rules live here, both keyed on the score's instrument partition — the
// head <scoreDef>'s nested <staffGrp>s, one per instrument (a flat root group
// is the single implicit instrument), mirroring the model's instrument table:
//
//  • duplicateTempiAcrossParts — a <tempo> is score-global in the model (one
//    element, one tempo-layer cursor stop) but conventionally engraved above
//    EVERY part, the way an imported "rit." already is (Finale writes such a
//    <direction> into each part, so the importer's per-part <dir>s land above
//    each staff while the <tempo>s collapse to one above staff 1). The copies
//    are made here so nothing downstream — the layer cursor, delete, save,
//    playback's tempo timeline — has to know about them. Must run BEFORE
//    filterToStaves: single-part view drops control events anchored to a
//    hidden staff, so without a copy of its own the viewed part would lose
//    every tempo marking.
//
//  • settleFermataSides — on a grand staff Verovio puts a fermata above the
//    note's own staff, which for the lower staff of the pair is INSIDE the
//    inter-staff gap (probed: staff 2's fermata at y 451–471 between a staff 1
//    ending at 433 and a staff 2 starting at 488). A fermata belongs outside
//    the braced pair, so the top staff's is pinned above and the bottom
//    staff's below — where Verovio draws the inverted glyph (E4C1) by itself.

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** Leading integer of an attribute that may hold a token list (`staff="1 2"`),
 *  or null when absent / unparseable. */
function firstInt(raw: string | null): number | null {
  if (raw === null) return null;
  const n = parseInt(raw.trim().split(/\s+/)[0], 10);
  return Number.isFinite(n) ? n : null;
}

/** Each instrument's staff `@n`s in document order, from the head scoreDef's
 *  staffGrp partition — nested groups are the instruments, a flat root group
 *  is the single implicit one (same rule as `ComposerModel.instruments()`, but
 *  DOM-only so it can read a render clone). */
export function instrumentStaffSets(doc: Document): number[][] {
  const head = doc.querySelector('scoreDef');
  const root = head?.querySelector('staffGrp');
  if (!root) return [];
  const nested = Array.from(root.children).filter((c) => c.localName === 'staffGrp');
  const out: number[][] = [];
  for (const grp of nested.length > 0 ? nested : [root]) {
    const ns = Array.from(grp.children)
      .filter((c) => c.localName === 'staffDef')
      .map((d) => firstInt(d.getAttribute('n')))
      .filter((n): n is number => n !== null && n > 0);
    if (ns.length > 0) out.push(ns);
  }
  return out;
}

/* ── tempo markings restated above every part ─────────────────────────────── */

/** Same-moment key for the tempi of one measure (tstamp is written with 3
 *  decimals by `formatTstamp`, so a fixed quantum is exact). */
const momentKey = (el: Element): number => Math.round((parseFloat(el.getAttribute('tstamp') ?? '1') || 1) * 1000);

/** True iff a `<tempo>` draws something. The document's head tempo is a
 *  text-less, playback-only `<tempo tstamp="1" staff="1">` carrying just
 *  `@mm`/`@midi.bpm` (`ComposerModel.setTempo`), and `@mm` alone renders
 *  nothing in this Verovio build — a shown metronome is composed INTO the
 *  content as a SMuFL `<rend>`, so the text content is the whole test. Such a
 *  mark is neither copied nor allowed to occupy its moment, else the head
 *  tempo would shadow a real marking written on beat 1 of measure 1. */
const drawsSomething = (el: Element): boolean => (el.textContent ?? '').trim().length > 0;

/** Copy every `<tempo>` to the top staff of each instrument that carries none
 *  at that moment. The copy is byte-for-byte the original (metronome, gradual
 *  span and all) but for `@staff` and an `@xml:id` suffixed `-p<staffN>` — a
 *  fourth id segment, which `newId`'s three-segment form can never produce, so
 *  `selectLayerElementById` can recover the original by stripping it. Runs on
 *  the render clone; deterministic, so a range sub-render matches the full one.
 *  No-op for a single-instrument score. */
export function duplicateTempiAcrossParts(doc: Document): void {
  const sets = instrumentStaffSets(doc);
  if (sets.length < 2) return;
  const topStaves = sets.map((s) => s[0]);
  for (const measure of Array.from(doc.querySelectorAll('measure'))) {
    const tempi = Array.from(measure.children)
      .filter((c) => c.localName === 'tempo' && drawsSomething(c));
    if (tempi.length === 0) continue;
    /* An authored per-part mark is never doubled: a moment's first <tempo> is
       the one copied, and only onto the top staves the moment lacks. */
    const covered = new Map<number, Set<number>>();
    const firstAt = new Map<number, Element>();
    for (const t of tempi) {
      const k = momentKey(t);
      const staffN = firstInt(t.getAttribute('staff')) ?? 1;
      if (!covered.has(k)) { covered.set(k, new Set()); firstAt.set(k, t); }
      covered.get(k)!.add(staffN);
    }
    for (const [k, staves] of covered) {
      const src = firstAt.get(k)!;
      /* Read AND write the id the way the source carries it: everything built
         here uses setAttributeNS (mei-build's `el`), but a doc assembled by
         hand can hold a null-namespace "xml:id", and writing the namespaced
         form onto that clone would serialize the attribute twice. */
      const nsId = src.getAttributeNS(XML_NS, 'id');
      const srcId = nsId ?? src.getAttribute('xml:id');
      for (const staffN of topStaves) {
        if (staves.has(staffN)) continue;
        const copy = src.cloneNode(true) as Element;
        copy.setAttribute('staff', String(staffN));
        if (srcId !== null) {
          const copyId = srcId + '-p' + staffN;
          if (nsId !== null) copy.setAttributeNS(XML_NS, 'xml:id', copyId);
          else copy.setAttribute('xml:id', copyId);
        }
        /* Appended, not inserted beside the source: the head tempo lives
           BEFORE the measure's <staff>s (setTempo puts it first) and Verovio
           rejects a control event there. */
        measure.appendChild(copy);
      }
    }
  }
}

/** The original element's id behind a `duplicateTempiAcrossParts` copy id, or
 *  null when `id` carries no copy suffix. */
export function tempoCopySource(id: string): string | null {
  const m = /^(.*)-p\d+$/.exec(id);
  return m ? m[1] : null;
}

/* ── fermatas outside the grand staff ─────────────────────────────────────── */

/** xml:id → staff `@n` for everything inside this measure's `<staff>`s, so a
 *  `@startid`-anchored control event can be attributed (an XML document has no
 *  working `getElementById` without a DTD). Built only for measures that hold
 *  a fermata. */
function staffIndexOf(measure: Element): Map<string, number> {
  const map = new Map<string, number>();
  for (const st of Array.from(measure.children)) {
    if (st.localName !== 'staff') continue;
    const n = firstInt(st.getAttribute('n'));
    if (n === null) continue;
    for (const e of Array.from(st.querySelectorAll('[*|id]'))) {
      const id = e.getAttribute('xml:id');
      if (id) map.set(id, n);
    }
  }
  return map;
}

/** Pin every grand-staff fermata outside the braced pair: `@place="above"` on
 *  the instrument's top staff, `@place="below"` on its bottom one. Fermatas on
 *  a single-staff instrument, on the middle staff of a three-staff one, and
 *  any that already carry an explicit `@place` are left to Verovio. */
export function settleFermataSides(doc: Document): void {
  const tops = new Set<number>();
  const bottoms = new Set<number>();
  for (const s of instrumentStaffSets(doc)) {
    if (s.length < 2) continue;
    tops.add(s[0]);
    bottoms.add(s[s.length - 1]);
  }
  if (tops.size === 0) return;
  for (const measure of Array.from(doc.querySelectorAll('measure'))) {
    const ferms = Array.from(measure.children).filter((c) => c.localName === 'fermata');
    if (ferms.length === 0) continue;
    let staffOf: Map<string, number> | null = null;
    for (const f of ferms) {
      if (f.hasAttribute('place')) continue;
      let n = firstInt(f.getAttribute('staff'));
      if (n === null) {
        const ref = (f.getAttribute('startid') ?? '').replace(/^#/, '');
        if (!ref) continue;
        staffOf ??= staffIndexOf(measure);
        n = staffOf.get(ref) ?? null;
      }
      if (n === null) continue;
      if (tops.has(n)) f.setAttribute('place', 'above');
      else if (bottoms.has(n)) f.setAttribute('place', 'below');
    }
  }
}
