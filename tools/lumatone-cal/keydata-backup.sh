#!/usr/bin/env bash
# Save, verify or restore the Lumatone's stored calibration over SSH (run on the host).
#
#   keydata-backup.sh save [dir]            copy KeyData_1..5 + ThresholdData_1..5 off the device
#                                           (default dir: backups/keydata-<date>-<time>)
#   keydata-backup.sh verify <dir>          compare the device's files with a saved copy (read-only)
#   keydata-backup.sh check <dir>           check a folder's files are well formed (no device needed)
#   keydata-backup.sh restore <dir> [--thresholds]
#                                           write KeyData_1..5 (and, with --thresholds,
#                                           ThresholdData_1..5) back, sync, verify
#
# To set a key's thresholds by number: save, edit the value in the saved KeyData_N
# (keydata-locate.py names the file and slot), check, restore, power-cycle.
#
# KeyData_N holds the per-key thresholds (MAX / MIN / validity / AT-MAX), the only files the
# firmware's built-in key and aftertouch calibration rewrites when it is confirmed.
# ThresholdData_N holds the per-board thresholds and sensitivities (HKL's Calibrate Keys
# sliders). <dir> is any folder holding those files: one made by `save`, or the `files/`
# folder of a full device backup.
#
# Saved copies default to backups/ beside this script (gitignored), never the home directory.
#
# restore first saves what the device holds now (backups/before-restore-<date>-<time>), so
# it can be undone. The controller reads
# these files only when it starts: power-cycle the Lumatone after a restore. The restore
# ends with `sync` on the device; never cut power before it reports done (docs/lessons.md).
#
# Device address and login: LUMATONE_HOST (default 192.168.6.2, the USB-ethernet gadget as
# a Linux host sees it; 192.168.7.2 from macOS/Windows), LUMATONE_PASSWORD (default: the
# stock password).
set -euo pipefail

BACKUPS=$(cd "$(dirname "$0")" && pwd)/backups
HOST=${LUMATONE_HOST:-192.168.6.2}
PASS=${LUMATONE_PASSWORD:-temppwd}
KEYDATA=(KeyData_1 KeyData_2 KeyData_3 KeyData_4 KeyData_5)
THRESHOLDS=(ThresholdData_1 ThresholdData_2 ThresholdData_3 ThresholdData_4 ThresholdData_5)
# 1.5.0+ keeps the files under LumatoneController; older firmware under TerpstraController.
REMOTE_DIR='d=/home/debian/LumatoneController/files; [ -d "$d" ] || d=/home/debian/TerpstraController/files'

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

ASKPASS=$(mktemp)
trap 'rm -f "$ASKPASS"' EXIT
printf '#!/bin/sh\nprintf "%%s\\n" "$LUMATONE_SSH_PASS"\n' > "$ASKPASS"
chmod 700 "$ASKPASS"

# remote <command> — run a shell command on the device; stdin and stdout pass through.
remote() {
  LUMATONE_SSH_PASS=$PASS SSH_ASKPASS=$ASKPASS SSH_ASKPASS_REQUIRE=force \
    ssh -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR \
        -o PreferredAuthentications=password -o PubkeyAuthentication=no \
        "debian@$HOST" "$1"
}

# A calibration file is rows of comma-separated integers; refuse anything else.
# check_file <file> <rows> <values per row> [largest value]
check_file() {
  local f=$1 rows=$2 per=$3 top=${4:-}
  [ -f "$f" ] || { echo "missing: $f" >&2; exit 1; }
  [ "$(grep -c . "$f")" -eq "$rows" ] || { echo "$f: expected $rows rows" >&2; exit 1; }
  if grep -q -v -E '^[0-9]+(,[0-9]+)*,?[[:space:]]*$' "$f"; then echo "$f: not a calibration file" >&2; exit 1; fi
  # a hand edit that drops or doubles a value shifts every key after it
  awk -F, -v per="$per" -v top="$top" -v name="$f" '
    { n = NF; if ($NF ~ /^[[:space:]]*$/) n--
      if (n != per) { printf "%s: row %d holds %d values, expected %d\n", name, NR, n, per; bad = 1 }
      if (top != "") for (i = 1; i <= n; i++) if ($i + 0 > top + 0) {
        printf "%s: row %d, slot %d: %d is above %d\n", name, NR, i - 1, $i, top; bad = 1 } }
    END { exit bad }' "$f" >&2 || exit 1
}

# check_dir <dir> <with thresholds: 0|1> — KeyData is 4 rows × 56 keys, 0–254; ThresholdData 10 rows × 1.
check_dir() {
  local f
  for f in "${KEYDATA[@]}"; do check_file "$1/$f" 4 56 254; done
  if [ "$2" -eq 1 ]; then for f in "${THRESHOLDS[@]}"; do check_file "$1/$f" 10 1; done; fi
}

device_sums() { remote "$REMOTE_DIR; cd \"\$d\" && sha256sum $*"; }

save() {
  local dir=$1
  mkdir -p "$dir"
  remote "$REMOTE_DIR; cd \"\$d\" && tar cf - ${KEYDATA[*]} ${THRESHOLDS[*]}" | tar xf - -C "$dir"
  ( cd "$dir" && sha256sum "${KEYDATA[@]}" "${THRESHOLDS[@]}" > SHA256SUMS )
  # the copy must match what the device still holds
  diff <(device_sums "${KEYDATA[@]}" "${THRESHOLDS[@]}") "$dir/SHA256SUMS" > /dev/null \
    || { echo "saved copy does not match the device" >&2; exit 1; }
  echo "saved ${#KEYDATA[@]} KeyData + ${#THRESHOLDS[@]} ThresholdData files to $dir"
}

# verify <dir> <file...> — exit 1 when any file differs.
verify() {
  local dir=$1; shift
  local bad=0 seen=0 name sum
  while read -r sum name; do
    seen=$((seen + 1))
    if [ ! -f "$dir/$name" ]; then echo "  $name: not in $dir"; bad=1
    elif [ "$(sha256sum < "$dir/$name" | cut -d' ' -f1)" = "$sum" ]; then echo "  $name: same"
    else echo "  $name: DIFFERENT"; bad=1; fi
  done < <(device_sums "$@")
  # a device that did not answer for every file has verified nothing
  [ "$seen" -eq $# ] || { echo "  device answered for $seen of $# files" >&2; bad=1; }
  return $bad
}

cmd=${1:-}; [ -n "$cmd" ] || usage
shift
case $cmd in
  save)
    save "${1:-$BACKUPS/keydata-$(date +%Y%m%d-%H%M%S)}"
    ;;
  check)
    [ $# -eq 1 ] || usage
    if [ -f "$1/ThresholdData_1" ]; then check_dir "$1" 1; else check_dir "$1" 0; fi
    echo "$1 holds well-formed calibration files"
    ;;
  verify)
    [ $# -eq 1 ] || usage
    if verify "$1" "${KEYDATA[@]}" "${THRESHOLDS[@]}"; then echo "device matches $1"
    else echo "device differs from $1"; exit 1; fi
    ;;
  restore)
    [ $# -ge 1 ] || usage
    dir=$1; files=("${KEYDATA[@]}")
    case ${2:-} in
      '') ;;
      --thresholds) files+=("${THRESHOLDS[@]}") ;;
      *) usage ;;
    esac
    if [ ${#files[@]} -gt 5 ]; then check_dir "$dir" 1; else check_dir "$dir" 0; fi
    undo=$BACKUPS/before-restore-$(date +%Y%m%d-%H%M%S)
    save "$undo"
    stage=/tmp/keydata-restore.$$
    # -m: the device's clock restarts in 2018 at every boot, so saved mtimes can be "in the future" there
    tar cf - -C "$dir" "${files[@]}" | remote "rm -rf $stage && mkdir $stage && tar xmf - -C $stage"
    # the files are root's: copy over them in place (owner and mode stay), then flush to the eMMC
    printf '%s\n' "$PASS" | remote "$REMOTE_DIR; sudo -S -p '' sh -c 'cd $stage && cp ${files[*]} \"'\"\$d\"'\"/ && sync' && rm -rf $stage"
    if verify "$dir" "${files[@]}"; then
      echo "restored ${#files[@]} files from $dir and synced; the device's previous files are in $undo"
      echo "Power-cycle the Lumatone to load them."
    else
      echo "restore did not take: the device differs from $dir" >&2; exit 1
    fi
    ;;
  *) usage ;;
esac
