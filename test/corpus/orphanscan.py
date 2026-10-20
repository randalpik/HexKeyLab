# Stops with no open start (document order) and where their start is
# (2026-10-20: 31 slurs written end-first). python3 -I orphanscan.py <M>
# the same number, and is the pair forward in TIME if taken stop-first?
import sys, json, glob, collections, xml.etree.ElementTree as ET
M = sys.argv[1]
S = json.load(open(M + '/sample.json'))['files']
out = collections.Counter(); ex = []
for h, r in S.items():
    if 'path' not in r: continue
    root = ET.parse(r['path']).getroot()
    for pi, part in enumerate(root.findall('part')):
        ends = []
        for mi, meas in enumerate(part.findall('measure')):
            div = None; pos = 0; last = 0
            for ci, node in enumerate(meas):
                if node.tag == 'attributes' and node.findtext('divisions'): pass
                if node.tag == 'backup': pos -= int(node.findtext('duration') or 0); continue
                if node.tag == 'forward': pos += int(node.findtext('duration') or 0); continue
                if node.tag != 'note': continue
                chord = node.find('chord') is not None
                onset = last if chord else pos
                if not chord: last = pos; pos += int(node.findtext('duration') or 0)
                for s in node.findall('notations/slur'):
                    ends.append((mi, ci, s.get('type'), s.get('number', '1'), onset, node.findtext('voice') or '1', node.findtext('staff') or '1'))
        ends.sort(key=lambda e: (e[0], e[1], 0 if e[2] == 'stop' else 1))
        open_ = {}
        for i, e in enumerate(ends):
            mi, ci, t, n, on, v, st = e
            if t == 'start': open_[n] = e; continue
            if n in open_: open_.pop(n); continue
            nxt = next((x for x in ends[i + 1:] if x[3] == n and x[2] == 'start'), None)
            if not nxt: out['orphan stop, no later start'] += 1; continue
            same_m = nxt[0] == mi
            fwd = (nxt[0], nxt[4]) <= (mi, on)
            out[f'orphan stop → next start {"same measure" if same_m else "later measure"}, {"start earlier in time (written end-first)" if fwd else "start later in time"}'] += 1
            if len(ex) < 4 and fwd: ex.append((h[:12], 'm%d' % (mi + 1), 'stop v%s/st%s @%d' % (v, st, on), 'start v%s/st%s @%d' % (nxt[5], nxt[6], nxt[4])))
for k, v in out.most_common(): print(f'{v:5}  {k}')
for e in ex: print('  e.g.', *e)
