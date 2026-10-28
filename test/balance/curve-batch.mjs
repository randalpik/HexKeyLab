#!/usr/bin/env node
// Reach-back curve over many documents (2026-10-20, partition F's Phase 0 — decisions.md).
// Reads partition-inputs dumps (sonata-probes/partition-inputs.js, any score)
// and reports, per section: today's committed lines, the greedy count, and
// every DISTINCT layout on the curve scored over the lines it changes plus
// the untouched line before them (min fill of the changed lines, sd of
// neighbor + changed), then the pick of max(min − sd − γ·changes) for each γ.
// A FINAL section of fewer than 3 greedy lines stays greedy (Max, 2026-10-20).
//
//   node test/balance/curve-batch.mjs <dump.json>... [--gammas 0,0.01,0.02,0.03,0.05] [--json out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeSeg, curve, fillsOf } from './partition-f.mjs';

const args = process.argv.slice(2);
const gi = args.indexOf('--gammas'), ji = args.indexOf('--json');
const GAMMAS = gi >= 0 ? args[gi + 1].split(',').map(Number) : [0, 0.01, 0.02, 0.03, 0.05];
const jsonOut = ji >= 0 ? args[ji + 1] : null;
const flagValues = new Set([gi, ji].filter((i) => i >= 0).map((i) => i + 1));
const files = args.filter((a, i) => !a.startsWith('--') && !flagValues.has(i));
const sd = (fs) => { const mu = fs.reduce((a, b) => a + b, 0) / fs.length; return Math.sqrt(fs.reduce((a, b) => a + (b - mu) ** 2, 0) / fs.length); };
const f3 = (x) => (x == null ? '  -  ' : x.toFixed(3).replace(/^0/, ''));

/** Distinct layouts along one section's curve, scored as in lens2. */
export function distinctLayouts(g) {
  const c = curve(g); const N = c.pts.length; const G = new Set(c.greedy);
  const rows = []; let prevKey = null;
  for (const p of c.pts) {
    const key = p.starts.join();
    if (key === prevKey) { rows[rows.length - 1].kTo = p.k; continue; }
    prevKey = key;
    const fs0 = p.starts.findIndex((x, i) => x !== c.greedy[i]);
    const firstChanged = fs0 < 0 ? N - 1 : fs0 - 1;
    const nb = firstChanged - 1;
    const changed = p.fs.slice(firstChanged), scored = nb >= 0 ? [p.fs[nb], ...changed] : changed;
    rows.push({ kFrom: p.k, kTo: p.k, chg: p.starts.filter((x) => !G.has(x)).length, lines: changed.length,
      last: p.last, min: Math.min(...changed), sd: sd(scored), starts: p.starts });
  }
  return { N, greedy: c.greedy, rows };
}
export const pick = (rows, gamma) => rows.reduce((best, r) => {
  const s = r.min - r.sd - gamma * r.chg, b = best.min - best.sd - gamma * best.chg;
  return s > b + 1e-12 ? r : best;
}, rows[0]);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = [];
  for (const f of files) {
    let D; try { D = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { console.log(`\n### ${basename(f)}: unreadable dump (${e.message.slice(0, 80)})`); continue; }
    const name = basename(f, '.json');
    const notes = [];
    if (D.__error) { console.log(`\n### ${name}: probe error ${String(D.__error).split('\n')[0]}`); continue; }
    if (D.missingNaturals) notes.push(`${D.missingNaturals} measures without a natural`);
    if (D.missingSig) notes.push(`${D.missingSig} measures without a leading-block width`);
    if (!D.starts?.length) notes.push('no committed partition');
    const mr = D.unitLo.filter((u, i) => u !== i).length; if (mr) notes.push(`${mr} multirest members`);
    console.log(`\n### ${name} — "${D.title ?? ''}": ${D.measures} measures, ${D.staves ?? '?'} staves, ${D.starts?.length ?? 0} lines today, ${D.pageStarts?.length ?? 0} pages, sb ${D.sb} pb ${D.pb}, hard starts ${D.hard.length}${notes.length ? ' | ' + notes.join('; ') : ''}`);
    if (D.missingNaturals || D.missingSig) { report.push({ name, skipped: notes }); continue; }
    const bounds = [0, ...D.hard, D.measures];
    const doc = { name, title: D.title, measures: D.measures, sections: [] };
    for (let s = 0; s + 1 < bounds.length; s++) {
      const lo = bounds[s], hi = bounds[s + 1];
      const ws = [], sigs = [];
      for (let i = lo; i < hi;) { let j = i; while (j + 1 < hi && D.unitLo[j + 1] === i) j++; let w = 0; for (let k = i; k <= j; k++) w += D.naturals[k]; ws.push(w / D.budget); sigs.push(D.sig[i] / D.budget); i = j + 1; }
      const g = makeSeg(ws, sigs);
      const isFinal = s + 2 === bounds.length;
      const today = D.starts.filter((x) => x >= lo && x < hi).map((x) => x - lo);
      const todayFs = today.length && D.unitLo.every((u, i) => u === i) ? fillsOf(g, today) : null;
      const L = distinctLayouts(g);
      const exempt = isFinal && L.N < 3;
      const picks = GAMMAS.map((gm) => (exempt ? L.rows[0] : pick(L.rows, gm)));
      const sec = { from: lo, to: hi - 1, bars: hi - lo, greedyLines: L.N, todayLines: today.length, exempt,
        todayLast: todayFs ? todayFs[todayFs.length - 1] : null, todayMin: todayFs ? Math.min(...todayFs) : null,
        layouts: L.rows.map(({ starts, ...r }) => r), picks: picks.map((p, i) => ({ gamma: GAMMAS[i], chg: p.chg, last: p.last, min: p.min, sd: p.sd })) };
      doc.sections.push(sec);
      console.log(`  section m.${lo}–${hi - 1} (${hi - lo} bars): greedy ${L.N} lines, today ${today.length}${exempt ? ' — FINAL < 3 lines: stays greedy' : ''}; today's last ${f3(sec.todayLast)} min ${f3(sec.todayMin)}`);
      console.log('    layouts (changes → last / min / sd): ' + L.rows.map((r) => `${r.chg}→${f3(r.last)}/${f3(r.min)}/${f3(r.sd)}`).join('  '));
      console.log('    picks by γ: ' + picks.map((p, i) => `γ${GAMMAS[i]}:${p.chg}`).join('  '));
    }
    report.push(doc);
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
}
