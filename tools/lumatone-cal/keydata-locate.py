#!/usr/bin/env python3
# keydata-locate — given a lattice (q, r) coordinate, identify which KeyData_N
# file and which comma-slot in each section holds that key's calibration bytes,
# and print the current values.
#
# Usage:
#   python3 keydata-locate.py <q> <r> [KEYDATA_DIR]
#
# Defaults KEYDATA_DIR to ./files (i.e. run from /home/max/lumatone/TerpstraController).
#
# The (q, r) coordinates match HKL's baseKeys. Toggle "coords" in HKL to see
# them on the canvas.

from __future__ import print_function
import os
import sys

# 280-element baseKeys table — taken from src/layout/baseKeys.ts. The order
# defines key indices 0..279. board_group = idx / 56, key_index_within_board = idx % 56.
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

# board_group → SysEx board (Max's unit has boards 3 & 4 physically swapped)
SYSEX_BOARD_MAP = [1, 2, 3, 5, 4]

SECTION_NAMES = [
    'MAX threshold (1=trigger near rest, larger=lighter touch registers)',
    'MIN threshold (onset detection — usually 0-5)',
    'Validity (0=disabled, 1=active)',
    'AT MAX threshold (aftertouch trigger)',
]


def find_key(q, r):
    for idx, (kq, kr) in enumerate(BASE_KEYS):
        if kq == q and kr == r:
            return idx
    return None


def parse_section(line):
    return [int(x) for x in line.strip().split(',')]


def main():
    if len(sys.argv) < 3:
        sys.exit('Usage: keydata-locate.py <q> <r> [KEYDATA_DIR]')
    q = int(sys.argv[1])
    r = int(sys.argv[2])
    keydata_dir = sys.argv[3] if len(sys.argv) > 3 else './files'

    idx = find_key(q, r)
    if idx is None:
        sys.exit('No key found at (q={0}, r={1})'.format(q, r))

    board_group = idx // 56
    key_in_board = idx % 56
    sysex_board = SYSEX_BOARD_MAP[board_group]
    print('Key (q={0}, r={1}):'.format(q, r))
    print('  baseKeys global index : {0}'.format(idx))
    print('  Board group (0..4)    : {0}'.format(board_group))
    print('  SysEx board (1..5)    : {0}'.format(sysex_board))
    print('  Key index in board    : {0}'.format(key_in_board))
    print('  KeyData file          : KeyData_{0}'.format(sysex_board))
    print('  Comma slot (0-indexed): {0}'.format(key_in_board))
    print('')

    # Try to load and print current values
    path = os.path.join(keydata_dir, 'KeyData_{0}'.format(sysex_board))
    if not os.path.exists(path):
        print('(KeyData file not found at {0}; pass dir as 3rd arg to inspect values)'.format(path))
        return
    with open(path) as f:
        lines = f.readlines()
    if len(lines) < 4:
        sys.exit('KeyData file looks malformed (expected 4 lines, got {0})'.format(len(lines)))
    print('Current values for this key:')
    for i, name in enumerate(SECTION_NAMES):
        vals = parse_section(lines[i])
        if key_in_board >= len(vals):
            print('  Section {0} ({1}): MISSING (line has {2} values)'.format(
                i + 1, name, len(vals)))
            continue
        print('  Section {0} ({1})'.format(i + 1, name))
        print('    value: {0}'.format(vals[key_in_board]))


if __name__ == '__main__':
    main()
