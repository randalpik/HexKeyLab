// Captures error-level messages from the page (console.error + console.warn
// + Verovio's own Log.entryAdded errors) and records them. Tests fail the
// CONSOLE invariant when any unfiltered error-level message was seen.
//
// Allowlist patterns (regex strings) are matched against the message text.
// Anything matching is dropped silently.

/** Default allowlist — kept conservative. Add patterns here only when a
 *  message is confirmed benign across all scenarios. */
const DEFAULT_ALLOW = [
  /^Download the React DevTools/i,
  /favicon\.ico/i,
  /Verovio.+loaded/i,
];

export function attachConsoleCapture(cdp, { allow = DEFAULT_ALLOW } = {}) {
  const records = [];
  const isAllowed = (text) => allow.some((re) => re.test(text));

  cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
    if (type !== 'error' && type !== 'warning' && type !== 'assert') return;
    const text = args
      .map((a) => (a.value != null ? String(a.value) : a.description ?? ''))
      .join(' ');
    if (isAllowed(text)) return;
    records.push({ source: 'console.' + type, text });
  });

  cdp.on('Log.entryAdded', ({ entry }) => {
    if (entry.level !== 'error' && entry.level !== 'warning') return;
    const text = entry.text ?? '';
    if (isAllowed(text)) return;
    records.push({ source: 'log.' + entry.level, text });
  });

  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    const text = exceptionDetails?.exception?.description
      ?? exceptionDetails?.text
      ?? 'exception';
    if (isAllowed(text)) return;
    records.push({ source: 'exception', text });
  });

  return {
    records,
    /** Returns the records that arrived since the last reset. */
    drain() {
      const snapshot = records.slice();
      records.length = 0;
      return snapshot;
    },
    reset() { records.length = 0; },
  };
}
