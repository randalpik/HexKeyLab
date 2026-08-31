# Phase C large-score probes (sonata)

The composer-test suite gates the line-break ownership on SMALL docs; these
probes are the large-score battery (446-bar sonata) that validated Phase C-A
and will re-validate Phase C-B. They live here so they don't die with a
session scratchpad (the spike-1/2/3/5 probes did — re-deriving them costs a
session).

Requires: `pnpm dev` running, `chromium` in PATH, and the sonata at
`~/Documents/sonataBr1.musicxml` (override with `SONATA=<path>`).

```
node test/composer-inspect/phasec/runner.mjs test/composer-inspect/phasec/refill-smoke.js
node test/composer-inspect/phasec/runner.mjs test/composer-inspect/phasec/battery.js
```

- **runner.mjs** — loads `/composer/`, imports the sonata via
  `window.__composerImportMusicXml`, waits out the deferred render, then
  evals the probe file's contents as an async IIFE and prints its JSON.
  `--no-sonata` skips the import.
- **refill-smoke.js** — three sonata edits through the live app: asserts the
  refill path (not derive), pins honored verbatim on mounted pages, bounded
  cascade, no-op render stability, and prints the refill timing breakdown
  (`PageLineBreaks.lastRefillStats`).
- **battery.js** — the Phase C-A gate battery: enablement parity (pins +
  breaks:'line' vs the smartSb0 render, per-measure x/width deltas — expect
  0.0) + a six-edit battery (mid-line / line-start / overflow / volta /
  region-end / doc-end) asserting refill path, pins-verbatim, and
  untouched-line geometry stability. NOTE the two known benign readings:
  the edited line counts as "untouched" when the partition doesn't move
  (its internal justification legitimately shifts), and a boundary moving
  next to a scoreDef re-spaces the previous line's end-of-line courtesy
  signatures (~33 units) — the C-B re-splice-k−1 case.

Both probes read renderer internals via bracket access
(`renderer['pageBreaks']` etc.) — update them if those fields move.
