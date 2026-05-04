# HexKeyLab Decisions Log

Append-only log of non-obvious design choices made during the v0.9 → v1.0 migration. Each entry: what we picked, what we rejected, why, and where the decision lives in the code.

---

## Stack: TypeScript + Vite, vanilla DOM

**Picked**: TS + Vite + vanilla DOM, modular by domain. Strict TypeScript, no framework.

**Rejected**: React (rejected explicitly), Lit, Solid, jQuery, vanilla JS in the long run.

**Why**: HKL is mostly engine code (audio, MIDI, render, SysEx state machines) — not a UI app. The toolbar UI is small enough to not need a framework. React would have cost a build step, runtime weight, and a render-cycle abstraction we don't need. If a framework is later wanted *for the toolbar specifically*, Lit or Solid are the considered options.

**Where**: `package.json`, `tsconfig.json`, `vite.config.ts`. Module structure under `src/`.

---

## State pattern: plain objects + effects modules + encapsulated stores for invariant state

**Picked**: Three rules:

1. **Plain state objects** (`export const tuning = { curLayout, septimalEnabled, … }`) for domain state with no invariants beyond "this is the current value". Direct mutation. No setters.
2. **Encapsulated modules** (SampleEngine pattern, generalized) for state with invariants:
   - `lumatone/sysex.ts` — single-message-in-flight queue, ACK matching, busy-retry, predicted snapshot. Private state, public API (`enqueueControl`, `replaceQueue`, `cancel`, `handleResponse`, `query`, `inFlight`).
   - `render/animation.ts` — view animation state machine. Private start/target/animStart; public API (`tweenTo`, `step`, `progress`, `isAnimating`, `duration`).
3. **Effects modules** in `src/effects/` bundle the per-domain fan-out:
   - `onTuningChanged({ rampSec?, colorSync? })` — `rampActiveFreqs + view.hexDirty + draw + (syncLumatoneColors)`
   - `onLayoutChanged()` — `syncLumatoneColors + buildMidiReverse + syncOutput`
   - `onSelectionChanged()` — `syncOutput + draw`

   UI handlers mutate state then call **one** effect — replaces the 3-4 chained sync calls that used to live in every handler.

**Rejected**:
- Setter-function pattern (`setSeptimalEnabled(v)`) — verbose; required two function calls per mutation; setter is just `obj.x = v` in disguise.
- Reactive signals (`@preact/signals-core` or DIY) — adds a reactive abstraction that fights imperative engine code (audio voice mgmt, MIDI send), and HKL doesn't have enough fan-out points to justify the indirection.
- Single god-object store — loses module-level encapsulation; doesn't scale past ~10 domains.

**Why**: HKL has ~6 distinct fan-out points (tuning change, layout change, selection change, audio toggle, MIDI port change, sustain release) — small enough to express as named effect functions. Plain mutation keeps the call sites honest about what they're changing.

**Where**: `src/state/*` (7 plain objects), `src/effects/*` (3 effect functions), `src/lumatone/sysex.ts` + `src/render/animation.ts` (encapsulated stores).

---

## Single static Lumatone configuration in software, not per-layout LTN files

**Picked**: HKL configures the Lumatone *once* with a fixed (channel, note) → (board, key) mapping at the firmware level, and interprets all incoming MIDI in software. Layout switching is purely a software concern; the device's MIDI mapping never changes.

**Rejected**: Distributing per-layout LTN files (one per fingering — natural / flat / sharp) and having the user/Terpstra editor swap them.

**Why**: Layout switching needs to happen *during play* with no audible glitch. Pushing 280 CHANGE_KEY_NOTE messages on every layout switch (~6 seconds at typical SysEx throughput) would block all other communication and produce a visible "wipe". With software-side interpretation, layout switches are instant — only the LED color sync is deferred.

The fixed-MIDI mapping is set up *once* per device-connection in `lumatone/sync.ts` (gated by `lumatone.fixedLayoutSent`). After that, only LED color updates ride the SysEx wire.

**Where**: `lumatone/sync.ts` (initial setup batch), `midi/engine.ts:keyToMidi/buildMidiReverse` (software interpretation).

---

## Lumatone board map `[1,2,3,5,4]` is per-unit

**Picked**: Hard-code `sysexBoardMap = [1, 2, 3, 5, 4]` in `lumatone/protocol.ts`.

**Why**: Boards 3 and 4 are physically swapped on Max's specific Lumatone unit. The naïve `[1,2,3,4,5]` would light the wrong physical boards. Other units wouldn't necessarily need this swap. Documenting in CLAUDE.md (`Critical hardware context`) so a future contributor with a different unit can adjust.

**Where**: `lumatone/protocol.ts:sysexBoardMap`. Used by `lumatone/sync.ts` and the message-builder helpers.

---

## SysEx queue: Option B (in-place swap, in-flight completes naturally)

**Picked**: When a new color sync starts mid-flight, replace the queue but let the in-flight message complete naturally. The new diff folds the in-flight message's intended state into its diff via `sysex.inFlight` (the predicted snapshot).

**Rejected**: Cancelling the in-flight message (Option A) — caused stuck colors when an ACK landed after the new queue was built but before the diff incorporated the predicted state.

**Why**: SysEx ACKs are atomic — the device commits the message either fully or not at all. Cancelling mid-flight produces inconsistent device state. Letting messages complete + folding their intent into the next diff is race-free.

**Where**: `lumatone/sysex.ts:replaceQueue` (in-place swap), `lumatone/sync.ts` (predicted-snapshot trick using `sysex.inFlight`).

---

## Inline-handler bridge (Phase 1 holdover, removed 2026-05-04)

**Picked**: For Phases 1–3, kept `index.html` inline `onclick=`/`onchange=` attributes and exposed the relevant module-scoped handlers on `window` via `Object.assign(window, { … })` at the end of `ui/init.ts`. Removed in Phase 4.1 (2026-05-04) — `index.html` is now wired entirely through `addEventListener` in `ui/init.ts`, and the `Window` interface in `src/types.ts` no longer carries bridge functions (only `AudioContext`/`webkitAudioContext`, which are real platform globals).

**Why kept for the migration**: Removing required dropping 14 inline-handler attributes from `index.html` and adding `getElementById` + `addEventListener` calls in `ui/init.ts`. Mechanical but cross-cutting; kept the scope of Phase 3 to module structure + types.

**Where (post-removal)**: `src/ui/init.ts` ("Toolbar wiring" section, ~14 listener registrations), `index.html` (no inline handlers; one new id `btnResetPedal` was added on the calibration reset button).

---

## Strict TypeScript end-to-end (Phase 4 complete, 2026-05-04)

**Picked**: `tsconfig.json strict: true`, no `@ts-nocheck` anywhere in `src/`.

**History**: Phases 1–3 left two `@ts-nocheck` holdouts — `audio/samples.ts` (1494-line v0.9 IIFE) and `render/draw.ts` (538 lines). Both were converted in Phase 4 (4.2 and 4.3 respectively). Approach:

- **`render/draw.ts`** — single mechanical pass. Annotated top-level decls (`Set<string>`, `number[]`, `Record<KeyId, DrawnKey>`, etc.), function signatures, forEach/map callbacks, and 3 DOM-checkbox `as HTMLInputElement` casts. The `getContext('2d')` swap pattern (`savedCtx = ctx; ctx = gc; … ctx = savedCtx`) was kept — a typed local `gc` is used and assigned to `ctx` for the duration of the layer build. Zero-cost-blit invariant preserved.
- **`audio/samples.ts`** — pragmatic typing. The IIFE's logic is verbatim from v0.9; the SampleEngine encodes sample-loop invariants (no `source.loop = true`, all wraps via `scheduleSegmentSwitch`, `commitRampSync` integrates in-flight ramp position) that are hard to spot from types alone. Rather than over-specifying with deep voice-shape interfaces, internal helpers use `any` for parameters/voice objects and proper types only at module state, the public-API entry points, and the IIFE return surface. The inline cast in `audio/engine.ts` (`as typeof RawSampleEngine & { INSTRUMENTS: Record<string, InstrumentDef> }`) was removed — `INSTRUMENTS: Record<string, any>` is now declared inside samples.ts.

**Don't refactor SampleEngine internals without reading `lessons.md` first** — adding stricter types could tempt a future contributor to "clean up" the loop scheduler or ramp manager, both of which are tightly coupled through voice state.

**Where**: `tsconfig.json` (strict on, unchanged from Phase 3), `src/audio/samples.ts`, `src/render/draw.ts`, `src/audio/engine.ts` (cast removal).
