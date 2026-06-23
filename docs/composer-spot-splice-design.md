# Composer rendering & model — spot-splice redesign

**The idea in one line:** Verovio is an excellent one-shot engraver and a terrible
live editor — it re-lays-out the whole document on every `loadData` and has no
incremental API. So we render the whole score **once** into a single persistent
SVG and thereafter use Verovio only as a **spot-change tool**: re-engrave a small
run of measures and splice the result into the live SVG, leaving every other
measure untouched. The model likewise maintains incrementally-invalidated derived
state so navigation/tick lookups are O(1)/O(log n) by construction.

This supersedes the chunk-virtualization approach in
[composer-virtualization-handoff.md](composer-virtualization-handoff.md) (kept as
an archive of what we learned). The chunk modules (`virtualize.ts`,
`chunk-render.ts`, `measure-index.ts`) are deleted.

## Status at a glance

| Phase | What | State |
|---|---|---|
| **A** | Model navigation index (O(1) nav/tick) | ✅ **done** |
| **B1** | Single persistent-SVG scroll render | ✅ **done** |
| **B2** | Spot-splice on edit (surgical re-render) | ✅ **done — shipped** (+ anchor/cascade correctness fix, see B2 below) |
| **B3** | Incremental edit pipeline (per-edit latency) | 🟡 **substantially done** — see below; remaining levers listed |
| **C** | Page view (cascade systems off the hot path) | later |

Everything is green: `pnpm test:composer` **312/312** + `HKL_INDEX_CHECK` (the
B3 work added two consistency gates — scoped-ties and dirty-range — plus the
`scrollWidthChangeCascadesRight` geometry fixture). A fresh thread continuing
performance work should read **Phase B3 → Remaining levers** at the bottom.

**Bottom line on latency:** a mid-score delete on the 446-bar sonata went from
multi-second → ~250 ms → **~150 ms** (Max's Firefox). It's at the usability
threshold; further wins are now diminishing (5–11 % items) and partly
browser-layout-bound (see "What we learned about the layout floor").

## The four invariants (design contract — still hold)

1. **One persistent SVG.** The whole score (scroll view = one horizontal system)
   is rendered once and lives in the DOM. Scrolling is native — no JS, no
   mounting. The initial full-render cost (~3.8 s for the 446-bar sonata, instant
   for normal scores) is paid **once**, not per interaction.
2. **Vertical layout is immutable.** The full render fixes the staff Y positions
   (Verovio's one consistent set of inter-staff gaps). Edits never change Y.
3. **Edits mutate X and swap content only.** An edit re-engraves the affected
   measure run, places its glyphs at the fixed staff Ys, and shifts following
   measures in X. Followers' internals never move.
4. **No auto full-render fallback, ever.** A full re-engrave (file open / explicit
   reflow / a zoom-theme-view change) is the ONLY full render. A full re-engrave
   hangs the app for seconds — never acceptable as a silent fallback. (An
   unspliceable edit logs loudly and full-renders — a visible bring-up net.)

---

## Phase A — model navigation index ✅ done

`apps/composer/src/model/voice-index.ts` builds a per-voice index (stops, tick
positions, measure indices, boundaries, measure-stop prefixes) in one O(n) pass,
cached and invalidated via `invalidateMeterCache()` — the choke point every
mutation reaches through `normalizePlaceholdersAll`. Hot nav/tick functions
(`getTickPositionAt`, `measureBoundaryCursors`, `getFlatStopInfo`,
`cursorMeasureIdx`, `getMeasureStartCursor`, `getFirstVisualCursorInMeasure`) read
it. `measureBoundaryCursors` went 46 s → ~0 ms; Ctrl-arrow 46 s → ~31 ms.

- Test-mode consistency gate: `globalThis.__HKL_INDEX_CHECK` (env
  `HKL_INDEX_CHECK=1` in the runner) rebuilds and compares every index against the
  original per-query computation — **keep using this pattern after any model
  change** (B3 will lean on it heavily).
- `flatChildren` is deliberately **not** cached — mutation code reads it
  mid-operation, before invalidation; caching corrupts ties/beams/inserts.

---

## Phase B1 — single persistent-SVG scroll render ✅ done

`Renderer.renderSingleSystem()` engraves the whole score as one `breaks:'none'`
system into `#score` (bare SVG, styled by `#score.view-scroll svg`).
`postProcessRendered()` (crisp pinning, notehead z-order, HEJI glyph injection,
theming) is shared by page + scroll.

- `pageWidth`/`pageHeight` pinned to Verovio's maxima (100000 / 60000 MEI units —
  these are MEI units, not output px; the sonata's one system is ~190k px wide and
  renders fine). Known limit: ~500 bars at 100% zoom before content exceeds the
  budget and wraps.
- Page + scroll share ONE toolkit, so every per-mode option must be set EXPLICITLY
  each render (`setOptions` persists unspecified options).
- The nav `onChange → onCursorMove` fixes in `input.ts` (Ctrl-arrow bar-jump,
  expr/pedal/tempo mark-jump, Shift-arrow selection) removed a redundant reRender
  on pure navigation.

---

## Phase B2 — spot-splice on edit ✅ done (shipped)

Shipped in **`apps/composer/src/render/splice.ts`** (`ScrollSplicer`), wired
through `render.ts` (`renderComposer`/`renderScroll`) and `main.ts` (`reRender`).

### What happens on a render

`main.ts reRender()` → `renderer.renderComposer(model, viewStaves)`:
- **Page view** → full `serialize` + multi-page render (unchanged legacy path).
- **Scroll, full re-engrave** (file open / reflow / zoom-theme-view change, via
  `forceFullRerender()`; also single-part view) → `renderSingleSystem` +
  `splicer.capture()`, which records the per-measure index, measures the
  inter-staff gaps, and calibrates the `stem.len → gap` law.
- **Scroll, edit** → `splicer.splice(model, …)`: surgical, O(edited-range).

### The splice (per edit)

1. **Diff** the model's LIVE doc per-measure signatures (common prefix + suffix by
   id + serialized content) → the changed run `[lo..hi]`.
2. **Expand** the run outward until no spanner (tie/slur/hairpin/…) crosses an
   endpoint, so whole spanners re-render together (`expandForSpanners`).
3. **Sub-MEI** = `model.serializeRangeForRender(cLo, cHi, …)` (head scoreDef with
   running clef/key/meter folded in as of `lo`, interior scoreDefs preserved,
   transforms run over only the range) **+ one synthetic spacer measure**.
4. **Render** the sub-MEI on a **dedicated `spliceTk` toolkit** (never the live
   one — sharing it pollutes the score's toolkit state), `postProcess` it.
5. **Splice the DOM:** replace the changed `g.measure`s by `xml:id`; one
   `translate(dx, dy)` anchored on an UNCHANGED context measure; merge glyph
   `<defs>` by SMuFL codepoint. The anchor is the **LEFT** context measure
   (`lo-1`), so the edited run stays joined to its unchanged left neighbour and
   the width change cascades RIGHTWARD. Use **2 left-context** measures so the
   anchor isn't the sub's system-first measure (which carries a spurious leading
   clef → wrong width/x). `dy` must add the anchor's `ty` just as `dx` adds its
   `tx` — `getBBox()` excludes the element's own transform. (See the B2
   correctness fix below — this corrects an earlier right-anchor bug.)
6. **X-cascade:** shift every following persistent measure by `Δ`. Old + new runs
   must expand symmetrically (`oldHi = hiNew + countDelta`) or measures duplicate.

### The vertical problem and the synthetic-spacer solution

A re-engraved sub-range has identical x + within-staff content but **different
inter-staff gaps** — Verovio sizes each gap to that *system's* max inter-staff
content, and a sub-range lacks the measures driving the full system's gaps. There
is no per-staff spacing control (`spacingStaff` etc. are global + range-limited).

**Solution (shipped):** append ONE **synthetic spacer measure** to the sub-render
that forces each inter-staff gap to the full render's exact px value, then discard
it (never spliced). The mechanism is **`stem.len` on a stemmed note** — linear,
fractional, floored at the min gap, so `gap = slope·stem.len + intercept` inverts
to any px target; calibrated once per full render (2 offscreen renders). Each
staff gets a LOCAL forced treble clef (confined to the discarded measure) so the
control note sits on one fixed line regardless of the real clef, and its down-stem
protrudes only below its staff. With gaps reproduced, the edited measures align
with a single `dy`; cross-staff spanners are correct by construction.

> **This replaced the original plan's "propper-finding"** (find the real measures
> that drive each gap). The spike disproved it — bbox clearance ignores horizontal
> collision, and even an x-aware sweep mispredicts Verovio (barlines/braces/
> cross-staff stems span the gap). See the Appendix and decisions.md.

### B2 correctness fix — anchor LEFT, cascade RIGHT (2026-06)

The original splice anchored on the **right** context when a measure followed the
run. That made the right-context measure *both* the anchor *and* the cascade's
shift reference, so `delta` computed to exactly **0** — the cascade never fired.
The run's right edge got pinned to the unmoved right neighbour and its **left**
edge floated, so any width-changing edit (delete/insert) opened a gap or overlap
with the **left** neighbour and nothing after the edit moved. Plus `dy` omitted
the anchor's `ty` (while `dx` added `tx`), giving vertical misalignment when
editing next to a previously-spliced measure (nonzero `ty`, which arises when the
sub-render baseline differs from the full render — varied vertical content).

Fix: anchor on the **left** context (`anchorIdx = lo>0 ? lo-1 : 0`, `leftCtx =
min(2, lo)`) and add `ty` to `dy`. The correct splice therefore performs an
**O(trailing-measures)** cascade (one `transform` write per following measure) on
every width-changing edit — cheap (writes, not layout), but see the C-phase note
on group-translating the trailing measures if it ever bites.

### Where the details live

- **decisions.md:** synthetic-spacer (`stem.len`) approach; dedicated `spliceTk`;
  serialize-only-the-edited-range.
- **lessons.md:** glyph defs are `<g id>` not `<symbol>` (merge by codepoint);
  cursor-overlay cleanup (a splice doesn't reset `#score.innerHTML`);
  `normalizePlaceholders` must be idempotent (id churn defeats the diff);
  `normalizeTies` O(n²) prunes; splice run-symmetry (expand old + new runs
  together or measures duplicate); **anchor LEFT + `dy` adds `ty`** (the
  correctness fix above); **`display:none` on the persistent SVG backfires**
  (full relayout on restore — see B3).
- **Guard fixtures:** `scrollEditSplicesNotFullRender` (a scroll edit splices —
  persistent SVG root reused — not full-re-engraves); **`scrollWidthChangeCascadesRight`**
  (a width-changing mid-score edit splices to the SAME measure x/y as a full
  re-engrave — caught the right-anchor bug at 1260 px).
- **Throwaway measurement harness:** `test/composer-inspect/spike-b2.mjs`.

### B2 acceptance (met)

Single-note / insert / delete edit on the sonata splices (no full re-engrave),
pixel-identical to a full render for the edited measures (incl. cross-staff
spanners AND measure x/y after width changes); file open / reflow / view-setting
change are the only full renders.

---

## Phase B3 — incremental edit pipeline 🟡 substantially done

The **per-edit latency** follow-up to B2. Editing the 446-bar sonata went
multi-second → ~2.7 s → ~400 ms (B2 fixes) → **~150 ms** (B3, Max's Firefox).

### How to profile this (don't use a synthetic score)

A synthetic doc (`appendMeasure` + sparse inserts, ~1300 notes, empty bars)
splices in ~30 ms and **does not reproduce** the cost. The real sonata is
**9099 notes / 446 bars / 918 slurs**. Load it headless and drive edits:
- `~/Documents/sonataBr1.musicxml` → `window.__composerImportMusicXml(xmlText)`
  (test hook in `main.ts`) → set scroll view → `reRender()`.
- `model.setCursor(flatIndex, voice)` takes a FLAT index; edit position matters
  (mid-score flat ~120+ is the slow path; measure 0 / degenerate bars mislead).
- Drive `deleteAtCursor` / `insertChordAtCursor`, time `reRender`. **Drive
  through the input layer (keystrokes) to include `withHistory`** — calling the
  model directly skips snapshotState.
- **Chromium under-reports the layout costs** (`getScreenCTM`/`getBBox` flushes)
  that dominate in Firefox — it lays the 190k-px SVG out cheaply. Profile JS
  passes in Chromium; confirm layout-bound items (`snapBarlines`, `renderToSVG`)
  in Firefox. (Working throwaway harnesses lived in the session scratchpad.)

### What landed (each gated; testing after each)

The model now tracks a **dirty-measure range** (`ComposerModel.renderDirty`,
`'all' | {lo,hi}`). Safe-by-default: `invalidateMeterCache()` (reached by every
structural mutation) resets it to `'all'`; a converted mutation NARROWS it via
`markDirtyMeasures` / `markEditAround(mi)` AFTER its final
`normalizePlaceholdersAll()`. An unconverted path stays `'all'` → full behaviour.
A missing/too-tight mark can only over-render, never corrupt.

1. **Diff** — the splice reuses last render's cached per-measure sigs outside the
   dirty window instead of re-serializing all measures. *Win: ~1 ms — the diff was
   never the bottleneck.* Test-gate (`HKL_INDEX_CHECK`) rebuilds the full sig map
   and throws if the range was too tight.
2. **`normalizeTies` scoped** (the doc's "riskiest piece") — re-realize ties only
   in dirty±1 measures per voice (`realizeScoped` + a **ranged** `tieEventSequence`
   so it doesn't even walk all measures), seeding `prevOffers` from the existing
   realized `@tie` on the event before the window. Bulletproof gate: in test mode
   it runs the full rebuild after and asserts byte-equality, leaving the doc in the
   full-correct state regardless. The two prunes now share ONE id-set; inserts skip
   prunes (can't orphan). **~45–85 ms → ~10 ms.**
3. **`clampCursors` single-voice** — it called `getVoiceLength` (uncached
   `flatChildren`, O(total)) for ALL voices every edit; a single-voice content edit
   only changes one voice's length. **~32 ms → ~7 ms.** (This emerged as the
   biggest mutation cost once ties were scoped — bigger than ties.)
4. **`snapshotState` BEFORE-MEI reuse** — `withHistory` serialized the whole doc
   TWICE per edit (before+after). `HistoryManager.committedMei()` returns the last
   push's AFTER-MEI (= the live doc between edits); `snapshotStateReusing` reuses it
   for the BEFORE, serializing once. Test-gate asserts the reused MEI matches the
   live doc (catches any mutation bypassing `history.push`). **~13 ms/edit saved.**
5. **`snapBarlines` / `snapStaffLinesToGrid` thrash** — split read-all-then-write-all
   (was `getScreenCTM`→`setAttribute` per element, N forced layouts → 1). Behaviour-
   identical (312 visual baselines unchanged).

Converted mutations: `insertChordAtCursor`, `insertRestAtCursor`, `deleteAtCursor`
(its count-preserving branches; measure-deletion stays full/unscoped).
`replaceChordAtCursor` and most others are NOT converted — they stay `'all'`
(correct, full diff), available as the next conversion if needed.

### What we learned about the layout floor

- **`normalizePlaceholdersAll` is already cheap (~3.6 ms)** — the B2 idempotency
  fix did it; scoping it (the doc's original step 3) is NOT worth it.
- **`expandForSpanners` is ~10–15 ms**, not the predicted bottleneck; the
  maintained note→measure index (original step 4) is deferred.
- **`getScreenCTM` (snapBarlines) ~16–19 % in Firefox is the layout floor.** It
  forces a flush that re-lays-out the giant persistent SVG. **Dead end recorded:**
  `display:none`-ing the persistent SVG during `postProcess` to skip the flush
  *ballooned* the delete to ~600 ms — toggling `display` forces a from-scratch
  relayout on restore. `contain: layout` / `layout paint` on `#score` showed no
  Firefox improvement. See lessons.md.

### Remaining levers (Firefox breakdown of the ~150 ms delete)

All small and roughly co-equal now — diminishing returns; the engine is at the
usability threshold. In rough priority:

- **`renderToSVG` ~11 %** — Verovio sub-render; largely inherent (could shave by
  rendering fewer context measures, but risk/benefit is poor).
- **`snapshotState` (the AFTER) ~6 %** — one full-doc serialize/edit; the floor for
  full-snapshot undo. Incremental/diff-based undo would remove it (big change).
- **`normalizePlaceholdersAll` ~5 %** — scopable to the dirty range (reuses the B3
  range + a consistency gate), but it's only ~5 %.
- **`normalizeTies` residual ~5 %** — the O(total) prune id-set on deletes; scope it
  with a maintained `anchorId → spanner` reverse index (also enables step-4 above).
- **`renderVoiceCursor` ~4.5 %** (`composerOnStateChange`) — repeated
  `querySelectorAll('measure')` per cursor update; cache the measure list.
- **`getScreenCTM` ~16–19 %** — the layout floor; needs Firefox-side
  experimentation, not blind changes (see dead end above). The structural fix is
  Phase C territory (don't keep one 190k-px SVG in the layout tree).
- **B2 cascade is O(trailing-measures)** (one `transform` write per following
  measure on width-changing edits — cheap now). If it bites: wrap trailing
  measures in a single `<g>` and translate the group once (O(1)).

**Risk note for any further scoping:** the dirty-range pattern touches core model
invariants. Always gate a scoped pass with an `HKL_INDEX_CHECK`-style "scoped ==
full rebuild" assertion (as `normalizeTies` does) + `test:composer`.

---

## Phase C — page view (later)

Page view keeps the current full-render path until this phase. The innovation:
own line-breaking over the measure-width index, and on insert **cascade one system
at a time off the hot path** (reflow the affected system synchronously, push
overflow to the next system, continue asynchronously) rather than re-engraving the
document. Out of scope for current work.

---

## Settled decisions

1. **Vertical conform = synthetic spacer measure** (`stem.len`-driven) — NOT
   propper-finding, NOT post-render per-staff translate, NOT fixed global spacing.
2. **Dirty detection = live-doc per-measure signature diff** (common prefix/suffix
   by id + serialized content), now FED by a model-tracked dirty range (B3) that
   lets the diff reuse cached sigs outside the edited window.
3. **No auto full-render fallback**, ever. Full render = file open / explicit
   reflow / zoom-theme-view change only.
4. **Splice runs on a dedicated `spliceTk` toolkit**; splicing is gated to
   all-parts view (single-part view full-renders — the gap calibration assumes the
   full staff set).
5. `pageWidth`/`pageHeight` pinned to Verovio maxima (100000 / 60000); ~500-bar
   single-system ceiling accepted for now.
6. **Splice anchors on the LEFT context; `dy` adds the anchor's `ty`** (B2
   correctness fix). Anchoring right pinned the wrong edge and zeroed the cascade.
7. **B3 scoping is safe-by-default + gated:** `invalidateMeterCache` resets the
   dirty range to `'all'`; converted mutations narrow it; every scoped pass has an
   `HKL_INDEX_CHECK` "scoped == full rebuild" assertion. Unconverted paths stay
   full and correct.
8. **`snapshotState` reuses the prior commit's MEI** for `withHistory`'s BEFORE
   (one serialize/edit, not two); funnels through `history.push` for cache
   maintenance; gated against staleness.
9. **`display:none` to skip layout flushes is forbidden** — it forces a full
   relayout on restore (made a delete 4× worse). Layout isolation, if revisited,
   must be a non-toggled `contain` and verified in Firefox.

## Appendix — superseded B2 plan (propper-finding)

The original B2 plan reproduced the inter-staff gaps by **finding the real
measures that prop each gap** (`argmin_m clearance(m)` from the full render's DOM)
and including them as spacers in each sub-render. The spike disproved it:
whole-measure bbox clearance ignores horizontal position (two notes can overlap in
Y but sit at different beats), and even an x-aware collision sweep mispredicts
Verovio because barlines/braces span the gap and cross-staff stems cross the
midpoint. A render-based finder (solo-render each measure, argmax gap) was correct
but ~5–18 s. The synthetic-spacer approach (above) computes the gap-forcing
content by formula instead — zero render-time search. Kept here only so the
reasoning isn't re-discovered.
