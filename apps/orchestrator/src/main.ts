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

function renderStep(): void {
  const host = document.getElementById('wizard');
  if (!host) return;
  host.innerHTML = '';
  const panel = document.createElement('div');
  panel.className = 'step-panel active';
  const title = STEPS.find(s => s.id === current)?.label ?? current;
  panel.innerHTML = `<h2>${title}</h2>`
    + `<p class="muted">This step is not implemented yet — scaffold only. `
    + `The device I/O, discovery, capture, and export modules land in subsequent phases.</p>`;
  host.appendChild(panel);
}

export function showStep(id: StepId): void {
  current = id;
  renderBreadcrumb();
  renderStep();
}

function main(): void {
  initBridge();
  showStep('connect');
  setStatus('Ready. Open HKL ( / ) in another tab on this origin to enable Send-to-HKL.');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
