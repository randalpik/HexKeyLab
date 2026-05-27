// In-page assertion library. Exported as a single string that the runner
// injects into the page context once, exposing window.__test.* helpers.
// Each helper returns { ok: boolean, detail?: string } so the runner can
// surface a useful failure message without re-querying the page.

export const ASSERTION_LIB = `
(() => {
  const m = () => window.__hkl_composer.model;

  /* Voice's flat children. */
  const flat = (v) => m().flatChildren(v);

  /** Assert various model invariants in one call.
   *  spec = {
   *    voice?: 1|2|3|4,
   *    voiceLength?: number,
   *    flatLength?: number,
   *    cursor?: number,
   *    isPastEnd?: boolean,
   *    measureCount?: number,
   *    currentElementId?: string | null,
   *  }
   *  Any field present is checked; missing fields are skipped. */
  function assertModelState(spec) {
    const v = spec.voice ?? m().getCurrentVoice();
    const fails = [];
    if (spec.voiceLength != null && m().getVoiceLength(v) !== spec.voiceLength) {
      fails.push('voiceLength: expected ' + spec.voiceLength + ', got ' + m().getVoiceLength(v));
    }
    if (spec.flatLength != null && flat(v).length !== spec.flatLength) {
      fails.push('flatLength: expected ' + spec.flatLength + ', got ' + flat(v).length);
    }
    if (spec.cursor != null && m().getCursor(v) !== spec.cursor) {
      fails.push('cursor: expected ' + spec.cursor + ', got ' + m().getCursor(v));
    }
    if (spec.isPastEnd != null && m().isCursorAtPastEnd(v) !== spec.isPastEnd) {
      fails.push('isPastEnd: expected ' + spec.isPastEnd + ', got ' + m().isCursorAtPastEnd(v));
    }
    if (spec.measureCount != null && m().allMeasures().length !== spec.measureCount) {
      fails.push('measureCount: expected ' + spec.measureCount + ', got ' + m().allMeasures().length);
    }
    if (spec.currentElementId !== undefined) {
      const ref = m().getCurrentElement(v, 'insert');
      const got = ref ? ref.id : null;
      if (got !== spec.currentElementId) {
        fails.push('currentElementId: expected ' + JSON.stringify(spec.currentElementId) + ', got ' + JSON.stringify(got));
      }
    }
    return fails.length ? { ok: false, detail: fails.join('; ') } : { ok: true };
  }

  /** Cursor convention (post-refactor):
   *    cursor c means "past flat[c]" — flat[c] is the element to the
   *    cursor's LEFT (also the element getCurrentElement returns).
   *    At past-end (cursor === voiceLen, voiceLen === flatLen): no flat[c]
   *    to the left; getCurrentElement returns null.
   *  Asserts:
   *    (1) When cursor < flat.length: getCurrentElement.elem === flat[cursor].
   *    (2) cursor === voiceLen ⇔ isCursorAtPastEnd (when past-end exists). */
  function assertCursorConvention(voice) {
    const v = voice ?? m().getCurrentVoice();
    const fl = flat(v);
    const cur = m().getCursor(v);
    if (cur > fl.length) return { ok: false, detail: 'cursor ' + cur + ' > flat.length ' + fl.length };
    if (cur < fl.length) {
      const ref = m().getCurrentElement(v, 'insert');
      if (!ref) return { ok: false, detail: 'getCurrentElement returned null but cursor (' + cur + ') < flat.length (' + fl.length + ')' };
      if (ref.elem !== fl[cur]) {
        return { ok: false, detail: 'getCurrentElement.elem.tag=' + ref.elem.localName + ' but flat[cursor].tag=' + (fl[cur]?.localName ?? 'null') };
      }
    }
    /* cursor === flatLen: past-end position. isCursorAtPastEnd reflects this. */
    const expectedPastEnd = cur === fl.length;
    if (m().isCursorAtPastEnd(v) !== expectedPastEnd) {
      return { ok: false, detail: 'cursor=' + cur + ' flatLen=' + fl.length + ' but isCursorAtPastEnd=' + m().isCursorAtPastEnd(v) };
    }
    return { ok: true };
  }

  /** Past-end is conditional on the last layer not being full. */
  function assertPastEndConditional(voice, expectedPastEndExists) {
    const v = voice ?? m().getCurrentVoice();
    const flatLen = flat(v).length;
    const voiceLen = m().getVoiceLength(v);
    const pastEndExists = voiceLen === flatLen;
    if (pastEndExists !== expectedPastEndExists) {
      return {
        ok: false,
        detail: 'pastEndExists: expected ' + expectedPastEndExists +
          ', got ' + pastEndExists +
          ' (voiceLen=' + voiceLen + ', flatLen=' + flatLen + ')',
      };
    }
    return { ok: true };
  }

  /** No orphan ties (post-normalizeTies forward-only model):
   *    - @tie="i" or "m" has data-tie-partner pointing to a real note in
   *      the document. (Forward chain pointer.)
   *    - @tie="t" has NO data-tie-partner (terminal — no forward link).
   *    - Every data-tie-partner reference resolves to an existing note.
   *    - Pending stubs (@data-pending-tie="true") have no @tie and no
   *      data-tie-partner. */
  function assertNoTieOrphans() {
    const doc = m().getDoc();
    const fails = [];
    for (const n of Array.from(doc.querySelectorAll('note'))) {
      const tie = n.getAttribute('tie');
      const partnerId = n.getAttribute('data-tie-partner');
      const pending = n.hasAttribute('data-pending-tie');
      const id = n.getAttribute('xml:id');
      if (tie === 'i' || tie === 'm') {
        if (!partnerId) {
          fails.push('note ' + id + ' @tie="' + tie + '" missing forward data-tie-partner');
          continue;
        }
        const partner = doc.querySelector('[*|id="' + partnerId + '"]');
        if (!partner) {
          fails.push('note ' + id + ' has dangling data-tie-partner="' + partnerId + '"');
        }
      } else if (tie === 't') {
        if (partnerId) {
          fails.push('note ' + id + ' @tie="t" should not carry data-tie-partner (terminal)');
        }
      } else if (pending) {
        if (partnerId) {
          fails.push('note ' + id + ' pending stub has data-tie-partner (should be null)');
        }
      } else if (partnerId) {
        fails.push('note ' + id + ' carries data-tie-partner without @tie / @data-pending-tie');
      }
    }
    return fails.length ? { ok: false, detail: fails.join('; ') } : { ok: true };
  }

  /** Per-measure placeholder invariant: every layer's contentTicks +
   *  placeholderTicks equals measureTicks. */
  function assertPlaceholderInvariant() {
    const ticksOf = (dur, dots) => {
      const denom = parseInt(dur, 10);
      let base = 64 / denom;
      if (dots === 1) base *= 1.5;
      if (dots === 2) base *= 1.75;
      return base;
    };
    const layerTicks = (layer) => {
      let t = 0;
      for (const c of Array.from(layer.children)) {
        const dur = c.getAttribute('dur');
        const dots = parseInt(c.getAttribute('dots') || '0', 10);
        if (dur) t += ticksOf(dur, dots);
        else if (c.localName === 'tuplet') {
          const num = parseInt(c.getAttribute('num') || '0', 10);
          const numbase = parseInt(c.getAttribute('numbase') || '0', 10);
          const atomicDur = c.getAttribute('data-tuplet-atomic-dur');
          if (num && numbase && atomicDur) {
            t += ticksOf(atomicDur, 0) * numbase;
          }
        }
      }
      return t;
    };
    const mTicks = m().measureTicks();
    const measures = m().allMeasures();
    const fails = [];
    for (let mi = 0; mi < measures.length; mi++) {
      const layers = measures[mi].querySelectorAll('layer');
      for (const layer of layers) {
        const t = layerTicks(layer);
        if (Math.abs(t - mTicks) > 0.001) {
          fails.push('measure ' + mi + ' staff/layer n=' +
            layer.parentElement?.getAttribute('n') + '/' + layer.getAttribute('n') +
            ': ticks=' + t + ' expected=' + mTicks);
        }
      }
    }
    return fails.length ? { ok: false, detail: fails.slice(0, 3).join('; ') } : { ok: true };
  }

  /** Tuplet bracket is rendered in the SVG (Verovio bracket-pass workaround). */
  function assertBracketRendered(tupletXmlId) {
    const svgEl = document.querySelector('#score svg');
    if (!svgEl) return { ok: false, detail: 'no score svg' };
    /* Verovio mirrors xml:id as element id on the rendered g. */
    const g = svgEl.querySelector('#' + CSS.escape(tupletXmlId));
    if (!g) return { ok: false, detail: 'no g for tuplet ' + tupletXmlId };
    const bracket = g.querySelector('.tupletBracket, polyline');
    return bracket
      ? { ok: true }
      : { ok: false, detail: 'tuplet ' + tupletXmlId + ' has no bracket element' };
  }

  /** Tuplet placeholders are CSS-hidden (visibility:hidden). */
  function assertTupletPlaceholdersHidden() {
    const phs = document.querySelectorAll('#score svg g.rest[data-data-tuplet-placeholder="true"]');
    const fails = [];
    for (const ph of phs) {
      const vis = getComputedStyle(ph).visibility;
      if (vis !== 'hidden') {
        fails.push('placeholder ' + (ph.id || '?') + ' visibility=' + vis);
      }
    }
    return fails.length ? { ok: false, detail: fails.slice(0, 3).join('; ') } : { ok: true };
  }

  /** Notehead color isolation: stems/flags/accidentals are not colored with
   *  the chord's color. Inputs the xml:id of the parent note/chord and
   *  the expected notehead color hex. */
  function assertColorIsolation(noteXmlId, colorHex) {
    const svgEl = document.querySelector('#score svg');
    if (!svgEl) return { ok: false, detail: 'no score svg' };
    const g = svgEl.querySelector('#' + CSS.escape(noteXmlId));
    if (!g) return { ok: false, detail: 'no g for note/chord ' + noteXmlId };
    const colored = (el) => getComputedStyle(el).color.toLowerCase();
    /* Heads should be colored; stems/flags/accids should be black-ish. */
    const heads = g.querySelectorAll('g.notehead');
    const fails = [];
    for (const h of heads) {
      const fill = h.getAttribute('fill') || colored(h);
      if (fill && colorHex && fill.toLowerCase() !== colorHex.toLowerCase() &&
          fill.replace(/#/, '').toLowerCase() !== colorHex.replace(/#/, '').toLowerCase()) {
        /* Color may live on a child <use>; only flag if no descendant has it either. */
        const anyMatch = Array.from(h.querySelectorAll('[fill]')).some(
          (n) => (n.getAttribute('fill') || '').toLowerCase().includes(colorHex.toLowerCase().slice(1))
        );
        if (!anyMatch) fails.push('notehead fill=' + fill + ' expected ' + colorHex);
      }
    }
    /* Stem/flag/accid should NOT carry the chord's color in computed fill. */
    const nonHead = g.querySelectorAll('g.stem, g.flag, g.accid');
    for (const el of nonHead) {
      const fill = el.getAttribute('fill') || '';
      if (fill && colorHex && fill.toLowerCase() === colorHex.toLowerCase()) {
        fails.push(el.localName + ' (class=' + el.getAttribute('class') + ') is colored with chord color ' + colorHex);
      }
    }
    return fails.length ? { ok: false, detail: fails.slice(0, 3).join('; ') } : { ok: true };
  }

  /** Cursor is currently within the viewport of the #score element. */
  function assertCursorInViewport(padding) {
    const pad = padding ?? 0;
    const score = document.getElementById('score');
    if (!score) return { ok: false, detail: 'no #score element' };
    const sr = score.getBoundingClientRect();
    const bars = document.querySelectorAll('rect[data-cursor-role="voice"]');
    let live = null;
    for (const b of bars) if (b.isConnected) { live = b; break; }
    if (!live) return { ok: false, detail: 'no live cursor bar' };
    const cr = live.getBoundingClientRect();
    const within =
      cr.left   >= sr.left   - pad &&
      cr.right  <= sr.right  + pad &&
      cr.top    >= sr.top    - pad &&
      cr.bottom <= sr.bottom + pad;
    return within
      ? { ok: true }
      : { ok: false, detail: 'cursor rect ' + JSON.stringify({l: cr.left, t: cr.top, r: cr.right, b: cr.bottom}) +
          ' not within score rect ' + JSON.stringify({l: sr.left, t: sr.top, r: sr.right, b: sr.bottom}) };
  }

  /** Visual cursor measure matches expectation. */
  function assertCursorVisualMeasure(voice, expectedMIdx) {
    const v = voice ?? m().getCurrentVoice();
    const got = m().cursorMeasureIdx(v);
    return got === expectedMIdx
      ? { ok: true }
      : { ok: false, detail: 'cursorMeasureIdx: expected ' + expectedMIdx + ', got ' + got };
  }

  /** Count of accid glyph 'use' refs inside a given measure index. */
  function countAccidGlyphs(measureIdx) {
    const svgEl = document.querySelector('#score svg');
    if (!svgEl) return -1;
    const measures = svgEl.querySelectorAll('g.measure');
    const mEl = measures[measureIdx];
    if (!mEl) return -1;
    return mEl.querySelectorAll('g.accid use').length;
  }

  /** Round-trip equality check — but placeholder xml:ids are regenerated
   *  by normalizePlaceholders on every load, so byte-equality is too
   *  strict. Strip xml:ids from placeholder <space> elements (and from
   *  tuplet placeholder <rest> elements) before comparing. Other ids
   *  must match exactly (notes / chords / tuplets / layers / etc.). */
  function runRoundTrip() {
    const before = m().serialize();
    const cls = m().constructor;
    const fresh = new cls(before);
    const after = fresh.serialize();
    const normalize = (xml) => {
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      const phs = doc.querySelectorAll(
        'space[data-placeholder="true"], rest[data-tuplet-placeholder="true"]'
      );
      for (const ph of phs) ph.removeAttributeNS('http://www.w3.org/XML/1998/namespace', 'id');
      return new XMLSerializer().serializeToString(doc);
    };
    const nBefore = normalize(before);
    const nAfter = normalize(after);
    return { ok: nBefore === nAfter, before: nBefore, after: nAfter };
  }

  window.__test = {
    assertModelState,
    assertCursorConvention,
    assertPastEndConditional,
    assertNoTieOrphans,
    assertPlaceholderInvariant,
    assertBracketRendered,
    assertTupletPlaceholdersHidden,
    assertColorIsolation,
    assertCursorInViewport,
    assertCursorVisualMeasure,
    countAccidGlyphs,
    runRoundTrip,
  };
  return Object.keys(window.__test);
})()
`;
