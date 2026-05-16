import { defineConfig } from 'vite';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IOWA_CACHE = path.join(__dirname, '.iowa-cache');

/* /iowa-mis and /iowa-mis-legacy: dev-only CORS + format-conversion bridge for
   Iowa MIS audio. Two problems compose here:
     (1) theremin.music.uiowa.edu sends no Access-Control-Allow-* headers,
         so browser fetch() fails cross-origin.
     (2) Iowa ships AIFF only, and Firefox's Web Audio decodeAudioData does
         not decode AIFF (Chromium does — that's why curl-based testing
         passes silently).
   Middleware below pulls the AIFF server-side, transcodes it to PCM WAV via
   ffmpeg, caches the WAV at .iowa-cache/, and returns it with
   Content-Type: audio/wav. URL extension stays .aif so the analyzer's
   filePatterns can keep their literal Iowa filenames — Web Audio reads the
   Content-Type header, not the path. NOT a production solution; for deploy,
   pre-clip + transcode into public/samples/ (see analyzer/clip-and-bundle.js). */
function iowaMisTranscodeMiddleware(prefix: string, remoteBase: string) {
  fs.mkdirSync(IOWA_CACHE, { recursive: true });
  return async (req: any, res: any, next: any) => {
    if (!req.url || !req.url.startsWith(prefix + '/')) return next();
    const rel = req.url.slice(prefix.length); // includes leading slash
    const isAif = /\.aiff?$/i.test(rel);
    if (!isAif) {
      // Pass through non-AIFF (shouldn't happen for Iowa, but be safe).
      const upstream = remoteBase + rel;
      try {
        const r = await fetch(upstream);
        if (!r.ok) { res.statusCode = r.status; return res.end(); }
        const ab = await r.arrayBuffer();
        res.setHeader('content-type', r.headers.get('content-type') || 'application/octet-stream');
        return res.end(Buffer.from(ab));
      } catch (e: any) {
        res.statusCode = 502; return res.end(String(e));
      }
    }
    /* Cache key includes `.mono.f32.` so the cache invalidates when we
       change format. Older `.wav` (stereo 16-bit) caches sit unused; nothing
       references them. */
    const cacheKey = rel.replace(/[\/\\:]/g, '_').replace(/\.aiff?$/i, '.mono.f32.wav');
    const cachePath = path.join(IOWA_CACHE, cacheKey);
    if (!fs.existsSync(cachePath) || fs.statSync(cachePath).size === 0) {
      const upstream = remoteBase + rel;
      console.log(`[iowa-mis] transcoding ${rel}`);
      let aifBytes: ArrayBuffer;
      try {
        const r = await fetch(upstream);
        if (!r.ok) { res.statusCode = r.status; return res.end(`upstream ${r.status} for ${upstream}`); }
        aifBytes = await r.arrayBuffer();
      } catch (e: any) {
        res.statusCode = 502; return res.end(String(e));
      }
      const tmpIn = path.join(IOWA_CACHE, `_in_${process.pid}_${Date.now()}.aif`);
      fs.writeFileSync(tmpIn, Buffer.from(aifBytes));
      /* `-ac 1` mono downmix at the server (ffmpeg uses sqrt(0.5) per
         channel — same as the headless `-ac 1 -f f32le` path) and
         `pcm_f32le` for IEEE 32-bit float precision (Iowa AIFFs are
         24-bit). Both choices eliminate the prior divergence between the
         in-browser analyzer and the Node-side runner, which were getting
         (a) different mono coefficients (browser's client-side `(L+R)/2`
         vs ffmpeg's `0.7071·(L+R)`) and (b) different precision
         (16-bit-quantized WAV vs 32-bit float raw). The runtime engine
         consumes whatever the analyzer emits and doesn't care. */
      const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmpIn, '-ac', '1', '-c:a', 'pcm_f32le', cachePath]);
      try { fs.unlinkSync(tmpIn); } catch {}
      if (ff.status !== 0) {
        res.statusCode = 500;
        return res.end(`ffmpeg failed: ${ff.stderr?.toString() || 'unknown'}`);
      }
    }
    res.setHeader('content-type', 'audio/wav');
    /* no-cache (NOT no-store): browser may keep the body but must revalidate
       with the dev server before reusing. Cheap because the dev server is
       local and the WAV is on disk — full GET completes in <10 ms — and it
       prevents the "I changed the middleware and Firefox is still serving
       the old AIFF" trap. immutable + max-age was the wrong choice for a
       same-URL endpoint whose body can change as the middleware evolves. */
    res.setHeader('cache-control', 'no-cache');
    res.end(fs.readFileSync(cachePath));
  };
}

/* /analyzer-configs-manifest: dev-only endpoint that returns every JSON file
   in analyzer/configs/ as a single map keyed by filename (sans .json). The
   analyzer page uses this to render its per-instrument checkbox list. The
   configs/ files are the single source of truth — no in-browser editing. */
const CONFIGS_DIR = path.join(__dirname, 'analyzer/configs');
function analyzerConfigsManifest(req: any, res: any, next: any) {
  if (!req.url || req.url.split('?')[0] !== '/analyzer-configs-manifest') return next();
  try {
    const files = fs.readdirSync(CONFIGS_DIR).filter((f) => f.endsWith('.json')).sort();
    const out: Record<string, unknown> = {};
    for (const f of files) {
      const key = f.replace(/\.json$/, '');
      out[key] = JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, f), 'utf8'));
    }
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-cache');
    res.end(JSON.stringify(out));
  } catch (e: any) {
    res.statusCode = 500;
    res.end(String(e));
  }
}

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: {
        main:     path.resolve(__dirname, 'index.html'),
        composer: path.resolve(__dirname, 'composer.html'),
      },
    },
  },
  plugins: [
    {
      name: 'iowa-mis-bridge',
      configureServer(server) {
        // Post-2012 / MIS Pitches - 2014 (per-note chromatic AIFFs).
        server.middlewares.use(iowaMisTranscodeMiddleware(
          '/iowa-mis',
          'https://theremin.music.uiowa.edu/sound%20files/MIS%20Pitches%20-%202014',
        ));
        // Pre-2012 legacy (used by the Iowa Piano set, which lives outside
        // the 2014 tree at /sound files/MIS/Piano_Other/piano/).
        server.middlewares.use(iowaMisTranscodeMiddleware(
          '/iowa-mis-legacy',
          'https://theremin.music.uiowa.edu/sound%20files/MIS',
        ));
      },
    },
    {
      name: 'analyzer-configs-manifest',
      configureServer(server) {
        server.middlewares.use(analyzerConfigsManifest);
      },
    },
  ],
});
