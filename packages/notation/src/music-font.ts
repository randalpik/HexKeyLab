// The score's music font: Verovio's stock Leipzig, except the C-clef family,
// which is Bravura's.
//
// Leipzig's C clef ends each bowl flat and joins them with two straight arms
// meeting at the center line, leaving 0.84 staff spaces between the bowls
// (Bravura 0.42, Leland 0.33) — the glyph as designed upstream, not a Verovio
// artifact. The fix is a custom Verovio font, "LeipzigHkl", that carries ONLY
// Bravura's E05C cClef / E05D cClef8vb / E07B cClefChange
// (tools/music-font/build.mjs → music-font-data.ts). Verovio looks a glyph up in
// the current font, then in `fontFallback` (default Leipzig), so every other
// glyph stays Leipzig — and layout uses the Bravura clef's own bounding box, so
// the clef gets the room it needs (Bravura's is 0.37 space wider; swapping the
// glyph into the SVG after rendering would have crowded the key signature).
//
// Every toolkit that renders score SVG must call installMusicFont once and
// spread MUSIC_FONT_OPTIONS into its options — HKL's Composer-view frame has to
// stay pixel-identical to Composer's scroll view.

import type { VerovioToolkit } from './verovio-types.js';

/** The custom font's name (the stem of the zip's root XML, which is how
 *  Verovio names a custom font; must match FONT in tools/music-font/build.mjs).
 *  Verovio writes it as the `font-family` of SMuFL text in a
 *  `<rend glyph.auth="smufl">` (metronome marks) — it contains "Leipzig" so the
 *  PDF export's font map (save.ts) still routes that text to Bravura. */
export const MUSIC_FONT = 'LeipzigHkl';

/** Spread into every option set given to a toolkit that ran installMusicFont.
 *  `resetOptions()` reverts the font to stock Leipzig; re-asserting it is a map
 *  lookup in Verovio (Toolkit::SetFont). */
export const MUSIC_FONT_OPTIONS = { font: MUSIC_FONT } as const;

/** Register the custom font on a new toolkit. Once per toolkit: Verovio keeps it
 *  in the toolkit's resources across setOptions / resetOptions / loadData. The
 *  zip (62 KB base64, nearly all of it Leipzig's woff2 for the `<rend>` text)
 *  is its own lazily loaded chunk. */
export async function installMusicFont(tk: VerovioToolkit): Promise<void> {
  const { MUSIC_FONT_ZIP } = await import('./music-font-data.js');
  tk.setOptions({ fontAddCustom: [MUSIC_FONT_ZIP], ...MUSIC_FONT_OPTIONS });
}
