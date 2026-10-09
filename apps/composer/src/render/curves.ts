/* Arc-length sampling of SVG path data in JS (2026-10-08).
 *
 * The tie, slur and text-layout passes sample curve outlines to test them
 * against obstacles. They did it through `getTotalLength` / `getPointAtLength`
 * — 105 000 calls on a sonata load (1.4 s in Chromium; Gecko re-flattens the
 * path on every call, so far more there). A Verovio curve is two or three
 * cubic Béziers in absolute coordinates; flattening them here, once per path,
 * gives the same arc-length parametrisation to well under a hundredth of a
 * unit, with no layout work at all.
 *
 * Supported: M L H V C S Q T Z, absolute and relative — everything Verovio
 * writes and a little more. A path that uses anything else (arcs) returns
 * null and the caller falls back to the DOM API.
 */

export interface Pt { x: number; y: number }

export interface PathSampler {
  /** Total length of the flattened path, in the path's own user units. */
  length: number;
  /** Point at arc length `s` from the path's start (clamped to [0, length]). */
  pointAt(s: number): Pt;
}

/** Subdivisions per Bézier segment. 24 keeps a 20-unit slur's flattening
 *  error below 0.01 units — a hundredth of the sampling gaps the passes use. */
const SUBDIV = 24;

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

export function samplePath(d: string): PathSampler | null {
  const pts: Pt[] = [];
  const cum: number[] = [];
  let total = 0;
  const push = (p: Pt): void => {
    if (pts.length) {
      const q = pts[pts.length - 1];
      total += Math.hypot(p.x - q.x, p.y - q.y);
    }
    pts.push(p);
    cum.push(total);
  };
  const cubic = (p0: Pt, p1: Pt, p2: Pt, p3: Pt): void => {
    for (let i = 1; i <= SUBDIV; i++) {
      const t = i / SUBDIV, u = 1 - t;
      push({
        x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
        y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
      });
    }
  };
  const quad = (p0: Pt, p1: Pt, p2: Pt): void => {
    for (let i = 1; i <= SUBDIV; i++) {
      const t = i / SUBDIV, u = 1 - t;
      push({ x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y });
    }
  };
  /* Tokenise: a command letter followed by its numbers, repeated. */
  const re = /([MLHVCSQTZmlhvcsqtz])([^MLHVCSQTZmlhvcsqtz]*)/g;
  let cur: Pt = { x: 0, y: 0 };
  let start: Pt = { x: 0, y: 0 };
  let lastCtrl: Pt | null = null;   // reflection point for S / T
  let lastCmd = '';
  let m: RegExpExecArray | null;
  let any = false;
  while ((m = re.exec(d)) !== null) {
    const cmd = m[1];
    const nums = (m[2].match(NUM) ?? []).map(Number);
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const P = (x: number, y: number): Pt => (rel ? { x: cur.x + x, y: cur.y + y } : { x, y });
    let i = 0;
    const take = (n: number): boolean => { if (i + n > nums.length) return false; return true; };
    if (C === 'Z') {
      if (pts.length && (cur.x !== start.x || cur.y !== start.y)) push(start);
      cur = start;
      lastCtrl = null;
      lastCmd = C;
      any = true;
      continue;
    }
    if (C === 'M') {
      if (!take(2)) return null;
      cur = P(nums[0], nums[1]); start = cur; i = 2;
      if (pts.length) return null;   // a second subpath: not a single curve — let the caller fall back
      push(cur);
      /* Further pairs after M are implicit L. */
      while (i + 1 < nums.length) { cur = P(nums[i], nums[i + 1]); push(cur); i += 2; }
      lastCtrl = null; lastCmd = C; any = true;
      continue;
    }
    any = true;
    while (true) {
      if (C === 'L') { if (!take(2)) break; cur = P(nums[i], nums[i + 1]); push(cur); i += 2; lastCtrl = null; }
      else if (C === 'H') { if (!take(1)) break; cur = { x: rel ? cur.x + nums[i] : nums[i], y: cur.y }; push(cur); i += 1; lastCtrl = null; }
      else if (C === 'V') { if (!take(1)) break; cur = { x: cur.x, y: rel ? cur.y + nums[i] : nums[i] }; push(cur); i += 1; lastCtrl = null; }
      else if (C === 'C') {
        if (!take(6)) break;
        const p1 = P(nums[i], nums[i + 1]), p2 = P(nums[i + 2], nums[i + 3]), p3 = P(nums[i + 4], nums[i + 5]);
        cubic(cur, p1, p2, p3); cur = p3; lastCtrl = p2; i += 6;
      } else if (C === 'S') {
        if (!take(4)) break;
        const p1: Pt = lastCtrl && (lastCmd === 'C' || lastCmd === 'S') ? { x: 2 * cur.x - lastCtrl.x, y: 2 * cur.y - lastCtrl.y } : cur;
        const p2 = P(nums[i], nums[i + 1]), p3 = P(nums[i + 2], nums[i + 3]);
        cubic(cur, p1, p2, p3); cur = p3; lastCtrl = p2; i += 4;
      } else if (C === 'Q') {
        if (!take(4)) break;
        const p1 = P(nums[i], nums[i + 1]), p2 = P(nums[i + 2], nums[i + 3]);
        quad(cur, p1, p2); cur = p2; lastCtrl = p1; i += 4;
      } else if (C === 'T') {
        if (!take(2)) break;
        const p1: Pt = lastCtrl && (lastCmd === 'Q' || lastCmd === 'T') ? { x: 2 * cur.x - lastCtrl.x, y: 2 * cur.y - lastCtrl.y } : cur;
        const p2 = P(nums[i], nums[i + 1]);
        quad(cur, p1, p2); cur = p2; lastCtrl = p1; i += 2;
      } else break;
      lastCmd = C;
      if (i >= nums.length) break;
    }
    if (i < nums.length) return null;   // leftover numbers: malformed for this parser
  }
  if (!any || pts.length < 2 || !(total > 0)) return null;
  const length = total;
  return {
    length,
    pointAt(s: number): Pt {
      if (!(s > 0)) return pts[0];
      if (s >= length) return pts[pts.length - 1];
      /* Binary search the cumulative lengths, then interpolate the segment. */
      let lo = 0, hi = cum.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
      const seg = cum[hi] - cum[lo];
      const t = seg > 0 ? (s - cum[lo]) / seg : 0;
      return { x: pts[lo].x + (pts[hi].x - pts[lo].x) * t, y: pts[lo].y + (pts[hi].y - pts[lo].y) * t };
    },
  };
}

/** Sample `path` at `n + 1` points equally spaced by arc length, mapped
 *  through `m` (the path's CTM composed with the frame's inverse). Null when
 *  the path cannot be parsed — the caller may fall back to the DOM API. */
export function sampleOutline(d: string, n: number, m: DOMMatrix): Pt[] | null {
  const sp = samplePath(d);
  if (!sp) return null;
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const q = sp.pointAt(sp.length * i / n);
    out.push({ x: m.a * q.x + m.c * q.y + m.e, y: m.b * q.x + m.d * q.y + m.f });
  }
  return out;
}

/* ── CTM without layout ──
   `getCTM()` is a layout query, and the engraving passes asked it 96 000 times
   on a sonata load (2026-10-08). An element's CTM is the product of the
   transforms on its ancestor chain up to its viewport, so two elements with
   the same chain of `transform` attributes under the same `<svg>` share a
   CTM: memoise by (viewport, chain string). The chain is read live from the
   attributes on every call — a transform written by a pass changes the key,
   a root resized by `pinExactScale` changes the key (its size is part of it)
   — so nothing here can go stale, and the first element of each chain pays
   the one real `getCTM()`. */
const ctmMemo = new WeakMap<Element, Map<string, DOMMatrix>>();

export function ctmOf(el: SVGGraphicsElement): DOMMatrix | null {
  let chain = '';
  let node: Element | null = el;
  let root: Element | null = null;
  while (node) {
    const t = node.getAttribute('transform');
    if (t) chain += t + '|';
    if (node.localName === 'svg') {
      /* The nearest viewport: its size and viewBox set the user-unit scale. */
      chain += '#' + (node.getAttribute('viewBox') ?? '') + '/' + (node.getAttribute('width') ?? '') + 'x' + (node.getAttribute('height') ?? '');
      root = node;
      break;
    }
    node = node.parentElement;
  }
  if (!root) return typeof el.getCTM === 'function' ? el.getCTM() : null;
  let byChain = ctmMemo.get(root);
  if (!byChain) { byChain = new Map(); ctmMemo.set(root, byChain); }
  const hit = byChain.get(chain);
  if (hit) return hit;
  if (typeof el.getCTM !== 'function') return null;
  const m = el.getCTM();
  if (!m) return null;
  if (byChain.size > 4096) byChain.clear();
  byChain.set(chain, m);
  return m;
}
