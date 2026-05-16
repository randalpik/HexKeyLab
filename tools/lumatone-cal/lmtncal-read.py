#!/usr/bin/env python3
# lmtncal-read — diagnostic. Reads the two arrays we care about without
# modifying anything. Use to verify:
#   - That the helper's pokes are still in place
#   - Whether real macro presses on boards 2/3 also set the same bits/flags
#     (and thus whether we have the right state model)

import os
import struct
import subprocess
import sys

PIC_MESSAGE0_FLAG = 0x2fe48   # 5 × uint32_t array
ENUM_OCTAVE_9065  = 0x2e4c8   # 5 × uint8_t array
ENUM_OCTAVE_9074  = 0x2e4d0   # 5 × uint8_t — alternate candidate
ENUM_OCTAVE_9083  = 0x2e4d8   # 5 × uint8_t — alternate candidate
CLOCK_START_FLAG  = 0x2e498   # 5 × uint32_t — checkboardtime gate
LMTN_STATE        = 0x2f8ec   # uint32_t — keyboard mode state


def find_tc_pid():
    out = subprocess.run(['pidof', 'TerpstraController'],
                         stdout=subprocess.PIPE, universal_newlines=True)
    pids = out.stdout.split()
    if not pids:
        sys.exit('TerpstraController not running')
    return int(pids[0])


def find_load_base(pid):
    base = None
    with open('/proc/{0}/maps'.format(pid)) as f:
        for line in f:
            if 'TerpstraController' not in line:
                continue
            start = int(line.split('-')[0], 16)
            if base is None or start < base:
                base = start
    if base is None:
        sys.exit('Could not find TerpstraController mapping')
    return base


def main():
    pid = find_tc_pid()
    base = find_load_base(pid)
    sys.stderr.write('TerpstraController pid={0} load_base=0x{1:x}\n'.format(pid, base))

    fd = os.open('/proc/{0}/mem'.format(pid), os.O_RDONLY)
    try:
        # picMessage0Flag — 5 × uint32_t
        os.lseek(fd, base + PIC_MESSAGE0_FLAG, os.SEEK_SET)
        data = os.read(fd, 20)
        flags = struct.unpack('<5I', data)
        print('picMessage0Flag (each shown hex; bit 0x4000000 = completion):')
        for i, v in enumerate(flags):
            marker = '  <-- has 0x4000000' if (v & 0x04000000) else ''
            print('  board {0} [{1}]: 0x{2:08x}{3}'.format(i + 1, i, v, marker))

        # Three enum_octave arrays — print all in case I picked the wrong one
        for label, off in [('enum_octave.9065', ENUM_OCTAVE_9065),
                           ('enum_octave.9074', ENUM_OCTAVE_9074),
                           ('enum_octave.9083', ENUM_OCTAVE_9083)]:
            os.lseek(fd, base + off, os.SEEK_SET)
            data = os.read(fd, 5)
            vals = struct.unpack('<5B', data)
            print('{0}: {1}'.format(label, list(vals)))

        # clockStartFlag — writeToPic skips boards where this is non-zero
        os.lseek(fd, base + CLOCK_START_FLAG, os.SEEK_SET)
        data = os.read(fd, 20)
        vals = struct.unpack('<5I', data)
        print('clockStartFlag (non-zero = writeToPic skips that board):')
        for i, v in enumerate(vals):
            marker = '  <-- non-zero, BLOCKS writeToPic' if v else ''
            print('  board {0} [{1}]: 0x{2:08x}{3}'.format(i + 1, i, v, marker))

        # lmtn_state (overall keyboard mode)
        os.lseek(fd, base + LMTN_STATE, os.SEEK_SET)
        v = struct.unpack('<I', os.read(fd, 4))[0]
        print('lmtn_state: 0x{0:08x} ({1})'.format(
            v, 'normal mode' if v == 0 else 'in non-normal mode (e.g. cal)'))
    finally:
        os.close(fd)


if __name__ == '__main__':
    main()
