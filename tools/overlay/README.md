# overlay — rebuild + restart the OBS overlay host

`tools/overlay/hkloverlay` rebuilds the lean overlay bundle and restarts the `hkl-overlay-host`
systemd user service, then verifies the result. Install it on `PATH` once:

```bash
ln -s ~/HexKeyLab/tools/overlay/hkloverlay ~/.local/bin/hkloverlay
```

```bash
hkloverlay       # pnpm overlay:dist + systemctl --user restart hkl-overlay-host + verify
hkloverlay -b    # rebuild only — enough for overlay code changes
hkloverlay -r    # restart only — enough for apps/overlay-host/src edits
hkloverlay -n    # print the commands instead of running them
```

Which half you need: the host's static server reads `embedded/` per request (`index.html` is
`no-cache`), so a rebuild is live without a restart; only host code, `HKL_OVERLAY_PORT` / `HKL_FS_*`
and picker changes (read once at startup) need the restart. Either way, the OBS Browser Source keeps
the old JS until it's refreshed.

Verification, after either half:
- the overlay page answers at `http://127.0.0.1:$port/?overlay` (polled ~5 s — `restart` returns once
  node is spawned, not once it listens);
- the unit is active, and the port's listener PID is the unit's `MainPID` (not a hand-started host);
- the served `index.html` names the same hashed entry as `apps/overlay-host/embedded/index.html`.

On failure it prints the unit's journal since the restart (or its last 30 lines) and exits 1. A failed
build exits before anything is touched: `overlay:dist` builds into `apps/hkl/dist-overlay/` first and
only then copies into `embedded/`.

A restart drops every relay socket. The OBS page and an already-connected performing tab reconnect on
their own (500 ms backoff, capped at 5 s); Composer file-bridge dialogs or saves in flight are lost.
Service details: [docs/architecture/overlay.md](../../docs/architecture/overlay.md) → Running it.
