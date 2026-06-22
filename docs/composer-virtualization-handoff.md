# Composer large-score rendering — virtualization handoff

Status as of this handoff: **work in progress, not committed.** Phase 0 (nav fix) and the Phase 2 scroll-mode renderer are implemented and the Composer test suite is green (305/305), but several scroll-mode correctness issues remain open (see Known issues). Read this before continuing.

## Why this exists (goals)

MusicXML import (just landed, committed) made it possible to load large external scores (the reference file is `~/Documents/sonataBr1.musicxml` — a 446-measure / 3-staff viola+piano sonata). Composer was **unusable** at that size: every cursor move, click, or edit froze the tab for ~4–7 s.

Measured cost on that file (page view, 36 pages, 8.2 MB of SVG):

| step | cost |
|---|---|
| `model.serialize` (HEJI/accidentals/beams) | 75 ms |
| Verovio `loadData` (lay out the whole doc) | ~1050 ms |
| `renderToSVG` × all 36 pages | ~1520 ms |
| `renderToSVG`, 1 page | 28 ms |
| **full `reRender()`** | **~3820 ms** |

**Goal:** make every cursor move, scroll, and edit **O(viewport)**, not O(total length), while keeping **behavior identical to the pre-virtualization renderer**. Parity is the bar — anything that renders or behaves differently from the old renderer is a bug, not a feature.

Two hard constraints from Max:
- **Scroll view stays a horizontal ribbon** (one continuous line, scrolled left↔right) — not wrapped-vertical.
- **No "render-once" interim** — a multi-second per-edit re-render is unacceptable in an editor.

## Approach (decided + validated)

Verovio re-lays-out the *whole* document on every `loadData` and has no incremental API. So we render the ribbon **a chunk of measures at a time** and mount only the chunks intersecting the viewport.

**The make-or-break question — proven in a spike (Max confirmed visually):** an interior run of measures, rendered as a standalone sub-MEI with `breaks:'none'`, is **width-identical** to the same measures inside the full ribbon (`dW = 0` for interior measures). So chunks can be rendered independently and stitched.

**Chunk mechanism (validated):**
1. Render a sub-MEI of `[dispLo−K .. dispHi+K]` (K = overlap measures) with `breaks:'none'` (natural, unjustified spacing). The chunk's `scoreDef` carries the **running** clef/key/meter as of `dispLo` (an interior chunk after a mid-piece change can't use the head scoreDef).
2. Pin vertical layout **content-independently** (`spacingStaff` fixed) so every chunk's staves sit at the same Y → chunks align across seams. (Per-chunk translate to a common staff-line Y is belt-and-suspenders.)
3. Keep the **whole `<svg>`** (its `<defs>` glyph symbols are required — extracting bare `<g>`s renders blank), positioned in a wrapper clipped (`overflow:hidden`) to the `[dispLo..dispHi]` x-range.
4. The overlap means a boundary spanner (tie/slur/hairpin) is drawn **fully in both** adjacent chunks; clipping each at the shared seam makes the halves meet seamlessly. The overlap also makes interior chunks' first measure not system-first (no spurious leading clef) and last measure not system-last.

## What's implemented

### Phase 0 — navigation no longer re-engraves (shipped, tested)
Plain Arrow/Home/End and click-to-position used to call a full `reRender()` (the 7 s freeze). They were calling both `hooks.onStateChange()` *and* `hooks.onChange()`.
- New `onCursorMove` hook in `InputHooks` ([input.ts](apps/composer/src/input.ts)); nav sites call it instead of `onStateChange()+onChange()`.
- `composerOnCursorMove()` in [main.ts](apps/composer/src/main.ts) = overlay update + scroll-into-view, **no reRender**; wired to the hook and to click ([click.ts](apps/composer/src/click.ts)).
- Result: arrow nav ~7000 ms → ~40 ms, no re-engrave. Fixture: `navDoesNotReRender`.

### Phase 2 — virtualized scroll renderer (implemented, suite green, issues open)
New modules under `apps/composer/src/render/`:
- **`chunk-render.ts`** — the chunk mechanism above. `renderChunk(opts)` → a positioned, clipped wrapper. Decoupled from the model (operates on the parsed MEI doc); computes running clef/key/meter by walking the section. Unit-testable.
- **`measure-index.ts`** — `MeasureIndex`: per-measure width + cumulative x, widths start as an **estimate** and are replaced when a chunk renders (lazy, no O(total) layout pass), with suffix reflow. Pure, unit-testable.
- **`virtualize.ts`** — `VirtualRibbon`: owns the scroll "canvas" (full-ribbon-width inner div), mounts only chunks intersecting `scrollLeft ± buffer`, renders lazily + caches, rAF-coalesced scroll handler, reflow + scroll anchoring. `ensureMeasureMounted(mi)` mounts the cursor's chunk; `measureBox`/`totalWidth`/`setOptions`/`destroy`.

Integration in **`render.ts`**: `render()` branches `scroll → renderScroll()` (page mode untouched). `renderScroll` (re)builds the `VirtualRibbon`. **Chunk rendering uses a dedicated Verovio toolkit instance** (`chunkTk`) — critical, because Verovio's `setOptions` *persists* unspecified options, so sharing the toolkit leaked `spacingStaff` into page renders.

Integration in **`main.ts`** `reRender()`: scroll mode skips page-only injections, sizes `#cursorOverlay` to the ribbon canvas, and `ensureMeasureMounted(cursor)` before `cursor.update`. `maybeScrollMeasureIntoView` and `composerOnStateChange` also ensure-mount the cursor's chunk. Click (`gatherCandidates`) now scans the whole container (all mounted chunk svgs), not a single `<svg>`.

**Integration bugs found + fixed:**
- `vr` not torn down on view-mode switch → leaked chunk-mounting into page mode. Fixed in `setViewMode`.
- `pageMarginTop:1200` exceeded Verovio's bounds → console errors. Removed.
- Shared-toolkit option leak (`spacingStaff` bleeding into page renders, 30+ spurious visual diffs). Fixed with the dedicated `chunkTk`.
- **Double cursor overlay** (the "two cursors" Max saw, and the cause of the `viewModeDropdownSwitch` cursor-trace failure): `vr.rebuild` only reset the container on first mount, so each render left the old `#cursorOverlay` and `main.ts` added another; the stale one held an old/fallback cursor. Fixed: `vr.rebuild` now makes the canvas the container's sole child every render.

## Known issues

### Issues 1–3 — RESOLVED (single root cause: a stray scroll-mode CSS margin)

Issues 1 (final barline invisible), 2 (past-end cursor invisible), and 3 (canvas
width undercount) were **one bug**, not three. Root cause: a legacy CSS rule from
the pre-virtualization scroll mode —

```css
#score.view-scroll svg:not(#cursorOverlay) { margin-left: 24px }
```

In the old scroll mode a single Verovio `<svg>` sat directly in `#score`, and the
24 px margin gave it left breathing room. In the virtualized renderer **every
chunk's `<svg>` is `position:absolute` inside its own `.hkl-chunk` wrapper**, with
`left` measured *offscreen* (the measuring `host` is appended to `document.body`,
so `#score`-scoped CSS does NOT apply during measurement). Once mounted, the rule
shifted each chunk's svg content **+24 px** relative to where the wrapper clip and
the `MeasureIndex` x put it. Consequences:
- the piece-end barline (rendered at the system's content edge) was pushed past
  the wrapper's `overflow:hidden` right edge → **clipped** (issue 1);
- the `pastEndRight` cursor (`rect(lastMeasure).right + 2·HPAD`) and the barline
  landed past the canvas/scroll extent → **unreachable** (issues 2 + 3).
- Issue 3's "barline undercount" was a **misdiagnosis**: the last measure's
  `g.measure` bbox already includes its end barline, so `MeasureIndex.totalWidth`
  was never short — the +24 shift was the whole story.

**This was fully reproducible headless** — drive a multi-measure doc into scroll
mode, `scrollLeft = scrollWidth`, screenshot. The earlier "headless can't see it"
claim (old issue 5) was wrong; the prior screenshots just weren't driven to the
piece end in scroll mode.

**Fix (committed in working tree):**
- Removed the per-svg `margin-left` rule ([apps/composer/index.html](apps/composer/index.html)).
- Moved the left breathing room onto the **ribbon canvas** instead, set in JS so
  the renderer owns it: `VirtualRibbon.leftMargin` → `canvas.style.marginLeft`
  ([virtualize.ts](apps/composer/src/render/virtualize.ts)); `SCROLL_LEFT_MARGIN = 24`
  in [render.ts](apps/composer/src/render/render.ts). Net visible score position is
  unchanged (still +24 in `#score`'s frame) — parity preserved — but the chunk
  clip is now correctly aligned, so the barline shows.
- Sized the cursor overlay (which also drives the scrollable extent) to span the
  full content frame: `scrollOverlayWidth() = leftMargin + totalWidth +
  SCROLL_PAST_END_PAD` ([render.ts](apps/composer/src/render/render.ts)),
  `SCROLL_PAST_END_PAD = 2·CURSOR_HPAD + CURSOR_WIDTH + 4`, so the past-end cursor
  is drawable and reachable. Wired in [main.ts](apps/composer/src/main.ts) `reRender`.

Verified: end barline visible, past-end cursor visible just past it, scroll
reaches both. Suite green (305/305).

### Still OPEN

4. **`spacingStaff` is too wide** (currently `SCROLL_STAFF_SPACING = 24` in `render.ts`) — Max noted the inter-staff gap looks extreme. It must stay ≥ the score's max inter-staff content extent to preserve vertical alignment across chunks, so tune it down carefully (ideally derive from the score's pitch range) rather than just lowering it.
5. **Edit latency not yet truly surgical.** An edit currently re-renders all *visible* chunks via `vr.rebuild` (O(viewport) render, but re-serializes + re-parses the whole model — O(total) for those steps). Acceptable interim; a true surgical per-edit single-chunk re-render is the optimization (roadmap).

### Note on headless verification

The earlier meta-warning ("trust live over headless") was an artifact of issues
1–3 not being reproduced correctly headless. `test/composer-inspect` screenshots
*do* reproduce scroll-mode piece-end visuals faithfully **when driven into the
right state** (scroll-mode class on `#score`, `scrollLeft` set to the end *after*
the final `reRender`, since `reRender` re-anchors scroll). Use a real screenshot +
`getBoundingClientRect` together; have Max confirm on anything subtle.

## Immediate roadmap

1. ~~**Fix issues 1–3** (piece-right edge: final barline + past-end cursor + canvas width).~~ **Done** — see "Issues 1–3 — RESOLVED" above (the stray `#score.view-scroll svg` margin).
2. **Phase 2e tests** — add to `test/composer-test`: a large-score fixture; a scroll-virtualization invariant (drive `#score.scrollLeft`, assert only viewport chunks mounted + scroll width matches index + console clean); visual identity at several scroll positions; rapid-scroll stress (random `scrollLeft` jumps); edit-latency benchmark (single-note edit re-engraves ≤ a few chunks, asserted via `performance.now()`).
3. **Tune `spacingStaff`** (issue 4).
4. **Surgical edit** (issue 6): re-render only the edited measure's chunk; shift downstream x.
5. **Phase 3 — page view on the same engine**: own line-breaking of the measure-width index into systems → pages (snap to system boundaries), virtualized identically; replaces the current double-`loadData` `layoutBreaks` path. Page mode currently still uses the **old full-render path** (untouched, works, but not virtualized — large scores in page view are still slow).

## How to work on it

- Run: `pnpm dev` (umbrella proxy on :5170). Composer at `http://localhost:5170/composer/`.
- Suite: `pnpm test:composer` (full tier, ~100 s). Gate also `pnpm typecheck` + `pnpm check:boundaries`. Page-mode fixtures cover the unchanged path; `viewModeDropdownSwitch`, `scrollIntoView_*`, and the `SCROLL` group exercise scroll mode.
- Headless inspection: `node test/composer-inspect/inspect.mjs '<expr>'` and `--screenshot <path>` (the dev server picks up edits via HMR). Useful but see issue 5.
- Perf measurement pattern: in-page, time `model.serialize()`, `tk.loadData()`, `tk.renderToSVG(p)`, and `reRender()` separately (this produced the table above).
- The Phase-1 spike (chunk-vs-full pixel comparison) was a throwaway harness in the session scratchpad; the mechanism it proved is now in `chunk-render.ts`.

## Files

- New: `apps/composer/src/render/{chunk-render,measure-index,virtualize}.ts`.
- Modified: `apps/composer/src/render/render.ts` (scroll branch, `chunkTk`, `setViewMode` teardown, `chunkOptions`/`postProcessChunk`/`renderScroll`/`ensureMeasureMounted`/`measureBox`/`ribbonWidth`/`scrollBandHeight`); `apps/composer/src/main.ts` (`onCursorMove`, `reRender` scroll branch, overlay sizing, `maybeScrollMeasureIntoView`); `apps/composer/src/input.ts` (`onCursorMove` hook + nav sites); `apps/composer/src/click.ts` (scan whole container); `test/composer-test/fixtures.mjs` (`navDoesNotReRender` fixture).
- Decisions/lessons worth recording once stable: the chunk mechanism, the dedicated-chunk-toolkit (Verovio setOptions persistence), and the double-overlay/`vr.rebuild` invariant.
