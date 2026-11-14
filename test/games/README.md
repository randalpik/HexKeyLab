# test/games

## The games oracle (pure Node)

```sh
node --import ./test/orchestrator-smoke/register-ts.mjs test/games/oracle.mjs
```

Checks the rules of the hidden games against the real modules in
`apps/hkl/src/games/`. No dev server, browser or device is needed. Its last line
is `N/N checks passed`, and it exits 1 on any failure.

- **A, board** (`board.ts`): the 280 keys, neighbors and rim recomputed from
  `baseKeys`; the halves (140 each, the two keys on the midline, and every key
  on the side the canvas draws it under the Lumatone rotation); `HEADINGS`
  counter-clockwise on the canvas.
- **B, Snake** (`snake.ts`): the start state, the walk to the wall, turns, the
  reversal into the body, following the tail, eating, each food tier on a
  constructed board, and 300 seeded games that check the body stays connected
  and distinct, the food stays off the snake, and length is 4 plus foods eaten.
- **C, motifs** (`motifs.ts`): the table, the Nokia tune from any E, a wrong
  octave, an enharmonic, a false start, two motifs sharing a start, and the
  Pong motif, registered as the spec writes it.
- **D, the case's frame and the scene** (`board.ts` `keyPoint`, `scene.ts`):
  every key where the gate's own turn of `baseKeys` puts it (centroid at the
  origin, the board step along x, neighbors one key apart, the long sides at
  ±4.31, each key's x on the side of its half, two keys on the center line);
  a tile shape exactly 1, no shape exactly 0, a shape over everything exactly 1
  everywhere; a ball on a key covering π/(2√3) of it and nothing else; a ball,
  a bumper, a paddle along and across the rows, a dash, and a ball over a dash,
  each within 1% of a brute-force count made in the gate; and a ball's total
  light the same at 300 seeded positions.
- **E, Pong** (`pong.ts`, and the field in `board.ts`): the long sides through
  five corner keys each and the ends square to the rows, both pairs symmetric;
  the two keys on the center line; the key under a point, and none in a notch
  of the staircase along a long side; the paddle table;
  over every key and every pair, a press honored exactly when the gate's own
  geometry says its shape clears the ball's starting place (139 keys and 2,812
  paddles a half); a press refused against the ball in play; the serve's
  warning; 2,000 seeded serves inside the ruled ranges, and the ranges against
  paths traced in the gate (every whole degree inside bounces at most twice,
  one degree more bounces a third time, and the module's ball agrees bounce for
  bounce); reflection off a long side, a bumper, a paddle's side and its round
  end against the gate's own contact point; several hundred shots at a paddle at
  speed 100 (the speed has no limit), in 16 ms and 100 ms frames, each a hit with
  the ball never left inside; a goal, the pause and the next warning; first to 3;
  an end and a long side met inside one step, in the order the path meets them
  (a goal that comes first is no bounce); the speed's rise with no limit and its
  drop after a goal; and the shapes drawn.

**Run it before declaring any change to `apps/hkl/src/games/` done.**

## Discovery and the Secrets toolbar (page gate)

```sh
node test/games/secrets.mjs
```

Requires `pnpm dev` (the proxy at :5170). Loads the real page in headless,
muted Chromium, pinned to a private overlay relay, and plays the Nokia tune and
then the Pong motif through the input handler against a simulated Lumatone. The
motifs are written out in the gate from the spec, not read from the module
under test.

Checks that a fresh profile shows no Secrets button or toolbar; that the first
twelve notes reveal nothing and each is still an ordinary note; that the
thirteenth reveals the button and the toolbar with a Snake button and the count
("1/2 secrets found"), and saves both prefs; that the button toggles its
toolbar; that Hide does nothing when declined and removes everything when
confirmed; that the motif is not heard under the QWERTY outline; that a canvas
click is heard as a note; that six notes of the Pong motif add nothing and the
seventh adds a Pong button, with "All secrets found"; that a reload restores
the toolbar from the prefs; and that Reset clears it. Any
console error fails the gate, except the "MIDI access denied" line every
headless run logs.

**Run it before declaring any change to `games/discovery.ts`, `ui/secrets.ts`,
the Secrets prefs, or the strike paths in `input/held.ts` and the canvas click
done.**

## Snake, running (page gate)

```sh
node test/games/snake.mjs
```

Requires `pnpm dev`. Plays a whole game in headless, muted Chromium against a
simulated Lumatone on firmware 1.5.0 that ACKs every message. The game's clocks
are driven by hand: the gate takes the intervals the game asks for (its step,
its food flash, its game-over flash, recognized by the tick function's name:
`stepTick`, `flashTick`, `overTick`; the host names each interval's callback
after the tick it wraps) and calls them, so each step is
deterministic and nothing waits on real time. It also pins the ruled timings:
300 ms a step, 200 ms a flash, three game-over flashes, a one-second hold. The
gate states the board itself (white, the food's own color, the dim level it
reads from `games/display.ts`) and compares it with what the device was sent.

Checks that the Snake button starts a waiting game with the start body and
marks itself as playing; that the device shows four white keys, the food and a
dimmed layout, and the canvas the same; that the food flashes and nothing moves
before the first press; that the first press starts the step clock and is
neither a turn nor a note; that a step moves the head, plays its note alone and
quietly, and does not flash the food; that the right half turns clockwise and
the left counter-clockwise,
from a key or a canvas click; that eating grows the snake and accents the note;
that the computer keyboard still plays; that the ref-edit modifier keeps
precedence and the board follows the ref change; that a hidden page pauses;
that the wall starts the game-over sequence (the note released, the step and
flash clocks stopped, the whole board dark, the snake going off and then on and
off three times, presses swallowed, the game still up through the hold with the
snake off) and that the
game then exits with the modal reporting the score and the device and canvas
restored; that leaving the Lumatone outline, the button again (also in the
middle of the sequence), and Hide each stop a game without a modal; and that
starting under another outline switches to the Lumatone outline.

The picture on the per-key path of older firmware, and through a ref slide, is
pinned hardware-free by section L of `test/hkl-midi/frame-sync.mjs`.

**Run it before declaring any change to `games/snake-game.ts`, `games/mode.ts`,
`games/display.ts`, the game hooks in `lumatone/sync.ts`, `render/draw.ts`,
`midi/handler.ts` and the canvas click, or the game buttons and modal in
`ui/secrets.ts` done.**

## Pong, running (page gate)

```sh
node test/games/pong.mjs
```

Requires `pnpm dev`. Plays a match in headless, muted Chromium against the same
simulated Lumatone. The game's clock is the host's animation frame, driven by
hand in steps of 50 ms or less (the host caps a frame at 100 ms), and
`Math.random` is pinned for the first serve, so the ball's path is known. Where
a step needs the ball somewhere, the gate sets it there, the way the Snake gate
parks the food. The rules themselves are the oracle's (section E); this gate is
about the driver and what reaches the device, the canvas and the notes.

Checks that the Pong button starts a game that waits with no frame clock and no
ball, the device showing the darkened layout and the solid center line, which
runs through the starting key; that the first press starts the warning and is a
bumper besides, sounding at the quiet velocity whatever the touch, with the
ball lit on the starting key at once, wider than the line;
that the warning is lit, dark, three times at 200 ms a change, in silence, and
the ball is served at 1.2 s; that in play the ball is where its speed puts it
along the pinned serve, shown on the device by tile share and on the canvas as
a disc; that the ball's line sounds the key under it quietly, one note at a
time, and holds the last note in a notch of the staircase; that a second key
makes a paddle with both keys sounding, while a third key, a key on the center
line and a key in the ball's way are swallowed; that a canvas click does
nothing; that a hit turns the ball back, strikes the paddle's keys again at the
accent velocity as the players' own notes, and accents the ball's key with
them; that releasing a paddle key leaves a bumper; that a goal counts, ends the
line and removes the ball for the one-second pause before the next warning;
that the third goal ends the match with the modal naming the winner and the
score, the device and the canvas restored, and a key still held still sounding
for its player; and that the Pong button again stops a game without a modal.

Its last INFO line reports, without judging, what one canvas redraw costs with
Pong on screen and without it, and what the scene's tile shares cost.

**Run it before declaring any change to `games/pong-game.ts`, `games/pong.ts`,
`games/mode.ts`, `games/scene.ts`, or `restrikeHeld` in `input/held.ts` done.**

## The host, with a stub game (page gate)

```sh
node test/games/host.mjs
```

Requires `pnpm dev`. Snake uses only part of what the host (`games/mode.ts`)
offers, so this gate starts a driver of its own, under Snake's id (the toolbar
stops a game it has no button for), against the same simulated Lumatone. The
stub shows a ball on a key, a paddle along a row and a square-ended dash, plays
a press of one key at velocity 33 and swallows every other. The gate drives the
host's interval and its animation frames by hand (the frame callback is
`gameFrame`).

Checks that the device shows each key blended toward white by the share of its
tile under the shapes (the shares are the oracle's business; the OKLab blend
over the darkened color is stated in the gate), with the undarkened key
untouched; that the canvas is white at the ball's center and between two keys
under the paddle, and not on a key the shapes miss; that a played press is a
note at the game's velocity whatever the touch, a swallowed one is no note, and
the game hears both and their releases; that a canvas click goes to the game
and selects nothing; that a clock runs at its period, stays one clock when
asked for twice, does nothing on a hidden page, and stops; that the frame clock
hands over the time since the last frame, 0 on the first and on the first after
a hidden page, capped at `MAX_FRAME_MS`; that the game's line is one note at a
time and `hush` ends it; that `end(text)` takes the game off the keys, shows
the text in the modal and restores the device and the canvas, and that the
host does nothing afterward; that a second game replaces the first; and that
leaving the Lumatone outline ends a game on its next frame.

**Run it before declaring any change to `games/mode.ts`, `games/scene.ts`,
`games/display.ts`, or the game hooks in `lumatone/sync.ts`, `render/draw.ts`
and `midi/handler.ts` done.**
