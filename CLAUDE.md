# CLAUDE.md — HexKeyLab Project Context

This document is the entry point for any Claude session working on HexKeyLab. Read it first.

## Who you're working with

Max Randal. Music theorist, software engineer, and Lumatone player. Builds HKL as both a personal performance/composition tool and a research instrument for hexagonal isomorphic tuning systems with just intonation. Has deep domain expertise in tuning theory, MIDI, and software architecture; treat him as a peer, not someone who needs hand-holding.

## What HexKeyLab is

A browser-based visualizer, audio engine, and Lumatone controller for hexagonal isomorphic keyboards with arbitrary tuning systems (currently Equal, Ptolemaic, Pythagorean, Semiditonal, Septimal, and Schismatic — see Tuning modes below). It does seven things:

1. **Visualizes** the hex lattice with band/seam structure, color-coded by tuning system
2. **Plays audio** through sample-based instruments (piano, organs, strings, etc.) and oscillators with proper JI tuning
3. **Communicates with the Lumatone** via MIDI input (notes from physical play) and SysEx output (key colors, key remapping, calibration)
4. **Analyzes intervals and chords** with comma-decomposition naming and JI ratio display
5. **Records and plays back performances** with full coordinate fidelity, and exports/imports `.mid` files via MPE for editing in external DAWs
6. **Transcribes recordings to sheet music** via a `.hkr` → LilyPond pipeline (tempo estimation + Ellis-DP beat tracking + per-bar duration Viterbi DP), emitting colored noteheads keyed to the lattice
7. **Documents tuning theory** through interactive exploration

The companion tool at `analyzer/HexKeyLab-analyzer.html` is a dev-only sidecar that generates loop-point data for sample-based instruments. It's not shipped with HKL but is part of the project.

**HKL Composer** (`composer.html`) is a sibling app shipped from the same repo — a keyboard-driven, Verovio-backed score editor that uses HKL as its input device via a same-origin `BroadcastChannel` bridge. Composer holds the MEI/score state; HKL holds the audio/MIDI/tuning state. See architecture.md §7.

## Project status (2026)

Repo at `/home/max/HexKeyLab`, version `1.0.0`. Migration from the v0.9 single-file (`HexKeyLab.html`, ~4200 lines of inline CSS/JS) to a strict TypeScript + Vite project is complete; that codebase is now being restructured into a pnpm monorepo (`apps/*` + `packages/*` — see the layout note below). v1.0 feature work is landing on top: pedal revamp, polyphonic aftertouch, persistence, recording/playback, and Lumatone diagnostics are all in.

Stack: TypeScript + Vite + vanilla DOM, modular by domain. **No React, no Redux.** HKL is mostly engine code (audio, MIDI, render, SysEx state machines) — not a UI app. The toolbar UI is small enough to not need a framework. If a framework is later wanted *for the toolbar specifically*, Lit or Solid are the considered options. React was explicitly considered and rejected.

**Repo layout is a pnpm monorepo** (migration in progress — see decisions.md "Per-app split + same-origin dev proxy" and the two prior monorepo entries). There is no top-level `src/` anymore:
- **`apps/{hkl,composer,analyzer}/`** — the three servable apps, each its own package with `index.html` + `vite.config.ts` + `package.json` + `src/`. (Granular paths in this doc written as `src/foo/bar.ts` now live at `apps/hkl/src/foo/bar.ts` unless they're composer/analyzer code.) Each runs its own dev server with scoped HMR.
- **`packages/{shared,engine,notation,bridge}/`** — the library packages (`@hkl/shared`, `@hkl/engine` = HKLE nucleus, `@hkl/notation`, `@hkl/bridge`). DAG: `@hkl/shared ← {engine, notation, bridge} ← apps`. Imports use bare `@hkl/*` specifiers (subpath exports map `./*.js` → `./src/*.ts`); intra-package imports stay relative.

**Running it: `pnpm dev`** spawns all three app servers + `vite/dev-proxy.mjs`, which reverse-proxies them under **one origin `http://localhost:5170`** (`/`→hkl, `/composer/`→composer, `/analyzer/`→analyzer). The single origin is mandatory — the HKL↔Composer/Analyzer `BroadcastChannel` bridge and the `IndexedDB` instrument registry are per-origin. `pnpm build` = `pnpm -r build` (each app to its own `dist/`); `pnpm typecheck` is one root `tsc --noEmit` over `apps` + `packages`. Verovio WASM is CDN-loaded by `@hkl/notation`; the analyzer app bundles its own `pipeline-worker` plus the root `analyzer/*.js` engine modules. Use **pnpm**, not npm (lockfile is `pnpm-lock.yaml`; `allowBuilds` in `pnpm-workspace.yaml` gates dependency install-scripts — esbuild must stay enabled).

## How to work with Max

**Style**: Direct, peer-to-peer, technically dense when warranted. Match the register of the conversation. Don't over-explain things he already knows. Don't pad responses with framing. He prefers compact responses unless he asks for depth.

**Speak before every tool call. No silent extended thinking.** Past sessions have racked up 10+ minutes and 50k+ tokens of internal deliberation with zero visible output; Max has had to interrupt to ask what's happening. This is unacceptable. Rules: (1) Before any tool call, write at least one sentence in the user-facing channel stating what you're about to do — even if it feels obvious. (2) Do not use thinking blocks to ruminate on which of two near-identical implementations is nicer; pick one and do it. (3) For a directive like "do X," reply with one short acknowledgement and start the tool call in the same turn — do not deliberate first. (4) If you have a clarifying question, ask it in one line and stop; do not produce a four-option AskUserQuestion or weigh options silently. (5) If you genuinely need to think, do it in 1-2 sentence chunks between tool calls, not in giant blocks. The user would always rather redirect a wrong action than wait through silence.

**Trust pattern**: He catches subtle regressions through hands-on testing. Trust him on testable claims; ask before pursuing dead-ends; favor compact responses over comprehensive ones.

**Stop and ask** when hitting circular reasoning, when a problem keeps not yielding to attempts, or when proceeding would commit to a direction he hasn't approved. Don't pursue unverified hypotheses.

**Design before code on complex features**. Simple tweaks can be implemented directly. For non-trivial changes — especially anything touching the audio engine, sample loop logic, SysEx state machines, or coordinate systems — propose the design first.

**Information-theoretic completeness matters to him**. No lossy interval names. Every distinct interval gets a unique name. Naming symmetric across complement pairs. This is a guiding principle for the interval-naming system specifically and a useful tell for his preferences generally.

**Terminology preferences**: Spell out "augmented"/"diminished" (not abbreviated). Interval naming uses a fixed-meaning adjective hierarchy (see architecture.md §4.10): `lesser/greater` for the two 5-limit (z=0) variants of a quality (`greater` = higher cents), `acute/grave` for the much-less-common SC variant on the opposite side of the standard 5-limit form, `septimal` for one prime-7 factor (with HKL-specific assignments for septimal A2/A4/d5/d7 tied to Lumatone reach, not xen-wiki canonical ratios — see decisions.md), `subminor/supermajor` for the 28:27 / 27:14 family, `wolf` for the narrowing 5-limit P-class variants. Comma decomposition for precision when no override fits.

**Verification before claims**. Use **pnpm, not npm**. Run `pnpm typecheck` (one root `tsc --noEmit` over `apps` + `packages`), `pnpm -r build` (or `pnpm --filter @hkl/<app> build`), and `pnpm check:boundaries` (enforces the package DAG — see decisions.md) before claiming a change works. Beyond that, **check `tools/` for verification tooling specific to the module you're working in** (e.g., `tools/composer-inspect/` for Composer rendering, `tools/lumatone-cal/` for calibration). If a tool exists for invariant checking or visual verification, run it before AND after the change — model-only verification has repeatedly missed visual / behavioral regressions that the tooling catches in one pass. Re-Read files between edits if intervening tool calls may have modified them; if `Edit` fails with "file modified since read", re-Read and re-attempt the same change before moving on. Search the codebase before saying something doesn't exist.

**File paths**. Repo is `/home/max/HexKeyLab` in Claude Code; that's the working directory for any code change.

## Critical hardware context

These are non-negotiable constraints. Always respect them.

- **Lumatone is 5 boards × 56 keys = 280 keys.**
- **Boards 3 and 4 are physically swapped on Max's unit.** Every LTN file and every SysEx send must account for this. The mapping is `sysexBoardMap = [1,2,3,5,4]` — board groups (0-indexed) 0,1,2,3,4 send to SysEx board IDs 1,2,3,5,4.
- **Fixed MIDI channel map is 0-indexed in SysEx**: `fixedMidiChannelMap = [0,1,2,3,4]`. The Lumatone firmware uses the SysEx channel byte directly.
- **A3 = 220 Hz** is the central reference of the tuning system.
- **The expression pedal jack is Roland-wired** (wiper on ring). Korg-style pedals (DS-1H, DS-2H, switch pedals) leave the ring floating and produce noise; don't confuse this with a software bug. Roland DP-10, EV-5, and Yamaha (with polarity invert) work.
- **CC 4 is hardcoded for the expression jack** in firmware; it cannot be remapped via SysEx. CC 64 is the sustain jack (binary).

## Critical tuning context

- **Coordinate axes**: q = major thirds (5:4), r = **fifths** (3:2). The r axis is fifths, NOT minor thirds. Minor thirds are a derived direction (-1, +1) in (q, r). This was verified empirically from LTN data and is easy to misremember.
- **Band structure**: 3 keys wide along the q-axis. Every key is exactly 2:1 (octave) above the key 3 positions to its left. Band index = `floor((q+1)/3)`, position-in-band = `((q+1) % 3 + 3) % 3`.
- **Origin**: A3 sits at (q=0, r=0) with bandOf=0, posInBand=1.
- **Constraint**: 5-limit mode constrains prime-5 exponent to ±2 (because posInBand ranges 0–2). Diesis (128:125) is unreachable in 5-limit; 7-limit syntonic adjustments can bring it within reach.

### Tuning modes (`TuningMode` in `state/persistence.ts`)

`TuningMode = 'E' | '5' | 'P' | 'D' | '7' | 'V'`. Selector displays them in this order with conceptual labels: **Equal · Ptolemaic · Pythagorean · Semiditonal · Septimal · Schismatic**. Persistence values stay the original `'E'/'5'/'7'` plus `'P'/'D'/'V'` so old prefs and `.hkr` recordings load unchanged. ('V' for "variant" was the code first picked, retained for disambiguation even though the label is now "Schismatic" — see the mode entry below.)

**Dual definition gotcha**: `TuningMode` is declared in TWO places that must stay in sync — `src/state/persistence.ts` (HKL-side, full app state) and `src/shared/freq.ts` (shared between HKL and Composer, kept self-contained so Composer doesn't pull in HKL's state). When adding a mode, update both type aliases AND the `TUNING_MODES` array in `freq.ts`. The `Record<TuningMode, ...>` sites that need new entries: `MODE_LABELS` in `composer/notation/retune.ts`, `TUNING_LABELS` in `composer/setupDialog.ts` and `bridge/hkl-side.ts`, `PIANO_BOUNDS_TABLE` in `render/canvas.ts`, `VALID_REF_TABLE` in `render/refbounds-table.ts`, and the `validRefSetByMode`/`validRefPathsByMode` pair in `render/draw.ts`. Plus the `isTuningMode` guards in `persistence.ts`, `recording/hkr.ts`, `composer/main.ts`, and `bridge/hkl-side.ts`. The selector `<option>` in `index.html` and the `tuningDescription()` switch in `bridge/hkl-side.ts` complete the loop.

The canonical source of truth is `tuning.mode`; `tuning.equalEnabled` and `tuning.septimalEnabled` are derived booleans (true exactly when `mode === 'E'` / `'7'`) kept in lockstep by `setTuning()`. Sites that only ask "is this Equal?" or "is this Septimal?" continue to work via the flags; new sites use `tuning.mode` directly.

Per qm column (`qmod3 = ((q%3)+3)%3`):

- **`'E'`** Equal — 12-TET. Frequency uses the 12-TET formula directly; regions not consulted.
- **`'5'`** Ptolemaic *(default)* — 5-limit JI base. All cells A-d0.
- **`'P'`** Pythagorean — qm=1 cells get +SC shift (A-d1-lower), qm=2 cells get −SC shift (A-d1-upper). Every M3 = 81/64, every m3 = 32/27. No 5-limit ratios anywhere. Mostly a study layout (5-limit M3s preferred in practice).
- **`'D'`** Semiditonal — qm=2 cells get −SC shift (A-d1-upper) only. qm=2 cells become enharmonic to their (+7, −4) 5-limit siblings, so the Pythagorean minor third (32/27) is reachable in qm=2 inside a band — much more compact than reaching to a distant 5-limit cell. 5-limit minor (10:12:15) is the trade.
- **`'7'`** Septimal — qm=2 cells are B-region (B-d1-upper: −SC + 63/64). Every qm=0 Pythag-spine cell has its harmonic 7th (7/4) exactly two rows up in qm=2 of the same r. Dominant 7 = 4:5:6:7 and half-dim 7 = 5:6:7:9 reachable everywhere. 5-limit minor (10:12:15) is the trade — minor becomes Pythagorean (32:27, via qm=0) or septimal subminor (7:6, via qm=2).
- **`'V'`** Schismatic *(experimental study mode)* — same qm shifts as Semiditonal (qm=2 −SC only); `freqAt` additionally multiplies the band factor by `SCHISMA^b` (schisma = 32805:32768 ≈ 1.954c, the comma by which 2·PM3 + M3 exceeds an octave). Within-band layout reads (PM3, M3) — left→center is PM3, center→right is the pure 5/4. The band-crossing M3 (qm=1 → qm=2 of the next band) is spelled as a `d4` (e.g. C# → F) and rings as a pure 81:64 PM3; the schisma is absorbed into the octave so qm=0 cells in successive bands all spell as the same letter (A3 → A4 → A5) at the cost of octave drift accumulating to ~14c across 7 octaves. Magnitude lands in the Railsback central-stretch range (~1–3c/oct), so pianistically-trained ears find it natural rather than jarring; V isolates the pure-thirds component of natural octave stretch from the inharmonicity component pianos add on top. Naming uses the standard `noteName`/`keyOctave` (no V-specific dispatch); the divergence from Semiditonal lives in two places: `jiRatioWithState` in `tuning/ratios.ts` adds `db × (−15, +8, +1, 0)` to the prime-exponent vector (the schisma's prime decomposition) so the interval analyzer surfaces "octave + schisma" via existing comma machinery; `keyColorVariant` in `render/colors.ts` short-circuits to its own chainStep × MIDI-octave formula, bypassing the SC-sibling redirect so the band-distinguishing hue serves as the *sole* visual indicator that the spelled octave has been altered by a schisma. The piano-outline picker (`compute88PianoCoords`) deliberately *opts out* of the `jiRatioWithState` divergence by routing through D state: V's schisma exponent inflates the TH of (3k, 0) lineage cells (each octave above ref carries one schisma in V's exponent vector), so under V rules the picker preferred diaschisma-spelled cells (e.g. MIDI 69 = (−4, 4) "A" at TH 21.98 over (3, 0) "A" at TH 30.00) or arithmetic-coincidence cells with weird spellings (MIDI 105 = (−2, 8) "G##" at TH 0). Routing through D collapses every (3k, 0) to TH 0 and the lineage wins by construction. Playback unaffected: `freqAt(…, 'V')` still applies `SCHISMA^b`, so the audible schisma stretch remains. Consequence: `VALID_REF_TABLE['V']` and `PIANO_BOUNDS_TABLE[*]['V']` are byte-identical to D's entries; the V-mode piano outline and valid-ref overlay match Semiditonal's exactly. HEJI does NOT double-flag this — `hejiCommas` omits the per-band shift. V is also the lone mode that draws band seams: with the band crossing spelled `d4`, it carries a real enharmonic change worth the universal seam treatment. **Naming caveat**: "Schismatic" here refers to the layout-level schisma stacking (every band carries one schisma; play across many bands and the schismas accumulate). It is NOT the classical schismatic temperament, which tempers the fifth itself by ~⅛ schisma so that 8 fifths approximate a pure 5/4. HKL's r-axis fifth stays pure 3:2 in V mode; only the band/q-axis accumulates schismas.

All shift dispatch lives in `src/tuning/regions.ts:regionInfoWithState` (switch on `mode`). Frequency / ratio math is mode-agnostic — they apply whatever RegionInfo they're handed via `aDepth`/`aUpper`/`type`. Persistence validation: any unrecognized `tuning` value reverts to the `'5'` default.

**Coloring**: SC-shifted cells (Pythagorean qm=1/qm=2, Semiditonal qm=2) reuse the colorTable via the SC equivalence — `lookupHue(q + 7·d, r − 4·d)` for −SC, `(−7, +4)` for +SC. An SC shift in (q,r) lands you on the cell whose hue is the SC sibling (purple → teal etc.). No new HueColors variants needed. Septimal qm=2 keeps its existing `.sl`/`.sd` warm-shifted variants. V mode is the lone exception — it skips the SC sibling redirect and uses a chainStep × MIDI-octave formula so every band carries its own hue rotation, breaking octave invariance to flag schisma accumulation. Helper: `keyColorVariant(q, r)` in `src/render/colors.ts`.

**Seams**: drawn at every band boundary in 5/P/D/7/V — the band crossing is where the qm structure cycles and (in V) where the spelled enharmonic d4 lives. Equal mode is the only mode without seams (no band concept). Septimal no longer draws an extra A↔B region seam — hue + HEJI hook + leftmost-of-band position already disambiguate the B region, so the additional seam was visual noise. Pure-SC-shift modes (Pythagorean, Semiditonal) still signal their qm columns through hue rotation; only band boundaries get seams.

### Ref-driven layout shift (`refSpine` in `src/tuning/refspine.ts`)

The legacy flat/natural/sharp layout buttons AND the QWERTY transpose ▲/▼ are gone. Lattice positioning under the static Lumatone / QWERTY outlines is now driven by the reference note: the lattice slides so that `refSpine(referenceNote.q, referenceNote.r)` lands at the outline's center.

```
refSpine(refQ, refR) = qmod3 === 0  → (refQ,     refR)   on Pythag spine
                       qmod3 === 1  → (refQ - 1, refR)   5-limit M3 above qm=0
                       qmod3 === 2  → (refQ + 1, refR)   same-row Pythag spine
```

The 3-layout system is a special case: ref ∈ {C, F, G} on the Pythag spine reproduces the old ♭/♮/♯ shifts. But any ref now works — including its syntonic-comma siblings (`(±7, ∓4)` neighbors) — and the rule is the same in all tuning modes including 12-TET.

### Held-voice migration on ref change

When ref changes, voices originating from PHYSICAL inputs migrate with the lattice: Lumatone MIDI voices (tracked in `midi/handler.ts:heldLumatonePhys` as `"ch,note"`) and QWERTY voices (tracked in `input/keyboard-notes.ts:heldCodes`) follow their physical key from the old lattice cell to the new one, so a held key keeps sounding the right relative pitch as the lattice slides. **Mouse-click voices stay anchored to the lattice cell they were clicked on** — they're lattice-bound, not input-bound. Fan-out lives in `src/effects/onRefChanged.ts`.

### Ref validation

`validateRefNoteCandidate(q, r)` (in `render/draw.ts`) checks two things only:
1. `coordToMidi(q, r) ∈ [21, 108]` — refNote must be inside 88-key range.
2. Every cell in the 88-cell footprint the picker produces under this ref spells with `≤ ±3` accidentals.

There is no extra "ref must be in V5 / V7" requirement — the dotted V5 / V7-uniform outlines (drawn when "Valid ref bounds" is on) are visual aids built from this same check, not a separate gate.

### Octave-consistent 88-cell picker

`compute88PianoCoords(refQ, refR)` walks MIDI 21..108 and for each MIDI picks the (q, r) with that MIDI that minimizes reduced Tenney Height to the ref, **tiebroken by `|proj − PROJ_PER_OCT · round((midi − refMidi)/12)|`** where `proj = 7(q−refQ) − 4(r−refR)`. The octave-normalized target keeps each pitch class on its own ref-aligned lineage — at the ref's own MIDI the picker returns `(refQ, refR)` exactly, and Eb3 / Eb4 end up at the same enharmonic spelling. A 0-centered `|proj|` tiebreak (earlier attempt) silently relocated the ref to a syntonic sibling at TH=0 ties.

## Audio architecture (philosophy)

HKL is **self-contained**. All tuning, layout interpretation, and audio synthesis happens inside HKL. The Lumatone sends MIDI on a fixed (channel, note) addressing scheme; HKL maps those addresses to the current lattice state, computes frequencies from the active tuning system, and renders audio directly through its sample/oscillator engine. No external synth, no Scala/SCL, no per-layout MIDI mappings — one static Lumatone configuration, all interpretation in software.

## Recording architecture (philosophy)

The recording feature treats lattice coordinates as the source of identity, not pitch. The native `.hkr` format (JSON) is the canonical recording: it bundles a layout snapshot (tuning, 5-limit layout, 7-limit shift, instrument, pedal mode, A3 reference) with a flat coordinate-event stream `{t, k, q, r, v, …}`. `.mid` is exported from and imported back to `.hkr` deterministically; the two travel separately (no bundled container). MIDI export uses MPE — manager channel 1, member channels 2–16, pitch-bend range ±48 semitones via RPN — so per-voice JI offsets survive a DAW round-trip. The capture hook lives **inside the audio engine** (`noteOn`/`noteOff`/`handleAftertouch`/`setDamperDepth`/`sostenuto*`) so QWERTY, mouse-click, and Lumatone input all record the same way. Playback drives the audio engine directly and also writes to `selection.selectedKeys` so keys flash visually as they play.

`.hkr` → LilyPond transcription is in `src/transcription/`: tempo estimation (IOI autocorrelation + log-Gaussian prior), Ellis-DP beat tracking, phase-search downbeat detection, per-bar Viterbi DP for duration quantization, middle-C voice split with rest consolidation. Output `.ly` is colored per-notehead via `\tweak NoteHead.color`. Pitch spelling reuses `noteName(q, r)` / `keyOctave(q, r)` so lattice-correct accidentals (sharps on +r, flats on −r) come through for free.

## Composer architecture (philosophy)

HKL Composer (`composer.html`) is a separate browser tab that consumes HKL's held-keys state and emits playback requests via `BroadcastChannel('hkl-composer-bridge')`. The bridge protocol is fully resolved: HKL sends `ResolvedNote` records with `{q, r, pname, accid, oct, midi, colorHex, velocity}` — Composer does **not** import HKL's tuning, audio, MIDI, or state modules. The decoupling lets Composer survive standalone (load/save/edit `.hkc` files even with HKL closed); entry of held chords requires HKL to be connected.

Engraving is **Verovio** (in-browser WASM, MEI in / SVG out, sub-100 ms re-render per chord). The canonical Composer state is MEI XML in memory; `.hkc` files are just MEI with HKL custom attrs (`data-q`, `data-r`) embedded on each `<note>`. MusicXML export is one-way (lossy on dynamics/repeats per Verovio's importer limits, but pitches/rhythms/colors round-trip).

Playback orchestration: Composer walks the MEI to compute per-voice timing in ms, dispatches `play-score` over the bridge. HKL's audio engine plays via the same `noteOn`/`noteOff` path used for live input. HKL also adds the playing keys to `selection.selectedKeys` (with a `playbackOwnedKeys` tracker so user-held keys aren't disturbed) and calls `draw()` — the lattice highlights what's sounding. The held-keys broadcast is suppressed while HKL is playing back to prevent Composer from seeing its own playback echoed back as held-key input.

Multi-measure with per-measure invariants: every voice's layer either holds real content OR holds invisible `<space data-placeholder>` elements summing to one measure — never both. Placeholders both reserve Verovio layout width (fixing the empty-measure bar-line gap) and serve as cursor navigation targets (letting the user start a voice partway through the score without manually entering whole rests). Auto-tie-on-overflow splits long notes across barlines via `<note @tie="i"/"m"/"t">` with `data-tie-partner` cross-references for O(1) orphan cleanup. Accidentals are clamped at ±3 (multi-`<accid>` children overlap in Verovio rendering); higher alterations are filtered at entry. Time-sig change uses per-measure truncation (not flatten-and-reflow). See architecture.md §7 for details.

Tuplets: single-measure non-nested `<tuplet>` support via Ctrl+N (N=2..7) + duration digit (architecture.md §7.21). Each tuplet element is a layer-level cursor stop in addition to its in-tuplet stops, so "before tuplet at layer level" and "before F1 inside tuplet" are distinct cursor positions. Placeholders are `<rest data-tuplet-placeholder="true">` (not `<space>` — Verovio's bracket-rendering pass needs "content" to draw the bracket; the rest glyph is CSS-hidden via the `data-data-tuplet-placeholder` attribute propagated by `svgAdditionalAttribute`). Atomic-aware placeholder regeneration via `data-tuplet-atomic-dur` makes fill+delete perfectly reversible. Verovio doesn't honor `@visible` on rests (issue rism-digital/verovio#202) — see lessons.md.

Selection / copy / paste: third `CursorMode` value (`'select'`) entered via Shift+arrow (architecture.md §7.22). Two granularities — beat (one voice, contiguous range of beats; state is `{origin, first, last, lastMoved}`) and measure (one or more two-voice staves, contiguous range of measures). OS clipboard I/O uses the DOM `copy`/`cut`/`paste` events (not `navigator.clipboard.readText` — that's blocked on Firefox even on localhost). Clipboard format is an `<hkl:clipboard>` MEI fragment that survives cross-tab paste. Paste auto-appends measures when content overflows the score. When cursor APIs pair `getTickPositionAt` with cursor placement, use `findCursorByTickPosition` — `findCursorAtOrBefore` uses an off-by-one convention that's only correct in its own round-trip (switchVoice); see lessons.md for the trap.

**Headless Composer verification tooling** (`tools/composer-inspect/`): use this whenever a Composer change touches rendering, cursor, layout, or DOM structure. Model-state inspection alone has repeatedly missed visual regressions — most commonly "cursor flat-index changes but the rendered bar doesn't move." Requires `pnpm dev` running. The `window.__hkl_composer` handle inside any expression exposes `bridge, model, renderer, cursor, reRender`.

- **`inspect.mjs '<expr>'`** — runs a JS expression in a headless Chromium page; prints the result as JSON. Use for ad-hoc DOM/state queries: `node tools/composer-inspect/inspect.mjs '[...document.querySelectorAll("g.accid use")].map(u => u.getAttribute("xlink:href"))'`.
- **`inspect.mjs --screenshot <path> [<expr>]`** — captures the rendered page as PNG (the Read tool renders PNGs visually for you). The optional expression runs first, so you can drive the model into a specific state and screenshot the result. Use to see what Max sees without manual browser cycles.
- **`cursor-trace-all.mjs <outDir>`** — runs every scenario in `scenarios.mjs` (`emptyDoc`, `m1Quarter`, `m1Full`, `m1FullM2Quarter`, `m1FullM2Empty`, `m1PartialM3Full`, `m1FullM2EmptyM3Quarter`, `m1EmptyM2Quarter`) through an in-page cursor-walk that records each position's rendered bbox + the elements before/after the cursor, plus a screenshot. Reports invariant violations: consecutive cursor positions whose rendered rects collide within 3px (= "state changes but pixel doesn't"). Exits non-zero if any violation. **Run this before declaring a cursor-model change done**, and add a new scenario to `scenarios.mjs` for any case under active investigation that isn't already covered.

**Composer test suite** (`tools/composer-test/`): the comprehensive gate. ~50 fixtures across cursor / tuplet / tie / multi-voice / time-sig / key-sig / Ctrl-nav / expression / scroll / bridge / keystroke-dispatch / visual categories. Each fixture runs through 5–9 invariants (MODEL, CURSOR, RENDER, ROUNDTRIP, INPUT, CONSOLE, VISUAL). Full tier finishes in ~15 s; fast tier in ~8 s. **Run `pnpm test:composer` before declaring any Composer change done** — it has surfaced regressions that `cursor-trace-all` alone misses (data-tie-partner asymmetry, accidental clamp, roundtrip placeholder-id drift, scroll-into-view, etc.). On failure, the runner emits `tools/composer-test/out/summary.json` plus per-fixture screenshots. See `tools/composer-test/README.md` for adding fixtures.

The suite exposes `window.__hkl_composer.bridge` for direct send/receive, plus in-page test hooks injected once at startup: `window.__test.*` (assertModelState, assertNoTieOrphans, assertBracketRendered, assertCursorInViewport, runRoundTrip, …), `window.__bridgeMock` (a second BroadcastChannel for HKL-side simulation: `sendHeldKeys(notes)`, `captured()`, `drain()`), `window.__cursorTrace(voice, exemptions)` for ad-hoc cursor walks, and `window.__waitForScrollSettle(maxMs)`. When debugging interactively, `node tools/composer-test/run.mjs scenario <name> --keep-open` leaves Chromium running so you can attach DevTools and probe these handles.

**Every Composer bug fix or feature lands with a fixture.** This is how the suite grows naturally with the codebase. The fixtures file is grouped by concern — add to the matching group and define a `FIXTURE_ASSERTIONS[name]` entry if the universal invariants (placeholder, tie orphans, cursor-trace, roundtrip, console) don't already cover what changed. For visual coverage, add a `visualBaseline: '<name>'` key; the first run seeds `baselines/<name>.png` automatically. A bug fix without a fixture is a bug fix waiting to regress.

**When a test's pixel output disagrees with live behavior on the same code**: don't hypothesize about caching, animations, or paint timing first. Diff the flows: list every command the test runner issues between the user's last input and the screenshot that a live browser doesn't (mock-channel injects, cursor-trace, RAF waits, forced view modes, etc.), in order. The cause is usually one of those concrete differences. See lessons.md "Test invariants that mutate render state pollute later invariants' pixel reads" and "Test/live divergence: diff the flows before hypothesizing."

**When verifying a write (baseline update, file regen, etc.)**: check mtime/size with `stat` or `ls -la`. "The command exited cleanly" is not proof the file was rewritten — tools can silently skip work when their tier filters don't match. See lessons.md "Verify file writes by checking mtime/size, not exit code."

## Critical Lumatone protocol context

- **SysEx envelope**: `F0 00 21 50 <board> <cmd> <data1-4> F7`
- **Manufacturer ID**: `[0x00, 0x21, 0x50]`
- **Reference repo**: https://github.com/hsstraub/TerpstraSysEx.2014 — the Terpstra Editor source. Has the authoritative command list.
- **Key commands HKL uses**:
  - `0x00 CHANGE_KEY_NOTE` — configure note/channel/keyType per key
  - `0x01 SET_KEY_COLOUR` — extended 8-bit color as 6 nibbles (RR GG BB)
  - `0x07 SET_LIGHT_ON_KEYSTROKES` — LED feedback on keypress
  - `0x0E SET_AFTERTOUCH_FLAG` — global polyphonic aftertouch
  - `0x31 GET_FIRMWARE_REVISION` — version query
  - `0x38 CALIBRATE_EXPRESSION_PEDAL` — toggle calibration mode
  - `0x39 RESET_EXPRESSION_PEDAL_BOUNDS` — reset to factory
  - `0x3E PERIPHERAL_CALIBRATION_DATA` — spontaneous status packets emitted every 100ms during cal mode
- **Key types**: 0=disabled, 1=noteOnNoteOff, 2=CC, 3=lumaTouch (continuous fader, NOT poly aftertouch).
- **typeByte format**: `(faderUpIsNull << 4) | keyType`

## Lumatone hardware (reverse-engineered, for calibration only)

Most HKL work doesn't touch this. Documented here because deriving it again costs a session.

- **Internals**: BeagleBone Black + Debian + 5 PIC microcontrollers. BBB↔PIC over UART `/dev/ttyO1`. BBB↔host over USB-MIDI plus USB-ethernet gadget.
- **SSH access** (Max's unit only — broken macro buttons make this necessary): `ssh debian@192.168.6.2` (Linux host), password `temppwd`. Mac/Windows hosts use `192.168.7.2`.
- **Firmware binary**: `/home/debian/TerpstraController/TerpstraController` (ARM 32-bit ELF, not stripped, full DWARF debug info, PIE). Launcher loop: `lmtn_launcher.sh` respawns it forever.
- **Per-key calibration storage**: `/home/debian/TerpstraController/files/KeyData_1..5`. Text files, 4 sections × 56 values (MAX, MIN, validity, AT MAX). Loaded at every TC boot and pushed to PICs.
- **In-memory `kbd_preset_params`**: TC `.bss` struct, 638-byte stride per board, section offsets +0x118 / +0x150 / +0x1c0 / +0x1fe. Indexed by PIC number (`sysex_board - 1`), NOT by spatial board_group — the physical-swap mapping only applies to file naming / SysEx routing, never to in-memory layout.
- **0x24 calibration is unusable for Max's boards 1/4/5**. PIC firmware waits for hardware macro-button signal; no SysEx or BBB-side trick can substitute. Use direct file/memory editing instead.
- **Toolchain**: `tools/lumatone-cal/` — Python scripts for live per-key editing (`keydata-live.py`), local file inspection (`keydata-locate.py`), diagnostic state dumps (`lmtncal-read.py`).
- **Full guide**: `docs/lumatone-calibration.md`. Read that before doing any calibration work.

## Browser/runtime context

- **Primary browser**: Firefox.
- **Web MIDI in Firefox** requires secure context — localhost or HTTPS. `file://` URLs do NOT work. Use Chromium for `file://` testing.
- **Web Audio API** for sample playback. Sample sources: `tonejs.github.io`, `gleitz.github.io`, `vcsl` (sharp notes URL-encoded as `%23`).
- **Canvas** for rendering. devicePixelRatio scaling for retina.

## Documentation map

- **`CLAUDE.md`** (this file) — entry point for sessions. Read first.
- **`docs/backlog.md`** — Max's source of truth for future direction, conceptual framing of layouts, and current task backlog. Read-only for Claude: suggest changes but never edit without explicit permission, even for "obvious" updates like striking completed items.
- **`docs/architecture.md`** — what HKL does and how it's organized. Feature-level reference.
- **`docs/lessons.md`** — gotchas, dead-ends, anti-patterns, hard-won truths. Read before debugging anything that smells familiar.
- **`docs/decisions.md`** — append-only log of non-obvious design choices. Add an entry when committing a decision worth remembering.
- **`docs/lumatone-calibration.md`** — how to do per-key hardware calibration via SSH + scripts in `tools/lumatone-cal/`. Only needed when working around the broken macro buttons on Max's unit.
- **`README.md`** — user-facing project description.

## Workflow patterns

- **For feature work**: skim CLAUDE.md (this file) → read relevant section of architecture.md → check backlog.md for the matching category to surface Max's framing and any open items (proactively flag adjacent `?` items) → check lessons.md for related gotchas → propose design (if non-trivial) → implement → test.
- **Before declaring any Composer change done**: `pnpm typecheck` + `pnpm -r build` + `pnpm check:boundaries` + `pnpm test:composer` (full tier, requires `pnpm dev` — the umbrella proxy — in another terminal; the suite hits `http://localhost:5170/composer/`). The suite fails on any unhandled console error, cursor-position regression, model invariant break, roundtrip drift, or keystroke-dispatch issue. For visual diffs, open `tools/composer-test/out/<name>.png` against `tools/composer-test/baselines/<name>.png`; if the diff is intentional, re-run with `--update-baselines`.
- **For debugging**: reproduce symptom → check lessons.md for similar past issues → narrow scope → propose hypothesis → test it before pursuing.
- **For new modules**: place under appropriate `src/` subdirectory (audio, midi, midi-io, lumatone, tuning, layout, render, recording, transcription, ui, state, effects, input, bridge, composer, analyzer, notation, shared, engine). Keep modules focused on one concern. Export a small surface; hold internal state private.
- **Composer-side code** lives under `src/composer/` and is allowed to import `src/bridge/`, `src/shared/`, plus a narrow set of pure helpers (`src/transcription/pitch.ts`, `src/tuning/notes.ts`). It must NOT import `src/audio/`, `src/midi/`, `src/state/`, or `src/lumatone/` — those are HKL-side concerns and the bridge protocol exists specifically to keep Composer independent of them.
- **Analyzer-side code** lives under `src/analyzer/` (entry point `analyzer.html` at project root). It may import `src/shared/`, `src/engine/`, `src/bridge/` (Phase 2), and the existing pure-browser engine modules at `analyzer/*.js` (`analyzer-analysis.js`, `analyzer-instruments.js`, `k-weighting.js`, `analyzer-visualization.js`). It must NOT import `src/audio/`, `src/midi/`, `src/state/`, `src/lumatone/`, `src/render/`, or `src/composer/`. Heavy signal-processing runs in `src/analyzer/pipeline-worker.ts` (Vite `?worker` import); main-thread `decodeAudioData` ships per-channel Float32Arrays to the worker as transferables. The dev sidecar `analyzer/HexKeyLab-analyzer.html` still exists for batch inspection; the new UI is the user-facing path. CLI workflow (`analyzer/generate-samples.js` + `analyzer/configs/*.json`) is unchanged and remains the source of truth for shipped instruments.
- **`packages/engine/` (`@hkl/engine`)** is the HKLE (Engine) library — now extracted (was the aspirational `src/engine/`). Holds `segmentLooper.ts` (single-voice multi-segment crossfade chain, used by the analyzer app's audition) and `samples-engine.ts` (the full voice lifecycle + loop-scheduling engine). It is **host-injected and self-contained**: `init(ctx, dest, config?)` takes an instrument-audio provider, a velocity→gain curve, and an optional seam-event sink; `loadInstrument(key, instrDef, …)` takes the instrument definition (the HKL barrel `apps/hkl/src/audio/samples.ts` injects `INSTRUMENTS[key]`). Web Audio APIs are permitted; HKL-app state (voices, MIDI, instruments, UI) is NOT. **`@hkl/engine` MUST import only `@hkl/shared`.** `examples/engine-smoke/` proves standalone consumption. Web Audio is permitted in `@hkl/engine` but not in `@hkl/shared`.
- **`src/notation/`** is the shared Verovio/MEI rendering library — the "spell a chord and engrave it" path used by both HKL Composer's full renderer and HKL's live staff inset (`src/render/staff-inset.ts`). Holds `verovio.ts` (lazy CDN-WASM toolkit loader + one-shot `renderMeiToContainer`), `chord-mei.ts` (grand-staff single-chord MEI builder), `heji-render.ts` (the `transformDocForHeji` + `injectHejiGlyphs` HEJI passes), `accidentals.ts` (pure token↔alteration + (q,r)-alteration helpers), and `verovio-types.ts`. May touch the DOM (it builds/serializes MEI and post-processes SVG) and may import `src/shared/` + `src/tuning/notes.ts`. MUST NOT import `src/audio/`, `src/state/`, `src/midi/`, `src/lumatone/`, `src/render/`, or `src/composer/`. Composer's measure-context `computeAccidentalDisplay` stays in `src/composer/notation/accidentals.ts` (it needs `model/ticks`). Verovio is CDN-loaded, so neither bundle grows; the inset pays the load cost only when "Show staff notation" is first enabled.
- **`src/shared/`** is the cross-app constants folder, seeded for the eventual HKL/HKC/sample-engine/analyzer monorepo split. HKL-side, Composer-side, and Analyzer-side may import from it. Modules under `src/shared/` MUST be pure data — no imports of `src/audio/`, `src/state/`, `src/render/`, DOM globals, or anything that holds runtime state. The load-time IIFE in `src/shared/colors.ts` (which precomputes septimal hue variants from base hues) is the only side effect allowed and runs with zero external dependencies.
- **For commits**: small, focused, with a description that explains *why*, not just *what*.

## What to update when

- **Behavior changes** → update architecture.md
- **Constraints discovered** → add to lessons.md
- **Non-obvious choices made** → append to decisions.md
- **Hardware/protocol facts learned** → update CLAUDE.md (this file) under critical context
- **Future intent / backlog state** → Max edits docs/backlog.md directly; Claude suggests but does not edit.

When in doubt about whether something is worth recording: yes. Future-you will be glad.
