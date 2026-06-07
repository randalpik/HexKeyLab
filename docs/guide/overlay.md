# OBS Overlay Guide

The OBS overlay puts HexKeyLab's live hex lattice (and, optionally, its Composer-view score) **on top of a performance video in OBS, with a transparent background**. As you play, the overlay mirrors exactly what's on your HKL screen, so a stream or recording can show the keyboard lighting up over a camera shot of your hands.

It works by running a tiny local server that serves a stripped-down, read-only copy of HKL and relays your performing instance's screen state to it. OBS loads that copy as a Browser Source.

---

## What you need

- **OBS** (or any tool that can add a Browser Source).
- **[Node](https://nodejs.org)** installed, to run the overlay host (a small bundled server).
- An internet connection while streaming (the notation font for the Composer view is local, but the music-engraving engine loads from a CDN).

---

## Setup

1. **Build and start the overlay host** (one time to build, then run whenever you stream):

   ```bash
   pnpm overlay:dist     # build the lean overlay + bundle it into the host
   pnpm overlay:host     # start the local server (listens on 127.0.0.1:5190)
   ```

2. **Add a Browser Source in OBS** pointing at:

   ```
   http://127.0.0.1:5190/?overlay
   ```

   Size it to your lattice; the background comes through transparent.

3. **Perform on the normal HKL page in Firefox** (the hosted/production HKL is fine). Publishing to the overlay starts **automatically**; there's no checkbox. As soon as the overlay host is running, your HKL screen state flows to the Browser Source.

That's the whole setup. The overlay mirrors lattice colors, selections, panning/animation, and (if you have **Composer view** on in HKL) the scrolling score.

---

## Browser notes

- **Perform in Firefox.** Firefox allows a web page to talk to a local server without a permission prompt, so publishing just works.
- **On Chromium browsers** you'll get a one-time "access other apps and services on your network" prompt the first time the overlay host is running. Grant it. (If the host isn't running, nothing prompts.)
- The OBS Browser Source itself is its own embedded Chromium; it's read-only (no audio, MIDI, or input), so it can't disturb your performing instance, and opening it never changes your real HKL's settings.

---

## What it shows

- The **hex lattice**, transparent outside the keyboard outline, identical to your performing screen.
- The **Composer view** score (bars following each sounding voice), if you have Composer view enabled in HKL.

If you open the Browser Source mid-performance, it reconstructs the current state immediately: the relay remembers the latest of each kind of update.
