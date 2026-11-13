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

  /* the Pong motif (docs/local/easter-egg-games.md): not registered until Pong exists */
  const pong = parseMotif('pong', 'B0 B-1 B-1 B-1 B-1 B-1 B-2');
  check('C Pong not registered yet', MOTIFS.some((m) => m.game === 'pong'), false);
  check('C Pong round', seq([snake, pong], 'B5 B4 B4 B4 B4 B4 B3').pop(), 'pong');
  check('C Pong, one bounce too many', seq([snake, pong], 'B5 B4 B4 B4 B4 B4 B4 B3').some((g) => g !== null), false);
  check('C Pong after a stray B', seq([snake, pong], 'B5 B5 B4 B4 B4 B4 B4 B3').pop(), 'pong');
  let threw = false;
  try { parseMotif('bad', 'H0'); } catch { threw = true; }
  check('C parseMotif rejects nonsense', threw, true);
}

console.log(`${pass}/${pass + fail} checks passed`);
if (failures.length) {
  console.log('\nFailures (first 25):');
  for (const f of failures) console.log('  ' + f);
}
process.exit(fail ? 1 : 0);
