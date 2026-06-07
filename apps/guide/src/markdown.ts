import { marked } from 'marked';

// GFM gives us tables + fenced code blocks, which the guides use heavily.
marked.use({ gfm: true });

// GitHub-style heading slug. This MUST match the slugs the guides' own
// cross-links were authored against (verified during the docs split):
// lowercase → drop everything outside [\w\s-] → spaces to hyphens. So e.g.
// "## Ties and tuplets" → "ties-and-tuplets", matching `[Ties](#ties-and-tuplets)`.
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

// Render markdown into `container`: parse with marked, then assign slug ids to
// every heading (so anchor links resolve) and mark external links to open in a
// new tab. The markdown is our own trusted content, so no sanitizer is needed.
export function renderInto(container: HTMLElement, md: string): void {
  container.innerHTML = marked.parse(md) as string;

  const seen = new Map<string, number>();
  container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6').forEach((h) => {
    let id = slugify(h.textContent ?? '');
    if (!id) return;
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 0) id = `${id}-${n}`;
    h.id = id;
  });

  container.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
    const href = a.getAttribute('href') ?? '';
    if (/^https?:\/\//.test(href)) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  });
}
