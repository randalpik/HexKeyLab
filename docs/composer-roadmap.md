# Composer feature roadmap — multi-phase plan

> **Status: working planning doc, not architecture.** Umbrella for the Composer feature push kicked off when Max bulk-added items to `backlog.md`. Updated as phases close.
>
> **Phase 1: ✅ shipped** (2026-05-28). 190/190 tests pass. See `docs/composer-phase1.md` for the historical detail; the inherited-by-Phase-2 surfaces are summarized below in **§ Phase 1 outcomes — what Phase 2 inherits**.
>
> **Phase 2: ✅ shipped** (2026-05-30). All four items (pedal layer, expressive-text modal + reusable shell, tempo modal + retiming + tempo layer, above/below placement) landed with fixtures; suite grew 190 → 207. The surfaces Phase 3 inherits are summarized in **§ Phase 2 outcomes — what Phase 3 inherits** below.
>
> **Phase 3: ✅ shipped** (2026-05-30). All items + post-review fixes landed with fixtures (suite 207 → 222): repeats + endings (`{`/`}`/`Ctrl+E`) with start-aware playback repeat-expansion composing with the tempo timeline; 8va (`Ctrl+8`, per-staff, q±3 playback shift); trills + tremolos (`Ctrl+R` — rebound off Ctrl+T which Firefox reserves) with alternating slur playback preserving the source notes' lattice cells; page break (`Ctrl+B`); and section headers (`Ctrl+Shift+H`) as a custom-injected centered movement title that displaces the system. Breaks render via `smart`+`breaksSmartSb:0` / two-pass bake so material after a break still auto-wraps. See **§ Phase 3 scaffold** for the as-built notes, **§ Phase 3 outcomes** for what Phase 4 inherits, and `decisions.md` (3 Phase-3 entries) for the non-obvious calls.
>
> **Phase 4: feature-complete (2026-05-31).** Shipped: the per-measure meter model prerequisite (suite 222 → 223), **4.1** the `Ctrl+Shift+S` time/key-sig modal (224), **4.2** mid-piece time + key signatures via in-section `<scoreDef>` overrides (225 — diff-aware so an unchanged submit writes nothing; per-measure accidental spelling; Setup's selects relegated to a button), and **4.3** mid-measure per-staff clef via inline `<clef>` (`Ctrl+Shift+C`, 228 — verified rendering a clef change mid-measure with subsequent notes re-positioned). The mid-piece-meter follow-ups are now **closed** (231): the expression-layer moment→tick mapping (`absoluteTickForMoment`) is per-measure (a tempo/dynamic/8va after a meter change anchors correctly), beaming is per-measure (6/8 beams 3+3), and MusicXML export emits per-measure `<key>`/`<time>`/clefs (best-effort, untested against external readers). See decisions.md ("Phase 4.1/4.2", "4.3", "prerequisite") and §10. **Phase 4 done — ready for Phase 5 (multi-instrument).**

## Context

Max added 28 Composer items to `backlog.md` (originally lines 98–125, now reordered into six implicit sub-categories by adjacency). Most introduce new keyboard shortcuts; many touch overlapping infrastructure (modal patterns, MEI expression layer, per-measure metadata, multi-instrument). This doc captures:

1. The hotkey consistency review across the proposed bindings vs the current set in `apps/composer/src/keybindings.ts`.
2. A sub-category breakdown of the COMPOSER block (now reflected in backlog ordering).
3. A phased prioritization, flagging the few hard architectural blockers.

This is an evaluation + roadmap, not a step-by-step implementation plan — each phase becomes its own focused plan when work starts.

The current keybinding source of truth is `apps/composer/src/keybindings.ts` (also rendered in the Help modal). Input dispatch is `apps/composer/src/input.ts`; modal infrastructure is `setupDialog.ts` + `helpDialog.ts` (native `<dialog>`, no shared abstraction yet). The MEI expression layer at `apps/composer/src/expressions.ts` already handles time-anchored `<dynam>` + `<hairpin>` (siblings of `<staff>` in their measure), which is the template most new expression types will follow.

Resolved questions (Max, 2026-05-28):
- **Shift+O for pedal lift** — confirmed (O = "off", ergonomically next to P).
- **Stem/slur direction overrides** — 2-state flip. Each press flips. If the resulting direction is opposite the natural default, the element is "frozen" until the next flip; if it matches the natural default, "unfrozen" (follows layout).
- **Articulation anchoring** — confirmed to follow the dynamics rule (INS → cursor−1, OVR → cursor).

---

## 1. Hotkey consistency review

### Conventions emerging from the proposals (good — keep)

The proposed bindings imply a clean four-tier convention. Worth making it explicit in `keybindings.ts` going forward:

| Tier | Pattern | What it does |
|------|---------|--------------|
| **Plain letter** | `S`, `A`, `T`, `F`, `B`, `H`, `P`, `L`, `/`, `]`, `{`, `}` | Direct one-shot toggle / attribute on the current note/rest/measure |
| **Shift+letter** | `Shift+1..8`, `Shift+P`, `Shift+O`, `Shift+L` | A "sibling" variant of the plain action (e.g. dynamics, alternate direction) |
| **Ctrl+letter** | `Ctrl+M`, `Ctrl+E`, `Ctrl+T`, `Ctrl+B`, `Ctrl+8` | Direct one-shot action operating at measure or structural scope |
| **Ctrl+Shift+letter** | `Ctrl+Shift+E`, `Ctrl+Shift+T`, `Ctrl+Shift+C`, `Ctrl+Shift+S` | Opens a configuration modal (anchor: current measure / current note) |

The modal-open tier (Ctrl+Shift+letter for text-entry / setup-like dialogs) is the most useful convention to lock in early — once `Ctrl+Shift+E` (expressive text) ships, the same pattern carries the tempo, clef, sig, and any future modal cleanly.

### Conflicts and tight collisions

None are blocking — modifier disambiguates everything — but a few deserve explicit thought:

1. **`T` is overloaded three ways**: plain T (tenuto), `Ctrl+T` (trill), `Ctrl+Shift+T` (tempo modal). Same letter, three actions, all "T-words." Should be tolerable in muscle memory.

2. **`L` clusters three line-like actions**: plain L (stem direction), `Shift+L` (slur direction), `Ctrl+L` (create/delete slur). Mnemonic "L = line direction" works for stem + slur direction; "Ctrl+L = create slur" is a different semantic but already shipped.

3. **`]` alone for double bar** is asymmetric vs `{` `}` for repeats. Mnemonic ("]" = "end of measure") works; `[` reserved for a future variant (e.g. thick final bar at end, or section-start mark).

4. **`Ctrl+B` for page break** collides with Firefox's bookmark shortcut. Composer already overrides several Ctrl- combos (Z/Y/C/X/V) via `preventDefault`, so this is fine technically.

5. **Plain `H` (hide rest) vs `Alt+H` (string harmonic)**: both visual-ish but applied to different surfaces (rest vs note). Once multi-instrument lands and strings are common, the second meaning becomes load-bearing.

### Anchoring rules to apply uniformly

Dynamics already have a precise anchor rule documented in `keybindings.ts`:

> in INS mode, the just-entered element (cursor−1); in OVR mode, the element at cursor.

All plain-letter note/rest attributes (articulations S/A/T/F/B, P, H, L, Shift+L, /) follow this same rule (confirmed). The existing dispatcher should be factored into a shared helper.

Time-attached items (expressive text, tempo, pedal) follow the existing expression-layer `@tstamp` anchoring (siblings of `<staff>`), which already survives nearby-note deletion per Max's stated preference (`feedback_expression_anchoring`).

### Recommended hotkey-table additions to `keybindings.ts`

Once these land, the Help modal should grow new sections in this order:

- **Note decorations** (plain letters): S/A/T/F/B/H/P/L/Shift+L/`/`
- **Score structure** (plain symbols + Ctrl-letters): `]`/`{`/`}`/`Ctrl+E`/`Ctrl+M`/`Ctrl+B`/`Ctrl+8`/`Ctrl+T`
- **Configuration modals** (Ctrl+Shift+letter): E (expressive text), T (tempo), C (clef), S (sig); also re-document Setup as the parent
- **Expression vertical placement**: `Ctrl+↑`/`Ctrl+↓`

---

## 2. Sub-categories (now reflected in backlog ordering)

The 28 items, grouped into six sub-categories. Backlog block already reordered so items in the same category are adjacent.

### A. Playback interaction (1 item)
- Ctrl+arrows during playback (cursor jump without stopping); plain arrows exit playback to cursor position rather than resetting.

### B. Score structure & navigation (8 items)
- Insert measure `Ctrl+M`
- Double bar line `]`
- Repeats + endings `{` `}` `Ctrl+E`
- Section headers in page view
- Page break `Ctrl+B`
- "Fill incomplete measures" document action
- Click on/near a note to move cursor
- Composer field + subtitle + watermark

### C. Note decorations (8 items, incl. cross-staff slurs spike)
- **Articulations** `S/A/T/F/B` *(P1)*
- Parenthetical cautionary accidentals `P`
- Hide rest `H`
- Beam split `/`, stem direction `L`, slur direction `Shift+L`
- 8va `Ctrl+8`
- Trills + tremolos `Ctrl+T`
- String harmonic `Alt+H`
- Cross-staff slurs `?` (spike)

### D. Expression layer (4 items)
- Expressive text modal `Ctrl+Shift+E`
- Above/below staff placement `Ctrl+↑/↓`
- Tempo layer + modal `Ctrl+Shift+T`
- Pedal layer `Shift+P/Shift+O`

### E. Mid-piece structural changes (3 items)
- Clef changes per-staff `Ctrl+Shift+C`
- Time/key sig modal `Ctrl+Shift+S`
- Switch time/key sig at measure boundaries

### F. Multi-instrument & specialization (4 items)
- Multi-instrument support — **architectural foundation for the rest of F**
- Pizz/arco toggle
- Single-part view + export
- Ignore color in setup

---

## 3. Prioritization (phased)

Five phases. Each ships independently and unblocks the next.

### Phase 1 — Quick wins + the P1 *(✅ shipped 2026-05-28; details in `docs/composer-phase1.md`)*

All 12 items shipped + ~15 follow-up fix rounds Max requested during smoke testing. Final state lives in code; tests gate at 190/190.

### Phase 2 — Expression layer expansion *(✅ shipped 2026-05-30; see § Phase 2 outcomes below)*

All four items shipped with fixtures (suite 190 → 207). Notable scope adjustments made with Max during the work:
- Pedal and tempo each became their **own navigable layer** in the cursor cycle (pedal after V4, tempo above V1) — not part of the per-staff expression layer. Tempo is score-global (the only annotation spanning all instruments) and has fixed placement.
- The pedal/tempo playback routing went deeper than "sustain-CC": HKL drives its damper engine from a pedal timeline (deferred note-offs), and tempo introduced a full piecewise-linear retiming (`tickMsAt`/trapezoidal `atMs`) — entirely Composer-side, no new bridge field for tempo.
- Above/below placement (`Ctrl+↑/↓`) applies to dynamics/hairpins/expressive-text only; **tempo + pedal excluded** (fixed placement). Works in both the expression layer and voice mode.

### Phase 3 — Score structure & playback structure *(ready to scaffold)*
Goal: repeats, endings, page layout, octave/trill extras.

- Repeats + endings `{` `}` `Ctrl+E` — biggest playback-builder change in the block
- Page break `Ctrl+B` + section headers — Verovio `<sb>`/`<pb>` controls + section header element
- 8va `Ctrl+8` — MEI `<octave>`
- Trills + tremolos `Ctrl+T` — `<trill>` + `<bTrem>`, with selection-mode tremolo logic

### Phase 4 — Mid-piece structural changes
Goal: the model schema rewrite for per-measure metadata.

- Time/key sig modal `Ctrl+Shift+S` (extract from Setup) — pure UI refactor first
- Switch time/key sig at measure boundaries — biggest model rewrite in the block
- Clef changes per-staff `Ctrl+Shift+C` (incl. tenor/alto/treble+8)

### Phase 5 — Multi-instrument & specialization
Goal: lift the 2-staff, 4-voice ceiling.

- Multi-instrument support — architectural prerequisite for the rest of this phase
- Single-part view + export — depends on multi-instrument
- Pizz/arco toggle — depends on multi-instrument + new HKL bridge concept
- String harmonic `Alt+H` — depends on multi-instrument + per-note timbre/pitch adjustment
- Ignore color in setup — independent; can land any time in this phase or earlier

---

## 4. Hard blockers & dependency notes

Only one chunk has true hard architectural blockers; the rest is sequencing.

- **Phase 4 (mid-piece sigs/clef) requires a model schema rewrite.** Current model assumes one global `<scoreDef>`; `setupDialog.ts` writes there directly. Per-measure changes touch: model API, playback retiming, MusicXML export, accidental carry-state across key changes, copy-paste semantics. Not a blocker on starting; *is* a blocker on doing it in a quick-win pass.

- **Phase 5 (multi-instrument) is the largest single architectural change.** Current 2-staff/4-voice hard-coding is in: model layer fixed structure, cursor voice cycle (1→2→expr→3→4), bridge protocol (single instrument owned by HKL), and HKL audio routing. Items "pizz/arco", "string harmonic", and "single-part export" all collapse if multi-instrument isn't first.

- **No Phase 1/2/3 item has a hard architectural blocker.**

- **Cross-staff slurs `?`** is the only `?`-marked item in the block. Verovio supports `@startid`/`@endid` across staves and current `slurs.ts` already uses xml:id binding — the question is rendering quality. One-afternoon spike answers it; folded into Phase 1.

- **Expression-layer `@tstamp` anchoring** (already shipped for dynamics + hairpins) is the right pattern for expressive text, tempo, and pedal. Slurs deliberately stayed note-attached (`@startid`/`@endid`) because their identity *is* their endpoints; articulations should also stay note-attached for the same reason.

---

## 5. Verification posture (every phase)

Per CLAUDE.md, the suite gating Composer changes:

- `pnpm typecheck` + `pnpm -r build` + `pnpm check:boundaries`
- `pnpm test:composer` (full tier, with `pnpm dev` running)
- Each new feature lands with a fixture in `test/composer-test/fixtures.mjs`
- Visual coverage via `visualBaseline:` for any rendering change

No new tooling needed for any phase except possibly Phase 5, where multi-instrument may need a fixture-suite expansion for instrument-aware scenarios.

---

## 6. Phase 1 outcomes — what Phase 2 inherits

Phase 1 left several infrastructure pieces in place that Phase 2 should reuse, not reinvent.

### Existing patterns to reuse

- **Note-attached articulation infrastructure** (`apps/composer/src/articulations.ts`). Two encodings live side-by-side:
  - `<artic @artic="…">` as a CHILD of `<note>` / `<chord>` (stacc, acc, ten).
  - `<fermata>` / `<breath>` as siblings of `<staff>` with `@data-hkl-anchor` pointing at the slot's xml:id (Verovio's @startid can't position a breath at end-of-note, so we use `@tstamp` + a custom anchor attr).
  - `pruneDanglingArticControls` runs inside `normalizeTies` to drop fermata/breath siblings whose anchor was deleted. Same hook for new sibling-encoded expressions.

- **Paren-cautionary + HEJI integration** (`apps/composer/src/notation/accidentals.ts` + `packages/notation/src/heji-render.ts`). The pipeline now:
  1. `computeAccidentalDisplay` writes `<accid accid="X" enclose="paren">` child for paren-caut notes (alter from `(q, r)`, not `@accid`).
  2. `transformDocForHeji` reads accid from child OR attribute, propagates `@enclose` to placeholder accids' outermost pair.
  3. `injectHejiGlyphs` identifies paren `<use>` by SMuFL codepoint (U+E26A / U+E26B), keeps only the outermost left + outermost right, swaps to BravuraText.

- **Playback session protocol** (`apps/composer/src/main.ts`). `pendingStopAcks` counter suppresses HKL's `playback-finished` ack when Composer itself initiated the stop, so seeks (= stop + resume) don't terminate the new session prematurely. `seekPlaybackByMeasure(dir)` and the `anyPlaybackHeadAtMeasureStart()` helper handle "Ctrl+← jumps to previous measure" when any voice's playhead is at a measure start.

- **Composer/footer post-render injection** (`injectHeaderFooter` in `main.ts`). Appends `<text class="hkl-injected-composer">` and `<text class="hkl-injected-footer">` into Verovio's `g.page-margin` group. The composer y is anchored to the first system's bbox.y (works whether or not a subtitle is present — Verovio shifts the system down for a subtitle automatically).

- **Click-to-position** (`apps/composer/src/click.ts`). DOM click handler on `#score` with `~8px` near-hit. Walks ancestors to find the OUTERMOST `g.chord` (or bare `g.note`/`g.rest`) and resolves to model element via `findElement`. Switches voice and parks cursor.

- **Beam-break override** (`apps/composer/src/notation/beams.ts`). `@hkl-beam-break` flips natural beam state per-element via XOR: mid-beat marker splits a beam; at-boundary marker joins one across beats. `findRunIncluding` uses the same logic for stem-direction-flip's beam group lookup.

- **Insert-measure with severing** (`model.insertMeasureAt`). Slurs straddling the insertion are pruned outright; ties demote to stubs via `normalizeTies`.

### Design conventions established

- **Plain-letter anchor rule**: in INS mode → cursor−1 (just-entered); in OVR → cursor element. Both resolve to `flat[c]` under the cursor convention. Applied uniformly across H/P/L/Shift+L/S/A/T/F/B/`/`. Use the same anchor in Phase 2 for `Shift+P`/`Shift+O` (pedal).

- **Modifier-tier convention** (locked in by Phase 1 hotkeys, ready for Phase 2 to follow):
  - Plain letter → one-shot toggle/attribute on the current element.
  - Shift+letter → "sibling" variant of the plain action OR a different element type.
  - Ctrl+letter → measure / structural-scope action.
  - Ctrl+Shift+letter → opens a configuration modal.

- **Roundtrip-friendly attribute placement**: model state lives on the doc (e.g. `@hkl-paren-caut`, `@hkl-beam-break`, `@stem.dir`, `@hkl-anchor` on sibling control events). `computeAccidentalDisplay` and `transformDocForHeji` work on the SERIALIZATION CLONE — the live doc stays clean. Test invariant: `serialize → load → serialize` must be byte-stable (modulo placeholder xml:ids).

- **Verovio coordinate trap**: `g.page-margin` carries `transform="translate(1400, 1400)"`. Anything injected into the inner SVG outside this group lands at the WRONG y. Always append into `g.page-margin` if you need to share coords with `g.pgHead` / `g.system`.

### Open Phase 1 cleanup

Nothing left from Phase 1 itself — but the **HEJI-cycle accidental cleanup** mentioned in Max's Phase 1 round wasn't a Phase 1 item and remains for whenever the user wants to address it. Not a Phase 2 blocker.

---

## 7. Phase 2 outcomes — what Phase 3 inherits

Phase 2 (pedal, expressive text, tempo, placement) left substantial infrastructure Phase 3 should reuse, not reinvent. All in `apps/composer/` unless noted.

### The layer pattern (NEW — the most reusable Phase 2 structure)

There are now **five cursor modes** (`CursorMode` in `src/input.ts`): `'voice' | 'expr' | 'pedal' | 'tempo' | 'select'`. The expression / pedal / tempo layers are "virtual voices" in the ↑/↓ cycle: **tempo (above V1) → 1 → 2 → expr → 3 → 4 → pedal**. Each non-voice layer is the same shape — copy it to add a new navigable layer:

- A `state.<x>Cursor: ExpressionCursor` (`{ index, moments }`) + `refresh<X>Cursor(model)`.
- A moment-list builder in `src/cursor/expressionCursor.ts` — `buildPedalMomentList` / `buildTempoMomentList` = `dedupSorted([...noteOnsetMoments(doc), ...<x>Moments(doc)])`. The shared snap helper is `cursorFromMoments(moments, prev)` (used by all three `rebuild*Cursor`).
- `cycleVoice()` (`src/input.ts`) handles entry/exit; expr+pedal are skipped when empty (`measureHasExpression` / `pedalMoments().length`), tempo is always reachable (a tempo always conceptually exists).
- Arrow nav (←/→/Home/End) + `Backspace`/`Delete` (per-layer `deleteSelected*`) branch on `cursorMode` in the keydown handler's nav block.
- Rendering in `src/cursor/cursor.ts`: a colored cursor bar + label + a `.<x>-selected` highlight class. Expr renders between staves; pedal below staff 2 (`computeBelowStaff2Y`); tempo above staff 1 (`computeAboveStaff1Y`). `CursorUpdateOpts` carries every layer's cursor; `main.ts` `cursorOpts()` passes them; `refreshIndicators` shows E/P/T.
- **Test-harness note:** `test/composer-test/lib/cursor-trace.mjs` coerces layer modes to `'voice'` and passes `<x>Cursor: null` — extend that coercion when adding a layer (else the trace's `cursor.update` dereferences a null cursor).

### Reusable modal shell (`src/ui/textEntryModal.ts`)

`openTextEntryModal({ title, fields, presets?, okLabel?, onOk })` — native `<dialog id="textEntryDialog">` (markup is an empty `<dialog>` in `index.html`, built dynamically). Field types: `text | number | check | select`. **OK = submit (Enter), Cancel = button, Escape = native cancel.** Model-agnostic: `onOk(values)` does all mutation + history. Used by expressive-text (inline in `input.ts`) and `tempoDialog.ts`. Phase 4's clef/sig modals should inherit it. Async caveat: `onOk` runs after the modal closes, so it manages its own `history.push` (can't be wrapped by the synchronous `withHistory` at the dispatch site).

### Time-anchored expression CRUD (`src/expressions.ts`)

`<dynam>` / `<hairpin>` / `<dir>` / `<tempo>` are all siblings of `<staff>`, `@tstamp`-anchored (survive nearby-note deletion — `feedback_expression_anchoring`). Helpers: `addDir`/`dirAt`/`dirText`/`dirIsItalic`/`setDirText`; `addTempo`/`tempoAt`/`readTempoEl`/`collectTempi`/`tempoMoments`. `<pedal>` CRUD is `src/pedal.ts`. The `data-hkl-*` attribute convention carries model state Verovio ignores (`data-hkl-gradual`, `data-hkl-mm-shown`, etc.).

### Playback timeline (`src/render/playback.ts`) — IMPORTANT for Phase 3 repeats

- **Tempo retiming**: `buildTempoTimeline(mei)` → `{ tickMsAt(tick), atMsAt(tick) }`. `tickMsAt` is piecewise-LINEAR in beat-period (instant tempo = step, gradual = linear ramp); `atMsAt` is the trapezoidal integral from tick 0. Gradual target resolution: explicit `@tstamp2` → next instant tempo's bpm → intensity-% (poco/plain/molto = 20/40/60, in `<hkl:config>` via `getGradualPercents`); "a tempo" restores the pre-gradual bpm. Gradual intensity is DERIVED from the mark text (`deriveGradualIntensity`), not stored. `buildPlayback` and `buildPedalEvents` both run on `atMsAt`; `playbackStartMs(model, startTicks)` gives the cursor-seek offset.
- **⚠️ Repeats will need to COMPOSE with this.** Today the timeline is a pure function of tick (`atMsAt(tick)` is monotonic). Repeats/voltas replay tick-spans, so a note's playback `atMs` is no longer `atMsAt(tick)` — it's the accumulated time over the *played order*, which visits some ticks more than once. Plan the repeat expansion as producing an ordered list of (tickSpan, repetition) and accumulate `atMs` by integrating `tickMsAt` over the played sequence. Velocity (`buildVelocityLookup`) and pedal lookups stay tick-based (a replayed note reuses the dynamics/pedal at its original tick), which is correct.
- **HKL driver hardening** (`apps/hkl/src/bridge/hkl-side.ts`): the lookahead driver's per-event scheduling is wrapped in try/catch (`logPlaybackError` + `playbackStateSnapshot`) so one bad event can't silently freeze the transport; the finish handler always sends `playback-finished` (finally). The pedal timeline drives the damper engine via deferred note-offs (`pedalCapturesNoteEndingAt` decides capture deterministically from the timeline at each note's WRITTEN end; glide degrades to overlap under the pedal). Bridge: `play-score` carries an optional `pedalEvents` array (`packages/bridge/src/protocol.ts`).

### Metronome / SMuFL-in-text (relevant for trills/tremolo/8va glyphs)

Verovio (6.2.0) does NOT render `@mm`/`@mm.unit` as a visible mark, and plain Unicode note chars (U+2669) render in the serif text font (ugly). The working encoding — confirmed by round-tripping a MusicXML metronome through `tk.getMEI()` — is a **SMuFL "Metronome marks" glyph as the content of `<rend glyph.auth="smufl">`**, which Verovio draws in the Leipzig music font: U+ECA3 half, U+ECA5 quarter, U+ECA7 eighth, U+ECB7 augmentation dot (see `mmGlyph` + `setTempoContent`). The same `<rend glyph.auth="smufl">{char}</rend>` pattern is the way to embed any SMuFL glyph in Verovio text. **Lesson:** for any "does Verovio render X" question, round-trip MusicXML→MEI via the toolkit to see the canonical form — don't assume attribute support.

### Placement gesture

`Ctrl+↑/↓` sets `@place` above/below on every expression element at the current moment (`commitExpressionPlace`), in BOTH the expression layer and voice mode (acts on the expression at the voice anchor). Always `preventDefault`s (no page scroll). Tempo + pedal are excluded (own layers, fixed placement).

### Verification

Suite at **207 fixtures** (`test/composer-test/`). Phase 2 fixtures live in the `PHASE1` group (full tier). Pattern for **modal-driven fixtures**: drive the whole open→fill→submit flow in `setup` JS (dispatch the real `Ctrl+Shift+…` keydown, set field values, `form.requestSubmit(okBtn)`), so the modal is closed by the time invariants run. Layer-navigation fixtures use `setupKeys` (ArrowUp/Down to enter the layer, etc.).

---

## 8. Phase 3 scaffold

A fresh session should start here. Four items; **repeats + endings is the big one** (the only fundamental playback-builder change) — do it first or last deliberately, not in the middle. None has a hard architectural blocker (§4).

### Phase 3.1 — Repeats + endings `{` / `}` / `Ctrl+E`

**Encoding:** repeat barlines via `<measure @left="rptstart">` / `@right="rptend"` (and `rptboth`); 1st/2nd endings (voltas) via `<ending n="1">…</ending>` wrapping measures, with `@lendsym`/`@startid` as needed. Verovio renders both natively. `]` (double bar, Phase 3-adjacent) sets `@right="dbl"`; `[` is still reserved (§1).

**Hotkeys:** `{` = repeat-start on the current measure, `}` = repeat-end; `Ctrl+E` = wrap/extend an ending over the selected measure(s). Confirm exact semantics with Max (toggle vs set; how endings interact with the selection layer).

**Playback (the hard part):** `buildPlayback` must EXPAND the repeat/volta structure into the played measure order BEFORE walking voices, then accumulate `atMs` over that order via the tempo timeline (see the ⚠️ note in §7 — `atMsAt(tick)` is no longer sufficient; integrate `tickMsAt` over the played sequence). A replayed note reuses tick-based velocity/pedal/tempo at its ORIGINAL tick. Highlight echo (`meiId`) repeats too — the same element id sounds more than once, so the cursor highlight must handle revisits (today each event carries one `meiId`; that still works, but verify the per-voice playback bars don't get confused by a revisited id).

**Files:** `src/model/*` (repeat/ending CRUD + selection integration), `src/input.ts` (`{`/`}`/`Ctrl+E`), `src/render/playback.ts` (repeat expansion + composed retiming), `src/keybindings.ts`.

### Phase 3.2 — Page break `Ctrl+B` + section headers

**Encoding:** `<pb>` (page break) / `<sb>` (system break) as section-level controls; Verovio honors them when `breaks: 'encoded'` (currently `'auto'`/`'none'` in `render.ts` `buildOptions` — a view-mode-aware change is needed so encoded breaks win in page mode). Section header = a rehearsal-style text (`<dir>` or a dedicated `<tempo>`-like block) at a measure; decide with Max whether it's a first-class element or reuses expressive text.

**Hotkeys:** `Ctrl+B` toggles a page break before the current measure (collides with Firefox bookmark — already `preventDefault`'d for other Ctrl combos; do the same).

**Files:** `src/model/*`, `src/render/render.ts` (breaks option per view mode), `src/input.ts`, `src/keybindings.ts`.

### Phase 3.3 — 8va `Ctrl+8` (octave lines)

**Encoding:** MEI `<octave @dis="8" @dis.place="above|below" @startid @endid>` (or `@tstamp`/`@tstamp2`). Verovio renders the ottava bracket. **Playback:** the spanned notes sound an octave higher/lower — but HKL playback is coord-based (`{q, r}` → frequency); an 8va must shift the played pitch. Decide: apply the octave shift in `buildPlayback` (adjust the emitted coord/octave for spanned notes) so HKL stays dumb. Note the lattice: an octave is +3 along q (band structure, 2:1 every 3 q-steps) — confirm the coord transform with the tuning rules (CLAUDE.md → coordinate axes).

**Hotkeys:** `Ctrl+8` over a selection (selection layer) or the current note.

**Files:** `src/expressions.ts` or a new `src/octave.ts` (CRUD), `src/render/playback.ts` (pitch shift), `src/input.ts`, `src/keybindings.ts`.

### Phase 3.4 — Trills + tremolos `Ctrl+T`

**Encoding:** `<trill>` (note-attached ornament, `@startid`; optional `@extender` wavy line via `@tstamp2`); tremolo via `<bTrem>` (single-note, wraps a `<note>`/`<chord>`) and `<fTrem>` (between two notes). Selection-mode tremolo logic: a multi-note tremolo spans the selection.

**Hotkeys:** `Ctrl+T` (note: `Ctrl+Shift+T` is the tempo modal — distinct). Confirm trill vs tremolo disambiguation with Max (modifier? selection size?).

**Playback:** trills/tremolos can stay render-only for v1 (like articulations were initially), or expand into rapid alternation in `buildPlayback`. Recommend render-only first with a clear TODO hook; surface to Max.

**Files:** `src/articulations.ts` (trill is ornament-like, note-attached — extends the artic infra) or a new module, `src/input.ts`, `src/keybindings.ts`, `src/render/playback.ts` (TODO hook).

### Phase 3 verification

Standard gates (`pnpm typecheck` + `pnpm -r build` + `pnpm check:boundaries` + `pnpm test:composer`, with `pnpm dev` running). Each item lands ≥1 fixture in the `PHASE1` group with `visualBaseline` for the rendering. The repeat-expansion playback change especially needs assertions on the emitted `atMs` sequence (a repeated span should produce duplicate note events at the right times) — mirror the tempo-retiming fixtures (`phase2_tempo_instant_retimes`).

### Cross-cutting decisions to surface to Max early in Phase 3

1. **Repeat/ending semantics**: `{`/`}` toggle vs set; how `Ctrl+E` endings interact with the selection layer; nested/multiple endings scope.
2. **Section headers**: first-class element vs reuse expressive text (`<dir>`).
3. **8va playback**: shift pitch in `buildPlayback` (recommended, keeps HKL dumb) — confirm the +3-q octave coord transform against the tuning rules.
4. **Trills/tremolo playback**: render-only v1 (recommended) vs expand to alternation; `Ctrl+T` trill-vs-tremolo disambiguation.

### Suggested kickoff prompt for the new thread

> "Read `docs/composer-roadmap.md` §7 (Phase 2 outcomes) + §8 (Phase 3 scaffold). Confirm the four cross-cutting decisions, then implement Phase 3 in the suggested order — start with repeats + endings, since its playback-expansion change is the one that composes with the tempo timeline. Land each item with fixtures; gate on `pnpm test:composer`."

---

## 9. Phase 3 outcomes — as-built deltas (what Phase 4 inherits)

All in `apps/composer/` unless noted. Resolved cross-cutting decisions and notable deviations from the §8 scaffold:

- **Repeat-expansion playback** (`src/render/playback.ts`): `expandPlayOrder(mei, startIdx)` returns the played measure order (rptstart/rptend honored, voltas selected by pass, capped at 2 passes, **start-aware** — repeats whose body the seek falls inside don't replay). `buildPlayback` tags each canonical event with `_mi`, and when `hasRepeatStructure(mei)` it re-stamps `atMs` over the played order (accumulating per-measure ms) while velocity/tempo/octave stay keyed on the **original** tick. No-repeat docs keep the exact original linear path. Endings are MEI `<ending>` wrapping `<measure>`; `Ctrl+E` is one-measure-at-a-time, context-derived (`toggleEndingAt`). `insertMeasureAt` made robust to ending-wrapped reference measures.
- **8va** (`src/expressions.ts` octave CRUD): Verovio renders `<octave>` only from `@startid`/`@endid` (an empty group results from `@tstamp` alone, and it **warns** if both are present). So the bracket uses note anchors for rendering and `data-hkl-t0`/`data-hkl-t1` (tick span) for the playback shift — `collectOctaves` reads the latter. Playback shifts coords `q ± 3` per octave (band structure). Per-staff (both voices).
- **Selection-mode actions exit through `dispatchSelectionMode`**: it now whitelists `Ctrl+8`/`Ctrl+T` to fall through **without** exiting the selection (their handlers read the live beat selection, then exit themselves). Other keys still exit-to-movable first.
- **Trills/tremolos** (`src/articulations.ts`, `model/index.ts`, `render/playback.ts`): `<trill>` is a `@startid` sibling (same shape as fermata; prune extended). Selection-mode `toggleTrillOrTremoloOnSelection` requires exactly two equal-duration, undotted, non-tuplet slots combining to a single notehead; diatonic step → collapse to one combined-duration note + trill (storing the discarded note's exact cell on `data-hkl-trill-q/r`), else wrap the pair in `<fTrem beams=3>` with both notes DRAWN at the combined value. **Playback** expands trill/tremolo into a slur of alternating notes (static `TRILL_NOTE_MS`), preserving the source notes' lattice cells — never computing pitches. A tremolo (`<fTrem>`/`<bTrem>`) needed first-class handling in ALL six tick/enumeration sites (`writtenTicks`, `contentChildren`, `layerStops`, `normalizePlaceholders`, `pushContentChildren`, harness `layerTicks`); a tremolo's time = ONE wrapped note's drawn value (not the sum). See decisions.md.
- **Page break / section header break mode** (`src/render/render.ts`): section/system breaks (`<sb>`, no `<pb>`) render with `breaks:'smart'` + `breaksSmartSb:0` — honors every forced `<sb>` AND auto-wraps overflow. Page-break docs (`<pb>`) need `'encoded'`, so `layoutBreaks()` does a two-pass (smart layout → bake natural `<sb>` → encoded) so pages split AND content still wraps. (See decisions.md — supersedes the earlier "encoded, no auto-wrap" tradeoff.) Trill rebound Ctrl+T → **Ctrl+R** (Firefox reserves Ctrl+T).
- **Section headers** (`src/main.ts` `injectSectionHeaders`): Verovio has no native centered mid-score title, so it's custom post-render injection — find the section's rendered `g.system`, translate it + every later system down by `SECTION_HEADER_RESERVE`, grow the page, and inject a page-centered `<text>` in the freed band. Model `setSectionHeaderAt` tags the measure (`data-hkl-section-title`), forces an `<sb>`, sets the prior measure's final barline, and resets numbering (`renumberMeasures` is now section-aware, restarting at each header). `Ctrl+Shift+H` modal.

**Test-harness note:** Phase 3 added no new cursor layer, so `cursor-trace.mjs` needed no change. Two recurring fixture gotchas surfaced: `duration` is the MEI `@dur` (`'4'`=quarter), **not** the keyboard digit (`'5'`); and `const c`/`let c` in fixture `setup` collides with the injected global `c` (cursor) — use `cc`.

---

## 10. Phase 4 scaffold

A fresh session starts here. Phase 4 = **mid-piece structural changes** (backlog lines 103–105): per-measure time/key signatures and per-staff clef changes. ⚠️ Unlike Phases 1–3, this phase has a **true architectural blocker** — the model currently assumes a single global `<scoreDef>` and `setupDialog.ts` writes there directly. Do the schema work first; the hotkeys are easy once the model supports per-measure metadata.

### The architectural prerequisite (do this first) — ✅ shipped (2026-05-31)

The model-layer prerequisite landed as its own no-user-feature step (suite 222 → 223; fixture `phase4_mixed_meter_prereq`). As-built: a cached `meterTable()` (per-measure budgets + cumulative `prefix[]` + `Map<measureEl,budget>`) with `measureTicksAt`/`measureStartTick`/`measureIdxAtTick`/`measureTicksForLayer`/`meterAt`/`measureIdxOf`/`measureElementOf`; the lynchpin `mi * measureTicks()` → `measureStartTick(mi)` migration across model + selection + clipboard + playback + input; `normalizePlaceholders` now takes a per-layer budget callback (model wraps it as `normalizePlaceholdersAll()`, which is also the central cache-invalidation point); `setTimeSig` re-routed through a ranged `truncateOverflowingMeasuresInRange`. `meterAt` returns the head meter and the `setMeterAt(mi>0)`/`setKeySigAt`/`setClefAt` setters are intentionally deferred to 4.2 (no caller yet). `buildTempoTimeline` tempo-ramp tick math and `beams.ts` beat-grouping still read the head meter (visual/ramp-only; 4.2). See decisions.md "Composer Phase 4 prerequisite — per-measure meter model". **Next: 4.1 `Ctrl+Shift+S` modal.**

Today: one `<scoreDef>` at the score head holds meter (`@meter.count`/`@meter.unit`), key (`@key.sig`), and clefs (`<staffDef>`); `setupDialog.ts` mutates it; everything (measureTicks, beat boundaries, accidental display, playback retiming, MusicXML export) reads that one global. Mid-piece changes need **per-measure scoreDef deltas** — in MEI, a `<scoreDef>` (or `<staffDef>`) placed *inside* `<section>` before a `<measure>` overrides from that point. The model must:
- represent and query "the meter/key/clef in effect AT measure *m*" (walk back to the most recent override), not just one global;
- recompute `measureTicks()` **per measure** (it's currently uniform — a load-bearing assumption in `buildTempoTimeline`, `buildPlayback` repeat-expansion `W`, beat boundaries, `normalizePlaceholders`, cursor tick math). **This is the riskiest ripple** — every site that multiplies by a single `measureTicks()` needs a per-measure lookup.
- carry accidental state across a key change (the HEJI/accidental pipeline assumes one key sig);
- handle copy-paste across a signature boundary (backlog line 105 calls this out).

**Recommend** landing this as its own step with no user-facing feature, gated by the full suite + a fixture proving a 2-measure doc with a mid-piece meter change still satisfies the placeholder invariant and round-trips.

### Phase 4.1 — Time/key signature modal `Ctrl+Shift+S` (UI refactor first)

Extract the existing key-sig dropdown + meter controls from `setupDialog.ts` into a modal on the reusable `openTextEntryModal` shell (Phase 2's `ui/textEntryModal.ts`; clef/sig modals were always the intended inheritors — see §7). `Ctrl+Shift+S` opens it anchored to the current measure; the Setup button still opens it for measure 1. Add cut-time/common-time displays and complex (additive, e.g. 2+3) time signatures (backlog line 104). **Pure UI refactor before any model change** — initially it still writes the global scoreDef.

### Phase 4.2 — Switch time/key sig at measure boundaries

The biggest model rewrite (depends on the prerequisite). `Ctrl+Shift+S` on measure *m* writes a per-measure override effective from *m*'s start until the next existing change; re-opening on a measure that already has a change populates the modal with it (backlog line 105). Playback retiming, MusicXML export, and accidental carry-state all consume the per-measure lookup.

### Phase 4.3 — Per-staff clef changes `Ctrl+Shift+C`

Mid-piece clef change on a staff via a modal (arrow-key clef picker), supporting tenor / alto / treble+8 (backlog line 103). MEI `<clef>` as a measure control event or a per-measure `<staffDef>`. Playback is clef-agnostic (coords carry pitch), so this is mostly notation + the per-measure-scoreDef plumbing from the prerequisite.

### What Phase 4 inherits from Phase 3 (reuse, don't reinvent)

- **Reusable modal shell** `ui/textEntryModal.ts` (`text|number|check|select` fields) — the clef/sig modals' intended home. Modal-driven fixtures: drive open→fill→submit in `setup` JS so the modal is closed before invariants run (see `phase3_section_header`).
- **`data-hkl-*` attribute convention** for model state Verovio ignores (used by tempo, octave `data-hkl-t0/t1`, trill `data-hkl-trill-q/r`, section titles). Per-measure overrides that Verovio doesn't natively place may ride the same pattern.
- **Section-aware `renumberMeasures` + derived `setBarlines`** already walk per-measure state — the natural hook points for per-measure metadata.
- **`Ctrl+Shift+letter` = config modal** tier is established (E/T/H taken; S and C are Phase 4's).

### Cross-cutting decisions to surface to Max early in Phase 4

1. **`measureTicks()` per-measure migration**: confirm the approach (a `measureTicksAt(mi)` helper threaded through every current caller) before the rewrite — it's the highest-blast-radius change in the whole roadmap.
2. **Signature-change encoding**: in-`<section>` `<scoreDef>`/`<staffDef>` vs measure-attribute deltas — pick one and confirm round-trip + MusicXML export behavior.
3. **Accidental carry-state across key changes**: how the HEJI pipeline should reset/carry at a mid-piece key change.
4. **Copy-paste across a signature boundary** (backlog line 105): what happens to pasted content whose source meter differs from the destination.

### Phase 4 verification

Standard gates (`pnpm typecheck` + `-r build` + `check:boundaries` + `pnpm test:composer`, `pnpm dev` running). The prerequisite especially needs fixtures proving per-measure `measureTicks` correctness (placeholder invariant on a mixed-meter doc, beat boundaries, playback timing across a meter change) and round-trip stability. Each item lands ≥1 fixture with `visualBaseline` for the rendered signature/clef change.

### Suggested kickoff prompt for the new thread

> "Read `docs/composer-roadmap.md` §9 (Phase 3 outcomes) + §10 (Phase 4 scaffold) and the §4 blocker note. Phase 4 is mid-piece time/key sig + per-staff clef. Confirm the four cross-cutting decisions — especially the per-measure `measureTicks()` migration — then land the per-measure-`<scoreDef>` model prerequisite FIRST (no user feature, full-suite gated), then the `Ctrl+Shift+S` modal (UI refactor), then mid-piece sig switching, then `Ctrl+Shift+C` clef changes. Land each with fixtures; gate on `pnpm test:composer`."
