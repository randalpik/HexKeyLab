// Motifs: the short melodies that reveal a hidden game, and the listener that
// hears them. Pure: the caller turns each key press into the key's spelling and
// octave (noteName / keyOctave, @hkl/shared/notes.js) and feeds it in.
//
// A motif is a specific sequence of note spellings with specific octave
// relationships. Only the spelling matters — not the tuning, and not an
// enharmonic (G♭ is not F♯). The first note may be played in any octave; every
// later note's octave is counted from the first one's.
//
// The listener is a state machine fed every key press. All motifs begin
// eligible. A press that matches the next note of some motifs keeps those
// eligible, each now waiting for its following note; the rest drop out. That
// repeats until one motif is complete, or none is left. Either way the machine
// starts over — and a press that left none eligible is heard once more as a
// possible first note, so a false start (E, E, D, …) still finds its motif.

export interface MotifNote {
  /** Spelling as noteName returns it: a letter, then '#' or 'b' per accidental. */
  name: string;
  /** Octaves above the motif's first note (0 for the first note itself). */
  octave: number;
}

export interface Motif {
  /** Id of the game this motif reveals. */
  game: string;
  /** The game's name as the Secrets toolbar shows it. */
  label: string;
  notes: ReadonlyArray<MotifNote>;
}

/** Read a motif written as "E0 D0 F#-1": each note a spelling and its octave
 *  offset from the first note. */
export function parseMotif(game: string, text: string, label: string = game): Motif {
  const notes = text.trim().split(/\s+/).map((token) => {
    const m = /^([A-G][#b]*)(-?\d+)$/.exec(token);
    if (!m) throw new Error('motif note not understood: ' + token);
    return { name: m[1], octave: +m[2] };
  });
  return { game, label, notes };
}

/** The motifs of the games that exist. Snake: the Nokia tune (bars 13–16 of
 *  Francisco Tárrega's Gran Vals, 1902), the ringtone of the phones Snake
 *  shipped on. Pong: a round of the original's three sounds, each an octave
 *  below the last: the serve, five bounces, the goal. */
export const MOTIFS: ReadonlyArray<Motif> = [
  parseMotif('snake', 'E0 D0 F#-1 G#-1 C#0 B-1 D-1 E-1 B-1 A-1 C#-1 E-1 A-1', 'Snake'),
  parseMotif('pong', 'B0 B-1 B-1 B-1 B-1 B-1 B-2', 'Pong'),
];

interface Attempt {
  motif: Motif;
  /** Notes matched so far. */
  at: number;
  /** Octave of the first note as played. */
  base: number;
}

export interface MotifListener {
  /** Hear one key press. Returns the id of the game whose motif this press
   *  completed, or null. */
  press(name: string, octave: number): string | null;
  /** Start over, forgetting any motif in progress. */
  reset(): void;
}

export function createMotifListener(motifs: ReadonlyArray<Motif> = MOTIFS): MotifListener {
  let attempts: Attempt[] = [];

  /* One pass of the machine: advance the eligible motifs (all of them, from a
     fresh start) by this press. Returns the completed game, or null with
     `attempts` holding whichever are still eligible. */
  function advance(name: string, octave: number): string | null {
    const from: Attempt[] = attempts.length
      ? attempts
      : motifs.map((motif) => ({ motif, at: 0, base: octave - motif.notes[0].octave }));
    attempts = [];
    for (const a of from) {
      const want = a.motif.notes[a.at];
      if (want.name !== name || a.base + want.octave !== octave) continue;
      if (a.at + 1 === a.motif.notes.length) { attempts = []; return a.motif.game; }
      attempts.push({ motif: a.motif, at: a.at + 1, base: a.base });
    }
    return null;
  }

  return {
    press(name, octave) {
      const midway = attempts.length > 0;
      const game = advance(name, octave);
      if (game !== null || attempts.length > 0 || !midway) return game;
      return advance(name, octave);
    },
    reset() { attempts = []; },
  };
}
