import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Live-ramp stress harness (Intonalogy repro). Consumes @hkl/engine from
// WORKSPACE SOURCE (not the built dist like react-consumer) so engine edits
// hot-reload during fix iteration — the ramp logic under test is identical in
// src and dist. publicDir serves the staged Intonalogy bundles directly, so
// the harness plays the exact .hki files that consumer ships.
export default defineConfig({
  publicDir: path.resolve(__dirname, '../../handoff/intonalogy'),
  server: { port: 5197, strictPort: false },
});
