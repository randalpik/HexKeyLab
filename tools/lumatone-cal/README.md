# Lumatone calibration tools

Host-side tools for the Lumatone's stored key calibration: save, verify and restore the per-key and per-board files over SSH, find a key's values in them, and read the octave-board firmware. Calibration itself runs from HKL's Calibrate Keys overlay (the firmware's built-in routine, firmware 1.5.0+); these tools back it up and set values by number where the learned ones aren't right.

**See `docs/lumatone-calibration.md` for the full guide** — internals, workflow, recovery.

## Files

| File | Where it runs | Purpose |
|---|---|---|
| `keydata-backup.sh` | Local (SSH to the Lumatone) | `save [dir]` copies `KeyData_1..5` + `ThresholdData_1..5` off the device; `verify <dir>` compares the device with a saved copy (read-only); `check <dir>` checks a folder is well formed (no device needed; run it after a hand edit); `restore <dir> [--thresholds]` writes them back, syncs and verifies (it runs the check and saves what the device holds first; power-cycle afterwards). Works on any firmware. Take a `save` before confirming a built-in calibration. |
| `keydata-locate.py` | Local | Map (q, r) → file and slot, and print the key's values from a saved folder. `--swap-boards-34` on a unit with boards 3 and 4 swapped. |
| `KeyData_default` | — | Uniform baseline file (MAX=70, MIN=0, valid=1, AT_MAX=200) for seeding a board that has no usable calibration. |
| `pic18dis.py` | Local | Minimal PIC18 disassembler for the octave-board image (`LMTN-01_OctaveBoard*.hex`, a PIC18F6xK22): `python3 pic18dis.py image.hex > out.asm`. How the calibration routine and key diagnostic display in docs/lessons.md were read. |

Saved copies go to `backups/` in this folder by default (gitignored; `save` → `backups/keydata-<date>-<time>`, the copy `restore` takes first → `backups/before-restore-<date>-<time>`).

`tools/reset-calibration.sh` (one folder up) sends the SysEx factory resets for the velocity/AT/Lumatouch LUTs and per-board thresholds. It does not touch per-key KeyData.

## Retired

`keydata-live.py` (live per-key edits in the running controller's memory), `lmtncal-read.py` (state dump) and `lmtncal-poke.py` (a failed macro-button spoof) were removed on 2026-11-11. They targeted firmware 1.4.0's binary and existed because the built-in calibration could not be finished without macro buttons; firmware 1.5.0's SysEx `0x52` ends it from software. They are in git history (`git log -- tools/lumatone-cal/keydata-live.py`); a port must re-derive every address from the installed binary.
