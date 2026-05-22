# CLAUDE.md — HexKeyLab Project Context

This document is the entry point for any Claude session working on HexKeyLab. Read it first.

## Who you're working with

Max Randal. Music theorist, software engineer, and Lumatone player. Builds HKL as both a personal performance/composition tool and a research instrument for hexagonal isomorphic tuning systems with just intonation. Has deep domain expertise in tuning theory, MIDI, and software architecture; treat him as a peer, not someone who needs hand-holding.

## What HexKeyLab is

A browser-based visualizer, audio engine, and Lumatone controller for hexagonal isomorphic keyboards with arbitrary tuning systems (currently 5-limit JI, 7-limit JI, and 12-TET). It does seven things:

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

Repo at `/home/max/HexKeyLab`, version `1.0.0`. Migration from the v0.9 single-file (`HexKeyLab.html`, ~4200 lines of inline CSS/JS) to a TypeScript + Vite project is complete (~57 modules under `src/`, strict end-to-end). v1.0 feature work is landing on top: pedal revamp, polyphonic aftertouch, persistence, recording/playback, and Lumatone diagnostics are all in.

Stack: TypeScript + Vite + vanilla DOM, modular by domain. **No React, no Redux.** HKL is mostly engine code (audio, MIDI, render, SysEx state machines) — not a UI app. The toolbar UI is small enough to not need a framework. If a framework is later wanted *for the toolbar specifically*, Lit or Solid are the considered options. React was explicitly considered and rejected.

Vite is configured for **multi-page build**: `index.html` (HKL viewer) and `composer.html` (HKL Composer) are separate entry points with separate bundles, sharing `src/*` modules. Verovio WASM is only pulled into the composer bundle.

## How to work with Max

**Style**: Direct, peer-to-peer, technically dense when warranted. Match the register of the conversation. Don't over-explain things he already knows. Don't pad responses with framing. He prefers compact responses unless he asks for depth.

**Trust pattern**: He catches subtle regressions through hands-on testing. Trust him on testable claims; ask before pursuing dead-ends; favor compact responses over comprehensive ones.

**Stop and ask** when hitting circular reasoning, when a problem keeps not yielding to attempts, or when proceeding would commit to a direction he hasn't approved. Don't pursue unverified hypotheses.

**Design before code on complex features**. Simple tweaks can be implemented directly. For non-trivial changes — especially anything touching the audio engine, sample loop logic, SysEx state machines, or coordinate systems — propose the design first.

**Information-theoretic completeness matters to him**. No lossy interval names. Every distinct interval gets a unique name. Naming symmetric across complement pairs. This is a guiding principle for the interval-naming system specifically and a useful tell for his preferences generally.

**Terminology preferences**: Spell out "augmented"/"diminished" (not abbreviated). "Lesser/greater" naming conventions for septimal intervals. Comma decomposition for precision over blanket prefixes like "septimal."

**Verification before claims**. Run `npm run typecheck` and `npm run build` before claiming a change works. Beyond that, **check `tools/` for verification tooling specific to the module you're working in** (e.g., `tools/composer-inspect/` for Composer rendering, `tools/lumatone-cal/` for calibration). If a tool exists for invariant checking or visual verification, run it before AND after the change — model-only verification has repeatedly missed visual / behavioral regressions that the tooling catches in one pass. Re-Read files between edits if intervening tool calls may have modified them; if `Edit` fails with "file modified since read", re-Read and re-attempt the same change before moving on. Search the codebase before saying something doesn't exist.

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

- **`'E'`** — 12-TET.
- **`'5'`** — 5-limit JI. **Default**.
- **`'7'`** — 7-limit JI, **uniform septimal**. Every qm=2 cell (`((q%3)+3)%3 === 2`) is region B with `aDepth=1, aUpper=true`; qm=0 and qm=1 are A-d0. Pure function of qmod3 — fully key-symmetric. Every qm=0 Pythagorean-spine cell has its harmonic 7th (7/4) exactly two rows up in qm=2 of the same r. Dominant 7 = 4:5:6:7 and half-dim 7 = 5:6:7:9 reachable everywhere. 5-limit minor (10:12:15) is the one musical loss; use `'5'` when you want it.
- **`'7-legacy'`** — hidden from the dropdown but preserved end-to-end. The old global-septimal-shift behavior (`septimalMode='global'`, alternating A/B bands shifted along r by `septimalShift`, ▲/▼ seam-shift UI restored). Only reachable by editing `localStorage.hkl.prefs.v1`.

Migration on load: old `'7'` saves become `'7-legacy'`; old `'7x'` saves become `'7'`.

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

For `'7-legacy'` the accidental check intersects over `septimalShift ∈ [0, 5]` so seam shifts can never orphan a placed ref. There is no extra "ref must be in V5 / V7" requirement — the dotted V5 / V7-uniform / V7-legacy outlines (drawn when "Valid ref bounds" is on) are visual aids built from this same check, not a separate gate.

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

**Headless Composer verification tooling** (`tools/composer-inspect/`): use this whenever a Composer change touches rendering, cursor, layout, or DOM structure. Model-state inspection alone has repeatedly missed visual regressions — most commonly "cursor flat-index changes but the rendered bar doesn't move." Requires `npm run dev` running. The `window.__hkl_composer` handle inside any expression exposes `bridge, model, renderer, cursor, reRender`.

- **`inspect.mjs '<expr>'`** — runs a JS expression in a headless Chromium page; prints the result as JSON. Use for ad-hoc DOM/state queries: `node tools/composer-inspect/inspect.mjs '[...document.querySelectorAll("g.accid use")].map(u => u.getAttribute("xlink:href"))'`.
- **`inspect.mjs --screenshot <path> [<expr>]`** — captures the rendered page as PNG (the Read tool renders PNGs visually for you). The optional expression runs first, so you can drive the model into a specific state and screenshot the result. Use to see what Max sees without manual browser cycles.
- **`cursor-trace-all.mjs <outDir>`** — runs every scenario in `scenarios.mjs` (`emptyDoc`, `m1Quarter`, `m1Full`, `m1FullM2Quarter`, `m1FullM2Empty`, `m1PartialM3Full`, `m1FullM2EmptyM3Quarter`, `m1EmptyM2Quarter`) through an in-page cursor-walk that records each position's rendered bbox + the elements before/after the cursor, plus a screenshot. Reports invariant violations: consecutive cursor positions whose rendered rects collide within 3px (= "state changes but pixel doesn't"). Exits non-zero if any violation. **Run this before declaring a cursor-model change done**, and add a new scenario to `scenarios.mjs` for any case under active investigation that isn't already covered.

**Composer test suite** (`tools/composer-test/`): the comprehensive gate. ~50 fixtures across cursor / tuplet / tie / multi-voice / time-sig / key-sig / Ctrl-nav / expression / scroll / bridge / keystroke-dispatch / visual categories. Each fixture runs through 5–9 invariants (MODEL, CURSOR, RENDER, ROUNDTRIP, INPUT, CONSOLE, VISUAL). Full tier finishes in ~15 s; fast tier in ~8 s. **Run `npm run test:composer` before declaring any Composer change done** — it has surfaced regressions that `cursor-trace-all` alone misses (data-tie-partner asymmetry, accidental clamp, roundtrip placeholder-id drift, scroll-into-view, etc.). On failure, the runner emits `tools/composer-test/out/summary.json` plus per-fixture screenshots. See `tools/composer-test/README.md` for adding fixtures.

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
- **`docs/architecture.md`** — what HKL does and how it's organized. Feature-level reference.
- **`docs/lessons.md`** — gotchas, dead-ends, anti-patterns, hard-won truths. Read before debugging anything that smells familiar.
- **`docs/decisions.md`** — append-only log of non-obvious design choices. Add an entry when committing a decision worth remembering.
- **`docs/lumatone-calibration.md`** — how to do per-key hardware calibration via SSH + scripts in `tools/lumatone-cal/`. Only needed when working around the broken macro buttons on Max's unit.
- **`README.md`** — user-facing project description.

## Workflow patterns

- **For feature work**: skim CLAUDE.md (this file) → read relevant section of architecture.md → check lessons.md for related gotchas → propose design (if non-trivial) → implement → test.
- **Before declaring any Composer change done**: `npm run typecheck` + `npm run build` + `npm run test:composer` (full tier, requires `npm run dev` in another terminal). The suite fails on any unhandled console error, cursor-position regression, model invariant break, roundtrip drift, or keystroke-dispatch issue. For visual diffs, open `tools/composer-test/out/<name>.png` against `tools/composer-test/baselines/<name>.png`; if the diff is intentional, re-run with `--update-baselines`.
- **For debugging**: reproduce symptom → check lessons.md for similar past issues → narrow scope → propose hypothesis → test it before pursuing.
- **For new modules**: place under appropriate `src/` subdirectory (audio, midi, midi-io, lumatone, tuning, layout, render, recording, transcription, ui, state, effects, input, bridge, composer, shared). Keep modules focused on one concern. Export a small surface; hold internal state private.
- **Composer-side code** lives under `src/composer/` and is allowed to import `src/bridge/`, `src/shared/`, plus a narrow set of pure helpers (`src/transcription/pitch.ts`, `src/tuning/notes.ts`). It must NOT import `src/audio/`, `src/midi/`, `src/state/`, or `src/lumatone/` — those are HKL-side concerns and the bridge protocol exists specifically to keep Composer independent of them.
- **`src/shared/`** is the cross-app constants folder, seeded for the eventual HKL/HKC/sample-engine/analyzer monorepo split. Both HKL-side and Composer-side may import from it. Modules under `src/shared/` MUST be pure data — no imports of `src/audio/`, `src/state/`, `src/render/`, DOM globals, or anything that holds runtime state. The load-time IIFE in `src/shared/colors.ts` (which precomputes septimal hue variants from base hues) is the only side effect allowed and runs with zero external dependencies.
- **For commits**: small, focused, with a description that explains *why*, not just *what*.

## What to update when

- **Behavior changes** → update architecture.md
- **Constraints discovered** → add to lessons.md
- **Non-obvious choices made** → append to decisions.md
- **Hardware/protocol facts learned** → update CLAUDE.md (this file) under critical context

When in doubt about whether something is worth recording: yes. Future-you will be glad.
