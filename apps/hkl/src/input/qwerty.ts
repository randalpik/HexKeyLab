// QWERTY layout: maps physical computer-keyboard keys to BASE (q, r) lattice
// coordinates. Used by:
//   • input/keyboard-notes.ts — adds refSpine offset at note-on/off time,
//     mirroring fixedMidiToKey(). The same physical key plays a different
//     lattice cell at each ref, so the keyboard "rides with" the lattice
//     the same way the Lumatone does.
//   • render/draw.ts — qwertyKeys is used to compute the outline polygon
//     and the bounds.
//
// Each row covers a contiguous q-range at fixed r; each row down is one
// minor third lower (Δq=+1, Δr=-1). H = (0, 0) at ref A3.

interface RowSpec {
  /** event.code values, left-to-right */
  codes: readonly string[];
  /** q value of the leftmost code */
  qStart: number;
  /** r value (constant across the row) */
  r: number;
}

const rows: readonly RowSpec[] = [
  {
    codes: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6',
      'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal'],
    qStart: -7,
    r: 2,
  },
  {
    codes: ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY',
      'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight'],
    qStart: -6,
    r: 1,
  },
  {
    codes: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH',
      'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote'],
    qStart: -5,
    r: 0,
  },
  {
    codes: ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB',
      'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'],
    qStart: -4,
    r: -1,
  },
];

const map: Record<string, readonly [number, number]> = {};
const keys: [number, number][] = [];
for (const row of rows) {
  for (let i = 0; i < row.codes.length; i++) {
    const q = row.qStart + i;
    map[row.codes[i]] = [q, row.r] as const;
    keys.push([q, row.r]);
  }
}

export const qwertyKeyMap: Readonly<Record<string, readonly [number, number]>> = map;
export const qwertyKeys: ReadonlyArray<readonly [number, number]> = keys;
