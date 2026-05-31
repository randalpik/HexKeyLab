// HKL Orchestrator — entry point.
//
// Drives a physical MIDI instrument (Web MIDI out) and captures its audio
// output (getUserMedia) across notes and velocities, then builds a velocity-
// layered .hki v2 bundle (decay instruments) for import into HKL. Five-step
// wizard: Connect → Discover → Configure → Capture → Export.
//
// This is the Phase 2 scaffold: bridge + wizard chrome wired; the per-step
// modules (device I/O, discovery, capture, analysis/export) land in later
// phases under src/{device,discovery,capture,analysis,ui}/.

import { initBridge } from './bridge.js';
import { renderConnect } from './ui/stepConnect.js';
import { renderDiscover } from './ui/stepDiscover.js';
import { renderConfigure } from './ui/stepConfigure.js';
import { renderCapture } from './ui/stepCapture.js';
import { getSession, setDevice, updateConfig, setBins, onSessionChange } from './state.js';
import { loadPersisted, patchPersisted } from './persist.js';
import { LoopbackDevice } from './device/loopback.js';
import { record } from './device/recorder.js';
import { runSweep } from './discovery/sweep.js';
import { detectBins } from './discovery/bins.js';
import { renderExport } from './ui/stepExport.js';
import { enumerateJobs } from './capture/plan.js';
import { runCaptureLoop } from './capture/loop.js';
import { runGates } from './capture/gates.js';
import { putOutcome } from './capture/store.js';
import { buildBundle } from './analysis/buildHki.js';
import { denoiseChannels } from './analysis/denoise.js';
import { writeHki, readHki } from '@hkl/shared/hki.js';

export type StepId = 'connect' | 'discover' | 'configure' | 'capture' | 'export';

const STEPS: Array<{ id: StepId; label: string }> = [
  { id: 'connect', label: '1 · Connect' },
  { id: 'discover', label: '2 · Discover' },
  { id: 'configure', label: '3 · Configure' },
  { id: 'capture', label: '4 · Capture' },
  { id: 'export', label: '5 · Export' },
];

let current: StepId = 'connect';
const done = new Set<StepId>();

function setStatus(text: string, kind?: 'err' | 'ok'): void {
  const el = document.getElementById('statusText');
  if (!el) return;
  el.textContent = text;
  el.className = 'statusbar' + (kind ? ' ' + kind : '');
}

function renderBreadcrumb(): void {
  const nav = document.getElementById('steps');
  if (!nav) return;
  nav.innerHTML = '';
  for (const s of STEPS) {
    const span = document.createElement('span');
    span.className = 'crumb'
      + (s.id === current ? ' active' : '')
      + (done.has(s.id) ? ' done' : '');
    span.textContent = s.label;
    span.addEventListener('click', () => showStep(s.id));
    nav.appendChild(span);
  }
}

function renderPlaceholder(host: HTMLElement): void {
  const panel = document.createElement('div');
  panel.className = 'step-panel active';
  const title = STEPS.find(s => s.id === current)?.label ?? current;
  panel.innerHTML = `<h2>${title}</h2>`
    + `<p class="muted">This step is not implemented yet — it lands in a subsequent phase.</p>`;
  host.appendChild(panel);
}

function renderStep(): void {
  const host = document.getElementById('wizard');
  if (!host) return;
  host.innerHTML = '';
  if (current === 'connect') {
    void renderConnect(host, () => { done.add('connect'); renderBreadcrumb(); });
    return;
  }
  if (current === 'discover') {
    renderDiscover(host, () => { done.add('discover'); renderBreadcrumb(); showStep('configure'); });
    return;
  }
  if (current === 'configure') {
    renderConfigure(host, () => { done.add('configure'); renderBreadcrumb(); showStep('capture'); });
    return;
  }
  if (current === 'capture') {
    renderCapture(host, () => { done.add('capture'); renderBreadcrumb(); showStep('export'); });
    return;
  }
  if (current === 'export') {
    renderExport(host);
    done.add('export'); renderBreadcrumb();
    return;
  }
  renderPlaceholder(host);
}

export function showStep(id: StepId): void {
  current = id;
  renderBreadcrumb();
  renderStep();
}

/** DevTools / headless-test handle. Mirrors HKL's window.__hkl_composer pattern:
 *  exposes session state, step nav, and a self-contained loopback capture so the
 *  device→capture path can be exercised from the console or a headless harness
 *  (e.g. `await window.__hklo.loopbackCaptureTest()`). */
function installTestHook(): void {
  (window as unknown as { __hklo: unknown }).__hklo = {
    getSession,
    showStep,
    updateConfig,
    setBins,
    /** Spin up a loopback device, capture one note, return summary stats. */
    async loopbackCaptureTest(note = 60, velocity = 100): Promise<{ frames: number; sampleRate: number; peak: number; rms: number }> {
      const dev = await LoopbackDevice.create();
      setDevice(dev, 'Synthetic (loopback)');
      const rec = await record(dev, { note, velocity, holdMs: 150, maxSec: 4 });
      const ch0 = rec.channels[0] ?? new Float32Array(0);
      let peak = 0, sumSq = 0;
      for (let i = 0; i < ch0.length; i++) { const a = Math.abs(ch0[i]); if (a > peak) peak = a; sumSq += ch0[i] * ch0[i]; }
      const rms = ch0.length ? Math.sqrt(sumSq / ch0.length) : 0;
      dev.teardown();
      setDevice(null, '');
      return { frames: ch0.length, sampleRate: rec.sampleRate, peak, rms };
    },
    /** Run a velocity sweep on the loopback and detect bins. With jump=true the
     *  loopback brightens above vel 64, so a boundary near 64 should be found;
     *  jump=false produces no discrete layers (even-bin fallback). */
    async discoverTest(jump = true, stride = 16, probeSec = 0.35): Promise<{ detected: boolean; boundaries: number[]; bins: number[]; n: number }> {
      const dev = await LoopbackDevice.create();
      dev.brightnessJump = jump;
      const fps = await runSweep(dev, { probeNote: 60, stride, probeSec, gapMs: 700 });
      dev.teardown();
      const r = detectBins(fps);
      return { detected: r.detected, boundaries: r.boundaries, bins: r.bins.map(b => b.sampleVel), n: fps.length };
    },
    /** Run a tiny capture loop on the loopback (2 notes × 1 layer) and return
     *  the per-job gate outcomes — plumbing check for the capture path. */
    async captureLoopTest(): Promise<Array<{ id: string; pass: boolean; flags: string[]; peakDb: number; durSec: number }>> {
      const dev = await LoopbackDevice.create();
      const config = { instrumentKey: 'lb', displayName: 'LB', lowMidi: 60, highMidi: 67, semitoneStride: 7, probeNote: 60, holdMs: 150 };
      const bins = [{ lo: 60, hi: 100, sampleVel: 90 }];
      const jobs = enumerateJobs(config, bins);
      const outcomes = await runCaptureLoop(dev, jobs, { holdMs: 150, gapMs: 200 });
      dev.teardown();
      return outcomes.map(o => ({ id: o.job.captureId, pass: o.gate.pass, flags: o.gate.flags, peakDb: o.gate.peakDb, durSec: o.gate.durSec }));
    },
    /** Deterministic quality-gate check on synthesized PCM (no audio device).
     *  Signals include a pre-roll noise floor so the noise-relative gates are
     *  exercised: padded-but-clean → pass, low-SNR → quiet, fast-decay → pass,
     *  miss → quiet+short, clip, octave → pitch. */
    gatesTest(): Record<string, { pass: boolean; flags: string[]; snrDb: number; durSec: number }> {
      const SR = 48000, F = 261.63;
      // peakDb tone (one or more partials) + constant noise floor, with `preMs`
      // of pre-attack noise. partials = [[harmonic-multiple, relative-amp], …].
      const build = (peakDb: number, freq: number, tau: number, sec: number, noiseDb: number, clip = false, partials: Array<[number, number]> = [[1, 1]], preMs = 150) => {
        const pre = Math.round((preMs / 1000) * SR);
        const n = pre + Math.round(sec * SR);
        const ch = new Float32Array(n);
        const norm = partials.reduce((a, [, amp]) => a + Math.abs(amp), 0) || 1;
        const amp = Math.pow(10, peakDb / 20), nAmp = Math.pow(10, noiseDb / 20);
        let seed = 99991;
        const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
        for (let i = 0; i < n; i++) {
          let s = nAmp * rnd();
          if (i >= pre) {
            const t = (i - pre) / SR;
            let tone = 0;
            for (const [mult, rel] of partials) tone += (rel / norm) * Math.sin(2 * Math.PI * freq * mult * i / SR);
            s += amp * Math.exp(-t / tau) * tone;
          }
          if (clip) s = Math.max(-1, Math.min(1, s));
          ch[i] = s;
        }
        return { channels: [ch], sampleRate: SR };
      };
      const r = (rec: { channels: Float32Array[]; sampleRate: number }) => { const g = runGates(rec, F); return { pass: g.pass, flags: g.flags, snrDb: g.snrDb, durSec: g.durSec }; };
      return {
        clean: r(build(-6, F, 0.8, 1.2, -75)),                              // loud, clean → pass
        padded: r(build(-30, F, 0.8, 1.2, -75)),                            // quiet but high SNR → pass
        softOk: r(build(-50, F, 0.8, 1.2, -63)),                            // ~18 dB SNR → pass (relaxed gate; denoise cleans rest)
        lowSnr: r(build(-55, F, 0.8, 1.2, -55)),                            // ~5 dB SNR, near floor → quiet
        fastDecay: r(build(-6, F, 0.04, 0.6, -75)),                         // strong attack, fast decay → pass (not short)
        miss: r(build(-120, F, 0.8, 0.6, -55)),                             // no note, just noise → quiet+short
        clip: r(build(3, F, 0.8, 1.2, -75, true)),                          // overdriven → clip
        octave: r(build(-6, F * 2, 0.8, 1.2, -75)),                         // octave up → NOT flagged (we trust MIDI→pitch; no octave detection)
        strongHarmonic: r(build(-6, F, 0.8, 1.2, -75, false, [[1, 1], [2, 0.9]])), // strong 2nd harmonic → pass (no false pitch flag)
      };
    },
    /** Verify spectral-subtraction NR: a tone over a noise floor, with pre-roll
     *  silence as the profile. The noise/silence regions should drop a lot; the
     *  note body should be essentially unchanged. */
    denoiseTest(): { noiseDropDb: number; bodyDeltaDb: number } {
      const SR = 48000, F = 261.63;
      const preMs = 150, pre = Math.round((preMs / 1000) * SR);
      const n = pre + Math.round(1.0 * SR);
      // Tonal-dominated noise (mains hum harmonics + a high tone) + light broadband,
      // matching the real scan signature; the signal tone F is not a hum multiple.
      const amp = Math.pow(10, -12 / 20), bbAmp = Math.pow(10, -72 / 20);
      const hum: Array<[number, number]> = [[60, 0.0025], [120, 0.0015], [180, 0.001], [6000, 0.0008]];
      let seed = 777;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
      const ch = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let s = bbAmp * rnd();
        for (const [f, a] of hum) s += a * Math.sin(2 * Math.PI * f * i / SR);
        if (i >= pre) { const t = (i - pre) / SR; s += amp * Math.exp(-t / 0.6) * Math.sin(2 * Math.PI * F * i / SR); }
        ch[i] = s;
      }
      const clean = denoiseChannels([ch], SR, preMs / 1000)[0];
      const rms = (s: Float32Array, a: number, b: number) => { let sq = 0; for (let i = a; i < b; i++) sq += s[i] * s[i]; return Math.sqrt(sq / (b - a)); };
      const dB = (x: number) => (x > 0 ? 20 * Math.log10(x) : -120);
      // Measure the pre-roll INTERIOR (away from the WOLA start boundary and the
      // onset) and the note body interior.
      const FFT = 2048;
      const noiseA = FFT, noiseB = pre - FFT;
      const bodyA = pre + FFT, bodyB = pre + FFT + Math.round(0.2 * SR);
      const noiseDrop = dB(rms(ch, noiseA, noiseB)) - dB(rms(clean, noiseA, noiseB));
      const bodyDelta = dB(rms(clean, bodyA, bodyB)) - dB(rms(ch, bodyA, bodyB));
      return { noiseDropDb: Number(noiseDrop.toFixed(1)), bodyDeltaDb: Number(bodyDelta.toFixed(2)) };
    },
    /** End-to-end export: capture one note at 2 velocity layers on the loopback,
     *  build a v2 .hki, round-trip it, decode the WAVs, and report the layer
     *  metadata + post-gain levels (the equal-loudness normalization invariant). */
    async exportTest(): Promise<unknown> {
      const dev = await LoopbackDevice.create();
      const config = { instrumentKey: 'lb-export', displayName: 'LB Export', lowMidi: 60, highMidi: 60, semitoneStride: 1, probeNote: 60, holdMs: 300 };
      const bins = [{ lo: 1, hi: 79, sampleVel: 60 }, { lo: 80, hi: 127, sampleVel: 100 }];
      const jobs = enumerateJobs(config, bins);
      const outcomes = await runCaptureLoop(dev, jobs, { holdMs: 150, gapMs: 200 });
      dev.teardown();
      for (const o of outcomes) putOutcome(o);
      const passing = outcomes.filter(o => o.gate.pass);
      const built = buildBundle(passing, config, 'loopback');
      const bytes = writeHki(built.bundle);
      const rt = readHki(bytes);   // round-trip through the shared reader

      const ctx = new AudioContext();
      const layers: Array<{ vel?: number; gain: number; freq: number; frames: number; postGainDb: number }> = [];
      for (const s of rt.manifest.samples) {
        const u8 = rt.audio[s.file];
        const ab = new Uint8Array(u8).buffer as ArrayBuffer;   // fresh, non-shared
        const audio = await ctx.decodeAudioData(ab);
        const ch0 = audio.getChannelData(0);
        let sq = 0; for (let i = 0; i < ch0.length; i++) sq += ch0[i] * ch0[i];
        const rms = ch0.length ? Math.sqrt(sq / ch0.length) : 0;
        const g = s.gain ?? 1;
        layers.push({ vel: s.vel, gain: Number(g.toFixed(2)), freq: Number(s.freq.toFixed(2)), frames: ch0.length, postGainDb: Number((20 * Math.log10(Math.max(1e-9, rms * g))).toFixed(1)) });
      }
      await ctx.close();
      return {
        version: rt.manifest.version, decays: rt.manifest.decays, loop: rt.manifest.loop,
        source: rt.provenance?.source, sampleCount: rt.manifest.samples.length,
        passing: passing.length, layers,
      };
    },
  };
}

/** Restore config + bins from localStorage (the device must be re-connected —
 *  a live audio/MIDI handle can't persist). */
function restoreSession(): void {
  const p = loadPersisted();
  if (p.config) updateConfig(p.config);
  if (p.bins && p.bins.length) setBins(p.bins);
}

let saveTimer = 0;
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    const s = getSession();
    patchPersisted({ config: s.config, bins: s.bins });
  }, 250);
}

function main(): void {
  initBridge();
  installTestHook();
  restoreSession();
  onSessionChange(scheduleSave);   // debounced persist of config + bins on every change
  showStep('connect');
  setStatus('Ready. Open HKL ( / ) in another tab on this origin to enable Send-to-HKL.');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
