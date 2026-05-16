#!/usr/bin/env python3
# lmtncal-poke — spoof the macro-button "calibration complete" signal for
# Lumatone boards whose macro buttons are broken/disconnected.
#
# Run as root, on the Lumatone's BeagleBone, *while TerpstraController is in
# calibration mode* (i.e., after the host has sent SysEx 0x24).
#
# Writes two memory locations in the running TerpstraController process:
#   1. picMessage0Flag[i] |= 0x4000000 — pretends the PIC sent subtype-4
#      completion notification, which writeToPic will later see and respond
#      to by calling getAftertouchMaxPic(boardId).
#   2. enum_octave.9065[i] = 1 — marks board i's kbd-mode transition as done,
#      so setKeyboardMode's loop will see all 5 entries true and fire the
#      calibration-complete cascade once macros on remaining boards arrive.
#
# After running this, the user must press the WORKING macro buttons on boards
# 2 and 3 (or whichever still work). When those real macro events arrive, the
# BBB's setKeyboardMode loop sees all 5 board flags = 1 and the cascade fires,
# causing writeToPic to query every PIC's thresholds and persist them to
# KeyData_1..5 files on the BBB filesystem.
#
# Addresses are nm-offsets from the PIE binary. Live addresses are
# (load_base + offset) where load_base comes from /proc/<pid>/maps.
#
# CAUTION: writing to /proc/<pid>/mem of a live process can crash it. If TC
# crashes, the launcher script restarts it. Power-cycle if anything looks
# wrong. Only run this when in calibration mode (otherwise the bit-flips are
# nonsense state).

import os
import struct
import subprocess
import sys

# Symbol vaddrs from `nm TerpstraController`. Verified by disassembly of
# decodePicMessage+0x171c and setKeyboardMode.
PIC_MESSAGE0_FLAG = 0x2fe48   # 5 × uint32_t array (.bss)
ENUM_OCTAVE_9065  = 0x2e4c8   # 5 × uint8_t array (.bss)
COMPLETION_BIT    = 0x04000000

# Board indices to spoof. 0-based. Boards 1, 4, 5 (= indices 0, 3, 4) have
# broken macro buttons on Max's unit. Override via argv to test single boards.
DEFAULT_SPOOF = [0, 3, 4]


def find_tc_pid():
    # subprocess.run capture_output= and text= are Python 3.7+; use the older
    # universal_newlines + stdout=PIPE form so this works on Debian 9's 3.5.
    out = subprocess.run(['pidof', 'TerpstraController'],
                         stdout=subprocess.PIPE,
                         universal_newlines=True)
    pids = out.stdout.split()
    if not pids:
        sys.exit('TerpstraController not running')
    # pidof prints newest first; the long-lived one is the highest PID returned
    # (in our case there's only one — the launcher invokes it foreground)
    return int(pids[0])


def find_load_base(pid):
    """Find the first mapping of the TerpstraController executable."""
    base = None
    with open('/proc/{0}/maps'.format(pid)) as f:
        for line in f:
            if 'TerpstraController' not in line:
                continue
            # Lowest-addr mapping of the binary = PIE load base
            start = int(line.split('-')[0], 16)
            if base is None or start < base:
                base = start
    if base is None:
        sys.exit('Could not find TerpstraController mapping in /proc/{0}/maps'.format(pid))
    return base


def main():
    spoof = DEFAULT_SPOOF
    if len(sys.argv) > 1:
        # Allow override: ./lmtncal-poke 0 3 4
        spoof = [int(x) for x in sys.argv[1:]]
        for i in spoof:
            if i < 0 or i > 4:
                sys.exit('Board index out of range: {0} (must be 0..4)'.format(i))

    pid = find_tc_pid()
    base = find_load_base(pid)
    sys.stderr.write('TerpstraController pid={0} load_base=0x{1:x}\n'.format(pid, base))
    sys.stderr.write('Spoofing board indices: {0}\n'.format(spoof))

    mem_path = '/proc/{0}/mem'.format(pid)
    fd = os.open(mem_path, os.O_RDWR)
    try:
        for i in spoof:
            # picMessage0Flag[i] |= COMPLETION_BIT
            addr = base + PIC_MESSAGE0_FLAG + i * 4
            os.lseek(fd, addr, os.SEEK_SET)
            cur = struct.unpack('<I', os.read(fd, 4))[0]
            new = cur | COMPLETION_BIT
            os.lseek(fd, addr, os.SEEK_SET)
            os.write(fd, struct.pack('<I', new))
            sys.stderr.write('  picMessage0Flag[{0}] @ 0x{1:x}: '
                             '0x{2:08x} -> 0x{3:08x}\n'.format(i, addr, cur, new))

            # enum_octave.9065[i] = 1
            addr = base + ENUM_OCTAVE_9065 + i
            os.lseek(fd, addr, os.SEEK_SET)
            cur_b = os.read(fd, 1)[0]
            os.lseek(fd, addr, os.SEEK_SET)
            os.write(fd, b'\x01')
            sys.stderr.write('  enum_octave.9065[{0}] @ 0x{1:x}: '
                             '0x{2:02x} -> 0x01\n'.format(i, addr, cur_b))
    finally:
        os.close(fd)

    sys.stderr.write('Done. Now press macro buttons on the working boards (2 & 3) '
                     'to trigger the cascade.\n')


if __name__ == '__main__':
    main()
