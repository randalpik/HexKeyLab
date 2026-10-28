// Composer test fixtures — files.
// Fixture spec: { setup?: string, setupKeys?: string[], ...flags }; ASSERTIONS maps
// fixture name → [{ name, expr }]. See ../README.md.

/* In-page LocalFs mock + helpers, prepended to each FILES assertion. `disk`
 * maps path → {text, mtimeMs}; `picks` queues dialog answers (null = cancel);
 * `calls` logs every call. Errors carry the same {status, code, mtimeMs} shape
 * as LocalFsError. */
const FS_MOCK_LIB = `
  const H = window.__hkl_composer;
  const disk = new Map();
  const picks = [];
  const calls = [];
  let clock = 1000.5;
  const ref = (p) => ({ path: p, dir: p.slice(0, p.lastIndexOf('/')), name: p.slice(p.lastIndexOf('/') + 1) });
  const fail = (code, mtimeMs) => { const e = new Error(code); e.status = 409; e.code = code; e.mtimeMs = mtimeMs; return e; };
  const mock = {
    async status() { calls.push(['status']); return { version: 1, picker: 'mock', home: '/home/u', roots: ['/home/u'] }; },
    async pickOpen(filter, startDir) { calls.push(['pickOpen', filter, startDir ?? null]); const p = picks.shift(); return p ? ref(p) : null; },
    async pickSave(filter, name, dir) { calls.push(['pickSave', filter, name, dir ?? null]); const p = picks.shift(); return p ? { ...ref(p), appended: false } : null; },
    async readText(p) { calls.push(['readText', p]); const f = disk.get(p); if (!f) throw fail('not-found'); return { ...ref(p), text: f.text, mtimeMs: f.mtimeMs }; },
    async write(p, data, cond) {
      calls.push(['write', p, cond]);
      const text = typeof data === 'string' ? data : await data.text();
      const cur = disk.get(p);
      let target = p;
      if (cond.kind === 'ifMtime' && (!cur || cur.mtimeMs !== cond.mtimeMs)) throw fail('conflict', cur ? cur.mtimeMs : null);
      if (cond.kind === 'ifAbsent' && cur) throw fail('conflict', cur.mtimeMs);
      if (cond.kind === 'unique') {
        const dot = p.lastIndexOf('.');
        for (let n = 1; disk.has(target); n++) target = p.slice(0, dot) + ' (' + n + ')' + p.slice(dot);
      }
      clock += 1;
      disk.set(target, { text, mtimeMs: clock });
      return { ...ref(target), mtimeMs: clock };
    },
  };
  const until = async (fn, ms = 3000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); }
    return null;
  };
  const ctrlKey = (key) => {
    const ev = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    return ev;
  };
  const writes = () => calls.filter((c) => c[0] === 'write');
  const click = (id) => document.getElementById(id).click();
`;

const fsAssert = (body) => `(async () => {
  ${FS_MOCK_LIB}
  const origConfirm = window.confirm;
  try {
    ${body}
  } catch (e) {
    return { ok: false, detail: String(e && e.stack || e) };
  } finally {
    window.confirm = origConfirm;
    if (H.__setLocalFs) H.__setLocalFs(null);
  }
})()`;

export const FIXTURES = {

  /* ── Export fixtures ──────────────────────────────────────────────────── */
  /* Smoke-test: downloadPdf() should produce a Blob with the `%PDF-` magic
   * header and one PDF page per rendered page. Captures the blob via the
   * URL.createObjectURL hook that downloadBlob() uses, stubbing the anchor
   * click so no actual file download fires. The export path lazy-imports
   * pdfkit + svg-to-pdfkit and reads the LIVE page DOM (mountAllPages); a
   * regression in that chain (missing dep, API drift, Verovio SVG quirks)
   * surfaces here. */
  export_pdf_smoke: {
    setup: `
      /* Insert a colored quarter note so the PDF exercises both the export
       * pipeline AND the non-notehead color-coercion (stems/flags/accids
       * must render black even when the note has an inherited color). */
      m.setCursor(0, 1);
      m.insertChordAtCursor({
        duration: '4', dots: 0,
        notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69,
                  colorHex: '#FF4C79', velocity: 80 }],
      });
    `,
  },
  /* Scroll view has no pages: the toolbar export switches to page view for the
   * export and back afterwards (main.ts btnExportPdf, 2026-09-05). Set up in
   * scroll view through the REAL selector; the assertion presses the real
   * button. The runner's reset returns the view to page afterwards. */
  export_pdf_from_scroll_view: {
    setup: `
      m.setCursor(0, 1);
      m.insertChordAtCursor({
        duration: '4', dots: 0,
        notes: [{ q: 0, r: 0, pname: 'a', accid: '', oct: 4, midi: 69,
                  colorHex: '#FF4C79', velocity: 80 }],
      });
      r();
      const sel = document.getElementById('viewModeSelect');
      sel.value = 'scroll';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    `,
  },

  /* Save / load through the overlay host's local file bridge (2026-09-28).
   * Every flow runs in its assertion (async): the assertion installs an in-page
   * mock of the LocalFs surface (@hkl/bridge/local-fs.ts) via
   * __hkl_composer.__setLocalFs, drives the REAL toolbar buttons / Ctrl+S, and
   * checks the mock's disk + call log. No real host is ever contacted — the
   * runner's __testReset disables the client before every fixture, so a fixture
   * that clicks Save or Export can never reach a live host (or open a real
   * dialog on the desktop). */
  file_download_named_by_title: {
    setup: `m.setTitle('Sonata: No. 1 / Draft');`,
  },
  file_load_ctrl_s_overwrites: { setup: `/* flow runs in the assertion */` },
  file_save_conflict_prompts: { setup: `/* flow runs in the assertion */` },
  file_import_musicxml_saves_numbered_hkc: { setup: `/* flow runs in the assertion */` },
  file_new_doc_save_as: { setup: `m.setTitle('New Piece');` },
  file_host_down_load_uses_input: { setup: `/* flow runs in the assertion */` },
};

export const ASSERTIONS = {
  /* Export → PDF smoke test. Captures the produced Blob via URL.createObjectURL
   * (the path downloadBlob uses), stubs HTMLAnchorElement.click so no actual
   * file save fires, and verifies the blob's first bytes are the PDF magic
   * header. Exercises the full jspdf + svg2pdf pipeline against a real
   * Verovio-rendered SVG with a colored note. */
  export_pdf_from_scroll_view: [
    { name: 'toolbar PDF export from scroll view yields a paginated PDF and returns to scroll view',
      expr: `(async () => {
        const h = window.__hkl_composer;
        const blobs = [];
        const origCreate = URL.createObjectURL;
        URL.createObjectURL = function(b) { blobs.push(b); return 'blob:test-suppressed'; };
        const origClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function() { /* no-op */ };
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        try {
          const score = document.getElementById('score');
          if (h.renderer.getViewMode() !== 'scroll' || !score.classList.contains('view-scroll'))
            return { ok: false, detail: 'setup did not land in scroll view: ' + h.renderer.getViewMode() + ' ' + score.className };
          document.getElementById('btnExportPdf').click();
          let blob = null;
          for (let i = 0; i < 300 && !blob; i++) { await sleep(50); blob = blobs.find(b => b && b.size > 0) || null; }
          if (!blob) return { ok: false, detail: 'no blob within 15 s' };
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const head = String.fromCharCode.apply(null, bytes.slice(0, 5));
          if (head !== '%PDF-') return { ok: false, detail: 'head=' + head };
          let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          /* (No backslashes: this expr is a template literal, which would eat them.) */
          const m = bin.match(/[/]Type [/]Pages[^]{0,120}?[/]Count ([0-9]+)/);
          if (!m || Number(m[1]) < 1) return { ok: false, detail: 'pdf page count=' + (m && m[1]) };
          /* The handler switches back to scroll view after the export. */
          let back = false;
          for (let i = 0; i < 200 && !back; i++) {
            await sleep(50);
            const b = document.getElementById('renderBusy');
            back = h.renderer.getViewMode() === 'scroll' && score.classList.contains('view-scroll') && (!b || b.hidden)
              && !!score.querySelector('svg:not(#cursorOverlay)') && !score.querySelector('.score-page');
          }
          if (!back) return { ok: false, detail: 'did not return to scroll view: mode=' + h.renderer.getViewMode() + ' classes=' + score.className + ' pages=' + score.querySelectorAll('.score-page').length };
          return { ok: true, detail: 'pdfPages=' + m[1] + ' size=' + blob.size };
        } finally {
          URL.createObjectURL = origCreate;
          HTMLAnchorElement.prototype.click = origClick;
        }
      })()` },
  ],
  export_pdf_smoke: [
    { name: 'downloadPdf produces a %PDF- blob',
      expr: `(async () => {
        /* Three nested stubs are required to prevent jsPDF from actually
         * writing a file to the user's Downloads folder:
         *   - URL.createObjectURL: capture the Blob but return a fake URL so
         *     no real blob: URL escapes (a real one with anchor.href would
         *     still trigger save on dispatchEvent below).
         *   - HTMLAnchorElement.prototype.click: defense in depth; some
         *     code paths call .click() directly.
         *   - EventTarget.prototype.dispatchEvent: jsPDF's saveAs (jspdf.es.min)
         *     uses anchor.dispatchEvent(new MouseEvent('click')), which is
         *     NOT routed through .click() — without this stub the file lands
         *     in Downloads even with the other two stubs in place.
         * Verified against jspdf 3.0 source in node_modules. */
        const blobs = [];
        const origCreate = URL.createObjectURL;
        URL.createObjectURL = function(b) { blobs.push(b); return 'blob:test-suppressed'; };
        const origClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function() { /* no-op */ };
        const origDispatch = EventTarget.prototype.dispatchEvent;
        EventTarget.prototype.dispatchEvent = function(ev) {
          /* Suppress click events on anchors (the jsPDF save path) to avoid
           * triggering a real download. Other dispatchEvent calls pass through. */
          if (ev && ev.type === 'click' && this instanceof HTMLAnchorElement) return true;
          return origDispatch.call(this, ev);
        };
        try {
          const handle = window.__hkl_composer;
          const mod = await import('/composer/src/save.ts');
          const pages = handle.renderer.mountAllPages();
          await mod.downloadPdf(pages);
          const blob = blobs.find(b => b && b.size > 0);
          if (!blob) return { ok: false, detail: 'no blob captured; count=' + blobs.length };
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const head = String.fromCharCode.apply(null, bytes.slice(0, 5));
          if (head !== '%PDF-') return { ok: false, detail: 'head=' + head + ' size=' + blob.size };
          /* WYSIWYG, page for page: the PDF's page tree counts exactly the
           * rendered pages (PDFKit writes its object dictionaries in clear;
           * only streams are compressed). */
          let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          /* (No backslashes: this expr is a template literal, which would eat them.) */
          const m = bin.match(/[/]Type [/]Pages[^]{0,120}?[/]Count ([0-9]+)/);
          const domPages = document.querySelectorAll('#score .score-page').length;
          if (!m || Number(m[1]) !== pages.length || pages.length !== domPages)
            return { ok: false, detail: 'pdf pages=' + (m && m[1]) + ' exported=' + pages.length + ' dom=' + domPages };
          return { ok: true, detail: 'size=' + blob.size + ' pages=' + pages.length };
        } finally {
          URL.createObjectURL = origCreate;
          HTMLAnchorElement.prototype.click = origClick;
          EventTarget.prototype.dispatchEvent = origDispatch;
        }
      })()` },
    /* The on-screen render keeps non-notehead glyphs black via composer.html
     * CSS, but svg2pdf processes a detached SVG so that CSS doesn't reach it.
     * forceNonNoteheadBlack must pin color="#000" on every .stem/.flag/.accid
     * /.ledgerLines/.dots container so currentColor resolves to black on the
     * Verovio-embedded `path {stroke: currentColor}` rule. Test against the
     * setup's #FF4C79 note: render a page via the toolkit, apply the helper,
     * and verify no matching container retains the note's color. */
    { name: 'forceNonNoteheadBlack zeros out non-notehead colors',
      expr: `(async () => {
        const handle = window.__hkl_composer;
        const mod = await import('/composer/src/save.ts');
        /* The on-screen page: since 2026-10-08 pages are assembled from line
           windows (pageassembly.ts) and the main toolkit holds no page layout,
           so this is what the export itself clones. */
        const live = document.querySelector('#score .score-page svg');
        const svg = live && live.cloneNode(true);
        if (!svg) return { ok: false, detail: 'no SVG' };
        mod.forceNonNoteheadBlack(svg);
        const sel = '.stem, .flag, .accid, .ledgerLines, .dots';
        const stale = [];
        for (const el of svg.querySelectorAll(sel)) {
          const c = el.getAttribute('color');
          const f = el.getAttribute('fill');
          if (c !== '#000' || f !== '#000') {
            stale.push(el.getAttribute('class') + ' color=' + c + ' fill=' + f);
          }
        }
        /* Also confirm at least one stem exists (proves the fixture's note
         * inserted correctly — otherwise the test would pass vacuously). */
        const stemCount = svg.querySelectorAll('.stem').length;
        if (stemCount === 0) return { ok: false, detail: 'no .stem in SVG (setup did not produce a note)' };
        return stale.length === 0
          ? { ok: true, detail: 'stems=' + stemCount }
          : { ok: false, detail: 'stale: ' + stale.join(' | ') };
      })()` },
    /* Verovio emits per-note g as [notehead, ..., stem]; SVG z-order is
     * document order so the stem otherwise paints over a colored notehead.
     * liftNoteheadsAbove moves each notehead to be the LAST direct child
     * of its g.note. Assert that order on every single-note g.note in a
     * freshly-rendered page. */
    { name: 'liftNoteheadsAbove puts notehead last in each g.note',
      expr: `(async () => {
        const handle = window.__hkl_composer;
        const mod = await import('/composer/src/save.ts');
        /* The on-screen page: since 2026-10-08 pages are assembled from line
           windows (pageassembly.ts) and the main toolkit holds no page layout,
           so this is what the export itself clones. */
        const live = document.querySelector('#score .score-page svg');
        const svg = live && live.cloneNode(true);
        if (!svg) return { ok: false, detail: 'no SVG' };
        mod.liftNoteheadsAbove(svg);
        const offenders = [];
        const notes = svg.querySelectorAll('g.note');
        for (const note of notes) {
          const head = note.querySelector(':scope > g.notehead');
          if (!head) continue;  /* chord-internal notes may not have stems */
          const last = note.lastElementChild;
          if (last !== head) {
            offenders.push(note.getAttribute('id') + ' last=' + (last && last.getAttribute('class')));
          }
        }
        return notes.length > 0 && offenders.length === 0
          ? { ok: true, detail: 'notes=' + notes.length }
          : { ok: false, detail: 'noteCount=' + notes.length + ' offenders=' + offenders.join(' | ') };
      })()` },
  ],

  /* No host (client disabled): Save and MusicXML export download under a name
   * derived from the title — reserved characters dropped, whitespace collapsed
   * — and an empty title falls back to "Untitled". */
  file_download_named_by_title: [
    { name: 'downloads are named after the title', expr: `(async () => {
      const H = window.__hkl_composer;
      const names = [];
      const origCreate = URL.createObjectURL;
      const origClick = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = () => 'blob:test-suppressed';
      HTMLAnchorElement.prototype.click = function () { names.push(this.download); };
      const settle = async (n) => { for (let i = 0; i < 300 && names.length < n; i++) await new Promise((r) => setTimeout(r, 10)); };
      try {
        document.getElementById('btnSave').click();
        await settle(1);
        document.getElementById('btnExportXml').click();
        await settle(2);
        H.model.setTitle('');
        document.getElementById('btnSave').click();
        await settle(3);
      } finally {
        URL.createObjectURL = origCreate;
        HTMLAnchorElement.prototype.click = origClick;
      }
      const want = ['Sonata No. 1 Draft.hkc', 'Sonata No. 1 Draft.musicxml', 'Untitled.hkc'];
      const ok = JSON.stringify(names) === JSON.stringify(want);
      return { ok, detail: 'got ' + JSON.stringify(names) };
    })()` },
  ],
  /* Load through the host binds the document to its path; Ctrl+S overwrites
   * it in place, conditioned on the mtime read at load, and the next Ctrl+S
   * conditions on the mtime that write returned. Ctrl+S is preventDefault'ed
   * (Firefox would otherwise open Save Page As). */
  file_load_ctrl_s_overwrites: [
    { name: 'Load binds the path; Ctrl+S writes it in place', expr: fsAssert(`
      H.model.setTitle('Etude');
      const text = H.model.serialize();
      H.model.setTitle('Scratch');
      disk.set('/home/u/scores/Etude.hkc', { text, mtimeMs: 500.25 });
      picks.push('/home/u/scores/Etude.hkc');
      H.__setLocalFs(mock);
      click('btnLoad');
      if (!(await until(() => H.model.getTitle() === 'Etude'))) return { ok: false, detail: 'load did not apply; calls=' + JSON.stringify(calls) };
      const st = H.fileState();
      if (st.path !== '/home/u/scores/Etude.hkc' || st.mtimeMs !== 500.25) return { ok: false, detail: 'fileState ' + JSON.stringify(st) };
      H.model.setCursor(0, 1);
      H.model.insertRestAtCursor({ duration: '4', dots: 0 });
      const ev = ctrlKey('s');
      if (!ev.defaultPrevented) return { ok: false, detail: 'Ctrl+S not preventDefault-ed' };
      if (!(await until(() => writes().length === 1 && disk.get('/home/u/scores/Etude.hkc').mtimeMs !== 500.25))) return { ok: false, detail: 'no write; calls=' + JSON.stringify(calls) };
      const w1 = writes()[0];
      if (w1[1] !== '/home/u/scores/Etude.hkc' || w1[2].kind !== 'ifMtime' || w1[2].mtimeMs !== 500.25) return { ok: false, detail: 'first write ' + JSON.stringify(w1) };
      if (!disk.get('/home/u/scores/Etude.hkc').text.includes('<rest')) return { ok: false, detail: 'saved text lacks the new rest' };
      const m1 = disk.get('/home/u/scores/Etude.hkc').mtimeMs;
      ctrlKey('s');
      if (!(await until(() => writes().length === 2))) return { ok: false, detail: 'no second write' };
      const w2 = writes()[1];
      if (w2[2].kind !== 'ifMtime' || w2[2].mtimeMs !== m1) return { ok: false, detail: 'second write ' + JSON.stringify(w2) + ' want mtime ' + m1 };
      if (calls.some((c) => c[0] === 'pickSave')) return { ok: false, detail: 'Save opened a dialog for a bound file' };
      return { ok: true, detail: 'overwrote in place twice, mtime-conditioned' };
    `) },
  ],
  /* The file changed on disk after load: Save asks before overwriting.
   * Declining leaves the disk alone; accepting overwrites unconditionally. */
  file_save_conflict_prompts: [
    { name: 'external change → confirm before overwrite', expr: fsAssert(`
      H.model.setTitle('Etude');
      disk.set('/home/u/Etude.hkc', { text: H.model.serialize(), mtimeMs: 700 });
      picks.push('/home/u/Etude.hkc');
      H.__setLocalFs(mock);
      click('btnLoad');
      if (!(await until(() => H.fileState().path === '/home/u/Etude.hkc'))) return { ok: false, detail: 'not bound; calls=' + JSON.stringify(calls) };
      disk.set('/home/u/Etude.hkc', { text: 'external', mtimeMs: 900 });
      const asked = [];
      window.confirm = (msg) => { asked.push(msg); return false; };
      ctrlKey('s');
      if (!(await until(() => asked.length === 1))) return { ok: false, detail: 'no confirm; calls=' + JSON.stringify(calls) };
      await new Promise((r) => setTimeout(r, 50));
      if (disk.get('/home/u/Etude.hkc').text !== 'external') return { ok: false, detail: 'declined overwrite still wrote' };
      window.confirm = (msg) => { asked.push(msg); return true; };
      ctrlKey('s');
      if (!(await until(() => disk.get('/home/u/Etude.hkc').text !== 'external'))) return { ok: false, detail: 'accepted overwrite did not write; calls=' + JSON.stringify(calls) };
      const last = writes().at(-1);
      if (last[2].kind !== 'overwrite') return { ok: false, detail: 'accepted write cond ' + JSON.stringify(last[2]) };
      const st = H.fileState();
      if (st.mtimeMs !== disk.get('/home/u/Etude.hkc').mtimeMs) return { ok: false, detail: 'mtime not updated ' + JSON.stringify(st) };
      return { ok: true, detail: 'declined → untouched, accepted → overwritten; prompt: ' + asked[0] };
    `) },
  ],
  /* MusicXML import through the host: the first Save writes <dir>/<base>.hkc
   * next to the source, numbered when taken, and never touches the source; the
   * doc is then bound to that .hkc, so the next Save overwrites it rather than
   * minting another number. */
  file_import_musicxml_saves_numbered_hkc: [
    { name: 'import → Save writes a numbered .hkc beside the source', expr: fsAssert(`
      H.model.setTitle('Foo Title');
      const xml = H.exportMusicXml(H.model);
      disk.set('/home/u/in/Foo.musicxml', { text: xml, mtimeMs: 10 });
      disk.set('/home/u/in/Foo.hkc', { text: 'older save', mtimeMs: 11 });
      picks.push('/home/u/in/Foo.musicxml');
      H.__setLocalFs(mock);
      click('btnImportXml');
      if (!(await until(() => calls.some((c) => c[0] === 'readText')))) return { ok: false, detail: 'import did not read; calls=' + JSON.stringify(calls) };
      if (!(await until(() => H.fileState().dir === '/home/u/in'))) return { ok: false, detail: 'import not recorded ' + JSON.stringify(H.fileState()) };
      if (H.fileState().path !== null) return { ok: false, detail: 'import bound the source path ' + JSON.stringify(H.fileState()) };
      const pickOpen = calls.find((c) => c[0] === 'pickOpen');
      if (pickOpen[1] !== 'musicxml') return { ok: false, detail: 'pickOpen filter ' + pickOpen[1] };
      ctrlKey('s');
      if (!(await until(() => writes().length === 1))) return { ok: false, detail: 'no write; calls=' + JSON.stringify(calls) };
      const w = writes()[0];
      if (w[1] !== '/home/u/in/Foo.hkc' || w[2].kind !== 'unique') return { ok: false, detail: 'write ' + JSON.stringify(w) };
      if (!(await until(() => H.fileState().path === '/home/u/in/Foo (1).hkc'))) return { ok: false, detail: 'not bound to numbered file ' + JSON.stringify(H.fileState()) };
      if (disk.get('/home/u/in/Foo.hkc').text !== 'older save' || disk.get('/home/u/in/Foo.musicxml').text !== xml) return { ok: false, detail: 'existing files touched' };
      ctrlKey('s');
      if (!(await until(() => writes().length === 2))) return { ok: false, detail: 'no second write' };
      const w2 = writes()[1];
      if (w2[1] !== '/home/u/in/Foo (1).hkc' || w2[2].kind !== 'ifMtime') return { ok: false, detail: 'second write ' + JSON.stringify(w2) };
      if (disk.has('/home/u/in/Foo (2).hkc')) return { ok: false, detail: 'second Save minted another number' };
      return { ok: true, detail: 'Foo (1).hkc written, then overwritten; source untouched' };
    `) },
  ],
  /* A new document has no file: Save opens the save dialog suggesting
   * <Title>.hkc in the last-used directory (none yet → host default), writes
   * the chosen path and binds it; Save As always opens the dialog, suggesting
   * the current file's name + directory. */
  file_new_doc_save_as: [
    { name: 'new doc: Save → dialog with title name; Save As rebinds', expr: fsAssert(`
      try { localStorage.removeItem('hklComposerLastDir'); } catch (e) {}
      H.__setLocalFs(mock);
      picks.push('/home/u/music/New Piece.hkc');
      ctrlKey('s');
      if (!(await until(() => H.fileState().path === '/home/u/music/New Piece.hkc'))) return { ok: false, detail: 'not bound; calls=' + JSON.stringify(calls) };
      const ps = calls.find((c) => c[0] === 'pickSave');
      if (ps[1] !== 'hkc' || ps[2] !== 'New Piece.hkc' || ps[3] !== null) return { ok: false, detail: 'pickSave ' + JSON.stringify(ps) };
      if (writes()[0][2].kind !== 'overwrite') return { ok: false, detail: 'dialog-confirmed write cond ' + JSON.stringify(writes()[0][2]) };
      picks.push('/home/u/music/Other.hkc');
      click('btnSaveAs');
      if (!(await until(() => H.fileState().path === '/home/u/music/Other.hkc'))) return { ok: false, detail: 'Save As not rebound; calls=' + JSON.stringify(calls) };
      const ps2 = calls.filter((c) => c[0] === 'pickSave')[1];
      if (ps2[2] !== 'New Piece.hkc' || ps2[3] !== '/home/u/music') return { ok: false, detail: 'Save As suggestion ' + JSON.stringify(ps2) };
      picks.push(null);
      click('btnSaveAs');
      await until(() => calls.filter((c) => c[0] === 'pickSave').length === 3);
      await new Promise((r) => setTimeout(r, 50));
      if (writes().length !== 2 || H.fileState().path !== '/home/u/music/Other.hkc') return { ok: false, detail: 'canceled Save As changed state' };
      let lastDir = null; try { lastDir = localStorage.getItem('hklComposerLastDir'); } catch (e) {}
      if (lastDir !== '/home/u/music') return { ok: false, detail: 'lastDir ' + lastDir };
      return { ok: true, detail: 'Save → New Piece.hkc, Save As → Other.hkc, cancel is a no-op' };
    `) },
  ],
  /* Host installed but not answering (status null): Load falls back to the
   * browser's own file input. */
  file_host_down_load_uses_input: [
    { name: 'no host → Load opens the <input type=file> picker', expr: fsAssert(`
      mock.status = async () => { calls.push(['status']); return null; };
      H.__setLocalFs(mock);
      const clicked = [];
      const origClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () { clicked.push(this.id); };
      try {
        click('btnLoad');
        await until(() => clicked.length > 0);
      } finally {
        HTMLInputElement.prototype.click = origClick;
      }
      if (clicked[0] !== 'fileInputHkc') return { ok: false, detail: 'clicked ' + JSON.stringify(clicked) + ' calls=' + JSON.stringify(calls) };
      if (calls.some((c) => c[0] === 'pickOpen')) return { ok: false, detail: 'asked a dead host for a dialog' };
      return { ok: true, detail: 'fell back to the file input' };
    `) },
  ],
};
