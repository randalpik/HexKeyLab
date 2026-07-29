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
  cents (red > 5¢), sRampFreq call/reject counts, and seam events split by
  `SeamEvent.kind` — `wrap` (clean, pre-scheduled at the validated b→a pair)
  vs `immediate` (panic splice; red if any occur — should be 0).
- Headless driving: `window.__ramp.{noteOn, noteOff, stepHold(dir, n, ms?),
  read}` — `stepHold` paces n steps on a real interval and resolves with the
  readout.

History: the 2026-07-23 sessions localized the failure to seams during active
ramps — `sRampFreq` deferred wrap-aligned scheduling until "settled" (never,
under held stepping), so every wrap degraded to the phase-unvalidated
immediate splice. Fixed 2026-07-24 with ramp-aware seams (see decisions.md
"ramp-aware seams"). Post-fix headless results: 400×1¢ @50ms/60ms (16 seams),
600×1¢ @15ms with overlapping 100ms ramps, −400×1¢ down, winds/brass — all
**0 immediate seams, 0.00¢ settled drift**; 8s no-ramp hold unregressed.
