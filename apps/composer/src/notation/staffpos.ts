// Staff positions from pitch + clef (shared by the render-clone passes).
//
// A note's vertical place on its staff is its diatonic step relative to the
// middle line's step under the clef in effect. `middleSteps` resolves the clef
// for every note by a document-order walk over staffDefs (head and interior
// scoreDefs reset a staff) and inline `<clef>`s, by Verovio's own rule
// (measured on 6.3.0, 2026-11-18): an inline clef sets ITS layer for the rest
// of the measure; any other layer of the staff keeps the clef the staff had
// when the measure began; from the next measure on, every layer starts in the
// last clef of the measure in document order. Extracted from
// notation/slurStems.ts (2026-09-06) for notation/restlayout.ts.

/** A note's vertical position as a diatonic step count (octave × 7 + letter). */
export function stepOf(n: Element): number | null {
  const p = n.getAttribute('pname'), o = n.getAttribute('oct');
  if (!p || !o) return null;
  const i = 'cdefgab'.indexOf(p[0].toLowerCase()), oct = parseInt(o, 10);
  return i < 0 || !Number.isFinite(oct) ? null : oct * 7 + i;
}

/** The step of the middle staff line for a clef, or null for an unpitched one. */
export function clefMiddleStep(shape: string | null, line: string | null, dis: string | null, disPlace: string | null): number | null {
  const ref = shape === 'G' ? 4 * 7 + 4 : shape === 'F' ? 3 * 7 + 3 : shape === 'C' ? 4 * 7 + 0 : null;   // g4 / f3 / c4
  if (ref === null) return null;
  const ln = parseInt(line ?? (shape === 'G' ? '2' : shape === 'F' ? '4' : '3'), 10);
  if (!Number.isFinite(ln)) return null;
  let mid = ref + (3 - ln) * 2;
  const d = dis === '8' ? 7 : dis === '15' ? 14 : dis === '22' ? 21 : 0;
  if (d) mid += disPlace === 'below' ? -d : d;   // an 8vb clef draws every written pitch an octave higher on the staff
  return mid;
}

/** The middle-line step in effect at every note, by a document-order walk:
 *  `staffDef` clefs (head and interior scoreDefs) reset a staff, an inline
 *  `<clef>` sets its own layer for the rest of the measure and becomes the
 *  staff's running clef from the next measure on. A layer with no clef of its
 *  own in a measure reads the staff's clef as of the measure's START
 *  (`staffEntry`), never the running one: the other layer's later clefs do
 *  not reach it (mazeppa m. 8, 2026-11-18 — the lower voice was read in the
 *  upper voice's last clef of the bar). */
export function middleSteps(doc: Document): Map<Element, number> {
  const out = new Map<Element, number>();
  const staffCur = new Map<string, number | null>();
  let staffEntry = new Map<string, number | null>();
  let layerCur = new Map<string, number | null>();
  let curMeasure: Element | null = null;
  for (const el of Array.from(doc.querySelectorAll('staffDef, clef, note'))) {
    const ln = el.localName;
    if (ln === 'staffDef') {
      const shape = el.getAttribute('clef.shape');
      if (!shape) continue;
      staffCur.set(el.getAttribute('n') ?? '1', clefMiddleStep(shape, el.getAttribute('clef.line'), el.getAttribute('clef.dis'), el.getAttribute('clef.dis.place')));
      continue;
    }
    const staff = el.closest('staff'), layer = el.closest('layer');
    if (!staff || !layer) continue;
    const measure = staff.closest('measure');
    if (measure !== curMeasure) { curMeasure = measure; layerCur = new Map(); staffEntry = new Map(staffCur); }
    const sn = staff.getAttribute('n') ?? '1', key = sn + '/' + (layer.getAttribute('n') ?? '1');
    if (ln === 'clef') {
      const mid = clefMiddleStep(el.getAttribute('shape'), el.getAttribute('line'), el.getAttribute('dis'), el.getAttribute('dis.place'));
      layerCur.set(key, mid);
      staffCur.set(sn, mid);
      continue;
    }
    const mid = layerCur.has(key) ? layerCur.get(key) : staffEntry.get(sn);
    if (mid !== null && mid !== undefined) out.set(el, mid);
  }
  return out;
}

/** A note's staff-line location (0 = bottom line, 4 = middle, 8 = top), given
 *  the middle line's step; null for an unpitched note. */
export function locOf(note: Element, middleStep: number): number | null {
  const s = stepOf(note);
  return s === null ? null : 4 + (s - middleStep);
}
