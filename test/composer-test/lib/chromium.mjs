// Launches headless Chromium with remote debugging and returns the
// debug-port endpoint. Caller is responsible for cleanup via stop(); a SIGINT,
// SIGTERM or SIGHUP while it runs stops it too.

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function launchChromium({ windowSize = '1600,1200', extraArgs = [] } = {}) {
  const port = 9222 + Math.floor(Math.random() * 1000);
  const profileDir = mkdtempSync(join(tmpdir(), 'hkl-composer-test-'));

  const proc = spawn('chromium', [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    /* never let a gate reach the machine's audio output: this mutes the output
       device only, the page's audio graph still runs (AGENTS.local.md) */
    '--mute-audio',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${windowSize}`,
    ...extraArgs,
    'about:blank',
  ], { stdio: 'pipe' });

  const signals = [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]
    .map(([sig, n]) => [sig, () => { stop(); process.exit(128 + n); }]);
  for (const [sig, h] of signals) process.once(sig, h);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const [sig, h] of signals) process.off(sig, h);
    stopBrowser(proc, profileDir);
  };

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/json/version`);
      if (r.ok) {
        return { port, profileDir, proc, stop };
      }
    } catch {}
    await new Promise((res) => setTimeout(res, 80));
  }
  stop();
  throw new Error('Chromium debug endpoint never came up');
}

export async function newTabWsUrl(port) {
  const r = await fetch(`http://localhost:${port}/json/new?about:blank`, {
    method: 'PUT',
  });
  return (await r.json()).webSocketDebuggerUrl;
}

/** Pids of the processes running on `profileDir`: those naming it on their
 *  command line, as `--user-data-dir=<dir>` (every Chromium process — browser,
 *  zygotes, GPU, network and storage services, renderers) or `--profile <dir>`
 *  (Firefox). Chromium rewrites its process title, so its /proc cmdline is one
 *  space-joined string, not NUL-separated argv: match the path as a token. */
function profileHolders(profileDir) {
  const pids = [];
  for (const p of readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue;
    let cmd;
    try { cmd = readFileSync(`/proc/${p}/cmdline`, 'utf8'); } catch { continue; }
    if (cmd.split(/[\0 =]/).includes(profileDir)) pids.push(Number(p));
  }
  return pids;
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Stops the browser `proc` (null if the caller already signaled it, or never
 *  launched it) and removes its profile. A browser writes profile files while
 *  it shuts down (Chromium's Local State, Default/), from the main process and
 *  from helpers that outlive it by tens of ms, so the profile is removed only
 *  once no process runs on it; one still running 10 s after SIGTERM is
 *  SIGKILLed, and one that outlives that by 5 s is reported, not waited on.
 *  Synchronous, so a cleanup that ends in process.exit can call it as is.
 *  /tmp is tmpfs here, so a leaked profile (≈300 MB once a page has run) is
 *  RAM. */
export function stopBrowser(proc, profileDir) {
  try { proc?.kill('SIGTERM'); } catch {}
  const killAt = Date.now() + 10_000;
  for (let pids; (pids = profileHolders(profileDir)).length; pause(20)) {
    if (Date.now() > killAt + 5_000) { console.error(`stopBrowser: pids ${pids.join(' ')} survive SIGKILL; profile left at ${profileDir}`); return; }
    if (Date.now() > killAt) for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
  rmSync(profileDir, { recursive: true, force: true });
}
