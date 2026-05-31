// Export step — analyze the passing captures into a v2 layered .hki, then offer
// download + Send-to-HKL (over the orchestrator bridge).

import { el, clear } from './dom.js';
import { getSession } from '../state.js';
import { listOutcomes } from '../capture/store.js';
import { buildBundle, type BuildResult } from '../analysis/buildHki.js';
import { writeHki, bundleAudioSize } from '@hkl/shared/hki.js';
import { downloadBytes } from './download.js';
import { sendHkiToHkl, isHklConnected, onConnectionChange } from '../bridge.js';

export function renderExport(host: HTMLElement): void {
  clear(host);
  const panel = el('div', { class: 'step-panel active' });
  panel.append(el('h2', { text: '5 · Export' }));

  const outcomes = listOutcomes();
  const passing = outcomes.filter(o => o.gate.pass);
  if (passing.length === 0) {
    panel.append(el('p', { class: 'muted', text: 'No passing captures yet — record some in step 4.' }));
    host.append(panel);
    return;
  }

  const status = el('span', { class: 'muted', text: `${passing.length} passing captures ready.` });
  let built: BuildResult | null = null;
  let bytes: Uint8Array | null = null;

  const summary = el('p', { class: 'muted' });
  const downloadBtn = el('button', { type: 'button', disabled: true, text: 'Download .hki' });
  const sendBtn = el('button', { type: 'button', disabled: true, text: isHklConnected() ? 'Send to HKL' : 'Send to HKL (no HKL)' });

  const buildBtn = el('button', { type: 'button', onclick: () => {
    try {
      built = buildBundle(passing, getSession().config, getSession().deviceLabel);
      bytes = writeHki(built.bundle);
      const mb = (bundleAudioSize(built.bundle) / 1e6).toFixed(1);
      summary.textContent = `Built v${built.bundle.manifest.version} bundle: ${built.noteCount} notes × layers = ${built.layerCount} samples, ${mb} MB audio (${(bytes.length / 1e6).toFixed(1)} MB packed).`;
      downloadBtn.removeAttribute('disabled');
      if (isHklConnected()) sendBtn.removeAttribute('disabled');
      status.textContent = 'Bundle built. Download or send to HKL.';
    } catch (e) {
      status.textContent = 'Build failed: ' + (e as Error).message;
    }
  }, text: 'Analyze & build .hki' });

  downloadBtn.addEventListener('click', () => {
    if (!bytes || !built) return;
    downloadBytes(bytes, (built.bundle.manifest.instrumentKey || 'instrument') + '.hki');
  });

  sendBtn.addEventListener('click', async () => {
    if (!built) return;
    sendBtn.setAttribute('disabled', '');
    status.textContent = 'Sending to HKL…';
    try {
      await sendHkiToHkl(built.bundle);
      status.textContent = 'Sent — instrument imported into HKL.';
    } catch (e) {
      status.textContent = 'Send failed: ' + (e as Error).message;
    } finally {
      if (isHklConnected()) sendBtn.removeAttribute('disabled');
    }
  });

  onConnectionChange(connected => {
    sendBtn.textContent = connected ? 'Send to HKL' : 'Send to HKL (no HKL)';
    if (connected && built) sendBtn.removeAttribute('disabled');
    if (!connected) sendBtn.setAttribute('disabled', '');
  });

  panel.append(
    el('div', { class: 'field-row' }, [buildBtn]),
    summary,
    el('div', { class: 'field-row' }, [downloadBtn, sendBtn]),
    el('div', { class: 'field-row' }, [status]),
  );
  host.append(panel);
}
