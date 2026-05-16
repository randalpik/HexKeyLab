#!/usr/bin/env python3
# keydata-live — set a single key's threshold value live, no reboot.
#
# Usage:
#   sudo python3 keydata-live.py <q> <r> <section> <value>
#       q, r       — lattice coordinates (use HKL coords toggle to find these)
#       section    — 1=MAX, 2=MIN, 3=validity, 4=AT_MAX
#       value      — 0-254 (or 0/1 for section 3)
#
#   sudo python3 keydata-live.py --read <q> <r>
#       Read current in-memory values for that key without modifying.
#
#   sudo python3 keydata-live.py --commit
#       After you've dialed in values you like via repeated live edits, this
#       writes the current in-memory state back to KeyData_N files on disk so
#       changes survive a power cycle.
#
# Mechanism: writes to /proc/<TerpstraController pid>/mem at the in-memory
# kbd_preset_params byte for this key+section, then sets the corresponding
# bit in picMessage0Flag[boardId-1] so writeToPic dispatches the section to
# the PIC on its next main-loop tick (sub-millisecond).
#
# NB: in-memory changes are volatile. Run --commit to persist.

from __future__ import print_function
import os
import struct
import subprocess
import sys

# Symbol vaddrs from `nm TerpstraController`
PIC_MESSAGE0_FLAG = 0x2fe48  # 5 × uint32_t
GOT_KBD_PRESET_OFFSET = 0x128  # offset within GOT pointing to kbd_preset_params base
GOT_BASE = 0x2e000

# Per-board struct stride and section offsets (verified by disassembly of
# setMaxPic/setMinPic/setValidPic/setAftertouchMaxPic).
BOARD_STRIDE = 638
SECTION_OFFSETS = {
    1: 0x118,   # MAX
    2: 0x150,   # MIN
    3: 0x1c0,   # validity
    4: 0x1fe,   # AT MAX
}
SECTION_BITS = {
    1: 0x1,
    2: 0x2,
    3: 0x4000,
    4: 0x40000,
}
SECTION_NAMES = {1: 'MAX', 2: 'MIN', 3: 'validity', 4: 'AT_MAX'}

# board_group → SysEx board (Max's unit has boards 3 & 4 swapped)
SYSEX_BOARD_MAP = [1, 2, 3, 5, 4]

# 280-element baseKeys table (from src/layout/baseKeys.ts).
BASE_KEYS = [
    (-19,9),(-18,9),(-18,8),(-17,8),(-16,8),(-15,8),(-14,8),(-18,7),(-17,7),(-16,7),
    (-15,7),(-14,7),(-13,7),(-17,6),(-16,6),(-15,6),(-14,6),(-13,6),(-12,6),(-17,5),
    (-16,5),(-15,5),(-14,5),(-13,5),(-12,5),(-16,4),(-15,4),(-14,4),(-13,4),(-12,4),
    (-11,4),(-16,3),(-15,3),(-14,3),(-13,3),(-12,3),(-11,3),(-15,2),(-14,2),(-13,2),
    (-12,2),(-11,2),(-10,2),(-15,1),(-14,1),(-13,1),(-12,1),(-11,1),(-10,1),(-13,0),
    (-12,0),(-11,0),(-10,0),(-9,0),(-10,-1),(-9,-1),
    (-12,7),(-11,7),(-11,6),(-10,6),(-9,6),(-8,6),(-7,6),(-11,5),(-10,5),(-9,5),(-8,5),
    (-7,5),(-6,5),(-10,4),(-9,4),(-8,4),(-7,4),(-6,4),(-5,4),(-10,3),(-9,3),(-8,3),(-7,3),
    (-6,3),(-5,3),(-9,2),(-8,2),(-7,2),(-6,2),(-5,2),(-4,2),(-9,1),(-8,1),(-7,1),(-6,1),
    (-5,1),(-4,1),(-8,0),(-7,0),(-6,0),(-5,0),(-4,0),(-3,0),(-8,-1),(-7,-1),(-6,-1),(-5,-1),
    (-4,-1),(-3,-1),(-6,-2),(-5,-2),(-4,-2),(-3,-2),(-2,-2),(-3,-3),(-2,-3),
    (-5,5),(-4,5),(-4,4),(-3,4),(-2,4),(-1,4),(0,4),(-4,3),(-3,3),(-2,3),(-1,3),(0,3),(1,3),
    (-3,2),(-2,2),(-1,2),(0,2),(1,2),(2,2),(-3,1),(-2,1),(-1,1),(0,1),(1,1),(2,1),(-2,0),
    (-1,0),(0,0),(1,0),(2,0),(3,0),(-2,-1),(-1,-1),(0,-1),(1,-1),(2,-1),(3,-1),(-1,-2),
    (0,-2),(1,-2),(2,-2),(3,-2),(4,-2),(-1,-3),(0,-3),(1,-3),(2,-3),(3,-3),(4,-3),(1,-4),
    (2,-4),(3,-4),(4,-4),(5,-4),(4,-5),(5,-5),
    (2,3),(3,3),(3,2),(4,2),(5,2),(6,2),(7,2),(3,1),(4,1),(5,1),(6,1),(7,1),(8,1),(4,0),
    (5,0),(6,0),(7,0),(8,0),(9,0),(4,-1),(5,-1),(6,-1),(7,-1),(8,-1),(9,-1),(5,-2),(6,-2),
    (7,-2),(8,-2),(9,-2),(10,-2),(5,-3),(6,-3),(7,-3),(8,-3),(9,-3),(10,-3),(6,-4),(7,-4),
    (8,-4),(9,-4),(10,-4),(11,-4),(6,-5),(7,-5),(8,-5),(9,-5),(10,-5),(11,-5),(8,-6),(9,-6),
    (10,-6),(11,-6),(12,-6),(11,-7),(12,-7),
    (9,1),(10,1),(10,0),(11,0),(12,0),(13,0),(14,0),(10,-1),(11,-1),(12,-1),(13,-1),(14,-1),
    (15,-1),(11,-2),(12,-2),(13,-2),(14,-2),(15,-2),(16,-2),(11,-3),(12,-3),(13,-3),(14,-3),
    (15,-3),(16,-3),(12,-4),(13,-4),(14,-4),(15,-4),(16,-4),(17,-4),(12,-5),(13,-5),(14,-5),
    (15,-5),(16,-5),(17,-5),(13,-6),(14,-6),(15,-6),(16,-6),(17,-6),(18,-6),(13,-7),(14,-7),
    (15,-7),(16,-7),(17,-7),(18,-7),(15,-8),(16,-8),(17,-8),(18,-8),(19,-8),(18,-9),(19,-9),
]

KEYDATA_DIR = '/home/debian/TerpstraController/files'


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


def find_kbd_preset_base(fd, load_base):
    """Resolve the runtime address of kbd_preset_params via the GOT."""
    got_addr = load_base + GOT_BASE + GOT_KBD_PRESET_OFFSET
    os.lseek(fd, got_addr, os.SEEK_SET)
    return struct.unpack('<I', os.read(fd, 4))[0]


def find_key(q, r):
    for idx, (kq, kr) in enumerate(BASE_KEYS):
        if kq == q and kr == r:
            return idx
    return None


def open_mem(pid):
    return os.open('/proc/{0}/mem'.format(pid), os.O_RDWR)


def cmd_read(q, r):
    idx = find_key(q, r)
    if idx is None:
        sys.exit('No key at (q={0}, r={1})'.format(q, r))
    board_group = idx // 56
    key_in_board = idx % 56
    sysex_board = SYSEX_BOARD_MAP[board_group]
    mem_slot = sysex_board - 1   # in-memory kbd_preset_params slot

    pid = find_tc_pid()
    base = find_load_base(pid)
    fd = open_mem(pid)
    try:
        kbd_base = find_kbd_preset_base(fd, base)
        sys.stderr.write('pid={0} load_base=0x{1:x} kbd_preset_base=0x{2:x}\n'.format(
            pid, base, kbd_base))
        print('Key (q={0}, r={1}): board_group={2} sysex_board={3} (mem_slot={4}) '
              'key_in_board={5}'.format(q, r, board_group, sysex_board, mem_slot, key_in_board))
        for section in (1, 2, 3, 4):
            addr = kbd_base + mem_slot * BOARD_STRIDE + SECTION_OFFSETS[section] + key_in_board
            os.lseek(fd, addr, os.SEEK_SET)
            v = os.read(fd, 1)[0]
            print('  section {0} ({1:<8}) live value: {2} (0x{2:02x}) at 0x{3:x}'.format(
                section, SECTION_NAMES[section], v, addr))
    finally:
        os.close(fd)


def cmd_set(q, r, section, value):
    idx = find_key(q, r)
    if idx is None:
        sys.exit('No key at (q={0}, r={1})'.format(q, r))
    if section not in SECTION_OFFSETS:
        sys.exit('Section must be 1, 2, 3, or 4')
    if section == 3:
        if value not in (0, 1):
            sys.exit('Validity (section 3) must be 0 or 1')
    else:
        if value < 0 or value > 254:
            sys.exit('Value must be 0..254')

    board_group = idx // 56
    key_in_board = idx % 56
    sysex_board = SYSEX_BOARD_MAP[board_group]
    mem_slot = sysex_board - 1   # in-memory kbd_preset_params and picMessage0Flag slot

    pid = find_tc_pid()
    base = find_load_base(pid)
    fd = open_mem(pid)
    try:
        kbd_base = find_kbd_preset_base(fd, base)
        # Update the byte
        addr = kbd_base + mem_slot * BOARD_STRIDE + SECTION_OFFSETS[section] + key_in_board
        os.lseek(fd, addr, os.SEEK_SET)
        cur = os.read(fd, 1)[0]
        os.lseek(fd, addr, os.SEEK_SET)
        os.write(fd, bytes([value]))
        # Set the bit in picMessage0Flag[mem_slot] to trigger PIC push
        flag_addr = base + PIC_MESSAGE0_FLAG + mem_slot * 4
        os.lseek(fd, flag_addr, os.SEEK_SET)
        flag_cur = struct.unpack('<I', os.read(fd, 4))[0]
        flag_new = flag_cur | SECTION_BITS[section]
        os.lseek(fd, flag_addr, os.SEEK_SET)
        os.write(fd, struct.pack('<I', flag_new))
        sys.stderr.write(
            'spatial board {0} (sysex_board={1}, mem_slot={2}) key {3} (q={4},r={5}) '
            'section {6} ({7}): {8} -> {9}\n'.format(
                board_group + 1, sysex_board, mem_slot, key_in_board,
                q, r, section, SECTION_NAMES[section], cur, value))
        sys.stderr.write('  picMessage0Flag[{0}]: 0x{1:08x} -> 0x{2:08x} '
                         '(dispatches section to PIC within ~1 main-loop tick)\n'.format(
            mem_slot, flag_cur, flag_new))
    finally:
        os.close(fd)


def cmd_commit():
    """Read current in-memory state for all 5 PIC slots and write to KeyData_N files.
       Memory slot i loads from KeyData_(i+1) at boot, so we iterate by slot directly
       and write each slot back to its matching file name. No physical-swap mapping
       involved at this layer."""
    pid = find_tc_pid()
    base = find_load_base(pid)
    fd = open_mem(pid)
    try:
        kbd_base = find_kbd_preset_base(fd, base)
        sys.stderr.write('Reading in-memory state and writing to {0}\n'.format(KEYDATA_DIR))
        for mem_slot in range(5):
            sysex_board = mem_slot + 1  # KeyData_(slot+1) maps to memory slot
            board_base = kbd_base + mem_slot * BOARD_STRIDE
            sections = []
            for section in (1, 2, 3, 4):
                os.lseek(fd, board_base + SECTION_OFFSETS[section], os.SEEK_SET)
                vals = list(os.read(fd, 56))
                sections.append(vals)
            path = '{0}/KeyData_{1}'.format(KEYDATA_DIR, sysex_board)
            content = '\n'.join(','.join(str(v) for v in s) for s in sections) + '\n'
            # Back up first (only on first commit)
            bak = path + '.bak'
            if os.path.exists(path) and not os.path.exists(bak):
                with open(path, 'rb') as f: orig = f.read()
                with open(bak, 'wb') as f: f.write(orig)
            with open(path, 'w') as f:
                f.write(content)
            sys.stderr.write('  wrote KeyData_{0} ({1} bytes)\n'.format(sysex_board, len(content)))
    finally:
        os.close(fd)


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit('Usage:\n'
                 '  set:    sudo python3 keydata-live.py <q> <r> <section 1-4> <value>\n'
                 '  read:   sudo python3 keydata-live.py --read <q> <r>\n'
                 '  commit: sudo python3 keydata-live.py --commit')
    if args[0] == '--read':
        if len(args) != 3: sys.exit('--read needs <q> <r>')
        cmd_read(int(args[1]), int(args[2]))
    elif args[0] == '--commit':
        cmd_commit()
    else:
        if len(args) != 4: sys.exit('set needs <q> <r> <section> <value>')
        cmd_set(int(args[0]), int(args[1]), int(args[2]), int(args[3]))


if __name__ == '__main__':
    main()
