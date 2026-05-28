# Composer feature roadmap — multi-phase plan

> **Status: working planning doc, not architecture.** This is the umbrella for the Composer feature push that was kicked off when Max bulk-added items to `backlog.md` lines 98–125. Updated as phases close. Once everything here is shipped (or absorbed into architecture.md), this file gets deleted.
>
> See also: `docs/composer-phase1.md` (current phase's focused implementation plan).

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

### Phase 1 — Quick wins + the P1 *(current; see `docs/composer-phase1.md`)*
Goal: deliver the active blocker plus all items that build directly on existing patterns with zero new infrastructure.

- Articulations S/A/T/F/B *(P1)*
- Ctrl+arrows during playback + plain-arrow exit-to-cursor
- Insert measure Ctrl+M
- Hide rest H
- Parenthetical cautionary P
- Stem direction L + slur direction Shift+L (2-state flip with freeze)
- Beam split /
- Double bar `]`
- Click on/near a note to move cursor
- Fill incomplete measures
- Composer field + watermark
- Cross-staff slurs `?` spike (cross-cutting)

### Phase 2 — Expression layer expansion
Goal: extend the existing time-anchored expression infrastructure with three new element types and the first text-entry modal pattern.

- Pedal layer `Shift+P/Shift+O` — simplest concrete instance; forces the bridge-CC plumbing early
- Expressive text modal `Ctrl+Shift+E` — first reusable text-entry modal; becomes the shell other modals inherit
- Tempo modal `Ctrl+Shift+T` + rit/accel rendering — first non-trivial playback retiming
- Above/below staff placement `Ctrl+↑/↓` — sits across all the above

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
