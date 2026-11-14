// Easter egg games oracle (docs/local/easter-egg-games.md).
//
// Pure Node gate — no dev server, no browser, no device. Imports the REAL
// modules through the repo's TS loader:
//   node --import ./test/orchestrator-smoke/register-ts.mjs test/games/oracle.mjs
//
//   A  board (games/board.ts): 280 keys; keyAt / keyOffset round trip; a step
//      and its opposite undo each other; every key has two to six neighbors;
//      the rim, recomputed here from baseKeys; the halves — 140 each, split
//      where 4u + v crosses its mean, the two keys on the line by row position,
//      and every key on the side the canvas draws it (the Lumatone rotation's
//      screen x against the outline's mean); HEADINGS runs counter-clockwise
//      on the canvas in 60° steps
//   B  snake (games/snake.ts): the start state; 14 steps to the row's last key
//      and the 15th into the wall; a clockwise and a counter-clockwise turn;
//      three turns reverse into the body; the head may enter the key the tail
//      leaves but no other body key; eating grows by one and replaces the
//      food; a finished game no longer changes; the four food tiers on
//      constructed boards, and no food on a full board; random play over many
//      seeds keeps the body connected and distinct, the food off the snake,
//      and length = 4 + eaten
//   C  motifs (games/motifs.ts): the table (unique games, first note at octave
//      0, every spelling one the lattice produces); the Nokia tune from any E
//      completes on its last note only; a wrong octave or an enharmonic does
//      not; a false start still matches; two motifs sharing a start; the Pong
//      motif (all B) with one bounce too many
//   D  the case's frame and the scene (games/board.ts keyPoint, games/scene.ts):
//      every key where the gate's own turn of baseKeys puts it (centroid at the
//      origin, the board step along x, neighbors one apart, the long sides at
//      ±4.31, x on the side of the key's half); a tile shape is exactly 1, no
//      shape exactly 0, a shape over everything exactly 1 everywhere; a ball on
//      a key covers π/(2√3) of it and nothing of its neighbors; ball, bumper,
//      paddle, dash, and a ball over a dash each within 1% of a brute-force
//      count made here; a ball's total light the same wherever it sits
//   E  Pong (games/pong.ts, and the field in games/board.ts): the long sides
//      through five corner keys each and the ends through nine, both pairs
//      symmetric; the two keys on the center line; the key under a point; key
//      distance; the paddle table (center-line keys, bumper, paddle, too far,
//      a third key, release, a key not honored until pressed again); over every
//      key and every pair, a press is honored exactly when the gate's own
//      geometry says its shape clears the starting place, which leaves both
//      halves 139 keys and 2,812 paddles; a press refused against the ball;
//      no ball on the field until a warning begins; the serve's warning (lit
//      first, six changes, 1.2 s); serves inside the
//      ruled ranges, and those ranges against paths traced here (every whole
//      degree inside bounces at most twice, one degree more bounces a third
//      time, and the module's ball agrees bounce for bounce); reflection off a
//      long side, a bumper, a paddle's side and its round end against the
//      gate's own contact point; no passing through a paddle at speed 100; a
//      goal when the whole ball is past an end, to the other half's player,
//      the pause, the next warning; first to 3; a goal and a long side met in
//      one step, in the order the path meets them; the speed's rise, with no
//      limit, and its drop after a goal; the shapes drawn

import { baseKeys } from '../../apps/hkl/src/layout/baseKeys.ts';
import { hexToScreen, setRotation } from '../../apps/hkl/src/layout/geometry.ts';
import { setAlignment } from '../../apps/hkl/src/layout/physical.ts';
import {
  KEY_COUNT, HEADINGS, keyAt, keyOffset, neighbor, neighbors, touchesEdge, halfOf,
} from '../../apps/hkl/src/games/board.ts';
import {
  newSnake, turn, step, directPath, foodTiers, placeFood, START_LENGTH,
} from '../../apps/hkl/src/games/snake.ts';
import { MOTIFS, parseMotif, createMotifListener } from '../../apps/hkl/src/games/motifs.ts';
import {
  keyPoint, frameStep, keyAtPoint, keyDistance, onCenterLine, FIELD_WALL, FIELD_END, ROW,
} from '../../apps/hkl/src/games/board.ts';
import * as pong from '../../apps/hkl/src/games/pong.ts';
import { whiteShares, TILE_STRIPS } from '../../apps/hkl/src/games/scene.ts';
import { noteName, keyOctave } from '../../packages/shared/src/notes.ts';

let pass = 0, fail = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  if (failures.length < 25) failures.push(`${label}: got ${a}, expected ${e}`);
}

/* A small seeded generator, so every run plays the same games. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const has = new Set(baseKeys.map(([u, v]) => u + ',' + v));
const STEPS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];

/* ───────── A  board ───────── */
{
  check('A key count', KEY_COUNT, 280);
  check('A headings', HEADINGS, STEPS);
  let roundTrip = 0, undo = 0, undoTotal = 0, neighborRange = 0, rimAgree = 0;
  for (let i = 0; i < 280; i++) {
    const [u, v] = keyOffset(i);
    if (keyAt(u, v) === i && u === baseKeys[i][0] && v === baseKeys[i][1]) roundTrip++;
    let onBoard = 0;
    for (let h = 0; h < 6; h++) {
      const n = neighbor(i, h);
      const expected = has.has((u + STEPS[h][0]) + ',' + (v + STEPS[h][1]));
      if ((n >= 0) !== expected) continue;
      if (n < 0) continue;
      onBoard++;
      undoTotal++;
      if (neighbor(n, (h + 3) % 6) === i) undo++;
    }
    if (neighbors(i).length === onBoard && onBoard >= 2 && onBoard <= 6) neighborRange++;
    if (touchesEdge(i) === (onBoard < 6)) rimAgree++;
  }
  check('A keyAt/keyOffset round trip', roundTrip, 280);
  check('A a step and its opposite undo', undo, undoTotal);
  check('A neighbors: 2 to 6, as recomputed', neighborRange, 280);
  check('A rim as recomputed', rimAgree, 280);
  check('A off-board keyAt', keyAt(100, 100), -1);
  const rim = baseKeys.filter((_, i) => touchesEdge(i)).length;
  check('A rim / interior', [rim, 280 - rim], [84, 196]);

  /* halves */
  const left = baseKeys.filter((_, i) => halfOf(i) === 'left').length;
  check('A halves', [left, 280 - left], [140, 140]);
  const mean = baseKeys.reduce((a, [u, v]) => a + 4 * u + v, 0) / 280;
  check('A midline: mean of 4u + v', mean, 1);
  let sideAgree = 0;
  const onLine = [];
  baseKeys.forEach(([u, v], i) => {
    const d = 4 * u + v - mean;
    if (d === 0) { onLine.push([u, v, halfOf(i)]); sideAgree++; return; }
    if ((d < 0 ? 'left' : 'right') === halfOf(i)) sideAgree++;
  });
  check('A every key off the line on its side', sideAgree, 280);
  check('A keys on the line', onLine, [[0, 1, 'right'], [1, -3, 'left']]);

  /* the canvas: the Lumatone rotation draws the case level */
  setAlignment('vertical');
  setRotation('lumatone', 'euler', 'vertical');
  const xs = baseKeys.map(([u, v]) => hexToScreen(u, v).sx);
  const xMean = xs.reduce((a, b) => a + b, 0) / 280;
  let canvasAgree = 0;
  xs.forEach((x, i) => { if ((x < xMean ? 'left' : 'right') === halfOf(i)) canvasAgree++; });
  check('A halves as the canvas draws them', canvasAgree, 280);

  /* HEADINGS counter-clockwise on the canvas (screen y points down) */
  const o = hexToScreen(0, 0);
  const angles = STEPS.map(([du, dv]) => {
    const p = hexToScreen(du, dv);
    return Math.atan2(-(p.sy - o.sy), p.sx - o.sx) * 180 / Math.PI;
  });
  let ccw = 0;
  for (let h = 0; h < 6; h++) {
    const turnBy = ((angles[(h + 1) % 6] - angles[h]) % 360 + 360) % 360;
    if (turnBy > 50 && turnBy < 70) ccw++;
  }
  check('A headings counter-clockwise, about 60° apart', ccw, 6);
}

/* ───────── B  snake ───────── */
const at = (u, v) => keyAt(u, v);
const offsets = (keys) => keys.map((k) => [...keyOffset(k)]);
{
  const s = newSnake(seeded(1));
  check('B start body', offsets(s.body), [[0, 0], [-1, 0], [-2, 0], [-3, 0]]);
  check('B start length', s.body.length, START_LENGTH);
  check('B start heading', HEADINGS[s.heading], [1, 0]);
  check('B start state', [s.eaten, s.over], [0, null]);
  check('B start path', offsets(directPath(s)).map(([u]) => u), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);

  /* start food obeys the full rule, recomputed here */
  const startBody = [[0, 0], [-1, 0], [-2, 0], [-3, 0]];
  const touchesStart = ([u, v]) => startBody.some(([a, b]) =>
    (a === u && b === v) || STEPS.some(([du, dv]) => a + du === u && b + dv === v));
  const interior = ([u, v]) => STEPS.every(([du, dv]) => has.has((u + du) + ',' + (v + dv)));
  const allowed = baseKeys.filter((k) => !touchesStart(k) && interior(k) && !(k[1] === 0 && k[0] > 0));
  check('B start tier 1', offsets(foodTiers(s)[0]), allowed.map((k) => [...k]));
  let foodOk = 0;
  for (let seed = 0; seed < 200; seed++) {
    const f = newSnake(seeded(seed)).food;
    if (allowed.some(([u, v]) => keyAt(u, v) === f)) foodOk++;
  }
  check('B start food in tier 1, 200 seeds', foodOk, 200);

  /* straight to the wall: keep the food out of the way */
  s.food = at(-10, 0);
  for (let n = 1; n <= 14; n++) step(s, seeded(2));
  check('B 14 steps', [offsets(s.body)[0], s.body.length, s.over], [[14, 0], 4, null]);
  const hit = step(s, seeded(2));
  check('B 15th step hits the wall', [hit.head, hit.ate, hit.over, s.over], [-1, false, 'wall', 'wall']);
  const frozen = JSON.stringify(s);
  turn(s, 'cw');
  const after = step(s, seeded(2));
  check('B a finished game does not change', [JSON.stringify(s), after.over], [frozen, 'wall']);
}
{
  const cw = newSnake(seeded(3)); cw.food = at(-10, 0);
  turn(cw, 'cw'); step(cw, seeded(3));
  check('B clockwise turn', [HEADINGS[cw.heading], offsets(cw.body)[0]], [[1, -1], [1, -1]]);
  const ccw = newSnake(seeded(3)); ccw.food = at(-10, 0);
  turn(ccw, 'ccw'); step(ccw, seeded(3));
  check('B counter-clockwise turn', [HEADINGS[ccw.heading], offsets(ccw.body)[0]], [[0, 1], [0, 1]]);
  const two = newSnake(seeded(3)); two.food = at(-10, 0);
  turn(two, 'ccw'); turn(two, 'ccw'); step(two, seeded(3));
  check('B two turns add up', offsets(two.body)[0], [-1, 1]);
  const back = newSnake(seeded(3)); back.food = at(-10, 0);
  turn(back, 'cw'); turn(back, 'cw'); turn(back, 'cw');
  check('B three turns reverse into the body', step(back, seeded(3)).over, 'self');
}
{
  /* a ring of six around (5, 0): the head follows the tail */
  const ring = [[6, 0], [5, 1], [4, 1], [4, 0], [5, -1], [6, -1]].map(([u, v]) => at(u, v));
  const s = { body: ring.slice(), heading: 4, food: at(-10, 0), eaten: 0, over: null };
  const r = step(s, seeded(4));
  check('B the head may enter the key the tail leaves', [r.over, offsets(s.body)[0], s.body.length], [null, [6, -1], 6]);
  check('B ring stays distinct', new Set(s.body).size, 6);
  /* one key longer: the same step now lands on a body key that stays */
  const longer = { body: ring.concat([at(7, -1)]), heading: 4, food: at(-10, 0), eaten: 0, over: null };
  check('B a body key that stays ends the game', step(longer, seeded(4)).over, 'self');
}
{
  const s = newSnake(seeded(5));
  s.food = at(1, 0);
  const r = step(s, seeded(5));
  check('B eating', [r.ate, r.over, s.body.length, s.eaten, offsets(s.body)], [true, null, 5, 1, [[1, 0], [0, 0], [-1, 0], [-2, 0], [-3, 0]]]);
  check('B new food off the snake', s.food >= 0 && !s.body.includes(s.food), true);
  step(s, seeded(5));
  check('B no growth on the next step', s.body.length, 5);
}
{
  /* constructed boards for the tiers: only the set of body keys, the head and
     the heading matter to food placement */
  const all = baseKeys.map((_, i) => i);
  const head = at(0, 0);
  const withHead = (keys) => [head, ...keys.filter((k) => k !== head)];
  const isInterior = (i) => !touchesEdge(i);
  const path = [];
  for (let u = 1; u <= 14; u++) path.push(at(u, 0));
  path.sort((a, b) => a - b); /* the tiers list keys in index order */

  /* tier 2: every free interior key touches the snake */
  const freeOddU = all.filter((i) => isInterior(i) && Math.abs(keyOffset(i)[0]) % 2 === 1 && i !== head);
  const s2 = { body: withHead(all.filter((i) => !freeOddU.includes(i))), heading: 0, food: -1, eaten: 0, over: null };
  const t2 = foodTiers(s2);
  check('B tier 2: tier 1 empty', t2[0].length, 0);
  check('B tier 2: interior, off the path', t2[1], freeOddU.filter((i) => !path.includes(i)));
  check('B tier 2 chosen', t2[1].includes(placeFood(s2, seeded(6))), true);

  /* tier 3: only rim keys are free */
  const s3 = { body: withHead(all.filter(isInterior)), heading: 0, food: -1, eaten: 0, over: null };
  const t3 = foodTiers(s3);
  check('B tier 3: tiers 1 and 2 empty', [t3[0].length, t3[1].length], [0, 0]);
  check('B tier 3: rim keys off the path', t3[2], all.filter((i) => !isInterior(i) && !path.includes(i)));
  check('B tier 3 chosen', t3[2].includes(placeFood(s3, seeded(7))), true);

  /* tier 4: only the direct path is free */
  const s4 = { body: withHead(all.filter((i) => !path.includes(i))), heading: 0, food: -1, eaten: 0, over: null };
  const t4 = foodTiers(s4);
  check('B tier 4: tiers 1 to 3 empty', [t4[0].length, t4[1].length, t4[2].length], [0, 0, 0]);
  check('B tier 4: the path', t4[3], path);
  check('B tier 4 chosen', path.includes(placeFood(s4, seeded(8))), true);

  check('B full board: no food', placeFood({ body: withHead(all), heading: 0, food: -1, eaten: 0, over: null }, seeded(9)), -1);
  check('B random at its ends', [placeFood(s4, () => 0), placeFood(s4, () => 0.999999), placeFood(s4, () => 1)], [path[0], path[13], path[13]]);
}
{
  /* random play */
  let games = 0, steps = 0, eaten = 0, bad = 0;
  const ends = { wall: 0, self: 0 };
  for (let seed = 1; seed <= 300; seed++) {
    const rnd = seeded(seed * 7919);
    const s = newSnake(rnd);
    games++;
    for (let n = 0; n < 2000 && !s.over; n++) {
      /* a player that turns at random and away from a wall when it can, so
         games last long enough to end either way; odd seeds never dodge */
      const roll = rnd();
      if (roll < 0.15) turn(s, 'cw'); else if (roll < 0.3) turn(s, 'ccw');
      if (seed % 2 === 0) {
        for (let tries = 0; tries < 5 && neighbor(s.body[0], s.heading) < 0; tries++) turn(s, rnd() < 0.5 ? 'cw' : 'ccw');
      }
      /* every third seed hunts: of going straight or turning once, take the
         free key nearest the food, so snakes grow long */
      if (seed % 3 === 0 && s.food >= 0) {
        const [fu, fv] = keyOffset(s.food);
        const far = (k) => {
          if (k < 0 || s.body.includes(k)) return Infinity;
          const [u, v] = keyOffset(k);
          return (Math.abs(u - fu) + Math.abs(v - fv) + Math.abs(u + v - fu - fv)) / 2;
        };
        const options = [0, 5, 1].map((d) => ({ d, far: far(neighbor(s.body[0], (s.heading + d) % 6)) }));
        options.sort((a, b) => a.far - b.far);
        if (options[0].d === 5) turn(s, 'cw'); else if (options[0].d === 1) turn(s, 'ccw');
      }
      const before = s.body.slice();
      const next = neighbor(s.body[0], s.heading);
      const r = step(s, rnd);
      steps++;
      if (r.over) {
        const expected = next < 0 ? 'wall' : 'self';
        if (r.over !== expected || JSON.stringify(s.body) !== JSON.stringify(before)) bad++;
        ends[r.over]++;
        break;
      }
      if (r.ate) eaten++;
      const distinct = new Set(s.body).size === s.body.length;
      const connected = s.body.every((k, i) => i === 0 || neighbors(s.body[i - 1]).includes(k));
      const foodOff = s.food >= 0 && !s.body.includes(s.food);
      if (!distinct || !connected || !foodOff || s.body.length !== START_LENGTH + s.eaten || s.body[0] !== next) bad++;
    }
  }
  check('B random play: invariants', bad, 0);
  check('B random play: both endings and some food reached', [games, ends.wall > 0, ends.self > 0, eaten > 0], [300, true, true, true]);
  console.log(`  (random play: ${steps} steps, ${eaten} foods, ${ends.wall} wall / ${ends.self} self)`);
}

/* ───────── C  motifs ───────── */
{
  check('C games unique', new Set(MOTIFS.map((m) => m.game)).size, MOTIFS.length);
  check('C first notes at octave 0', MOTIFS.every((m) => m.notes[0].octave === 0), true);
  /* every spelling is one the lattice produces (noteName's own format) */
  const spelled = new Set();
  for (let q = -6; q <= 6; q++) for (let r = -12; r <= 12; r++) spelled.add(noteName(q, r, 'euler', 0, true));
  check('C spellings exist on the lattice', MOTIFS.every((m) => m.notes.every((n) => spelled.has(n.name))), true);
  check('C A3 at the origin', [noteName(0, 0, 'euler', 0, true), keyOctave(0, 0, 'euler', 0, true)], ['A', 3]);

  const snake = MOTIFS.find((m) => m.game === 'snake');
  check('C Nokia tune', snake.notes.map((n) => n.name + n.octave).join(' '), 'E0 D0 F#-1 G#-1 C#0 B-1 D-1 E-1 B-1 A-1 C#-1 E-1 A-1');
  const play = (listener, notes, base) => notes.map((n) => listener.press(n.name, base + n.octave));
  for (const base of [2, 3, 4, 5, 6]) {
    const heard = play(createMotifListener(), snake.notes, base);
    check('C Nokia from E' + base, [heard.slice(0, -1).every((g) => g === null), heard[heard.length - 1]], [true, 'snake']);
  }
  /* twice in a row: the machine starts over after a match */
  {
    const l = createMotifListener();
    play(l, snake.notes, 5);
    check('C again after a match', play(l, snake.notes, 4).pop(), 'snake');
  }
  /* wrong octave on the third note (F♯ in the E's own octave), then recovery */
  {
    const l = createMotifListener();
    const wrong = snake.notes.map((n, i) => (i === 2 ? { name: n.name, octave: 0 } : n));
    check('C wrong octave', play(l, wrong, 5).some((g) => g !== null), false);
    check('C recovers', play(l, snake.notes, 5).pop(), 'snake');
  }
  /* enharmonic */
  {
    const l = createMotifListener();
    const flat = snake.notes.map((n) => (n.name === 'F#' ? { name: 'Gb', octave: n.octave } : n));
    check('C enharmonic does not match', play(l, flat, 5).some((g) => g !== null), false);
  }
  /* false start: E, then the whole tune */
  {
    const l = createMotifListener();
    l.press('E', 5);
    check('C false start still matches', play(l, snake.notes, 5).pop(), 'snake');
  }
  /* false start in another octave: the second E sets the octave */
  {
    const l = createMotifListener();
    l.press('E', 3);
    check('C false start, other octave', play(l, snake.notes, 5).pop(), 'snake');
  }
  /* reset */
  {
    const l = createMotifListener();
    play(l, snake.notes.slice(0, 6), 5);
    l.reset();
    check('C reset forgets progress', play(l, snake.notes.slice(6), 5).some((g) => g !== null), false);
  }

  /* two motifs sharing a start */
  const x = parseMotif('x', 'C0 D0 E0'), y = parseMotif('y', 'C0 D0 F0');
  const seq = (motifs, text) => {
    const l = createMotifListener(motifs);
    return text.split(' ').map((t) => { const n = parseMotif('', t).notes[0]; return l.press(n.name, n.octave); });
  };
  check('C shared start, first', seq([x, y], 'C4 D4 E4'), [null, null, 'x']);
  check('C shared start, second', seq([x, y], 'C4 D4 F4'), [null, null, 'y']);
  check('C shared start, neither', seq([x, y], 'C4 D4 G4 E4'), [null, null, null, null]);
  check('C failing press heard as a first note', seq([x, y], 'C4 D4 C5 D5 F5'), [null, null, null, null, 'y']);

  /* the Pong motif, as the spec writes it (docs/local/easter-egg-games.md) */
  const pong = parseMotif('pong', 'B0 B-1 B-1 B-1 B-1 B-1 B-2', 'Pong');
  check('C Pong is registered as the spec writes it', MOTIFS.find((m) => m.game === 'pong'), pong);
  check('C Pong round', seq([snake, pong], 'B5 B4 B4 B4 B4 B4 B3').pop(), 'pong');
  check('C Pong, one bounce too many', seq([snake, pong], 'B5 B4 B4 B4 B4 B4 B4 B3').some((g) => g !== null), false);
  check('C Pong after a stray B', seq([snake, pong], 'B5 B5 B4 B4 B4 B4 B4 B3').pop(), 'pong');
  let threw = false;
  try { parseMotif('bad', 'H0'); } catch { threw = true; }
  check('C parseMotif rejects nonsense', threw, true);
}

/* ── D: the case's frame and the scene ─────────────────────────────────────── */
{
  /* The gate's own frame: regular hexagons one key apart, turned so the board
     step (+7, −2) lies along x, the origin at the keys' centroid. */
  const R3 = Math.sqrt(3);
  const flat = baseKeys.map(([u, v]) => [u + v / 2, v * R3 / 2]);
  const mid = [0, 1].map((j) => flat.reduce((s, p) => s + p[j], 0) / flat.length);
  const stepAngle = Math.atan2(-2 * R3 / 2, 7 - 1);
  const turned = ([x, y]) => {
    const dx = x - mid[0], dy = y - mid[1], c = Math.cos(-stepAngle), s = Math.sin(-stepAngle);
    return [dx * c - dy * s, dx * s + dy * c];
  };
  const own = flat.map(turned);
  const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
  let offKeys = 0;
  for (let i = 0; i < KEY_COUNT; i++) {
    const p = keyPoint(i);
    if (!close(p[0], own[i][0]) || !close(p[1], own[i][1])) offKeys++;
  }
  check('D every key is where the gate puts it', offKeys, 0);
  check('D the centroid is the origin', [0, 1].map((j) => close(own.reduce((s, p) => s + p[j], 0), 0, 1e-6)), [true, true]);
  const from = own[keyAt(0, 0)], to = own[keyAt(7, -2)];
  check('D the board step lies along x', [close(to[1], from[1]), close(to[0] - from[0], Math.hypot(6, R3))], [true, true]);
  check('D frameStep is a key\'s step', frameStep(7, -2).map((x) => +x.toFixed(9)), [+Math.hypot(6, R3).toFixed(9), 0]);
  let apart = 0;
  for (let i = 0; i < KEY_COUNT; i++) for (const n of neighbors(i)) if (!close(Math.hypot(own[i][0] - own[n][0], own[i][1] - own[n][1]), 1)) apart++;
  check('D neighbors are one key width apart', apart, 0);
  const ys = own.map((p) => p[1]);
  check('D the long sides are at ±4.31', [(Math.max(...ys) + 0.5).toFixed(2), (Math.min(...ys) - 0.5).toFixed(2)], ['4.31', '-4.31']);
  let wrongSide = 0;
  const onLine = [];
  for (let i = 0; i < KEY_COUNT; i++) {
    const x = keyPoint(i)[0];
    if (close(x, 0)) onLine.push(keyOffset(i).join(','));
    else if ((x < 0 ? 'left' : 'right') !== halfOf(i)) wrongSide++;
  }
  check('D x is on the side of the key\'s half', wrongSide, 0);
  check('D two keys are on the center line', onLine.sort(), ['0,1', '1,-3']);
  check('D the central key', keyPoint(keyAt(0, 0)).map((x) => x.toFixed(2)), ['-0.24', '-0.07']);

  /* Brute force: the share of key k's tile under the shapes, counted on a fine
     grid. A point is in the tile when no neighboring center (a key or not) is
     nearer; the shapes are tested by their definitions. */
  const AROUND = STEPS.map(([du, dv]) => turned([du + dv / 2 + mid[0], dv * R3 / 2 + mid[1]]));
  const inShape = (s, x, y) => {
    if (s.kind === 'circle') return Math.hypot(x - s.x, y - s.y) <= s.r;
    const lx = s.x2 - s.x1, ly = s.y2 - s.y1, len = Math.hypot(lx, ly);
    const along = ((x - s.x1) * lx + (y - s.y1) * ly) / len, across = Math.abs((x - s.x1) * ly - (y - s.y1) * lx) / len;
    if (along >= 0 && along <= len) return across <= s.half;
    return s.round && Math.min(Math.hypot(x - s.x1, y - s.y1), Math.hypot(x - s.x2, y - s.y2)) <= s.half;
  };
  const counted = (k, shapes) => {
    const [kx, ky] = own[k], N = 260, span = 1.2;
    let tile = 0, lit = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const dx = (i + 0.5) / N * span - span / 2, dy = (j + 0.5) / N * span - span / 2;
      const d = dx * dx + dy * dy;
      if (AROUND.some(([ax, ay]) => (dx - ax) ** 2 + (dy - ay) ** 2 < d)) continue;
      tile++;
      if (shapes.some((s) => inShape(s, kx + dx, ky + dy))) lit++;
    }
    return lit / tile;
  };
  const K = keyAt(2, 1), E = keyAt(3, 1), E3 = keyAt(5, 1), UP = keyAt(2, 2);
  const [kx, ky] = own[K], [ex, ey] = own[E], [fx, fy] = own[E3], [ux, uy] = own[UP];
  const TRUE_BALL = Math.PI / (2 * R3);
  const within = (a, b, eps) => Math.abs(a - b) <= eps;

  check('D the strips are a multiple of 4', TILE_STRIPS % 4, 0);
  check('D no shapes: nothing', whiteShares([]).every((w) => w === 0), true);
  const tiles = whiteShares([{ kind: 'tile', key: K }, { kind: 'tile', key: E }]);
  check('D a tile shape is exactly 1 on its key alone', [tiles[K], tiles[E], tiles.filter((w) => w !== 0).length], [1, 1, 2]);
  check('D a shape over everything is exactly 1 everywhere', whiteShares([{ kind: 'circle', x: 0, y: 0, r: 50 }]).every((w) => w === 1), true);

  const ball = [{ kind: 'circle', x: kx, y: ky, r: 0.5 }];
  const onKey = whiteShares(ball);
  check('D a ball on a key covers π/(2√3) of its tile', within(onKey[K], TRUE_BALL, 0.002), true);
  check('D and exactly nothing of any other', onKey.filter((w) => w !== 0).length, 1);
  const cases = {
    'a ball on a key': [ball, [K]],
    'a ball between two keys': [[{ kind: 'circle', x: (kx + ex) / 2, y: (ky + ey) / 2, r: 0.5 }], [K, E]],
    'a ball off-center': [[{ kind: 'circle', x: kx + 0.31, y: ky + 0.17, r: 0.5 }], [K, E, UP]],
    'a bumper': [[{ kind: 'circle', x: kx, y: ky, r: 0.4 }], [K]],
    'a paddle along a row': [[{ kind: 'line', x1: kx, y1: ky, x2: fx, y2: fy, half: 0.4, round: true }], [K, E, E3]],
    'a paddle across the rows': [[{ kind: 'line', x1: kx, y1: ky, x2: ux, y2: uy, half: 0.4, round: true }], [K, UP, E]],
    'a dash': [[{ kind: 'line', x1: kx, y1: ky - 0.5, x2: kx, y2: ky + 0.5, half: 0.1, round: false }], [K, UP]],
    'a ball over a dash': [[...ball, { kind: 'line', x1: kx, y1: ky - 0.9, x2: kx, y2: ky + 0.1, half: 0.1, round: false }], [K, keyAt(2, 0), keyAt(3, 0)]],
  };
  for (const [name, [shapes, keys]] of Object.entries(cases)) {
    const got = whiteShares(shapes);
    check('D ' + name + ': within 1% of the count', keys.map((k) => within(got[k], counted(k, shapes), 0.01)), keys.map(() => true));
  }
  const between = whiteShares(cases['a ball between two keys'][0]);
  check('D between two keys the ball is shared equally', within(between[K], between[E], 1e-9), true);
  const row = whiteShares(cases['a paddle along a row'][0]);
  check('D a paddle 0.8 thick covers 87% of a key along its row', row[E].toFixed(2), '0.87');
  check('D a bumper 0.8 wide covers 58%', whiteShares(cases['a bumper'][0])[K].toFixed(2), '0.58');

  /* The same ball anywhere over the keys throws the same light in all. */
  const random = seeded(11);
  let low = Infinity, high = -Infinity;
  for (let n = 0; n < 300; n++) {
    const x = kx + (random() - 0.5) * 3, y = ky + (random() - 0.5) * 3;
    const light = whiteShares([{ kind: 'circle', x, y, r: 0.5 }]).reduce((a, b) => a + b, 0);
    low = Math.min(low, light); high = Math.max(high, light);
  }
  check('D a ball\'s total light is the same wherever it sits', [within(low, TRUE_BALL, 0.003), within(high, TRUE_BALL, 0.003)], [true, true]);
}

/* ── E: Pong ───────────────────────────────────────────────────────────────── */
{
  /* The gate's own frame again, and the field as the spec states it. */
  const R3 = Math.sqrt(3);
  const flat = baseKeys.map(([u, v]) => [u + v / 2, v * R3 / 2]);
  const mid = [0, 1].map((j) => flat.reduce((s, p) => s + p[j], 0) / flat.length);
  const tilt = -Math.atan2(-2 * R3 / 2, 7 - 1);
  const own = flat.map(([x, y]) => {
    const dx = x - mid[0], dy = y - mid[1];
    return [dx * Math.cos(tilt) - dy * Math.sin(tilt), dx * Math.sin(tilt) + dy * Math.cos(tilt)];
  });
  const rowDir = [Math.cos(tilt), Math.sin(tilt)];
  const rowOf = ([x, y]) => x * rowDir[0] + y * rowDir[1];
  const off = (i) => keyOffset(i).join(',');
  const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
  const all = Array.from({ length: KEY_COUNT }, (_, i) => i);
  const ys = own.map((p) => p[1]), rows = own.map(rowOf);
  const wall = Math.max(...ys) + 0.5, end = Math.max(...rows) + 0.5;
  const hexd = (a, b) => {
    const du = baseKeys[a][0] - baseKeys[b][0], dv = baseKeys[a][1] - baseKeys[b][1];
    return Math.max(Math.abs(du), Math.abs(dv), Math.abs(du + dv));
  };
  const segDist = ([x, y], [ax, ay], [bx, by]) => {
    const lx = bx - ax, ly = by - ay, len2 = lx * lx + ly * ly;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * lx + (y - ay) * ly) / len2)) : 0;
    return Math.hypot(x - ax - t * lx, y - ay - t * ly);
  };
  const { newPong, press, release, begin, advance, ballLit, pongShapes, playerOf } = pong;
  const REACH = pong.BALL_RADIUS + pong.PADDLE_HALF;
  const START = keyAt(0, 1);

  /* The field. */
  check('E the long sides', [FIELD_WALL.toFixed(3), (Math.min(...ys) - 0.5).toFixed(3), near(FIELD_WALL, wall)], ['4.314', '-4.314', true]);
  check('E five corner keys touch the top side', all.filter((i) => near(ys[i], wall - 0.5)).map(off).sort(), ['-14,8', '-7,6', '0,4', '14,0', '7,2']);
  check('E five the bottom', all.filter((i) => near(ys[i], 0.5 - wall)).map(off).sort(), ['-10,-1', '-3,-3', '11,-7', '18,-9', '4,-5']);
  check('E the ends, along the rows', [FIELD_END.toFixed(3), (Math.min(...rows) - 0.5).toFixed(3), near(FIELD_END, end)], ['15.250', '-15.250', true]);
  /* Nine rows reach each end, alternating half a key back: the outermost keys
     touch the end line. */
  check('E the keys that touch each end, right and left', [all.filter((i) => near(rows[i], end - 0.5)).length, all.filter((i) => near(rows[i], 0.5 - end)).length], [4, 5]);
  check('E of nine within half a key of it', [all.filter((i) => rows[i] > end - 1 - 1e-9).length, all.filter((i) => rows[i] < 1 - end + 1e-9).length], [9, 9]);
  check('E the field is 31.75 long on the center line', (2 * FIELD_END / ROW[0]).toFixed(2), '31.75');
  check('E the rows are tilted 16.1°', [(Math.atan2(ROW[1], ROW[0]) * 180 / Math.PI).toFixed(1), near(ROW[0], rowDir[0]), near(ROW[1], rowDir[1])], ['16.1', true, true]);
  check('E the keys on the center line', all.filter(onCenterLine).map(off).sort(), ['0,1', '1,-3']);
  check('E they are nobody\'s, the rest keep their half', [playerOf(START), playerOf(keyAt(1, -3)), all.filter((i) => !onCenterLine(i) && playerOf(i) !== halfOf(i)).length], [null, null, 0]);
  check('E the ball starts on (0, 1), on the line, 0.90 above the middle', [off(pong.SERVE_KEY), near(own[START][0], 0), own[START][1].toFixed(2)], ['0,1', true, '0.90']);

  /* The key under a point: on a key and a third of the way to each neighbor it
     is that key; elsewhere it is the nearest key when the point is within its
     inscribed circle, and no key when no key is within a tile's reach. */
  let underWrong = 0;
  for (const i of all) {
    if (keyAtPoint(...own[i]) !== i) underWrong++;
    for (const [du, dv] of STEPS) {
      const [sx, sy] = frameStep(du, dv);
      if (keyAtPoint(own[i][0] + sx * 0.3, own[i][1] + sy * 0.3) !== i) underWrong++;
    }
  }
  check('E the key under a point on or near a key', underWrong, 0);
  {
    const random = seeded(5);
    let wrong = 0, none = 0;
    for (let n = 0; n < 4000; n++) {
      const p = [(random() - 0.5) * 36, (random() - 0.5) * 10];
      let best = -1, bestD = Infinity;
      for (const i of all) { const d = Math.hypot(p[0] - own[i][0], p[1] - own[i][1]); if (d < bestD) { bestD = d; best = i; } }
      const got = keyAtPoint(...p);
      if (bestD < 0.5 && got !== best) wrong++;
      if (bestD > 1 / R3 + 1e-9) { none++; if (got !== -1) wrong++; }
    }
    check('E the key under any point, or none', [wrong, none > 100], [0, true]);
  }
  /* A notch of the staircase along the top side: where key (4, 3) would be,
     beside (3, 3). The ball's center can be 0.3 below that place, and no key is
     under it there. */
  const notch = [own[keyAt(3, 3)][0] + rowDir[0], own[keyAt(3, 3)][1] + rowDir[1] - 0.3];
  check('E in a notch of the staircase the field is over no key', [keyAt(4, 3), notch[1] < wall - pong.BALL_RADIUS, keyAtPoint(...notch)], [-1, true, -1]);
  {
    let none = 0, places = 0;
    for (let x = -15; x <= 15; x += 0.05) for (let y = 0.5 - wall; y <= wall - 0.5; y += 0.05) { places++; if (keyAtPoint(x, y) < 0) none++; }
    check('E the notches are about 3% of where the ball\'s center can be', (100 * none / places).toFixed(0), '3');
  }
  let distWrong = 0;
  for (let n = 0; n < KEY_COUNT; n += 7) for (let m = 0; m < KEY_COUNT; m += 11) if (keyDistance(n, m) !== hexd(n, m)) distWrong++;
  check('E key distance', [distWrong, keyDistance(keyAt(0, 0), keyAt(4, 0)), keyDistance(keyAt(0, 0), keyAt(2, -4)), keyDistance(keyAt(0, 0), keyAt(3, 2))], [0, 4, 4, 5]);

  /* The paddle table. */
  const L1 = keyAt(-8, 0), L2 = keyAt(-6, 0), L3 = keyAt(-8, 2), LFAR = keyAt(-3, 0), R1 = keyAt(8, 0);
  check('E setup: the table\'s keys', [[L1, L2, L3, LFAR].map(playerOf), playerOf(R1), hexd(L1, L2), hexd(L1, LFAR), hexd(L2, L3)], [['left', 'left', 'left', 'left'], 'right', 2, 5, 2]);
  {
    const s = newPong();
    check('E a new game waits, with no ball on the field', [s.phase, ballLit(s), s.ball, pongShapes(s).some((x) => x.kind === 'circle'), s.score, s.speed], ['waiting', false, null, false, { left: 0, right: 0 }, pong.START_SPEED]);
    check('E a key on the center line is not honored', [press(s, START), press(s, keyAt(1, -3)), s.held], [false, false, { left: [], right: [] }]);
    check('E a first key is a bumper', [press(s, L1), s.held.left], [true, [L1]]);
    check('E a second key too far away is not honored', [press(s, LFAR), s.held.left], [false, [L1]]);
    check('E a second key within reach makes a paddle', [press(s, L2), s.held.left], [true, [L1, L2]]);
    check('E a third key is not honored', [press(s, L3), s.held.left], [false, [L1, L2]]);
    check('E the other half is its own', [press(s, R1), s.held], [true, { left: [L1, L2], right: [R1] }]);
    release(s, L1);
    check('E letting one key of a paddle go leaves a bumper', s.held.left, [L2]);
    release(s, LFAR);
    check('E letting go of a key that was not honored changes nothing', s.held, { left: [L2], right: [R1] });
    check('E the third key, still down, is not taken up', s.held.left.includes(L3), false);
    check('E pressed again, it is honored', [press(s, L3), s.held.left], [true, [L2, L3]]);
    release(s, L2); release(s, L3); release(s, R1);
    check('E all let go', s.held, { left: [], right: [] });
  }

  /* Every key and every pair: honored exactly when the shape clears the ball's
     starting place, by the gate's own distances. */
  {
    const startAt = own[START];
    const usable = { left: 0, right: 0 }, makeable = { left: 0, right: 0 }, refused = { left: 0, right: 0 };
    let keyWrong = 0, pairWrong = 0, pairs = 0;
    for (const k of all) {
      const s = newPong();
      const want = !onCenterLine(k) && Math.hypot(own[k][0] - startAt[0], own[k][1] - startAt[1]) >= REACH;
      if (press(s, k) !== want) keyWrong++;
      if (want) usable[halfOf(k)]++;
    }
    for (const a of all) for (const b of all) {
      if (a >= b || onCenterLine(a) || onCenterLine(b) || halfOf(a) !== halfOf(b) || hexd(a, b) > pong.PADDLE_REACH) continue;
      pairs++;
      const s = newPong();
      press(s, a);
      const want = segDist(startAt, own[a], own[b]) >= REACH;
      if (press(s, b) !== want) pairWrong++;
      if (want) makeable[halfOf(a)]++; else refused[halfOf(a)]++;
      /* Whatever the order: a refused second key leaves the first a bumper. */
      if (!want && (s.held[halfOf(a)].length !== 1 || s.held[halfOf(a)][0] !== a)) pairWrong++;
    }
    check('E each key is honored exactly when its bumper clears the starting place', keyWrong, 0);
    check('E each pair exactly when its paddle does', [pairWrong, pairs > 5000], [0, true]);
    check('E both halves have 139 usable keys', usable, { left: 139, right: 139 });
    check('E and 2,812 paddles', makeable, { left: 2812, right: 2812 });
    check('E 22 and 21 paddles are refused for the starting place', refused, { left: 22, right: 21 });
  }

  /* Against the ball in play. */
  const inPlay = (s, x, y, dx, dy) => { s.phase = 'play'; s.ball = { x, y }; const n = Math.hypot(dx, dy); s.dir = { x: dx / n, y: dy / n }; };
  {
    const s = newPong();
    const [bx, by] = own[L2];
    inPlay(s, bx + 0.3, by, 0, 1);
    check('E a bumper that would touch the ball is refused', [press(s, L2), s.held.left], [false, []]);
    check('E one that clears it is honored', [press(s, L1), s.held.left], [true, [L1]]);
    const L4 = keyAt(-4, 0);
    check('E a paddle whose line would cross the ball is refused, the bumper stays', [hexd(L1, L4), press(s, L4), s.held.left], [4, false, [L1]]);
    s.phase = 'pause'; s.ball = null;
    check('E with the ball gone the same paddle is honored', [press(s, L4), s.held.left], [true, [L1, L4]]);
    s.phase = 'over';
    release(s, L4);
    check('E after the match nothing is honored', press(s, L4), false);
  }

  /* The serve's warning. */
  {
    const s = newPong();
    check('E waiting, time does nothing and no ball appears', [advance(s, 5000, () => 0.5), s.phase, s.ball, ballLit(s)], [[], 'waiting', null, false]);
    begin(s);
    check('E the warning begins with the ball lit on the starting key', [s.phase, ballLit(s), pongShapes(s).filter((x) => x.kind === 'circle').length], ['serve', true, 1]);
    const seen = [];
    advance(s, 100, () => 0.5); seen.push(ballLit(s));
    for (let n = 0; n < 5; n++) { advance(s, 200, () => 0.5); seen.push(ballLit(s)); }
    check('E it flashes on and off three times, a change every 200 ms', [s.phase, seen], ['serve', [true, false, true, false, true, false]]);
    check('E nothing moves in the warning', near(s.ball.x, own[START][0]) && near(s.ball.y, own[START][1]), true);
    check('E not served before 1.2 s', [advance(s, 99, () => 0.5), s.phase], [[], 'serve']);
    const ev = advance(s, 1, () => 0.5);
    check('E served at 1.2 s, from the starting key', [ev, s.phase, ballLit(s), near(Math.hypot(s.dir.x, s.dir.y), 1), near(s.ball.x, own[START][0])], [[{ kind: 'served' }], 'play', true, true, true]);
    check('E the warning is three flashes of 200 ms', [pong.SERVE_FLASHES, pong.SERVE_FLASH_MS], [3, 200]);
  }

  /* The serve's direction, and the ruled ranges. */
  check('E the ruled serve ranges', pong.SERVE_RANGE, { right: { up: 49, down: 48 }, left: { up: 46, down: 52 } });
  {
    const random = seeded(23);
    const seenAt = { left: [], right: [] };
    for (let n = 0; n < 2000; n++) {
      const s = newPong();
      begin(s);
      advance(s, 1200, random);
      seenAt[s.dir.x > 0 ? 'right' : 'left'].push(Math.asin(s.dir.y) * 180 / Math.PI);
    }
    const inside = (side) => seenAt[side].every((a) => a <= pong.SERVE_RANGE[side].up + 1e-9 && a >= -pong.SERVE_RANGE[side].down - 1e-9);
    const spans = (side) => Math.max(...seenAt[side]) > pong.SERVE_RANGE[side].up - 2 && Math.min(...seenAt[side]) < -pong.SERVE_RANGE[side].down + 2;
    check('E every serve is inside its side\'s range', [inside('left'), inside('right')], [true, true]);
    check('E serves go both ways and fill the ranges', [seenAt.left.length > 800, seenAt.right.length > 800, spans('left'), spans('right')], [true, true, true, true]);
  }
  /* The gate's own trace from the starting key: a bounce is the ball's edge
     meeting a long side, and the end is reached when the whole ball is past it. */
  const traced = (deg, side) => {
    let [x, y] = own[START];
    const dx = side * Math.cos(deg * Math.PI / 180);
    let dy = Math.sin(deg * Math.PI / 180), bounces = 0;
    const lim = wall - pong.BALL_RADIUS, goalAt = side * (end + pong.BALL_RADIUS);
    for (;;) {
      const tEnd = (goalAt - (x * rowDir[0] + y * rowDir[1])) / (dx * rowDir[0] + dy * rowDir[1]);
      const tWall = dy > 0 ? (lim - y) / dy : dy < 0 ? (-lim - y) / dy : Infinity;
      if (tEnd <= tWall || bounces > 20) return bounces;
      x += dx * tWall; y += dy * tWall; dy = -dy; bounces++;
    }
  };
  /* The module's ball, served at an angle with nothing in its way. */
  const flown = (deg, side) => {
    const s = newPong();
    inPlay(s, own[START][0], own[START][1], side * Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180));
    let walls = 0, scorer = null;
    for (let t = 0; t < 60000 && s.phase === 'play'; t += 16) {
      for (const e of advance(s, 16, () => 0.5)) { if (e.kind === 'wall') walls++; if (e.kind === 'goal') scorer = e.scorer; }
    }
    return [walls, scorer];
  };
  {
    let over2 = 0, edgeShort = 0, disagree = 0, wrongScorer = 0;
    for (const [side, name] of [[1, 'right'], [-1, 'left']]) {
      for (const [sign, limit] of [[1, pong.SERVE_RANGE[name].up], [-1, pong.SERVE_RANGE[name].down]]) {
        for (let deg = 0; deg <= limit; deg++) {
          const want = traced(sign * deg, side);
          if (want > 2) over2++;
          const [walls, scorer] = flown(sign * deg, side);
          if (walls !== want) disagree++;
          if (scorer !== (side > 0 ? 'left' : 'right')) wrongScorer++;
        }
        if (traced(sign * (limit + 1), side) <= 2) edgeShort++;
      }
    }
    check('E every whole degree inside the ranges bounces at most twice', over2, 0);
    check('E one degree past each limit bounces a third time', edgeShort, 0);
    check('E the module\'s ball bounces as often as the trace, at every degree', disagree, 0);
    check('E past the right end the left player scores, and the reverse', wrongScorer, 0);
  }

  /* Reflection. */
  const reflect = ([dx, dy], [nx, ny]) => { const k = 2 * (dx * nx + dy * ny); return [dx - k * nx, dy - k * ny]; };
  const fly = (s, ms) => { const ev = []; for (let t = 0; t < ms; t += 4) ev.push(...advance(s, 4, () => 0.5)); return ev; };
  {
    const s = newPong();
    inPlay(s, -5, 0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6));
    let top = -Infinity;
    const ev = [];
    for (let t = 0; t < 1600; t += 4) { ev.push(...advance(s, 4, () => 0.5)); top = Math.max(top, s.ball.y); }
    check('E a long side: one bounce, the ball\'s edge never past it', [ev.map((e) => e.kind), top <= wall - pong.BALL_RADIUS + 1e-9, top > wall - pong.BALL_RADIUS - 0.05], [['wall'], true, true]);
    check('E and the angle out is the angle in', [near(s.dir.x, Math.cos(Math.PI / 6)), near(s.dir.y, -Math.sin(Math.PI / 6))], [true, true]);
  }
  {
    /* A bumper, hit off-center: the gate finds where a ball flying along −x at
       height h above the bumper's center first touches, and reflects there. */
    const s = newPong();
    press(s, L1);
    const [cx, cy] = own[L1], h = 0.45;
    inPlay(s, cx + 3, cy + h, -1, 0);
    const ev = fly(s, 600);
    const normal = [Math.sqrt(REACH * REACH - h * h) / REACH, h / REACH];
    const want = reflect([-1, 0], normal);
    check('E a bumper: one hit, named with its key', ev, [{ kind: 'hit', half: 'left', keys: [L1] }]);
    check('E reflected about the normal at the point of contact', [near(s.dir.x, want[0], 1e-6), near(s.dir.y, want[1], 1e-6)], [true, true]);
    const s2 = newPong();
    press(s2, L1);
    inPlay(s2, cx + 3, cy, -1, 0);
    fly(s2, 600);
    check('E head on, it comes straight back', [near(s2.dir.x, 1, 1e-6), near(s2.dir.y, 0, 1e-6)], [true, true]);
  }
  {
    /* A paddle along a row, L1 to L2. Its side: a ball coming down on its
       middle at 45° to the row. Its round end: a ball flying back along the
       row, 0.3 above the row's line, meets the disc on L2. */
    const s = newPong();
    press(s, L1); press(s, L2);
    const a = own[L1], b = own[L2], m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const up = [-rowDir[1], rowDir[0]];
    const d = [(rowDir[0] - up[0]) / Math.SQRT2, (rowDir[1] - up[1]) / Math.SQRT2];
    inPlay(s, m[0] - d[0] * 3, m[1] - d[1] * 3, d[0], d[1]);
    const ev = fly(s, 500);
    const want = reflect(d, up);
    check('E a paddle\'s side: one hit, named with both keys', ev, [{ kind: 'hit', half: 'left', keys: [L1, L2] }]);
    check('E reflected about the paddle\'s perpendicular', [near(s.dir.x, want[0], 1e-6), near(s.dir.y, want[1], 1e-6)], [true, true]);
    const s2 = newPong();
    press(s2, L1); press(s2, L2);
    const h = 0.3;
    inPlay(s2, b[0] + rowDir[0] * 3 + up[0] * h, b[1] + rowDir[1] * 3 + up[1] * h, -rowDir[0], -rowDir[1]);
    const ev2 = fly(s2, 500);
    const along = Math.sqrt(REACH * REACH - h * h) / REACH, across = h / REACH;
    const normal = [rowDir[0] * along + up[0] * across, rowDir[1] * along + up[1] * across];
    const want2 = reflect([-rowDir[0], -rowDir[1]], normal);
    check('E a paddle\'s round end: one hit', ev2.map((e) => e.kind), ['hit']);
    check('E reflected about the normal of the end\'s disc', [near(s2.dir.x, want2[0], 1e-6), near(s2.dir.y, want2[1], 1e-6)], [true, true]);
  }
  {
    /* The speed has no limit, so this is far past what a match reaches (from
       6, at +0.25 a second, 100 is six minutes of one rally): aimed at a
       four-key paddle from both sides and many angles, in frames of 16 ms and
       of 100 ms, every shot is a hit and the ball is never left inside the
       paddle. */
    const FAST = 100;
    const P1 = keyAt(-6, 2), P2 = keyAt(-6, -2);
    const a = own[P1], b = own[P2];
    const random = seeded(31);
    let shots = 0, hits = 0, inside = 0;
    for (const frame of [16, 100]) for (let n = 0; n < 200; n++) {
      const s = newPong();
      press(s, P1); press(s, P2);
      const t = 0.1 + random() * 0.8, target = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const from = (random() < 0.5 ? 1 : -1) * (3 + random() * 2), slant = (random() - 0.5) * 3;
      const p = [target[0] + from, target[1] + slant];
      if (Math.abs(p[1]) > wall - 1) continue;
      inPlay(s, p[0], p[1], target[0] - p[0], target[1] - p[1]);
      s.speed = FAST;
      shots++;
      let hit = false;
      for (let ms = 0; ms < 400 && s.phase === 'play'; ms += frame) {
        if (advance(s, frame, () => 0.5).some((e) => e.kind === 'hit')) hit = true;
        if (s.ball && segDist([s.ball.x, s.ball.y], a, b) < REACH - 1e-6) inside++;
      }
      if (hit) hits++;
    }
    check('E a paddle keys 4 apart', [hexd(P1, P2), playerOf(P1), playerOf(P2)], [4, 'left', 'left']);
    check('E at speed 100 every shot at a paddle hits it', [shots > 300, hits === shots], [true, true]);
    check('E and the ball is never left inside it', inside, 0);
    check('E the step is short enough', pong.MAX_STEP < REACH, true);
  }

  /* Goals, the pause, the match, the speed. */
  {
    const s = newPong();
    inPlay(s, 13, 0, rowDir[0], rowDir[1]);
    let last = null, ev = [];
    for (let t = 0; t < 2000 && s.phase === 'play'; t++) { last = rowOf([s.ball.x, s.ball.y]); ev.push(...advance(s, 1, () => 0.5)); }
    const speedAt = pong.START_SPEED;
    check('E a goal when the whole ball is past the end', [ev, last <= end + pong.BALL_RADIUS, last > end + pong.BALL_RADIUS - 0.02], [[{ kind: 'goal', scorer: 'left' }], true, true]);
    check('E then the ball is gone and the score counts', [s.phase, s.ball, ballLit(s), s.score, pongShapes(s).some((x) => x.kind === 'circle')], ['pause', null, false, { left: 1, right: 0 }, false]);
    check('E the speed drops halfway back to the start', [s.speed > speedAt, s.speed < speedAt + 0.2], [true, true]);
    check('E the pause is a second', [advance(s, 999, () => 0.5), s.phase], [[], 'pause']);
    advance(s, 1, () => 0.5);
    check('E then the next warning, lit on the starting key', [s.phase, near(s.ball.x, own[START][0]) && near(s.ball.y, own[START][1]), ballLit(s)], ['serve', true, true]);
    check('E and the next serve 1.2 s later', [advance(s, 1200, () => 0.5), s.phase], [[{ kind: 'served' }], 'play']);
  }
  {
    const s = newPong();
    const kinds = [];
    for (let g = 0; g < 3; g++) {
      inPlay(s, -14.9, 0, -rowDir[0], -rowDir[1]);
      for (let t = 0; t < 3000 && s.phase === 'play'; t += 16) kinds.push(...advance(s, 16, () => 0.5).map((e) => e.kind));
    }
    check('E past the left end the right player scores; three goals end the match', [kinds, s.phase, s.winner, s.score, s.ball], [['goal', 'goal', 'goal', 'over'], 'over', 'right', { left: 0, right: 3 }, null]);
    check('E first to 3', pong.WIN_SCORE, 3);
    check('E after the match, time does nothing', [advance(s, 5000, () => 0.5), s.phase], [[], 'over']);
  }
  {
    /* A long side and an end met inside one step (0.096 at the starting speed
       in a 16 ms frame), the ball flying up and to the right at 45 degrees:
       whichever comes first along the path happens first. */
    const d = Math.SQRT1_2, lim = wall - pong.BALL_RADIUS, goalAt = end + pong.BALL_RADIUS;
    const perPath = d * rowDir[0] + d * rowDir[1];
    const near2 = (toWall, toEnd) => {
      const y = lim - toWall * d;
      const x = (goalAt - toEnd * perPath - y * rowDir[1]) / rowDir[0];
      const s = newPong();
      inPlay(s, x, y, d, d);
      const kinds = [];
      for (let i = 0; i < 3; i++) kinds.push(...advance(s, 16, () => 0.5).map((e) => e.kind));
      return [kinds, s.score];
    };
    check('E the end 0.02 ahead and the wall 0.05: a goal and no bounce', near2(0.05, 0.02), [['goal'], { left: 1, right: 0 }]);
    check('E the wall 0.02 ahead and the end 0.05: a bounce, then the goal', near2(0.02, 0.05), [['wall', 'goal'], { left: 1, right: 0 }]);
  }
  {
    const s = newPong();
    inPlay(s, 0, 0, 0, 1);
    advance(s, 4000, () => 0.5);
    check('E the speed rises 0.25 a second of play', [s.phase, near(s.speed, pong.START_SPEED + 1, 1e-6), pong.SPEED_GAIN], ['play', true, 0.25]);
    s.speed = 500;
    advance(s, 2000, () => 0.5);
    check('E and has no limit', [s.phase, near(s.speed, 500.5, 1e-6), 'TOP_SPEED' in pong], ['play', true, false]);
    /* The speed in the millisecond before the goal: it rises until then. */
    s.speed = 40;
    let before = s.speed;
    inPlay(s, 14.9, 0, rowDir[0], rowDir[1]);
    for (let t = 0; t < 3000 && s.phase === 'play'; t++) { before = s.speed; advance(s, 1, () => 0.5); }
    check('E after a goal it is halfway back', [s.phase, near(s.speed, (before + pong.START_SPEED) / 2, 1e-3)], ['pause', true]);
    /* The match's highest speed: the starting speed at first, the speed while
       it rises, and unchanged by the drop after a goal or a slower rally. This
       state flew at 500.5 above, before its goal at 40. */
    check('E the highest speed starts as the starting speed', newPong().maxSpeed, pong.START_SPEED);
    check('E it holds through a slower flight and the drop after its goal', [near(s.maxSpeed, 500.5, 1e-6), near(before, 40, 0.1), s.speed < 24], [true, true, true]);
    inPlay(s, 0, 0, 0, 1);
    advance(s, 2000, () => 0.5);
    check('E and through a slower rally', [near(s.speed, (before + pong.START_SPEED) / 2 + 0.5, 1e-3), near(s.maxSpeed, 500.5, 1e-6)], [true, true]);
    const r = newPong();
    inPlay(r, 0, 0, 0, 1);
    advance(r, 4000, () => 0.5);
    check('E in a rally it is the speed reached', [near(r.maxSpeed, pong.START_SPEED + 1, 1e-6), r.maxSpeed === r.speed], [true, true]);
  }

  /* What is drawn is what the ball meets. */
  {
    const s = newPong();
    const lines = pongShapes(s).filter((x) => x.kind === 'line');
    const ranges = lines.map((l) => [l.y1.toFixed(2), l.y2.toFixed(2)]).sort((p, q) => p[0] - q[0]);
    check('E the center line: one square-ended line on x = 0 from wall to wall, 0.5 thick',
      [ranges, lines.every((l) => l.x1 === 0 && l.x2 === 0 && l.half === 0.25 && l.round === false)],
      [[['-4.31', '4.31']], true]);
    check('E waiting, only the center line is drawn', pongShapes(s).length, 1);
    begin(s);
    const ballShape = pongShapes(s).filter((x) => x.kind === 'circle');
    check('E the ball: a disc one key wide on the starting key', [ballShape.length, ballShape[0].r, near(ballShape[0].x, own[START][0]), near(ballShape[0].y, own[START][1])], [1, 0.5, true, true]);
    advance(s, 250, () => 0.5);
    check('E flashed off, it is not drawn', pongShapes(s).filter((x) => x.kind === 'circle').length, 0);
    press(s, L1); press(s, R1);
    const bumpers = pongShapes(s).filter((x) => x.kind === 'circle');
    check('E a bumper: a disc 0.8 wide on its key', [bumpers.map((c) => c.r), near(bumpers[0].x, own[L1][0]), near(bumpers[1].x, own[R1][0])], [[0.4, 0.4], true, true]);
    press(s, L2);
    const paddle = pongShapes(s).filter((x) => x.kind === 'line' && x.round);
    check('E a paddle: a round-ended line 0.8 thick between its keys', [paddle.length, paddle[0].half, near(paddle[0].x1, own[L1][0]) && near(paddle[0].y1, own[L1][1]), near(paddle[0].x2, own[L2][0]) && near(paddle[0].y2, own[L2][1])], [1, 0.4, true, true]);
    check('E the sizes drawn are the sizes met', [pong.BALL_RADIUS, pong.PADDLE_HALF, pong.LINE_HALF], [0.5, 0.4, 0.25]);
    const K = keyAt(2, 1), [kx, ky] = own[K];
    const dash = whiteShares([{ kind: 'line', x1: kx, y1: ky - 2, x2: kx, y2: ky + 2, half: pong.LINE_HALF, round: false }])[K];
    check('E the center line through a key\'s center covers about 58% of it', dash.toFixed(2), '0.58');
    {
      /* The starting key is on the line: the warning's flash is the step from
         the line alone to the line with the ball on it. */
      const w = newPong();
      const dark = whiteShares(pongShapes(w))[START];
      begin(w);
      const lit = whiteShares(pongShapes(w))[START];
      check('E the starting key: 58% under the line alone, 94% with the ball lit', [dark.toFixed(2), lit.toFixed(2)], ['0.58', '0.94']);
    }
  }
}

console.log(`${pass}/${pass + fail} checks passed`);
if (failures.length) {
  console.log('\nFailures (first 25):');
  for (const f of failures) console.log('  ' + f);
}
process.exit(fail ? 1 : 0);
