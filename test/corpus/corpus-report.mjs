#!/usr/bin/env node
// Corpus report over batch-import.mjs records (2026-10-20, partition F's
// Phase 0): import outcomes and the change-weighted reach-back curve per
// section, aggregated per sample set. Records carry the partition-inputs dump;
// the optional survey (mxl survey.json) supplies the set each file belongs to.
//
//   node test/balance/curve-batch.mjs is the per-document view; this is the
//   aggregate:  node test/corpus/corpus-report.mjs <outDir> [--survey survey.json] [--gamma 0.03] [--json out.json]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeSeg, fillsOf } from '../balance/partition-f.mjs';
import { distinctLayouts, pick } from '../balance/curve-batch.mjs';

const dir = process.argv[2];
const opt = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const GAMMA = Number(opt('--gamma', 0.03));
const SWEEP = [0, 0.01, 0.02, 0.03, 0.05, 0.08];
const surveyPath = opt('--survey', null), jsonOut = opt('--json', null);
const setOf = new Map();
if (surveyPath) for (const r of JSON.parse(readFileSync(surveyPath, 'utf8'))) setOf.set(r.hash, r.set);
const q = (xs, p) => { if (!xs.length) return NaN; const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : '  -  ');
const dist = (xs) => `n ${xs.length}  p10 ${f3(q(xs, 0.1))}  p25 ${f3(q(xs, 0.25))}  med ${f3(q(xs, 0.5))}  p75 ${f3(q(xs, 0.75))}  p90 ${f3(q(xs, 0.9))}`;
const hist = (xs, edges) => edges.concat([Infinity]).map((e, i, a) => {
  const lo = i === 0 ? -Infinity : a[i - 1]; const n = xs.filter((x) => x >= lo && x < e).length;
  return `${i === 0 ? '<' + e : e === Infinity ? '≥' + a[i - 1] : a[i - 1] + '–' + e}: ${n}`; }).join('  ');
const norm = (m) => m.replace(/\s+/g, ' ').trim().replace(/#?\b[a-z]-[a-z0-9]+-[a-z0-9]+\b/g, '<id>').replace(/'[^']*'/g, "'…'").replace(/\d+(\.\d+)?/g, 'N').slice(0, 140);

const recs = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ name: f.slice(0, -5), ...JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
const report = { gamma: GAMMA, sets: {} };
for (const set of [...new Set(recs.map((r) => setOf.get(r.name) ?? 'all'))].sort()) {
  const R = recs.filter((r) => (setOf.get(r.name) ?? 'all') === set);
  console.log(`\n================ ${set}: ${R.length} files ================`);
  /* ── import ── */
  const ok = R.filter((r) => r.import?.ok), failed = R.filter((r) => r.import && !r.import.ok), timedOut = R.filter((r) => r.timeout);
  const errKinds = new Map(); for (const r of failed) { const k = norm(r.import.error.split(' | ')[0]); errKinds.set(k, (errKinds.get(k) ?? 0) + 1); }
  const dropped = ok.filter((r) => /left out/.test(r.status ?? ''));
  const noPart = ok.filter((r) => !r.dump?.starts?.length), missing = ok.filter((r) => r.dump && (r.dump.missingNaturals || r.dump.missingSig));
  console.log(`import: ${ok.length} ok, ${failed.length} failed, ${timedOut.length} timed out; ${dropped.length} dropped unpitched parts; ${noPart.length} without a partition; ${missing.length} with missing widths`);
  for (const [k, n] of [...errKinds].sort((a, b) => b[1] - a[1])) console.log(`   ${n}× ${k}`);
  for (const r of timedOut) console.log(`   timeout: ${r.name} (${r.timeout})`);
  const cmsg = new Map(); let cE = 0, cW = 0, cX = 0;
  for (const r of R) { cE += r.console?.errors ?? 0; cW += r.console?.warnings ?? 0; cX += r.console?.exceptions ?? 0;
    for (const t of r.console?.top ?? []) { const m = /^(\d+)× ([\s\S]*)$/.exec(t); if (!m) continue; const k = norm(m[2]); const e = cmsg.get(k) ?? { n: 0, files: new Set() }; e.n += Number(m[1]); e.files.add(r.name); cmsg.set(k, e); } }
  console.log(`console: ${cE} errors, ${cW} warnings, ${cX} exceptions across ${R.length} files; top messages (count / files; counts are lower bounds — each record keeps its 12 most frequent):`);
  for (const [k, e] of [...cmsg].sort((a, b) => b[1].files.size - a[1].files.size).slice(0, 14)) console.log(`   ${e.n} / ${e.files.size}  ${k}`);
  const ms = ok.map((r) => r.ms.total);
  console.log(`time per file (ms): ${dist(ms).replace(/(\d+)\.000/g, '$1')}  max ${Math.max(...ms)}`);
  /* ── balancing ── */
  const secs = [];
  for (const r of ok) {
    const D = r.dump; if (!D?.starts?.length || D.missingNaturals || D.missingSig) continue;
    const bounds = [0, ...D.hard, D.measures];
    for (let s = 0; s + 1 < bounds.length; s++) {
      const lo = bounds[s], hi = bounds[s + 1];
      const ws = [], sigs = [], ids = [];
      for (let i = lo; i < hi;) { let j = i; while (j + 1 < hi && D.unitLo[j + 1] === i) j++; let w = 0; for (let k = i; k <= j; k++) w += D.naturals[k]; ws.push(w / D.budget); sigs.push(D.sig[i] / D.budget); ids.push(i); i = j + 1; }
      const g = makeSeg(ws, sigs);
      const L = distinctLayouts(g);
      const isFinal = s + 2 === bounds.length;
      const exempt = isFinal && L.N < 3;
      const greedy = L.rows[0], full = L.rows[L.rows.length - 1], p = exempt ? greedy : pick(L.rows, GAMMA);
      const at = new Map(ids.map((id, a) => [id, a]));
      const today = D.starts.filter((x) => x >= lo && x < hi).map((x) => at.get(x)).filter((x) => x !== undefined);
      const tf = today.length ? fillsOf(g, today) : null;
      const overWide = ws.filter((w, a) => sigs[a] + w > 1.0).length;
      const gammaPicks = Object.fromEntries(SWEEP.map((gm) => { const pp = exempt ? greedy : pick(L.rows, gm); return [gm, { chg: pp.chg, last: pp.last, min: pp.min }]; }));
      secs.push({ doc: r.name, from: lo, bars: hi - lo, lines: L.N, exempt, overWide, gammaPicks,
        todayOver: tf ? tf.filter((x) => x > 1.0005).length : 0, todayMax: tf ? Math.max(...tf) : null,
        greedyLast: greedy.last, pickChg: p.chg, pickLast: p.last, pickMin: p.min, fullChg: full.chg, fullLast: full.last, fullMin: full.min,
        todayLast: tf ? tf[tf.length - 1] : null, todayMin: tf ? Math.min(...tf) : null, todayLines: today.length, pickIsFull: p.chg === full.chg });
    }
  }
  const B = secs.filter((s) => !s.exempt && s.lines >= 2);
  console.log(`\nsections: ${secs.length} (${secs.filter((s) => s.exempt).length} final sections under 3 lines stay greedy; ${secs.filter((s) => s.lines < 2).length} one-line); balanced: ${B.length}`);
  console.log(`  lines per balanced section: ${dist(B.map((s) => s.lines)).replace(/\.000/g, '')}  max ${Math.max(...B.map((s) => s.lines))}`);
  console.log(`  sections with a measure wider than a line: ${secs.filter((s) => s.overWide).length}`);
  console.log(`  greedy last-line fill:   ${hist(B.map((s) => s.greedyLast), [0.3, 0.5, 0.65, 0.8])}`);
  console.log(`  today's last-line fill:  ${hist(B.filter((s) => s.todayLast != null).map((s) => s.todayLast), [0.3, 0.5, 0.65, 0.8])}`);
  console.log(`  pick (γ ${GAMMA}) last-line: ${hist(B.map((s) => s.pickLast), [0.3, 0.5, 0.65, 0.8])}`);
  console.log(`  full balance last-line:  ${hist(B.map((s) => s.fullLast), [0.3, 0.5, 0.65, 0.8])}`);
  const chgH = (xs) => [0, 1, 2, 3, 4].map((c) => `${c}: ${xs.filter((x) => x === c).length}`).join('  ') + `  5+: ${xs.filter((x) => x >= 5).length}`;
  console.log(`  boundaries moved — pick: ${chgH(B.map((s) => s.pickChg))}`);
  console.log(`                     full: ${chgH(B.map((s) => s.fullChg))}`);
  const need = B.filter((s) => s.fullChg > 0);
  console.log(`  of ${need.length} sections the full balance changes: pick = full in ${need.filter((s) => s.pickIsFull).length}; pick makes 0 changes in ${need.filter((s) => s.pickChg === 0).length}`);
  console.log(`  pick vs full — last-line loss (full − pick): ${dist(need.map((s) => s.fullLast - s.pickLast))}`);
  console.log(`                 min-line loss  (full − pick): ${dist(need.map((s) => s.fullMin - s.pickMin))}`);
  console.log(`                 changes saved  (full − pick): ${dist(need.map((s) => s.fullChg - s.pickChg)).replace(/\.000/g, '')}`);
  const tOver = B.filter((s) => s.todayOver > 0);
  console.log(`  today compresses (a line > 1.00) in ${tOver.length} sections; their widest line: ${dist(tOver.map((s) => s.todayMax))}`);
  console.log(`  γ sweep (balanced sections where the full balance changes something, n ${need.length}):`);
  console.log('     γ      moved med/p90/max   = full   last ≥0.65   last ≥0.80   last-line loss med/p75/p90   min loss p90');
  for (const gm of SWEEP) {
    const P = need.map((s) => ({ ...s.gammaPicks[gm], fullLast: s.fullLast, fullMin: s.fullMin, fullChg: s.fullChg }));
    const mv = P.map((x) => x.chg), ll = P.map((x) => x.fullLast - x.last), ml = P.map((x) => x.fullMin - x.min);
    console.log(`     ${String(gm).padEnd(5)}  ${(q(mv, 0.5) + '/' + q(mv, 0.9) + '/' + Math.max(...mv)).padEnd(17)}  ${String(P.filter((x) => x.chg === x.fullChg).length).padStart(5)}   ${String(P.filter((x) => x.last >= 0.65).length).padStart(9)}   ${String(P.filter((x) => x.last >= 0.8).length).padStart(9)}    ${f3(q(ll, 0.5))}/${f3(q(ll, 0.75))}/${f3(q(ll, 0.9))}              ${f3(q(ml, 0.9))}`);
  }
  const worst = B.filter((s) => s.pickLast < 0.6).sort((a, b) => a.pickLast - b.pickLast);
  console.log(`  pick leaves a last line < 0.60 in ${worst.length} sections:`);
  for (const s of worst.slice(0, 10)) console.log(`     ${s.doc.slice(0, 14)} m.${s.from} ${s.bars} bars ${s.lines} lines: greedy ${f3(s.greedyLast)} → pick ${f3(s.pickLast)} (${s.pickChg} chg) | full ${f3(s.fullLast)} (${s.fullChg} chg) | today ${f3(s.todayLast)}`);
  report.sets[set] = { files: R.length, sections: secs };
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report));
