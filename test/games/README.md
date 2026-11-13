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
