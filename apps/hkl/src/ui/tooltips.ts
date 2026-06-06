// Single source of truth for every toolbar control's hover tooltip.
//
// All toolbar `title=` text lives here (not inline in index.html) so it can be
// copy-edited in one place. `applyTooltips()` is called once at startup (from
// init.ts, right after the toolbar selector is wired) and stamps each `title`
// onto the correct host element.
//
// Out of scope (titles set at runtime, intentionally not here): the Lumatone
// status click-hint (`midi/engine.ts`), per-port piano device `<option>`s
// (`midi/piano.ts`), and the in-dialog "Send to Composer" button
// (`ui/recorder.ts`). Those reflect live state and override as needed.

/** Tooltip text keyed by element id. */
export const TOOLTIPS: Record<string, string> = {
  // ── Toolbar selector ────────────────────────────────────────────────
  tbLayout: 'Show the Layout toolbar: tuning system, note-name / band-seam / pattern display, and lattice rotation & outline.',
  tbPlayback: 'Show the Playback toolbar: audio engine, instrument, transpose, and the loop-seam diagnostics overlay.',
  tbAnalysis: 'Show the Analysis toolbar: interval/chord analysis box, coordinate readout, staff-notation inset, and accidental options.',
  tbRecording: 'Show the Recording toolbar: record/play, .hkr save/load, .mid import/export, and Composer transcription.',
  tbLumatone: 'Show the Lumatone toolbar: connection & color auto-sync, pedal mode, and pedal/key calibration.',
  tbPiano: 'Show the Piano toolbar: external MIDI device input/output and the valid-reference-note overlay.',
  btnResetPrefs: 'Reset all toolbar settings and visibility to defaults',

  // ── Layout ──────────────────────────────────────────────────────────
  selTuning: 'Active tuning system: sets the just-intonation interpretation of every key.',
  cbNotes: 'Draw note names on each key.',
  cbBands: 'Draw the octave-band seams (every key is one octave above the key three positions to its left along the q-axis).',
  cbExtend: 'Extend the repeating key pattern beyond the physical outline to fill the canvas.',
  selRotation: 'Lattice orientation: Vertical Freq (pitch rises straight up), Lumatone (physical board tilt), or Piano.',
  selOutline: 'Which key outline to overlay on the lattice: Lumatone, QWERTY, Piano, or none.',
  selHexSize: 'Hex size: rescale the whole lattice — keys, labels, and outlines — to Small, Medium, or Large.',

  // ── Playback ────────────────────────────────────────────────────────
  cbAudio: 'Enable the built-in audio engine (sample / oscillator playback at true JI tuning).',
  waveform: 'Instrument / waveform for the audio engine: sampled instruments and synthesized waveforms, plus any imported .hki bundles.',
  btnHkiManage: 'Import and manage instruments',
  btnClear: 'Clear the current selection and release any held notes.',
  cbShowDiag: 'Loop-seam diagnostics overlay: visualizes master-output RMS, seam crossfades, and per-key input traces (requires Audio enabled)',

  // ── Analysis ────────────────────────────────────────────────────────
  cbAnalysis: 'Show the interval/chord analysis box (comma-decomposition names and JI ratios for the held notes).',
  cbCoords: 'Show each key’s (q, r) lattice coordinates.',
  cbStaff: 'Show the currently-held notes as a chord on a grand staff (Verovio), inset at the bottom-right. HEJI accidentals follow the HEJI toggle.',
  cbStaffDark: 'Render the staff-notation inset dark: dark background, light staff lines and accidentals, and noteheads in the bright on-screen lattice colors. Distinct from Composer’s theme.',
  cbComposerView: 'Replace the analysis/staff area with a read-only, scrollable frame mirroring the current HKL Composer score (the cursor instrument’s part), auto-scrolling to follow the Composer cursor and playback. Requires HKL Composer open in another tab.',
  cbShortIvl: 'Use compact (short) interval names in the analysis box.',
  cbHeji: 'Decorate note labels with Helmholtz-Ellis JI comma arrows / septimal hooks (auto-enabled in Schismatic mode)',

  // ── Recording ───────────────────────────────────────────────────────
  btnRecord: 'Start/stop recording',
  btnPlay: 'Play current recording',
  btnSaveHkr: 'Save the current recording as .hkr (HexKeyLab native format)',
  btnLoadHkr: 'Load a .hkr recording',
  btnExportMidi: 'Export the current recording as a .mid file (MPE)',
  btnImportMidi: 'Import a .mid file (requires matching .hkr loaded for layout snapshot)',
  btnExportComposer: 'Transcribe the current recording to a .hkc score; download it or send it straight to Composer',
  cbCaptureAudio: 'Download a .wav of the engine output alongside each .hkr record or playback (44.1kHz / 16-bit stereo PCM)',

  // ── Lumatone ────────────────────────────────────────────────────────
  cbAutoSync: 'Automatically push key colors to the connected Lumatone whenever the layout changes.',
  pedalMode: 'Sustain mode: sustain jack = damper. Sostenuto mode: sustain jack = sostenuto, expression jack = continuous damper.',
  btnCalibPedal: 'Calibrate the expression pedal jack.',
  cbCalibrateKeys: 'Per-board key calibration overlay (Shift+\\ also toggles)',

  // ── Piano ───────────────────────────────────────────────────────────
  selPianoDevice: 'External MIDI device for piano-keyboard input / output.',
  cbPianoEnabled: 'Enable 12-TET piano-keyboard MIDI input. Notes are resolved to lattice cells via Tenney Height against the current reference note (broadcast by HKL Composer when connected; A3 otherwise).',
  cbPianoOutput: 'Mirror HKL playback to the selected device’s audio engine, tuned to true just intonation via per-channel RPN fine-tuning (one voice per MIDI channel). Independent of the Audio toggle. Needs a synth set to receive on all MIDI channels.',
  cbValidRefBounds: 'Show a dotted outline marking the region where you can Ctrl+click to set a new reference note. Shape depends on the active tuning bucket (5-limit/12-TET vs 7-limit).',

  // ── Composer (hidden group, shown when Composer connects) ────────────
  cbSyncToComposer: 'When on, HKL aggressively applies any layout requirement broadcast by Composer (tuning mode + ref note). When off, mismatches trigger a prompt at playback start.',
};

/** Transpose axes have no element ids — keyed by their `.tpal` axis label. */
export const TRANSPOSE_TOOLTIPS: Record<string, string> = {
  P5: 'Transpose the selection by a perfect fifth, up or down.',
  M3: 'Transpose the selection by a major third, up or down.',
  m3: 'Transpose the selection by a minor third, up or down.',
  P8: 'Transpose the selection by an octave, up or down.',
  SC: 'Transpose the selection by a syntonic comma, up or down.',
};

/* Resolve the element a tooltip should sit on so hovering the visible label
   (not just the tiny checkbox/select box) surfaces it: prefer an enclosing
   <label>, then a `.lsel` wrapper (label-span + select), else the element. */
function tooltipHost(el: HTMLElement): HTMLElement {
  return (el.closest('label') as HTMLElement | null)
    ?? (el.closest('.lsel') as HTMLElement | null)
    ?? el;
}

/** Stamp every tooltip onto its host. Idempotent; safe to call once at init. */
export function applyTooltips(): void {
  for (const [id, text] of Object.entries(TOOLTIPS)) {
    const el = document.getElementById(id);
    if (el) tooltipHost(el).title = text;
  }
  for (const ax of document.querySelectorAll<HTMLElement>('#transposeCtrl .tpax')) {
    const label = ax.querySelector('.tpal')?.textContent?.trim();
    const text = label ? TRANSPOSE_TOOLTIPS[label] : undefined;
    if (text) ax.title = text;
  }
}
