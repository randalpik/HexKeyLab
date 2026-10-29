# test/hkl-midi

## Color sync ordering (hardware-free)

```sh
node --import ./test/orchestrator-smoke/register-ts.mjs test/hkl-midi/sync-order.mjs
```

Checks full/sparse diffs, an initial in-flight board, single-board exhaustion,
both board maps, and physical top-to-bottom ordering independent of canvas
rotation. Full sweeps must have zero same-board transitions. No dev server or
MIDI device is needed.

## Damper never raises a voice

```sh
node test/hkl-midi/damper.mjs        # requires `pnpm dev`; exits non-zero on failure
```

Invariant gate for the per-voice damper ratchet (`applyDamperToVoice`): a
partial lift lowers a sustained voice, and nothing after it (re-press,
sostenuto on/off, a seeded random pedal walk) schedules a rise on its
`damperGain`. Uses an oscillator voice and records every value scheduled on
the AudioParam, so it holds whether or not headless Chromium runs the
AudioContext. **Run it before declaring any change to `setDamperDepth`,
`sostenutoOn/Off`, or the note-off sustain path done.**

## Device departure and liveness heartbeat

Behavioral gate for HKL's **Lumatone MIDI input path** — device-departure
handling, the liveness heartbeat that detects a power-off, and confirmed
re-adoption of a port that reappears.

Requires `pnpm dev` running (the umbrella proxy at `:5170`).

```sh
node test/hkl-midi/departure.mjs     # exits non-zero on any failed check
```

Unlike `test/hkl-inspect/` (console *inspection*, always exits 0), this is a
pass/fail gate. **Run it before declaring any change to `midi/handler.ts`,
`midi/heartbeat.ts` or `midi/engine.ts` done.**

## Held physical inputs release the key they struck

```sh
node test/hkl-midi/held-inputs.mjs   # requires `pnpm dev`; exits non-zero on failure
```

Invariant gate for the held-input registry (`input/held.ts`): a note struck by
a physical key (Lumatone `"ch,note"`, QWERTY `e.code`) releases — and routes
aftertouch to — the `KeyId` it struck, even after an anchor change that did
**not** migrate it. Also covers ref-change migration for both sources, the Clear
button forgetting held records, QWERTY blur, and the damper handoff. Same
harness as `departure.mjs` (live modules resolved through their importers).
**Run it before declaring any change to `input/held.ts`, the Lumatone / QWERTY /
piano note paths, or `effects/onRefChanged.ts` done.**

## Velocity ownership

```sh
node test/hkl-midi/velocity-owners.mjs   # requires `pnpm dev`; exits non-zero on failure
```

Gate for who owns each velocity store (docs/architecture/engine.md → Velocity
architecture, Owners): Composer and `.hkr` playback never leave or read
`audio.keyVelocity`, so a click on a cell after playback strikes at the default
dynamic, not the score's (P, R); the Lumatone's per-key gain and stats follow
the physical key across an anchor change, and the key that slides onto a
calibrated key's old cell is not calibrated (K); v3 prefs keyed by lattice cell
migrate to physical keys under the capture anchor the saved cells prove — A3,
or a whole keyboard saved under a shifted ref — and data no single anchor
explains is dropped (M, each round a reload with seeded prefs). Voices are oscillators; a voice's `vol` is the velocity probe. **Run it
before declaring any change to `velocityCal`, the playback note-on paths,
`keyVelocity`, or `Voice.vel` done.**

## Mapping switch with keys held

```sh
node test/hkl-midi/mapping-switch.mjs   # requires `pnpm dev`; exits non-zero on failure
```

Behavioral gate for `setMapping()` (docs/architecture.md → Note-name mapping). With the
reference at A4 — its spine has q ≠ 0, so the anchor moves on a switch — a held
Lumatone key keeps its `(q,r)` and retunes in place, a held mouse note converts
with its pitch kept, release leaves nothing behind, both directions, and with a
reference change between switch and release. **Run it before declaring any
change to `setMapping`, the held-input registry, or ref anchoring done.**

## Syntonic / Polysyntonic anchor

```sh
node test/hkl-midi/anchor.mjs   # requires `pnpm dev`; exits non-zero on failure
```

Behavioral gate for the anchor (home band) the live app derives from the
reference tiers (docs/architecture.md → Tuning modes, Syntonic / Polysyntonic): a Ctrl+click re-anchors and re-pitches
in place with one deferred fan-out; a composer-source selection never moves it;
the score-ref drives it unless a manual selection overrides; `setAnchorOverride`
pins and releases it; piano input stays in `k = 0` bands; a mid-take re-anchor
writes `a` on the next note-on; outside S/Y nothing reads it. **Run it before
declaring any change to `state/reference.ts`, the 88-cell picker, or recording
capture done.**

## Ref centering

```sh
node test/hkl-midi/ref-centering.mjs   # requires `pnpm dev`; exits non-zero on failure
```

Behavioral gate for the one-authority reference state (docs/architecture.md →
Ref-driven layout shift): walks every path that moves a ref tier — a real
Ctrl+click on the canvas and Composer's `set-reference-note` / `set-score-ref` /
`composer-bye` / `apply-layout` on the live bridge channel, Sync on and off,
outline and mapping switches — and checks after each that the effective ref is
what the tiers call for and the view is centered on it (`view = kbAnchor =
refSpine(ref)` outside the piano outline). Includes a snap landing mid-slide.
**Run it before declaring any change to `state/reference.ts`,
`effects/onRefChanged.ts`, a ref-moving handler, or the view tween done.**

## Fresh profile

```sh
node test/hkl-midi/fresh-profile.mjs   # requires `pnpm dev`; exits non-zero on failure
```

A first session (no saved prefs) must show every select-backed `DEFAULT_PREFS`
value in its `<select>` — assigning a value with no `<option>` silently blanks
the select, which is how the default instrument once drifted from the menu's
"Piano" and played the first note through an empty-type oscillator — and the
audio engine's starting instrument must agree with the pref. Also checks the
hotkeys: `Shift+\` opens Calibrate Keys before its overlay was ever built; a
plain `D` holds a QWERTY note but `Shift+D` doesn't (a modified key is never a
note); with Diagnostics open, `Ctrl+D` is claimed by the overlay and holds no
note. **Run it after changing `DEFAULT_PREFS`, a pref-backed menu's options,
QWERTY input, or a hotkey.**

Every gate here loads HKL through `isolatedHklUrl()`
(`test/composer-test/lib/private-relay.mjs`), so its page publishes to a private
in-process overlay relay — never the live one on `:5190`.

## Why it is shaped this way

The modules are imported live from the dev server (`/src/midi/handler.ts`), so
the test drives the same module instances the running app uses rather than a
reconstruction. Messages are delivered through a **simulated `MIDIInput`'s
`onmidimessage`**, exactly as the browser delivers them — which is what makes
"the port was detached" a meaningful assertion: after a departure the fake
port's handler is null, so a replayed burst genuinely cannot reach the app.

Web MIDI is denied in headless Chromium (the console line about it is
expected); the fake ports are what the test installs instead. The fake output
answers heartbeat pings (CMD 33h) on the fake input when "alive" and swallows
them when "dead", which is how a powered-off Lumatone behaves.

Every module is imported by the exact URL the app imports it by, walking the
app's own import edges from `/src/ui/init.ts` (read from each importer's
transformed source). Once a module has been hot-reloaded, Vite serves its
importers a `?t=<stamp>` URL, so a bare `/src/midi/engine.ts` import would be a
*second* instance with no release handler registered, and the checks would
test the wrong object. `depUrl` throws on a missing edge rather than falling
back to the bare path, so an import an app change removes surfaces as a
"not imported by" error instead of a quietly disconnected module; `damper.mjs`
still imports bare paths and is exposed to the same failure after a hot reload.

## Adding cases

`check(name, got, want)` inside the in-page script; scenarios are grouped by
letter with a comment banner. End with `await chrome.stop()` before
`process.exit`: without it the headless Chromium and its /tmp profile outlive
the run (docs/lessons.md, 2026-10-28). Timing-sensitive heartbeat cases derive their
waits from the exported `HEARTBEAT_*` constants rather than hardcoding them.
