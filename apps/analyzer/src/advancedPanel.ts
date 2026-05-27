// Advanced gate-options panel. Each input is OPTIONAL — empty means "use
// engine default". Numeric inputs map to state.opts.<key>. The sidecar
// merged these into prepareLoop opts via mergeGlobalThresholds; here we
// just keep them in state.opts and let pipeline.ts pass them through.

import { getState, setOpts } from './stage.js';
import type { GateOpts } from './state.js';

interface Wire {
  id: string;
  key: keyof GateOpts;
  kind: 'number' | 'bool' | 'tri';
}

const WIRES: Wire[] = [
  { id: 'gateRmsStep',         key: 'rmsStepThreshold',       kind: 'number' },
  { id: 'gateSlopeStep',       key: 'slopeStepThreshold',     kind: 'number' },
  { id: 'gateSlopeStride',     key: 'slopeStrideSec',         kind: 'number' },
  { id: 'gateCorrThreshold',   key: 'corrThreshold',          kind: 'number' },
  { id: 'gatePitchStep',       key: 'pitchStepThresholdCents', kind: 'number' },
  { id: 'gateTiltStep',        key: 'tiltStepThreshold',      kind: 'number' },
  { id: 'gateTrustLabeled',    key: 'trustLabeledPitch',      kind: 'tri' },
];

function readNumber(el: HTMLInputElement): number | undefined {
  const v = el.value.trim();
  if (v === '') return undefined;
  const n = parseFloat(v);
  return isFinite(n) ? n : undefined;
}

function readTri(el: HTMLSelectElement): boolean | undefined {
  if (el.value === '') return undefined;
  return el.value === 'true';
}

export function initAdvancedPanel(): void {
  for (const w of WIRES) {
    const el = document.getElementById(w.id) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) continue;
    const handler = () => {
      const cur = getState().opts;
      const patch: Partial<GateOpts> = {};
      if (w.kind === 'number') {
        patch[w.key] = readNumber(el as HTMLInputElement) as never;
      } else if (w.kind === 'tri') {
        patch[w.key] = readTri(el as HTMLSelectElement) as never;
      }
      /* Only apply when value actually changed — avoids re-broadcasting on
         every focus/blur. */
      if (cur[w.key] === patch[w.key]) return;
      setOpts(patch);
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  }
}
