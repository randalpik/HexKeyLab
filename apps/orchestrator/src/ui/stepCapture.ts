// Capture step — run the sequential capture loop with a live progress bar and a
// per-job status table (gate tier + flags). Failed jobs get a Re-capture button.

import { el, clear } from './dom.js';
import { getSession } from '../state.js';
import { enumerateJobs, type CaptureJob } from '../capture/plan.js';
import { runCaptureLoop, captureOne, type JobOutcome } from '../capture/loop.js';
import { gateTier, type GateResult } from '../capture/gates.js';
import { putOutcome } from '../capture/store.js';

const TIER_COLOR: Record<string, string> = { green: '#5fd07a', yellow: '#e8c06a', red: '#e87a7a' };

export function renderCapture(host: HTMLElement, onDone: () => void): void {
  clear(host);
  const panel = el('div', { class: 'step-panel active' });
  panel.append(el('h2', { text: '4 · Capture' }));

  const s = getSession();
  if (!s.device) { panel.append(el('p', { class: 'muted', text: 'Connect a device first (step 1).' })); host.append(panel); return; }
  if (s.bins.length === 0) { panel.append(el('p', { class: 'muted', text: 'Pick velocity layers first (step 2).' })); host.append(panel); return; }

  const jobs = enumerateJobs(s.config, s.bins);
  const outcomes = new Map<string, JobOutcome>();
  let aborter: AbortController | null = null;

  panel.append(el('p', { class: 'muted', text: `${jobs.length} captures (${s.bins.length} layers × notes). One note at a time; 12 s max or until the decay reaches the noise floor.` }));

  const barFill = el('div', { class: 'meter-fill', style: 'background:var(--accent)' });
  const bar = el('div', { class: 'meter', style: 'width:100%' }, [barFill]);
  const status = el('span', { class: 'muted', text: 'ready' });
  const tableBody = el('tbody', {});
  const table = el('table', { style: 'width:100%;border-collapse:collapse;font-size:12px;margin-top:10px' }, [
    el('thead', {}, [el('tr', {}, ['note / vel', 'tier', 'peak dB', 'SNR dB', 'dur s', 'drift ¢', 'flags', ''].map(h => el('th', { style: 'text-align:left;padding:3px 6px;color:#9aa0aa', text: h })))]),
    tableBody,
  ]);

  const rowFor = new Map<string, HTMLTableRowElement>();
  function renderRow(job: CaptureJob, g: GateResult): void {
    let tr = rowFor.get(job.captureId);
    if (!tr) { tr = el('tr', {}); rowFor.set(job.captureId, tr); tableBody.append(tr); }
    clear(tr);
    const tier = gateTier(g);
    const recapBtn = el('button', { type: 'button', style: 'padding:2px 8px;font-size:11px', onclick: async () => {
      const dev = getSession().device; if (!dev) return;
      recapBtn.setAttribute('disabled', '');
      const o = await captureOne(dev, job, getSession().config.holdMs);
      outcomes.set(job.captureId, o);
      putOutcome(o);
      renderRow(job, o.gate);
      updateDoneState();
    }, text: 'Re-capture' });
    const cells: Array<Node | string> = [
      `${job.midi} / ${job.velocity}`,
      el('span', { style: `color:${TIER_COLOR[tier]}`, text: tier }),
      String(g.peakDb), String(g.snrDb), String(g.durSec), g.driftCents == null ? '—' : String(g.driftCents),
      g.flags.join(', ') || '—',
    ];
    for (const c of cells) tr.append(el('td', { style: 'padding:3px 6px' }, [typeof c === 'string' ? document.createTextNode(c) : c]));
    tr.append(el('td', { style: 'padding:3px 6px' }, g.pass ? [] : [recapBtn]));
  }

  const exportBtn = el('button', { type: 'button', disabled: true, onclick: onDone, text: 'Analyze & export →' });
  function updateDoneState(): void {
    const passing = [...outcomes.values()].filter(o => o.gate.pass).length;
    status.textContent = `${outcomes.size}/${jobs.length} captured, ${passing} passing.`;
    if (outcomes.size === jobs.length && passing > 0) exportBtn.removeAttribute('disabled');
  }

  const startBtn = el('button', { type: 'button', onclick: async () => {
    const dev = getSession().device; if (!dev) return;
    startBtn.setAttribute('disabled', '');
    aborter = new AbortController();
    abortBtn.removeAttribute('disabled');
    try {
      await runCaptureLoop(dev, jobs, {
        holdMs: getSession().config.holdMs,
        signal: aborter.signal,
        onProgress: (done, total, outcome) => {
          outcomes.set(outcome.job.captureId, outcome);
          putOutcome(outcome);
          barFill.style.width = ((done / total) * 100).toFixed(1) + '%';
          renderRow(outcome.job, outcome.gate);
          updateDoneState();
        },
      });
    } catch (e) { status.textContent = 'Capture error: ' + (e as Error).message; }
    finally { startBtn.removeAttribute('disabled'); abortBtn.setAttribute('disabled', ''); }
  }, text: 'Start capture' });

  const abortBtn = el('button', { type: 'button', disabled: true, onclick: () => { aborter?.abort(); getSession().device?.allNotesOff(); }, text: 'Stop' });

  panel.append(el('div', { class: 'field-row' }, [startBtn, abortBtn, exportBtn]), bar, el('div', { class: 'field-row' }, [status]), table);
  host.append(panel);
}
