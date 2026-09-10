// Which spanners does the MusicXML round-trip lose, and where?
const H = window.__hkl_composer; const m = H.model;
const { exportMusicXml } = await import('/composer/src/save.ts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const posOf = () => {
  const d = m.getDoc();
  const measures = [...d.querySelectorAll('measure')];
  const pos = new Map();
  measures.forEach((meas, mi) => {
    for (const st of [...meas.querySelectorAll('staff')]) {
      const sn = st.getAttribute('n');
      for (const ly of [...st.querySelectorAll('layer')]) {
        let t = 0;
        const walk = (par) => {
          for (const c of [...par.children]) {
            const ln = c.localName;
            if (ln === 'beam' || ln === 'tuplet' || ln === 'fTrem' || ln === 'bTrem') { walk(c); continue; }
            if (ln === 'note' || ln === 'chord' || ln === 'rest' || ln === 'space') {
              const id = c.getAttribute('xml:id');
              if (id) pos.set(id, mi + ':' + sn + ':' + t);
              for (const n of [...c.querySelectorAll('note')]) {
                const nid = n.getAttribute('xml:id');
                if (nid) pos.set(nid, mi + ':' + sn + ':' + t);
              }
              const dur = parseInt(c.getAttribute('dur') || '4', 10) || 4;
              const dots = parseInt(c.getAttribute('dots') || '0', 10);
              let w = 64 / dur; if (dots === 1) w *= 1.5; if (dots === 2) w *= 1.75;
              t += w;
            }
          }
        };
        walk(ly);
      }
    }
  });
  return pos;
};

const spanSet = (name) => {
  const d = m.getDoc(); const pos = posOf();
  return [...d.querySelectorAll(name)].map((el) => {
    const a = (el.getAttribute('startid') || '').replace(/^#/, '');
    const b = (el.getAttribute('endid') || '').replace(/^#/, '');
    return (pos.get(a) || '?' + a) + ' -> ' + (pos.get(b) || '?' + b);
  });
};

const octDetail = () => [...m.getDoc().querySelectorAll('octave')].map((o) => {
  const meas = o.closest('measure');
  const mi = [...m.getDoc().querySelectorAll('measure')].indexOf(meas);
  return { measure: mi + 1, staff: o.getAttribute('staff'), dis: o.getAttribute('dis'), place: o.getAttribute('dis.place'),
           start: (o.getAttribute('startid') || '').replace(/^#/, ''), end: (o.getAttribute('endid') || '').replace(/^#/, '') };
});

const beforeSlurs = spanSet('slur');
const beforeOct = octDetail();
const xml = exportMusicXml(m);
const outDoc = new DOMParser().parseFromString(xml, 'application/xml');
const exportedOct = [...outDoc.querySelectorAll('octave-shift')].map((o) => {
  const meas = o.closest('measure');
  const part = o.closest('part');
  return { part: part && part.getAttribute('id'), measure: meas && meas.getAttribute('number'),
           type: o.getAttribute('type'), size: o.getAttribute('size'),
           staff: (o.closest('direction').querySelector('staff') || {}).textContent };
});

window.__composerImportMusicXml(xml);
for (let i = 0; i < 400; i++) {
  const b = document.getElementById('renderBusy');
  if (document.querySelector('.score-page svg') && (!b || b.hidden)) break;
  await sleep(250);
}
await sleep(1500);
const afterSlurs = spanSet('slur');
const afterOct = octDetail();

const countMap = (arr) => arr.reduce((mm, k) => (mm[k] = (mm[k] || 0) + 1, mm), {});
const cb = countMap(beforeSlurs), ca = countMap(afterSlurs);
const missing = [];
for (const k of Object.keys(cb)) { const d = cb[k] - (ca[k] || 0); if (d > 0) missing.push({ span: k, lost: d }); }
const extra = [];
for (const k of Object.keys(ca)) { const d = ca[k] - (cb[k] || 0); if (d > 0) extra.push({ span: k, added: d }); }

return JSON.stringify({
  slursBefore: beforeSlurs.length, slursAfter: afterSlurs.length,
  slursLost: missing.slice(0, 12), slursAdded: extra.slice(0, 12),
  octBefore: beforeOct, exportedOct, octAfter: afterOct,
}, null, 1);
