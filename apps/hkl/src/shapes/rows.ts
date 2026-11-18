// How the shape guide's entries share the rows of a page. A row holds three
// entries, two or one, and its entries always share it equally, so the second
// entry of every two-entry row starts at the same place across the page.
//
// Pure: no DOM, so the Node oracle (test/shapes/) imports it.

/** The most entries that can share a row with this one: 3 when it fits a
 *  third of the page, 2 when it needs half, 1 when it needs the whole width. */
export type Fit = 1 | 2 | 3;

export interface Row {
  /** Index of the row's first entry, and how many entries it holds. */
  start: number;
  count: number;
  /** How many equal parts the row is cut into: each entry takes one. */
  columns: Fit;
}

/** The entries of one section, in order, as rows.
 *   - An entry that needs the whole width has a row to itself.
 *   - Three in a row only where all three fit a third.
 *   - Otherwise two in a row, each a half: also for two entries that would
 *     each fit a third, when the one after them does not. An entry is alone on
 *     a half only when the next needs the whole width, or it is the last.
 *   - The last one or two entries of a section, if they all fit a third, stay
 *     on thirds, in line with the rows of three above them. */
export function rowsOf(fits: ReadonlyArray<Fit>): Row[] {
  const rows: Row[] = [];
  const n = fits.length;
  let i = 0;
  while (i < n) {
    if (fits[i] === 1) { rows.push({ start: i, count: 1, columns: 1 }); i += 1; continue; }
    const thirds = (from: number, to: number): boolean => fits.slice(from, to).every((f) => f === 3);
    if (i + 3 <= n && thirds(i, i + 3)) { rows.push({ start: i, count: 3, columns: 3 }); i += 3; continue; }
    if (n - i <= 2 && thirds(i, n)) { rows.push({ start: i, count: n - i, columns: 3 }); i = n; continue; }
    const count = i + 1 < n && fits[i + 1] !== 1 ? 2 : 1;
    rows.push({ start: i, count, columns: 2 });
    i += count;
  }
  return rows;
}
