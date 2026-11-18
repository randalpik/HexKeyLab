// Shape-guide page gate (docs/architecture/hkl.md → Lattice shapes → The page).
//
// Needs `pnpm dev` (the page is /shapes.html on the shared origin). One muted headless Chromium
// (test/composer-test/lib/chromium.mjs passes --mute-audio), stopped at the end. The page has no
// audio, MIDI or overlay code of its own. Checks, for Randal in Ptolemaic:
//   P1  the page finishes: 71 entries, numbered 1 to 71 in guide order, an index entry for each,
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
//   node test/shapes/page.mjs [--shot <png>] [--pdf <pdf>]
//     --shot  also save a full-page screenshot;  --pdf  also save the page as printed (Letter)

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
  check('P1 the page finishes', ready, '71');
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
    check('P1 entries', report.entries, 71);
    check('P1 index entries', report.index, 71);
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
    check('P5 every entry is in a row', seen, 71);
    console.log('rows: ' + report.layout.map((r) => r.entries.length + '/' + r.columns).join(' '));
  }

  if (arg('--shot')) {
    const m = await cdp.send('Page.getLayoutMetrics');
    const { width, height } = m.cssContentSize;
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
    writeFileSync(arg('--shot'), Buffer.from(shot.data, 'base64'));
    console.log(`screenshot ${width}×${height} → ${arg('--shot')}`);
  }
  if (arg('--pdf')) {
    const pdf = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
    writeFileSync(arg('--pdf'), Buffer.from(pdf.data, 'base64'));
    console.log(`pdf → ${arg('--pdf')}`);
  }
} finally {
  await chrome.stop();
}
console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
