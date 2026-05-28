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
6. **Transcribes recordings to sheet music** via a `.hkr` → `.hkc` pipeline (tempo estimation + Ellis-DP beat tracking + per-bar duration Viterbi DP), emitting a Composer-native `.hkc` (MEI) with colored noteheads keyed to the lattice — downloadable or bridged straight to Composer for editing
7. **Documents tuning theory** through interactive exploration

The **HKL Analyzer** (`apps/analyzer/`) is the dev-facing companion: a browser UI plus a Node CLI (`apps/analyzer/cli/`) that batch-generates loop-point + gain data for sample-based instruments from CDN soundfonts. Dev tooling, not shipped to end users, but part of the project.

**HKL Composer** (`apps/composer/`) is a sibling app shipped from the same repo — a keyboard-driven, Verovio-backed score editor that uses HKL as its input device via a same-origin `BroadcastChannel` bridge. Composer holds the MEI/score state; HKL holds the audio/MIDI/tuning state. See [docs/architecture/composer.md](docs/architecture/composer.md).

## Project status (2026)

Repo at `/home/max/HexKeyLab`, version `1.0.0`. Migration from the v0.9 single-file (`HexKeyLab.html`, ~4200 lines of inline CSS/JS) to a strict TypeScript + Vite project is complete; that codebase is now being restructured into a pnpm monorepo (`apps/*` + `packages/*` — see the layout note below). v1.0 feature work is landing on top: pedal revamp, polyphonic aftertouch, persistence, recording/playback, and Lumatone diagnostics are all in.

Stack: TypeScript + Vite + vanilla DOM, modular by domain. **No React, no Redux.** HKL is mostly engine code (audio, MIDI, render, SysEx state machines) — not a UI app. The toolbar UI is small enough to not need a framework. If a framework is later wanted *for the toolbar specifically*, Lit or Solid are the considered options. React was explicitly considered and rejected.

**Repo layout is a pnpm monorepo** (migration in progress — see decisions.md "Per-app split + same-origin dev proxy" and the two prior monorepo entries). There is no top-level `src/` anymore:
- **`apps/{hkl,composer,analyzer}/`** — the three servable apps, each its own package with `index.html` + `vite.config.ts` + `package.json` + `src/`. (Granular paths in this doc written as `src/foo/bar.ts` now live at `apps/hkl/src/foo/bar.ts` unless they're composer/analyzer code.) Each runs its own dev server with scoped HMR.
- **`packages/{shared,engine,notation,bridge}/`** — the library packages (`@hkl/shared`, `@hkl/engine` = HKLE nucleus, `@hkl/notation`, `@hkl/bridge`). DAG: `@hkl/shared ← {engine, notation, bridge} ← apps`. Imports use bare `@hkl/*` specifiers (subpath exports map `./*.js` → `./src/*.ts`); intra-package imports stay relative.

**Running it: `pnpm dev`** spawns all three app servers + `vite/dev-proxy.mjs`, which reverse-proxies them under **one origin `http://localhost:5170`** (`/`→hkl, `/composer/`→composer, `/analyzer/`→analyzer). The single origin is mandatory — the HKL↔Composer/Analyzer `BroadcastChannel` bridge and the `IndexedDB` instrument registry are per-origin. `pnpm build` = `pnpm -r build` (each app to its own `dist/`); `pnpm typecheck` is one root `tsc --noEmit` over `apps` + `packages`. Verovio WASM is CDN-loaded by `@hkl/notation`; the analyzer app bundles its own `pipeline-worker` plus its in-package `analysis/*.js` engine modules. Use **pnpm**, not npm (lockfile is `pnpm-lock.yaml`; `allowBuilds` in `pnpm-workspace.yaml` gates dependency install-scripts — esbuild must stay enabled).

## How to work with Max

### ⚠️ RULE ZERO — Speak before every tool call. No silent extended thinking. ⚠️

**This is the rule Max has had to remind me about most often, including by interrupting silent thinking blocks after 10+ minutes of zero output. If you remember nothing else from this file, remember this. Past violations have included multi-minute, 50k+-token internal deliberations on routine debugging — completely unacceptable.**

Concrete rules — these are not aspirational, they are mandatory:

1. **Before any tool call, write at least one sentence in the user-facing channel** stating what you're about to do, even if it feels obvious. "Looking at X to confirm Y" is fine. Silence is not.
2. **If you genuinely need to think, do it in 1–2 sentence chunks between tool calls**, not in giant blocks. Think → speak → act → repeat. Each thinking block must be small enough that an interruption from Max would only waste seconds, not minutes.
3. **For complex debugging, narrate your hypotheses as you form them**, even half-formed ones. The user would always rather redirect a wrong direction early than wait through silent deliberation. Wrong hypotheses spoken aloud are useful; wrong hypotheses thought silently waste both of our time.
4. **For a directive like "do X," reply with one short acknowledgement and start the tool call in the same turn** — do not deliberate first.
5. **Do not ruminate on which of two near-identical implementations is nicer** — pick one and do it.
6. **If you have a clarifying question, ask it in one line and stop**; do not produce a four-option AskUserQuestion or weigh options silently.

If you catch yourself in a long thinking block, **stop the thinking, write a sentence, and continue**. The cost of breaking up thought is far smaller than the cost of silent walls.

### Other style

**Style**: Direct, peer-to-peer, technically dense when warranted. Match the register of the conversation. Don't over-explain things he already knows. Don't pad responses with framing. He prefers compact responses unless he asks for depth.

**Trust pattern**: He catches subtle regressions through hands-on testing. Trust him on testable claims; ask before pursuing dead-ends; favor compact responses over comprehensive ones.

**Stop and ask** when hitting circular reasoning, when a problem keeps not yielding to attempts, or when proceeding would commit to a direction he hasn't approved. Don't pursue unverified hypotheses.

**Design before code on complex features**. Simple tweaks can be implemented directly. For non-trivial changes — especially anything touching the audio engine, sample loop logic, SysEx state machines, or coordinate systems — propose the design first.

**Information-theoretic completeness matters to him**. No lossy interval names. Every distinct interval gets a unique name. Naming symmetric across complement pairs. This is a guiding principle for the interval-naming system specifically and a useful tell for his preferences generally.

**Terminology preferences**: Spell out "augmented"/"diminished" (not abbreviated). Interval naming uses a fixed-meaning adjective hierarchy — `lesser/greater`, `acute/grave`, `septimal`, `subminor/supermajor`, `wolf`, with comma decomposition when no override fits. Full semantics in [docs/architecture/hkl.md](docs/architecture/hkl.md) (interval naming); HKL-specific septimal A2/A4/d5/d7 assignments are in decisions.md.

**Verification before claims**. Use **pnpm, not npm**. Run `pnpm typecheck` (one root `tsc --noEmit` over `apps` + `packages`), `pnpm -r build` (or `pnpm --filter @hkl/<app> build`), and `pnpm check:boundaries` (enforces the package DAG — see decisions.md) before claiming a change works. Beyond that, **check `test/` for verification tooling specific to the module you're working in** (e.g., `test/composer-inspect/` for Composer rendering, `tools/lumatone-cal/` for calibration). If a tool exists for invariant checking or visual verification, run it before AND after the change — model-only verification has repeatedly missed visual / behavioral regressions that the tooling catches in one pass. Re-Read files between edits if intervening tool calls may have modified them; if `Edit` fails with "file modified since read", re-Read and re-attempt the same change before moving on. Search the codebase before saying something doesn't exist.

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

### Tuning modes (`TuningMode` in `apps/hkl/src/state/persistence.ts`)

`TuningMode = 'E' | '5' | 'P' | 'D' | '7' | 'V'`. Selector displays them in this order with conceptual labels: **Equal · Ptolemaic · Pythagorean · Semiditonal · Septimal · Schismatic**. Persistence values stay the original `'E'/'5'/'7'` plus `'P'/'D'/'V'` so old prefs and `.hkr` recordings load unchanged. ('V' for "variant" was the code first picked, retained for disambiguation even though the label is now "Schismatic" — see the mode entry below.)

**Dual definition gotcha** (agent maintenance checklist when adding a mode): `TuningMode` is declared in TWO places that must stay in sync — `apps/hkl/src/state/persistence.ts` (HKL app state) and `@hkl/shared/freq.js` (shared with Composer, self-contained). Update both type aliases AND the `TUNING_MODES` array in `@hkl/shared/freq.js`. `Record<TuningMode, …>` sites needing new entries: `MODE_LABELS` (`apps/composer/src/notation/retune.ts`), `TUNING_LABELS` (`apps/composer/src/setupDialog.ts` + `apps/hkl/src/bridge/hkl-side.ts`), `PIANO_BOUNDS_TABLE` (`apps/hkl/src/render/canvas.ts`), `VALID_REF_TABLE` (`apps/hkl/src/render/refbounds-table.ts`), `validRefSetByMode`/`validRefPathsByMode` (`apps/hkl/src/render/draw.ts`). Plus `isTuningMode` guards in `apps/hkl/src/state/persistence.ts`, `apps/hkl/src/recording/hkr.ts`, `apps/composer/src/main.ts`, `apps/hkl/src/bridge/hkl-side.ts`; the selector `<option>` in `apps/hkl/index.html`; and the `tuningDescription()` switch in `apps/hkl/src/bridge/hkl-side.ts`. (The two bounds tables are regenerated, not hand-edited — see `test/bounds-probe/`.)

The per-mode behavior (E/5/P/D/7/V), the Schismatic-V details, coloring, and seams are documented in **[docs/architecture.md](docs/architecture.md) → Tuning system** (the human-readable source of truth). All shift dispatch lives in `apps/hkl/src/tuning/regions.ts:regionInfoWithState`; frequency/ratio math is mode-agnostic. Canonical source of truth is `tuning.mode`; `tuning.equalEnabled`/`tuning.septimalEnabled` are derived booleans kept in lockstep by `setTuning()`. Any unrecognized persisted `tuning` reverts to `'5'`.

The **ref-driven layout shift** (`refSpine`), held-voice migration, ref validation, and the octave-consistent 88-cell picker also live in [docs/architecture.md](docs/architecture.md) → Tuning system. Agent-relevant invariant: `validateRefNoteCandidate` (`apps/hkl/src/render/draw.ts`) gates a ref on (1) MIDI ∈ [21,108] and (2) the 88-cell footprint spelling with ≤ ±3 accidentals — no separate "valid-ref" gate exists.

## Architecture & app docs

The human-readable "what it is / how it works" reference lives under [`docs/architecture/`](docs/architecture/) — overview ([docs/architecture.md](docs/architecture.md): tuning, color, coordinates, file formats, cross-app flows) + per-app deep-dives ([hkl.md](docs/architecture/hkl.md), [composer.md](docs/architecture/composer.md), [analyzer.md](docs/architecture/analyzer.md), [engine.md](docs/architecture/engine.md)). Agent-relevant philosophy in one line each:

- **Self-contained audio**: all tuning/layout interpretation + synthesis happen in HKL via `@hkl/engine`; the Lumatone sends fixed `(channel, note)`, no external synth / Scala / per-layout mappings. (→ [engine.md](docs/architecture/engine.md))
- **Recording = coordinates, not pitch**: `.hkr` (JSON: layout snapshot + flat coord-event stream) is canonical; `.mid` is a deterministic MPE round-trip. Capture hooks live inside the audio-engine note path so all input sources record identically. (→ [hkl.md](docs/architecture/hkl.md))
- **Composer is decoupled**: separate tab, talks to HKL only via the resolved `BroadcastChannel` bridge (`@hkl/bridge`); imports none of HKL's audio/MIDI/state. Engraving is Verovio (MEI in / SVG out); `.hkc` = MEI + `data-q`/`data-r`. (→ [composer.md](docs/architecture/composer.md))

**Headless Composer verification tooling** (`test/composer-inspect/`): use this whenever a Composer change touches rendering, cursor, layout, or DOM structure. Model-state inspection alone has repeatedly missed visual regressions — most commonly "cursor flat-index changes but the rendered bar doesn't move." Requires `pnpm dev` running. The `window.__hkl_composer` handle inside any expression exposes `bridge, model, renderer, cursor, reRender`.

- **`inspect.mjs '<expr>'`** — runs a JS expression in a headless Chromium page; prints the result as JSON. Use for ad-hoc DOM/state queries: `node test/composer-inspect/inspect.mjs '[...document.querySelectorAll("g.accid use")].map(u => u.getAttribute("xlink:href"))'`.
- **`inspect.mjs --screenshot <path> [<expr>]`** — captures the rendered page as PNG (the Read tool renders PNGs visually for you). The optional expression runs first, so you can drive the model into a specific state and screenshot the result. Use to see what Max sees without manual browser cycles.
- **`cursor-trace-all.mjs <outDir>`** — runs every scenario in `scenarios.mjs` (`emptyDoc`, `m1Quarter`, `m1Full`, `m1FullM2Quarter`, `m1FullM2Empty`, `m1PartialM3Full`, `m1FullM2EmptyM3Quarter`, `m1EmptyM2Quarter`) through an in-page cursor-walk that records each position's rendered bbox + the elements before/after the cursor, plus a screenshot. Reports invariant violations: consecutive cursor positions whose rendered rects collide within 3px (= "state changes but pixel doesn't"). Exits non-zero if any violation. **Run this before declaring a cursor-model change done**, and add a new scenario to `scenarios.mjs` for any case under active investigation that isn't already covered.

**Composer test suite** (`test/composer-test/`): the comprehensive gate. ~50 fixtures across cursor / tuplet / tie / multi-voice / time-sig / key-sig / Ctrl-nav / expression / scroll / bridge / keystroke-dispatch / visual categories. Each fixture runs through 5–9 invariants (MODEL, CURSOR, RENDER, ROUNDTRIP, INPUT, CONSOLE, VISUAL). Full tier finishes in ~15 s; fast tier in ~8 s. **Run `pnpm test:composer` before declaring any Composer change done** — it has surfaced regressions that `cursor-trace-all` alone misses (data-tie-partner asymmetry, accidental clamp, roundtrip placeholder-id drift, scroll-into-view, etc.). On failure, the runner emits `test/composer-test/out/summary.json` plus per-fixture screenshots. See `test/composer-test/README.md` for adding fixtures.

The suite exposes `window.__hkl_composer.bridge` for direct send/receive, plus in-page test hooks injected once at startup: `window.__test.*` (assertModelState, assertNoTieOrphans, assertBracketRendered, assertCursorInViewport, runRoundTrip, …), `window.__bridgeMock` (a second BroadcastChannel for HKL-side simulation: `sendHeldKeys(notes)`, `captured()`, `drain()`), `window.__cursorTrace(voice, exemptions)` for ad-hoc cursor walks, and `window.__waitForScrollSettle(maxMs)`. When debugging interactively, `node test/composer-test/run.mjs scenario <name> --keep-open` leaves Chromium running so you can attach DevTools and probe these handles.

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
- **`docs/architecture.md`** + **`docs/architecture/{hkl,composer,analyzer,engine}.md`** — the human-readable source-of-truth reference: overview (tuning/color/coords/formats/flows) + per-app deep-dives.
- **`docs/lessons.md`** — gotchas, dead-ends, anti-patterns, hard-won truths. Read before debugging anything that smells familiar.
- **`docs/decisions.md`** — append-only log of non-obvious design choices. Add an entry when committing a decision worth remembering.
- **`docs/lumatone-calibration.md`** — how to do per-key hardware calibration via SSH + scripts in `tools/lumatone-cal/`. Only needed when working around the broken macro buttons on Max's unit.
- **`README.md`** — contributor-facing repo description (structure, run/build).
- **`docs/user-guide.md`** — end-user guide for the HKL viewer app.

## Workflow patterns

- **For feature work**: skim CLAUDE.md (this file) → read relevant section of architecture.md → check backlog.md for the matching category to surface Max's framing and any open items (proactively flag adjacent `?` items) → check lessons.md for related gotchas → propose design (if non-trivial) → implement → test.
- **Before declaring any Composer change done**: `pnpm typecheck` + `pnpm -r build` + `pnpm check:boundaries` + `pnpm test:composer` (full tier, requires `pnpm dev` — the umbrella proxy — in another terminal; the suite hits `http://localhost:5170/composer/`). The suite fails on any unhandled console error, cursor-position regression, model invariant break, roundtrip drift, or keystroke-dispatch issue. For visual diffs, open `test/composer-test/out/<name>.png` against `test/composer-test/baselines/<name>.png`; if the diff is intentional, re-run with `--update-baselines`.
- **For debugging**: reproduce symptom → check lessons.md for similar past issues → narrow scope → propose hypothesis → test it before pursuing.
- **For new modules**: place them in the owning app (`apps/{hkl,composer,analyzer}/src/`) or library package (`packages/{shared,engine,notation,bridge}/`) per the dependency DAG `@hkl/shared ← {engine, notation, bridge} ← apps` (see docs/architecture.md → Repo layout, and per-package responsibilities in docs/architecture/). Keep modules focused; export a small surface; hold internal state private.
- **Import boundaries are enforced by `pnpm check:boundaries`**: a package may import only its declared `@hkl/*` deps, and no cross-package relative reaches. The load-bearing rules: `@hkl/shared` is pure data (no DOM/state/runtime); `@hkl/engine` imports only `@hkl/shared`; Composer never imports HKL audio/midi/state/lumatone (only `@hkl/bridge`/`@hkl/notation`/`@hkl/shared`); no app imports another app's `src/`.
- **For commits**: small, focused, with a description that explains *why*, not just *what*.

## What to update when

- **Behavior changes** → update the relevant `docs/architecture/<app>.md` (or `docs/architecture.md` for cross-cutting)
- **Constraints discovered** → add to lessons.md
- **Non-obvious choices made** → append to decisions.md
- **Hardware/protocol facts learned** → update CLAUDE.md (this file) under critical context
- **Future intent / backlog state** → Max edits docs/backlog.md directly; Claude suggests but does not edit.

When in doubt about whether something is worth recording: yes. Future-you will be glad.
