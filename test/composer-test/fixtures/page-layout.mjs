// Composer test fixtures — page-layout.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

/** Pagination fixtures: a piano + viola score builder (page view). `full`
 *  ranges get both instruments, `solo` ranges the viola alone (piano cells
 *  left empty for hide-empty). `flagHide(lo, hi)` toggles the hide-empty flag
 *  on the piano cells of measures [lo, hi). */
const PAG_BUILD = `
  const N = (o, midi) => ({ q: 0, r: 0, pname: 'a', accid: '', oct: o, midi, colorHex: '#888', velocity: 80 });
  const build = (ranges) => {
    m.addInstrument({ name: 'Viola', staffCount: 1 });
    const total = Math.max(...Object.values(ranges).map((rg) => rg[1]));
    m.setVoice(5); m.setCursor(0, 5);
    for (let i = 0; i < 4 * total; i++) m.insertChordAtCursor({ notes: [N(4, 69)], duration: '4', dots: 0 });
    for (const [name, rg] of Object.entries(ranges)) {
      if (!name.startsWith('full')) continue;
      m.setVoice(1); m.setCursor(m.getMeasureStartCursor(rg[0], 1), 1);
      for (let i = 0; i < 4 * (rg[1] - rg[0]); i++) m.insertChordAtCursor({ notes: [N(5, 81)], duration: '4', dots: 0 });
    }
  };
  const flagHide = (lo, hi) => {
    const cells = [];
    for (let mi = lo; mi < hi; mi++) cells.push({ measureIdx: mi, staffN: 1 }, { measureIdx: mi, staffN: 2 });
    m.toggleEmptyFlag(cells, 'hide-empty');
  };
`;

/* ── Manual line breaks (2026-09-11, linebreakCommands.ts / render/lockmarks.ts) ──
 * Page-view doc of 12 quarter-note bars → two owned lines [0..5] [6..11] (the
 * same shape as PAGE_LINEBREAKS). Every command must take the REFILL path
 * (never a derive), land as a splice, and leave a padlock at the end of the
 * system whose successor line starts at the lock. `window.__lockPre` holds the
 * pre-command partition for the assertions. */
const lockSetup = (chords) => `
  const sel = document.getElementById('viewModeSelect');
  if (sel.value !== 'page') { sel.value = 'page'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  m.setCursor(0, 1);
  const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
  for (let i = 0; i < ${chords}; i++) { const high = (Math.floor(i / 4) % 2) === 0; m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 }); }
  r();
  { const pb = window.__hkl_composer.renderer['pageBreaks']; for (let i = 0; i < 3 && !pb.ownershipActive(); i++) r(); }
  { const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
    window.__lockPre = window.__hkl_composer.renderer['pageBreaks'].lineStarts().map((id) => ids.indexOf(id)); }
`;

const LOCK_SETUP = lockSetup(48);

const LOCK_SETUP_18 = lockSetup(72);

/* The partition spec's justification rule (2026-10-20), read off the mounted
 * systems: every system but the document's last is justified, and the last is
 * justified exactly when the owner says so (`finalSystemJustified`: its section
 * was balanced by F, or it stayed greedy at fill ≥ 0.70). An expression taking
 * the renderer; '' when the rule holds, else what broke. */
const JUSTIFY_RULE = `((r) => {
  if (typeof r.mountAllPages === 'function') r.mountAllPages();
  const pb = r['pageBreaks'];
  const ws = [...document.querySelectorAll('#score .score-page:not(.score-page-pending) g.system')].map((g) => g.getBBox().width);
  if (ws.length < 2) return 'only ' + ws.length + ' systems';
  const max = Math.max(...ws), last = ws[ws.length - 1], fmt = ws.map((w) => Math.round(w)).join(',');
  if (ws.slice(0, -1).some((w) => w < 0.98 * max)) return 'a non-final system is unjustified: ' + fmt;
  const want = pb.finalSystemJustified();
  if (want === null) return 'finalSystemJustified unknown';
  if (want !== (last >= 0.98 * max)) return 'the last system ' + (want ? 'should be justified' : 'should be at natural width') + ': ' + fmt;
  return '';
})`;

/* Uniform test material: `bars` 4/4 bars of quarters alternating a high
 * ledger-line bar and a mid-staff bar (varying system heights), optionally a
 * section header before measure `headerAt`. */
const partfDoc = (bars, headerAt = -1) => `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 4 * ${bars}; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      ${headerAt >= 0 ? `m.setSectionHeaderAt(${headerAt}, 'II');` : ''}
      r();`;

/* Shared in-page helpers for the partition-F assertions. */
const PARTF_LIB = `
        const H = window.__hkl_composer, m = H.model, r = H.renderer, pb = r['pageBreaks'];
        const settle = async () => {
          await window.__waitForRender();
          for (let i = 0; i < 500; i++) { const b = document.getElementById('renderBusy'); if (!b || b.hidden) break; await new Promise((res) => setTimeout(res, 20)); }
          await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        };
        const J = JSON.stringify;
        const ids = () => m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const state = () => {
          if (typeof r.mountAllPages === 'function') r.mountAllPages();
          /* Where each measure is ON ITS PAGE (client rect relative to the card):
             a system's local coordinates depend on the Verovio window it was
             engraved in, its placement is a transform above it. */
          const geom = {};
          for (const el of document.querySelectorAll('#score .score-page:not(.score-page-pending) g.measure')) {
            const pg = el.closest('.score-page'); const b = el.getBoundingClientRect(), c = pg.getBoundingClientRect();
            geom[el.id] = [pg.dataset.page, +(b.left - c.left).toFixed(1), +(b.top - c.top).toFixed(1), +b.width.toFixed(1), +b.height.toFixed(1)];
          }
          return { lines: pb.lineStarts().join(), pages: pb.pageStarts().join(), geom };
        };
        const geomDiff = (a, b) => { const out = []; for (const id of Object.keys(a)) if (J(a[id]) !== J(b[id])) out.push(id + ' ' + J(a[id]) + ' -> ' + J(b[id])); for (const id of Object.keys(b)) if (!(id in a)) out.push(id + ' new'); return out; };
        const isF = () => { const F = pb.partitionOfDocument(m); return !!F && F.join() === pb.lineStarts().join(); };
        const noFull = () => r.renderLedger().filter((e) => e.full).map((e) => e.deriveReason || e.skipReason || '?');
`;

export const FIXTURES = {
  /* Page view stacks multiple systems whose heights are content-dependent, so
   * each lands at its own sub-pixel device-y phase — staff lines would blur
   * differently per system. renderer.snapSystems() lands every system on the
   * grid (crisp). This builds a multi-system page (alternating high-ledger /
   * mid notes → varying system heights) at the default 100% preset (2px lines →
   * integer phase) and asserts EVERY system's staff lines share the on-grid
   * phase. Asserted in FIXTURE_ASSERTIONS.pageViewMultiSystemCrisp. */
  pageViewMultiSystemCrisp: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 48; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [high ? mk('g', 6) : mk('b', 4)], duration: '4', dots: 0 });
      }
      r();
    `,
    visualBaseline: 'pageview_multisystem_crisp',
    visualFullPage: true,
  },
  /* Per-document "Page size" (pageScale): scaling the page rectangle enlarges
   * the paper on screen and reflows bars per system while EVERY note keeps its
   * on-screen size (content size is owned by zoom, not pageScale). Builds a
   * multi-measure page, sets pageScale 140%, and reRenders. Asserted in
   * FIXTURE_ASSERTIONS.pageScaleGrowsPageNotContent (page SVG ~1.4× wider, note
   * glyph unchanged, persisted as page-scale="140"). Visual baseline pins the
   * 140% look + crispness. */
  pageScaleGrowsPageNotContent: {
    setup: `
      m.setCursor(0, 1);
      const mk = (o) => ({ q: 0, r: 0, pname: 'b', accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 24; i++) m.insertChordAtCursor({ notes: [mk(4)], duration: '4', dots: 0 });
      m.setPageScale(140);
      r();
    `,
    visualBaseline: 'pagescale_140',
    visualFullPage: true,
  },

  /* ── Page-view line-break ownership (render/linebreaks.ts) ────── */
  /* Multi-system page doc; an edit near a boundary must take the REFILL path
   * (not derive) and render breaks:'line' with the owner's pins honored
   * VERBATIM — every rendered system starts exactly at a pinned measure, in
   * order. The visual baseline pins the refilled look. Asserted via
   * FIXTURE_ASSERTIONS.pageLineBreaksRefill. */
  pageLineBreaksRefill: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 48; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();   /* derive render — arms partition adoption (finished synchronously
                by the first refill attempt) */
    `,
    visualBaseline: 'page_linebreaks_refill',
    visualFullPage: true,
  },
  /* Ruling ii (decisions.md 2026-08-30, Phase C-B): a local edit that leaves the
   * document's widths unchanged must never move a line boundary. Inserts a
   * quarter into a half-full final measure (no overflow), renders, deletes it
   * again, renders — the partition must be identical at every step, and both
   * renders must take the refill path. Asserted via
   * FIXTURE_ASSERTIONS.pageLineBreaksNoopDeterminism. */
  pageLineBreaksNoopDeterminism: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 46; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();   /* 11.5 bars — the last measure has room for the round-trip insert */
    `,
  },
  /* The virtualized page rebuild momentarily collapses every non-first page
   * to a zero-height div; the forced layout that measures page 1 then CLAMPS
   * the container's scrollTop to the one-page extent (probe-confirmed on the
   * sonata: 25392 → 2744 across a content-identical edit). renderPage now
   * captures and restores the scroll position inside the same synchronous
   * block. This fixture builds a multi-PAGE doc (big enough that the edit's
   * possible one-line merge cannot shrink the extent below the scroll
   * offset — a genuinely shorter doc re-clamps by design), scrolls to
   * page 2, edits there, and asserts the scroll held. Asserted via
   * FIXTURE_ASSERTIONS.pageEditPreservesScroll. */
  pageEditPreservesScroll: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      /* The assertion needs >= 3 pages to exist, so a one-line merge cannot
         shrink the scroll extent below the offset. 240 quarter-note inserts gave
         that at the old unit-9/10 presets and only 2 pages once the crisp
         presets moved to a constant unit 8 (~11 % smaller notation ⇒ ~19 % fewer
         pages). Buying the third page with MORE CONTENT is the wrong lever —
         the insert loop is superlinear, and 480 inserts cost 235 s on its own,
         more than the entire rest of the suite. Shrink the PAPER instead:
         pageScale scales only the page rectangle, so the same 240 inserts span
         more pages at a fraction of the setup cost, and it keeps the fixture
         off a page boundary regardless of future preset density changes. */
      m.setPageScale(70);
      for (let i = 0; i < 240; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
    /* The cursor walk would scroll every one of those stops into view across
       several pages (minutes) and tests nothing about scroll preservation —
       covered by every other fixture. */
    skipCursorTrace: true,
  },
  /* USER PAGE BREAK reflow (Max, 2026-08-31). A Ctrl+B page break must (a) split
   * its line when it lands mid-system, and (b) cause everything after it to
   * RE-PACK by height — the old behaviour layered the <pb> on top of an
   * unchanged page pinning, so a break before a page's last line left a page
   * holding that single line and our page list one short of the DOM. Enough
   * content (with a shrunken page) for several pages, so a break has somewhere
   * to cascade. Asserted via FIXTURE_ASSERTIONS.pageUserBreakReflows. */
  pageUserBreakReflows: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      m.setPageScale(70);
      for (let i = 0; i < 240; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
    skipCursorTrace: true,
  },
  /* THE reversibility gate (Max, 2026-08-30): the partition is never
   * re-derived, only repaired when an edit makes a line illegal — so a note
   * delete must move NO boundary, and Ctrl+Z must restore the layout
   * bit-for-bit. (The predecessor greedy refill re-derived and accepted any
   * line up to FIT_MAX, so a deletion pulled a measure into the line and undo
   * left it there — layout drifted one measure per edit and never drifted
   * back.) Asserted via FIXTURE_ASSERTIONS.pageLineBreaksUndoRestoresLayout. */
  pageLineBreaksUndoRestoresLayout: {
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
  /* A user break toggle used to refuse the refill (userBreakSig guard) and
   * derive; since 2026-10-08 ("Every edit is a splice") a page break is a
   * partition edit the refill carries — a hard line AND page start — and the
   * render is a splice. Asserted via FIXTURE_ASSERTIONS.pageLineBreaksDeriveFallback. */
  pageLineBreaksDeriveFallback: {
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
  /* ── Section balancing (render/balance.ts, 2026-09-05) ──
   * Verovio's castoff leaves every section's remainder as its final line — a
   * lone bar justified across the page before a section break, a one-bar stub
   * at the end of the document. The balancer redistributes a section whose
   * final line is below MIN_FILL: synchronously for the first pages before the
   * first paint, in an idle job for the rest, and on the edit path for the
   * sections an edit touches. Documents here are 4-quarter bars (~0.15 of a
   * line each; 5–6 per system), so 13 bars cast off as 6+6+1. */

  /* 13-bar section I (castoff 6+6+1: a lone bar before the section break) +
   * 9-bar section II (castoff 6+3: a sparse document-final line). Both are
   * balanced before the first paint: no lone-bar system, every section-final
   * line legal, every system justified to the same width. Asserted via
   * FIXTURE_ASSERTIONS.pageBalanceSectionFinal. */
  /* Single-part view is OWNED and balanced like the score (2026-09-05, Max's
     backlog item): a piano + viola document whose viola part (voice 5) has
     the same 13 + 9 bar shape as pageBalanceSectionFinal, viewed viola-only
     through the real selector. The filtered render must engage the line-break
     owner, balance its sections before the paint and show only staff 3. */
  pageBalanceSinglePartView: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      m.addInstrument({ name: 'Viola', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5);
      for (let i = 0; i < 4 * 22; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 5 : 3)], duration: '4', dots: 0 });
      }
      m.setSectionHeaderAt(13, 'II');
      m.setVoice(1); m.setCursor(0, 1);
      r();
      const sel = document.getElementById('viewInstrSelect');
      sel.value = '1'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    `,
    skipCursorTrace: true,
    fullRender: 'a view change re-engraves by design (forceFullRerender); the owner adopts the filtered layout from it',
  },
  /* …and an edit in that view splices, exactly as in the full score. */
  pageSinglePartViewEditSplices: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      m.addInstrument({ name: 'Viola', staffCount: 1 });
      m.setVoice(5); m.setCursor(0, 5);
      for (let i = 0; i < 4 * 22; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 5 : 3)], duration: '4', dots: 0 });
      }
      m.setSectionHeaderAt(13, 'II');
      m.setVoice(1); m.setCursor(0, 1);
      r();
      const sel = document.getElementById('viewInstrSelect');
      sel.value = '1'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    `,
    skipCursorTrace: true,
    fullRender: 'the view change re-engraves by design; the edit in the assertion must NOT (asserted there)',
  },
  pageBalanceSectionFinal: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 4 * 22; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      m.setSectionHeaderAt(13, 'II');
      r();
    `,
    visualBaseline: 'page_balance_section_final',
    visualFullPage: true,
    skipCursorTrace: true,
  },
  /* 13-bar section I + 8-bar section II. Section II is the FINAL section and
   * greedy needs only two lines for it (6+2), so F keeps it greedy — the
   * small-document rule that replaced MIN_FILL (partition spec, 2026-10-20) —
   * rather than balancing it to [4,4] as the old balancer did, and its sparse
   * last system stays at natural width (fill < 0.70). Asserted via
   * FIXTURE_ASSERTIONS.pageBalanceDocFinalSmallDocKeepsStub. */
  pageBalanceDocFinalSmallDocKeepsStub: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 4 * 21; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      m.setSectionHeaderAt(13, 'II');
      r();
    `,
    skipCursorTrace: true,
  },
  /* The short-final-section rule (Max's rule 2 of 2026-09-18, restated by the
   * partition spec 2026-10-20): a FINAL section of fewer than three greedy
   * lines stays greedy, and its last system is justified only at fill ≥ 0.70.
   * 13 bars of section I + a 2-bar section II, whose whole content is ~0.35 of
   * a line: one line, kept as it is, at natural width. Asserted via
   * FIXTURE_ASSERTIONS.pageBalanceRule2StubKept. */
  pageBalanceRule2StubKept: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 4 * 15; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      m.setSectionHeaderAt(13, 'II');
      r();
    `,
    skipCursorTrace: true,
  },
  /* Edit path, composing at the end: bars are appended until greedy needs a
   * new line; F re-partitions the section (3+ lines: picked from the curve, so
   * its last system is justified), on the splice path, and the result is F of
   * the document. Asserted via FIXTURE_ASSERTIONS.pageBalanceComposeAtEnd. */
  pageBalanceComposeAtEnd: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 4 * 21; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
    `,
    skipCursorTrace: true,
  },
  /* A splice whose window opens exactly at a movement boundary: the hunk is
   * section II's first line, so the window is a synthetic mRest LEADER followed
   * by the restart scoreDef and its label-replacement scoreDef. The leader must
   * have the HEAD scoreDef's staff count — counting the label-only staffDefs
   * gave a 3-staff score a 5-staff leader and Verovio a null-function crash on
   * loadData (2026-09-05, found by the sonata battery once the balancer let a
   * hunk start at the boundary). Asserted via
   * FIXTURE_ASSERTIONS.pageSpliceLeaderAtSectionRestart. */
  pageSpliceLeaderAtSectionRestart: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 4 * 26; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      m.setSectionHeaderAt(17, 'II');
      r();
    `,
    skipCursorTrace: true,
  },
  /* Edit path, deleting at a section end: section I (17 bars, castoff 6+6+5 —
   * legal, so the sync balance leaves it alone and the idle job only warms its
   * naturals) has the notes of its last bars deleted until its final line falls
   * below MIN_FILL; the balancer repairs it locally (a bar pulled back or the
   * line folded), on the splice path. Asserted via
   * FIXTURE_ASSERTIONS.pageBalanceDeleteAtSectionEnd. */
  pageBalanceDeleteAtSectionEnd: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 4 * 26; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      m.setSectionHeaderAt(17, 'II');
      r();
    `,
    skipCursorTrace: true,
  },
  /* Sub-measure widening (2026-09-19). 20 whole rests in voice 1 castoff to
   * two lines; voice 3 then takes quarter rests from bar 11, widening measures
   * IN PLACE — no measure count change, no lock, so the old `structural` flag
   * was false on every keystroke and the balance gate (`!force && lastFill >=
   * MIN_FILL`) held the divisions. Only the section-final line's MIN was ever
   * checked, never a max, so the line compressed to fill 1.433 across 26
   * consecutive keystrokes while a fresh derive wanted three lines from the
   * 4th on; it escaped only when FIT_MAX tripped the REPAIR loop. Undo then
   * appeared to break its contract because the layout on screen had never been
   * the one the content implied. The gate is gone: every touched section
   * rebalances, always. Asserted via
   * FIXTURE_ASSERTIONS.pageBalanceSubMeasureWiden. */
  pageBalanceSubMeasureWiden: {
    setup: `
      m.setCursor(0, 1);
      for (let i = 0; i < 20; i++) m.insertRestAtCursor({ duration: '1', dots: 0 });
      r();
    `,
    skipCursorTrace: true,
  },
  /* ── Pagination (decisions.md "Composer draws the pages", 2026-10-08) ──
     Pages are first-fit over measured system heights. The builder makes a
     piano + viola score in page view: `full` measures carry both instruments,
     `solo` measures only the viola (piano cells empty, so they can be flagged
     hide-empty — a one-staff system is ~40 % the height of a three-staff one,
     which is exactly the castoff's blind spot: Verovio cast off the full
     height, Composer substituted the short system, and the hole it left was
     never reclaimed — sonata p. 7). */
  pag_hideEmptyNoHole: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      ${PAG_BUILD}
      build({ full: [0, 12], solo: [12, 44], full2: [44, 60] });
      flagHide(12, 44);
      m.setVoice(1); m.setCursor(0, 1);
      r();
    `,
    skipCursorTrace: true,
  },
  /* An edit that SHRINKS systems (Ctrl+H on viola-only lines) must pull the
     next page's first system up when it fits. */
  /* A line that GROWS past its page's bottom spills onto the next page; the
   * same line shrinking back must RETURN to the page it left. Pagination is a
   * function of the stored extents alone (first-fit), never of the edit
   * history: after the second edit the document is what it was, so the pages
   * must be too. Caught the repagination starting at the spilled line's NEW
   * page, which never offered it back to the page before (2026-10-08). The
   * universal first-fit invariant fails on the under-full page; the fixture's
   * own assertion fails on the system counts. */
  pag_spillThenPullBack: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      /* pageSectionHeaderOwnLine's document: page 1 closes with ~1700 units of
         slack under its 6th line, so growing that line at both extremes spills
         it (a 3-staff build left a system's worth of slack and never did). */
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 200; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      m.setSectionHeaderAt(Math.floor(m.allMeasures().length / 2), 'II');
      r();
      window.__hkl_composer.renderer.runExtentsJobNow();   /* finish the assembly: every page committed */
      const pb = window.__hkl_composer.renderer['pageBreaks'];
      const pst = pb.pageStarts();
      if (pst.length < 2) throw new Error('need 2+ pages, got ' + pst.length);
      const li = pb['startIds'].indexOf(pst[1]) - 1;        /* last line of page 1 */
      const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
      const mi = ids.indexOf(pb['startIds'][li]);
      const counts = () => [...document.querySelectorAll('#score .score-page')].map((p) => p.querySelectorAll('g.system').length);
      window.__pagCountsBefore = counts();
      const cur = m.getMeasureStartCursor(1, mi)   /* (voice, measure) */;
      m.setCursor(cur, 1);
      m.replaceChordAtCursor({ notes: [mk('c', 0), mk('g', 8)], duration: '4', dots: 0 });   /* grow: spills */
      r();
      window.__pagCountsGrown = counts();
      m.setCursor(cur, 1);
      const high = (mi % 2) === 0;
      m.replaceChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });   /* and back */
      r();
    `,
    skipCursorTrace: true,
  },
  /* A key change at the start of a line makes Verovio draw an end-of-line
   * COURTESY signature in the measure before it — generated by the line that
   * FOLLOWS. The assembly renders one line per window, so the window must
   * carry that next measure as a pinned stub (the splicer's B3 rule), or the
   * live page draws no courtesy where a full engrave does. Found by the
   * sonata's reference gate (m. 47→48, two flats to five sharps: 681 units of
   * width the live line lacked; 8 of 31 pages off the reference on a fresh
   * load, key and meter courtesies alike), 2026-10-08. */
  /* ── Every edit is a splice (decisions.md "Every edit is a splice",
   * 2026-10-08). A page break, a section header or a meter change never
   * affects a page before it, so page 1's systems must be the SAME DOM nodes
   * afterwards and nothing may full-render; Setup apply redraws headers only;
   * add instrument is the one all-lines edit and says so. The edit happens in
   * the assertion so the suite's own ledger sees it. */
  pag_pageBreakSplices: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 200; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
      window.__hkl_composer.renderer.runExtentsJobNow();
    `,
    skipCursorTrace: true,
  },
  pag_sectionHeaderSplices: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 200; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
      window.__hkl_composer.renderer.runExtentsJobNow();
    `,
    skipCursorTrace: true,
  },
  pag_meterChangeSplices: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 200; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
      window.__hkl_composer.renderer.runExtentsJobNow();
    `,
    skipCursorTrace: true,
  },
  pag_setupApplyKeepsSystems: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 200; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
      window.__hkl_composer.renderer.runExtentsJobNow();
    `,
    skipCursorTrace: true,
  },
  pag_addInstrumentAllLines: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 200; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      r();
      window.__hkl_composer.renderer.runExtentsJobNow();
    `,
    skipCursorTrace: true,
  },
  /* ── Page cards and the cascade (Max, 2026-10-08): the number of rendered
   * page cards is known at first paint and changes only when the calculation
   * says the total differs; a page shows its content only once its systems are
   * placed. The lazy assembly used to start as one card and grow (the scroll
   * jumped on every load and zoom) and painted the open page while its
   * systems were still being appended (staves overlapping). */
  pag_loadCardsUpFront: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 800; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      m.setCursor(0, 1);   /* cursor on page 1: the synchronous burst stops there */
      r();
      /* Synchronous part only: page 1 is closed, the rest is idle slices. */
      window.__pagCardsAtPaint = document.querySelectorAll('#score .score-page').length;
      window.__pagBuildingHidden = (() => { const b = document.querySelector('#score .score-page-building'); return b ? getComputedStyle(b).visibility : 'none'; })();
    `,
    skipCursorTrace: true,
  },
  pag_zoomKeepsCardsAndScroll: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 800; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      m.setCursor(0, 1);   /* cursor on page 1: the synchronous burst stops there */
      r();
      window.__hkl_composer.renderer.runExtentsJobNow();
      const score = document.getElementById('score');
      const p4 = document.querySelector('#score .score-page[data-page="4"]');
      score.scrollTop = p4.offsetTop - score.offsetTop;
      window.__pagScrollBefore = score.scrollTop;
      window.__pagCardsBefore = document.querySelectorAll('#score .score-page').length;
      /* The zoom render may be deferred behind the badge: capture at the
         moment the render lands, inside the render call itself. */
      const rr = window.__hkl_composer.renderer; const orig = rr.renderComposer;
      rr.renderComposer = function (...a) { const res = orig.apply(this, a); rr.renderComposer = orig; window.__pagCardsAtPaint = document.querySelectorAll('#score .score-page').length; window.__pagScrollAtPaint = score.scrollTop; return res; };
      window.__hkl_composer.renderer.setZoom(50); r();
    `,
    skipCursorTrace: true,
  },
  pag_buildingPageHidden: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 800; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      m.setCursor(0, 1);   /* cursor on page 1: the synchronous burst stops there */
      r();
      /* 40 lines: page 1 closes synchronously, the rest is in flight. */
      const b = document.querySelector('#score .score-page-building');
      window.__pagBuildingVisibility = b ? getComputedStyle(b).visibility : 'no building page';
      window.__pagPendingAtPaint = document.querySelectorAll('#score .score-page-pending').length;
      window.__pagCardsAtPaint = document.querySelectorAll('#score .score-page').length;
    `,
    skipCursorTrace: true,
  },
  /* Zoom is visual-only (Max): the inner SVG coordinates, viewBox and margin
   * are identical at every zoom; only the card's outer size and the device-grid
   * placement differ. A zoom therefore re-renders NOTHING — the shells are
   * resized and every page re-snapped and re-placed in place (2026-10-08, the
   * 20 s Firefox zoom). Asserted via FIXTURE_ASSERTIONS.pag_zoomRescalesInPlace. */
  pag_zoomRescalesInPlace: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 400; i++) {
        const high = (Math.floor(i / 4) % 2) === 0;
        m.insertChordAtCursor({ notes: [mk(high ? 'g' : 'b', high ? 6 : 4)], duration: '4', dots: 0 });
      }
      m.setCursor(0, 1);
      window.__hkl_composer.renderer.setZoom(100);   /* explicit start */
      r();
      window.__hkl_composer.renderer.runExtentsJobNow();
    `,
    skipCursorTrace: true,
  },
  pag_courtesyAtLineEnd: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 48; i++) m.insertChordAtCursor({ notes: [mk('b', 4)], duration: '4', dots: 0 });
      r();
      window.__hkl_composer.renderer.runExtentsJobNow();
      const pb = window.__hkl_composer.renderer['pageBreaks'];
      if (pb['startIds'].length < 2) throw new Error('need 2+ lines, got ' + pb['startIds'].length);
      const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
      const mi = ids.indexOf(pb['startIds'][1]);          /* line 2's first measure */
      /* Lock the boundary: the courtesy widens line 1's last measure, and an
         unlocked refill answers by moving that measure down — the change would
         no longer start a line and nothing would generate a courtesy. */
      m.setLineLockAt(mi, true);
      m.setKeySigAt(mi, '5s', 'major');
      r();
      window.__hkl_composer.renderer.runExtentsJobNow();
      window.__courtesyPrevId = ids[mi - 1];
    `,
    skipCursorTrace: true,
  },
  pag_shrinkPulls: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      ${PAG_BUILD}
      build({ full: [0, 12], solo: [12, 44], full2: [44, 60] });
      m.setVoice(1); m.setCursor(0, 1);
      r();
      window.__pagPagesBefore = document.querySelectorAll('#score .score-page').length;
      window.__pagP1Before = document.querySelector('#score .score-page[data-page="1"]').querySelectorAll('g.system').length;
      flagHide(12, 44);
      r();
    `,
    skipCursorTrace: true,
  },
  /* The reverse edit GROWS systems (hide-empty off): a page that no longer
     holds its systems pushes the tail on. */
  pag_growPushes: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      ${PAG_BUILD}
      build({ full: [0, 12], solo: [12, 44], full2: [44, 60] });
      flagHide(12, 44);
      m.setVoice(1); m.setCursor(0, 1);
      r();
      window.__pagPagesBefore = document.querySelectorAll('#score .score-page').length;
      flagHide(12, 44);   /* toggle OFF */
      r();
    `,
    skipCursorTrace: true,
  },
  /* A user page break is a hard page start: the page before it may be
     under-full, and the page after it starts exactly there. */
  pag_userPbHonoured: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      ${PAG_BUILD}
      build({ full: [0, 24] });
      const cc = m.getMeasureStartCursor(1, 8); m.setCursor(cc, 1);   /* (voice, measure): the break goes before m9 */
      r();
    `,
    setupKeys: [{ key: 'b', ctrl: true }],
    skipCursorTrace: true,
  },
  /* A zoom RE-RUNS the post-process passes on every mounted page (rescale),
     and the second run must be a fixed point of the first (2026-10-18, Max:
     "I always zoom out to 50% after loading"; sonata III m. 24 LH slur grew
     "a needlessly large bulge", p. 15's first system grew 3.5 units and the
     document went from 29 pages to 31). The hidden state was the HEJI
     injection at the end of run 1: every accidental becomes a BravuraText
     `<text>` whose getBBox is the 8-unit character cell, and run 2's slur and
     instrument-gap passes read those cells as obstacles. Material: a flipped
     two-voice slur over flatted a5s (the flats' cells reach under the slur),
     low flatted piano-LH notes and high flatted viola notes at the boundary
     with a below-dynamic between them (the gap's ink floor). Asserted via
     FIXTURE_ASSERTIONS.pag_zoomRerunKeepsSlursAndGaps. */
  pag_zoomRerunKeepsSlursAndGaps: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      m.addInstrument({ name: 'Viola', staffCount: 1 });
      /* Lattice-consistent spellings (the render clone derives accidentals from q/r): a♭ = (-2, 1), e♭ = (-2, 2), b♭ = (-2, 3), c = (0, 0) + a fourth. */
      const N = (p, o, midi, accid = '', q = 0, r = 0) => ({ q, r, pname: p, accid, oct: o, midi, colorHex: '#888', velocity: 80 });
      /* Piano RH, voice 1: a slurred triplet of flatted a5s (stems up, beam +
         numeral above); voice 2: a c4 whole note → two-voice, slur flipped below. */
      m.setVoice(1); m.setCursor(0, 1);
      m.createTupletAtCursor({ num: 3, numbase: 2, atomicDur: '8', spanDur: '4', spanDots: 0 });
      m.setCursor(1, 1);
      m.insertChordAtCursor({ notes: [N('a', 5, 80, 'f', -2, 1)], duration: '8', dots: 0 });
      m.insertChordAtCursor({ notes: [N('a', 5, 80, 'f', -2, 1)], duration: '8', dots: 0 });
      m.insertChordAtCursor({ notes: [N('a', 5, 80, 'f', -2, 1)], duration: '8', dots: 0 });
      m.setVoice(2); m.setCursor(0, 2);
      m.insertChordAtCursor({ notes: [N('c', 4, 60, '', 1, -1)], duration: '1', dots: 0 });
      /* Piano LH, voice 3: low flatted quarters (ledger lines + flats below the staff). */
      m.setVoice(3); m.setCursor(0, 3);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [N('e', 2, 39, 'f', -2, 2)], duration: '4', dots: 0 });
      /* Viola, voice 5: high flatted quarters (ledger lines + flats above the staff). */
      m.setVoice(5); m.setCursor(0, 5);
      for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [N('b', 5, 82, 'f', -2, 3)], duration: '4', dots: 0 });
      const doc = m.getDoc();
      const MEI = 'http://www.music-encoding.org/ns/mei';
      const notes = [...doc.querySelectorAll('staff[n="1"] layer[n="1"] tuplet note')];
      const sl = doc.createElementNS(MEI, 'slur');
      sl.setAttribute('xml:id', 's-test-zoom-rerun'); sl.setAttribute('startid', '#' + notes[0].getAttribute('xml:id')); sl.setAttribute('endid', '#' + notes[2].getAttribute('xml:id')); sl.setAttribute('data-voice', '1');
      const meas = doc.querySelector('measure');
      meas.appendChild(sl);
      const d = doc.createElementNS(MEI, 'dynam'); d.setAttribute('xml:id', 'd-test-zoom-rerun'); d.setAttribute('tstamp', '1'); d.setAttribute('place', 'below'); d.setAttribute('staff', '2'); d.textContent = 'mf';
      meas.appendChild(d);
      /* Enough plain measures for several lines: the in-place rescale (the path
         under test) stands down on a one-line document and full-renders instead. */
      m.setVoice(1); m.setCursor(m.getVoiceLength(1), 1);
      for (let i = 0; i < 4 * 14; i++) m.insertChordAtCursor({ notes: [N('c', 5, 72, '', 1, -1)], duration: '4', dots: 0 });
      m.setVoice(5); m.setCursor(m.getVoiceLength(5), 5);
      for (let i = 0; i < 4 * 14; i++) m.insertChordAtCursor({ notes: [N('c', 4, 60, '', 1, -1)], duration: '4', dots: 0 });
      m.setVoice(1); m.setCursor(0, 1);
      window.__hkl_composer.renderer.setZoom(100);   /* explicit start */
      r();
      window.__hkl_composer.renderer.runExtentsJobNow();
    `,
    skipCursorTrace: true,
  },
  /* A zoom round-trip is visual-only: the same pages come back. */
  pag_zoomRoundTripKeepsPages: {
    setup: `
      window.__hkl_composer.renderer.setViewMode('page');
      ${PAG_BUILD}
      build({ full: [0, 12], solo: [12, 44], full2: [44, 60] });
      flagHide(12, 44);
      m.setVoice(1); m.setCursor(0, 1);
      r();
      /* pageStarts() is a PREFIX while pages are still closing (the assembly is
         synchronous only to the cursor's page, idle slices after): finish it
         before reading, else "before" is page 1 alone and "after" the whole list. */
      window.__hkl_composer.renderer.runExtentsJobNow();
      window.__pagStartsBefore = JSON.stringify(window.__hkl_composer.renderer['pageBreaks'].pageStarts());
      window.__hkl_composer.renderer.setZoom(50); r(); window.__hkl_composer.renderer.runExtentsJobNow();
      window.__hkl_composer.renderer.setZoom(100); r(); window.__hkl_composer.renderer.runExtentsJobNow();
    `,
    skipCursorTrace: true,
  },

  // 12 bars → [0..5] [6..11]
         // 18 bars → [0..5] [6..11] [12..17]
  /* Alt+Shift+↓ mid-system (m8 of [7..12]): a lock before m8; m8–12 form the
   * final section. The 7 bars before the lock (greedy 6+1) are a non-final
   * section, so F balances them into two lines [3,4] — no lone bar and no
   * compressed line (the old merge rule folded them onto one line at ~1.1). */
  lock_down_splits: {
    setup: LOCK_SETUP + `m.setCursor(m.getMeasureStartCursor(1, 7), 1);`,
    setupKeys: [{ key: 'ArrowDown', alt: true, shift: true }],
    visualBaseline: 'lock_down_splits',
    visualFullPage: true,
  },
  /* Alt+Shift+↓ at a system start (m7): the existing boundary is locked and
   * nothing moves. */
  lock_down_at_start_locks_only: {
    setup: LOCK_SETUP + `m.setCursor(m.getMeasureStartCursor(1, 6), 1);`,
    setupKeys: [{ key: 'ArrowDown', alt: true, shift: true }],
  },
  /* Alt+Shift+↓ at m9 of the 12-bar doc: the two-bar remainder m7–8 is too
   * sparse to stand, too wide to merge (8 bars > MERGE_MAX) and the 8-bar
   * section has no legal two-line split — the balancer reports 'no legal
   * balance: section kept' and the remainder stays. Deterministic, and exactly
   * what any measure edit would get. */
  lock_down_sparse_remainder_kept: {
    setup: LOCK_SETUP + `m.setCursor(m.getMeasureStartCursor(1, 8), 1);`,
    setupKeys: [{ key: 'ArrowDown', alt: true, shift: true }],
  },
  /* Alt+Shift+↓ at m15 of the 18-bar doc: the 14-bar section [m1..m14]
   * rebalances from [6,6,2] into three legal lines ([4,5,5] → starts 0,4,9) —
   * the ordinary balancer, no side channel. */
  lock_down_rebalances_section: {
    setup: LOCK_SETUP_18 + `m.setCursor(m.getMeasureStartCursor(1, 14), 1);`,
    setupKeys: [{ key: 'ArrowDown', alt: true, shift: true }],
  },
  /* Refusals leave the document and the partition alone. */
  lock_down_first_measure_refused: {
    setup: LOCK_SETUP + `m.setCursor(m.getMeasureStartCursor(1, 0), 1);`,
    setupKeys: [{ key: 'ArrowDown', alt: true, shift: true }],
  },
  /* Undo restores the exact pre-command partition (a layout snapshot on the
   * history entry, not a repair); redo restores the post-command one. */
  lock_undo_restores_partition: {
    setup: LOCK_SETUP + `m.setCursor(m.getMeasureStartCursor(1, 7), 1);`,
  },
  /* The padlock click removes the <sb>: the two sections join and F
   * re-partitions them as one — the layout a reload of the unlocked document
   * engraves (partition spec G1; this was "pin removed only" until
   * 2026-10-20, a layout no reload could reproduce). */
  lock_click_unlocks_keeps_layout: {
    setup: LOCK_SETUP + `m.setCursor(m.getMeasureStartCursor(1, 7), 1);`,
    setupKeys: [{ key: 'ArrowDown', alt: true, shift: true }],
  },
  /* Scroll view: the command is refused, nothing changes. */
  lock_scroll_view_ignored: {
    setup: `
      const sel = document.getElementById('viewModeSelect');
      if (sel.value !== 'scroll') { sel.value = 'scroll'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 16; i++) m.insertChordAtCursor({ notes: [mk('g', 4)], duration: '4', dots: 0 });
      r();
      m.setCursor(m.getMeasureStartCursor(1, 2), 1);
    `,
    setupKeys: [{ key: 'ArrowDown', alt: true, shift: true }],
  },
  /* A lock exports as a MusicXML system break on the locked measure. */
  lock_export_new_system: {
    setup: LOCK_SETUP + `m.setCursor(m.getMeasureStartCursor(1, 7), 1);`,
    setupKeys: [{ key: 'ArrowDown', alt: true, shift: true }],
  },
  /* Zoom is visual-only (Max, 2026-09-12): a zoom round-trip goes through the
   * partition cache and must hand the owner back its width caches along with
   * the lines — before this, every natural went cold and the balancer declined
   * every section-final defect ('naturals incomplete') until reload. */
  page_zoom_roundtrip_keeps_widths: {
    setup: LOCK_SETUP_18 + `
      window.__lockNat0 = window.__hkl_composer.renderer['pageBreaks']['naturals'].size;
      window.__hkl_composer.renderer.setZoom(50); r();`,
    fullRender: 'the assertion zooms back to 100 (a cached-partition paint, not a derive) to leave the shared page as found',
  },
  /* The user-visible symptom: import at 100 %, zoom to 50 %, lock after the
   * first measure of system 3 — the orphaned bar must still fold/rebalance. */
  lock_after_zoom_reflows: {
    setup: LOCK_SETUP_18 + `
      window.__hkl_composer.renderer.setZoom(50); r();
      m.setCursor(m.getMeasureStartCursor(1, 13), 1);`,
    setupKeys: [{ key: 'ArrowDown', alt: true, shift: true }],
    fullRender: 'the assertion zooms back to 100 (a cached-partition paint, not a derive) to leave the shared page as found',
  },
  /* After a lock, an ordinary edit in the locked line moves no boundary and
   * the lock stays a line start. */
  lock_then_edit_keeps_lock: {
    setup: LOCK_SETUP + `m.setCursor(m.getMeasureStartCursor(1, 7), 1);`,
    setupKeys: [{ key: 'ArrowDown', alt: true, shift: true }],
  },

  /* ── Partition F (docs/composer-partition-consistency-spec.md, 2026-10-20) ──
   * The partition is one pure function of the document: these pin the
   * contracts that follow from it. */

  /* The sonata's m. 250 defect, small: a bar-count edit on a later page
   * re-partitions its section; undoing it restores partition, pagination and
   * geometry exactly (the suffix balance of the old edit path was a fixed
   * point of its own and kept the edited layout). */
  partF_laterPageEditUndo: {
    setup: partfDoc(110, 30),
    skipCursorTrace: true,
  },
  /* A chain of edits of every kind (bar inserts near the start and deep in a
   * section, a key change, a section header) then a restore of the load
   * snapshot: back to the load layout bit for bit. */
  partF_editUndoChain: {
    setup: partfDoc(80),
    skipCursorTrace: true,
  },
  /* Reload ≡ live: after edits, re-loading the serialized document lays it out
   * exactly as the live edit path did (G1: a reload never changes the screen). */
  partF_reloadEqualsLive: {
    setup: partfDoc(70, 25),
    skipCursorTrace: true,
    fullRender: 'the assertion reloads the document (a load is a full assembly by design)',
  },
  /* A tail stub repaired by a short reach: 19 uniform bars are greedy 6+6+6+1;
   * F re-divides only the last lines (a few boundaries), never the whole
   * section, and no line is compressed. */
  partF_tailStubShortReach: {
    setup: partfDoc(19),
    skipCursorTrace: true,
  },
  /* A measure wider than a line sits alone on its line (no compression of its
   * neighbours to make room, no split of the measure). */
  partF_wideMeasureAlone: {
    setup: `
      m.setCursor(0, 1);
      const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
      for (let i = 0; i < 4 * 17; i++) m.insertChordAtCursor({ notes: [mk('b', 4)], duration: '4', dots: 0 });
      /* Bar 9 in 32/4 (a 4/4 bar cannot get wider than ~0.96 of a line:
         64 sixty-fourths measured 18100 against an 18790 budget), 4/4 again
         from bar 10. */
      m.setMeterAt(8, 32, 4);
      m.setMeterAt(9, 4, 4);
      /* Fill it with notes (the meter change pads with long rests, which are
         narrow): 112 sixteenths before its 4 quarters. */
      m.setCursor(m.getMeasureStartCursor(1, 8), 1);
      for (let i = 0; i < 112; i++) m.insertChordAtCursor({ notes: [mk(i % 2 ? 'c' : 'a', 5)], duration: '16', dots: 0 });
      r();`,
    skipCursorTrace: true,
  },
  /* An early insert re-flows the whole tail of a long section while only
   * pages 1-2 are mounted: the unmounted pages are not engraved (deferred
   * cards, heights as they were), and mounting them one by one engraves each
   * and re-fits — at the end the pagination is first-fit and the partition F,
   * exactly as a fresh assembly would have it (Max, 2026-10-20). */
  /* A delete that makes a clef measure-initial: the clef is then DRAWN at the
   * end of the previous measure (model relocateInitialClefs), and `serialize`
   * saves it there — so a reload must find exactly the widths the live edit
   * path uses, or F re-breaks lines on reload (sonata m. 313, 2026-10-20). */
  partF_clefInitialReload: {
    setup: partfDoc(24) + `
      const flat = m['flatChildren'](1); const meas = m.allMeasures()[10];
      const first = flat.findIndex((el) => (el.localName === 'note' || el.localName === 'chord') && el.closest('measure') === meas);
      m.setClefAtCursor(1, first, 'F', '4', null, null);
      r();`,
    skipCursorTrace: true,
    fullRender: 'the assertion reloads the document (a load is a full assembly by design)',
  },
  partF_deferredTailMountsExact: {
    setup: partfDoc(160),
    skipCursorTrace: true,
  },
};


export const ASSERTIONS = {
  /* Page-size factor scales the page rectangle, not the content: at a fixed
   * zoom, the page SVG grows ~linearly with pageScale while a notehead's device
   * size is unchanged. Compares a 100% render to the 140% render, then restores
   * 140% so the VISUAL screenshot (captured after this) matches the baseline. */
  pageScaleGrowsPageNotContent: [
    { name: 'page grows ~1.4×, note glyph unchanged, value persists in MEI',
      expr: `(() => {
        const M = window.__hkl_composer, m = M.model;
        const pageW = () => { const s = document.querySelector('#score .score-page > svg'); return s ? s.getBoundingClientRect().width : 0; };
        const noteW = () => { const n = document.querySelector('#score g.notehead'); return n ? n.getBoundingClientRect().width : 0; };
        m.setPageScale(100); M.reRender();
        const p100 = pageW(), n100 = noteW();
        m.setPageScale(140); M.reRender();
        const p140 = pageW(), n140 = noteW();
        if (!p100 || !n100 || !p140 || !n140) return { ok: false, detail: 'missing metrics p100=' + p100 + ' n100=' + n100 + ' p140=' + p140 + ' n140=' + n140 };
        const pageRatio = p140 / p100;
        if (Math.abs(pageRatio - 1.4) > 0.06) return { ok: false, detail: 'page ratio=' + pageRatio.toFixed(3) + ' (expected ~1.4)' };
        if (Math.abs(n140 - n100) > 0.75) return { ok: false, detail: 'notehead size changed ' + n100.toFixed(2) + '→' + n140.toFixed(2) };
        if (m.getPageScale() !== 140) return { ok: false, detail: 'getPageScale=' + m.getPageScale() };
        if (!m.serialize().includes('page-scale="140"')) return { ok: false, detail: 'page-scale not serialized' };
        return { ok: true, detail: 'page ' + pageRatio.toFixed(3) + '×, note ' + n100.toFixed(1) + 'px unchanged, persisted' };
      })()` },
  ],
  /* Every system's staff lines must land on the device-pixel grid (crisp) in a
   * multi-system page, despite content-dependent system heights. At the 100%
   * preset (2px lines, even width) the target phase is integer (0). */
  pageViewMultiSystemCrisp: [
    { name: 'all systems land on the device-pixel grid (no cross-system drift)',
      expr: `(() => {
        const systems = [...document.querySelectorAll('#score g.system')];
        if (systems.length < 2) return { ok: false, detail: 'only ' + systems.length + ' system(s); need >=2 to test cross-system alignment' };
        const phases = [];
        for (const s of systems) {
          let line = null;
          for (const p of s.querySelectorAll('.staff path')) { try { if (p.getBBox().height < 1) { line = p; break; } } catch (e) {} }
          if (!line) continue;
          const c = line.getScreenCTM();
          phases.push(((c.f + line.getBBox().y * c.d) % 1 + 1) % 1);
        }
        /* 2px (even) lines are crisp on an integer phase → distance to nearest integer ~0. */
        const off = phases.filter(ph => Math.min(ph, 1 - ph) > 0.05).map(x => x.toFixed(3));
        if (off.length) return { ok: false, detail: phases.length + ' systems; off-grid: ' + off.join(',') };
        return { ok: true, detail: phases.length + ' systems all on-grid' };
      })()` },
  ],
  lock_down_splits: [
    { name: 'refill path (no derive), spliced, lock before m8 starts a line, pins in order, padlock drawn',
      expr: `(() => { const H = window.__hkl_composer, m = H.model, r = H.renderer, pb = r['pageBreaks'];
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const L = () => pb.lineStarts().map((id) => ids.indexOf(id));
        const pre = window.__lockPre;
        const status = () => (document.getElementById('composerStatus')?.textContent ?? '').trim();
        const locks = () => [...document.querySelectorAll('g.hkl-lock')].map((g) => ids.indexOf(g.getAttribute('data-for')));
        const last = () => r.renderLedger().slice(-1)[0] ?? {};
        const key = (k, o) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
        const pinsInOrder = () => {
          const starts = pb['startIds'] ?? []; const pos = new Map(starts.map((id, i) => [id, i]));
          let prevEnd = -1;
          for (const page of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
            const s = [...page.querySelectorAll('g.system')].map((g) => g.querySelector('g.measure')?.id).filter(Boolean);
            if (!s.length) continue;
            let at = pos.get(s[0]); if (at == null || at <= prevEnd) return false;
            for (let i = 1; i < s.length; i++) if (pos.get(s[i]) !== at + i) return false;
            prevEnd = at + s.length - 1;
          }
          return true;
        };
        const J = JSON.stringify;
        const l = L();
        /* The keystroke ran before the runner cleared the render ledger, so the
           splice outcome is read from the owner (derive reason '') and the
           runner's own splice invariant; last() is only detail here. */
        const ok = pb.lastDeriveReason === '' && m.hardBreakBefore(7) === 'lock' && l.includes(7) && !l.includes(6) && pinsInOrder() && J(locks()) === '[7]';
        return { ok, detail: J({ pre, lines: l, derive: pb.lastDeriveReason, ledger: last(), hb7: m.hardBreakBefore(7), locks: locks(), balance: pb.lastBalance, status: status() }) };
      })()` },
  ],
  lock_down_at_start_locks_only: [
    { name: 'locking an existing boundary moves nothing (partition unchanged, lastRefillLines 0) and draws the padlock',
      expr: `(() => { const H = window.__hkl_composer, m = H.model, r = H.renderer, pb = r['pageBreaks'];
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const L = () => pb.lineStarts().map((id) => ids.indexOf(id));
        const pre = window.__lockPre;
        const status = () => (document.getElementById('composerStatus')?.textContent ?? '').trim();
        const locks = () => [...document.querySelectorAll('g.hkl-lock')].map((g) => ids.indexOf(g.getAttribute('data-for')));
        const last = () => r.renderLedger().slice(-1)[0] ?? {};
        const key = (k, o) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
        const pinsInOrder = () => {
          const starts = pb['startIds'] ?? []; const pos = new Map(starts.map((id, i) => [id, i]));
          let prevEnd = -1;
          for (const page of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
            const s = [...page.querySelectorAll('g.system')].map((g) => g.querySelector('g.measure')?.id).filter(Boolean);
            if (!s.length) continue;
            let at = pos.get(s[0]); if (at == null || at <= prevEnd) return false;
            for (let i = 1; i < s.length; i++) if (pos.get(s[i]) !== at + i) return false;
            prevEnd = at + s.length - 1;
          }
          return true;
        };
        const J = JSON.stringify;
        const ok = pb.lastDeriveReason === '' && m.hardBreakBefore(6) === 'lock' && J(L()) === J(pre) && pb.lastRefillLines === 0 && J(locks()) === '[6]';
        return { ok, detail: J({ pre, lines: L(), moved: pb.lastRefillLines, hb6: m.hardBreakBefore(6), locks: locks(), status: status() }) };
      })()` },
  ],
  lock_down_sparse_remainder_kept: [
    { name: 'lock before m9: the 8-bar section balances to [4,4] ([0,4,8]) — no sparse remainder survives, no derive',
      expr: `(() => { const H = window.__hkl_composer, m = H.model, r = H.renderer, pb = r['pageBreaks'];
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const L = () => pb.lineStarts().map((id) => ids.indexOf(id));
        const pre = window.__lockPre;
        const status = () => (document.getElementById('composerStatus')?.textContent ?? '').trim();
        const locks = () => [...document.querySelectorAll('g.hkl-lock')].map((g) => ids.indexOf(g.getAttribute('data-for')));
        const last = () => r.renderLedger().slice(-1)[0] ?? {};
        const key = (k, o) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
        const pinsInOrder = () => {
          const starts = pb['startIds'] ?? []; const pos = new Map(starts.map((id, i) => [id, i]));
          let prevEnd = -1;
          for (const page of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
            const s = [...page.querySelectorAll('g.system')].map((g) => g.querySelector('g.measure')?.id).filter(Boolean);
            if (!s.length) continue;
            let at = pos.get(s[0]); if (at == null || at <= prevEnd) return false;
            for (let i = 1; i < s.length; i++) if (pos.get(s[i]) !== at + i) return false;
            prevEnd = at + s.length - 1;
          }
          return true;
        };
        const J = JSON.stringify;
        const l = L();
        /* Was [0,6,8]: the two-bar remainder used to survive because [4,4]
           missed MIN_FILL by 0.0049 — an artefact of the old budget, which
           read the system BBOX and so carried ~222 units of ink overhang the
           per-measure naturals do not have, making every fill ~1.2 % too
           small. On the geometric budget [4,4] is 0.6787 / 0.6528 and legal,
           so the section balances and no stub is left (Max, 2026-09-18: the
           last line is always justified). */
        const ok = pb.lastDeriveReason === '' && J(l) === '[0,4,8]' && m.hardBreakBefore(8) === 'lock' && J(locks()) === '[8]' && pinsInOrder();
        return { ok, detail: J({ pre, lines: l, derive: pb.lastDeriveReason, balance: pb.lastBalance, hb8: m.hardBreakBefore(8), locks: locks(), status: status() }) };
      })()` },
  ],
  lock_down_rebalances_section: [
    { name: 'lock before m15: [0,4,9,14], the partition is F of the document, no derive',
      expr: `(() => { const H = window.__hkl_composer, m = H.model, r = H.renderer, pb = r['pageBreaks'];
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const L = () => pb.lineStarts().map((id) => ids.indexOf(id));
        const pre = window.__lockPre;
        const status = () => (document.getElementById('composerStatus')?.textContent ?? '').trim();
        const locks = () => [...document.querySelectorAll('g.hkl-lock')].map((g) => ids.indexOf(g.getAttribute('data-for')));
        const last = () => r.renderLedger().slice(-1)[0] ?? {};
        const key = (k, o) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
        const pinsInOrder = () => {
          const starts = pb['startIds'] ?? []; const pos = new Map(starts.map((id, i) => [id, i]));
          let prevEnd = -1;
          for (const page of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
            const s = [...page.querySelectorAll('g.system')].map((g) => g.querySelector('g.measure')?.id).filter(Boolean);
            if (!s.length) continue;
            let at = pos.get(s[0]); if (at == null || at <= prevEnd) return false;
            for (let i = 1; i < s.length; i++) if (pos.get(s[i]) !== at + i) return false;
            prevEnd = at + s.length - 1;
          }
          return true;
        };
        /* Single-authority check: the committed partition is F of the
           document (read-only, from the owner's caches) — so what the lock
           left on screen is what a fresh load of this document engraves. */
        const isFixedPoint = () => {
          const F = pb.partitionOfDocument(m);
          if (!F) return [{ unjudgeable: true }];
          return F.join() === pb.lineStarts().join() ? [] : [{ F: F.map((id) => ids.indexOf(id)) }];
        };
        const J = JSON.stringify;
        const l = L();
        /* The lock splits the 18-bar section into 14 + 4: F balances the
           14 bars (greedy 6+6+2) into [4,5,5] and keeps the 4-bar final
           section on one line. */
        const moved = isFixedPoint();
        const ok = pb.lastDeriveReason === '' && J(l) === '[0,4,9,14]' && m.hardBreakBefore(14) === 'lock' && moved.length === 0 && J(locks()) === '[14]' && pinsInOrder();
        return { ok, detail: J({ pre, lines: l, derive: pb.lastDeriveReason, balance: pb.lastBalance, notFixedPoint: moved, hb14: m.hardBreakBefore(14), locks: locks(), status: status() }) };
      })()` },
  ],
  lock_down_first_measure_refused: [
    { name: 'push at the first measure is refused: status error, partition and document unchanged',
      expr: `(() => { const H = window.__hkl_composer, m = H.model, r = H.renderer, pb = r['pageBreaks'];
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const L = () => pb.lineStarts().map((id) => ids.indexOf(id));
        const pre = window.__lockPre;
        const status = () => (document.getElementById('composerStatus')?.textContent ?? '').trim();
        const locks = () => [...document.querySelectorAll('g.hkl-lock')].map((g) => ids.indexOf(g.getAttribute('data-for')));
        const last = () => r.renderLedger().slice(-1)[0] ?? {};
        const key = (k, o) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
        const pinsInOrder = () => {
          const starts = pb['startIds'] ?? []; const pos = new Map(starts.map((id, i) => [id, i]));
          let prevEnd = -1;
          for (const page of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
            const s = [...page.querySelectorAll('g.system')].map((g) => g.querySelector('g.measure')?.id).filter(Boolean);
            if (!s.length) continue;
            let at = pos.get(s[0]); if (at == null || at <= prevEnd) return false;
            for (let i = 1; i < s.length; i++) if (pos.get(s[i]) !== at + i) return false;
            prevEnd = at + s.length - 1;
          }
          return true;
        };
        const J = JSON.stringify;
        const sbs = m.getDoc().querySelectorAll('sb:not([data-hkl-section])').length;
        const ok = /first measure/.test(status()) && J(L()) === J(pre) && sbs === 0 && locks().length === 0;
        return { ok, detail: J({ status: status(), lines: L(), pre, sbs }) };
      })()` },
  ],
  lock_undo_restores_partition: [
    { name: 'Alt+Shift+↓ then Ctrl+Z restores the exact pre-command partition as a no-op render; Ctrl+Y restores the post-command one',
      expr: `(() => { const H = window.__hkl_composer, m = H.model, r = H.renderer, pb = r['pageBreaks'];
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const L = () => pb.lineStarts().map((id) => ids.indexOf(id));
        const pre = window.__lockPre;
        const status = () => (document.getElementById('composerStatus')?.textContent ?? '').trim();
        const locks = () => [...document.querySelectorAll('g.hkl-lock')].map((g) => ids.indexOf(g.getAttribute('data-for')));
        const last = () => r.renderLedger().slice(-1)[0] ?? {};
        const key = (k, o) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
        const pinsInOrder = () => {
          const starts = pb['startIds'] ?? []; const pos = new Map(starts.map((id, i) => [id, i]));
          let prevEnd = -1;
          for (const page of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
            const s = [...page.querySelectorAll('g.system')].map((g) => g.querySelector('g.measure')?.id).filter(Boolean);
            if (!s.length) continue;
            let at = pos.get(s[0]); if (at == null || at <= prevEnd) return false;
            for (let i = 1; i < s.length; i++) if (pos.get(s[i]) !== at + i) return false;
            prevEnd = at + s.length - 1;
          }
          return true;
        };
        const J = JSON.stringify;
        key('ArrowDown', { altKey: true, shiftKey: true });
        const post = L(); const postLocks = locks();
        key('z', { ctrlKey: true });
        const afterUndo = L(); const undoLedger = last(); const hbUndo = m.hardBreakBefore(7); const undoLocks = locks();
        key('y', { ctrlKey: true });
        const afterRedo = L(); const hbRedo = m.hardBreakBefore(7); const redoLocks = locks();
        const ok = J(post) !== J(pre) && J(afterUndo) === J(pre) && hbUndo === null && undoLocks.length === 0 && undoLedger.outcome === 'noop' && undoLedger.deriveReason === ''
          && J(afterRedo) === J(post) && hbRedo === 'lock' && J(redoLocks) === J(postLocks) && pb.lastDeriveReason === '';
        return { ok, detail: J({ pre, post, afterUndo, afterRedo, undoLedger, hbUndo, hbRedo, undoLocks, redoLocks, postLocks }) };
      })()` },
  ],
  lock_click_unlocks_keeps_layout: [
    { name: 'clicking the padlock removes the <sb>: the two sections join and F re-partitions them as one ([0,3,7] → [0,6], what a reload engraves), spliced, glyph removed',
      expr: `(() => { const H = window.__hkl_composer, m = H.model, r = H.renderer, pb = r['pageBreaks'];
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const L = () => pb.lineStarts().map((id) => ids.indexOf(id));
        const pre = window.__lockPre;
        const status = () => (document.getElementById('composerStatus')?.textContent ?? '').trim();
        const locks = () => [...document.querySelectorAll('g.hkl-lock')].map((g) => ids.indexOf(g.getAttribute('data-for')));
        const last = () => r.renderLedger().slice(-1)[0] ?? {};
        const key = (k, o) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
        const pinsInOrder = () => {
          const starts = pb['startIds'] ?? []; const pos = new Map(starts.map((id, i) => [id, i]));
          let prevEnd = -1;
          for (const page of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
            const s = [...page.querySelectorAll('g.system')].map((g) => g.querySelector('g.measure')?.id).filter(Boolean);
            if (!s.length) continue;
            let at = pos.get(s[0]); if (at == null || at <= prevEnd) return false;
            for (let i = 1; i < s.length; i++) if (pos.get(s[i]) !== at + i) return false;
            prevEnd = at + s.length - 1;
          }
          return true;
        };
        const J = JSON.stringify;
        const before = L(); const lock = document.querySelector('g.hkl-lock');
        if (!lock) return { ok: false, detail: 'no padlock to click' };
        lock.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        const F = (pb.partitionOfDocument(m) ?? []).map((id) => ids.indexOf(id));
        const ok = m.hardBreakBefore(7) === null && J(before) === '[0,3,7]' && J(L()) === '[0,6]' && J(L()) === J(F)
          && locks().length === 0 && !last().full && pb.lastDeriveReason === '' && /unlocked/.test(status()) && pinsInOrder();
        return { ok, detail: J({ before, after: L(), F, hb7: m.hardBreakBefore(7), locks: locks(), ledger: last(), derive: pb.lastDeriveReason, status: status() }) };
      })()` },
  ],
  lock_scroll_view_ignored: [
    { name: 'scroll view: the command is refused and the document is unchanged',
      expr: `(() => { const H = window.__hkl_composer, m = H.model, r = H.renderer, pb = r['pageBreaks'];
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const L = () => pb.lineStarts().map((id) => ids.indexOf(id));
        const pre = window.__lockPre;
        const status = () => (document.getElementById('composerStatus')?.textContent ?? '').trim();
        const locks = () => [...document.querySelectorAll('g.hkl-lock')].map((g) => ids.indexOf(g.getAttribute('data-for')));
        const last = () => r.renderLedger().slice(-1)[0] ?? {};
        const key = (k, o) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
        const pinsInOrder = () => {
          const starts = pb['startIds'] ?? []; const pos = new Map(starts.map((id, i) => [id, i]));
          let prevEnd = -1;
          for (const page of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
            const s = [...page.querySelectorAll('g.system')].map((g) => g.querySelector('g.measure')?.id).filter(Boolean);
            if (!s.length) continue;
            let at = pos.get(s[0]); if (at == null || at <= prevEnd) return false;
            for (let i = 1; i < s.length; i++) if (pos.get(s[i]) !== at + i) return false;
            prevEnd = at + s.length - 1;
          }
          return true;
        };
        const J = JSON.stringify;
        const sbs = m.getDoc().querySelectorAll('sb:not([data-hkl-section])').length;
        const ok = r.getViewMode() === 'scroll' && /page-view command/.test(status()) && sbs === 0;
        return { ok, detail: J({ view: r.getViewMode(), status: status(), sbs }) };
      })()` },
  ],
  lock_export_new_system: [
    { name: 'MusicXML export carries <print new-system="yes"/> on the locked measure (m8) and nowhere else',
      expr: `(() => { const H = window.__hkl_composer, m = H.model, r = H.renderer, pb = r['pageBreaks'];
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const L = () => pb.lineStarts().map((id) => ids.indexOf(id));
        const pre = window.__lockPre;
        const status = () => (document.getElementById('composerStatus')?.textContent ?? '').trim();
        const locks = () => [...document.querySelectorAll('g.hkl-lock')].map((g) => ids.indexOf(g.getAttribute('data-for')));
        const last = () => r.renderLedger().slice(-1)[0] ?? {};
        const key = (k, o) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
        const pinsInOrder = () => {
          const starts = pb['startIds'] ?? []; const pos = new Map(starts.map((id, i) => [id, i]));
          let prevEnd = -1;
          for (const page of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
            const s = [...page.querySelectorAll('g.system')].map((g) => g.querySelector('g.measure')?.id).filter(Boolean);
            if (!s.length) continue;
            let at = pos.get(s[0]); if (at == null || at <= prevEnd) return false;
            for (let i = 1; i < s.length; i++) if (pos.get(s[i]) !== at + i) return false;
            prevEnd = at + s.length - 1;
          }
          return true;
        };
        const J = JSON.stringify;
        const xml = H.exportMusicXml(m);
        const d = new DOMParser().parseFromString(xml, 'application/xml');
        const hits = [...d.querySelectorAll('measure')].filter((me) => me.querySelector(':scope > print[new-system="yes"]')).map((me) => me.getAttribute('number'));
        const ok = J(hits) === '["8"]';
        return { ok, detail: J({ hits }) };
      })()` },
  ],
  page_zoom_roundtrip_keeps_widths: [
    { name: 'after setZoom(50) the owner still holds every natural and every signature context; the partition is unchanged',
      expr: `(() => { const H = window.__hkl_composer, m = H.model, r = H.renderer, pb = r['pageBreaks'];
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const L = () => pb.lineStarts().map((id) => ids.indexOf(id));
        const pre = window.__lockPre;
        const status = () => (document.getElementById('composerStatus')?.textContent ?? '').trim();
        const locks = () => [...document.querySelectorAll('g.hkl-lock')].map((g) => ids.indexOf(g.getAttribute('data-for')));
        const J = JSON.stringify;
        const nat = pb['naturals'].size, sig = pb['sigWByCtx'].size;
        const ok = r.getZoom() === 50 && nat === ids.length && window.__lockNat0 === ids.length && sig > 0 && J(L()) === J(pre) && pb.ownershipActive();
        r.setZoom(100); H.reRender();   /* leave the shared page as we found it */
        return { ok, detail: J({ zoom: 50, naturals: nat, before: window.__lockNat0, measures: ids.length, sigCtx: sig, lines: L(), pre }) };
      })()` },
  ],
  lock_after_zoom_reflows: [
    { name: 'at zoom 50 after a round-trip, the lock before m14 folds the one-bar remainder into the previous system (balance applied, no "naturals incomplete")',
      expr: `(() => { const H = window.__hkl_composer, m = H.model, r = H.renderer, pb = r['pageBreaks'];
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const L = () => pb.lineStarts().map((id) => ids.indexOf(id));
        const pre = window.__lockPre;
        const status = () => (document.getElementById('composerStatus')?.textContent ?? '').trim();
        const locks = () => [...document.querySelectorAll('g.hkl-lock')].map((g) => ids.indexOf(g.getAttribute('data-for')));
        const J = JSON.stringify;
        const l = L(); const b = pb.lastBalance;
        const ok = pb.lastDeriveReason === '' && m.hardBreakBefore(13) === 'lock' && l.includes(13) && !l.includes(12) && b.applied >= 1 && !b.reasons.some((x) => /naturals incomplete/.test(x)) && J(locks()) === '[13]';
        r.setZoom(100); H.reRender();   /* leave the shared page as we found it */
        return { ok, detail: J({ pre, lines: l, derive: pb.lastDeriveReason, balance: b, hb13: m.hardBreakBefore(13), naturals: pb['naturals'].size, status: status() }) };
      })()` },
  ],
  lock_then_edit_keeps_lock: [
    { name: 'an edit inside the locked line after the lock moves no boundary; m8 stays a hard line start',
      expr: `(() => { const H = window.__hkl_composer, m = H.model, r = H.renderer, pb = r['pageBreaks'];
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const L = () => pb.lineStarts().map((id) => ids.indexOf(id));
        const pre = window.__lockPre;
        const status = () => (document.getElementById('composerStatus')?.textContent ?? '').trim();
        const locks = () => [...document.querySelectorAll('g.hkl-lock')].map((g) => ids.indexOf(g.getAttribute('data-for')));
        const last = () => r.renderLedger().slice(-1)[0] ?? {};
        const key = (k, o) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
        const pinsInOrder = () => {
          const starts = pb['startIds'] ?? []; const pos = new Map(starts.map((id, i) => [id, i]));
          let prevEnd = -1;
          for (const page of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
            const s = [...page.querySelectorAll('g.system')].map((g) => g.querySelector('g.measure')?.id).filter(Boolean);
            if (!s.length) continue;
            let at = pos.get(s[0]); if (at == null || at <= prevEnd) return false;
            for (let i = 1; i < s.length; i++) if (pos.get(s[i]) !== at + i) return false;
            prevEnd = at + s.length - 1;
          }
          return true;
        };
        const J = JSON.stringify;
        const before = L();
        m.setCursor(m.getMeasureStartCursor(1, 7), 1);
        m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'g', accid: '', oct: 4, midi: 67, colorHex: '#888', lightColorHex: '#fff', velocity: 80 }], duration: '8', dots: 0 });
        H.reRender();
        const ok = pb.lastDeriveReason === '' && J(L()) === J(before) && pb.lastRefillLines === 0 && m.hardBreakBefore(7) === 'lock' && J(locks()) === '[7]';
        return { ok, detail: J({ before, after: L(), moved: pb.lastRefillLines, derive: pb.lastDeriveReason, ledger: last() }) };
      })()` },
  ],
  pageLineBreaksRefill: [
    { name: 'an edit takes the refill path and every rendered system starts at a pin, in order',
      expr: `(() => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        if (!pb.canAttemptRefill()) return { ok: false, detail: 'no partition adoptable after the derive render' };
        /* Engage ownership deterministically before the edit: lazy adoption
           means the setup's renders may have adopted a stale (e.g. blank-doc,
           single-line) partition and legally fallen back to derive — which
           state we start from depends on idle-callback timing. One or two
           no-change renders settle it: bail → derive re-arms → next render
           adopts THIS doc and pins it. */
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged after pre-renders (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        m.setCursor(m.getMeasureStartCursor(1, 4), 1);
        if (!m.deleteAtCursor()) return { ok: false, detail: 'delete rejected' };
        H.reRender();   /* refill path — adoption completes synchronously here */
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not active after the edit render (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        if (pb.lastDeriveReason !== '') return { ok: false, detail: 'derive path taken — expected a refill (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        /* NOTE: lastRefillLines === 0 is the DESIRED outcome for an edit that
           breaks no line's legality — the partition is repaired, never
           re-derived (Max's ruling 2026-08-30). What matters here is that the
           REFILL path ran and the render honored its pins. */
        const startIds = pb['startIds'];
        if (startIds.length < 2) return { ok: false, detail: 'expected a multi-line partition, got ' + startIds.length };
        const pos = new Map(startIds.map((id, i) => [id, i]));
        let prevEnd = -1;
        let systems = 0;
        for (const page of document.querySelectorAll('#score .score-page:not(.score-page-pending)')) {
          const starts = [];
          for (const sys of page.querySelectorAll('g.system')) {
            const first = sys.querySelector('g.measure');
            if (first && first.id) starts.push(first.id);
          }
          if (!starts.length) continue;
          systems += starts.length;
          const at = pos.get(starts[0]);
          if (at == null || at <= prevEnd) return { ok: false, detail: 'system start ' + starts[0] + ' is not a pin (or out of order)' };
          for (let i = 1; i < starts.length; i++) {
            if (pos.get(starts[i]) !== at + i) return { ok: false, detail: 'rendered partition broke pin order at ' + starts[i] };
          }
          prevEnd = at + starts.length - 1;
        }
        return systems >= 2 ? { ok: true } : { ok: false, detail: 'only ' + systems + ' rendered system(s)' };
      })()` },
  ],
  pageLineBreaksNoopDeterminism: [
    { name: 'identical content always refills to the identical partition (ruling ii): round-trips agree, no-op renders are stable',
      expr: `(() => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        /* Engage ownership with a no-change refill first (adoption completes
           synchronously; sig diff finds nothing → pins re-encoded as adopted).
           Since the partition is never re-derived — only repaired when an edit
           makes a line illegal (Max's ruling 2026-08-30) — a round-trip must
           restore the partition exactly, two round-trips must agree, and a
           no-change render must move nothing. */
        for (let i = 0; i < 3 && !pb.ownershipActive(); i++) H.reRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged after pre-renders (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        const roundTrip = () => {
          m.setCursor(m.getMeasureStartCursor(1, 5), 1);
          if (!m.deleteAtCursor()) return null;
          H.reRender();
          if (pb.lastDeriveReason !== '') return null;   // derive taken — expected refill
          m.setCursor(m.getMeasureStartCursor(1, 5), 1);
          m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'b', accid: '', oct: 4, midi: 59, colorHex: '#888', lightColorHex: '#fff', velocity: 80 }], duration: '4', dots: 0 });
          H.reRender();
          if (pb.lastDeriveReason !== '') return null;
          return pb['startIds'].join();
        };
        const A = roundTrip();
        if (A === null) return { ok: false, detail: 'first round-trip fell off the refill path' };
        const B = roundTrip();
        if (B === null) return { ok: false, detail: 'second round-trip fell off the refill path' };
        if (A !== B) return { ok: false, detail: 'identical content produced different partitions across round-trips' };
        H.reRender();   // no-op render request
        if (pb['startIds'].join() !== A) return { ok: false, detail: 'a no-change render moved a boundary' };
        return { ok: true };
      })()` },
  ],
  pageUserBreakReflows: [
    { name: 'a user PAGE break splits its line and starts a page (+1 line, +1 page), each page from the break on re-balances, and removing it restores this layout exactly',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model, r = H.renderer;
        const pb = r['pageBreaks'];
        const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
        /* SETTLE between steps. reRender is not synchronous, and snapping
           straight after it reads a mid-render layout — which is why this
           fixture used to compare an unsettled 'after' against an unsettled
           'base' and pass by accident (2026-09-09). */
        const settled = async () => {
          for (let i = 0; i < 600; i++) {
            const b = document.getElementById('renderBusy');
            if (pb.lineStarts().length > 0 && (!b || b.hidden)
 && r.extentsJobState() === null) return true;
            await sleep(25);
          }
          return false;
        };
        for (let i = 0; i < 3 && !pb.ownershipActive(); i++) { H.reRender(); await settled(); }
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        if (!await settled()) return { ok: false, detail: 'never settled before the break' };
        const mountAll = () => {
          for (const p of document.querySelectorAll('#score .score-page.score-page-pending')) r['mountPage'](+p.dataset.page);
        };
        const snap = () => {
          mountAll();
          const pages = [...document.querySelectorAll('#score .score-page')];
          const per = pages.map((p) => p.querySelectorAll('g.system').length);
          return { domPages: pages.length, owned: pb.pageStarts().length, lines: pb.lineStarts().length,
                   per, perStr: per.join(','), singles: per.filter((n) => n === 1).length };
        };
        const base = snap();
        if (base.domPages < 3) return { ok: false, detail: 'need >= 3 pages to cascade into; got ' + base.domPages };
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const lineSet = new Set(pb.lineStarts());
        /* Prefer a MID-SYSTEM measure — that exercises the line split too. */
        let mi = -1;
        for (let i = 4; i < Math.min(ids.length, 60); i++) { if (!lineSet.has(ids[i])) { mi = i; break; } }
        if (mi < 0) return { ok: false, detail: 'no mid-system measure found' };
        const wasLineStart = lineSet.has(ids[mi]);
        m.togglePageBreakAt(mi);
        H.reRender();
        if (!await settled()) return { ok: false, detail: 'never settled with the break' };
        const withBreak = snap();
        const startsLine = pb.lineStarts().includes(ids[mi]);
        const startsPage = pb.pageStarts().includes(ids[mi]);
        const verified = pb.verifyRenderedPartition(r['container'], m, r['pageVirt'] ? r['pageVirt'].pageCount : 1, r['pageBreaksCtx']());
        m.togglePageBreakAt(mi);
        H.reRender();
        if (!await settled()) return { ok: false, detail: 'never settled after removing the break' };
        const after = snap();
        const fails = [];
        if (wasLineStart) fails.push('picked measure was already a line start (not a mid-system break)');
        if (!startsLine) fails.push('break measure does not start a line (line was not split)');
        if (!startsPage) fails.push('break measure does not start a page');
        if (withBreak.owned !== withBreak.domPages) fails.push('page list ' + withBreak.owned + ' != DOM ' + withBreak.domPages);
        /* A single-system page is now a legitimate outcome: a user page break
           makes the measures before it their OWN section, and a section is
           balanced independently — five measures become one line rather than
           two sparse ones. Dropped with the +1-line count below (2026-09-18). */
        if (!verified) fails.push('verifyRenderedPartition false');
        /* The +1-LINE arithmetic is gone. It held while a break only split a
           line; now the break also makes a section boundary, and both sides
           rebalance, so the split can be offset by a merge elsewhere (this
           document: 15 -> 15). What must still hold is that the break starts a
           line and a page, that pagination stays consistent, and — the real
           gate — that REMOVING it restores the previous layout exactly, which
           the partition being a pure function of content guarantees. */
        if (withBreak.domPages !== base.domPages + 1) {
          fails.push('expected +1 page with the break, got ' + base.domPages + ' -> ' + withBreak.domPages);
        }
        if (after.domPages !== base.domPages || after.lines !== base.lines || after.perStr !== base.perStr) {
          fails.push('removing the break did not restore this layout:\\n  base  ' + base.domPages + 'p/' + base.lines + 'l [' + base.perStr + ']'
            + '\\n  after ' + after.domPages + 'p/' + after.lines + 'l [' + after.perStr + ']');
        }
        return { ok: fails.length === 0, detail: fails.join('; ')
          || ('mi=' + mi + ' ' + base.domPages + 'p/' + base.lines + 'l -> ' + withBreak.domPages + 'p/' + withBreak.lines + 'l -> restored') };
      })()` },
  ],
  pageLineBreaksUndoRestoresLayout: [
    { name: 'a note delete moves no line boundary, and undo restores the layout bit-for-bit (no reflow hysteresis)',
      expr: `(() => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'];
        for (let i = 0; i < 3 && !pb.ownershipActive(); i++) H.reRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        const geom = () => {
          const g = new Map();
          for (const el of document.querySelectorAll('#score .score-page:not(.score-page-pending) g.measure')) {
            const b = el.getBBox();
            g.set(el.id, [+b.x.toFixed(2), +b.width.toFixed(2)]);
          }
          return g;
        };
        const before = pb['startIds'].join();
        const geomBefore = geom();
        if (geomBefore.size < 8) return { ok: false, detail: 'only ' + geomBefore.size + ' rendered measures — fixture too small' };
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        /* Delete a note mid-document (well inside a line, not at a boundary)
           THROUGH THE REAL INPUT PATH — a direct model.deleteAtCursor() skips
           withHistory, so nothing lands on the undo stack and the Ctrl+Z below
           would silently no-op (probe artifact, 2026-08-30). */
        const mi = Math.floor(ids.length / 2);
        const cur = m.getFirstVisualCursorInMeasure(1, mi, 'overwrite');
        if (cur < 0) return { ok: false, detail: 'no visual cursor in measure ' + mi };
        m.setCursor(cur, 1);
        const notesBefore = m.getDoc().querySelectorAll('note').length;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
        if (m.getDoc().querySelectorAll('note').length >= notesBefore) {
          return { ok: false, detail: 'Backspace deleted nothing (notes ' + notesBefore + ')' };
        }
        if (pb['startIds'].join() !== before) {
          return { ok: false, detail: 'a note delete moved a boundary (movedLines=' + pb.lastRefillLines + ') — the partition was re-derived, not repaired' };
        }
        if (pb.lastRefillLines !== 0) return { ok: false, detail: 'lastRefillLines=' + pb.lastRefillLines + ' for a legality-preserving edit' };
        /* Undo through the real input path (history + effects + reRender). */
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
        if (m.getDoc().querySelectorAll('note').length !== notesBefore) {
          return { ok: false, detail: 'undo did not restore the deleted note (notes ' + m.getDoc().querySelectorAll('note').length + ' vs ' + notesBefore + ')' };
        }
        if (pb['startIds'].join() !== before) return { ok: false, detail: 'undo moved a boundary' };
        const geomAfter = geom();
        for (const [id, v] of geomBefore) {
          const w = geomAfter.get(id);
          if (!w) return { ok: false, detail: 'measure ' + id + ' missing after undo' };
          if (Math.abs(v[0] - w[0]) > 0.01 || Math.abs(v[1] - w[1]) > 0.01) {
            return { ok: false, detail: 'measure ' + id + ' geometry changed across delete+undo: ' + JSON.stringify(v) + ' → ' + JSON.stringify(w) };
          }
        }
        return { ok: true };
      })()` },
  ],
  pageBalanceSinglePartView: [
    { name: 'viola-only view: the owner engages on the filtered layout, section I is F\'s pick, the final two-line section stays greedy, only staff 3 is drawn, the justification rule holds',
      expr: `(() => {
        const H = window.__hkl_composer; const m = H.model; const pb = H.renderer['pageBreaks'];
        if (H.inputState().viewInstrIdx !== 1) return { ok: false, detail: 'view not on the viola: ' + H.inputState().viewInstrIdx };
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged in single-part view (' + pb.lastDeriveReason + ')' };
        const ns = [...new Set([...document.querySelectorAll('#score .score-page:not(.score-page-pending) g.staff')].map((s) => s.getAttribute('data-n')))];
        if (ns.length !== 1 || ns[0] !== '3') return { ok: false, detail: 'staves drawn: ' + ns.join(',') };
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const idIdx = new Map(ids.map((id, i) => [id, i]));
        const starts = pb['startIds'].map((id) => idIdx.get(id));
        const lens = starts.map((s, k) => (k + 1 < starts.length ? starts[k + 1] : ids.length) - s);
        if (lens.some((L) => L <= 1)) return { ok: false, detail: 'a lone-bar system survived: lens=' + lens.join(',') };
        const secII = starts.indexOf(13);
        if (secII < 0) return { ok: false, detail: 'section II does not start a line: starts=' + starts.join(',') };
        /* Section II (9 bars) is the FINAL section and needs only two greedy
           lines, so F keeps it greedy (6+3) and its sparse last system stays
           at natural width (fill < 0.70). */
        if (lens.slice(secII).join() !== '6,3') return { ok: false, detail: 'final section not kept greedy: lens ' + lens.join(',') };
        const lastFill = pb['lineFill'](starts, starts.length - 1, ids);
        if (!(lastFill < 0.70) || pb.finalSystemJustified() !== false) return { ok: false, detail: 'final greedy line fill ' + lastFill + ', finalSystemJustified ' + pb.finalSystemJustified() };
        const jr = ${JUSTIFY_RULE}(H.renderer);
        if (jr) return { ok: false, detail: jr };
        return { ok: true, detail: 'lens ' + lens.join(',') };
      })()` },
  ],
  pageSinglePartViewEditSplices: [
    { name: 'composing past the end in single-part view splices (no full engrave) and the view stays viola-only',
      expr: `(async () => {
        const H = window.__hkl_composer; const m = H.model; const pb = H.renderer['pageBreaks']; const led = H.renderer['ledger'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (' + pb.lastDeriveReason + ')' };
        const before = led.length;
        /* A real edit: a quarter past the end of the viola part (a new bar). An
           insert INTO a full bar is refused by the model and renders nothing. */
        m.setVoice(5); m.setCursor(m.getVoiceLength(5), 5);
        m.insertChordAtCursor({ notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69, colorHex: '#888', lightColorHex: '#fff', velocity: 80 }], duration: '4', dots: 0 });
        H.reRender();
        /* A render after a heavy derive may be deferred behind the busy badge (T2.2). */
        for (let i = 0; i < 100 && led.length <= before; i++) await new Promise((res) => setTimeout(res, 30));
        const since = led.slice(before);
        if (!since.length) return { ok: false, detail: 'no render recorded for the edit within 3 s' };
        const full = since.filter((e) => e.full);
        if (full.length) return { ok: false, detail: 'the edit full-rendered: ' + full.map((e) => e.deriveReason || e.skipReason || '(unattributed)').join(' | ') };
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership lost after the edit' };
        const ns = [...new Set([...document.querySelectorAll('#score .score-page:not(.score-page-pending) g.staff')].map((s) => s.getAttribute('data-n')))];
        if (ns.length !== 1 || ns[0] !== '3') return { ok: false, detail: 'staves drawn after the edit: ' + ns.join(',') };
        return { ok: true, detail: since.map((e) => e.outcome + ':' + e.ms + 'ms').join(' ') };
      })()` },
  ],
  pageBalanceSectionFinal: [
    { name: 'no lone-bar system: section I (greedy 6+6+1) is F\'s pick before the first paint; section II, final and two lines, stays greedy 6+3 with its sparse last system at natural width; every other system is justified',
      expr: `(() => {
        const H = window.__hkl_composer; const m = H.model; const pb = H.renderer['pageBreaks'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (' + pb.lastDeriveReason + ')' };
        const ib = pb.lastInitialBalance;
        if (!ib || ib.applied < 1) return { ok: false, detail: 'the sync band balance did not fire: ' + JSON.stringify(ib) };
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const idIdx = new Map(ids.map((id, i) => [id, i]));
        const starts = pb['startIds'].map((id) => idIdx.get(id));
        const lens = starts.map((s, k) => (k + 1 < starts.length ? starts[k + 1] : ids.length) - s);
        if (lens.some((L) => L <= 1)) return { ok: false, detail: 'a lone-bar system survived: lens=' + lens.join(',') };
        const secII = starts.indexOf(13);
        if (secII < 0) return { ok: false, detail: 'section II does not start a line: starts=' + starts.join(',') };
        if (lens.slice(secII).join() !== '6,3') return { ok: false, detail: 'final section not kept greedy: lens ' + lens.join(',') };
        if (pb.finalSystemJustified() !== false) return { ok: false, detail: 'finalSystemJustified ' + pb.finalSystemJustified() + ' for a greedy last line at ' + pb['lineFill'](starts, starts.length - 1, ids) };
        const jr = ${JUSTIFY_RULE}(H.renderer);
        if (jr) return { ok: false, detail: jr };
        return { ok: true, detail: 'lens ' + lens.join(',') };
      })()` },
  ],
  pageBalanceDocFinalSmallDocKeepsStub: [
    { name: 'a document-final section of two greedy lines stays greedy (6+2, not balanced to 4+4) and its sparse last system is left at natural width; every other system is justified',
      expr: `(() => {
        const H = window.__hkl_composer; const pb = H.renderer['pageBreaks'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (' + pb.lastDeriveReason + ')' };
        const m2 = H.model;
        const ids = m2.allMeasures().map((x) => x.getAttribute('xml:id'));
        const idIdx = new Map(ids.map((id, i) => [id, i]));
        const starts = pb.lineStarts().map((id) => idIdx.get(id));
        const lens = starts.map((s0, k) => (k + 1 < starts.length ? starts[k + 1] : ids.length) - s0);
        const secII = starts.indexOf(13);
        if (secII < 0) return { ok: false, detail: 'section II does not start a line: ' + starts.join(',') };
        if (lens.slice(secII).join() !== '6,2') return { ok: false, detail: 'final section not kept greedy: lens ' + lens.join(',') };
        const pick = (pb.lastInitialBalance?.picks ?? []).find((p) => p.from === ids[13]);
        if (!pick || !pick.exempt) return { ok: false, detail: 'section II not reported exempt: ' + JSON.stringify(pick) };
        const lastFill = pb['lineFill'](starts, starts.length - 1, ids);
        if (lastFill === null || !(lastFill < 0.70)) return { ok: false, detail: 'final greedy line fill ' + lastFill };
        const jr = ${JUSTIFY_RULE}(H.renderer);
        if (jr) return { ok: false, detail: jr };
        return { ok: true, detail: 'lens ' + lens.join(',') + ', last fill ' + lastFill.toFixed(3) };
      })()` },
  ],
  pageBalanceRule2StubKept: [
    { name: 'a one-line final section (2 bars) stays as it is and is left at natural width (fill < 0.70); every other system is justified',
      expr: `(() => {
        const H = window.__hkl_composer; const m = H.model; const pb = H.renderer['pageBreaks'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (' + pb.lastDeriveReason + ')' };
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const idIdx = new Map(ids.map((id, i) => [id, i]));
        const starts = pb.lineStarts().map((id) => idIdx.get(id));
        if (starts[starts.length - 1] !== 13) return { ok: false, detail: 'section II is not one line: ' + starts.join(',') };
        const pick = (pb.lastInitialBalance?.picks ?? []).find((p) => p.from === ids[13]);
        if (!pick || !pick.exempt || pick.lines !== 1) return { ok: false, detail: 'section II pick: ' + JSON.stringify(pb.lastInitialBalance) };
        const lastFill = pb['lineFill'](starts, starts.length - 1, ids);
        if (lastFill === null || !(lastFill < 0.70)) return { ok: false, detail: 'final line fill ' + lastFill };
        if (pb.finalSystemJustified() !== false) return { ok: false, detail: 'finalSystemJustified ' + pb.finalSystemJustified() };
        const jr = ${JUSTIFY_RULE}(H.renderer);
        if (jr) return { ok: false, detail: jr };
        return { ok: true, detail: 'stub fill ' + lastFill.toFixed(3) };
      })()` },
  ],
  pageBalanceComposeAtEnd: [
    { name: 'composing past the end: when greedy needs a new line F re-partitions the section on the splice path — F of the document, no line compressed, the balanced final system justified',
      expr: `(() => {
        const H = window.__hkl_composer; const m = H.model; const pb = H.renderer['pageBreaks'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (' + pb.lastDeriveReason + ')' };
        /* Scope the splice gate to the APPENDS. Building 21 bars from the
           blank doc passes through a single-line partition, which derives by
           design — but a blanket fullRender: on the fixture would also
           forgive a real full engrave during the appends, which is the thing
           being tested. Clearing the ledger here keeps the gate live. */
        H.renderer.renderLedger().length = 0;
        const mk = (p, o) => ({ q: 0, r: 0, pname: p, accid: '', oct: o, midi: 57, colorHex: '#888', lightColorHex: '#fff', velocity: 80 });
        const linesBefore = pb['startIds'].length;
        let bars = 0;
        while (bars < 12 && pb['startIds'].length === linesBefore) {
          for (let i = 0; i < 4; i++) m.insertChordAtCursor({ notes: [mk(i % 2 ? 'b' : 'g', i % 2 ? 4 : 6)], duration: '4', dots: 0 });
          bars++;
          H.reRender();
          if (pb.lastDeriveReason !== '') return { ok: false, detail: 'derive after appending bar ' + bars + ': ' + pb.lastDeriveReason };
        }
        if (pb['startIds'].length === linesBefore) return { ok: false, detail: 'no new line after ' + bars + ' appended bars' };
        const lb = pb.lastBalance;
        if (lb.applied !== 1) return { ok: false, detail: 'balancer did not fire on the push: ' + JSON.stringify(lb) };
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const idIdx = new Map(ids.map((id, i) => [id, i]));
        const starts = pb['startIds'].map((id) => idIdx.get(id));
        /* What must hold (partition spec): the partition is F of the document
           — what a reload engraves — and no line is compressed past its
           natural width (the defect this fixture was born for: 4,5,5,5,5,9
           with the last line at 1.42). The section has 3+ lines, so F picked
           it from the curve and its last system is justified. */
        const F = pb.partitionOfDocument(m);
        if (!F || F.join() !== pb.lineStarts().join()) return { ok: false, detail: 'partition is not F: ' + JSON.stringify({ F, committed: pb.lineStarts() }) };
        const fills = starts.map((_, k) => pb['lineFill'](starts, k, ids));
        if (fills.some((x) => x === null || x > 1.0 + 1e-9)) return { ok: false, detail: 'a line is compressed: ' + fills.map((x) => x && x.toFixed(3)).join(',') };
        if (pb.finalSystemJustified() !== true) return { ok: false, detail: 'finalSystemJustified ' + pb.finalSystemJustified() + ' for a balanced final section' };
        const jr = ${JUSTIFY_RULE}(H.renderer);
        if (jr) return { ok: false, detail: jr };
        const led = H.renderer.renderLedger();
        if (!led.length || led[led.length - 1].full) return { ok: false, detail: 'the push render was a full engrave: ' + JSON.stringify(led[led.length - 1]) };
        return { ok: true };
      })()` },
  ],
  pageSpliceLeaderAtSectionRestart: [
    { name: 'an edit in a section\'s first line splices through a leader-at-boundary window (no Verovio crash, no derive)',
      expr: `(async () => {
        const H = window.__hkl_composer; const m = H.model; const pb = H.renderer['pageBreaks']; const ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        await window.__waitForRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (' + pb.lastDeriveReason + ')' };
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const idIdx = new Map(ids.map((id, i) => [id, i]));
        const starts = pb['startIds'].map((id) => idIdx.get(id));
        if (!starts.includes(17)) return { ok: false, detail: 'section II does not start a line: ' + starts.join(',') };
        /* Delete a note in section II's FIRST bar: the hunk is its first line
           and the window opens with a leader right before the boundary. */
        m.setCursor(m.getMeasureStartCursor(1, 17), 1);
        if (!m.deleteAtCursor()) return { ok: false, detail: 'delete rejected' };
        let thrown = null;
        try { H.reRender(); } catch (e) { thrown = String(e); }
        if (thrown) return { ok: false, detail: 'render threw: ' + thrown };
        if (pb.lastDeriveReason !== '') return { ok: false, detail: 'derive: ' + pb.lastDeriveReason };
        if (ps.lastOutcome !== 'spliced') return { ok: false, detail: 'expected a splice, got ' + ps.lastOutcome + ' (' + ps.lastSkipReason + ')' };
        if (!ps.lastWindow || !ps.lastWindow.leader) return { ok: false, detail: 'window had no leader: ' + JSON.stringify(ps.lastWindow) };
        if (!(ps.lastStats.loadMs > 0)) return { ok: false, detail: 'window never loaded: ' + JSON.stringify(ps.lastStats) };
        return { ok: true };
      })()` },
  ],
  pageBalanceSubMeasureWiden: [
    { name: 'widening measures in place re-partitions immediately: every keystroke leaves F of the document, no line is compressed, and emptying voice 3 restores the original layout exactly',
      expr: `(() => {
        const H = window.__hkl_composer; const m = H.model; const pb = H.renderer['pageBreaks'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (' + pb.lastDeriveReason + ')' };
        /* F of the document from the owner's caches (read-only): the layout a
           fresh load of this content engraves. \`changed\` = boundaries the
           committed partition differs from it by (−1: unjudgeable). */
        const state = () => {
          const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
          const idIdx = new Map(ids.map((id, i) => [id, i]));
          const starts = pb['startIds'].map((id) => idIdx.get(id));
          const fills = starts.map((_, k) => pb['lineFill'](starts, k, ids));
          const F = pb.partitionOfDocument(m);
          const A = new Set(F ?? []), B = new Set(pb.lineStarts());
          const changed = F ? [...A].filter((x) => !B.has(x)).length + [...B].filter((x) => !A.has(x)).length : -1;
          return { lines: starts.length, fills, changed,
                   sig: fills.map((f) => f === null ? 'x' : f.toFixed(3)).join(',') };
        };
        const base = state();
        if (base.changed !== 0) return { ok: false, detail: 'baseline is not a fixed point: ' + JSON.stringify(base) };
        if (base.lines !== 2) return { ok: false, detail: '20 whole rests expected 2 lines, got ' + base.lines };
        const v30 = m.getVoiceLength(3);
        /* Bar 11 = the second line's first measure, in voice 3. */
        m.setCursor(m.getMeasureStartCursor(1, 10), 1);
        m.setVoicePreservingMeasure(3);
        let worst = 0;
        for (let i = 0; i < 30; i++) {
          if (m.insertRestAtCursor({ duration: '4', dots: 0 }) === null) return { ok: false, detail: 'insert rejected at quarter #' + (i + 1) };
          H.reRender();
          const st = state();
          if (st.fills.some((f) => f === null)) return { ok: false, detail: 'naturals cold after quarter #' + (i + 1) };
          if (st.changed !== 0) return { ok: false, detail: 'stale partition after quarter #' + (i + 1) + ': ' + st.lines + ' lines on screen, F differs by ' + st.changed + ' boundaries (' + st.sig + ')' };
          worst = Math.max(worst, ...st.fills);
        }
        /* The defect this fixture exists for: the held partition let a line
           reach fill 1.433 (43% compression - stems into accidentals). F never
           packs a line past its natural width (no atom here is wider). */
        if (worst > 1.0 + 1e-9) return { ok: false, detail: 'a line was compressed to fill ' + worst.toFixed(3) + ' (held-partition defect; 1.433 before the 2026-09-19 fix)' };
        /* Undo contract: emptying voice 3 again must restore the ORIGINAL
           partition exactly, not merely a legal one. */
        m.setCursor(m.getVoiceLength(3), 3);
        for (let g = 0; g < 90 && m.getVoiceLength(3) > v30; g++) {
          if (!m.deleteAtCursor()) break;
          H.reRender();
          const st = state();
          if (st.changed !== 0) return { ok: false, detail: 'stale partition after delete #' + (g + 1) + ': ' + st.lines + ' lines, F differs by ' + st.changed + ' boundaries' };
        }
        if (m.getVoiceLength(3) !== v30) return { ok: false, detail: 'voice 3 not emptied: ' + m.getVoiceLength(3) + ' vs ' + v30 };
        const end = state();
        if (end.sig !== base.sig) return { ok: false, detail: 'layout not restored: ' + end.sig + ' vs baseline ' + base.sig };
        return { ok: true };
      })()` },
  ],
  pageBalanceDeleteAtSectionEnd: [
    { name: 'emptying bars at a section end: once the final line falls below MIN_FILL the balancer repairs the section locally, on the splice path',
      expr: `(() => {
        const H = window.__hkl_composer; const m = H.model; const pb = H.renderer['pageBreaks'];
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) H.reRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (' + pb.lastDeriveReason + ')' };
        /* Naturals for every section are warmed before the paint
           (warmAllNaturals); there is no job left to drain. */
        const ids0 = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const idIdx0 = new Map(ids0.map((id, i) => [id, i]));
        const starts0 = pb['startIds'].map((id) => idIdx0.get(id));
        if (!starts0.includes(17)) return { ok: false, detail: 'section II does not start a line: ' + starts0.join(',') };
        let fired = null;
        for (let bar = 16; bar >= 12 && !fired; bar--) {
          for (let n = 0; n < 4; n++) {
            m.setCursor(m.getMeasureStartCursor(1, bar), 1);
            if (!m.deleteAtCursor()) break;
          }
          H.reRender();
          if (pb.lastDeriveReason !== '') return { ok: false, detail: 'derive after emptying bar ' + bar + ': ' + pb.lastDeriveReason };
          if (pb.lastBalance.applied) fired = { bar, lb: JSON.parse(JSON.stringify(pb.lastBalance)) };
        }
        if (!fired) return { ok: false, detail: 'balancer never fired: ' + JSON.stringify(pb.lastBalance) };
        if (fired.lb.changed > 4) return { ok: false, detail: 'balance was not local: ' + JSON.stringify(fired) };
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const idIdx = new Map(ids.map((id, i) => [id, i]));
        const starts = pb['startIds'].map((id) => idIdx.get(id));
        const secEnd = starts.indexOf(17) - 1;
        if (secEnd < 0) return { ok: false, detail: 'section II lost its line start: ' + starts.join(',') };
        const f = pb['lineFill'](starts, secEnd, ids);
        if (f === null || f < 0.65) return { ok: false, detail: 'section-final line fill ' + f + ' after balance (starts ' + starts.join(',') + ')' };
        const led = H.renderer.renderLedger();
        if (!led.length || led[led.length - 1].full) return { ok: false, detail: 'the repair render was a full engrave: ' + JSON.stringify(led[led.length - 1]) };
        return { ok: true };
      })()` },
  ],
  pageEditPreservesScroll: [
    { name: 'a page-view edit rendered while scrolled to a later page keeps the scroll position (no placeholder-collapse clamp)',
      expr: `(() => {
        const H = window.__hkl_composer;
        const m = H.model;
        const score = document.getElementById('score');
        try {
          const pages = score.querySelectorAll('.score-page').length;
          if (pages < 3) return { ok: false, detail: 'need >= 3 pages so a one-line merge cannot shrink the extent below the offset; got ' + pages };
          score.querySelector('.score-page[data-page="2"]').scrollIntoView();
          const top0 = score.scrollTop;
          if (top0 <= 0) return { ok: false, detail: 'scrollIntoView left scrollTop at 0 — fixture cannot exercise the clamp' };
          /* Edit a measure on page 2 through the model (no key handlers, so no
             scroll-into-view correction can mask a clamp). The edit may merge
             one line (content legitimately shifts BELOW it) — the invariant is
             that the numeric scroll offset survives the rebuild. Small doc →
             the render is synchronous, scrollTop is readable right after. */
          m.setCursor(m.getMeasureStartCursor(1, 20), 1);
          if (!m.deleteAtCursor()) return { ok: false, detail: 'delete rejected' };
          H.reRender();
          const top1 = score.scrollTop;
          return Math.abs(top1 - top0) <= 4
            ? { ok: true }
            : { ok: false, detail: 'scrollTop moved across a page edit: ' + top0 + ' → ' + top1 };
        } finally {
          /* Leave no scroll state for later fixtures (the runner reset also
             zeroes it; belt and braces since this fixture's whole point is
             that renders no longer reset scroll for us). */
          score.scrollTop = 0;
          score.scrollLeft = 0;
        }
      })()` },
  ],
  pageLineBreaksDeriveFallback: [
    { name: 'a page-break toggle is carried by the refill and lands as a splice (no derive), giving 2 pages',
      expr: `(async () => {
        const H = window.__hkl_composer;
        const m = H.model;
        const pb = H.renderer['pageBreaks'], ps = H.renderer['pageSplicer'];
        for (let i = 0; i < 3 && !pb.ownershipActive(); i++) H.reRender();
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (lastDeriveReason=' + pb.lastDeriveReason + ')' };
        H.renderer.clearRenderLedger();
        if (m.togglePageBreakAt(6) !== true) return { ok: false, detail: 'togglePageBreakAt(6) did not insert a <pb>' };
        H.reRender(); await window.__waitForRender();
        const fulls = H.renderer.renderLedger().filter((e) => e.full);
        if (fulls.length) return { ok: false, detail: 'a page break derived: ' + fulls.map((e) => e.deriveReason || e.skipReason).join('; ') };
        if (ps.lastOutcome !== 'spliced' && ps.lastOutcome !== 'applied') return { ok: false, detail: 'outcome ' + ps.lastOutcome + ' (' + ps.lastSkipReason + ')' };
        const pages = document.querySelectorAll('#score .score-page').length;
        return pages === 2 ? { ok: true } : { ok: false, detail: 'expected 2 pages after the <pb>, got ' + pages };
      })()` },
  ],
  pag_hideEmptyNoHole: [
    { name: 'no page is under-full while the next page\'s first system fits (hide-empty runs)',
      expr: `window.__test.assertPaginationFirstFit({ mountAll: true })` },
    { name: 'the document spans more than one page and holds one-staff systems',
      expr: `(() => {
        const pages = document.querySelectorAll('#score .score-page').length;
        const oneStaff = [...document.querySelectorAll('#score g.system')].filter((s) => { const f = s.querySelector('g.measure'); return !!f && f.querySelectorAll(':scope > g.staff').length === 1; }).length;
        return pages >= 2 && oneStaff >= 2 ? { ok: true, detail: pages + ' pages, ' + oneStaff + ' one-staff systems' } : { ok: false, detail: pages + ' pages, ' + oneStaff + ' one-staff systems (want >= 2 and >= 2)' };
      })()` },
  ],
  pag_pageBreakSplices: [
    { name: 'a page break deep in the document splices: page 1 untouched, the break starts a page',
      expr: `(async () => {
        const H = window.__hkl_composer, m = H.model, r = H.renderer;
        const sysOf = (p) => [...document.querySelectorAll('#score .score-page[data-page="' + p + '"] g.system')];
        const pb = r['pageBreaks'];
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const starts = pb.pageStarts();
        if (starts.length < 2) return { ok: false, detail: 'need 2+ pages, got ' + starts.length };
        const li2 = pb['startIds'].indexOf(starts[1]);
        const target = pb['startIds'][li2 + 1];                     /* second line of page 2 */
        if (!target) return { ok: false, detail: 'page 2 has one line' };
        const mi = ids.indexOf(target);
        const before = sysOf(1);
        if (before.length < 2) return { ok: false, detail: 'page 1 has ' + before.length + ' systems' };
        r.clearRenderLedger();
        if (m.togglePageBreakAt(mi) === null) return { ok: false, detail: 'togglePageBreakAt refused' };
        H.reRender(); await window.__waitForRender();
        const fulls = r.renderLedger().filter((e) => e.full);
        if (fulls.length) return { ok: false, detail: 'full render during the edit: ' + fulls.map((e) => e.deriveReason || e.skipReason || '?').join('; ') };
        const after = sysOf(1);
        if (after.length !== before.length || !after.every((sys, i) => sys === before[i])) return { ok: false, detail: 'page 1 was re-rendered or re-paginated (' + before.length + ' -> ' + after.length + ' systems)' };
        const p3 = document.querySelector('#score .score-page[data-page="3"]');
        const first = p3 && p3.querySelector('g.system g.measure');
        if (!first || first.id !== target) return { ok: false, detail: 'page 3 does not start at the break (' + (first && first.id) + ' vs ' + target + ')' };
        return { ok: true };
      })()` },
  ],
  pag_sectionHeaderSplices: [
    { name: 'a section header deep in the document splices: page 1 untouched, the header line restarts',
      expr: `(async () => {
        const H = window.__hkl_composer, m = H.model, r = H.renderer;
        const sysOf = (p) => [...document.querySelectorAll('#score .score-page[data-page="' + p + '"] g.system')];
        const pb = r['pageBreaks'];
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const starts = pb.pageStarts();
        if (starts.length < 2) return { ok: false, detail: 'need 2+ pages, got ' + starts.length };
        const li2 = pb['startIds'].indexOf(starts[1]);
        const target = pb['startIds'][li2 + 1];                     /* second line of page 2 */
        if (!target) return { ok: false, detail: 'page 2 has one line' };
        const mi = ids.indexOf(target);
        const before = sysOf(1);
        if (before.length < 2) return { ok: false, detail: 'page 1 has ' + before.length + ' systems' };
        r.clearRenderLedger();
        if (!m.setSectionHeaderAt(mi, 'II')) return { ok: false, detail: 'setSectionHeaderAt refused' };
        H.reRender(); await window.__waitForRender();
        const fulls = r.renderLedger().filter((e) => e.full);
        if (fulls.length) return { ok: false, detail: 'full render during the edit: ' + fulls.map((e) => e.deriveReason || e.skipReason || '?').join('; ') };
        const after = sysOf(1);
        if (after.length !== before.length || !after.every((sys, i) => sys === before[i])) return { ok: false, detail: 'page 1 was re-rendered or re-paginated (' + before.length + ' -> ' + after.length + ' systems)' };
        const me = document.getElementById(target);
        const sys = me && me.closest('g.system');
        if (!sys || sys.querySelector('g.measure').id !== target) return { ok: false, detail: 'the header measure does not start a system' };
        if (!document.querySelector('text.hkl-section-header[data-for="' + target + '"]')) return { ok: false, detail: 'no section title rendered for ' + target };
        return { ok: true };
      })()` },
  ],
  pag_meterChangeSplices: [
    { name: 'a meter change deep in the document splices: every page-1 line F did not change keeps its system node, the change is drawn',
      expr: `(async () => {
        const H = window.__hkl_composer, m = H.model, r = H.renderer;
        const sysOf = (p) => [...document.querySelectorAll('#score .score-page[data-page="' + p + '"] g.system')];
        const pb = r['pageBreaks'];
        const ids = m.allMeasures().map((x) => x.getAttribute('xml:id'));
        const starts = pb.pageStarts();
        if (starts.length < 2) return { ok: false, detail: 'need 2+ pages, got ' + starts.length };
        const li2 = pb['startIds'].indexOf(starts[1]);
        const target = pb['startIds'][li2 + 1];                     /* second line of page 2 */
        if (!target) return { ok: false, detail: 'page 2 has one line' };
        const mi = ids.indexOf(target);
        const before = sysOf(1);
        if (before.length < 2) return { ok: false, detail: 'page 1 has ' + before.length + ' systems' };
        /* F re-partitions the whole section and may reach back onto page 1
           (no cap on reach: partition spec G3); what must hold is locality —
           a line whose start and end F left alone is not re-engraved. */
        const L0 = pb.lineStarts().slice();
        r.clearRenderLedger();
        m.setMeterAt(mi, 3, 4);
        H.reRender(); await window.__waitForRender();
        const fulls = r.renderLedger().filter((e) => e.full);
        if (fulls.length) return { ok: false, detail: 'full render during the edit: ' + fulls.map((e) => e.deriveReason || e.skipReason || '?').join('; ') };
        const L1 = pb.lineStarts();
        const endOf = (L, id) => { const k = L.indexOf(id); return k < 0 ? null : (L[k + 1] ?? '$'); };
        let kept = 0;
        for (const sys of before) {
          const id = sys.querySelector('g.measure')?.id;
          if (!id || endOf(L1, id) !== endOf(L0, id)) continue;
          if (!sys.isConnected) return { ok: false, detail: 'page-1 line ' + id + ' was unchanged by F but re-engraved' };
          kept++;
        }
        if (kept < 1) return { ok: false, detail: 'no page-1 line survived the edit (' + before.length + ' systems)' };
        const me = document.getElementById(target);
        if (!me || !me.querySelector('g.meterSig')) return { ok: false, detail: 'no meter signature drawn at ' + target };
        return { ok: true };
      })()` },
  ],
  pag_setupApplyKeepsSystems: [
    { name: 'Setup apply redraws the headers only: every system is the same node, the title is new',
      expr: `(async () => {
        const H = window.__hkl_composer, m = H.model, r = H.renderer;
        const all = () => [...document.querySelectorAll('#score .score-page g.system')];
        const before = all();
        if (before.length < 4) return { ok: false, detail: 'only ' + before.length + ' systems' };
        r.clearRenderLedger();
        m.setTitle('Renamed Piece');
        if (typeof r.refreshPageHeaders !== 'function') return { ok: false, detail: 'renderer.refreshPageHeaders missing (Setup apply still force-renders)' };
        r.refreshPageHeaders();
        H.reRender(); await window.__waitForRender();
        const fulls = r.renderLedger().filter((e) => e.full);
        if (fulls.length) return { ok: false, detail: 'full render on Setup apply: ' + fulls.map((e) => e.deriveReason || e.skipReason || '?').join('; ') };
        const after = all();
        if (after.length !== before.length || !after.every((sys, i) => sys === before[i])) return { ok: false, detail: 'systems were re-rendered (' + before.length + ' -> ' + after.length + ')' };
        const title = document.querySelector('#score .score-page[data-page="1"] text.hkl-title');
        if (!title || !title.textContent.includes('Renamed Piece')) return { ok: false, detail: 'title not redrawn: ' + (title && title.textContent) };
        return { ok: true };
      })()` },
  ],
  pag_addInstrumentAllLines: [
    { name: 'adding an instrument re-renders every line through the assembly and says so',
      expr: `(async () => {
        const H = window.__hkl_composer, m = H.model, r = H.renderer;
        r.clearRenderLedger();
        m.addInstrument({ name: 'Probe', staffCount: 1 });
        H.reRender(); await window.__waitForRender();
        const fulls = r.renderLedger().filter((e) => e.full);
        if (!fulls.length) return { ok: false, detail: 'no full render recorded for add instrument' };
        const bad = fulls.filter((e) => !/^all lines/.test(e.deriveReason || ''));
        if (bad.length) return { ok: false, detail: 'full render reason not "all lines…": ' + bad.map((e) => e.deriveReason || e.skipReason || '?').join('; ') };
        r.mountAllPages();
        const systems = [...document.querySelectorAll('#score .score-page g.system')];
        const short = systems.filter((s) => s.querySelector('g.measure').querySelectorAll(':scope > g.staff').length !== 3);
        if (short.length) return { ok: false, detail: short.length + ' of ' + systems.length + ' systems lack the third staff' };
        return { ok: true };
      })()` },
  ],
  pag_loadCardsUpFront: [
    { name: 'every page card exists at first paint (count only corrected if the total differs)',
      expr: `(() => {
        const H = window.__hkl_composer;
        H.renderer.runExtentsJobNow();
        const final = document.querySelectorAll('#score .score-page').length;
        if (final < 4) return { ok: false, detail: 'document has ' + final + ' page(s); need 4+' };
        if (window.__pagCardsAtPaint !== final) return { ok: false, detail: 'cards at first paint ' + window.__pagCardsAtPaint + ', final ' + final };
        return { ok: true };
      })()` },
  ],
  pag_zoomKeepsCardsAndScroll: [
    { name: 'a zoom change keeps the page cards and the scroll position at first paint',
      expr: `(async () => {
        await window.__waitForRender();
        const score = document.getElementById('score');
        if (window.__pagCardsAtPaint === undefined) return { ok: false, detail: 'the zoom render never landed' };
        if (window.__pagCardsAtPaint !== window.__pagCardsBefore) return { ok: false, detail: 'cards at paint ' + window.__pagCardsAtPaint + ' != before ' + window.__pagCardsBefore };
        /* Zoom 100 → 50 halves the cards: the reader stays on the same PAGE,
           so the scroll position scales by the card-height ratio (card margins
           are unscaled, hence the tolerance). */
        const want = window.__pagScrollBefore * 0.5;
        if (Math.abs(window.__pagScrollAtPaint - want) > 160) return { ok: false, detail: 'scrollTop at paint ' + window.__pagScrollAtPaint + ', before ' + window.__pagScrollBefore + ' (expected about ' + Math.round(want) + ')' };
        return { ok: true };
      })()` },
  ],
  pag_buildingPageHidden: [
    { name: 'a page being built is not painted; unbuilt pages are blank cards',
      expr: `(() => {
        const H = window.__hkl_composer;
        const cardsAtPaint = window.__pagCardsAtPaint, pending = window.__pagPendingAtPaint;
        H.renderer.runExtentsJobNow();
        const final = document.querySelectorAll('#score .score-page').length;
        if (final < 3) return { ok: false, detail: 'document has ' + final + ' page(s); need 3+' };
        if (window.__pagBuildingVisibility === 'no building page') return { ok: true, detail: 'assembly finished synchronously (' + final + ' pages) — nothing was in flight' };
        if (window.__pagBuildingVisibility !== 'hidden') return { ok: false, detail: 'the page being built was visible (visibility=' + window.__pagBuildingVisibility + ')' };
        if (cardsAtPaint !== final) return { ok: false, detail: 'cards at paint ' + cardsAtPaint + ' (pending ' + pending + '), final ' + final };
        return { ok: true };
      })()` },
  ],
  pag_zoomRescalesInPlace: [
    { name: 'a zoom renders no window: every system node survives, page starts hold, no full render',
      expr: `(async () => {
        const H = window.__hkl_composer, r = H.renderer, pb = r['pageBreaks'];
        r.mountAllPages();
        const before = [...document.querySelectorAll('#score .score-page g.system')];
        const startsBefore = JSON.stringify(pb.pageStarts());
        if (before.length < 6) return { ok: false, detail: 'only ' + before.length + ' systems' };
        const tk = r['spliceTk']; const orig = tk.loadData; let loads = 0; tk.loadData = function (...a) { loads++; return orig.apply(this, a); };
        r.clearRenderLedger();
        r.setZoom(50); H.reRender(); await window.__waitForRender();
        r.runExtentsJobNow(); r.mountAllPages();
        tk.loadData = orig;
        const fulls = r.renderLedger().filter((e) => e.full);
        const after = [...document.querySelectorAll('#score .score-page g.system')];
        const same = after.length === before.length && after.every((sys, i) => sys === before[i]);
        const w = document.querySelector('#score .score-page[data-page="1"] > svg').getAttribute('width');
        r.setZoom(100); H.reRender(); await window.__waitForRender();
        if (loads) return { ok: false, detail: 'the zoom rendered ' + loads + ' window(s)' };
        if (fulls.length) return { ok: false, detail: 'the zoom was a full render: ' + fulls.map((e) => e.deriveReason).join('; ') };
        if (!same) return { ok: false, detail: 'systems were replaced (' + before.length + ' -> ' + after.length + ')' };
        if (JSON.stringify(pb.pageStarts()) !== startsBefore) return { ok: false, detail: 'page starts changed across the zoom' };
        if (!/^1079/.test(w || '')) return { ok: false, detail: 'card width at zoom 50 is ' + w + ', expected 1079.5px' };
        return { ok: true };
      })()` },
  ],
  pag_zoomRerunKeepsSlursAndGaps: [
    { name: 'after a zoom to 50 the flipped slur keeps Verovio\'s curve (no re-draw), every instrument-gap shift holds (within a grid step) and no system grows',
      expr: `(async () => {
        const H = window.__hkl_composer, r = H.renderer;
        r.mountAllPages();
        const norm = (d) => { const n = (d || '').match(/-?\\d+(\\.\\d+)?/g); if (!n) return null; const x0 = +n[0], y0 = +n[1]; return n.map((v, i) => Math.round(+v - (i % 2 ? y0 : x0))); };
        const snap = () => {
          const g = document.getElementById('s-test-zoom-rerun');
          const path = g && g.querySelector('path');
          return {
            curvedir: g && g.getAttribute('data-curvedir'), mark: g && g.getAttribute('data-hkl-slur'), d: path && norm(path.getAttribute('d')),
            systems: [...document.querySelectorAll('#score .score-page g.system')].map((s) => s.getBBox().height),
            shifts: [...document.querySelectorAll('#score .score-page g.staff')].map((st) => parseFloat(st.getAttribute('data-hkl-ishift') || '0') || 0),
            accidTexts: document.querySelectorAll('#score .score-page g.accid text').length,
          };
        };
        const before = snap();
        if (!before.d) return { ok: false, detail: 'slur s-test-zoom-rerun not rendered' };
        if (before.curvedir !== 'below') return { ok: false, detail: 'the side pass did not flip the slur below (data-curvedir=' + before.curvedir + ') — the fixture needs a flipped slur' };
        if (before.mark) return { ok: false, detail: 'the first run already re-drew the slur (' + before.mark + ')' };
        if (!before.accidTexts) return { ok: false, detail: 'no BravuraText accidentals in the DOM — the HEJI injection did not run, so the fixture cannot exercise the re-run' };
        if (!before.shifts.some((v) => v > 0)) return { ok: false, detail: 'no instrument-gap shift on the first run — the fixture needs a shifted system' };
        if (document.querySelectorAll('#score .score-page g.system').length < 2) return { ok: false, detail: 'one system only — the in-place rescale needs several lines' };
        r.clearRenderLedger();
        r.setZoom(50); H.reRender(); await window.__waitForRender();
        const fulls = r.renderLedger().filter((e) => e.full);
        r.runExtentsJobNow(); r.mountAllPages();
        const after = snap();
        r.setZoom(100); H.reRender(); await window.__waitForRender();
        if (fulls.length) return { ok: false, detail: 'the zoom was a full render (' + fulls.map((e) => e.deriveReason).join('; ') + '), not the in-place rescale this fixture exercises' };
        const grid = 20;   /* user units per device pixel at zoom 50 */
        if (after.mark) return { ok: false, detail: 'the zoom re-drew the slur (data-hkl-slur=' + after.mark + ')' };
        if (!after.d || after.d.length !== before.d.length || after.d.some((v, i) => Math.abs(v - before.d[i]) > 1)) return { ok: false, detail: 'the slur curve changed across the zoom: ' + JSON.stringify(before.d) + ' -> ' + JSON.stringify(after.d) };
        if (after.systems.length !== before.systems.length) return { ok: false, detail: 'system count changed ' + before.systems.length + ' -> ' + after.systems.length };
        for (let i = 0; i < before.systems.length; i++) if (Math.abs(after.systems[i] - before.systems[i]) > grid) return { ok: false, detail: 'system ' + i + ' height changed ' + before.systems[i].toFixed(0) + ' -> ' + after.systems[i].toFixed(0) + ' user units across the zoom' };
        if (after.shifts.length !== before.shifts.length) return { ok: false, detail: 'staff count changed' };
        for (let i = 0; i < before.shifts.length; i++) if (Math.abs(after.shifts[i] - before.shifts[i]) > grid) return { ok: false, detail: 'instrument-gap shift on staff ' + i + ' changed ' + before.shifts[i] + ' -> ' + after.shifts[i] + ' across the zoom' };
        return { ok: true, detail: 'slur curve, ' + before.shifts.filter((v) => v > 0).length + ' shifted staves and ' + before.systems.length + ' system heights held across the zoom' };
      })()` },
  ],
  pag_courtesyAtLineEnd: [
    { name: 'the measure before a line-start key change draws the courtesy signature',
      expr: `(() => {
        const prev = document.getElementById(window.__courtesyPrevId);
        if (!prev) return { ok: false, detail: 'measure before the change not rendered (' + window.__courtesyPrevId + ')' };
        const sys = prev.closest('g.system');
        const last = sys && [...sys.querySelectorAll(':scope > g.measure')].pop();
        if (!last || last.id !== prev.id) return { ok: false, detail: 'the key change does not start a line (last measure of its system is ' + (last && last.id) + ')' };
        const courtesy = prev.querySelectorAll('g.keySig').length;
        return courtesy > 0 ? { ok: true, detail: courtesy + ' courtesy keySig(s)' } : { ok: false, detail: 'no courtesy keySig in ' + prev.id + ' before the five-sharp line' };
      })()` },
  ],
  pag_spillThenPullBack: [
    { name: 'the spilled line returns to its page when it shrinks back',
      expr: `(() => {
        const b = window.__pagCountsBefore, g = window.__pagCountsGrown;
        const a = [...document.querySelectorAll('#score .score-page')].map((p) => p.querySelectorAll('g.system').length);
        if (!(g[0] < b[0])) return { ok: false, detail: 'the grow step did not spill (' + b.join('/') + ' -> ' + g.join('/') + ')' };
        if (a.join('/') !== b.join('/')) return { ok: false, detail: 'pages after the shrink ' + a.join('/') + ' != before the grow ' + b.join('/') + ' (grown ' + g.join('/') + ')' };
        return { ok: true };
      })()` },
  ],
  pag_shrinkPulls: [
    { name: 'after the shrink no page is under-full (the next page\'s first system was pulled up)',
      expr: `window.__test.assertPaginationFirstFit({ mountAll: true })` },
    { name: 'the shrink pulled a system onto page 1 and added no page',
      expr: `(() => {
        const n = document.querySelectorAll('#score .score-page').length;
        const p1 = document.querySelector('#score .score-page[data-page="1"]').querySelectorAll('g.system').length;
        return n <= window.__pagPagesBefore && p1 > window.__pagP1Before
          ? { ok: true, detail: 'pages ' + window.__pagPagesBefore + ' -> ' + n + ', page 1 systems ' + window.__pagP1Before + ' -> ' + p1 }
          : { ok: false, detail: 'pages ' + window.__pagPagesBefore + ' -> ' + n + ', page 1 systems ' + window.__pagP1Before + ' -> ' + p1 };
      })()` },
  ],
  pag_growPushes: [
    { name: 'after the growth no page overflows and none is under-full',
      expr: `window.__test.assertPaginationFirstFit({ mountAll: true })` },
    { name: 'the growth added at least one page',
      expr: `(() => { const n = document.querySelectorAll('#score .score-page').length; return n > window.__pagPagesBefore ? { ok: true, detail: window.__pagPagesBefore + ' -> ' + n } : { ok: false, detail: window.__pagPagesBefore + ' -> ' + n }; })()` },
  ],
  pag_userPbHonoured: [
    { name: 'page 2 starts at the measure after the user page break',
      expr: `(() => {
        const doc = window.__hkl_composer.model.getDoc();
        const pb = doc.querySelector('pb'); if (!pb) return { ok: false, detail: 'no <pb> in the model' };
        const next = pb.nextElementSibling; const id = next && next.getAttribute('xml:id');
        const p2 = document.querySelector('#score .score-page[data-page="2"]');
        if (!p2) return { ok: false, detail: 'no page 2' };
        window.__hkl_composer.renderer.mountAllPages();
        const first = p2.querySelector('g.system g.measure');
        return first && first.id === id ? { ok: true } : { ok: false, detail: 'page 2 starts at ' + (first && first.id) + ', pb before ' + id };
      })()` },
    { name: 'first-fit holds with the hard start excepted', expr: `window.__test.assertPaginationFirstFit({ mountAll: true })` },
  ],
  pag_zoomRoundTripKeepsPages: [
    { name: 'the page starts survive a zoom round-trip',
      expr: `(() => { const now = JSON.stringify(window.__hkl_composer.renderer['pageBreaks'].pageStarts()); return now === window.__pagStartsBefore ? { ok: true } : { ok: false, detail: 'before ' + window.__pagStartsBefore + ' after ' + now }; })()` },
    { name: 'first-fit holds after the round-trip', expr: `window.__test.assertPaginationFirstFit({ mountAll: true })` },
  ],

  partF_laterPageEditUndo: [
    { name: 'a bar insert on a later page re-partitions its section by F (a splice), and undo restores partition, pages and geometry exactly',
      expr: `(async () => {${PARTF_LIB}
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) { H.reRender(); await settle(); }
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (' + pb.lastDeriveReason + ')' };
        if (pb.pageStarts().length < 3) return { ok: false, detail: 'need 3+ pages, got ' + pb.pageStarts().length };
        const load = state();
        if (!isF()) return { ok: false, detail: 'the load is not F' };
        /* A bar on page 3, in section II (section I ends on page 1 or 2). */
        const mi = ids().indexOf(pb.pageStarts()[2]) + 2;
        const snap = m.snapshotState();
        r.clearRenderLedger();
        m.insertMeasureAt(mi);
        H.reRender(); await settle();
        if (noFull().length) return { ok: false, detail: 'the edit full-rendered: ' + noFull().join('; ') };
        if (!isF()) return { ok: false, detail: 'after the edit the partition is not F' };
        const edited = state();
        if (edited.lines === load.lines) return { ok: false, detail: 'the insert moved no boundary — nothing to undo' };
        r.clearRenderLedger();
        m.restoreSnapshot(snap);
        H.reRender(); await settle();
        if (noFull().length) return { ok: false, detail: 'the undo full-rendered: ' + noFull().join('; ') };
        const back = state();
        if (back.lines !== load.lines) return { ok: false, detail: 'undo did not restore the line partition' };
        if (back.pages !== load.pages) return { ok: false, detail: 'undo did not restore the pagination: ' + load.pages + ' -> ' + back.pages };
        const d = geomDiff(load.geom, back.geom);
        if (d.length) return { ok: false, detail: d.length + ' measures moved across edit+undo: ' + d.slice(0, 3).join(' | ') };
        return { ok: true, detail: Object.keys(load.geom).length + ' measures compared' };
      })()` },
  ],
  partF_editUndoChain: [
    { name: 'a chain of edits (bar inserts early and deep, a key change, a section header) then a restore of the load snapshot is the load layout bit for bit; F after every step',
      expr: `(async () => {${PARTF_LIB}
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) { H.reRender(); await settle(); }
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (' + pb.lastDeriveReason + ')' };
        const load = state();
        const snap = m.snapshotState();
        const steps = [
          ['insert bar 3', () => m.insertMeasureAt(2)],
          ['insert bar 41', () => m.insertMeasureAt(40)],
          ['key change at bar 20', () => m.setKeySigAt(19, '2s', 'major')],
          ['section header at bar 50', () => m.setSectionHeaderAt(49, 'II')],
          ['insert bar 60', () => m.insertMeasureAt(59)],
        ];
        for (const [what, fn] of steps) {
          fn(); H.reRender(); await settle();
          if (pb.lastDeriveReason) return { ok: false, detail: what + ': derived (' + pb.lastDeriveReason + ')' };
          if (!isF()) return { ok: false, detail: what + ': the partition is not F' };
        }
        m.restoreSnapshot(snap);
        H.reRender(); await settle();
        const back = state();
        if (back.lines !== load.lines) return { ok: false, detail: 'restore did not bring back the load partition' };
        if (back.pages !== load.pages) return { ok: false, detail: 'restore did not bring back the load pagination' };
        const d = geomDiff(load.geom, back.geom);
        if (d.length) return { ok: false, detail: d.length + ' measures differ from the load: ' + d.slice(0, 3).join(' | ') };
        return { ok: true };
      })()` },
  ],
  partF_reloadEqualsLive: [
    { name: 'after edits, re-loading the serialized document gives the same line and page starts (a reload never changes the screen)',
      expr: `(async () => {${PARTF_LIB}
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) { H.reRender(); await settle(); }
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (' + pb.lastDeriveReason + ')' };
        m.insertMeasureAt(4); H.reRender(); await settle();
        m.setKeySigAt(33, '3f', 'major'); H.reRender(); await settle();
        m.insertMeasureAt(50); H.reRender(); await settle();
        if (!isF()) return { ok: false, detail: 'the live partition is not F' };
        const live = state();
        window.__composerLoadHkc(m.serialize());
        for (let i = 0; i < 3 && !pb.ownershipActive(); i++) { H.reRender(); await settle(); }
        await settle();
        const fresh = state();
        if (fresh.lines !== live.lines) {
          const a = live.lines.split(','), b = fresh.lines.split(',');
          let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
          return { ok: false, detail: 'reload re-partitioned at line ' + i + ': live ' + J(a.slice(i, i + 3)) + ' vs reload ' + J(b.slice(i, i + 3)) };
        }
        if (fresh.pages !== live.pages) return { ok: false, detail: 'reload re-paginated: ' + live.pages + ' -> ' + fresh.pages };
        return { ok: true, detail: live.lines.split(',').length + ' lines' };
      })()` },
  ],
  partF_tailStubShortReach: [
    { name: 'a tail stub (greedy 6+6+6+1) is repaired by a short reach: greedy\'s line count, a few boundaries moved, the last line no longer a stub, nothing compressed',
      expr: `(async () => {${PARTF_LIB}
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) { H.reRender(); await settle(); }
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (' + pb.lastDeriveReason + ')' };
        const pick = pb.lastInitialBalance?.picks?.[0];
        if (!pick) return { ok: false, detail: 'no pick recorded: ' + J(pb.lastInitialBalance) };
        const I = ids(); const st = pb.lineStarts().map((id) => I.indexOf(id));
        const lens = st.map((x, k) => (k + 1 < st.length ? st[k + 1] : I.length) - x);
        const fills = st.map((_, k) => pb['lineFill'](st, k, I));
        if (pick.exempt) return { ok: false, detail: 'section exempted: ' + J(pick) };
        if (!(pick.changes >= 1 && pick.changes <= 3)) return { ok: false, detail: 'reach not short: ' + J(pick) + ' lens ' + lens };
        if (lens[lens.length - 1] <= 1) return { ok: false, detail: 'the stub survived: lens ' + lens };
        if (lens.slice(0, -3).some((L) => L !== lens[0])) return { ok: false, detail: 'the body moved: lens ' + lens };
        if (fills.some((f) => f === null || f > 1.0 + 1e-9)) return { ok: false, detail: 'a line is compressed: ' + fills.map((f) => f && f.toFixed(3)) };
        return { ok: true, detail: 'lens ' + lens.join(',') + ', ' + pick.changes + ' changes, min ' + pick.min.toFixed(3) };
      })()` },
  ],
  partF_wideMeasureAlone: [
    { name: 'a measure wider than a line sits alone on its line; every other line fits at fill ≤ 1.00',
      expr: `(async () => {${PARTF_LIB}
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) { H.reRender(); await settle(); }
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (' + pb.lastDeriveReason + ')' };
        const I = ids(); const st = pb.lineStarts().map((id) => I.indexOf(id));
        const wide = I.findIndex((_, i) => (pb['naturals'].get(I[i]) ?? 0) > pb['budgetW']);
        if (wide < 0) return { ok: false, detail: 'no measure wider than the line: the material is too narrow (' + I.map((id) => Math.round(pb['naturals'].get(id) ?? 0)).join(',') + ' vs budget ' + Math.round(pb['budgetW']) + ')' };
        const k = st.indexOf(wide);
        if (k < 0 || (k + 1 < st.length ? st[k + 1] : I.length) !== wide + 1) return { ok: false, detail: 'the wide measure ' + wide + ' does not sit alone: starts ' + st.join(',') };
        const fills = st.map((_, j) => pb['lineFill'](st, j, I));
        const bad = fills.map((f, j) => [f, j]).filter(([f, j]) => j !== k && (f === null || f > 1.0 + 1e-9));
        if (bad.length) return { ok: false, detail: 'compressed lines: ' + J(bad) };
        return { ok: true, detail: 'starts ' + st.join(',') + ', wide line fill ' + fills[k].toFixed(3) };
      })()` },
  ],
  partF_deferredTailMountsExact: [
    { name: 'an early insert with only pages 1-2 mounted leaves the re-flowed tail unengraved (deferred cards); mounting each page engraves and re-fits it, ending first-fit and F',
      expr: `(async () => {${PARTF_LIB}
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) { H.reRender(); await settle(); }
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (' + pb.lastDeriveReason + ')' };
        r.setMountWindowEnabled(false);
        const as = r['assembler'];
        if (typeof r.mountAllPages === 'function') r.mountAllPages();
        const n0 = as.pageCount;
        if (n0 < 4) return { ok: false, detail: 'need 4+ pages, got ' + n0 };
        r['pageIo']?.disconnect();
        for (let p = 3; p <= n0; p++) r['unmountPage'](p);
        const warns = []; const ow = console.warn;
        console.warn = (...a) => { const t = a.join(' '); if (!/^\\[Warning\\]/.test(t)) warns.push(t); ow(...a); };
        let rendered;
        try {
          r.clearRenderLedger();
          m.insertMeasureAt(2); H.reRender(); await settle();
          rendered = as.lastRepaginate.renderedLines;
        } finally { console.warn = ow; }
        if (warns.length) return { ok: false, detail: 'warnings: ' + warns.join(' | ') };
        if (noFull().length) return { ok: false, detail: 'the edit full-rendered: ' + noFull().join('; ') };
        if (!isF()) return { ok: false, detail: 'the partition is not F after the insert' };
        const deferred = [...as.stalePages];
        if (!deferred.length) return { ok: false, detail: 'no page was deferred — the tail was engraved synchronously' };
        if (deferred.some((p) => as.isMounted(p))) return { ok: false, detail: 'a deferred page is mounted: ' + deferred };
        /* Scroll order: mount every page front to back. */
        for (let p = 1; p <= as.pageCount; p++) as.mount(p);
        await settle();
        if (as.stalePages.size) return { ok: false, detail: 'pages still deferred after mounting all: ' + [...as.stalePages] };
        const ff = window.__test.assertPaginationFirstFit({ mountAll: true });
        if (!ff.ok) return { ok: false, detail: 'pagination after mounting is not first-fit: ' + ff.detail };
        if (!isF()) return { ok: false, detail: 'the partition is not F after mounting' };
        const dom = as.domLineStarts().join();
        if (dom !== pb.lineStarts().join()) return { ok: false, detail: 'the pages draw another partition than the committed one' };
        return { ok: true, detail: n0 + ' -> ' + as.pageCount + ' pages, ' + deferred.length + ' deferred, ' + rendered + ' lines engraved at the edit' };
      })()` },
  ],
  partF_clefInitialReload: [
    { name: 'after a delete makes a clef measure-initial, the live inputs (the previous bar\'s natural, the signature context there) and the partition equal a reload\'s',
      expr: `(async () => {${PARTF_LIB}
        for (let i = 0; i < 2 && !pb.ownershipActive(); i++) { H.reRender(); await settle(); }
        if (!pb.ownershipActive()) return { ok: false, detail: 'ownership not engaged (' + pb.lastDeriveReason + ')' };
        const meas = () => m.allMeasures()[10];
        const flat = m['flatChildren'](1);
        const first = flat.findIndex((el) => (el.localName === 'note' || el.localName === 'chord') && el.closest('measure') === meas());
        m.setCursor(first, 1);
        if (!m.deleteAtCursor()) return { ok: false, detail: 'delete rejected' };
        H.reRender(); await settle();
        const lay = meas().querySelector('staff[n="1"] > layer');
        if (!lay || !lay.firstElementChild || lay.firstElementChild.localName !== 'clef') return { ok: false, detail: 'fixture cannot pose the case: no measure-initial clef (' + (lay ? [...lay.children].map((c) => c.localName).join(',') : 'no layer') + ')' };
        const I = ids();
        const live = { nat9: pb['naturals'].get(I[9]), key10: pb['sigCtxKeys'][10], sig10: pb['sigWForLineQuiet'](10), lines: pb.lineStarts().join(), pages: pb.pageStarts().join() };
        if (!isF()) return { ok: false, detail: 'the live partition is not F' };
        window.__composerLoadHkc(m.serialize());
        for (let i = 0; i < 3 && !pb.ownershipActive(); i++) { H.reRender(); await settle(); }
        await settle();
        const fresh = { nat9: pb['naturals'].get(I[9]), key10: pb['sigCtxKeys'][10], sig10: pb['sigWForLineQuiet'](10), lines: pb.lineStarts().join(), pages: pb.pageStarts().join() };
        if (live.nat9 == null || fresh.nat9 == null || Math.abs(live.nat9 - fresh.nat9) > 0.01) return { ok: false, detail: 'bar 10 natural: live ' + live.nat9 + ' vs reload ' + fresh.nat9 + ' (the relocated clef is drawn there)' };
        /* The CONTEXT must agree; its measured width may differ by the measure
           number it was measured under (lessons.md 2026-10-20) — open. */
        if (live.key10 !== fresh.key10) return { ok: false, detail: 'signature context at bar 11: live ' + live.key10 + ' vs reload ' + fresh.key10 };
        if (live.lines !== fresh.lines) return { ok: false, detail: 'reload re-partitioned' };
        if (live.pages !== fresh.pages) return { ok: false, detail: 'reload re-paginated' };
        return { ok: true, detail: 'nat ' + live.nat9 + ', sig live ' + live.sig10 + ' / reload ' + fresh.sig10 };
      })()` },
  ],
};
