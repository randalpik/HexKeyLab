// Headless driver for the in-flight crossfade-cut repro
// (handoff/hkle-inflight-crossfade-cut.md). Spawns its OWN vite dev server on
// a fresh random port (never touches an already-running one) plus a headless
// Chromium, runs the __repro scenarios in a real-time 44.1kHz AudioContext,
// pulls each capture, writes out/<name>.wav + .events.json, and runs the
// step/kink detector + event-log correlator over every capture.
//
// The detector itself is gated first: synthetic cuts injected into the clean
// capture must be caught 100% (depth ≥ 0.2) with zero false positives before
// any other verdict is trusted.
//
// usage: node test/ramp-stress/run.mjs [scenario ...] [--gate]
//   scenarios default to the full set; --gate exits non-zero on any in-window
//   correlated defect (the post-fix regression mode). Without --gate the run
//   is a report: it exits non-zero only on harness/validation errors.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium, newTabWsUrl } from '../composer-test/lib/chromium.mjs';
import { openPage } from '../composer-test/lib/cdp.mjs';
import {
  writeWavFloat32, detectDefects, validateDetector, correlate, seamDipStats, MIN_VALIDATED_DEPTH,
} from './detect.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });

// name → { run-args, expected wall seconds, expectation label }
const SCENARIOS = {
  clean: { scenario: 'clean', opts: { holdSec: 10 }, secs: 13, expect: 'zero (validation baseline)' },
  'r1-control': { scenario: 'r1-control', opts: { reps: 4 }, secs: 30, expect: 'zero (note-offs clear of switch windows)' },
  r1: { scenario: 'r1', opts: { reps: 4 }, secs: 30, expect: 'defect per cut, in-window, mag grows with fade offset' },
  r2: { scenario: 'r2', opts: { durationSec: 60 }, secs: 63, expect: 'defects cluster at seam switchTimes (race — statistical)' },
  'r2-sharpened': { scenario: 'r2-sharpened', opts: { seams: 40 }, secs: 60, expect: 'race hits at hammered boundaries' },
  'r2-snipe': { scenario: 'r2-snipe', opts: { attempts: 60 }, secs: 90, expect: 'single phase-aligned call per seam — the maximal Cause-2 race odds' },
  'cadence-pair40': { scenario: 'cadence', opts: { mode: 'pair40' }, secs: 43, expect: 'count for Intonalogy 40ms cadence' },
  'cadence-p100': { scenario: 'cadence', opts: { mode: 'p100' }, secs: 43, expect: 'count for 100ms cadence' },
  'cadence-single': { scenario: 'cadence', opts: { mode: 'single' }, secs: 43, expect: 'count for one-ramp-per-gesture (continuous-API proxy)' },
  melody: { scenario: 'melody', opts: { passes: 8 }, secs: 36, expect: 'every defect coincides with an in-window note-off' },
};

const args = process.argv.slice(2);
const gateMode = args.includes('--gate');
const picked = args.filter((a) => !a.startsWith('--'));
for (const p of picked) {
  if (!SCENARIOS[p]) { console.error(`unknown scenario '${p}' (have: ${Object.keys(SCENARIOS).join(', ')})`); process.exit(2); }
}
// 'clean' always runs first — the detector validation gate depends on it.
const names = picked.length ? [...new Set(['clean', ...picked])] : Object.keys(SCENARIOS);

// ── infra ─────────────────────────────────────────────────────────────────
const PORT = 5600 + Math.floor(Math.random() * 100);
let vite = null, chrome = null;
const cleanup = (code) => {
  try { chrome?.stop(); } catch {}
  try { vite?.kill('SIGTERM'); } catch {}
  process.exit(code);
};
process.on('SIGINT', () => cleanup(130));
process.on('SIGTERM', () => cleanup(143));

async function waitHttp(url, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`${url} never came up`);
}

function withTimeout(promise, secs, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${secs}s`)), secs * 1000)),
  ]);
}

async function pullPcm(cdp, length) {
  const CHUNK = 1_000_000; // float32 samples per eval (~5.3MB base64)
  const buf = Buffer.alloc(length * 4);
  for (let off = 0; off < length; off += CHUNK) {
    const b64 = await cdp.evalJSON(`window.__repro.pcmChunk(${off}, ${CHUNK})`);
    if (typeof b64 !== 'string') throw new Error(`pcmChunk failed: ${JSON.stringify(b64)}`);
    Buffer.from(b64, 'base64').copy(buf, off * 4);
  }
  return new Float32Array(buf.buffer, buf.byteOffset, length);
}

// ── main ──────────────────────────────────────────────────────────────────
try {
  console.log(`serving ramp-stress on :${PORT} …`);
  vite = spawn('pnpm', ['--filter', '@hkl/ramp-stress', 'exec', 'vite', '--port', String(PORT), '--strictPort'],
    { cwd: repoRoot, stdio: 'pipe' });
  await waitHttp(`http://localhost:${PORT}/`, 20_000);

  /* --mute-audio: silence the OUTPUT mixer only — the render graph (and the
     worklet capture tap, which sits pre-output on the engine master) keeps
     running in real time, so the machine stays quiet during runs. The smoke
     step's peak assertion guards the assumption: if muting ever stalled
     rendering, the run fails there instead of producing silent captures. */
  chrome = await launchChromium({ extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const cdp = await openPage(await newTabWsUrl(chrome.port), `http://localhost:${PORT}/`, { waitMs: 800 });
  cdp.on('Runtime.exceptionThrown', (p) => console.error('page exception:', p.exceptionDetails?.text,
    p.exceptionDetails?.exception?.description ?? ''));

  const smoke = await withTimeout(cdp.evalJSON('window.__repro.smoke()'), 30, 'smoke');
  if (!smoke || smoke.__error || !smoke.ok) {
    console.error('✗ smoke failed — real-time capture path is not working:', JSON.stringify(smoke));
    cleanup(1);
  }
  console.log(`✓ smoke: ctx @ ${smoke.sampleRate}Hz, peak ${smoke.peak.toFixed(3)}, ${smoke.captured} samples captured`);

  let validated = false;
  let gateFailures = 0;
  const summary = [];

  for (const name of names) {
    const cfg = SCENARIOS[name];
    console.log(`\n── ${name} — ~${cfg.secs}s real-time (expect: ${cfg.expect})`);
    const res = await withTimeout(
      cdp.evalJSON(`window.__repro.run(${JSON.stringify(cfg.scenario)}, ${JSON.stringify(cfg.opts)})`),
      cfg.secs * 2 + 60, name,
    );
    if (!res || res.__error) { console.error(`✗ ${name} failed: ${res && res.__error}`); cleanup(1); }

    const pcm = await pullPcm(cdp, res.length);
    writeFileSync(join(outDir, `${name}.wav`), writeWavFloat32(pcm, res.sampleRate));
    writeFileSync(join(outDir, `${name}.events.json`), JSON.stringify(
      { scenario: name, info: res.info, startFrame: res.startFrame, sampleRate: res.sampleRate, events: res.events }, null, 1));

    if (name === 'clean') {
      const v = validateDetector(pcm, res.sampleRate);
      for (const r of v.perDepth) {
        console.log(`  inject depth ${r.depth}: ${r.hits}/${r.of} detected${r.depth >= MIN_VALIDATED_DEPTH ? '' : ' (informational)'}`);
      }
      console.log(`  false positives on clean capture: ${v.falsePositives}`);
      if (!v.ok) {
        console.error('✗ DETECTOR VALIDATION FAILED — no other verdict below is trustworthy. Aborting.');
        cleanup(1);
      }
      validated = true;
      console.log('✓ detector validated (100% at depth ≥ 0.2, zero false positives)');
    }

    const defects = detectDefects(pcm, res.sampleRate);
    const corr = correlate(defects, res.events, res.startFrame, res.sampleRate);
    const dips = seamDipStats(pcm, res.events, res.startFrame, res.sampleRate);
    if (dips.n) {
      console.log(`  seam dips (${dips.n} wrap seams, ${dips.deferred} deferred): ` +
        `min ${dips.min.toFixed(3)} p10 ${dips.p10.toFixed(3)} median ${dips.median.toFixed(3)}` +
        ` — clean floor ≈ 0.807; deferred must be 0 and min ≈ clean post-fix`);
    } else if (dips.deferred) {
      console.log(`  ${dips.deferred} deferred seam(s) (no measurable dips — release tails)`);
    }
    console.log(`  ${(pcm.length / res.sampleRate).toFixed(1)}s captured → ${corr.nDefects} defect(s): ` +
      `${corr.nCorrelatedInWindow} in-window / ${corr.nCorrelatedOutOfWindow} out-of-window / ${corr.nUncorrelated} uncorrelated` +
      (corr.nOnsets ? ` (+${corr.nOnsets} onset kinks, expected)` : ''));
    const interesting = corr.rows.filter((r) => !r.onset);
    for (const r of interesting.slice(0, 12)) {
      const m = r.match
        ? `${r.match.call}@${(r.match.offsetIntoFade * 100).toFixed(0)}% of fade, dt=${(r.match.dt * 1000).toFixed(2)}ms${r.match.inWindow ? '' : ' (OUT-OF-WINDOW)'}`
        : 'UNCORRELATED';
      console.log(`    t=${r.t.toFixed(3)}s mag=${r.mag.toFixed(4)} ratio=${r.ratio.toFixed(1)} → ${m}`);
    }
    if (interesting.length > 12) console.log(`    … ${interesting.length - 12} more (see out/${name}.events.json + detect.mjs CLI)`);

    // R1 per-cut hit accounting — the report's amplitude-vs-offset signature.
    if (name === 'r1') {
      const hits = res.info.cuts.map((c) => {
        const row = corr.rows.find((r) => r.match && r.match.key === c.key);
        return { off: c.actualOffset, mag: row ? row.mag : null };
      });
      const hit = hits.filter((h) => h.mag != null).length;
      console.log(`  R1 cuts detected: ${hit}/${hits.length}`);
      for (const h of hits) {
        console.log(`    offset ${(h.off * 100).toFixed(0)}% → ${h.mag != null ? 'mag ' + h.mag.toFixed(4) : 'no defect detected'}`);
      }
    }

    summary.push({ name, ...corr, expect: cfg.expect });
    if (gateMode && corr.nCorrelatedInWindow > 0) gateFailures++;
  }

  console.log('\n══ summary ══');
  for (const s of summary) {
    console.log(`${s.nCorrelatedInWindow > 0 ? '✗' : '·'} ${s.name}: ${s.nDefects} defects ` +
      `(${s.nCorrelatedInWindow} in-window, ${s.nUncorrelated} uncorrelated) — expect: ${s.expect}`);
  }
  if (!validated) console.log('note: clean/validation stage was not in this scenario selection');
  console.log(`artifacts: test/ramp-stress/out/*.wav + *.events.json`);
  cleanup(gateMode && gateFailures > 0 ? 1 : 0);
} catch (e) {
  console.error('runner failed:', e?.stack ?? e);
  cleanup(1);
}
