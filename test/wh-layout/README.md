# test/wh-layout

```sh
node --import ./test/orchestrator-smoke/register-ts.mjs test/wh-layout/oracle.mjs
```

Pure-Node oracle for the Wicki-Hayden note-name mapping (docs/wicki-hayden-spec.md
§2–§3). Imports the real `@hkl/shared` primitives and HKL's `render/colors.ts` and
checks, on wide cell windows in every tuning mode: the §3 interval invariants and
row / major-scale-shape tables, copy spelling (the column cell, an octave lower),
colour (JI: the column's; Equal: by sounding octave; light/dark by own pitch class),
pitch-preserving frame conversion (Schismatic copies → Euler land exactly one schisma
low), and that the 280 Lumatone keys stay 280 distinct cells. No dev server needed;
exits non-zero on failure. **Run it after any change to `@hkl/shared/{mapping,freq,notes,heji}.ts`
or to `render/colors.ts`.** The picker side is covered by
`test/bounds-probe/octave-consistency.mjs`; switching with keys held by
`test/hkl-midi/mapping-switch.mjs`.
