#!/usr/bin/env node
// End-to-end round-trip for the .hkr → .hkc transcription pipeline.
//
// Faithful two-page test in one headless Chromium:
//   1. HKL page (/?hklrec=1): inject a synthetic recording, run the REAL
//      emitter via window.__hkl_rec.transcribe() → a .hkc MEI string.
//   2. Composer page (/composer/): load that string the way the import path
//      does (model.replaceDocument, which runs normalizeTies + normalizePlaceholders)
//      and assert the structural invariants a hand-edited score must satisfy.
//
// This is the regression guard for the emitter's measure/tie/coord assembly and
// for the Composer-side import — neither is covered by the keystroke-driven
// Composer suite. Requires the dev proxy running (`pnpm dev`) at
// http://localhost:5170.
//
// Usage: node test/transcription-roundtrip/run.mjs

import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { openPage } from '../composer-test/lib/cdp.mjs';
import { INJECT_LIB } from '../composer-test/lib/runner-core.mjs';
import { isolatedHklUrl } from '../composer-test/lib/private-relay.mjs';

const BASE = process.env.HKL_URL ?? 'http://localhost:5170';
const WAIT_MS = Number(process.env.WAIT_MS ?? 2500);

/* A small recording exercising chords, a treble/bass split, a note sustained
   across a bar line (→ a tie), and a trailing rest. bpmHint pins the tempo so
   the DP result is stable run-to-run. */
/* mapping: the recording's layout; at: Euler (q, r) → that layout's cell (Janko
   (2q + 3r, r) is the same note). A layout a score can't use (SCORE_MAPPINGS)
   must come out in Euler, note for note. */
const BUILD_AND_TRANSCRIBE = (mapping = 'euler', at = '(q, r) => [q, r]') => `
(() => {
  const snapshot = { tuning:'5', septimalEnabled:false, equalEnabled:false,
    septimalW:0, instrument:'piano', pedalMode:'sustain', refHz:220, mapping:'${mapping}', anchor:0, banded:true };
  const at = ${at};
  const N = (t,q0,r0,dur,v=90) => { const [q, r] = at(q0, r0); return [ {t,k:'on',q,r,v}, {t:t+dur,k:'off',q,r} ]; };
  const events = [].concat(
    N(0.0, 0,  1, 0.45), N(0.0, 0, -1, 0.45),  /* chord: treble + bass */
    N(0.5, 0,  0, 0.45),
    N(1.0, 1,  0, 0.45),
    N(1.5, 0,  1, 1.00),                        /* beat 4 → bar 2 beat 2: ties across the bar line */
    N(2.5, -1, 1, 0.45),
    N(3.0, 0,  0, 0.90)
  ).sort((a,b) => a.t - b.t);
  const session = { format:'hkr', version:1, createdAt:new Date().toISOString(),
    durationSec:4.0, timing:{ unit:'audioCtxSec', epoch:0 }, snapshot, events };
  if (!window.__hkl_rec) return { __error: '__hkl_rec hook missing (need ?hklrec=1)' };
  window.__hkl_rec.setSession(session);
  const res = window.__hkl_rec.transcribe({ numerator:4, bpmHint:120, title:'Round Trip' });
  return res && res.hkc ? res.hkc : { __error: 'transcribe returned no hkc' };
})()
`;

function assertExpr(hkc) {
  return `
  (() => {
    const m = window.__hkl_composer.model;
    const hkc = ${JSON.stringify(hkc)};
    try { m.replaceDocument(hkc); } catch (e) {
      return { ok:false, stage:'replaceDocument', detail:String(e && e.stack || e) };
    }
    window.__hkl_composer.reRender();
    const doc = m.getDoc();
    if (doc.querySelector('parsererror')) return { ok:false, stage:'parse', detail:'parsererror' };
    const notes = Array.from(doc.querySelectorAll('note'));
    const missingCoord = notes.filter((n) =>
      !n.hasAttribute('data-q') || !n.hasAttribute('data-r') || !n.hasAttribute('color')).length;
    const tieCount = notes.filter((n) => n.getAttribute('tie')).length;
    const orphan = window.__test.assertNoTieOrphans();
    const ph = window.__test.assertPlaceholderInvariant
      ? window.__test.assertPlaceholderInvariant() : { ok:true };
    /* Origin spot-check: A3 = (q=0, r=0) must spell as pname 'a', octave 3. */
    const origin = doc.querySelector('note[data-q="0"][data-r="0"]');
    const originOk = origin
      ? (origin.getAttribute('pname') === 'a' && origin.getAttribute('oct') === '3') : null;
    /* Round-trip stability via the suite's helper (placeholder xml:ids are
       regenerated on every load by design, so it strips them before comparing). */
    const rt = window.__test.runRoundTrip();
    return {
      ok:true,
      measures: doc.querySelectorAll('measure').length,
      noteCount: notes.length,
      missingCoord, tieCount, orphan, ph, originOk,
      roundtripStable: rt.ok,
    };
  })()
  `;
}

async function main() {
  const browser = await launchChromium();
  let exitCode = 0;
  try {
    /* 1 — emit a .hkc from a real recording on the HKL page. */
    const hklCdp = await openPage(await newTabWsUrl(browser.port), await isolatedHklUrl(BASE + '/?hklrec=1'), { waitMs: WAIT_MS });
    const hkc = await hklCdp.evalJSON(BUILD_AND_TRANSCRIBE());
    const hkcJanko = await hklCdp.evalJSON(BUILD_AND_TRANSCRIBE('janko', '(q, r) => [2 * q + 3 * r, r]'));
    const hkcRandal = await hklCdp.evalJSON(BUILD_AND_TRANSCRIBE('randal', '(q, r) => [q + 3 * r, -r]'));
    hklCdp.close();
    if (typeof hkc !== 'string') {
      console.error('FAIL — emit stage:', hkc && hkc.__error ? hkc.__error : JSON.stringify(hkc));
      await browser.stop();
      process.exit(1);
    }
    if (!hkc.includes('<measure') || !hkc.includes('data-q')) {
      console.error('FAIL — emitted .hkc missing <measure>/data-q');
      console.error(hkc.slice(0, 500));
      await browser.stop();
      process.exit(1);
    }

    /* 2 — load it into Composer and assert. */
    const cmpCdp = await openPage(await newTabWsUrl(browser.port), BASE + '/composer/', { waitMs: WAIT_MS });
    await cmpCdp.evalJSON(INJECT_LIB);
    const r = await cmpCdp.evalJSON(assertExpr(hkc));
    cmpCdp.close();

    const checks = [];
    const check = (name, ok, detail) => { checks.push({ name, ok, detail }); if (!ok) exitCode = 1; };
    if (!r || r.__error) {
      console.error('FAIL — assert stage threw:', r && r.__error ? r.__error : JSON.stringify(r));
      await browser.stop();
      process.exit(1);
    }
    check('replaceDocument + parse', r.ok === true, r.stage + ': ' + (r.detail ?? ''));
    if (r.ok) {
      check('measure count ≥ 2', r.measures >= 2, 'got ' + r.measures);
      check('all notes carry data-q/data-r/color', r.missingCoord === 0, r.missingCoord + ' missing');
      check('no tie orphans', r.orphan && r.orphan.ok, r.orphan && r.orphan.detail);
      check('placeholder invariant', r.ph && r.ph.ok, r.ph && r.ph.detail);
      check('origin (0,0) spells A3', r.originOk !== false, 'origin note mis-spelled');
      check('serialize round-trip stable', r.roundtripStable === true, 'serialize drift');
      /* Janko (sheared) and Randal (inverted) recordings: an Euler layoutReq, and the
         Euler notes at the Euler cells, colored as Euler colors them */
      const notesOf = (x) => (x.match(/<note\b[^>]*>/g) ?? []).map((t) => ['data-q', 'data-r', 'pname', 'accid', 'oct', 'color', 'data-light-color']
        .map((a) => (t.match(new RegExp(' ' + a + '="([^"]*)"')) ?? [])[1] ?? '').join('/')).sort().join(' ');
      for (const [name, x] of [['Janko', hkcJanko], ['Randal', hkcRandal]]) {
        const lr = typeof x === 'string' ? (x.match(/<hkl:layoutReq\b[^>]*>/) ?? [''])[0] : '';
        check(name + ' recording → Euler score (no mapping attribute)', lr !== '' && !lr.includes('mapping='), lr || JSON.stringify(x));
        check(name + ' recording → the Euler notes and colors, note for note', typeof x === 'string' && notesOf(x) === notesOf(hkc),
          typeof x === 'string' ? notesOf(x) + ' vs ' + notesOf(hkc) : JSON.stringify(x));
      }
      if (r.tieCount === 0) {
        console.warn('  ! warning: no ties in output — tie path not exercised this run');
      }
    }

    for (const c of checks) {
      console.log((c.ok ? '  ✓ ' : '  ✗ ') + c.name + (c.ok ? '' : '  — ' + c.detail));
    }
    console.log(exitCode === 0
      ? `\nPASS  (${r.measures} measures, ${r.noteCount} notes, ${r.tieCount} tied)`
      : '\nFAIL');
  } finally {
    await browser.stop();
  }
  process.exit(exitCode);
}

main().catch((e) => { console.error(e); process.exit(1); });
