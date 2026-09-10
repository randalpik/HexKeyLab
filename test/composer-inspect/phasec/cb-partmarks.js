// Part-mark inventory (2026-09-09) — the gate for notation/parts.ts: tempo
// markings restated above every part, fermatas pinned outside a grand staff.
//
// Reports, over the WHOLE imported document (model doc + render clone):
//   • instruments  — each instrument's staff @n set, and its top staff
//   • tempi        — every <tempo> in the model doc (staff, moment, text) and
//                    the staves the render clone ends up drawing it on
//   • tempoGaps    — any moment whose marking fails to reach a part's top staff
//   • fermatas     — every <fermata>: its note's staff, the @place the clone
//                    assigned, and whether that staff is a grand staff's top,
//                    bottom or a single staff
//   • fermataGaps  — grand-staff fermatas the clone left without a place
//
//   node test/composer-inspect/phasec/runner.mjs test/composer-inspect/phasec/cb-partmarks.js
//   --arg "rows=0"   summary counts only
const H = window.__hkl_composer; const m = H.model;
const arg = String(window.__probeArg || '');
const num = (k, d) => { const g = new RegExp(k + '=(-?\\d+)').exec(arg); return g ? Number(g[1]) : d; };
const rows = num('rows', 12);

const first = (raw) => raw === null ? null : parseInt(String(raw).trim().split(/\s+/)[0], 10);
const sets = m.instruments().map((i) => ({ name: i.name, staffNs: i.staffNs.slice() }));
const tops = sets.map((s) => s.staffNs[0]);
const bottoms = sets.filter((s) => s.staffNs.length >= 2).map((s) => s.staffNs[s.staffNs.length - 1]);

const doc = m.getDoc();
const clone = new DOMParser().parseFromString(m.serialize({ hejiEnabled: m.getHejiEnabled() }), 'application/xml');
const measures = [...doc.querySelectorAll('measure')];
const cmeasures = [...clone.querySelectorAll('measure')];

/* ── tempi ─────────────────────────────────────────────────────────────── */
const tempi = [];
const tempoGaps = [];
measures.forEach((meas, mi) => {
  const src = [...meas.children].filter((c) => c.localName === 'tempo' && (c.textContent || '').trim());
  if (!src.length) return;
  const drawn = [...(cmeasures[mi] ? cmeasures[mi].children : [])]
    .filter((c) => c.localName === 'tempo' && (c.textContent || '').trim());
  const byMoment = new Map();
  for (const t of drawn) {
    const k = Math.round((parseFloat(t.getAttribute('tstamp') || '1') || 1) * 1000);
    if (!byMoment.has(k)) byMoment.set(k, new Set());
    byMoment.get(k).add(first(t.getAttribute('staff')) ?? 1);
  }
  for (const t of src) {
    const ts = parseFloat(t.getAttribute('tstamp') || '1') || 1;
    const k = Math.round(ts * 1000);
    const staves = [...(byMoment.get(k) || [])].sort((a, b) => a - b);
    const missing = tops.filter((n) => !staves.includes(n));
    const row = { measure: mi + 1, tstamp: ts, text: (t.textContent || '').trim().slice(0, 28), srcStaff: first(t.getAttribute('staff')) ?? 1, drawnOn: staves, missing };
    tempi.push(row);
    if (missing.length) tempoGaps.push(row);
  }
});

/* ── fermatas ──────────────────────────────────────────────────────────── */
const staffIndex = (meas) => {
  const map = new Map();
  for (const st of [...meas.children]) {
    if (st.localName !== 'staff') continue;
    const n = first(st.getAttribute('n'));
    if (n === null) continue;
    for (const e of [...st.querySelectorAll('[*|id]')]) {
      const id = e.getAttribute('xml:id');
      if (id) map.set(id, n);
    }
  }
  return map;
};
const fermatas = [];
const fermataGaps = [];
cmeasures.forEach((meas, mi) => {
  const fs = [...meas.children].filter((c) => c.localName === 'fermata');
  if (!fs.length) return;
  const idx = staffIndex(meas);
  for (const f of fs) {
    const ref = (f.getAttribute('startid') || '').replace(/^#/, '');
    const staff = first(f.getAttribute('staff')) ?? (ref ? (idx.get(ref) ?? null) : null);
    const place = f.getAttribute('place');
    const kind = staff === null ? 'unresolved'
      : tops.includes(staff) && bottoms.length && sets.some((s) => s.staffNs.length >= 2 && s.staffNs[0] === staff) ? 'grandTop'
      : bottoms.includes(staff) ? 'grandBottom' : 'single';
    const row = { measure: mi + 1, staff, kind, place };
    fermatas.push(row);
    const want = kind === 'grandTop' ? 'above' : kind === 'grandBottom' ? 'below' : null;
    if (want && place !== want) fermataGaps.push({ ...row, want });
  }
});

const count = (arr, k) => arr.reduce((o, r) => { o[r[k]] = (o[r[k]] || 0) + 1; return o; }, {});
return JSON.stringify({
  instruments: sets,
  topStaves: tops,
  summary: {
    tempi: tempi.length, tempoGaps: tempoGaps.length,
    fermatas: fermatas.length, fermataGaps: fermataGaps.length,
    fermataKinds: count(fermatas, 'kind'), fermataPlaces: count(fermatas, 'place'),
  },
  tempoGaps: tempoGaps.slice(0, rows),
  fermataGaps: fermataGaps.slice(0, rows),
  tempiSample: tempi.slice(0, rows),
  fermataSample: fermatas.slice(0, rows),
});
