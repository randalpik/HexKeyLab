// The shape guide as a page: every entry of buildGuide() with its picture,
// laid out for print (US Letter, portrait). Entry point of shapes.html — no
// audio, no MIDI, none of the lattice's own page.
//
//   /shapes.html                       Randal in Ptolemaic (the first guide)
//   /shapes.html?mapping=…&mode=…      another mapping (a layout id) and tuning (5 P D 7 S Y,
//                                      SHAPE_GUIDE_MODES); the page shows the shapes that layout holds
//   /shapes.html?root=…                the starting note, one of the fifteen major-key tonics, by its
//                                      id (Cb Gb Db Ab Eb Bb F C G D A E B Fs Cs): the reference is
//                                      its unaltered key, and a shape starts on it wherever it holds
//                                      the shape as close as any note does
//   /shapes.html?theme=dark            the dark theme: a dark page with light text, and in the
//                                      pictures white seams and a white border on the member keys.
//                                      shapes.html reads the parameter itself, before the first paint,
//                                      and leaves it on <html data-theme>.

import { SHAPE_GUIDE_MODES, TUNING_LABELS, type TuningMode } from '@hkl/shared/freq.js';
import { tonicLabel, tonicOfId } from '@hkl/shared/tonic.js';
import { isMapping, mappingLabel, type Mapping } from '@hkl/shared/mapping.js';
import { setHexSize, setRotation } from '../layout/geometry.js';
import { buildGuide, rootedLayout, type GuideEntry, type GuideLayout } from './guide.js';
import { renderDiagram, type DiagramStyle } from './diagram.js';
import { indentOf, room, rowsOf, shownSize, type Fit } from './rows.js';
import { GUIDE_ALIGNMENT, GUIDE_ROTATION, type ShapeLayout } from './solve.js';

/* How the pictures are drawn. The page is Lumatone rotation at Vertical
   alignment in HKL's medium hex size (Max, 2026-11-17). On the dark theme the
   seams and the member keys' borders are white (Max, 2026-11-18); the labels
   stay as the lattice draws them, since they sit on the key's color. */
const dark = document.documentElement.dataset.theme === 'dark';
const STYLE: DiagramStyle = {
  pathAlpha: 0.45, memberBorder: 1.5, heji: true, seamWidth: 4, scale: 4,
  seamColor: dark ? '#fff' : '#000', memberBorderColor: dark ? '#fff' : '#111',
};

const query = new URLSearchParams(location.search);
const wantMapping = query.get('mapping') ?? 'randal', wantMode = query.get('mode') ?? '5';
const mapping: Mapping = isMapping(wantMapping) ? wantMapping : 'randal';
const mode: TuningMode = SHAPE_GUIDE_MODES.find((m) => m === wantMode) ?? '5';
const root = tonicOfId(query.get('root')) ?? 'C';
const at: GuideLayout = { mode, mapping, banded: true };
/* the layout the pictures are drawn in: the reference on the root, the anchor following it */
const layout: ShapeLayout = rootedLayout(at, root).layout;

const SECTIONS: ReadonlyArray<readonly [string, (g: GuideEntry) => boolean]> = [
  ['Triads', (g) => g.family === 'triad'],
  ['Seventh chords', (g) => g.family === 'seventh'],
  ['Augmented sixth chords', (g) => g.family === 'augmented sixth'],
  ['Scales', (g) => g.family === 'scale'],
  ['Intervals', (g) => g.family === 'interval'],
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const capital = (s: string): string => s[0].toUpperCase() + s.slice(1);

/** How many entries can share a row with `g`: as many as leave room for its
 *  picture. A scale lists many intervals, so never more than two (Max,
 *  2026-11-17). */
function fitOf(g: GuideEntry, picture: number): Fit {
  const fit: Fit = picture <= room(3) ? 3 : picture <= room(2) ? 2 : 1;
  return g.kind === 'scale' && fit === 3 ? 2 : fit;
}

/** One entry: its number and title, a chord's position under it, then its ratio,
 *  starting position, intervals and picture. With it, how many can share its row. */
function entry(g: GuideEntry, n: number): { box: HTMLElement; fit: Fit } {
  const box = el('article', 'entry');
  box.id = 'e' + n;
  const head = el('h3', 'name');
  head.append(el('span', 'num', String(n)), capital(g.title));
  box.append(head);
  if (g.subtitle) box.append(el('p', 'position', g.subtitle));
  const facts = el('p', 'facts');
  facts.append(el('span', 'ratio', g.ratio));
  if (g.cents) facts.append(el('span', 'cents', g.cents));
  facts.append(' · from ', el('b', '', g.start));
  box.append(facts);
  if (g.kind !== 'interval') {
    /* two parts, each kept whole: side by side when both fit on the line, otherwise "also"
       starts a line of its own (shapes.html .part) */
    const list = el('p', 'intervals');
    const part = (cls: string, label: string, names: ReadonlyArray<string>): HTMLElement => {
      const p = el('span', 'part ' + cls);
      p.append(el('span', 'label', label + ' '), names.join(' '));
      return p;
    };
    list.append(part('steps', 'steps', g.steps));
    if (g.others.length) list.append(part('also', 'also', g.others));
    box.append(list);
  } else box.append(el('p', 'intervals', g.steps[0]));
  const d = renderDiagram(g.shape, layout, STYLE);
  const img = el('img', 'diagram');
  img.src = d.canvas.toDataURL('image/png');
  /* shown as drawn, or scaled down to its row when it is wider than one (./rows.ts) */
  const shown = shownSize(d.width, d.height);
  img.width = shown.width; img.height = shown.height;
  if (shown.scale < 1) img.dataset.scaled = shown.scale.toFixed(3);
  img.alt = g.name;
  box.append(img);
  return { box, fit: fitOf(g, shown.width) };
}

async function main(): Promise<void> {
  setHexSize('medium');
  /* the pose the solver's "higher on the page" is measured in */
  setRotation(GUIDE_ROTATION, mapping, GUIDE_ALIGNMENT);
  await document.fonts.load('12px BravuraText');
  const guide = buildGuide(at, root);
  const page = document.getElementById('guide')!;
  /* the hanging indent of titles and text, wide enough for the guide's last number (shapes.html --indent) */
  page.style.setProperty('--indent', indentOf(guide.length) + 'px');
  const start = tonicLabel(root);
  const title = `Lattice shapes from ${start}: ${mappingLabel(mapping)} mapping, ${TUNING_LABELS[mode]} tuning`;
  document.title = title;
  page.append(el('h1', '', title));
  page.append(el('p', 'legend',
    `A shape is listed only if it can be reached on the Lumatone in this layout with the reference note set to the unaltered ${start}. `
    + 'Each is drawn in its closest reachable arrangement. '
    + 'Solid keys are the notes of the shape; faint keys only show the way between them. '
    + '“From” is the possible alignments for the lowest note inside its band. '
    + `A heavy ${dark ? 'white' : 'black'} line is a band seam, drawn where the starting position matters and the shape crosses one.`));

  const index = el('nav', 'index');
  page.append(index);
  let n = 0;
  for (const [heading, belongs] of SECTIONS) {
    const entries = guide.filter(belongs);
    if (!entries.length) continue;
    const list = el('ol', '');
    list.start = n + 1;
    const group = el('div', 'index-group');
    group.append(el('h4', '', heading), list);
    index.append(group);
    const section = el('section', 'section');
    section.append(el('h2', '', heading));
    const made = entries.map((g) => {
      n++;
      const item = el('li', '');
      const link = el('a', '', capital(g.name));
      link.href = '#e' + n;
      item.append(link);
      list.append(item);
      return entry(g, n);
    });
    /* rows of three, two or one, each shared equally (./rows.ts) */
    for (const r of rowsOf(made.map((m) => m.fit))) {
      const row = el('div', 'row');
      row.dataset.columns = String(r.columns);
      row.append(...made.slice(r.start, r.start + r.count).map((m) => m.box));
      section.append(row);
    }
    page.append(section);
  }
  document.body.dataset.ready = String(n);
}
void main();
