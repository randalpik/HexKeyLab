# test/alignment

```sh
node --import ./test/orchestrator-smoke/register-ts.mjs test/alignment/gate.mjs
```

Hardware- and server-free gate for the Layout toolbar's Alignment (docs/decisions.md,
"Alignment: the physical layout's pose on the lattice"): the poses in
`apps/hkl/src/layout/physical.ts` and the rotation rule in `layout/geometry.ts`. Every pose
maps the 280 Lumatone / 45 QWERTY keys to distinct cells and keeps the anchor key on (0,0);
the rotations compose (left∘right = id, right³ = point reflection); the vertical pose is the
physical layout and its Lumatone tilt is the pre-Alignment constant bit for bit at every hex
size; the Lumatone rotation levels the posed case row and keeps every key within 1 px of its
vertical-pose position (the dxH:dyH shear); Vertical Freq and Piano ignore the pose; under Right
every key row is a pure 3:2 chain in every JI mode and mapping; outline poses and anchored cells.
The live behavior is `test/hkl-midi/alignment.mjs`.
