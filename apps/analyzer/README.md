# HKL Analyzer

Builds sample-based instruments for HexKeyLab. It finds clean loop points in
sustained samples so notes can be held indefinitely, analyzes decaying ones,
and normalizes every sample's loudness. Two front ends share one DSP package,
`@hkl/analysis` (`packages/analysis/`):

- **The browser app** (`src/`, served at `/analyzer/` by `pnpm dev`): load audio
  files or a CDN sample set and export a `.hki` bundle. How to use it: the
  [Analyzer guide](../../docs/guide/analyzer.md).
- **The Node CLI** (`cli/`): the same analysis, headless and repeatable; it is
  how HKL's shipped instruments were built.

How it works (the loop and decay pipelines, perceptual seam selection, sample
picking, gain normalization) is in
[docs/architecture/analyzer.md](../../docs/architecture/analyzer.md).

## CLI

Needs Node ≥ 22.13, pnpm (`pnpm install` at the repository root), and `ffmpeg`
and `curl` on your `PATH`.

```sh
# 1. Write a config (configs/ is gitignored: configs are local inputs)
$EDITOR apps/analyzer/configs/<key>.json

# 2. Fetch, analyze and pick; writes apps/analyzer/out/
pnpm analyze apps/analyzer/configs/<key>.json

# 3. Read the report: tiers, loop segments, gains, picks
less apps/analyzer/out/<key>-report.md

# 4. Splice the generated entry into apps/hkl/src/audio/samples-data.ts
node apps/analyzer/cli/insert-instrument.js apps/analyzer/configs/<key>.json
pnpm typecheck
```

Then listen in HKL: the tier classifier measures loop coherence, not musical
quality.

`out/` receives `<key>-block.txt` (the `samples-data.ts` entry),
`<key>-report.md` and `<key>-summary.json`; with `"source": "local"` the
samples are also packed into `<key>.hki`, with `<key>-def.json` for external
engine consumers. `.cache/` keeps fetched and decoded audio, so re-runs are
fast. Both are gitignored.

### Config

A minimal config for a CDN sample set:

```json
{
  "instrumentKey": "violin",
  "displayName": "Violin",
  "baseUrl": "https://example.com/violin-mp3/",
  "filePattern": "{NOTE}.mp3",
  "ext": ".mp3",
  "noteStyle": "flat",
  "lowOct": 3,
  "highOct": 7,
  "decays": false,
  "vibrato": true,
  "releaseTime": 0.3,
  "volume": 1.0
}
```

- **`noteStyle`**: how the filenames spell notes: `flat` (`Db`), `sharp`
  (`C#`), `sharp_s` (`Cs`), `sharp_lower` (`c#`) or `salamander` (sparse
  `A`/`C`/`Ds`/`Fs`). `noteSemis` limits which semitones exist; `filePatterns`
  (an array) tries several naming templates per note, in order.
- **`decays`**: `false` for a sustained (looped) instrument, `true` for a
  decaying one. `vibrato: true` smooths steadiness detection on vibrato
  sources.
- **`transpose`**: a frequency divisor, default `1`: the recordings sound at
  their label's frequency ÷ `transpose` (`2` = an octave below the label). The
  browser app asks for semitones instead.
- **Local files**: `"source": "local"` with `"sourceDir"` instead of
  `baseUrl`.
- **Picking and gates**: `pickSpacing`, `keepAllRange`, `keepAllGreenRange`,
  `excludeNotes`, `loudnessEvenness` and per-instrument `gateOpts`; see the
  architecture doc.

### Other tools in `cli/`

- **`hki-regain.mjs`**: re-gains a velocity-layered decay `.hki` (such as an
  Orchestrator export) for consistent perceived loudness; audio untouched.
- **`backfill-gains.js`**: re-measures the gains of instruments already in
  `samples-data.ts`, with the same loudness measure as `generate-samples.js`,
  without re-running loop analysis.
- **`backfill-patterns.js`**: one-off migration that writes the `.pattern`
  sidecars older caches lack.
- **`bundle.js`**: the `.hki` packer `generate-samples.js` calls.
