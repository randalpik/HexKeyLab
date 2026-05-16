# Lumatone calibration scripts

Per-key threshold calibration tools that run on the Lumatone's internal BeagleBone via SSH. Used to dial in keys that the built-in macro-button-driven calibration can't reach (e.g., boards with broken macro buttons).

**See `docs/lumatone-calibration.md` for the full guide** — installation, usage, internals, recovery.

## Files

| Script | Where it runs | Purpose |
|---|---|---|
| `keydata-live.py` | On the Lumatone (SSH) | Live per-key threshold editing + commit to disk |
| `keydata-locate.py` | Local | Map (q, r) → file/slot, inspect values offline |
| `lmtncal-read.py` | On the Lumatone (SSH) | Diagnostic state dump of TC firmware internals |
| `lmtncal-poke.py` | On the Lumatone (SSH) | **Obsolete.** Earlier attempt to spoof macro-button completion — doesn't work because the PIC firmware blocks at hardware-event level. Kept for diagnostic reference; do not use for calibration. |
| `reset-calibration.sh` | Local | Send SysEx commands to factory-reset velocity/AT/Lumatouch LUTs and per-board thresholds. Does NOT touch per-key KeyData. |
