// Keystroke driver via CDP Input.dispatchKeyEvent. Sends real keyboard
// events to the page so input.ts's keydown handler is exercised end-to-end.
//
// Keystroke specs are { key, code?, modifiers?, text? }:
//   key: a logical key (e.g. '4', 'ArrowLeft', 'Insert', '=', 'Backspace')
//   code: physical key code (e.g. 'Digit4', 'Equal'); inferred when omitted
//   modifiers: integer bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8) — or use
//              the helper { ctrl, shift, alt, meta } in `type` calls
//   text: character to type for printable keys (defaults to `key` if a
//         single character)

const MOD_ALT   = 1;
const MOD_CTRL  = 2;
const MOD_META  = 4;
const MOD_SHIFT = 8;

const KEY_CODE = {
  '0': 'Digit0', '1': 'Digit1', '2': 'Digit2', '3': 'Digit3', '4': 'Digit4',
  '5': 'Digit5', '6': 'Digit6', '7': 'Digit7', '8': 'Digit8', '9': 'Digit9',
  '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', '$': 'Digit4',
  '%': 'Digit5', '^': 'Digit6', '&': 'Digit7', '*': 'Digit8',
  '.': 'Period', ',': 'Comma',
  '=': 'Equal', '+': 'Equal', '_': 'Minus', '-': 'Minus',
  '<': 'Comma', '>': 'Period',
  'Insert': 'Insert', 'Delete': 'Delete', 'Backspace': 'Backspace',
  'Enter': 'Enter', 'Escape': 'Escape', 'Tab': 'Tab',
  'Home': 'Home', 'End': 'End',
  'ArrowLeft': 'ArrowLeft', 'ArrowRight': 'ArrowRight',
  'ArrowUp': 'ArrowUp', 'ArrowDown': 'ArrowDown',
};

function keyCodeFor(key) {
  if (KEY_CODE[key]) return KEY_CODE[key];
  if (key.length === 1 && /[a-zA-Z]/.test(key)) return 'Key' + key.toUpperCase();
  return key;
}

function buildModifiers({ ctrl = false, shift = false, alt = false, meta = false } = {}) {
  return (ctrl ? MOD_CTRL : 0) | (shift ? MOD_SHIFT : 0) | (alt ? MOD_ALT : 0) | (meta ? MOD_META : 0);
}

/** Dispatch a single key press (down + up) via CDP. */
export async function pressKey(cdp, key, mods = {}) {
  const modifiers = buildModifiers(mods);
  const code = keyCodeFor(key);
  /* Printable single-character keys send text on keydown so the page sees
   * the typed character (input.ts inspects e.key, which Chromium maps from
   * either text or unmodifiedText). */
  const isPrintable = key.length === 1 && !mods.ctrl && !mods.meta && !mods.alt;
  await cdp.send('Input.dispatchKeyEvent', {
    type: isPrintable ? 'keyDown' : 'rawKeyDown',
    key,
    code,
    modifiers,
    text: isPrintable ? key : undefined,
    unmodifiedText: isPrintable ? key : undefined,
    windowsVirtualKeyCode: virtualKey(code),
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: virtualKey(code),
  });
}

/** A small subset of windows virtual key codes for keys that Chromium's
 *  CDP layer cares about (arrow keys, modifiers, navigation). Returning
 *  0 is fine for printable keys. */
function virtualKey(code) {
  const map = {
    'ArrowLeft': 0x25, 'ArrowUp': 0x26, 'ArrowRight': 0x27, 'ArrowDown': 0x28,
    'Backspace': 0x08, 'Tab': 0x09, 'Enter': 0x0D, 'Escape': 0x1B,
    'Home': 0x24, 'End': 0x23, 'PageUp': 0x21, 'PageDown': 0x22,
    'Insert': 0x2D, 'Delete': 0x2E,
  };
  return map[code] ?? 0;
}

/** Type a sequence of keys. Each entry is either a string (single key) or
 *  a { key, ctrl, shift, alt, meta } object. After each, awaits one RAF
 *  so the page can process. */
export async function typeKeys(cdp, seq) {
  for (const entry of seq) {
    if (typeof entry === 'string') await pressKey(cdp, entry);
    else await pressKey(cdp, entry.key, entry);
    /* Single RAF wait — most input.ts handlers schedule re-render via
     * hooks.onChange which is sync; this lets layout settle. */
    await cdp.evalJSON(`new Promise((r) => requestAnimationFrame(() => r(true)))`);
  }
}

/** Convenience: focus the body so subsequent key events go to the
 *  document keydown handler (which input.ts attaches). Some focused
 *  elements (like dialog inputs) would intercept otherwise. */
export async function focusBody(cdp) {
  await cdp.evalJSON(`(() => { document.body.focus(); return true; })()`);
}
