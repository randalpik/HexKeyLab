# Composer staff quantization — plan (own the staff, retire the snap)

Status: **proposal, not approved.** Written 2026-09-03, out of the Phase 3
investigation. Supersedes nothing; it is the follow-on the vertical-ownership
plan did not anticipate, and it is what makes that plan's correctness contract
— *a spliced page equals a full re-engrave of the same pinned MEI* — actually
assertable rather than tolerated.

## 1. What is wrong

Ownership stops at the system boundary. `placeSystems` chooses each SYSTEM's
top; Verovio's engraving decides where each staff sits inside it. Because a
grand staff's lower staff is displaced by content between the staves, the two
staves land at different sub-pixel phases, so no single system-level choice can
make both crisp. `snapStaffLinesToGrid`
(`packages/notation/src/render-presets.ts`) therefore runs AFTER placement and
nudges each `g.staff` by ≤ ½ device pixel.

That second pass mutates the geometry placement just consumed. `measureExtents`
read `above`/`span` before the nudge; the page ends up at `snap(place(x))` while
re-measuring says it should be at `place(snap(x))`. The two differ by up to one
grid step, and since a system's extents feed the top of every system below it,
the error is visible page-wide.

Measured, on the current build with NO edits at all (`cb-mountexact.js`):

| page | 2 | 5 | 9 | 14 | 19 | 23 | 28 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| live actual vs `placePage(extents)` | −4.42 | +4.45 | −4.12 | −8.80 | −7.46 | **0** | −10.0 |

Page 23 reads 0 because its staves were already in phase. One device pixel is
10 user units at scale 100, and the snap is bounded by ½ of one — which is
exactly the spread. The exactness census over 115 edits found the same thing
from the other side: 328 of 338 (edit, page) pairs deviate, median ~9 units,
**identical on both code states** — this predates and is independent of the
Phase 3 window change.

Two consequences worth stating plainly:

- `TOL = 30` in the reference gate exists to absorb this. It was added for the
  wrong reason: not measurement noise, but a real second write the model does
  not account for. It cannot distinguish "exact" from "off by 29 on every
  system", which is how the splice went a long time without satisfying its own
  contract and no test could say so.
- The splice itself is NOT at fault. A before/after probe over 12 edits
  (`cb-survivor.js`, self-validated: a no-op re-render moves nothing) finds
  **zero** systems outside the replaced set moving. Splices faithfully carry
  the mount's deviation; they do not create it.

## 2. The idea

Own the staff, not just the system. One pass decides vertical position, writes
it, and nothing moves afterwards.

The enabling observation: **if every system top is a whole number of grid steps,
each staff's phase becomes independent of where the system is placed.** A
staff's device phase is `(systemTop + staffLocalY) * ds`; when `systemTop * ds`
is integral, the phase depends only on `staffLocalY`, which is system-local
geometry we can correct once, before any placement arithmetic. That breaks the
circularity that forces the current place-then-nudge ordering.

## 3. The algorithm

Per page, in one pass:

1. **Align staff rows (system-local).** For each system, for each staff row,
   compute the ≤ ½px translate that puts its first line on the phase its stroke
   width needs, from the staff's own `y` plus the page-margin origin phase —
   arithmetic, not `getScreenCTM` per staff. Write it. Placement-independent by
   the observation above.
2. **Measure.** `measureExtents` now reads final geometry: nothing will move
   these staves again.
3. **Place, quantized.** `placeSystems` rounds each `top` to a whole grid step.
   `ty = top − ext.staffTop` then moves the system by a whole number of steps,
   so every aligned staff stays aligned.
4. **No snap pass.** `snapPage` disappears from the page path.

Idempotent by construction: re-running on an already-placed page recomputes the
same corrections (zero) and the same tops.

## 4. Changes

- **`render/pagefit.ts`** — `PageFitConstants` gains `grid` (user units per
  device pixel, `1 / ds`) and `phase` (0 or ½, from `evenWidth`). New
  `alignStaffRows(sys, k, originPhase)` doing step 1. `placeSystems` rounds
  `top` to `grid`. `measureExtents` unchanged.
- **`render/render.ts`** — `placePage` calls `alignStaffRows` for every system
  before `measureAndPlace`; the `snapPage` call after placement goes, on the
  mount path and in the splicer's post-surgery loop. `snapSystems` stays for
  scroll view and the frame/inset (single-system, margin-parity crisped, no
  `placeSystems` involved).
- **`render/pagesplice.ts`** — the reference host gets `alignStaffRows` +
  placement identically, so the gate compares like with like; `TOL` drops from
  30 to a float epsilon.
- **`@hkl/notation` `snapStaffLinesToGrid`** — unchanged and still used by
  `packages/notation/src/verovio.ts`. Only Composer's page path stops calling it.

## 5. Preconditions to verify BEFORE writing code

1. **The page-margin origin sits at a known device phase.** `pinExactScale` +
   `crispMarginTop` are designed to guarantee it, but step 1's arithmetic
   depends on it, so measure it across zooms (50/75/100) and page-scale values
   and assert it at runtime rather than assume it.
2. **All `g.staff` groups of one staff ROW within a system share a phase.**
   `measureExtents` reads only the first measure's staves while the snap touches
   every measure's; if they can differ, the model needs a per-measure notion and
   the design changes.
3. **Barlines stay crisp.** They span staves and are deliberately outside
   `g.staff` (`snapBarlines` handles them); confirm moving staves by the same
   amounts we already move them does not regress barline phase.
4. **Section-header bands and the `firstContentTop` header read** survive
   quantization (the band is derived from `contentTop`, which shifts by ≤ ½px).

## 6. Verification

Instruments already exist from the investigation; all must be run before AND
after (lessons.md, "a measurement harness is unvalidated code"):

- `cb-mountexact.js` — every page 0, and the live self-error column 0.
- `cb-exact.js` — the census goes to 338/338 exact, on the whole document.
- `cb-survivor.js` — still zero systems moving outside the replaced set (it is
  already zero; this must not regress).
- `cb-sweep.js`, `allmeasures.sh`, `HKL_INDEX_CHECK=1 run.mjs full`,
  `cb-splice-battery.js` on both code states, `cb-splicecost.js`.
- Visual: sub-pixel shifts are expected on essentially every baseline. They go
  to Max as image pairs before any reseed — the reason is established first
  (docs/lessons.md, 2026-09-03).

The gate change is the point of the exercise: once the census reads 338/338,
`TOL` becomes an epsilon and the correctness contract is asserted rather than
tolerated.

## 7. Risks

- **Every visual baseline shifts by up to a pixel.** Unavoidable; it is the
  defect being fixed.
- **Cumulative rounding.** Each staff is rounded to an ABSOLUTE grid position,
  never by accumulating deltas, so error cannot compound down a page.
- **Zoom/page-scale interaction.** `grid = 1/ds` changes with the preset;
  precondition 1 covers it, and the bounds-probe fixtures cover the rest.
- **Scroll view untouched** — it has one system and no `placeSystems`.
