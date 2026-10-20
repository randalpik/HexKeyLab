// Per-fixture V8 block coverage, mapped back to original source lines.
//
// `run.mjs <tier> --coverage` turns on precise coverage, snapshots it after
// every fixture, and writes out/coverage-map.json: for each fixture, the set of
// original (TypeScript) lines it executed in Composer's modules and the
// packages it loads. Each module's compiled source (the sourcemap's
// sourcesContent) rides along as a snapshot, so `run.mjs affected` can diff the
// working tree against exactly what was measured. select-fast.mjs reads the
// same map to choose the fast tier.
//
// V8 block ranges are exact where reported but leave gaps (e.g. the code after
// a conditional expression inherits its function's count), so the line sets
// can only OVER-approximate what ran — affected selection errs toward running
// more, never fewer.
//
// Coverage counters reset on every take (callCount: true), so a take after a
// fixture holds only what that fixture ran — module top-level code runs once at
// load and is never attributed to a fixture (affected.mjs treats module-scope
// lines accordingly, finding function extents by parsing the snapshot).

import { execFileSync } from 'node:child_process';

const REPO = new URL('../../../', import.meta.url).pathname;

/** Repo-relative source path for a served module URL, or null if the module is
 *  not Composer/package source (Vite client, prebundled deps, CSS, ...). */
export function sourcePathOf(url) {
  let p;
  try { p = new URL(url).pathname; } catch { return null; }
  if (!/\.(ts|js|mjs)$/.test(p) || p.includes('/node_modules/') || p.includes('/@vite/') || p.includes('/@id/')) return null;
  const fs = p.indexOf('/@fs/');
  if (fs >= 0) {
    const abs = p.slice(fs + 4);
    return abs.startsWith(REPO) ? abs.slice(REPO.length) : null;
  }
  const m = p.match(/^\/composer\/(src\/.*)$/);
  return m ? 'apps/composer/' + m[1] : null;
}

/* ── Sourcemap decoding (inline base64 maps, as Vite serves in dev) ──────── */

const B64 = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((c, i) => [c, i]));

/** Decode a v3 `mappings` string into per-generated-line segment arrays of
 *  [genCol, srcIdx, origLine0, origCol] (segments without a source dropped). */
function decodeMappings(mappings) {
  const lines = [];
  let srcIdx = 0, origLine = 0, origCol = 0;
  for (const lineStr of mappings.split(';')) {
    const segs = [];
    let genCol = 0;
    if (lineStr) {
      for (const seg of lineStr.split(',')) {
        const vals = [];
        let shift = 0, value = 0;
        for (const ch of seg) {
          const d = B64.get(ch);
          value += (d & 31) << shift;
          if (d & 32) { shift += 5; continue; }
          vals.push(value & 1 ? -(value >>> 1) : value >>> 1);
          shift = 0; value = 0;
        }
        genCol += vals[0];
        if (vals.length >= 4) {
          srcIdx += vals[1]; origLine += vals[2]; origCol += vals[3];
          segs.push([genCol, srcIdx, origLine, origCol]);
        }
      }
    }
    lines.push(segs);
  }
  return lines;
}

/** Fetch a served module and build its generated-offset → original-line index:
 *  flat arrays of [genStart, genEnd) spans with the original 1-based line each
 *  maps to, plus the original source text (sourcesContent). */
async function loadModule(url, path) {
  const code = await (await fetch(url)).text();
  const m = code.match(/\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/);
  if (!m) return null;
  const map = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  const own = map.sources.findIndex((s) => path.endsWith(s.replace(/^(\.\.?\/)+/, '').replace(/^\//, '')));
  const srcIdx = own >= 0 ? own : 0;
  const content = map.sourcesContent?.[srcIdx];
  if (content == null) return null;
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const decoded = decodeMappings(map.mappings);
  const genStart = [], genEnd = [], origLine = [];
  for (let gl = 0; gl < decoded.length; gl++) {
    const segs = decoded[gl];
    const lineEnd = gl + 1 < lineStarts.length ? lineStarts[gl + 1] : code.length;
    for (let s = 0; s < segs.length; s++) {
      if (segs[s][1] !== srcIdx) continue;
      const a = lineStarts[gl] + segs[s][0];
      const b = s + 1 < segs.length ? lineStarts[gl] + segs[s + 1][0] : lineEnd;
      if (b > a) { genStart.push(a); genEnd.push(b); origLine.push(segs[s][2] + 1); }
    }
  }
  const nLines = content.split('\n').length;
  const mapped = new Uint8Array(nLines + 2);
  for (const l of origLine) mapped[l] = 1;
  return { path, codeLength: code.length, content, nLines, genStart, genEnd, origLine, mapped };
}


/* ── Bitsets (line numbers are 1-based) ───────────────────────────────────── */

export const bitsetToB64 = (bits) => Buffer.from(bits).toString('base64');
export const b64ToBitset = (s) => new Uint8Array(Buffer.from(s, 'base64'));
export const hasBit = (bits, i) => (bits[i >> 3] >> (i & 7)) & 1;

/* ── Collector ────────────────────────────────────────────────────────────── */

export class CoverageCollector {
  constructor(cdp, pageUrl) {
    this.cdp = cdp;
    this.pageUrl = pageUrl;
    this.modules = new Map();   // url → module index (null = not source)
    this.fixtures = {};
  }

  async start() {
    await this.cdp.send('Profiler.enable');
    await this.cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  }

  /** Drop whatever ran since the last take (between-fixture work). */
  async discard() { await this.cdp.send('Profiler.takePreciseCoverage'); }

  /** Attribute everything since the last take to `name`. */
  async record(name, extra = {}) {
    const { result } = await this.cdp.send('Profiler.takePreciseCoverage');
    const files = {};
    for (const sc of result) {
      if (!this.modules.has(sc.url)) {
        const path = sourcePathOf(sc.url);
        this.modules.set(sc.url, path ? await loadModule(sc.url, path).catch(() => null) : null);
      }
      const mod = this.modules.get(sc.url);
      if (!mod) continue;
      /* Paint executed bytes: ranges sorted outer-before-inner, so each byte
         ends up with its innermost range's verdict (V8 block semantics). */
      const ranges = [];
      for (const fn of sc.functions) for (const r of fn.ranges) ranges.push(r);
      if (!ranges.some((r) => r.count > 0)) continue;
      ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
      const painted = new Uint8Array(mod.codeLength + 1);
      for (const r of ranges) painted.fill(r.count > 0 ? 1 : 0, r.startOffset, Math.min(r.endOffset, mod.codeLength));
      const bits = new Uint8Array((mod.nLines >> 3) + 2);
      let any = false;
      for (let i = 0; i < mod.genStart.length; i++) {
        const line = mod.origLine[i];
        if (hasBit(bits, line)) continue;
        for (let o = mod.genStart[i]; o < mod.genEnd[i]; o++) {
          if (painted[o]) { bits[line >> 3] |= 1 << (line & 7); any = true; break; }
        }
      }
      if (any) files[mod.path] = bitsetToB64(bits);
    }
    this.fixtures[name] = { ...extra, files };
  }

  toJSON() {
    const files = {};
    for (const mod of this.modules.values()) {
      if (!mod) continue;
      const mapped = new Uint8Array((mod.nLines >> 3) + 2);
      for (let l = 1; l <= mod.nLines; l++) if (mod.mapped[l]) mapped[l >> 3] |= 1 << (l & 7);
      files[mod.path] = { content: mod.content, mapped: bitsetToB64(mapped) };
    }
    let commit = null;
    try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO }).toString().trim(); } catch {}
    return { version: 1, generated: new Date().toISOString(), commit, url: this.pageUrl, files, fixtures: this.fixtures };
  }
}
