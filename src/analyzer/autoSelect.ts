// Auto-select heuristic — port of analyzer/generate-samples.js:pickSamples().
//
// Two-pass selection for loop instruments:
//   Pass 1 — spine: walk green samples at ~4-semitone spacing, pick the best
//            within each ±2-semitone window. Tiebreak by tier > segments > steady duration.
//   Pass 2 — fill: identify gaps > 4 semitones in the spine (between picks
//            and at head/tail of the usable range) and insert blue+yellow
//            samples at ~4-semitone spacing inside each gap, anchored so no
//            fill lands within 2 semitones of a spine pick.
//
// Decay instruments: keep every valid (green/blue/yellow) sample.

import type { SampleSlot, Tier } from './state.js';

const TIER_RANK: Record<Tier, number> = { green: 4, blue: 3, yellow: 2, red: 1, fail: 0 };

export interface AutoSelectOpts {
  /** Inclusive MIDI range for "keep all green" override; greens in this range
   *  bypass spine-spacing and are kept unconditionally. Pass null/undefined
   *  to disable. */
  keepAllGreenLowMidi?: number | null;
  keepAllGreenHighMidi?: number | null;
}

interface Cand {
  slot: SampleSlot;
  midi: number;
  tier: Tier;
}

function tiebreak(a: Cand, b: Cand): number {
  if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[b.tier] - TIER_RANK[a.tier];
  const na = (a.slot.result?.segments?.length) || 0;
  const nb = (b.slot.result?.segments?.length) || 0;
  if (na !== nb) return nb - na;
  const sa = ((a.slot.result?.stats as { steadyDurSec?: number } | undefined)?.steadyDurSec) || 0;
  const sb = ((b.slot.result?.stats as { steadyDurSec?: number } | undefined)?.steadyDurSec) || 0;
  return sb - sa;
}

/** Walk from startMidi to endMidi by 4-semitone targets; in each ±2-semitone
 *  window pick the best candidate by tiebreak; advance to best.midi + 4 after
 *  each pick. excludeFrom + minSep guard fills from clustering against the
 *  spine. */
function spacedPick(
  candidates: Cand[],
  startMidi: number,
  endMidi: number,
  excludeFrom: Cand[] | null,
  minSep: number,
): Cand[] {
  if (candidates.length === 0) return [];
  const sorted = candidates.slice().sort((a, b) => a.midi - b.midi);
  const picked: Cand[] = [];
  const seen = new Set<string>();
  let target = startMidi;
  while (target <= endMidi + 2) {
    const win = sorted.filter(r =>
      Math.abs(r.midi - target) <= 2
      && !seen.has(r.slot.name)
      && (!excludeFrom || !excludeFrom.some(p => Math.abs(r.midi - p.midi) < minSep))
      && !picked.some(p => Math.abs(r.midi - p.midi) < minSep)
    );
    if (win.length === 0) { target += 4; continue; }
    const best = win.slice().sort(tiebreak)[0];
    picked.push(best);
    seen.add(best.slot.name);
    target = best.midi + 4;
  }
  return picked;
}

/** Returns the slot names that auto-select would pick. */
export function pickSamples(
  slots: SampleSlot[],
  decays: boolean,
  opts: AutoSelectOpts = {},
): string[] {
  const usable: Cand[] = slots
    .filter(s => s.tier === 'green' || s.tier === 'blue' || s.tier === 'yellow')
    .map(s => ({ slot: s, midi: s.midi, tier: s.tier as Tier }));
  if (usable.length === 0) return [];
  usable.sort((a, b) => a.midi - b.midi);

  // Decay instruments: keep every valid sample (typically pre-curated by the
  // soundfont author).
  if (decays) return usable.map(c => c.slot.name);

  // Pass 1: green spine. No min-sep within spine (allow close greens — both
  // are loop-quality and redundancy is fine).
  const greens = usable.filter(c => c.tier === 'green');
  let spine: Cand[] = [];
  if (greens.length > 0) {
    const loM = opts.keepAllGreenLowMidi;
    const hiM = opts.keepAllGreenHighMidi;
    const inRange = (loM != null && hiM != null)
      ? greens.filter(g => g.midi >= loM && g.midi <= hiM)
      : [];
    const outOfRange = (loM != null && hiM != null)
      ? greens.filter(g => g.midi < loM || g.midi > hiM)
      : greens;
    const spaced = outOfRange.length > 0
      ? spacedPick(outOfRange, outOfRange[0].midi, outOfRange[outOfRange.length - 1].midi, null, 0)
      : [];
    spine = inRange.concat(spaced);
  }
  spine.sort((a, b) => a.midi - b.midi);

  // Pass 2: blue + yellow fill in gaps > 4 semitones (head/tail edges count).
  const fillTier = usable.filter(c => c.tier === 'blue' || c.tier === 'yellow');
  const minMidi = usable[0].midi;
  const maxMidi = usable[usable.length - 1].midi;
  const FILL_MIN_SEP = 2;
  interface Gap { lowExcl: number; highExcl: number; isHead: boolean; isTail: boolean }
  const gaps: Gap[] = [];
  if (spine.length === 0) {
    gaps.push({ lowExcl: minMidi - 1, highExcl: maxMidi + 1, isHead: false, isTail: false });
  } else {
    if (spine[0].midi - minMidi > 4) {
      gaps.push({ lowExcl: minMidi - 1, highExcl: spine[0].midi, isHead: true, isTail: false });
    }
    for (let i = 1; i < spine.length; i++) {
      if (spine[i].midi - spine[i - 1].midi > 4) {
        gaps.push({ lowExcl: spine[i - 1].midi, highExcl: spine[i].midi, isHead: false, isTail: false });
      }
    }
    const last = spine[spine.length - 1];
    if (maxMidi - last.midi > 4) {
      gaps.push({ lowExcl: last.midi, highExcl: maxMidi + 1, isHead: false, isTail: true });
    }
  }

  const fills: Cand[] = [];
  for (const gap of gaps) {
    const inGap = fillTier.filter(r => r.midi > gap.lowExcl && r.midi < gap.highExcl);
    if (inGap.length === 0) continue;
    const startTarget = gap.isHead ? inGap[0].midi : gap.lowExcl + 4;
    const endTarget = gap.isTail ? inGap[inGap.length - 1].midi : gap.highExcl - 1;
    const excludeFrom = spine.length > 0 ? spine.concat(fills) : null;
    const filled = spacedPick(inGap, startTarget, endTarget, excludeFrom, FILL_MIN_SEP);
    for (const f of filled) fills.push(f);
  }

  const all = spine.concat(fills);
  all.sort((a, b) => a.midi - b.midi);
  return all.map(c => c.slot.name);
}
