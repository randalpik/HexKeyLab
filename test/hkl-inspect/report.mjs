// Shared reporting helpers for the HKL console scanners (Chromium + Firefox).
// Both capture a list of { source, text } console records; this dedupes and
// prints them in a stable, grouped form.

export const HR = '─'.repeat(72);

/** Dedupe items by keyFn, keeping a count of how many collapsed into each. */
export function tally(items, keyFn) {
  const map = new Map();
  for (const it of items) {
    const k = keyFn(it);
    const cur = map.get(k);
    if (cur) cur.count++;
    else map.set(k, { ...it, count: 1 });
  }
  return [...map.values()];
}

/** Print a deduped CONSOLE section from records shaped { source, text }. */
export function printConsole(records) {
  const con = tally(records, (r) => r.source + '|' + r.text);
  console.log('\nCONSOLE warnings/errors (' + con.length + ' distinct, ' + records.length + ' total)');
  if (con.length === 0) { console.log('  (none)'); return; }
  for (const r of con.sort((a, b) => a.source.localeCompare(b.source))) {
    console.log('  [' + r.source + ']' + (r.count > 1 ? ' x' + r.count : ''));
    console.log('      ' + r.text.replace(/\n/g, '\n      '));
  }
}
