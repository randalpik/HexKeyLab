# test/hkl-inspect

Headless console-warning scanners for the **HKL core app** (`apps/hkl/`, served at
`http://localhost:5170/`). HKL has no test harness of its own, so the Chromium scanner reuses
Composer's app-agnostic CDP layer (`../composer-test/lib/{cdp,chromium,console-capture}.mjs`)
pointed at HKL instead of `/composer/`; the Firefox scanner drives Firefox's built-in WebDriver
BiDi remote agent (no geckodriver).

These are **inspection tools**, not pass/fail gates: each drives the app into a state that
exercises the noisy code paths, captures console warnings/errors (Chromium also: failed network
requests), and prints a grouped, de-duplicated report. They always exit 0.

- `console-scan.mjs` — **Chromium** (CDP). `report.mjs` — shared dedup/print helpers.
- `console-scan-firefox.mjs` — **Firefox** (WebDriver BiDi). Max's primary browser.

## Usage

Requires `pnpm dev` running in another terminal (the umbrella proxy at `:5170`).

```sh
pnpm scan:hkl                                          # Chromium: scan + report
pnpm scan:hkl:firefox                                  # Firefox (BiDi): scan + report
node test/hkl-inspect/console-scan.mjs --screenshot /tmp/hkl.png   # Chromium, also save a PNG
ALL=1 pnpm scan:hkl:firefox                            # Firefox: include info/debug levels
HKL_URL=http://localhost:5170/ WAIT_MS=3000 VEROVIO_MS=3000 pnpm scan:hkl
MAPPING=chromatic TUNING=S pnpm scan:hkl:firefox       # set the toolbar layout before the chord
```

## What it does

1. Launches headless Chromium and navigates to HKL, attaching console + network capture
   **before** navigation so boot-time warnings are not missed.
2. Enables `#cbStaff` (Show staff notation) + `#cbHeji` (HEJI accidentals), then holds a
   3-note chord (`A`/`S`/`D`) via CDP key events. This is required because the staff inset —
   and therefore Verovio's WASM, the BravuraText font load, and MEI rendering — loads lazily,
   only once the staff toggle is on and a note is held.
3. Waits for the Verovio render, confirms an `<svg>` actually appeared (so a clean report means
   "clean", not "never triggered"), then reports.

## Report sections

- **CONSOLE** — `console.warning`/`error`/`assert`, browser-level `Log.entryAdded` warnings
  (includes Verovio), and uncaught exceptions, deduped with counts.
- **NETWORK** — requests with HTTP status ≥ 400 and hard loading failures (catches missing
  fonts/assets).

## What neither scanner can capture (important)

Both protocols expose **console-API calls + JS exceptions** (Chromium's CDP adds browser-level
`Log` entries; Firefox BiDi does not). Neither exposes browser-*internal* subsystem warnings:

- **source maps** — only fetched when DevTools is open; headless has no DevTools, so the
  "failed to load source map" warning never fires (both browsers).
- **downloadable-font** warnings and the **WASM `'try'`** engine note — emitted by Firefox's
  font/JS-engine subsystems straight to the Web Console UI via the internal console service,
  not through the console API.

Empirically these three categories produce nothing in either headless scanner even after a full
Verovio render. They have to be fixed from console text pasted out of an interactive Firefox
session. What the scanners *do* catch is the actionable rest — e.g. the MEI "No header" warning
and the empty-`OscillatorType` error. The Chromium NETWORK section also surfaces failed
`.map`/asset requests when they exist.

## Layout screenshots (before/after)

```sh
node test/hkl-inspect/layout-shots.mjs <dir>                  # requires `pnpm dev`
python3 test/hkl-inspect/compare-shots.py <dirA> <dirB> [<heatmapDir>]
```

`layout-shots.mjs` captures one full-page PNG per toolbar combination, driven
through the toolbar's own change events and the Composer bridge: every outline
× rotation × Extend pattern at the default reference, the physical outlines
(and None) under a shifted score-ref (kbAnchor off (0, 0)), and Vertical Freq
under Wicki-Hayden and chromatic — 28 shots, with a `manifest.json`. One
headless Chromium on a private overlay relay, stopped at the end.

`compare-shots.py` reports per shot the pixels that differ at all and exits 1 if
any shot differs; with a heatmap dir, each differing pair gets a full-page
`test/composer-test/heatmap.py` heatmap. Capture the baseline **before** the
change, twice — two runs on the same code must be identical, or the comparison
can't gate anything — then capture again after it. A refactor that must not
move a pixel passes at 28/28 identical.
