# Bounds probe

Standalone Node scripts that characterize HKL's canvas-sizing and Tenney-Height invariants. Used to derive the per-`(rotation × outline)` bounds the renderer needs, and as a regression test for the octave-consistency property of the TH-based enharmonic resolver.

These scripts re-derive their answers from the source — when the lattice geometry, tuning math, or cell sets change, re-run them and update any hardcoded bounds in `src/render/canvas.ts` to match.

**The piano-outline bounds in `src/render/canvas.ts` are HARDCODED from this probe's output.** The picker iteration is too expensive to run at every rotation/tuning change (multiple seconds in production), so the canvas reads from a precomputed `PIANO_BOUNDS_TABLE` keyed by `(rotation, tuning bucket)`. Re-run `compute-bounds.mjs` and paste the new `kbMinW × CH` values into that table whenever the picker math or geometry changes.

## Files

| Script | Purpose |
|---|---|
| `compute-bounds.mjs` | Prints the `kbMinW × CH` matrix for every `(rotation × outline)` pair. The piano column unions across `refQ ∈ {0,1,2}` × `septimalShift ∈ [-21, 20]` × `{5-limit, 7-limit}` — the full set of states the user can reach without further canvas resize. |
| `octave-consistency.mjs` | Verifies that the TH-based picks in `tenneyHeightFromExps` are octave-consistent: MIDI N picks `(q, r)` ⇒ MIDI N+12 picks `(q+3, r)`. Run as a regression test after touching `src/tuning/ratios.ts`. |

## When to re-run

- **Adding a rotation, outline mode, or instrument-key-set** → re-run `compute-bounds.mjs`, update `src/render/canvas.ts` bounds tables if the matrix shifts.
- **Changing `hexR`, `dxH`, `dyH`, or any `TILT_*` constant** in `src/layout/geometry.ts` → re-run `compute-bounds.mjs`.
- **Changing the QWERTY transpose range (`QWERTY_TRANSPOSE_MIN/MAX`), `layoutShifts`, or `septimalShift` wrap range** → re-run `compute-bounds.mjs`. Update `SEPTIMAL_SHIFT_MIN/MAX` and `QWERTY_TRANSPOSE_*` at the top of the script if those source-of-truth values move.
- **Changing `jiRatio`, `regionInfo`, or Tenney-Height computation** in `src/tuning/{ratios,regions}.ts` → re-run **both** scripts. `octave-consistency.mjs` must exit 0; `compute-bounds.mjs`'s piano column will reflect the new cell shape.
- **Adding the syntonic-shift cap or other refNote-bounded modes** that could let the piano envelope grow beyond `q ∈ [-29, 29]` / `r ∈ [-11, 11]` → re-run `compute-bounds.mjs` and verify the canvas still fits.

## Output format

`compute-bounds.mjs` prints a matrix like:

```
              lumatone       qwerty         piano          none
verticalFreq  774×896        535×604        929×1268       929×1268
lumatone      912×716        638×463        1254×953       1254×953
piano         972×504        716×307        1456×603       1456×603
```

These are the values `recomputeCanvasBounds()` in `src/render/canvas.ts` should produce for each `(rotation, outline)` state. `kbOffY` is `0` in every cell — the canvas is symmetric about its vertical midline, content not center-fitted via offset.

`octave-consistency.mjs` exits `0` on pass and prints any breaks. Sample output on a clean codebase:

```
--- 5-limit ---
OLD (unreduced TH): 15/228 octave-pairs inconsistent    ← regression history
REDUCED TH        : 0/228 octave-pairs inconsistent
--- 7-limit (sweeping septimalShift) ---
OLD (unreduced TH): N/1140 octave-pairs inconsistent
REDUCED TH        : 0/1140 octave-pairs inconsistent
✓ Reduced TH is octave-consistent (regression test PASSES).
```

## Why these live outside `src/`

The math is also embedded inside the production renderer (`src/render/{canvas,draw}.ts`) and tuning code (`src/tuning/ratios.ts`). These probes deliberately re-implement the math from first principles so they can serve as a cross-check: if a refactor accidentally changes the TH-ranking or canvas-size derivation, the probe's output drifts from the production output and the diff is visible.

The probes' inlined constants (geometry, qwertyKeys row spec, layoutShifts, septimalShift range) MUST stay manually in sync with `src/`. `baseKeys` is parsed dynamically from `src/layout/baseKeys.ts` since that array is long and frequently extended.
