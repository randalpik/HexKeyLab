// Shape-guide page gate (docs/architecture/hkl.md → Lattice shapes → The page).
//
// Needs `pnpm dev` (the page is /shapes.html on the shared origin). One muted headless Chromium
// (test/composer-test/lib/chromium.mjs passes --mute-audio), stopped at the end. The page has no
// audio, MIDI or overlay code of its own. Checks, for Randal in Ptolemaic:
//   P1  the page finishes: 129 entries, numbered 1 to 129 in guide order, an index entry for each,
//       no page errors
//   P2  every entry shows its picture, loaded, at 4 device px per CSS px
//   P3  each picture holds its keys as the lattice colors them (keyColorHex, the page's own
//       module): every member key's color as a solid area, every path key's color at the path
//       opacity over white, and pure black only where the entry has a seam
//   P4  an entry's text is the guide's: title, a chord's position under it ("in root position"),
//       ratio, an interval's cents beside it, starting position, steps and other intervals; steps
//       and "also" share a line exactly when both fit, and otherwise "also" starts the next line
//
//   P5  the rows (src/shapes/rows.ts): entries in order; each takes an equal share of its row and
//       starts where its part of the row starts, so the second entry of every two-entry row lines
//       up; a scale is at most two to a row; no picture reaches into its entry's gutter
//
//   P6  a layout that holds part of the catalog (Randal in Pythagorean) shows just those entries,
//       numbered through, with no empty section and nothing marked missing; its minor 2nd, two
//       adjacent keys, says "from center or right" (the left C has that pitch only on a far key)
//   P7  a tuning the guide is not made for (?mode=V, Schismatic; ?mode=E, Equal) falls back to
//       Ptolemaic
//   P9  Randal in Septimal shows the 144 entries it holds, the septimal chords and scales next to
//       the ones they retune, every picture loaded, and no entry's text or picture reaches out
//       of its share of the row
//   P10 a starting note (?root=Eb, ?root=Fs): the title and the legend name it; the page holds
//       the entries the C page holds, with the same titles, positions, ratios, "from" and
//       intervals, and pictures of the same sizes; every entry's own guide shape starts on a key
//       of that name (as every shape of Randal in Ptolemaic starts on C); an id that is not one
//       of the fifteen falls back to C
//   P11 a layout with pictures wider than a sheet (Chromatic in Ptolemaic: eleven shapes of
//       Pythagorean thirds): no picture reaches out of its entry or past the sheet's text edge;
//       exactly those are shown scaled down, in proportion, to the room of a row to themselves,
//       each alone on its row, the widest (755 px as drawn) to 91%; every other picture is shown
//       as drawn. The legend states the limit: a shape is listed only if it can be reached on the Lumatone
//   P12 the hanging label, on a guide with fewer than 100 entries (Randal in Pythagorean, 56) and
//       one with more (Randal in Septimal, 144): the number ends the same distance before the title in
//       every entry, whatever its digits, and never touches it; the title and the lines under it
//       start at one indent, and a title that wraps keeps to it; the picture is not indented: it
//       is centered in its entry's cell (the entry less its gutter)
//   P8  the dark theme (?theme=dark): <html data-theme="dark">, the ground and the sheet #161616,
//       the text #f2f2f2, the legend's seam "white", all 129 entries. Each picture is compared
//       with the page's own painter run in the light style, pixel for pixel: it is the same size;
//       every pixel inside a seam's black or a member key's dark border on paper is white; no
//       other pixel is pure white; and no pure black is left
//
//   node test/shapes/page.mjs [--shot <png>] [--pdf <pdf>] [--dark-shot <png>] [--septimal-shot <png>]
//     --shot  also save a full-page screenshot;  --pdf  also save the page as printed (Letter)
//     --dark-shot  also save a full-page screenshot of the dark theme

import { writeFileSync } from 'node:fs';
import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { CDP } from '../composer-test/lib/cdp.mjs';

const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const URL = process.env.SHAPES_URL ?? 'http://localhost:5170/shapes.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0, fails = 0;
function check(label, got, want) {
  checks++;
  if (got !== want) { fails++; if (fails <= 40) console.log(`FAIL ${label}: got ${got}, want ${want}`); }
}

const chrome = await launchChromium();
try {
  const cdp = new CDP(await newTabWsUrl(chrome.port));
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const errors = [];
  cdp.on('Runtime.exceptionThrown', (p) => errors.push(p?.exceptionDetails?.exception?.description ?? p?.exceptionDetails?.text ?? 'exception'));
  const loaded = new Promise((res) => { const off = cdp.on('Page.loadEventFired', () => { off(); res(); }); });
  await cdp.send('Page.navigate', { url: URL });
  await loaded;
  let ready = null;
  for (let i = 0; i < 100 && !ready && !errors.length; i++) { ready = await cdp.evalJSON('document.body.dataset.ready ?? null'); if (!ready) await sleep(150); }
  check('P1 the page finishes', ready, '129');
  check('P1 no page errors', errors.join(' | '), '');

  const report = ready ? await cdp.evalJSON(`(async () => {
    const urls = performance.getEntriesByType('resource').map((e) => e.name);
    const find = (re) => urls.find((u) => re.test(u));
    const G = await import(find(/\\/shapes\\/guide\\.ts/)), K = await import(find(/\\/keycolor\\.ts/)), F = await import(find(/\\/shared\\/src\\/freq\\.ts/));
    const layout = { mode: '5', mapping: 'randal', anchor: F.anchorOf(0, 0, 'randal'), banded: true };
    const guide = G.buildGuide(layout);
    const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const color = ([q, r]) => rgb(K.keyColorHex(q, r, layout.mode, layout.mapping, layout.anchor, layout.banded));
    const articles = [...document.querySelectorAll('article.entry')];
    const out = { entries: articles.length, index: document.querySelectorAll('.index li').length, rows: [] };
    for (let i = 0; i < articles.length; i++) {
      const a = articles[i], g = guide[i], img = a.querySelector('img.diagram');
      const row = { n: i + 1, id: a.id, num: a.querySelector('.num')?.textContent, name: a.querySelector('.name')?.textContent,
        want: g.name, wantTitle: g.title, position: a.querySelector('.position')?.textContent ?? '', wantPosition: g.subtitle, ratio: a.querySelector('.ratio')?.textContent, wantRatio: g.ratio,
        start: a.querySelector('.facts b')?.textContent, wantStart: g.start,
        intervals: a.querySelector('.intervals')?.textContent, wantSteps: g.steps.join(' '), wantOthers: g.others.join(' '), kind: g.kind,
        cents: a.querySelector('.cents')?.textContent ?? '', wantCents: g.cents,
        stepsText: a.querySelector('.part.steps')?.textContent ?? '', alsoText: a.querySelector('.part.also')?.textContent ?? '',
        /* where the two parts of the interval line sit: their boxes, and the room the line has */
        parts: (() => {
          const line = a.querySelector('.intervals'), st = a.querySelector('.part.steps'), al = a.querySelector('.part.also');
          if (!line || !st || !al) return null;
          const cs = getComputedStyle(line), room = line.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          const s = st.getBoundingClientRect(), o = al.getBoundingClientRect(), l = line.getBoundingClientRect();
          return { room, stepsW: s.width, gap: parseFloat(getComputedStyle(st).marginRight), alsoW: o.width, sameLine: Math.abs(s.top - o.top) < 1,
            alsoAtStart: Math.abs(o.left - (l.left + parseFloat(cs.paddingLeft))) < 1, alsoBelow: o.top >= s.bottom - 1 };
        })(),
        img: !!img && img.complete, natural: img ? img.naturalWidth / img.width : 0 };
      if (img && img.complete) {
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        /* on white, as on paper: the picture's ground is transparent and its path keys translucent */
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, c.width, c.height).data, count = new Map();
        for (let p = 0; p < d.length; p += 4) { if (d[p + 3] !== 255) continue; const k = (d[p] << 16) | (d[p + 1] << 8) | d[p + 2]; count.set(k, (count.get(k) ?? 0) + 1); }
        /* pixels within 1 of an RGB value on every channel (compositing rounds) */
        const near = ([r, gg, b]) => { let n = 0; for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) n += count.get(((r + dr) << 16) | ((gg + dg) << 8) | (b + db)) ?? 0; return n; };
        const faint = (c3) => c3.map((v) => Math.round(0.45 * v + 0.55 * 255));
        const tally = (cells, f) => { const by = new Map(); for (const cell of cells) { const k = f(color(cell)).join(); by.set(k, (by.get(k) ?? 0) + 1); } return [...by].map(([k, keys]) => ({ keys, px: near(k.split(',').map(Number)) })); };
        row.members = tally(g.shape.cells, (c3) => c3);
        row.path = tally(g.shape.path, faint);
        row.black = count.get(0) ?? 0;
        row.seams = g.shape.seams.length;
      }
      out.rows.push(row);
    }
    /* the rows: each entry's place and width within its section, and how far its picture's right
       edge is from its own */
    out.layout = [...document.querySelectorAll('.row')].map((row) => {
      const s = row.parentElement.getBoundingClientRect();
      return { columns: Number(row.dataset.columns), width: s.width, entries: [...row.children].map((e) => {
        const r = e.getBoundingClientRect(), img = e.querySelector('img.diagram');
        return { n: Number(e.id.slice(1)), left: r.left - s.left, width: r.width, spare: img ? r.right - img.getBoundingClientRect().right : 999 };
      }) };
    });
    return out;
  })()`) : null;

  if (report?.__error) { check('the in-page report runs', report.__error, ''); }
  else if (report) {
    check('P1 entries', report.entries, 129);
    check('P1 index entries', report.index, 129);
    const cap = (s) => s[0].toUpperCase() + s.slice(1);
    /* a key's colored hexagon is about 624 CSS px² less its label; at 4 device px per CSS px, 16× that */
    const SOLID = 0.6 * 624 * 16;
    let sideBySide = 0, broken = 0;
    for (const r of report.rows) {
      check(`P1 entry ${r.n} id`, r.id, 'e' + r.n);
      check(`P4 entry ${r.n} title`, r.name, r.n + cap(r.wantTitle));
      check(`P4 entry ${r.n} position under the title`, r.position, r.wantPosition);
      check(`P4 entry ${r.n} ratio`, r.ratio, r.wantRatio);
      check(`P4 entry ${r.n} start`, r.start, r.wantStart);
      check(`P4 entry ${r.n} cents beside the ratio`, r.cents, r.wantCents);
      if (r.kind === 'interval') check(`P4 entry ${r.n} short name`, r.intervals, r.wantSteps);
      else {
        check(`P4 entry ${r.n} steps`, r.stepsText, 'steps ' + r.wantSteps);
        check(`P4 entry ${r.n} other intervals`, r.alsoText, r.wantOthers ? 'also ' + r.wantOthers : '');
      }
      if (r.parts) {
        /* side by side exactly when both fit on the line; otherwise "also" starts the next line */
        const fits = r.parts.stepsW + r.parts.gap + r.parts.alsoW <= r.parts.room + 0.5;
        if (r.parts.sameLine) { sideBySide++; check(`P4 entry ${r.n}: steps and also share a line only if both fit`, fits, true); }
        else {
          broken++;
          check(`P4 entry ${r.n}: also starts its own line, under steps`, r.parts.alsoAtStart && r.parts.alsoBelow, true);
          check(`P4 entry ${r.n}: also breaks only when the two do not fit one line`, fits, false);
        }
      }
      check(`P2 entry ${r.n} picture loaded`, r.img, true);
      check(`P2 entry ${r.n} picture at 4 device px per CSS px`, r.natural, 4);
      for (const m of r.members ?? []) check(`P3 entry ${r.n} (${r.want}): ${m.keys} member key(s) in their lattice color`, m.px >= SOLID * m.keys, true);
      for (const m of r.path ?? []) check(`P3 entry ${r.n} (${r.want}): ${m.keys} path key(s) at the path opacity`, m.px >= SOLID * m.keys, true);
      check(`P3 entry ${r.n} (${r.want}): black seam ink iff it has a seam`, (r.black ?? 0) > 200, (r.seams ?? 0) > 0);
    }
    console.log(`steps and also: ${sideBySide} side by side, ${broken} with also on its own line`);
    let seen = 0;
    const GUTTER = 10 * 96 / 72;
    for (const row of report.layout) {
      check(`P5 row at entry ${row.entries[0]?.n}: one to ${row.columns} entries`, row.entries.length >= 1 && row.entries.length <= row.columns, true);
      row.entries.forEach((e, k) => {
        seen++;
        check(`P5 entry ${e.n} comes in order`, e.n, seen);
        check(`P5 entry ${e.n}: an equal share of its row (1 of ${row.columns})`, Math.abs(e.width - row.width / row.columns) < 0.6, true);
        check(`P5 entry ${e.n}: starts where part ${k + 1} of ${row.columns} starts`, Math.abs(e.left - k * row.width / row.columns) < 0.6, true);
        check(`P5 entry ${e.n}: its picture stops short of the gutter`, e.spare >= GUTTER - 0.5, true);
        if (report.rows[e.n - 1].kind === 'scale') check(`P5 entry ${e.n}: a scale, at most two to a row`, row.columns <= 2, true);
      });
    }
    check('P5 every entry is in a row', seen, 129);
    console.log('rows: ' + report.layout.map((r) => r.entries.length + '/' + r.columns).join(' '));
  }

  /* P6: a layout that holds only part of the catalog (Randal in Pythagorean: 56 of the 129, by
     test/shapes/oracle.mjs) shows just those, numbered through, in the sections that have any.
     Saved first: --shot and --pdf are of the page as loaded above. */
  const saves = [];
  if (arg('--shot')) {
    const m = await cdp.send('Page.getLayoutMetrics');
    const { width, height } = m.cssContentSize;
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
    writeFileSync(arg('--shot'), Buffer.from(shot.data, 'base64'));
    saves.push(`screenshot ${width}×${height} → ${arg('--shot')}`);
  }
  if (arg('--pdf')) {
    const pdf = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
    writeFileSync(arg('--pdf'), Buffer.from(pdf.data, 'base64'));
    saves.push(`pdf → ${arg('--pdf')}`);
  }
  for (const line of saves) console.log(line);
  const again = new Promise((res) => { const off = cdp.on('Page.loadEventFired', () => { off(); res(); }); });
  await cdp.send('Page.navigate', { url: URL + (URL.includes('?') ? '&' : '?') + 'mapping=randal&mode=P' });
  await again;
  let part = null;
  for (let i = 0; i < 100 && !part && !errors.length; i++) { part = await cdp.evalJSON('document.body.dataset.ready ?? null'); if (!part) await sleep(150); }
  const partial = part ? await cdp.evalJSON(`({
    heading: document.querySelector('h1')?.textContent,
    nums: [...document.querySelectorAll('article.entry .num')].map((n) => n.textContent).join(),
    index: document.querySelectorAll('.index li').length,
    pictures: [...document.querySelectorAll('img.diagram')].filter((i) => i.complete && i.naturalWidth > 0).length,
    sections: [...document.querySelectorAll('.section')].map((s) => s.querySelector('h2').textContent + ':' + s.querySelectorAll('article.entry').length).join(' '),
    text: document.getElementById('guide').textContent.includes('Not on this lattice'),
    m2: (() => { const a = [...document.querySelectorAll('article.entry')].find((e) => e.querySelector('.ratio')?.textContent === '256:243');
      return a ? a.querySelector('.name').textContent.replace(/^\\d+/, '') + ' | ' + a.querySelector('.facts b').textContent : null; })(),
  })`) : {};
  check('P6 Randal in Pythagorean finishes with the 56 it holds', part, '56');
  check('P6 heading', partial.heading, 'Lattice shapes from C: Randal mapping, Pythagorean tuning');
  check('P6 entries numbered through', partial.nums, Array.from({ length: 56 }, (_, i) => i + 1).join());
  check('P6 index and pictures', `${partial.index} ${partial.pictures}`, '56 56');
  check('P6 no section is empty, none says a shape is missing', /:0\b/.test(partial.sections ?? ':0') || partial.text, false);
  check('P6 the minor 2nd starts where its two adjacent keys work', partial.m2, 'Pythagorean minor 2nd | center or right');
  check('P6 no page errors', errors.join(' | '), '');
  console.log(`Randal in Pythagorean: ${partial.sections}`);

  /* load the page with a query and wait for it to finish; its entry count, or null */
  const load = async (query) => {
    const done = new Promise((res) => { const off = cdp.on('Page.loadEventFired', () => { off(); res(); }); });
    await cdp.send('Page.navigate', { url: URL + (URL.includes('?') ? '&' : '?') + query });
    await done;
    let n = null;
    for (let i = 0; i < 100 && !n && !errors.length; i++) { n = await cdp.evalJSON('document.body.dataset.ready ?? null'); if (!n) await sleep(150); }
    return n;
  };

  /* P7: Schismatic and Equal are not among the guide's tunings */
  for (const m of ['V', 'E']) {
    const n = await load('mapping=randal&mode=' + m);
    check(`P7 ?mode=${m} falls back to Ptolemaic`, `${n} ${await cdp.evalJSON(`document.querySelector('h1')?.textContent ?? null`)}`, '129 Lattice shapes from C: Randal mapping, Ptolemaic tuning');
  }

  /* P9: Randal in Septimal, where the septimal structures are */
  const septN = await load('mapping=randal&mode=7');
  const sept = septN ? await cdp.evalJSON(`(() => {
    const entries = [...document.querySelectorAll('article.entry')];
    const titles = entries.map((a) => a.querySelector('.name').textContent.replace(/^\\d+/, '') + (a.querySelector('.position') ? ' ' + a.querySelector('.position').textContent : ''));
    const roots = [...new Set(entries.map((a) => a.querySelector('.name').textContent.replace(/^\\d+/, '')))];
    let out = 0;
    for (const a of entries) { const r = a.getBoundingClientRect(); for (const e of a.querySelectorAll('.name, .position, .facts, .intervals, .part, img.diagram')) { const b = e.getBoundingClientRect(); if (b.right > r.right + 0.5 || b.left < r.left - 0.5) out++; } }
    return { heading: document.querySelector('h1').textContent, n: entries.length, roots: roots.slice(0, 21).join('; '),
      pictures: [...document.querySelectorAll('img.diagram')].filter((i) => i.complete && i.naturalWidth > 0).length, out,
      sections: [...document.querySelectorAll('.section')].map((x) => x.querySelector('h2').textContent + ':' + x.querySelectorAll('article.entry').length).join(' ') };
  })()`) : {};
  check('P9 Randal in Septimal finishes with the 144 it holds', septN, '144');
  check('P9 heading', sept.heading, 'Lattice shapes from C: Randal mapping, Septimal tuning');
  check('P9 pictures', sept.pictures, 144);
  check('P9 nothing reaches out of its entry', sept.out, 0);
  console.log(`Randal in Septimal: ${sept.sections}`);
  console.log(`  in order: ${sept.roots}`);
  if (arg('--septimal-shot')) {
    const m = await cdp.send('Page.getLayoutMetrics');
    const { width, height } = m.cssContentSize;
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
    writeFileSync(arg('--septimal-shot'), Buffer.from(shot.data, 'base64'));
    console.log(`septimal screenshot ${width}×${height} → ${arg('--septimal-shot')}`);
  }

  /* P12: the hanging label. Text is measured where it is drawn: the number's own glyphs, the
     title's first glyph, the first glyph of each line under it */
  const LABELS = `(() => {
    const box = (node, from, to) => { const r = document.createRange(); r.setStart(node, from); r.setEnd(node, to); return r; };
    const textOf = (el) => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.textContent.trim()) return n; return null; };
    const gaps = {}, bad = [], indents = new Set(); let wrapped = 0, flush = 0;
    for (const a of document.querySelectorAll('article.entry')) {
      const num = a.querySelector('.num'), nt = num.firstChild, title = num.nextSibling, digits = nt.textContent.length;
      const numRight = box(nt, 0, nt.length).getBoundingClientRect().right;
      const lines = [...box(title, 0, title.length).getClientRects()], titleLeft = box(title, 0, 1).getBoundingClientRect().left;
      const gap = titleLeft - numRight;
      (gaps[digits] ??= []).push(gap);
      if (lines.length > 1) wrapped++;
      const lefts = [...lines.map((r) => r.left)];
      for (const sel of ['.position', '.facts', '.intervals']) { const e = a.querySelector(sel); if (e) { const t = textOf(e); lefts.push(box(t, 0, 1).getBoundingClientRect().left); } }
      if (lefts.some((x) => Math.abs(x - titleLeft) > 0.6)) bad.push(nt.textContent + ': ' + lefts.map((x) => (x - titleLeft).toFixed(1)).join(' '));
      { const i = a.querySelector('img.diagram').getBoundingClientRect(), e = a.getBoundingClientRect(), right = e.right - parseFloat(getComputedStyle(a).paddingRight);
        if (Math.abs((i.left - e.left) - (right - i.right)) > 1 || i.left < e.left - 0.5) flush++; }
      indents.add(Math.round((titleLeft - a.getBoundingClientRect().left) * 10) / 10);
    }
    const all = Object.values(gaps).flat();
    return { flush, indent: [...indents].join(), digits: Object.keys(gaps).join(), spread: Math.max(...all) - Math.min(...all), least: Math.min(...all), wrapped, bad: bad.slice(0, 3).join(' | '), misaligned: bad.length,
      byDigits: Object.entries(gaps).map(([d, g]) => d + ' digit: ' + Math.min(...g).toFixed(1) + '…' + Math.max(...g).toFixed(1)).join(', ') };
  })()`;
  for (const [what, query, digits] of [['Randal in Pythagorean', 'mapping=randal&mode=P', '1,2'], ['Randal in Septimal', 'mapping=randal&mode=7', '1,2,3']]) {
    await load(query);
    const lab = await cdp.evalJSON(LABELS);
    check(`P12 ${what}: numbers of ${digits} digits`, lab.digits, digits);
    check(`P12 ${what}: the number ends the same distance before the title in every entry`, lab.spread < 0.6, true);
    check(`P12 ${what}: and never touches it`, lab.least > 2.5, true);
    check(`P12 ${what}: the title and the lines under it start at one indent`, `${lab.misaligned} ${lab.bad}`, '0 ');
    check(`P12 ${what}: one indent for the whole guide, a digit wider from a hundred entries (px)`, lab.indent, digits === '1,2' ? '20.4' : '28.4');
    check(`P12 ${what}: every picture is centered in its entry, between its left edge and its gutter`, lab.flush, 0);
    console.log(`${what}: number to title, px: ${lab.byDigits}; ${lab.wrapped} titles wrap`);
  }

  /* P10: starting notes. The C page's entries first, to hold the others to */
  const CARD = `(() => [...document.querySelectorAll('article.entry')].map((a) => { const i = a.querySelector('img.diagram');
    return [a.querySelector('.name').textContent, a.querySelector('.position')?.textContent ?? '', a.querySelector('.facts').textContent, a.querySelector('.intervals').textContent, i.naturalWidth + 'x' + i.naturalHeight].join(' | '); }).join('\\n'))()`;
  await load('mapping=randal&mode=5');
  const cCards = await cdp.evalJSON(CARD);
  for (const [id, label, name] of [['Eb', 'E♭', 'Eb'], ['Fs', 'F♯', 'F#']]) {
    const n = await load('mapping=randal&mode=5&root=' + id);
    const got = n ? await cdp.evalJSON(`(async () => {
      const urls = performance.getEntriesByType('resource').map((e) => e.name), find = (re) => urls.find((u) => re.test(u));
      const G = await import(find(/\\/shapes\\/guide\\.ts/)), N = await import(find(/\\/shared\\/src\\/notes\\.ts/));
      const at = { mode: '5', mapping: 'randal', banded: true }, l = G.rootedLayout(at, ${JSON.stringify(name)}).layout;
      return { heading: document.querySelector('h1').textContent, title: document.title, legend: document.querySelector('.legend').textContent,
        starts: G.buildGuide(at, ${JSON.stringify(name)}).every((e) => N.noteName(e.shape.bass[0], e.shape.bass[1], 'randal', l.anchor, true) === ${JSON.stringify(name)}) };
    })()`) : {};
    check(`P10 ${label}: the page finishes`, n, '129');
    check(`P10 ${label}: title`, `${got.heading} | ${got.title === got.heading}`, `Lattice shapes from ${label}: Randal mapping, Ptolemaic tuning | true`);
    check(`P10 ${label}: the legend names it`, got.legend, `A shape is listed only if it can be reached on the Lumatone in this layout with the reference note set to the unaltered ${label}. Each is drawn in its closest reachable arrangement. Solid keys are the notes of the shape; faint keys only show the way between them. “From” is the possible alignments for the lowest note inside its band. A heavy black line is a band seam, drawn where the starting position matters and the shape crosses one.`);
    check(`P10 ${label}: every shape starts on a key of that name`, got.starts, true);
    const cards = n ? await cdp.evalJSON(CARD) : '', mine = cards.split('\n'), theirs = cCards.split('\n'), at = mine.findIndex((x, i) => x !== theirs[i]);
    check(`P10 ${label}: the entries, their text and their pictures' sizes are the C page's`, at < 0 && mine.length === theirs.length ? 'same' : `entry ${at + 1}: ${mine[at]}  ≠  ${theirs[at]}`, 'same');
  }
  const bad = await load('mapping=randal&mode=5&root=H');
  check('P10 an unknown starting note falls back to C', `${bad} ${await cdp.evalJSON(`document.querySelector('h1')?.textContent ?? null`)}`, '129 Lattice shapes from C: Randal mapping, Ptolemaic tuning');

  /* P11: pictures wider than a sheet are scaled down to their row */
  const wideN = await load('mapping=chromatic&mode=5');
  const wide = wideN ? await cdp.evalJSON(`(() => {
    const sheet = document.getElementById('guide'), edge = sheet.getBoundingClientRect().right - parseFloat(getComputedStyle(sheet).paddingRight);
    let out = 0, past = 0; const scaled = [], asDrawn = [];
    for (const a of document.querySelectorAll('article.entry')) {
      const i = a.querySelector('img.diagram'), b = i.getBoundingClientRect(), e = a.getBoundingClientRect();
      if (b.right > e.right + 0.5) out++;
      if (b.right > edge + 0.5) past++;
      const k = i.naturalWidth / i.width / 4;
      if (i.dataset.scaled) scaled.push({ name: a.querySelector('.name').textContent.replace(/^\\d+/, ''), width: i.width, drawn: i.naturalWidth / 4, scale: Number(i.dataset.scaled),
        ok: Math.abs(i.naturalHeight / i.naturalWidth - i.height / i.width) < 0.005 && Math.abs(i.width / (i.naturalWidth / 4) - Number(i.dataset.scaled)) < 0.002 && a.parentElement.children.length === 1 && a.parentElement.dataset.columns === '1' });
      else asDrawn.push(Math.abs(k - 1) < 0.001);
    }
    return { n: document.querySelectorAll('article.entry').length, out, past, asDrawn: asDrawn.every(Boolean), others: asDrawn.length,
      scaled: scaled.length + ' scaled, all to ' + [...new Set(scaled.map((x) => x.width))].join('/') + ' px, each in proportion and alone on its row ' + scaled.every((x) => x.ok)
        + ', all of Pythagorean thirds ' + scaled.every((x) => /^(Pythagorean|Semiditonal) /.test(x.name)) + ', the widest drawn ' + Math.max(...scaled.map((x) => x.drawn)) + ' px to ' + Math.round(Math.min(...scaled.map((x) => x.scale)) * 100) + '%' };
  })()`) : {};
  check('P11 Chromatic in Ptolemaic finishes', wideN, '119');
  check('P11 the legend states the limit', /^A shape is listed only if it can be reached on the Lumatone in this layout with the reference note set to the unaltered C\. Each is drawn in its closest reachable arrangement\./.test(await cdp.evalJSON(`document.querySelector('.legend').textContent`)), true);
  check('P11 no picture reaches out of its entry, or past the sheet\'s text edge', `${wide.out} ${wide.past}`, '0 0');
  check('P11 the pictures wider than a sheet are scaled down to a row', wide.scaled,
    '11 scaled, all to 687 px, each in proportion and alone on its row true, all of Pythagorean thirds true, the widest drawn 755 px to 91%');
  check('P11 every other picture is shown as drawn', `${wide.asDrawn} ${wide.others}`, 'true 108');

  /* P8: the dark theme */
  const darkN = await load('theme=dark');
  check('P8 the dark page finishes', darkN, '129');
  const dark = darkN ? await cdp.evalJSON(`(async () => {
    const urls = performance.getEntriesByType('resource').map((e) => e.name);
    const find = (re) => urls.find((u) => re.test(u));
    const G = await import(find(/\\/shapes\\/guide\\.ts/)), D = await import(find(/\\/shapes\\/diagram\\.ts/)), F = await import(find(/\\/shared\\/src\\/freq\\.ts/));
    const layout = { mode: '5', mapping: 'randal', anchor: F.anchorOf(0, 0, 'randal'), banded: true };
    const guide = G.buildGuide(layout);
    /* the light theme's style (src/shapes/page.ts), for the page's own painter */
    const LIGHT = { pathAlpha: 0.45, memberBorder: 1.5, heji: true, seamWidth: 4, scale: 4, seamColor: '#000', memberBorderColor: '#111' };
    const css = (e, prop) => getComputedStyle(e)[prop];
    const out = { theme: document.documentElement.dataset.theme ?? null, ground: css(document.documentElement, 'backgroundColor'),
      sheet: css(document.getElementById('guide'), 'backgroundColor'), ink: css(document.body, 'color'),
      rule: css(document.querySelector('h2'), 'borderBottomColor'), legend: document.querySelector('.legend').textContent,
      entries: document.querySelectorAll('article.entry').length, rows: [] };
    const articles = [...document.querySelectorAll('article.entry')];
    for (let i = 0; i < articles.length; i++) {
      const img = articles[i].querySelector('img.diagram');
      const light = D.renderDiagram(guide[i].shape, layout, LIGHT).canvas;
      const row = { n: i + 1, sameSize: light.width === img.naturalWidth && light.height === img.naturalHeight, seams: guide[i].shape.seams.length };
      if (row.sameSize) {
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, c.width, c.height).data;
        const l = light.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, light.width, light.height).data;
        /* on paper: a seam is opaque #000, a member key's border opaque #111, and where a seam's
           soft edge lies on a border, an opaque gray between the two */
        const W = c.width, ink = (p) => l[p + 3] === 255 && l[p] === l[p + 1] && l[p] === l[p + 2] && l[p] <= 0x11;
        let black = 0, border = 0, notWhite = 0, white = 0, stray = 0, darkBlack = 0;
        for (let p = 0; p < d.length; p += 4) {
          const lightInk = ink(p);
          const isWhite = d[p + 3] === 255 && d[p] === 255 && d[p + 1] === 255 && d[p + 2] === 255;
          if (lightInk) {
            if (l[p] === 0) black++; else if (l[p] === 0x11) border++;
            /* inside the ink: its four neighbors are ink too (a soft edge over a faint path key
               is a blend with what is under it, on either theme) */
            if (!isWhite && ink(p - 4) && ink(p + 4) && ink(p - 4 * W) && ink(p + 4 * W)) notWhite++;
          }
          if (isWhite) { white++; if (!lightInk) stray++; }
          if (d[p + 3] === 255 && d[p] === 0 && d[p + 1] === 0 && d[p + 2] === 0) darkBlack++;
        }
        Object.assign(row, { black, border, notWhite, white, stray, darkBlack });
      }
      out.rows.push(row);
    }
    return out;
  })()`) : null;
  if (dark?.__error) check('P8 the in-page report runs', dark.__error, '');
  else if (dark) {
    check('P8 <html data-theme>', dark.theme, 'dark');
    check('P8 ground, sheet, ink, rule', `${dark.ground} | ${dark.sheet} | ${dark.ink} | ${dark.rule}`, 'rgb(22, 22, 22) | rgb(22, 22, 22) | rgb(242, 242, 242) | rgb(242, 242, 242)');
    check('P8 the legend names the seam\'s color', /A heavy white line is a band seam/.test(dark.legend), true);
    check('P8 entries', dark.entries, 129);
    let seamPx = 0, borderPx = 0;
    for (const r of dark.rows) {
      check(`P8 entry ${r.n}: the picture is the size of the light one`, r.sameSize, true);
      if (!r.sameSize) continue;
      check(`P8 entry ${r.n}: member keys have a border on paper`, r.border > 1000, true);
      check(`P8 entry ${r.n}: black on paper exactly where it has a seam`, r.black > 0, r.seams > 0);
      check(`P8 entry ${r.n}: every pixel inside a seam or a member key's border is white`, r.notWhite, 0);
      check(`P8 entry ${r.n}: nothing else is pure white`, r.stray, 0);
      check(`P8 entry ${r.n}: no pure black is left`, r.darkBlack, 0);
      seamPx += r.black; borderPx += r.border;
    }
    console.log(`dark theme: ${seamPx} seam px and ${borderPx} member-border px turned white, over 129 pictures`);
  }
  if (arg('--dark-shot')) {
    const m = await cdp.send('Page.getLayoutMetrics');
    const { width, height } = m.cssContentSize;
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
    writeFileSync(arg('--dark-shot'), Buffer.from(shot.data, 'base64'));
    console.log(`dark screenshot ${width}×${height} → ${arg('--dark-shot')}`);
  }
  check('P7 to P12 no page errors', errors.join(' | '), '');
} finally {
  await chrome.stop();
}
console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
