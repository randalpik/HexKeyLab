// The Layouts tab: the lattice shape guide for a chosen mapping and tuning; and
// the Scales tab after it: a key's chords and footprint on that layout
// (HKL's /scales.html), with one more dropdown for the key.
//
// The guide itself is HKL's page /shapes.html (apps/hkl/src/shapes/page.ts),
// which shows the shapes a layout holds. It is embedded by URL in a frame — it
// is another app's page, so nothing of it is imported — and this tab only
// chooses the layout. Served on the shared origin; under the Guide's own dev
// server (:5177) there is no /shapes.html to show.
//
// The choice lives in the hash, #layouts/<mapping>/<mode>, with /<starting note>
// after it when that is not C, as preset ids only.
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
import { MAJOR_TONICS, tonicId, tonicLabel, tonicOfId } from '@hkl/shared/tonic.js';
import { KEY_PROFILE_LABELS, isKeyProfileId, type KeyProfileId } from '@hkl/shared/keyProfiles.js';

export const LAYOUTS_ID = 'layouts';
export const LAYOUTS_LABEL = 'Layouts';

export interface LayoutChoice {
  mapping: PresetMapping;
  mode: TuningMode;
  /** The starting note, one of MAJOR_TONICS: the reference is its unaltered key,
   *  and a shape starts on it wherever it holds the shape as close as any note. */
  root: string;
}

/* The first guide written: Randal in Ptolemaic, from C. */
const DEFAULT: LayoutChoice = { mapping: 'randal', mode: '5', root: 'C' };
/* The starting notes on offer: the fifteen major-key tonics, in fifths, by their URL ids. */
const ROOT_IDS: ReadonlyArray<string> = MAJOR_TONICS.map(tonicId);
const ROOT_LABELS: Readonly<Record<string, string>> = Object.fromEntries(MAJOR_TONICS.map((t) => [tonicId(t), tonicLabel(t)]));
/* The tunings the shape guide is made for: not Equal, not Schismatic. */
const MODES = SHAPE_GUIDE_MODES;

export type LayoutsTheme = 'light' | 'dark';
const THEMES: ReadonlyArray<LayoutsTheme> = ['light', 'dark'];
const THEME_LABELS: Readonly<Record<LayoutsTheme, string>> = { light: 'Light', dark: 'Dark' };
const THEME_KEY = 'hkl.guide.layoutsTheme';

function savedTheme(): LayoutsTheme {
  try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}

/** The choice a hash section names, "<mapping>/<mode>" or
 *  "<mapping>/<mode>/<starting note>"; each part falls back to the default
 *  when it is not one of the presets on offer. */
export function parseChoice(section: string | null): LayoutChoice {
  const [mapping, mode, root] = (section ?? '').split('/');
  return {
    mapping: isPresetMapping(mapping) ? mapping : DEFAULT.mapping,
    mode: MODES.find((m) => m === mode) ?? DEFAULT.mode,
    root: tonicOfId(root) ?? DEFAULT.root,
  };
}

/** The hash section for a choice; C, the default starting note, is left unsaid. */
export const choiceSection = (c: LayoutChoice): string => c.mapping + '/' + c.mode + (c.root === DEFAULT.root ? '' : '/' + tonicId(c.root));

/** The shape guide's page for a choice, in a theme. */
export const shapesUrl = (c: LayoutChoice, theme: LayoutsTheme = 'light'): string =>
  `/shapes.html?mapping=${c.mapping}&mode=${c.mode}` + (c.root === DEFAULT.root ? '' : '&root=' + tonicId(c.root)) + (theme === 'dark' ? '&theme=dark' : '');

/** A dropdown in the bar, with its label before it. */
function select<T extends string>(label: string, values: ReadonlyArray<T>, labels: Readonly<Record<T, string>>): [HTMLLabelElement, HTMLSelectElement] {
  const wrap = document.createElement('label');
  wrap.className = 'g-layouts-field';
  const sel = document.createElement('select');
  for (const v of values) sel.add(new Option(labels[v], v));
  wrap.append(label + ' ', sel);
  return [wrap, sel];
}

/** The tab's section: the mapping, tuning, starting-note and theme dropdowns,
 *  a link that opens the guide in a tab of its own (to print it; always
 *  light), and the frame. `onChoose` is told of a new mapping, tuning or
 *  starting note; `show` puts a choice on screen, in the theme chosen. */
export function buildLayouts(onChoose: (c: LayoutChoice) => void): { el: HTMLElement; show(c: LayoutChoice): void } {
  const el = document.createElement('section');
  el.className = 'g-layouts';
  el.hidden = true;
  const bar = document.createElement('div');
  bar.className = 'g-layouts-bar';
  const [mapField, mapSel] = select('Mapping', MAPPINGS, MAPPING_LABELS);
  const [modeField, modeSel] = select('Tuning', MODES, TUNING_LABELS);
  const [rootField, rootSel] = select('Starting note', ROOT_IDS, ROOT_LABELS);
  const [themeField, themeSel] = select('Theme', THEMES, THEME_LABELS);
  const open = document.createElement('a');
  open.className = 'g-layouts-open';
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = 'Open in new tab';
  bar.append(mapField, modeField, rootField, themeField, open);
  const frame = document.createElement('iframe');
  frame.className = 'g-layouts-frame';
  frame.title = 'Lattice shapes';
  el.append(bar, frame);

  let theme = savedTheme();
  themeSel.value = theme;
  const chosen = (): LayoutChoice => parseChoice(mapSel.value + '/' + modeSel.value + '/' + rootSel.value);
  const show = (c: LayoutChoice): void => {
    /* the other tab may have changed it */
    theme = savedTheme();
    themeSel.value = theme;
    mapSel.value = c.mapping;
    modeSel.value = c.mode;
    rootSel.value = tonicId(c.root);
    const url = shapesUrl(c, theme);
    open.href = shapesUrl(c);
    /* the frame's own ground is the page's (guide.css), so it does not flash while the page loads */
    frame.dataset.theme = theme;
    /* only a new layout or theme reloads the frame: coming back to the tab keeps the page and its scroll */
    if (frame.getAttribute('src') !== url) frame.src = url;
  };
  mapSel.addEventListener('change', () => onChoose(chosen()));
  modeSel.addEventListener('change', () => onChoose(chosen()));
  rootSel.addEventListener('change', () => onChoose(chosen()));
  themeSel.addEventListener('change', () => {
    theme = themeSel.value === 'dark' ? 'dark' : 'light';
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode / quota: the choice lasts the visit */ }
    show(chosen());
  });

  return { el, show };
}

/* ── the Scales tab ── */

export const SCALES_ID = 'scales';
export const SCALES_LABEL = 'Scales';

/** A layout and a key on it. `scale` null is whichever key the page shows
 *  first: which keys a layout can play is HKL's to say, not the Guide's. */
export interface ScaleChoice extends LayoutChoice {
  scale: KeyProfileId | null;
}

/** The choice a hash section names: "<mapping>/<mode>", then the key's id and
 *  the starting note's, each left out when it is the default. */
export function parseScaleChoice(section: string | null): ScaleChoice {
  const parts = (section ?? '').split('/'), scale = isKeyProfileId(parts[2]) ? parts[2] : null;
  return { ...parseChoice([parts[0], parts[1], scale ? parts[3] : parts[2]].join('/')), scale };
}
export const scaleSection = (c: ScaleChoice): string => c.mapping + '/' + c.mode + (c.scale ? '/' + c.scale : '') + (c.root === DEFAULT.root ? '' : '/' + tonicId(c.root));
export const scalesUrl = (c: ScaleChoice, theme: LayoutsTheme = 'light'): string =>
  shapesUrl(c, 'light').replace('/shapes.html', '/scales.html') + (c.scale ? '&scale=' + c.scale : '') + (theme === 'dark' ? '&theme=dark' : '');

/** The Scales tab's section: the Layouts tab's four dropdowns, a fifth for the
 *  key, the link, and the frame. The key's options are the ones the frame's
 *  page says its layout can play (a message { type: 'hkl-scales', scales,
 *  scale } from /scales.html); until it has said so the dropdown keeps what it
 *  had. `onChoose` is told of a new choice, `onShown` of the key the page
 *  shows, which is not the one asked for when the layout cannot play that;
 *  `show` puts a choice on screen. */
export function buildScales(onChoose: (c: ScaleChoice) => void, onShown: (scale: KeyProfileId | null) => void): { el: HTMLElement; show(c: ScaleChoice): void } {
  const el = document.createElement('section');
  el.className = 'g-layouts g-scales';
  el.hidden = true;
  const bar = document.createElement('div');
  bar.className = 'g-layouts-bar';
  const [mapField, mapSel] = select('Mapping', MAPPINGS, MAPPING_LABELS);
  const [modeField, modeSel] = select('Tuning', MODES, TUNING_LABELS);
  const [rootField, rootSel] = select('Starting note', ROOT_IDS, ROOT_LABELS);
  const [scaleField, scaleSel] = select('Key', [] as string[], {});
  const [themeField, themeSel] = select('Theme', THEMES, THEME_LABELS);
  const open = document.createElement('a');
  open.className = 'g-layouts-open';
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = 'Open in new tab';
  bar.append(mapField, modeField, rootField, scaleField, themeField, open);
  const frame = document.createElement('iframe');
  frame.className = 'g-layouts-frame';
  frame.title = 'Scales';
  el.append(bar, frame);

  let theme = savedTheme();
  let scale: KeyProfileId | null = null;
  const chosen = (): ScaleChoice => ({ ...parseChoice(mapSel.value + '/' + modeSel.value + '/' + rootSel.value), scale: isKeyProfileId(scaleSel.value) ? scaleSel.value : null });
  const show = (c: ScaleChoice): void => {
    theme = savedTheme();
    themeSel.value = theme;
    mapSel.value = c.mapping;
    modeSel.value = c.mode;
    rootSel.value = tonicId(c.root);
    scale = c.scale;
    if (c.scale && [...scaleSel.options].some((o) => o.value === c.scale)) scaleSel.value = c.scale;
    const url = scalesUrl(c, theme);
    open.href = scalesUrl(c);
    frame.dataset.theme = theme;
    if (frame.getAttribute('src') !== url) frame.src = url;
  };
  /* the frame's page says which keys its layout can play, and which it shows */
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== frame.contentWindow || e.data?.type !== 'hkl-scales') return;
    const ids = (Array.isArray(e.data.scales) ? e.data.scales : []).filter(isKeyProfileId);
    scaleSel.replaceChildren(...(ids.length ? ids.map((id: KeyProfileId) => new Option(KEY_PROFILE_LABELS[id], id)) : [new Option('None on this layout', '')]));
    scaleSel.disabled = !ids.length;
    if (isKeyProfileId(e.data.scale)) scaleSel.value = e.data.scale;
    el.dataset.offered = ids.join(',');
    scale = isKeyProfileId(e.data.scale) ? e.data.scale : null;
    onShown(scale);
  });
  /* a new layout keeps the key if it can: the page falls back to its first when it cannot */
  const relayout = (): void => onChoose({ ...chosen(), scale: isKeyProfileId(scaleSel.value) ? scaleSel.value : scale });
  mapSel.addEventListener('change', relayout);
  modeSel.addEventListener('change', relayout);
  rootSel.addEventListener('change', relayout);
  scaleSel.addEventListener('change', () => onChoose(chosen()));
  themeSel.addEventListener('change', () => {
    theme = themeSel.value === 'dark' ? 'dark' : 'light';
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode / quota: the choice lasts the visit */ }
    show({ ...chosen(), scale: isKeyProfileId(scaleSel.value) ? scaleSel.value : scale });
  });

  return { el, show };
}
