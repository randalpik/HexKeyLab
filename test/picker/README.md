# Picker gates

Node gates for the 88-cell piano-footprint picker (`apps/hkl/src/tuning/picker.ts`), run on the real modules through the repo's TS loader:

```sh
node --max-old-space-size=1024 --import ./test/orchestrator-smoke/register-ts.mjs test/picker/<script>.mjs
```

Run them one at a time.

| Script | Checks |
|---|---|
| `octave-consistency.mjs` | MIDI N and N+12 get the same spelling, one spelled octave apart (where the octave sits is the picker's choice, nearest the ref). Exits non-zero on any break outside Syntonic / Polysyntonic; those are reported (availability: a spelling's 5-limit pitch can exist in one octave's band and not the next), as is the unbanded layout (Euler has no spelled octave there). |
| `footprint-extent.mjs` | The canvas-height reduction (`footprintExtents`, `footprintHalfHeight`): every ref's footprint is its band position's window, cell for cell; the runtime heights equal brute force over every (position, ref MIDI); every ref-to-anchor offset reproduces one the runtime measures (`footprintAnchorOffsets`: 0–3 in banded Syntonic, 0 elsewhere). About 8 minutes over the nine layouts. |

Both iterate every `MAPPINGS` layout × `TUNING_MODES` value × banding.

## When to re-run

- Changing the picker, the per-mode tuning (`coordExps`), Tenney Height or spelling: both.
- Adding a tuning mode or a layout: both. A mode whose band offset isn't linear in the band distance fails check C until `footprintAnchorOffsets` names its phases.

## History

Until 2026-10-30 this folder was `test/bounds-probe/`: two offline probes that generated `VALID_REF_TABLE` (the ±3-accidental valid-ref region) and printed `PIANO_BOUNDS_TABLE` (hand-pasted canvas sizes from W × 7 sampled refs). Ref validity is now the piano range (decisions.md), and the canvas height is computed at runtime, exactly, from W stitched footprints; this gate checks that computation.
