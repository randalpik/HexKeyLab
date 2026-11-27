// TS loader for Node smoke tests. Node's built-in type-stripping runs the TS
// files, but does NOT rewrite the codebase's `./foo.js` import specifiers (which
// map to `./foo.ts` on disk, per the Vite/tsconfig convention). This resolve hook
// rewrites a relative `.js` specifier to its `.ts` sibling when the `.js` doesn't
// exist — so a test can `import ... from '../../apps/.../foo.ts'` and that module
// can in turn `import { x } from './bar.js'`.
//
// A package specifier gets the same treatment when it fails: `@hkl/analysis/normalize.js`
// maps to `src/normalize.js`, which exists only as `normalize.ts`. The `.ts` sibling is
// returned by its real path, since Node will not strip types under `node_modules`.
//
//   node --import ./test/orchestrator-smoke/register-ts.mjs test/orchestrator-smoke/<test>.mjs

import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
  import { existsSync, realpathSync } from 'node:fs';
  import { fileURLToPath, pathToFileURL } from 'node:url';
  export async function resolve(spec, ctx, next) {
    if ((spec.startsWith('./') || spec.startsWith('../')) && spec.endsWith('.js')) {
      try {
        const asIs = new URL(spec, ctx.parentURL);
        if (!existsSync(fileURLToPath(asIs))) {
          const tsSpec = spec.slice(0, -3) + '.ts';
          if (existsSync(fileURLToPath(new URL(tsSpec, ctx.parentURL)))) {
            return next(tsSpec, ctx);
          }
        }
      } catch { /* fall through to default resolution */ }
    }
    try {
      return await next(spec, ctx);
    } catch (e) {
      const m = e && e.code === 'ERR_MODULE_NOT_FOUND' && /Cannot find module '([^']+)\\.js'/.exec(e.message);
      if (m && existsSync(m[1] + '.ts')) return { url: pathToFileURL(realpathSync(m[1] + '.ts')).href, shortCircuit: true };
      throw e;
    }
  }
`), import.meta.url);
