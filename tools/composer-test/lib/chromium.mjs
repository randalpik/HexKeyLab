// Launches headless Chromium with remote debugging and returns the
// debug-port endpoint. Caller is responsible for cleanup via stop().

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function launchChromium({ windowSize = '1600,1200' } = {}) {
  const port = 9222 + Math.floor(Math.random() * 1000);
  const profileDir = mkdtempSync(join(tmpdir(), 'hkl-composer-test-'));

  const proc = spawn('chromium', [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${windowSize}`,
    'about:blank',
  ], { stdio: 'pipe' });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/json/version`);
      if (r.ok) {
        return { port, profileDir, proc, stop: () => stop(proc, profileDir) };
      }
    } catch {}
    await new Promise((res) => setTimeout(res, 80));
  }
  stop(proc, profileDir);
  throw new Error('Chromium debug endpoint never came up');
}

export async function newTabWsUrl(port) {
  const r = await fetch(`http://localhost:${port}/json/new?about:blank`, {
    method: 'PUT',
  });
  return (await r.json()).webSocketDebuggerUrl;
}

function stop(proc, profileDir) {
  try { proc.kill('SIGTERM'); } catch {}
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
