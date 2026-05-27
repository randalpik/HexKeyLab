// Shared dev-server middleware for the HKL dev proxy (vite/dev-proxy.mjs).
// Plain .mjs so Node runs it directly — these are origin-level dev endpoints
// mounted on the proxy, not on the per-app vite servers. Express-style
// (req, res, next): each returns true-by-handling or calls next() to pass.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/* /iowa-mis and /iowa-mis-legacy: dev-only CORS + format-conversion bridge for
   Iowa MIS audio. (1) theremin.music.uiowa.edu sends no CORS headers, so
   browser fetch() fails cross-origin. (2) Iowa ships AIFF only and Firefox's
   decodeAudioData can't decode AIFF. The middleware pulls the AIFF server-side,
   transcodes to mono PCM-f32 WAV via ffmpeg, caches it at cacheDir/, and
   returns Content-Type: audio/wav (URL keeps .aif — Web Audio reads the MIME).
   NOT a production path; deploy pre-clips into public/samples/. */
export function iowaMisTranscodeMiddleware(prefix, remoteBase, cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });
  return async (req, res, next) => {
    if (!req.url || !req.url.startsWith(prefix + '/')) return next();
    const rel = req.url.slice(prefix.length); // includes leading slash
    const isAif = /\.aiff?$/i.test(rel);
    if (!isAif) {
      const upstream = remoteBase + rel;
      try {
        const r = await fetch(upstream);
        if (!r.ok) { res.statusCode = r.status; return res.end(); }
        const ab = await r.arrayBuffer();
        res.setHeader('content-type', r.headers.get('content-type') || 'application/octet-stream');
        return res.end(Buffer.from(ab));
      } catch (e) {
        res.statusCode = 502; return res.end(String(e));
      }
    }
    /* Cache key tags `.mono.f32.` so it invalidates when the format changes. */
    const cacheKey = rel.replace(/[\/\\:]/g, '_').replace(/\.aiff?$/i, '.mono.f32.wav');
    const cachePath = path.join(cacheDir, cacheKey);
    if (!fs.existsSync(cachePath) || fs.statSync(cachePath).size === 0) {
      const upstream = remoteBase + rel;
      console.log(`[iowa-mis] transcoding ${rel}`);
      let aifBytes;
      try {
        const r = await fetch(upstream);
        if (!r.ok) { res.statusCode = r.status; return res.end(`upstream ${r.status} for ${upstream}`); }
        aifBytes = await r.arrayBuffer();
      } catch (e) {
        res.statusCode = 502; return res.end(String(e));
      }
      const tmpIn = path.join(cacheDir, `_in_${process.pid}_${Date.now()}.aif`);
      fs.writeFileSync(tmpIn, Buffer.from(aifBytes));
      /* `-ac 1` mono (ffmpeg sqrt(0.5)/channel — matches the headless f32le
         path) + pcm_f32le for 32-bit float precision (Iowa AIFFs are 24-bit).
         Eliminates browser/Node analyzer divergence. */
      const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmpIn, '-ac', '1', '-c:a', 'pcm_f32le', cachePath]);
      try { fs.unlinkSync(tmpIn); } catch {}
      if (ff.status !== 0) {
        res.statusCode = 500;
        return res.end(`ffmpeg failed: ${ff.stderr?.toString() || 'unknown'}`);
      }
    }
    res.setHeader('content-type', 'audio/wav');
    /* no-cache (NOT no-store): browser may keep the body but must revalidate —
       avoids the "changed the middleware, still serving stale AIFF" trap. */
    res.setHeader('cache-control', 'no-cache');
    res.end(fs.readFileSync(cachePath));
  };
}

/* /analyzer-configs-manifest: dev-only endpoint returning every JSON file in
   configsDir as one map keyed by filename (sans .json). The analyzer page
   renders its per-instrument checkbox list from this. configs/ is the single
   source of truth — no in-browser editing. */
export function analyzerConfigsManifest(configsDir) {
  return (req, res, next) => {
    if (!req.url || req.url.split('?')[0] !== '/analyzer-configs-manifest') return next();
    try {
      const files = fs.readdirSync(configsDir).filter((f) => f.endsWith('.json')).sort();
      const out = {};
      for (const f of files) {
        const key = f.replace(/\.json$/, '');
        out[key] = JSON.parse(fs.readFileSync(path.join(configsDir, f), 'utf8'));
      }
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-cache');
      res.end(JSON.stringify(out));
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  };
}
