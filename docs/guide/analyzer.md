# HKL Analyzer Guide

The HKL Analyzer builds **sample-based instruments** for HexKeyLab out of audio you supply: a folder of recorded notes, or a public soundfont URL. It finds clean loop points so sustained notes can be held indefinitely, analyzes decay, and normalizes every sample to a consistent loudness, then packages the result as a `.hki` bundle (or a CDN config) you can load straight into HKL.

Open it at **`/analyzer/`** (same address as HKL, its own tab). It's a developer/power-user tool; you don't need it to play HKL, only to add new voices.

> To sample a *physical* instrument (a hardware synth or piano) rather than existing audio files, use the [Orchestrator](orchestrator.md) instead.

---

## What you need

Either of:

- **Local files**: a set of audio files, one per note, named by pitch (e.g. `A3.wav`, `C#4.mp3`). The Analyzer reads the pitch from the filename.
- **A CDN URL**: the base URL of a publicly hosted soundfont (e.g. a tonejs / gleitz / VCSL sample set). The Analyzer fetches notes from it on demand.

Most common formats work (`.wav`, `.aiff`, `.flac`, `.mp3`, `.ogg`, …).

---

## The workflow

1. **Pick a source.** Drag local files onto the page (or use the file picker), or paste a CDN base URL. For a CDN, set the **file pattern** (how filenames are built, e.g. `{NOTE}.mp3`) and the **note spelling** (sharps vs flats, etc.); a fallback-pattern button tries common variants if the first guess misses.
2. **Configure.** Set the instrument key + display name, the note range, the semitone stride (how many notes to sample), and whether it's a **sustained** (looped) or **decaying** (struck/plucked) instrument. Add a transpose if the recordings are pitched differently from their labels (e.g. some organs).
3. **Analyze all samples.** Each sample is processed in the background: loop-point detection for sustained instruments, decay analysis for struck ones, and loudness measurement for all. The table fills in, and the Analyzer auto-selects a good spread of samples (roughly one every few semitones).
4. **Inspect.** Each row shows a quality tier (color-coded), the number of loop segments found, and the gain. Expand a row to see the waveform chart and play it back (Audition) with a moving playhead. Listen for a seamless loop.
5. **Export.** Build a **`.hki`** bundle (self-contained: metadata + encoded audio) or a **CDN config** (JSON only, for publicly hosted sets). Download it, or **Send to HKL** to load it into a connected HKL tab immediately.

Your work is auto-saved as you go. Reload the page and your source, config, and selections come back.

---

## Reading the quality tiers

The Analyzer color-codes each sample by how confidently it found a clean loop (or decay):

- **Green**: excellent (a solid set of mutually-compatible loop points, or a clean decay).
- **Blue**: good.
- **Yellow**: usable but marginal (few loop segments, or some pitch drift on a decay).
- **Red / fail**: couldn't find a usable loop, or the sample clips/is too short.

A good sustained sample has several loop points whose crossfades all match. If a sample comes up red, try a different recording of that note, or adjust the **advanced gate options** (the tightness thresholds), but the defaults handle most material.

---

## Loading into HKL

Once an instrument is in HKL (via **Send to HKL**, or by importing the downloaded `.hki` with HKL's **Import** button on the Playback tab), it appears at the bottom of HKL's instrument dropdown and persists across reloads. Play a note to hear it.
