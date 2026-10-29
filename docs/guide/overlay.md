# OBS Overlay Guide

The OBS overlay puts HexKeyLab's live keyboard, and optionally its Composer-view score, **over a performance video in OBS, with a transparent background**. It mirrors your HKL screen as you play, so a stream or recording shows the keyboard lighting up over a camera shot of your hands.

A small local server, the overlay host, serves a read-only copy of HKL to OBS and relays your HKL screen to it.

---

## What you need

- **OBS**, or any tool that can add a Browser Source.
- **[Node](https://nodejs.org)** and **[pnpm](https://pnpm.io)**, with a clone of this repository and `pnpm install` run once at its root: the overlay host is built from source.
- An internet connection while you stream: the Composer view's engraving engine loads from the web.

---

## Setup

1. **Build and start the overlay host** from the repository root. Build once, then start it whenever you stream:

   ```bash
   pnpm overlay:dist     # build the overlay
   pnpm overlay:host     # start the overlay host on 127.0.0.1:5190
   ```

2. **Add a Browser Source in OBS** pointing at `http://127.0.0.1:5190/?overlay`, sized to your keyboard.

3. **Open, or reload, HKL in Firefox.** It finds the host and starts sending to it automatically. **Start the host first**: HKL looks for it only for about a second and a half after the page loads, so a tab opened before the host started has to be reloaded.

   In a Chromium browser, grant the one-time "access other apps and services on your network" prompt. A copy of HKL served from your own address must first be added to the host's allow-list (`HKL_FS_ORIGINS`, comma-separated).

4. **In HKL, turn Extend pattern off** (Layout tab), so the area around the keyboard's outline is transparent.

The overlay then shows the keyboard as on your screen (colors, keys you play, movement) and, with **Composer view** on in HKL, the scrolling score. A Browser Source opened mid-performance catches up at once.

### Score size

The overlay draws the score at **Composer's zoom** (`Shift+=` / `Shift+-` in Composer: 50, 75 or 100 %), so zoom Composer in if the staff is too small to read; the line breaks stay the same. HKL's own Composer-view strip stays at 50 %.

### Trimming a recording into a loop

If you record your performances in OBS, `tools/obs-trim/` in your clone of the repository cuts a take out of a session recording into a video, vertical or horizontal, that loops seamlessly on the beat. Its `README.md` covers what it needs and how to use it.

---

## If the overlay stays empty

**Reload the HKL tab.** That is nearly always the fix: an HKL tab opened before the host started has stopped looking for it. If that doesn't do it:

- Check that the host is running (`pnpm overlay:host`) on the expected port, `127.0.0.1:5190` by default. To use another port, start the host with `HKL_OVERLAY_PORT=<port>` (or the port as its first argument) **and** open HKL with `?obsrelay=<port>` in its address (or set `localStorage.hklOverlayPort`).
- The Browser Source URL must end in **`?overlay`**; without it you get the full HKL app.
- In a Chromium browser, the network-access prompt must have been granted.
- If only the score is missing, turn on **Composer view** in HKL.
- If the area around the keyboard is opaque, turn **Extend pattern** off in HKL.
