import './guide.css';
import { GUIDES, GUIDE_IDS, tabIdForFile } from './guides.js';
import { renderInto } from './markdown.js';

const DEFAULT_TAB = GUIDES[0].id; // core

const app = document.getElementById('app')!;
const tabsEl = document.createElement('header');
tabsEl.className = 'g-tabs';
const contentEl = document.createElement('main');
contentEl.className = 'g-content';
app.append(tabsEl, contentEl);

// ── Tab bar ──────────────────────────────────────────────────────────────
const tabButtons = new Map<string, HTMLButtonElement>();
for (const g of GUIDES) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'g-tab';
  b.textContent = g.label;
  b.addEventListener('click', () => setHash(g.id));
  tabsEl.appendChild(b);
  tabButtons.set(g.id, b);
}

// ── Lazily-rendered section per guide ─────────────────────────────────────
const sections = new Map<string, HTMLElement>();
function sectionFor(id: string): HTMLElement {
  let sec = sections.get(id);
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
  if (!GUIDE_IDS.has(tab)) tab = DEFAULT_TAB;

  if (tab !== activeTab) {
    activeTab = tab;
    const target = sectionFor(tab);
    for (const [id, sec] of sections) sec.hidden = id !== tab;
    target.hidden = false;
    for (const [id, b] of tabButtons) b.classList.toggle('active', id === tab);
    document.title = `HexKeyLab Guide — ${GUIDES.find((g) => g.id === tab)!.label}`;
  }

  const sec = sectionFor(tab);
  if (section) {
    const el = sec.querySelector<HTMLElement>(`[id="${section}"]`);
    if (el) {
      el.scrollIntoView({ block: 'start' });
      return;
    }
  }
  contentEl.scrollTop = 0;
}

// ── Hash routing: #<tab> or #<tab>/<section> ──────────────────────────────
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
