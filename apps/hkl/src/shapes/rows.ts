// How the shape guide's entries share the rows of a page. A row holds three
// entries, two or one, and its entries always share it equally, so the second
// entry of every two-entry row starts at the same place across the page.
//
// Pure: no DOM, so the Node oracle (test/shapes/) imports it.

/* The sheet in CSS px: 7.3 in of Letter between its 0.6 in margins. An entry
   gives up a 10pt gutter on its right (shapes.html); the rest of its share of
   the row is room for its picture, which is centered in it. */
export const SHEET = 7.3 * 96;
const GUTTER = (10 * 96) / 72;
/** The room a picture has in a row cut into `columns` equal parts. */
export const room = (columns: number): number => SHEET / columns - GUTTER;

/* An entry's title and text are set in by one indent, in which its number
   hangs; the picture is not (Max, 2026-11-18), so the indent takes no room
   from it and the rows do not depend on it. */
const INDENT = (1.7 * 9 * 96) / 72, DIGIT = (0.6 * 10 * 96) / 72, POINT = (0.3 * 10 * 96) / 72;
/** The indent of a guide whose entries are numbered `numbers` ("7", "7.1"), in
 *  CSS px: 15.3pt, which holds a number of two digits and the gap after it,
 *  and more by as much as the widest number is wider than two digits (a digit
 *  is 0.6em of the number's 10pt, the point of an inversion 0.3em). One indent
 *  for the whole guide, so its entries line up. */
export function indentOf(numbers: ReadonlyArray<string>): number {
  const width = (n: string): number => [...n].reduce((w, ch) => w + (ch === '.' ? POINT : DIGIT), 0);
  return INDENT + Math.max(0, ...numbers.map((n) => width(n) - 2 * DIGIT));
}

/* The contents are set in columns, a section to a block (Max, 2026-11-19). A
   section stays whole unless it is what makes the table tall: one longer than
   an even share of the table's lines, which no arrangement of whole sections
   could bring down to the others' height. Such a section may run on into the
   next column, as long as a break leaves at least CONTENTS_KEEP of its lines
   on either side. A section's heading and the space under it count as two
   lines. */
export const CONTENTS_KEEP = 3;
const HEADING = 2;
/** For each section of the contents, by its number of lines, whether it may
 *  break across columns. */
export function contentsSplits(lines: ReadonlyArray<number>, columns = 3): boolean[] {
  const even = lines.reduce((total, n) => total + n + HEADING, 0) / columns;
  return lines.map((n) => n >= 2 * CONTENTS_KEEP && n + HEADING > even);
}

/** The size a picture is shown at. Every picture is drawn at one key size
 *  and shown as drawn, but one wider than a row to itself is scaled down to
 *  fit it (Max, 2026-11-18): a shape that sprawls on some layout stays in that
 *  layout's guide, since "can be played there at all" is what puts a shape in
 *  a guide, and its keys come out smaller than the rest. `scale` is 1 for a
 *  picture shown as drawn. */
export function shownSize(width: number, height: number): { width: number; height: number; scale: number } {
  const most = Math.floor(room(1));
  if (width <= most) return { width, height, scale: 1 };
  const scale = most / width;
  return { width: most, height: Math.round(height * scale), scale };
}

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
