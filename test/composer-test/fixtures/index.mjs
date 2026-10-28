// Composer test fixtures, one module per feature category.
//
// A fixture is a named Composer state: the runner resets to a blank document,
// runs the fixture's `setup` snippet in the page (m = model, c = cursor,
// r = reRender, bridge = the bridge, all from window.__hkl_composer), then types
// its `setupKeys` through real CDP key events. Every fixture then gets the
// universal invariants (placeholder, tie orphans, pagination first-fit,
// roundtrip, cursor-trace, console, splice ledger, visual baseline if declared)
// plus its own ASSERTIONS: name → [{ name, expr }], each expr returning
// { ok, detail? } in the page. See ../README.md.
//
// Each category module exports FIXTURES and ASSERTIONS; this index merges them,
// rejects duplicate names, and tags every fixture with its `category` (for
// --group) and `tier` (../fast-tier.json lists the fast tier).

import { readFileSync } from 'node:fs';
import * as accidentals from './accidentals.mjs';
import * as chords from './chords.mjs';
import * as clefs from './clefs.mjs';
import * as click from './click.mjs';
import * as cursor from './cursor.mjs';
import * as emptyCells from './empty-cells.mjs';
import * as engraving from './engraving.mjs';
import * as expression from './expression.mjs';
import * as files from './files.mjs';
import * as grace from './grace.mjs';
import * as instruments from './instruments.mjs';
import * as keyboard from './keyboard.mjs';
import * as layerCursor from './layer-cursor.mjs';
import * as mapping from './mapping.mjs';
import * as musicxml from './musicxml.mjs';
import * as notationCommands from './notation-commands.mjs';
import * as pageLayout from './page-layout.mjs';
import * as pageSplice from './page-splice.mjs';
import * as performance from './performance.mjs';
import * as playback from './playback.mjs';
import * as scroll from './scroll.mjs';
import * as selection from './selection.mjs';
import * as signatures from './signatures.mjs';
import * as slurs from './slurs.mjs';
import * as structure from './structure.mjs';
import * as syntonic from './syntonic.mjs';
import * as ties from './ties.mjs';
import * as tuplets from './tuplets.mjs';
import * as undo from './undo.mjs';

export const CATEGORIES = {
  accidentals: accidentals,
  chords: chords,
  clefs: clefs,
  click: click,
  cursor: cursor,
  'empty-cells': emptyCells,
  engraving: engraving,
  expression: expression,
  files: files,
  grace: grace,
  instruments: instruments,
  keyboard: keyboard,
  'layer-cursor': layerCursor,
  mapping: mapping,
  musicxml: musicxml,
  'notation-commands': notationCommands,
  'page-layout': pageLayout,
  'page-splice': pageSplice,
  performance: performance,
  playback: playback,
  scroll: scroll,
  selection: selection,
  signatures: signatures,
  slurs: slurs,
  structure: structure,
  syntonic: syntonic,
  ties: ties,
  tuplets: tuplets,
  undo: undo,
};

const FAST = new Set(JSON.parse(readFileSync(new URL('../fast-tier.json', import.meta.url), 'utf8')).fixtures);

export const FIXTURES = {};
export const FIXTURE_ASSERTIONS = {};
for (const [category, mod] of Object.entries(CATEGORIES)) {
  for (const [name, spec] of Object.entries(mod.FIXTURES)) {
    if (FIXTURES[name]) throw new Error('duplicate fixture ' + name + ' in ' + category + ' and ' + FIXTURES[name].category);
    FIXTURES[name] = { ...spec, category, tier: FAST.has(name) ? 'fast' : 'full' };
  }
  for (const [name, list] of Object.entries(mod.ASSERTIONS)) {
    if (!mod.FIXTURES[name]) throw new Error(category + ': assertions for unknown fixture ' + name);
    FIXTURE_ASSERTIONS[name] = list;
  }
}
for (const name of FAST) if (!FIXTURES[name]) throw new Error('fast-tier.json names unknown fixture ' + name);
