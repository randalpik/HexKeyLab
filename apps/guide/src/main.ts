import './guide.css';
import { GUIDES, GUIDE_IDS, tabIdForFile } from './guides.js';
import { renderInto } from './markdown.js';
import {
  LAYOUTS_ID, LAYOUTS_LABEL, SCALES_ID, SCALES_LABEL, buildLayouts, buildScales, choiceSection, parseChoice, parseScaleChoice, scaleSection,
  type LayoutChoice, type ScaleChoice,
} from './layouts.js';

const DEFAULT_TAB = GUIDES[0].id; // core

const app = document.getElementById('app')!;
const tabsEl = document.createElement('header');
tabsEl.className = 'g-tabs';
const contentEl = document.createElement('main');
contentEl.className = 'g-content';
app.append(tabsEl, contentEl);

// ── Tab bar: the guides, then Layouts (the lattice shape guide) and Scales (a key on a layout), both ./layouts.ts ──
const TABS: ReadonlyArray<{ id: string; label: string }> = [...GUIDES, { id: LAYOUTS_ID, label: LAYOUTS_LABEL }, { id: SCALES_ID, label: SCALES_LABEL }];
const tabButtons = new Map<string, HTMLButtonElement>();
for (const t of TABS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'g-tab';
  b.textContent = t.label;
  b.addEventListener('click', () => setHash(t.id));
  tabsEl.appendChild(b);
  tabButtons.set(t.id, b);
}

// ── Lazily-rendered section per guide ─────────────────────────────────────
const sections = new Map<string, HTMLElement>();
/* The Layouts section, built on first use. Choosing a layout there goes through
   the hash, like every other navigation. */
let layouts: ReturnType<typeof buildLayouts> | null = null;
let scales: ReturnType<typeof buildScales> | null = null;
/* What the two tabs share: the mapping, tuning and starting note last shown in either, so a tab
   opened by its bare name (a click on it) takes up the other's choice; and the key last shown. */
let shared: LayoutChoice | null = null;
let sharedScale: ScaleChoice['scale'] = null;
function sectionFor(id: string): HTMLElement {
  let sec = sections.get(id);
  if (!sec && id === SCALES_ID) {
    scales = buildScales((c) => setHash(SCALES_ID, scaleSection(c)), (scale) => {
      /* the hash names the key shown: the first on offer when none was asked for, or when the
         layout cannot play the one that was */
      if (activeTab !== SCALES_ID || !shared) return;
      sharedScale = scale;
      const h = '#' + SCALES_ID + '/' + scaleSection({ ...shared, scale });
      if (location.hash !== h) history.replaceState(null, '', h);
    });
    sec = scales.el;
    contentEl.appendChild(sec);
    sections.set(id, sec);
  }
  if (!sec && id === LAYOUTS_ID) {
    layouts = buildLayouts((c) => setHash(LAYOUTS_ID, choiceSection(c)));
    sec = layouts.el;
    contentEl.appendChild(sec);
    sections.set(id, sec);
  }
  if (!sec) {
    const g = GUIDES.find((x) => x.id === id)!;
    sec = document.createElement('article');
    sec.className = 'g-doc';
    sec.hidden = true;
    renderInto(sec, g.md);
    contentEl.appendChild(sec);
    sections.set(id, sec);
  }
  return sec;
}

let activeTab = '';

function activate(tab: string, section: string | null): void {
  if (!GUIDE_IDS.has(tab) && tab !== LAYOUTS_ID && tab !== SCALES_ID) tab = DEFAULT_TAB;

  if (tab !== activeTab) {
    activeTab = tab;
    const target = sectionFor(tab);
    for (const [id, sec] of sections) sec.hidden = id !== tab;
    target.hidden = false;
    for (const [id, b] of tabButtons) b.classList.toggle('active', id === tab);
    document.title = `HexKeyLab Guide — ${TABS.find((t) => t.id === tab)!.label}`;
  }

  const sec = sectionFor(tab);
  /* Layouts: the rest of the hash is its mapping and tuning, not a heading to scroll to */
  if (tab === LAYOUTS_ID) {
    const c = section ? parseChoice(section) : shared ?? parseChoice(null);
    shared = c;
    /* a bare #layouts that took up a choice says so, without another navigation */
    if (!section && choiceSection(c) !== choiceSection(parseChoice(null))) history.replaceState(null, '', '#' + LAYOUTS_ID + '/' + choiceSection(c));
    layouts!.show(c);
    return;
  }
  if (tab === SCALES_ID) {
    const c: ScaleChoice = section ? parseScaleChoice(section) : { ...(shared ?? parseChoice(null)), scale: sharedScale };
    shared = { mapping: c.mapping, mode: c.mode, root: c.root };
    sharedScale = c.scale;
    if (!section && scaleSection(c) !== scaleSection(parseScaleChoice(null))) history.replaceState(null, '', '#' + SCALES_ID + '/' + scaleSection(c));
    scales!.show(c);
    return;
  }
  if (section) {
    const el = sec.querySelector<HTMLElement>(`[id="${section}"]`);
    if (el) {
      el.scrollIntoView({ block: 'start' });
      return;
    }
  }
  contentEl.scrollTop = 0;
}

// ── Hash routing: #<tab> or #<tab>/<section>; #layouts/<mapping>/<mode>; #scales/<mapping>/<mode>/<key> ───
function parseHash(): { tab: string; section: string | null } {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return { tab: DEFAULT_TAB, section: null };
  const slash = raw.indexOf('/');
  return slash === -1
    ? { tab: raw, section: null }
    : { tab: raw.slice(0, slash), section: raw.slice(slash + 1) || null };
}

function setHash(tab: string, section?: string | null): void {
  const h = '#' + tab + (section ? '/' + section : '');
  if (location.hash === h) {
    // No hashchange will fire (e.g. re-clicking the active tab) — act directly.
    activate(tab, section ?? null);
  } else {
    location.hash = h;
  }
}

window.addEventListener('hashchange', () => {
  const { tab, section } = parseHash();
  activate(tab, section);
});

// ── Link interception: make the markdown's relative links drive the tabs ───
function sanitizeAnchor(s: string | undefined | null): string | null {
  const m = (s ?? '').match(/[\w-]+/);
  return m ? m[0] : null;
}

contentEl.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a');
  if (!a) return;
  const href = a.getAttribute('href') ?? '';
  if (!href || /^https?:\/\//.test(href) || /^mailto:/.test(href)) return; // external — default

  const md = href.match(/([\w-]+\.md)(?:#(.+))?$/);
  if (md) {
    const tab = tabIdForFile(md[1]);
    if (tab) {
      e.preventDefault();
      setHash(tab, sanitizeAnchor(md[2]));
      return;
    }
  }

  if (href.startsWith('#')) {
    e.preventDefault();
    setHash(activeTab, sanitizeAnchor(href.slice(1)));
  }
});

// ── Boot ───────────────────────────────────────────────────────────────────
const initial = parseHash();
activate(initial.tab, initial.section);
