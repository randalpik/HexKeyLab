// One line → one measured system (decisions.md "Composer draws the pages", 2026-10-08).
//
// Page view no longer paints Verovio pages: every system is rendered from a
// ONE-LINE window — the system splicer's recipe (leader / trailer stubs so a
// mid-document line engraves like its neighbours, the window closed over
// spanners and endings so every tie and slur finds its other end, the view's
// staff subset minus the line's hidden staves) — and Composer assembles pages
// from the results. This is what `substituteHiddenStaffSystems` did for a
// hide-empty system on a painted page, generalised to every line: the window
// is justified at page width with `breaks:'encoded'` and the line's own `<sb>`
// pins, so the system is the one a pinned page render would have drawn
// (the reference gate has asserted that equality since Phase 1).
//
// Nothing here measures: the returned system is a parsed, never-laid-out
// element. The caller imports it into a page, runs the post passes where it
// sits (A11: geometry-dependent passes run on the live host) and measures it
// there (render/pagefit.ts `measureExtents`).

import type { ComposerModel } from '../model/index.js';
import type { VerovioToolkit } from '@hkl/notation/verovio-types.js';
import { buildWindowMei, beginsSignatureChange } from './pagesplice.js';
import { expandForSpannersOnce, expandForEndings } from './splice.js';
import { hiddenStavesFor, visibleStavesFor } from './hiddenstaves.js';

export interface LineRenderCtx {
  /** Isolated toolkit (spliceTk) — never the live one. */
  toolkit: VerovioToolkit;
  /** The live page options with `breaks:'encoded'` (pageSpliceCtx.windowOptions). */
  windowOptions: object;
  /** Single-part view's staves (null = all). */
  viewStaves: number[] | null;
}

export interface RenderedLine {
  /** The `g.system` in the window's own document (import it before use). */
  system: SVGGElement;
  /** The window document — `mergeGlyphDefs` reads its `<defs>`; its `<style>`
   *  is what a page shell carries. */
  host: Document;
  /** Staves hidden on this line (hide-empty), global @n. */
  hidden: number[];
}

/** Token a page shell replaces with its own root id (pageshell.ts). */
export const STYLE_ROOT_TOKEN = '#__HKL_PAGE_ROOT__';

/** Verovio's page `<style>` text from a window document ('' when absent),
 *  with the window's root-svg id selectors rewritten to STYLE_ROOT_TOKEN.
 *  Verovio scopes every rule by the root's id (`#p1g180gl path {stroke:…}`),
 *  so the text is only useful under a root that carries the token's id:
 *  without the rewrite no stroke rule matched and every staff line,
 *  barline and stem on an assembled page lost its stroke (2026-10-08).
 *  Only the FIRST `<style>` (the scoped rules): the `@font-face` one Verovio
 *  adds for SMuFL text goes to the document <head> (splice.ts adoptFontFaces,
 *  via mergeGlyphDefs). */
export function styleTextOf(host: Document): string {
  const root = host.querySelector('svg');
  const text = host.querySelector('svg > style')?.textContent ?? '';
  const id = root?.getAttribute('id');
  return id ? text.split('#' + id).join(STYLE_ROOT_TOKEN) : text;
}

/** Render line `li` of `lines` (start-measure ids, document order) alone.
 *  `measureIds` is every measure's xml:id in document order. Null when the
 *  window could not be built or rendered (the caller derives nothing from it:
 *  it reports and stops). */
/** Lines per Verovio window on a load: one `loadData` + `renderToSVG` lays
 *  out this many systems at once (each on its own pinned line), where a
 *  window per line paid Verovio's parse and setup 115 times on the sonata
 *  (2026-10-08: 29 ms a line of 68). The chunk never crosses a change in the
 *  hidden-staff set, since a window renders one staff subset. */
export const CHUNK_LINES = 6;

export function renderLineSystem(
  model: ComposerModel, lines: readonly string[], li: number, measureIds: readonly string[], ctx: LineRenderCtx,
): RenderedLine | null {
  return renderLineSystems(model, lines, li, li + 1, measureIds, ctx).get(li) ?? null;
}

/** Render lines [li0, li1) in ONE window — the system splicer's recipe
 *  (leader / trailer stubs, the window closed over spanners and endings, a
 *  courtesy stub when the line after the chunk begins a signature change,
 *  the view's staff subset minus the chunk's hidden staves), every line on
 *  its own pinned system. Stops early (fewer entries) where the next line's
 *  hidden-staff set differs; a line whose system cannot be found is absent. */
export function renderLineSystems(
  model: ComposerModel, lines: readonly string[], li0: number, li1: number, measureIds: readonly string[], ctx: LineRenderCtx,
): Map<number, RenderedLine> {
  const out = new Map<number, RenderedLine>();
  const total = measureIds.length;
  const lineRange = (li: number): [number, number] | null => {
    const mLo = measureIds.indexOf(lines[li]);
    if (mLo < 0) return null;
    const nextStart = li + 1 < lines.length ? measureIds.indexOf(lines[li + 1]) : total;
    return [mLo, (nextStart > mLo ? nextStart : total) - 1];
  };
  const first = lineRange(li0);
  if (!first) return out;
  /* The chunk: consecutive lines sharing one hidden-staff set. */
  const idxsOf = (lo: number, hi: number): number[] => { const a: number[] = []; for (let i = lo; i <= hi; i++) a.push(i); return a; };
  const hidden0 = hiddenStavesFor(model, idxsOf(first[0], first[1]), ctx.viewStaves);
  const key0 = hidden0.join(',');
  let liEnd = li0 + 1;
  let mHi = first[1];
  while (liEnd < li1 && liEnd < lines.length) {
    const rg = lineRange(liEnd);
    if (!rg) break;
    if (hiddenStavesFor(model, idxsOf(rg[0], rg[1]), ctx.viewStaves).join(',') !== key0) break;
    mHi = rg[1];
    liEnd++;
  }
  const mLo = first[0];
  const hidden = hidden0;
  const staves = hidden.length ? visibleStavesFor(model, ctx.viewStaves, hidden) : ctx.viewStaves;
  const meiMeasures = model.allMeasures();
  let [wLo, wHi] = expandForSpannersOnce(meiMeasures, mLo, mHi, model.docVersion());
  [wLo, wHi] = expandForEndings(meiMeasures, wLo, wHi);
  /* Courtesy signatures (the splicer's B3 rule): an end-of-line courtesy
     clef / key / meter is generated by the line that FOLLOWS, so when the next
     line begins with a signature change the window carries that line's first
     measure as a pinned one-measure stub — else the system renders without
     the courtesy a full engrave draws (the sonata's m. 47 → 48, two flats to
     five sharps: 681 units of width, 6 of 31 pages off the reference, 2026-10-08). */
  let stubId: string | null = null;
  if (mHi + 1 < total && beginsSignatureChange(meiMeasures[mHi + 1])) {
    stubId = meiMeasures[mHi + 1].getAttribute('xml:id');
    if (wHi < mHi + 1) wHi = mHi + 1;
  }
  const starts: string[] = [];
  for (let li = li0; li < liEnd; li++) starts.push(lines[li]);
  if (wHi > mHi && stubId === null) starts.push(meiMeasures[mHi + 1].getAttribute('xml:id') ?? '');
  const mei = buildWindowMei(model, wLo, wHi, starts, wLo > 0, wHi < total - 1, stubId, new Set(), staves);
  if (!mei) return out;
  /* Test hook: the last window built (probes diff it against the full serialize). */
  (globalThis as { __hklLastWindowMei?: string }).__hklLastWindowMei = mei;
  const tk = ctx.toolkit;
  /* A window that IS the whole document (a one-line score) carries no line
     pin — injectPins never pins the first measure and there is no stub to
     pin — and 'encoded' would warn "Requesting layout with line breaks but
     nothing provided". Cast it off with 'auto' instead; one line is one page
     either way. */
  const wholeDoc = wLo === 0 && wHi === total - 1 && starts.length === 1 && stubId === null;
  tk.setOptions(wholeDoc ? { ...ctx.windowOptions, breaks: 'auto' } : ctx.windowOptions);
  if (!tk.loadData(mei)) return out;
  /* A window normally lays out on one page; a user `<pb>` inside it (the line
     after a page break, with its leader before the break) legitimately puts
     systems on the window's second page. Look on every page. */
  const wanted = new Map<string, number>();
  for (let li = li0; li < liEnd; li++) wanted.set(lines[li], li);
  const pages = Math.max(1, tk.getPageCount());
  for (let p = 1; p <= pages && wanted.size; p++) {
    const host = new DOMParser().parseFromString(tk.renderToSVG(p, {}), 'image/svg+xml');
    if (host.querySelector('parsererror')) continue;
    for (const g of Array.from(host.querySelectorAll('g.system')) as SVGGElement[]) {
      const id = g.querySelector('g.measure')?.id ?? '';
      const li = wanted.get(id);
      if (li === undefined) continue;
      out.set(li, { system: g, host, hidden });
      wanted.delete(id);
    }
  }
  return out;
}
