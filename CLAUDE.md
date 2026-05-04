# CLAUDE.md — HexKeyLab Project Context

This document is the entry point for any Claude session working on HexKeyLab. Read it first.

## Who you're working with

Max Randal. Music theorist, software engineer, and Lumatone player. Builds HKL as both a personal performance/composition tool and a research instrument for hexagonal isomorphic tuning systems with just intonation. Has deep domain expertise in tuning theory, MIDI, and software architecture; treat him as a peer, not someone who needs hand-holding.

## What HexKeyLab is

A browser-based visualizer, audio engine, and Lumatone controller for hexagonal isomorphic keyboards with arbitrary tuning systems (currently 5-limit JI, 7-limit JI, and 12-TET). It does five things:

1. **Visualizes** the hex lattice with band/seam structure, color-coded by tuning system
2. **Plays audio** through sample-based instruments (piano, organs, strings, etc.) and oscillators with proper JI tuning
3. **Communicates with the Lumatone** via MIDI input (notes from physical play) and SysEx output (key colors, key remapping, calibration)
4. **Analyzes intervals and chords** with comma-decomposition naming and JI ratio display
5. **Documents tuning theory** through interactive exploration

The companion tool, `HexKeyLab-analyzer.html`, is a dev-only sidecar that generates loop-point data for sample-based instruments. It's not shipped with HKL but is part of the project.

## Project status (2026)

Repo at `/home/max/HexKeyLab`, version `0.10.0-dev`. Migration from the v0.9 single-file (`HexKeyLab.html`, ~4200 lines of inline CSS/JS) to a TypeScript + Vite project is complete: 38 modules under `src/`, strict TypeScript end-to-end, behavior frozen at v0.9 parity. The next change to land is v1.0 feature work, planned separately.

Stack: TypeScript + Vite + vanilla DOM, modular by domain. **No React, no Redux.** HKL is mostly engine code (audio, MIDI, render, SysEx state machines) — not a UI app. The toolbar UI is small enough to not need a framework. If a framework is later wanted *for the toolbar specifically*, Lit or Solid are the considered options. React was explicitly considered and rejected.

## How to work with Max

**Style**: Direct, peer-to-peer, technically dense when warranted. Match the register of the conversation. Don't over-explain things he already knows. Don't pad responses with framing. He prefers compact responses unless he asks for depth.

**Trust pattern**: He catches subtle regressions through hands-on testing. Trust him on testable claims; ask before pursuing dead-ends; favor compact responses over comprehensive ones.

**Stop and ask** when hitting circular reasoning, when a problem keeps not yielding to attempts, or when proceeding would commit to a direction he hasn't approved. Don't pursue unverified hypotheses.

**Design before code on complex features**. Simple tweaks can be implemented directly. For non-trivial changes — especially anything touching the audio engine, sample loop logic, SysEx state machines, or coordinate systems — propose the design first.

**Information-theoretic completeness matters to him**. No lossy interval names. Every distinct interval gets a unique name. Naming symmetric across complement pairs. This is a guiding principle for the interval-naming system specifically and a useful tell for his preferences generally.

**Terminology preferences**: Spell out "augmented"/"diminished" (not abbreviated). "Lesser/greater" naming conventions for septimal intervals. Comma decomposition for precision over blanket prefixes like "septimal."

**Verification before claims**. Run `npm run typecheck` and `npm run build` before claiming a change works. Re-Read files between edits if intervening tool calls may have modified them; if `Edit` fails with "file modified since read", re-Read and re-attempt the same change before moving on. Search the codebase before saying something doesn't exist.

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

## Audio architecture (philosophy)

HKL is **self-contained**. All tuning, layout interpretation, and audio synthesis happens inside HKL. The Lumatone sends MIDI on a fixed (channel, note) addressing scheme; HKL maps those addresses to the current lattice state, computes frequencies from the active tuning system, and renders audio directly through its sample/oscillator engine. No external synth, no Scala/SCL, no per-layout MIDI mappings — one static Lumatone configuration, all interpretation in software.

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
- **`README.md`** — user-facing project description.

## Workflow patterns

- **For feature work**: skim CLAUDE.md (this file) → read relevant section of architecture.md → check lessons.md for related gotchas → propose design (if non-trivial) → implement → test.
- **For debugging**: reproduce symptom → check lessons.md for similar past issues → narrow scope → propose hypothesis → test it before pursuing.
- **For new modules**: place under appropriate `src/` subdirectory (audio, midi, lumatone, tuning, layout, render, ui, state, effects). Keep modules focused on one concern. Export a small surface; hold internal state private.
- **For commits**: small, focused, with a description that explains *why*, not just *what*.

## What to update when

- **Behavior changes** → update architecture.md
- **Constraints discovered** → add to lessons.md
- **Non-obvious choices made** → append to decisions.md
- **Hardware/protocol facts learned** → update CLAUDE.md (this file) under critical context

When in doubt about whether something is worth recording: yes. Future-you will be glad.
