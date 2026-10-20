# Slur patterns in the source XML of files whose import warned about slurs
# (2026-10-20 evidence for importMusicXml.ts pairSlurs). python3 -I slurscan.py <M>
import sys, json, glob, re, collections, xml.etree.ElementTree as ET
M = sys.argv[1]
S = json.load(open(M + '/sample.json'))['files']
warned = {}
for f in glob.glob(M + '/out/*.json'):
    r = json.load(open(f)); h = f.rsplit('/', 1)[1][:-5]
    top = ' '.join(r['console']['top'])
    warned[h] = ('identical values in @startid and @endid' in top, 'does not occur temporally before end' in top)
tot = collections.Counter()
for h, (ident, back) in warned.items():
    if not (ident or back): continue
    root = ET.parse(S[h]['path']).getroot()
    for part in root.findall('part'):
        open_ = {}   # number -> (measure idx, onset, staff, voice) in DOCUMENT order
        for mi, meas in enumerate(part.findall('measure')):
            pos = 0; last = 0
            for node in meas:
                if node.tag == 'backup': pos -= int(node.findtext('duration') or 0); continue
                if node.tag == 'forward': pos += int(node.findtext('duration') or 0); continue
                if node.tag != 'note': continue
                chord = node.find('chord') is not None
                onset = last if chord else pos
                if not chord: last = pos; pos += int(node.findtext('duration') or 0)
                st, vo = node.findtext('staff') or '1', node.findtext('voice') or '1'
                slurs = node.findall('notations/slur')
                types = collections.defaultdict(set)
                for s in slurs: types[s.get('number', '1')].add(s.get('type'))
                for n, ts in types.items():
                    if 'start' in ts and 'stop' in ts: tot['note both stops and starts slur N' + (' (warned identical)' if ident else '')] += 1
                for s in slurs:
                    n, t = s.get('number', '1'), s.get('type')
                    here = (mi, onset, st, vo)
                    if t == 'start':
                        open_[n] = here
                    elif t == 'stop':
                        if n not in open_: tot['stop with no open start (document order)'] += 1; continue
                        a = open_.pop(n)
                        if (a[0], a[1]) > (mi, onset): tot['pair runs backwards in time (document order)'] += 1
                        elif (a[2], a[3]) != (st, vo): tot['pair crosses staff/voice, forward in time'] += 1
                        else: tot['ordinary pair'] += 1
print('files warned identical:', sum(1 for v in warned.values() if v[0]), '| warned backwards:', sum(1 for v in warned.values() if v[1]))
for k, v in tot.most_common(): print(f'  {v:6}  {k}')
