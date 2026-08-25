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

## Automated capture+detect mode (`run.mjs`)

Repro + regression gate for `handoff/hkle-inflight-crossfade-cut.md` (teardown
during an in-flight seam crossfade hard-cuts the incoming source — note-off
and tuning-race variants).

```
node test/ramp-stress/run.mjs                 # full scenario set (~6 min real-time)
node test/ramp-stress/run.mjs r1 r2           # subset ('clean' always prepended)
node test/ramp-stress/run.mjs --gate          # exit non-zero on any in-window defect
node test/ramp-stress/detect.mjs out/r1.wav out/r1.events.json   # re-analyze
```

Spawns its own vite server (fresh random port) + headless Chromium; the page
side (`src/repro.js`, `window.__repro`) drives scripted scenarios against a
real-time 44.1kHz AudioContext and records PCM via an AudioWorklet fed from
the engine's `tapMaster` diagnostics tap. Real-time is load-bearing: Cause 2
is a JS-clock-vs-render-thread race that `OfflineAudioContext` cannot exhibit.
Every engine call is logged with a pre-call `pendingSwitch` snapshot, so each
`cancelPendingSwitch` — all are triggered by harness calls — is inferable
without touching the engine under test.

Scenarios (from the handoff's repro recipes): `clean` (validation baseline),
`r1` / `r1-control` (note-off aimed inside / clear of the crossfade),
`r2` / `r2-sharpened` (consumer-cadence retunes / sub-ms hammering across
switchTime), `r2-snipe` (ONE phase-aligned call per seam, fired one quantum
after an observed currentTime flip — maximal odds for the stale-gate race;
the hammer variants self-defeat because every pre-boundary call defers the
seam via scheduleSegmentSwitch's now+5ms clamp), `cadence-{pair40,p100,single}`
(same drag at three command cadences — quantifies the consumer's
40ms-throttle workaround), `melody` (the consumer's exact melody+drone shape).

`detect.mjs` flags single-sample outliers in the **second difference** against
a block-local robust (median) scale, then correlates each defect with the
event log (in-window = the call's clock read sat in
`[switchTime − 4ms, switchTime + xfDur + 5ms]`). The detector is only trusted
after its per-run validation gate: synthetic cuts of the defect's shape
(instant multiplicative dip, 5ms recovery) injected into the clean capture
must hit 100% at depth ≥ 0.2 with zero false positives — a null result from an
unvalidated detector proves nothing. Judge runs categorically (zero vs many),
never by count ratios. Artifacts land in `out/` (`.wav` float32 + events
JSON), listenable directly.

History: the 2026-07-23 sessions localized the failure to seams during active
ramps — `sRampFreq` deferred wrap-aligned scheduling until "settled" (never,
under held stepping), so every wrap degraded to the phase-unvalidated
immediate splice. Fixed 2026-07-24 with ramp-aware seams (see decisions.md
"ramp-aware seams"). Post-fix headless results: 400×1¢ @50ms/60ms (16 seams),
600×1¢ @15ms with overlapping 100ms ramps, −400×1¢ down, winds/brass — all
**0 immediate seams, 0.00¢ settled drift**; 8s no-ramp hold unregressed.

2026-08-25 inflight-crossfade-cut findings (pre-fix baselines, strings.hki,
desktop Chromium): **Cause 1 confirmed** — R1 12/12 cuts detected, all
correlated in-window, mag 0.03–0.14 ∝ vol×progress×|sample| (deterministic per
(seam, offset)); controls categorical zero. **Cause 2 (stale-gate race) did
not reproduce on Chromium** — 60 snipes, 19 with clock reads inside the final
quantum (down to 0.03ms before switchTime), zero cuts: a stop posted while JS
still reads pre-switchTime beats the fade's render on this host. **The real
web-side tuning artifact is the deferral-clamp splice**: a retune call landing
within 5ms of a wrap reschedules the fade at now+5ms, past the validated seam
point — seam-dip floor degrades from 0.807 (clean) to 0.553 @20ms cadence /
0.500 @40ms cadence, with the ten deepest R2 dips ALL at call-gap exactly
5.0ms; one-ramp-per-gesture (`cadence-single`) shows **zero degradation**
(floor 0.807 = clean). The step detector is blind to this dip class — use the
seam-dip RMS comparison (`seamDipStats`, printed per scenario by `run.mjs`)
for it.

Fixed in **engine 2.4.3** (`XFADE_GUARD_S` — in-flight/imminent fades are
never torn down or deferred; see decisions.md 2026-08-25): full `--gate` run
green — R1 12/12 → 0/12, all controls zero, every cadence's seam-dip floor at
the 0.807 clean level, 0 deferred seams (`SeamEvent.deferredMs`) including
under sub-ms hammering. `out/` holds the post-fix captures; pre-fix numbers
live in decisions.md.
