// Composer test fixtures — page-splice.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

import {
  CLEAR_ADOPTED_FONT_FACES,
  METRONOME_FONT_CHECK,
} from './_helpers.mjs';

/* Cross-system spanner edits (2026-10-18). A spanner's MEI element lives in
 * its START measure only, so removing one (delete, or undoing its add) changes
 * the signature of that measure alone; the splicers closed the changed run over
 * the POST-edit document's spanners, where the removed one no longer exists, so
 * the system holding its continuation segment was never replaced and the
 * segment stayed on the page. Shared by the pageCrossSystem* fixtures: a
 * 200-chord document, line-break ownership engaged, endpoints in line 1's last
 * measure and line 2's first, so the spanner crosses the 1|2 system break. */
const CROSS_SYS_DOC = `
  m.setCursor(0, 1);
  const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
  for (let i = 0; i < 200; i++) {
    const high = (Math.floor(i / 4) % 2) === 0;
    m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
  }
  r();
`;

const CROSS_SYS_PRELUDE = `
  const H = window.__hkl_composer;
  const m = H.model;
  const pb = H.renderer['pageBreaks'];
  const ps = H.renderer['pageSplicer'];
  for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
  await window.__waitForRender();
  if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
  const startIds = pb['startIds'];
  if (startIds.length < 4) return { ok: false, detail: 'need >= 4 lines, got ' + startIds.length };
  const meas = m.allMeasures();
  const ids = meas.map((x) => x.getAttribute('xml:id'));
  const chordsIn = (voice, measEl) => { const flat = m['flatChildren'](voice); const at = [];
    for (let i = 0; i < flat.length; i++) if ((flat[i].localName === 'note' || flat[i].localName === 'chord') && flat[i].closest('measure') === measEl) at.push(i);
    return at; };
  const endMi = ids.indexOf(startIds[2]);
  const startMi = endMi - 1;
  const live = (cls) => document.querySelectorAll('#score .score-page g.' + cls).length;
  const key = (k, mods) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, mods || {})));
  const errs = [];
  const onErr = (e) => errs.push(String((e && (e.message || e.error)) || e).slice(0, 400));
  const prevCheck = globalThis.__HKL_INDEX_CHECK;
  /* The inline reference gate compares every touched page against a fresh
     full render, and its residue census sees a stale continuation segment —
     but only on pages the splice touched; the live-count checks below see it
     wherever it is. */
  globalThis.__HKL_INDEX_CHECK = true;
  window.addEventListener('error', onErr);
`;

const CROSS_SYS_CLEANUP = `
  globalThis.__HKL_INDEX_CHECK = prevCheck;
  window.removeEventListener('error', onErr);
`;

/* Ctrl+Shift+T → instant tempo, ♩ = 96 shown (the tempo_mm_shown form). */
const ADD_METRONOME_VIA_MODAL = `
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  const tdlg = document.getElementById('textEntryDialog');
  tdlg.querySelector('[data-field="kind"]').value = 'instant';
  tdlg.querySelector('[data-field="bpm"]').value = '96';
  tdlg.querySelector('[data-field="showMm"]').checked = true;
  tdlg.querySelector('form').requestSubmit(tdlg.querySelector('.te-ok'));
  await window.__waitForRender();
`;

export const FIXTURES = {

  /* ── Page-view system splice (render/pagesplice.ts) ─────────── */
  /* The modal edit — a mid-line content change on a line-break-owned page —
   * must land as a SYSTEM SPLICE (no full loadData): outcome 'spliced', the
   * DOM still renders the pinned partition verbatim, and (HKL_INDEX_CHECK)
   * the inline reference gate re-renders the same pinned MEI offscreen and
   * throws on any geometry divergence. Asserted via
   * FIXTURE_ASSERTIONS.pageSystemSpliceEdit. */
  pageSystemSpliceEdit: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 96; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();   /* derive render — arms partition adoption */
    `,
    visualBaseline: 'page_system_splice_edit',
    visualFullPage: true,
  },
  /* A11 (2026-09-02): the page splice never attaches its window to the
   * document — the window is a parsed SVG document read as text, and the
   * imported systems are post-processed in the live page. Asserted via
   * FIXTURE_ASSERTIONS.pageSpliceNoHostAttach (a MutationObserver on <body>). */
  pageSpliceNoHostAttach: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 96; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
  },
  /* B1: growing the DOC-LAST line's bottom extent (deep ledger-line chord)
   * used to refuse the splice — nothing below it moves, so v1's page-last
   * bottom-extent rule was pure caution once pagination became pinned. It must
   * now SPLICE, with the inline reference gate (HKL_INDEX_CHECK) proving the
   * result equals a full re-engrave. Asserted via
   * FIXTURE_ASSERTIONS.pageSystemSpliceBottomExtent. */
  pageSystemSpliceBottomExtent: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 96; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
  },
  /* B1 core: an edit that grows an EARLY system's vertical extent moves every
   * system below it on the page. v1 refused ("vertical: spacing below would
   * move"); the dy-cascade measures the shift in the window and applies it.
   * Asserted via FIXTURE_ASSERTIONS.pageSystemSpliceDyCascade. */
  pageSystemSpliceDyCascade: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 96; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
  },
  /* B4: a section title is injected at page MOUNT at an ABSOLUTE y beside the
   * systems, and its reserve displaces every system at/below it — neither fact
   * is known to Verovio. An edit on a line ABOVE the header on the same page
   * cascades those systems, so the title must travel with them (it used to stay
   * put, stranding the title or letting the music slide over it) AND the
   * cascade distance must account for the reserve. Asserted via
   * FIXTURE_ASSERTIONS.pageSectionHeaderCascade. */
  pageSectionHeaderCascade: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 200; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      m.setSectionHeaderAt(Math.floor(m.allMeasures().length / 2), 'II');
      r();
    `,
  },
  /* B4 remainder: the case where the replaced system IS the header's own. The
   * title is not inside the system — main.ts appends it to the page-margin at
   * an absolute y derived from that system's content top — so re-engraving the
   * system leaves the title behind. This used to be refused outright
   * ('section-header line', 9 of the sonata's 34 exhaustive-pass refusals). It
   * must now splice, with the title re-placed on the injector's own rule.
   * Asserted via FIXTURE_ASSERTIONS.pageSectionHeaderOwnLine. */
  pageSectionHeaderOwnLine: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 200; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      m.setSectionHeaderAt(Math.floor(m.allMeasures().length / 2), 'II');
      r();
    `,
  },
  /* Line 0 was excluded by name ('score-start line', 6 of the 34), on a probe
   * that measured the PRE-ownership window recipe. Under the current recipe a
   * window starting at line 0 takes no synthetic leader and simply IS the score
   * start, so it reproduces. What is structurally special is that there is no
   * line ABOVE it: the context check has one side, and the vertical plan must
   * read line 0's position from the window's own page-1 anchor rather than
   * chain from a predecessor. Asserted via
   * FIXTURE_ASSERTIONS.pageScoreStartSplice. */
  pageScoreStartSplice: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 96; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
  },
  /* Score-start splice with a meter SYMBOL (2026-09-01, Max's smoke test): the
   * range head lost `meter.sym` because `stampRunningCtx` cleared it whenever the
   * running context had no symbol — including when it had no meter at all, which
   * is every range opening at measure 0 — so any edit on line 0 turned cut time
   * into "2/2". Same width as the glyph, so no geometry gate saw it; this
   * fixture reads the meter glyph codepoints. Asserted via
   * FIXTURE_ASSERTIONS.pageScoreStartSpliceKeepsMeterSym. */
  pageScoreStartSpliceKeepsMeterSym: {
    skipCursorTrace: true,
    setup: `
      m.setTimeSig(2, 2, { sym: 'cut', beatGroups: null });
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 96; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
  },
  /* The reference gate is the ONLY detector of a wrong replaced line since
   * Phase 3 dropped the live context-line comparison (2026-09-03), so this
   * fixture forges defects into a SPLICED page and asserts the gate names each
   * one. It replaces `pageSystemSpliceRefusesGlyphMismatch`, which forged a
   * glyph on a context line the window no longer renders. Asserted via
   * FIXTURE_ASSERTIONS.pageReferenceGateCatchesForgedDefects. */
  pageReferenceGateCatchesForgedDefects: {
    skipCursorTrace: true,
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 96; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
  },
  /* Signature changes govern RANGES, not the document (Max, 2026-09-01: "any
   * time the user is exposed to O(document) on a live path when they didn't ask
   * for a change to the full document is a failure, full stop"). A key change at
   * a line start with a later key change re-engraves exactly the lines between
   * them — a splice whose replaced set ends before the reset — and the result
   * matches a full render (reference gate). Previously any interior scoreDef
   * change derived the whole document. Asserted via
   * FIXTURE_ASSERTIONS.pageKeyChangeSplicesGovernedRange. */
  pageKeyChangeSplicesGovernedRange: {
    skipCursorTrace: true,
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 160; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
  },
  /* Same rule for a meter change with a later meter change. Asserted via
   * FIXTURE_ASSERTIONS.pageMeterChangeSplicesGovernedRange. */
  pageMeterChangeSplicesGovernedRange: {
    skipCursorTrace: true,
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 160; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
  },
  /* Same rule for an inline clef change with a later clef on the same staff:
   * the run extends to the measure before the next clef and splices. (For one
   * afternoon inline clefs joined the interior signature and every clef edit
   * derived — the same failure with a newer date.) Asserted via
   * FIXTURE_ASSERTIONS.pageClefChangeSplicesGovernedRange. */
  pageClefChangeSplicesGovernedRange: {
    skipCursorTrace: true,
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 160; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
  },
  /* B3: Verovio draws an end-of-line COURTESY signature when the NEXT line
   * begins with a clef/key/meter change. A splice window that stops at that
   * boundary renders its last line without the courtesy the live page has — a
   * width-only divergence (43-347 units on the sonata) that the context check
   * refuses on, and 9 of the 11 such refusals measured by splice-sweep.js. The
   * window must pull in the line that GENERATES the courtesy. Asserted via
   * FIXTURE_ASSERTIONS.pageSystemSpliceCourtesySig. */
  pageSystemSpliceCourtesySig: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 200; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
  },
  /* B3, second hole (2026-09-01): the courtesy-generating scoreDef may sit
   * BEHIND a break element. `setSectionHeaderAt` (and the MusicXML importer)
   * emit `scoreDef > sb[section] > measure`, so a movement that opens with a
   * key change has its scoreDef two siblings back — the first version of the
   * check read only the immediate previous sibling and walked straight past
   * both sonata movement boundaries (dW 347 and 604). Asserted via
   * FIXTURE_ASSERTIONS.pageSystemSpliceCourtesyBehindSectionBreak. */
  pageSystemSpliceCourtesyBehindSectionBreak: {
    skipCursorTrace: true,
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 200; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
  },
  /* B3, third hole (2026-09-01): a leading clef on a staff other than the
   * first is a courtesy clef on that staff. The check scanned only the first
   * staff, so a piano right hand going G→F at a line start (the sonata's
   * measure 226) left the line above without its courtesy in the window
   * (dW 49). Asserted via FIXTURE_ASSERTIONS.pageSystemSpliceCourtesyClefOtherStaff. */
  pageSystemSpliceCourtesyClefOtherStaff: {
    skipCursorTrace: true,
    setup: `
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      m.setCursor(0, 1);
      for (let i = 0; i < 200; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      m.setVoice(3); m.setCursor(0, 3);
      for (let i = 0; i < 200; i++) {
        m.insertChordAtCursor({ notes: [mk('c', 3)], duration: '4', dots: 0 });
      }
      m.setVoice(1);
      r();
    `,
  },
  /* Vertical ownership (2026-09-02): the courtesy-
   * generating line is no longer pulled into the window whole — only its FIRST
   * measure, as a pinned one-measure stub before the trailer. Two consecutive
   * lines that each begin a key change used to chain the window forward by
   * two whole lines (courtesyExt = 2, the bound); with the stub the window
   * ends one measure past the compared context line and the second signature
   * line never enters it. Asserted via
   * FIXTURE_ASSERTIONS.pageSystemSpliceCourtesyStubChain. */
  pageSystemSpliceCourtesyStubChain: {
    skipCursorTrace: true,
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 200; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
  },
  /* 2026-09-02: an <ending> that begins right past the window's
   * last line is swallowed WHOLE by the window's ending closure (which treats
   * the measure after the range as touched) before the courtesy rule runs, so
   * the courtesy stub is never an ending member — it is the first measure of
   * the line AFTER the swallowed ending line. Posed with a key change at the
   * ending's first measure (its line joins the window) and a second key change
   * on the following line (which becomes the stub). Asserted via
   * FIXTURE_ASSERTIONS.pageSystemSpliceCourtesyStubAfterEnding. */
  pageSystemSpliceCourtesyStubAfterEnding: {
    skipCursorTrace: true,
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 200; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
  },
  /* A render-time cross-measure dependency the sig-diff cannot see (2026-09-01):
   * `relocateInitialClefs` draws a measure-initial clef at the END of the
   * PREVIOUS measure, so an edit that makes a mid-measure clef measure-initial
   * (deleting the chord ahead of it) re-engraves the measure before the changed
   * run — on the line above, when the run starts a line. The sonata's last
   * measure posed exactly this (m-cy6, dW 89..329 on the line above): the
   * context check refused correctly, but the splice must instead pull the
   * predecessor into the run. Asserted via
   * FIXTURE_ASSERTIONS.pageSystemSpliceRelocatedClef. */
  pageSystemSpliceRelocatedClef: {
    skipCursorTrace: true,
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 200; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
  },
  /* Ctrl+L on a slot under a slur that crosses a system break deletes it: both
   * segments must leave the page (the continuation used to stay until some
   * other edit replaced its system). Asserted via
   * FIXTURE_ASSERTIONS.pageCrossSystemSlurDelete. */
  pageCrossSystemSlurDelete: { skipCursorTrace: true, setup: CROSS_SYS_DOC },
  /* The same removal reached through undo: Ctrl+L add, then Ctrl+Z. Undo
   * restores the pre-add document, which the splicer sees only as a changed
   * start measure. Asserted via FIXTURE_ASSERTIONS.pageCrossSystemSlurUndoAdd. */
  pageCrossSystemSlurUndoAdd: { skipCursorTrace: true, setup: CROSS_SYS_DOC },
  /* The tstamp-anchored sibling: a hairpin hosted in line 1's last measure
   * whose @tstamp2 reaches into line 2, then removed. Asserted via
   * FIXTURE_ASSERTIONS.pageCrossSystemHairpinDelete. */
  pageCrossSystemHairpinDelete: { skipCursorTrace: true, setup: CROSS_SYS_DOC },
  /* A metronome mark added by an edit draws its note glyph (2026-10-19). The
   * glyph is SMuFL text whose @font-face Verovio writes only into the SVG of a
   * window that draws such text; the page shells kept just the window's first
   * <style>, so the glyph drew blank — "( = 96)". The fix carries the face from
   * every window whose output enters the page (mergeGlyphDefs). Here the edit
   * is a page splice into line 3 of a document with no metronome glyph before it.
   * Asserted via FIXTURE_ASSERTIONS.pageMetronomeFontAfterSplice. */
  pageMetronomeFontAfterSplice: { skipCursorTrace: true, setup: CROSS_SYS_DOC },
  /* The scroll-view twin: the persistent scroll SVG came from a full render
   * with no SMuFL text, so its own <style>s declare no face either; the mark
   * arrives by a scroll splice. Asserted via
   * FIXTURE_ASSERTIONS.scrollMetronomeFontAfterSplice. */
  scrollMetronomeFontAfterSplice: { skipCursorTrace: true, setup: "window.__hkl_composer.renderer.setViewMode('scroll');" + CROSS_SYS_DOC },
  /* Range serializer (2026-09-01): a range whose first measure begins with a
   * clef change must fold that clef into its head scoreDef. The clef itself is
   * dropped from the range (`relocateInitialClefs(clone, true)` — its glyph
   * belongs to the out-of-range previous measure), and `runningScoreDefContext`
   * stopped BEFORE the target measure, so the head kept the OLD clef and the
   * whole sub-render drew in it. Found by the page splicer's context check:
   * windows opening at the sonata's measures 226 and 230 rendered staff 2 in
   * the wrong clef — including the REPLACED line — and only 11 units of
   * ledger-line drift on the context line stopped one from landing. Both the
   * page and scroll splicers render through this path. Asserted via
   * FIXTURE_ASSERTIONS.rangeSerializeLeadingClefHead. */
  rangeSerializeLeadingClefHead: {
    skipCursorTrace: true,
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 64; i++) {
        m.insertChordAtCursor({ notes: [mk('g', 5)], duration: '4', dots: 0 });
      }
      r();
    `,
  },
  /* B5: page view mounts pages lazily, so a line the splice needs is often a
   * placeholder. That used to refuse outright — the biggest refusal class in
   * real use (19 of 39 on the coverage sweep, invisible to the battery because
   * it pre-mounts everything). The splice must now mount such a page from the
   * already-loaded pre-edit layout and proceed. Asserted via
   * FIXTURE_ASSERTIONS.pageSystemSpliceEnsureMount. */
  pageSystemSpliceEnsureMount: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 400; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
    /* Cursor geometry is orthogonal to this fixture, and the walk scrolls
       every stop of a deliberately multi-page score into view — ~14 s here,
       for coverage the small cursor fixtures already give (2026-09-02). */
    skipCursorTrace: true,
  },
  /* B2 (2026-09-02; was the B1 safety net): a dy-cascade that pushes its page
   * past the paper is REPAIRED — the spilled system moves onto the next page
   * as a splice whose window pins it page-first (its position is read, never
   * modelled) — instead of handing pagination back to Verovio with a warn and
   * a full render. Asserted via FIXTURE_ASSERTIONS.pageSystemSpliceCascadeOverflow. */
  pageSystemSpliceCascadeOverflow: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 400; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
    /* Cursor geometry is orthogonal to this fixture, and the walk scrolls
       every stop of a deliberately multi-page score into view — ~14 s here,
       for coverage the small cursor fixtures already give (2026-09-02). */
    skipCursorTrace: true,
  },
  /* B2: the commonest line-count change — composing at the end of the score.
   * Appending past the last line's fill opens a new final line: a refill whose
   * partition has N+1 lines, which the splicer must land as a hunk (one old
   * system → two new) rather than refuse with "line count changed" (a full
   * render on every fourth bar of composition). Asserted via
   * FIXTURE_ASSERTIONS.pageSpliceNewLineAtEnd. */
  pageSpliceNewLineAtEnd: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 96; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
  },
  /* B2: composing past a FULL last page. The new final line spills page N;
   * the pagination repair moves it onto a page that does not exist yet, which
   * the splice creates from its own window page (same page options → same
   * furniture) — no full render, no warn. Asserted via
   * FIXTURE_ASSERTIONS.pageSpliceNewPageAtEnd. */
  pageSpliceNewPageAtEnd: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 400; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
    /* Cursor geometry is orthogonal to this fixture, and the walk scrolls
       every stop of a deliberately multi-page score into view — ~14 s here,
       for coverage the small cursor fixtures already give (2026-09-02). */
    skipCursorTrace: true,
  },
  /* B2, the 1 -> 2 transition: composing into an EMPTY score in page view.
   * The overflow cascade was gated on paginationOwned() (pageStartIds > 1), so
   * a ONE-page score could never grow a second one — the cascade was the only
   * thing that could add a page, and it required a page to already have been
   * added. Every new system piled past the bottom of page 1, silently, with no
   * warning, until some unrelated full render rebuilt the score. Live
   * composition therefore disagreed with importing the same content (measured
   * 2026-09-18: 161 measures = 1 page live, 4 pages imported).
   *
   * This fixture starts from the BLANK document and deliberately does NOT gate
   * on paginationOwned(): that precondition is exactly what blinded
   * pageSpliceNewPageAtEnd (which pre-builds a multi-page score) to this state.
   * Asserted via FIXTURE_ASSERTIONS.pageGrowFromOnePage. */
  pageGrowFromOnePage: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      r();
    `,
    /* The walk would scroll every stop of a multi-page score into view for
       coverage the small cursor fixtures already give. */
    skipCursorTrace: true,
    /* Two unavoidable full renders, neither of them the thing under test: the
       blank document is ONE system until ownership engages (the documented
       `single-line partition` bail), and the assertion then deliberately calls
       forceFullRerender() to compare the live result against a derived one —
       that comparison IS the contract being tested. The splice invariant is
       replaced here by a stricter, more specific check: the assertion requires
       lastCascade.created >= 1, so a second page arriving from a full render
       instead of the repair still fails. */
    fullRender: 'the blank doc derives while it is one system, and the assertion force-renders on purpose to compare live output against derived output',
  },
  /* A USER page break must survive the next edit. The derive paints 'encoded'
   * (which honors `<pb>`) and produced 2 pages, but the refill then repainted
   * with breaks:'line' whenever the owner held one page start — and 'line'
   * IGNORES `<pb>` (measured on identical data: 1 page vs 2). So Ctrl+B gave a
   * page break and the very next note took it away, with the `<pb>` still
   * sitting in the model (2026-09-18). Asserted via
   * FIXTURE_ASSERTIONS.pageUserBreakSurvivesEdit. */
  pageUserBreakSurvivesEdit: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      m.setCursor(0, 1);
      for (let i = 0; i < 4; i++) m.insertRestAtCursor({ duration: '4', dots: 0 });
      m.appendMeasure();
      m.togglePageBreakAt(1);
      r();
    `,
    skipCursorTrace: true,
    /* PRE-EXISTING, not what this fixture is about: the splice window carries
       the user `<pb>`, so the window render paginates, `getPageCount() !==
       wantPages` trips and the splicer refuses with 'window paginated' — an
       edit anywhere in a document with a user page break falls back to the
       full refill render. Measured the same with the old refill strategy (2
       full renders there against 1 here), so it is independent of the encoded
       fix this fixture guards. Worth its own work; see decisions.md. */
  },
  /* B2: the other direction — a line whose every measure is deleted vanishes
   * (membership carry), an N−1 partition. The hunk replaces two old systems
   * (the vanished line and the line the deletion anchored on) with one.
   * Asserted via FIXTURE_ASSERTIONS.pageSpliceLineMerge. */
  pageSpliceLineMerge: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 96; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
  },
  /* B2: a page whose every line is deleted collapses. Pages are carried by
   * line, so the emptied page's start moves onto its successor's start, the
   * page count drops by one, the splicer leaves the emptied page element
   * without systems and the renderer removes and renumbers it — the pins,
   * the page count and the DOM numbering must all agree afterwards. Asserted
   * via FIXTURE_ASSERTIONS.pageSplicePageCollapse. */
  pageSplicePageCollapse: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 400; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
    /* Cursor geometry is orthogonal to this fixture, and the walk scrolls
       every stop of a deliberately multi-page score into view — ~14 s here,
       for coverage the small cursor fixtures already give (2026-09-02). */
    skipCursorTrace: true,
  },
  /* A section header is a component with a reserved height in its page's
   * vertical budget (Max, 2026-09-02): the paper is fixed, the scale is fixed
   * at the box, and a page whose systems no longer fit below the reserve
   * overflows — the spilled tail moves onto the next page (title travelling
   * with its system). The injector used to grow the page's viewBox instead,
   * drawing header pages ~3 % small until the first splice re-pinned the box
   * 90 px taller. Asserted via FIXTURE_ASSERTIONS.pageSectionHeaderOverflow. */
  pageSectionHeaderOverflow: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 400; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
    /* Cursor geometry is orthogonal to this fixture, and the walk scrolls
       every stop of a deliberately multi-page score into view — ~14 s here,
       for coverage the small cursor fixtures already give (2026-09-02). */
    skipCursorTrace: true,
  },
  /* A render request with a signature-identical doc must not touch the page
   * DOM at all (the no-op skip): outcome 'noop' and element identity
   * preserved. Asserted via FIXTURE_ASSERTIONS.pageSystemSpliceNoopSkip. */
  pageSystemSpliceNoopSkip: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 48; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
  },
  /* Vertical ownership (2026-09-02): Composer OWNS the
   * page's vertical placement. Every mounted page — derived or spliced — must
   * satisfy the self-consistency invariant `live staff tops == placePage(live
   * extents)`: the one rule (render/pagefit.ts placeSystems) applied to the
   * extents measured off the page itself reproduces where the systems sit.
   * Asserted via FIXTURE_ASSERTIONS.pagePlacementOwned. */
  pagePlacementOwned: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 400; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
    /* Cursor geometry is orthogonal to this fixture, and the walk scrolls
       every stop of a deliberately multi-page score into view — ~14 s here,
       for coverage the small cursor fixtures already give (2026-09-02). */
    skipCursorTrace: true,
  },
  /* THE pagination identity invariants (2026-09-08). A multi-page score, then:
   *   1. mount every page, unmount every page, mount them all again — the
   *      pagination must be byte-identical. A mount is a VIEW operation; it
   *      must DRAW the pagination, never re-decide it.
   *   2. change the zoom — the pagination must be byte-identical. Zoom has no
   *      effect on layout.
   * Both were violated for weeks and neither had a test: the sonata paginated
   * to 30 pages at first paint and 31 after scrolling down and back up, and a
   * zoom silently re-paginated 31 -> 30 by restoring a partition cached before
   * the pagination was settled. Asserted via
   * FIXTURE_ASSERTIONS.pagePaginationIdentityUnderMountAndZoom. */
  pagePaginationIdentityUnderMountAndZoom: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 400; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
    /* Same reason as pagePlacementOwned: the cursor walk over a deliberately
       multi-page score costs many seconds for coverage the small cursor
       fixtures already provide. */
    skipCursorTrace: true,
    fullRender: 'a 400-bar document built from the blank doc derives on its first render, and the zoom assertion deliberately re-engraves three times — the point is that those re-engraves must NOT change the pagination',
  },
  /* A system whose topmost content is a <text> (a tempo above the
   * first staff) is placed by the same rule — its above-extent is read from
   * the post-processed bbox, never modelled. The first system on page 1 sits
   * below the page header, never higher than before the text arrived, and
   * stays self-consistent. Asserted via
   * FIXTURE_ASSERTIONS.pagePlacementTextTopped. */
  pagePlacementTextTopped: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 400; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
    /* Cursor geometry is orthogonal to this fixture, and the walk scrolls
       every stop of a deliberately multi-page score into view — ~14 s here,
       for coverage the small cursor fixtures already give (2026-09-02). */
    skipCursorTrace: true,
  },
  /* The splice window carries NO <pb> pins — it is one page, and a
   * page-first hunk is placed on its live page by the rule, from a one-page
   * window, instead of being read "absolutely" from a paginated window (B1's
   * reason for pinning). Asserted via FIXTURE_ASSERTIONS.pageSpliceNoPbPins. */
  pageSpliceNoPbPins: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 400; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
    /* Cursor geometry is orthogonal to this fixture, and the walk scrolls
       every stop of a deliberately multi-page score into view — ~14 s here,
       for coverage the small cursor fixtures already give (2026-09-02). */
    skipCursorTrace: true,
  },
  /* Vertical ownership: the overflow cascade runs on the MODEL.
   * The fold is predicted from placed extents (the flag cross-checks it against
   * the laid-out DOM), the spilled block is TRANSPLANTED — the same elements,
   * nothing rendered — and no page is left drawn past its paper. Asserted via
   * FIXTURE_ASSERTIONS.pageCascadePredictedFold. */
  pageCascadePredictedFold: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 400; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
    /* Cursor geometry is orthogonal to this fixture, and the walk scrolls
       every stop of a deliberately multi-page score into view — ~14 s here,
       for coverage the small cursor fixtures already give (2026-09-02). */
    skipCursorTrace: true,
  },
  /* A spill into a page that is NOT mounted but whose lines' extents
   * the extents job measured is pure bookkeeping — pins move, the page is
   * marked stale, nothing is rendered or parked — and the page draws right
   * when it mounts. Asserted via FIXTURE_ASSERTIONS.pageCascadeArithmeticPastMount. */
  pageCascadeArithmeticPastMount: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 400; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
    /* Cursor geometry is orthogonal to this fixture, and the walk scrolls
       every stop of a deliberately multi-page score into view — ~14 s here,
       for coverage the small cursor fixtures already give (2026-09-02). */
    skipCursorTrace: true,
  },
  /* An edit while the extents job is armed cancels it (adoption's
   * discipline: any document change) and the render re-arms it fresh; the edit
   * splices as usual and every page stays placed by its own rule. Asserted via
   * FIXTURE_ASSERTIONS.pageExtentsJobEditDuring. */
  pageExtentsJobEditDuring: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 400; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
    /* Cursor geometry is orthogonal to this fixture, and the walk scrolls
       every stop of a deliberately multi-page score into view — ~14 s here,
       for coverage the small cursor fixtures already give (2026-09-02). */
    skipCursorTrace: true,
  },
  /* A page that mounts while the extents job is armed measures itself
   * (placePage); the job skips it and measures only the pages still pending.
   * Asserted via FIXTURE_ASSERTIONS.pageExtentsJobScrollDuring. */
  pageExtentsJobScrollDuring: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 400; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
    /* Cursor geometry is orthogonal to this fixture, and the walk scrolls
       every stop of a deliberately multi-page score into view — ~14 s here,
       for coverage the small cursor fixtures already give (2026-09-02). */
    skipCursorTrace: true,
  },
  /* The splice clips its replaced set to the MOUNTED BAND (2026-09-02, Max:
   * "aren't unmounted pages supposed to be deferred off the main thread? A
   * synchronous wait for a 34-line window shouldn't be possible"). Inserting a
   * measure renumbers every measure to the end of its section, so the changed
   * run reaches the end of the document; only the lines on mounted pages may be
   * re-engraved, and the rest are deferred: marked stale, returned to
   * placeholders if drawn, redrawn from the committed pins on mount. Asserted
   * via FIXTURE_ASSERTIONS.pageSpliceClipsToMountedBand. */
  pageSpliceClipsToMountedBand: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 400; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
    /* Cursor geometry is orthogonal to this fixture, and the walk scrolls
       every stop of a deliberately multi-page score into view — ~14 s here,
       for coverage the small cursor fixtures already give (2026-09-02). */
    skipCursorTrace: true,
  },
  /* Re-flow and re-draw are different questions (2026-09-02). A renumber
   * changes what a measure DRAWS (the number is rendered, one per line start)
   * but not its width, so its line's fill and the partition cannot move: the
   * naturals measurement and the repair must see only the measures whose FLOW
   * changed, while the splicer still redraws the rest. Asserted via
   * FIXTURE_ASSERTIONS.pageRenumberIsRedrawOnly. */
  pageRenumberIsRedrawOnly: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 400; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
    /* Cursor geometry is orthogonal to this fixture, and the walk scrolls
       every stop of a deliberately multi-page score into view — ~14 s here,
       for coverage the small cursor fixtures already give (2026-09-02). */
    skipCursorTrace: true,
  },
  /* A clipped splice leaves the deferred pages stale, and a stale page's next
   * mount reloads the whole document into the toolkit — on the user's scroll.
   * The idle extents job warms them instead. Asserted via
   * FIXTURE_ASSERTIONS.pageExtentsJobWarmsDeferred. */
  pageExtentsJobWarmsDeferred: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 400; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
    /* Cursor geometry is orthogonal to this fixture, and the walk scrolls
       every stop of a deliberately multi-page score into view — ~14 s here,
       for coverage the small cursor fixtures already give (2026-09-02). */
    skipCursorTrace: true,
  },
};

export const ASSERTIONS = {
  pageSystemSpliceEdit: [
    { name: 'a mid-line edit lands as a system splice (no full loadData) and the DOM keeps the pinned partition',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        /* No priming: since the partition is repaired rather than re-derived
           (Max's ruling 2026-08-30), the FIRST edit in a region leaves the
           line count alone and must splice straight away. */
        const startIds = pb['startIds'];
        if (startIds.length < 3) return { ok: false, detail: 'need >= 3 lines, got ' + startIds.length };
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        /* Second measure of line 1: mid-line, past the excluded score-start line. */
        const mi = ids.indexOf(startIds[1]) + 1;
        m.setCursor(m.getMeasureStartCursor(1, mi), 1);
        if (!m.deleteAtCursor()) return { ok: false, detail: 'delete rejected' };
        H.reRender();   /* the inline reference gate (HKL_INDEX_CHECK) throws on any splice/full-render divergence */
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a system splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + ')' };
        /* Visual-diff diagnostic (2026-09-01): a one-off sub-pixel difference on
           the spliced system was seen in full-suite order. Record the vertical
           plan and each replaced system's applied translate in user units AND
           device pixels; the visual check appends window.__visualDiag on failure. */
        try {
          const vp = ps.lastVertical; const run = ps.lastRun; const sids = pb['startIds'];
          const systems = [];
          if (run) for (let k = run.a; k <= run.b; k++) {
            const meas = document.getElementById(sids[k]); const sys = meas && meas.closest('g.system');
            if (!sys) { systems.push({ line: k, missing: true }); continue; }
            const bv = sys.transform && sys.transform.baseVal.consolidate(); const tx = bv ? bv.matrix.e : 0, ty = bv ? bv.matrix.f : 0;
            const ctm = sys.getScreenCTM(); const devX = ctm ? tx * ctm.a : null, devY = ctm ? ty * ctm.d : null;
            systems.push({ line: k, tx: +tx.toFixed(2), ty: +ty.toFixed(2), devDx: devX == null ? null : +devX.toFixed(3), devDy: devY == null ? null : +devY.toFixed(3), fracDx: devX == null ? null : +((devX % 1 + 1) % 1).toFixed(3), fracDy: devY == null ? null : +((devY % 1 + 1) % 1).toFixed(3) });
          }
          window.__visualDiag = { static: vp ? vp.static : null, dyFollow: vp ? +vp.dyFollow.toFixed(2) : null, liveTop: vp ? vp.liveTop.map((v) => +v.toFixed(1)) : null, newTop: vp ? vp.newTop.map((v) => +v.toFixed(1)) : null, systems, mounted: document.querySelectorAll('#score .score-page:not(.score-page-pending)').length, scrollTop: document.getElementById('score').scrollTop };
        } catch (e) { window.__visualDiag = { error: String(e).slice(0, 120) }; }
        const pos = new Map(pb['startIds'].map((id, i) => [id, i]));
        let prevEnd = -1;
        for (const page of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
          const starts = [];
          for (const sys of page.querySelectorAll('g.system')) {
            const first = sys.querySelector('g.measure');
            if (first && first.id) starts.push(first.id);
          }
          if (!starts.length) continue;
          const at = pos.get(starts[0]);
          if (at == null || at <= prevEnd) return { ok: false, detail: 'system start ' + starts[0] + ' is not a pin (or out of order)' };
          for (let i = 1; i < starts.length; i++) {
            if (pos.get(starts[i]) !== at + i) return { ok: false, detail: 'spliced partition broke pin order at ' + starts[i] };
          }
          prevEnd = at + starts.length - 1;
        }
        return { ok: true };
      })()` },
  ],
  pageSpliceNoHostAttach: [
    { name: 'a system splice attaches nothing to <body> (the window is never laid out)',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        const settle = async () => {
          for (let i = 0; i < 500; i++) { const b = document.getElementById('renderBusy'); if (!b || b.hidden) break; await new Promise((r) => setTimeout(r, 20)); }
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        };
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        if (pb['startIds'].length < 3) return { ok: false, detail: 'need >= 3 lines, got ' + pb['startIds'].length };
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const edit = () => { const mi = ids.indexOf(pb['startIds'][1]) + 1; m.setCursor(m.getMeasureStartCursor(1, mi), 1); return m.deleteAtCursor(); };
        /* Warm-up: the FIRST naturals window after a load measures the leading
           clef+key width on an attached host, legitimately (A7). Do one edit,
           undo it, then measure the second. */
        const snap = m.snapshotState();
        if (!edit()) return { ok: false, detail: 'warm-up delete rejected' };
        H.reRender(); await settle();
        m.restoreSnapshot(snap); H.reRender(); await settle();
        /* The reference gate (HKL_INDEX_CHECK) attaches a host by design — it is
           a test-mode verification, not the splice. Measure without it. */
        const prev = globalThis.__HKL_INDEX_CHECK; globalThis.__HKL_INDEX_CHECK = false;
        /* Records are DELIVERED to the callback on a microtask, which empties the
           queue — a no-op callback would make takeRecords() see nothing. Collect
           in both places. */
        const recs = []; const mo = new MutationObserver((batch) => recs.push(...batch)); mo.observe(document.body, { childList: true });
        let added = [];
        try {
          if (!edit()) return { ok: false, detail: 'delete rejected' };
          H.reRender(); await settle();
          recs.push(...mo.takeRecords());
          added = recs.flatMap((rec) => Array.from(rec.addedNodes)).filter((n) => n.nodeType === 1)
            .map((n) => n.tagName + (n.className ? '.' + n.className : '') + (n.style && n.style.left ? '@' + n.style.left : ''));
        } finally { mo.disconnect(); globalThis.__HKL_INDEX_CHECK = prev; }
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a system splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + ')' };
        return { ok: added.length === 0, detail: 'elements attached to <body> during the splice: ' + JSON.stringify(added) };
      })()` },
  ],
  pageSystemSpliceBottomExtent: [
    { name: 'growing the doc-last line bottom extent now SPLICES (nothing below it moves) and matches a full re-engrave',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        if (pb['startIds'].length < 3) return { ok: false, detail: 'need >= 3 lines, got ' + pb['startIds'].length };
        /* Replace in the LAST measure — always in the page-last line, so the
           bottom extent of the system itself changes with nothing below it. */
        const lastMeasure = m.allMeasures()[ids.length - 1];
        const flat = m['flatChildren'](1);
        let cur = -1;
        for (let i = flat.length - 1; i >= 0; i--) {
          const el = flat[i];
          if ((el.localName === 'note' || el.localName === 'chord') && el.closest('measure') === lastMeasure) { cur = i; break; }
        }
        if (cur < 0) return { ok: false, detail: 'no note in the last measure to replace' };
        m.setCursor(cur, 1);
        const deep = { q: 0, r: 0, pname: 'c', accid: '', oct: 1, midi: 24, colorHex: '#888', lightColorHex: '#fff', velocity: 80 };
        if (m.replaceChordAtCursor({ notes: [deep], duration: '4', dots: 0 }) === null) return { ok: false, detail: 'replace rejected' };
        /* Mark line 0's system: it is never replaced, so it survives a splice
           and disappears if a full refill render rebuilt the page DOM. */
        const marker = document.querySelector('#score .score-page g.system');
        marker.setAttribute('data-hkl-test-marker', '1');
        H.reRender();   /* HKL_INDEX_CHECK reference gate throws on divergence */
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + ')' };
        const still = document.querySelector('[data-hkl-test-marker]');
        if (!still) return { ok: false, detail: 'page DOM was rebuilt — this was a full render, not a splice' };
        still.removeAttribute('data-hkl-test-marker');
        return { ok: true };
      })()` },
  ],
  pageSystemSpliceDyCascade: [
    { name: 'an edit that grows an early system pushes the systems below it down by the measured dy (B1 cascade)',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        const startIds = pb['startIds'];
        if (startIds.length < 4) return { ok: false, detail: 'need >= 4 lines, got ' + startIds.length };
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        /* Target line 1 so there are systems BELOW the replaced one to
           cascade (line 0 splices too — see pageScoreStartSplice — but on a
           short doc it can be the only line on its page). */
        const target = m.allMeasures()[ids.indexOf(startIds[1])];
        const flat = m['flatChildren'](1);
        let cur = -1;
        for (let i = 0; i < flat.length; i++) {
          const el = flat[i];
          if ((el.localName === 'note' || el.localName === 'chord') && el.closest('measure') === target) { cur = i; break; }
        }
        if (cur < 0) return { ok: false, detail: 'no note in the target measure to replace' };
        /* Where the last line sits now — it must end up lower. */
        const lastId = startIds[startIds.length - 1];
        const topOf = (id) => {
          const el = document.getElementById(id);
          return el ? el.getBoundingClientRect().top : null;
        };
        const before = topOf(lastId);
        if (before === null) return { ok: false, detail: 'last line not mounted' };
        const marker = document.querySelector('#score .score-page g.system');
        marker.setAttribute('data-hkl-test-marker', '1');
        m.setCursor(cur, 1);
        const deep = { q: 0, r: 0, pname: 'c', accid: '', oct: 2, midi: 36, colorHex: '#888', lightColorHex: '#fff', velocity: 80 };
        if (m.replaceChordAtCursor({ notes: [deep], duration: '4', dots: 0 }) === null) return { ok: false, detail: 'replace rejected' };
        H.reRender();   /* HKL_INDEX_CHECK reference gate throws on divergence */
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + ')' };
        if (!document.querySelector('[data-hkl-test-marker]')) return { ok: false, detail: 'page DOM was rebuilt — this was a full render, not a splice' };
        document.querySelector('[data-hkl-test-marker]').removeAttribute('data-hkl-test-marker');
        /* Phase 1 (2026-09-02): no vertical plan any more — the placement pass
           moves the followers by whatever the deeper chord adds to the edited
           system's extent below its last staff. Down is positive. */
        const after = topOf(lastId);
        if (after === null) return { ok: false, detail: 'last line vanished' };
        const movedPx = after - before;
        if (!(movedPx > 1)) return { ok: false, detail: 'followers did not cascade down: moved ' + movedPx.toFixed(2) + 'px' };
        return { ok: true };
      })()` },
  ],
  pageSectionHeaderCascade: [
    { name: 'an edit above a section header cascades the title with its system (no stranding, no overlap)',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 3 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
        const title = document.querySelector('#score text.hkl-section-header');
        if (!title) return { ok: false, detail: 'no section title rendered' };
        if (!isFinite(Number(title.getAttribute('data-reserve')))) {
          return { ok: false, detail: 'title carries no data-reserve — the splicer cannot subtract what it cannot read' };
        }
        const headerSys = () => {
          const t = document.querySelector('#score text.hkl-section-header');
          const meas = t && document.getElementById(t.getAttribute('data-for'));
          return { t, sys: meas ? meas.closest('g.system') : null };
        };
        /* Clearance between the title and the music it labels — the quantity a
           reader actually sees. Must survive the cascade unchanged. */
        const gap = () => {
          const { t, sys } = headerSys();
          if (!t || !sys) return null;
          return { g: sys.getBoundingClientRect().top - t.getBoundingClientRect().bottom,
                   sysTop: sys.getBoundingClientRect().top,
                   titleBottom: t.getBoundingClientRect().bottom };
        };
        const g0 = gap();
        if (!g0) return { ok: false, detail: 'header system not resolvable' };
        if (!(g0.g > 0)) return { ok: false, detail: 'title already overlapping before the edit (gap ' + g0.g.toFixed(1) + ')' };
        /* The line the header starts, and the line directly above it. */
        const hs = headerSys().sys;
        const onPage = [...hs.parentElement.querySelectorAll(':scope > g.system')];
        if (onPage.indexOf(hs) < 1) return { ok: false, detail: 'header system starts its page — no line above it on the same page' };
        const headerLine = pb['startIds'].indexOf(hs.querySelector('g.measure').id);
        if (headerLine < 2) return { ok: false, detail: 'header line too close to the score start (' + headerLine + ')' };
        const noteIn = (measureEl) => {
          const flat = m['flatChildren'](1);
          for (let i = 0; i < flat.length; i++) {
            const el = flat[i];
            if ((el.localName === 'note' || el.localName === 'chord') && el.closest('measure') === measureEl) return i;
          }
          return -1;
        };
        const lineStartMeasure = (li) => {
          const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
          return m.allMeasures()[ids.indexOf(pb['startIds'][li])];
        };
        const step = (notes, what) => {
          const cur = noteIn(lineStartMeasure(headerLine - 1));
          if (cur < 0) return { ok: false, detail: 'no note to replace on the line above the header' };
          m.setCursor(cur, 1);
          if (m.replaceChordAtCursor({ notes, duration: '4', dots: 0 }) === null) return { ok: false, detail: 'replace rejected (' + what + ')' };
          H.reRender();   /* HKL_INDEX_CHECK verifies the page against a full re-engrave */
          const g = gap();
          if (!g) return { ok: false, detail: 'header system lost after ' + what };
          if (Math.abs(g.g - g0.g) > 3) {
            return { ok: false, detail: what + ': title/system clearance changed ' + g0.g.toFixed(1) + ' -> ' + g.g.toFixed(1) + 'px (title did not travel with its system)' };
          }
          return { ok: true, g, outcome: ps.lastOutcome, plan: ps.lastVertical };
        };
        /* Grow the line above: everything below, header included, moves DOWN. */
        const grown = step([mk('c', 0), mk('g', 7)], 'grow');
        if (!grown.ok) return grown;
        if (grown.outcome !== 'spliced') return { ok: false, detail: 'expected a splice on grow, got "' + grown.outcome + '" (' + ps.lastSkipReason + ')' };
        /* Phase 1 (2026-09-02): no vertical plan any more; the pixel checks on
           sysTop below are what proves the cascade happened. */
        if (!(grown.g.sysTop - g0.sysTop > 1)) return { ok: false, detail: 'header system did not move down on grow' };
        /* Shrink it back: everything moves UP again — the direction that used
           to slide the music over the title. */
        const shrunk = step([mk('b', 4)], 'shrink');
        if (!shrunk.ok) return shrunk;
        /* Under rule v2 (Phase 4) a shrink does NOT necessarily pull the header
           system back up: the slack it frees is distributed across the page's
           gaps instead of collapsing them, and the partition legitimately stays
           put. Verified by hand against a full re-engrave (2026-09-03: spliced
           and derived both put the header system at page 2 system 0, same
           pixel) — but NOT asserted by forcing a re-render here, which mutates
           render state and pollutes later fixtures (lessons.md); HKL_INDEX_CHECK
           already compares every rendered page against a fresh engrave.
           What is asserted instead: the page is still self-consistent with the
           rule that placed it, and the system never drifts DOWNWARD on a
           shrink. */
        if (shrunk.g.sysTop > grown.g.sysTop + 1) return { ok: false, detail: 'header system moved DOWN on shrink: ' + grown.g.sysTop.toFixed(1) + ' -> ' + shrunk.g.sysTop.toFixed(1) };
        const tyOf = (el) => { const c = el.transform && el.transform.baseVal.consolidate(); return c ? c.matrix.f : 0; };
        const staffTopU = (sys) => { const st = sys.querySelector('g.measure > g.staff'); if (!st) return null; const ys = [...st.children].filter((n) => n.localName === 'path').map((n) => n.getBBox().y); if (!ys.length) return null; ys.sort((a, b) => a - b); return ys[0] + tyOf(st) + tyOf(sys); };
        const hs3 = headerSys().sys;
        const pgEl3 = hs3.closest('.score-page');
        const onPage3 = [...hs3.parentElement.querySelectorAll(':scope > g.system')];
        const exp3 = H.renderer.placeFor(onPage3, { distribute: true, pageNo: Number(pgEl3.dataset.page) });
        if (!exp3 || exp3.length !== onPage3.length) return { ok: false, detail: 'placement unreadable after the shrink' };
        for (let i = 0; i < onPage3.length; i++) {
          const live = staffTopU(onPage3[i]);
          if (live === null) return { ok: false, detail: 'system ' + i + ' has no readable staff lines after the shrink' };
          if (Math.abs(live - exp3[i].top) > 20) return { ok: false, detail: 'after the shrink, page ' + pgEl3.dataset.page + ' system ' + i + ': live top ' + live.toFixed(1) + ' vs rule ' + exp3[i].top.toFixed(1) };
        }
        return { ok: true };
      })()` },
  ],
  pageSectionHeaderOwnLine: [
    { name: "editing the header's OWN line splices, and the title is re-placed on the injector's rule",
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 3 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
        const title0 = document.querySelector('#score text.hkl-section-header');
        if (!title0) return { ok: false, detail: 'no section title rendered' };
        /* Both attributes together ARE the placement rule; without them the
           splicer cannot re-derive where the title goes and refuses the page. */
        const RESERVE = Number(title0.getAttribute('data-reserve'));
        const BASELINE = Number(title0.getAttribute('data-baseline'));
        if (!isFinite(RESERVE)) return { ok: false, detail: 'title carries no data-reserve' };
        if (!isFinite(BASELINE)) return { ok: false, detail: 'title carries no data-baseline' };
        const RULE = RESERVE - BASELINE;   /* title baseline sits this far above its system's content top */
        const ty = (el) => { const b = el.transform && el.transform.baseVal.consolidate(); return b ? b.matrix.f : 0; };
        const headerSys = () => {
          const t = document.querySelector('#score text.hkl-section-header');
          const meas = t && document.getElementById(t.getAttribute('data-for'));
          return { t, sys: meas ? meas.closest('g.system') : null };
        };
        /* Two readings: the RULE (Verovio units — what the injector fixes, and
           what a stale title violates as its system's content top moves) and
           the on-screen CLEARANCE in px, which is what a reader sees. */
        const state = () => {
          const { t, sys } = headerSys();
          if (!t || !sys) return null;
          const top = sys.getBBox().y + ty(sys);
          return { rule: top - Number(t.getAttribute('y')),
                   gap: sys.getBoundingClientRect().top - t.getBoundingClientRect().bottom };
        };
        const s0 = state();
        if (!s0) return { ok: false, detail: 'header system not resolvable' };
        if (!(s0.gap > 0)) return { ok: false, detail: 'title already overlapping before the edit (gap ' + s0.gap.toFixed(1) + 'px)' };
        const hs = headerSys().sys;
        const headerLine = pb['startIds'].indexOf(hs.querySelector('g.measure').id);
        if (headerLine < 1) return { ok: false, detail: 'header system is not a line start (' + headerLine + ')' };
        /* A note on the header's OWN line — the run the splice must replace. */
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const lo = ids.indexOf(pb['startIds'][headerLine]);
        const hi = headerLine + 1 < pb['startIds'].length ? ids.indexOf(pb['startIds'][headerLine + 1]) : ids.length;
        const flat = m['flatChildren'](1);
        let cur = -1;
        for (let i = 0; i < flat.length; i++) {
          const el = flat[i];
          if (el.localName !== 'note' && el.localName !== 'chord') continue;
          const mi = m.allMeasures().indexOf(el.closest('measure'));
          if (mi >= lo && mi < hi) { cur = i; break; }
        }
        if (cur < 0) return { ok: false, detail: 'no note on the header line to replace' };
        /* Snap noise (staff/barline snapping, applied at a different phase on
           the live page than on the freshly measured replacement) puts ~5 units
           on the rule reading. A title left at its old y drifts by however far
           its system's content top moved — 14 units on this document's grow
           step, so 8 discriminates with margin on both sides. */
        const TOL = 8;
        const step = (notes, what) => {
          m.setCursor(cur, 1);
          if (m.replaceChordAtCursor({ notes, duration: '4', dots: 0 }) === null) return { ok: false, detail: 'replace rejected (' + what + ')' };
          H.reRender();   /* HKL_INDEX_CHECK verifies the page against a full re-engrave */
          if (ps.lastOutcome !== 'spliced') return { ok: false, detail: what + ': expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + ')' };
          /* The point of the fixture: the header's OWN line was the run. */
          if (!ps.lastRun || headerLine < ps.lastRun.a || headerLine > ps.lastRun.b) {
            return { ok: false, detail: what + ': the header line was not in the replaced run (' + JSON.stringify(ps.lastRun) + ', header line ' + headerLine + ')' };
          }
          const st = state();
          if (!st) return { ok: false, detail: 'header system lost after ' + what };
          if (Math.abs(st.rule - RULE) > TOL) {
            return { ok: false, detail: what + ': title is ' + st.rule.toFixed(1) + ' units above its system content top, rule says ' + RULE + ' — it was not re-placed with the system it labels' };
          }
          if (Math.abs(st.gap - s0.gap) > 3) {
            return { ok: false, detail: what + ': title/system clearance changed ' + s0.gap.toFixed(1) + ' -> ' + st.gap.toFixed(1) + 'px' };
          }
          return { ok: true, st };
        };
        /* Grow the header line at BOTH extremes: a note far below sinks the
           system's whole frame (its top edge moves down ~14 units), which is
           what makes a stale title measurably wrong. Growing only upward does
           not pose the case — Verovio reserves the space by sinking the staff
           INSIDE the system, leaving its top edge where it was. */
        const grown = step([mk('c', 0), mk('g', 8)], 'grow');
        if (!grown.ok) return grown;
        /* And back. */
        const shrunk = step([mk('b', 4)], 'shrink');
        if (!shrunk.ok) return shrunk;
        return { ok: true };
      })()` },
  ],
  pageScoreStartSplice: [
    { name: 'an edit on the score-start line (line 0) splices instead of full-rendering',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 3 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        const startIds = pb['startIds'];
        if (startIds.length < 3) return { ok: false, detail: 'need >= 3 lines, got ' + startIds.length };
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const end = ids.indexOf(startIds[1]);
        if (end < 1) return { ok: false, detail: 'line 1 start not in model' };
        /* Prefer a measure after line 0's first, mirroring the coverage sweep's
           mid-line target; fall back to measure 0 on a one-measure line. */
        const flat = m['flatChildren'](1);
        let cur = -1, best = Infinity;
        for (let i = 0; i < flat.length; i++) {
          const el = flat[i];
          if (el.localName !== 'note' && el.localName !== 'chord') continue;
          const mi = m.allMeasures().indexOf(el.closest('measure'));
          if (mi < 0 || mi >= end) continue;
          const rank = mi === 0 ? 1 : 0;
          if (rank < best) { best = rank; cur = i; if (rank === 0) break; }
        }
        if (cur < 0) return { ok: false, detail: 'no note on line 0 to replace' };
        /* A marker on the LAST mounted system: it is outside the replaced run,
           so it survives a splice and dies with a full render. */
        const allSys = [...document.querySelectorAll('#score .score-page g.system')];
        if (allSys.length < 2) return { ok: false, detail: 'need >= 2 mounted systems, got ' + allSys.length };
        const marker = allSys[allSys.length - 1];
        marker.setAttribute('data-hkl-test-marker', '1');
        m.setCursor(cur, 1);
        const deep = { q: 0, r: 0, pname: 'c', accid: '', oct: 2, midi: 36, colorHex: '#888', lightColorHex: '#fff', velocity: 80 };
        if (m.replaceChordAtCursor({ notes: [deep], duration: '4', dots: 0 }) === null) return { ok: false, detail: 'replace rejected' };
        H.reRender();   /* HKL_INDEX_CHECK verifies page 1 against a full re-engrave */
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + ')' };
        if (!ps.lastRun || ps.lastRun.a !== 0) return { ok: false, detail: 'replaced run does not start at line 0: ' + JSON.stringify(ps.lastRun) };
        const still = document.querySelector('[data-hkl-test-marker]');
        if (!still) return { ok: false, detail: 'page DOM was rebuilt — this was a full render, not a splice' };
        still.removeAttribute('data-hkl-test-marker');
        return { ok: true };
      })()` },
  ],
  pageSystemSpliceCourtesySig: [
    { name: 'an edit beside a line that begins a key change still splices (the window pulls in the courtesy-generating line)',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        let startIds = pb['startIds'];
        if (startIds.length < 5) return { ok: false, detail: 'need >= 5 lines, got ' + startIds.length };
        /* Put a key change at the START of a line, so the PREVIOUS line gets an
           end-of-line courtesy signature — the thing the window must reproduce. */
        const sigLine = 3;
        /* The partition is a pure function of content (2026-09-19): adding a key
           signature widens its measure, so the section re-breaks and the measure
           the change was placed on may no longer START a line. Re-place it on
           the line start the NEW partition chose until it stays put (converges
           on the second attempt for this document). */
        let sigMi = -1, lineOfSig = -1;
        for (let attempt = 0; attempt < 5; attempt++) {
          const idsN = m.allMeasures().map((x) => x.getAttribute('xml:id'));
          const cand = idsN.indexOf(pb['startIds'][sigLine]);
          if (cand < 0) return { ok: false, detail: 'line start not in model' };
          if (sigMi >= 0 && sigMi !== cand) m.setKeySigAt(sigMi, '0', 'major');
          m.setKeySigAt(cand, '3s', 'major');
          sigMi = cand;
          H.reRender();
          await window.__waitForRender();
          for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
          await window.__waitForRender();
          const idsA = m.allMeasures().map((x) => x.getAttribute('xml:id'));
          lineOfSig = pb['startIds'].indexOf(idsA[sigMi]);
          if (lineOfSig >= 3) break;
        }
        startIds = pb['startIds'];
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        if (lineOfSig < 3) return { ok: false, detail: 'key change is not a line start (line ' + lineOfSig + ') — fixture cannot pose the case' };
        /* The retarget above is SETUP, not the thing under test: only the edit
           below must splice. */
        H.renderer.renderLedger().length = 0;
        /* Edit TWO lines before the key change. The line between them is then
           the compared context line, its last measure carries the courtesy, and
           the line that GENERATES that courtesy sits just beyond the window —
           which is exactly the case that used to diverge. Editing the line
           directly before the change does NOT pose it: the generating line is
           already the context line, hence already in the window. */
        const target = lineOfSig - 2;
        const mi = ids.indexOf(startIds[target]);
        if (mi < 0) return { ok: false, detail: 'target line start not in model' };
        m.setCursor(m.getMeasureStartCursor(1, mi + 1), 1);
        const ver = m.docVersion();
        if (!m.deleteAtCursor()) return { ok: false, detail: 'delete rejected' };
        if (m.docVersion() === ver) return { ok: false, detail: 'delete did not change the document' };
        H.reRender();   /* HKL_INDEX_CHECK verifies against a full re-engrave */
        if (/diverged/.test(ps.lastSkipReason || '')) {
          return { ok: false, detail: 'context line diverged — the courtesy line was not pulled into the window: ' + ps.lastSkipReason };
        }
        if (ps.lastOutcome !== 'spliced') {
          return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + ')' };
        }
        return { ok: true };
      })()` },
  ],
  pageReferenceGateCatchesForgedDefects: [
    { name: 'the reference gate accepts a real splice and names a forged signature glyph, a removed glyph group, and a removed cross-system spanner segment on the REPLACED line',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model, R = H.renderer;
        const pb = R['pageBreaks'];
        const ps = R['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        const startIds = pb['startIds'];
        if (startIds.length < 4) return { ok: false, detail: 'need >= 4 lines, got ' + startIds.length };
        /* A real splice on line 1 — the gate must accept it before it is
           trusted to reject anything. */
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const mi = ids.indexOf(startIds[1]);
        if (mi < 0) return { ok: false, detail: 'line 1 start not in model' };
        m.setCursor(m.getMeasureStartCursor(1, mi + 1), 1);
        const ver = m.docVersion();
        if (!m.deleteAtCursor()) return { ok: false, detail: 'delete rejected' };
        if (m.docVersion() === ver) return { ok: false, detail: 'delete did not change the document' };
        H.reRender();
        await window.__waitForRender();
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + ')' };
        const lineStart = pb['startIds'][1];
        const anchor = document.getElementById(lineStart);
        const sys = anchor && anchor.closest('g.system');
        const pageEl = anchor && anchor.closest('.score-page');
        if (!sys || !pageEl) return { ok: false, detail: 'replaced line 1 system not locatable after the splice' };
        const verify = () => {
          try { ps.verifyAgainstReference(R['pinnedMeiForCurrentModel'](), [pageEl], R['pageSpliceCtx']()); return null; }
          catch (e) { return String((e && e.message) || e); }
        };
        const clean = verify();
        if (clean) return { ok: false, detail: 'gate rejected an honest splice: ' + clean };
        const fails = [];
        /* (1) a signature glyph in the WRONG FORM at the right width. */
        const use = sys.querySelector('g.meterSig use, g.clef use');
        if (!use) { fails.push('no signature glyph on the replaced line to forge'); }
        else {
          const attr = use.hasAttribute('xlink:href') ? 'xlink:href' : 'href';
          const href = use.getAttribute(attr) || '';
          const forged = href.replace(/#E0[0-9A-F]{2}/, '#E0FF');
          if (forged === href) { fails.push('unexpected href ' + href); }
          else {
            use.setAttribute(attr, forged);
            const g = verify();
            use.setAttribute(attr, href);
            if (!g || !/signature glyphs diverged/.test(g)) fails.push('signature forgery not named: ' + g);
          }
        }
        /* (2) an equal-width CONTENT loss: drop a glyph group outright. The
           per-measure census is the only check that can see this. */
        const victim = sys.querySelector('g.measure g.notehead') || sys.querySelector('g.measure g.stem');
        if (!victim) { fails.push('no glyph group on the replaced line to remove'); }
        else {
          const parent = victim.parentNode, next = victim.nextSibling;
          parent.removeChild(victim);
          const g = verify();
          parent.insertBefore(victim, next);
          if (!g || !/rendered glyph classes diverged/.test(g)) fails.push('removed glyph group not named: ' + g);
        }
        /* (3) a segment a system draws OUTSIDE its measures — where Verovio
           puts the continuation of a spanner crossing the system break. Only
           the residue census can see one of these go missing. */
        const outside = Array.from(sys.children).find((c) => {
          const cls = (c.getAttribute && c.getAttribute('class') || '').split(/\s+/)[0];
          return cls && cls !== 'measure' && cls !== 'pb' && cls !== 'sb';
        });
        if (outside) {
          const parent = outside.parentNode, next = outside.nextSibling;
          parent.removeChild(outside);
          const g = verify();
          parent.insertBefore(outside, next);
          if (!g || !/outside the measures diverged/.test(g)) fails.push('removed out-of-measure segment not named: ' + g);
        }
        /* Leave the page as the splice left it. */
        const after = verify();
        if (after) fails.push('page not restored after the forgeries: ' + after);
        return fails.length ? { ok: false, detail: fails.join(' | ') } : { ok: true };
      })()` },
  ],
  pageKeyChangeSplicesGovernedRange: [
    { name: 'a key change with a later key change splices exactly the lines up to the reset (reference-clean)',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        /* a render the heaviness predictor defers (a meter change truncates a
           dozen measures) lands behind the busy badge — wait it out */
        const settle = async () => {
          for (let i = 0; i < 500; i++) { const b = document.getElementById('renderBusy'); if (!b || b.hidden) break; await new Promise((r) => setTimeout(r, 20)); }
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        };
        const KIND = 'key';
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        let startIds = pb['startIds'];
        if (startIds.length < 7) return { ok: false, detail: 'need >= 7 lines, got ' + startIds.length };
        const chordAt = (mi) => { const flat = m['flatChildren'](1); return flat.findIndex((el) => (el.localName === 'note' || el.localName === 'chord') && el.closest('measure') === m.allMeasures()[mi]); };
        /* The later RESET first (line 5), rendered by whatever path. Resets must
           DIFFER from the document's defaults (4/4, staff 1 in G2): setMeterAt /
           setClefAtCursor are diff-aware and write nothing for a redundant
           value — which would leave the edit's range unbounded.
           The partition is a pure function of content (2026-09-19), so the reset
           widens its measure and re-breaks the section: the measure it was placed
           on may no longer START a line. Re-place it on the line start the NEW
           partition chose until it stays put. Withdrawing is non-destructive for
           both retargeted kinds (key → inherited; meter 2/2 → 4/4 keeps every
           measure's content — a truncating change like 2/4 would not). A clef
           reset cannot be withdrawn the same way, so it keeps its single
           attempt, exactly as before. */
        let resetMi = -1, resetLine = -1;
        for (let attempt = 0; attempt < 5; attempt++) {
          const idsN = m.allMeasures().map((x) => x.getAttribute('xml:id'));
          const cand = idsN.indexOf(pb['startIds'][5]);
          if (cand < 0) return { ok: false, detail: 'line start not in model' };
          if (resetMi >= 0 && resetMi !== cand) {
            if (KIND === 'key') m.setKeySigAt(resetMi, '0', 'major');
            else if (KIND === 'meter') m.setMeterAt(resetMi, 4, 4);
          }
          if (KIND === 'key') m.setKeySigAt(cand, '2f', 'major');
          else if (KIND === 'meter') m.setMeterAt(cand, 2, 2);
          else { if (!m.setClefAtCursor(1, chordAt(cand), 'C', '3', null, null)) return { ok: false, detail: 'reset clef refused' }; }
          resetMi = cand;
          H.reRender(); await settle();
          for (let i = 0; i < 2 && !pb.ownershipActive(); i++) { H.reRender(); await settle(); }
          const idsA = m.allMeasures().map((x) => x.getAttribute('xml:id'));
          resetLine = pb['startIds'].indexOf(idsA[resetMi]);
          if (resetLine >= 4 || KIND === 'clef') break;
        }
        startIds = pb['startIds'];
        let ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        if (resetLine < 4) return { ok: false, detail: 'reset is not a line start >= 4 (line ' + resetLine + ') — fixture cannot pose the case' };
        /* The retarget above is SETUP, not the thing under test. */
        H.renderer.renderLedger().length = 0;
        /* the edit under test: the same kind of change at line 2. Clear the
           splicer's diagnostics first — a derive leaves them from the previous
           render, which would read as a stale "spliced". */
        const editMi = ids.indexOf(startIds[2]);
        ps.lastOutcome = ''; ps.lastRun = null; ps.lastSkipReason = '';
        const snapBefore = m.snapshotState();
        const ver = m.docVersion();
        /* meter: 4/4 → 2/2 keeps every measure's content and width (a
           truncating change like 2/4 halves the line fills, merges lines, and
           lands in B2 — line-count-changing refills — which is not under test) */
        if (KIND === 'key') m.setKeySigAt(editMi, '3s', 'major');
        else if (KIND === 'meter') m.setMeterAt(editMi, 2, 2);
        else { if (!m.setClefAtCursor(1, chordAt(editMi), 'F', '4', null, null)) return { ok: false, detail: 'edit clef refused' }; }
        if (m.docVersion() === ver) return { ok: false, detail: 'edit did not change the document' };
        const prevCheck = globalThis.__HKL_INDEX_CHECK;
        globalThis.__HKL_INDEX_CHECK = true;
        const __warns = []; const __ow = console.warn; console.warn = (...a) => { __warns.push(a.join(' ').slice(0, 160)); __ow(...a); };
        try { H.reRender(); await settle(); } finally { globalThis.__HKL_INDEX_CHECK = prevCheck; console.warn = __ow; }
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice of the governed range, got "' + ps.lastOutcome + '" (skip: ' + ps.lastSkipReason + '; derive reason: ' + pb.lastDeriveReason + '; refill moved lines: ' + pb.lastRefillLines + '; lines now ' + pb['startIds'].length + ')' };
        ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        startIds = pb['startIds'];
        /* Line CONTAINING the measure, not the line STARTING with it (2026-09-19).
           The signature change widens its measure, the section re-breaks, and the
           edited measure need not start a line any more — indexOf then read -1
           and every bound below compared against nonsense. */
        const lineOf = (mi) => { let k = -1; for (let i = 0; i < startIds.length; i++) { const st = ids.indexOf(startIds[i]); if (st >= 0 && st <= mi) k = i; } return k; };
        const editLine = lineOf(editMi);
        const resetLineNow = lineOf(resetMi);
        const run = ps.lastRun;
        /* the run may begin one line early: the measure before the change takes
           the end-of-line courtesy, so its line is replaced too. This bound is
           UNCHANGED by the 2026-09-19 balance work — only the line LOOKUPS moved
           to lineOf; the run stayed local. */
        if (!run || run.a > editLine || run.a < editLine - 1) return { ok: false, detail: 'run does not start at (or one line above) the edit line: run=' + JSON.stringify(run) + ' editLine=' + editLine + ' | diag: sigW=' + pb['sigW'] + ' budgetW=' + pb['budgetW'] + ' refillLines=' + pb.lastRefillLines + ' lines=' + startIds.length + ' editStart=' + ids[editMi] + ' startsNow=' + JSON.stringify(startIds.slice(0, 6)) + ' zoom=' + (window.__hkl_composer.renderer['zoom']) + ' mounted=' + document.querySelectorAll('#score .score-page:not(.score-page-pending)').length + '/' + document.querySelectorAll('#score .score-page').length + ' derive=' + pb.lastDeriveReason + ' adoptionInFlight=' + !!pb['adoption'] + ' tkCurrent=' + (window.__hkl_composer.renderer['pageVirt'] && window.__hkl_composer.renderer['pageVirt'].tkCurrent) + ' stale=' + (window.__hkl_composer.renderer['pageVirt'] ? [...window.__hkl_composer.renderer['pageVirt'].stalePages].join('/') : '-') + ' outcome=' + ps.lastOutcome + ' warns=' + JSON.stringify(__warns) };
        /* key/meter resets sit BEFORE their measure, so the run ends on the line
           before the reset; a mid-measure reset CLEF leaves the start of its own
           measure in the changed clef, so that line joins the range too */
        /* Last measure the change GOVERNS is the one before the reset; the run
           must reach the line holding it and stop there. Computed via lineOf
           rather than resetLineNow - 1 (2026-09-19): the reset need not start a
           line any more, and when it sits mid-line the governed range reaches
           into that same line. Identical to the old bound whenever the reset IS
           a line start. A mid-measure reset CLEF leaves the start of its own
           measure in the changed clef, so that line joins the range too. */
        const lastGoverned = KIND === 'clef' ? resetLineNow : lineOf(resetMi - 1);
        const maxB = lastGoverned;
        if (run.b < lastGoverned) return { ok: false, detail: 'run stops before the governed range ends: run=' + JSON.stringify(run) + ' reset line=' + resetLineNow + ' lastGoverned=' + lastGoverned };
        if (run.b > maxB) return { ok: false, detail: 'run overshoots the reset: run=' + JSON.stringify(run) + ' reset line=' + resetLineNow + ' lastGoverned=' + lastGoverned };
        /* The UNDO is the same range in reverse and must splice too. restoreSnapshot
           swaps the document object: interior scoreDefs are matched by their
           successor measure's id, never by element identity — identity read every
           scoreDef as removed+re-added and turned each undo into a whole-document
           derive (governed-range-edits.js, 2026-09-01). */
        ps.lastOutcome = ''; ps.lastRun = null; ps.lastSkipReason = ''; pb.lastDeriveReason = '';
        m.restoreSnapshot(snapBefore);
        H.reRender(); await settle();
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'UNDO did not splice: outcome "' + ps.lastOutcome + '" (skip: ' + ps.lastSkipReason + '; derive reason: ' + pb.lastDeriveReason + ')' };
        return { ok: true };
      })()` },
  ],
  pageMeterChangeSplicesGovernedRange: [
    { name: 'a meter change with a later meter change splices exactly the lines up to the reset (reference-clean)',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        /* a render the heaviness predictor defers (a meter change truncates a
           dozen measures) lands behind the busy badge — wait it out */
        const settle = async () => {
          for (let i = 0; i < 500; i++) { const b = document.getElementById('renderBusy'); if (!b || b.hidden) break; await new Promise((r) => setTimeout(r, 20)); }
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        };
        const KIND = 'meter';
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        let startIds = pb['startIds'];
        if (startIds.length < 7) return { ok: false, detail: 'need >= 7 lines, got ' + startIds.length };
        const chordAt = (mi) => { const flat = m['flatChildren'](1); return flat.findIndex((el) => (el.localName === 'note' || el.localName === 'chord') && el.closest('measure') === m.allMeasures()[mi]); };
        /* The later RESET first (line 5), rendered by whatever path. Resets must
           DIFFER from the document's defaults (4/4, staff 1 in G2): setMeterAt /
           setClefAtCursor are diff-aware and write nothing for a redundant
           value — which would leave the edit's range unbounded.
           The partition is a pure function of content (2026-09-19), so the reset
           widens its measure and re-breaks the section: the measure it was placed
           on may no longer START a line. Re-place it on the line start the NEW
           partition chose until it stays put. Withdrawing is non-destructive for
           both retargeted kinds (key → inherited; meter 2/2 → 4/4 keeps every
           measure's content — a truncating change like 2/4 would not). A clef
           reset cannot be withdrawn the same way, so it keeps its single
           attempt, exactly as before. */
        let resetMi = -1, resetLine = -1;
        for (let attempt = 0; attempt < 5; attempt++) {
          const idsN = m.allMeasures().map((x) => x.getAttribute('xml:id'));
          const cand = idsN.indexOf(pb['startIds'][5]);
          if (cand < 0) return { ok: false, detail: 'line start not in model' };
          if (resetMi >= 0 && resetMi !== cand) {
            if (KIND === 'key') m.setKeySigAt(resetMi, '0', 'major');
            else if (KIND === 'meter') m.setMeterAt(resetMi, 4, 4);
          }
          if (KIND === 'key') m.setKeySigAt(cand, '2f', 'major');
          else if (KIND === 'meter') m.setMeterAt(cand, 2, 2);
          else { if (!m.setClefAtCursor(1, chordAt(cand), 'C', '3', null, null)) return { ok: false, detail: 'reset clef refused' }; }
          resetMi = cand;
          H.reRender(); await settle();
          for (let i = 0; i < 2 && !pb.ownershipActive(); i++) { H.reRender(); await settle(); }
          const idsA = m.allMeasures().map((x) => x.getAttribute('xml:id'));
          resetLine = pb['startIds'].indexOf(idsA[resetMi]);
          if (resetLine >= 4 || KIND === 'clef') break;
        }
        startIds = pb['startIds'];
        let ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        if (resetLine < 4) return { ok: false, detail: 'reset is not a line start >= 4 (line ' + resetLine + ') — fixture cannot pose the case' };
        /* The retarget above is SETUP, not the thing under test. */
        H.renderer.renderLedger().length = 0;
        /* the edit under test: the same kind of change at line 2. Clear the
           splicer's diagnostics first — a derive leaves them from the previous
           render, which would read as a stale "spliced". */
        const editMi = ids.indexOf(startIds[2]);
        ps.lastOutcome = ''; ps.lastRun = null; ps.lastSkipReason = '';
        const snapBefore = m.snapshotState();
        const ver = m.docVersion();
        /* meter: 4/4 → 2/2 keeps every measure's content and width (a
           truncating change like 2/4 halves the line fills, merges lines, and
           lands in B2 — line-count-changing refills — which is not under test) */
        if (KIND === 'key') m.setKeySigAt(editMi, '3s', 'major');
        else if (KIND === 'meter') m.setMeterAt(editMi, 2, 2);
        else { if (!m.setClefAtCursor(1, chordAt(editMi), 'F', '4', null, null)) return { ok: false, detail: 'edit clef refused' }; }
        if (m.docVersion() === ver) return { ok: false, detail: 'edit did not change the document' };
        const prevCheck = globalThis.__HKL_INDEX_CHECK;
        globalThis.__HKL_INDEX_CHECK = true;
        const __warns = []; const __ow = console.warn; console.warn = (...a) => { __warns.push(a.join(' ').slice(0, 160)); __ow(...a); };
        try { H.reRender(); await settle(); } finally { globalThis.__HKL_INDEX_CHECK = prevCheck; console.warn = __ow; }
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice of the governed range, got "' + ps.lastOutcome + '" (skip: ' + ps.lastSkipReason + '; derive reason: ' + pb.lastDeriveReason + '; refill moved lines: ' + pb.lastRefillLines + '; lines now ' + pb['startIds'].length + ')' };
        ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        startIds = pb['startIds'];
        /* Line CONTAINING the measure, not the line STARTING with it (2026-09-19).
           The signature change widens its measure, the section re-breaks, and the
           edited measure need not start a line any more — indexOf then read -1
           and every bound below compared against nonsense. */
        const lineOf = (mi) => { let k = -1; for (let i = 0; i < startIds.length; i++) { const st = ids.indexOf(startIds[i]); if (st >= 0 && st <= mi) k = i; } return k; };
        const editLine = lineOf(editMi);
        const resetLineNow = lineOf(resetMi);
        const run = ps.lastRun;
        /* the run may begin one line early: the measure before the change takes
           the end-of-line courtesy, so its line is replaced too. This bound is
           UNCHANGED by the 2026-09-19 balance work — only the line LOOKUPS moved
           to lineOf; the run stayed local. */
        if (!run || run.a > editLine || run.a < editLine - 1) return { ok: false, detail: 'run does not start at (or one line above) the edit line: run=' + JSON.stringify(run) + ' editLine=' + editLine + ' | diag: sigW=' + pb['sigW'] + ' budgetW=' + pb['budgetW'] + ' refillLines=' + pb.lastRefillLines + ' lines=' + startIds.length + ' editStart=' + ids[editMi] + ' startsNow=' + JSON.stringify(startIds.slice(0, 6)) + ' zoom=' + (window.__hkl_composer.renderer['zoom']) + ' mounted=' + document.querySelectorAll('#score .score-page:not(.score-page-pending)').length + '/' + document.querySelectorAll('#score .score-page').length + ' derive=' + pb.lastDeriveReason + ' adoptionInFlight=' + !!pb['adoption'] + ' tkCurrent=' + (window.__hkl_composer.renderer['pageVirt'] && window.__hkl_composer.renderer['pageVirt'].tkCurrent) + ' stale=' + (window.__hkl_composer.renderer['pageVirt'] ? [...window.__hkl_composer.renderer['pageVirt'].stalePages].join('/') : '-') + ' outcome=' + ps.lastOutcome + ' warns=' + JSON.stringify(__warns) };
        /* key/meter resets sit BEFORE their measure, so the run ends on the line
           before the reset; a mid-measure reset CLEF leaves the start of its own
           measure in the changed clef, so that line joins the range too */
        /* Last measure the change GOVERNS is the one before the reset; the run
           must reach the line holding it and stop there. Computed via lineOf
           rather than resetLineNow - 1 (2026-09-19): the reset need not start a
           line any more, and when it sits mid-line the governed range reaches
           into that same line. Identical to the old bound whenever the reset IS
           a line start. A mid-measure reset CLEF leaves the start of its own
           measure in the changed clef, so that line joins the range too. */
        const lastGoverned = KIND === 'clef' ? resetLineNow : lineOf(resetMi - 1);
        const maxB = lastGoverned;
        if (run.b < lastGoverned) return { ok: false, detail: 'run stops before the governed range ends: run=' + JSON.stringify(run) + ' reset line=' + resetLineNow + ' lastGoverned=' + lastGoverned };
        if (run.b > maxB) return { ok: false, detail: 'run overshoots the reset: run=' + JSON.stringify(run) + ' reset line=' + resetLineNow + ' lastGoverned=' + lastGoverned };
        /* The UNDO is the same range in reverse and must splice too. restoreSnapshot
           swaps the document object: interior scoreDefs are matched by their
           successor measure's id, never by element identity — identity read every
           scoreDef as removed+re-added and turned each undo into a whole-document
           derive (governed-range-edits.js, 2026-09-01). */
        ps.lastOutcome = ''; ps.lastRun = null; ps.lastSkipReason = ''; pb.lastDeriveReason = '';
        m.restoreSnapshot(snapBefore);
        H.reRender(); await settle();
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'UNDO did not splice: outcome "' + ps.lastOutcome + '" (skip: ' + ps.lastSkipReason + '; derive reason: ' + pb.lastDeriveReason + ')' };
        return { ok: true };
      })()` },
  ],
  pageClefChangeSplicesGovernedRange: [
    { name: 'a clef change with a later clef on the same staff splices exactly the lines up to the reset (reference-clean)',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        /* a render the heaviness predictor defers (a meter change truncates a
           dozen measures) lands behind the busy badge — wait it out */
        const settle = async () => {
          for (let i = 0; i < 500; i++) { const b = document.getElementById('renderBusy'); if (!b || b.hidden) break; await new Promise((r) => setTimeout(r, 20)); }
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        };
        const KIND = 'clef';
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        let startIds = pb['startIds'];
        if (startIds.length < 7) return { ok: false, detail: 'need >= 7 lines, got ' + startIds.length };
        const chordAt = (mi) => { const flat = m['flatChildren'](1); return flat.findIndex((el) => (el.localName === 'note' || el.localName === 'chord') && el.closest('measure') === m.allMeasures()[mi]); };
        /* The later RESET first (line 5), rendered by whatever path. Resets must
           DIFFER from the document's defaults (4/4, staff 1 in G2): setMeterAt /
           setClefAtCursor are diff-aware and write nothing for a redundant
           value — which would leave the edit's range unbounded.
           The partition is a pure function of content (2026-09-19), so the reset
           widens its measure and re-breaks the section: the measure it was placed
           on may no longer START a line. Re-place it on the line start the NEW
           partition chose until it stays put. Withdrawing is non-destructive for
           both retargeted kinds (key → inherited; meter 2/2 → 4/4 keeps every
           measure's content — a truncating change like 2/4 would not). A clef
           reset cannot be withdrawn the same way, so it keeps its single
           attempt, exactly as before. */
        let resetMi = -1, resetLine = -1;
        for (let attempt = 0; attempt < 5; attempt++) {
          const idsN = m.allMeasures().map((x) => x.getAttribute('xml:id'));
          const cand = idsN.indexOf(pb['startIds'][5]);
          if (cand < 0) return { ok: false, detail: 'line start not in model' };
          if (resetMi >= 0 && resetMi !== cand) {
            if (KIND === 'key') m.setKeySigAt(resetMi, '0', 'major');
            else if (KIND === 'meter') m.setMeterAt(resetMi, 4, 4);
          }
          if (KIND === 'key') m.setKeySigAt(cand, '2f', 'major');
          else if (KIND === 'meter') m.setMeterAt(cand, 2, 2);
          else { if (!m.setClefAtCursor(1, chordAt(cand), 'C', '3', null, null)) return { ok: false, detail: 'reset clef refused' }; }
          resetMi = cand;
          H.reRender(); await settle();
          for (let i = 0; i < 2 && !pb.ownershipActive(); i++) { H.reRender(); await settle(); }
          const idsA = m.allMeasures().map((x) => x.getAttribute('xml:id'));
          resetLine = pb['startIds'].indexOf(idsA[resetMi]);
          if (resetLine >= 4 || KIND === 'clef') break;
        }
        startIds = pb['startIds'];
        let ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        if (resetLine < 4) return { ok: false, detail: 'reset is not a line start >= 4 (line ' + resetLine + ') — fixture cannot pose the case' };
        /* The retarget above is SETUP, not the thing under test. */
        H.renderer.renderLedger().length = 0;
        /* the edit under test: the same kind of change at line 2. Clear the
           splicer's diagnostics first — a derive leaves them from the previous
           render, which would read as a stale "spliced". */
        const editMi = ids.indexOf(startIds[2]);
        ps.lastOutcome = ''; ps.lastRun = null; ps.lastSkipReason = '';
        const snapBefore = m.snapshotState();
        const ver = m.docVersion();
        /* meter: 4/4 → 2/2 keeps every measure's content and width (a
           truncating change like 2/4 halves the line fills, merges lines, and
           lands in B2 — line-count-changing refills — which is not under test) */
        if (KIND === 'key') m.setKeySigAt(editMi, '3s', 'major');
        else if (KIND === 'meter') m.setMeterAt(editMi, 2, 2);
        else { if (!m.setClefAtCursor(1, chordAt(editMi), 'F', '4', null, null)) return { ok: false, detail: 'edit clef refused' }; }
        if (m.docVersion() === ver) return { ok: false, detail: 'edit did not change the document' };
        const prevCheck = globalThis.__HKL_INDEX_CHECK;
        globalThis.__HKL_INDEX_CHECK = true;
        const __warns = []; const __ow = console.warn; console.warn = (...a) => { __warns.push(a.join(' ').slice(0, 160)); __ow(...a); };
        try { H.reRender(); await settle(); } finally { globalThis.__HKL_INDEX_CHECK = prevCheck; console.warn = __ow; }
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice of the governed range, got "' + ps.lastOutcome + '" (skip: ' + ps.lastSkipReason + '; derive reason: ' + pb.lastDeriveReason + '; refill moved lines: ' + pb.lastRefillLines + '; lines now ' + pb['startIds'].length + ')' };
        ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        startIds = pb['startIds'];
        /* Line CONTAINING the measure, not the line STARTING with it (2026-09-19).
           The signature change widens its measure, the section re-breaks, and the
           edited measure need not start a line any more — indexOf then read -1
           and every bound below compared against nonsense. */
        const lineOf = (mi) => { let k = -1; for (let i = 0; i < startIds.length; i++) { const st = ids.indexOf(startIds[i]); if (st >= 0 && st <= mi) k = i; } return k; };
        const editLine = lineOf(editMi);
        const resetLineNow = lineOf(resetMi);
        const run = ps.lastRun;
        /* the run may begin one line early: the measure before the change takes
           the end-of-line courtesy, so its line is replaced too. This bound is
           UNCHANGED by the 2026-09-19 balance work — only the line LOOKUPS moved
           to lineOf; the run stayed local. */
        if (!run || run.a > editLine || run.a < editLine - 1) return { ok: false, detail: 'run does not start at (or one line above) the edit line: run=' + JSON.stringify(run) + ' editLine=' + editLine + ' | diag: sigW=' + pb['sigW'] + ' budgetW=' + pb['budgetW'] + ' refillLines=' + pb.lastRefillLines + ' lines=' + startIds.length + ' editStart=' + ids[editMi] + ' startsNow=' + JSON.stringify(startIds.slice(0, 6)) + ' zoom=' + (window.__hkl_composer.renderer['zoom']) + ' mounted=' + document.querySelectorAll('#score .score-page:not(.score-page-pending)').length + '/' + document.querySelectorAll('#score .score-page').length + ' derive=' + pb.lastDeriveReason + ' adoptionInFlight=' + !!pb['adoption'] + ' tkCurrent=' + (window.__hkl_composer.renderer['pageVirt'] && window.__hkl_composer.renderer['pageVirt'].tkCurrent) + ' stale=' + (window.__hkl_composer.renderer['pageVirt'] ? [...window.__hkl_composer.renderer['pageVirt'].stalePages].join('/') : '-') + ' outcome=' + ps.lastOutcome + ' warns=' + JSON.stringify(__warns) };
        /* key/meter resets sit BEFORE their measure, so the run ends on the line
           before the reset; a mid-measure reset CLEF leaves the start of its own
           measure in the changed clef, so that line joins the range too */
        /* Last measure the change GOVERNS is the one before the reset; the run
           must reach the line holding it and stop there. Computed via lineOf
           rather than resetLineNow - 1 (2026-09-19): the reset need not start a
           line any more, and when it sits mid-line the governed range reaches
           into that same line. Identical to the old bound whenever the reset IS
           a line start. A mid-measure reset CLEF leaves the start of its own
           measure in the changed clef, so that line joins the range too. */
        const lastGoverned = KIND === 'clef' ? resetLineNow : lineOf(resetMi - 1);
        const maxB = lastGoverned;
        if (run.b < lastGoverned) return { ok: false, detail: 'run stops before the governed range ends: run=' + JSON.stringify(run) + ' reset line=' + resetLineNow + ' lastGoverned=' + lastGoverned };
        if (run.b > maxB) return { ok: false, detail: 'run overshoots the reset: run=' + JSON.stringify(run) + ' reset line=' + resetLineNow + ' lastGoverned=' + lastGoverned };
        /* The UNDO is the same range in reverse and must splice too. restoreSnapshot
           swaps the document object: interior scoreDefs are matched by their
           successor measure's id, never by element identity — identity read every
           scoreDef as removed+re-added and turned each undo into a whole-document
           derive (governed-range-edits.js, 2026-09-01). */
        ps.lastOutcome = ''; ps.lastRun = null; ps.lastSkipReason = ''; pb.lastDeriveReason = '';
        m.restoreSnapshot(snapBefore);
        H.reRender(); await settle();
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'UNDO did not splice: outcome "' + ps.lastOutcome + '" (skip: ' + ps.lastSkipReason + '; derive reason: ' + pb.lastDeriveReason + ')' };
        return { ok: true };
      })()` },
  ],
  pageScoreStartSpliceKeepsMeterSym: [
    { name: 'a line-0 splice keeps the cut-time symbol (range head keeps meter.sym; meter glyphs match a full render)',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        const headSym = m.getDoc().querySelector('scoreDef').getAttribute('meter.sym');
        if (headSym !== 'cut') return { ok: false, detail: 'fixture cannot pose the case: head meter.sym=' + headSym };
        /* model level: the range head must keep the symbol */
        const rangeHead = new DOMParser().parseFromString(m.serializeRangeForRender(0, 2, { hejiEnabled: false }, null), 'application/xml').querySelector('scoreDef');
        if (rangeHead.getAttribute('meter.sym') !== 'cut') return { ok: false, detail: 'serializeRangeForRender(0, 2) head lost meter.sym (' + rangeHead.getAttribute('meter.sym') + ')' };
        const glyphs = () => { const m0 = document.querySelector('#score .score-page[data-page="1"] g.measure');
          return m0 ? Array.from(m0.querySelectorAll('g.meterSig use')).map((u) => (u.getAttribute('xlink:href') || u.getAttribute('href') || '').replace(/^#/, '').split('-')[0]).join(' ') : 'page 1 not mounted'; };
        const before = glyphs();
        if (!/E08B/.test(before)) return { ok: false, detail: 'fixture cannot pose the case: live measure 0 does not draw the cut-time glyph: ' + before };
        /* edit line 0 */
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        m.setCursor(m.getMeasureStartCursor(1, 1), 1);
        const ver = m.docVersion();
        if (!m.deleteAtCursor()) return { ok: false, detail: 'delete rejected' };
        if (m.docVersion() === ver) return { ok: false, detail: 'delete did not change the document' };
        const prevCheck = globalThis.__HKL_INDEX_CHECK;
        globalThis.__HKL_INDEX_CHECK = true;
        try { H.reRender(); } finally { globalThis.__HKL_INDEX_CHECK = prevCheck; }
        await window.__waitForRender();
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice on line 0, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + ')' };
        if (!ps.lastRun || ps.lastRun.a !== 0) return { ok: false, detail: 'edit did not replace line 0: run=' + JSON.stringify(ps.lastRun) };
        const after = glyphs();
        if (after !== before) return { ok: false, detail: 'meter glyphs changed across the line-0 splice: before "' + before + '" after "' + after + '"' };
        return { ok: true };
      })()` },
  ],
  pageSystemSpliceCourtesyBehindSectionBreak: [
    { name: 'an edit one line above a movement that opens with a key change (scoreDef behind the section <sb>) splices',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        let startIds = pb['startIds'];
        if (startIds.length < 6) return { ok: false, detail: 'need >= 6 lines, got ' + startIds.length };
        const ids0 = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const sigMi = ids0.indexOf(startIds[4]);
        if (sigMi < 0) return { ok: false, detail: 'line start not in model' };
        /* Key change FIRST (scoreDef directly before the measure), THEN the
           section header, whose <sb> lands between them: scoreDef > sb > measure,
           the importer's order at a movement boundary. */
        m.setKeySigAt(sigMi, '3s', 'major');
        if (m.setSectionHeaderAt(sigMi, 'II') !== true) return { ok: false, detail: 'setSectionHeaderAt refused' };
        const meas = m.allMeasures()[sigMi];
        const prev1 = meas.previousElementSibling, prev2 = prev1 && prev1.previousElementSibling;
        if (!prev1 || prev1.localName !== 'sb' || !prev2 || prev2.localName !== 'scoreDef') {
          return { ok: false, detail: 'fixture cannot pose the case: siblings before the header measure are ' + (prev2 && prev2.localName) + ' > ' + (prev1 && prev1.localName) };
        }
        H.reRender();
        await window.__waitForRender();
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        startIds = pb['startIds'];
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const lineOfSig = startIds.indexOf(ids[sigMi]);
        if (lineOfSig < 3) return { ok: false, detail: 'header measure is not a line start >= 3 (line ' + lineOfSig + ')' };
        /* Two lines above: the line between is the compared context line, its
           last measure carries the courtesy key signature, and the line that
           GENERATES it sits just beyond the window. */
        const target = lineOfSig - 1;
        const mi = ids.indexOf(startIds[target]);
        m.setCursor(m.getMeasureStartCursor(1, mi + 1), 1);
        const ver = m.docVersion();
        if (!m.deleteAtCursor()) return { ok: false, detail: 'delete rejected' };
        if (m.docVersion() === ver) return { ok: false, detail: 'delete did not change the document' };
        const prevCheck = globalThis.__HKL_INDEX_CHECK;
        globalThis.__HKL_INDEX_CHECK = true;
        try { H.reRender(); } finally { globalThis.__HKL_INDEX_CHECK = prevCheck; }
        await window.__waitForRender();
        if (/diverged/.test(ps.lastSkipReason || '')) {
          return { ok: false, detail: 'context line diverged — the courtesy line behind the section break was not pulled in: ' + ps.lastSkipReason };
        }
        if (ps.lastOutcome !== 'spliced') {
          return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + ')' };
        }
        if (!ps.lastWindow || !ps.lastWindow.stubId) {
          return { ok: false, detail: 'window has no courtesy stub for the generating line (stubId=' + (ps.lastWindow && ps.lastWindow.stubId) + ')' };
        }
        /* The stub is exactly ONE measure past the last window line (Phase 0,
           2026-09-02) — the generating line's first measure, not the line. */
        { const sp = pb['startIds'], idsN = m.allMeasures().map((x) => x.getAttribute('xml:id')), W = ps.lastWindow;
          const lineEnd = W.wHi + 1 < sp.length ? idsN.indexOf(sp[W.wHi + 1]) : idsN.length;
          if (W.mHi !== lineEnd || idsN[W.mHi] !== W.stubId) return { ok: false, detail: 'stub is not exactly the first measure past the last window line (mHi=' + W.mHi + ', line end=' + lineEnd + ', stubId=' + W.stubId + ')' }; }
        return { ok: true };
      })()` },
  ],
  pageSystemSpliceCourtesyClefOtherStaff: [
    { name: 'an edit one line above a line that begins with a STAFF-2 clef change splices (courtesy clef on the second staff)',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        let startIds = pb['startIds'];
        if (startIds.length < 6) return { ok: false, detail: 'need >= 6 lines, got ' + startIds.length };
        const ids0 = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const sigMi = ids0.indexOf(startIds[4]);
        if (sigMi < 0) return { ok: false, detail: 'line start not in model' };
        /* Voice 3 = staff 2, layer 1. Its default clef is F4, so G2 is a change.
           Cursor c means "past flat[c]", so a clef set at the first chord's
           cursor lands AFTER that chord; deleting the chord then makes the clef
           measure-initial — the importer's form, and the only public-API route
           to it (a clef set at the barline cursor is stored at the END of the
           previous measure instead). */
        const flat3 = m['flatChildren'](3);
        const first3 = flat3.findIndex((el) => (el.localName === 'note' || el.localName === 'chord') && el.closest('measure') === m.allMeasures()[sigMi]);
        if (first3 < 0) return { ok: false, detail: 'no chord in voice 3 of the target measure' };
        if (!m.setClefAtCursor(3, first3, 'G', '2', null, null)) return { ok: false, detail: 'setClefAtCursor refused' };
        m.setVoice(3); m.setCursor(first3, 3);
        const delOk = m.deleteAtCursor();
        m.setVoice(1);
        if (!delOk) return { ok: false, detail: 'delete in voice 3 rejected' };
        const meas = m.allMeasures()[sigMi];
        const lead = meas.querySelector('staff[n="2"] > layer > clef');
        if (!lead || lead !== lead.parentElement.firstElementChild) return { ok: false, detail: 'fixture cannot pose the case: no leading clef in staff 2 of the target measure: ' + (lead ? Array.from(lead.parentElement.children).map((c) => c.localName).join(',') : 'none') };
        if (meas.querySelector('staff[n="1"] > layer > clef')) return { ok: false, detail: 'unexpected clef on staff 1' };
        H.reRender();
        await window.__waitForRender();
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        startIds = pb['startIds'];
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const lineOfSig = startIds.indexOf(ids[sigMi]);
        if (lineOfSig < 3) return { ok: false, detail: 'clef-change measure is not a line start >= 3 (line ' + lineOfSig + ')' };
        const target = lineOfSig - 1;
        const mi = ids.indexOf(startIds[target]);
        m.setCursor(m.getMeasureStartCursor(1, mi + 1), 1);
        const ver = m.docVersion();
        if (!m.deleteAtCursor()) return { ok: false, detail: 'delete rejected' };
        if (m.docVersion() === ver) return { ok: false, detail: 'delete did not change the document' };
        const prevCheck = globalThis.__HKL_INDEX_CHECK;
        globalThis.__HKL_INDEX_CHECK = true;
        try { H.reRender(); } finally { globalThis.__HKL_INDEX_CHECK = prevCheck; }
        await window.__waitForRender();
        if (/diverged/.test(ps.lastSkipReason || '')) {
          return { ok: false, detail: 'context line diverged — the staff-2 courtesy clef line was not pulled in: ' + ps.lastSkipReason };
        }
        if (ps.lastOutcome !== 'spliced') {
          return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + ')' };
        }
        if (!ps.lastWindow || !ps.lastWindow.stubId) {
          return { ok: false, detail: 'window has no courtesy stub for the generating line (stubId=' + (ps.lastWindow && ps.lastWindow.stubId) + ')' };
        }
        /* The stub is exactly ONE measure past the last window line (Phase 0,
           2026-09-02) — the generating line's first measure, not the line. */
        { const sp = pb['startIds'], idsN = m.allMeasures().map((x) => x.getAttribute('xml:id')), W = ps.lastWindow;
          const lineEnd = W.wHi + 1 < sp.length ? idsN.indexOf(sp[W.wHi + 1]) : idsN.length;
          if (W.mHi !== lineEnd || idsN[W.mHi] !== W.stubId) return { ok: false, detail: 'stub is not exactly the first measure past the last window line (mHi=' + W.mHi + ', line end=' + lineEnd + ', stubId=' + W.stubId + ')' }; }
        return { ok: true };
      })()` },
  ],
  pageSystemSpliceCourtesyStubChain: [
    { name: 'two consecutive lines beginning key changes: the window ends one measure past the compared line (a stub), the second signature line stays out',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        let startIds = pb['startIds'];
        if (startIds.length < 7) return { ok: false, detail: 'need >= 7 lines, got ' + startIds.length };
        /* The partition is a pure function of content (2026-09-19): two key
           signatures widen two measures, so the section re-breaks and the
           measures they were placed on may no longer START consecutive lines.
           Re-place them on the line starts the NEW partition chose until they
           stay put. Clearing is order-sensitive — sig2 inherits sig1, so it
           goes back to '3s' and must be cleared BEFORE sig1 returns to '0'. */
        let sig1 = -1, sig2 = -1, L1 = -1, L2 = -1;
        for (let attempt = 0; attempt < 6; attempt++) {
          const idsN = m.allMeasures().map((x) => x.getAttribute('xml:id'));
          const c1 = idsN.indexOf(pb['startIds'][4]), c2 = idsN.indexOf(pb['startIds'][5]);
          if (c1 < 0 || c2 < 0) return { ok: false, detail: 'line start not in model' };
          if (sig1 === c1 && sig2 === c2) break;          // already there; the shape is what it is
          if (sig2 >= 0) m.setKeySigAt(sig2, '3s', 'major');
          if (sig1 >= 0) m.setKeySigAt(sig1, '0', 'major');
          m.setKeySigAt(c1, '3s', 'major');
          m.setKeySigAt(c2, '2f', 'major');
          sig1 = c1; sig2 = c2;
          H.reRender();
          await window.__waitForRender();
          for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
          await window.__waitForRender();
          const idsA = m.allMeasures().map((x) => x.getAttribute('xml:id'));
          L1 = pb['startIds'].indexOf(idsA[sig1]); L2 = pb['startIds'].indexOf(idsA[sig2]);
          if (L1 >= 3 && L2 === L1 + 1) break;
        }
        startIds = pb['startIds'];
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        if (L1 < 3 || L2 !== L1 + 1) return { ok: false, detail: 'fixture cannot pose the case: key changes sit on lines ' + L1 + ' and ' + L2 };
        /* The retarget above is SETUP, not the thing under test. */
        H.renderer.renderLedger().length = 0;
        /* Edit one line above the first change: the line between is the compared
           context line, the first signature line generates its courtesy, and the
           second signature line is what the old whole-line rule chained in. */
        const target = L1 - 1;
        const mi = ids.indexOf(startIds[target]);
        m.setCursor(m.getMeasureStartCursor(1, mi + 1), 1);
        const ver = m.docVersion();
        if (!m.deleteAtCursor()) return { ok: false, detail: 'delete rejected' };
        if (m.docVersion() === ver) return { ok: false, detail: 'delete did not change the document' };
        const prevCheck = globalThis.__HKL_INDEX_CHECK;
        globalThis.__HKL_INDEX_CHECK = true;
        try { H.reRender(); } finally { globalThis.__HKL_INDEX_CHECK = prevCheck; }
        await window.__waitForRender();
        if (/diverged/.test(ps.lastSkipReason || '')) return { ok: false, detail: 'context line diverged: ' + ps.lastSkipReason };
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + ')' };
        const W = ps.lastWindow;
        if (!W || !W.stubId) return { ok: false, detail: 'no courtesy stub (stubId=' + (W && W.stubId) + ')' };
        const sp = pb['startIds'], idsN = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const stubLine = sp.indexOf(W.stubId);
        if (stubLine !== W.wHi + 1) return { ok: false, detail: 'stub is not the line right past the window (stub line ' + stubLine + ', wHi ' + W.wHi + ')' };
        if (W.mHi !== idsN.indexOf(W.stubId)) return { ok: false, detail: 'stub is not exactly one measure (mHi=' + W.mHi + ', stub measure=' + idsN.indexOf(W.stubId) + ')' };
        if (W.stubId !== ids[sig1]) return { ok: false, detail: 'fixture did not pose the chain: the stub is ' + W.stubId + ', expected the first signature line ' + ids[sig1] };
        if (idsN.indexOf(ids[sig2]) <= W.mHi) return { ok: false, detail: 'the second signature line leaked into the window' };
        return { ok: true };
      })()` },
  ],
  pageSystemSpliceCourtesyStubAfterEnding: [
    { name: 'an ending starting past the window is swallowed by the ending closure; the courtesy stub is the first measure of the line after it, never an ending member',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        let startIds = pb['startIds'];
        if (startIds.length < 7) return { ok: false, detail: 'need >= 7 lines, got ' + startIds.length };
        /* The partition is a pure function of content (2026-09-19): the two key
           signatures widen their measures and re-break the section, so they may
           no longer START consecutive lines. Settle them onto the line starts
           the NEW partition chose before the ending is built on top. Clearing is
           order-sensitive — sig2 inherits sig1. */
        let sig1 = -1, sig2 = -1;
        for (let attempt = 0; attempt < 6; attempt++) {
          const idsN = m.allMeasures().map((x) => x.getAttribute('xml:id'));
          const c1 = idsN.indexOf(pb['startIds'][4]), c2 = idsN.indexOf(pb['startIds'][5]);
          if (c1 < 0 || c2 < 0 || c1 + 1 >= c2) return { ok: false, detail: 'line starts not usable (' + c1 + ', ' + c2 + ')' };
          if (sig1 === c1 && sig2 === c2) break;
          if (sig2 >= 0) m.setKeySigAt(sig2, '3s', 'major');
          if (sig1 >= 0) m.setKeySigAt(sig1, '0', 'major');
          m.setKeySigAt(c1, '3s', 'major');
          m.setKeySigAt(c2, '2f', 'major');
          sig1 = c1; sig2 = c2;
          H.reRender();
          await window.__waitForRender();
          for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
          await window.__waitForRender();
          const idsA = m.allMeasures().map((x) => x.getAttribute('xml:id'));
          const l1 = pb['startIds'].indexOf(idsA[sig1]), l2 = pb['startIds'].indexOf(idsA[sig2]);
          if (l1 >= 3 && l2 === l1 + 1) break;
        }
        /* A two-measure 1st ending whose FIRST member is the first key-change
           measure: create it on the next measure (it needs a backward repeat),
           then extend backwards. */
        m.allMeasures()[sig1 + 1].setAttribute('right', 'rptend');
        const c = m.toggleEndingAt(sig1 + 1);
        if (!c || c.action !== 'created') return { ok: false, detail: 'toggleEndingAt did not create an ending: ' + JSON.stringify(c) };
        const e = m.toggleEndingAt(sig1);
        if (!e || e.action !== 'extended') return { ok: false, detail: 'toggleEndingAt did not extend the ending backwards: ' + JSON.stringify(e) };
        const meas = m.allMeasures()[sig1];
        const wrap = meas.closest('ending');
        const members = wrap ? Array.from(wrap.children).filter((k) => k.localName === 'measure') : [];
        if (!wrap || members.length !== 2 || members[0] !== meas) return { ok: false, detail: 'fixture cannot pose the case: ending members ' + members.length };
        H.reRender();
        await window.__waitForRender();
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        startIds = pb['startIds'];
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const L1 = startIds.indexOf(ids[sig1]), L2 = startIds.indexOf(ids[sig2]);
        if (L1 < 3 || L2 !== L1 + 1) return { ok: false, detail: 'fixture cannot pose the case: key changes sit on lines ' + L1 + ' and ' + L2 };
        const target = L1 - 1;
        const mi = ids.indexOf(startIds[target]);
        m.setCursor(m.getMeasureStartCursor(1, mi + 1), 1);
        const ver = m.docVersion();
        if (!m.deleteAtCursor()) return { ok: false, detail: 'delete rejected' };
        if (m.docVersion() === ver) return { ok: false, detail: 'delete did not change the document' };
        const prevCheck = globalThis.__HKL_INDEX_CHECK;
        globalThis.__HKL_INDEX_CHECK = true;
        try { H.reRender(); } finally { globalThis.__HKL_INDEX_CHECK = prevCheck; }
        await window.__waitForRender();
        if (/diverged/.test(ps.lastSkipReason || '')) return { ok: false, detail: 'context line diverged: ' + ps.lastSkipReason };
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + ')' };
        const W = ps.lastWindow;
        const sp = pb['startIds'], idsN = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const endingLine = sp.indexOf(ids[sig1]);
        if (!W || W.wHi !== endingLine) return { ok: false, detail: 'the ending line was not swallowed by the ending closure (wHi=' + (W && W.wHi) + ', ending line=' + endingLine + '; window=' + JSON.stringify(W) + ')' };
        if (W.stubId !== ids[sig2]) return { ok: false, detail: 'stub is not the first measure of the line after the ending (stubId=' + W.stubId + ')' };
        if (W.mHi !== idsN.indexOf(ids[sig2])) return { ok: false, detail: 'stub is not exactly one measure (mHi=' + W.mHi + ')' };
        if (m.allMeasures()[W.mHi].closest('ending')) return { ok: false, detail: 'the stub is an ending member' };
        return { ok: true };
      })()` },
  ],
  pageSystemSpliceRelocatedClef: [
    { name: 'deleting the chord ahead of a mid-measure clef at a line start pulls the previous line into the run and splices',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        let startIds = pb['startIds'];
        if (startIds.length < 5) return { ok: false, detail: 'need >= 5 lines, got ' + startIds.length };
        const ids0 = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const mi = ids0.indexOf(startIds[3]);
        if (mi < 0) return { ok: false, detail: 'line start not in model' };
        /* A clef change before the SECOND chord of the line's first measure —
           mid-measure, so it renders inside that measure and the line above is
           untouched. Staff 1's default is G2, so F4 is a change. Cursors are
           located by scanning the voice's flat children (a measure-start cursor
           may be a wrapper stop, so +1 arithmetic lands one element late). */
        const chordsIn = (voice, measEl) => { const flat = m['flatChildren'](voice); const at = [];
          for (let i = 0; i < flat.length; i++) if ((flat[i].localName === 'note' || flat[i].localName === 'chord') && flat[i].closest('measure') === measEl) at.push(i);
          return at; };
        const at0 = chordsIn(1, m.allMeasures()[mi]);
        if (at0.length < 2) return { ok: false, detail: 'need >= 2 chords in the clef measure, got ' + at0.length };
        /* cursor at0[0] is "past the first chord": the clef lands before the second */
        if (!m.setClefAtCursor(1, at0[0], 'F', '4', null, null)) return { ok: false, detail: 'setClefAtCursor refused' };
        const layer = m.allMeasures()[mi].querySelector('staff[n="1"] > layer');
        const clef = layer && layer.querySelector(':scope > clef');
        if (!clef || clef !== layer.children[1]) return { ok: false, detail: 'fixture cannot pose the case: clef is not after the first chord: ' + (layer ? Array.from(layer.children).map((c) => c.localName).join(',') : 'no layer') };
        H.reRender();
        await window.__waitForRender();
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        startIds = pb['startIds'];
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const lineOfMi = startIds.indexOf(ids[mi]);
        if (lineOfMi < 2) return { ok: false, detail: 'clef measure is not a line start >= 2 (line ' + lineOfMi + ') — cannot pose the cross-line case' };
        /* Delete the chord AHEAD of the clef: the clef becomes measure-initial
           and relocateInitialClefs draws it at the end of the previous measure,
           i.e. on the line above. */
        const at1 = chordsIn(1, m.allMeasures()[mi]);
        m.setCursor(at1[0], 1);   /* past the first chord → Backspace removes it */
        const ver = m.docVersion();
        if (!m.deleteAtCursor()) return { ok: false, detail: 'delete rejected' };
        if (m.docVersion() === ver) return { ok: false, detail: 'delete did not change the document' };
        if (layer.firstElementChild !== clef) return { ok: false, detail: 'clef did not become measure-initial after the delete: layer=' + Array.from(layer.children).map((c) => c.localName).join(',') };
        const prevCheck = globalThis.__HKL_INDEX_CHECK;
        globalThis.__HKL_INDEX_CHECK = true;
        try { H.reRender(); } finally { globalThis.__HKL_INDEX_CHECK = prevCheck; }
        await window.__waitForRender();
        if (/diverged/.test(ps.lastSkipReason || '')) {
          return { ok: false, detail: 'context line diverged — the relocated clef re-engraved the line above without it being in the run: ' + ps.lastSkipReason };
        }
        if (ps.lastOutcome !== 'spliced') {
          return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + ')' };
        }
        if (!ps.lastRun || ps.lastRun.a !== lineOfMi - 1) {
          return { ok: false, detail: 'run did not extend to the line above: run=' + JSON.stringify(ps.lastRun) + ' clef line=' + lineOfMi };
        }
        /* And the live page shows the change glyph where a full render puts it:
           at the end of the previous measure, none at the start of this one. */
        const prevEl = document.querySelector('#score #' + CSS.escape(ids[mi - 1]));
        const thisEl = document.querySelector('#score #' + CSS.escape(ids[mi]));
        if (!prevEl || !thisEl) return { ok: false, detail: 'measures not in the DOM' };
        const clefsPrev = prevEl.querySelectorAll('g.clef').length;
        if (clefsPrev < 1) return { ok: false, detail: 'previous measure shows no clef-change glyph after the splice' };
        return { ok: true };
      })()` },
  ],
  pageCrossSystemSlurDelete: [
    { name: 'deleting a cross-system slur removes BOTH segments, by splice',
      expr: `(async () => {
        ${CROSS_SYS_PRELUDE}
        try {
          const a = chordsIn(1, meas[startMi]), b = chordsIn(1, meas[endMi]);
          if (!a.length || !b.length) return { ok: false, detail: 'no chords at the endpoints' };
          m.setCursor(a[a.length - 1], 1);
          key('l', { ctrlKey: true });
          m.setCursor(b[0], 1);
          key('l', { ctrlKey: true });
          await window.__waitForRender();
          if (m.getDoc().querySelectorAll('slur').length !== 1) return { ok: false, detail: 'Ctrl+L did not add one slur (' + m.getDoc().querySelectorAll('slur').length + ')' };
          const before = live('slur');
          if (before !== 2) return { ok: false, detail: 'fixture cannot pose the case: the slur draws ' + before + ' segments, not 2' };
          m.setCursor(a[a.length - 1], 1);
          key('l', { ctrlKey: true });
          await window.__waitForRender();
          if (errs.length) return { ok: false, detail: 'render threw: ' + errs.join(' | ') };
          if (m.getDoc().querySelectorAll('slur').length !== 0) return { ok: false, detail: 'Ctrl+L did not delete the slur' };
          if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + ')' };
          const after = live('slur');
          if (after !== 0) return { ok: false, detail: after + ' stale slur segment(s) still on the page after the delete (run=' + JSON.stringify(ps.lastRun) + ', slur lines 1..2)' };
          return { ok: true };
        } finally { ${CROSS_SYS_CLEANUP} }
      })()` },
  ],
  pageMetronomeFontAfterSplice: [
    { name: 'a metronome mark added by a page splice draws its note glyph in a loaded face',
      expr: `(async () => {
        ${CROSS_SYS_PRELUDE}
        try {
          if ([...m.getDoc().querySelectorAll('tempo rend')].some((e) => e.getAttribute('glyph.auth') === 'smufl')) return { ok: false, detail: 'fixture cannot pose the case: a tempo already draws a metronome glyph' };
          const at = chordsIn(1, meas[endMi]);
          if (!at.length) return { ok: false, detail: 'no chord on line 3' };
          ${CLEAR_ADOPTED_FONT_FACES}
          m.setCursor(at[0], 1);
          ${ADD_METRONOME_VIA_MODAL}
          if (errs.length) return { ok: false, detail: 'render threw: ' + errs.join(' | ') };
          if (![...m.getDoc().querySelectorAll('tempo rend')].some((e) => e.getAttribute('glyph.auth') === 'smufl')) return { ok: false, detail: 'the modal wrote no metronome glyph' };
          if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + ')' };
          ${METRONOME_FONT_CHECK}
          return { ok: true };
        } finally { ${CROSS_SYS_CLEANUP} }
      })()` },
  ],
  scrollMetronomeFontAfterSplice: [
    { name: 'a metronome mark added by a scroll splice draws its note glyph in a loaded face',
      expr: `(async () => {
        const H = window.__hkl_composer, m = H.model, r = H.renderer;
        if (r['viewMode'] !== 'scroll') return { ok: false, detail: 'view=' + r['viewMode'] };
        if ([...m.getDoc().querySelectorAll('tempo rend')].some((e) => e.getAttribute('glyph.auth') === 'smufl')) return { ok: false, detail: 'fixture cannot pose the case: a tempo already draws a metronome glyph' };
        const flat = m['flatChildren'](1);
        const i = flat.findIndex((e, k) => k >= 80 && (e.localName === 'note' || e.localName === 'chord'));
        if (i < 0) return { ok: false, detail: 'no chord past index 80' };
        ${CLEAR_ADOPTED_FONT_FACES}
        m.setCursor(i, 1);
        ${ADD_METRONOME_VIA_MODAL}
        if (![...m.getDoc().querySelectorAll('tempo rend')].some((e) => e.getAttribute('glyph.auth') === 'smufl')) return { ok: false, detail: 'the modal wrote no metronome glyph' };
        const last = r.renderLedger().slice(-1)[0] ?? {};
        if (last.full) return { ok: false, detail: 'expected a scroll splice, got a full render (' + (last.skipReason || last.deriveReason) + ')' };
        ${METRONOME_FONT_CHECK}
        return { ok: true };
      })()` },
  ],
  pageCrossSystemSlurUndoAdd: [
    { name: 'undoing a cross-system slur add removes BOTH segments, by splice',
      expr: `(async () => {
        ${CROSS_SYS_PRELUDE}
        try {
          const a = chordsIn(1, meas[startMi]), b = chordsIn(1, meas[endMi]);
          if (!a.length || !b.length) return { ok: false, detail: 'no chords at the endpoints' };
          m.setCursor(a[a.length - 1], 1);
          key('l', { ctrlKey: true });
          m.setCursor(b[0], 1);
          key('l', { ctrlKey: true });
          await window.__waitForRender();
          const before = live('slur');
          if (before !== 2) return { ok: false, detail: 'fixture cannot pose the case: the slur draws ' + before + ' segments, not 2' };
          key('z', { ctrlKey: true });
          await window.__waitForRender();
          if (errs.length) return { ok: false, detail: 'render threw: ' + errs.join(' | ') };
          if (m.getDoc().querySelectorAll('slur').length !== 0) return { ok: false, detail: 'Ctrl+Z did not undo the slur add' };
          if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + ')' };
          const after = live('slur');
          if (after !== 0) return { ok: false, detail: after + ' stale slur segment(s) still on the page after the undo (run=' + JSON.stringify(ps.lastRun) + ')' };
          return { ok: true };
        } finally { ${CROSS_SYS_CLEANUP} }
      })()` },
  ],
  pageCrossSystemHairpinDelete: [
    { name: 'deleting a cross-system hairpin removes BOTH segments, by splice',
      expr: `(async () => {
        ${CROSS_SYS_PRELUDE}
        try {
          const doc = m.getDoc();
          const hp = doc.createElementNS('http://www.music-encoding.org/ns/mei', 'hairpin');
          hp.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:id', 'hfx-cross');
          hp.setAttribute('tstamp', '3');
          hp.setAttribute('tstamp2', '1m+2');
          hp.setAttribute('form', 'cres');
          hp.setAttribute('place', 'below');
          hp.setAttribute('staff', '1');
          meas[startMi].appendChild(hp);
          H.reRender();
          await window.__waitForRender();
          const before = live('hairpin');
          if (before !== 2) return { ok: false, detail: 'fixture cannot pose the case: the hairpin draws ' + before + ' segments, not 2' };
          hp.remove();
          H.reRender();
          await window.__waitForRender();
          if (errs.length) return { ok: false, detail: 'render threw: ' + errs.join(' | ') };
          if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + ')' };
          const after = live('hairpin');
          if (after !== 0) return { ok: false, detail: after + ' stale hairpin segment(s) still on the page after the delete (run=' + JSON.stringify(ps.lastRun) + ')' };
          return { ok: true };
        } finally { ${CROSS_SYS_CLEANUP} }
      })()` },
  ],
  rangeSerializeLeadingClefHead: [
    { name: 'a range starting at a measure with a leading clef folds that clef into its head scoreDef',
      expr: `(() => {
        const H = window.__hkl_composer;
        const m = H.model;
        const mi = 8;
        if (m.allMeasures().length <= mi + 2) return { ok: false, detail: 'need > ' + (mi + 2) + ' measures' };
        /* Cursor c is "past flat[c]": the clef lands after measure mi's first
           chord; deleting that chord makes it measure-initial — the importer's
           form, which the range serializer must drop-and-fold. */
        const flat = m['flatChildren'](1);
        const measEl = m.allMeasures()[mi];
        const first = flat.findIndex((el) => (el.localName === 'note' || el.localName === 'chord') && el.closest('measure') === measEl);
        if (first < 0) return { ok: false, detail: 'no chord in measure ' + mi };
        if (!m.setClefAtCursor(1, first, 'F', '4', null, null)) return { ok: false, detail: 'setClefAtCursor refused' };
        m.setCursor(first, 1);
        if (!m.deleteAtCursor()) return { ok: false, detail: 'delete rejected' };
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const layer = m.allMeasures()[mi].querySelector('staff[n="1"] > layer');
        if (!layer || !layer.firstElementChild || layer.firstElementChild.localName !== 'clef') return { ok: false, detail: 'fixture cannot pose the case: no leading clef: ' + (layer ? Array.from(layer.children).map((c) => c.localName).join(',') : 'no layer') };
        const parse = (lo, hi) => new DOMParser().parseFromString(m.serializeRangeForRender(lo, hi, { hejiEnabled: false }, null), 'application/xml');
        const headClef = (doc) => { const sd = doc.querySelector('scoreDef staffDef[n="1"]'); return sd ? (sd.getAttribute('clef.shape') || '?') + (sd.getAttribute('clef.line') || '') : null; };
        /* Range opening AT the clef measure: head must say F4, and the clef
           element itself is gone (it belongs to the out-of-range predecessor). */
        const atDoc = parse(mi, mi + 1);
        const atFirst = atDoc.querySelector('measure');
        if (!atFirst || atFirst.getAttribute('xml:id') !== ids[mi]) return { ok: false, detail: 'range does not start at the clef measure' };
        if (headClef(atDoc) !== 'F4') return { ok: false, detail: 'range head clef is ' + headClef(atDoc) + ', expected F4 (the dropped leading clef)' };
        if (atFirst.querySelector('layer > clef')) return { ok: false, detail: 'leading clef was not dropped from the range first measure' };
        /* Range opening one measure EARLIER: head keeps G2 and the clef is
           relocated to the end of the predecessor, exactly like the full render. */
        const beforeDoc = parse(mi - 1, mi + 1);
        if (headClef(beforeDoc) !== 'G2') return { ok: false, detail: 'range head clef is ' + headClef(beforeDoc) + ', expected G2 (clef change is inside the range)' };
        const prevLayer = beforeDoc.querySelector('measure staff[n="1"] > layer');
        if (!prevLayer || !prevLayer.lastElementChild || prevLayer.lastElementChild.localName !== 'clef') return { ok: false, detail: 'clef was not relocated to the end of the predecessor measure' };
        const full = new DOMParser().parseFromString(m.serialize({ hejiEnabled: false }, null), 'application/xml');
        const fullPrev = Array.from(full.querySelectorAll('measure')).find((x) => x.getAttribute('xml:id') === ids[mi - 1]);
        const fl = fullPrev && fullPrev.querySelector('staff[n="1"] > layer');
        if (!fl || !fl.lastElementChild || fl.lastElementChild.localName !== 'clef') return { ok: false, detail: 'full serialize did not relocate the clef (baseline assumption broken)' };
        return { ok: true };
      })()` },
  ],
  pageSystemSpliceEnsureMount: [
    { name: 'an edit whose context line sits on an UNMOUNTED page splices without drawing it (B5 mount superseded by the band clip)',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        /* Read pageVirt AFTER those renders: a full render REPLACES the object,
           and un-mounting a stale copy leaves the renderer's mounted set
           disagreeing with the DOM — an inconsistency the splicer cannot see. */
        /* The runtime mount window would re-mount page 2 on an idle callback
           and make this test race, so pin the window off. */
        H.renderer.setMountWindowEnabled(false);
        const st = H.renderer['pageVirt'];
        if (!st || st.pageCount < 2) return { ok: false, detail: 'need >= 2 pages, got ' + (st ? st.pageCount : 0) };
        const startIds = pb['startIds'];
        const at = new Map(startIds.map((id, i) => [id, i]));
        const pageStartLines = pb.pageStarts().map((id) => at.get(id)).filter((x) => x != null).sort((x, y) => x - y);
        if (pageStartLines.length < 2) return { ok: false, detail: 'no second page start' };
        /* Edit the LAST line of page 1: its context-below is page 2's first
           line. Until 2026-09-02 the splice mounted page 2 to compare that line
           (B5). Since the replaced set is clipped to the mounted band, a
           context line outside the band is simply not compared — page 2 holds
           no hunk line, so the edit needs nothing from it — and the splice
           lands without drawing a page the user is not looking at. */
        const target = pageStartLines[1] - 1;
        if (target < 1) return { ok: false, detail: 'page 1 has too few lines' };
        /* Park page 2 (its shell and systems detached, a sized placeholder left). */
        const p2 = document.querySelector('#score .score-page[data-page="2"]');
        if (!p2) return { ok: false, detail: 'no page 2 element' };
        st.unmount(2);
        if (!p2.classList.contains('score-page-pending')) return { ok: false, detail: 'could not un-mount page 2' };
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const mi = ids.indexOf(startIds[target]) + 1;
        m.setCursor(m.getMeasureStartCursor(1, mi), 1);
        if (!m.deleteAtCursor()) return { ok: false, detail: 'delete rejected' };
        H.reRender();   /* HKL_INDEX_CHECK verifies the result against a full re-engrave */
        if (/not mounted/.test(ps.lastSkipReason || '')) {
          return { ok: false, detail: 'refused on a mount miss instead of mounting: ' + ps.lastSkipReason };
        }
        if (ps.lastOutcome !== 'spliced') {
          return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + ')' };
        }
        /* Page 2 must NOT have been drawn: that is the win. */
        if (H.renderer['pageVirt'].mounted.has(2)) {
          return { ok: false, detail: 'page 2 was mounted — the splice still pays for a page off screen' };
        }
        const still = document.querySelector('#score .score-page[data-page="2"]');
        if (!still.classList.contains('score-page-pending')) {
          return { ok: false, detail: 'page 2 is drawn in the DOM although the renderer does not list it as mounted' };
        }
        /* It carries no hunk line, so nothing about it was deferred either. */
        if ((ps.lastDeferredPages || []).includes(2)) {
          return { ok: false, detail: 'page 2 was deferred, but it holds no line of the hunk' };
        }
        /* And it still draws correctly when it does mount. */
        const warns = [];
        const ow = console.warn;
        console.warn = (...a) => { const t = a.join(' '); if (!/^\[Warning\]/.test(t)) warns.push(t); };
        try { st.mount(2); } finally { console.warn = ow; }
        if (warns.length) return { ok: false, detail: 'warnings when page 2 mounted: ' + warns.join(' | ') };
        const now = document.querySelector('#score .score-page[data-page="2"]');
        if (now.classList.contains('score-page-pending') || !now.querySelector('g.system')) {
          return { ok: false, detail: 'page 2 did not draw on mount' };
        }
        const first = now.querySelector('g.system g.measure');
        if (!first || first.id !== pb.pageStarts()[1]) {
          return { ok: false, detail: 'mounted page 2 starts at ' + (first && first.id) + ', pins say ' + pb.pageStarts()[1] };
        }
        return { ok: true };
      })()` },
  ],
  pageSystemSpliceCascadeOverflow: [
    { name: 'a cascade that overflows its page moves the spilled system onto the next page as a splice (B2), never handing pagination back',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        if (!pb.paginationOwned()) return { ok: false, detail: 'pagination not owned (pages=' + pb.pageStarts().length + ')' };
        const st0 = H.renderer['pageVirt'];
        const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
        const overflowing = () => {
          const bad = [];
          for (const pageEl of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
            const svg = pageEl.querySelector('svg');
            const systems = [...pageEl.querySelectorAll('g.system')];
            if (!svg || !systems.length) continue;
            if (systems[systems.length - 1].getBoundingClientRect().bottom > svg.getBoundingClientRect().bottom + 2) {
              bad.push(pageEl.dataset.page);
            }
          }
          return bad;
        };
        if (overflowing().length) return { ok: false, detail: 'page already overflowing before the edit' };
        const sysCount = (p) => document.querySelectorAll('#score .score-page[data-page="' + p + '"] g.system').length;
        const p1sys = [...document.querySelectorAll('#score .score-page[data-page="1"] g.system')];
        const n1 = p1sys.length;
        if (n1 < 3) return { ok: false, detail: 'page 1 has only ' + n1 + ' systems' };
        const tailId = p1sys[n1 - 1].querySelector('g.measure').id;   // page 1's last line, pre-edit
        const tailEl = p1sys[n1 - 1];                                     // its element: a transplant keeps it
        const p2start0 = pb.pageStarts()[1];
        /* Grow successive early systems by a c0..g7 span (deep ledger lines both
           ways). Each consumes a chunk of page 1's bottom slack; the loop runs
           until the slack is exhausted, so it does not depend on knowing how
           much slack Verovio happened to leave. Any warn is a failure here — a
           spill used to be handed back to Verovio with one, and now it is not. */
        const warns = [];
        const ow = console.warn;
        /* Verovio's own "[Warning]" lines (justification compression on a
           legal, dense line) are not evidence here; ours are. */
        console.warn = (...a) => { const t = a.join(' '); if (!/^\\[Warning\\]/.test(t)) warns.push(t); };
        let moved = false, steps = 0;
        try {
          for (let line = 1; line <= 6 && !moved; line++) {
            const startId = pb['startIds'][line];
            if (!startId) break;
            const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
            const target = m.allMeasures()[ids.indexOf(startId)];
            if (!target) break;
            const flat = m['flatChildren'](1);
            let cur = -1;
            for (let i = 0; i < flat.length; i++) {
              const el = flat[i];
              if ((el.localName === 'note' || el.localName === 'chord') && el.closest('measure') === target) { cur = i; break; }
            }
            if (cur < 0) break;
            m.setCursor(cur, 1);
            if (m.replaceChordAtCursor({ notes: [mk('c', 0), mk('g', 7)], duration: '4', dots: 0 }) === null) break;
            H.reRender();
            await window.__waitForRender();
            steps++;
            if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'step ' + steps + ': expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + '; derive=' + pb.lastDeriveReason + ')' };
            if (H.renderer['pageVirt'] !== st0) return { ok: false, detail: 'page DOM was rebuilt at step ' + steps + ' — a full render, not a splice' };
            const over = overflowing();
            if (over.length) return { ok: false, detail: 'page ' + over.join(',') + ' drawn past the paper after step ' + steps };
            moved = sysCount(1) < n1;
          }
        } finally { console.warn = ow; }
        if (warns.length) return { ok: false, detail: 'warnings: ' + warns.join(' | ') };
        if (!steps) return { ok: false, detail: 'no growth step ran' };
        if (!moved) return { ok: false, detail: 'never exhausted page 1\\'s slack in ' + steps + ' steps' };
        if (sysCount(1) !== n1 - 1) return { ok: false, detail: 'page 1 lost ' + (n1 - sysCount(1)) + ' systems, expected 1' };
        const p2first = document.querySelector('#score .score-page[data-page="2"] g.system g.measure');
        if (!p2first || p2first.id !== tailId) return { ok: false, detail: 'page 2 starts at ' + (p2first && p2first.id) + ', expected the moved line ' + tailId };
        if (pb.pageStarts()[1] !== tailId) return { ok: false, detail: 'pins say page 2 starts at ' + pb.pageStarts()[1] + ', DOM says ' + tailId };
        if (p2start0 === tailId) return { ok: false, detail: 'page 2 start did not change' };
        /* Phase 2: the step is a DOM TRANSPLANT — the very element that was
           page 1's tail now heads page 2 (nothing re-rendered), and no step parked. */
        if (p2first.closest('g.system') !== tailEl) return { ok: false, detail: 'page 2\\'s first system is not the transplanted element (a re-render, not a transplant)' };
        const c = H.renderer.lastCascade;
        if (!c || c.transplanted < 1) return { ok: false, detail: 'lastCascade shows no transplant: ' + JSON.stringify(c) };
        if (c.parked) return { ok: false, detail: 'a cascade step parked with every page mounted: ' + JSON.stringify(c) };
        const verified = pb.verifyRenderedPartition(H.renderer['container'], m, st0.pageCount, H.renderer['pageBreaksCtx']());
        if (!verified) return { ok: false, detail: 'rendered partition diverged from the pins after the move' };
        return { ok: true };
      })()` },
  ],
  pageSystemSpliceNoopSkip: [
    { name: 'a signature-identical render request leaves the page DOM untouched (no-op skip)',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        const sys = document.querySelector('#score .score-page g.system');
        if (!sys) return { ok: false, detail: 'no rendered system' };
        sys.setAttribute('data-hkl-test-marker', 'noop');
        H.reRender();   /* no model change */
        if (ps.lastOutcome !== 'noop') return { ok: false, detail: 'expected a no-op skip, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + ')' };
        const still = document.querySelector('[data-hkl-test-marker="noop"]');
        if (!still) return { ok: false, detail: 'no-op render rebuilt the page DOM' };
        still.removeAttribute('data-hkl-test-marker');
        return { ok: true };
      })()` },
  ],
  /* B2 (2026-09-02): line-count changes and pagination changes are splices. */
  pageSpliceNewLineAtEnd: [
    { name: 'composing past the last line opens a new final line as a splice (N → N+1 systems), never a full render',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        const st0 = H.renderer['pageVirt'];
        const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
        const overflowing = () => [...document.querySelectorAll('#score .score-page:not(.score-page-pending)')].filter((pg) => {
          const svg = pg.querySelector('svg'); const s = [...pg.querySelectorAll('g.system')];
          return svg && s.length && s[s.length - 1].getBoundingClientRect().bottom > svg.getBoundingClientRect().bottom + 2;
        }).map((pg) => pg.dataset.page);
        const lines0 = pb.lineStarts().length;
        let grew = false, steps = 0;
        for (; steps < 16 && !grew; steps++) {
          m.setCursor(m['flatChildren'](1).length, 1);
          if (!m.insertChordAtCursor({ notes: [mk('b', 4)], duration: '4', dots: 0 })) return { ok: false, detail: 'append rejected at step ' + steps };
          H.reRender();
          await window.__waitForRender();
          if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'step ' + steps + ': expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + '; derive=' + pb.lastDeriveReason + ')' };
          if (H.renderer['pageVirt'] !== st0) return { ok: false, detail: 'page DOM was rebuilt at step ' + steps + ' — a full render, not a splice' };
          grew = pb.lineStarts().length === lines0 + 1;
        }
        if (!grew) return { ok: false, detail: steps + ' appended quarters never opened a new line' };
        if (!ps.lastHunk || ps.lastHunk.bNew - ps.lastHunk.bOld !== 1) return { ok: false, detail: 'hunk did not grow by one line: ' + JSON.stringify(ps.lastHunk) };
        const lastId = pb.lineStarts()[pb.lineStarts().length - 1];
        const el = document.querySelector('#score .score-page g.measure#' + CSS.escape(lastId));
        if (!el || el.closest('g.system').querySelector('g.measure') !== el) return { ok: false, detail: 'the new last line is not a rendered system start' };
        const over = overflowing();
        if (over.length) return { ok: false, detail: 'page ' + over.join(',') + ' drawn past the paper' };
        return { ok: true };
      })()` },
  ],
  pageSpliceNewPageAtEnd: [
    { name: 'composing past a full last page creates a new page as a splice (cascade onto a created page), never a full render',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        const st0 = H.renderer['pageVirt'];
        if (!st0 || !pb.paginationOwned()) return { ok: false, detail: 'pagination not owned (pages=' + pb.pageStarts().length + ')' };
        const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
        const overflowing = () => [...document.querySelectorAll('#score .score-page:not(.score-page-pending)')].filter((pg) => {
          const svg = pg.querySelector('svg'); const s = [...pg.querySelectorAll('g.system')];
          return svg && s.length && s[s.length - 1].getBoundingClientRect().bottom > svg.getBoundingClientRect().bottom + 2;
        }).map((pg) => pg.dataset.page);
        const warns = [];
        const ow = console.warn;
        console.warn = (...a) => { const t = a.join(' '); if (!/^\\[Warning\\]/.test(t)) warns.push(t); };
        const pages0 = pb.pageStarts().length;
        let created = false, steps = 0;
        try {
          /* One measure (four quarters) per render step: whole notes would sit
             at the top of the legal fill range and trip Verovio's compression
             warning, which the suite treats as an error. */
          for (; steps < 80 && !created; steps++) {
            for (let q = 0; q < 4; q++) {
              m.setCursor(m['flatChildren'](1).length, 1);
              if (!m.insertChordAtCursor({ notes: [mk(q % 2 ? 'g' : 'b', q % 2 ? 6 : 4)], duration: '4', dots: 0 })) return { ok: false, detail: 'append rejected at step ' + steps };
            }
            H.reRender();
            await window.__waitForRender();
            if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'step ' + steps + ': expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + '; derive=' + pb.lastDeriveReason + ')' };
            if (H.renderer['pageVirt'] !== st0) return { ok: false, detail: 'page DOM was rebuilt at step ' + steps + ' — a full render, not a splice' };
            const over = overflowing();
            if (over.length) return { ok: false, detail: 'page ' + over.join(',') + ' drawn past the paper after step ' + steps };
            created = pb.pageStarts().length === pages0 + 1;
          }
        } finally { console.warn = ow; }
        if (warns.length) return { ok: false, detail: 'warnings during the cascade: ' + warns.join(' | ') };
        if (!created) return { ok: false, detail: steps + ' appended whole notes never opened a new page' };
        if (st0.pageCount !== pages0 + 1) return { ok: false, detail: 'pageVirt.pageCount ' + st0.pageCount + ' vs ' + (pages0 + 1) };
        const divs = [...document.querySelectorAll('#score .score-page')];
        if (divs.length !== pages0 + 1) return { ok: false, detail: divs.length + ' page elements for ' + (pages0 + 1) + ' pages' };
        const last = divs[divs.length - 1];
        if (Number(last.dataset.page) !== pages0 + 1 || last.classList.contains('score-page-pending')) return { ok: false, detail: 'the new page is not mounted as page ' + (pages0 + 1) };
        const first = last.querySelector('g.system g.measure');
        if (!first || first.id !== pb.pageStarts()[pages0]) return { ok: false, detail: 'new page starts at ' + (first && first.id) + ', pins say ' + pb.pageStarts()[pages0] };
        if (!last.querySelector('svg defs')) return { ok: false, detail: 'created page has no <defs>' };
        /* Phase 2: the page is the spilling page's own shell with the block
           transplanted in — its page-number header reads the new number. */
        const c = H.renderer.lastCascade;
        if (!c || c.created < 1) return { ok: false, detail: 'lastCascade shows no created page: ' + JSON.stringify(c) };
        if (c.parked) return { ok: false, detail: 'a cascade step parked: ' + JSON.stringify(c) };
        const hd = last.querySelector('g.pgHead');
        if (!hd) return { ok: false, detail: 'created page carries no page header' };
        if (!(hd.textContent || '').includes(String(pages0 + 1))) return { ok: false, detail: 'created page header reads "' + (hd.textContent || '').trim() + '", expected page number ' + (pages0 + 1) };
        const verified = pb.verifyRenderedPartition(H.renderer['container'], m, st0.pageCount, H.renderer['pageBreaksCtx']());
        if (!verified) return { ok: false, detail: 'rendered partition diverged from the pins after the page was created' };
        return { ok: true };
      })()` },
  ],
  pageGrowFromOnePage: [
    { name: 'composing into an empty score grows a second page through the cascade, and the live result equals a full render of the same document',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const rd = H.renderer;
        const pb = rd['pageBreaks'];
        const pageEls = () => [...document.querySelectorAll('#score .score-page')];
        const overflowing = () => [...document.querySelectorAll('#score .score-page:not(.score-page-pending)')].filter((pg) => {
          const svg = pg.querySelector('svg'); const s = [...pg.querySelectorAll('g.system')];
          return svg && s.length && s[s.length - 1].getBoundingClientRect().bottom > svg.getBoundingClientRect().bottom + 2;
        }).map((pg) => pg.dataset.page);
        /* Per-page shape: the page number header a created page must carry, and
           how many systems landed on it. Compared live-vs-derived below. */
        const shape = () => pageEls().map((pg) => {
          const hd = pg.querySelector('g.pgHead');
          return { p: pg.dataset.page, head: hd ? (hd.textContent || '').trim() : null, sys: pg.querySelectorAll('g.system').length };
        });
        const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
        if (pageEls().length !== 1) return { ok: false, detail: 'expected a one-page blank document, got ' + pageEls().length };
        let grewAt = -1, created = 0;
        for (let step = 0; step < 80 && grewAt < 0; step++) {
          const high = (step % 4) < 2;
          for (let q = 0; q < 4; q++) {
            m.setCursor(m['flatChildren'](1).length, 1);
            if (!m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 })) return { ok: false, detail: 'append rejected at step ' + step };
          }
          H.reRender();
          await window.__waitForRender();
          const over = overflowing();
          if (over.length) return { ok: false, detail: 'step ' + step + ': page ' + over.join(',') + ' drawn past its paper (pageStarts=' + pb.pageStarts().length + ', repairable=' + pb.paginationRepairable() + ')' };
          if (rd['lastCascade']) created += rd['lastCascade'].created;
          if (pageEls().length > 1) grewAt = step;
        }
        if (grewAt < 0) return { ok: false, detail: '80 appended measures never produced a second page (systems=' + document.querySelectorAll('#score g.system').length + ')' };
        if (created < 1) return { ok: false, detail: 'page 2 appeared without a cascade creation (lastCascade=' + JSON.stringify(rd['lastCascade']) + ') — a full render, not the repair' };
        /* A created page is never a header page, but it must still carry the
           running page-number header a derived page has: cloning page 1's shell
           (whose pgHead is the TITLE block) used to drop the header entirely. */
        const headless = shape().filter((h) => h.p !== '1' && !h.head);
        if (headless.length) return { ok: false, detail: 'created page(s) ' + headless.map((h) => h.p).join(',') + ' carry no page header' };
        /* The contract: populating content live must equal importing it. */
        const liveShape = JSON.stringify(shape());
        const liveStarts = JSON.stringify(pb.pageStarts());
        rd.forceFullRerender();
        H.reRender();
        await window.__waitForRender();
        const fullStarts = JSON.stringify(pb.pageStarts());
        if (liveStarts !== fullStarts) return { ok: false, detail: 'live page starts ' + liveStarts + ' != full render ' + fullStarts };
        const fullShape = JSON.stringify(shape());
        if (liveShape !== fullShape) return { ok: false, detail: 'live page shape ' + liveShape + ' != full render ' + fullShape };
        const overFull = overflowing();
        if (overFull.length) return { ok: false, detail: 'full render itself overflows page ' + overFull.join(',') };
        return { ok: true };
      })()` },
  ],
  pageUserBreakSurvivesEdit: [
    { name: 'a user page break survives the next edit (the refill must repaint encoded, which honors <pb>)',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pages = () => document.querySelectorAll('#score .score-page').length;
        const pbCount = () => m.getDoc().querySelectorAll('pb').length;
        if (pbCount() !== 1) return { ok: false, detail: 'setup left ' + pbCount() + ' user <pb> in the model, expected 1' };
        if (pages() !== 2) return { ok: false, detail: 'expected 2 pages after the page break, got ' + pages() };
        m.setCursor(m['flatChildren'](1).length, 1);
        if (!m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'b', accid: '', oct: 4, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 }], duration: '4', dots: 0 })) return { ok: false, detail: 'append rejected' };
        H.reRender();
        await window.__waitForRender();
        if (pbCount() !== 1) return { ok: false, detail: 'the edit removed the user <pb> from the MODEL (a different bug from the render losing it)' };
        if (pages() !== 2) return { ok: false, detail: 'the user page break was lost on the next edit: ' + pages() + ' page(s) rendered while the <pb> is still in the model — the refill repainted with breaks:line, which ignores <pb>' };
        return { ok: true };
      })()` },
    { name: 'the owner adopts a page start for a user page break even when the natural castoff is a single line',
      expr: `(() => {
        const H = window.__hkl_composer;
        const pb = H.renderer['pageBreaks'];
        /* castoffSegmentedByUserBreaks used to bail on \`baked.lines.length <= 1\`,
           tested on the RAW castoff — above the merge that folds the user's break
           measures into the line set. Two measures are one natural line, so this
           document could never have its page break adopted: the owner kept ONE
           page start while the paint (encoded, which honors <pb>) gave two pages,
           and the cascade then had a page it did not track. */
        const ps = pb.pageStarts().length;
        const pages = document.querySelectorAll('#score .score-page').length;
        if (ps !== pages) return { ok: false, detail: 'owner holds ' + ps + ' page start(s) for a ' + pages + '-page render — the user page break was not adopted' };
        if (!pb.paginationOwned()) return { ok: false, detail: 'pagination not owned despite a user page break (pageStarts=' + ps + ')' };
        return { ok: true };
      })()` },
  ],
  pageSpliceLineMerge: [
    { name: 'deleting every measure of a line removes that system as a splice (N → N−1 systems), never a full render',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        const st0 = H.renderer['pageVirt'];
        const lines0 = pb.lineStarts();
        if (lines0.length < 4) return { ok: false, detail: 'need >= 4 lines, got ' + lines0.length };
        const ids = () => m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const k = 1;
        const startId = lines0[k], endId = lines0[k + 1];
        const all0 = ids();
        const doomed = all0.slice(all0.indexOf(startId), all0.indexOf(endId));
        if (!doomed.length) return { ok: false, detail: 'line ' + k + ' has no measures' };
        const deleteMeasure = (id) => {
          for (let guard = 0; guard < 64; guard++) {
            const cur = ids(); const mi = cur.indexOf(id);
            if (mi < 0) return true;
            m.setCursor(m.getMeasureStartCursor(1, mi), 1);
            if (!m.deleteAtCursor()) return false;
          }
          return false;
        };
        for (const id of doomed.slice().reverse()) {
          if (!deleteMeasure(id)) return { ok: false, detail: 'could not delete measure ' + id };
        }
        H.reRender();
        await window.__waitForRender();
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + '; derive=' + pb.lastDeriveReason + ')' };
        if (H.renderer['pageVirt'] !== st0) return { ok: false, detail: 'page DOM was rebuilt — a full render, not a splice' };
        const lines1 = pb.lineStarts();
        if (lines1.length !== lines0.length - 1) return { ok: false, detail: 'line count ' + lines0.length + ' → ' + lines1.length + ' (expected −1)' };
        if (lines1.includes(startId)) return { ok: false, detail: 'the deleted line still starts a line' };
        if (!lines1.includes(endId)) return { ok: false, detail: 'the line after the deleted one lost its start' };
        if (!ps.lastHunk || ps.lastHunk.bOld - ps.lastHunk.bNew !== 1) return { ok: false, detail: 'hunk did not shrink by one line: ' + JSON.stringify(ps.lastHunk) };
        for (const id of doomed) {
          if (document.querySelector('#score g.measure#' + CSS.escape(id))) return { ok: false, detail: 'deleted measure ' + id + ' is still rendered' };
        }
        const verified = pb.verifyRenderedPartition(H.renderer['container'], m, st0.pageCount, H.renderer['pageBreaksCtx']());
        if (!verified) return { ok: false, detail: 'rendered partition diverged from the pins after the merge' };
        return { ok: true };
      })()` },
  ],
  pageSplicePageCollapse: [
    { name: 'deleting every measure of a page removes the page as a splice (renumbered, pins consistent), never a full render',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        H.renderer.setMountWindowEnabled(false);
        for (const page of document.querySelectorAll('#score .score-page.score-page-pending')) H.renderer['mountPage'](+page.dataset.page);
        const st0 = H.renderer['pageVirt'];
        const pages0 = pb.pageStarts();
        if (pages0.length < 3) return { ok: false, detail: 'need >= 3 pages, got ' + pages0.length };
        const lines0 = pb.lineStarts();
        const ids = () => m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const all0 = ids();
        /* Page 2's measures: from its start to page 3's start. */
        const doomed = all0.slice(all0.indexOf(pages0[1]), all0.indexOf(pages0[2]));
        if (doomed.length < 2) return { ok: false, detail: 'page 2 has ' + doomed.length + ' measures' };
        const p3start = pages0[2];
        const deleteMeasure = (id) => {
          for (let guard = 0; guard < 64; guard++) {
            const cur = ids(); const mi = cur.indexOf(id);
            if (mi < 0) return true;
            m.setCursor(m.getMeasureStartCursor(1, mi), 1);
            if (!m.deleteAtCursor()) return false;
          }
          return false;
        };
        for (const id of doomed.slice().reverse()) {
          if (!deleteMeasure(id)) return { ok: false, detail: 'could not delete measure ' + id };
        }
        const warns = [];
        const ow = console.warn;
        console.warn = (...a) => { const t = a.join(' '); if (!/^\\[Warning\\]/.test(t)) warns.push(t); };
        try { H.reRender(); } finally { console.warn = ow; }
        if (warns.length) return { ok: false, detail: 'warnings: ' + warns.join(' | ') };
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + '; derive=' + pb.lastDeriveReason + ')' };
        if (H.renderer['pageVirt'] !== st0) return { ok: false, detail: 'page DOM was rebuilt — a full render, not a splice' };
        const pages1 = pb.pageStarts();
        if (pages1.length !== pages0.length - 1) return { ok: false, detail: 'page count ' + pages0.length + ' → ' + pages1.length + ' (expected −1)' };
        if (pages1[1] !== p3start) return { ok: false, detail: 'page 2 now starts at ' + pages1[1] + ', expected old page 3 start ' + p3start };
        if (st0.pageCount !== pages1.length) return { ok: false, detail: 'pageVirt.pageCount ' + st0.pageCount + ' vs ' + pages1.length };
        const divs = [...document.querySelectorAll('#score .score-page')];
        if (divs.length !== pages1.length) return { ok: false, detail: divs.length + ' page elements for ' + pages1.length + ' pages' };
        for (let i = 0; i < divs.length; i++) {
          if (Number(divs[i].dataset.page) !== i + 1) return { ok: false, detail: 'page numbering not contiguous at index ' + i + ' (data-page=' + divs[i].dataset.page + ')' };
        }
        const p2 = divs[1].querySelector('g.system g.measure');
        if (!p2 || p2.id !== p3start) return { ok: false, detail: 'DOM page 2 starts at ' + (p2 && p2.id) + ', expected ' + p3start };
        for (const id of doomed) {
          if (document.querySelector('#score g.measure#' + CSS.escape(id))) return { ok: false, detail: 'deleted measure ' + id + ' is still rendered' };
        }
        if (lines0.length - pb.lineStarts().length < 1) return { ok: false, detail: 'no line vanished with the page' };
        const verified = pb.verifyRenderedPartition(H.renderer['container'], m, st0.pageCount, H.renderer['pageBreaksCtx']());
        if (!verified) return { ok: false, detail: 'rendered partition diverged from the pins after the collapse' };
        return { ok: true };
      })()` },
  ],
  pageSectionHeaderOverflow: [
    { name: 'headers added to a full page keep the page box fixed and push the spilled tail onto the next page (title travels)',
      expr: `(() => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        H.renderer.setMountWindowEnabled(false);
        const mountAll = () => { for (const page of document.querySelectorAll('#score .score-page.score-page-pending')) H.renderer['mountPage'](+page.dataset.page); };
        mountAll();
        const pages0 = pb.pageStarts();
        if (pages0.length < 3) return { ok: false, detail: 'need >= 3 pages, got ' + pages0.length };
        const lines = pb.lineStarts();
        const at = new Map(lines.map((id, i) => [id, i]));
        const p2first = at.get(pages0[1]), p3first = at.get(pages0[2]);
        if (p2first == null || p3first == null || p3first - p2first < 2) return { ok: false, detail: 'page 2 needs >= 2 lines' };
        const p2last = p3first - 1;
        const ids = () => m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const miFirst = ids().indexOf(lines[p2first]), miLast = ids().indexOf(lines[p2last]);
        const tailId = lines[p2last];
        const pageEl = (p) => document.querySelector('#score .score-page[data-page="' + p + '"]');
        const box = (p) => { const el = pageEl(p); const svg = el.querySelector('svg'); return { h: svg.getAttribute('height'), vb: el.querySelector('svg.definition-scale').getAttribute('viewBox'), divH: Math.round(el.getBoundingClientRect().height) }; };
        const overflowing = () => [...document.querySelectorAll('#score .score-page:not(.score-page-pending)')].filter((pg) => {
          const svg = pg.querySelector('svg'); const s = [...pg.querySelectorAll('g.system')];
          return svg && s.length && s[s.length - 1].getBoundingClientRect().bottom > svg.getBoundingClientRect().bottom + 2;
        }).map((pg) => pg.dataset.page);
        if (overflowing().length) return { ok: false, detail: 'overflowing before the edit: ' + overflowing() };
        const ref = box(1), before2 = box(2);
        if (before2.h !== ref.h || before2.vb !== ref.vb) return { ok: false, detail: 'pages 1 and 2 differ before the edit: ' + JSON.stringify([ref, before2]) };
        const pxPerUnit = parseFloat(ref.h) / Number(ref.vb.split(/\\s+/)[3]);
        const slackPx = (() => { const svg = pageEl(2).querySelector('svg'); const s = [...pageEl(2).querySelectorAll('g.system')]; return svg.getBoundingClientRect().bottom - s[s.length - 1].getBoundingClientRect().bottom; })();
        /* Headers on page 2's FIRST and LAST lines: the tail is shifted by two reserves. */
        m.setSectionHeaderAt(miFirst, 'II');
        m.setSectionHeaderAt(miLast, 'III');
        const warns = [];
        const ow = console.warn;
        console.warn = (...a) => { const t = a.join(' '); if (!/^\\[Warning\\]/.test(t)) warns.push(t); };
        try { H.reRender(); mountAll(); } finally { console.warn = ow; }
        if (warns.length) return { ok: false, detail: 'warnings: ' + warns.join(' | ') };
        const over = overflowing();
        if (over.length) return { ok: false, detail: 'page ' + over.join(',') + ' drawn past the paper after adding headers' };
        const titles = [...document.querySelectorAll('#score text.hkl-section-header')];
        if (titles.length !== 2) return { ok: false, detail: titles.length + ' titles rendered, expected 2' };
        const reserve = Number(titles[0].getAttribute('data-reserve'));
        if (!(reserve > 0)) return { ok: false, detail: 'title carries no data-reserve' };
        /* The paper never changes: every mounted page keeps page 1's box. */
        for (const pg of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
          const b = box(Number(pg.dataset.page));
          if (b.h !== ref.h || b.vb !== ref.vb || Math.abs(b.divH - ref.divH) > 1) return { ok: false, detail: 'page ' + pg.dataset.page + ' box changed: ' + JSON.stringify([ref, b]) };
        }
        /* Each title sits in the band above its own system, on the same page. */
        for (const t of titles) {
          const id = t.getAttribute('data-for');
          const meas = document.querySelector('#score g.measure#' + CSS.escape(id));
          if (!meas) return { ok: false, detail: 'title ' + t.textContent + ' has no rendered measure' };
          if (meas.closest('.score-page') !== t.closest('.score-page')) return { ok: false, detail: 'title ' + t.textContent + ' is not on its system\\'s page' };
          const sys = meas.closest('g.system');
          const tb = sys.transform.baseVal.consolidate(); const ty = tb ? tb.matrix.f : 0;
          const gap = (sys.getBBox().y + ty) - Number(t.getAttribute('y'));
          if (!(gap > 0 && gap < 2 * reserve)) return { ok: false, detail: 'title ' + t.textContent + ' gap to its system ' + gap.toFixed(1) };
        }
        const pages1 = pb.pageStarts();
        const moved = slackPx < 2 * reserve * pxPerUnit;
        if (moved) {
          const newP3 = pages1[2];
          const li3 = pb.lineStarts().indexOf(newP3);
          if (li3 < 0 || li3 > p2last || li3 <= p2first) return { ok: false, detail: 'expected page 3 to start inside old page 2 (lines ' + (p2first + 1) + '..' + p2last + '), got line ' + li3 };
          const p3start = pageEl(3).querySelector('g.system g.measure');
          if (!p3start || p3start.id !== newP3) return { ok: false, detail: 'DOM page 3 starts at ' + (p3start && p3start.id) + ', pins say ' + newP3 };
          if (!document.querySelector('#score .score-page[data-page="3"] g.measure#' + CSS.escape(tailId))) return { ok: false, detail: 'old tail line ' + tailId + ' did not move to page 3' };
        } else if (pages1.join() !== pages0.join()) {
          return { ok: false, detail: 'page 2 had room (' + slackPx.toFixed(0) + ' px) yet pagination changed' };
        }
        const st = H.renderer['pageVirt'];
        const verified = pb.verifyRenderedPartition(H.renderer['container'], m, st.pageCount, H.renderer['pageBreaksCtx']());
        if (!verified) return { ok: false, detail: 'rendered partition diverged from the pins' };
        return { ok: true, detail: moved ? 'tail moved' : 'fit without moving' };
      })()` },
  ],
  pagePaginationIdentityUnderMountAndZoom: [
    { name: 'mount -> unmount -> remount leaves the pagination byte-identical',
      expr: `(() => {
        const H = window.__hkl_composer;
        const pb = H.renderer['pageBreaks'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        const sig = () => pb.lineStarts().join(',') + '#' + pb.pageStarts().join(',');
        const pageNums = () => [...document.querySelectorAll('#score .score-page')].map((p) => +p.dataset.page);
        H.renderer.setMountWindowEnabled(false);
        const mountAll = () => { for (const p of pageNums()) H.renderer['mountPage'](p); };
        const unmountAll = () => { for (const p of pageNums()) { try { H.renderer['unmountPage'](p); } catch (e) {} } };
        mountAll();
        const a = sig();
        if (pageNums().length < 2) return { ok: false, detail: 'need a multi-page score, got ' + pageNums().length };
        unmountAll();
        const b = sig();
        mountAll();
        const c = sig();
        if (a !== b) return { ok: false, detail: 'unmounting changed the pagination:\\n  mounted   ' + a + '\\n  unmounted ' + b };
        if (a !== c) return { ok: false, detail: 'remounting changed the pagination:\\n  first  ' + a + '\\n  second ' + c };
        return { ok: true };
      })()` },
    { name: 'a zoom change leaves the pagination byte-identical',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const pb = H.renderer['pageBreaks'];
        const sleep = (ms) => new Promise((r2) => setTimeout(r2, ms));
        /* reRender is NOT synchronous: read immediately after it and the
           partition is still empty (this assertion first failed that way). */
        const settled = async () => {
          for (let i = 0; i < 400; i++) {
            const b = document.getElementById('renderBusy');
            if (pb.lineStarts().length > 0 && (!b || b.hidden)) return true;
            await sleep(25);
          }
          return false;
        };
        const sig = () => pb.lineStarts().join(',') + '#' + pb.pageStarts().join(',');
        if (!await settled()) return { ok: false, detail: 'never settled before the zoom' };
        const before = sig();
        const z0 = H.renderer['zoom'];
        const seen = [];
        try {
          for (const z of [75, 50, 100]) {
            H.renderer.setZoom(z);
            H.reRender();
            if (!await settled()) return { ok: false, detail: 'never settled at zoom ' + z };
            seen.push([z, sig()]);
          }
        } finally {
          H.renderer.setZoom(z0);
          H.reRender();
          await settled();
        }
        const bad = seen.filter(([, x]) => x !== before);
        if (bad.length) {
          return { ok: false, detail: 'zoom re-paginated at ' + bad.map(([z]) => z + '%').join(', ')
            + '\\n  before ' + before + '\\n  after  ' + bad[0][1] };
        }
        if (sig() !== before) return { ok: false, detail: 'restoring the zoom changed the pagination' };
        return { ok: true };
      })()` },
  ],
  pagePlacementOwned: [
    { name: 'every mounted page satisfies live staff tops == placePage(live extents), after the derive and after a splice',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        if (typeof H.renderer.placeFor !== 'function') return { ok: false, detail: 'renderer has no placeFor — placement is not owned' };
        H.renderer.setMountWindowEnabled(false);
        const mountAll = () => { for (const page of document.querySelectorAll('#score .score-page.score-page-pending')) H.renderer['mountPage'](+page.dataset.page); };
        mountAll();
        const tf = (el) => { const t = el.getAttribute('transform') || ''; const mm = /translate\\(\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)/.exec(t); return mm ? { tx: +mm[1], ty: +mm[2] } : { tx: 0, ty: 0 }; };
        /* Live staff top of a system in the page-margin frame + the staff-line spacing (2 Verovio units). */
        const staffTop = (sys) => {
          const st = sys.querySelector('g.measure > g.staff'); if (!st) return null;
          const ys = [];
          for (const p of st.children) {
            if (p.localName !== 'path') continue;
            const mm = /M\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)\\s*L\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)/.exec(p.getAttribute('d') || '');
            if (mm && Math.abs(+mm[2] - +mm[4]) < 0.01) ys.push(+mm[2]);
          }
          if (ys.length < 2) return null;
          ys.sort((a, b) => a - b);
          return { top: ys[0] + tf(st).ty + tf(sys).ty, spacing: ys[1] - ys[0] };
        };
        const mountedPages = () => [...document.querySelectorAll('#score .score-page:not(.score-page-pending)')];
        const systemsOf = (pageEl) => { const margin = pageEl.querySelector('svg g.page-margin'); return margin ? [...margin.children].filter((c) => c.classList.contains('system')) : []; };
        /* Self-consistency of one page: every live top within half a unit of the rule's. */
        const checkPage = (pageEl) => {
          const systems = systemsOf(pageEl);
          if (!systems.length) return 'page ' + pageEl.dataset.page + ' has no systems';
          /* DISTRIBUTED (rule v2, Phase 4): a mounted page has had its slack
             shared out, so the rule it must be self-consistent with is the one
             that placed it. */
          const exp = H.renderer.placeFor(systems, { distribute: true, pageNo: Number(pageEl.dataset.page) });
          if (!exp || exp.length !== systems.length) return 'page ' + pageEl.dataset.page + ': placeFor returned ' + (exp ? exp.length : 'null') + ' for ' + systems.length + ' systems';
          for (let i = 0; i < systems.length; i++) {
            const live = staffTop(systems[i]);
            if (!live) return 'page ' + pageEl.dataset.page + ' system ' + i + ': no readable staff lines';
            const tol = live.spacing / 4;   // half a Verovio unit
            const d = Math.abs(exp[i].top - live.top);
            if (d > tol) return 'page ' + pageEl.dataset.page + ' system ' + i + ': live top ' + live.top.toFixed(1) + ' vs rule ' + exp[i].top.toFixed(1) + ' (d=' + d.toFixed(1) + ', tol=' + tol.toFixed(1) + ')';
            /* Snapping is an OUTPUT transform (2026-09-04). The rule exposes the
               unsnapped position it accumulated on, and the snapped one must be
               within half a device pixel of it on EVERY system independently: a
               snapped position that fed the next system's premise accumulated
               down the page and split neighbours across pixel boundaries.
               Absent rawTop, the accumulator is running on snapped values. */
            if (typeof exp[i].rawTop !== 'number') return 'page ' + pageEl.dataset.page + ' system ' + i + ': placement exposes no rawTop — snapping is not output-only';
            const grid = 1000 / H.renderer['currentScale']();
            const snapMove = Math.abs(exp[i].top - exp[i].rawTop);
            if (snapMove > grid / 2 + 0.01) return 'page ' + pageEl.dataset.page + ' system ' + i + ': the snap moved the system ' + snapMove.toFixed(2) + ' units, more than half a device pixel (' + (grid / 2).toFixed(2) + ') — a snapped position fed a later one';
          }
          return null;
        };
        const checkAll = () => { for (const pg of mountedPages()) { const e = checkPage(pg); if (e) return e; } return null; };
        const ids = () => m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const withWarnsCaptured = (fn) => { const warns = []; const ow = console.warn; console.warn = (...a) => { const t = a.join(' '); if (!/^\\[Warning\\]/.test(t)) warns.push(t); }; try { fn(); } finally { console.warn = ow; } return warns; };
        const pages0 = pb.pageStarts();
        if (pages0.length < 3) return { ok: false, detail: 'need >= 3 pages, got ' + pages0.length };
        if (mountedPages().length !== pages0.length) return { ok: false, detail: mountedPages().length + ' pages mounted of ' + pages0.length };
        const e0 = checkAll();
        if (e0) return { ok: false, detail: 'after the derive: ' + e0 };
        /* An edit mid-document: the touched page is re-placed by the splice path; the invariant must hold again. */
        const st0 = H.renderer['pageVirt'];
        const mi = ids().indexOf(pages0[1]) + 1;
        m.setCursor(m.getMeasureStartCursor(1, mi), 1);
        if (!m.deleteAtCursor()) return { ok: false, detail: 'delete at measure ' + mi + ' rejected' };
        const warns = withWarnsCaptured(() => { H.reRender(); mountAll(); });
        if (warns.length) return { ok: false, detail: 'warnings: ' + warns.join(' | ') };
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + '; derive=' + pb.lastDeriveReason + ')' };
        if (H.renderer['pageVirt'] !== st0) return { ok: false, detail: 'page DOM was rebuilt — a full render, not a splice' };
        const e1 = checkAll();
        if (e1) return { ok: false, detail: 'after the splice: ' + e1 };
        return { ok: true };
      })()` },
  ],
  pagePlacementTextTopped: [
    { name: 'a text-topped first system (tempo above the staff) is rule-placed: below the page header, never higher than without the text, self-consistent',
      expr: `(() => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        if (typeof H.renderer.placeFor !== 'function') return { ok: false, detail: 'renderer has no placeFor — placement is not owned' };
        H.renderer.setMountWindowEnabled(false);
        const mountAll = () => { for (const page of document.querySelectorAll('#score .score-page.score-page-pending')) H.renderer['mountPage'](+page.dataset.page); };
        mountAll();
        const tf = (el) => { const t = el.getAttribute('transform') || ''; const mm = /translate\\(\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)/.exec(t); return mm ? { tx: +mm[1], ty: +mm[2] } : { tx: 0, ty: 0 }; };
        /* Live staff top of a system in the page-margin frame + the staff-line spacing (2 Verovio units). */
        const staffTop = (sys) => {
          const st = sys.querySelector('g.measure > g.staff'); if (!st) return null;
          const ys = [];
          for (const p of st.children) {
            if (p.localName !== 'path') continue;
            const mm = /M\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)\\s*L\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)/.exec(p.getAttribute('d') || '');
            if (mm && Math.abs(+mm[2] - +mm[4]) < 0.01) ys.push(+mm[2]);
          }
          if (ys.length < 2) return null;
          ys.sort((a, b) => a - b);
          return { top: ys[0] + tf(st).ty + tf(sys).ty, spacing: ys[1] - ys[0] };
        };
        const mountedPages = () => [...document.querySelectorAll('#score .score-page:not(.score-page-pending)')];
        const systemsOf = (pageEl) => { const margin = pageEl.querySelector('svg g.page-margin'); return margin ? [...margin.children].filter((c) => c.classList.contains('system')) : []; };
        /* Self-consistency of one page: every live top within half a unit of the rule's. */
        const checkPage = (pageEl) => {
          const systems = systemsOf(pageEl);
          if (!systems.length) return 'page ' + pageEl.dataset.page + ' has no systems';
          /* DISTRIBUTED (rule v2, Phase 4): a mounted page has had its slack
             shared out, so the rule it must be self-consistent with is the one
             that placed it. */
          const exp = H.renderer.placeFor(systems, { distribute: true, pageNo: Number(pageEl.dataset.page) });
          if (!exp || exp.length !== systems.length) return 'page ' + pageEl.dataset.page + ': placeFor returned ' + (exp ? exp.length : 'null') + ' for ' + systems.length + ' systems';
          for (let i = 0; i < systems.length; i++) {
            const live = staffTop(systems[i]);
            if (!live) return 'page ' + pageEl.dataset.page + ' system ' + i + ': no readable staff lines';
            const tol = live.spacing / 4;   // half a Verovio unit
            const d = Math.abs(exp[i].top - live.top);
            if (d > tol) return 'page ' + pageEl.dataset.page + ' system ' + i + ': live top ' + live.top.toFixed(1) + ' vs rule ' + exp[i].top.toFixed(1) + ' (d=' + d.toFixed(1) + ', tol=' + tol.toFixed(1) + ')';
          }
          return null;
        };
        const checkAll = () => { for (const pg of mountedPages()) { const e = checkPage(pg); if (e) return e; } return null; };
        const ids = () => m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const withWarnsCaptured = (fn) => { const warns = []; const ow = console.warn; console.warn = (...a) => { const t = a.join(' '); if (!/^\\[Warning\\]/.test(t)) warns.push(t); }; try { fn(); } finally { console.warn = ow; } return warns; };
        const page1 = () => document.querySelector('#score .score-page[data-page="1"]');
        const sys0 = () => systemsOf(page1())[0];
        if (!sys0()) return { ok: false, detail: 'page 1 has no system' };
        const before = staffTop(sys0());
        if (!before) return { ok: false, detail: 'page 1 system 1 has no readable staff lines' };
        m.setTempo(120, '4', 0, 'Allegro con brio');
        const warns = withWarnsCaptured(() => { H.reRender(); mountAll(); });
        if (warns.length) return { ok: false, detail: 'warnings: ' + warns.join(' | ') };
        const sys = sys0();
        const tempo = sys && sys.querySelector('g.tempo');
        if (!tempo) return { ok: false, detail: 'no g.tempo rendered in page 1 system 1' };
        const after = staffTop(sys);
        if (!after) return { ok: false, detail: 'page 1 system 1 lost its staff lines' };
        const unit = after.spacing / 2;
        /* The text is the system's topmost content: above the first staff line, below the page header. */
        const sysTy = tf(sys).ty;
        const tb = tempo.getBBox();
        const tempoTop = tb.y + sysTy, tempoBottom = tb.y + tb.height + sysTy;
        if (!(tempoBottom <= after.top + 0.01)) return { ok: false, detail: 'tempo bottom ' + tempoBottom.toFixed(1) + ' is not above the staff top ' + after.top.toFixed(1) };
        const margin = page1().querySelector('svg g.page-margin');
        const hd = margin && [...margin.children].find((c) => c.classList.contains('pgHead'));
        if (hd) {
          const hb = hd.getBBox(); const hdBottom = hb.y + hb.height + tf(hd).ty;
          if (!(tempoTop >= hdBottom - 0.01)) return { ok: false, detail: 'tempo top ' + tempoTop.toFixed(1) + ' overlaps the page header (bottom ' + hdBottom.toFixed(1) + ')' };
        } else if (!(tempoTop >= -0.01)) return { ok: false, detail: 'tempo top ' + tempoTop.toFixed(1) + ' is above the page margin' };
        if (after.top < before.top - unit / 2) return { ok: false, detail: 'first system moved UP with a text on top: ' + before.top.toFixed(1) + ' → ' + after.top.toFixed(1) };
        const e = checkAll();
        if (e) return { ok: false, detail: e };
        return { ok: true };
      })()` },
  ],
  pageSpliceNoPbPins: [
    { name: 'a page-first hunk splices from a ONE-page window with no <pb> pins and is placed on its live page by the rule',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        if (typeof H.renderer.placeFor !== 'function') return { ok: false, detail: 'renderer has no placeFor — placement is not owned' };
        H.renderer.setMountWindowEnabled(false);
        const mountAll = () => { for (const page of document.querySelectorAll('#score .score-page.score-page-pending')) H.renderer['mountPage'](+page.dataset.page); };
        mountAll();
        const tf = (el) => { const t = el.getAttribute('transform') || ''; const mm = /translate\\(\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)/.exec(t); return mm ? { tx: +mm[1], ty: +mm[2] } : { tx: 0, ty: 0 }; };
        /* Live staff top of a system in the page-margin frame + the staff-line spacing (2 Verovio units). */
        const staffTop = (sys) => {
          const st = sys.querySelector('g.measure > g.staff'); if (!st) return null;
          const ys = [];
          for (const p of st.children) {
            if (p.localName !== 'path') continue;
            const mm = /M\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)\\s*L\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)/.exec(p.getAttribute('d') || '');
            if (mm && Math.abs(+mm[2] - +mm[4]) < 0.01) ys.push(+mm[2]);
          }
          if (ys.length < 2) return null;
          ys.sort((a, b) => a - b);
          return { top: ys[0] + tf(st).ty + tf(sys).ty, spacing: ys[1] - ys[0] };
        };
        const mountedPages = () => [...document.querySelectorAll('#score .score-page:not(.score-page-pending)')];
        const systemsOf = (pageEl) => { const margin = pageEl.querySelector('svg g.page-margin'); return margin ? [...margin.children].filter((c) => c.classList.contains('system')) : []; };
        /* Self-consistency of one page: every live top within half a unit of the rule's. */
        const checkPage = (pageEl) => {
          const systems = systemsOf(pageEl);
          if (!systems.length) return 'page ' + pageEl.dataset.page + ' has no systems';
          /* DISTRIBUTED (rule v2, Phase 4): a mounted page has had its slack
             shared out, so the rule it must be self-consistent with is the one
             that placed it. */
          const exp = H.renderer.placeFor(systems, { distribute: true, pageNo: Number(pageEl.dataset.page) });
          if (!exp || exp.length !== systems.length) return 'page ' + pageEl.dataset.page + ': placeFor returned ' + (exp ? exp.length : 'null') + ' for ' + systems.length + ' systems';
          for (let i = 0; i < systems.length; i++) {
            const live = staffTop(systems[i]);
            if (!live) return 'page ' + pageEl.dataset.page + ' system ' + i + ': no readable staff lines';
            const tol = live.spacing / 4;   // half a Verovio unit
            const d = Math.abs(exp[i].top - live.top);
            if (d > tol) return 'page ' + pageEl.dataset.page + ' system ' + i + ': live top ' + live.top.toFixed(1) + ' vs rule ' + exp[i].top.toFixed(1) + ' (d=' + d.toFixed(1) + ', tol=' + tol.toFixed(1) + ')';
          }
          return null;
        };
        const checkAll = () => { for (const pg of mountedPages()) { const e = checkPage(pg); if (e) return e; } return null; };
        const ids = () => m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const withWarnsCaptured = (fn) => { const warns = []; const ow = console.warn; console.warn = (...a) => { const t = a.join(' '); if (!/^\\[Warning\\]/.test(t)) warns.push(t); }; try { fn(); } finally { console.warn = ow; } return warns; };
        const pages0 = pb.pageStarts();
        if (pages0.length < 3) return { ok: false, detail: 'need >= 3 pages, got ' + pages0.length };
        const st0 = H.renderer['pageVirt'];
        const pageEl = (p) => document.querySelector('#score .score-page[data-page="' + p + '"]');
        /* Edit inside page 2's FIRST measure: the hunk's first line is page-first. */
        const mi = ids().indexOf(pages0[1]);
        if (mi < 0) return { ok: false, detail: 'page 2 start ' + pages0[1] + ' not in the document' };
        m.setCursor(m.getMeasureStartCursor(1, mi), 1);
        if (!m.deleteAtCursor()) return { ok: false, detail: 'delete at page-2 start (measure ' + mi + ') rejected' };
        const warns = withWarnsCaptured(() => { H.reRender(); mountAll(); });
        if (warns.length) return { ok: false, detail: 'warnings: ' + warns.join(' | ') };
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + '; derive=' + pb.lastDeriveReason + ')' };
        if (H.renderer['pageVirt'] !== st0) return { ok: false, detail: 'page DOM was rebuilt — a full render, not a splice' };
        const w = ps.lastWindow;
        if (!w) return { ok: false, detail: 'no window recorded for the splice' };
        if (w.pbIds && w.pbIds.length) return { ok: false, detail: 'window carried <pb> pins: ' + w.pbIds.join(',') };
        const p2 = pageEl(2), p3 = pageEl(3);
        if (!p2 || !p3 || p2.classList.contains('score-page-pending') || p3.classList.contains('score-page-pending')) return { ok: false, detail: 'pages 2 and 3 are not both mounted' };
        const first2 = systemsOf(p2)[0], first3 = systemsOf(p3)[0];
        if (!first2 || !first3) return { ok: false, detail: 'page 2 or 3 has no system' };
        if (first2.querySelector('g.measure').id !== pb.pageStarts()[1]) return { ok: false, detail: 'DOM page 2 starts at ' + first2.querySelector('g.measure').id + ', pins say ' + pb.pageStarts()[1] };
        /* Both are page-first, header-free systems, so the rule gives them the
           same first-content top — as an UNDISTRIBUTED placement. Rule v2 then
           moves each page's block by its own slack (a sparse page may open its
           top gap), so the live tops legitimately differ; the invariant this
           fixture exists for is that the hunk was placed as a page-first
           system at all, which is the v1 comparison. */
        const t2 = staffTop(first2), t3 = staffTop(first3);
        if (!t2 || !t3) return { ok: false, detail: 'page-first system without readable staff lines' };
        const nat2 = H.renderer.placeFor(systemsOf(p2)), nat3 = H.renderer.placeFor(systemsOf(p3));
        if (!nat2 || !nat3) return { ok: false, detail: 'undistributed placement unreadable' };
        const tol = t2.spacing / 4;
        if (Math.abs(nat2[0].top - nat3[0].top) > tol) return { ok: false, detail: 'page-first tops differ (undistributed): page 2 ' + nat2[0].top.toFixed(1) + ' vs page 3 ' + nat3[0].top.toFixed(1) + ' (tol ' + tol.toFixed(1) + ')' };
        if (t2.top < nat2[0].top - tol) return { ok: false, detail: 'page 2 live top ' + t2.top.toFixed(1) + ' is ABOVE its undistributed placement ' + nat2[0].top.toFixed(1) + ' — distribution only ever moves a system down' };
        const e = checkPage(p2);
        if (e) return { ok: false, detail: e };
        return { ok: true };
      })()` },
  ],
  pageCascadePredictedFold: [
    { name: 'the cascade folds by prediction and moves the spilled block as a transplant (same elements), leaving no page past its paper',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        if (!H.renderer.lastCascade || typeof H.renderer.runExtentsJobNow !== 'function') return { ok: false, detail: 'renderer has no cascade diagnostics / extents job — Phase 2 not built' };
        H.renderer.setMountWindowEnabled(false);
        const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
        const pageEl = (p) => document.querySelector('#score .score-page[data-page="' + p + '"]');
        const mountAll = () => { for (const page of document.querySelectorAll('#score .score-page.score-page-pending')) H.renderer['mountPage'](+page.dataset.page); };
        const mountedPages = () => [...document.querySelectorAll('#score .score-page:not(.score-page-pending)')];
        const systemsOf = (pg) => { const margin = pg.querySelector('svg g.page-margin'); return margin ? [...margin.children].filter((c) => c.classList.contains('system')) : []; };
        const overflowing = () => mountedPages().filter((pg) => {
          const svg = pg.querySelector('svg'); const sy = systemsOf(pg);
          return svg && sy.length && sy[sy.length - 1].getBoundingClientRect().bottom > svg.getBoundingClientRect().bottom + 2;
        }).map((pg) => pg.dataset.page);
        const ids = () => m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const linesOfPage = (p) => { const lines = pb.lineStarts(), pages = pb.pageStarts(); const lo = lines.indexOf(pages[p - 1]); const hi = p < pages.length ? lines.indexOf(pages[p]) : lines.length; return lo < 0 ? [] : lines.slice(lo, hi < 0 ? lines.length : hi); };
        const withWarnsCaptured = async (fn) => { const warns = []; const ow = console.warn; console.warn = (...a) => { const t = a.join(' '); if (!/^\\[Warning\\]/.test(t)) warns.push(t); }; try { await fn(); } finally { console.warn = ow; } return warns; };
        mountAll();
        const pages0 = pb.pageStarts().length;
        if (pages0 < 2) return { ok: false, detail: 'need >= 2 pages, got ' + pages0 };
        if (overflowing().length) return { ok: false, detail: 'overflowing before the edit: ' + overflowing() };
        const st0 = H.renderer['pageVirt'];
        /* Where every system sits now (element → page). */
        const homeOf = new Map();
        for (const pg of mountedPages()) for (const sy of systemsOf(pg)) homeOf.set(sy, Number(pg.dataset.page));
        /* Compose past the last line until a cascade step lands. */
        let cascade = null, steps = 0;
        const warns = await withWarnsCaptured(async () => {
          for (; steps < 80 && !cascade; steps++) {
            for (let q = 0; q < 4; q++) {
              m.setCursor(m['flatChildren'](1).length, 1);
              if (!m.insertChordAtCursor({ notes: [mk(q % 2 ? 'g' : 'b', q % 2 ? 6 : 4)], duration: '4', dots: 0 })) { cascade = { error: 'append rejected at step ' + steps }; return; }
            }
            H.reRender();
            await window.__waitForRender();
            if (ps.lastOutcome !== 'spliced') { cascade = { error: 'step ' + steps + ': expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + '; derive=' + pb.lastDeriveReason + ')' }; return; }
            if (H.renderer['pageVirt'] !== st0) { cascade = { error: 'page DOM was rebuilt at step ' + steps + ' — a full render' }; return; }
            const over = overflowing();
            if (over.length) { cascade = { error: 'page ' + over.join(',') + ' drawn past the paper after step ' + steps }; return; }
            if (H.renderer.lastCascade.steps > 0) cascade = { ...H.renderer.lastCascade };
          }
        });
        if (warns.length) return { ok: false, detail: 'warnings: ' + warns.join(' | ') };
        if (!cascade) return { ok: false, detail: steps + ' steps never spilled a page' };
        if (cascade.error) return { ok: false, detail: cascade.error };
        if (cascade.parked) return { ok: false, detail: 'a step parked with every page mounted: ' + JSON.stringify(cascade) };
        if (!(cascade.transplanted >= 1)) return { ok: false, detail: 'no transplant recorded: ' + JSON.stringify(cascade) };
        /* The moved systems are the SAME elements, now heading their new page, in order. */
        let moved = 0;
        for (const pg of mountedPages()) {
          const p = Number(pg.dataset.page);
          const sy = systemsOf(pg);
          for (let i = 0; i < sy.length; i++) {
            const home = homeOf.get(sy[i]);
            if (home === undefined) { if (!cascade.created) return { ok: false, detail: 'page ' + p + ' system ' + i + ' is a new element — a re-render, not a transplant' }; continue; }
            if (home !== p) {
              if (home !== p - 1) return { ok: false, detail: 'system moved from page ' + home + ' to ' + p };
              if (i !== moved) return { ok: false, detail: 'moved system is not at the head of page ' + p + ' (index ' + i + ')' };
              moved++;
            }
          }
          if (moved) break;
        }
        if (!moved && !cascade.created) return { ok: false, detail: 'no system changed page' };
        /* Predicted fold agrees with the DOM on every mounted page (the flag also throws inside foldOf on disagreement). */
        for (const pg of mountedPages()) {
          const fold = H.renderer['foldOf'](pg);
          if (fold && fold.firstPast >= 0) return { ok: false, detail: 'page ' + pg.dataset.page + ' still predicted to overflow at system ' + fold.firstPast };
        }
        const verified = pb.verifyRenderedPartition(H.renderer['container'], m, st0.pageCount, H.renderer['pageBreaksCtx']());
        if (!verified) return { ok: false, detail: 'rendered partition diverged from the pins after the cascade' };
        return { ok: true };
      })()` },
  ],
  pageCascadeArithmeticPastMount: [
    { name: 'a spill into a PARKED page is repaginated in place: the page is rebuilt from the park, draws right, and nothing is handed back',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        H.renderer.setMountWindowEnabled(false);
        const as = H.renderer['pageVirt'];
        if (!as) return { ok: false, detail: 'no page assembler' };
        const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
        const pageEl = (p) => document.querySelector('#score .score-page[data-page="' + p + '"]');
        const mountedPages = () => [...document.querySelectorAll('#score .score-page:not(.score-page-pending)')];
        const systemsOf = (pg) => { const margin = pg.querySelector('svg g.page-margin'); return margin ? [...margin.children].filter((c) => c.classList.contains('system')) : []; };
        const ids = () => m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const linesOfPage = (p) => { const lines = pb.lineStarts(), pages = pb.pageStarts(); const lo = lines.indexOf(pages[p - 1]); const hi = p < pages.length ? lines.indexOf(pages[p]) : lines.length; return lines.slice(lo, hi); };
        const staffTopOf = (sys) => { const st = sys.querySelector('g.measure > g.staff'); if (!st) return null; const ys = []; for (const q of st.children) { if (q.localName !== 'path') continue; const mm = /M\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)/.exec(q.getAttribute('d') || ''); if (mm) ys.push(Number(mm[2])); } if (!ys.length) return null; ys.sort((a, b) => a - b); const tf = /translate\\(\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)/.exec(sys.getAttribute('transform') || ''); const stf = /translate\\(\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)/.exec(st.getAttribute('transform') || ''); return { top: ys[0] + (tf ? +tf[2] : 0) + (stf ? +stf[2] : 0), spacing: ys.length > 1 ? ys[1] - ys[0] : 160 }; };
        const selfConsistent = () => {
          for (const pg of mountedPages()) {
            const sy = systemsOf(pg); if (!sy.length) continue;
            const exp = H.renderer.placeFor(sy, { distribute: true, pageNo: Number(pg.dataset.page) });
            if (!exp) return 'page ' + pg.dataset.page + ': placement unreadable';
            for (let i = 0; i < sy.length; i++) {
              const live = staffTopOf(sy[i]); if (!live) return 'page ' + pg.dataset.page + ' system ' + i + ': no readable staff lines';
              if (Math.abs(exp[i].top - live.top) > live.spacing / 4) return 'page ' + pg.dataset.page + ' system ' + i + ': staff top ' + live.top.toFixed(1) + ' vs rule ' + exp[i].top.toFixed(1);
            }
          }
          return null;
        };
        as.mountAll();
        const pages0 = pb.pageStarts();
        if (pages0.length < 3) return { ok: false, detail: 'need >= 3 pages, got ' + pages0.length };
        /* Pages 3.. back to the park, never re-mounted by the observer. */
        for (let p = 3; p <= as.pageCount; p++) as.unmount(p);
        if (!pageEl(3).classList.contains('score-page-pending')) return { ok: false, detail: 'page 3 did not park' };
        /* Make page 2 spill: grow its systems one by one with a c0..g7 chord
           (deep ledger lines both ways) until its slack is gone — content edits,
           which splice. */
        const lines = pb.lineStarts();
        const p2first = lines.indexOf(pages0[1]), p3first = lines.indexOf(pages0[2]);
        if (p3first - p2first < 2) return { ok: false, detail: 'page 2 needs >= 2 lines' };
        let c = null, steps = 0, err = null;
        for (let li = p2first; li < p3first && !c; li++) {
          const target = m.allMeasures()[ids().indexOf(lines[li])];
          if (!target) { err = 'line ' + li + ' start measure missing'; break; }
          const flat = m['flatChildren'](1);
          let cur = -1;
          for (let i = 0; i < flat.length; i++) { const el = flat[i]; if ((el.localName === 'note' || el.localName === 'chord') && el.closest('measure') === target) { cur = i; break; } }
          if (cur < 0) { err = 'no chord in line ' + li; break; }
          m.setCursor(cur, 1);
          if (m.replaceChordAtCursor({ notes: [mk('c', 0), mk('g', 7)], duration: '4', dots: 0 }) === null) { err = 'replace rejected at line ' + li; break; }
          H.reRender();
          await window.__waitForRender();
          steps++;
          if (ps.lastOutcome !== 'spliced') { err = 'step ' + steps + ': expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + '; derive=' + pb.lastDeriveReason + ')'; break; }
          if (H.renderer['pageVirt'] !== as) { err = 'page DOM was rebuilt at step ' + steps + ' — a full render'; break; }
          if (H.renderer.lastCascade.steps > 0) c = { ...H.renderer.lastCascade };
        }
        if (err) return { ok: false, detail: err };
        if (!c) return { ok: false, detail: 'page 2 never spilled in ' + steps + ' steps' };
        if (c.transplanted < 1) return { ok: false, detail: 'repagination moved no system: ' + JSON.stringify(c) };
        /* The rebuilt pages are real and right: nothing past its paper, every
           mounted page self-consistent, and page 3 (rebuilt from the park) real. */
        const over = mountedPages().filter((pg) => { const svg = pg.querySelector('svg'); const sy = systemsOf(pg); return svg && sy.length && sy[sy.length - 1].getBoundingClientRect().bottom > svg.getBoundingClientRect().bottom + 2; }).map((pg) => pg.dataset.page);
        if (over.length) return { ok: false, detail: 'pages past their paper: ' + over.join(',') };
        const sc = selfConsistent(); if (sc) return { ok: false, detail: sc };
        for (const id of linesOfPage(3)) if (!H.renderer.extentsKnown(id)) return { ok: false, detail: 'page 3 line ' + id + ' has no extents' };
        return { ok: true, detail: 'spilled at step ' + steps + ', cascade ' + JSON.stringify(c) };
      })()` },
  ],
  pageExtentsJobEditDuring: [
    { name: 'an edit while the assembly is still running finishes the assembly first, splices, and every page stays self-consistent',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        H.renderer.setMountWindowEnabled(false);
        const as = H.renderer['pageVirt'];
        if (!as) return { ok: false, detail: 'no page assembler' };
        const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
        const pageEl = (p) => document.querySelector('#score .score-page[data-page="' + p + '"]');
        const mountedPages = () => [...document.querySelectorAll('#score .score-page:not(.score-page-pending)')];
        const systemsOf = (pg) => { const margin = pg.querySelector('svg g.page-margin'); return margin ? [...margin.children].filter((c) => c.classList.contains('system')) : []; };
        const ids = () => m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const linesOfPage = (p) => { const lines = pb.lineStarts(), pages = pb.pageStarts(); const lo = lines.indexOf(pages[p - 1]); const hi = p < pages.length ? lines.indexOf(pages[p]) : lines.length; return lines.slice(lo, hi); };
        const staffTopOf = (sys) => { const st = sys.querySelector('g.measure > g.staff'); if (!st) return null; const ys = []; for (const q of st.children) { if (q.localName !== 'path') continue; const mm = /M\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)/.exec(q.getAttribute('d') || ''); if (mm) ys.push(Number(mm[2])); } if (!ys.length) return null; ys.sort((a, b) => a - b); const tf = /translate\\(\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)/.exec(sys.getAttribute('transform') || ''); const stf = /translate\\(\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)/.exec(st.getAttribute('transform') || ''); return { top: ys[0] + (tf ? +tf[2] : 0) + (stf ? +stf[2] : 0), spacing: ys.length > 1 ? ys[1] - ys[0] : 160 }; };
        const selfConsistent = () => {
          for (const pg of mountedPages()) {
            const sy = systemsOf(pg); if (!sy.length) continue;
            const exp = H.renderer.placeFor(sy, { distribute: true, pageNo: Number(pg.dataset.page) });
            if (!exp) return 'page ' + pg.dataset.page + ': placement unreadable';
            for (let i = 0; i < sy.length; i++) {
              const live = staffTopOf(sy[i]); if (!live) return 'page ' + pg.dataset.page + ' system ' + i + ': no readable staff lines';
              if (Math.abs(exp[i].top - live.top) > live.spacing / 4) return 'page ' + pg.dataset.page + ' system ' + i + ': staff top ' + live.top.toFixed(1) + ' vs rule ' + exp[i].top.toFixed(1);
            }
          }
          return null;
        };
        /* Restart the assembly: the synchronous burst closes only the cursor's
           page, the rest is idle work — an edit now must not find a half-built
           document. */
        m.setCursor(0, 1);
        H.renderer.forceFullRerender();
        H.reRender();
        if (!H.renderer.assemblyPending()) return { ok: true, detail: 'document too small to leave the assembly pending — nothing to test here' };
        const as1 = H.renderer['pageVirt'];
        const mi = ids().indexOf(pb.pageStarts()[1]) + 1;
        m.setCursor(m.getMeasureStartCursor(1, mi), 1);
        if (!m.deleteAtCursor()) return { ok: false, detail: 'delete at measure ' + mi + ' rejected' };
        H.reRender();
        await window.__waitForRender();
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + '; derive=' + pb.lastDeriveReason + ')' };
        if (H.renderer['pageVirt'] !== as1) return { ok: false, detail: 'page DOM was rebuilt — a full render' };
        if (H.renderer.assemblyPending()) return { ok: false, detail: 'assembly still pending after the edit' };
        const pages = pb.pageStarts().length;
        for (let p = 1; p <= pages; p++) for (const id of linesOfPage(p)) if (!H.renderer.extentsKnown(id)) return { ok: false, detail: 'page ' + p + ' line ' + id + ' has no extents' };
        as1.mountAll();
        const sc = selfConsistent(); if (sc) return { ok: false, detail: sc };
        return { ok: true };
      })()` },
  ],
  pageExtentsJobScrollDuring: [
    { name: 'a page asked for while the assembly is still running is built on demand; the rest finishes afterwards',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        H.renderer.setMountWindowEnabled(false);
        const as = H.renderer['pageVirt'];
        if (!as) return { ok: false, detail: 'no page assembler' };
        const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
        const pageEl = (p) => document.querySelector('#score .score-page[data-page="' + p + '"]');
        const mountedPages = () => [...document.querySelectorAll('#score .score-page:not(.score-page-pending)')];
        const systemsOf = (pg) => { const margin = pg.querySelector('svg g.page-margin'); return margin ? [...margin.children].filter((c) => c.classList.contains('system')) : []; };
        const ids = () => m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const linesOfPage = (p) => { const lines = pb.lineStarts(), pages = pb.pageStarts(); const lo = lines.indexOf(pages[p - 1]); const hi = p < pages.length ? lines.indexOf(pages[p]) : lines.length; return lines.slice(lo, hi); };
        const staffTopOf = (sys) => { const st = sys.querySelector('g.measure > g.staff'); if (!st) return null; const ys = []; for (const q of st.children) { if (q.localName !== 'path') continue; const mm = /M\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)/.exec(q.getAttribute('d') || ''); if (mm) ys.push(Number(mm[2])); } if (!ys.length) return null; ys.sort((a, b) => a - b); const tf = /translate\\(\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)/.exec(sys.getAttribute('transform') || ''); const stf = /translate\\(\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)/.exec(st.getAttribute('transform') || ''); return { top: ys[0] + (tf ? +tf[2] : 0) + (stf ? +stf[2] : 0), spacing: ys.length > 1 ? ys[1] - ys[0] : 160 }; };
        const selfConsistent = () => {
          for (const pg of mountedPages()) {
            const sy = systemsOf(pg); if (!sy.length) continue;
            const exp = H.renderer.placeFor(sy, { distribute: true, pageNo: Number(pg.dataset.page) });
            if (!exp) return 'page ' + pg.dataset.page + ': placement unreadable';
            for (let i = 0; i < sy.length; i++) {
              const live = staffTopOf(sy[i]); if (!live) return 'page ' + pg.dataset.page + ' system ' + i + ': no readable staff lines';
              if (Math.abs(exp[i].top - live.top) > live.spacing / 4) return 'page ' + pg.dataset.page + ' system ' + i + ': staff top ' + live.top.toFixed(1) + ' vs rule ' + exp[i].top.toFixed(1);
            }
          }
          return null;
        };
        m.setCursor(0, 1);
        H.renderer.forceFullRerender();
        H.reRender();
        if (!H.renderer.assemblyPending()) return { ok: true, detail: 'document too small to leave the assembly pending — nothing to test here' };
        const as1 = H.renderer['pageVirt'];
        const lines = pb.lineStarts();
        if (lines.length < 6) return { ok: false, detail: 'need >= 6 lines, got ' + lines.length };
        /* Ask for a measure well past the frontier: its page is built now. */
        const mi = ids().indexOf(lines[lines.length - 1]);
        H.renderer.ensureMeasureMounted(mi);
        const el = document.querySelector('#score #' + CSS.escape(ids()[mi]));
        if (!el) return { ok: false, detail: 'measure ' + mi + ' not drawn after ensureMeasureMounted' };
        const pg = el.closest('.score-page');
        if (!pg || pg.classList.contains('score-page-pending')) return { ok: false, detail: 'its page is not mounted' };
        if (H.renderer['pageVirt'] !== as1) return { ok: false, detail: 'page DOM was rebuilt — a full render' };
        H.renderer.runExtentsJobNow();
        if (H.renderer.assemblyPending()) return { ok: false, detail: 'assembly still pending after running it to completion' };
        const pages = pb.pageStarts().length;
        for (let p = 1; p <= pages; p++) for (const id of linesOfPage(p)) if (!H.renderer.extentsKnown(id)) return { ok: false, detail: 'page ' + p + ' line ' + id + ' has no extents' };
        as1.mountAll();
        const sc = selfConsistent(); if (sc) return { ok: false, detail: sc };
        return { ok: true };
      })()` },
  ],
  pageSpliceClipsToMountedBand: [
    { name: 'a hunk reaching past the mounted band re-engraves only the band and defers the rest (stale, undrawn, correct on mount)',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        if (!Array.isArray(ps.lastDeferredPages)) return { ok: false, detail: 'splicer has no lastDeferredPages — the clip is not built' };
        H.renderer.setMountWindowEnabled(false);
        const st0 = H.renderer['pageVirt'];
        const pageEl = (p) => document.querySelector('#score .score-page[data-page="' + p + '"]');
        const isMounted = (p) => { const el = pageEl(p); return !!el && !el.classList.contains('score-page-pending'); };
        const mountAll = () => { for (const page of document.querySelectorAll('#score .score-page.score-page-pending')) H.renderer['mountPage'](+page.dataset.page); };
        const mountedPages = () => [...document.querySelectorAll('#score .score-page:not(.score-page-pending)')];
        const systemsOf = (pg) => { const margin = pg.querySelector('svg g.page-margin'); return margin ? [...margin.children].filter((c) => c.classList.contains('system')) : []; };
        const overflowing = () => mountedPages().filter((pg) => {
          const svg = pg.querySelector('svg'); const sy = systemsOf(pg);
          return svg && sy.length && sy[sy.length - 1].getBoundingClientRect().bottom > svg.getBoundingClientRect().bottom + 2;
        }).map((pg) => pg.dataset.page);
        const ids = () => m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const nums = () => m.allMeasures().map((x) => x.getAttribute('n') ?? '');
        const withWarnsCaptured = (fn) => { const warns = []; const ow = console.warn; console.warn = (...a) => { const t = a.join(' '); if (!/^\\[Warning\\]/.test(t)) warns.push(t); }; try { fn(); } finally { console.warn = ow; } return warns; };
        /* Insert a blank measure after measure mi, the way Ctrl+M does. */
        const insertAt = (mi) => { m.setCursor(m.getMeasureStartCursor(1, mi), 1); m.insertMeasureAt(mi + 1); };
        mountAll();
        if (st0.pageCount < 3) return { ok: false, detail: 'need >= 3 pages, got ' + st0.pageCount };
        /* Only pages 1-2 drawn; the observer must not re-mount behind us. */
        st0.io?.disconnect();
        for (let p = 3; p <= st0.pageCount; p++) H.renderer['unmountPage'](p);
        if (isMounted(3)) return { ok: false, detail: 'page 3 did not unmount' };
        const linesBefore = pb.lineStarts().length;
        const nBefore = nums();
        /* Insert early: the renumber reaches the end of the document, so the
           changed run does too. */
        const warns = withWarnsCaptured(() => { insertAt(1); H.reRender(); });
        if (warns.length) return { ok: false, detail: 'warnings: ' + warns.join(' | ') };
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + '; derive=' + pb.lastDeriveReason + ')' };
        if (H.renderer['pageVirt'] !== st0) return { ok: false, detail: 'page DOM was rebuilt — a full render' };
        /* The renumber really did reach far: otherwise this fixture proves nothing. */
        const nAfter = nums();
        let renumbered = 0;
        for (let i = 0; i + 1 < nAfter.length && i < nBefore.length; i++) if (nBefore[i] !== nAfter[i + 1]) renumbered++;
        if (renumbered < 20) return { ok: false, detail: 'only ' + renumbered + ' measures renumbered — the run is not wide enough to clip' };
        /* Pages beyond the band were deferred, not drawn. */
        const deferred = ps.lastDeferredPages.slice();
        if (!deferred.length) return { ok: false, detail: 'nothing deferred although the run reached past the mounted band' };
        for (const p of deferred) {
          if (isMounted(p)) return { ok: false, detail: 'deferred page ' + p + ' is still drawn' };
          if (!st0.stalePages.has(p)) return { ok: false, detail: 'deferred page ' + p + ' not marked stale' };
        }
        /* The window covered only the band: fewer lines than the whole run. */
        if (!(ps.lastStats.lines >= 1)) return { ok: false, detail: 'no line was re-engraved' };
        if (ps.lastDeferredLines && ps.lastDeferredLines.a <= (ps.lastRun ? ps.lastRun.b : -1)) return { ok: false, detail: 'deferred lines overlap the replaced run' };
        if (overflowing().length) return { ok: false, detail: 'page ' + overflowing().join(',') + ' drawn past the paper' };
        /* A deferred page draws correctly when it mounts. */
        const target = deferred[0];
        const warns2 = withWarnsCaptured(() => { H.renderer['mountPage'](target); });
        if (warns2.length) return { ok: false, detail: 'warnings at mount: ' + warns2.join(' | ') };
        if (!isMounted(target)) return { ok: false, detail: 'deferred page ' + target + ' did not mount' };
        const first = pageEl(target).querySelector('g.system g.measure');
        const pins = pb.pageStarts();
        if (!first || first.id !== pins[target - 1]) return { ok: false, detail: 'mounted page ' + target + ' starts at ' + (first && first.id) + ', pins say ' + pins[target - 1] };
        if (overflowing().length) return { ok: false, detail: 'page ' + overflowing().join(',') + ' past the paper after the mount' };
        const verified = pb.verifyRenderedPartition(H.renderer['container'], m, st0.pageCount, H.renderer['pageBreaksCtx']());
        if (!verified) return { ok: false, detail: 'rendered partition diverged from the pins' };
        if (pb.lineStarts().length < linesBefore) return { ok: false, detail: 'lines went ' + linesBefore + ' -> ' + pb.lineStarts().length };
        return { ok: true };
      })()` },
  ],
  pageRenumberIsRedrawOnly: [
    { name: 'a renumber is redraw-only: the naturals measurement stays local while the splicer still redraws the renumbered lines',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        if (!Array.isArray(ps.lastDeferredPages)) return { ok: false, detail: 'splicer has no lastDeferredPages — the clip is not built' };
        H.renderer.setMountWindowEnabled(false);
        const st0 = H.renderer['pageVirt'];
        const pageEl = (p) => document.querySelector('#score .score-page[data-page="' + p + '"]');
        const isMounted = (p) => { const el = pageEl(p); return !!el && !el.classList.contains('score-page-pending'); };
        const mountAll = () => { for (const page of document.querySelectorAll('#score .score-page.score-page-pending')) H.renderer['mountPage'](+page.dataset.page); };
        const mountedPages = () => [...document.querySelectorAll('#score .score-page:not(.score-page-pending)')];
        const systemsOf = (pg) => { const margin = pg.querySelector('svg g.page-margin'); return margin ? [...margin.children].filter((c) => c.classList.contains('system')) : []; };
        const overflowing = () => mountedPages().filter((pg) => {
          const svg = pg.querySelector('svg'); const sy = systemsOf(pg);
          return svg && sy.length && sy[sy.length - 1].getBoundingClientRect().bottom > svg.getBoundingClientRect().bottom + 2;
        }).map((pg) => pg.dataset.page);
        const ids = () => m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const nums = () => m.allMeasures().map((x) => x.getAttribute('n') ?? '');
        const withWarnsCaptured = (fn) => { const warns = []; const ow = console.warn; console.warn = (...a) => { const t = a.join(' '); if (!/^\\[Warning\\]/.test(t)) warns.push(t); }; try { fn(); } finally { console.warn = ow; } return warns; };
        /* Insert a blank measure after measure mi, the way Ctrl+M does. */
        const insertAt = (mi) => { m.setCursor(m.getMeasureStartCursor(1, mi), 1); m.insertMeasureAt(mi + 1); };
        mountAll();
        if (st0.pageCount < 2) return { ok: false, detail: 'need >= 2 pages, got ' + st0.pageCount };
        const nBefore = nums();
        const linesBefore = pb.lineStarts().slice();
        const warns = withWarnsCaptured(() => { insertAt(1); H.reRender(); });
        if (warns.length) return { ok: false, detail: 'warnings: ' + warns.join(' | ') };
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + '; derive=' + pb.lastDeriveReason + ')' };
        const nAfter = nums();
        let renumbered = 0;
        for (let i = 0; i + 1 < nAfter.length && i < nBefore.length; i++) if (nBefore[i] !== nAfter[i + 1]) renumbered++;
        if (renumbered < 20) return { ok: false, detail: 'only ' + renumbered + ' measures renumbered — nothing to prove' };
        /* THE POINT: naturals were measured for the measures whose FLOW changed
           (the new blank measure and its line), not for the renumbered tail. */
        const nat = pb.lastRefillStats.windowMeasures;
        if (!(nat < renumbered / 2)) return { ok: false, detail: 'naturals measured ' + nat + ' measures for ' + renumbered + ' renumbered — the flow/redraw split is not in effect' };
        /* And the partition did not move because of a renumber: every old line
           start still starts a line (the insert may add one). */
        const now = new Set(pb.lineStarts());
        const lost = linesBefore.filter((id) => !now.has(id) && m.allMeasures().some((x) => x.getAttribute('xml:id') === id));
        if (lost.length) return { ok: false, detail: lost.length + ' surviving line starts stopped starting lines (e.g. ' + lost[0] + ') — the renumber re-flowed the partition' };
        /* The rendered numbers are right on every drawn page: that is what the
           redraw run is for. */
        const byId = new Map(m.allMeasures().map((x) => [x.getAttribute('xml:id'), x.getAttribute('n') ?? '']));
        for (const pg of mountedPages()) {
          for (const mn of pg.querySelectorAll('g.mNum')) {
            const meas = mn.closest('g.measure');
            if (!meas) continue;
            const want = byId.get(meas.id);
            const got = (mn.textContent || '').trim();
            if (want !== undefined && got && got !== want) return { ok: false, detail: 'page ' + pg.dataset.page + ' measure ' + meas.id + ' shows number "' + got + '", model says "' + want + '"' };
          }
        }
        return { ok: true };
      })()` },
  ],
  pageExtentsJobWarmsDeferred: [
    { name: 'the idle extents job clears the staleness a clipped splice left, so a later mount needs no document reload',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        if (!Array.isArray(ps.lastDeferredPages)) return { ok: false, detail: 'splicer has no lastDeferredPages — the clip is not built' };
        H.renderer.setMountWindowEnabled(false);
        const st0 = H.renderer['pageVirt'];
        const pageEl = (p) => document.querySelector('#score .score-page[data-page="' + p + '"]');
        const isMounted = (p) => { const el = pageEl(p); return !!el && !el.classList.contains('score-page-pending'); };
        const mountAll = () => { for (const page of document.querySelectorAll('#score .score-page.score-page-pending')) H.renderer['mountPage'](+page.dataset.page); };
        const mountedPages = () => [...document.querySelectorAll('#score .score-page:not(.score-page-pending)')];
        const systemsOf = (pg) => { const margin = pg.querySelector('svg g.page-margin'); return margin ? [...margin.children].filter((c) => c.classList.contains('system')) : []; };
        const overflowing = () => mountedPages().filter((pg) => {
          const svg = pg.querySelector('svg'); const sy = systemsOf(pg);
          return svg && sy.length && sy[sy.length - 1].getBoundingClientRect().bottom > svg.getBoundingClientRect().bottom + 2;
        }).map((pg) => pg.dataset.page);
        const ids = () => m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const nums = () => m.allMeasures().map((x) => x.getAttribute('n') ?? '');
        const withWarnsCaptured = (fn) => { const warns = []; const ow = console.warn; console.warn = (...a) => { const t = a.join(' '); if (!/^\\[Warning\\]/.test(t)) warns.push(t); }; try { fn(); } finally { console.warn = ow; } return warns; };
        /* Insert a blank measure after measure mi, the way Ctrl+M does. */
        const insertAt = (mi) => { m.setCursor(m.getMeasureStartCursor(1, mi), 1); m.insertMeasureAt(mi + 1); };
        mountAll();
        if (st0.pageCount < 3) return { ok: false, detail: 'need >= 3 pages, got ' + st0.pageCount };
        st0.io?.disconnect();
        for (let p = 3; p <= st0.pageCount; p++) H.renderer['unmountPage'](p);
        const warns = withWarnsCaptured(() => { insertAt(1); H.reRender(); });
        if (warns.length) return { ok: false, detail: 'warnings: ' + warns.join(' | ') };
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice, got "' + ps.lastOutcome + '" (' + ps.lastSkipReason + ')' };
        if (!st0.stalePages.size) return { ok: false, detail: 'the splice left no stale page — nothing to warm' };
        const staleBefore = [...st0.stalePages].sort((a, b) => a - b);
        H.renderer.runExtentsJobNow();
        const js = H.renderer.extentsJobState();
        if (st0.stalePages.size) return { ok: false, detail: 'still stale after the job: ' + [...st0.stalePages].join(',') + ' (was ' + staleBefore.join(',') + ')' };
        /* A mount now needs no render: the warm rebuilt the deferred pages in the park. */
        const target = staleBefore.find((p) => !isMounted(p) && p <= st0.pageCount);
        if (target === undefined) return { ok: false, detail: 'no unmounted stale page to mount' };
        const warns2 = withWarnsCaptured(() => { H.renderer['mountPage'](target); });
        if (warns2.length) return { ok: false, detail: 'warnings at mount: ' + warns2.join(' | ') };
        if (!isMounted(target)) return { ok: false, detail: 'page ' + target + ' did not mount' };
        if (overflowing().length) return { ok: false, detail: 'page ' + overflowing().join(',') + ' past the paper' };
        return { ok: true };
      })()` },
  ],
};
