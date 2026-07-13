# HKL Orchestrator Guide

The HKL Orchestrator samples a **physical MIDI instrument** (a hardware synth, digital piano, or sound module) into a HexKeyLab `.hki` instrument bundle. It plays each note for you, records the real audio output, captures multiple velocity layers, cleans up the noise, and packages it all so you can play *your own keyboard's sound* inside HKL, legally, without redistributing anyone else's samples.

Open it at **`/orchestrator/`** (same address as HKL, its own tab). Like the Analyzer, it's a power-user tool for building instruments.

> To build an instrument from existing audio *files* (or a soundfont URL) rather than a live instrument, use the [Analyzer](analyzer.md) instead. The Orchestrator handles **decaying** instruments (pianos, plucked/struck sounds); sustained instruments are out of scope.

---

## What you need

- A **MIDI instrument** connected so the browser can both *trigger* it (MIDI output) and *hear* it (its audio routed into an audio-interface input).
- That's it: no special software. If you just want to try the flow without hardware, pick the built-in **synthetic loopback** device.

---

## The five-step wizard

1. **Connect**: choose the MIDI output that plays your instrument and the audio input that hears it (the browser's own audio processing — echo cancellation, noise suppression, auto-gain — is forced off so the recording is faithful). Fire a test note and watch the level meter to confirm signal. Or pick the **loopback** synth for a hardware-free dry run.
   - **Calibrate whine** (optional, recommended): records a few seconds of the instrument's *idle* output and detects any fixed tonal artifacts — the DAC/switching-clock whine many digital instruments emit (often a high-frequency comb around 6–15 kHz). Those exact tones are then notched out of every capture. Don't play during the ~3 s recording. The detected profile is remembered across reloads; re-run it if you change the instrument or its master volume.
2. **Discover**: the Orchestrator sweeps a single note across the whole velocity range and detects where your instrument switches between its internal velocity layers (the points where the *timbre* jumps, not just the volume). You can edit the detected boundaries, or fall back to evenly-spaced bins. The sweep also measures your instrument's own **velocity→loudness response**, used at export to balance the layers.
3. **Configure**: set the instrument key/name, the note range, the semitone stride, and the hold time.
4. **Capture**: for each note × velocity layer, the Orchestrator holds the key and records the **natural decay** all the way down into the noise floor, then runs quality checks. A take that comes out abnormally quiet or too noisy-once-boosted is **automatically re-recorded once** (a fresh strike often fixes it); the cleaner take is kept. Anything still failing (too quiet, clipped, or too short) is flagged so you can re-capture just those.
5. **Export**: each capture is cleaned (fixed whine tones notched out, then broadband noise reduced), each layer's gain is set so the velocity layers reproduce *your keyboard's own* loudness balance, and it's all assembled into a velocity-layered `.hki` — downloaded or **sent straight to HKL**. A layer that's genuinely too quiet to boost without audible hiss (common for the highest notes at the softest velocity) is **skipped** and reported; when you play that note/velocity, HKL falls back to the nearest captured layer instead.

Your configuration and detected layers are remembered across reloads.

---

## Notes on quality

- **Capture quality is mostly about your input chain**, not the software. A clean line-in source makes everything downstream work; hum or a noisy preamp are the usual culprits. The capture step measures and reports the noise floor so you can dial in the input gain. A device's *own* fixed tonal whine (a DAC/clock artifact, present even at idle and scaling with the instrument's master volume) can't be dialed out at the input — that's what **Calibrate whine** is for.
- **Pitch is trusted, not detected.** The Orchestrator stores each note's nominal equal-tempered pitch rather than measuring it: digital instruments hold tuning precisely, and pitch detection on a piano reads systematically sharp. The just-intonation correction happens at playback inside HKL.
- **Velocity layers reproduce your keyboard's loudness balance.** Rather than flattening every layer to one level, the Orchestrator compares your instrument's measured velocity→loudness (from the Discover sweep) against HKL's playback curve and softens the brighter layers by exactly the residual — so a layer switch no longer reads as an abrupt jump in perceived loudness. HKL's own velocity curve still supplies the overall dynamics.

---

## Loading into HKL

**Send to HKL** loads the bundle into a connected HKL tab immediately; or import the downloaded `.hki` with HKL's **Import** button (Playback tab). It then appears in HKL's instrument dropdown and persists across reloads.
