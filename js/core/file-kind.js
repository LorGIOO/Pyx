// Which files of a project folder may be opened in the EDITOR.
//
// The file tree used to hand anything that was not a PDF, an image or a CAD
// drawing to the editor: a .zip, an .mp4, an .xlsx or an executable opened as
// "text" — megabytes of mojibake that could freeze the window — and from then
// on a single Ctrl+S wrote that decoding back over the file and destroyed it.
//
// So the editor takes what is known to be text (by extension), up to a size
// the editor can hold; a file of unknown type only when it is small and its
// bytes look like text; and everything else goes to the program the system
// opens it with.

// LaTeX sources and the build files worth reading, data, and common code.
const TEXT_EXT = new Set([
  'tex', 'ltx', 'pltx', 'sty', 'cls', 'bib', 'bst', 'bbx', 'cbx', 'dtx', 'ins', 'def', 'cfg', 'clo', 'fd',
  'tikz', 'pgf', 'aux', 'log', 'toc', 'lof', 'lot', 'out', 'bbl', 'blg', 'idx', 'ind', 'ilg', 'glo', 'gls',
  'nav', 'snm', 'fls',
  'txt', 'md', 'csv', 'tsv', 'dat', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini', 'ipynb',
  'py', 'js', 'ts', 'jsx', 'tsx', 'rs', 'c', 'cpp', 'h', 'hpp', 'html', 'css', 'm', 'jl', 'r', 'lua',
  'sh', 'bat', 'ps1', 'gp', 'gnuplot',
]);

/** Largest file the editor opens as text. */
export const MAX_TEXT_BYTES = 10 * 1024 * 1024;
/** Largest file of UNKNOWN type that is read to see whether it is text. */
export const MAX_SNIFF_BYTES = 2 * 1024 * 1024;

export function extOf(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  // ".gitignore" has no extension: the dot is the first character.
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Known to be text by its extension. */
export function isTextName(name) {
  return TEXT_EXT.has(extOf(name));
}

/** Do these bytes look like a binary file? A NUL in the first kilobytes is
 *  the classic tell (no text encoding the editor reads contains one — UTF-16
 *  does, and is recognised by its BOM first). */
export function looksBinary(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 2 && ((b[0] === 0xFF && b[1] === 0xFE) || (b[0] === 0xFE && b[1] === 0xFF))) return false;
  const n = Math.min(b.length, 8192);
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}

/**
 * Where a file of the tree should open, from its name and size alone:
 *   'text'     — in the editor;
 *   'sniff'    — unknown type but small: read it and ask looksBinary;
 *   'external' — with the system's program for it.
 * `size` < 0 means "could not be determined": treated as small.
 */
export function openTarget(name, size) {
  // A .pltx is a container: its size is its figures and build files, not the
  // text the editor will hold.
  if (extOf(name) === 'pltx') return 'text';
  if (isTextName(name)) return size > MAX_TEXT_BYTES ? 'external' : 'text';
  return size > MAX_SNIFF_BYTES ? 'external' : 'sniff';
}
