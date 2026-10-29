// Octave-consistency check for the piano-footprint picker.
//
// For each MIDI N the picker (apps/hkl/src/tuning/picker.ts) chooses the cell
// piano input resolves to. Its SPELLING must be octave-consistent: if MIDI N is
// spelled X in octave o, MIDI N+12 must be spelled X in octave o+1 — otherwise
// the canonical spelling of a pitch class drifts as the octave changes, which
// is musically wrong and visually disruptive. WHERE the octave sits is the
// picker's business (identical pitches go to the cell nearest the ref), so this
// checks names and spelled octaves, not positions.
//
// Spelling consistency comes from the ranking itself: TH is octave- and
// complement-reduced, so an octave-equivalent candidate ranks the same in every
// octave; the tritone (the one place two spellings tie) always takes the
// augmented 4th.
//
// Run (every mode × mapping, refs across one band, refR ∈ [−3, 3]):
//   node --import ./test/orchestrator-smoke/register-ts.mjs test/bounds-probe/octave-consistency.mjs
//
// Syntonic / Polysyntonic are REPORTED, not gated (Max, 2026-10-26: some
// inconsistency there is expected — the layout offers a spelling's 5-limit
// pitch in one octave's band and not the next). Ties can't cause breaks (the
// tritone always takes the A4), so every S/Y break is availability.
//
// History: an earlier tenneyHeightFromExps did NOT octave- and complement-
// reduce, so |e₂| asymmetry across octaves flipped 5/76 pairs in 5-limit (more
// in 7-limit). Exits non-zero on any inconsistency outside S/Y.

import { TUNING_MODES, anchorOf } from '../../packages/shared/src/freq.ts';
import { noteName, keyOctave } from '../../packages/shared/src/notes.ts';
import { MAPPINGS, bandWidth } from '../../packages/shared/src/mapping.ts';
import { pianoFootprint } from '../../apps/hkl/src/tuning/picker.ts';

let total = 0, bad = 0;
for (const mapping of MAPPINGS) {
  for (const mode of TUNING_MODES) {
    let modeBad = 0, modeTotal = 0;
    const examples = [];
    for (let refQ = 0; refQ < bandWidth(mapping); refQ++) {
      for (let refR = -3; refR <= 3; refR++) {
        const cells = pianoFootprint(refQ, refR, {
          mode, mapping, anchor: anchorOf(refQ, mapping), banded: true,
          equalEnabled: mode === 'E', septimalEnabled: mode === '7', septimalW: 3,
        });
        for (let i = 0; i + 12 < cells.length; i++) {
          const [q1, r1] = cells[i], [q2, r2] = cells[i + 12];
          const a = anchorOf(refQ, mapping);
          const n1 = noteName(q1, r1, mapping, a, true), n2 = noteName(q2, r2, mapping, a, true);
          const o1 = keyOctave(q1, r1, mapping, a, true), o2 = keyOctave(q2, r2, mapping, a, true);
          modeTotal++;
          if (n1 !== n2 || o2 !== o1 + 1) {
            modeBad++;
            if (examples.length < 4) {
              examples.push(`ref (${refQ},${refR}) MIDI ${21 + i}→${33 + i}: ${n1}${o1} (${q1},${r1}) vs ${n2}${o2} (${q2},${r2})`);
            }
          }
        }
      }
    }
    const reportOnly = mode === 'S' || mode === 'Y';
    if (!reportOnly) { total += modeTotal; bad += modeBad; }
    console.log(`${mapping.padEnd(11)} ${mode}: ${modeBad}/${modeTotal} octave pairs inconsistent`
      + (reportOnly ? '  (report only: availability)' : ''));
    for (const e of examples) console.log('    ' + e);
  }
}
console.log(bad === 0
  ? `\n✓ spelling is octave-consistent outside S/Y (${total} pairs)`
  : `\n✗ ${bad}/${total} octave pairs inconsistent outside S/Y`);
process.exit(bad === 0 ? 0 : 1);
