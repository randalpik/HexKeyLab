# Bounds probe

Node scripts that derive HKL's precomputed piano-footprint tables and check the picker's octave-consistency. They run the **real** modules through the repo's TS loader — the picker (`apps/hkl/src/tuning/picker.ts`, the one ranking rule `compute88PianoCoords` uses), the tuning (`coordExps`) and the spelling (`noteName`) — so a table can never disagree with the live picker. Only geometry and the canvas-metrics formula are inlined in `compute-bounds.mjs`.

```sh
node --max-old-space-size=1024 --import ./test/orchestrator-smoke/register-ts.mjs test/bounds-probe/<script>.mjs
```

Run them **one at a time** (`compute-refbounds.mjs` scans ~27 000 candidate refs; ~1¼ min here). Every probe covers every `TUNING_MODES` value under both **note-name mappings** (`euler`, `wickiHayden`); Syntonic / Polysyntonic rank each probed ref as its own home band (the anchor a Ctrl+click would give it).

**The piano-outline bounds in `apps/hkl/src/render/canvas.ts` are HARDCODED from this probe's output.** The picker iteration is too expensive to run at every rotation/tuning change, so the canvas reads a precomputed `PIANO_BOUNDS_TABLE[mapping][rotation][mode]`. `compute-refbounds.mjs` writes `apps/hkl/src/render/refbounds-table.ts` (`VALID_REF_TABLE[mapping][mode]`, the dotted valid-ref boundary) directly; `compute-bounds.mjs` prints the `PIANO_BOUNDS_TABLE` block to paste.

## Files

| Script | Purpose |
|---|---|
| `compute-refbounds.mjs` | Writes `refbounds-table.ts`: every ref whose 88-cell footprint spells with ≤ ±3 accidentals, per mapping × mode. |
| `compute-bounds.mjs` | Prints the `kbMinW × CH` matrix for every `(rotation × outline)` pair. The piano column unions across one band of `refQ` × `refR ∈ [-3,3]` — the states the user can reach without further canvas resize. |
| `octave-consistency.mjs` | Gate: MIDI N and N+12 get the same spelling, one spelled octave apart (where the octave sits is the picker's choice — nearest the ref). Exits non-zero on any break outside Syntonic / Polysyntonic; those are reported — all availability (a spelling's 5-limit pitch can exist in one octave's band and not the next); the tritone tie always takes the augmented 4th, so ties can't break consistency. |

## When to re-run

- **Changing the picker** (`apps/hkl/src/tuning/picker.ts`), the per-mode tuning (`coordExps`), Tenney Height, or spelling → re-run all three. `octave-consistency.mjs` must exit 0.
- **Adding a tuning mode** → re-run `compute-refbounds.mjs` and `compute-bounds.mjs` (both tables are keyed by `TuningMode`).
- **Adding a rotation, outline mode, or instrument-key-set**, or changing `hexR`, `dxH`, `dyH` or any `TILT_*` constant in `src/layout/geometry.ts` → re-run `compute-bounds.mjs`, paste the block if the matrix shifts.
- **Allowing a refR range beyond [-3, 3]** → re-run `compute-bounds.mjs` and verify the canvas still fits.

## Output format

`compute-bounds.mjs` prints a matrix per mapping × mode like:

```
              lumatone       qwerty         piano          none
verticalFreq  1049×515       455×304        1115×418       1115×515
lumatone      1048×282       474×235        1240×345       1240×345
piano         972×504        460×160        1257×307       1257×504
```

These are the values `recomputeCanvasBounds()` in `src/render/canvas.ts` should produce for each `(rotation, outline)` state. `kbOffY` is `0` in every cell — the canvas is symmetric about its vertical midline.

`octave-consistency.mjs` prints one line per mapping × mode and the verdict, e.g.

```
wickiHayden P: 0/3192 octave pairs inconsistent
wickiHayden S: 0/3192 octave pairs inconsistent  (report only: availability)
wickiHayden Y: 436/3192 octave pairs inconsistent  (report only: availability)
✓ spelling is octave-consistent outside S/Y (28728 pairs)
```

## History

Until 2026-10-26 the probes re-implemented the picker, tuning and spelling from first principles as an independent cross-check. With the picker extracted into a pure module (one ranking rule for every mode), they import it instead: a table generated from a drifted copy is wrong silently, which is worse than losing the cross-check (`docs/lessons.md`, "Tools outside the typecheck drift silently"). The octave-consistency gate used to check *positions* (N+12 at `(q+3, r)` / `(q+6, r)`), which is what pinned the footprint to the ref's octave line; it now checks spelling.
