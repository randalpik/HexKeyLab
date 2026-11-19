// The Layouts tab: the lattice shape guide for a chosen mapping and tuning.
//
// The guide itself is HKL's page /shapes.html (apps/hkl/src/shapes/page.ts),
// which shows the shapes a layout holds. It is embedded by URL in a frame — it
// is another app's page, so nothing of it is imported — and this tab only
// chooses the layout. Served on the shared origin; under the Guide's own dev
// server (:5177) there is no /shapes.html to show.
//
// The choice lives in the hash, #layouts/<mapping>/<mode>, as preset ids only.
// The Guide's URL is part of every usage-analytics payload, so it may carry a
// short enumeration and never anything typed (docs/architecture.md → Usage
// analytics); a hash that names anything else falls back to the default.
//
// The theme, light or dark, is how the reader likes to look at it, not what is
// shown: like Composer's it is remembered in localStorage and stays out of the
// hash. It reaches the frame's page as ?theme=dark and paints the frame's
// ground. The "Open in new tab" link always opens the light page, the one that
// prints (Max, 2026-11-18).

import { MAPPINGS, MAPPING_LABELS, isPresetMapping, type PresetMapping } from '@hkl/shared/mapping.js';
import { SHAPE_GUIDE_MODES, TUNING_LABELS, type TuningMode } from '@hkl/shared/freq.js';

export const LAYOUTS_ID = 'layouts';
export const LAYOUTS_LABEL = 'Layouts';

export interface LayoutChoice {
  mapping: PresetMapping;
  mode: TuningMode;
}

/* The first guide written: Randal in Ptolemaic. */
const DEFAULT: LayoutChoice = { mapping: 'randal', mode: '5' };
/* The tunings the shape guide is made for: not Equal, not Schismatic. */
const MODES = SHAPE_GUIDE_MODES;

export type LayoutsTheme = 'light' | 'dark';
const THEMES: ReadonlyArray<LayoutsTheme> = ['light', 'dark'];
const THEME_LABELS: Readonly<Record<LayoutsTheme, string>> = { light: 'Light', dark: 'Dark' };
const THEME_KEY = 'hkl.guide.layoutsTheme';

function savedTheme(): LayoutsTheme {
  try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}

/** The choice a hash section names, "<mapping>/<mode>"; each half falls back
 *  to the default when it is not one of the presets on offer. */
export function parseChoice(section: string | null): LayoutChoice {
  const [mapping, mode] = (section ?? '').split('/');
  return {
    mapping: isPresetMapping(mapping) ? mapping : DEFAULT.mapping,
    mode: MODES.find((m) => m === mode) ?? DEFAULT.mode,
  };
}

/** The hash section for a choice. */
export const choiceSection = (c: LayoutChoice): string => c.mapping + '/' + c.mode;

/** The shape guide's page for a choice, in a theme. */
export const shapesUrl = (c: LayoutChoice, theme: LayoutsTheme = 'light'): string =>
  `/shapes.html?mapping=${c.mapping}&mode=${c.mode}` + (theme === 'dark' ? '&theme=dark' : '');

/** A dropdown in the bar, with its label before it. */
function select<T extends string>(label: string, values: ReadonlyArray<T>, labels: Readonly<Record<T, string>>): [HTMLLabelElement, HTMLSelectElement] {
  const wrap = document.createElement('label');
  wrap.className = 'g-layouts-field';
  const sel = document.createElement('select');
  for (const v of values) sel.add(new Option(labels[v], v));
  wrap.append(label + ' ', sel);
  return [wrap, sel];
}

/** The tab's section: the mapping, tuning and theme dropdowns, a link that
 *  opens the guide in a tab of its own (to print it; always light), and the
 *  frame. `onChoose` is told of a new mapping or tuning; `show` puts a choice
 *  on screen, in the theme chosen. */
export function buildLayouts(onChoose: (c: LayoutChoice) => void): { el: HTMLElement; show(c: LayoutChoice): void } {
  const el = document.createElement('section');
  el.className = 'g-layouts';
  el.hidden = true;
  const bar = document.createElement('div');
  bar.className = 'g-layouts-bar';
  const [mapField, mapSel] = select('Mapping', MAPPINGS, MAPPING_LABELS);
  const [modeField, modeSel] = select('Tuning', MODES, TUNING_LABELS);
  const [themeField, themeSel] = select('Theme', THEMES, THEME_LABELS);
  const open = document.createElement('a');
  open.className = 'g-layouts-open';
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = 'Open in new tab';
  bar.append(mapField, modeField, themeField, open);
  const frame = document.createElement('iframe');
  frame.className = 'g-layouts-frame';
  frame.title = 'Lattice shapes';
  el.append(bar, frame);

  let theme = savedTheme();
  themeSel.value = theme;
  const chosen = (): LayoutChoice => parseChoice(mapSel.value + '/' + modeSel.value);
  const show = (c: LayoutChoice): void => {
    mapSel.value = c.mapping;
    modeSel.value = c.mode;
    const url = shapesUrl(c, theme);
    open.href = shapesUrl(c);
    /* the frame's own ground is the page's (guide.css), so it does not flash while the page loads */
    frame.dataset.theme = theme;
    /* only a new layout or theme reloads the frame: coming back to the tab keeps the page and its scroll */
    if (frame.getAttribute('src') !== url) frame.src = url;
  };
  mapSel.addEventListener('change', () => onChoose(chosen()));
  modeSel.addEventListener('change', () => onChoose(chosen()));
  themeSel.addEventListener('change', () => {
    theme = themeSel.value === 'dark' ? 'dark' : 'light';
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode / quota: the choice lasts the visit */ }
    show(chosen());
  });

  return { el, show };
}
