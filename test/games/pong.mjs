// Hidden games: Pong, running (its driver apps/hkl/src/games/pong-game.ts under
// the host games/mode.ts; the rules, games/pong.ts, are the Node oracle's;
// docs/architecture/hkl.md → Hidden games).
//
// The REAL modules imported live from the dev server, against a simulated
// Lumatone on firmware 1.5.0 that ACKs every message. The game's clock is the
// host's animation frame, driven by hand: the gate takes the frames the host
// asks for (the callback is `gameFrame`) and calls them with its own times, in
// steps of 50 ms or less. Math.random is pinned for the serve, so the ball's
// path is known. The gate places the ball itself where a step needs it, the
// way the Snake gate parks the food.
//
// Requires `pnpm dev` running (umbrella proxy at :5170). The page is pinned to
// a private overlay relay (never the live :5190), and Chromium is muted.
//
//   node test/games/pong.mjs        # exits non-zero on any failure
//
// Covers:
//   G1   the Pong button starts a game that waits: no frame clock, no ball; the
//        device shows the darkened layout and the center line, and the canvas
//        the line
//   G2   the first press starts the warning and is an ordinary press besides: a
//        bumper, sounding at the quiet velocity whatever the touch; the ball is
//        lit on the starting key at once, on the device and the canvas
//   G3   the warning: lit, dark, three times, 200 ms a change, in silence; the
//        ball is served at 1.2 s
//   G4   in play the ball moves at its speed along the pinned serve; the device
//        shows it by tile share and the canvas as a disc
//   G5   the ball's line: the note of the key under it, quietly, one at a time;
//        over no key the last note holds
//   G6   a second key makes a paddle, both keys sounding quietly; a third key,
//        a key on the center line and a key in the ball's way are swallowed
//   G7   a canvas click does nothing
//   G8   a hit: the ball turns back, the paddle's keys are struck again at the
//        accent velocity and stay the players' notes, and the ball's key is
//        accented with them
//   G9   releasing a paddle key ends its note and leaves a bumper
//   G10  a goal: the score counts, the line ends, the ball is gone for the
//        one-second pause, then the next warning begins lit
//   G11  the third goal ends the match: the game leaves the keys, the modal
//        names the winner, the score and the highest speed, the board stays
//        dark until the modal is closed and the layout is back then, the
//        players' held notes are still theirs
//   G12  the Pong button again stops a running game without a modal
// It also reports (without judging) what one canvas redraw costs with the game
// on screen and without it.

import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { CDP } from '../composer-test/lib/cdp.mjs';
import { isolatedHklUrl } from '../composer-test/lib/private-relay.mjs';

const URL = await isolatedHklUrl(process.env.HKL_URL ?? 'http://localhost:5170/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRIPT = `(async () => {
  const depUrl = async (fromPath, depPath) => {
    const src = await (await fetch(fromPath)).text();
    const i = src.indexOf(depPath);
    if (i < 0) throw new Error(depPath + ' is not imported by ' + fromPath);
    let j = i + depPath.length;
    while (j < src.length && src[j] !== '"' && src[j] !== "'") j++;
    return src.slice(i, j);
  };
  const root = '/src/ui/init.ts';
  const results = [];
  const check = (name, got, want) => results.push({ name, got, want, ok: JSON.stringify(got) === JSON.stringify(want) });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const drawUrl = await depUrl(root, '/src/render/draw.ts');
  const handlerUrl = await depUrl(root, '/src/midi/handler.ts');
  const engineUrl = await depUrl(handlerUrl, '/src/midi/engine.ts');
  const secretsUrl = await depUrl(root, '/src/ui/secrets.ts');
  const modeUrl = await depUrl(secretsUrl, '/src/games/mode.ts');
  const driversUrl = await depUrl(secretsUrl, '/src/games/drivers.ts');
  const pongGameUrl = await depUrl(driversUrl, '/src/games/pong-game.ts');
  const syncUrl = await depUrl(modeUrl, '/src/lumatone/sync.ts');
  const [prefsMod, viewMod, drawMod, handler, selMod, audioMod, midiMod, lumMod, secrets, mode, board, display, held, physical, colors, scene, oklab, rules] =
    await Promise.all([
      import(await depUrl(root, '/src/state/persistence.ts')),
      import(await depUrl(root, '/src/state/view.ts')),
      import(drawUrl), import(handlerUrl),
      import(await depUrl(root, '/src/state/selection.ts')),
      import(await depUrl(root, '/src/state/audio.ts')),
      import(await depUrl(engineUrl, '/src/state/midi.ts')),
      import(await depUrl(root, '/src/state/lumatone.ts')),
      import(secretsUrl), import(modeUrl),
      import(await depUrl(modeUrl, '/src/games/board.ts')),
      import(await depUrl(modeUrl, '/src/games/display.ts')),
      import(await depUrl(modeUrl, '/src/input/held.ts')),
      import(await depUrl(modeUrl, '/src/layout/physical.ts')),
      import(await depUrl(drawUrl, '/src/render/colors.ts')),
      import(await depUrl(syncUrl, '/src/games/scene.ts')),
      import(await depUrl(syncUrl, '/src/lumatone/oklab.ts')),
      import(await depUrl(pongGameUrl, '/src/games/pong.ts')),
    ]);
  const { view } = viewMod, { selection } = selMod, { audio } = audioMod, { midi } = midiMod, { lumatone } = lumMod;
  const sel = (id, v) => { const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event('change')); };
  const tickBox = (id, on) => { const c = document.getElementById(id); c.checked = on; c.dispatchEvent(new Event('change')); };

  /* Simulated Lumatone on firmware 1.5.0: answers pings, ACKs everything. */
  const fakeIn = { id: 'fake-lumatone-in', name: 'Lumatone', state: 'connected', onmidimessage: null };
  const fakeOut = {
    id: 'fake-lumatone-out', name: 'Lumatone', state: 'connected',
    send(m) {
      if (m[0] !== 0xF0) return;
      const answer = (data) => setTimeout(() => { if (fakeIn.onmidimessage) fakeIn.onmidimessage({ data }); }, 1);
      if (m[4] === 0x00 && m[5] === 0x33) { answer(new Uint8Array([0xF0, 0x00, 0x21, 0x50, 0x00, 0x33, 0x01, m[6], m[7], m[8], m[9], 0xF7])); return; }
      answer(new Uint8Array([0xF0, 0x00, 0x21, 0x50, m[4], m[5], 0x01, 0xF7]));
    },
  };
  midi.midiIn = fakeIn; midi.midiOut = fakeOut;
  fakeIn.onmidimessage = handler.handleMidiMessage;
  const deliver = (...bytes) => fakeIn.onmidimessage({ data: new Uint8Array(bytes) });
  const phys = (i) => [Math.floor(i / 56) + 1, i % 56];
  const on = (i) => { const [ch, n] = phys(i); deliver(0x90 | (ch - 1), n, 100); };
  const off = (i) => { const [ch, n] = phys(i); deliver(0x80 | (ch - 1), n, 0); };
  lumatone.firmware = [1, 5, 0]; lumatone.fixedLayoutSent = true; lumatone.deviceColors = null;
  tickBox('cbAutoSync', true);
  await wait(80);

  /* The host's animation frame, held here and called by hand. */
  const realRaf = window.requestAnimationFrame.bind(window), realCancel = window.cancelAnimationFrame.bind(window);
  let frame = null;
  const FRAME_ID = -77;
  window.requestAnimationFrame = (fn) => { if (fn.name !== 'gameFrame') return realRaf(fn); frame = fn; return FRAME_ID; };
  window.cancelAnimationFrame = (id) => { if (id === FRAME_ID) frame = null; else realCancel(id); };
  let now = 1000;
  const runFrame = () => { const f = frame; frame = null; if (f) f(now); };
  /* Let ms pass, in frames of step ms, then let the device and the canvas settle. */
  const pass = async (ms, step = 50) => { for (let t = 0; t < ms; t += step) { now += step; runFrame(); } await wait(70); };
  /* Show the state as the gate has set it: a frame in which no time passes. */
  const still = async () => { runFrame(); await wait(70); };

  const at = (u, v) => board.keyAt(u, v);
  const cellOf = (i) => physical.lumatoneCell(i).join(',');
  const pt = (i) => board.keyPoint(i);
  const DIM = display.GAME_DIM_LED;
  const dim = (hex) => {
    const c = (p) => Math.round(parseInt(hex.slice(p, p + 2), 16) * DIM);
    return '#' + ((1 << 24) + (c(1) << 16) + (c(3) << 8) + c(5)).toString(16).slice(1);
  };
  const normal = () => Array.from({ length: 280 }, (_, i) => { const [q, r] = physical.lumatoneCell(i); return colors.keyColorHex(q, r); });
  const toWhite = (hex, w) => {
    const a = oklab.hexToOklab(hex), b = oklab.hexToOklab('#ffffff');
    return oklab.oklabToHex([0, 1, 2].map((j) => a[j] + (b[j] - a[j]) * w));
  };
  const g = () => mode.runningGame();
  const st = () => g().state;
  /* Every key darkened, blended toward white by the share of its tile under
     the shapes the rules give now. */
  const shares = () => scene.whiteShares(rules.pongShapes(st()));
  const board280 = () => { const sh = shares(); return normal().map((c) => dim(c)).map((c, i) => (sh[i] >= 1 ? '#ffffff' : sh[i] <= 0 ? c : toWhite(c, sh[i]))); };
  const wrong = (want) => { let n = 0; for (let i = 0; i < 280; i++) if (lumatone.deviceColors[i] !== want[i]) n++; return n; };
  const hasBall = () => rules.pongShapes(st()).some((s) => s.kind === 'circle' && s.r === rules.BALL_RADIUS);

  /* Canvas: whether the patch of side 2n + 1 around a view point is white, and
     where a cell is. */
  const cv = document.getElementById('cv');
  const white = ([x, y], n = 3) => {
    const rect = cv.getBoundingClientRect(), scale = cv.width / rect.width;
    const ctx = cv.getContext('2d');
    let all = 0, w = 0;
    for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) {
      const d = ctx.getImageData(Math.round((x + dx) * scale), Math.round((y + dy) * scale), 1, 1).data;
      all++;
      if (d[0] >= 250 && d[1] >= 250 && d[2] >= 250) w++;
    }
    return w / all >= 0.9;
  };
  const center = (cell) => {
    let n = 0, cx = 0, cy = 0;
    for (let y = 0; y < view.CH; y += 2) for (let x = 0; x < view.CW; x += 2) {
      if (drawMod.hexAtPoint(x, y) !== cell) continue;
      n++; cx += x; cy += y;
    }
    return n ? [cx / n, cy / n] : null;
  };
  const clickAt = ([x, y]) => {
    const rect = cv.getBoundingClientRect();
    const o = { bubbles: true, clientX: rect.left + x, clientY: rect.top + y, button: 0 };
    cv.dispatchEvent(new MouseEvent('mousedown', o));
    window.dispatchEvent(new MouseEvent('mouseup', o));
  };
  const dialog = () => document.getElementById('gameOverDialog');
  const pongButton = () => document.querySelector('#tb-group-secrets button[data-game="pong"]');

  /* The keys of the match. Left: a bumper on L1, a paddle to L2 along the row,
     L3 a third key in reach. Right: R1, for the click. ABOVE is the key the
     ball is over when it hits the paddle a quarter of the way along; K1 and K2
     are two keys the ball is set on; START is the serve's key. */
  const START = at(0, 1), L1 = at(-8, 0), L2 = at(-6, 0), L3 = at(-8, 2), R1 = at(8, 0), ABOVE = at(-8, 1), K1 = at(2, 1), K2 = at(5, 1);
  const NAMED = [START, L1, L2, L3, R1, ABOVE, K1, K2, at(0, 0), at(1, 0), at(3, 3), at(10, 0)];
  if (NAMED.some((k) => k < 0)) return { pass: false, results: [{ name: 'setup: every key the gate names is on the board', got: NAMED, want: 'no -1', ok: false }] };
  const QUIET = mode.QUIET_VELOCITY, ACCENT = mode.ACCENT_VELOCITY;
  check('setup: quiet is softer than the accent, and neither is the touch (100)', [QUIET < ACCENT, QUIET !== 100, ACCENT !== 100], [true, true, true]);

  prefsMod.savePrefs({ secretGames: ['pong'], toolbars: { ...prefsMod.loadPrefs().toolbars, secrets: true } });
  secrets.renderSecrets();
  sel('selOutline', 'lumatone');
  await wait(120);
  const startAt = center(cellOf(START)), l1At = center(cellOf(L1)), k1At = center(cellOf(K1));
  const c00 = center(cellOf(at(0, 0))), c10 = center(cellOf(at(1, 0)));
  /* The field's center is a quarter of the way from key (0, 0) to key (1, 0). */
  const middle = c00 && c10 ? [c00[0] + (c10[0] - c00[0]) / 4, c00[1] + (c10[1] - c00[1]) / 4] : null;
  /* The starting key is on the center line, so its center is white under the
     line with or without a ball. The ball is told apart beside the line: 0.39
     of a row step from the key's center is inside the ball's disc (radius 0.5)
     and 0.37 from the line's middle, outside the line (0.25 to each side). */
  const ballSide = startAt && c00 && c10 ? [startAt[0] + (c10[0] - c00[0]) * 0.39, startAt[1] + (c10[1] - c00[1]) * 0.39] : null;
  check('setup: the probed places are on screen', [!!startAt, !!l1At, !!k1At, !!middle, !!ballSide], [true, true, true, true, true]);
  check('setup: nothing is white there without a game', [white(startAt), white(ballSide, 1), white(l1At), white(k1At), white(middle, 1)], [false, false, false, false, false]);

  /* ── G1 ── */
  check('G1a: the Pong button is offered', !!pongButton(), true);
  pongButton().click();
  await wait(120);
  check('G1b: a game is waiting', g() && [g().id, st().phase, st().score], ['pong', 'waiting', { left: 0, right: 0 }]);
  if (!g()) return { pass: false, results };
  check('G1c: the button is marked as playing, and no frame clock runs yet', [pongButton().classList.contains('playing'), !!frame], [true, false]);
  check('G1d: no ball on the field', [hasBall(), st().ball], [false, null]);
  check('G1e: the device shows the darkened layout and the center line', [wrong(board280()), shares().filter((w) => w > 0).length >= 5, wrong(normal().map(dim)) > 0], [0, true, true]);
  check('G1f: the starting key holds the line, 0.5 thick, and no ball', [shares()[START] > 0.5, shares()[START] < 0.65], [true, true]);
  check('G1g: the canvas draws the center line, solid through the starting key, and no ball', [white(middle, 1), white(startAt, 1), white(ballSide, 1)], [true, true, false]);

  /* ── G2 ── */
  const realRandom = Math.random;
  Math.random = () => 0.75;   /* the serve: toward the right, 24.75° up */
  on(L1);
  check('G2a: the first press starts the warning', [st().phase, !!frame], ['serve', true]);
  check('G2b: and is a bumper besides', st().held, { left: [L1], right: [] });
  check('G2c: sounding as a held note, quietly, whatever the touch', [held.heldCount('lumatone'), [...selection.selectedKeys], audio.keyVelocity[cellOf(L1)]], [1, [cellOf(L1)], QUIET]);
  await wait(100);
  check('G2d: the ball is lit on the starting key at once', [hasBall(), shares()[START] > 0.9, wrong(board280())], [true, true, 0]);
  check('G2e: the bumper covers part of its key', [shares()[L1] > 0.5, shares()[L1] < 0.65], [true, true]);
  check('G2f: the canvas shows the ball, wider than the line, and the bumper', [white(startAt), white(ballSide, 1), white(l1At)], [true, true, true]);

  /* ── G3 ── */
  runFrame();   /* the first frame counts no time */
  const seen = [];
  await pass(100); seen.push([hasBall(), wrong(board280())]);
  for (let n = 0; n < 5; n++) { await pass(200); seen.push([hasBall(), wrong(board280())]); }
  check('G3a: lit, dark, three times, a change every 200 ms', seen, [[true, 0], [false, 0], [true, 0], [false, 0], [true, 0], [false, 0]]);
  check('G3b: still the warning at 1.1 s, in silence', [st().phase, held.heldCount('game')], ['serve', 0]);
  check('G3c: in a dark half the starting key is back to the line alone, on the device and the canvas', [shares()[START] < 0.65, white(startAt, 1), white(ballSide, 1)], [true, true, false]);
  await pass(150);
  check('G3d: served by 1.25 s', st().phase, 'play');
  Math.random = realRandom;

  /* ── G4 ── */
  const angle = 24.75 * Math.PI / 180, dir = [Math.cos(angle), Math.sin(angle)];
  const flown = (sec) => rules.START_SPEED * sec + rules.SPEED_GAIN * sec * sec / 2;
  const off0 = [st().ball.x - pt(START)[0], st().ball.y - pt(START)[1]];
  check('G4a: the ball left along the pinned serve, 50 ms on its way', [Math.abs(st().dir.x - dir[0]) < 1e-9, Math.abs(st().dir.y - dir[1]) < 1e-9, Math.abs(Math.hypot(...off0) - flown(0.05)) < 0.01], [true, true, true]);
  check('G4b: the first note of its line is the starting key, quietly', [held.heldCount('game'), selection.selectedKeys.has(cellOf(START)), audio.keyVelocity[cellOf(START)]], [1, true, QUIET]);
  await pass(400);
  const off1 = [st().ball.x - pt(START)[0], st().ball.y - pt(START)[1]];
  check('G4c: 400 ms later it is where its speed puts it', [Math.abs(Math.hypot(...off1) - flown(0.45)) < 0.01, Math.abs(off1[1] / off1[0] - dir[1] / dir[0]) < 1e-6], [true, true]);
  check('G4d: the device shows the ball by tile share', [hasBall(), wrong(board280()), shares().filter((w) => w > 0.2).length >= 1], [true, 0, true]);
  st().ball.x = pt(K1)[0]; st().ball.y = pt(K1)[1];
  await still();
  check('G4e: set on a key, the ball lights that key', [shares()[K1] > 0.9, wrong(board280()), lumatone.deviceColors[K1] !== '#ffffff'], [true, 0, true]);
  check('G4f: and the canvas draws it there', white(k1At), true);

  /* ── G5 ── */
  check('G5a: the line sounds the key under the ball, quietly, alone', [held.heldCount('game'), selection.selectedKeys.has(cellOf(K1)), selection.selectedKeys.has(cellOf(START)), audio.keyVelocity[cellOf(K1)]], [1, true, false, QUIET]);
  st().ball.x = pt(K2)[0]; st().ball.y = pt(K2)[1];
  await still();
  check('G5b: it moves on with the ball', [held.heldCount('game'), selection.selectedKeys.has(cellOf(K2)), selection.selectedKeys.has(cellOf(K1))], [1, true, false]);
  /* A notch of the staircase along the top side: where key (4, 3) would be,
     beside (3, 3), and 0.3 below that place. Inside the field, over no key. */
  const rowStep = board.frameStep(1, 0);
  st().ball.x = pt(at(3, 3))[0] + rowStep[0]; st().ball.y = pt(at(3, 3))[1] + rowStep[1] - 0.3; st().dir.x = 1; st().dir.y = 0;
  const overNone = [at(4, 3), st().ball.y < board.FIELD_WALL - rules.BALL_RADIUS, board.keyAtPoint(st().ball.x, st().ball.y)];
  await still();
  check('G5c: over no key, the last note holds', [overNone, held.heldCount('game'), selection.selectedKeys.has(cellOf(K2))], [[-1, true, -1], 1, true]);

  /* ── G6 ── */
  on(L2);
  check('G6a: a second key in reach makes a paddle', st().held.left, [L1, L2]);
  check('G6b: both keys sound, quietly', [held.heldCount('lumatone'), audio.keyVelocity[cellOf(L1)], audio.keyVelocity[cellOf(L2)]], [2, QUIET, QUIET]);
  on(L3);
  check('G6c: a third key is swallowed', [st().held.left, held.heldCount('lumatone'), selection.selectedKeys.has(cellOf(L3))], [[L1, L2], 2, false]);
  off(L3);
  on(START);
  check('G6d: a key on the center line is swallowed', [st().held, held.heldCount('lumatone')], [{ left: [L1, L2], right: [] }, 2]);
  off(START);
  st().ball.x = pt(R1)[0] + 0.3; st().ball.y = pt(R1)[1];
  on(R1);
  check('G6e: a key whose bumper would touch the ball is swallowed', [st().held.right, held.heldCount('lumatone')], [[], 2]);
  off(R1);
  await wait(70);

  /* ── G7 ── */
  const before = [...selection.selectedKeys].sort();
  clickAt(center(cellOf(at(10, 0))));
  check('G7: a canvas click does nothing', [[...selection.selectedKeys].sort(), st().held.right], [before, []]);

  /* ── G8 ── */
  /* Straight down onto the paddle, a quarter of the way from L1 to L2. */
  const up = [-board.ROW[1], board.ROW[0]];
  const aim = [pt(L1)[0] + (pt(L2)[0] - pt(L1)[0]) / 4, pt(L1)[1] + (pt(L2)[1] - pt(L1)[1]) / 4];
  st().ball.x = aim[0] + up[0] * 2; st().ball.y = aim[1] + up[1] * 2; st().dir.x = -up[0]; st().dir.y = -up[1];
  let frames = 0;
  while (frames < 40 && st().dir.x * up[0] + st().dir.y * up[1] < 0) { now += 16; runFrame(); frames++; }
  await wait(70);
  const under = board.keyAtPoint(st().ball.x, st().ball.y);
  check('G8a: the ball turns back off the paddle', [frames < 40, Math.abs(st().dir.x - up[0]) < 1e-6, Math.abs(st().dir.y - up[1]) < 1e-6], [true, true, true]);
  check('G8b: the paddle\\'s keys are struck again, accented', [audio.keyVelocity[cellOf(L1)], audio.keyVelocity[cellOf(L2)]], [ACCENT, ACCENT]);
  check('G8c: and are still the players\\' notes', [held.heldCount('lumatone'), selection.selectedKeys.has(cellOf(L1)), selection.selectedKeys.has(cellOf(L2))], [2, true, true]);
  check('G8d: the ball\\'s key is accented with them', [under, held.heldCount('game'), selection.selectedKeys.has(cellOf(ABOVE)), audio.keyVelocity[cellOf(ABOVE)]], [ABOVE, 1, true, ACCENT]);
  check('G8e: the device follows', wrong(board280()), 0);

  /* ── G9 ── */
  off(L2);
  check('G9: releasing a paddle key ends its note and leaves a bumper', [st().held.left, held.heldCount('lumatone'), selection.selectedKeys.has(cellOf(L2)), selection.selectedKeys.has(cellOf(L1))], [[L1], 1, false, true]);

  /* ── G10 ── */
  const toEnd = (short) => {
    /* On the row line through the field's center, short of the right end, heading out. */
    const along = board.FIELD_END - short;
    st().ball = { x: along * board.ROW[0], y: along * board.ROW[1] };
    st().dir.x = board.ROW[0]; st().dir.y = board.ROW[1];
    st().phase = 'play';
  };
  /* A fast rally before the first goal: the match's highest speed. The goal
     drops it halfway back to the start (about 11.7), where the match ends. */
  st().speed = 17.3;
  toEnd(0.3);
  frames = 0;
  while (frames < 40 && st().phase === 'play') { now += 16; runFrame(); frames++; }
  await wait(70);
  check('G10a: past the right end, the left player scores', [frames < 40, st().phase, st().score], [true, 'pause', { left: 1, right: 0 }]);
  check('G10b: the line ends and the ball is gone', [held.heldCount('game'), hasBall(), st().ball, wrong(board280())], [0, false, null, 0]);
  await pass(800);
  check('G10c: gone through the pause, in silence', [st().phase, hasBall(), held.heldCount('game')], ['pause', false, 0]);
  await pass(250);
  check('G10d: then the next warning begins, lit on the starting key', [st().phase, hasBall(), shares()[START] > 0.9, wrong(board280())], ['serve', true, true, 0]);

  /* ── G11 ── */
  const st0 = st();   /* the state outlives the game */
  st().score.left = 2;
  toEnd(0.3);
  frames = 0;
  while (frames < 40 && g()) { now += 16; runFrame(); frames++; }
  await wait(120);
  check('G11a: the third goal ends the match and the game leaves the keys', [frames < 40, g(), !!frame], [true, null, false]);
  check('G11b: the modal names the winner, the score and the match\\'s highest speed, not its last', [dialog()?.open === true, document.getElementById('gameOverText')?.textContent, Math.round(st0.speed)], [true, 'The left player wins, 3 to 0. Max speed: 17.', 12]);
  check('G11c: under the modal the board stays dark: every key dimmed, no line, paddle or ball', [wrong(normal().map(dim)), white(middle, 1), white(startAt)], [0, false, false]);
  check('G11d: a key still held is still its player\\'s note', [held.heldCount('lumatone'), selection.selectedKeys.has(cellOf(L1)), held.heldCount('game')], [1, true, 0]);
  off(L1);
  check('G11e: until it is let go', [held.heldCount('lumatone'), selection.selectedKeys.size, pongButton().classList.contains('playing')], [0, 0, false]);
  document.getElementById('gameOverClose').click();
  await wait(150);
  check('G11f: closing the modal brings the layout back', [dialog().open, wrong(normal())], [false, 0]);

  /* ── G12, and what a redraw costs ── */
  pongButton().click();
  on(L1); on(L2); on(R1);
  runFrame();
  await pass(1250);
  st().ball.x = pt(K1)[0]; st().ball.y = pt(K1)[1];
  await still();
  const timeDraws = () => { const t0 = performance.now(); for (let n = 0; n < 40; n++) drawMod.draw(); return (performance.now() - t0) / 40; };
  timeDraws();
  const withGame = timeDraws();
  const t0 = performance.now();
  for (let n = 0; n < 200; n++) scene.whiteShares(rules.pongShapes(st()));
  const sharesMs = (performance.now() - t0) / 200;
  const playing = [st().phase, st().held];
  pongButton().click();
  await wait(120);
  check('G12: the Pong button again stops a running game, without a modal', [playing, g(), dialog().open, !!frame, wrong(normal())], [['play', { left: [L1, L2], right: [R1] }], null, false, false, 0]);
  off(L1); off(L2); off(R1);
  timeDraws();
  const plain = timeDraws();

  window.requestAnimationFrame = realRaf; window.cancelAnimationFrame = realCancel;
  tickBox('cbAutoSync', false);
  return {
    pass: results.every((r) => r.ok), results,
    info: { drawWithGameMs: +withGame.toFixed(2), drawPlainMs: +plain.toFixed(2), sharesMs: +sharesMs.toFixed(3), canvas: view.CW + 'x' + view.CH },
  };
})()`;

const chrome = await launchChromium();
const cdp = new CDP(await newTabWsUrl(chrome.port));
await cdp.ready;
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

/* Any console error fails the gate, except the one a headless browser always
   logs: it has no Web MIDI permission, and the gate supplies its own device. */
const EXPECTED_ERROR = /^MIDI access denied/;
const errors = [];
cdp.on('Runtime.exceptionThrown', (p) => errors.push(p?.exceptionDetails?.exception?.description ?? p?.exceptionDetails?.text ?? 'exception'));
cdp.on('Runtime.consoleAPICalled', (p) => {
  if (p.type !== 'error') return;
  const text = p.args.map((a) => a.value ?? a.description).join(' ');
  if (!EXPECTED_ERROR.test(text)) errors.push(text);
});

let exit = 0, total = 0, passed = 0;
try {
  const loaded = new Promise((res) => { const off = cdp.on('Page.loadEventFired', () => { off(); res(); }); });
  await cdp.send('Page.navigate', { url: URL });
  await loaded;
  await sleep(2500);
  const out = await cdp.evalJSON(SCRIPT);
  if (!out || !out.results) {
    console.log('FAILED TO RUN:', JSON.stringify(out));
    exit = 1;
  } else {
    for (const r of out.results) {
      total++;
      if (r.ok) passed++;
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}` + (r.ok ? '' : `\n        got  ${JSON.stringify(r.got)}\n        want ${JSON.stringify(r.want)}`));
    }
    if (out.info) console.log('\nINFO  one canvas redraw: ' + out.info.drawWithGameMs + ' ms with Pong on screen, ' + out.info.drawPlainMs + ' ms without (canvas ' + out.info.canvas + ', headless Chromium); the scene\'s tile shares: ' + out.info.sharesMs + ' ms');
    if (!out.pass) exit = 1;
  }
} catch (e) {
  console.log('GATE ERROR:', e?.message ?? e);
  exit = 1;
}
console.log(`\n${passed}/${total} checks passed`);
if (errors.length) { console.log('\nCONSOLE ERRORS:\n  ' + errors.join('\n  ')); exit = 1; }
await chrome.stop();
process.exit(exit);
