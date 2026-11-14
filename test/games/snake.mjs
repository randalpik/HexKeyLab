// Hidden games: Snake, running (its driver apps/hkl/src/games/snake-game.ts
// under the host games/mode.ts, and the host's hooks in lumatone/sync.ts,
// render/draw.ts, midi/handler.ts, ui/init.ts, ui/secrets.ts;
// docs/architecture/hkl.md → Hidden games).
//
// The REAL modules imported live from the dev server, against a simulated
// Lumatone on firmware 1.5.0 that ACKs every message. The game's clocks are
// driven by hand: the gate takes the intervals the game asks for (its step, its
// food flash, its game-over flash — recognized by the tick function's name) and
// calls them, so every step is deterministic and nothing waits on real time.
//
// Requires `pnpm dev` running (umbrella proxy at :5170). The page is pinned to
// a private overlay relay (never the live :5190), and Chromium is muted.
//
//   node test/games/snake.mjs        # exits non-zero on any failure
//
// Covers:
//   T    the ruled timings: 300 ms a step, 200 ms a flash, three game-over
//        flashes, a one-second hold
//   N1   the Snake button starts a game that waits: start body, not started,
//        the button marked as playing, the flash clock running and no step clock
//   N2   the device shows the board: four white keys, the food at its normal
//        color, every other key dimmed; the canvas shows white on the head and
//        darkens a dimmed key
//   N3   while waiting, the flash moves nothing; the food flashes on the device
//   N4   the first press starts the step clock and is not a turn or a note; the
//        flash still moves nothing
//   N5   a step moves the head one key and plays its note quietly, alone, and
//        does not touch the flash
//   N6   a press on the right half turns clockwise, on the left half
//        counter-clockwise; the line stays legato (one note at a time)
//   N7   a canvas click on an outline key steers too and selects nothing
//   N8   eating grows the snake and accents the note
//   N9   the computer keyboard still plays notes and does not steer
//   N10  the ref-edit modifier keeps precedence: the key picks the ref, the
//        heading stays; after the ref change the device shows the same board
//        over the new layout
//   N11  a hidden page pauses the game
//   N12  the wall starts the game-over sequence: the note is released, the step
//        and flash clocks stop, the background stays dark with the food dark,
//        and the snake goes off, then on and off three times; presses are
//        swallowed; the game stays up, the snake off, through the hold and then
//        exits: the modal reports the score, the board stays dark until the
//        modal is closed, and then the device and the canvas are back to the
//        normal layout
//   N13  leaving the Lumatone outline ends a game without a modal
//   N14  the Snake button again stops a running game without a modal, also in
//        the middle of the game-over sequence
//   N15  starting under another outline switches to the Lumatone outline
//   N16  Hide stops a running game

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
  /* The driver's own constants: its timings. */
  const snakeMod = await import(await depUrl(driversUrl, '/src/games/snake-game.ts'));
  const [prefsMod, viewMod, drawMod, handler, selMod, audioMod, midiMod, lumMod, refState, secrets, mode, board, display, held, physical, colors] =
    await Promise.all([
      import(await depUrl(root, '/src/state/persistence.ts')),
      import(await depUrl(root, '/src/state/view.ts')),
      import(drawUrl), import(handlerUrl),
      import(await depUrl(root, '/src/state/selection.ts')),
      import(await depUrl(root, '/src/state/audio.ts')),
      import(await depUrl(engineUrl, '/src/state/midi.ts')),
      import(await depUrl(root, '/src/state/lumatone.ts')),
      import(await depUrl(root, '/src/state/reference.ts')),
      import(secretsUrl), import(modeUrl),
      import(await depUrl(modeUrl, '/src/games/board.ts')),
      import(await depUrl(modeUrl, '/src/games/display.ts')),
      import(await depUrl(modeUrl, '/src/input/held.ts')),
      import(await depUrl(modeUrl, '/src/layout/physical.ts')),
      import(await depUrl(drawUrl, '/src/render/colors.ts')),
    ]);
  const { view } = viewMod, { selection } = selMod, { audio } = audioMod, { midi } = midiMod, { lumatone } = lumMod;
  const ref = refState.referenceNote;
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
  const tap = (i) => { on(i); off(i); };
  lumatone.firmware = [1, 5, 0]; lumatone.fixedLayoutSent = true; lumatone.deviceColors = null;
  tickBox('cbAutoSync', true);
  await wait(80);

  /* The game's clocks: an interval whose callback is one of the game's three
     tick functions is held here, under that function's name, and called by hand. */
  const TICKS = { stepTick: 'STEP_MS', flashTick: 'FLASH_MS', overTick: 'OVER_FLASH_MS' };
  const clocks = {}, ids = {}, periods = {};
  let nextId = -1000;
  const realSet = window.setInterval.bind(window), realClear = window.clearInterval.bind(window);
  window.setInterval = (fn, ms, ...rest) => {
    if (!(fn.name in TICKS)) return realSet(fn, ms, ...rest);
    clocks[fn.name] = fn; periods[fn.name] = ms; ids[--nextId] = fn.name;
    return nextId;
  };
  window.clearInterval = (id) => {
    if (id in ids) { if (clocks[ids[id]]) delete clocks[ids[id]]; delete ids[id]; } else realClear(id);
  };
  const run = async (name, n) => { for (let k = 0; k < n; k++) if (clocks[name]) clocks[name](); await wait(70); };
  const steps = (n) => run('stepTick', n), flashes = (n) => run('flashTick', n), overs = (n) => run('overTick', n);
  const running = () => Object.keys(clocks).sort();

  /* The board as the gate states it. */
  const at = (u, v) => board.keyAt(u, v);
  const cellOf = (i) => physical.lumatoneCell(i).join(',');
  const g = () => mode.runningGame();
  const head = () => [...board.keyOffset(g().snake.body[0])];
  const bodyOffsets = () => g().snake.body.map((k) => [...board.keyOffset(k)]);
  const DIM = display.GAME_DIM_LED;
  const dim = (hex) => {
    const c = (p) => Math.round(parseInt(hex.slice(p, p + 2), 16) * DIM);
    return '#' + ((1 << 24) + (c(1) << 16) + (c(3) << 8) + c(5)).toString(16).slice(1);
  };
  const normal = () => Array.from({ length: 280 }, (_, i) => { const [q, r] = physical.lumatoneCell(i); return colors.keyColorHex(q, r); });
  /* White snake (dark while it is flashed off), the food's own color while lit, the rest dimmed. */
  const boardColors = () => {
    const s = g().snake, lit = g().foodLit, snakeOn = g().snakeLit;
    return normal().map((c, i) => (s.body.includes(i) ? (snakeOn ? '#ffffff' : dim(c)) : (i === s.food && lit) ? c : dim(c)));
  };
  const wrong = (want) => { let n = 0; for (let i = 0; i < 280; i++) if (lumatone.deviceColors[i] !== want[i]) n++; return n; };
  const whites = () => lumatone.deviceColors.filter((c) => c === '#ffffff').length;

  /* Canvas: the pixels of one cell, as the share that is white and the mean brightness. */
  const cv = document.getElementById('cv');
  const cellPixels = (cell) => {
    const rect = cv.getBoundingClientRect(), scale = cv.width / rect.width;
    const ctx = cv.getContext('2d');
    let n = 0, white = 0, sum = 0, cx = 0, cy = 0;
    for (let y = 0; y < view.CH; y += 3) for (let x = 0; x < view.CW; x += 3) {
      if (drawMod.hexAtPoint(x, y) !== cell) continue;
      const d = ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data;
      n++; cx += x; cy += y; sum += d[0] + d[1] + d[2];
      if (d[0] >= 250 && d[1] >= 250 && d[2] >= 250) white++;
    }
    return n ? { n, white: white / n, mean: sum / n / 3, x: cx / n, y: cy / n } : null;
  };
  const clickCell = (cell) => {
    const p = cellPixels(cell);
    if (!p) return false;
    const rect = cv.getBoundingClientRect();
    const o = { bubbles: true, clientX: rect.left + p.x, clientY: rect.top + p.y, button: 0 };
    cv.dispatchEvent(new MouseEvent('mousedown', o));
    window.dispatchEvent(new MouseEvent('mouseup', o));
    return true;
  };
  const dialog = () => document.getElementById('gameOverDialog');
  const snakeButton = () => document.querySelector('#tb-group-secrets button[data-game="snake"]');
  const discover = () => {
    prefsMod.savePrefs({ secretGames: ['snake'], toolbars: { ...prefsMod.loadPrefs().toolbars, secrets: true } });
    secrets.renderSecrets();
  };
  const FAR = at(-10, 3);   /* a key no step below crosses: where the food is parked */
  const RIGHT = at(10, 0), LEFT = at(-8, 0);
  check('setup: the two steering keys are on opposite halves', [board.halfOf(RIGHT), board.halfOf(LEFT)], ['right', 'left']);
  check('setup: the dim level is a fraction', DIM > 0 && DIM < 1, true);
  check('setup: quiet is softer than the accent', mode.QUIET_VELOCITY < mode.ACCENT_VELOCITY, true);
  check('T: the ruled timings', [snakeMod.STEP_MS, snakeMod.FLASH_MS, snakeMod.OVER_FLASHES, snakeMod.OVER_HOLD_MS], [300, 200, 3, 1000]);
  const plainFar = cellPixels(cellOf(at(-12, 2)));

  /* ── N1 ── */
  discover();
  check('N1a: the Snake button is offered', !!snakeButton(), true);
  check('N1b: no game is running', g(), null);
  snakeButton().click();
  await wait(80);
  check('N1c: a game is waiting', g() && [g().id, g().started, g().over], ['snake', false, false]);
  if (!g()) return { pass: false, results };
  check('N1d: the start body', [bodyOffsets(), g().snake.heading], [[[0, 0], [-1, 0], [-2, 0], [-3, 0]], 0]);
  check('N1e: the button is marked as playing', snakeButton().classList.contains('playing'), true);
  check('N1f: the flash clock runs, at its own period; no step clock yet', [running(), periods.flashTick], [['flashTick'], snakeMod.FLASH_MS]);

  /* ── N2 ── */
  g().snake.food = FAR;
  await flashes(2);   /* the food is lit again, and the device has the board */
  check('N2a: the food is lit', g().foodLit, true);
  check('N2b: the device shows the board', wrong(boardColors()), 0);
  check('N2c: four white keys', whites(), 4);
  check('N2d: the food keeps its color, the rest are dimmed', [lumatone.deviceColors[FAR] === normal()[FAR], lumatone.deviceColors[at(-12, 2)] === dim(normal()[at(-12, 2)])], [true, true]);
  const headPx = cellPixels(cellOf(at(0, 0))), dimPx = cellPixels(cellOf(at(-12, 2)));
  check('N2e: the canvas paints the head white', headPx && headPx.white > 0.8, true);
  check('N2f: and darkens a dimmed key', !!plainFar && !!dimPx && dimPx.mean < plainFar.mean - 5, true);

  /* ── N3 ── */
  await flashes(1);
  check('N3a: a flash later the food is dark on the device', [g().foodLit, lumatone.deviceColors[FAR] === dim(normal()[FAR]), wrong(boardColors())], [false, true, 0]);
  await flashes(5);
  check('N3b: waiting, the flash moves nothing', [bodyOffsets(), g().started], [[[0, 0], [-1, 0], [-2, 0], [-3, 0]], false]);

  /* ── N4 ── */
  on(RIGHT);
  check('N4a: the first press starts the game', g().started, true);
  check('N4b: and is not a turn', g().snake.heading, 0);
  check('N4c: nor a note', [selection.selectedKeys.size, held.heldCount('lumatone')], [0, 0]);
  off(RIGHT);
  check('N4d: the step clock starts, at its own period', [running(), periods.stepTick], [['flashTick', 'stepTick'], snakeMod.STEP_MS]);
  await flashes(3);
  check('N4e: the flash still moves nothing', head(), [0, 0]);

  /* ── N5 ── */
  const litBefore = g().foodLit;
  await steps(1);
  check('N5a: a step moves the head one key', bodyOffsets(), [[1, 0], [0, 0], [-1, 0], [-2, 0]]);
  check('N5b: and plays its note, alone', [...selection.selectedKeys], [cellOf(at(1, 0))]);
  check('N5c: quietly', audio.keyVelocity[cellOf(at(1, 0))], mode.QUIET_VELOCITY);
  check('N5d: the device follows', wrong(boardColors()), 0);
  check('N5e: a step does not flash the food', g().foodLit, litBefore);

  /* ── N6 ── */
  tap(RIGHT);
  check('N6a: a press on the right half turns clockwise', g().snake.heading, 5);
  await steps(1);
  check('N6b: the head goes down-right', head(), [2, -1]);
  check('N6c: one note at a time', [...selection.selectedKeys], [cellOf(at(2, -1))]);
  tap(LEFT);
  check('N6d: a press on the left half turns counter-clockwise', g().snake.heading, 0);
  await steps(1);
  check('N6e: the head goes along the row', head(), [3, -1]);

  /* ── N7 ── */
  check('N7a: the click target is on screen', clickCell(cellOf(LEFT)), true);
  check('N7b: a canvas click steers', g().snake.heading, 1);
  check('N7c: and selects nothing', [...selection.selectedKeys], [cellOf(at(3, -1))]);
  await steps(1);
  check('N7d: the head goes up-right', head(), [3, 0]);

  /* ── N8 ── */
  g().snake.food = at(3, 1);
  await steps(1);
  check('N8a: eating grows the snake', [head(), g().snake.body.length, g().snake.eaten], [[3, 1], 5, 1]);
  check('N8b: the note is accented', audio.keyVelocity[cellOf(at(3, 1))], mode.ACCENT_VELOCITY);
  check('N8c: new food is off the snake', g().snake.food >= 0 && !g().snake.body.includes(g().snake.food), true);
  g().snake.food = FAR;

  /* ── N9 ── */
  const keyD = (type) => window.dispatchEvent(new KeyboardEvent(type, { code: 'KeyD', key: 'd', bubbles: true, cancelable: true }));
  keyD('keydown');
  check('N9a: the computer keyboard still plays', held.heldKey('qwerty', 'KeyD') !== undefined, true);
  check('N9b: and does not steer', g().snake.heading, 1);
  keyD('keyup');

  /* ── N10 ── */
  const ctrl = (down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { key: 'Control', code: 'ControlLeft', ctrlKey: down, bubbles: true }));
  const refBefore = ref.q + ',' + ref.r;
  let refTarget = -1;
  for (const [u, v] of [[-5, 1], [-6, 2], [-4, -1], [-7, 1]]) {
    const i = at(u, v), [q, r] = physical.lumatoneCell(i);
    if (q + ',' + r !== refBefore && drawMod.validateRefNoteCandidate(q, r) === null) { refTarget = i; break; }
  }
  const wantRef = refTarget >= 0 ? cellOf(refTarget) : null;
  ctrl(true);
  if (refTarget >= 0) tap(refTarget);
  ctrl(false);
  check('N10a: under the modifier the key picks the ref', ref.q + ',' + ref.r, wantRef);
  check('N10b: and does not steer', g() && g().snake.heading, 1);
  await wait(750);   /* the ref slide */
  await steps(1);
  check('N10c: the game goes on', g() && head(), [3, 2]);
  check('N10d: the device shows the board over the new layout', g() ? wrong(boardColors()) : -1, 0);

  /* ── N11 ── */
  const litHidden = g().foodLit;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  await steps(4); await flashes(3);
  check('N11: a hidden page pauses the game', g() && [head(), g().foodLit], [[3, 2], litHidden]);
  delete document.hidden;

  /* ── N12 ── */
  const headCell = cellOf(at(0, 0));
  for (let k = 0; k < 20 && g() && !g().over; k++) await steps(1);
  check('N12a: the wall starts the game-over sequence, the game still up', g() && [g().over, g().snake.over, g().snakeLit, g().foodLit], [true, 'wall', false, false]);
  if (!g()) return { pass: false, results };
  check('N12b: only the game-over clock runs', running(), ['overTick']);
  check('N12c: the note is released', [selection.selectedKeys.size, held.heldCount('game')], [0, 0]);
  check('N12d: the background stays dark, the snake off, the food dark', [wrong(boardColors()), whites(), wrong(normal().map(dim))], [0, 0, 0]);
  check('N12e: no modal yet', dialog().open, false);
  const seen = [];
  for (let k = 0; k < 2 * snakeMod.OVER_FLASHES; k++) {
    await overs(1);
    seen.push([g() ? g().snakeLit : null, whites(), g() ? wrong(boardColors()) : -1]);
  }
  check('N12f: the snake flashes on and off three times, ending off', seen, [[true, 5, 0], [false, 0, 0], [true, 5, 0], [false, 0, 0], [true, 5, 0], [false, 0, 0]]);
  on(RIGHT);
  check('N12g: a press during the sequence is swallowed', [selection.selectedKeys.size, held.heldCount('lumatone')], [0, 0]);
  off(RIGHT);
  const hold = snakeMod.OVER_HOLD_MS / snakeMod.OVER_FLASH_MS;
  await overs(hold - 1);
  check('N12h: the game stays up through the hold, the snake off', [!!g(), g() && g().snakeLit, whites(), wrong(normal().map(dim)), dialog().open], [true, false, 0, 0, false]);
  await overs(1);
  check('N12i: then it exits', g(), null);
  check('N12j: the modal reports the score', [dialog()?.open === true, /wall/.test(dialog()?.textContent ?? ''), /Score: 1\\./.test(document.getElementById('gameOverText')?.textContent ?? ''), /Food eaten/.test(dialog()?.textContent ?? '')], [true, true, true, false]);
  check('N12k: under the modal the board stays dark: every key dimmed, nothing white', [wrong(normal().map(dim)), whites()], [0, 0]);
  check('N12l: the clocks are gone and the button is idle', [running(), snakeButton().classList.contains('playing')], [[], false]);
  const during = cellPixels(headCell);
  check('N12m: the canvas shows no snake', !!during && during.white < 0.2, true);
  document.getElementById('gameOverClose').click();
  check('N12n: the modal closes', dialog().open, false);
  await wait(150);
  const after = cellPixels(headCell);
  check('N12o: and only then the device and the canvas are back to the layout', [wrong(normal()), !!after && after.white < 0.2, !!during && !!after && after.mean > during.mean + 5], [0, true, true]);

  /* ── N13 ── */
  snakeButton().click();
  check('N13a: a new game', g() && g().started, false);
  sel('selOutline', 'qwerty');
  await flashes(1);
  check('N13b: leaving the Lumatone outline ends it, without a modal', [g(), dialog().open, running()], [null, false, []]);
  sel('selOutline', 'lumatone');

  /* ── N14 ── */
  snakeButton().click();
  const wasRunning = !!g();
  snakeButton().click();
  check('N14a: the button again stops the game, without a modal', [wasRunning, g(), dialog().open, running()], [true, null, false, []]);
  snakeButton().click();
  g().snake.food = FAR;
  tap(RIGHT);
  for (let k = 0; k < 20 && g() && !g().over; k++) await steps(1);
  await overs(2);
  const midSequence = g() && g().over;
  snakeButton().click();
  await wait(80);
  check('N14b: also in the middle of the game-over sequence', [midSequence, g(), dialog().open, running(), wrong(normal())], [true, null, false, [], 0]);

  /* ── N15 ── */
  sel('selOutline', 'qwerty');
  snakeButton().click();
  check('N15: starting switches to the Lumatone outline', [document.getElementById('selOutline').value, !!g()], ['lumatone', true]);

  /* ── N16 ── */
  const realConfirm = window.confirm;
  window.confirm = () => true;
  document.getElementById('btnHideSecrets').click();
  window.confirm = realConfirm;
  await wait(80);
  check('N16: Hide stops a running game', [g(), prefsMod.loadPrefs().secretGames, wrong(normal())], [null, [], 0]);

  window.setInterval = realSet; window.clearInterval = realClear;
  tickBox('cbAutoSync', false);
  return { pass: results.every((r) => r.ok), results };
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
