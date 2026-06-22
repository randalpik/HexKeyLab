import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Minimal browser-React consumer of the *built* @hexkeylab/engine artifact
// (resolved via `file:../../packages/engine/dist` — the real published output,
// not the workspace raw-.ts). Proves the package installs + runs in an
// unrelated React app against a real Web Audio AudioContext.
export default defineConfig({
  plugins: [react()],
});
