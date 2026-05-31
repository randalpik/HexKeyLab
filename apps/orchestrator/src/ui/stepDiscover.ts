// Discover step — sweep the probe note across velocities, detect velocity-layer
// boundaries from the adjacent-distance curve, and let the user confirm/edit the
// resulting bins (or force N even bins). Applied bins feed the Configure step.

import { el, clear } from './dom.js';
import { getSession, setBins, type VelocityBin } from '../state.js';
import { runSweep, sweepVelocities } from '../discovery/sweep.js';
import { detectBins, evenBins, type DiscoveryResult } from '../discovery/bins.js';
import type { Fingerprint } from '../discovery/fingerprint.js';

let working: VelocityBin[] = [];
let lastResult: DiscoveryResult | null = null;

function drawCurve(canvas: HTMLCanvasElement, result: DiscoveryResult): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#2c3038'; ctx.fillRect(0, 0, W, H);
  const curve = result.distanceCurve;
  if (curve.length === 0) {
    ctx.fillStyle = '#9aa0aa'; ctx.font = '12px system-ui';
    ctx.fillText('no sweep yet', 10, H / 2);
    return;
  }
  const maxD = Math.max(...curve.map(p => p.d)) || 1;
  const x = (v: number) => (v / 127) * (W - 20) + 10;
  const y = (d: number) => H - 10 - (d / maxD) * (H - 20);
  // Boundaries (vertical lines).
  ctx.strokeStyle = '#e8c06a';
  for (const b of result.boundaries) {
    ctx.beginPath(); ctx.moveTo(x(b), 0); ctx.lineTo(x(b), H); ctx.stroke();
  }
  // Distance curve.
  ctx.strokeStyle = '#6ea8fe'; ctx.lineWidth = 1.5; ctx.beginPath();
  curve.forEach((p, i) => { const px = x(p.v), py = y(p.d); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
  ctx.stroke();
}

function renderBinList(host: HTMLElement): void {
  clear(host);
  for (let i = 0; i < working.length; i++) {
    const bin = working[i];
    const velInput = el('input', { type: 'number', min: 1, max: 127, value: String(bin.sampleVel), style: 'width:64px' });
    velInput.addEventListener('change', () => {
      const v = Math.max(1, Math.min(127, parseInt(velInput.value, 10) || bin.sampleVel));
      working[i] = { ...bin, sampleVel: v };
    });
    host.append(el('div', { class: 'field-row' }, [
      el('span', { class: 'muted', text: `Layer ${i + 1}: vel ${bin.lo}–${bin.hi}` }),
      el('label', { text: 'sample @' }), velInput,
    ]));
  }
}

export function renderDiscover(host: HTMLElement, onApplied: () => void): void {
  clear(host);
  const panel = el('div', { class: 'step-panel active' });
  panel.append(el('h2', { text: '2 · Discover' }));

  const session = getSession();
  if (!session.device) {
    panel.append(el('p', { class: 'muted', text: 'Connect a device first (step 1).' }));
    host.append(panel);
    return;
  }

  panel.append(el('p', { class: 'muted', text:
    `Sweeps probe note ${session.config.probeNote} across the velocity band and looks for timbre/level jumps that mark the device’s internal velocity layers. Edit the result or force evenly-spaced bins.` }));

  const status = el('span', { class: 'muted', text: 'idle' });
  const canvas = el('canvas', { width: 600, height: 120, style: 'border:1px solid #3a3f48;border-radius:6px;max-width:100%' });
  const binList = el('div', {});

  const applyResult = (r: DiscoveryResult) => {
    lastResult = r;
    working = r.bins.map(b => ({ ...b }));
    drawCurve(canvas as HTMLCanvasElement, r);
    renderBinList(binList);
    status.textContent = r.detected
      ? `Detected ${r.boundaries.length} boundary(ies) → ${r.bins.length} layers.`
      : `No discrete layers detected — using ${r.bins.length} even bins.`;
  };

  const runBtn = el('button', { type: 'button', onclick: async () => {
    const dev = getSession().device;
    if (!dev) return;
    runBtn.setAttribute('disabled', '');
    const total = sweepVelocities(4).length;
    status.textContent = `Sweeping 0/${total}…`;
    try {
      const fps: Fingerprint[] = await runSweep(dev, {
        probeNote: getSession().config.probeNote,
        stride: 4,
        onProgress: (done, tot, v) => { status.textContent = `Sweeping ${done}/${tot} (vel ${v})…`; },
      });
      applyResult(detectBins(fps));
    } catch (e) {
      status.textContent = 'Sweep failed: ' + (e as Error).message;
    } finally {
      runBtn.removeAttribute('disabled');
    }
  }, text: 'Run velocity sweep' });

  const evenCount = el('input', { type: 'number', min: 1, max: 8, value: '4', style: 'width:56px' });
  const evenBtn = el('button', { type: 'button', onclick: () => {
    const n = Math.max(1, Math.min(8, parseInt((evenCount as HTMLInputElement).value, 10) || 4));
    working = evenBins(n);
    renderBinList(binList);
    status.textContent = `Using ${n} even bins.`;
  }, text: 'Use even bins' });

  const applyBtn = el('button', { type: 'button', onclick: () => {
    if (working.length === 0) { status.textContent = 'Run a sweep or pick even bins first.'; return; }
    setBins(working.map(b => ({ ...b })));
    status.textContent = `Applied ${working.length} velocity layers → ${working.map(b => b.sampleVel).join(', ')}.`;
    onApplied();
  }, text: 'Apply layers →' });

  panel.append(
    el('div', { class: 'field-row' }, [runBtn]),
    canvas,
    binList,
    el('div', { class: 'field-row' }, [el('label', { text: 'Even bins' }), evenCount, evenBtn]),
    el('div', { class: 'field-row' }, [applyBtn]),
    el('div', { class: 'field-row' }, [status]),
  );
  host.append(panel);

  // Seed with whatever bins already exist (e.g. revisiting the step).
  if (session.bins.length) { working = session.bins.map(b => ({ ...b })); renderBinList(binList); }
  void lastResult;
}
