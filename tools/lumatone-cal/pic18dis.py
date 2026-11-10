#!/usr/bin/env python3
"""Minimal PIC18 disassembler for Intel HEX images (XC8 output).
usage: pic18dis.py image.hex > out.asm
Addresses are byte addresses (as in MPLAB listings)."""
import sys


def load_hex(path):
    mem = {}
    upper = 0
    for line in open(path):
        line = line.strip()
        if not line.startswith(':'):
            continue
        n = int(line[1:3], 16)
        addr = int(line[3:7], 16)
        typ = int(line[7:9], 16)
        data = bytes.fromhex(line[9:9 + 2 * n])
        if typ == 0:
            for i, b in enumerate(data):
                mem[(upper << 16) + addr + i] = b
        elif typ == 4:
            upper = int.from_bytes(data, 'big')
        elif typ == 1:
            break
    return mem


BYTE_OPS = {  # top 6 bits -> name (d,a form)
    0b001001: 'addwf', 0b001000: 'addwfc', 0b000101: 'andwf', 0b000111: 'comf',
    0b000001: 'decf', 0b001011: 'decfsz', 0b010011: 'dcfsnz', 0b001010: 'incf',
    0b001111: 'incfsz', 0b010010: 'infsnz', 0b000100: 'iorwf', 0b010100: 'movf',
    0b001101: 'rlcf', 0b010001: 'rlncf', 0b001100: 'rrcf', 0b010000: 'rrncf',
    0b010101: 'subfwb', 0b010111: 'subwf', 0b010110: 'subwfb', 0b001110: 'swapf',
    0b000110: 'xorwf',
}
BYTE_OPS_A = {  # top 7 bits -> name (a form only)
    0b0110101: 'clrf', 0b0110001: 'cpfseq', 0b0110010: 'cpfsgt', 0b0110000: 'cpfslt',
    0b0110111: 'movwf', 0b0000001: 'mulwf', 0b0110110: 'negf', 0b0110100: 'setf',
    0b0110011: 'tstfsz',
}
BIT_OPS = {0b1001: 'bcf', 0b1000: 'bsf', 0b1011: 'btfsc', 0b1010: 'btfss', 0b0111: 'btg'}
COND = {0xE2: 'bc', 0xE6: 'bn', 0xE3: 'bnc', 0xE7: 'bnn', 0xE5: 'bnov', 0xE1: 'bnz',
        0xE4: 'bov', 0xE0: 'bz'}
LIT = {0x0F: 'addlw', 0x0B: 'andlw', 0x09: 'iorlw', 0x0E: 'movlw', 0x0D: 'mullw',
       0x08: 'sublw', 0x0A: 'xorlw', 0x0C: 'retlw'}
MISC = {0x0004: 'clrwdt', 0x0007: 'daw', 0x0000: 'nop', 0x0006: 'pop', 0x0005: 'push',
        0x00FF: 'reset', 0x0010: 'retfie', 0x0011: 'retfie fast', 0x0012: 'return',
        0x0013: 'return fast', 0x0003: 'sleep', 0x0008: 'tblrd*', 0x0009: 'tblrd*+',
        0x000A: 'tblrd*-', 0x000B: 'tblrd+*', 0x000C: 'tblwt*', 0x000D: 'tblwt*+',
        0x000E: 'tblwt*-', 0x000F: 'tblwt+*'}


def freg(f, a):
    if a:
        return 'b:0x%02X' % f          # banked
    return '0x%03X' % (f if f < 0x60 else 0xF00 + f)  # access bank


def dis(mem):
    out = []
    addrs = sorted(a for a in mem if a < 0x200000 and a % 2 == 0)
    skip = set()
    for pc in addrs:
        if pc in skip:
            continue
        w = mem[pc] | (mem.get(pc + 1, 0) << 8)
        w2 = mem.get(pc + 2, 0) | (mem.get(pc + 3, 0) << 8)
        hi = w >> 8
        lo = w & 0xFF
        txt = None
        if w in MISC:
            txt = MISC[w]
        elif hi == 0x01 and (lo & 0xF0) == 0:
            txt = 'movlb 0x%X' % (lo & 0x0F)
        elif hi in LIT:
            txt = '%s 0x%02X' % (LIT[hi], lo)
        elif hi in COND:
            off = lo - 256 if lo & 0x80 else lo
            txt = '%s 0x%05X' % (COND[hi], pc + 2 + 2 * off)
        elif (w >> 11) == 0b11010:
            n = w & 0x7FF
            n = n - 0x800 if n & 0x400 else n
            txt = 'bra 0x%05X' % (pc + 2 + 2 * n)
        elif (w >> 11) == 0b11011:
            n = w & 0x7FF
            n = n - 0x800 if n & 0x400 else n
            txt = 'rcall 0x%05X' % (pc + 2 + 2 * n)
        elif hi in (0xEC, 0xED) and (w2 >> 12) == 0xF:
            txt = 'call 0x%05X' % ((((w2 & 0xFFF) << 8) | lo) * 2)
            skip.add(pc + 2)
        elif hi == 0xEF and (w2 >> 12) == 0xF:
            txt = 'goto 0x%05X' % ((((w2 & 0xFFF) << 8) | lo) * 2)
            skip.add(pc + 2)
        elif hi == 0xEE and (lo & 0xC0) == 0 and (w2 >> 8) == 0xF0:
            txt = 'lfsr %d, 0x%03X' % ((lo >> 4) & 3, ((lo & 0xF) << 8) | (w2 & 0xFF))
            skip.add(pc + 2)
        elif (w >> 12) == 0xC and (w2 >> 12) == 0xF:
            txt = 'movff 0x%03X, 0x%03X' % (w & 0xFFF, w2 & 0xFFF)
            skip.add(pc + 2)
        elif (w >> 12) in BIT_OPS:
            txt = '%s %s, %d' % (BIT_OPS[w >> 12], freg(lo, (w >> 8) & 1), (w >> 9) & 7)
        elif (w >> 9) in BYTE_OPS_A:
            txt = '%s %s' % (BYTE_OPS_A[w >> 9], freg(lo, (w >> 8) & 1))
        elif (w >> 10) in BYTE_OPS:
            txt = '%s %s, %s' % (BYTE_OPS[w >> 10], freg(lo, (w >> 8) & 1),
                                 'f' if (w >> 9) & 1 else 'w')
        elif (w >> 12) == 0xF:
            txt = 'nop2 0x%03X' % (w & 0xFFF)
        else:
            txt = '.word 0x%04X' % w
        out.append((pc, w, txt))
    return out


if __name__ == '__main__':
    for pc, w, txt in dis(load_hex(sys.argv[1])):
        print('%05X: %04X  %s' % (pc, w, txt))
