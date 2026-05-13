// Apply a stored LayoutSnapshot back to live HKL state. Drives the existing
// control handlers (setTuning, setLayout, etc.) so all side effects fire —
// color sync, info update, prefs persistence. Awaits sample load if the
// snapshot's instrument isn't resident.
//
// Kept in its own module (not in snapshot.ts) because applying pulls in
// ui/controls.ts which itself transitively imports audio/engine.ts and
// recording/capture.ts. Snapshot capture/match — used by capture.ts — must
// stay leaf-position in the module graph; this module is consumed only by
// ui/recorder.ts.

import { tuning } from '../state/tuning.js';
import { pedal } from '../state/pedal.js';
import { audio } from '../state/audio.js';
import { SampleEngine } from '../audio/samples.js';
import { savePrefs } from '../state/persistence.js';
import { setTuning, setLayout, setQwertyTranspose } from '../ui/controls.js';
import { onTuningChanged } from '../effects/onTuningChanged.js';
import type { LayoutSnapshot } from './types.js';

function isOscillator(name: string): boolean {
  return name === 'sine' || name === 'square' || name === 'triangle';
}

export async function applySnapshot(s: LayoutSnapshot): Promise<void> {
  const sampleInstrAvailable = !!SampleEngine.INSTRUMENTS[s.instrument];
  if (!isOscillator(s.instrument) && !sampleInstrAvailable) {
    throw new Error('Instrument unavailable: ' + s.instrument);
  }

  /* Tuning system + seam shift first — layout switch downstream may color-sync
     against tuning state. */
  const selTuning = document.getElementById('selTuning') as HTMLSelectElement | null;
  if (selTuning && selTuning.value !== s.tuning) {
    selTuning.value = s.tuning;
    setTuning();
  }
  if (tuning.septimalShift !== s.septimalShift) {
    tuning.septimalShift = s.septimalShift;
    const ssi = document.getElementById('seamShiftInd');
    if (ssi) ssi.textContent = String(s.septimalShift);
    savePrefs({ septimalShift: s.septimalShift });
    onTuningChanged({ colorSync: false });
  }
  if (tuning.qwertyTranspose !== s.qwertyTranspose) {
    setQwertyTranspose(s.qwertyTranspose - tuning.qwertyTranspose);
  }
  if (tuning.curLayout !== s.curLayout) {
    setLayout(s.curLayout);
  }

  /* Pedal mode — no handler beyond the DOM listener, so we set state + DOM and
     persist directly. The mid-press re-evaluation done by the DOM listener
     isn't relevant here (nothing is held during playback prep). */
  if (pedal.mode !== s.pedalMode) {
    const pmSel = document.getElementById('pedalMode') as HTMLSelectElement | null;
    if (pmSel) pmSel.value = s.pedalMode;
    pedal.mode = s.pedalMode;
    savePrefs({ pedalMode: s.pedalMode });
  }

  /* Instrument — load if needed, then commit. */
  if (audio.activeWaveform !== s.instrument) {
    const wfSel = document.getElementById('waveform') as HTMLSelectElement | null;
    if (wfSel) wfSel.value = s.instrument;
    if (isOscillator(s.instrument) || SampleEngine.isInstrumentLoaded(s.instrument)) {
      audio.activeWaveform = s.instrument;
    } else {
      await SampleEngine.loadInstrument(s.instrument);
      audio.activeWaveform = s.instrument;
    }
    savePrefs({ waveform: s.instrument });
  }
}
