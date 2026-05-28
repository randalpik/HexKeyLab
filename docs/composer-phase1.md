# Composer Phase 1 — Quick wins + the P1 articulation

> Phase 1 of the multi-phase Composer push. Umbrella plan: `docs/composer-roadmap.md`.
>
> **Status: implementation pass complete (2026-05-28).** All 12 items shipped, 34 new fixtures, full suite 179/179, `pnpm typecheck` + `pnpm -r build` + `pnpm check:boundaries` clean. Awaiting Max's smoke test.

## Context

Phase 1 delivers the P1 active blocker (articulations S/A/T/F/B) plus 11 additional items that build directly on existing Composer patterns. The common thread: each item is an attribute-level MEI addition, a single MEI element type, or a small input.ts dispatcher rule — no new infrastructure required.

The architectural primitives this phase relies on already exist:
- **Note-attached pattern** (`apps/composer/src/slurs.ts`): xml:id binding via `@startid`/`@endid`, dangling cleanup hook, `data-voice` annotation. Reused for articulations (as note children) and beam-break/stem-direction overrides (as attributes on notes).
- **Anchor rule** for plain-letter ops (`apps/composer/src/input.ts:1491–1503`): INS mode → cursor−1 (just-entered element), OVR mode → cursor element. Factor into a shared helper this phase.
- **Display visibility pass** (`apps/composer/src/notation/accidentals.ts`): post-render Verovio-clone mutation. Parenthetical cautionary builds on this.
- **Auto-beam regroup** (`apps/composer/src/notation/beams.ts`): per-beat grouping with idempotent re-wrap. Beam-break override is an early-exit condition for `regroupBeams()`.
- **Measure rebuild** (`model.setTimeSig()` path): full measure restructuring with rest-fill. Insert-measure reuses this primitive.

Resolved design questions (Max, 2026-05-28):
- **Stem/slur direction overrides** — 2-state flip; "frozen" if the result is opposite the natural default, "unfrozen" (follows layout) if it matches.
- **Articulation anchoring** — follows the dynamics rule (INS → cursor−1, OVR → cursor).

## Items in this phase (12)

Listed in recommended implementation order — cheapest first to build velocity. Each item is self-contained and ships individually.

### 1. [COMPLETED] Double bar line `]`
- **Key**: plain `]` in voice mode.
- **MEI**: `@right="dbl"` on the current measure's `<measure>` element. Toggle off → omit attribute (default = `single`).
- **Files**: `input.ts`, `save.ts` (where measures are serialized — currently writes single bar lines implicitly).
- **Anchor**: current measure (the one containing the cursor).
- **Fixture**: cursor in a measure, press `]`, verify `@right="dbl"` and rendered double bar. Press again → toggle off.

### 2. [COMPLETED] Hide rest `H`
- **Key**: plain `H` in voice mode.
- **MEI**: `@visible="false"` on the current `<rest>`. Verovio honors this natively.
- **Anchor**: standard plain-letter rule (cursor−1 in INS, cursor in OVR). No-op on non-rest elements.
- **Files**: `input.ts`.
- **Fixture**: insert a rest, press `H`, verify rest disappears in render but model still has the element. Toggle off → reappears.

### 3. [COMPLETED] Parenthetical cautionary accidental `P`
- **Key**: plain `P` in voice mode.
- **MEI**: `@enclose="paren"` on the `<accid>` child of the current note (or on a synthetic `<accid>` if the note didn't have one — paren-cautionary semantics). On a chord, applies to all at once, or a single note if in alt-selection mode.
- **Display pass**: `notation/accidentals.ts` already chooses which accid to render; the paren flag is data and Verovio draws the parens.
- **Files**: `input.ts`, `notation/accidentals.ts` (verify visibility-pass honors `@enclose`).
- **Fixture**: note in a context where accidental is normally suppressed, press `P`, verify paren-wrapped accid renders.

### 4. [COMPLETED] Ctrl+arrows during playback / arrow-exit-to-cursor
- **Behavior change**:
  - `Ctrl+←/→` during playback: jump cursor by measure WITHOUT stopping playback. Playback continues from the new cursor position.
  - Plain `←/→` during playback: stop playback, leave cursor where the playback head currently is (NOT reset to pre-playback position).
- **Implication**: playback module must expose "current playback meiId / measure index" to the input handler.
- **Files**: `input.ts` (playback-key branch around `:1552`), `main.ts` (playback state — `isPlayingPosition` or similar).
- **Fixture**: start playback, press Ctrl+→ to advance, verify cursor moved and playback continued from new position. Separate fixture: press plain → mid-playback, verify cursor lands at playback head and playback stopped.

### 5. [COMPLETED] Click on/near a note to move cursor
- **Approach**: listener on `#score svg` for `click` events. Hit-test `<g class="note">` rectangles with ~8px padding (so "near" works for sparse layouts). Resolve to `(voice, slotIndex)`, set cursor + switch voice mode.
- **Gating**: plain click only (no modifiers); existing zoom/selection drag handlers untouched.
- **Files**: new `apps/composer/src/click.ts` (or augment `render.ts`), `main.ts` wiring.
- **Fixture**: `test/composer-inspect/` style — dispatch a click event at a known note's bbox, verify cursor moves to that note and voice changes.

### 6. [COMPLETED] Insert measure `Ctrl+M`
- **Key**: `Ctrl+M` in voice mode.
- **Behavior**: inserts an empty measure at the NEXT measure boundary after the cursor (or AT the cursor if it's already on a boundary). New measure uses current key/time sig, autofilled with rests.
- **Approach**: new model op `model.insertMeasureAt(beforeMeasureIdx)`; reuses the existing measure-rebuild path.
- **Cursor**: lands at the start of the new measure.
- **Files**: `model/index.ts`, `input.ts`.
- **Fixture**: insert at various positions (start of measure 2, mid-measure 3, end of last measure), verify measure count, cursor position, rest-fill.

### 7. [COMPLETED] Cross-staff slurs `?` spike (cross-cutting)
- **Goal**: confirm Verovio renders a `<slur>` with endpoints on different staves (e.g. voice 1 → voice 3) acceptably.
- **Approach**: hand-crafted MEI fixture; visual screenshot via `test/composer-inspect/inspect.mjs --screenshot`. No code changes if Verovio handles it (slurs.ts is already xml:id-based and cross-staff-capable).
- **Outcome**:
  - If acceptable → remove `?` marker; document in `decisions.md` that cross-staff slurs work and require no special handling.
  - If unacceptable → document the Verovio limitation in `decisions.md`, close the `?` item with "not supported", note the workaround (separate slurs per staff if user wants).

### 8. [COMPLETED] Stem direction `L`, slur direction `Shift+L` (2-state flip with freeze)
- **Keys**: plain `L` (stem on current note/chord), `Shift+L` (curvedir on slur at cursor).
- **Approach**:
  - Each note/slur carries an optional `@stem.dir` / `@curvedir` plus a sentinel data attribute `data-hkl-dir-frozen="true"` (or similar) marking user intent.
  - On flip: read current effective direction (from `@stem.dir` if frozen, else Verovio's natural choice). Compute the opposite. If the opposite equals the natural default → unfreeze (drop attribute + flag). Otherwise → set attribute to opposite and set frozen flag.
  - "Natural default" we approximate by stripping `@stem.dir` and reading the rendered stem direction once (one Verovio round-trip per flip — acceptable cost; alternatively, cache a precomputed natural-direction map per note).
  - Stem direction flip does NOT break beams; if L is pressed on a note that's within a beam, every other note in the beam must flip with it.
- **Files**: `input.ts`, `slurs.ts` (curvedir flip), `save.ts` (preserve attributes; they're already model state).
- **Fixture**: flip L on a note, verify `@stem.dir` set; flip again, verify attribute removed (back to natural). Same for Shift+L on a slur.

### 9. [COMPLETED] Beam split `/`
- **Key**: plain `/` in voice mode.
- **Approach**: each beamable element can carry `@hkl-beam-break="true"`. `regroupBeams()` splits its beat group at any such marker (treats it like a beat boundary).
- **Semantics**: `/` toggles the marker on the next element (cursor is between elements; "after this position, start a new beam"). On a non-beamable position (cursor on a rest, beat boundary, etc.) → no-op.
- **Files**: `input.ts`, `notation/beams.ts` (honor the override in `regroupBeams`/`splitIntoBeamableRuns`).
- **Fixture**: 8 eighth notes in 4/4 (auto-beamed 4+4), press `/` at the midpoint of the first group, verify split into 2+2+4 or whatever the rule produces.

### 10. [COMPLETED] Articulations `S/A/T/F/B` *(P1)*
- **Keys**: plain `S` (staccato), `A` (accent), `T` (tenuto), `F` (fermata), `B` (breath mark).
- **MEI**: `<artic @artic="stacc|accent|ten|fermata|breath">` as a child of the current `<note>`/`<chord>`. Breath mark is a sibling marker anchored to end-of-note (per Max's spec) — likely a `<breath>` element rather than `<artic>`, sibling of `<staff>` with `@tstamp` at the end of the anchor note.
- **Anchor**: standard plain-letter rule. No-op on rests EXCEPT `F` (fermata) which works on rests.
- **Playback effects** (in `render/playback.ts` velocity timeline):
  - Staccato: shorten by `STACCATO_FRACTION` (≈0.5 of duration).
  - Accent: boost velocity by `ACCENT_VELOCITY_DELTA` (≈+20).
  - Tenuto: extend to next onset minus `TENUTO_GAP_MS` (≈10ms) — full-value with no gap.
  - Fermata: extend by `FERMATA_HOLD_FRACTION` (≈+0.5) + small post-pause.
  - Breath: insert ~80ms gap before the next note.
- **Cleanup**: articulations as note CHILDREN don't need dangling-pruning (auto-removed when parent deletes). Breath as a sibling needs an entry in the dangling-cleanup hook (`normalizeTies` or sibling).
- **Files**: new `apps/composer/src/articulations.ts` (CRUD), `input.ts` (5 new keys), `render/playback.ts` (velocity + timing shaping), `notation/accidentals.ts`-style display pass if Verovio needs help rendering combined articulations (likely not needed).
- **Fixtures**: one per articulation type, verifying MEI structure, render, and playback shaping (compare velocity timeline against expected values).

### [COMPLETED] 11. Fill incomplete measures (document action)
- **Trigger**: button in setup modal. No keyboard shortcut for now (it's a one-shot doc-level action).
- **Approach**: iterate all measures; for each that's under-full, append rests of the longest fitting durations to reach time-sig length. Same primitive as autofill.
- **Files**: `model/index.ts` new op, toolbar wiring in `setupDialog.ts`.
- **Fixture**: doc with under-full measures, invoke action, verify all measures full.

### 12. Composer field + subtitle + watermark
- **MEI**: `<meiHead>/<titleStmt>` extended with `<title type="subtitle">`. Composer field already exists but *is not displayed on the score* - needs to appear right-justified between the title and the first system in page mode.
- **Watermark**: footer SVG `<text>` "Engraved with HKL Composer" injected at page-bottom position post-Verovio-render. The default text can be edited or removed in Setup. CSS-styled; non-selectable.
- **Setup dialog**: gains a "Subtitle" and "Footer" field.
- **Files**: `setupDialog.ts`, `save.ts` (`<meiHead>` write/read), `render.ts` (watermark injection).
- **Fixture**: save a doc with subtitle, reload, check persistence + render.

---

## Hotkey additions to `keybindings.ts`

Add a new "Note decorations" section and extend "Score structure & navigation":

**Note decorations (plain letters)**
- `S / A / T / F / B` — articulations (staccato/accent/tenuto/fermata/breath)
- `H` — hide rest
- `P` — toggle parenthetical cautionary accidental
- `L` — flip stem direction (2-state with freeze)
- `Shift+L` — flip slur curve direction (2-state with freeze)
- `/` — toggle beam break at cursor

**Score structure additions**
- `]` — toggle double bar line at end of current measure
- `Ctrl+M` — insert empty measure at next measure boundary

**Playback behavior (under Universal or new "Playback" section)**
- `Ctrl+←/→` during playback — jump cursor by measure without stopping
- `←/→` during playback — stop playback, leave cursor at playback head

Anchoring rule (document once at top of "Note decorations" section): plain-letter note/rest attributes anchor like dynamics — INS → cursor−1, OVR → cursor element.

---

## Critical files

- `apps/composer/src/input.ts` — every keystroke addition lands here
- `apps/composer/src/keybindings.ts` — documentation source of truth for the new keys
- `apps/composer/src/model/index.ts` — `insertMeasureAt`, `fillIncompleteMeasures` ops
- `apps/composer/src/notation/beams.ts` — beam-break override support
- `apps/composer/src/notation/accidentals.ts` — paren caut. display pass
- New: `apps/composer/src/articulations.ts` — articulation CRUD (CHILD of note, plus `<breath>` sibling)
- `apps/composer/src/slurs.ts` — `@curvedir` flip
- `apps/composer/src/save.ts` — `@right="dbl"` barline, `@visible`, `@stem.dir`, `<meiHead>` subtitle, footer SVG watermark
- `apps/composer/src/render/playback.ts` — articulation velocity/duration shaping
- `apps/composer/src/setupDialog.ts` — subtitle field
- `apps/composer/src/main.ts` — playback exposes current meiId for cursor handoff
- New: `apps/composer/src/click.ts` — DOM click handler for note hit-test
- `test/composer-test/fixtures.mjs` — ~14 new fixtures (one per item, plus per-articulation)

## Verification

Per CLAUDE.md, before declaring Phase 1 done:

1. `pnpm typecheck` (clean)
2. `pnpm -r build` (clean)
3. `pnpm check:boundaries` (DAG intact)
4. `pnpm test:composer` (full tier, with `pnpm dev` in another terminal) — all new fixtures pass; no regressions
5. **Manual verification**: open `pnpm dev`, exercise each new hotkey by hand, confirm visual + playback behavior. For articulations, check the playback velocity timeline (`window.__hkl_composer.lastPlaybackEvents` or via DevTools).
6. **Visual baselines** for: articulation rendering (one fixture per articulation), paren accid, hidden rest, double bar, stem-flip, slur-flip, beam-split, inserted measure, doc with subtitle/watermark. Cross-staff slurs spike produces a screenshot regardless of outcome.

## Out of scope for Phase 1

Explicitly deferred to later phases (see roadmap):
- Repeat signs `{` `}`, endings `Ctrl+E`, section headers, page break `Ctrl+B` (Phase 3 — they touch playback structure)
- 8va `Ctrl+8`, trills/tremolos `Ctrl+T` (Phase 3 — clean MEI element but more involved than the Phase 1 batch)
- String harmonic `Alt+H`, pizz/arco (Phase 5 — depend on multi-instrument)
- Expression layer additions (Phase 2)
- Mid-piece sigs/clef (Phase 4 — requires schema rewrite)
