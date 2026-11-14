// Hidden games: the host (apps/hkl/src/games/mode.ts), with a game of the
// gate's own. Snake uses only part of what the host offers; this gate runs a
// stub driver through the rest: shapes that are not whole keys, a press played
// as a note at the game's velocity, releases, the animation-frame clock, and an
// ending in the game's own words (docs/architecture/hkl.md → Hidden games).
//
// The REAL modules imported live from the dev server, against a simulated
// Lumatone on firmware 1.5.0 that ACKs every message. The host's clocks are
// driven by hand: the gate takes the interval and the animation frames the host
// asks for (recognized by the callback's name) and calls them.
//
// Requires `pnpm dev` running (umbrella proxy at :5170). The page is pinned to
// a private overlay relay (never the live :5190), and Chromium is muted.
//
//   node test/games/host.mjs        # exits non-zero on any failure
//
// Covers:
//   H1   starting a driver runs its game: the host reports it, the toolbar
//        marks its button
//   H2   the device shows the scene: each key its darkened color blended
//        toward white by the share of its tile under the shapes (the shares are
//        the oracle's business; the blend is stated here), an undarkened key
//        untouched, a ball's key neither white nor dim
//   H3   the canvas draws the shapes as they are: white at the ball's center
//        and between two keys under a paddle, where a key's own border would
//        be; not white on a key the shapes miss
//   H4   a press the game plays is a note at the game's velocity, whatever the
//        touch, and its release ends it; the game hears both
//   H5   a press the game swallows is no note; the game hears it and its release
//   H6   a canvas click on an outline key goes to the game and selects nothing
//   H7   a clock: runs at its period, is one clock when asked for twice, does
//        nothing on a hidden page, stops
//   H8   the frame clock: the time since the last frame, 0 on the first, capped;
//        nothing on a hidden page and 0 on the first frame back; stops
//   H9   the game's line: one note at a time, at the velocity asked; hush ends it
//   H10  the game's end: off the keys, its own text in the modal, the clocks
//        gone; the board dark until the modal is closed (by its button, or
//        without it as Esc does), then the layout back; a game started under
//        an open result keeps its picture; its host does nothing after
//   H11  a second game replaces the first: the first's clocks and line are gone
//   H12  leaving the Lumatone outline ends a game on its next frame

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
  const syncUrl = await depUrl(modeUrl, '/src/lumatone/sync.ts');
  const [prefsMod, viewMod, drawMod, handler, selMod, audioMod, midiMod, lumMod, secrets, mode, board, display, held, physical, colors, scene, oklab] =
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

  /* The host's clocks, held here and called by hand: an interval whose callback
     carries one of the stub's tick names, and the host's animation frame. */
  const TICKS = ['tickA', 'tickB'];
  const clocks = {}, ids = {}, periods = {};
  let nextId = -1000;
  const realSet = window.setInterval.bind(window), realClear = window.clearInterval.bind(window);
  window.setInterval = (fn, ms, ...rest) => {
    if (!TICKS.includes(fn.name)) return realSet(fn, ms, ...rest);
    clocks[fn.name] = fn; periods[fn.name] = ms; ids[--nextId] = fn.name;
    return nextId;
  };
  window.clearInterval = (id) => {
    if (id in ids) { if (clocks[ids[id]]) delete clocks[ids[id]]; delete ids[id]; } else realClear(id);
  };
  const running = () => Object.keys(clocks).sort();
  const realRaf = window.requestAnimationFrame.bind(window), realCancel = window.cancelAnimationFrame.bind(window);
  let frame = null;
  const FRAME_ID = -77;
  window.requestAnimationFrame = (fn) => { if (fn.name !== 'gameFrame') return realRaf(fn); frame = fn; return FRAME_ID; };
  window.cancelAnimationFrame = (id) => { if (id === FRAME_ID) frame = null; else realCancel(id); };
  const runFrame = (now) => { const f = frame; frame = null; if (f) f(now); };

  const at = (u, v) => board.keyAt(u, v);
  const cellOf = (i) => physical.lumatoneCell(i).join(',');
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
  const wrong = (want) => { let n = 0; for (let i = 0; i < 280; i++) if (lumatone.deviceColors[i] !== want[i]) n++; return n; };

  /* Canvas: whether the patch around a view point is white (7 × 7 points: a
     note label's strokes alone do not fill it), and where a cell is. */
  const cv = document.getElementById('cv');
  const white = (x, y) => {
    const rect = cv.getBoundingClientRect(), scale = cv.width / rect.width;
    const ctx = cv.getContext('2d');
    let n = 0, w = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const d = ctx.getImageData(Math.round((x + dx) * scale), Math.round((y + dy) * scale), 1, 1).data;
      n++;
      if (d[0] >= 250 && d[1] >= 250 && d[2] >= 250) w++;
    }
    return w / n >= 0.9;
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
  const snakeButton = () => document.querySelector('#tb-group-secrets button[data-game="snake"]');

  /* The stub: a ball on key BALL, a paddle from PAD1 to PAD2 along a row, a
     short square-ended dash, everything darkened but key LIT. It plays a press
     of key PLAYED at velocity 33 and swallows every other. It takes Snake's id,
     since the toolbar stops a game it has no button for. */
  const BALL = at(2, 1), PAD1 = at(5, 1), PADMID = at(6, 1), PAD2 = at(7, 1), LIT = at(-10, 3), MISSED = at(5, -1);
  const PLAYED = at(-6, 2), SWALLOWED = at(-7, 2), CLICKED = at(-8, 0);
  const KEYS = [BALL, PAD1, PADMID, PAD2, LIT, MISSED, PLAYED, SWALLOWED, CLICKED, at(-3, 0)];
  if (KEYS.some((k) => k < 0)) return { pass: false, results: [{ name: 'setup: every key the gate names is on the board', got: KEYS, want: 'no -1', ok: false }] };
  const pt = (i) => board.keyPoint(i);
  const shapes = [
    { kind: 'circle', x: pt(BALL)[0], y: pt(BALL)[1], r: 0.5 },
    { kind: 'line', x1: pt(PAD1)[0], y1: pt(PAD1)[1], x2: pt(PAD2)[0], y2: pt(PAD2)[1], half: 0.4, round: true },
    { kind: 'line', x1: pt(at(-3, 0))[0], y1: pt(at(-3, 0))[1] - 0.5, x2: pt(at(-3, 0))[0], y2: pt(at(-3, 0))[1] + 0.5, half: 0.1, round: false },
  ];
  const log = [];
  const made = [];
  const stub = (host) => {
    const game = {
      id: 'snake', host, shapes,
      scene: () => ({ dark: (key) => key !== LIT, shapes: game.shapes }),
      press: (key) => { log.push('press ' + key); return key === PLAYED ? 33 : 'swallow'; },
      release: (key) => { log.push('release ' + key); },
      click: (key) => { log.push('click ' + key); },
    };
    made.push(game);
    return game;
  };
  const g = () => mode.runningGame();

  prefsMod.savePrefs({ secretGames: ['snake'], toolbars: { ...prefsMod.loadPrefs().toolbars, secrets: true } });
  secrets.renderSecrets();
  sel('selOutline', 'lumatone');
  await wait(120);
  const ballAt = center(cellOf(BALL)), padAt = [center(cellOf(PAD1)), center(cellOf(PADMID))], missedAt = center(cellOf(MISSED));
  const between = padAt[0] && padAt[1] ? [(padAt[0][0] + padAt[1][0]) / 2, (padAt[0][1] + padAt[1][1]) / 2] : null;
  check('setup: the probed keys are on screen', [!!ballAt, !!between, !!missedAt], [true, true, true]);
  check('setup: nothing is white there without a game', [white(...ballAt), white(...between), white(...missedAt)], [false, false, false]);

  /* ── H1 ── */
  check('H1a: no game is running', g(), null);
  mode.startGame(stub);
  await wait(120);
  check('H1b: the host runs the stub', g() === made[0], true);
  check('H1c: the toolbar marks its button', snakeButton()?.classList.contains('playing'), true);

  /* ── H2 ── */
  const share = scene.whiteShares(shapes);
  const want = normal().map((c, i) => {
    const under = i === LIT ? c : dim(c);
    return share[i] >= 1 ? '#ffffff' : share[i] <= 0 ? under : toWhite(under, share[i]);
  });
  check('H2a: the device shows each key blended by its share', wrong(want), 0);
  check('H2b: the shapes reach some keys and miss most', [share.filter((w) => w > 0).length > 5, share.filter((w) => w === 0).length > 250], [true, true]);
  check('H2c: the undarkened key is untouched', lumatone.deviceColors[LIT], normal()[LIT]);
  check('H2d: the ball\\'s key is neither white nor dim', [lumatone.deviceColors[BALL] !== '#ffffff', lumatone.deviceColors[BALL] !== dim(normal()[BALL])], [true, true]);
  check('H2e: a missed key is dimmed', lumatone.deviceColors[MISSED], dim(normal()[MISSED]));

  /* ── H3 ── */
  check('H3a: the canvas is white at the ball\\'s center', white(...ballAt), true);
  check('H3b: and between two keys under the paddle', white(...between), true);
  check('H3c: not on a key the shapes miss', white(...missedAt), false);

  /* ── H4 ── */
  on(PLAYED);
  check('H4a: a played press is a note', [held.heldCount('lumatone'), [...selection.selectedKeys]], [1, [cellOf(PLAYED)]]);
  check('H4b: at the game\\'s velocity, not the touch\\'s', audio.keyVelocity[cellOf(PLAYED)], 33);
  off(PLAYED);
  check('H4c: its release ends it', [held.heldCount('lumatone'), selection.selectedKeys.size], [0, 0]);
  check('H4d: the game heard both', log.splice(0), ['press ' + PLAYED, 'release ' + PLAYED]);

  /* ── H5 ── */
  on(SWALLOWED);
  check('H5a: a swallowed press is no note', [held.heldCount('lumatone'), selection.selectedKeys.size], [0, 0]);
  off(SWALLOWED);
  check('H5b: the game heard it and its release', log.splice(0), ['press ' + SWALLOWED, 'release ' + SWALLOWED]);

  /* ── H6 ── */
  clickAt(center(cellOf(CLICKED)));
  check('H6: a canvas click goes to the game and selects nothing', [log.splice(0), selection.selectedKeys.size], [['click ' + CLICKED], 0]);

  /* ── H7 ── */
  const host = g().host;
  let a = 0;
  function tickA() { a++; }
  host.every(40, tickA);
  check('H7a: a clock is asked for at its period', [running(), periods.tickA], [['tickA'], 40]);
  clocks.tickA(); clocks.tickA();
  check('H7b: and calls its tick', a, 2);
  host.every(55, tickA);
  check('H7c: asked for again it is still one clock, at the new period', [running(), periods.tickA, Object.keys(ids).length], [['tickA'], 55, 1]);
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  clocks.tickA();
  check('H7d: it does nothing on a hidden page', a, 2);
  delete document.hidden;
  host.stop(tickA);
  check('H7e: it stops', running(), []);

  /* ── H8 ── */
  const got = [];
  const onFrame = (ms) => got.push(ms);
  host.eachFrame(onFrame);
  check('H8a: a frame is asked for', !!frame, true);
  runFrame(1000); runFrame(1016); runFrame(1041);
  check('H8b: each frame gets the time since the last, 0 on the first', got.splice(0), [0, 16, 25]);
  runFrame(9000);
  check('H8c: a late frame is capped', got.splice(0), [mode.MAX_FRAME_MS]);
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  runFrame(9016);
  check('H8d: nothing on a hidden page, and the loop waits', [got.length, !!frame], [0, true]);
  delete document.hidden;
  runFrame(20000); runFrame(20016);
  check('H8e: the first frame back counts no time', got.splice(0), [0, 16]);
  host.eachFrame(null);
  check('H8f: it stops', !!frame, false);

  /* ── H9 ── */
  host.sound(BALL, 40);
  check('H9a: the line sounds a key at the velocity asked', [[...selection.selectedKeys], held.heldCount('game'), audio.keyVelocity[cellOf(BALL)]], [[cellOf(BALL)], 1, 40]);
  host.sound(PAD1, 90);
  check('H9b: one note at a time', [[...selection.selectedKeys], held.heldCount('game'), audio.keyVelocity[cellOf(PAD1)]], [[cellOf(PAD1)], 1, 90]);
  host.hush();
  check('H9c: hush ends it', [selection.selectedKeys.size, held.heldCount('game')], [0, 0]);

  /* ── H10 ── */
  let b = 0;
  function tickB() { b++; }
  host.every(40, tickB);
  host.eachFrame(onFrame);
  host.sound(BALL, 40);
  host.end('The stub is over.');
  await wait(120);
  check('H10a: the game is off', g(), null);
  check('H10b: the modal says what the game said', [dialog()?.open === true, document.getElementById('gameOverText')?.textContent], [true, 'The stub is over.']);
  check('H10c: the clocks, the frame and the line are gone', [running(), !!frame, held.heldCount('game'), selection.selectedKeys.size], [[], false, 0, 0]);
  check('H10d: under the modal the device stays dark: every key dimmed, no shapes', wrong(normal().map(dim)), 0);
  check('H10e: the canvas shows no shapes', [white(...ballAt), white(...between)], [false, false]);
  check('H10f: the button is idle', snakeButton()?.classList.contains('playing'), false);
  host.sound(BALL, 40); host.every(40, tickB); host.show(); host.end('again');
  check('H10g: a finished game\\'s host plays nothing and ends nothing', [held.heldCount('game'), document.getElementById('gameOverText')?.textContent], [0, 'The stub is over.']);
  check('H10h: nor starts a clock', [running(), b], [[], 0]);
  document.getElementById('gameOverClose').click();
  await wait(120);
  check('H10i: closing the modal brings the layout back', [dialog().open, wrong(normal())], [false, 0]);
  /* Closed without the button, as Esc closes a dialog. */
  mode.startGame(stub);
  g().host.end('Over again.');
  await wait(120);
  check('H10j: dark again under the next result', [dialog().open, g(), wrong(normal().map(dim))], [true, null, 0]);
  dialog().close();
  await wait(120);
  check('H10k: closed without the button, the layout is back as well', wrong(normal()), 0);
  /* A game started while a result is still up keeps its picture when the
     result is closed. */
  mode.startGame(stub);
  g().host.end('Over a third time.');
  await wait(120);
  mode.startGame(stub);
  await wait(120);
  const underResult = wrong(want);
  dialog().close();
  await wait(120);
  check('H10l: a game started under a result keeps its picture when the result is closed', [underResult, wrong(want), !!g()], [0, 0, true]);
  mode.stopGame();
  await wait(80);
  check('H10m: and stopping it brings the layout back', wrong(normal()), 0);

  /* ── H11 ── */
  const before11 = made.length;
  mode.startGame(stub);
  const first = g().host;
  first.every(40, tickA);
  first.sound(BALL, 40);
  mode.startGame(stub);
  await wait(80);
  check('H11a: a second game replaces the first', [g() === made[before11 + 1], made.length], [true, before11 + 2]);
  check('H11b: the first\\'s clock and line are gone', [running(), held.heldCount('game')], [[], 0]);
  check('H11c: no modal', dialog().open, false);

  /* ── H12 ── */
  g().host.eachFrame(onFrame);
  sel('selOutline', 'qwerty');
  runFrame(30000);
  await wait(80);
  check('H12a: leaving the Lumatone outline ends the game on its next frame', [g(), got.length, !!frame, dialog().open], [null, 0, false, false]);
  sel('selOutline', 'lumatone');
  await wait(80);
  check('H12b: and the device is back to the layout', wrong(normal()), 0);

  window.setInterval = realSet; window.clearInterval = realClear;
  window.requestAnimationFrame = realRaf; window.cancelAnimationFrame = realCancel;
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
