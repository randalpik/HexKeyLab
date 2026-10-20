// Composer test fixtures — ties.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

import {
  A_NOTE,
} from './_helpers.mjs';

const B_NOTE = `{ q: 0, r: 1, pname: 'e', accid: '', oct: 4, midi: 64, colorHex: '#888', velocity: 80 }`;

/* ── Tie clearance (2026-09-22, render/tielayout.ts) ──
   Verovio draws a tie from its two noteheads alone; a tie through another
   voice's glyph is re-arched to the lowest clear height within its width, or
   kept as Verovio drew it. */
const TIE_P = `const P = (pname, oct, midi) => ({ q: 0, r: 0, pname, accid: '', oct, midi, colorHex: '#888', velocity: 80 });`;

export const FIXTURES = {

  /* ── Ties ────────────────────────────────────────────────────────── */
  /* Two same-pitch notes, then tie the first → real-tie pair created. */
  m1TieRealPair: { setup: `
    m.setCursor(0, 1);
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '4', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '4', dots: 0 });
    /* flat = [wrapper, A1, A2]; cursor=3 (past A2). Set cursor=2 to put
     * A1 (=flat[2]) as the toggle target... wait, flat[1]=A1 with the
     * wrapper at flat[0]. Cursor=1 puts A1 as flat[cursor]. */
    m.setCursor(2, 1);  /* cursor past A2 → A2 is the toggle target;
                            tie A2 to NEXT (which is past-end / nothing) →
                            this would create a stub. Instead set cursor=1
                            so A1 is the target with A2 as the next. */
    m.setCursor(1, 1);
    /* Wait: cursor=1, flat[1]=A1, but is that the element to the cursor's
     * left? Under cursor convention, yes — flat[cursor]=A1.
     * Toggle: ref=A1, next=flat[2]=A2 → matching pitch → real-tie pair. */
    m.toggleTieOnCurrent('insert');
  ` },
  /* Note, tie (creates stub), then different-pitch note → stub remains
   * unresolved (pitch doesn't match). */
  m1TiePendingStub: { setup: `
    m.setCursor(0, 1);
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '4', dots: 0 });
    m.toggleTieOnCurrent('insert');  /* No next → pending stub on A. */
  ` },
  /* Real pair, then delete the second → first should be demoted to
   * pending stub (per orphanTiePartners). */
  m1TieOrphanForward: { setup: `
    m.setCursor(0, 1);
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '4', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '4', dots: 0 });
    m.setCursor(1, 1);
    m.toggleTieOnCurrent('insert');
    /* flat = [wrapper, A1, A2]. To delete A2 set cursor=2 (past A2 in
     * the new convention) — deleteAtCursor removes flat[cursor] = A2. */
    m.setCursor(2, 1);
    m.deleteAtCursor();
  ` },
  /* Cross-bar split: half note inserted at end of M_1 with 16 ticks free
   * → splits into quarter (in M_1, @tie=i) + quarter (in M_2, @tie=t).
   * Verifies normalizeTies built the chain correctly under the
   * forward-only data-tie-partner convention. */
  m1TieCrossBarSplit: { setup: `
    m.setCursor(0, 1);
    for (let i = 0; i < 3; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
    /* 16 ticks remain. Insert half (32 ticks): 16 + 16 across bar. */
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '2', dots: 0 });
  ` },
  /* Whole note inserted with only 4 ticks free in M_1 → 3-piece chain
   * (i in M_1 = 4 ticks 16th; m in M_2 = 32 + 16 + 8 ticks decomposed
   * via dotted notation; ...). Exercises the i→m→t multi-piece chain. */
  m1TieThreePieceChain: { setup: `
    m.setCursor(0, 1);
    m.insertRestAtCursor({ duration: '16', dots: 0 });  /* 4 ticks */
    /* 60 ticks remain. Insert whole (64 ticks) → splits into 60 + 4 */
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '1', dots: 0 });
  ` },
  /* Delete the INITIATOR (i-note) of a 2-piece cross-bar chain →
   * survivor (originally t) should demote cleanly: no @tie, no
   * data-tie-partner, no dangling refs, no Verovio console warning.
   * This was the asymmetry-bug repro before normalizeTies. */
  m1TieDeleteInitiatorFromSplit: { setup: `
    m.setCursor(0, 1);
    for (let i = 0; i < 3; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '2', dots: 0 });
    /* Delete the i-note. Find it via flat scan and set cursor past it. */
    const flat = m.flatChildren(1);
    const iIdx = flat.findIndex((e) => e.localName === 'note' && e.getAttribute('tie') === 'i');
    m.setCursor(iIdx + 1, 1);
    m.deleteAtCursor();
  ` },
  /* Delete a MIDDLE piece of a 3-piece chain. Before normalizeTies this
   * left a dangling data-tie-partner and triggered Verovio's
   * "Expected @tie median or terminal" warning. After normalize the
   * chain compacts cleanly to length 2 (i + t). */
  m1TieDeleteMiddleFromSplit: { setup: `
    m.setCursor(0, 1);
    m.insertRestAtCursor({ duration: '16', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '1', dots: 0 });
    /* Find the first @tie='m' note. */
    const flat = m.flatChildren(1);
    const mIdx = flat.findIndex((e) => e.localName === 'note' && e.getAttribute('tie') === 'm');
    if (mIdx < 0) throw new Error('no @tie=m note found in chain');
    m.setCursor(mIdx + 1, 1);
    m.deleteAtCursor();
  ` },
  /* Extend a tie chain by toggling tie on a note that already has an
   * incoming tie (@tie="t"). When the next note matches in pitch, the
   * t note should promote to @tie="m" with a forward partner; the chain
   * becomes length 3 (i, m, t). Previously the toggle had no effect
   * because the alreadyTied check treated @tie="t" as untied AND because
   * normalizeTies dropped the wants-forward intent when wasFromPrev. */
  m1TieToggleOnTerminal: { setup: `
    /* A4 - A4 - A4 quarter rests. */
    m.setCursor(0, 1);
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '4', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '4', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '4', dots: 0 });
    /* Tie A1→A2 first (cursor past A1 = flat index 1 since wrapper at 0). */
    m.setCursor(1, 1);
    m.toggleTieOnCurrent('insert');
    /* A2 now has @tie="t" (incoming). Toggle tie on A2 to extend chain. */
    m.setCursor(2, 1);
    m.toggleTieOnCurrent('insert');
  ` },
  /* Toggle tie on a terminal note when NO next-pitch-match exists →
   * note should carry both incoming terminal (@tie="t") AND outgoing
   * pending stub (data-pending-tie + <lv>). Visually: incoming arc
   * plus hanging arc. The forward intent survives, ready to auto-
   * resolve when a same-pitch note is later inserted after it. */
  m1TieToggleOnTerminalNoPartner: { setup: `
    /* A4 - A4 - B4. */
    m.setCursor(0, 1);
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '4', dots: 0 });
    m.insertChordAtCursor({ notes: [${A_NOTE}], duration: '4', dots: 0 });
    m.insertChordAtCursor({ notes: [${B_NOTE}], duration: '4', dots: 0 });
    /* Tie A1→A2. */
    m.setCursor(1, 1);
    m.toggleTieOnCurrent('insert');
    /* Toggle on A2 — next is B4 (no pitch match) → pending stub kept. */
    m.setCursor(2, 1);
    m.toggleTieOnCurrent('insert');
  ` },
  /* <lv> tie stub (2026-10-17): the stub's @tstamp2 had the breath mark's two
     defects — head-meter beat unit and a flat layer scan that skipped a
     preceding <tuplet> — so sonata III m. 89's pending tie (eighth chord after
     a quarter triplet, 3/4) got "0m+1.5" against a note at beat 3 and Verovio
     dropped it ("lv … is ignored, since start does not occur temporally before
     end"). Head 2/2, measure 1 in 3/4: quarter triplet then an eighth with a
     pending tie → "0m+3.5", and the arc must render. */
  lv_stubTstamp2UsesEffectiveMeterAndNestedTicks: {
    setup: `
      m.setTimeSig(2, 2);
      m.appendMeasure();
      m.setMeterAt(1, 3, 4);
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '4', spanDur: '2', spanDots: 0 });
      for (let i = 0; i < 3; i++) m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'c', accid: '', oct: 5, midi: 72, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '8', dots: 0 });
      m.toggleTieOnCurrent('insert');  /* no next measure note → pending stub */
      r();
    `,
  },
  /* A stub saved with a stale @tstamp2 (every .hkc written before the fix)
     is recomputed on load: normalizeTies runs in replaceDocument and
     ensureLvForNote now refreshes an existing stub instead of keeping it. */
  lv_staleStubRefreshedOnLoad: {
    setup: `
      m.setTimeSig(2, 2);
      m.appendMeasure();
      m.setMeterAt(1, 3, 4);
      m.setCursor(m.getMeasureStartCursor(1, 1), 1);
      m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '4', spanDur: '2', spanDots: 0 });
      for (let i = 0; i < 3; i++) m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'c', accid: '', oct: 5, midi: 72, colorHex: '#888', velocity: 80 }], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', velocity: 80 }], duration: '8', dots: 0 });
      m.toggleTieOnCurrent('insert');
      const xml = m.serialize().replace(/(<lv\\b[^>]*tstamp2=")[^"]*(")/, '$10m+1.5$2');
      if (!/tstamp2="0m\\+1\\.5"/.test(xml)) throw new Error('fixture: stale tstamp2 not planted');
      m.replaceDocument(xml);
      m.setCursor(0, 1);
      r();
    `,
  },
  /* Max's repro: V1 A4 dotted half tied to A4 quarter; V2 quarter rest, C5 —
     the C5 head sat on Verovio's tie. */
  engr_tieArchesOverOtherVoice: {
    setup: `
      ${TIE_P}
      m.setVoice(1); m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [P('a', 4, 69)], duration: '2', dots: 1 });
      m.insertChordAtCursor({ notes: [P('a', 4, 69)], duration: '4', dots: 0 });
      m.setCursor(1, 1); m.toggleTieOnCurrent('insert');
      m.setVoice(2); m.setCursor(0, 2);
      m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [P('c', 5, 72)], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
    visualBaseline: 'engr_tieArchesOverOtherVoice',
  },
  /* A tall V2 chord between two tied quarters: no clear arch within the tie's
     width, so Verovio's tie stays. */
  engr_tieKeptWhenTallerThanWide: {
    setup: `
      ${TIE_P}
      m.setVoice(1); m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [P('a', 4, 69)], duration: '4', dots: 0 });
      m.insertChordAtCursor({ notes: [P('a', 4, 69)], duration: '4', dots: 0 });
      m.setCursor(1, 1); m.toggleTieOnCurrent('insert');
      m.setVoice(2); m.setCursor(0, 2);
      m.insertRestAtCursor({ duration: '8', dots: 0 });
      m.insertChordAtCursor({ notes: [P('b', 4, 71), P('d', 5, 74), P('f', 5, 77), P('a', 5, 81), P('c', 6, 84)], duration: '8', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
  },
  /* Nothing in the way: the tie is Verovio's, untouched. */
  engr_tieClearUntouched: {
    setup: `
      ${TIE_P}
      m.setVoice(1); m.setCursor(0, 1);
      m.insertChordAtCursor({ notes: [P('a', 4, 69)], duration: '2', dots: 0 });
      m.insertChordAtCursor({ notes: [P('a', 4, 69)], duration: '2', dots: 0 });
      m.setCursor(1, 1); m.toggleTieOnCurrent('insert');
      r();
    `,
  },
};

export const ASSERTIONS = {
  /* Ties. */
  m1TieRealPair: [
    { name: 'real-tie pair created (i + t)',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const i = doc.querySelectorAll('note[tie="i"]');
        const t = doc.querySelectorAll('note[tie="t"]');
        return i.length === 1 && t.length === 1
          ? { ok: true }
          : { ok: false, detail: 'i=' + i.length + ', t=' + t.length };
      })()` },
    { name: 'i has forward data-tie-partner; t has none (forward-only model)',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const i = doc.querySelector('note[tie="i"]');
        const t = doc.querySelector('note[tie="t"]');
        if (!i || !t) return { ok: false, detail: 'missing i or t' };
        const iP = i.getAttribute('data-tie-partner');
        const tP = t.getAttribute('data-tie-partner');
        return iP === t.getAttribute('xml:id') && tP === null
          ? { ok: true }
          : { ok: false, detail: 'iP=' + iP + ' (expected t.id), tP=' + tP + ' (expected null)' };
      })()` },
  ],
  m1TiePendingStub: [
    { name: 'data-pending-tie present on note',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const stub = doc.querySelector('note[data-pending-tie="true"]');
        return stub
          ? { ok: true }
          : { ok: false, detail: 'no pending-tie stub note' };
      })()` },
    { name: 'no @tie on stub (only data-pending-tie)',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const tied = doc.querySelectorAll('note[tie]');
        return tied.length === 0
          ? { ok: true }
          : { ok: false, detail: tied.length + ' notes have @tie (expected 0)' };
      })()` },
  ],
  m1TieOrphanForward: [
    { name: 'first note demoted to pending stub after partner deleted',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const tied = doc.querySelectorAll('note[tie]');
        const stubs = doc.querySelectorAll('note[data-pending-tie="true"]');
        return tied.length === 0 && stubs.length === 1
          ? { ok: true }
          : { ok: false, detail: 'tied=' + tied.length + ' stubs=' + stubs.length };
      })()` },
  ],
  m1TieCrossBarSplit: [
    { name: '2-piece chain: i + t with forward partner',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const i = doc.querySelector('note[tie="i"]');
        const t = doc.querySelector('note[tie="t"]');
        if (!i || !t) return { ok: false, detail: 'missing i or t' };
        const iP = i.getAttribute('data-tie-partner');
        return iP === t.getAttribute('xml:id')
          ? { ok: true }
          : { ok: false, detail: 'i.partner=' + iP + ' expected t.id' };
      })()` },
  ],
  m1TieThreePieceChain: [
    { name: '3-piece chain forms i → m → t with valid forward links',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const tied = Array.from(doc.querySelectorAll('note[tie]'));
        if (tied.length < 3) return { ok: false, detail: 'expected 3+ tied notes, got ' + tied.length };
        const i = tied.find((n) => n.getAttribute('tie') === 'i');
        const t = tied.find((n) => n.getAttribute('tie') === 't');
        const ms = tied.filter((n) => n.getAttribute('tie') === 'm');
        if (!i || !t || ms.length < 1) {
          return { ok: false, detail: 'tags: ' + tied.map((n) => n.getAttribute('tie')).join(',') };
        }
        /* Verify the chain links forward end-to-end. */
        let cur = i;
        const seen = new Set();
        while (cur) {
          if (seen.has(cur)) return { ok: false, detail: 'cycle in chain' };
          seen.add(cur);
          const pid = cur.getAttribute('data-tie-partner');
          if (!pid) {
            if (cur === t) break;
            return { ok: false, detail: 'mid-chain note ' + cur.getAttribute('xml:id') + ' missing partner' };
          }
          cur = doc.querySelector('[*|id="' + pid + '"]');
        }
        return { ok: true };
      })()` },
  ],
  m1TieDeleteInitiatorFromSplit: [
    { name: 'after deleting i-note, survivor is clean stub (no @tie, no partner)',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const tied = doc.querySelectorAll('note[tie]');
        const stubs = doc.querySelectorAll('note[data-pending-tie="true"]');
        return tied.length === 0 && stubs.length === 1
          ? { ok: true }
          : { ok: false, detail: 'tied=' + tied.length + ' stubs=' + stubs.length };
      })()` },
  ],
  m1TieDeleteMiddleFromSplit: [
    { name: 'after deleting middle m, chain compacts (no dangling partner)',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const tied = Array.from(doc.querySelectorAll('note[tie]'));
        /* Verify every i/m has a partner that exists. */
        for (const n of tied) {
          const tie = n.getAttribute('tie');
          if (tie === 'i' || tie === 'm') {
            const pid = n.getAttribute('data-tie-partner');
            if (!pid) return { ok: false, detail: n.getAttribute('xml:id') + ' @tie=' + tie + ' no partner' };
            const p = doc.querySelector('[*|id="' + pid + '"]');
            if (!p) return { ok: false, detail: n.getAttribute('xml:id') + ' dangling partner ' + pid };
          }
        }
        return { ok: true };
      })()` },
  ],
  m1TieToggleOnTerminal: [
    { name: 'chain extends to length 3 (i, m, t)',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const tags = Array.from(doc.querySelectorAll('note[tie]')).map((n) => n.getAttribute('tie'));
        return tags.length === 3 && tags[0] === 'i' && tags[1] === 'm' && tags[2] === 't'
          ? { ok: true }
          : { ok: false, detail: 'tags=' + JSON.stringify(tags) };
      })()` },
    { name: 'm note has forward partner pointing at t',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const mNote = doc.querySelector('note[tie="m"]');
        const tNote = doc.querySelector('note[tie="t"]');
        if (!mNote || !tNote) return { ok: false, detail: 'missing m or t' };
        return mNote.getAttribute('data-tie-partner') === tNote.getAttribute('xml:id')
          ? { ok: true }
          : { ok: false, detail: 'm.partner=' + mNote.getAttribute('data-tie-partner') };
      })()` },
  ],
  m1TieToggleOnTerminalNoPartner: [
    { name: 'terminal note carries both @tie="t" AND pending stub',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const ts = Array.from(doc.querySelectorAll('note[tie="t"]'));
        if (ts.length !== 1) return { ok: false, detail: 'expected 1 t-note, got ' + ts.length };
        const t = ts[0];
        const pending = t.hasAttribute('data-pending-tie');
        return pending
          ? { ok: true }
          : { ok: false, detail: 't-note has no data-pending-tie' };
      })()` },
    { name: 'pending stub has corresponding <lv> element in its measure',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const t = doc.querySelector('note[tie="t"][data-pending-tie="true"]');
        if (!t) return { ok: false, detail: 'no t+pending note' };
        const measure = t.closest('measure');
        const id = t.getAttribute('xml:id');
        const lv = measure?.querySelector('lv[startid="#' + id + '"]');
        return lv ? { ok: true } : { ok: false, detail: 'no <lv> for ' + id };
      })()` },
  ],
  lv_stubTstamp2UsesEffectiveMeterAndNestedTicks: [
    { name: 'exactly one <lv> stub on the pending-tie eighth with tstamp2 "0m+3.5" (beat 3 + half a beat in 3/4)',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const lvs = [...doc.querySelectorAll('lv')];
        if (lvs.length !== 1) return { ok: false, detail: 'lv count=' + lvs.length };
        const stub = doc.querySelector('note[data-pending-tie="true"]');
        if (!stub || lvs[0].getAttribute('startid') !== '#' + stub.getAttribute('xml:id')) return { ok: false, detail: 'startid=' + lvs[0].getAttribute('startid') + ' stub=' + stub?.getAttribute('xml:id') };
        const t2 = lvs[0].getAttribute('tstamp2');
        return t2 === '0m+3.5' ? { ok: true } : { ok: false, detail: 'tstamp2=' + t2 };
      })()` },
    { name: 'Verovio draws the stub (g.lv present in the measure)',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const stub = doc.querySelector('note[data-pending-tie="true"]');
        const mid = stub?.closest('measure')?.getAttribute('xml:id');
        const g = document.querySelector('#score svg g.measure[id="' + mid + '"]');
        const lv = g?.querySelector('g.lv');
        return lv ? { ok: true } : { ok: false, detail: 'no g.lv rendered in measure ' + mid };
      })()` },
  ],
  lv_staleStubRefreshedOnLoad: [
    { name: 'exactly one <lv> stub on the pending-tie eighth with tstamp2 "0m+3.5" (beat 3 + half a beat in 3/4)',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const lvs = [...doc.querySelectorAll('lv')];
        if (lvs.length !== 1) return { ok: false, detail: 'lv count=' + lvs.length };
        const stub = doc.querySelector('note[data-pending-tie="true"]');
        if (!stub || lvs[0].getAttribute('startid') !== '#' + stub.getAttribute('xml:id')) return { ok: false, detail: 'startid=' + lvs[0].getAttribute('startid') + ' stub=' + stub?.getAttribute('xml:id') };
        const t2 = lvs[0].getAttribute('tstamp2');
        return t2 === '0m+3.5' ? { ok: true } : { ok: false, detail: 'tstamp2=' + t2 };
      })()` },
    { name: 'Verovio draws the stub (g.lv present in the measure)',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const stub = doc.querySelector('note[data-pending-tie="true"]');
        const mid = stub?.closest('measure')?.getAttribute('xml:id');
        const g = document.querySelector('#score svg g.measure[id="' + mid + '"]');
        const lv = g?.querySelector('g.lv');
        return lv ? { ok: true } : { ok: false, detail: 'no g.lv rendered in measure ' + mid };
      })()` },
  ],
  /* ── Tie clearance ── */
  engr_tieArchesOverOtherVoice: [
    { name: 'the tie is re-drawn and its outline misses the V2 C5 notehead', expr: `(() => { const g = document.querySelector('#score g.tie'); const path = g && g.querySelector('path'); if (!path) return { ok: false, detail: 'no tie' }; const ctm = path.getScreenCTM(); const L = path.getTotalLength(); const pts = []; for (let i = 0; i <= 200; i++) { const q = path.getPointAtLength(L * i / 200); pts.push(new DOMPoint(q.x, q.y).matrixTransform(ctm)); } const heads = [...document.querySelectorAll('#score g.layer[data-n="2"] g.note g.notehead')].map(h => h.getBoundingClientRect()); const hit = pts.some(p => heads.some(b => p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom)); return { ok: g.getAttribute('data-hkl-tie') === 'redrawn' && heads.length === 1 && !hit, detail: JSON.stringify({ mark: g.getAttribute('data-hkl-tie'), heads: heads.length, hit }) }; })()` },
    { name: 'the arch is no taller than it is wide', expr: `(() => { const g = document.querySelector('#score g.tie'); const path = g && g.querySelector('path'); if (!path) return { ok: false, detail: 'no tie' }; const ctm = path.getScreenCTM(); const L = path.getTotalLength(); const pts = []; for (let i = 0; i <= 200; i++) { const q = path.getPointAtLength(L * i / 200); pts.push(new DOMPoint(q.x, q.y).matrixTransform(ctm)); } const xs = pts.map(p => p.x), ys = pts.map(p => p.y); const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys); return { ok: h > 0 && h <= w, detail: JSON.stringify({ w: Math.round(w), h: Math.round(h) }) }; })()` },
  ],
  engr_tieKeptWhenTallerThanWide: [
    { name: 'no clear arch within the width: marked kept, Verovio path untouched', expr: `(() => { const g = document.querySelector('#score g.tie'); const path = g && g.querySelector('path'); return { ok: !!path && g.getAttribute('data-hkl-tie') === 'kept' && !path.hasAttribute('data-hkl-orig-d'), detail: g ? String(g.getAttribute('data-hkl-tie')) : 'no tie' }; })()` },
  ],
  engr_tieClearUntouched: [
    { name: 'a clear tie carries no mark and no re-draw', expr: `(() => { const g = document.querySelector('#score g.tie'); const path = g && g.querySelector('path'); return { ok: !!path && !g.hasAttribute('data-hkl-tie') && !path.hasAttribute('data-hkl-orig-d'), detail: g ? String(g.getAttribute('data-hkl-tie')) : 'no tie' }; })()` },
  ],
};
