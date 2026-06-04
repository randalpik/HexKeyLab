// Click-to-position: EVERY click in the score jumps the cursor to the nearest
// navigable target and switches to its appropriate cursor mode. Targets are
// found by a global nearest-distance search over all rendered elements (not
// point-hit-testing, which no-ops on whitespace clicks). Three target kinds,
// all first-class:
//   - note/chord/rest glyph  → voice mode, cursor before/after by click side
//   - empty-measure staff    → voice mode, cursor at that measure's start stop
//   - dynam/hairpin/pedal/dir/tempo control → its expression-family layer
// Distance is point-to-bounding-box (0 when the click is inside the box), so
// the closest thing always wins. Per-click diagnostics are logged under the
// `[click]` console prefix.

import type { ComposerModel, Voice } from './model/index.js';

export interface ClickHooks {
  /** Trigger a re-render + state refresh. */
  onChange: () => void;
  /** Surface a status message (e.g. on voice switch). */
  setStatus?: (msg: string, kind?: 'info' | 'error' | 'state' | 'action') => void;
  /** Suppress while playback is active. */
  isPlaybackActive: () => boolean;
  /** Select a clicked expression-family control (dynam/dir/hairpin/pedal/tempo)
   *  by xml:id — switch into its virtual layer and snap the cursor to it.
   *  Returns true if the id resolved to a selectable control. */
  onSelectLayerElement?: (meiId: string) => boolean;
}

const CONTROL_CLASSES = ['dynam', 'hairpin', 'pedal', 'dir', 'tempo'];

/** Resolve a glyph `<g>` to the meiId that lives in flatChildren: the OUTERMOST
 *  g.chord when present (chord-internal note ids aren't flat entries), else the
 *  bare note/rest id. */
function noteOrRestId(g: Element): string | null {
  const chord = g.closest('g.chord');
  if (chord) return chord.getAttribute('id');
  return g.getAttribute('id');
}

/** True for a glyph the user can actually target: visible (not a CSS-hidden
 *  tuplet placeholder / hidden rest) and laid out (non-zero box). */
function isRealGlyph(g: Element): boolean {
  if (g.getAttribute('data-data-tuplet-placeholder') === 'true') return false;
  const r = g.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  try { if (getComputedStyle(g).visibility === 'hidden') return false; } catch { /* jsdom */ }
  return true;
}

/** Euclidean distance from point (x,y) to rectangle `r`; 0 when inside. */
function distToRect(x: number, y: number, r: DOMRect): number {
  const dx = x < r.left ? r.left - x : (x > r.right ? x - r.right : 0);
  const dy = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
  return Math.hypot(dx, dy);
}

type Candidate =
  | { kind: 'glyph'; id: string; rect: DOMRect; dist: number }
  | { kind: 'emptyStaff'; staffG: Element; rect: DOMRect; dist: number }
  | { kind: 'control'; id: string; rect: DOMRect; dist: number };

/** Collect every navigable target in the rendered score with its distance to
 *  the click point. Empty-measure staff regions are first-class targets (added
 *  for any staff with no real glyph), so a click nearest an empty measure lands
 *  at its start stop even when notes exist elsewhere. */
function gatherCandidates(svg: Element, x: number, y: number): Candidate[] {
  const cands: Candidate[] = [];
  const seenGlyph = new Set<string>();
  const stavesWithGlyph = new Set<Element>();

  for (const g of Array.from(svg.querySelectorAll('g.chord, g.note, g.rest'))) {
    if (!isRealGlyph(g)) continue;
    const id = noteOrRestId(g);
    if (!id) continue;
    const staff = g.closest('g.staff');
    if (staff) stavesWithGlyph.add(staff);
    if (seenGlyph.has(id)) continue;
    seenGlyph.add(id);
    const owner = g.closest('g.chord') ?? g;
    const rect = owner.getBoundingClientRect();
    cands.push({ kind: 'glyph', id, rect, dist: distToRect(x, y, rect) });
  }

  for (const staff of Array.from(svg.querySelectorAll('g.staff'))) {
    if (stavesWithGlyph.has(staff)) continue;
    const rect = staff.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    cands.push({ kind: 'emptyStaff', staffG: staff, rect, dist: distToRect(x, y, rect) });
  }

  const controlSel = CONTROL_CLASSES.map((c) => 'g.' + c).join(', ');
  for (const g of Array.from(svg.querySelectorAll(controlSel))) {
    const id = g.getAttribute('id');
    if (!id) continue;
    const rect = g.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    cands.push({ kind: 'control', id, rect, dist: distToRect(x, y, rect) });
  }

  return cands;
}

export function attachScoreClickHandler(
  scoreEl: HTMLElement,
  model: ComposerModel,
  hooks: ClickHooks,
): () => void {
  /* Place the cursor at the start stop of the measure under an empty staff:
     resolve the rendered `<g class="staff">` id → model staff (xml:id) → first
     voice on that staff → its measure-start stop. False if unresolved. */
  function placeCursorAtEmptyStaff(staffG: Element): boolean {
    const staffId = staffG.getAttribute('id');
    if (!staffId) return false;
    const doc = model.getDoc();
    let staffEl: Element | null = null;
    for (const s of Array.from(doc.querySelectorAll('staff'))) {
      if (s.getAttribute('xml:id') === staffId) { staffEl = s; break; }
    }
    if (!staffEl) return false;
    const staffN = parseInt(staffEl.getAttribute('n') ?? '0', 10);
    const measureEl = staffEl.closest('measure');
    if (!measureEl) return false;
    const mi = model.measureIdxOf(measureEl);
    if (mi < 0) return false;
    let voice: number | null = null;
    for (let v = 1; v <= model.totalVoices(); v++) {
      if (model.staffForVoice(v) === staffN) { voice = v; break; }
    }
    if (voice == null) return false;
    model.setVoice(voice as Voice);
    const cur = model.getMeasureStartCursor(voice as Voice, mi);
    model.setCursor(cur, voice as Voice);
    console.log('[click] → emptyStaff: staff @' + staffN + ' measure ' + mi + ' → voice ' + voice + ' cursor ' + cur);
    /* No status message: the top-bar voice indicator already shows the voice. */
    return true;
  }

  function onClick(e: MouseEvent): void {
    if (hooks.isPlaybackActive()) { console.log('[click] ignored: playback active'); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) { console.log('[click] ignored: modifier held'); return; }
    if (e.button !== 0) { console.log('[click] ignored: non-primary button'); return; }

    const svg = scoreEl.querySelector('svg');
    if (!svg) { console.log('[click] ignored: no rendered SVG'); return; }

    const x = e.clientX, y = e.clientY;
    const cands = gatherCandidates(svg, x, y);
    if (cands.length === 0) { console.log('[click] (' + Math.round(x) + ',' + Math.round(y) + ') no targets in score'); return; }

    let best = cands[0];
    for (const c of cands) if (c.dist < best.dist) best = c;

    const counts = cands.reduce((m, c) => { m[c.kind] = (m[c.kind] ?? 0) + 1; return m; }, {} as Record<string, number>);
    console.log('[click] (' + Math.round(x) + ',' + Math.round(y) + ') candidates=' + JSON.stringify(counts)
      + ' nearest=' + best.kind + ' dist=' + best.dist.toFixed(1)
      + (best.kind !== 'emptyStaff' ? ' id=' + best.id : ''));

    if (best.kind === 'control') {
      if (hooks.onSelectLayerElement && hooks.onSelectLayerElement(best.id)) {
        console.log('[click] → control selected in its layer: ' + best.id);
        hooks.onChange();
      } else {
        console.log('[click] control did not resolve to a selectable layer element: ' + best.id);
      }
      return;
    }

    if (best.kind === 'emptyStaff') {
      if (placeCursorAtEmptyStaff(best.staffG)) hooks.onChange();
      else console.log('[click] emptyStaff did not resolve to a model staff/voice');
      return;
    }

    /* glyph: place the cursor before or after it by which side of its center
       the click fell. Cursor convention "c targets flat[c]": index = before,
       index+1 = after. */
    const loc = model.findElement(best.id);
    if (!loc) { console.log('[click] glyph id has no model element: ' + best.id); return; }
    /* The INS cursor renders to the RIGHT of a note, so a note "owns" the span
       from its left edge rightward to the next note. Clicking at/right of the
       glyph's left edge selects it (cursor = its flat index, drawn at its right
       edge); a click fully LEFT of the glyph lands before it (index − 1).
       Between two notes this resolves to the left note either way: the left
       half is nearest the left note (→ its index); the right half is nearest
       the right note (→ right.index − 1 = left.index). */
    const side: 'before' | 'after' = x >= best.rect.left ? 'after' : 'before';
    const cursor = side === 'after' ? loc.index : loc.index - 1;
    model.setVoice(loc.voice as Voice);
    model.setCursor(cursor, loc.voice as Voice);
    console.log('[click] → glyph: voice ' + loc.voice + ' flat[' + loc.index + '] side=' + side + ' cursor=' + cursor);
    /* No status message: the top-bar voice indicator already shows the voice. */
    hooks.onChange();
  }

  scoreEl.addEventListener('click', onClick);
  return () => scoreEl.removeEventListener('click', onClick);
}
