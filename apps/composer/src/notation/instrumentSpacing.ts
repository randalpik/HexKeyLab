// Wider gaps between INSTRUMENTS than within a grand staff (2026-09-04).
//
// Verovio's `spacingStaff` (12 units) is a floor on every adjacent pair of
// staves, and `spacingBraceGroup` only ever raises the gap inside a brace —
// there is no option that separates instruments more than a piano's two
// staves (probed: raising spacingStaff widens both). MEI's `staffDef@spacing`
// is per staff — "distance to the preceding staff", in Verovio units — and
// Verovio honors it as that pair's minimum (probed: the viola→piano gap grew,
// the piano's inner gap did not). So the render clone stamps it on the first
// staff of every instrument after the first. A minimum, not a fixed distance:
// content still pushes staves further apart. Saved documents are untouched;
// this is a Composer default, not a per-file setting.

/** Minimum distance from one instrument's last staff to the next instrument's
 *  first, in Verovio units (half staff spaces): 9 staff spaces, against the
 *  6 a grand staff's two staves keep. */
export const INSTRUMENT_GAP_UNITS = 18;

export function applyInstrumentSpacing(doc: Document, units: number = INSTRUMENT_GAP_UNITS): void {
  const root = doc.querySelector('scoreDef > staffGrp');
  if (!root) return;
  const groups = Array.from(root.children).filter((c) => c.localName === 'staffGrp');
  if (groups.length < 2) return;
  for (const g of groups.slice(1)) {
    const first = Array.from(g.children).find((c) => c.localName === 'staffDef');
    if (first && !first.hasAttribute('spacing')) first.setAttribute('spacing', String(units));
  }
}
