# Lumatone calibration scripts

Per-key threshold calibration tools that run on the Lumatone's internal BeagleBone via SSH. Used to set per-key thresholds by number, which the built-in touch-learning calibration can't do, and on firmware 1.4.x the only route on boards with broken macro buttons (1.5.0's SysEx `0x52` completes the built-in routine without them).

**Firmware status:** the on-device scripts (`keydata-live.py`, `lmtncal-read.py`, `lmtncal-poke.py`) target firmware 1.4.0: they look for a `TerpstraController` process and use 1.4.0's symbol offsets. On 1.5.0 they exit "not running" until the offsets are re-derived from `LumatoneController`; never just rename the process they look for. `keydata-locate.py` only reads `KeyData` files and works with either version.

**See `docs/lumatone-calibration.md` for the full guide** — installation, usage, internals, recovery.

## Files

| Script | Where it runs | Purpose |
|---|---|---|
| `keydata-live.py` | On the Lumatone (SSH) | Per-key live edits, bulk passes (`--bulk` / `--bulk-raise` / `--bulk-lower` / `--bulk-change`), and `--commit` to persist to disk. `--bulk-change <section> <from> <to>` is the rescue-preserving primitive for iterative MAX-raising. Full docstring at the top of the file. |
| `keydata-locate.py` | Local | Map (q, r) → file/slot, inspect values offline |
| `keydata-backup.sh` | Local (SSH to the Lumatone) | `save [dir]` copies `KeyData_1..5` + `ThresholdData_1..5` off the device; `verify <dir>` compares the device with a saved copy (read-only); `restore <dir> [--thresholds]` writes them back, syncs and verifies (it first saves what the device holds; power-cycle afterwards). Works on any firmware. Take a `save` before confirming a built-in calibration from HKL's Calibrate Keys. |
| `pic18dis.py` | Local | Minimal PIC18 disassembler for the octave-board image (`LMTN-01_OctaveBoard*.hex`, a PIC18F6xK22): `python3 pic18dis.py image.hex > out.asm`. How the calibration routine and key diagnostic display in docs/lessons.md were read. |
| `KeyData_default` | — | Project baseline file (MAX=70, MIN=0, valid=1, AT_MAX=200) for seeding all 5 boards. Used by the Phase 0 step of the calibration workflow. |
| `lmtncal-read.py` | On the Lumatone (SSH) | Diagnostic state dump of TC firmware internals |
| `lmtncal-poke.py` | On the Lumatone (SSH) | **Obsolete.** Earlier attempt to spoof macro-button completion — doesn't work because the PIC firmware blocks at hardware-event level; on 1.5.0, SysEx `0x52` does this properly. Kept for diagnostic reference; do not use for calibration. |
| `reset-calibration.sh` | Local | Send SysEx commands to factory-reset velocity/AT/Lumatouch LUTs and per-board thresholds. Does NOT touch per-key KeyData. |
