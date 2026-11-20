// What the shape guide's two pages share (./page.ts, the Layouts guide, and
// ./scalePage.ts, a key's chords): the layout asked for in the query, how the
// pictures are drawn, and the small DOM helpers.
//
//   ?mapping=…&mode=…   a mapping (a layout id) and a tuning (5 P D 7 S Y, SHAPE_GUIDE_MODES);
//                       anything else falls back to Randal and Ptolemaic
//   ?root=…             the starting note, by its id (Cb Gb Db Ab Eb Bb F C G D A E B Fs Cs)
//   ?theme=dark         the dark theme; the page's html reads it before the first paint

import { SHAPE_GUIDE_MODES, type TuningMode } from '@hkl/shared/freq.js';
import { isMapping, type Mapping } from '@hkl/shared/mapping.js';
import { tonicOfId } from '@hkl/shared/tonic.js';
import { renderDiagram, type DiagramStyle } from './diagram.js';
import { rootedLayout, type GuideLayout } from './guide.js';
import { shownSize } from './rows.js';
import type { Cell, Shape, ShapeLayout } from './solve.js';

/* How the pictures are drawn. The page is Lumatone rotation at Vertical
   alignment in HKL's medium hex size (Max, 2026-11-17). On the dark theme the
   seams and the member keys' borders are white (Max, 2026-11-18); the labels
   stay as the lattice draws them, since they sit on the key's color. */
export const dark = document.documentElement.dataset.theme === 'dark';
export const STYLE: DiagramStyle = {
  pathAlpha: 0.45, memberBorder: 1.5, heji: true, seamWidth: 4, scale: 4,
  seamColor: dark ? '#fff' : '#000', memberBorderColor: dark ? '#fff' : '#111',
};

export const query = new URLSearchParams(location.search);
const wantMapping = query.get('mapping') ?? 'randal', wantMode = query.get('mode') ?? '5';
export const mapping: Mapping = isMapping(wantMapping) ? wantMapping : 'randal';
export const mode: TuningMode = SHAPE_GUIDE_MODES.find((m) => m === wantMode) ?? '5';
export const root = tonicOfId(query.get('root')) ?? 'C';
export const at: GuideLayout = { mode, mapping, banded: true };
/* the layout the pictures are drawn in, and its reference: on the root, the anchor following it */
const rooted = rootedLayout(at, root);
export const layout: ShapeLayout = rooted.layout;
export const ref: Cell = rooted.ref;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
export const capital = (s: string): string => s[0].toUpperCase() + s.slice(1);

/** A shape's picture as an image: shown as drawn, or scaled down to a row when
 *  it is wider than one (./rows.ts). `width` is the width it is shown at. */
export function picture(shape: Shape, alt: string): { img: HTMLImageElement; width: number } {
  const d = renderDiagram(shape, layout, STYLE);
  const img = el('img', 'diagram');
  img.src = d.canvas.toDataURL('image/png');
  const shown = shownSize(d.width, d.height);
  img.width = shown.width; img.height = shown.height;
  if (shown.scale < 1) img.dataset.scaled = shown.scale.toFixed(3);
  img.alt = alt;
  return { img, width: shown.width };
}
