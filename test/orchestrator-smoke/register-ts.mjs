// TS loader for Node smoke tests. Node's built-in type-stripping runs the TS
// files, but does NOT rewrite the codebase's `./foo.js` import specifiers (which
// map to `./foo.ts` on disk, per the Vite/tsconfig convention). This resolve hook
// rewrites a relative `.js` specifier to its `.ts` sibling when the `.js` doesn't
// exist — so a test can `import ... from '../../apps/.../foo.ts'` and that module
// can in turn `import { x } from './bar.js'`.
//
//   node --import ./test/orchestrator-smoke/register-ts.mjs test/orchestrator-smoke/<test>.mjs

import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
  import { existsSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
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
    return next(spec, ctx);
  }
`), import.meta.url);
