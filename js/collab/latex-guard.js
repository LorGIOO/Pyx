// While hosting, the host's machine typesets LaTeX that other people wrote.
// LaTeX can read any file the user can (`\input{C:/Users/…/secret.txt}`
// lands in the PDF, and the PDF goes to every guest) and, with shell escape,
// run programs. Two locks close that:
//
//   1. latex.rs runs the engine with shell escape OFF and, on TeX Live,
//      kpathsea's paranoid mode (openin_any=p): no absolute paths, no `..`,
//      no dot files. That is the lock that cannot be talked around.
//   2. This scan, before the engine starts, refuses the obvious attempts on
//      every engine (MiKTeX and Tectonic have no paranoid mode) and says why,
//      instead of letting the compile fail somewhere deep in the log.
//
// It is a guard, not a parser: TeX can build file names out of macros, which
// is exactly why (1) exists.

const FILE_CMDS = [
  'input', 'include', 'includeonly', 'InputIfFileExists', 'IfFileExists', 'import', 'subimport',
  'includegraphics', 'includepdf', 'includesvg', 'includestandalone', 'graphicspath',
  'verbatiminput', 'VerbatimInput', 'lstinputlisting', 'inputminted', 'LoadClass',
  'bibliography', 'addbibresource', 'usepackage', 'RequirePackage', 'documentclass',
  'pyfile', 'pynotebook', 'subfile', 'externaldocument', 'openin', 'openout',
];
const CMD_RE = new RegExp(`\\\\(${FILE_CMDS.join('|')})\\*?\\s*(?:\\[[^\\]]*\\]\\s*)*((?:\\{[^}]*\\}\\s*){1,2})`, 'g');
const RAW_RE = /\\(?:openin|openout)\s*\d*\s*=?\s*([^\s\\{}]+)/g;
const SHELL_RE = /\\(?:immediate\s*\\)?write18\b|\\ShellEscape\b|\\input\s*\{?\s*\|/;

/** Is this file name reaching outside the project folder? */
export function escapesProject(name) {
  const n = String(name || '').trim().replace(/^["']|["']$/g, '');
  if (!n) return false;
  if (n.startsWith('|')) return true;                  // pipe input: runs a program
  if (/^([A-Za-z]:|[\\/]|~|\\\\)/.test(n)) return true; // absolute, home, UNC
  return n.split(/[\\/]/).some((seg) => seg === '..'); // climbing out
}

function stripComments(text) {
  // `%` starts a comment unless escaped (`\%`).
  return text.replace(/(^|[^\\])%.*$/gm, '$1');
}

/** First problems found in the project's files (Map path → {content}), as a
 *  message for the person compiling — or '' when there is none. */
export function latexEscapes(files) {
  const found = [];
  for (const [path, f] of files) {
    const text = stripComments(String((f && f.content) || ''));
    const name = String(path).split(/[\\/]/).pop();
    if (SHELL_RE.test(text)) found.push(`${name}: ejecutar programas (\\write18) no está permitido en una sesión compartida`);
    CMD_RE.lastIndex = 0;
    for (let m = CMD_RE.exec(text); m; m = CMD_RE.exec(text)) {
      const args = [...m[2].matchAll(/\{([^}]*)\}/g)].flatMap((g) => g[1].split(','));
      for (const a of args) {
        // \graphicspath{{dir/}{dir2/}} nests braces: take each piece.
        const piece = a.replace(/[{}]/g, '');
        if (escapesProject(piece)) found.push(`${name}: \\${m[1]}{${piece.trim()}} lee fuera de la carpeta del proyecto`);
      }
    }
    RAW_RE.lastIndex = 0;
    for (let m = RAW_RE.exec(text); m; m = RAW_RE.exec(text)) {
      if (escapesProject(m[1])) found.push(`${name}: abre ${m[1]} fuera de la carpeta del proyecto`);
    }
    if (found.length >= 5) break;
  }
  if (!found.length) return '';
  return 'Compilación bloqueada durante la sesión compartida: el documento intenta leer archivos de '
    + 'fuera del proyecto, que acabarían en el PDF que reciben los demás.\n  • '
    + found.slice(0, 5).join('\n  • ')
    + '\nUsa rutas relativas dentro de la carpeta del proyecto (sin «..» ni rutas absolutas).';
}
