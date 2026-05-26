# SP-250 fine-tune over MIDI — empirical spike

Precursor to the Orchestrator (HKLO) project. Determines whether the Korg SP-250 honours any MIDI-based fine-tune path so we know whether a monophonic real-time JI alternative is on the table or sampling is the only viable approach.

Source-of-truth design lives in `~/Downloads/sp250_finetune_spike.md` (test rationale, expected outcomes, interpretation matrix). This directory is the browser-side port of that spike.

## What the page tests

- **Test A** — Universal Real Time SysEx Master Fine Tuning (`F0 7F 7F 04 03 LSB MSB F7`)
- **Test B** — RPN 0001 Fine Tuning via CC 101/100/6/38, first on channel 0, then broadcast to all 16 channels if channel 0 fails
- **Sustain follow-up** — if A or B PASS, holds A3 and retunes mid-ring to see whether the held note pitch-bends along
- **Test C** — only enabled after both A and B FAIL: listens for whatever MIDI the SP-250 emits while the front-panel fine-tune buttons (FUNCTION+B5, FUNCTION+C6) and Sound Data Dump are exercised

## Run

Web MIDI needs a secure context (`localhost`, not `file://`). Easiest:

```
npx serve tools/sp250-spike
```

Then open the printed URL in Firefox or Chromium. Approve the SysEx prompt.

Alternatively, if `npm run dev` is already running for HKL work, navigate to `http://localhost:5173/tools/sp250-spike/` — Vite serves arbitrary repo files.

## Hardware setup

- USB-MIDI: computer → SP-250 **MIDI IN**
- SP-250 audio → monitors/headphones (listening is by ear)
- SP-250: Piano 1, Local On, Fine Tune centered, Touch=Normal, Reverb OFF, Chorus OFF
- Test C only: second cable, SP-250 **MIDI OUT** → computer MIDI IN

## Reporting

After running, click "Copy to clipboard" — the deliverable block matches the format the spike doc expects:

```
Test A (Universal SysEx): PASS/FAIL/AMBIGUOUS
  Sustain behavior: notes-stay/notes-shift   (if PASS)
Test B (RPN): PASS/FAIL/AMBIGUOUS
  Sustain behavior: notes-stay/notes-shift   (if PASS)
Test C: <verdict>
  Captured MIDI: <log if any>
```

Hand that block back to HKL to scope the next step (HKLO sampling path, monophonic-JI follow-up, or both).
