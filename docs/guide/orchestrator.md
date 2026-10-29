# HKL Orchestrator Guide

The HKL Orchestrator samples a **physical MIDI instrument** (a digital piano, hardware synth or sound module) into an HKL instrument bundle (`.hki`). It plays each note for you at several velocities, records your instrument's own audio, cleans it up and packages it, so you can play your own keyboard's sound in HKL, in just intonation.

Open it at **`/orchestrator/`**, at the same address as HKL, in its own tab. It handles **decaying** instruments, such as pianos and plucked or struck sounds. For sustained sounds, or to build an instrument from audio files, use the [Analyzer](analyzer.md).

---

## What you need

- A **MIDI instrument** connected so the browser can play it over MIDI and hear its audio through an audio-interface input.
- A browser with Web MIDI. Firefox asks permission to use MIDI devices; Chromium works too. Audio inputs appear once you press **Enable mic access**.
- To try it without hardware, pick the built-in **synthetic loopback** device.

---

## The five steps

1. **Connect**: choose the MIDI output that plays your instrument and the audio input that hears it, then fire a test note and watch the level meter.
   - **Calibrate whine** (recommended): records about 3 seconds of the instrument idling, finds the steady electronic whine many digital instruments make, and removes exactly those tones from every take. Don't play while it records. The result is remembered; run it again if you change the instrument or its master volume.
2. **Discover**: the Orchestrator sweeps one note through the whole velocity range and finds where your instrument switches between its internal velocity layers. Adjust the velocity each layer is sampled at (**sample @**), or use evenly spaced layers instead (**Use even bins**), then press **Apply layers →**.
3. **Configure**: the instrument key and name, the note range, the **Semitone stride** between sampled notes, and **Min hold (ms)**: how long after the strike to wait before listening for the note to die away.
4. **Capture**: for each note and layer, the Orchestrator holds the key and records the note's natural decay (up to 12 seconds), then checks the take. A take that comes out too quiet or too noisy is recorded again once, automatically; takes that still fail are flagged so you can capture just those again. Each take's peak level and signal-to-noise ratio are shown, to help you set the input gain.
5. **Export**: the takes are cleaned and balanced so the layers keep your instrument's own loudness from soft to loud, then assembled into a `.hki` to download or **Send to HKL**. A layer too quiet to use without audible hiss (often the highest notes at the softest velocity) is skipped and reported; HKL plays the nearest layer instead.

Your settings and layers are remembered across reloads. **The recorded audio is not**: export the `.hki` before you reload or close the tab.

Capture quality depends mostly on your input chain. A clean line-level connection matters most; hum and a noisy preamp are the usual problems.

---

## Loading into HKL

**Send to HKL** loads the bundle into a connected HKL tab at once; or import the downloaded `.hki` with HKL's **Import** button (Playback tab). It then appears in HKL's instrument dropdown and stays across reloads.
