// The five user-facing guides, bundled from docs/guide/*.md as raw text.
// docs/guide/ is the single source of truth; Vite's `?raw` import inlines the
// markdown at build time (the dev server reads it live, with HMR).
import core from '../../../docs/guide/core.md?raw';
import composer from '../../../docs/guide/composer.md?raw';
import analyzer from '../../../docs/guide/analyzer.md?raw';
import orchestrator from '../../../docs/guide/orchestrator.md?raw';
import overlay from '../../../docs/guide/overlay.md?raw';

export interface Guide {
  id: string;
  label: string;
  md: string;
}

// Tab order; the first entry (core) is the default tab.
export const GUIDES: Guide[] = [
  { id: 'core', label: 'Core', md: core },
  { id: 'composer', label: 'Composer', md: composer },
  { id: 'analyzer', label: 'Analyzer', md: analyzer },
  { id: 'orchestrator', label: 'Orchestrator', md: orchestrator },
  { id: 'overlay', label: 'Overlay', md: overlay },
];

export const GUIDE_IDS = new Set(GUIDES.map((g) => g.id));

// Map a guide-doc filename used in a cross-link (e.g. "composer.md" or
// "../guide/core.md") to its tab id, or null if it isn't one of our guides.
export function tabIdForFile(href: string): string | null {
  const m = href.replace(/^.*\//, '').match(/^([\w-]+)\.md$/);
  return m && GUIDE_IDS.has(m[1]) ? m[1] : null;
}
