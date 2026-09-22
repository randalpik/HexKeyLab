# test/hkl-midi

Behavioral gate for HKL's **Lumatone MIDI input path** — device-departure
handling and the opt-in power-off note guard.

Requires `pnpm dev` running (the umbrella proxy at `:5170`).

```sh
node test/hkl-midi/departure.mjs     # exits non-zero on any failed check
```

Unlike `test/hkl-inspect/` (console *inspection*, always exits 0), this is a
pass/fail gate. **Run it before declaring any change to `midi/handler.ts` or
`midi/engine.ts` done.**

## Why it is shaped this way

The modules are imported live from the dev server (`/src/midi/handler.ts`), so
the test drives the same module instances the running app uses rather than a
reconstruction. Messages are delivered through a **simulated `MIDIInput`'s
`onmidimessage`**, exactly as the browser delivers them — which is what makes
"the port was detached" a meaningful assertion: after a departure the fake
port's handler is null, so a replayed burst genuinely cannot reach the app.

Web MIDI is denied in headless Chromium (the console line about it is
expected); the fake ports are what the test installs instead.

## Adding cases

`check(name, got, want)` inside the in-page script; scenarios are grouped by
letter with a comment banner. Timing-sensitive guard cases `await sleep(80)`
to clear the 25 ms window with margin.
