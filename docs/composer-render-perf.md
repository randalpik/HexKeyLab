# Composer render performance — living plan

Tracking doc for large-document render latency (page view, view switching,
document-wide actions). Companion to
[composer-spot-splice-design.md](composer-spot-splice-design.md), which owns the
scroll-view splice engine (Phases A–B3, shipped; steady-state scroll edits
~150 ms Firefox). This doc owns everything still slow: the full-render paths.
Update statuses here as levers land or get rejected.

Backlog items this covers: "Improve speed in page view", "Add loading
indications for document actions rather than silent stall".

## Measured baseline (2026-08-29, headless Chromium, sonataBr1)

446 measures / 9,099 notes / 37 pages @100% zoom. Probe: wrap
`verovio.toolkit.prototype.{loadData,renderToSVG,setOptions}` +
`model.serialize` in-page, drive `__composerImportMusicXml` / `reRender`.
Firefox is worse on the DOM-bound buckets (Max observes up to 10 s); WASM
buckets transfer roughly 1:1.

| Action | Total | Breakdown |
|---|---|---|
| Page-view full render (= every edit, zoom, switch) | ~4.5 s | serialize 75 ms · loadData (layout) 1.25 s · renderToSVG ×37 1.8 s (~50 ms/page) · ~1.3 s DOM remainder (innerHTML parse, postProcess, header/section injections, overlay) |
| Zoom change, page view | ~4.0 s | same full pipeline |
| Switch page→scroll | ~6.7 s | ONE renderToSVG(1) of the ~190k-px SVG ≈ 5 s; loadData only ~250 ms (breaks:'none' skips line-breaking) |
| Theme change (was) | ~6.4 s | full re-engrave for a DOM-only repaint |
| Scroll no-op reRender / steady-state edit | 70 ms / ~150 ms (Fx) | splice path — at threshold |

Structural facts driving the plan:

1. **Verovio separates layout from drawing.** `loadData` lays out all pages;
   `renderToSVG(n)` draws one (~50 ms). Nothing forces drawing all 37 pages +
   post-processing them per render.
2. **All engraving is synchronous main-thread WASM.** No indicator can animate
   during the block; inputs stack. Feedback requires async chunking (yield
   between per-page renderToSVG) or a worker toolkit.
3. `redoLayout()` re-lays-out already-loaded data with current options — skips
   MEI parse/convert on option-only changes (zoom).
4. The splice machinery (spacer measure, defs merge, dirty range,
   anchor/cascade) transfers to system granularity for page view (Phase C).

## Tier 1 — cheap independent wins

- [x] **T1.1 Theme change in place** (shipped 2026-08-29). `setTheme` no longer
  forces a re-engrave; the theme handler runs `renderer.applyThemeToRendered()`
  (`applyNotationTheme` + transparent-class toggle) on the existing container —
  the pass was already fully reversible (dark tags + inline-paints noteheads;
  light removes both). Measured 6.4 s → ~0.45–0.55 s on the sonata (Chromium;
  the remainder is the 9,099-note repaint traversal — optimizable later if it
  bites in Firefox). Splicer + mode caches stay valid across theme changes.
- [x] **T1.2 View-switch render cache** (shipped 2026-08-29). On a mode switch,
  `stashAndRestore` stashes the outgoing mode's container nodes (detached REAL
  nodes, so splicer refs survive) keyed on serialize output + zoom + pageScale,
  and re-attaches the incoming mode's stash when the key matches (re-applying
  theme if it changed while stashed). Cache cleared by `forceFullRerender()`
  and the string-entry `render()`. A mode-change cache MISS forces a full
  engrave — never a splice into DOM the other mode owns. `renderComposer` now
  returns `fresh: boolean`; main.ts skips the page-only injections + crisp
  snap on a restore (already baked into the stashed DOM). Measured: page
  restore 4.3 s → ~0.75 s, scroll restore 6.7 s → ~0.78 s (Chromium; ~0.6 s of
  that is the browser re-laying-out the re-attached SVG — Firefox number TBD).
  Key soundness: byte-equal serialize ⇒ identical xml:ids ⇒ render-equivalent
  DOM; correctness relies on "every model mutation re-renders before a mode
  switch can happen" (true for all app paths — mutations funnel through
  reRender).
- [x] ~~**T1.3 Zoom via `redoLayout()`.**~~ **REJECTED — dead end (2026-08-29,
  don't retry).** Implemented and reverted same-day: on the CDN build,
  `setOptions` + `redoLayout()` does NOT re-apply page geometry — a
  scroll→page relayout kept the 100000-unit scroll page and produced 2 pages
  instead of 37, and a zoom relayout returned in 0 ms (silent no-op; the crisp
  preset's `unit` change likely not re-applied either). `loadData` is the only
  reliable relayout. Zoom stays a full render; its real fix is T2.1 (fewer
  pages drawn) + T2.2/T2.3 (feedback). See lessons.md.

## Tier 2 — page virtualization + feedback (perceived-lag fix)

- [x] **T2.1 Draw only visible pages** (shipped 2026-08-29). `renderPage`
  (renderComposer path only — string-entry `render()` keeps the legacy
  all-pages DOM for old tooling) renders page 1, sizes fixed-dim placeholder
  `.score-page-pending` divs from its measured SVG box, synchronously mounts
  viewport±1-page placeholders + the cursor's page, and lazy-mounts the rest
  via IntersectionObserver (root #score, rootMargin 100 %). Page-scoped
  injections (header/footer, section headers, volta, crisp snap) moved from
  reRender into a renderer-owned `onPageMounted` hook — exactly once per
  mount (section-header translation is not idempotent). `ensureMeasureMounted`
  is a real page-mode implementation (measure id → `getPageWithElement` →
  mount), with a DOM-presence fast path so it never reloads the toolkit for
  an already-visible measure; call sites (scroll-into-view, cursor update,
  playback bars) already existed. `pageVirt.tkCurrent` tracks whether the live
  toolkit still holds the page layout (scroll engraves + PDF export steal it);
  a lazy mount reloads on demand (~1 s once, then cheap again). Virtualization
  state survives view-switch stash/restore (IO disconnected on stash, re-armed
  on restore). Measured (Chromium, sonata): page full render 4.5 s → **1.25 s**
  (loadData 1.0–1.2 s is now ~90 % of it), zoom 4.0 s → **1.35 s**, page
  restore 0.75 s → **0.43 s**, lazy mount ~40–70 ms/page, theme ~50 ms.
- [x] **T2.2 Busy badge + render coalescing** (shipped 2026-08-29, reshaped by
  T2.1): with lazy pages, the per-page loop shrank to ~2 pages, so the
  determinate "page 12/37" progress idea died — the dominant block is ONE
  unbreakable loadData. What shipped instead: `renderer.predictNextRenderHeavy`
  (mirrors renderScroll's splice test + recorded last-full-engrave durations,
  250 ms threshold — small docs and splices stay fully synchronous, fixtures
  unaffected); heavy renders defer via double-rAF + timeout so the static
  `#renderBusy` badge paints first; re-render requests arriving while one is
  queued/frozen coalesce into a single render of the latest model state
  (probe: 3 burst reRenders → 1 loadData) — the input-stacking fix; DOM-reading
  post-render actions route through `afterRender()`; file load/import handlers
  show the badge across their parse (the `await file.text()` yields the paint).
  The badge is deliberately unanimated: nothing animates while the engrave
  blocks the main thread — a spinner would freeze. That, plus unfreezing the
  UI entirely, is T2.3's territory.
- [ ] **T2.3 Worker-offloaded full engraves** (optional; the remaining ~1.2 s
  page-edit floor is loadData, unbreakable on the main thread). Second toolkit
  in a Web Worker for FULL engraves only (splice stays sync on main). Main
  thread interactive during file open / reflow; animated progress becomes
  possible. Biggest refactor of the tier: reRender goes async at full-render
  call sites (the afterRender queue from T2.2 is the ready seam).

**Known v1 virtualization limits** (revisit if they bite): a selection or
measure-mode overlay spanning unmounted pages draws only on mounted ones; a
click on a not-yet-mounted (visible for <1 frame) page resolves against the
nearest mounted glyph; a lazily-mounted page containing a section header grows
on mount (viewBox growth), shifting pages below it; scroll-mode full engrave
(~7 s) is untouched — its fix is T2.3/Phase C.

## Tier 3 — Phase C: system-splice cascade in page view (structural fix)

- [x] **T3.0 Line-break ownership (Phase C-A)** — SHIPPED 2026-08-30
  (`apps/composer/src/render/linebreaks.ts`): Composer owns the page-view
  system partition (naturals model + greedy/rebalance + render-time `<sb>`
  pins, displayed via breaks:'line' — verbatim systems, Verovio keeps
  pagination). Enablement pixel-exact; edits refill only the affected lines
  (bounded, deterministic reflow); everything unprovable derives loudly.
  NOT yet a latency win — the refill still pays a full loadData (~1.5 s
  Chromium / Firefox TBD, ± today's cost; refill overhead itself is
  ~150–400 ms). It is the structural prerequisite: every boundary is now a
  hard anchor, so C-B's windows are pixel-exact by construction and the
  cascade extent is known before any DOM work.
- [x] **T3.1 Contained system splice (Phase C-B v1)** — SHIPPED 2026-08-30
  (`apps/composer/src/render/pagesplice.ts`; full account in
  composer-page-splice-design.md "Implementation (Phase C-B v1)"). A refilled
  edit lands as a DOM splice of only the affected systems from a pin-anchored
  window render (synthetic leader + trailer, breaks:'line') — **no full-doc
  loadData**. Gated hard: splices only when the window's measured spacing
  chain proves nothing else on any page moves; context-line sanity + inline
  HKL_INDEX_CHECK reference parity enforce Max's no-visual-change gate.
  **Sonata: 7 of 8 battery edits splice at 380–673 ms wall (splice work
  ~160–190 ms) vs ~1.95 s for the one full render**; reference parity ≤ 4
  units document-wide on every edit; the single fallback is the
  section-header line (excluded by design). No-op renders skip DOM work
  entirely. (The 3/8 hit rate measured before conservative reflow was a
  side effect of re-derivation changing the line count — see the 2026-08-30
  reflow entry below.)
- [ ] **T3.2 Cascades + pagination ownership (Phase C-B2)** — dy-translate of
  following systems (the window MEASURES the new spacing, so dy is known),
  line-count-changing splices (replace N systems with M), page-boundary
  moves, `<pb>` pins + our height-fit rule so a full render agrees by
  construction (also fixes the user-`<pb>` giant-page quirk); re-splice k−1
  on courtesy-signature boundaries; section-zone windows (the k59/k87
  scoreDef family); first-edit hit rate via a keep-current-boundary fill
  bias (design item 1c, Max's call).

## Rejected / dead ends (don't retry)

- `display:none` on `#score` to skip layout flushes — forces from-scratch
  relayout on restore (~4× worse). See spot-splice doc, settled decision 9.
- Chunk virtualization of scroll view — superseded by the persistent-SVG +
  splice design (see composer-virtualization-handoff.md).
- Verovio `select`(measureRange) as a page-view window: layout of a selection
  re-breaks lines, so page boundaries wouldn't match the full document —
  unusable for a pixel-stable window. (Noted 2026-08-29; revisit only if
  Verovio gains layout-preserving selection.)

## Status log

- 2026-08-29 — doc created; baseline measured; Tier 1 in progress.
- 2026-08-29 — T1.1 + T1.2 shipped (theme in place ~0.5 s; view-switch
  restores ~0.7–0.8 s, both Chromium); T1.3 (redoLayout zoom) implemented,
  disproven by probe (wrong page geometry), reverted and marked dead end.
  Gates: typecheck / build / boundaries / `HKL_INDEX_CHECK=1 test:composer`
  328/328. Firefox pass confirmed theme + switches (~1 s).
- 2026-08-29 — T2.1 + T2.2 shipped (page virtualization + busy badge +
  render coalescing). Chromium sonata: page edit/full render 4.5 s → 1.25 s
  (loadData is ~90 % of the residual), zoom 1.35 s, page restore 0.43 s,
  theme 50 ms, 3-burst reRender → 1 engrave. Same gates, 328/328. Remaining
  floors: loadData ~1.2 s per page edit (T2.3 worker or Phase C), scroll full
  engrave ~7 s (Phase C). Awaiting Max's Firefox pass.
- 2026-08-29 — Phase C design drafted (composer-page-splice-design.md) with
  Max's amendments: reverse cascade via greedy refill (pull-back and spill are
  the same operation), gate = no visual change to cross-system actions vs a
  full re-engrave. Spike 1 run on the sonata: viable — range-serialize content
  byte-perfect, boundary-crossing spanners identified as the sole fidelity
  killer, previous-system-context window + left escalation is the fix to
  validate; ~125 ms per window engrave.
- 2026-08-30 — Phase C spike 2 complete (see composer-page-splice-design.md):
  87 % of boundaries splice at ~180 ms via window escalation; hard-break-
  anchored windows are pixel-exact; design pivots to encoded-<sb> partition
  pinning (spike 3). Shipped en route: boundary scoreDefs render inline in
  serializeRangeForRender (fidelity fix, also scroll-splice relevant).
- 2026-08-30 — **Page-view edits no longer shift scroll**: the T2.1 virtualized
  rebuild's zero-height placeholders + mid-swap layout clamped #score.scrollTop
  to ~page 1 on EVERY page edit (probe: 25392 → 2744, content-identical), with
  the afterRender scroll-into-view yanking it back — visible as jump-then-
  correct once C-A made edits surgical. renderPage now captures/restores the
  scroll in the same synchronous block (fixture pageEditPreservesScroll).
  En route: composer-test visual capture reworked (viewport-fit raster,
  stable-frame settle, compact vs visualFullPage framing, capture meta in
  summary.json), all baselines re-seeded — see decisions.md same date.
- 2026-08-30 — **T3.0 line-break ownership shipped** (spikes 3+5 validated →
  implemented same day; full account in composer-page-splice-design.md
  "Implementation"). Key discovery en route: Verovio breaks:'line' honors
  every <sb> VERBATIM while auto-paginating — the display mode that makes
  partition ownership possible WITHOUT owning pagination (smartSb0 display
  refuted by probe: castoff re-wraps refilled lines). 334/334 with
  HKL_INDEX_CHECK, 3 new fixtures; enablement pixel-exact; awaiting Max's
  Firefox feel-check of the edit-reflow semantics.
- 2026-08-29 — Firefox pass: virtualization works, page edits ~2–3 s (loadData
  dominated — Firefox's WASM/parse is slower than Chromium's; T3 is the fix,
  not micro-tuning). **Atomicity bug fixed**: T2.2's deferral exposed
  applyViewMode's eager CSS-class flip — the container restyled to the new
  mode's shape around the OLD mode's DOM for the whole engrave. The view-mode
  class now flips inside doReRender, in the same synchronous block as the
  content swap, so a deferred switch paints class + content atomically
  (probe-verified both directions). Rule for all future deferral work:
  **no user-visible state may change before the deferred render lands — every
  visible flip travels with the content swap.**
- 2026-08-30 — **T3.1 contained system splice shipped** (Phase C-B v1; full
  account in composer-page-splice-design.md). Page-view edits that pass the
  gates splice at ~400–630 ms wall on the sonata (Chromium) vs 1.6–3.1 s full
  renders — the first structural latency win from Phase C. Probes settled the
  mechanism (endings ride inside g.system; content-driven stacking, no
  vertical justification; pin-anchored windows pixel-exact); the battery
  found the end-of-score final-barline artifact (synthetic trailer) and the
  section-zone divergence (context-check refusal). Suite green under
  HKL_INDEX_CHECK with 3 new fixtures; awaiting Max's Firefox pass (the
  splice avoids loadData, where Firefox pays 2–3×, so the relative win
  should be larger there).
- 2026-08-30 — **Reflow made conservative** (Max's ruling; decisions.md same
  date). The page-view partition is no longer re-derived on an edit — it is
  carried across and only REPAIRED where a line left the legality envelope
  ([MIN_FILL 0.65, FIT_MAX 1.45], set to contain Verovio's own castoff range
  0.706–1.426). Fixes the reported drift (delete a note → the system gained a
  measure → undo left it there: threshold hysteresis inherent to greedy
  re-derivation) and, because most edits now leave the line count untouched,
  raises the C-B splice hit rate — the first edit in a region splices too.
  Sonata (real keystrokes): 4/4 edits and undos held the partition with zero
  moved lines, undo geometry bit-exact 3/4 (4th within 3 units of snap noise),
  spliced edits ~460–650 ms. Also closed a hole the probe exposed: a page
  mounted lazily AFTER a splice used to draw pre-edit content (pageVirt.stale
  → re-serialize + re-pin on the next mount, ~1.5 s once, off the hot path).
