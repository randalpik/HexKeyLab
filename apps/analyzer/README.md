# analyzer/ — instrument sample-set generator

Produces ready-to-paste `samples.ts` blocks from a CDN folder of pitched
instrument samples. The HKL analyzer's loop-finding and pitch-refinement
algorithms run headless via Node, so a full instrument can be generated
without opening the browser.

## Prerequisites

- Node ≥ 18 (uses built-in `fetch` semantics; ESM)
- `ffmpeg` on `PATH` (decoding MP3/WAV → f32 PCM)
- `curl` on `PATH` (fetching from CDN)

The repo's analyzer functions live in `tools/HexKeyLab-analyzer.html`.
This directory loads that file's `<script>` body via `Function()` with
stubbed DOM globals so we can call `prepareLoopVibrato`,
`prepareLoopMacroPeriod`, and `refineFundamentalPeriod` from Node. The
HTML UI continues to work for individual-sample inspection.

## Files

- `generate-samples.js` — single entry point. Fetches every chromatic
  note in the config range, runs the appropriate analysis path,
  classifies samples by quality, picks at ~4-semitone spacing, emits
  a JS block + diagnostic report.
- `insert-instrument.js` — splices the generated block into
  `src/audio/samples.ts`. Replaces an existing block if present, else
  appends.
- `configs/*.json` — one file per instrument. Reproduces the 6
  currently-shipped instruments (5 loop + piano decay) as a regression
  fixture.
- `.cache/` — gitignored; per-instrument fetched and decoded samples.
  Re-runs are fast.
- `out/` — gitignored; generated `<key>-block.txt` and
  `<key>-report.md`. Inspect before insertion.

## Two pipelines

The script branches on `config.decays`:

- **Loop instruments** (`decays: false`, sustained tones — strings,
  organs, winds): runs `prepareLoopVibrato` (if `vibrato: true`) or
  `prepareLoopMacroPeriod`. Each emitted entry has `loopPts`,
  `validStartsByEnd`, `trimStart`, `slopeCV`, and an
  autocorrelation-refined `freq`. Selection prefers green > blue >
  yellow tier within each ±2-semitone window.
- **Decay instruments** (`decays: true`, naturally fading — piano,
  harp, plucked strings): runs only `refineFundamentalPeriod` for
  pitch correction. Emitted entries are minimal `{name, freq}`.
  Selection keeps every valid sample (the soundfont's own sampling
  density).

## Config schema

```json
{
  "instrumentKey": "violin",         // key used in samples.ts
  "displayName": "Violin",           // human-facing name
  "baseUrl": "https://.../violin-mp3/",
  "ext": ".mp3",
  "filePattern": "{NOTE}.mp3",       // {NOTE} is replaced with note name
  "noteStyle": "flat",               // "flat" | "sharp" | "salamander"
  "lowOct": 2,
  "highOct": 7,
  "transpose": 1,                    // 2 if filenames are an octave above audio (Hammond)
  "decays": false,                   // picks the analysis path
  "vibrato": true,                   // ignored when decays:true
  "releaseTime": 0.3,
  "volume": 1.0,
  "gateOpts": {}                     // per-instrument analyzer overrides
}
```

`noteStyle: "salamander"` is for Tone.js Salamander piano: sparse
sampling (every minor third) using `A`, `C`, `Ds`, `Fs` naming.

## Workflow

```
# 1. Author or copy a config
cp analyzer/configs/fluidR3-violin.json analyzer/configs/my-instrument.json
# edit fields as needed

# 2. Generate the block + report
node analyzer/generate-samples.js analyzer/configs/my-instrument.json

# 3. Inspect the report
cat analyzer/out/<key>-report.md

# 4. Splice into samples.ts
node analyzer/insert-instrument.js analyzer/configs/my-instrument.json

# 5. Verify the build
npm run typecheck && npm run build

# 6. Audition in HexKeyLab — the only step Claude can't do.
#    The tier classifier is a coherence proxy, not a musical-quality
#    proxy. Confirm the instrument actually sounds right before commit.
```

## When to add a new instrument

Driven by the `add-instrument` skill (`.claude/skills/add-instrument/`).
Ask Claude: *"Use add-instrument with this CDN: https://..."*. Claude
will gather config fields interactively, run the generator, surface
diagnostics, and on approval splice into `samples.ts`.

## Updating the analyzer

Changes to `tools/HexKeyLab-analyzer.html`'s analysis functions
(`prepareLoopVibrato`, `prepareLoopMacroPeriod`,
`refineFundamentalPeriod`, etc.) flow through here automatically — the
script reads that file fresh on each run. To regenerate every shipped
instrument after an analyzer change:

```sh
for cfg in analyzer/configs/*.json; do
  node analyzer/generate-samples.js "$cfg"
  node analyzer/insert-instrument.js "$cfg"
done
npm run typecheck && npm run build
```

Diff `src/audio/samples.ts` to see what changed.
