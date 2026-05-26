// Tier classifier — single entry point that branches on cfg.decays.
//
// Ports analyzer/generate-samples.js:classifyLoop + classifyDecay verbatim.
// Keep these in sync if the CLI's heuristics change — the new UI must agree
// with the CLI on tier assignment so the diagnostic report matches.

import type { AnalysisResult, Tier } from './state.js';

const VALID_TIERS: ReadonlySet<Tier> = new Set(['green', 'blue', 'yellow']);

/** Loop-path tier:
 *    fail   no segments returned, or stats missing
 *    red    ≤2 segments (or SCC broken — no perpetual cycle possible);
 *           filtered out by pickSamples and triggers filePatterns fallback
 *    yellow exactly 3 segments (perpetual loop works but low variety)
 *    blue   4+ segments, SCC OK, but ≥half are bridges (constrained variety)
 *    green  4+ segments, SCC OK, fewer than half bridges (real randomization)
 */
function classifyLoop(res: AnalysisResult | null | undefined): Tier {
  if (!res || !Array.isArray(res.segments)) return 'fail';
  const s = (res.stats || {}) as { sccOk?: boolean; bridgeCount?: number };
  const n = res.segments.length;
  const sccOk = !!s.sccOk;
  const bridges = s.bridgeCount || 0;
  if (n < 3 || !sccOk) return 'red';
  if (n < 4) return 'yellow';
  if (bridges * 2 >= n) return 'blue';
  return 'green';
}

/** Decay-path tier:
 *    fail   no fundamental found, or no result
 *    yellow drift > 50¢ from labeled pitch (suspect labeling/tuning)
 *    green  good detection within ±50¢
 */
function classifyDecay(res: AnalysisResult | null | undefined): Tier {
  if (!res || res.failReason) return 'fail';
  const drift = (res as { driftCents?: number }).driftCents;
  if (typeof drift === 'number' && Math.abs(drift) > 50) return 'yellow';
  return 'green';
}

export function classifyTier(res: AnalysisResult | null | undefined, decays: boolean): Tier {
  return decays ? classifyDecay(res) : classifyLoop(res);
}

export function isValidTier(t: Tier | undefined): boolean {
  return t !== undefined && VALID_TIERS.has(t);
}
