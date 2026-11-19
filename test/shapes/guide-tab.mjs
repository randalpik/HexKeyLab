// The Guide's Layouts tab gate (apps/guide/src/layouts.ts; docs/architecture/hkl.md → Lattice
// shapes → The Layouts tab).
//
// Needs `pnpm dev` (the Guide at /guide/ and the shape guide at /shapes.html share the origin).
// One muted headless Chromium (test/composer-test/lib/chromium.mjs passes --mute-audio), stopped
// at the end. Neither page has audio, MIDI or overlay code. Checks:
//   T1  the tab bar ends in Layouts; #layouts opens it, with the title naming the tab only; the
//       tab bar has nothing to scroll, down or across, on Layouts or on a guide's tab
//   T2  the dropdowns: the eight preset mappings and the six tunings the guide is made for (not
//       Equal, not Schismatic), by their toolbar names, Randal and Ptolemaic chosen; the Theme
//       dropdown (Light, Dark), labeled like the other two, Light chosen; the "Open in new tab"
//       link; the frame holds /shapes.html
//       for that choice, finished, all 94 entries, on the light ground; the frame fills the tab
//       under the bar
//   T3  choosing a mapping, then a tuning, moves the hash to #layouts/<mapping>/<mode>, the frame
//       and the "open by itself" link to that layout, and the frame's page finishes with the
//       entries that layout holds
//   T4  a hash naming a layout opens on it; a hash naming anything that is not a preset on offer
//       (a custom layout id, Equal, Schismatic) falls back to Randal and Ptolemaic
//   T5  another tab hides Layouts and shows its guide; coming back to the same layout keeps the
//       frame's page (no reload)
//   T6  Dark: the frame takes &theme=dark, the frame's page is dark and finishes, the frame's own
//       ground is the page's dark, and the hash is unchanged (the theme is not part of the URL
//       the Guide reports); the "Open in new tab" link stays on the light page, whatever the
//       theme; a reload of the Guide keeps Dark; Light puts everything back
//   T7  no page errors, in the Guide or in the frame
//
//   node test/shapes/guide-tab.mjs [--shot <png>] [--dark-shot <png>]

import { writeFileSync } from 'node:fs';
import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { CDP } from '../composer-test/lib/cdp.mjs';

const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const URL = process.env.GUIDE_URL ?? 'http://localhost:5170/guide/';
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
  await cdp.send('Page.navigate', { url: URL + '#layouts' });
  await loaded;

  /* the Guide and its frame, as one snapshot */
  const SNAP = `(() => {
    const frame = document.querySelector('.g-layouts-frame'), doc = frame?.contentDocument, sec = document.querySelector('.g-layouts');
    const sels = [...document.querySelectorAll('.g-layouts-field select')];
    const box = (e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    return {
      hash: location.hash, title: document.title,
      tabs: [...document.querySelectorAll('.g-tab')].map((b) => b.textContent + (b.classList.contains('active') ? '*' : '')).join(' '),
      shown: sec ? !sec.hidden : false,
      tabsScroll: (() => { const b = document.querySelector('.g-tabs'); return 'down ' + (b.scrollHeight - b.clientHeight) + ', across ' + (b.scrollWidth - b.clientWidth); })(),
      docs: [...document.querySelectorAll('.g-doc')].filter((d) => !d.hidden).length,
      mappings: sels[0] ? [...sels[0].options].map((o) => o.value + '=' + o.textContent).join(' ') : '', mapping: sels[0]?.value,
      tunings: sels[1] ? [...sels[1].options].map((o) => o.value + '=' + o.textContent).join(' ') : '', tuning: sels[1]?.value,
      themes: sels[2] ? [...sels[2].options].map((o) => o.value + '=' + o.textContent).join(' ') : '', theme: sels[2]?.value,
      labels: sels.map((x) => x.parentElement.firstChild.textContent.trim()).join(' '), fields: sels.length,
      openText: document.querySelector('.g-layouts-open')?.textContent ?? null,
      frameGround: frame ? getComputedStyle(frame).backgroundColor : null,
      pageTheme: doc?.documentElement?.dataset.theme ?? null, pageGround: doc?.documentElement ? frame.contentWindow.getComputedStyle(doc.documentElement).backgroundColor : null,
      stored: (() => { try { return localStorage.getItem('hkl.guide.layoutsTheme'); } catch { return 'no storage'; } })(),
      src: frame?.getAttribute('src') ?? null,
      open: document.querySelector('.g-layouts-open')?.getAttribute('href') ?? null, openTarget: document.querySelector('.g-layouts-open')?.target ?? null,
      frameUrl: doc ? doc.location.pathname + doc.location.search : null,
      ready: doc?.body?.dataset.ready ?? null, heading: doc?.querySelector('h1')?.textContent ?? null,
      entries: doc ? doc.querySelectorAll('article.entry').length : 0, pictures: doc ? [...doc.querySelectorAll('img.diagram')].filter((i) => i.complete && i.naturalWidth > 0).length : 0,
      kept: frame?.contentWindow?.__kept ?? null,
      frame: frame ? box(frame) : null, bar: document.querySelector('.g-layouts-bar') ? box(document.querySelector('.g-layouts-bar')) : null,
      content: box(document.querySelector('.g-content')),
    };
  })()`;
  /* wait until the frame holds the finished page for `search` */
  const settle = async (search) => {
    let s = null;
    for (let i = 0; i < 120; i++) {
      s = await cdp.evalJSON(SNAP);
      if (s && s.frameUrl === '/shapes.html' + search && s.ready) return s;
      await sleep(150);
    }
    return s ?? {};
  };
  const choose = (which, value) => cdp.evalJSON(`(() => {
    const sel = document.querySelectorAll('.g-layouts-field select')[${which}];
    sel.value = ${JSON.stringify(value)}; sel.dispatchEvent(new Event('change')); return true;
  })()`);

  /* T1, T2 */
  let s = await settle('?mapping=randal&mode=5');
  check('T1 tabs', s.tabs, 'Core Composer Analyzer Orchestrator Overlay Layouts*');
  check('T1 Layouts is shown, and no guide', `${s.shown} ${s.docs}`, 'true 0');
  check('T1 title names the tab only', s.title, 'HexKeyLab Guide — Layouts');
  check('T1 the tab bar has nothing to scroll (px)', s.tabsScroll, 'down 0, across 0');
  check('T2 mappings', s.mappings, 'euler=Euler wickiHayden=Wicki-Hayden chromatic=Chromatic gerhard=Gerhard janko=Janko accordion=Accordion randal=Randal park=Park');
  check('T2 tunings', s.tunings, '5=Ptolemaic P=Pythagorean D=Semiditonal 7=Septimal S=Syntonic Y=Polysyntonic');
  check('T2 the three dropdowns, each labeled', `${s.fields}: ${s.labels}`, '3: Mapping Tuning Theme');
  check('T2 themes', `${s.themes} | ${s.theme}`, 'light=Light dark=Dark | light');
  check('T2 light: the frame\'s ground and its page\'s', `${s.frameGround} | ${s.pageTheme} ${s.pageGround}`, 'rgb(221, 221, 221) | null rgb(221, 221, 221)');
  check('T2 chosen', `${s.mapping} ${s.tuning}`, 'randal 5');
  check('T2 frame source', s.src, '/shapes.html?mapping=randal&mode=5');
  check('T2 the frame\'s page finished', `${s.ready} entries, ${s.entries} shown, ${s.pictures} pictures`, '94 entries, 94 shown, 94 pictures');
  check('T2 the frame\'s page', s.heading, 'Lattice shapes: Randal mapping, Ptolemaic tuning');
  check('T2 open link', `${s.openText} | ${s.open} ${s.openTarget}`, 'Open in new tab | /shapes.html?mapping=randal&mode=5 _blank');
  check('T2 the frame is as wide as the tab', Math.abs(s.frame.width - s.content.width) < 1, true);
  check('T2 the frame runs from the bar to the bottom of the tab', Math.abs(s.frame.top - s.bar.bottom) < 1.5 && Math.abs(s.frame.bottom - s.content.bottom) < 1.5 && s.frame.height > 300, true);
  if (arg('--shot')) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(arg('--shot'), Buffer.from(shot.data, 'base64'));
    console.log(`screenshot → ${arg('--shot')}`);
  }

  /* T3 */
  await choose(0, 'park');
  s = await settle('?mapping=park&mode=5');
  check('T3 mapping → hash', s.hash, '#layouts/park/5');
  check('T3 mapping → frame', `${s.src} | ${s.heading} | ${s.ready}/${s.entries}/${s.pictures}`, '/shapes.html?mapping=park&mode=5 | Lattice shapes: Park mapping, Ptolemaic tuning | 94/94/94');
  await choose(1, 'P');
  s = await settle('?mapping=park&mode=P');
  check('T3 tuning → hash', s.hash, '#layouts/park/P');
  check('T3 tuning → frame', `${s.src} | ${s.heading}`, '/shapes.html?mapping=park&mode=P | Lattice shapes: Park mapping, Pythagorean tuning');
  check('T3 tuning → the frame shows what that layout holds', Number(s.ready) >= 1 && Number(s.ready) < 94 && s.entries === Number(s.ready) && s.pictures === s.entries, true);
  check('T3 open link follows', s.open, '/shapes.html?mapping=park&mode=P');
  check('T3 title still names the tab only', s.title, 'HexKeyLab Guide — Layouts');
  console.log(`Park in Pythagorean: ${s.ready} entries`);

  /* T4 */
  await cdp.evalJSON(`(location.hash = '#layouts/euler/7', true)`);
  s = await settle('?mapping=euler&mode=7');
  check('T4 a hash names a layout', `${s.mapping} ${s.tuning} ${s.heading}`, 'euler 7 Lattice shapes: Euler mapping, Septimal tuning');
  await cdp.evalJSON(`(location.hash = '#layouts/4:2:i/E', true)`);
  s = await settle('?mapping=randal&mode=5');
  check('T4 anything but a preset on offer falls back', `${s.mapping} ${s.tuning} ${s.src}`, 'randal 5 /shapes.html?mapping=randal&mode=5');
  await cdp.evalJSON(`(location.hash = '#layouts/park/V', true)`);
  s = await settle('?mapping=park&mode=5');
  check('T4 Schismatic is not on offer', `${s.mapping} ${s.tuning} ${s.heading}`, 'park 5 Lattice shapes: Park mapping, Ptolemaic tuning');
  await cdp.evalJSON(`(location.hash = '#layouts', true)`);
  s = await settle('?mapping=randal&mode=5');

  /* T5 */
  await cdp.evalJSON(`(document.querySelector('.g-layouts-frame').contentWindow.__kept = 1, true)`);
  await cdp.evalJSON(`([...document.querySelectorAll('.g-tab')].find((b) => b.textContent === 'Core').click(), true)`);
  await sleep(300);
  s = await cdp.evalJSON(SNAP);
  check('T5 the tab bar has nothing to scroll on a guide\'s tab (px)', s.tabsScroll, 'down 0, across 0');
  check('T5 Core hides Layouts and shows its guide', `${s.tabs} | ${s.shown} ${s.docs} | ${s.title}`, 'Core* Composer Analyzer Orchestrator Overlay Layouts | false 1 | HexKeyLab Guide — Core');
  await cdp.evalJSON(`(location.hash = '#layouts/4:2:i/E', true)`);
  await sleep(600);
  s = await cdp.evalJSON(SNAP);
  check('T5 back on the same layout, the frame\'s page was kept', `${s.shown} ${s.kept} ${s.ready}`, 'true 1 94');

  /* T6: the theme */
  const hashBefore = s.hash;
  await choose(2, 'dark');
  s = await settle('?mapping=randal&mode=5&theme=dark');
  check('T6 dark → the frame; the link stays light', `${s.src} | ${s.open}`, '/shapes.html?mapping=randal&mode=5&theme=dark | /shapes.html?mapping=randal&mode=5');
  check('T6 dark → the frame\'s page', `${s.pageTheme} ${s.pageGround} | ${s.ready}/${s.entries}/${s.pictures}`, 'dark rgb(22, 22, 22) | 94/94/94');
  check('T6 dark → the frame\'s own ground', s.frameGround, 'rgb(22, 22, 22)');
  check('T6 dark → the hash and title do not carry it', `${s.hash} | ${s.title}`, `${hashBefore} | HexKeyLab Guide — Layouts`);
  check('T6 dark is remembered', s.stored, 'dark');
  if (arg('--dark-shot')) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(arg('--dark-shot'), Buffer.from(shot.data, 'base64'));
    console.log(`dark screenshot → ${arg('--dark-shot')}`);
  }
  await choose(0, 'euler');
  s = await settle('?mapping=euler&mode=5&theme=dark');
  check('T6 dark stays through a change of mapping', `${s.hash} | ${s.src} | ${s.pageTheme} | ${s.open}`, '#layouts/euler/5 | /shapes.html?mapping=euler&mode=5&theme=dark | dark | /shapes.html?mapping=euler&mode=5');
  const reloaded = new Promise((res) => { const off = cdp.on('Page.loadEventFired', () => { off(); res(); }); });
  await cdp.send('Page.reload');
  await reloaded;
  s = await settle('?mapping=euler&mode=5&theme=dark');
  check('T6 a reload keeps dark', `${s.theme} | ${s.src} | ${s.pageTheme} | ${s.frameGround}`, 'dark | /shapes.html?mapping=euler&mode=5&theme=dark | dark | rgb(22, 22, 22)');
  await choose(2, 'light');
  s = await settle('?mapping=euler&mode=5');
  check('T6 light puts it back', `${s.stored} | ${s.src} | ${s.open} | ${s.pageTheme} | ${s.frameGround}`, 'light | /shapes.html?mapping=euler&mode=5 | /shapes.html?mapping=euler&mode=5 | null | rgb(221, 221, 221)');

  check('T7 no page errors', errors.join(' | '), '');
} finally {
  await chrome.stop();
}
console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
