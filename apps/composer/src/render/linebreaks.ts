// Page-view line-break ownership (Phase C foundation — "own the line-breaking",
// docs/composer-page-splice-design.md, spike 5).
//
// In page view, Composer — not Verovio's castoff — decides which measure starts
// each system. The partition is pinned as render-time <sb> elements injected
// into the serialized render MEI (never into the live doc: saves, undo
// snapshots and history diffs stay pin-free by construction). Verovio remains
// the measure-level engraver + within-line justifier; with every boundary
// pinned, castoff has no free choices left, so an edit can only move the
// boundaries WE move.
//
// THE PARTITION IS NEVER RE-DERIVED (Max's ruling, 2026-08-30). An edit carries
// the existing partition across by line MEMBERSHIP and then repairs ONLY the
// lines the edit made ILLEGAL — outside the [MIN_FILL, FIT_MAX] envelope — by
// moving as few measures as possible. Everything else stays exactly where it
// was. This is what makes edits reversible: a greedy re-derivation accepts any
// line up to FIT_MAX, so a measure pulled into a line by a deletion stayed
// there when the deletion was undone (threshold hysteresis — the layout drifted
// one measure per edit and never drifted back). With conservative repair a
// no-op edit provably moves nothing, undo restores the original layout, and the
// legality bounds above are the only tuning surface. (An explicit "reflow the
// whole document as if freshly engraved" command, and explicit move-measure-
// between-systems commands, are deliberately future work — not this path.)
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
//       the partition is carried across by membership and any line the edit
//       made illegal is repaired minimally (push/pull one measure at a time,
//       hard breaks respected), pins are re-encoded, and the doc re-renders with
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
import { expandForSpanners, expandForEndings } from './splice.js';
import { captureSigState, signatureRanges, unionRun, type SigState } from './sigranges.js';
import { balanceSection, boundariesChanged, startsOf } from './balance.js';

const MEI_NS = 'http://www.music-encoding.org/ns/mei';

/** LEGALITY bounds — the load-bearing tuning surface (Max, 2026-08-30).
 *  Fills are (sigW + Σ natural widths)/budget: >1 = the justified line
 *  compresses, <1 = it stretches. These are NOT a packing target: the
 *  partition is never re-derived, so a line is only ever re-laid when an edit
 *  pushes it OUTSIDE this envelope (see `repartition`). Set wide enough to
 *  contain Verovio's own castoff output — the sonata's 118 lines measure
 *  0.706–1.426 by this same naturals model (spike 5) — so an adopted
 *  partition is legal by construction and the first edit in a region moves
 *  nothing. Narrowing them makes reflow more eager; widening makes lines
 *  denser/sparser before they break. */
const FIT_MAX = 1.45;
/** Exported because the LAST system's justification threshold is this same
 *  rule (render.ts `buildOptions` → Verovio `minLastJustification`): a final
 *  line is justified exactly when it is a legal line, and left at its natural
 *  width when it is too sparse to be one. */
export const MIN_FILL = 0.65;
/** Measure moves one repartition may perform before giving up (derive). */
const MAX_REPAIR_STEPS = 64;
/** Naturals windows one repartition may render before giving up (derive).
 *  Repairs examine a handful of lines, so this is generous. */
const MAX_ENSURES = 4;
/** A single naturals window (post spanner/ending expansion) larger than this
 *  falls back to a derive render instead. */
const WINDOW_CAP = 260;
/** Section balancer knobs (render/balance.ts; Max, 2026-09-05). A section-final
 *  line below MIN_FILL is the one illegality the repair loop cannot fix — it
 *  pulls only from the NEXT line, and a section's last line has none — so the
 *  balancer redistributes that section's measures instead. BALANCE_LAMBDA is
 *  the change penalty per moved boundary while the section is on screen: on
 *  the sonata 0.02 turned a delete-at-movement-end into "pull one bar back" or
 *  "fold the sparse final line into its neighbour", where the unpenalised
 *  optimum rewrote every boundary (the 3-vs-4-bar interleaving flips); ≤ 0.005
 *  still rippled. It is 0 when no line of the section is mounted — nothing
 *  visible changes, so the fully even partition is free. MERGE_MAX is the fill
 *  up to which a sparse final line is folded into its predecessor (one
 *  modestly compressed line beats two sparse ones; at 1.0 merges never fired
 *  and a section thinned toward MIN_FILL under deletion). */
export const BALANCE_LAMBDA = 0.02;
export const MERGE_MAX = 1.2;
/** Measures one idle slice of the balance job renders (~250 ms of Verovio —
 *  the adoption walk's 40 ms budget is unreachable for a render). */
const BALANCE_SLICE = 40;
/** Largest single naturals window the balancer asks for (before context and
 *  spanner/ending expansion, which WINDOW_CAP still bounds). */
const BALANCE_WINDOW = 120;

function indexCheckEnabled(): boolean {
  return typeof globalThis !== 'undefined' &&
    (globalThis as { __HKL_INDEX_CHECK?: boolean }).__HKL_INDEX_CHECK === true;
}

/** Everything the owner needs from the Renderer. */
export interface PageBreaksCtx {
  /** The live toolkit while it still holds the page layout being adopted
   *  (renderPage's data); null once something else was loaded into it. */
  layoutToolkit(): VerovioToolkit | null;
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
  /** Land a PARTITION-ONLY change (the document is unchanged): mounted lines
   *  are spliced, the rest marked stale, spills cascaded. False = refused; the
   *  owner reverts to the previous partition. */
  commitPartition(oldStartIds: string[], newStartIds: string[], oldPageStartIds: string[], newPageStartIds: string[]): boolean;
  /** The balance job checked every section (the renderer flags its
   *  partition-cache entry so a zoom round-trip needs no re-check). */
  balanceComplete(): void;
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
}

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
 *  (`cb-splicecost.js --arg "edit=ctrlm,mi=8"`). Flow differences are a subset
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
 *  all (`cb-commands.js`). Ids are stable, so the signature now changes when a
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
      else if (c.localName === 'sb' || c.localName === 'pb') pending.push(c.localName);
      else if (c.localName !== 'scoreDef' && c.querySelector('measure')) walk(c);
    }
  };
  walk(section);
  flush('$end');
  return parts.join(',');
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

/** Page bookkeeping after the lines [kLo, kLo+n0) were replaced by n1 ≤ n0
 *  lines (pages are carried by LINE index, B2): a page starting past the
 *  section shifts up by the lines removed; a page whose first line was one of
 *  the removed tail lines now begins at the line after the section (the tail
 *  merged into lines that end on the previous page); a page left with no line
 *  collapses into its predecessor. */
function linesReplaced(pageLines: number[], kLo: number, n0: number, n1: number, lineCount: number): void {
  const d = n0 - n1;
  if (d <= 0) return;
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

interface AdoptionTask {
  nextPage: number;
  pageCount: number;
  startIds: string[];
  /** First line start of each page — the pagination being adopted. */
  pageStartIds: string[];
  cancelled: boolean;
}

/** The idle balance job (see armBalanceJob). Sections are identified by the
 *  id of their first line's start measure, so an edit between two slices —
 *  which may move boundaries or balance a section itself — never confuses it. */
interface BalanceJob {
  cancelled: boolean;
  done: Set<string>;
  steps: number;
  /** One slice; scheduled through scheduleIdle, or driven synchronously by
   *  finishBalanceJobNow (tests/probes). */
  step: () => void;
}

/** Diagnostics of one balance pass (edit path, initial band, or one job step). */
export interface BalanceStats {
  sections: number;
  applied: number;
  changed: number;
  removed: number;
  reasons: string[];
  ms: number;
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
  /** Running clef+key context key per measure, document order (`sigCtxVer` =
   *  the `docVersion()` it was computed for). */
  private sigCtxKeys: string[] = [];
  private sigCtxVer = -1;
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
  private adoption: AdoptionTask | null = null;
  /** Line starts the last refill actually MOVED (0 = the edit changed content
   *  only and no boundary shifted — the common, desired case). Diagnostics
   *  and tests read it; fixtures assert 0 for no-op-equivalent edits. */
  lastRefillLines = 0;
  /** Timing/diagnostic breakdown of the last tryRefill (ms). */
  lastRefillStats: { naturalsMs: number; windows: number; windowMeasures: number; injectMs: number; serializeMs: number } =
    { naturalsMs: 0, windows: 0, windowMeasures: 0, injectMs: 0, serializeMs: 0 };
  /** Why the last tryRefill returned null (diagnostics/tests); '' after a
   *  successful refill. */
  lastDeriveReason = '';
  /** Diagnostics of the last balance pass (see BalanceStats). */
  lastBalance: BalanceStats = { sections: 0, applied: 0, changed: 0, removed: 0, reasons: [], ms: 0 };
  /** Diagnostics of the last SYNC band balance (balanceInitialBand) — kept
   *  apart from `lastBalance`, which every job slice overwrites. */
  lastInitialBalance: BalanceStats | null = null;
  private balanceJob: BalanceJob | null = null;
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
    this.sigCtxKeys = [];
    this.sigCtxVer = -1;
    this.sigCtxMisses = 0;
    this.sigCtxMissKeys.clear();
    this.sigCtxPending = 0;
    this.sig.clear();
    this.sigOrder = [];
    this.sigEl.clear();
    this.sigDirty.clear();
    this.sigAll = true;
    this.budgetW = 0;
    if (this.adoption) this.adoption.cancelled = true;
    this.adoption = null;
    if (this.balanceJob) this.balanceJob.cancelled = true;
    this.balanceJob = null;
  }

  /** Own the partition of `viewStaves` (null = every staff). A subset other
   *  than the current one invalidates: its measures have other widths. */
  setView(viewStaves: number[] | null): void {
    const key = viewKeyOf(viewStaves);
    if (key !== this.viewKey) this.invalidate();
    this.viewKey = key;
    this.viewStaves = viewStaves ? viewStaves.slice() : null;
  }

  /** True while the idle balance job still has sections to check. */
  balanceJobActive(): boolean {
    return this.balanceJob !== null && !this.balanceJob.cancelled;
  }

  /** Run the idle balance job to completion synchronously (tests and probes;
   *  the idle callbacks it already scheduled then find no job and return). */
  finishBalanceJobNow(): void {
    const job = this.balanceJob;
    if (!job) return;
    let guard = 0;
    while (this.balanceJob === job && !job.cancelled && guard++ < 10_000) job.step();
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

  /** True when pagination is owned (pinned `<pb>`), not left to Verovio. */
  paginationOwned(): boolean {
    return this.pageStartIds.length > 1;
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

  /** True when a refill attempt is worth making (adopted, or adoption armed
   *  and finishable). */
  canAttemptRefill(): boolean {
    return this.startIds !== null || this.adoption !== null;
  }

  /** True when the doc is actually being line-break-owned (a multi-line
   *  partition is adopted) — gates the derive-fallback log so single-line
   *  documents, which always derive by design, don't spam the console. */
  ownershipActive(): boolean {
    return this.startIds !== null && this.startIds.length > 1;
  }

  /* ── adoption ─────────────────────────────────────────────────────────── */

  /** Adopt the partition Verovio just cast off, read from PAGE-BASED MEI
   *  (`getMEI({scoreBased:false})` → `<page>`/`<system>` wrappers) instead of
   *  rendering every page to SVG. Measured on the sonata: ~100 ms vs ~1830 ms
   *  for the SVG walk, producing a byte-identical partition (118 lines /
   *  37 pages). Being both cheap and SYNCHRONOUS is what matters: the caller
   *  can adopt and then immediately paint the pinned `encoded` render, so the
   *  castoff pass becomes an internal bootstrap the user never sees — one
   *  break algorithm on screen, always, and no first-edit transition.
   *
   *  `tk` must hold the castoff layout (loadData done, nothing else needed).
   *  Returns false when the output can't be read, and the caller falls back to
   *  painting the castoff layout + arming the idle SVG walk. */
  adoptFromCastoff(model: ComposerModel, tk: VerovioToolkit): boolean {
    const read = partitionFromLayout(tk);
    if (!read) return false;
    return this.adoptPartition(model, read.lines, read.pages);
  }

  /** Commit `lines`/`pages` as the owned partition against the CURRENT document:
   *  reset state, capture the structural + per-measure signature baseline (so a
   *  later refill diffs against the document this partition describes), and
   *  verify every id still exists. Shared by castoff adoption and by the
   *  renderer's partition cache (`restorePartition`). */
  private adoptPartition(model: ComposerModel, lines: string[], pages: string[]): boolean {
    if (lines.length <= 1) return false;   // single-line docs are never owned
    this.invalidate();
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
  restorePartition(model: ComposerModel, lines: string[], pages: string[]): boolean {
    return this.adoptPartition(model, lines, pages);
  }

  /** Arm lazy partition adoption right after a derive render: the live toolkit
   *  holds the rendered layout; read each page's system starts in idle slices
   *  so the (~2 s on a large score) walk never blocks an interaction. */
  armAdoption(model: ComposerModel, pageCount: number, ctx: PageBreaksCtx): void {
    this.invalidate();
    this.userBreakSig = computeUserBreakSig(model);
    this.sigState = captureSigState(model.getDoc(), headExtra(model));
    /* Signatures of the doc state this layout renders — captured NOW, in the
       same synchronous block as the derive render, so the idle-completed
       partition and the sig baseline describe the same document. */
    const meiMeasures = model.allMeasures();
    this.captureSigs(model.getDoc(), meiMeasures, measureIds(meiMeasures));
    const task: AdoptionTask = { nextPage: 1, pageCount, startIds: [], pageStartIds: [], cancelled: false };
    this.adoption = task;
    const step = (): void => {
      if (task.cancelled) return;
      const tk = ctx.layoutToolkit();
      if (!tk) { task.cancelled = true; this.adoption = null; return; }
      const budget = performance.now() + 40;
      while (task.nextPage <= task.pageCount && performance.now() < budget) {
        const starts = systemStartsFromPageSvg(tk.renderToSVG(task.nextPage, {}));
        if (starts.length) task.pageStartIds.push(starts[0]);
        task.startIds.push(...starts);
        task.nextPage++;
      }
      if (task.nextPage > task.pageCount) {
        this.commitAdoption(task);
        return;
      }
      scheduleIdle(step);
    };
    scheduleIdle(step);
  }

  /** Finish an in-flight adoption synchronously (an edit arrived first). */
  private finishAdoptionNow(ctx: PageBreaksCtx): boolean {
    const task = this.adoption;
    if (!task || task.cancelled) return this.startIds !== null;
    const tk = ctx.layoutToolkit();
    if (!tk) { task.cancelled = true; this.adoption = null; return false; }
    while (task.nextPage <= task.pageCount) {
      const starts = systemStartsFromPageSvg(tk.renderToSVG(task.nextPage, {}));
      if (starts.length) task.pageStartIds.push(starts[0]);
      task.startIds.push(...starts);
      task.nextPage++;
    }
    return this.commitAdoption(task);
  }

  private commitAdoption(task: AdoptionTask): boolean {
    /* Only the CURRENT task may commit — once. `finishAdoptionNow` completes a
       walk synchronously when an edit arrives, but the task's already-scheduled
       idle `step` still fires later; with `nextPage` past `pageCount` it skipped
       straight here and RE-INSTALLED the task's stale start list over the
       partition the refill had just committed (2026-09-01: the between-fixture
       blank-document adoption, finished with ONE start during the next fixture's
       setup, re-committed that one-line partition 150 ms after the fixture's
       second splice — intermittent, order-dependent, traced by a setter trap on
       `startIds`). A superseded or already-committed task must never write. */
    if (this.adoption !== task || task.cancelled) return false;
    this.adoption = null;
    task.cancelled = true;
    if (task.startIds.length === 0) return false;
    this.startIds = task.startIds;
    this.pageStartIds = task.pageStartIds;
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
    if (this.startIds === null && !this.finishAdoptionNow(ctx)) return bail('no adoptable partition');
    if (this.startIds!.length <= 1) return bail('single-line partition');
    if (computeUserBreakSig(model) !== this.userBreakSig) return bail('user breaks changed');
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
    const redraw = unionRun(redrawSpan.lo, redrawSpan.hi, sr.ranges);

    let newStartIds: string[];
    let newPageStartIds: string[];
    let changedRun: { lo: number; hi: number } | null;
    const oldPageStartIds = this.pageStartIds.slice();
    if (run.lo > run.hi) {
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
      changedRun = { lo: Math.min(run.lo, redraw.lo), hi: Math.max(run.hi, redraw.hi) };
      /* Pagination is carried INSIDE the repair, by line (see repartition):
         a surviving line never changes page, and a page whose lines all
         vanished collapses. The renderer compares old and new page COUNTS to
         decide whether the page grid itself changed. */
      const repaired = this.repartition(model, meiMeasures, ids, idIdx, hard, { lo: run.lo, hi: run.hi }, ctx);
      if (!repaired) return bail('repartition window/cap exhausted');
      newStartIds = repaired.starts;
      newPageStartIds = repaired.pages;
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

    const strategy: RefillStrategy = newPageStartIds.length > 1 ? 'encoded' : 'line';
    this.startIds = newStartIds;
    this.pageStartIds = newPageStartIds;
    this.captureSigs(model.getDoc(), meiMeasures, ids, cur);
    this.sigState = newState;
    this.lastDeriveReason = '';
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
      oldPageStartIds, newPageStartIds,
    };
  }

  /** Carry the committed partition across the edit and repair ONLY what the
   *  edit made illegal. Never re-derives: an edit that leaves every line
   *  inside [MIN_FILL, FIT_MAX] moves no boundary at all, so a no-op edit is
   *  a visual no-op and undo restores the original layout exactly (Max's
   *  ruling, 2026-08-30 — see the module header). Returns the new start-id
   *  list, or null (caller derives). */
  private repartition(
    model: ComposerModel,
    meiMeasures: Element[],
    ids: string[],
    idIdx: Map<string, number>,
    hard: Set<string>,
    dirty: { lo: number; hi: number },
    ctx: PageBreaksCtx,
  ): { starts: string[]; pages: string[] } | null {
    const n = ids.length;
    const dLo = Math.max(0, Math.min(dirty.lo, n - 1));
    const dHi = Math.max(dLo, Math.min(dirty.hi, n - 1));

    /* ── carry the partition across the edit, by MEMBERSHIP ──
       Each old line keeps its first surviving member as its start, so:
       deleting a line's first measure just moves that line's start to the
       next survivor (no reflow); an inserted measure joins the line whose
       index range contains it; a line whose every member was deleted
       disappears. Nothing here consults widths — only structure. */
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
        const ni = idIdx.get(this.sigOrder[i]);
        if (ni == null) continue;
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
       indices into `starts` through the repair loop below, because a repair
       that INSERTS a line shifts every later page's line index. */
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
        if (ensures >= MAX_ENSURES) return false;
        ensures++;
        const w = this.measureWindow(model, meiMeasures, ids, i, j, ctx);
        if (w == null) return false;
        i = j + 1;                       // measureWindow files sigW by context
      }
      return true;
    };

    /* Measure the whole dirty range in ONE window before the repair loop. A
       note edit dirties a measure or two, but a signature change governs a
       RANGE (sigranges.ts) that can span many lines, and the per-line ensures
       below would spend MAX_ENSURES on it and derive — the O(document) fallback
       for what is an O(range) change. One window over the range costs exactly
       the range; the repair loop then finds every natural present. */
    if (dHi >= dLo && !ensureRange(dLo, dHi)) return null;

    const budget = this.budgetW;
    const lineEnd = (k: number): number => (k + 1 < starts.length ? starts[k + 1] : n);
    const fillOf = (k: number): number | null => {
      const from = starts[k], to = lineEnd(k);
      if (!ensureRange(from, to - 1)) return null;
      const sig = this.sigWAt(from);
      if (sig === null) return null;
      let acc = sig;
      for (let i = from; i < to; i++) acc += this.naturals.get(ids[i]) ?? 0;
      return acc / budget;
    };

    /* ── repair ──
       Examine only the lines the edit touched, then whatever a repair
       cascades into. Each step moves ONE measure across ONE boundary, so the
       reflow is as small as the illegality demands. */
    let first = 0, last = 0;
    for (let k = 0; k < starts.length; k++) {
      if (starts[k] <= dLo) first = k;
      if (starts[k] <= dHi) last = k;
    }
    /* A line that pushed must never pull the same measure back (oscillation);
       an overfull line that cannot shed without going underfull stays as it
       is — content over churn. */
    let pushed = new Set<number>();
    let steps = 0;
    let k = first;
    let through = last;
    while (k < starts.length && k <= through) {
      if (++steps > MAX_REPAIR_STEPS) return null;
      const f = fillOf(k);
      if (f == null) return null;
      const from = starts[k], to = lineEnd(k);
      if (f > FIT_MAX && to - from > 1) {
        const moving = to - 1;                       // last measure of this line
        const nat = this.naturals.get(ids[moving]) ?? 0;
        if ((f * budget - nat) / budget < MIN_FILL && to - from === 2) {
          k++; continue;                             // shedding would only trade one illegality for another
        }
        if (k + 1 >= starts.length) {
          starts.push(moving);                       // new final line
          pushed = new Set<number>();
        } else if (hard.has(ids[starts[k + 1]])) {
          starts.splice(k + 1, 0, moving);           // can't move a user break — new line before it
          lineInserted(k + 1);
          pushed = new Set<number>();
          through++;
        } else {
          starts[k + 1] = moving;
        }
        pushed.add(k);
        through = Math.max(through, k + 1);
        continue;                                    // re-check this line
      }
      if (f < MIN_FILL && k + 1 < starts.length && !pushed.has(k)) {
        const cand = starts[k + 1];
        if (!hard.has(ids[cand]) && lineEnd(k + 1) - cand > 1) {
          if (!ensureRange(cand, cand)) return null;
          const nat = this.naturals.get(ids[cand]) ?? 0;
          if ((f * budget + nat) / budget <= FIT_MAX) {
            starts[k + 1] = cand + 1;
            through = Math.max(through, k + 1);
            continue;                                // re-check this line
          }
        }
      }
      k++;
    }

    /* ── balance (2026-09-05) ──
       The repair pulls only from the NEXT line, so a section-final line below
       MIN_FILL — a lone bar before a movement break, a one-bar stub while
       composing at the end — is the one illegality it cannot fix. For every
       section the edit touched whose final line is defective, redistribute
       that section's measures (render/balance.ts), with the change penalty:
       the section is on screen. Only a section whose naturals are all cached
       is balanced here (the adoption job warms them); one still missing
       naturals keeps today's behaviour and the job balances it when it gets
       there — never a whole-section window on the hot path. */
    this.balanceTouched(starts, pageLines, ids, hard, first, Math.min(through, starts.length - 1), BALANCE_LAMBDA);

    const out = starts.map((i) => ids[i]);
    let movedLines = 0;
    for (let i = 0; i < Math.max(out.length, this.startIds!.length); i++) {
      if (out[i] !== this.startIds![i]) movedLines++;
    }
    this.lastRefillLines = movedLines;
    return { starts: out, pages: pageLines.map((li) => out[li]) };
  }

  /* ── section balancing (2026-09-05) ───────────────────────────────────── */

  /** Fill of line k of `starts` from cached naturals; null when any is missing. */
  private lineFill(starts: number[], k: number, ids: string[]): number | null {
    const from = starts[k], to = k + 1 < starts.length ? starts[k + 1] : ids.length;
    const sig = this.sigWAt(from);
    if (sig === null) return null;
    let acc = sig;
    for (let i = from; i < to; i++) {
      const w = this.naturals.get(ids[i]);
      if (w === undefined) return null;
      acc += w;
    }
    return acc / this.budgetW;
  }

  /** Balance the section occupying lines [kLo..kHi] of `starts` in place when
   *  its final line is defective (fill < MIN_FILL): `starts` and `pageLines`
   *  (page-start line indices) are updated; the line count may shrink (merge
   *  rule / N−1 fallback), never grow. Requires every natural of the section
   *  to be cached. Reasons: '' (nothing to do), 'naturals incomplete',
   *  'no legal balance: stub kept' (document-final — Max's rule 2), 'no legal
   *  balance: section kept', 'single-line result'. */
  private balanceSectionLines(
    starts: number[], pageLines: number[], kLo: number, kHi: number, ids: string[], lambda: number,
  ): { applied: boolean; reason: string; changed: number; removed: number } {
    const none = (reason: string) => ({ applied: false, reason, changed: 0, removed: 0 });
    const n = ids.length;
    const mFrom = starts[kLo], mTo = kHi + 1 < starts.length ? starts[kHi + 1] : n;
    const last = this.lineFill(starts, kHi, ids);
    if (last === null) return none('naturals incomplete');
    if (last >= MIN_FILL) return none('');
    const budget = this.budgetW;
    const ws: number[] = [];
    for (let i = mFrom; i < mTo; i++) {
      const w = this.naturals.get(ids[i]);
      if (w === undefined) return none('naturals incomplete');
      ws.push(w / budget);
    }
    const refLens: number[] = [];
    for (let k = kLo; k <= kHi; k++) refLens.push((k + 1 < starts.length ? starts[k + 1] : n) - starts[k]);
    /* balanceSection takes ONE sig/budget for the section it balances; a
       section can still contain a key change, so this is the section's own
       leading context rather than a per-line value. Deterministic (which is
       the defect being fixed); per-line exactness inside the balancer is a
       separate refinement. */
    const sigSec = this.sigWAt(mFrom);
    if (sigSec === null) return none('sig context unmeasured');
    const res = balanceSection(ws, sigSec / budget, refLens, {
      minFill: MIN_FILL, fitMax: FIT_MAX, lambda, mergeMax: MERGE_MAX,
    });
    if (!res) return none(kHi === starts.length - 1 ? 'no legal balance: stub kept' : 'no legal balance: section kept');
    const n0 = refLens.length, n1 = res.lens.length;
    /* A partition needs two lines to be owned at all (tryRefill's single-line
       rule); a document that small keeps its castoff shape. */
    if (starts.length - (n0 - n1) < 2) return none('single-line result');
    const changed = boundariesChanged(refLens, res.lens);
    if (changed === 0) return none('');
    const secStarts = startsOf(res.lens).map((o) => mFrom + o);
    starts.splice(kLo, n0, ...secStarts);
    linesReplaced(pageLines, kLo, n0, n1, starts.length);
    return { applied: true, reason: '', changed, removed: n0 - n1 };
  }

  /** Balance every section intersecting lines [kFrom..kTo] (edit path: the
   *  lines the repair examined). Sections are visited last-to-first so a line
   *  removal in one never shifts the indices of one still to visit. */
  private balanceTouched(
    starts: number[], pageLines: number[], ids: string[], hard: Set<string>,
    kFrom: number, kTo: number, lambda: number,
  ): void {
    const t0 = performance.now();
    const lb: BalanceStats = { sections: 0, applied: 0, changed: 0, removed: 0, reasons: [], ms: 0 };
    const secs = sectionRanges(starts, ids, hard).filter(([lo, hi]) => hi >= kFrom && lo <= kTo);
    for (let s = secs.length - 1; s >= 0; s--) {
      const [kLo, kHi] = secs[s];
      lb.sections++;
      const r = this.balanceSectionLines(starts, pageLines, kLo, kHi, ids, lambda);
      if (r.reason) lb.reasons.push(r.reason);
      if (r.applied) { lb.applied++; lb.changed += r.changed; lb.removed += r.removed; }
    }
    lb.ms = Math.round(performance.now() - t0);
    this.lastBalance = lb;
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

  /** Adoption-time balance for the sections with a line on the first `pages`
   *  pages, run SYNCHRONOUSLY before the pinned paint (decided with Max,
   *  2026-09-05): the first paint is already balanced, so page 1 never re-flows
   *  under the reader; every other section is left to the idle job. `budget`
   *  is the justified system width, measured from the castoff layout since
   *  nothing is mounted yet. The final line's naturals are measured first —
   *  they alone decide whether the section is defective — and the rest of the
   *  section only when it is (movement I of the sonata: 139 measures ≈ 0.9 s).
   *  λ = 0: nothing is painted, so the fully even partition is free. */
  balanceInitialBand(model: ComposerModel, ctx: PageBreaksCtx, budget: number, pages: number): void {
    const t0 = performance.now();
    const lb: BalanceStats = { sections: 0, applied: 0, changed: 0, removed: 0, reasons: [], ms: 0 };
    this.lastBalance = lb;
    this.lastInitialBalance = lb;
    if (this.startIds === null || this.startIds.length <= 1 || !(budget > 0)) return;
    if (this.budgetW <= 0) this.budgetW = budget;
    const meiMeasures = model.allMeasures();
    const ids = measureIds(meiMeasures);
    const part = this.indexedPartition(ids);
    if (!part) return;
    const { starts, pageLines } = part;
    const lastLine = pageLines.length > pages ? pageLines[pages] - 1 : starts.length - 1;
    const hard = hardStartIds(model);
    const secs = sectionRanges(starts, ids, hard).filter(([lo]) => lo <= lastLine);
    let touched = false;
    for (let s = secs.length - 1; s >= 0; s--) {
      const [kLo, kHi] = secs[s];
      lb.sections++;
      const mFrom = starts[kLo], mTo = kHi + 1 < starts.length ? starts[kHi + 1] : ids.length;
      if (this.measureMissing(model, meiMeasures, ids, starts[kHi], mTo - 1, ctx, Infinity) !== true) { lb.reasons.push('naturals window failed'); continue; }
      const last = this.lineFill(starts, kHi, ids);
      if (last === null || last >= MIN_FILL) continue;
      if (this.measureMissing(model, meiMeasures, ids, mFrom, mTo - 1, ctx, Infinity) !== true) { lb.reasons.push('naturals window failed'); continue; }
      const r = this.balanceSectionLines(starts, pageLines, kLo, kHi, ids, 0);
      if (r.reason) lb.reasons.push(r.reason);
      if (r.applied) { lb.applied++; lb.changed += r.changed; lb.removed += r.removed; touched = true; }
    }
    if (touched) {
      const newStarts = starts.map((i) => ids[i]);
      this.startIds = newStarts;
      this.pageStartIds = pageLines.map((li) => newStarts[li]);
    }
    lb.ms = Math.round(performance.now() - t0);
  }

  /** Measure and cache the natural width of EVERY measure, synchronously.
   *
   *  The balance and every later legality check are only as complete as the
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

  /** Arm the idle balance job after a derive: check every section not yet
   *  balanced, mounted ones first, measuring at most BALANCE_SLICE naturals per
   *  idle slice (the final line first — a non-defective section costs one small
   *  window), and land each balanced section through `ctx.commitPartition`
   *  (splice for mounted lines, stale marks for the rest). A section with no
   *  mounted line balances with λ = 0; one on screen with BALANCE_LAMBDA.
   *  Cancelled by `invalidate()`; an edit between slices is fine — every slice
   *  re-reads the committed partition and skips sections already done. */
  armBalanceJob(model: ComposerModel, ctx: PageBreaksCtx): void {
    if (this.balanceJob) this.balanceJob.cancelled = true;
    this.balanceJob = null;
    if (this.startIds === null || this.startIds.length <= 1) return;
    const job: BalanceJob = { cancelled: false, done: new Set(), steps: 0, step: () => {} };
    this.balanceJob = job;
    const finish = (): void => { if (this.balanceJob === job) this.balanceJob = null; };
    /* A slice that throws must not leave a zombie job (balanceJobActive() true
       forever, the partition-cache flag never set): cancel it, loudly. */
    const step = (): void => {
      try {
        stepBody();
      } catch (e) {
        job.cancelled = true;
        finish();
        if (indexCheckEnabled()) throw e;
        console.warn('[page-balance] job step failed — balancing stopped for this render: ' + (e instanceof Error ? e.message : String(e)));
      }
    };
    const stepBody = (): void => {
      if (job.cancelled || this.balanceJob !== job) return;
      if (this.startIds === null) { finish(); return; }
      if (this.budgetW <= 0) {
        const w = ctx.budgetW();
        if (w == null || !(w > 0)) { finish(); return; }
        this.budgetW = w;
      }
      const meiMeasures = model.allMeasures();
      const ids = measureIds(meiMeasures);
      const part = this.indexedPartition(ids);
      if (!part) { finish(); return; }
      const { starts, pageLines } = part;
      const hard = hardStartIds(model);
      const secs = sectionRanges(starts, ids, hard).filter(([lo]) => !job.done.has(ids[starts[lo]]));
      if (!secs.length) { finish(); ctx.balanceComplete(); return; }
      const pageOfLine = (k: number): number => {
        let p = 1;
        for (let q = 1; q < pageLines.length; q++) { if (pageLines[q] <= k) p = q + 1; else break; }
        return p;
      };
      const mountedSec = (lo: number, hi: number): boolean => {
        for (let k = lo; k <= hi; k++) if (ctx.isPageMounted(pageOfLine(k))) return true;
        return false;
      };
      const [kLo, kHi] = secs.find(([lo, hi]) => mountedSec(lo, hi)) ?? secs[0];
      const secId = ids[starts[kLo]];
      const mFrom = starts[kLo], mTo = kHi + 1 < starts.length ? starts[kHi + 1] : ids.length;
      job.steps++;
      const t0 = performance.now();
      const lb: BalanceStats = { sections: 1, applied: 0, changed: 0, removed: 0, reasons: [], ms: 0 };
      const settle = (): void => { lb.ms = Math.round(performance.now() - t0); this.lastBalance = lb; scheduleIdle(step); };
      /* Final line first (it decides whether the section is defective), then
         the REST of the section regardless: the edit path balances only a
         section whose naturals are all cached, so a section that is fine now
         must still be warm for the edit that later makes its final line
         sparse — otherwise that defect could never be repaired. */
      let m = this.measureMissing(model, meiMeasures, ids, starts[kHi], mTo - 1, ctx, BALANCE_SLICE);
      if (m === false) { job.done.add(secId); lb.reasons.push('naturals window failed'); settle(); return; }
      if (m === 'incomplete') { settle(); return; }
      const last = this.lineFill(starts, kHi, ids);
      m = this.measureMissing(model, meiMeasures, ids, mFrom, mTo - 1, ctx, BALANCE_SLICE);
      if (m === false) { job.done.add(secId); lb.reasons.push('naturals window failed'); settle(); return; }
      if (m === 'incomplete') { settle(); return; }
      job.done.add(secId);
      if (last === null || last >= MIN_FILL) { settle(); return; }
      const r = this.balanceSectionLines(starts, pageLines, kLo, kHi, ids, mountedSec(kLo, kHi) ? BALANCE_LAMBDA : 0);
      if (r.reason) lb.reasons.push(r.reason);
      if (r.applied) {
        const oldStarts = this.startIds, oldPages = this.pageStartIds;
        const newStarts = starts.map((i) => ids[i]);
        const newPages = pageLines.map((li) => newStarts[li]);
        this.startIds = newStarts;
        this.pageStartIds = newPages;
        if (ctx.commitPartition(oldStarts, newStarts, oldPages, newPages)) {
          lb.applied++; lb.changed += r.changed; lb.removed += r.removed;
        } else {
          this.startIds = oldStarts;
          this.pageStartIds = oldPages;
          lb.reasons.push('commit refused');
        }
      }
      settle();
    };
    job.step = step;
    scheduleIdle(step);
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
   *  (`cb-naturalspath.js`): 441/443 interior measures and every last measure
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
    const ver = model.docVersion();
    const keysCurrent = this.sigCtxVer === ver && this.sigCtxKeys.length === meiMeasures.length;
    if (keysCurrent && this.sigCtxPending === 0) return;
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
      out.push(keyOf());
      seen.add(node);
      /* Inline clefs change the clef for every LATER line. */
      for (const c of Array.from(node.querySelectorAll('layer > clef'))) {
        const st = c.closest('staff')?.getAttribute('n');
        if (!st) continue;
        const shape = c.getAttribute('shape'), line = c.getAttribute('line');
        const dis = c.getAttribute('dis'), place = c.getAttribute('dis.place');
        clef.set(st, (shape ?? '') + (line ?? '') + (dis ? dis + (place ?? '') : ''));
      }
    }
    /* A document whose measures are not the section's direct children (or a
       shape this walk does not recognise) gets no keys rather than wrong ones;
       sigWAt then reports misses instead of inventing a yardstick. */
    this.sigCtxKeys = out.length === meiMeasures.length && meiMeasures.every((m) => seen.has(m)) ? out : [];
    this.sigCtxVer = ver;
    this.measureAllSigCtx(model, ids, ctx);
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
  private measureAllSigCtx(model: ComposerModel, ids: string[], ctx: PageBreaksCtx): void {
    if (!this.sigCtxKeys.length) { this.sigCtxPending = 0; return; }
    const firstIdx = new Map<string, number>();
    this.sigCtxKeys.forEach((k, i) => { if (!firstIdx.has(k)) firstIdx.set(k, i); });
    const failed: string[] = [];
    let measured = 0;
    for (const [key, idx] of firstIdx) {
      if (this.sigWByCtx.has(key)) continue;
      const hi = Math.min(ids.length - 1, idx + 1);
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
      for (let i = needLo; i <= needHi; i++) {
        const el = doc.getElementById(ids[i]);
        const span = el ? staffLineSpan(el) : null;
        if (span === null || !(span > 0)) return null;
        this.naturals.set(ids[i], span);
      }
      /* The leading signature this window draws belongs to the context at
         `lo` — keyed semantically (clef+key) rather than by the folded head
         string, so the value can be looked up per LINE without serializing. */
      this.ensureSigCtx(model, meiMeasures, ids, ctx);
      const ctxKey = this.sigCtxKeys[lo];
      if (ctxKey !== undefined) {
        const known = this.sigWByCtx.get(ctxKey);
        if (known !== undefined && known > 0) return { sigW: known };
      }
      const sigW = measureLeadingSigW(svg, ids[lo]);
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
    for (const page of Array.from(container.querySelectorAll('.score-page:not(.score-page-pending)'))) {
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
      console.warn('[page-breaks] rendered partition diverged from pins — re-adopting from the rendered layout');
      this.armAdoption(model, pageCount, ctx);
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

/** requestIdleCallback with a setTimeout fallback. */
export function scheduleIdle(fn: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 1000 });
  else setTimeout(fn, 120);
}
