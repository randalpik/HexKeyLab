# HKL Composer

Keyboard-driven, Verovio-backed score editor that uses HKL as its input device. Part of [the HexKeyLab architecture](../architecture.md); tuning/coordinate concepts live there, audio playback in [engine.md](engine.md).

Composer holds the MEI/score state; HKL holds the audio/MIDI/tuning state. They run as separate browser tabs and share no module imports beyond the bridge protocol.

## Two-tab architecture

- **HKL tab** (`apps/hkl/index.html`) — Lumatone input, audio engine, tuning state, lattice rendering. Unchanged by Composer's existence.
- **Composer tab** (`apps/composer/index.html`) — MEI model, Verovio render, cursor overlay, keyboard input, playback orchestration. Imports `@hkl/bridge` plus pure helpers from `@hkl/shared` (incl. `notes.js`). Does NOT import HKL's audio / midi / state / lumatone code.

Composer is openable standalone (`.hkc` load/save/edit works without HKL); held-chord entry requires HKL connected. Toolbar `#connStatus` badge: `no HKL` (red) pre-handshake, `connected` (green) after `hkl-hello`, `standalone` (yellow) after 1 s with no hello.

## Bridge protocol (`@hkl/bridge`)

Two `BroadcastChannel`s, both built on the generic `BridgeChannel<In, Out>` (channel name via constructor):

- `'hkl-composer-bridge'` — HKL ↔ Composer (this doc).
- `'hkl-analyzer-bridge'` — HKL ↔ Analyzer (see main architecture §8).

Per-channel protocol modules define independent `In`/`Out` unions. HKL instantiates both in `apps/hkl/src/bridge/hkl-side.ts`.

**HKL → Composer** (`HklEvent`):
- `hkl-hello`, `hkl-bye` — lifecycle.
- `held-keys` — array of `ResolvedNote` `{q, r, pname, accid, oct, midi, colorHex, velocity}`. Broadcast on every `selection.selectedKeys` change (RAF-polled, signature-diffed).
- `playback-position` — `{meiId, timeMs}` per chord onset; final has `meiId: null`.
- `playback-finished`, `tuning-changed` — `{mode, description}` informational.

**Composer → HKL** (`ComposerEvent`):
- `composer-hello` / `composer-bye` / `request-state` — handshake. Composer re-broadcasts `composer-hello` on every inbound `hkl-hello` so HKL learns it's alive when HKL boots second.
- `set-song-key` (key-sig tonic, qm=0 spine, lowest MIDI ≥ F3=53) / `set-reference-note` (cursor's prior note, sent only when non-null) — HKL's two ref-tier channels via `apps/hkl/src/state/reference.ts`. Selection-tier wins over song-key, but a `composer`-source selection is gated on outline mode = `'piano'`.
- `layout-req-changed` — score's pinned tuning + ref; applied when "Sync layout" on.
- `play-score` — `{events: PlaybackEvent[]}`, per-event `{atMs, durationMs, notes, meiId?}`.
- `stop-playback`.

`ResolvedNote` is fully resolved by HKL (pname/accid/oct/midi/colorHex derived from `(q, r)` + tuning), so Composer never needs HKL's tuning to render. `accid` is count-form (`''`, `'s'`, `'ss'`, …, `'f'`, …, `'n'`); not clamped at the bridge.

→ see decisions.md "Composer entry-time playback removed" (a `play-chord`-per-keypress message was dropped — its scheduled `noteOff` cut still-held Lumatone notes short).

### HKL-side glue (`apps/hkl/src/bridge/hkl-side.ts`)

RAF-polled loop resolves each `selectedKeys` `(q, r)` and broadcasts on signature change. Inbound `play-score` dispatches via `audio.noteOn`/`noteOff`. During playback:
- `playbackActive` flag suppresses the held-keys broadcast (else Composer echoes its own playback back as input).
- `playbackOwnedKeys: Set<KeyId>` tracks which `selectedKeys` playback added; only those are removed on noteOff/abort, so user-held keys survive.
- `draw()` after each onset/offset so the lattice highlights what's sounding.

## MEI model (`apps/composer/src/model.ts`)

The MEI document is a `Document` (DOMParser XML). Initial doc: one measure, two staves (grand staff, `bar.thru="true"`), two layers per staff. Metadata (`<titleStmt>`, `<scoreDef>`, `<tempo>`) lives on the document. Mutations are direct DOM ops; the doc re-serializes to a string for Verovio's `loadData()` every render.

Voice numbering (top-to-bottom):

| Voice | Staff | Layer |
|---|---|---|
| 1 | 1 (treble) | 1 |
| 2 | 1 (treble) | 2 |
| 3 | 2 (bass) | 1 |
| 4 | 2 (bass) | 2 |

Each voice has its own cursor in `cursors: Record<Voice, number>`, indexing the **linear flat stream** (concatenated `chord|note|rest|space-placeholder` across all measures, in order). Multi-measure traversal is transparent to the cursor.

- `switchVoice` is time-aligned: snapshots cumulative-time-at-cursor (`getTimeAt`), switches, then `findCursorAtOrBefore(newVoice, time)`. Durations in 64th-note ticks via `elementDurationTicks`.
- Two locator helpers, deliberately different boundary semantics: `locateCursor` (insertion point, strict `<` so cursor=N at a boundary lands in the NEXT measure at `withinIdx=0`) vs `locateFlatElement` (element-at-index, strict-decrement walker for `deleteAtCursor`).

Every `<note>` carries `data-q`/`data-r` (lattice identity survives roundtrip; MEI ignores unknown attrs so `.hkc` opens in other viewers) and `xml:id` set via `setAttributeNS(XML_NS, …)` so `[*|id]` selectors resolve. Every `<staff>`/`<measure>` also carries `xml:id` for cursor-overlay rect lookup. → see decisions.md "Manually-set xml:id without setAttributeNS".

## Render & cursor overlay

`apps/composer/src/render.ts` owns the Verovio toolkit lifecycle. WASM is CDN-loaded via script injection (no npm dep; ~6–8 MB gzipped, 200–800 ms first render). Engraving options:
- `svgViewBox: false`, `scale: 100` — intrinsic-size render, no fit-to-container scaling.
- Page mode: `pageWidth: 2100`/`pageHeight: 2970`, breaks `'auto'`. Scroll mode: `pageWidth: 100000`/`pageHeight: 400`, breaks `'none'`.
- `header`/`footer: 'none'`; `svgAdditionalAttribute: ['note@data-q', 'note@data-r', 'note@color']`.

Post-render SVG processing: each note's `<g class="notehead">` is moved to last sibling so the colored notehead draws on top of the (black) stem; CSS forces stems/flags/accidentals/ledgers/dots black (only the notehead carries lattice color). All strokes use `shape-rendering: geometricPrecision` (consistent stem widths, correct bar-line overhang, zoom-safe). → see decisions.md "geometricPrecision over crispEdges".

Cursor overlay (`apps/composer/src/cursor.ts`) is a separate `<svg>` appended in `#score` after each render, sized to match Verovio's dimensions. Two modes:
- **Editing** — bar/box at the active voice's cursor. Insert mode anchors to the RIGHT edge of `flat[cursor-1]`; overwrite draws a translucent box around `flat[cursor]`. Empty-voice / at-placeholder cases anchor on the active staff. Shows "V1"–"V4" label.
- **Playback** — per-voice bars, editing cursor hidden. Toggled via `setPlaybackMode`.

The cursor resets its refs in `attach()` because Verovio's `loadData()+renderToSVG()` rewrites `#score` innerHTML, orphaning the prior overlay. → see decisions.md "Stale DOM refs across innerHTML rewrites".

## Input model (keyboard-driven)

`apps/composer/src/input.ts`. No mouse-to-document handlers — Speedy-Entry flow, Finale bindings:

| Key | Action |
|---|---|
| `1`–`7` | duration (1=64th … 5=quarter … 7=whole). Held keys → chord; none → rest. Held keys with `|alter|>±3` filtered before commit. |
| `.` | cycle dots (0→1→2→0) on current note/chord/rest. Overflow auto-ties across the bar. |
| `=` | toggle tie on current note/chord (per-pitch; see [Ties](#ties)). |
| `↑`/`↓` | switch voice (cycles 1↔2↔expr↔3↔4, time-aligned). |
| `←`/`→` | move cursor within voice. |
| `Home`/`End` | jump to voice start/end. |
| `Backspace` | voice mode: delete element before cursor (skips placeholders; removes a measure if a delete empties it across all voices, unless it's the only one). Selection mode: delete-and-exit (no clipboard write). |
| `Delete` | voice mode: delete element after cursor. Selection mode: delete-and-exit. |
| `Insert` | toggle insert / overwrite. |
| `Space` | toggle playback; bound at top of dispatcher with `preventDefault`; works in any cursor mode. |

Arrow keys suppressed during playback (`isPlaybackActive` short-circuits navigation).

**Statusline** `#composerStatus` — the sole feedback surface for keystroke actions. `setStatus(text, kind)` toggles a CSS class; four kinds:
- `error` (red) — blocked actions / no-op reasons.
- `state` (blue) — current-state info (`held: A3 C4`, pending-hairpin/tuplet prompts).
- `action` (purple) — post-action confirmations.
- `info` (gray) — `Ready.` default + transient progress.

`clearStatusIfTransient()` fires at the top of every non-modifier keydown and resets to `Ready.` if the current kind is `error`/`action`. State (blue) survives the keystroke; it clears via its own overwrite. Held-keys echoes clear via a source-tagged `clearStatusIfHeldKeys()`. Connection events go to the `#connStatus` badge only, never the statusline. Pick kind by intent, not message content.

## Playback orchestration (`apps/composer/src/playback.ts`)

`buildPlayback(model)` walks every measure of every voice; each chord/note emits a `PlaybackEvent` with cumulative `atMs` per voice and `durationMs` from `elementDurationTicks` at the score tempo (`<tempo>` in measure 1, fallback 120 BPM). Rests/placeholders advance the clock but don't emit. Tied chains coalesce: `@tie="i"` emits ONE event with the chain's total duration; `m`/`t` pieces don't re-attack. Events sorted by `atMs`.

`startPlayback` (in `main.ts`): snapshot editing cursor → send `play-score` → `setPlaybackMode(true)`. On each `playback-position`: look up voice via `findElement(meiId)`, call `setPlaybackPosition` (editing cursor model state untouched — bars are pure overlay). On `playback-finished`/`stop-playback`: `finalizePlaybackEnd()` exits, restores the snapshot.

## Save / load / export (`apps/composer/src/save.ts`)

- **`.hkc`** — canonical. MEI XML string incl. `data-q`/`data-r`. `saveHkc` serializes, `loadHkcFromFile` parses → new `ComposerModel`.
- **`.musicxml`** — one-way. `<score-partwise>`, grand-staff, per-voice `<note>`/`<chord>`/`<rest>`, `<backup>` to align voices, `<notehead color>` for lattice color. Lossy on dynamics/repeats/articulations; pitches/rhythms/colors round-trip to MuseScore/Finale/Sibelius. `divisions: 16` (or `LCM(16, tuplet @num values)` when tuplets present).

## View modes

Toolbar "Page"/"Scroll" toggle. Both use `svgViewBox: false`, `scale: 100`; differ in `pageWidth`/`pageHeight`/`breaks`. Verovio `setOptions()` + re-render on toggle.

## Build / bundling

Composer is its own workspace package (`@hkl/composer`) with its own Vite config; Verovio WASM is CDN-loaded (not bundled). Under `pnpm dev` it's served at `/composer/` on the shared `:5170` origin (same origin as HKL — required for the bridge). Build via `pnpm -r build`.

## Document Setup modal (`apps/composer/src/setupDialog.ts`)

A native `<dialog>` opened by the "Setup…" button:
- **Title** → `<titleStmt><title>`; **Composer** → `<persName role="composer">`.
- **Key signature** → `<scoreDef key.sig>` + `<scoreDef mode="major|minor">` (defaults `'major'`). A **minor** checkbox switches displayed labels major↔relative-minor (the `sig` value is shared); drives `computeSongKeyRef` so the song-key tier publishes the actual tonic. MusicXML emits `<mode>`.
- **Time signature** → `<scoreDef meter.count meter.unit>` (num 1–16, denom 1/2/4/8/16).
- **Tempo** → `<tempo>` first child of measure 1 (`mm`, `mm.unit`, `mm.dots`, `midi.bpm`, optional text).

Applied in dependency order on save (title/composer/keysig/tempo first, time signature last as it can trigger truncation). Time-sig change confirms only when the new meter is *smaller* AND the score has content.

## Measure nav-stop model

Each (voice, measure) contributes cursor stops mirroring the [tuplet](#tuplets) pattern: a **wrapper** stop (the `<measure>` element), one stop per real content child (tuplets inline their stops), and — for **partial** layers — one **fill-anchor** stop (first trailing `<space data-placeholder>`). A synthetic **past-end** stop sits at `flatChildren.length` for every voice; inserting there appends a measure via `appendMeasure`.

| Layer state of Mₖ | Stops emitted |
|---|---|
| Empty, prev measure has content | `[wrapper, fill-anchor]` (wrapper = post-prev nav, fill-anchor = delete target) |
| Empty otherwise (no prev content / first / single-measure doc) | `[wrapper]` (doubles as delete target) |
| Partial (content + space) | `[wrapper, ...content, fill-anchor]` |
| Full (content = cap) | `[wrapper, ...content]` |
| Collapsed (Mₖ₋₁ full + Mₖ has content) | `[...content, fill-anchor?]` (wrapper omitted) |
| Past end (synthetic) | one stop at index `flat.length` |

**Wrapper collapse** (`shouldEmitWrapper`): emit Mₖ's wrapper iff (a) Mₖ is empty for this voice, or (b) k>0 AND Mₖ₋₁ is *partial*. Otherwise omit — three collapse cases (M₁-with-content; Mₖ-with-content + Mₖ₋₁-full; Mₖ-with-content + Mₖ₋₁-empty) each make the wrapper redundant with an adjacent stop.

**Insertion per stop kind:**

| Stop | `loc.withinIdx` | Effect |
|---|---|---|
| Wrapper | `0` | insert at layer front, "before measure" |
| Content | element position in `contentChildren` | standard insert |
| Fill-anchor | `contentChildren.length` | insert at back, extends partial measure |
| Past-end synthetic | fresh empty layer, `0` | applier creates the missing measure |

The user picks extend-vs-enter explicitly via fill-anchor-of-Mₖ (extends) vs wrapper-of-Mₖ₊₁ (enters) — distinct visual positions (before/after the bar line); no boundary re-aim heuristic.

**Backspace** (mirrors tuplets):
- On fill-anchor of an empty tuplet → delete the tuplet.
- On wrapper of an empty measure → delete the measure (unless it's the last).
- Target is a placeholder / tuplet wrapper / measure wrapper → skip-left, no deletion.
- Target is real content → delete it. Content-emptied measures are NOT auto-removed; user backs into the wrapper for the explicit second backspace.

**Cursor rendering** (`cursor.ts`): wrapper / past-end stops use a fallback chain `findSigEndXForStaff` (past clef/keysig/timesig) → first content left edge → first placeholder left edge → `measure.rect.left + 30`. Y/height from the voice's single staff bbox (not the grand staff). "Before a wrapper" anchors INSIDE the wrapper's measure (`anchorAtMeasureLeft`). Past-end of a full last measure merges with "right of last content" (a full measure can't be extended). Fill-anchor anchors right of last real content (`anchorPastLayerContent`).

The `<space data-placeholder>` children stay in the DOM so Verovio reserves measure width and accidental computation works. `normalizePlaceholders` keeps each layer's `<space>` summing to `measureTicks − realTicks(content)`. → see decisions.md "past-end has no +1 redundant index".

### Autofill rests

`autofillAllAndReanchor(voice)` runs from every mutation and navigation entry point. It walks every measure of the voice except the cursor's current one, calling `autofillMeasure`, a no-op unless the measure qualifies:
- Skip if the layer has no real content (empty layers stay placeholders, still navigable).
- Skip if no content in any strictly-later measure (don't pad the trailing tail).
- Skip if already full.
- Else replace trailing placeholder space with `decomposeBeatAlignedRests(startTick, remaining, timeSig)`.

Autofilled rests are plain `<rest>` — to extend the measure later, the user deletes them. Triggering on every mutation (not just measureIdx change) catches the common abandonment pattern at insert time. Re-anchoring captures the cursor's target element before the sweep and snaps to its new flat-index after.

## Ties

**Intent vs. realization.** Tie state on each `<note>` splits in two:
- **Intent** (persisted): `wantsForward` — wants to tie to the next same-pitch note in flat order. Encoded as `@tie ∈ {"i","m"}` OR `data-pending-tie="true"`.
- **Realization** (derived):
  - `@tie ∈ {"i","m","t"}` — MEI 5 value (no compound `"ti"`/`"it"`; Verovio rejects them).
  - `data-tie-partner` — forward-only xml:id ref to the next chain member; terminals carry none.
  - `data-pending-tie` + `<lv startid tstamp2>` — pending stub for unrealizable forward intent; renders as a laissez-vibrer arc.

A note can hold `@tie="t"` (incoming terminus) AND `data-pending-tie` (outgoing intent) at once.

**`normalizeTies()`** is the single source of truth, run after every structural mutation; idempotent:
1. Snapshot per-note `wantsForward`.
2. Strip ALL realization attrs and remove every `<lv>`.
3. Forward-walk each voice: realize `@tie` + `data-tie-partner` where intent has a same-pitch successor; set `data-pending-tie` + `<lv>` where it can't. → see decisions.md "normalizeTies replaces ad-hoc tie passes".

- **`toggleTieOnCurrent`** (`=`) flips `wantsForward` on every note in the chord, then `normalizeTies` derives the result. Dropping demotes `@tie="m"→"t"` to preserve an incoming arc; `"i"`→cleared; pending→cleared. Setting adds `data-pending-tie`.
- **Auto-tie-on-overflow**: `insertWithSplit` decomposes via `decomposeTicks` (greedy by 64ths through dotted forms), tags each piece with intent `@tie`; the caller's `normalizeTies` computes partners.
- **Deletion**: just remove the element + `normalizeTies` — survivors re-tag consistently (i-t with `i` deleted → `t` demotes to pending; i-m-t with `m` deleted → i-t).

**Planner + applier** (`planInsert` + `insertWithSplit`): one walker simulates the new sequence (inserted pieces + post-cursor items), assigning `(measureIdx, offset)`, enforcing three invariants — surfaced via `canInsertHere` (same planner, dry-run, so status matches apply):
- **Measures never exceed length.** Content landing past the cursor's measure requires that target layer empty, else reject `Insertion would overflow into next measure's content.`
- **Tuplets stay atomic.** A tuplet that won't fit moves wholesale to the next measure (gap autofilled later); if that target isn't empty, reject `Insertion would push tuplet across bar line.`
- **Existing post-cursor items keep identity.** Only the fresh note splits with ties; existing items shift wholesale, preserving tie wiring (xml:id + `data-tie-partner` invariant under a DOM move).

## Time-signature change: per-measure truncation

`setTimeSig` → `truncateOverflowingMeasures()`. Per measure × layer:
- Sum 64th-note ticks; find the FIRST overflowing element; `remaining = cap − running`.
- `remaining > 0`: shorten its `@dur`/`@dots` to `decomposeTicks(remaining)[0]` (pitches/ties/color/coords preserved).
- `remaining === 0`: drop the overflowing element via `orphanTiePartners + removeChild`.
- Drop every element after the truncation point.

Then `normalizePlaceholders()`, `setBarlines()`, and clamp each voice's cursor. Measure count preserved (no reflow); enlarging is a no-op modulo placeholder re-norm; crossing tied chains unwind via orphan logic. → see decisions.md "Per-measure truncation over rebuild-and-reflow".

## Accidentals: HEJI-aware carry-state + render-time glyph injection

`apps/composer/src/notation/accidentals.ts` runs `computeAccidentalDisplay` at serialize-time on the *cloned* doc (live doc untouched). Per measure × per staff (treble/bass independently; accidentals carry across voices within a staff):
- Authoritative alteration is `noteAlter(note)` from `(q, r)` via `noteName()` (any magnitude; `@accid` token caps at ±3 as a display cache only). Falls back to `@accid` for coordinate-less imported notes.
- Carry-state keys on the full **HEJI identity** `{alter, syn5, sept7}`, not just the integer alteration — with HEJI on, F♯ vs F♯↑ are distinct and both show; a comma-bearing natural is forced visible. With HEJI off, `syn5`/`sept7` stay 0 (classic conventional carry). Commas from `hejiCommasFor(mode, q, r)`.
- Matched identity → hide via `@accid.ges`; tie destination → hide but update carry; else → show + update carry.

**No ±3 clamp** anywhere in capability — `(q, r)` is the source of truth; the entry/transpose/retune clamps are gone. `@accid` still stores a clamped canonical token as a display cache only.

**HEJI / arbitrary-stack rendering** (`apps/composer/src/notation/heji-render.ts`) — Verovio can't draw EHE glyphs (`@glyph.num` is a no-op in 6.x) and collapses repeated same-token `<accid>` siblings. Render-only workaround (never touches `.hkc`):
1. **`transformDocForHeji`** (from `model.serialize({ hejiEnabled })`, after `computeAccidentalDisplay`): for any note needing more than one ≤±3 glyph, replace `@accid` with DISTINCT placeholder `<accid>` children (distinct tokens force a real horizontal slot each), tagged `@type="hklg-<seq>-<family>-<hex>"`. MEI order reversed from visual (MEI-first renders rightmost, nearest the notehead).
2. **`injectHejiGlyphs`** (from `render.ts` after `renderToSVG`, gated on `document.fonts.load('BravuraText')`): redraws *every* accidental as a BravuraText `<text>` — placeholders become combined U+E2C0+ glyphs; native ones redraw at their SMuFL codepoint. Size `1000 × scale`.

Net: accidentals are uniformly Bravura, rest of the score stays on Leipzig (Bravura rests read worse). Comma math in `@hkl/shared` `heji.ts`, shared by lattice (with readability collapse) and Composer (full chain, no collapse). The HEJI toggle is a setup-dialog checkbox on `<extMeta>/<hkl:config> @heji`, independent of HKL's `hejiEnabled`. MusicXML `<alter>` from `noteAlter` (lossy on commas; no MusicXML HEJI standard).

## Intelligent beaming (`apps/composer/src/beams.ts`)

Computed at serialize-time on the cloned doc (live doc has no `<beam>` wrappers). `regroupBeams(doc, timeSig)` removes existing beams, re-wraps consecutive beamable elements (`dur ≥ 8`, not a rest) per beat group:
- **Simple** (n/{1,2,4}): one denominator-note per group.
- **Compound** (n/{8,16}, n divisible by 3, ≥6): three per group.
- **4/4 special**: each half-measure (beats 1–2, beats 3–4) is a super-group **only when its members are exactly four eighth notes** (no rests, every `@dur === '8'`). 8 eighths → two beams of 4; mixed rhythms (e.g. `E E 16 16 E E E E`) fall back to per-beat groups. The two halves are evaluated independently.

Rests and durations ≥ quarter break the run; singletons stay unwrapped; an element belongs to the group containing its startTick.

## Bar lines + grand staff

- `bar.thru="true"` on `<staffGrp>` → one continuous bar line top-to-bottom.
- `@right="end"` on the last measure → final thin+thick barline (`"dbl"` would render a regular double bar).
- All strokes `shape-rendering: geometricPrecision`.

## Expression layer (dynamics + hairpins)

A virtual fifth "voice" between voices 2 and 3 in the nav cycle, with its own cursor snapping to {every note onset across all four voices} ∪ {every existing dynam/hairpin moment}. `apps/composer/src/expressions.ts` (CRUD + tstamp helpers + doc defaults), `apps/composer/src/expressionCursor.ts` (moment list + navigation + selection).

**Anchoring by `@tstamp`/`@tstamp2`, not `@startid`/`@endid`.** Dynamics/hairpins are siblings of `<staff>` in their measure; an expression survives deletion of any nearby note. Trade-off: re-barring doesn't carry expressions. → see decisions.md / MEMORY "Expression-layer tstamp anchoring trade-off".

- **Voice cycle**: ArrowUp/Down → `1 → 2 → expr → 3 → 4`; indicator shows `E`. `InputState.cursorMode: 'voice' | 'expr'` (alongside `mode: 'insert' | 'overwrite'`).
- **Moment list** (`buildMomentList`): all four voices' note/chord onsets (tie-initial only) + every dynam tstamp + every hairpin start AND end moment; sorted, deduped with float epsilon.
- **Input** — voice mode: `Shift+1..8` (`!@#$%^&*`) enter fff…ppp at the cursor anchor (1=loudest); `<`/`>` mark hairpin start/end. Expr mode: `1..8` dynamics, `<`/`>` hairpins, arrows step moments, `Backspace`/`Delete` remove, `Escape` cancels pending. Hairpins are two-step in either mode (start moment, then a later end; pressing the other form re-starts; same-moment close rejected).
- **Visual** (`cursor.ts`): voice bar hidden; orange vertical tick between staves at the moment's x (from a coincident staff-1 note, or the element's own rect when orphan). Existing dynam/hairpin in range gets `.expr-selected` highlight.
- **Playback** (`playback.ts`): a per-tick velocity timeline built before walking voices. `collectDynams`/`collectHairpins` resolve moments to absolute 64th ticks via `absoluteTickForMoment`. Per onset: most-recent dynam at-or-before (default `mf=85`); the latest-started containing hairpin adds linear interpolation to the next explicit dynam or a synthesized ±25 endpoint. Each event gets `velocity`; HKL's `dispatchChord` reads `ev.velocity ?? keyVelocity[k] ?? 80`. MVP: held notes spanning a hairpin don't continuously change loudness (only newly-struck notes pick up interpolated levels).
- **Doc defaults**: dynamic→velocity map in `<meiHead><extMeta><hkl:config><hkl:dynamicMap>` (ns `https://hexkeylab.com/ns/mei`), seeded at creation, edited via Setup ("Dynamics → velocity"). Round-trips through `XMLSerializer`; `<extMeta>` is the MEI 5 extension point. `replaceDocument` calls `ensureExpressionDefaults` so older `.hkc` get defaults seeded.
- **Save/load**: `<dynam>`/`<hairpin>` are just extra `<measure>` siblings; survive serialize/load with no special handling.

## Slurs

*Implemented.* Note-attached via `@startid`/`@endid` (a slur's identity IS its two endpoint slots, so it stays note-attached, NOT in the tstamp expression layer). `apps/composer/src/slurs.ts` (`addSlur` / `removeSlur` / `collectSlurs` / `pruneDanglingSlurs`).

- **Endpoints** are SLOT elements — a bare `<note>` or `<chord>`, both id-bearing; the `<slur>` is appended as a measure child after `<staff>` (like `<hairpin>`/`<dynam>`) with `data-voice` (1–4).
- **Entry** (voice mode, `Ctrl+L`): first press marks the start slot (pending, status feedback only); a second `Ctrl+L` after navigating closes the slur (endpoints ordered low→high by flat-slot index; same slot → no-op + error). `Ctrl+L` on any slot under an existing slur's span deletes that whole slur. Switching voices / entering select mode / Esc / undo exits pending.
- Verovio renders the arc natively (no SVG injection); round-trips through serialize/`.hkc` untouched.
- **Dangling cleanup**: `pruneDanglingSlurs` runs inside `normalizeTies` (shared post-mutation hook) and in `applyRetune`. Retune rewrites kept notes in place, so xml:ids — and slurs — survive; only dropped endpoints prune.
- **Playback**: `buildPlayback` stamps each event with `voice` and `slurredToNext`. Realization is instrument-dependent, chosen HKL-side in `playScore` via `computeLegatoPlan(events, glideMode)` with `glideMode = !instrReplaysOnTranspose()`:
  - **Decay + replay-on-transpose instruments** (overlap mode): a slurred note's release is delayed by `SLUR_OVERLAP_FRACTION` (12%) of its duration (note-proportional legato; `offMs` override).
  - **Sustained loopers** (glide mode, the "transpose effect"): a single-note slurred transition hands one voice off via portamento (`SLUR_GLIDE_MS` = 70 ms, clamped to half the note) instead of re-attacking. Predecessor sets `noOff`; successor sets `glideFromKey`; `dispatchChord` calls `glideVoices` (shared voice-handoff primitive in `audio/engine.ts`) migrating bookkeeping old→new. Chord-involved joins fall back to abutting playback (v1). Verified by ear, not the headless harness.

## Tuplets

Single-measure, non-nested `<tuplet>`. `Ctrl+N` (N=2..7) opens a pending-tuplet state; the next duration digit completes by inserting a `<tuplet>` at the cursor. A tuplet never straddles a barline (it's the atomic unit of fit), but `insertWithSplit` may push an *existing* tuplet wholesale across a barline (see [Ties](#ties) planner).

**Ratio table** (`Ctrl+N` then duration digit `d`):

| N | num:numbase | span | atomic written-dur |
|---|---|---|---|
| 2 | 2:3 | dotted-d | d ÷ 2 |
| 3 | 3:2 | d | d ÷ 2 |
| 4 | 4:6 | dotted-d | d ÷ 4 |
| 5 | 5:4 | d | d ÷ 4 |
| 6 | 6:4 | d | d ÷ 4 |
| 7 | 7:8 | d | d ÷ 8 |

E.g. `Ctrl+3,5` = triplet (3:2) of 8ths in a quarter. `num`/`numbase` written to MEI directly; Verovio draws bracket + numeral (count form).

**Pending flow** (`input.ts`): `Ctrl+N` sets `state.pendingTuplet`, prompts, `preventDefault`s. Next plain digit completes via `commitPendingTuplet`. Any other non-modifier key cancels and falls through (so `Ctrl+3` then `→` cancels and moves; `Ctrl+3` then Shift alone is a no-op so the user can still Shift+digit chord). `Ctrl+N` inside a tuplet rejects `Cannot nest tuplets.`

**Data model** (live MEI): `<tuplet>` is a direct child of `<layer>`. `data-tuplet-atomic-dur` records the atomic written-duration for `regenTupletPlaceholders`. Children = filled content + trailing placeholder rests:

```xml
<tuplet xml:id="t-..." num="3" numbase="2"
        bracket.visible="true" num.visible="true" num.format="count"
        data-tuplet-atomic-dur="8">
  <note dur="8" pname="a" oct="3" .../>           <!-- F1 -->
  <rest dur="8" data-tuplet-placeholder="true"/>  <!-- fill anchor -->
  <rest dur="8" data-tuplet-placeholder="true"/>
</tuplet>
```

Placeholders are `<rest>` (not `<space>`) because Verovio's bracket-rendering pass only fires with visible-content children; the rest glyph is CSS-hidden (see Bracket workaround).

**Cursor stops** (`navigableChildren`): each `<tuplet>` contributes `[tuplet-wrapper, ...in-tuplet-stops]`. The wrapper is a layer-level "before tuplet" stop. In-tuplet stops: one before each filled child Fi, plus one on the first trailing placeholder (fill anchor) iff any exist. "After tuplet" is the natural "before next layer element" stop.

- Empty `[note, tuplet]` → flat `[note, tuplet, fill-anchor]` (4 stops).
- Partial `[tuplet[F1], Q]` → `[tuplet, F1, fill-anchor, Q]` (5 stops).
- Complete `[F1, F2, F3]` → `[tuplet, F1, F2, F3]` (fill anchor absent).

"Before tuplet at layer level" (insert pushes tuplet right) is distinct from "before F1 inside" (insert pushes F1 right within the bracket).

**Insertion**: layer-level "before tuplet" → planner insert (may push tuplet to next measure; rejects `Insertion would push tuplet across bar line.` if that target isn't empty). In-tuplet stop → consumes trailing placeholders; total written-tick budget (num × atomic) invariant; regen recomposes. Overflow inside → reject `Doesn't fit in remaining tuplet space.`

**Atomic-aware regen** (`regenTupletPlaceholders`): after any trailing-placeholder change, regenerate preferentially as N atomic-sized rests (per `data-tuplet-atomic-dur`), `decomposeTicks` for awkward remainders. Makes fill+delete reversible (e.g. insert 8th into a triplet → `[F1_8, P_8, P_8]`; backspace → `[P_8, P_8, P_8]`). Non-aligned remainders emit one atomic + leftover decomposed.

**Backspace** (`deleteAtCursor`):
- Right of / past the tuplet: nibble the rightmost filled child, regrow placeholders; element survives until all-placeholder; one more removes the `<tuplet>` from the empty fill-anchor.
- "Before F1 inside" (target = tuplet wrapper): cursor moves left to "before tuplet at layer level", no deletion.
- Between filled children: nibble that child, following content shifts left, placeholders regrow.
- On fill anchor of an entirely empty tuplet: delete the whole `<tuplet>`.

**Cursor rendering** (`cursor.ts:renderVoiceCursor`), two tuplet anchor cases in insert mode: entering (flat[c-1]=wrapper) → LEFT edge of flat[c], just inside the bracket; exiting (flat[c-1] is a tuplet child, flat[c] has a different parent) → parent tuplet's right edge.

**Beaming** (`beams.ts:regroupOneTuplet`): a second pass beams each tuplet's content as one beat group (rests split runs, placeholders filtered by `isTupletPlaceholder`); reuses `splitIntoBeamableRuns`/`wrapInBeam`.

**MusicXML** (`exportMusicXml`): `DIVISIONS = LCM(16, all tuplet @num)`. Each child carries `<time-modification>` (`num`/`numbase`); first child's `<notations>` has `<tuplet type="start">`, last `"stop"`. Chord-in-tuplet: only the primary note carries the `<tuplet>` tag; all members carry `<time-modification>`. Rests carry `<time-modification>` but no `<tuplet>`.

**Bracket workaround**: `<space>` is excluded from Verovio's bracket pass; `<rest visible="false">` doesn't work (verovio#202, open since 2016). So placeholders are real `<rest data-tuplet-placeholder="true">`, hidden via CSS:

```css
#score svg g.rest[data-data-tuplet-placeholder="true"] { visibility: hidden }
```

(`data-data-` is Verovio's normalization of `svgAdditionalAttribute`-exposed attrs.) `visibility: hidden` preserves layout width; `display: none` would collapse the bracket.

**Out of scope**: nested tuplets (rejected `Cannot nest tuplets.`), `<tupletSpan>` cross-bar tuplets, mid-tuplet insertion when out of placeholder space (rejected; no push-past-bar since tuplets can't cross bars).

## Selection, copy & paste

A third `CursorMode` value (`'select'`), orthogonal to voice/expr and to `EntryMode`. Two granularities, always bounded at musical boundaries:
- **Beat mode** — one voice, contiguous beats. Entered via Shift+Left/Right.
- **Measure mode** — one+ two-voice staves, contiguous measures. Entered via Shift+Up/Down. Beat mode promotes to measure mode irreversibly via Shift+Up/Down.

**Beat-mode state** (`apps/composer/src/selection.ts`):
```ts
{ kind: 'beat'; voice: Voice;
  origin: number; first: number; last: number;
  lastMoved: 'first' | 'last'; }
```
Invariant `first ≤ origin ≤ last`, with `first==origin` or `last==origin` (grows from one side at a time). Minimum is one beat; zero-width impossible (no convergence-exit). A **beat** is the half-open interval between consecutive `beatBoundariesInVoice` entries (cursor positions tstamp-aligned to `beatTicks(timeSig)`, not strictly inside a tuplet; tuplets spanning beat-aligned tstamps select atomically). Boundaries dedup'd by tstamp (collapsed wrapper case: later/measure-aligned index wins). `measureBoundariesInVoice` is the barline-aligned analog — tstamp-based, NOT `getMeasureStartCursor`-based (which returns one stop past the visual barline in the collapsed case).

**Beat transitions:**

| State | Shift+Left | Shift+Right |
|---|---|---|
| `origin==last` (single OR expanded left) | `first--`, lastMoved='first' | `last++` if single; else `first++` (shrink) |
| `origin==first` (expanded right) | `last--` (shrink), lastMoved='last' | `last++`, lastMoved='last' |

Ctrl+Shift+Arrow = repeated Shift+Arrow until the moved edge lands on a measure-aligned boundary (or score edge). Entry direction sets `lastMoved`: Shift+Left→'first', Shift+Right→'last' (matters for immediate exit).

**Measure-mode state:**
```ts
{ kind: 'measure'; originVoice: Voice;
  originStaff: 1|2; firstStaff: 1|2; lastStaff: 1|2;
  anchorMeasure: number; movableMeasure: number;
  movableSide: 'left' | 'right' | 'unset'; }
```
`anchor`/`movable` accounting predates the beat rework (measure mode has no convergence-exit problem). `originStaff` defines symmetric staff expansion via Shift+Up/Down.

**Mode-exit cursor placement** (`cursorAtMovable`) — used by Escape and any non-selection key. Ctrl+X and Backspace/Delete reuse the lastMoved-side placement via `deleteSelectionContent(sel)` (beats: `boundaries[lastMoved==='first' ? first : last+1]` post-clear; measures: `cursorAtMovable`). Ctrl+C is the exception — leaves selection intact, doesn't reposition. Backspace and Delete are identical in selection mode.

**Clipboard format + OS I/O** (`apps/composer/src/clipboard.ts`): an `<hkl:clipboard>` MEI fragment carrying re-anchor metadata:
```xml
<hkl:clipboard kind="beat" voice="1" durationTicks="32" timeSig="4/4">
  <hkl:content>… raw chord/note/rest/tuplet, ids stripped …</hkl:content>
</hkl:clipboard>
```
```xml
<hkl:clipboard kind="measure" staffFirst="1" staffLast="2" measureCount="2" timeSig="4/4">
  <hkl:measures><measure>…</measure></hkl:measures>
  <hkl:expressions><dynam … data-hkl-src-measure-offset="0"/></hkl:expressions>
</hkl:clipboard>
```

OS clipboard uses the **DOM `copy`/`cut`/`paste` events**, NOT `navigator.clipboard.writeText`/`readText` (unreliable on Firefox — permission UI + stale/empty data). The keydown handler still does the model side-effects for Ctrl+C/X (so CDP tests observe state changes); the serialized text is stashed in module-level `pendingClipboardText`, written to `event.clipboardData` by the DOM `copy`/`cut` handler in the same gesture tick. Paste is handled entirely in the DOM `paste` event.

**Paste semantics** (`pasteBeatContent` / `pasteMeasureContent` in `model.ts`):
- *Beat*: snap to current beat boundary, clear destination range (incl. partially-overlapping tuplets expanded atomically), insert source via existing helpers, auto-append measures past end-of-score, re-enter beat selection over the pasted range.
- *Measure*: time-sig pre-check (mismatch → reject); per-measure wipe + replace of selected staves' layers; expression re-anchoring; auto-append.
- *In selection mode*: delete current selection first, paste at the resulting cursor; final selection covers pasted content.

**Cursor convention bridge** (`findCursorByTickPosition`): the model has two cursor conventions off by one — `locateCursor`/`insertChordAtCursor`/`deleteAtCursor`/`getTickPositionAt` use "cursor c = past flat[c]"; `getTimeAt`/`findCursorAtOrBefore` use "past flat[c-1]". Paste/cut paths pairing `getTickPositionAt` with cursor placement use `findCursorByTickPosition` (the locateCursor-convention version) to avoid off-by-one. → see decisions.md "two cursor-position conventions".

**Selection overlay** (`apps/composer/src/selectionOverlay.ts`): one rect per `<g class="system">` ancestor touched (coalesced via DOM ancestor, not a y-distance heuristic). X ranges union within a group; Y depends on mode — measure: full staff bbox across `firstStaff..lastStaff`; beat: union of layer-element bboxes in the voice, `CURSOR_VPAD` padded (hugs the actual voice). Boundary x rules: past-end → last measure right edge; measure-start tstamp → `kind='start'` uses `Mₖ.contentLeft` (sig-block snap via `findSigEndXForStaff`), `kind='end'` uses `Mₖ₋₁.right` (disambiguates across system breaks); mid-content → left edge of `flat[c+1]`; mid-system barline → prefer `Mₖ₊₁.bbox.left` (Verovio renders the barLine glyph inside the measure group, so `Mₖ.bbox.right` overshoots).

**Out of scope**: cross-system selection bridging ribbon (rects render correctly per-system, just not connected); paste of non-HKL clipboard content (fails gracefully with "Clipboard is empty or not HKL content").

## Out of scope (Composer overall)

- Note-level edits inside an existing chord.
- Anacrusis / partial-bar pickups.
- Tempo changes mid-score, expressive text, articulations (planned — see expression-layer extensions).
- Print / PDF export (deferred).
- Undo / redo.
- Multi-instrument scores beyond grand staff.
- Tie-chain re-coalescence under time-sig change (currently per-measure truncation).

### Planned extensions (expression-layer infrastructure)

The Moment/tstamp helpers, moment-snap cursor, and velocity timeline are shaped so these slot in without re-architecting:
- **`<tempo>` mid-score** — `addTempo`; extend `buildPlayback` with a tempo timeline (`@func="continuous"` interpolates via `<hkl:tempoAlteration>`); `<hkl:tempoMap>` text→BPM defaults.
- **`<dir>` expressive text** — `addDir`; visual-only, tstamp-anchored.
- **`<artic>` articulations** — children of note/chord, containment-based; staccato shortens / tenuto extends / accent boosts velocity. (`.` conflicts with cycle-dots; keymap needs design.)
- **Continuous-loudness shaping through hairpins** — a new `ComposerEvent` carrying timed `(meiId, pressureValue, atMs)` triples so HKL schedules per-voice `handleAftertouch` pressure ramps.
- **Click-to-select expressions** — click handler snaps the expression cursor via `snapTo`.
- **Per-staff dynamic scoping** — velocity lookup consults `<dynam> @staff`.
- **MusicXML export of expressions** — `<direction>`/`<wedge>` per dynam/hairpin.
- **Tstamp orphan migration on meter change** — `truncateOrMigrateExpressions(prevMeter, newMeter)`.

User-facing entry is unchanged: cycle to the voice/expr layer, press a hotkey.

## Help modal (`apps/composer/src/helpDialog.ts`)

Read-only enumeration of every binding the dispatcher acts on, grouped Universal / Voice / Tuplet / Expression / Selection. The catalog is `KEYBINDINGS: KeySection[]` in `apps/composer/src/keybindings.ts` — the canonical doc source for Composer keybindings (replaced the former `input.ts` header docstring). Native `<dialog>.showModal()` provides focus trap + Escape; the dispatcher's `shouldIgnore` already drops events from focused form elements. When changing a binding in `input.ts`, update `keybindings.ts`. The catalog is documentation-as-data, NOT a dispatch table. → see decisions.md.

## Testing & inspection

**Test suite** (`test/composer-test/`) — pre-merge gate. `pnpm test:composer` (full, ~15 s) / `:fast` (~8 s); needs `pnpm dev` in another terminal.

Tiers: `fast` (MODEL+CURSOR+CONSOLE), `full` (+ROUNDTRIP+RENDER+INPUT+VISUAL), `visual` (pixel baselines; `--update-baselines`), `scenario <name>` (single fixture, `--keep-open`).

| Invariant | Asserts | Catches |
|---|---|---|
| MODEL | model query post-setup matches | flat-list off-by-one, cursor convention drift, accidental clamp |
| CURSOR | consecutive positions render >3px apart | "state changes but pixel doesn't" |
| RENDER | DOM/SVG shape | missing tuplet bracket, accid overlap, color leak |
| ROUNDTRIP | serialize→replace→serialize identical (mod placeholder ids) | xml:id namespace bugs, tie reconstruction |
| VISUAL | pixel match vs baseline (clipped to bbox) | font/color/line-rendering changes |
| INPUT | real CDP keystrokes reach the model-API end-state | keybinding registration, pending flows |
| CONSOLE | no error-level messages (always-on) | stale `@tie`, dangling refs, MEI parse errors |

`RESET_SNIPPET` (`lib/runner-core.mjs`) clears model + input state + scroll between fixtures and forces scroll mode for deterministic clip rects. Every bug fix lands with a fixture; `fixtures.mjs` is grouped by concern (cursor-convention, single/multi-voice, tuplets, ties, sig-changes, keystroke-dispatch, bridge, scroll, visual). The selection group covers entry/growth/shrink-to-origin/Ctrl+Shift jumps/promotion/cut/visual (`sel_beat_shrink_to_origin` enforces "selection always ≥ 1 beat").

**Headless inspection** (`test/composer-inspect/`): `inspect.mjs '<expr>'` runs a JS expression in headless Chromium and prints JSON; `--screenshot <path>` captures a PNG. `cursor-trace-all.mjs <outDir>` walks every `scenarios.mjs` scenario's cursor positions and reports rect-collision violations. Needs `pnpm dev`; the `window.__hkl_composer` handle exposes `bridge, model, renderer, cursor, reRender`.
