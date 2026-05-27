// Enumerate every key pair on the 280-key Lumatone layout in a given tuning
// mode, surface interval names, ratios, and (ord, qual, s, z, h) decomposition,
// and group by minimum taxicab distance. Designed to identify naming gaps in
// `src/tuning/intervals.ts` — i.e. (ord, qual, s, z) tuples that currently
// produce comma-decomposition names but are reachable close to the keyboard
// reference and deserve explicit overrides.
//
// Run: `npx tsx test/interval-names/enumerate.ts [options]`
//
// Options:
//   --mode <E|5|P|D|7|V>    tuning mode (default '5')
//   --q-min <n>             keep only cells with q ≥ n
//   --q-max <n>             keep only cells with q ≤ n
//   --max-dist <n>          keep only pairs with taxicab distance < n
//   --commas-only           filter to entries whose name contains comma/schisma/diesis or ± signs
//   --by-class              group output by (ord, qual) instead of by min distance
//   --include <regex>       additional substring/regex filter on name
//   --limit <n>             cap rows printed (default 200)
//
// Examples:
//   # Semiditonal-mode comma-decomp entries within ±2 bands, dist < 9
//   npx tsx test/interval-names/enumerate.ts --mode D --q-min -7 --q-max 7 --max-dist 9 --commas-only
//
//   # Septimal mode, group by class
//   npx tsx test/interval-names/enumerate.ts --mode 7 --by-class --commas-only
//
//   # All instances of (2, d) (the Pythagorean comma class)
//   npx tsx test/interval-names/enumerate.ts --mode D --include 'diminished 2nd|Pythagorean comma'

import { intervalNameFromCoords, classifyDiatonic, solveCommas, pythagRefExp } from '../../apps/hkl/src/tuning/intervals.ts';
import { jiRatioWithState } from '../../apps/hkl/src/tuning/ratios.ts';
import { baseKeys } from '../../apps/hkl/src/layout/baseKeys.ts';
import type { TuningStateLike } from '../../apps/hkl/src/tuning/regions.ts';

type Mode = 'E' | '5' | 'P' | 'D' | '7' | 'V';

interface Args {
  mode: Mode;
  qMin: number;
  qMax: number;
  maxDist: number;
  commasOnly: boolean;
  byClass: boolean;
  include: RegExp | null;
  limit: number;
}

function parseArgs(): Args {
  const a: Args = {
    mode: '5', qMin: -Infinity, qMax: Infinity, maxDist: Infinity,
    commasOnly: false, byClass: false, include: null, limit: 200,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--mode':         a.mode = v as Mode; i++; break;
      case '--q-min':        a.qMin = +v; i++; break;
      case '--q-max':        a.qMax = +v; i++; break;
      case '--max-dist':     a.maxDist = +v; i++; break;
      case '--commas-only':  a.commasOnly = true; break;
      case '--by-class':     a.byClass = true; break;
      case '--include':      a.include = new RegExp(v); i++; break;
      case '--limit':        a.limit = +v; i++; break;
      case '-h': case '--help':
        console.log(`Usage: npx tsx test/interval-names/enumerate.ts [options]\n` +
          `See header comment in ${import.meta.url} for option details.`);
        process.exit(0);
    }
  }
  if (!['E', '5', 'P', 'D', '7', 'V'].includes(a.mode)) { console.error(`bad --mode: ${a.mode}`); process.exit(2); }
  return a;
}

function makeState(mode: Mode): TuningStateLike {
  return { mode, equalEnabled: mode === 'E', septimalEnabled: mode === '7', septimalW: 1 };
}

const log3 = Math.log2(3), log5 = Math.log2(5), log7 = Math.log2(7);
function decompose(act: [number, number, number, number], pRef: [number, number, number, number]):
  { s: number; z: number; h: number; octs: number } | null {
  const lA = act[0] + act[1] * log3 + act[2] * log5 + act[3] * log7;
  const lR = pRef[0] + pRef[1] * log3;
  const octs = Math.round(lA - lR);
  const red: [number, number, number, number] = [act[0] - octs, act[1], act[2], act[3]];
  const de: [number, number, number, number] = [red[0] - pRef[0], red[1] - pRef[1], red[2] - pRef[2], red[3] - pRef[3]];
  const sol = solveCommas(de);
  if (!sol) return null;
  return { s: sol[0], z: sol[1], h: sol[2], octs };
}

interface Rec {
  name: string; ratio: string; cls: string;
  s: number; z: number; h: number; extraOct: number;
  dist: number; count: number;
  example: [number, number, number, number];
}

function commaPattern(s: string): boolean {
  return /comma|schisma|diesis|\+|−/.test(s);
}

const args = parseArgs();
const state = makeState(args.mode);
const seen = new Map<string, Rec>();
const N = baseKeys.length;
for (let i = 0; i < N; i++) {
  const [q1, r1] = baseKeys[i];
  if (q1 < args.qMin || q1 > args.qMax) continue;
  for (let j = i + 1; j < N; j++) {
    const [q2, r2] = baseKeys[j];
    if (q2 < args.qMin || q2 > args.qMax) continue;
    const dist = Math.abs(q2 - q1) + Math.abs(r2 - r1);
    if (dist >= args.maxDist) continue;
    const name = intervalNameFromCoords(q1, r1, q2, r2, state);
    if (args.commasOnly && !commaPattern(name)) continue;
    if (args.include && !args.include.test(name)) continue;
    const cls = classifyDiatonic(q1, r1, q2, r2);
    const pRef = pythagRefExp(cls.ord, cls.qual);
    const { e, num, den } = jiRatioWithState(q1, r1, q2, r2, state);
    const neg: [number, number, number, number] = [-e[0], -e[1], -e[2], -e[3]];
    const d1 = decompose(e, pRef);
    const d2 = decompose(neg, pRef);
    const score = (d: typeof d1): number => d ? Math.abs(d.s) + Math.abs(d.z) + Math.abs(d.h) : Infinity;
    const d = score(d1) <= score(d2) ? d1 : d2;
    const ratio = `${num}:${den}`;
    const key = name + '|' + ratio;
    const rec = seen.get(key);
    if (rec) {
      rec.count++;
      if (dist < rec.dist) { rec.dist = dist; rec.example = [q1, r1, q2, r2]; }
    } else {
      seen.set(key, {
        name, ratio,
        cls: `(${cls.ord},${cls.qual},+${cls.extraOct})`,
        s: d?.s ?? 0, z: d?.z ?? 0, h: d?.h ?? 0,
        extraOct: cls.extraOct,
        dist, count: 1, example: [q1, r1, q2, r2],
      });
    }
  }
}

const all = [...seen.values()];
console.log(`mode=${args.mode} q∈[${args.qMin === -Infinity ? '-∞' : args.qMin},${args.qMax === Infinity ? '+∞' : args.qMax}] ` +
  `dist<${args.maxDist === Infinity ? '∞' : args.maxDist} commas-only=${args.commasOnly} → ${all.length} unique (name, ratio) tuples`);
console.log('');

if (args.byClass) {
  const byCls = new Map<string, Rec[]>();
  for (const r of all) {
    if (!byCls.has(r.cls)) byCls.set(r.cls, []);
    byCls.get(r.cls)!.push(r);
  }
  const sorted = [...byCls.entries()].sort((a, b) => {
    const [oA, qA] = a[0].slice(1, -1).split(',');
    const [oB, qB] = b[0].slice(1, -1).split(',');
    return +oA - +oB || qA.localeCompare(qB);
  });
  let printed = 0;
  outer: for (const [cls, recs] of sorted) {
    recs.sort((a, b) => a.dist - b.dist || b.count - a.count);
    console.log(`=== ${cls} ===`);
    for (const r of recs) {
      const ex = `(${r.example[0]},${r.example[1]})→(${r.example[2]},${r.example[3]})`;
      console.log(`  (s=${r.s.toString().padStart(2)},z=${r.z.toString().padStart(2)},h=${r.h.toString().padStart(2)}) ` +
        `dist=${r.dist.toString().padStart(2)} count=${r.count.toString().padStart(4)} ${r.ratio.padEnd(22)} ${ex.padEnd(23)} → "${r.name}"`);
      if (++printed >= args.limit) break outer;
    }
  }
} else {
  all.sort((a, b) => a.dist - b.dist || b.count - a.count);
  console.log('dist | count | class           | (s,z,h)      | ratio                  | example                  | name');
  console.log('---|---|---|---|---|---|---');
  for (let k = 0; k < Math.min(all.length, args.limit); k++) {
    const r = all[k];
    const ex = `(${r.example[0]},${r.example[1]})→(${r.example[2]},${r.example[3]})`;
    const sz = `(${r.s.toString().padStart(2)},${r.z.toString().padStart(2)},${r.h.toString().padStart(2)})`;
    console.log(`${r.dist.toString().padStart(3)} | ${r.count.toString().padStart(4)} | ${r.cls.padEnd(15)} | ${sz} | ${r.ratio.padEnd(22)} | ${ex.padEnd(24)} | ${r.name}`);
  }
  if (all.length > args.limit) console.log(`... ${all.length - args.limit} more (raise --limit to see)`);
}
