# Offline content survey of an extracted sample (test/corpus/README.md).
#   python3 -I survey.py <M>   → <M>/survey.json + a per-set summary
import sys, json, re, collections, statistics, xml.etree.ElementTree as ET
M = sys.argv[1]
S = json.load(open(M + '/sample.json'))
rows = []
for h, r in S['files'].items():
    if 'path' not in r: continue
    b = open(r['path'], 'rb').read()
    enc = 'utf-16' if b[:2] in (b'\xff\xfe', b'\xfe\xff') else 'utf-8/other'
    d = {'hash': h, 'set': r['set'], 'xmlBytes': len(b), 'enc': enc}
    try:
        root = ET.fromstring(b)
    except Exception as e:
        d['parseError'] = repr(e)[:120]; rows.append(d); continue
    strip = lambda t: t.split('}')[-1]
    d['root'] = strip(root.tag)
    sw = [e.text for e in root.iter() if strip(e.tag) == 'software' and e.text]
    d['software'] = re.sub(r'[\d.]+.*$', '', sw[0]).strip() if sw else '?'
    parts = [e for e in root if strip(e.tag) == 'part']
    d['parts'] = len(parts)
    meas = [m for m in parts[0] if strip(m.tag) == 'measure'] if parts else []
    d['measures'] = len(meas)
    staves = 0
    for p in parts:
        st = [int(e.text) for e in p.iter() if strip(e.tag) == 'staves' and e.text and e.text.isdigit()]
        staves += max(st) if st else 1
    d['staves'] = staves
    notes = [e for e in root.iter() if strip(e.tag) == 'note']
    tags = collections.Counter(strip(c.tag) for n in notes for c in n)
    d['notes'] = len(notes)
    d['unpitched'] = tags['unpitched']; d['grace'] = tags['grace']; d['chordMembers'] = tags['chord']
    d['lyrics'] = tags['lyric']; d['tupletNotes'] = tags['time-modification']
    d['invisible'] = sum(1 for n in notes if n.get('print-object') == 'no' and not any(strip(c.tag) == 'rest' for c in n))
    voices = {c.text for n in notes for c in n if strip(c.tag) == 'voice'}
    d['voices'] = len(voices)
    d['timeSigs'] = sum(1 for e in root.iter() if strip(e.tag) == 'time')
    d['keySigs'] = sum(1 for e in root.iter() if strip(e.tag) == 'key')
    d['newSystem'] = sum(1 for e in root.iter() if strip(e.tag) == 'print' and e.get('new-system') == 'yes')
    d['multiRest'] = sum(1 for e in root.iter() if strip(e.tag) == 'multiple-rest')
    d['harmony'] = sum(1 for e in root.iter() if strip(e.tag) == 'harmony')
    names = [ (e.text or '').strip() for e in root.iter() if strip(e.tag) == 'part-name']
    d['partNames'] = names[:6]
    rows.append(d)
json.dump(rows, open(M + '/survey.json', 'w'), indent=1)
def summ(set_):
    R = [r for r in rows if r['set'] == set_ and 'parseError' not in r]
    q = lambda xs, p: sorted(xs)[min(len(xs) - 1, int(p * len(xs)))]
    print(f'\n== {set_}: {len(R)} parsed, {sum(1 for r in rows if r["set"] == set_ and "parseError" in r)} parse errors')
    for k in ('measures', 'parts', 'staves', 'notes', 'xmlBytes'):
        xs = [r[k] for r in R]; print(f'  {k:9} p10 {q(xs,.1)}  median {q(xs,.5)}  p90 {q(xs,.9)}  max {max(xs)}')
    frac = lambda f: f'{sum(1 for r in R if f(r))}/{len(R)}'
    print('  with unpitched', frac(lambda r: r['unpitched']), '| invisible notes', frac(lambda r: r['invisible']), '| grace', frac(lambda r: r['grace']),
          '| tuplets', frac(lambda r: r['tupletNotes']), '| lyrics', frac(lambda r: r['lyrics']), '| chord symbols', frac(lambda r: r['harmony']))
    print('  >1 voice', frac(lambda r: r['voices'] > 1), '| meter changes', frac(lambda r: r['timeSigs'] > r['parts']), '| multirests', frac(lambda r: r['multiRest']), '| UTF-16', frac(lambda r: r['enc'] == 'utf-16'))
    print('  software', collections.Counter(r['software'] for r in R).most_common(5))
    print('  roots', collections.Counter(r['root'] for r in R).most_common(3))
    pn = collections.Counter(n.lower() for r in R for n in r['partNames'][:1])
    print('  first part names', pn.most_common(10))
summ('random'); summ('large')
