#!/usr/bin/env bash
# Reset Lumatone velocity, aftertouch, and per-board thresholds to factory defaults.
# Uses amidi (ALSA). Pass the MIDI port as $1, or it will auto-detect "Lumatone".
#
# SysEx envelope: F0 00 21 50 <board> <cmd> F7
#   0x0A RESET_VELOCITY_CONFIG     (board 0)
#   0x12 RESET_AFTERTOUCH_CONFIG   (board 0)
#   0x34 RESET_BOARD_THRESHOLDS    (boards 1..5)

set -euo pipefail

PORT="${1:-}"
if [[ -z "$PORT" ]]; then
  PORT=$(amidi -l | awk '/Lumatone/ {print $2; exit}')
fi
if [[ -z "$PORT" ]]; then
  echo "No Lumatone MIDI port found. Run 'amidi -l' and pass the hw:X,Y,Z id as \$1." >&2
  exit 1
fi
echo "Using port: $PORT"

send() {
  local label="$1"; shift
  local bytes="$*"
  echo "  -> $label : $bytes"
  amidi -p "$PORT" -S "$bytes"
  sleep 0.15
}

echo "Reset velocity LUT"
send "0x0A RESET_VELOCITY_CONFIG"   F0 00 21 50 00 0A F7

echo "Reset aftertouch LUT"
send "0x12 RESET_AFTERTOUCH_CONFIG" F0 00 21 50 00 12 F7

echo "Reset board thresholds + CC/AT sensitivity (boards 1..5)"
for board in 01 02 03 04 05; do
  send "0x34 RESET_BOARD_THRESHOLDS board=$board" F0 00 21 50 $board 34 F7
done

echo "Done."
