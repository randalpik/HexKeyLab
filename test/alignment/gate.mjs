// Alignment gate (hardware- and server-free): the physical-layout poses of
// apps/hkl/src/layout/physical.ts and the rotation rule in layout/geometry.ts.
//
//   node --import ./test/orchestrator-smoke/register-ts.mjs test/alignment/gate.mjs
//
// Checks:
//   P1  every pose maps the 280 Lumatone keys / 45 QWERTY keys to distinct cells
//       and keeps the key on the anchor (the Lumatone key at (0,0), QWERTY H)
//       on (0,0)
//   P2  left∘right = right∘left = identity; right³ = the point reflection
//   P3  the vertical pose IS the physical layout (baseKeys, qwertyKeyMap)
//   T1  vertical-pose Lumatone tilt == the pre-Alignment atan(dyH / 3dxH), bit for
//       bit, at every hex size
//   T2  the Lumatone tilt levels the posed case row (the (+7, −2) board step)
//   T3  Lumatone rotation pins the outline: every key's screen position in every
//       pose is within 1 px of its vertical-pose position (only the dxH:dyH shear)
//   T4  Vertical Freq and Piano pin the lattice: the tilt ignores the pose
//   F1  under Right every key row is a chain of pure 3:2 fifths in every JI mode
//       and mapping
//   O1  outline poses: Lumatone / QWERTY take the alignment, Piano / None stay
//       vertical; the anchored cells add kbAnchor

import { baseKeys } from '../../apps/hkl/src/layout/baseKeys.ts';
import { qwertyKeyMap } from '../../apps/hkl/src/input/qwerty.ts';
import {
  poseOffset, setAlignment, outlinePose, outlineCells, lumatoneCell, qwertyCell, lumatoneCells,
} from '../../apps/hkl/src/layout/physical.ts';
import { view } from '../../apps/hkl/src/state/view.ts';
import * as geo from '../../apps/hkl/src/layout/geometry.ts';
import { coordExps } from '../../packages/shared/src/freq.ts';
import { MAPPINGS } from '../../packages/shared/src/mapping.ts';

const results = [];
const check = (name, got, want) => results.push({ name, got, want, ok: got === want });
const POSES = ['vertical', 'left', 'right'];
const key = ([q, r]) => q + ',' + r;

/* P1 */
for (const a of POSES) {
  const cells = outlineCells('lumatone', a);
  check(`P1a ${a}: 280 distinct Lumatone cells`, new Set(cells.map(key)).size, 280);
  const i0 = baseKeys.findIndex(([q, r]) => q === 0 && r === 0);
  check(`P1b ${a}: the anchor key stays on (0,0)`, key(cells[i0]), '0,0');
  const q = outlineCells('qwerty', a);
  check(`P1c ${a}: 45 distinct QWERTY cells`, new Set(q.map(key)).size, 45);
  check(`P1d ${a}: QWERTY H stays on (0,0)`, key(poseOffset(a, ...qwertyKeyMap.KeyH)), '0,0');
}

/* P2 */
let lr = 0, rl = 0, r3 = 0;
for (const [u, v] of baseKeys) {
  if (key(poseOffset('left', ...poseOffset('right', u, v))) !== key([u, v])) lr++;
  if (key(poseOffset('right', ...poseOffset('left', u, v))) !== key([u, v])) rl++;
  const t = poseOffset('right', ...poseOffset('right', ...poseOffset('right', u, v)));
  if (key(t) !== key([-u, -v])) r3++;
}
check('P2a: left∘right = identity', lr, 0);
check('P2b: right∘left = identity', rl, 0);
check('P2c: right³ = point reflection', r3, 0);

/* P3 */
check('P3a: vertical pose = baseKeys', outlineCells('lumatone', 'vertical').map(key).join(' '), baseKeys.map(key).join(' '));
check('P3b: vertical pose = qwertyKeyMap', outlineCells('qwerty', 'vertical').map(key).join(' '),
  Object.values(qwertyKeyMap).map(key).join(' '));

/* T1-T4 */
const screen = (cell) => { const p = geo.hexToScreen(cell[0], cell[1]); return [p.sx, p.sy]; };
for (const size of ['small', 'medium', 'large']) {
  geo.setHexSize(size);
  geo.setRotation('lumatone', 'euler', 'vertical');
  check(`T1 ${size}: vertical tilt is the pre-Alignment constant`, geo.tiltAngle, Math.atan(geo.dyH / (3 * geo.dxH)));
}
geo.setHexSize('medium');
for (const a of POSES) {
  geo.setRotation('lumatone', 'euler', a);
  const [, sy] = screen(poseOffset(a, 7, -2));
  check(`T2 ${a}: the posed case row is level`, Math.abs(sy) < 1e-9, true);
}
geo.setRotation('lumatone', 'euler', 'vertical');
const vPos = baseKeys.map(([u, v]) => screen([u, v]));
for (const a of ['left', 'right']) {
  geo.setRotation('lumatone', 'euler', a);
  let worst = 0;
  baseKeys.forEach(([u, v], i) => {
    const [x, y] = screen(poseOffset(a, u, v));
    worst = Math.max(worst, Math.hypot(x - vPos[i][0], y - vPos[i][1]));
  });
  check(`T3 ${a}: Lumatone rotation pins the outline (max ${worst.toFixed(3)} px)`, worst < 1, true);
}
for (const mode of ['verticalFreq', 'piano'])
  for (const m of MAPPINGS) {
    const tilts = POSES.map((a) => { geo.setRotation(mode, m, a); return geo.tiltAngle; });
    check(`T4 ${mode} ${m}: the tilt ignores the pose`, new Set(tilts).size, 1);
  }

/* F1 */
const has = new Set(baseKeys.map(key));
let bad = 0, pairs = 0;
for (const mode of ['5', 'P', 'D', '7', 'V', 'S', 'Y'])
  for (const m of MAPPINGS)
    for (const [u, v] of baseKeys) {
      if (!has.has((u + 1) + ',' + v)) continue;
      const a = coordExps(...poseOffset('right', u, v), mode, m, 0, true);
      const b = coordExps(...poseOffset('right', u + 1, v), mode, m, 0, true);
      const d = b.map((x, i) => x - a[i]).join(',');
      pairs++;
      if (d !== '-1,1,0,0') bad++;
    }
check(`F1: Right rows are pure 3:2 in every JI mode × mapping (${pairs} steps)`, bad, 0);

/* O1 */
setAlignment('right');
check('O1a: Lumatone outline takes the alignment', outlinePose('lumatone'), 'right');
check('O1b: QWERTY outline takes the alignment', outlinePose('qwerty'), 'right');
check('O1c: Piano outline stays vertical', outlinePose('piano'), 'vertical');
check('O1d: None stays vertical', outlinePose('none'), 'vertical');
view.kbAnchorQ = 3; view.kbAnchorR = -2;
const p = poseOffset('right', ...baseKeys[24]);
check('O1e: lumatoneCell = posed offset + kbAnchor', key(lumatoneCell(24)), key([p[0] + 3, p[1] - 2]));
check('O1f: lumatoneCells follows setAlignment', key(lumatoneCells[24]), key(p));
const w = poseOffset('right', ...qwertyKeyMap.KeyW);
check('O1g: qwertyCell = posed offset + kbAnchor', key(qwertyCell('KeyW')), key([w[0] + 3, w[1] - 2]));
check('O1h: a non-note code plays nothing', qwertyCell('Space'), null);
setAlignment('vertical'); view.kbAnchorQ = 0; view.kbAnchorR = 0;

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  (got ${JSON.stringify(r.got)}, want ${JSON.stringify(r.want)})`}`);
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
