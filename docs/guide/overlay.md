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

3. **Now open (or reload) the normal HKL page in Firefox** (the hosted/production HKL is fine). Publishing to the overlay starts **automatically**; there's no checkbox.

   **The order of steps 1 and 3 matters.** HKL looks for the overlay host once, a second or so after the page loads, and if nothing answers it stops looking for the rest of that page's life. Starting the host afterwards won't wake it up — only reloading the HKL tab will. So: **host first, then HKL.** If your HKL tab was already open, just reload it.

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

### Score size on the overlay

The overlay draws the score at **Composer's current zoom** (`Shift`+`=` / `Shift`+`-` in Composer:
50 %, 75 %, 100 %) — so if the staff is too small to read in a tall portrait capture, zoom Composer in and
the overlay follows immediately. HKL's own Composer-view strip stays at 50 % regardless; there's no
room for more in the bar under the lattice, so the two sizes are independent by design. Zooming only
magnifies — the score keeps exactly the same bar layout and line breaks at every level.

If you open the Browser Source mid-performance, it reconstructs the current state immediately: the relay remembers the latest of each kind of update.

---

## If the overlay stays empty

**Reload the performing HKL tab first.** This is nearly always it. HKL only tries to reach the overlay host briefly at page load, so any HKL tab that was open *before* you started the host has quietly given up; the Browser Source will keep showing nothing no matter what you play. Reloading HKL — with the host already running — fixes it.

This is easy to misread, because the two halves fail differently. The Browser Source keeps retrying forever and reconnects on its own, so once it has worked it stays working, and a host restart alone looks harmless. The performing tab is the fragile side, and the tab most likely to have been open for hours is a **development** one (`localhost:5170`) — which is why it can look like the overlay "only works with the published version" when in fact both are treated identically. It's the page load, not the address, that matters.

Everything else worth checking, if a reload didn't do it:

- The host is actually running (`pnpm overlay:host`) and on the expected port — `127.0.0.1:5190` unless you changed it.
- Your Browser Source URL ends in **`?overlay`**. Without it you'll get the full HKL app, not the transparent mirror.
- On a Chromium-based browser, you granted the one-time "access other apps and services on your network" prompt.
- **Composer view** is toggled on in HKL, if the score is the part that's missing (the lattice and the score are independent).
