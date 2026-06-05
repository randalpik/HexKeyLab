// Shared notation theming. A single injected stylesheet drives the colors of
// any Verovio-rendered staff via two CSS custom properties on the render
// container (set by `data-notation-theme`):
//
//   --notation-ink  staff lines, stems, flags, beams, accidentals, dots,
//                   clefs, time/key sigs, rests, slurs/ties, brackets, and the
//                   injected HEJI glyphs (which read the var via inline style).
//   --notation-bg   the surface color the consuming container paints behind
//                   the SVG (consumers apply `background: var(--notation-bg)`).
//
// Noteheads are NOT themed here — they keep their per-note baked color, swapped
// between the ink (`color`) and light-source (`data-light-color`) variants by
// applyNotationTheme() in verovio.ts.
//
// Why a TS module and not a .css file: the @hkl/notation exports map only maps
// `./*.js` → `./src/*.ts`, so a `.css` subpath import wouldn't resolve in both
// apps. Injecting once at first themed render keeps it dependency-free.

const STYLE_ID = 'hkl-notation-theme';

/* Verovio strokes every shape via `stroke: currentColor` (its own in-SVG
   <style>, keyed on an #id so class rules can't outrank it for `stroke`) and
   sets NO color/fill rules itself. So we recolor WITHOUT !important by setting
   `color` — which every currentColor stroke resolves to (stems, braces, slurs,
   staff/bar/ledger lines, beams) — plus `fill` (glyph bodies, filled
   slurs/ties/beams, text). Verovio's own fills are presentation attributes /
   inheritance, both beaten by an ordinary rule.

   Noteheads are deliberately NOT recolored here: applyNotationTheme gives them
   an INLINE color+fill (the light-source variant). Inline style beats these
   ordinary rules, so a notehead keeps its color even when a selector like
   `.beam *` matches it — and since its inline `color` equals its fill, its own
   currentColor stroke draws no ink outline. (This is why these rules must NOT
   be !important: a stylesheet !important would override the inline notehead
   fill and beamed/grouped noteheads would lose their color.) */
const CSS = `
[data-notation-theme="dark"] {
  --notation-ink: #f2f2f2; --notation-bg: #161616;
  /* Staff + bar lines: a slightly darker silver than the ink so they recede
     behind notes/glyphs (see rule 4). */
  --notation-line: #9a9a9a;
  /* Edit/playback cursor: a brighter purple than the light-mode #7226e4 for
     contrast on #161616. Consumed by the cursor overlays (cursor.ts /
     composer-frame.ts) via \`var(--cursor-color, …)\`; the overlays live inside
     the themed container so they inherit it. */
  --cursor-color: #a96bff;
}

/* 1. Universal stroke recolor. Verovio strokes EVERY shape with
   stroke:currentColor, so setting \`color\` recolors every stroke at once —
   staff/ledger/bar lines, the bare system-bracket line, stems, braces, slurs,
   beams, hairpins, tuplet/octave brackets, anything — with no class list to
   keep in sync. g.note carries its own @color attribute that its glyph
   descendants inherit, so re-assert color inside notes too. Recoloring a
   stroke is always safe (it can never create a fill artifact). */
[data-notation-theme="dark"] svg:not(#cursorOverlay),
[data-notation-theme="dark"] svg:not(#cursorOverlay) g.note * { color: var(--notation-ink); }

/* 2. Universal glyph + text fill. SMuFL glyphs render as <use> (noteheads,
   clefs, accidentals, rests, flags, time/key sigs, fermatas, ornaments, …) and
   labels / numbers / headings as <text>; neither is ever an open shape, so
   filling them is always safe — and this needs no per-glyph class list either.
   Noteheads are <use> too, but applyNotationTheme gives them an inline fill
   (the light-source color) that beats this ordinary rule. */
[data-notation-theme="dark"] svg:not(#cursorOverlay) use,
[data-notation-theme="dark"] svg:not(#cursorOverlay) text { fill: var(--notation-ink); }

/* 3. The few FILLED non-glyph shapes (filled <path>/<polygon>/<ellipse>):
   staff brace + bracket, slurs, ties, beams, augmentation dots. This is the
   complete set of Verovio's filled non-glyph primitives. Every OTHER bare
   shape (staff lines, stems, hairpins, tuplet/octave brackets, …) is an open
   stroked path — left out here so it shows only its now-ink currentColor
   stroke, never a filled area. */
[data-notation-theme="dark"] svg:not(#cursorOverlay) .grpSym, [data-notation-theme="dark"] svg:not(#cursorOverlay) .grpSym *,
[data-notation-theme="dark"] svg:not(#cursorOverlay) .slur, [data-notation-theme="dark"] svg:not(#cursorOverlay) .slur *,
[data-notation-theme="dark"] svg:not(#cursorOverlay) .tie, [data-notation-theme="dark"] svg:not(#cursorOverlay) .tie *,
[data-notation-theme="dark"] svg:not(#cursorOverlay) .beam, [data-notation-theme="dark"] svg:not(#cursorOverlay) .beam *,
[data-notation-theme="dark"] svg:not(#cursorOverlay) .dots, [data-notation-theme="dark"] svg:not(#cursorOverlay) .dots * { fill: var(--notation-ink); }

/* 4. Staff lines + bar lines + the grand-staff connecting line render in a
   darker silver (--notation-line) so the ruling recedes behind the ink-colored
   notes/glyphs. Staff lines are the 5 bare <path> DIRECT children of g.staff
   (clef/keySig/meterSig/layers are all <g>, so the child combinator isolates
   the lines from everything note-related, incl. stems/beams which live under
   g.layer). Bar lines are g.barLine / g.barLineAttr containers whose stroked
   path inherits this color. The system-initial vertical line joining the staves
   (right of the brace, full grand-staff height) is the lone bare <path> DIRECT
   child of g.system — matched so it tracks the staff/bar lines instead of
   staying ink-white (the brace symbol itself, g.grpSym, is left ink). All
   selectors out-specify rule 1's blanket \`color\`. Ledger lines are left ink —
   they read as part of the note, not the ruling. */
[data-notation-theme="dark"] svg:not(#cursorOverlay) g.staff > path,
[data-notation-theme="dark"] svg:not(#cursorOverlay) g.system > path,
[data-notation-theme="dark"] svg:not(#cursorOverlay) .barLine,
[data-notation-theme="dark"] svg:not(#cursorOverlay) .barLineAttr { color: var(--notation-line); }
`;

/** Inject the shared notation-theme stylesheet once. Idempotent; no-op when
 *  there is no DOM (e.g. a non-browser context). */
export function ensureNotationThemeStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}
