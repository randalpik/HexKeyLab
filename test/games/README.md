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
  Pong motif, which is defined here and not yet registered.

**Run it before declaring any change to `apps/hkl/src/games/` done.**

## Discovery and the Secrets toolbar (page gate)

```sh
node test/games/secrets.mjs
```

Requires `pnpm dev` (the proxy at :5170). Loads the real page in headless,
muted Chromium, pinned to a private overlay relay, and plays the Nokia tune
through the input handler against a simulated Lumatone. The motif is written out
in the gate from the spec, not read from the module under test.

Checks that a fresh profile shows no Secrets button or toolbar; that the first
twelve notes reveal nothing and each is still an ordinary note; that the
thirteenth reveals the button and the toolbar with a Snake button and the count,
and saves both prefs; that the button toggles its toolbar; that Hide does
nothing when declined and removes everything when confirmed; that the motif is
not heard under the QWERTY outline; that a canvas click is heard as a note; that
a reload restores the toolbar from the prefs; and that Reset clears it. Any
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
`stepTick`, `flashTick`, `overTick`) and calls them, so each step is
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

**Run it before declaring any change to `games/mode.ts`, `games/display.ts`, the
game hooks in `lumatone/sync.ts`, `render/draw.ts`, `midi/handler.ts` and the
canvas click, or the game buttons and modal in `ui/secrets.ts` done.**
