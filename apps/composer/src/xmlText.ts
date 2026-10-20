// MusicXML file bytes → text (2026-10-20, Max: UTF-16 files must import).
//
// `File.text()` always decodes UTF-8, so a UTF-16 file (two of the eighteen in
// the MusicXML sample set) failed to parse, and a file declaring a single-byte
// encoding garbled every non-ASCII character. The order follows XML 1.0
// Appendix F: a byte-order mark; then UTF-16's null-byte pattern on "<?"; then
// the encoding the XML declaration names. A declaration is trusted only for an
// ASCII-compatible encoding — one that claims UTF-16 without a BOM or null
// bytes is not UTF-16 — and a label TextDecoder does not know falls back to
// UTF-8. TextDecoder drops the BOM it matched.
//
// Twin: apps/overlay-host/src/fs-bridge.mjs `decodeXmlText` — the local file
// bridge decodes on the host, which cannot import this module. Keep them alike.

/** Decode an XML file's bytes by its BOM, byte pattern or declared encoding. */
export function decodeXmlText(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return new TextDecoder(xmlEncodingOf(b)).decode(b);
}

/** The TextDecoder label an XML file's bytes are in (see the header). */
export function xmlEncodingOf(b: Uint8Array): string {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf-8';
  if (b[0] === 0xff && b[1] === 0xfe) return 'utf-16le';
  if (b[0] === 0xfe && b[1] === 0xff) return 'utf-16be';
  if (b[0] === 0x3c && b[1] === 0x00 && b[2] === 0x3f && b[3] === 0x00) return 'utf-16le';
  if (b[0] === 0x00 && b[1] === 0x3c && b[2] === 0x00 && b[3] === 0x3f) return 'utf-16be';
  let head = '';
  for (let i = 0; i < Math.min(b.length, 256); i++) head += String.fromCharCode(b[i]);
  const label = /^<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/.exec(head)?.[1].toLowerCase();
  if (!label || /^utf-?(16|32)/.test(label)) return 'utf-8';
  try { return new TextDecoder(label).encoding; } catch { return 'utf-8'; }
}
