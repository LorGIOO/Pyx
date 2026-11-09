// How a text file is stored on disk — its encoding, its byte-order mark and
// its line endings — detected when the file is read so that saving gives the
// file back the way it came.
//
// Pyx used to keep ONE encoding for everything (Configuración → Archivos) and
// always wrote LF: opening a colleague's Latin-1 chapter in a UTF-8 setup and
// pressing Ctrl+S re-encoded it, every CRLF file became LF on its first save
// (the whole file shows as changed in git), a BOM was dropped, and a character
// the target encoding lacks was silently written as "?". All of that is a
// change to the author's file that the author never asked for.
//
// Pure functions, no platform access: the store decides what to do with a
// character that does not fit (ask, or refuse) — never this module.

/* Windows-1252, bytes 0x80–0x9F, as the WHATWG decoder maps them (the five
   bytes the code page leaves undefined decode to the C1 control of the same
   number, so every byte round-trips). 0xA0–0xFF are Latin-1. */
const CP1252_HIGH = [
  0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
  0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
  0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
  0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
];
const CP1252_ENCODE = new Map(CP1252_HIGH.map((cp, i) => [cp, 0x80 + i]));

/** The byte for a code point in a single-byte encoding, or -1. */
function singleByte(encoding, cp) {
  if (cp < 0x80) return cp;
  if (encoding === 'us-ascii') return -1;
  if (encoding === 'iso-8859-1') return cp < 0x100 ? cp : -1;
  // windows-1252: the table wins over Latin-1 in 0x80–0x9F (U+0080 itself,
  // for one, is NOT in the code page: 0x80 is the euro sign).
  const high = CP1252_ENCODE.get(cp);
  if (high !== undefined) return high;
  return cp >= 0xA0 && cp < 0x100 ? cp : -1;
}

/** What the options of Configuración → «Codificación de los archivos» mean. */
export function formatFromSetting(name) {
  switch (name) {
    case 'UTF-8 con BOM': return { encoding: 'utf-8', bom: true, eol: '\n' };
    case 'ISO-8859-1 (Latin-1)': return { encoding: 'iso-8859-1', bom: false, eol: '\n' };
    case 'Windows-1252': return { encoding: 'windows-1252', bom: false, eol: '\n' };
    case 'US-ASCII': return { encoding: 'us-ascii', bom: false, eol: '\n' };
    default: return { encoding: 'utf-8', bom: false, eol: '\n' };
  }
}

/** A name for messages. */
export function encodingLabel(encoding) {
  return {
    'utf-8': 'UTF-8',
    'utf-16le': 'UTF-16 LE',
    'utf-16be': 'UTF-16 BE',
    'windows-1252': 'Windows-1252',
    'iso-8859-1': 'ISO-8859-1 (Latin-1)',
    'us-ascii': 'US-ASCII',
  }[encoding] || String(encoding || 'UTF-8');
}

/** The line ending a text uses: the most frequent one; LF when it has none. */
export function detectEol(text) {
  let crlf = 0, lf = 0, cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) { crlf++; i++; } else cr++;
    } else if (c === 10) lf++;
  }
  if (crlf > lf && crlf >= cr) return '\r\n';
  if (cr > lf && cr > crlf) return '\r';
  return '\n';
}

/**
 * Decode a file's bytes.
 *
 * Strict UTF-8 first (a BOM is noted and dropped), UTF-16 when its BOM says
 * so, and otherwise Windows-1252 — the legacy .tex with accents saved as
 * latin-1 — which accepts any byte and gives every byte back on encoding.
 *
 * `ascii` is true when the bytes cannot tell UTF-8 from a single-byte
 * encoding (nothing above 0x7F, no BOM): such a file has no encoding of its
 * own yet, and the first accent typed into it goes in the user's default one.
 *
 * @returns {{text:string, encoding:string, bom:boolean, eol:string, ascii:boolean}}
 */
export function decodeBytes(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text;
  let encoding = 'utf-8';
  let bom = false;
  let ascii = false;
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) bom = true;
  if (b.length >= 2 && ((b[0] === 0xFF && b[1] === 0xFE) || (b[0] === 0xFE && b[1] === 0xFF))) {
    encoding = b[0] === 0xFF ? 'utf-16le' : 'utf-16be';
    bom = true;
    text = new TextDecoder(encoding).decode(b); // drops the BOM
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(b); // drops the BOM
      if (!bom) {
        ascii = true;
        for (let i = 0; i < b.length; i++) if (b[i] > 0x7F) { ascii = false; break; }
      }
    } catch (_) {
      text = new TextDecoder('windows-1252').decode(b);
      encoding = 'windows-1252';
      bom = false;
    }
  }
  return { text, encoding, bom, eol: detectEol(text), ascii };
}

/**
 * Encode `text` for a file stored as `format` ({encoding, bom, eol}).
 *
 * The editor's text has LF line endings; they are written as `format.eol`
 * (`eol: null` writes the text's line breaks untouched).
 * `unmappable` lists the distinct characters the encoding cannot represent
 * (always empty for UTF-8 / UTF-16). They are in `bytes` as "?", so a caller
 * that finds any must not write `bytes` without the user's say-so.
 *
 * @returns {{bytes:Uint8Array, unmappable:string[]}}
 */
export function encodeText(text, format = {}) {
  const encoding = format.encoding || 'utf-8';
  let s = String(text);
  // `eol: null` = the text already carries the file's own line breaks (it was
  // decoded from the file and never went through the editor): leave them.
  if (format.eol !== null) {
    const eol = format.eol === '\r\n' || format.eol === '\r' ? format.eol : '\n';
    // One pass to LF first, so a stray CR already in the text is not doubled.
    if (s.includes('\r')) s = s.replace(/\r\n?/g, '\n');
    if (eol !== '\n') s = s.replace(/\n/g, eol);
  }

  if (encoding === 'utf-8') {
    const u = new TextEncoder().encode(s);
    if (!format.bom) return { bytes: u, unmappable: [] };
    const bytes = new Uint8Array(u.length + 3);
    bytes.set([0xEF, 0xBB, 0xBF]);
    bytes.set(u, 3);
    return { bytes, unmappable: [] };
  }

  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    // Always with its BOM: without one nothing can tell the byte order.
    const le = encoding === 'utf-16le';
    const bytes = new Uint8Array(2 + s.length * 2);
    bytes[0] = le ? 0xFF : 0xFE;
    bytes[1] = le ? 0xFE : 0xFF;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      bytes[2 + i * 2] = le ? c & 0xFF : c >> 8;
      bytes[3 + i * 2] = le ? c >> 8 : c & 0xFF;
    }
    return { bytes, unmappable: [] };
  }

  // Single-byte encodings. By code point, so a character outside the BMP is
  // one "?" and one entry in the report, not two.
  const out = new Uint8Array(s.length);
  const missing = new Set();
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i);
    if (cp > 0xFFFF) i++;
    const byte = singleByte(encoding, cp);
    if (byte < 0) {
      missing.add(String.fromCodePoint(cp));
      out[n++] = 0x3F;
    } else out[n++] = byte;
  }
  return { bytes: out.subarray(0, n), unmappable: [...missing] };
}
