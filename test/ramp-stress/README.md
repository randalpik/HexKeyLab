# ramp-stress — live-ramp repro harness (Intonalogy)

Minimal engine consumer reproducing Intonalogy's retune stress: **one voice,
hold +¢/−¢** (buttons or ArrowUp/ArrowDown) to step the pitch by `step` cents
every `interval` ms, each step issuing `sRampFreq` over `ramp dur` ms.
Exists to reproduce the reported crackles/hiccups/wrong-pitch landings on our
side, with no engine behavior changes, before fixing them in the engine.

Run: `pnpm --filter @hkl/ramp-stress dev` → http://localhost:5197/

- Consumes `@hkl/engine` from **workspace source** (unlike react-consumer's
  built-dist link) so engine edits hot-reload during fix iteration.
- Serves the staged Intonalogy bundles directly (`publicDir` →
  `handoff/intonalogy/`); the dropdown lists file basenames and the engine
  key comes from each bundle's own manifest, so staged-file renames don't
  break it. Regenerate missing bundles per the handoff flow (analyzer
  `generate-samples.js <config> --bundle`).
- Readout: expected pitch (accumulated cents) vs engine target (`voice.freq`)
  vs sounding pitch (derived from `source.playbackRate.value`), drift in
  cents (red > 5¢), sRampFreq call/reject counts, seam-event count.
- Headless driving: `window.__ramp.{noteOn, noteOff, stepHold(dir, n, ms?),
  read}` — `stepHold` paces n steps on a real interval and resolves with the
  readout.

Observed so far (headless Chromium, 2026-07-23): 60×1¢ @50ms/60ms and even
200×1¢ @15ms with overlapping 100ms ramps settle to 0.00¢ drift — the
wrong-pitch landing did not reproduce headless; crackle assessment needs ears
on a live run. Suspect space for the real failures: Firefox
(`cancelAndHoldAtTime` polyfill paths), scheduling contention/GC on device,
seam-crossfade interaction mid-ramp.
