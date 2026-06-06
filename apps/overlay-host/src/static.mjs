// Minimal, dependency-free static file server for the embedded overlay build.
// Path-traversal-safe; serves the lean `dist-overlay` assets with correct
// content-types. Any path with no file extension (e.g. `/`, `/?overlay`) falls
// back to index.html — there's only the one SPA entry.

import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

/** Returns an async (req, res) handler serving files under `root`. */
export function staticHandler(root) {
  const rootResolved = path.resolve(root);
  return async function serve(req, res) {
    try {
      /* Strip query/hash, decode, normalize. A bare path or extensionless path
         (the `?overlay` SPA route) serves index.html. */
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
      if (urlPath === '/' || !path.extname(urlPath)) urlPath = '/index.html';

      const filePath = path.join(rootResolved, path.normalize(urlPath));
      /* Traversal guard: the resolved path must stay under root. */
      if (filePath !== rootResolved && !filePath.startsWith(rootResolved + path.sep)) {
        res.writeHead(403); res.end('forbidden'); return;
      }

      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat || !stat.isFile()) { res.writeHead(404); res.end('not found'); return; }

      const ext = path.extname(filePath).toLowerCase();
      const type = TYPES[ext] || 'application/octet-stream';
      /* Content-hashed assets are immutable; index.html must not be cached so a
         rebuilt overlay is picked up on reload. */
      const cache = ext === '.html'
        ? 'no-cache'
        : (filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');

      res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'cache-control': cache });
      createReadStream(filePath).pipe(res);
    } catch (e) {
      res.writeHead(500); res.end('server error');
    }
  };
}
