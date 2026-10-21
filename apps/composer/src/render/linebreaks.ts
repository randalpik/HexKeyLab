// Page-view line-break ownership (Phase C foundation — "own the line-breaking",
// docs/architecture/composer.md, Page view).
//
// In page view, Composer — not Verovio's castoff — decides which measure starts
// each system. The partition is pinned as render-time <sb> elements injected
// into the serialized render MEI (never into the live doc: saves, undo
// snapshots and history diffs stay pin-free by construction). Verovio remains
// the measure-level engraver + within-line justifier; with every boundary
// pinned, castoff has no free choices left, so an edit can only move the
// boundaries WE move.
//
// THE PARTITION IS ONE PURE FUNCTION OF THE DOCUMENT (docs/composer-partition-
// consistency-spec.md; decisions.md "Partition: the reach-back curve", Max
// 2026-10-20). Each SECTION (the measures between hard starts — every measure
// after a user or section-level sb/pb) is partitioned by F, render/balance.ts
// `partitionSection`: greedy lines at fill ≤ 1.00, then the best layout on the
// reach-back curve. A load runs F over every section; an edit carries the
// partition across by line MEMBERSHIP (which only says which sections it
// touched and keeps pages by line) and then runs the SAME F over every touched
// section in full. So a load and an edit compute the same layout, a reload
// never changes the screen, and undo restores the layout exactly — there is no
// edit algorithm to keep equivalent, no legality envelope, and no bound on how
// far a section's answer reaches. (This replaces the 2026-08-30 "never
// re-derived" repair loop and its [MIN_FILL, FIT_MAX] envelope, whose suffix
// balance disagreed with the load's: undoing a one-note delete at the
// sonata's m. 250 left 19 boundaries moved.) Manual line breaks
// (2026-09-11/12, linebreakCommands.ts) are plain <sb> LOCKS in the document:
// a lock is a hard start like any other, so it splits its section — the
// layout never holds state the document could not reproduce after a reload
// (Max's ruling, 2026-09-12).
//
// Lifecycle:
//   derive render (doc load / zoom / page scale / staff filter / any fallback)
//     → today's strategy, byte-identical output (nothing changes at enablement);
//       the partition is ADOPTED from the laid-out toolkit lazily — an
//       idle-chunked renderToSVG walk (~2 s on the 37-page sonata), finished
//       synchronously if an edit arrives first.
//   edit in page view (narrow accumulated dirty range)
//     → naturals for the dirty window are (re)measured from an offscreen
//       breaks:'none' sub-render (spanner/ending-complete, context-padded),
//       the partition is carried across by membership, every section the
//       edit touched is re-partitioned by F (hard breaks respected), pins
//       are re-encoded, and the doc re-renders with
//       breaks:'line' — every <sb> honored VERBATIM, pages still broken
//       automatically by height (probed 2026-08-30: 'line', unlike 'smart',
//       never wraps a pinned line it deems overfull, so the partition really
//       is ours; 'smart' rewrapped refilled lines wholesale). Docs with user
//       page breaks render 'encoded' instead — 'line' ignores <pb>, and
//       verbatim page semantics are what those docs already have today.
//   anything the refill can't prove (structural dirty, changed user breaks or
//   head/staff context, missing ids, window caps) → derive, never silently.
//
// Pin placement rules (probed 2026-08-30, lessons.md):
//   - a pin lands directly BEFORE its measure — including directly after a
//     scoreDef (matches the model's own section-break convention
//     `scoreDef, sb, measure`; partition parity verified for both orders);
//   - a pin whose position directly follows an </ending> goes INSIDE the
//     wrapper as its last child (smart castoff silently ignores it outside);
//   - an existing user sb/pb directly before the measure IS the break — no pin.

import type { VerovioToolkit } from '@hkl/notation/verovio-types.js';
import type { ComposerModel } from '../model/index.js';
import type { RenderUnitIndex } from '../model/multirest.js';
import { expandForSpanners, expandForEndings } from './splice.js';
import { captureSigState, signatureRanges, unionRun, type SigState } from './sigranges.js';
import { partitionSection, sectionAtoms, greedyStarts, FINAL_GREEDY_BELOW } from './balance.js';

const MEI_NS = 'http://www.music-encoding.org/ns/mei';

/** The document's LAST system, when its section stayed greedy (a final section
 *  under FINAL_GREEDY_BELOW lines — balance.ts), is justified only at this
 *  fill or above (Max, 2026-10-20: "a little less eager than 0.65"); when the
 *  final section ran through F's pick it is always justified. Fills are
 *  (sigW + Σ natural widths)/budget. See `finalSystemJustified`. */
export const FINAL_JUSTIFY_FILL = 0.70;
/** Naturals windows one repartition may render before giving up (derive). An
 *  edit's dirty range is one window; a touched section's other naturals are
 *  cached from the load (`warmAllNaturals`), so this is generous. */
const MAX_ENSURES = 64;
/** A naturals window never spans more measures than this: a long governed
 *  signature range (a meter change mid-piece governs to the next change) is
 *  measured in chunks instead of refused ('repartition window/cap exhausted'
 *  derived the whole document for it until 2026-10-08). */
const ENSURE_CHUNK = 96;
/** A single naturals window (post spanner/ending expansion) larger than this
 *  falls back to a derive render instead. */
const WINDOW_CAP = 260;
/** Largest single naturals window the balancer asks for (before context and
 *  spanner/ending expansion, which WINDOW_CAP still bounds). */
const BALANCE_WINDOW = 120;

function indexCheckEnabled(): boolean {
  return typeof globalThis !== 'undefined' &&
    (globalThis as { __HKL_INDEX_CHECK?: boolean }).__HKL_INDEX_CHECK === true;
}

/** Everything the owner needs from the Renderer. */
export interface PageBreaksCtx {
  /** Isolated toolkit for offscreen naturals renders (never the live one). */
  naturalsToolkit(): VerovioToolkit;
  /** breaks:'none' options at the current zoom preset with a huge page budget
   *  (scroll geometry) so a window renders as one unwrapped system. */
  naturalsOptions(): object;
  /** Max justified system width (SVG user units) from the live page DOM;
   *  null while nothing is mounted. */
  budgetW(): number | null;
  /** Is page `page` currently drawn (exists and is not a placeholder)? The
   *  balance job orders sections by it and drops the change penalty for a
   *  section with no mounted line. */
  isPageMounted(page: number): boolean;
}

/** Refill display strategy: 'line' honors every <sb> VERBATIM (castoff never
 *  wraps even an overfull pinned line — unlike 'smart', which re-wraps by its
 *  own context-dependent fit metric; probed 2026-08-30) while still paginating
 *  automatically by height. Docs with user page breaks render 'encoded'
 *  instead — 'line' ignores <pb>, and verbatim page semantics are what those
 *  docs already have today. */
export type RefillStrategy = 'line' | 'encoded';

/** A successful refill: the committed partition plus everything the Phase C-B
 *  system splicer needs to decide whether the edit can land as a DOM splice
 *  instead of a full loadData render (see render/pagesplice.ts). */
export interface RefillResult {
  strategy: RefillStrategy;
  /** Lazily serialize + pin the full doc — only the full-render path pays for
   *  it. Null when pin injection fails (caller must derive). */
  mei: () => string | null;
  /** Sig-diff changed run in CURRENT (new) measure indices; null = the doc is
   *  signature-identical to the committed baseline (a no-op render). */
  changedRun: { lo: number; hi: number } | null;
  /** Partition the mounted DOM currently renders (pre-edit). */
  oldStartIds: string[];
  /** Partition just committed (what the DOM must render after this edit). */
  newStartIds: string[];
  /** Pagination the mounted DOM renders (pre-edit) and the one just committed
   *  — page-start line ids, page 1 first. Pages are carried by LINE: a
   *  surviving line keeps its page, so an id here changes only when a page's
   *  first line got a new start measure (its old one was deleted) — the page
   *  grid itself is unchanged and the splicer handles it. The COUNT changes
   *  only when a page's every line vanished (the page collapses). Empty when
   *  pagination isn't owned. */
  oldPageStartIds: string[];
  newPageStartIds: string[];
  /** Nothing inside any measure changed — only the partition (a manual
   *  line-break command, 2026-09-11): the splicer may treat the hunk like the
   *  balancer's partition-only changes. */
  partitionOnly: boolean;
  /** A page break or section header was added or removed: pages must re-fit
   *  from the break's page even when `changedRun` is null (2026-10-08). */
  breaksChanged: boolean;
  /** Measure ids those breaks precede (added and removed). */
  breakIds: string[];
}

/** A manual line-break edit in CURRENT measure indices: the measures a newly
 *  added lock precedes (the `lock:` sig diff in tryRefill). A lock is a
 *  DOCUMENT change and nothing more (Max, 2026-09-12): the layout must never
 *  hold state the document cannot reproduce after a reload, so there is no
 *  "dissolve this soft start" or "keep this line over-tight" side channel —
 *  the line is split at the lock and the ordinary carry/repair/balance does
 *  the rest, exactly as for a measure insert. A removed lock changes nothing
 *  here: the boundary merely stops being hard. */
interface PartitionEdit { addStarts: number[]; removedAt: number[] }

/* ── pure helpers ─────────────────────────────────────────────────────────── */

/** System-start measure ids of one rendered page SVG, in order. */
export function systemStartsFromPageSvg(svgText: string): string[] {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const starts: string[] = [];
  for (const sys of Array.from(doc.querySelectorAll('g.system'))) {
    const first = sys.querySelector('g.measure');
    if (first?.id) starts.push(first.id);
  }
  return starts;
}

/** Line- and page-start measure ids of a laid-out toolkit, read from PAGE-BASED
 *  MEI (`getMEI({scoreBased:false})` → `<page>`/`<system>` wrappers) instead of
 *  rendering every page to SVG. Measured on the sonata: ~100 ms vs ~1830 ms for
 *  the SVG walk, byte-identical output (118 lines / 37 pages). Returns null
 *  when the output can't be read, and the caller falls back to the SVG walk.
 *
 *  `tk` must hold the layout to read (loadData done, nothing else needed). */
export function partitionFromLayout(
  tk: VerovioToolkit,
): { lines: string[]; pages: string[] } | null {
  let xml: string;
  try {
    xml = tk.getMEI({ scoreBased: false });
  } catch {
    return null;
  }
  if (!xml) return null;
  /* Verovio echoes our `hkl:` metadata elements but drops the xmlns:hkl
     declaration, so its output is not well-formed as-is (2026-08-30). */
  const src = /xmlns:hkl=/.test(xml)
    ? xml
    : xml.replace(/<mei\s/, '<mei xmlns:hkl="http://www.hexkeylab.org/ns" ');
  const doc = new DOMParser().parseFromString(src, 'application/xml');
  if (doc.querySelector('parsererror')) return null;
  const lines: string[] = [];
  const pages: string[] = [];
  for (const page of Array.from(doc.getElementsByTagNameNS('*', 'page'))) {
    let firstOfPage: string | null = null;
    for (const sys of Array.from(page.getElementsByTagNameNS('*', 'system'))) {
      const m = sys.getElementsByTagNameNS('*', 'measure')[0];
      const id = m ? m.getAttribute('xml:id') : null;
      if (!id) continue;
      lines.push(id);
      if (!firstOfPage) firstOfPage = id;
    }
    if (firstOfPage) pages.push(firstOfPage);
  }
  return lines.length ? { lines, pages } : null;
}

/** Inject partition pins into a serialized render MEI: an `<sb>` (or `<pb>`
 *  for ids in `pageStartIds`) before every line-start measure except the
 *  first. Returns null when a start id is missing from the document (the
 *  caller must fall back to a derive render). See the placement rules above. */
export function injectPins(
  mei: string, startIds: string[], pageStartIds?: Set<string> | null,
): string | null {
  const doc = new DOMParser().parseFromString(mei, 'application/xml');
  if (doc.querySelector('parsererror')) return null;
  const byId = new Map<string, Element>();
  for (const m of Array.from(doc.querySelectorAll('measure'))) {
    const id = m.getAttribute('xml:id');
    if (id) byId.set(id, m);
  }
  let n = 0;
  for (let i = 1; i < startIds.length; i++) {
    const id = startIds[i];
    const m = byId.get(id);
    if (!m) return null;
    const wantPb = pageStartIds?.has(id) ?? false;
    const mk = (): Element => {
      const e = doc.createElementNS(MEI_NS, wantPb ? 'pb' : 'sb');
      e.setAttribute('xml:id', 'hklpin-' + n++);
      return e;
    };
    let node: Element = m;
    let container = node.parentElement;
    if (!container) return null;
    if (container.localName === 'ending' && node.previousElementSibling === null) {
      /* line starts at an ending's first measure → position is before the
         wrapper at section level */
      node = container;
      container = node.parentElement;
      if (!container) return null;
    }
    const prev = node.previousElementSibling;
    if (prev && (prev.localName === 'sb' || prev.localName === 'pb')) {
      /* an existing user/section break already forces this boundary; for a
         page start over an sb, upgrade it to pb in the render copy only */
      if (wantPb && prev.localName === 'sb') {
        const pb = mk();
        for (const at of prev.getAttributeNames()) {
          if (at !== 'xml:id') pb.setAttribute(at, prev.getAttribute(at)!);
        }
        container.replaceChild(pb, prev);
      }
      continue;
    }
    if (prev && prev.localName === 'ending') {
      prev.appendChild(mk());      // smart castoff ignores an sb AFTER </ending>
      continue;
    }
    container.insertBefore(mk(), node);
  }
  return new XMLSerializer().serializeToString(doc);
}

/** A measure's FLOW signature: its serialized XML with its OWN `@n` removed.
 *
 *  The full signature answers "must this measure be REDRAWN"; the flow
 *  signature answers "must its line be RE-FLOWED" (2026-09-02, Max). The two
 *  differ for exactly one edit shape and it is a common one: `renumberMeasures`
 *  is section-aware and rewrites `@n` for every measure to the end of the
 *  enclosing section, so inserting a measure near a section start reports that
 *  whole section as changed. Those measures DO need redrawing — the measure
 *  number is rendered, one per line start — but a number is an overlay label
 *  above the staff, so their widths and their lines' fills cannot have moved,
 *  and re-measuring 134 naturals for it cost 675 ms of a 2.6 s insert
 *  (`edit-cost-attribution.js --arg "edit=ctrlm,mi=8"`). Flow differences are a subset
 *  of full differences, always.
 *
 *  Only the measure element's own attribute is stripped: its opening tag ends
 *  at the first '>', so nested `staff@n` / `layer@n` are untouched. */
function measureFlowSig(raw: string): string {
  const gt = raw.indexOf('>');
  if (gt < 0) return raw;
  return raw.slice(0, gt).replace(/\s+n="[^"]*"/, '') + raw.slice(gt);
}

/** Measure ids (document order) of the live doc. */
function measureIds(meiMeasures: Element[]): string[] {
  return meiMeasures.map((m) => m.getAttribute('xml:id') ?? '');
}

/** Signature of the user break structure (section-level sb/pb). Any real
 *  change — Ctrl+B page break, section header add/remove/move — invalidates a
 *  narrow dirty range's meaning for the partition, so the refill guards on it.
 *
 *  Keyed on the measure each break PRECEDES, by xml:id, not on a running
 *  measure count (2026-09-02). The count encoding aliased position onto
 *  identity: inserting a blank measure anywhere above a break shifted every
 *  later count, so Ctrl+M insert-measure tripped this guard and derived —
 *  2.8 s on the sonata for an edit whose break structure had not changed at
 *  all (`command-splice-inventory.js`). Ids are stable, so the signature now changes when a
 *  break is added, removed, or moved to another measure, and only then. A
 *  trailing break with no following measure keys on `$end`. */
function computeUserBreakSig(model: ComposerModel): string {
  const section = model.getDoc().querySelector('section');
  if (!section) return '';
  const parts: string[] = [];
  const pending: string[] = [];
  const flush = (id: string): void => {
    while (pending.length) parts.push(pending.shift() + ':' + id);
  };
  const walk = (el: Element): void => {
    for (const c of Array.from(el.children)) {
      if (c.localName === 'measure') flush(c.getAttribute('xml:id') ?? '?');
      else if (c.localName === 'pb') pending.push('pb');
      /* A plain <sb> is a MANUAL LINE BREAK (`lock:`, 2026-09-11) — a
         partition edit the refill handles; a section header's <sb> and a
         <pb> are structural and still derive. */
      else if (c.localName === 'sb') pending.push(c.getAttribute('data-hkl-section') === 'true' ? 'sb' : 'lock');
      else if (c.localName !== 'scoreDef' && c.querySelector('measure')) walk(c);
    }
  };
  walk(section);
  flush('$end');
  return parts.join(',');
}

/** Diff two user-break signatures: the measure ids whose break (a manual
 *  `lock:`, a `pb:` page break or a section header's `sb:`) was added /
 *  removed. Every kind is a LINE-START edit the refill carries like a lock
 *  (an added break splits its line; a removed one merely stops being hard);
 *  `structural` flags a page break or section header among them, which the
 *  renderer answers with a page re-fit even when no line changed ("Every edit
 *  is a splice", 2026-10-08 — until then these derived). */
function diffBreakSigs(oldSig: string, newSig: string): { added: string[]; removed: string[]; removedStructural: string[]; structural: boolean } {
  const parse = (sig: string): Set<string> => new Set(sig ? sig.split(',') : []);
  const a = parse(oldSig), b = parse(newSig);
  const added = new Set<string>(), removed = new Set<string>(), removedStructural = new Set<string>();
  let structural = false;
  const idOf = (e: string): string => e.slice(e.indexOf(':') + 1);
  for (const e of b) if (!a.has(e)) { if (!e.startsWith('lock:')) structural = true; added.add(idOf(e)); }
  for (const e of a) if (!b.has(e)) { if (!e.startsWith('lock:')) { structural = true; removedStructural.add(idOf(e)); } removed.add(idOf(e)); }
  added.delete('$end'); removed.delete('$end'); removedStructural.delete('$end');
  return { added: [...added], removed: [...removed], removedStructural: [...removedStructural], structural };
}

/** Measure range (CURRENT indices) of the lines whose starts differ between
 *  two partitions — from the line BEFORE the first moved start (its end moved)
 *  through the last moved line — i.e. what a partition-only splice redraws.
 *  Null when the partitions are equal or an id is unknown. Mirrors
 *  Renderer.applyPartitionChange's hunk. */
export function partitionHunk(
  oldStartIds: readonly string[], newStartIds: readonly string[], idIdx: Map<string, number>, n: number,
): { lo: number; hi: number } | null {
  const N = oldStartIds.length, M = newStartIds.length;
  let pre = 0;
  while (pre < Math.min(N, M) && oldStartIds[pre] === newStartIds[pre]) pre++;
  let suf = 0;
  while (suf < Math.min(N, M) - pre && oldStartIds[N - 1 - suf] === newStartIds[M - 1 - suf]) suf++;
  if (N === M && pre === N) return null;
  const a = Math.max(0, pre - 1), bNew = M - 1 - suf;
  const lo = idIdx.get(newStartIds[a]);
  const hiEnd = bNew + 1 < M ? idIdx.get(newStartIds[bNew + 1]) : n;
  if (lo == null || hiEnd == null) return null;
  return { lo, hi: Math.max(lo, hiEnd - 1) };
}

/** Measure ids a MANUAL line break precedes: a plain `<sb>` (no
 *  `data-hkl-section`) in the doc's section stream — an Alt+Shift+↑/↓ lock or
 *  any foreign `<sb>`. Subset of `hardStartIds`; the lock glyphs draw from it. */
export function lockStartIds(model: ComposerModel): Set<string> {
  const out = new Set<string>();
  const section = model.getDoc().querySelector('section');
  if (!section) return out;
  let pending = false;
  const walk = (el: Element): void => {
    for (const c of Array.from(el.children)) {
      if (c.localName === 'measure') {
        if (pending) { const id = c.getAttribute('xml:id'); if (id) out.add(id); }
        pending = false;
      } else if (c.localName === 'sb') {
        if (c.getAttribute('data-hkl-section') !== 'true') pending = true;
      } else if (c.localName !== 'scoreDef' && c.localName !== 'pb' && c.querySelector('measure')) {
        walk(c);
      }
    }
  };
  walk(section);
  return out;
}

/** Measure ids that MUST start a line: those directly preceded by a user
 *  sb/pb in the doc's section stream. */
export function hardStartIds(model: ComposerModel): Set<string> {
  const out = new Set<string>();
  const section = model.getDoc().querySelector('section');
  if (!section) return out;
  let pending = false;
  const walk = (el: Element): void => {
    for (const c of Array.from(el.children)) {
      if (c.localName === 'measure') {
        if (pending) { const id = c.getAttribute('xml:id'); if (id) out.add(id); }
        pending = false;
      } else if (c.localName === 'sb' || c.localName === 'pb') {
        pending = true;
      } else if (c.localName !== 'scoreDef' && c.querySelector('measure')) {
        walk(c);
      }
    }
  };
  walk(section);
  return out;
}

/** Line-index ranges [kLo, kHi] of the SECTIONS of a partition: a section
 *  begins at line 0 and at every hard-start line (a measure after a user or
 *  section-level sb/pb). Measures move freely inside a section, never across. */
function sectionRanges(starts: number[], ids: string[], hard: Set<string>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let kLo = 0;
  for (let k = 1; k < starts.length; k++) {
    if (hard.has(ids[starts[k]])) { out.push([kLo, k - 1]); kLo = k; }
  }
  out.push([kLo, starts.length - 1]);
  return out;
}

/** Page bookkeeping after the lines [kLo, kLo+n0) were replaced by n1 lines
 *  (pages are carried by LINE index, B2).
 *
 *  Shrinking (n1 < n0): a page starting past the section shifts up by the lines
 *  removed; a page whose first line was one of the removed tail lines now
 *  begins at the line after the section (the tail merged into lines that end on
 *  the previous page); a page left with no line collapses into its predecessor.
 *
 *  Growing (n1 > n0): a page starting past the section shifts DOWN by the lines
 *  added — the section now needs one more system than the page grid allotted
 *  it, exactly as a repair that inserts a line does (`lineInserted`). A section
 *  can grow because the line count is greedy's over the current content
 *  (balance.ts `partitionSection`) rather than only ever merged away. */
function linesReplaced(pageLines: number[], kLo: number, n0: number, n1: number, lineCount: number): void {
  const d = n0 - n1;
  if (d === 0) return;
  if (d < 0) {
    for (let p = 0; p < pageLines.length; p++) {
      if (pageLines[p] >= kLo + n0) pageLines[p] -= d;
    }
    return;
  }
  for (let p = 0; p < pageLines.length; p++) {
    const L = pageLines[p];
    if (L >= kLo + n0) pageLines[p] = L - d;
    else if (L >= kLo + n1) pageLines[p] = kLo + n1;
  }
  for (let p = pageLines.length - 1; p >= 0; p--) {
    if (pageLines[p] >= lineCount || (p > 0 && pageLines[p] <= pageLines[p - 1])) pageLines.splice(p, 1);
  }
}

/** Head-level context that is NOT the head scoreDef's key/meter: the
 *  section-level elements before the first measure (scoreDefs excluded — they
 *  are interior entries) plus the composer/footer credits, which are injected
 *  per page mount and would go stale under a splice or no-op skip. Folded into
 *  the head's `rest` (sigranges.ts): a change here still derives. */
function headExtra(model: ComposerModel): string {
  const doc = model.getDoc();
  const ser = new XMLSerializer();
  const first = doc.querySelector('section measure');
  let pre = '';
  if (first) {
    let top: Element = first;
    while (top.parentElement && top.parentElement.localName !== 'section') top = top.parentElement;
    let node = top.previousElementSibling;
    while (node) {
      if (node.localName !== 'scoreDef') pre = ser.serializeToString(node) + pre;
      node = node.previousElementSibling;
    }
  }
  return pre + '|' + model.getComposer() + '|' + model.getFooter();
}

/* ── the owner ────────────────────────────────────────────────────────────── */


/** What F picked for one section (diagnostics; balance.ts `SectionPartition`). */
export interface SectionPick {
  /** First measure id of the section. */
  from: string;
  lines: number;
  /** Line starts moved off greedy. */
  changes: number;
  /** Lowest fill / spread over the lines the pick changed (+ the neighbour). */
  min: number;
  sd: number;
  /** Distinct layouts on the section's curve. */
  layouts: number;
  /** A final section under FINAL_GREEDY_BELOW lines, kept greedy. */
  exempt: boolean;
}

/** Diagnostics of one partition pass (the load's, or an edit's). */
export interface BalanceStats {
  sections: number;
  /** Sections whose line starts F changed. */
  applied: number;
  /** Line starts that moved (symmetric difference, by measure). */
  changed: number;
  /** Lines removed (negative: the sections grew). */
  removed: number;
  reasons: string[];
  /** One per section F ran on, document order. */
  picks: SectionPick[];
  ms: number;
}

const emptyBalanceStats = (): BalanceStats =>
  ({ sections: 0, applied: 0, changed: 0, removed: 0, reasons: [], picks: [], ms: 0 });

/** The owner's width caches, as the renderer's partition cache carries them
 *  across a zoom / page-scale / view round-trip (2026-09-12). Natural measure
 *  widths and leading clef+key widths are in Verovio's logical units, which
 *  `unit` (constant across every zoom preset) fixes — measured identical at
 *  zoom 50 and 100 on the sonata — and they do not depend on the page
 *  rectangle either, so they are valid for any budget. Only the budget is
 *  re-measured. */
export interface OwnerWidths {
  naturals: Map<string, number>;
  sigW: Map<string, number>;
  /** First-system instrument-name indent (see measureLabelIndent). Carried
   *  with the other widths because a partition-cache restore measures no
   *  window: without it the document's first line has no leading width and
   *  every refill is refused until reload — the 2026-09-12 zoom defect, in a
   *  new place. Null when nothing has been measured yet. */
  labelIndent: number | null;
}

/** Cache / identity key of a staff subset: sorted staff numbers, or 'all'. */
export function viewKeyOf(viewStaves: number[] | null | undefined): string {
  return viewStaves ? viewStaves.slice().sort((a, b) => a - b).join(',') : 'all';
}

export class PageLineBreaks {
  /** Adopted partition: line-start measure ids, document order. Null until a
   *  derive render's layout has been read (or a refill committed its own). */
  private startIds: string[] | null = null;
  /** Adopted PAGINATION: the subset of `startIds` that begins a page, document
   *  order, page 1's start included (it needs no pin — the document starts
   *  there — but keeping it makes the list a faithful page index). Pages are
   *  owned exactly like lines: adopted from a derive render, pinned as `<pb>`,
   *  carried across edits, and only changed when a page stops being legal. */
  private pageStartIds: string[] = [];
  private userBreakSig = '';
  /** Head + interior signature state (sigranges.ts): key/meter changes become
   *  RANGES of governed measures; only structural changes still derive. */
  private sigState: SigState | null = null;
  private budgetW = 0;
  /** Natural (unjustified) measure widths in SVG user units, from breaks:'none'
   *  window renders. Only missing/dirty ids are ever (re)written, so a cached
   *  value never drifts — determinism of the refill depends on it. */
  private naturals = new Map<string, number>();
  /** Leading clef+key block width (Verovio units) PER SIGNATURE CONTEXT.
   *
   *  This used to be one scalar plus the head key of the window that last
   *  measured it, and `fillOf` applied it as a document-level constant. That
   *  is wrong for any score whose clef or key changes: the leading signature a
   *  line draws depends on the context AT THAT LINE, and the retained scalar
   *  was whichever window happened to measure last. Two sessions rendering the
   *  same document by different routes therefore judged every line against a
   *  different yardstick and settled on different partitions — measured on the
   *  sonata as 1296.70 in one session against 1135.08 in another, a 14 %
   *  difference in the term, enough to flip lines sitting near a fill
   *  boundary and to shift a whole system at the tight ones (2026-09-08).
   *
   *  Keyed by the running clef+key at a measure (`signatureCtxKeys`), which is
   *  what determines the block Verovio draws; the value for a context is the
   *  same whenever it is measured, so the partition no longer depends on
   *  measurement order. */
  private sigWByCtx = new Map<string, number>();
  /** Instrument-name indent of the FIRST system (see measureLabelIndent);
   *  null until a naturals window has been rendered. Document-level: the names
   *  come from the scoreDef, so any window measures the same value. */
  private labelIndentW: number | null = null;
  /** Running clef+key context key per measure, document order (`sigCtxVer` =
   *  the `docVersion()` it was computed for). */
  private sigCtxKeys: string[] = [];
  private sigCtxVer = -1;
  /** The `sigCtxVer` whose contexts `measureAllSigCtx` last measured: keys
   *  can be refreshed without measuring (`refreshSigKeys`), so "keys current"
   *  no longer implies "contexts measured". */
  private sigCtxMeasuredVer = -1;
  /** Lookups that found no measured width. Should always be 0 — every context
   *  is measured up front — so a non-zero value is a defect, reported rather
   *  than absorbed. */
  private sigCtxMisses = 0;
  /** Which contexts missed, and how often — for diagnosis. */
  private sigCtxMissKeys = new Map<string, number>();
  /** Contexts whose width could not be measured on the last attempt; non-zero
   *  makes `ensureSigCtx` retry rather than settle for an incomplete table. */
  private sigCtxPending = 0;
  private lastSigCtxMeasured = 0;
  /** Per-measure live-doc serializations (+ their id order) captured whenever
   *  a partition is committed against the current document. The refill diffs
   *  the live doc against these to find the TRUE changed run — it never
   *  trusts the model's renderDirty hint, whose reset-then-narrow lifecycle
   *  can silently swallow an earlier mutation's 'all' under batch-mutate-
   *  then-render flows (same reason the scroll splicer keeps its own sig
   *  map). ~13 ms on a 446-bar score, amortized into a >1 s render. */
  private sig = new Map<string, string>();
  /** Per-measure FLOW signatures, in lockstep with `sig` (see measureFlowSig). */
  private sigFlow = new Map<string, string>();
  private sigOrder: string[] = [];
  /** Element identity behind each captured signature. A measure that is still
   *  the SAME object AND was never mutated since capture cannot have a
   *  different serialization — so the diff can reuse the captured string
   *  instead of recomputing it (Phase D). */
  private sigEl = new Map<string, Element>();
  /** Mutation tracker for the incremental baseline: which measures the live
   *  document actually changed since `captureSigs`. `sigAll` means "assume
   *  everything changed" — set whenever a mutation lands above measure level
   *  (the measure SET or the shared context moved), when the document object is
   *  swapped, or before any capture has armed the observer. */
  private sigMo: MutationObserver | null = null;
  private sigMoDoc: Document | null = null;
  private sigDirty = new Set<Element>();
  private sigAll = true;
  /** Line-start boundaries the last refill changed: starts that appeared plus
   *  starts that disappeared (0 = the edit changed content only and no
   *  boundary shifted — the common, desired case). Counted by measure id, not
   *  by line index: an index-wise count read every line after an added or
   *  removed one as moved (a 10-line section rebalance reported 57).
   *  Diagnostics and tests read it; fixtures assert 0 for no-op-equivalent
   *  edits. */
  lastRefillLines = 0;
  /** Timing/diagnostic breakdown of the last tryRefill (ms). */
  lastRefillStats: { naturalsMs: number; windows: number; windowMeasures: number; injectMs: number; serializeMs: number } =
    { naturalsMs: 0, windows: 0, windowMeasures: 0, injectMs: 0, serializeMs: 0 };
  /** Why the last tryRefill returned null (diagnostics/tests); '' after a
   *  successful refill. */
  lastDeriveReason = '';
  /** Diagnostics of the last partition pass, load or edit (see BalanceStats). */
  lastBalance: BalanceStats = emptyBalanceStats();
  /** Diagnostics of the load's pass (balanceInitialBand) — kept apart from
   *  `lastBalance`, which every edit overwrites. */
  lastInitialBalance: BalanceStats | null = null;
  /** Whether the document's last system is justified, for the committed
   *  partition (`finalSystemJustified`); null = unknown (a width missing). */
  private finalJustified: boolean | null = null;
  /** `docVersion()` of the document the committed partition was computed
   *  for (every commit passes `noteFinalJustified`). */
  private committedVer = -1;
  /** The staff subset this partition describes — single-part view's staves, or
   *  null for the whole score (2026-09-05). A part has its own widths, so its
   *  own partition, naturals and cache entry; the renderer sets it before every
   *  page render, and a change drops everything owned here. */
  private viewStaves: number[] | null = null;
  private viewKey = 'all';

  /** Drop all partition state. Next page render must derive + re-adopt. */
  invalidate(): void {
    this.sigFlow.clear();
    this.startIds = null;
    this.pageStartIds = [];
    this.naturals.clear();
    this.sigWByCtx.clear();
    this.labelIndentW = null;
    this.sigCtxKeys = [];
    this.sigCtxVer = -1;
    this.sigCtxMeasuredVer = -1;
    this.sigCtxMisses = 0;
    this.sigCtxMissKeys.clear();
    this.sigCtxPending = 0;
    this.sig.clear();
    this.sigOrder = [];
    this.sigEl.clear();
    this.sigDirty.clear();
    this.sigAll = true;
    this.budgetW = 0;
    this.finalJustified = null;
  }

  /** Own the partition of `viewStaves` (null = every staff). A subset other
   *  than the current one invalidates: its measures have other widths. */
  setView(viewStaves: number[] | null): void {
    const key = viewKeyOf(viewStaves);
    if (key !== this.viewKey) this.invalidate();
    this.viewKey = key;
    this.viewStaves = viewStaves ? viewStaves.slice() : null;
  }

  /** Capture per-measure signatures of the current live doc (see `sig`), and
   *  re-arm the mutation tracker so the NEXT diff only re-serializes what
   *  actually changed after this moment. */
  private captureSigs(doc: Document, meiMeasures: Element[], ids: string[], pre?: string[]): void {
    const ser = new XMLSerializer();
    this.sig.clear();
    this.sigFlow.clear();
    this.sigEl.clear();
    this.sigOrder = ids;
    for (let i = 0; i < meiMeasures.length; i++) {
      const raw = pre?.[i] ?? ser.serializeToString(meiMeasures[i]);
      this.sig.set(ids[i], raw);
      this.sigFlow.set(ids[i], measureFlowSig(raw));
      this.sigEl.set(ids[i], meiMeasures[i]);
    }
    this.armSigObserver(doc);
    /* This capture IS the new baseline: discard everything recorded before it. */
    this.sigMo?.takeRecords();
    this.sigDirty.clear();
    this.sigAll = false;
  }

  /** Observe `doc` for the incremental baseline, re-arming (and invalidating)
   *  when the document object itself was swapped — load, undo, redo. */
  private armSigObserver(doc: Document): void {
    if (typeof MutationObserver === 'undefined') { this.sigAll = true; return; }
    if (this.sigMoDoc === doc && this.sigMo) return;
    this.sigMo?.disconnect();
    this.sigMo = new MutationObserver((recs) => this.noteSigMutations(recs));
    this.sigMo.observe(doc, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
    this.sigMoDoc = doc;
    this.sigDirty.clear();
    this.sigAll = true;
  }

  /** Fold mutation records into the dirty set. A record whose target sits
   *  inside a `<measure>` dirties that measure; anything above measure level
   *  (a `<section>` childList insert/remove, a mid-piece scoreDef, the head)
   *  changes the measure SET or the shared context, so nothing may be assumed
   *  clean. */
  private noteSigMutations(recs: MutationRecord[]): void {
    for (const r of recs) {
      let node: Node | null = r.target;
      while (node && node.nodeType !== 1) node = node.parentNode;
      let e = node as Element | null;
      while (e && e.localName !== 'measure') e = e.parentElement;
      if (e) this.sigDirty.add(e);
      else this.sigAll = true;
    }
  }

  /** Drain the tracker and answer: which measure elements changed since the
   *  last capture, or null when that can't be narrowed. */
  private drainSigDirty(doc: Document): Set<Element> | null {
    if (this.sigMoDoc !== doc || !this.sigMo) { this.armSigObserver(doc); return null; }
    this.noteSigMutations(this.sigMo.takeRecords());
    return this.sigAll ? null : this.sigDirty;
  }

  /** Inject the CURRENT partition's pins into a freshly serialized render MEI.
   *  Used by the renderer to rebuild page data for a lazy mount after a system
   *  splice (the mounted DOM is current; the toolkit's layout is not).
   *  Null when nothing is adopted or an id is missing. */
  pinRenderMei(mei: string): string | null {
    if (this.startIds === null || this.startIds.length <= 1) return null;
    return injectPins(mei, this.startIds, this.pageSet());
  }

  /** Page-start ids as a lookup set for injectPins (`<pb>` instead of `<sb>`).
   *  Empty until pagination is adopted, in which case pins are sb-only and
   *  Verovio paginates by height — the pre-ownership behaviour. */
  private pageSet(): Set<string> | null {
    return this.pageStartIds.length > 1 ? new Set(this.pageStartIds) : null;
  }

  /** Adopted page starts (diagnostics / tests / the renderer's page index). */
  pageStarts(): string[] {
    return this.pageStartIds.slice();
  }

  /** True when pagination is owned (pinned `<pb>`), not left to Verovio.
   *  This is the PIN-EMISSION question (it mirrors `pageSet()`), and it is NOT
   *  the right gate for a pagination REPAIR — see `paginationRepairable()`. */
  paginationOwned(): boolean {
    return this.pageStartIds.length > 1;
  }

  /** True when an adopted page partition's overflow is OURS to repair.
   *
   *  Distinct from `paginationOwned()` on exactly one state: a ONE-PAGE owned
   *  document. There `pageSet()` pins no `<pb>`, yet the painted strategy is
   *  still `'encoded'` (`ownershipActive()`), and `breaks:'encoded'` does no
   *  height-based pagination at all (lessons.md 2026-08-30) — so nobody
   *  paginates it unless we do. Gating the repair on `paginationOwned()` made
   *  that a self-perpetuating trap: growing to two pages needs the cascade,
   *  and the cascade needed two pages, so composing into an empty score piled
   *  every system onto page 1 forever (2026-09-18).
   *
   *  A single-SYSTEM document is deliberately excluded (`ownershipActive()` is
   *  false): it paints `breaks:'line'`, where Verovio paginates by height
   *  correctly and we must not interfere. */
  paginationRepairable(): boolean {
    return this.ownershipActive() && this.pageStartIds.length >= 1;
  }

  /** Commit a pagination the renderer's overflow repair decided (B2): the
   *  cascade moves a page boundary forward or appends a page, one measured
   *  step at a time, and the committed pins must describe the DOM after each
   *  step. Validated — every id must be a line start, page 1 the document
   *  start, strictly ascending — so a wrong list is refused, never pinned. The
   *  signature baseline is untouched (the document did not change). */
  replacePageStarts(pages: string[]): boolean {
    if (this.startIds === null) return false;
    const pos = new Map(this.startIds.map((id, i) => [id, i]));
    if (!pages.length || pages[0] !== this.startIds[0]) return false;
    let prev = -1;
    for (const id of pages) {
      const p = pos.get(id);
      if (p == null || p <= prev) return false;
      prev = p;
    }
    this.pageStartIds = pages.slice();
    return true;
  }

  /** True when a refill attempt is worth making (a partition is owned). */
  canAttemptRefill(): boolean {
    return this.startIds !== null;
  }

  /** True when the doc is actually being line-break-owned (a multi-line
   *  partition is adopted) — gates the derive-fallback log so single-line
   *  documents, which always derive by design, don't spam the console. */
  ownershipActive(): boolean {
    return this.startIds !== null && this.startIds.length > 1;
  }

  /* ── the seed partition (decisions.md "Composer draws the pages", 2026-10-08) ─────── */

  /** The partition a fresh derive starts from, computed from Composer's own
   *  measurements — no Verovio castoff anywhere. Every natural width is
   *  measured first (`warmAllNaturals`), then each SECTION (document start +
   *  every hard start: user `<sb>`/`<pb>`, section breaks) is filled greedily
   *  at cap 1.0 — "a line never compresses past its natural width" — which is
   *  F's own first step, so the partition that follows (`balanceInitialBand`)
   *  keeps each section's line count and only picks its layout. Returns the seed lines (start-measure ids) — ONE line
   *  for a document that fits on one — or null when nothing could be measured.
   *  A multi-line seed is adopted (the owner then carries it across edits);
   *  a one-line document is never owned (tryRefill's rule) and the renderer
   *  assembles its single page from the returned line directly. */
  seedPartition(model: ComposerModel, ctx: PageBreaksCtx, budget: number): string[] | null {
    const meiMeasures = model.allMeasures();
    if (!meiMeasures.length) return null;
    const ids = measureIds(meiMeasures);
    this.invalidate();
    this.budgetW = budget;
    this.viewKey = viewKeyOf(this.viewStaves);
    this.ensureSigCtx(model, meiMeasures, ids, ctx);
    if (!this.warmAllNaturals(model, ctx)) {
      console.warn('[page-breaks] could not measure every natural — seeding with what is cached');
    }
    const hard = hardStartIds(model);
    const units = model.renderUnits(this.viewStaves);
    const starts: number[] = [0];
    let acc = this.sigWForLine(0) ?? 0;
    for (let i = 0; i < ids.length;) {
      const [uLo, uHi] = units.unitOf(i);
      let w = 0;
      for (let k = uLo; k <= Math.min(uHi, ids.length - 1); k++) w += this.naturals.get(ids[k]) ?? 0;
      const lineStart = starts[starts.length - 1];
      if (i !== lineStart && (hard.has(ids[i]) || acc + w > budget)) {
        starts.push(i);
        acc = (this.sigWForLine(i) ?? 0) + w;
      } else {
        acc += w;
      }
      i = uHi + 1;
    }
    const lines = starts.map((i) => ids[i]);
    if (lines.length > 1) {
      this.adoptPartition(model, lines, [], undefined, budget);
    } else {
      /* A one-line document is never OWNED (tryRefill's rule: it derives on
         every edit), but it is registered — signatures baselined, the one
         start held — so the next render's refill bails with its reason
         ('single-line partition') instead of an unattributed derive. */
      this.userBreakSig = computeUserBreakSig(model);
      this.sigState = captureSigState(model.getDoc(), headExtra(model));
      this.captureSigs(model.getDoc(), meiMeasures, ids);
      this.startIds = lines;
      this.pageStartIds = [];
    }
    this.noteFinalJustified(model);
    return lines;
  }

  /** The page starts the renderer's first-fit assembly decided (any prefix of
   *  the final list while pages are still closing). Validated like
   *  `replacePageStarts` — every id a line start, page 1 the document start,
   *  strictly ascending — and refused otherwise. */
  setPageStarts(pages: string[]): boolean {
    if (this.startIds === null) {
      /* A one-line document is not owned; its single page needs no pin. */
      this.pageStartIds = [];
      return pages.length <= 1;
    }
    const pos = new Map(this.startIds.map((id, i) => [id, i]));
    if (pages.length && pages[0] !== this.startIds[0]) return false;
    let prev = -1;
    for (const id of pages) {
      const p = pos.get(id);
      if (p == null || p <= prev) return false;
      prev = p;
    }
    this.pageStartIds = pages.slice();
    return true;
  }

  /** Copies of the width caches for the renderer's partition cache (see
   *  OwnerWidths). */
  exportWidths(): OwnerWidths {
    return { naturals: new Map(this.naturals), sigW: new Map(this.sigWByCtx), labelIndent: this.labelIndentW };
  }

  /** Commit `lines`/`pages` as the owned partition against the CURRENT document:
   *  reset state, capture the structural + per-measure signature baseline (so a
   *  later refill diffs against the document this partition describes), and
   *  verify every id still exists. Shared by castoff adoption and by the
   *  renderer's partition cache (`restorePartition`). `widths` restores the
   *  width caches the cache entry carried: without them a zoom round-trip
   *  left every natural cold and the edit-path balancer — which never works
   *  on partial data — declined every section-final defect until reload
   *  ('naturals incomplete'; a lock after a system's first measure left the
   *  bar orphaned at zoom 50 but not at 100, Max 2026-09-12). Zoom must not
   *  change what the owner knows. */
  private adoptPartition(
    model: ComposerModel, lines: string[], pages: string[], widths?: OwnerWidths, budget?: number,
  ): boolean {
    if (lines.length <= 1) return false;   // single-line docs are never owned
    this.invalidate();
    /* The budget the widths are judged against (the page geometry): without
       it a restored partition could not be read as F (`partitionOfDocument`)
       nor decide the last system's justification until the next edit. */
    if (budget !== undefined && budget > 0) this.budgetW = budget;
    if (widths) {
      this.naturals = new Map(widths.naturals);
      this.sigWByCtx = new Map(widths.sigW);
      this.labelIndentW = widths.labelIndent;
    }
    this.userBreakSig = computeUserBreakSig(model);
    this.sigState = captureSigState(model.getDoc(), headExtra(model));
    const meiMeasures = model.allMeasures();
    this.captureSigs(model.getDoc(), meiMeasures, measureIds(meiMeasures));
    /* Every adopted id must exist in the live doc, or the pins we build from
       it would be unplaceable. */
    const present = new Set(measureIds(meiMeasures));
    if (!lines.every((id) => present.has(id))) return false;
    if (!pages.every((id) => present.has(id))) return false;
    this.startIds = lines;
    this.pageStartIds = pages;
    this.noteFinalJustified(model);
    return true;
  }

  /** The committed line partition (line-start measure ids). Empty when nothing
   *  is owned. The renderer snapshots this into its per-(zoom, pageScale)
   *  partition cache so a zoom round-trip need not re-run the castoff pass. */
  lineStarts(): string[] {
    return this.startIds ? this.startIds.slice() : [];
  }

  /** Re-adopt a partition the renderer cached for this zoom/pageScale, instead
   *  of re-deriving it with a full castoff `loadData` (~1 s on the sonata). The
   *  caller is responsible for only offering a partition whose document is
   *  unchanged (it keys on `model.docVersion()`); this still re-verifies every
   *  id and rebuilds the signature baseline, and the render that follows is
   *  checked by `verifyRenderedPartition` + the page-overflow test exactly like
   *  a freshly adopted one — so a stale offer degrades to a derive, never to a
   *  wrong layout. */
  restorePartition(
    model: ComposerModel, lines: string[], pages: string[], widths?: OwnerWidths, budget?: number,
  ): boolean {
    return this.adoptPartition(model, lines, pages, widths, budget);
  }

  /** Commit a partition for the CURRENT document WITHOUT dropping the width
   *  caches (manual line breaks, 2026-09-11). The renderer restores a layout
   *  snapshot on undo/redo of a line-break command; the document then differs
   *  from the one the snapshot was taken against only by a `<sb>`, so every
   *  natural and leading-signature width is still right — `adoptPartition`'s
   *  `invalidate` would throw them away and leave the next edit re-measuring
   *  (and the edit's F refusing with 'naturals incomplete'). Validates
   *  the ids (present, ascending, line 0 = the document start, page 1 = line
   *  0), cancels any adoption/balance job, and re-baselines the signatures and
   *  the user-break sig against the current document. */
  replacePartition(model: ComposerModel, lines: string[], pages: string[]): boolean {
    if (lines.length <= 1) return false;
    const meiMeasures = model.allMeasures();
    const ids = measureIds(meiMeasures);
    const idIdx = new Map(ids.map((id, i) => [id, i]));
    if (lines[0] !== ids[0]) return false;
    let prev = -1;
    for (const id of lines) { const i = idIdx.get(id); if (i == null || i <= prev) return false; prev = i; }
    const lineSet = new Set(lines);
    if (pages.length && pages[0] !== lines[0]) return false;
    if (!pages.every((id) => lineSet.has(id))) return false;
    this.userBreakSig = computeUserBreakSig(model);
    this.sigState = captureSigState(model.getDoc(), headExtra(model));
    this.captureSigs(model.getDoc(), meiMeasures, ids);
    this.startIds = lines.slice();
    this.pageStartIds = pages.slice();
    this.lastDeriveReason = '';
    this.noteFinalJustified(model);
    return true;
  }

  /* ── refill ───────────────────────────────────────────────────────────── */

  /** Recompute the affected lines for whatever actually changed since the
   *  last committed partition and return the refill (strategy + lazy pinned
   *  render MEI + splice metadata), or null when a derive is required. The
   *  changed run is found by a per-measure signature diff against the owner's
   *  own baseline (see `sig`) — the model's renderDirty hint is never trusted.
   *  On success the new partition and a fresh sig baseline are committed.
   *  `mei()` is lazy: the system splicer (Phase C-B) never needs the full
   *  serialize + pin pass, so the full-render path pays for it, not the hot
   *  path. `changedRun` is the sig-diff run in CURRENT (new) measure indices;
   *  null means the document is signature-identical to the committed baseline. */
  tryRefill(
    model: ComposerModel,
    viewStaves: number[] | null,
    ctx: PageBreaksCtx,
  ): RefillResult | null {
    const bail = (why: string): null => { this.lastDeriveReason = why; return null; };
    this.setView(viewStaves);
    if (this.startIds === null) return bail('no owned partition');
    if (this.startIds!.length <= 1) return bail('single-line partition');
    /* User breaks — a manual line break, a page break, a section header —
       are partition edits handled below like a measure insert, never a
       derive: an added break splits its line, a removed one stops being hard,
       and a page break or section header additionally has the renderer re-fit
       pages from its page (`breaksChanged`). Until 2026-10-08 the page break
       and the section header derived ('user breaks changed'), re-assembling
       the document for an edit that cannot touch a page before it. */
    const newBreakSig = computeUserBreakSig(model);
    const lockDiff = newBreakSig === this.userBreakSig ? null : diffBreakSigs(this.userBreakSig, newBreakSig);
    /* Head / interior signature changes are handled AFTER the measure diff, as
       governed RANGES folded into the changed run (sigranges.ts); only a
       structural change there still derives. */
    if (this.budgetW <= 0) {
      const w = ctx.budgetW();
      if (w == null || !(w > 0)) return bail('no budgetW measurable');
      this.budgetW = w;
    }

    this.lastRefillStats = { naturalsMs: 0, windows: 0, windowMeasures: 0, injectMs: 0, serializeMs: 0 };
    const meiMeasures = model.allMeasures();
    if (meiMeasures.length === 0) return bail('empty document');
    const ids = measureIds(meiMeasures);
    const idIdx = new Map(ids.map((id, i) => [id, i]));

    /* The refill assumes CONTINUITY — an edit on the document this partition
       was adopted from. A wholesale swap (most line-start ids gone, e.g. a
       replaceDocument without a render in between) is a load, not an edit. */
    const surviving = this.startIds!.filter((id) => idIdx.has(id));
    if (surviving.length * 2 < this.startIds!.length) return bail('foreign document (line-start survival < 50%)');

    /* Changed run via prefix/suffix diff of (id, serialized measure) against
       the committed baseline — structural truth in the CURRENT index space. */
    const ser = new XMLSerializer();
    /* INCREMENTAL (Phase D): a measure that is still the same element AND was
       never mutated since the capture serializes to the captured string by
       construction, so only what the document actually changed is recomputed.
       Whole-document serialization was ~22 ms per keystroke on the sonata and
       scaled with the score, not the edit. Falls back to serializing everything
       whenever the tracker can't narrow it (see drainSigDirty). */
    const dirty = this.drainSigDirty(model.getDoc());
    const cur: string[] = new Array(meiMeasures.length);
    const curFlow: string[] = new Array(meiMeasures.length);
    for (let j = 0; j < meiMeasures.length; j++) {
      const el = meiMeasures[j];
      const kept = dirty && !dirty.has(el) && this.sigEl.get(ids[j]) === el
        ? this.sig.get(ids[j])
        : undefined;
      cur[j] = kept ?? ser.serializeToString(el);
      curFlow[j] = kept !== undefined ? (this.sigFlow.get(ids[j]) ?? measureFlowSig(cur[j])) : measureFlowSig(cur[j]);
    }
    if (indexCheckEnabled() && dirty) {
      for (let j = 0; j < meiMeasures.length; j++) {
        const truth = ser.serializeToString(meiMeasures[j]);
        if (truth !== cur[j]) {
          throw new Error(
            `[PageLineBreaks] incremental sig baseline stale at measure ${j} (${ids[j]})`,
          );
        }
      }
    }
    const oldOrder = this.sigOrder;
    const oN = oldOrder.length, nN = ids.length;
    const eq = (i: number, j: number): boolean =>
      oldOrder[i] === ids[j] && this.sig.get(oldOrder[i]) === cur[j];
    let P = 0;
    while (P < Math.min(oN, nN) && eq(P, P)) P++;
    let S = 0;
    while (S < Math.min(oN, nN) - P && eq(oN - 1 - S, nN - 1 - S)) S++;
    /* The same diff over FLOW signatures (measureFlowSig): which measures need
       their LINE re-flowed, as opposed to merely redrawn. A pure renumber has
       an empty flow run, so the partition and the naturals are untouched while
       the splicer still redraws the numbers. */
    const eqFlow = (i: number, j: number): boolean =>
      oldOrder[i] === ids[j] && this.sigFlow.get(oldOrder[i]) === curFlow[j];
    let Pf = 0;
    while (Pf < Math.min(oN, nN) && eqFlow(Pf, Pf)) Pf++;
    let Sf = 0;
    while (Sf < Math.min(oN, nN) - Pf && eqFlow(oN - 1 - Sf, nN - 1 - Sf)) Sf++;

    /* Surviving old line starts, in document order. If the very first measure
       was replaced, re-anchor line 0 at the current first measure. */
    const oldStarts = surviving.slice();
    if (oldStarts.length === 0 || idIdx.get(oldStarts[0])! !== 0) oldStarts.unshift(ids[0]);
    const hard = hardStartIds(model);
    /* The partition the current DOM renders (verifyRenderedPartition keeps
       these in lockstep) — the splicer locates the systems to replace by
       THESE ids, even ones whose measure the edit deleted. */
    const oldStartIds = this.startIds!.slice();

    /* Signature changes govern RANGES, not the document (Max, 2026-09-01). A
       clef / key / meter change re-engraves the measures from that point to the
       next change of the same kind — the head and mid-piece scoreDefs are
       invisible to the per-measure diff, inline clefs are visible but govern
       far beyond their measure — so those ranges join the changed run here,
       before the partition repair re-measures them. Anything structural (a
       staffDef, an element before the first measure, the credits) still
       derives: no range expresses it. */
    const newState = captureSigState(model.getDoc(), headExtra(model));
    const changedNew: number[] = [];
    if (!(P >= nN && oN === nN)) {
      for (let j = Math.min(P, nN - 1); j <= Math.max(Math.min(P, nN - 1), nN - 1 - S); j++) changedNew.push(j);
    }
    const sr = signatureRanges({
      oldSig: this.sig,
      newSig: (id) => { const j = idIdx.get(id); return j == null ? undefined : cur[j]; },
      changedNew, measures: meiMeasures, ids, idIdx,
      oldState: this.sigState ?? newState, newState,
    });
    if (sr.bail) return bail(sr.bail);
    /* Two runs (2026-09-02). `redraw` is every measure whose rendering differs
       and is what the splicer must replace; `run` is the subset whose LINE must
       be re-flowed (partition repair + naturals) — see measureFlowSig. A
       governed signature range changes widths, so it joins both. */
    const runFrom = (p: number, sfx: number): { lo: number; hi: number } => {
      if (p >= nN && oN === nN) return { lo: 1, hi: 0 };
      /* A pure deletion can leave an empty new-side run (hi < lo); the line
         that LOST content still needs re-laying — anchor the range at the
         structural change point. */
      const dLo = Math.min(p, nN - 1);
      return { lo: dLo, hi: Math.max(dLo, nN - 1 - sfx) };
    };
    let run = unionRun(runFrom(Pf, Sf).lo, runFrom(Pf, Sf).hi, sr.ranges);
    const redrawSpan = runFrom(P, S);
    let redraw = unionRun(redrawSpan.lo, redrawSpan.hi, sr.ranges);
    /* A multimeasure-rest run is ONE rendered measure (model/multirest.ts): an
       edit touching any member re-flows and redraws the whole unit — its
       representative's width depends on every member's flag. */
    const units = model.renderUnits(this.viewStaves);
    if (units.active) {
      if (run.lo <= run.hi) { const [a, b] = units.snap(run.lo, run.hi); run = { lo: a, hi: b }; }
      if (redraw.lo <= redraw.hi) { const [a, b] = units.snap(redraw.lo, redraw.hi); redraw = { lo: a, hi: b }; }
    }

    /* User-break edit: an added break (lock, page break, section header)
       splits its line and so its section; a REMOVED one joins two sections
       into one, which F then partitions whole. A removed LOCK is no exception
       (it used to keep the layout — "pin-removed-only", 2026-09-12 — which a
       reload could not reproduce once the partition became a function of the
       document: partition spec G1). The layout holds no state the document
       cannot reproduce (Max, 2026-09-12). */
    const addStarts: number[] = [];
    const removedAt: number[] = [];
    if (lockDiff) {
      for (const id of lockDiff.added) { const i = idIdx.get(id); if (i != null && i > 0) addStarts.push(i); }
      for (const id of lockDiff.removed) { const i = idIdx.get(id); if (i != null && i > 0) removedAt.push(i); }
    }
    const hasEdit = addStarts.length > 0 || removedAt.length > 0;

    let newStartIds: string[];
    let newPageStartIds: string[];
    let changedRun: { lo: number; hi: number } | null;
    let partitionOnly = false;
    const oldPageStartIds = this.pageStartIds.slice();
    if (run.lo > run.hi && !hasEdit) {
      newStartIds = oldStarts;               // no line needs re-flowing — re-pin as-is
      /* Every measure's FLOW survived identically, so every line and page did
         too. A single-page document has exactly one page start — the document
         start — which simply follows line 0. (An empty list would read as
         "pagination changed" and block every splice.)
         The document may still need REDRAWING here (a renumber): `changedRun`
         carries that to the splicer even though nothing re-flowed. */
      newPageStartIds = oldPageStartIds.length ? [newStartIds[0], ...oldPageStartIds.slice(1)] : [];
      changedRun = redraw.lo > redraw.hi ? null : { lo: redraw.lo, hi: redraw.hi };
      this.lastRefillLines = 0;
    } else {
      /* Pagination is carried INSIDE the repartition, by line (see repartition):
         a surviving line never changes page, and a page whose lines all
         vanished collapses. The renderer compares old and new page COUNTS to
         decide whether the page grid itself changed. */
      const repaired = this.repartition(
        model, meiMeasures, ids, idIdx, hard, { lo: run.lo, hi: run.hi }, ctx,
        hasEdit ? { addStarts, removedAt } : null,
      );
      if (!repaired) return bail('repartition window/cap exhausted');
      newStartIds = repaired.starts;
      newPageStartIds = repaired.pages;
      if (run.lo <= run.hi) {
        changedRun = { lo: Math.min(run.lo, redraw.lo), hi: Math.max(run.hi, redraw.hi) };
      } else {
        /* A pure line-break edit: nothing inside a measure changed, so the
           splicer's hunk is exactly the lines whose starts moved — none means
           the no-op path (only the lock glyphs refresh). */
        const hunk = partitionHunk(oldStartIds, newStartIds, idIdx, ids.length);
        if (redraw.lo > redraw.hi) { changedRun = hunk; partitionOnly = true; }
        else changedRun = hunk ? { lo: Math.min(hunk.lo, redraw.lo), hi: Math.max(hunk.hi, redraw.hi) } : { lo: redraw.lo, hi: redraw.hi };
      }
    }
    /* A single-line partition isn't worth owning: breaks:'line' with no <sb>
       in the data WARNS and falls back to auto castoff internally (probed
       2026-08-30), and the 1-vs-2-line cusp is exactly where our fill rules
       and castoff's metric could flip-flop per edit. Docs that small derive
       synchronously well under the deferral threshold — let them. */
    if (newStartIds.length <= 1) return bail('single-line result');
    const newLineStarts = new Set(newStartIds);
    if (newPageStartIds.length && newPageStartIds[0] !== newStartIds[0]) return bail('page 1 does not start the document');
    if (!newPageStartIds.every((id) => newLineStarts.has(id))) return bail('page start is not a line start');

    /* ALWAYS 'encoded' (2026-09-18). This used to fall back to 'line' when the
       owner held one page start, because a one-page document pins no `<pb>`
       and 'encoded' would then paint it as a single page however tall it grew
       — 'line' delegated height pagination to Verovio. That fallback is what
       kept one-page scores paginating, and it is no longer needed now the
       overflow cascade covers them (`paginationRepairable`): an overfull page
       is grown by the repair, not by Verovio.
       It also has to go, because 'line' IGNORES `<pb>` — measured on identical
       data, 'line' gives 1 page where 'encoded' gives 2. So a document with a
       USER page break rendered correctly on the derive (painted 'encoded') and
       then lost the break on the very next edit, which came through here and
       repainted it 'line': Ctrl+B, type one note, the page break is gone. */
    const strategy: RefillStrategy = 'encoded';
    this.startIds = newStartIds;
    this.pageStartIds = newPageStartIds;
    this.captureSigs(model.getDoc(), meiMeasures, ids, cur);
    this.sigState = newState;
    this.userBreakSig = newBreakSig;
    this.lastDeriveReason = '';
    /* The last system's justification is a function of the final section
       (finalSystemJustified). When an edit flips it — the final section
       crossed FINAL_GREEDY_BELOW lines, or its greedy last line crossed
       FINAL_JUSTIFY_FILL — the last line must be re-engraved even if its
       members did not change, so the run reaches it. Either side of a flip
       is a section of at most FINAL_GREEDY_BELOW lines, so this costs a few
       lines at most. */
    if (this.noteFinalJustified(model, ids, hard)) {
      const lastStart = idIdx.get(newStartIds[newStartIds.length - 1]) ?? 0;
      changedRun = { lo: Math.min(changedRun?.lo ?? lastStart, lastStart), hi: ids.length - 1 };
    }
    const pageSet = newPageStartIds.length > 1 ? new Set(newPageStartIds) : null;
    const mei = (): string | null => {
      const tSer = performance.now();
      const full = model.serialize({ hejiEnabled: model.getHejiEnabled() }, this.viewStaves);
      this.lastRefillStats.serializeMs = Math.round(performance.now() - tSer);
      const tInj = performance.now();
      const pinned = injectPins(full, newStartIds, pageSet);
      this.lastRefillStats.injectMs = Math.round(performance.now() - tInj);
      return pinned;
    };
    return {
      strategy, mei, changedRun, oldStartIds, newStartIds,
      oldPageStartIds, newPageStartIds, partitionOnly,
      breaksChanged: lockDiff?.structural ?? false,
      breakIds: lockDiff ? lockDiff.added.concat(lockDiff.removed) : [],
    };
  }

  /** Carry the committed partition across the edit by membership, then
   *  re-partition every SECTION the edit touched with F, in full — the same
   *  function the load ran, so the result equals a fresh load of this
   *  document (module header). Returns the new start-id list, or null (caller
   *  derives). */
  private repartition(
    model: ComposerModel,
    meiMeasures: Element[],
    ids: string[],
    idIdx: Map<string, number>,
    hard: Set<string>,
    dirty: { lo: number; hi: number },
    ctx: PageBreaksCtx,
    edit: PartitionEdit | null = null,
  ): { starts: string[]; pages: string[] } | null {
    const n = ids.length;
    /* The per-measure signature-context keys are rebuilt here, not as a side
       effect of measuring a window: with the width caches restored from the
       partition cache no window need be measured, and `fillOf` → `sigWAt`
       would otherwise miss on every line and refuse the refill (2026-09-12,
       the zoom-then-lock derive). Cheap when current. */
    this.ensureSigCtx(model, meiMeasures, ids, ctx);
    /* `dirty` may be EMPTY (hi < lo) for a pure manual line-break edit: no
       measure changed, so no natural is dropped and nothing is re-measured. */
    const hasDirty = dirty.lo <= dirty.hi;
    /* One measure further left than the change: a measure-initial clef in
       measure i is DRAWN at the end of measure i−1 (model
       `relocateInitialClefs`), so an edit that gives measure i one, or takes
       it away, changes i−1's natural width without touching i−1 — left stale,
       F partitioned the live document differently from its own reload
       (2026-10-20). The window renders that measure as context anyway. */
    const dLo = hasDirty ? Math.max(0, Math.min(dirty.lo, n - 1) - 1) : 0;
    const dHi = hasDirty ? Math.max(dLo, Math.min(dirty.hi, n - 1)) : -1;

    /* ── carry the partition across the edit, by MEMBERSHIP ──
       Each old line keeps its first surviving member as its start, so:
       deleting a line's first measure just moves that line's start to the
       next survivor (no reflow); an inserted measure joins the line whose
       index range contains it; a line whose every member was deleted
       disappears. Nothing here consults widths — only structure. */
    /* Multimeasure-rest runs (model/multirest.ts) are ONE rendered measure: a
       line can only start at a unit's first measure and a repair moves whole
       units. Interior members carry natural 0 (measureWindow), so unit widths
       already sum correctly. */
    const units = model.renderUnits(this.viewStaves);
    const unitLo = (i: number): number => units.repIdxOf(i);
    const oldPos = new Map(this.sigOrder.map((id, i) => [id, i]));
    const oldStartPos: number[] = [];
    for (const id of this.startIds!) {
      const p = oldPos.get(id);
      if (p == null) return null;   // partition/baseline disagree → derive
      oldStartPos.push(p);
    }
    const starts: number[] = [];
    /* New line index each old line carried to (null = every member deleted). */
    const oldLineToNew: Array<number | null> = [];
    for (let k = 0; k < oldStartPos.length; k++) {
      const from = oldStartPos[k];
      const to = k + 1 < oldStartPos.length ? oldStartPos[k + 1] : this.sigOrder.length;
      let carried: number | null = null;
      for (let i = from; i < to; i++) {
        let ni = idIdx.get(this.sigOrder[i]);
        if (ni == null) continue;
        ni = unitLo(ni);                             // a line starts where its unit starts
        if (!starts.length || ni > starts[starts.length - 1]) { starts.push(ni); carried = starts.length - 1; }
        break;
      }
      oldLineToNew.push(carried);
    }
    if (!starts.length) return null;
    starts[0] = 0;   // line 0 always begins the document

    /* ── carry PAGINATION by LINE, not by id (B2, 2026-09-02) ──
       A page is a run of lines; it keeps the LINE its old start carried to.
       Carrying by start ID (what this did before) sent a page whose start
       MEASURE was deleted to the next surviving old START — skipping the
       remnant of its own first line, which then landed on the previous page:
       a pagination change no edit asked for. By line, a surviving line never
       changes page; a page whose every line vanished collapses into its
       successor (the renderer removes the emptied page element). Tracked as
       indices into `starts` through the break edits and F below, because a
       line inserted or removed shifts every later page's line index. The
       renderer re-fits pages from the first changed one regardless. */
    const oldLineOf = new Map(this.startIds!.map((id, k) => [id, k]));
    const pageLines: number[] = [];
    for (const pid of this.pageStartIds) {
      const kOld = oldLineOf.get(pid);
      if (kOld == null) return null;   // page start is not a line start → derive
      let li: number | null = null;
      for (let k = kOld; k < oldLineToNew.length && li === null; k++) li = oldLineToNew[k];
      if (li === null) continue;                                  // page at the end, everything gone
      if (pageLines.length && li <= pageLines[pageLines.length - 1]) continue;   // collapsed into its predecessor
      pageLines.push(li);
    }
    if (this.pageStartIds.length) {
      if (!pageLines.length || pageLines[0] !== 0) pageLines.unshift(0);
      if (pageLines.length > 1 && pageLines[1] === 0) pageLines.splice(1, 1);
    }
    /* A repair that inserts a new line at position k+1 shifts the line index
       of every page starting at or after it. */
    const lineInserted = (at: number): void => {
      for (let p = 0; p < pageLines.length; p++) if (pageLines[p] >= at) pageLines[p]++;
    };

    /* Dirty measures must be re-measured; drop their cached naturals. */
    for (let i = dLo; i <= dHi; i++) this.naturals.delete(ids[i]);

    /* ── naturals on demand (only for the lines we actually examine) ── */
    let ensures = 0;
    const ensureRange = (lo: number, hi: number): boolean => {
      lo = Math.max(0, lo); hi = Math.min(n - 1, hi);
      let i = lo;
      while (i <= hi) {
        if (this.naturals.has(ids[i])) { i++; continue; }
        let j = i;
        while (j + 1 <= hi && !this.naturals.has(ids[j + 1])) j++;
        /* One window per ENSURE_CHUNK measures: the cost is the range's own. */
        for (let c = i; c <= j; c += ENSURE_CHUNK) {
          if (ensures >= MAX_ENSURES) return false;
          ensures++;
          const w = this.measureWindow(model, meiMeasures, ids, c, Math.min(j, c + ENSURE_CHUNK - 1), ctx);
          if (w == null) return false;
        }
        i = j + 1;                       // measureWindow files sigW by context
      }
      return true;
    };

    /* Measure the whole dirty range in ONE window before F runs. A
       note edit dirties a measure or two, but a signature change governs a
       RANGE (sigranges.ts) that can span many lines, and the per-line ensures
       below would spend MAX_ENSURES on it and derive — the O(document) fallback
       for what is an O(range) change. One window over the range costs exactly
       the range; F then finds every natural present. */
    if (dHi >= dLo && !ensureRange(dLo, dHi)) return null;

    /* ── user-break edit (2026-09-11) ──
       Applied AFTER the membership carry and BEFORE F, so the sections F sees
       are the document's: an added break becomes a line start (and so a
       section boundary — `sectionRanges` reads hard starts off line starts).
       `examine` collects the measures whose sections F must re-partition even
       though no measure content changed. */
    let examineLo = -1, examineHi = -1;
    const touch = (lo: number, hi: number): void => {
      examineLo = examineLo < 0 ? lo : Math.min(examineLo, lo);
      examineHi = Math.max(examineHi, hi);
    };
    const lineEndAt = (k: number): number => (k + 1 < starts.length ? starts[k + 1] : n);
    if (edit) {
      /* Added breaks: split the line at the break. One at an existing start
         still examines both sides — the section it ends and the one it
         starts are each partitioned alone now. */
      for (const raw of edit.addStarts) {
        const at = unitLo(raw);
        if (at <= 0) continue;
        let k = 0;
        while (k < starts.length && starts[k] < at) k++;
        if (k < starts.length && starts[k] === at) { touch(starts[k - 1], lineEndAt(k) - 1); continue; }
        starts.splice(k, 0, at);
        lineInserted(k);
        touch(starts[k - 1], lineEndAt(k) - 1);
      }
      /* Removed breaks: the boundary is no longer hard. Examine the line
         before it and the line it started, so the joined section is
         partitioned whole — the symmetric half of the add above. The boundary
         itself moves only if F moves it. */
      for (const raw of edit.removedAt) {
        const at = unitLo(raw);
        if (at <= 0) continue;
        let k = 0;
        while (k < starts.length && starts[k] < at) k++;
        if (k < starts.length && starts[k] === at && k > 0) touch(starts[k - 1], lineEndAt(k) - 1);
      }
    }

    /* ── F over every touched section (partition spec, Phase 3) ──
       The lines the edit touched name the SECTIONS it touched; each is
       re-partitioned WHOLE by the function the load ran, so the result is the
       document's own partition, not a repair of the old one. No legality
       envelope, no repair cascade, no page bound: F reaches as far back as its
       pick says (no cap — Max, 2026-10-20), and an untouched section keeps
       the load's answer because its widths did not change. */
    let eLo = hasDirty ? dLo : -1, eHi = hasDirty ? dHi : -1;
    if (examineLo >= 0) { eLo = eLo < 0 ? examineLo : Math.min(eLo, examineLo); eHi = Math.max(eHi, examineHi); }
    if (eLo >= 0 && eHi >= eLo) {
      let first = 0, last = 0;
      for (let k = 0; k < starts.length; k++) {
        if (starts[k] <= eLo) first = k;
        if (starts[k] <= eHi) last = k;
      }
      const t0 = performance.now();
      const lb = emptyBalanceStats();
      const secs = sectionRanges(starts, ids, hard).filter(([lo, hi]) => hi >= first && lo <= last);
      /* Last to first, so a line-count change in one never shifts the line
         indices of a section still to visit. */
      for (let s = secs.length - 1; s >= 0; s--) {
        const [kLo, kHi] = secs[s];
        const mTo = kHi + 1 < starts.length ? starts[kHi + 1] : n;
        /* F reads the whole section: cached from the load except what the
           edit dirtied (measured above), so this is normally free. */
        if (!ensureRange(starts[kLo], mTo - 1)) return null;
        lb.sections++;
        const r = this.balanceSectionLines(starts, pageLines, kLo, kHi, ids, units, lb);
        if (r.reason) { this.lastBalance = lb; return null; }   // F never runs on partial widths
        if (r.applied) { lb.applied++; lb.changed += r.changed; lb.removed += r.removed; }
      }
      lb.picks.reverse();
      lb.ms = Math.round(performance.now() - t0);
      this.lastBalance = lb;
    }

    const out = starts.map((i) => ids[i]);
    const before = new Set(this.startIds!), after = new Set(out);
    let movedLines = 0;
    for (const id of after) if (!before.has(id)) movedLines++;
    for (const id of before) if (!after.has(id)) movedLines++;
    this.lastRefillLines = movedLines;
    return { starts: out, pages: pageLines.map((li) => out[li]) };
  }

  /* ── the partition: F per section ─────────────────────────────────────── */

  /** Fill of line k of `starts` from cached naturals — the fill F judges it
   *  by (its own leading block + Σ naturals, over the budget); null when any
   *  width is missing. Diagnostics: fixtures and probes read it. */
  private lineFill(starts: number[], k: number, ids: string[]): number | null {
    const from = starts[k], to = k + 1 < starts.length ? starts[k + 1] : ids.length;
    const sig = this.sigWForLine(from);
    if (sig === null) return null;
    let acc = sig;
    for (let i = from; i < to; i++) {
      const w = this.naturals.get(ids[i]);
      if (w === undefined) return null;
      acc += w;
    }
    return acc / this.budgetW;
  }

  /** Partition the section occupying lines [kLo..kHi] of `starts` with F
   *  (balance.ts `partitionSection`) and splice its answer in place: `starts`
   *  and `pageLines` (page-start line indices) are updated, and the line count
   *  may shrink OR grow — it is greedy's count over the CURRENT content, never
   *  a function of the incumbent. The section is FINAL when it ends the
   *  document (F keeps a final section under FINAL_GREEDY_BELOW lines greedy).
   *  Each line pays its own leading block (`sigWForLine` at its first
   *  measure). Every natural of the section must be cached: F never balances
   *  against a phantom document. The pick is recorded in `stats.picks`.
   *  Reasons: '' (applied, or nothing moved), 'naturals incomplete'. */
  private balanceSectionLines(
    starts: number[], pageLines: number[], kLo: number, kHi: number, ids: string[],
    units: RenderUnitIndex, stats: BalanceStats,
  ): { applied: boolean; reason: string; changed: number; removed: number } {
    const n = ids.length;
    const mFrom = starts[kLo], mTo = kHi + 1 < starts.length ? starts[kHi + 1] : n;
    /* Atoms are render UNITS (model/multirest.ts): a multimeasure-rest run is
       one atom whose width is its members' naturals summed (interiors are 0),
       so no line can start inside a run. */
    const at = sectionAtoms(mFrom, mTo, this.budgetW,
      (i) => this.naturals.get(ids[i]), (i) => this.sigWForLine(i), (i) => units.unitOf(i));
    if (!at) return { applied: false, reason: 'naturals incomplete', changed: 0, removed: 0 };
    const res = partitionSection(at, mTo === n);
    const secStarts = res.starts.map((a) => at.atomStart[a]);
    stats.picks.push({
      from: ids[mFrom], lines: secStarts.length, changes: res.layout?.changes ?? 0,
      min: res.layout?.min ?? 0, sd: res.layout?.sd ?? 0, layouts: res.layouts, exempt: res.exempt,
    });
    const n0 = kHi - kLo + 1, n1 = secStarts.length;
    const before = new Set(starts.slice(kLo, kHi + 1)), after = new Set(secStarts);
    let changed = 0;
    for (const x of before) if (!after.has(x)) changed++;
    for (const x of after) if (!before.has(x)) changed++;
    if (changed === 0) return { applied: false, reason: '', changed: 0, removed: 0 };
    starts.splice(kLo, n0, ...secStarts);
    linesReplaced(pageLines, kLo, n0, n1, starts.length);
    return { applied: true, reason: '', changed, removed: n0 - n1 };
  }

  /** Measure the naturals still missing in ids[lo..hi], at most `cap` measures
   *  (one window per contiguous missing run, each ≤ BALANCE_WINDOW before the
   *  context/spanner expansion). False when a window failed; 'incomplete' when
   *  the cap was reached first; true when the range is complete. */
  private measureMissing(
    model: ComposerModel, meiMeasures: Element[], ids: string[],
    lo: number, hi: number, ctx: PageBreaksCtx, cap: number,
  ): boolean | 'incomplete' {
    let left = cap;
    let i = lo;
    while (i <= hi) {
      if (this.naturals.has(ids[i])) { i++; continue; }
      if (left <= 0) return 'incomplete';
      const maxRun = Math.min(left, BALANCE_WINDOW);
      let j = i;
      while (j + 1 <= hi && !this.naturals.has(ids[j + 1]) && j + 1 - i < maxRun) j++;
      const w = this.measureWindow(model, meiMeasures, ids, i, j, ctx);
      if (w == null) return false;
      left -= j - i + 1;               // measureWindow files sigW by context
      i = j + 1;
    }
    return true;
  }

  /** The committed partition as line indices + page-start line indices, or
   *  null when an id is missing from the document. */
  private indexedPartition(ids: string[]): { starts: number[]; pageLines: number[] } | null {
    if (this.startIds === null) return null;
    const idIdx = new Map(ids.map((id, i) => [id, i]));
    const starts: number[] = [];
    for (const id of this.startIds) { const i = idIdx.get(id); if (i == null) return null; starts.push(i); }
    const lineAt = new Map(this.startIds.map((id, k) => [id, k]));
    const pageLines: number[] = [];
    for (const id of this.pageStartIds) { const k = lineAt.get(id); if (k == null) return null; pageLines.push(k); }
    return { starts, pageLines };
  }

  /** The load's partition: F over EVERY section, run SYNCHRONOUSLY before the
   *  first paint on the greedy seed (`seedPartition`), so the first paint is
   *  the document's own partition and nothing re-flows under the reader.
   *  `budget` is the justified system width from the page geometry (nothing is
   *  mounted yet). Naturals are complete beforehand (`warmAllNaturals`); a
   *  section whose window still failed keeps its greedy seed. */
  balanceInitialBand(model: ComposerModel, ctx: PageBreaksCtx, budget: number): void {
    const t0 = performance.now();
    const lb = emptyBalanceStats();
    this.lastBalance = lb;
    this.lastInitialBalance = lb;
    if (this.startIds === null || this.startIds.length <= 1 || !(budget > 0)) return;
    if (this.budgetW <= 0) this.budgetW = budget;
    const meiMeasures = model.allMeasures();
    const ids = measureIds(meiMeasures);
    const part = this.indexedPartition(ids);
    if (!part) return;
    this.ensureSigCtx(model, meiMeasures, ids, ctx);   // keys before any fill (see repartition)
    const { starts, pageLines } = part;
    const hard = hardStartIds(model);
    const units = model.renderUnits(this.viewStaves);
    const secs = sectionRanges(starts, ids, hard);
    let touched = false;
    for (let s = secs.length - 1; s >= 0; s--) {
      const [kLo, kHi] = secs[s];
      lb.sections++;
      const mFrom = starts[kLo], mTo = kHi + 1 < starts.length ? starts[kHi + 1] : ids.length;
      if (this.measureMissing(model, meiMeasures, ids, mFrom, mTo - 1, ctx, Infinity) !== true) { lb.reasons.push('naturals window failed'); continue; }
      const r = this.balanceSectionLines(starts, pageLines, kLo, kHi, ids, units, lb);
      if (r.reason) lb.reasons.push(r.reason);
      if (r.applied) { lb.applied++; lb.changed += r.changed; lb.removed += r.removed; touched = true; }
    }
    lb.picks.reverse();
    if (touched) {
      /* Lines only. Pages are no longer carried by line index from a castoff
         (decisions.md "Composer draws the pages"): the renderer decides them from the
         measured systems after the partition and commits them with
         `setPageStarts`. */
      this.startIds = starts.map((i) => ids[i]);
      this.pageStartIds = [];
    }
    this.noteFinalJustified(model);
    lb.ms = Math.round(performance.now() - t0);
  }

  /** F of the whole document from the width caches, as line-start ids — what
   *  the committed partition MUST equal (the suite's "partition is F"
   *  invariant; probes). Read-only: measures nothing, so null when a natural
   *  or a leading block is missing. */
  /** True when the committed partition was computed for the document as it
   *  is now — false after an edit that has not been rendered yet. */
  partitionCurrent(model: ComposerModel): boolean {
    return this.startIds !== null && this.committedVer === model.docVersion();
  }

  partitionOfDocument(model: ComposerModel): string[] | null {
    if (!(this.budgetW > 0)) return null;
    const meiMeasures = model.allMeasures();
    this.refreshSigKeys(model, meiMeasures);
    const ids = measureIds(meiMeasures);
    if (!ids.length) return [];
    const hard = hardStartIds(model);
    const units = model.renderUnits(this.viewStaves);
    const bounds = [0];
    for (let i = 1; i < ids.length; i++) if (hard.has(ids[i])) bounds.push(i);
    bounds.push(ids.length);
    const out: string[] = [];
    for (let s = 0; s + 1 < bounds.length; s++) {
      const at = sectionAtoms(bounds[s], bounds[s + 1], this.budgetW,
        (i) => this.naturals.get(ids[i]), (i) => this.sigWForLineQuiet(i), (i) => units.unitOf(i));
      if (!at) return null;
      for (const a of partitionSection(at, s + 2 === bounds.length).starts) out.push(ids[at.atomStart[a]]);
    }
    return out;
  }

  /** Is the document's LAST system justified? (render.ts `buildOptions` →
   *  Verovio `minLastJustification`; Max, 2026-10-20.) Always when the final
   *  section ran through F's pick (FINAL_GREEDY_BELOW+ greedy lines — its
   *  last line is part of a balanced layout); when the final section stayed
   *  greedy (1–2 lines), only at fill ≥ FINAL_JUSTIFY_FILL. Decided by OUR
   *  fill, so it needs no slack for Verovio's own ratio. Null when unknown (a
   *  width is missing). Recomputed whenever a partition is committed. */
  finalSystemJustified(): boolean | null {
    return this.finalJustified;
  }

  /** Recompute `finalJustified` for the committed partition. True when it
   *  changed (tryRefill then re-renders the last line). */
  private noteFinalJustified(model: ComposerModel, ids?: string[], hard?: Set<string>): boolean {
    this.committedVer = model.docVersion();
    const was = this.finalJustified;
    const meiMeasures = model.allMeasures();
    this.refreshSigKeys(model, meiMeasures);
    this.finalJustified = this.computeFinalJustified(model, ids ?? measureIds(meiMeasures), hard ?? hardStartIds(model));
    return was !== this.finalJustified;
  }

  private computeFinalJustified(model: ComposerModel, ids: string[], hard: Set<string>): boolean | null {
    if (this.startIds === null || !this.startIds.length || !(this.budgetW > 0)) return null;
    const n = ids.length;
    if (!n) return null;
    let h = 0;
    for (let i = n - 1; i > 0; i--) if (hard.has(ids[i])) { h = i; break; }
    const units = model.renderUnits(this.viewStaves);
    const at = sectionAtoms(h, n, this.budgetW,
      (i) => this.naturals.get(ids[i]), (i) => this.sigWForLineQuiet(i), (i) => units.unitOf(i));
    if (!at) return null;
    if (greedyStarts(at).length >= FINAL_GREEDY_BELOW) return true;
    const last = ids.indexOf(this.startIds[this.startIds.length - 1]);
    if (last < 0) return null;
    const sig = this.sigWForLineQuiet(last);
    if (sig === null) return null;
    let w = sig;
    for (let i = last; i < n; i++) {
      const x = this.naturals.get(ids[i]);
      if (x === undefined) return null;
      w += x;
    }
    return w / this.budgetW >= FINAL_JUSTIFY_FILL;
  }

  /** Measure and cache the natural width of EVERY measure, synchronously.
   *
   *  The partition (F, at load and on every edit) is only as complete as the
   *  naturals cache. It used to be filled opportunistically — the idle balance
   *  job walked the document after the paint — so removing that job in favour
   *  of a pre-paint balance left an edit's `balanceTouched` reporting
   *  'naturals incomplete' and declining to repair a section it should have
   *  (fixture pageBalanceDeleteAtSectionEnd). Filling it here means the
   *  pre-paint balance judges every section with full information and every
   *  later edit finds what it needs already cached. Import pays; edits do not.
   *  False when a window failed — the caller then treats the balance as
   *  incomplete rather than acting on partial data. */
  warmAllNaturals(model: ComposerModel, ctx: PageBreaksCtx): boolean {
    const meiMeasures = model.allMeasures();
    if (!meiMeasures.length) return true;
    const ids = measureIds(meiMeasures);
    return this.measureMissing(model, meiMeasures, ids, 0, ids.length - 1, ctx, Infinity) === true;
  }

  /* ── naturals measurement ─────────────────────────────────────────────── */

  /** Measure natural widths for ids[needLo..needHi] via one offscreen
   *  breaks:'none' window render. The window gains two left + one right
   *  context measures and is expanded to hold every spanner and <ending>
   *  whole, so member widths reproduce their full-context values (page
   *  spike 1, finding 5). Only [needLo..needHi] values are written — cached
   *  neighbours are never disturbed (determinism). Returns the window's
   *  measured leading clef+key width (or the retained one), or null on failure.
   *
   *  LAYOUT-FREE (A7, 2026-09-01). A measure's natural width is the horizontal
   *  extent of its staff line — the first horizontal `<path d="M x1 y L x2 y">`
   *  under its first `g.staff` — read from the SVG TEXT via DOMParser. Nothing
   *  is attached to the document, so there is no layout flush here and the live
   *  page's layout stays clean for the splice's first live read (that read used
   *  to be a 5 ms flush purely because this host touched `<body>`). Proven
   *  against the previous `getBBox` reading over every sonata measure
   *  (a since-deleted probe): 441/443 interior measures and every last measure
   *  identical (delta 0); the only differences are a window's FIRST measure,
   *  whose bbox began 144 units left of its staff line (the system-start brace/
   *  barline), i.e. the old reading over-counted measure 0 by the brace. The
   *  span is the width Verovio lays the measure out with.
   *
   *  `sigW` (leading clef+key extent) needs glyph ink metrics, which the text
   *  cannot give, so it keeps the attached-host `getBBox` path — but only when
   *  the window's folded head (the part of the sub-MEI before `<section>`,
   *  which alone determines the leading clef+key the first system draws)
   *  differs from the head of the window that last measured it. Interior
   *  scoreDefs and inline clefs inside the window do not change the LEADING
   *  signature and never did change today's measurement, so they don't
   *  trigger. `fillOf` already applies `sigW` as a document-level constant. */
  /** Leading-signature width a LINE starting at measure `idx` pays for.
   *  Zero for the document's first line: the clef+key+meter block there is
   *  drawn inside measure 0 and is therefore already inside that measure's
   *  natural width, so charging `sigWAt` as well counted it twice and cost
   *  that line a measure (verified 2026-09-18; see balance.ts `sigFirst`).
   *  Every other line really does get a block no natural contains. */
  /** `sigWForLine` for READ-ONLY diagnostics (`partitionOfDocument`,
   *  `finalSystemJustified`): a miss returns null without being reported —
   *  only the partition itself refuses, and reports, a missing width. */
  private sigWForLineQuiet(idx: number): number | null {
    if (idx === 0) return this.labelIndentW;
    const key = this.sigCtxKeys[idx];
    const w = key === undefined ? undefined : this.sigWByCtx.get(key);
    return w !== undefined && w > 0 ? w : null;
  }

  private sigWForLine(idx: number): number | null {
    if (idx !== 0) return this.sigWAt(idx);
    /* The clef+key+meter block is already inside measure 0's natural, so the
       document's first line pays no `sigWAt` — but it DOES pay the instrument
       names, which sit outside every measure (10.7 % of the budget on a
       viola+piano score). Null while no window has been measured yet: the
       caller refuses the refill rather than guessing, the same contract as
       `sigWAt`. */
    return this.labelIndentW;
  }

  /** The leading clef+key width for the line starting at measure `idx`, or
   *  NULL when that context has no measurement. There is deliberately no
   *  fallback: every context in the document is measured up front
   *  (`ensureSigCtx`), so a miss is a defect, and a plausible-but-invented
   *  width is exactly what let the old document-level scalar hide. Callers
   *  refuse the refill — the same contract as a window that cannot be
   *  measured ("never guesses"). */
  private sigWAt(idx: number): number | null {
    const key = this.sigCtxKeys[idx];
    const w = key === undefined ? undefined : this.sigWByCtx.get(key);
    if (w !== undefined && w > 0) return w;
    this.sigCtxMisses++;
    if (key !== undefined) this.sigCtxMissKeys.set(key, (this.sigCtxMissKeys.get(key) ?? 0) + 1);
    console.error('[page-breaks] no leading-signature width for context '
      + (key ?? '<unkeyed measure ' + idx + '>') + ' — refusing the refill');
    return null;
  }

  /** Running clef+key context per measure, in document order, recomputed only
   *  when the document version changes. The leading signature a system draws
   *  is the clef and key in force at its first measure — meter is excluded
   *  because mid-score systems do not redraw it (see measureLeadingSigW) — so
   *  the context is the head scoreDef's key and per-staff clef, advanced by
   *  interior scoreDefs and by inline clefs inside the layers. */
  private ensureSigCtx(
    model: ComposerModel, meiMeasures: Element[], ids: string[], ctx: PageBreaksCtx,
  ): void {
    const recomputed = this.refreshSigKeys(model, meiMeasures);
    if (!recomputed && this.sigCtxPending === 0 && this.sigCtxMeasuredVer === this.sigCtxVer) return;
    this.measureAllSigCtx(model, meiMeasures, ids, ctx);
    this.sigCtxMeasuredVer = this.sigCtxVer;
  }

  /** The per-measure context keys alone, recomputed when the document version
   *  changed — no measuring. For readers of the committed partition
   *  (`partitionOfDocument`, `finalSystemJustified`) that run without a
   *  refill: a partition-cache restore (`adoptPartition`) brings the widths
   *  back but `invalidate` emptied the keys, and every `sigWAt` then missed.
   *  True when the keys were recomputed. */
  private refreshSigKeys(model: ComposerModel, meiMeasures: Element[]): boolean {
    const ver = model.docVersion();
    if (this.sigCtxVer === ver && this.sigCtxKeys.length === meiMeasures.length) return false;
    const doc = model.getDoc();
    const clef = new Map<string, string>();
    let key = '';
    const applyScoreDef = (sd: Element): void => {
      const k = sd.getAttribute('key.sig');
      if (k !== null) key = k;
      for (const sdf of Array.from(sd.querySelectorAll('staffDef'))) {
        const n = sdf.getAttribute('n');
        if (n === null) continue;
        const shape = sdf.getAttribute('clef.shape'), line = sdf.getAttribute('clef.line');
        const dis = sdf.getAttribute('clef.dis'), place = sdf.getAttribute('clef.dis.place');
        if (shape !== null || line !== null) clef.set(n, (shape ?? '') + (line ?? '') + (dis ? dis + (place ?? '') : ''));
        const kk = sdf.getAttribute('key.sig');
        if (kk !== null) key = kk;                 // per-staff key sigs are uniform here
      }
    };
    const keyOf = (): string => {
      const parts: string[] = [];
      for (const n of Array.from(clef.keys()).sort()) parts.push(n + ':' + clef.get(n));
      return 'k=' + key + '|c=' + parts.join(',');
    };
    const out: string[] = [];
    const seen = new Set<Element>();
    /* Document order over BOTH kinds, so a measure nested in an <ending>
       (volta) is reached — walking `section`'s direct children alone missed
       those and bailed the whole walk. `scoreDef` never nests in `scoreDef`,
       so this sequence is exactly the running-context stream. */
    const score = doc.querySelector('score');
    for (const node of Array.from(score?.querySelectorAll('scoreDef, measure') ?? [])) {
      if (node.localName === 'scoreDef') { applyScoreDef(node); continue; }
      const applyClef = (c: Element): void => {
        const st = c.closest('staff')?.getAttribute('n');
        if (!st) return;
        const shape = c.getAttribute('shape'), line = c.getAttribute('line');
        const dis = c.getAttribute('dis'), place = c.getAttribute('dis.place');
        clef.set(st, (shape ?? '') + (line ?? '') + (dis ? dis + (place ?? '') : ''));
      };
      /* A layer-INITIAL clef is in force from its OWN measure: rendering moves
         it before the barline (model `relocateInitialClefs` — and `serialize`
         saves that form, the clef at the end of the previous measure), and a
         line starting here draws it as its leading clef (the range head folds
         it in). Keyed here, the live form and the saved form get one context —
         a delete that made a clef measure-initial left the live key on the old
         clef, and a reload re-broke two lines of the sonata (2026-10-20). */
      for (const layer of Array.from(node.querySelectorAll('staff > layer'))) {
        const first = layer.firstElementChild;
        if (first && first.localName === 'clef') applyClef(first);
      }
      out.push(keyOf());
      seen.add(node);
      /* Any other inline clef changes the clef for every LATER line. */
      for (const c of Array.from(node.querySelectorAll('layer > clef'))) applyClef(c);
    }
    /* A document whose measures are not the section's direct children (or a
       shape this walk does not recognise) gets no keys rather than wrong ones;
       sigWAt then reports misses instead of inventing a yardstick. */
    this.sigCtxKeys = out.length === meiMeasures.length && meiMeasures.every((m) => seen.has(m)) ? out : [];
    this.sigCtxVer = ver;
    return true;
  }

  /** Measure the leading clef+key width of EVERY signature context in the
   *  document, each at its own first measure.
   *
   *  Deliberate rather than opportunistic: the width is only ever measurable
   *  at a window's FIRST measure (a naturals window is one system, so only
   *  `ids[lo]` draws a leading signature), and the windows a refill happens to
   *  need cover only a few contexts — on the sonata 6 of 20, leaving one
   *  context spanning 45 measures unmeasured. Rather than fall back, each
   *  missing context gets a two-measure window whose head IS a measure in that
   *  context, which is measurable by construction: a context exists only
   *  because some measure carries it. Widths depend on the context alone, not
   *  on document content, so they survive edits and are measured at most once
   *  per context per document load (cleared only by `invalidate`). */
  private measureAllSigCtx(model: ComposerModel, meiMeasures: Element[], ids: string[], ctx: PageBreaksCtx): void {
    if (!this.sigCtxKeys.length) { this.sigCtxPending = 0; return; }
    const firstIdx = new Map<string, number>();
    this.sigCtxKeys.forEach((k, i) => { if (!firstIdx.has(k)) firstIdx.set(k, i); });
    const failed: string[] = [];
    let measured = 0;
    for (const [key, idx] of firstIdx) {
      if (this.sigWByCtx.has(key)) continue;
      let hi = Math.min(ids.length - 1, idx + 1);
      /* Cover the spanners the two-measure window would cut (a slur leaving
         measure 2 for measure 4), the way `measureWindow` does: a cut spanner
         is a Verovio warning on every first render, since the seed measures
         every context up front. The head stays at `idx` — the window's first
         measure is the one that draws the signature — so only the tail grows;
         past the cap, the bare window is measured and the warning tolerated. */
      const [elo, ehi] = expandForEndings(meiMeasures, ...expandForSpanners(meiMeasures, idx, hi, model.docVersion()));
      if (elo === idx && ehi - idx + 1 <= WINDOW_CAP) hi = ehi;
      let ok = false;
      try {
        const sub = model.serializeRangeForRender(idx, hi, { hejiEnabled: model.getHejiEnabled() }, this.viewStaves);
        const tk = ctx.naturalsToolkit();
        tk.setOptions(ctx.naturalsOptions());
        if (tk.loadData(sub)) {
          const w = measureLeadingSigW(tk.renderToSVG(1, {}), ids[idx]);
          if (w > 0) { this.sigWByCtx.set(key, w); measured++; ok = true; }
        }
      } catch { /* falls through to `failed` */ }
      if (!ok) failed.push(key);
    }
    this.sigCtxPending = failed.length;
    if (failed.length) {
      console.error('[page-breaks] could not measure the leading signature for '
        + failed.length + ' of ' + firstIdx.size + ' contexts: ' + failed.join(' | '));
    }
    this.lastSigCtxMeasured = measured;
  }

  /** Context coverage, for the probes and the index check: `distinct` in the
   *  document vs `contexts` measured, `pending` unmeasurable, and any lookup
   *  `misses` (all three should be 0). */
  sigCtxStats(): { contexts: number; misses: number; keyed: boolean; distinct: number;
                   pending: number; measured: string[]; missing: Array<[string, number]> } {
    return { contexts: this.sigWByCtx.size, misses: this.sigCtxMisses, keyed: this.sigCtxKeys.length > 0,
             distinct: new Set(this.sigCtxKeys).size, pending: this.sigCtxPending,
             measured: Array.from(this.sigWByCtx.keys()),
             missing: Array.from(this.sigCtxMissKeys.entries()) };
  }

  private measureWindow(
    model: ComposerModel, meiMeasures: Element[], ids: string[],
    needLo: number, needHi: number, ctx: PageBreaksCtx,
  ): { sigW: number } | null {
    let lo = Math.max(0, needLo - 2);
    let hi = Math.min(ids.length - 1, needHi + 1);
    [lo, hi] = expandForSpanners(meiMeasures, lo, hi, model.docVersion());
    [lo, hi] = expandForEndings(meiMeasures, lo, hi);
    if (hi - lo + 1 > WINDOW_CAP) return null;
    const tWin = performance.now();
    this.lastRefillStats.windows++;
    this.lastRefillStats.windowMeasures += hi - lo + 1;
    try {
      const sub = model.serializeRangeForRender(lo, hi, { hejiEnabled: model.getHejiEnabled() }, this.viewStaves);
      const tk = ctx.naturalsToolkit();
      tk.setOptions(ctx.naturalsOptions());
      if (!tk.loadData(sub)) return null;
      const svg = tk.renderToSVG(1, {});
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      /* Multimeasure-rest runs (model/multirest.ts): an interior member has no
         rendered measure and contributes no width — natural 0 — so a run's
         width is carried by its representative alone and line sums stay right. */
      const units = model.renderUnits(this.viewStaves);
      for (let i = needLo; i <= needHi; i++) {
        if (units.isInterior(i)) { this.naturals.set(ids[i], 0); continue; }
        const el = doc.getElementById(ids[i]);
        const span = el ? staffLineSpan(el) : null;
        if (span === null || !(span > 0)) return null;
        this.naturals.set(ids[i], span);
      }
      /* The leading signature this window draws belongs to the context at
         `lo` — keyed semantically (clef+key) rather than by the folded head
         string, so the value can be looked up per LINE without serializing. */
      if (this.labelIndentW === null) this.labelIndentW = measureLabelIndent(svg);
      this.ensureSigCtx(model, meiMeasures, ids, ctx);
      const ctxKey = this.sigCtxKeys[lo];
      if (ctxKey !== undefined) {
        const known = this.sigWByCtx.get(ctxKey);
        if (known !== undefined && known > 0) return { sigW: known };
      }
      const sigW = measureLeadingSigW(svg, ids[units.repIdxOf(lo)]);
      if (sigW > 0 && ctxKey !== undefined) this.sigWByCtx.set(ctxKey, sigW);
      return { sigW };
    } finally {
      this.lastRefillStats.naturalsMs += Math.round(performance.now() - tWin);
    }
  }

  /* ── post-render verification ─────────────────────────────────────────── */

  /** After a refill render, check that every mounted page's system starts form
   *  a contiguous, in-order run of the pinned partition. smartSb0 can in rare
   *  cases auto-wrap a pinned line it deems overfull (the k87 class) — that is
   *  detected here, warned about, and healed by re-adopting from the rendered
   *  layout; under HKL_INDEX_CHECK it throws so fixtures fail loudly. */
  verifyRenderedPartition(container: HTMLElement, model: ComposerModel, pageCount: number, ctx: PageBreaksCtx): boolean {
    if (this.startIds === null) return true;
    const pos = new Map(this.startIds.map((id, i) => [id, i]));
    /* When pagination is owned too, a page must begin exactly where its pin
       says — otherwise the page grid the splicer edits in place is describing
       a layout Verovio didn't draw. */
    const pageOf = new Map(this.pageStartIds.map((id, i) => [id, i + 1]));
    let ok = true;
    let prevEnd = -1;
    /* A page the assembler is still BUILDING (pageassembly.ts: its systems
       are being added and its start is not committed until it closes) is not
       a rendered page yet — it reads as a page with an unpinned start. */
    for (const page of Array.from(container.querySelectorAll('.score-page:not(.score-page-pending):not(.score-page-building)'))) {
      const starts: string[] = [];
      for (const sys of Array.from(page.querySelectorAll('g.system'))) {
        const first = sys.querySelector('g.measure');
        if (first?.id) starts.push(first.id);
      }
      if (!starts.length) continue;
      let at = pos.get(starts[0]);
      if (at == null || at <= prevEnd) { ok = false; break; }
      if (this.pageStartIds.length > 1) {
        const pinnedPage = pageOf.get(starts[0]);
        const domPage = Number((page as HTMLElement).dataset.page);
        if (pinnedPage == null || (domPage >= 1 && pinnedPage !== domPage)) { ok = false; break; }
      }
      for (let i = 1; i < starts.length && ok; i++) {
        if (pos.get(starts[i]) !== at + i) ok = false;
      }
      if (!ok) break;
      prevEnd = at + starts.length - 1;
    }
    if (!ok) {
      if (indexCheckEnabled()) {
        throw new Error('[page-breaks] rendered partition diverged from the pinned one (castoff override?)');
      }
      console.warn('[page-breaks] rendered partition diverged from pins');
    }
    return ok;
  }
}

/** Horizontal extent of a rendered measure's staff line, from the SVG text
 *  (no layout): the first horizontal `M x1 y L x2 y` path directly under the
 *  measure's first `g.staff`. Verovio emits the five staff lines as such paths
 *  with absolute page coordinates; consecutive measures' lines abut, so the
 *  span is exactly what the previous `getBBox` reading measured as
 *  `next.x − this.x` (and as `bbox.width` for a window's last measure). Null
 *  when the shape is not what we expect — the caller then refuses the window
 *  (a derive), never guesses. */
function staffLineSpan(measureEl: Element): number | null {
  const staff = measureEl.querySelector('g.staff');
  if (!staff) return null;
  for (const p of Array.from(staff.children)) {
    if (p.localName !== 'path') continue;
    const m = /M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(p.getAttribute('d') ?? '');
    if (!m) continue;
    const y1 = Number(m[2]), y2 = Number(m[4]);
    if (Math.abs(y1 - y2) > 1e-6) continue;
    return Number(m[3]) - Number(m[1]);
  }
  return null;
}

/** Leading clef+key extent (meter excluded — mid-score systems don't redraw
 *  it) of a naturals window: sig glyphs left of the first note/rest/chord,
 *  measured from the first measure's bbox left edge. Needs glyph ink metrics,
 *  so this is the one place the window is attached and laid out; called only
 *  when the value could differ from the retained one (see measureWindow). The
 *  formula is unchanged from the pre-A7 reading so the value is identical. */
function measureLeadingSigW(svg: string, firstId: string): number {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0';
  host.innerHTML = svg;
  document.body.appendChild(host);
  try {
    const first = host.querySelector('#' + CSS.escape(firstId)) as SVGGraphicsElement | null;
    if (!first) return 0;
    const x0 = first.getBBox().x;
    let firstContent = Infinity;
    for (const el of Array.from(host.querySelectorAll('g.note, g.rest, g.chord, g.mRest'))) {
      const b = (el as SVGGraphicsElement).getBBox();
      if (b.x < firstContent) firstContent = b.x;
    }
    let sigRight = -Infinity;
    for (const el of Array.from(host.querySelectorAll('g.clef, g.keySig'))) {
      const b = (el as SVGGraphicsElement).getBBox();
      if (b.x < firstContent && b.x + b.width > sigRight) sigRight = b.x + b.width;
    }
    return isFinite(sigRight) ? sigRight - x0 : 0;
  } finally {
    host.remove();
  }
}

/** How far the FIRST system's staff is pushed right by the instrument names,
 *  in SVG user units — the width the document's first line does not get.
 *
 *  Measured as the staff's left edge in a naturals render: on a labelled score
 *  the first system's staff starts at 2009 while every later system's starts
 *  at 0, the page-margin origin (probed 2026-09-18, viola+piano: labels
 *  "Violoncello" w1678 and "Piano" w820). On an unlabelled score it is 0, so
 *  this costs nothing there.
 *
 *  Do NOT measure this from the first measure's offset instead: later systems
 *  carry a MEASURE NUMBER that hangs left of the staff (system bbox x = −220),
 *  so differencing the two offsets answers a different question and gave 1690
 *  where the truth is 2009. The staff edge is the quantity that matters —
 *  it is where the music may start. */
function measureLabelIndent(svg: string): number {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0';
  host.innerHTML = svg;
  document.body.appendChild(host);
  try {
    let left = Infinity;
    for (const el of Array.from(host.querySelectorAll('g.staff'))) {
      const b = (el as SVGGraphicsElement).getBBox();
      if (b.x < left) left = b.x;
    }
    return isFinite(left) && left > 0 ? left : 0;
  } finally {
    host.remove();
  }
}

/** requestIdleCallback with a setTimeout fallback. */
export function scheduleIdle(fn: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 1000 });
  else setTimeout(fn, 120);
}
