# HKL Orchestrator — Guide

The HKL Orchestrator samples a **physical MIDI instrument** — a hardware synth, digital piano, or sound module — into a HexKeyLab `.hki` instrument bundle. It plays each note for you, records the real audio output, captures multiple velocity layers, cleans up the noise, and packages it all so you can play *your own keyboard's sound* inside HKL — legally, without redistributing anyone else's samples.

Open it at **`/orchestrator/`** (same address as HKL, its own tab). Like the Analyzer, it's a power-user tool for building instruments.

> To build an instrument from existing audio *files* (or a soundfont URL) rather than a live instrument, use the [Analyzer](analyzer.md) instead. The Orchestrator handles **decaying** instruments (pianos, plucked/struck sounds); sustained instruments are out of scope.

---

## What you need

- A **MIDI instrument** connected so the browser can both *trigger* it (MIDI output) and *hear* it (its audio routed into an audio-interface input).
- That's it — no special software. If you just want to try the flow without hardware, pick the built-in **synthetic loopback** device.

---

## The five-step wizard

1. **Connect** — choose the MIDI output that plays your instrument and the audio input that hears it (the browser's own audio processing — echo cancellation, noise suppression, auto-gain — is forced off so the recording is faithful). Fire a test note and watch the level meter to confirm signal. Or pick the **loopback** synth for a hardware-free dry run.
2. **Discover** — the Orchestrator sweeps a single note across the whole velocity range and detects where your instrument switches between its internal velocity layers (the points where the *timbre* jumps, not just the volume). You can edit the detected boundaries, or fall back to evenly-spaced bins.
3. **Configure** — set the instrument key/name, the note range, the semitone stride, and the hold time.
4. **Capture** — for each note × velocity layer, the Orchestrator holds the key and records the **natural decay** all the way down into the noise floor, then runs quality checks. Failures (too quiet, clipped, or too short) are flagged so you can re-capture just those.
5. **Export** — each layer is denoised and normalized to a consistent loudness, assembled into a velocity-layered `.hki`, and downloaded or **sent straight to HKL**.

Your configuration and detected layers are remembered across reloads.

---

## Notes on quality

- **Capture quality is mostly about your input chain**, not the software. A clean line-in source makes everything downstream work; hum, whine, or a noisy preamp are the usual culprits. The capture step measures and reports the noise floor so you can dial in the input gain.
- **Pitch is trusted, not detected.** The Orchestrator stores each note's nominal equal-tempered pitch rather than measuring it — digital instruments hold tuning precisely, and pitch detection on a piano reads systematically sharp. The just-intonation correction happens at playback inside HKL.
- **Velocity layers change timbre, not loudness.** Every layer is normalized to the same target level; at play time HKL picks the nearest layer for the timbre and applies its own velocity-to-loudness curve.

---

## Loading into HKL

**Send to HKL** loads the bundle into a connected HKL tab immediately; or import the downloaded `.hki` with HKL's **Import** button (Playback tab). It then appears in HKL's instrument dropdown and persists across reloads.
