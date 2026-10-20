# Sample + extract MusicXML root files from the untrusted mxl.tar.gz
# (test/corpus/README.md). Nothing is extracted by archive path: chosen
# members are read in memory, each .mxl (a zip) is opened from bytes,
# META-INF/container.xml names the root file, its size is capped, and it is
# written as <M>/<set>/<hash>.musicxml. Needs <M>/listing.txt (tar -tzvf).
#
#   python3 -I sample_extract.py <M> <mxl.tar.gz> [random=300] [band=100] [top=50] [seed=20261020]
# random: uniform over the archive; band: from the p90–p99 size band; top:
# above p99 (the 2026-10-20 sample used the defaults).
import sys, tarfile, zipfile, io, random, json, re, xml.etree.ElementTree as ET
M = sys.argv[1]; TAR = sys.argv[2]
N_RANDOM, N_BAND, N_TOP, SEED = [int(x) for x in (sys.argv[3:7] + ['300', '100', '50', '20261020'][len(sys.argv[3:7]):])]
rows = []
for line in open(M + '/listing.txt'):
    p = line.split()
    if p[-1].endswith('.mxl'): rows.append((p[-1], int(p[2])))
rows.sort()
sizes = sorted(s for _, s in rows); p90 = sizes[len(sizes) * 9 // 10]; p99 = sizes[len(sizes) * 99 // 100]
rng = random.Random(SEED)
rand = rng.sample(rows, N_RANDOM)
chosen = {n for n, _ in rand}
band = [r for r in rows if p90 <= r[1] < p99 and r[0] not in chosen]
top = [r for r in rows if r[1] >= p99 and r[0] not in chosen]
big = rng.sample(band, N_BAND) + rng.sample(top, N_TOP)
want = {n: 'random' for n, _ in rand}
want.update({n: 'large' for n, _ in big})
MAX_XML = 50 * 1024 * 1024
out = {}
with tarfile.open(TAR, 'r|gz') as tf:
    for m in tf:
        if m.name not in want or not m.isfile(): continue
        data = tf.extractfile(m).read()
        h = m.name.rsplit('/', 1)[1][:-4]
        rec = {'set': want[m.name], 'member': m.name, 'mxlBytes': len(data)}
        try:
            z = zipfile.ZipFile(io.BytesIO(data))
            root = None
            if 'META-INF/container.xml' in z.namelist():
                c = ET.fromstring(z.read('META-INF/container.xml'))
                rf = [e for e in c.iter() if e.tag.endswith('rootfile')]
                root = rf[0].get('full-path') if rf else None
            if root is None:
                cands = [n for n in z.namelist() if n.lower().endswith(('.xml', '.musicxml')) and not n.startswith('META-INF')]
                root = cands[0] if cands else None
            if root is None: raise ValueError('no root file')
            info = z.getinfo(root)
            if info.file_size > MAX_XML: raise ValueError('root file too large: %d' % info.file_size)
            xmlb = z.read(root)
            path = '%s/%s/%s.musicxml' % (M, want[m.name], h)
            open(path, 'wb').write(xmlb)
            rec.update({'root': root, 'xmlBytes': len(xmlb), 'path': path})
        except Exception as e:
            rec['error'] = repr(e)[:200]
        out[h] = rec
json.dump({'p90': p90, 'p99': p99, 'files': out}, open(M + '/sample.json', 'w'), indent=1)
print('extracted', sum(1 for r in out.values() if 'path' in r), 'errors', sum(1 for r in out.values() if 'error' in r), 'p90', p90, 'p99', p99)
