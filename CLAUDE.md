# CLAUDE.md — HexKeyLab Project Context

This document is the entry point for any Claude session working on HexKeyLab. Read it first. It holds what every session needs; detail lives in the doc it belongs to, with a pointer here.

## Who you're working with

Max Randal. Music theorist, software engineer, and Lumatone player. Builds HKL as both a personal performance/composition tool and a research instrument for hexagonal isomorphic tuning systems with just intonation. Has deep domain expertise in tuning theory, MIDI, and software architecture; treat him as a peer, not someone who needs hand-holding.

## What HexKeyLab is

A browser-based visualizer, audio engine, and Lumatone controller for hexagonal isomorphic keyboards with arbitrary tuning systems. It:

1. **Visualizes** the hex lattice with band/seam structure, colored by pitch
2. **Plays audio** through sample-based instruments and oscillators in just intonation
3. **Drives the Lumatone**: MIDI in from physical play; SysEx out for key colors, key layout and calibration
4. **Analyzes intervals and chords** with comma-decomposition naming and JI ratios
5. **Records and plays back** performances as coordinates (`.hkr`), with a deterministic MPE `.mid` round-trip for DAWs
6. **Transcribes recordings** into Composer-native `.hkc` scores
7. **Documents tuning theory** through interactive exploration

Sibling apps in the same repo: **HKL Composer** (`apps/composer/`), a keyboard-driven, Verovio-backed score editor that uses HKL as its input device over a same-origin `BroadcastChannel` bridge; the **Analyzer** (`apps/analyzer/`), dev tooling that generates loop points and gains for sample instruments; the **Orchestrator** (`apps/orchestrator/`), which samples a MIDI device into a velocity-layered `.hki`; and the **overlay host** (below).

## Stack and repo

Repo `/home/max/HexKeyLab`, version `1.0.0`: TypeScript + Vite + vanilla DOM. **No React, no Redux** — HKL is mostly engine code (audio, MIDI, render, SysEx state machines). React was considered and rejected; if the toolbar ever needs a framework, Lit or Solid are the candidates.

A pnpm monorepo (layout, exports map and build details: [docs/architecture.md](docs/architecture.md) → Repo layout):
- **`apps/{hkl,composer,analyzer,orchestrator}/`** — the four Vite apps, each with its own dev server.
- **`apps/overlay-host/`** — a Node server, not a Vite app: the OBS-overlay WebSocket relay plus Composer's local file bridge (`/fs/*`). **On Max's machine it runs permanently as the systemd user service `hkl-overlay-host`**: never start a second host on :5190 (tests bind their own ports); edits to `apps/overlay-host/src/` take effect only after `systemctl --user restart hkl-overlay-host`, which is Max's to run.
- **`packages/{shared,engine,notation,bridge,analysis}/`** — the libraries. DAG: `@hkl/shared ← {engine, notation, bridge} ← apps`, plus `@hkl/analysis` (zero deps) ← {analyzer, orchestrator}. `pnpm check:boundaries` enforces it: `@hkl/shared` is pure data (no DOM/state/runtime), `@hkl/engine` imports only `@hkl/shared`, Composer imports only `@hkl/{bridge,notation,shared}` (never HKL audio/MIDI/state/lumatone), and no app imports another app's `src/`.

### Running and verifying

- **`pnpm dev`** runs the four app servers behind `vite/dev-proxy.mjs` at **one origin, `http://localhost:5170`** (`/`, `/composer/`, `/analyzer/`, `/orchestrator/`). The single origin is mandatory: the `BroadcastChannel` bridges and the `IndexedDB` instrument registry are per-origin. The dev server is Max's — never start or kill it; if none is up, ask him to run it.
- **pnpm, not npm.**
- Before claiming a change works: `pnpm typecheck` (one root `tsc --noEmit` over `apps` + `packages`), `pnpm check:boundaries`, and a build of each touched app — `NODE_OPTIONS=--max-old-space-size=1536 pnpm --filter @hkl/<app> build`, one at a time. **Never the root `pnpm build`** on Max's machine (it ran out of memory).
- Then the module's own tooling under `test/` (and `tools/` for hardware), before AND after the change: model-only verification has repeatedly missed visual and behavioral regressions the tooling catches in one pass.

### Composer verification

- **Test suite** (`test/composer-test/`, ~730 fixtures; needs `pnpm dev`): `pnpm test:composer:affected` for a scoped change (read its report — untested changed lines mean a missing fixture); `pnpm test:composer:fast` for breadth; `pnpm test:composer` (every fixture, ~7 min) once per broad change set. Flags, in-page hooks and debugging: `test/composer-test/README.md`.
- **Every Composer bug fix or feature lands with a fixture** in `fixtures/<category>.mjs` — with an `ASSERTIONS[name]` entry when the universal invariants don't cover the change, and `visualBaseline` for visual coverage.
- **Screenshots come from `visualBaseline` fixtures**, never `inspect.mjs --screenshot` (it resizes the viewport before capturing, so the overlay is stale). `test/composer-inspect/inspect.mjs '<expr>'` is fine for DOM/state queries.
- **Visual diffs** go to Max as a heatmap (`test/composer-test/heatmap.py`), never a side-by-side; re-seed with `--update-baselines` only on his approval.
- **Sonata probes** (`test/composer-inspect/sonata-probes/`, index in its README): whole-document gates against Max's sonata; run the edit-path gates after any change to the refill, splicer, partition or pagination.
- When test pixels disagree with live behavior on the same code, diff the flows (every command the runner issues that a live session doesn't) before hypothesizing about caching or paint timing. Verify file writes by mtime/size, not exit code.

## How to work with Max

### ⚠️ RULE ZERO — Keep Max in the loop: speak before you act, never go silent. ⚠️

Max would always rather redirect a wrong direction in seconds than wait through silence. The failures this rule exists for: multi-minute silent deliberations, bare tool-call messages, and turns that answer a question without looking anything up. Mandatory:

1. **Every message that contains a tool call begins with at least one sentence of visible text** saying what you're about to do ("Reading X to confirm Y"). No exception for "mechanical" calls (todo updates, collecting a background result, re-running a check) — feeling that the sentence is redundant is what this failure feels like from the inside.
2. **Think in small steps, out loud.** Think → speak → act → repeat; keep each private reasoning stretch short enough that an interruption costs seconds, not minutes. In debugging, state hypotheses as they form, even half-formed ones. If you notice a long silent stretch, stop, write a sentence, and continue.
3. **Directives**: "do X" gets a one-line acknowledgement and the first tool call in the same turn. Don't deliberate over near-identical implementations — pick one.
4. **Questions**: first decide whether the answer is already in your context.
   - **It is** → answer in text and end the turn. Don't run tool calls to re-derive what you already have.
   - **It isn't** (it lives in the code, docs, git history, or needs a measurement) → say in a line what you already know and what you'll check ("I'll search lessons/decisions and git history for the 0.85"), then check, then answer the question's intent fully in the same turn. A turn that ends on "I don't know" or "I haven't checked" is a lookup left undone.
   - **About what you did** → verify against the transcript, never reconstruct from memory of intent; private reasoning and emitted output are indistinguishable in hindsight and WILL be confabulated.
5. **Clarifying questions**: one line, then stop — not a multi-option AskUserQuestion menu for something that fits in a sentence.
6. **Background work**: never block on a background task; end the turn and let the completion notification resume work. A long operation you must run in the foreground (CDN downloads, full regens) gets its cause and rough duration stated before it starts.

### Other style

**Style**: Direct, peer-to-peer, technically dense when warranted. Match the register of the conversation. Don't over-explain things he already knows. Don't pad responses with framing. He prefers compact responses unless he asks for depth.

**Trust pattern**: He catches subtle regressions through hands-on testing. Trust him on testable claims; ask before pursuing dead-ends.

**Stop and ask** when hitting circular reasoning, when a problem keeps not yielding to attempts, or when proceeding would commit to a direction he hasn't approved. Don't pursue unverified hypotheses.

**Design before code on complex features**. Simple tweaks can be implemented directly. For non-trivial changes — especially anything touching the audio engine, sample loop logic, SysEx state machines, or coordinate systems — propose the design first.

**Information-theoretic completeness matters to him**. No lossy interval names. Every distinct interval gets a unique name. Naming symmetric across complement pairs. This is a guiding principle for the interval-naming system specifically and a useful tell for his preferences generally.

**Terminology preferences**: Spell out "augmented"/"diminished" (not abbreviated). Interval naming uses a fixed-meaning adjective hierarchy — `lesser/greater`, `acute/grave`, `septimal`, `subminor/supermajor`, `wolf`, with comma decomposition when no override fits. Full semantics in [docs/architecture/hkl.md](docs/architecture/hkl.md) (interval naming); HKL-specific septimal A2/A4/d5/d7 assignments are in decisions.md.

**Look before claiming**. Search the codebase before saying something doesn't exist. Re-Read a file between edits if other tool calls may have modified it; if `Edit` fails with "file modified since read", re-Read and re-attempt the same change before moving on.

**Identifiers are copied, never recalled**. Any opaque identifier in text Max reads — an absolute path, a UUID, a hash, an `xml:id` — is copied from a tool result or looked up with a tool call first, never typed from memory. A sentence that goes wrong is deleted and rewritten, never patched in-stream ("…is not the exact path; the correct one is…"), and a lookup is never handed to Max ("run `ls` to find it"); an optional reference is dropped rather than hedged. The final recap is a deliverable held to the same bar as code.

## Critical hardware context

Non-negotiable constraints. Protocol detail (commands, LED throughput, pedal calibration) is in [docs/architecture/hkl.md](docs/architecture/hkl.md) → Hardware integration.

- **Lumatone is 5 boards × 56 keys = 280 keys.**
- **Boards 3 and 4 are physically swapped on Max's unit** — a runtime toggle (*Calibrate Keys → "Swap boards 3 ↔ 4"*, pref `swapBoards34`, off by default, ON for Max's unit). All SysEx board bytes go through `sysexBoardFor(group)` (`apps/hkl/src/lumatone/protocol.ts`); never hardcode a board map at a call site.
- **The MIDI channel map is 0-indexed in SysEx**: `fixedMidiChannelMap = [0,1,2,3,4]`, independent of the board swap.
- **SysEx envelope**: `F0 00 21 50 <board> <cmd> <data1-4> F7`. When LED updates are pending, prefer another board over the same one — interleaving boards is ~3× faster.
- **A3 = 220 Hz** is the central reference of the tuning system.
- **Pedals**: the expression jack is Roland-wired and fixed to CC 4; the sustain jack is CC 64 (binary). Neither is remappable via SysEx. Korg-style expression pedals read as noise — a wiring mismatch, not a software bug.
- **Power-off emits a burst of protocol-valid spurious note-ons**; the liveness heartbeat (`apps/hkl/src/midi/heartbeat.ts`) clears it rather than filtering it — don't re-propose filters (decisions.md 2026-10-02).
- **Calibration and firmware work** (SSH into the unit, per-key KeyData, the local firmware mirror at `/home/max/lumatone/`): read [docs/lumatone-calibration.md](docs/lumatone-calibration.md) and hkl.md → Lumatone internals first.

## Critical tuning context

- **Coordinate axes**: q = major thirds (5:4), r = **fifths** (3:2). The r axis is fifths, NOT minor thirds — minor thirds are the derived direction (-1, +1). Easy to misremember.
- **Band structure**: 3 keys wide along the q-axis; every key is exactly 2:1 above the key 3 positions to its left. Band index = `floor((q+1)/3)`, position-in-band = `((q+1) % 3 + 3) % 3`.
- **Origin**: A3 sits at (q=0, r=0) with bandOf=0, posInBand=1.
- **Modes**: `TuningMode = 'E' | '5' | 'P' | 'D' | '7' | 'V' | 'S' | 'Y'` = Equal · Ptolemaic · Pythagorean · Semiditonal · Septimal · Schismatic · Syntonic · Polysyntonic (the persisted codes predate the labels; `'V'` is Schismatic). The per-mode tuning lives in exactly one place, `coordExps(q, r, mode, mapping, anchor)` (`@hkl/shared/freq.js`); frequency, ratios, HEJI and color all derive from it. `TuningMode` is declared twice — adding a mode follows the checklist in docs/architecture.md → Tuning system → Adding a tuning mode.
- **Color is one function of the pitch** for every JI mode (Equal's octave cycle is the one separate rule) — never add a per-mode color branch; `test/color-gate/` pins it.
- **Note-name mapping** (`Mapping = 'euler' | 'wickiHayden' | 'chromatic'`, `@hkl/shared/mapping.js`) is orthogonal to the mode: a `(q, r)` means nothing without its mapping, so the mapping travels with every coordinate and shared primitives take it as a **required** argument. Never write Euler arithmetic (`57 + 4q + 7r`, octave `q ± 3`, SC `(±7, ∓4)`) against a frame coordinate — use `coordToMidi(…, mapping)` / `vecFromEuler`. Never branch on `mapping === 'wickiHayden'` (a ternary silently turns any other mapping into Euler) — derive from `COLUMN_STEP` / `bandWidth`, or use a `Record<Mapping, …>` so the compiler enumerates every site.
- Per-mode behavior, the Syntonic/Polysyntonic anchor, the ref-driven layout shift, ref validation, the 88-cell picker and the two band functions are in **[docs/architecture.md](docs/architecture.md) → Tuning system**, the source of truth.

## Architecture & app docs

The "what it is / how it works" reference lives under [`docs/architecture/`](docs/architecture/): the overview ([docs/architecture.md](docs/architecture.md): tuning, color, coordinates, file formats, cross-app flows) plus per-app deep-dives ([hkl.md](docs/architecture/hkl.md), [composer.md](docs/architecture/composer.md), [analyzer.md](docs/architecture/analyzer.md), [orchestrator.md](docs/architecture/orchestrator.md), [engine.md](docs/architecture/engine.md), [overlay.md](docs/architecture/overlay.md)). The philosophy in one line each:

- **Self-contained audio**: all tuning/layout interpretation + synthesis happen in HKL via `@hkl/engine`; the Lumatone sends fixed `(channel, note)`, no external synth / Scala / per-layout mappings.
- **Recording = coordinates, not pitch**: `.hkr` (layout snapshot + coordinate-event stream) is canonical; `.mid` is a deterministic MPE round-trip. Capture hooks live inside the audio-engine note path so every input source records identically.
- **Composer is decoupled**: separate tab, talks to HKL only through `@hkl/bridge`; imports none of HKL's audio/MIDI/state. Engraving is Verovio (MEI in / SVG out); `.hkc` = MEI + `data-q`/`data-r`.
- **OBS overlay = one local relay + read-only mirror**: the performing HKL publishes render state over a localhost WebSocket; a `?overlay` instance (lean, audio/MIDI-free build) renders it transparent in OBS. `apps/overlay-host` is the only relay.

## Browser/runtime context

- **Primary browser**: Firefox. Run Firefox gates yourself, headless.
- **Web MIDI** needs a secure context (localhost or HTTPS); `file://` does NOT work in Firefox — use Chromium for `file://` testing.

## Documentation map

- **`docs/backlog.md`** — Max's source of truth for future direction and the task backlog. **Read-only for Claude**: suggest changes, never edit without explicit permission for that edit.
- **`docs/architecture.md`** + **`docs/architecture/*.md`** — the developer architecture reference (above).
- **`docs/guide/{core,composer,analyzer,orchestrator,overlay}.md`** — the user-facing guides (how to *use* each app), served by the HKL Guide app.
- **`docs/architecture/analyzer.md` → Perceptual seam selection** — the analyzer's perceptual gate methodology. Read before touching analyzer gates or building instrument sets.
- **`docs/lessons.md`** — gotchas, dead-ends, hard-won truths. Read before debugging anything that smells familiar.
- **`docs/decisions.md`** — append-only log of non-obvious design choices.
- **`docs/lumatone-calibration.md`** — per-key hardware calibration over SSH with `tools/lumatone-cal/`.
- **`README.md`** — contributor-facing repo description.

## Workflow patterns

- **Feature work**: CLAUDE.md → the relevant architecture doc → backlog.md's matching category for Max's framing and open items (flag adjacent `?` items) → lessons.md for related gotchas → propose a design if non-trivial → implement → verify (above).
- **Debugging**: reproduce the symptom → check lessons.md → narrow scope → propose a hypothesis → test it before pursuing.
- **New modules** go in the owning app's `src/` or library package per the DAG; keep them focused, with a small exported surface and private internal state.
- **Commits are Max's**: never `git commit`, stash or check out files on his behalf.

## What to update when

- **Behavior changes** → the relevant `docs/architecture/<app>.md` (or `docs/architecture.md` if cross-cutting); if it changes what a user *does* (a control, keystroke or workflow), also the matching `docs/guide/<app>.md`.
- **Constraints discovered** → lessons.md.
- **Non-obvious choices** → decisions.md.
- **Hardware/protocol facts** → docs/architecture/hkl.md → Hardware integration (or docs/lumatone-calibration.md); CLAUDE.md only for a constraint every session must respect.
- **Future intent / backlog state** → Max edits docs/backlog.md; Claude suggests.

When in doubt about whether something is worth recording: yes — in the doc it belongs to.
