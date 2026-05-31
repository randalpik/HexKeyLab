// Configure step — instrument metadata + note range/stride for the capture plan.
// Velocity layers come from the Discover step (session.bins).

import { el, clear } from './dom.js';
import { getSession, updateConfig } from '../state.js';
import { jobCount } from '../capture/plan.js';

export function renderConfigure(host: HTMLElement, onContinue: () => void): void {
  clear(host);
  const panel = el('div', { class: 'step-panel active' });
  panel.append(el('h2', { text: '3 · Configure' }));

  const s = getSession();
  const c = s.config;
  if (s.bins.length === 0) {
    panel.append(el('p', { class: 'muted', text: 'Pick velocity layers first (step 2).' }));
    host.append(panel);
    return;
  }

  const summary = el('p', { class: 'muted' });
  const refreshSummary = () => {
    const n = jobCount(getSession().config, getSession().bins);
    const mins = (n * 13) / 60; // ~13s worst-case per capture
    summary.textContent = `${s.bins.length} velocity layers × notes (every ${getSession().config.semitoneStride} semitones, MIDI ${getSession().config.lowMidi}–${getSession().config.highMidi}) = ${n} captures (up to ~${mins.toFixed(0)} min).`;
  };

  const num = (value: number, on: (v: number) => void, min: number, max: number) => {
    const inp = el('input', { type: 'number', min, max, value: String(value), style: 'width:80px' });
    inp.addEventListener('change', () => { const v = parseInt((inp as HTMLInputElement).value, 10); if (!Number.isNaN(v)) { on(Math.max(min, Math.min(max, v))); refreshSummary(); } });
    return inp;
  };
  const text = (value: string, on: (v: string) => void, ph: string) => {
    const inp = el('input', { type: 'text', value, placeholder: ph, style: 'width:240px' });
    inp.addEventListener('input', () => on((inp as HTMLInputElement).value));
    return inp;
  };

  const row = (label: string, ...controls: Node[]) => el('div', { class: 'field-row' }, [el('label', { text: label }), ...controls]);

  panel.append(
    row('Instrument key', text(c.instrumentKey, v => updateConfig({ instrumentKey: v }), 'e.g. my-korg-grand')),
    row('Display name', text(c.displayName, v => updateConfig({ displayName: v }), 'e.g. Korg Grand Piano')),
    row('Low MIDI', num(c.lowMidi, v => updateConfig({ lowMidi: v }), 0, 127)),
    row('High MIDI', num(c.highMidi, v => updateConfig({ highMidi: v }), 0, 127)),
    row('Semitone stride', num(c.semitoneStride, v => updateConfig({ semitoneStride: v }), 1, 12)),
    row('Min hold (ms)', num(c.holdMs, v => updateConfig({ holdMs: v }), 10, 5000)),
    summary,
  );

  const status = el('span', { class: 'muted' });
  const continueBtn = el('button', { type: 'button', onclick: () => {
    const cfg = getSession().config;
    if (!cfg.instrumentKey.trim()) { status.textContent = 'Enter an instrument key.'; return; }
    if (cfg.highMidi < cfg.lowMidi) { status.textContent = 'High MIDI must be ≥ low MIDI.'; return; }
    onContinue();
  }, text: 'Continue to capture →' });

  panel.append(el('div', { class: 'field-row' }, [continueBtn, status]));
  host.append(panel);
  refreshSummary();
}
