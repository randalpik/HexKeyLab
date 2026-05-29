# Composer feature roadmap — multi-phase plan

> **Status: working planning doc, not architecture.** Umbrella for the Composer feature push kicked off when Max bulk-added items to `backlog.md`. Updated as phases close.
>
> **Phase 1: ✅ shipped** (2026-05-28). 190/190 tests pass. See `docs/composer-phase1.md` for the historical detail; the inherited-by-Phase-2 surfaces are summarized below in **§ Phase 1 outcomes — what Phase 2 inherits**.
>
> **Phase 2: ready to scaffold on a fresh thread.** See **§ Phase 2 scaffold** below.

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

### Phase 2 — Expression layer expansion *(ready to scaffold)*

Goal: extend the time-anchored expression infrastructure (already shipped for `<dynam>` + `<hairpin>`) with three new element types and the first reusable text-entry modal.

- **Pedal layer `Shift+P/Shift+O`** — simplest concrete instance; first to land. Forces the bridge → HKL sustain-CC routing.
- **Expressive text modal `Ctrl+Shift+E`** — first reusable text-entry modal; becomes the shell tempo and (later) clef/sig modals inherit.
- **Tempo modal `Ctrl+Shift+T`** + rit/accel rendering — uses the new modal shell; introduces the first non-trivial playback retiming.
- **Above/below staff placement `Ctrl+↑/↓`** — touches all the above (`@place` on every expression element).

### Phase 3 — Score structure & playback structure
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

## 7. Phase 2 scaffold

A fresh session should start here. The four items, in implementation order:

### Phase 2.1 — Pedal layer `Shift+P` / `Shift+O`

**Encoding:** MEI `<pedal @dir="down" @tstamp=…>` and `<pedal @dir="up" @tstamp=…>` as siblings of `<staff>` in their measure — same shape as `<fermata>`/`<breath>` already shipped in Phase 1.

**Hotkeys:** `Shift+P` = pedal down; `Shift+O` = pedal up (off). Each places its own event at the cursor's moment. The pedal symbol renders BELOW the bottom staff (Verovio knows this; no manual @place).

**Playback:** new bridge message `pedal-event` with `{ at: tickPos, dir: 'down'|'up' }`, OR piggyback as an additional field on `play-score` events. The cleanest: extend `buildPlayback` to emit a parallel sequence of pedal events with their own timestamps, and add a new bridge field `pedalEvents`. HKL routes them to sustain CC 64 on its audio engine. External MIDI out gets the same CC.

**Files (likely):**
- `apps/composer/src/pedal.ts` (new) — CRUD for `<pedal>` events: `addPedal(doc, moment, dir)`, `removePedal(doc, moment, dir)`, `collectPedals(doc)`, `pruneDanglingPedals(doc)` (sibling-of-staff cleanup; hook into `normalizeTies` like fermata/breath).
- `apps/composer/src/input.ts` — `Shift+P` / `Shift+O` keystroke dispatch.
- `apps/composer/src/keybindings.ts` — add to Voice mode section, plain-musician language.
- `apps/composer/src/render/playback.ts` — extend `buildPlayback` to emit pedal events; bridge message extension.
- `packages/bridge/src/protocol.ts` — add `pedalEvents` to `play-score` payload OR new `pedal-event` message type.
- `apps/hkl/src/bridge/hkl-side.ts` — receive pedal events and apply sustain CC.

**Decisions needed** (would benefit from Max's input before scaffolding):
- **Bridge protocol**: piggyback on `play-score` (one transport for the whole timeline) vs separate `pedal-event` messages (cleaner separation, easier to extend with other CCs later). *Recommend piggyback for v1*.
- **Anchoring**: time-based `@tstamp` (survives nearby note deletion — matches `feedback_expression_anchoring`) vs note-attached. *Recommend tstamp* (matches dynamics/hairpins).

### Phase 2.2 — Expressive text modal `Ctrl+Shift+E`

**Modal shell** (the most reusable Phase 2 deliverable). Currently `setupDialog.ts` is the only modal pattern; it's a one-off. Phase 2 should extract a reusable text-entry-modal abstraction that subsequent modals (tempo, future clef/sig) inherit.

**Suggested shape** (under-specified — Max may have a different preference):
- `apps/composer/src/ui/textEntryModal.ts` (new) — generic `openTextEntryModal({ title, fields: [...], onOk })` that builds a `<dialog>`, focuses the first text field, handles Enter→submit / Escape→cancel.
- Or: a wrapper component like `apps/composer/src/expressionTextDialog.ts` that uses native `<dialog>` directly (matching `setupDialog.ts`'s pattern) without an over-engineered abstraction.

**Encoding:** MEI `<dir>` element as sibling of `<staff>`, `@tstamp` anchored. Has `@place` (above/below — Phase 2.4 hotkey toggles it) and contains the text content. Optional `<rend @fontstyle="italic">` for italics.

**Modal contents** (per backlog item):
- Text input (single line for v1).
- Italics checkbox.
- "Common configurations" via arrow keys / Tab — e.g., pizz / arco / sul tasto / con sord. Could be a dropdown of presets OR autocomplete. *Defer detail to scaffold thread.*

**Playback:** "we will directly interpret text" per the backlog — Phase 2 likely parses the literal text for known cues (pizz, arco) and applies them. Out of scope of the text-entry feature itself; lives in `render/playback.ts`. For v1, ship the text rendering and DEFER the playback parsing (mark as TODO with a clear hook).

**Files:**
- New: `apps/composer/src/expressionTextDialog.ts` or `ui/textEntryModal.ts`.
- `apps/composer/src/input.ts` — `Ctrl+Shift+E` opens the dialog.
- `apps/composer/src/expressions.ts` — add `<dir>` CRUD alongside dynam/hairpin.
- `apps/composer/index.html` — modal markup.

### Phase 2.3 — Tempo modal `Ctrl+Shift+T` + rit/accel

**Encoding:** MEI `<tempo>` element. Phase 1 already supports a single global tempo via `setTempo()` in `setupDialog`. Phase 2 extends to MULTIPLE `<tempo>` elements at arbitrary moments, plus `<gradual>` (or equivalent) for rit/accel spans.

**Verovio support**: Verovio renders `<tempo>` with `@mm` and text content (e.g. "Allegro ♩ = 120"). For rit/accel, the convention is `<tempo>` with text "rit." plus an optional dashed line. MEI 5 also supports `<dynam>`-style hairpins for gradual changes; check what Verovio renders.

**Modal contents:**
- Text (e.g. "Allegro", "rit.", "molto rit.").
- Marking mode: "tempo marking" (bold + larger, e.g. "Allegro ♩=120") vs "expression" (italic, e.g. "rit.").
- Note-symbol entry for "♩=120"-style markings (dropdown of note values).
- For rit/accel: span endpoint (= when does the gradual change end).

**Playback retiming:** this is the first non-trivial change to `buildPlayback`. The current velocity timeline is piecewise-constant (dynamics) + piecewise-linear (hairpins). Tempo gets a similar treatment:
- Piecewise-constant for instant tempo changes.
- Piecewise-linear interpolation for rit/accel (or curved — *decision needed*).
- The `tickMs` constant becomes a `tickMsAt(tickPos)` function.

**Files:**
- `apps/composer/src/expressions.ts` (extend) — `<tempo>` CRUD as siblings of staff.
- `apps/composer/src/input.ts` — `Ctrl+Shift+T` opens the modal.
- New: `apps/composer/src/tempoDialog.ts` (using the shell from 2.2).
- `apps/composer/src/render/playback.ts` — piecewise tempo timeline; mid-piece retiming.
- `apps/composer/src/setupDialog.ts` — initial tempo control STAYS in Setup (the modal handles MID-PIECE changes); Setup writes to the first measure's `<tempo>` and the modal handles subsequent ones.

**Decision needed:** rit/accel interpolation — linear, exponential, or user-selectable. *Recommend linear for v1*.

### Phase 2.4 — Above/below staff placement `Ctrl+↑` / `Ctrl+↓`

**Behavior:** in expression mode (or with a selected expression element at the cursor), `Ctrl+↑` and `Ctrl+↓` flip `@place="above"` ↔ `@place="below"` on the current expression element. Defaults per element type (dynamics: between staves; tempo: above; pedal: below) — but Phase 2 ships flat defaults (always above), since "defaults per instrument" requires Phase 5's multi-instrument concept.

**Encoding:** `@place` on `<dynam>` / `<hairpin>` / `<dir>` / `<tempo>` / `<pedal>` — already a standard MEI attribute. Verovio honors it.

**Files:**
- `apps/composer/src/input.ts` — `Ctrl+↑/↓` in expression mode.
- `apps/composer/src/expressions.ts` — `getPlace(el)` / `setPlace(el, place)` helpers (probably one-liners).

### Phase 2 verification

Per the standard suite gates. New fixtures:

- **Pedal**: `<pedal @dir="down">` at moment, second key adds `@dir="up"`, both render; playback events include pedal CC.
- **Expressive text modal**: `Ctrl+Shift+E` opens the modal; submitting writes a `<dir>` at the cursor's moment; renders.
- **Tempo modal**: `Ctrl+Shift+T` opens; submitting writes a `<tempo>` mid-piece; playback retimes accordingly (assert event `atMs` shifted vs default-tempo computation).
- **Above/below**: `Ctrl+↑/↓` toggles `@place` on the cursor's expression; renders position changes.

### Cross-cutting decisions to surface to Max early in Phase 2

(Repeated from above for convenience — a fresh thread should ask before scaffolding deep.)

1. **Pedal bridge protocol**: piggyback on `play-score` (recommended) vs separate `pedal-event` messages.
2. **Modal abstraction shape**: extract `textEntryModal.ts` generic shell vs per-feature dialogs that copy `setupDialog.ts`'s pattern.
3. **Expressive text playback effects**: ship the text rendering only in v1, defer the "pizz"/"arco" auto-interpretation? Or fold it in?
4. **Rit/accel interpolation curve**: linear (recommended) vs curved.
5. **Initial tempo**: stays in Setup dialog (recommended) vs migrate fully to the new tempo modal.

### Suggested kickoff prompt for the new thread

> "Read `docs/composer-roadmap.md` § Phase 2. Confirm the five cross-cutting decisions, then write a focused implementation plan at `docs/composer-phase2.md` (mirror the structure of `composer-phase1.md`). Implement Phase 2.1 (pedal) first."
