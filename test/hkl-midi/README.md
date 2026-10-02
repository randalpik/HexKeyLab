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

`engine.ts` and `heartbeat.ts` are imported by the exact URL `handler.ts`
imports them by (read from its transformed source). Once a module has been
hot-reloaded, Vite serves its importers a `?t=<stamp>` URL, so a bare
`/src/midi/engine.ts` import would be a *second* instance with no release
handler registered, and the departure checks would test the wrong object.

## Adding cases

`check(name, got, want)` inside the in-page script; scenarios are grouped by
letter with a comment banner. Timing-sensitive heartbeat cases derive their
waits from the exported `HEARTBEAT_*` constants rather than hardcoding them.
