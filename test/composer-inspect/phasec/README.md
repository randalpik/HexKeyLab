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
  signatures (~33 units) — the C-B re-splice-k−1 case. (Known wart: it
  waits on a renderer field `pendingDirty` that no longer exists, so each
  edit rides its 40 s waitFor timeout — functional but slow; the C-B
  battery below waits on the busy badge instead.)

Phase C-B probes (2026-08-30, findings baked into
`docs/composer-page-splice-design.md` → "Implementation (Phase C-B v1)"):

- **cb-structure.js** — page-mode structural survey: `g.ending` parentage
  (inside `g.system` → whole-system splices carry volta brackets), the
  vertical stacking model (content-driven clearance, no vertical
  justification, margin-anchored first systems), page bottom slack, existing
  system transforms (section-header reserve).
- **cb-window.js** — window fidelity: pin-anchored windowed sub-renders
  (synthetic mRest leader + sb pins, page geometry, tall page, breaks:'line')
  vs an offscreen pinned full render — per-measure x/width, staff-line ys,
  hanging extents, and consecutive-system spacing (the pairwise-locality
  check that lets the splice MEASURE follower dy). Expect delta 0.0 except
  line 0 and section-boundary zones.
- **cb-splice-battery.js** — the C-B acceptance-gate battery: eight edits
  through the live app, each asserting the splice/skip outcome AND a
  document-wide reference compare (every mounted page vs a fresh offscreen
  render of the same pinned MEI: system sequence, per-measure x/width,
  spacing; section-header pages exempt the spacing check — their reserve
  translate is a main.ts injection). Expect allReferenceOk true; spliced
  edits ~400–630 ms wall vs 1.6–3.1 s full renders.
- **cb-focus.js** — three consecutive edits at one spot (sonata measure 100):
  the first may full-render (first-edit-in-region re-break), the rest must
  splice. The probe that found the end-of-score final-barline artifact
  (fixed by the synthetic trailer).

All probes read renderer internals via bracket access
(`renderer['pageBreaks']`, `renderer['pageSplicer']` etc.) — update them if
those fields move.

Conservative-repartition probes (2026-08-30, the reflow-reversibility ruling):

- **cb-noreflow.js** — the reversibility gate at sonata scale: for four edit
  sites, delete a note and undo THROUGH REAL KEYSTROKES (Backspace / Ctrl+Z,
  note-count-checked — a direct `model.deleteAtCursor()` skips `withHistory`,
  so undo silently no-ops and the probe eats a chord per cycle; see
  lessons.md), asserting the partition holds on both steps, `movedLines` is 0,
  and the post-undo geometry matches. Expect 4/4 held, 3/4 bit-exact and the
  4th within a few units of snap noise.
- **cb-noreflow2.js** — two identical delete+undo cycles at one site plus a
  live-vs-fresh-full-render comparison, to tell a one-time transition from a
  per-cycle drift. (Written before the keystroke fix; its numbers are the
  artifact — kept because the live-vs-reference comparator is the useful part.)
- **cb-undodiff.js** — model-level diff of a delete+undo round trip (serialized
  measures + whole-doc). The probe that identified the artifact above.
- **cb-stalemount.js** — after a real splice, force the edited page back to a
  placeholder and re-mount it: the freshly mounted page must draw the CURRENT
  document (pageVirt.stale → re-serialize + re-pin). Expect `staleFlag: true`,
  `ok: true`, remount ~1.5 s (one loadData, off the hot path).

Pagination-ownership + latency probes (2026-08-30):

- **cb-pagination.js** — the gating probe for owning pages: renders the same
  pinned document with `breaks:'line'` (sb pins) and `breaks:'encoded'` (sb +
  pb pins) and compares page count, per-page system split, per-measure
  geometry and load time. Expect identical pagination, 2× faster encoded
  load, and a non-zero justification delta (~52 px) — that delta is the
  accepted one-time respacing.
- **cb-pagerender.js** — renders ONE page in a chosen mode into `#score` for
  screenshotting: `--arg line:3` / `--arg encoded:3` with `--screenshot <path>`
  (both flags are new in runner.mjs, along with `--arg` → `window.__probeArg`).
  This is how the encoded-vs-line question was put in front of Max as images.
- **cb-pageown.js** — pagination-ownership acceptance: pins honored per page,
  no page overflows, live DOM self-consistent with a fresh full render of the
  same pinned MEI, and the user-`<pb>` quirk status (still 37 → 2 pages).
- **cb-profile.js** — attributes ONE steady-state spliced edit by wrapping the
  hot primitives (Verovio loadData/renderToSVG, XMLSerializer, model.serialize)
  and the phase boundaries (mutation, renderComposer, cursor.update). Mounts
  the pages around the edit first, and runs a throwaway edit before measuring
  (the first edit after a derive always full-renders). This is the probe that
  answers "why isn't a splice as fast as editing a short score".

Break-mode forensics + the castoff bootstrap (2026-08-30):

- **cb-modes.js** — renders the same document as `auto` / `smartSb0` / `line` /
  `encoded` and compares per-measure x and width, with a percentile
  distribution. The evidence that the modes space identically-broken music
  differently (median 26 units, max 516) and that `line` ≡ `smartSb0`.
- **cb-whymode.js** — isolates MODE from CONTENT: same pinned data under
  `line` vs `encoded` (409/446 measures differ) versus `encoded` with and
  without `<pb>` (0 differ). Proves the break algorithm is the cause and the
  page-break elements are inert.
- **cb-sbcorrelate.js** — classifies every line by its relation to document
  `<sb>`/`<pb>` and mid-piece `<scoreDef>` landmarks, to test whether the
  spacing difference is a section-break artifact. It is not: 85 of 118 lines
  are "plain" and still drift.
- **cb-linepb.js** — does `breaks:'line'` honor `<pb>`? It does (pagination
  follows the pins exactly, spacing unchanged) — correcting the C-A note.
- **cb-getmei.js / cb-tkapi.js / cb-pagebased.js** — the getMEI investigation:
  call shapes, what this build exposes, and the decisive check that page-based
  `getMEI({scoreBased:false})` yields a partition byte-identical to the SVG
  walk in ~98 ms instead of ~1830 ms.
- **cb-wholenote.js** — rebuilds the `phase3_section_header` fixture and
  measures the whole-note placement and system widths in each mode (the
  extreme case Max flagged). Run with `--no-sonata`.
- **cb-loadcost.js** — forces three derive renders and reports wall time,
  ownership state, whether an idle walk was armed, and whether the first edit
  afterwards splices. The check that the extra first-paint cost happens once.
