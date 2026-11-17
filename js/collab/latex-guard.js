// While hosting, the host's machine typesets LaTeX that other people wrote.
// LaTeX can read any file the user can (`\input{C:/Users/…/secret.txt}`
// lands in the PDF, and the PDF goes to every guest) and, with shell escape,
// run programs. The locks:
//
//   1. latex.rs runs every engine with shell escape OFF, always.
//   2. This scan, before the engine starts: every file the document names
//      (\input, \include, \includegraphics, \bibliography, \lstinputlisting…)
//      must resolve INSIDE THE SHARED FOLDER (the project's «carpeta madre»).
//      `../capitulos/cap1` from a subfolder is fine; `/etc/passwd`,
//      `C:/Users/…`, `~/.ssh/…` or a `..` that climbs out of the shared
//      folder are not. File names built out of macros cannot be checked, so
//      they are refused too (except Pyx's own `\py{…}`, whose value only the
//      host's Python — or someone with Python rights — decides).
//   3. When nothing in the project climbs out of the root document's folder,
//      TeX Live additionally runs in kpathsea's paranoid mode (openin_any=p),
//      which refuses `..` and absolute paths inside the engine itself. A
//      project that needs `../` cannot use that mode (it refuses every `..`),
//      and then (2) is what holds, as it always is on MiKTeX and Tectonic.
//
// (2) is a guard, not a TeX interpreter: TeX can build names in ways no scan
// follows, which is why (3) is used whenever the project allows it. The
// people who can write LaTeX in a session are the ones the host approved.

import { normalizePath, relativeTo, joinPath, dirOf } from '../core/paths.js';

const FILE_CMDS = [
  'input', 'include', 'includeonly', 'InputIfFileExists', 'IfFileExists', 'import', 'subimport',
  'includegraphics', 'includepdf', 'includesvg', 'includestandalone', 'graphicspath',
  'verbatiminput', 'VerbatimInput', 'lstinputlisting', 'inputminted', 'LoadClass',
  'bibliography', 'addbibresource', 'usepackage', 'RequirePackage', 'documentclass',
  'pyfile', 'pynotebook', 'subfile', 'externaldocument', 'openin', 'openout',
  '@@input', '@input', '@iinput',
];
const esc = (s) => s.replace(/[@]/g, '\\@');
// One braced argument: the file name. (\IfFileExists{name}{code}{code}: the
// code is scanned on its own, like the rest of the text.) \import and
// \subimport take two names: folder and file.
const CMD_RE = new RegExp(`\\\\(${FILE_CMDS.map(esc).join('|')})(?![A-Za-z@])\\*?\\s*(?:\\[[^\\]]*\\]\\s*)*(\\{(?:[^{}]|\\{[^{}]*\\})*\\})`, 'g');
const IMPORT_RE = /\\(?:sub)?import\*?\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g;
// TeX's own syntax, without braces: `\input file` / `\openin3=file`.
const RAW_RE = /\\(?:openin|openout)\s*\d*\s*=?\s*([^\s\\{}]+)|\\(?:@@input|input)(?![A-Za-z@])\s+([^\s\\{}%][^\s%]*)/g;
const MACRO_INPUT = /\\(?:@@input|input|include)(?![A-Za-z@])\s*\\(?!py\{)[A-Za-z@]/;
const SHELL_RE = /\\(?:immediate\s*\\)?write18\b|\\ShellEscape\b|\\input\s*\{?\s*\|/;
// LuaLaTeX runs Lua, and Lua opens any file by itself (`io.open`), whatever
// kpathsea is told: no Lua in a hosted compile.
const LUA_RE = /\\(?:directlua|latelua|luaexec|luadirect|luaescapestring)(?![A-Za-z@])|\\begin\s*\{\s*luacode\*?\s*\}/;
// A file command spelled so that no scan can see it: its name assembled with
// \csname, or the backslash / braces given to other characters (\catcode).
const HIDDEN_RE = /\\csname[^\\]{0,60}(?:input|include|openin|openout|read|write|import|verbatim|lstinput|@@)[^\\]{0,60}\\endcsname|\\catcode\s*`\\?[^\s=]{1,3}\s*=?\s*(?:0|1|2)(?![0-9])|\\(?:scantokens|detokenize\s*\\expandafter|uppercase|lowercase)\s*\{[^{}]*(?:input|openin|include)/i;
// Commands whose arguments are package/class NAMES, not paths (a name never
// has a slash or a dot-dot, so only those are checked).
const NAME_ONLY = new Set(['usepackage', 'RequirePackage', 'documentclass', 'LoadClass', 'includeonly']);

/** Does this name obviously reach outside any folder (no context needed)? */
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

const isAbs = (n) => /^([A-Za-z]:[\\/]|[\\/])/.test(n);

/**
 * Check the project's files (Map path → {content}) before a hosted compile.
 *   shareRoot  the shared folder (names must resolve inside it)
 *   cwd        the engine's working directory (the root document's folder)
 * Returns { error, climbs }: `error` is a message for the person compiling
 * ('' when fine); `climbs` says whether the project reaches outside `cwd`
 * (then the engine cannot run in paranoid mode). Without `shareRoot` every
 * `..` and absolute path is refused (the strictest reading).
 */
export function checkLatex(files, { shareRoot = null, cwd = null } = {}) {
  const found = [];
  let climbs = false;
  const bases = [];
  if (cwd) bases.push(cwd);
  for (const p of files.keys()) {
    const d = dirOf(p);
    if (d && !bases.includes(d)) bases.push(d);
    if (cwd && relativeTo(cwd, p) == null) climbs = true;
  }
  const inside = (name) => {
    const n = String(name || '').trim().replace(/^["']|["']$/g, '');
    if (!n) return true;
    if (n.startsWith('|') || /^(~|\\\\)/.test(n)) return false;
    if (!shareRoot) return !escapesProject(n);
    // TeX looks the name up from the working directory and from every
    // folder on its search path: inside the shared folder from ALL of them.
    // A name that starts with ./ or ../ is "explicitly relative": kpathsea
    // resolves it from the working directory only, never along the path.
    const explicit = /^\.\.?[\\/]/.test(n);
    const from = explicit && cwd ? [cwd] : bases;
    const targets = isAbs(n) ? [normalizePath(n)] : from.map((b) => normalizePath(joinPath(b, n)));
    for (const t of targets) {
      if (relativeTo(shareRoot, t) == null) return false;
      if (cwd && relativeTo(cwd, t) == null) climbs = true;
    }
    return true;
  };
  for (const [path, f] of files) {
    const text = stripComments(String((f && f.content) || ''));
    const name = String(path).split(/[\\/]/).pop();
    if (SHELL_RE.test(text)) found.push(`${name}: ejecutar programas (\\write18) no está permitido en una sesión compartida`);
    if (LUA_RE.test(text)) found.push(`${name}: el código Lua (\\directlua, luacode) no está permitido en una sesión compartida: puede leer cualquier archivo`);
    if (HIDDEN_RE.test(text)) found.push(`${name}: una orden de lectura de archivos escrita de forma encubierta (\\csname, \\catcode): en una sesión deben escribirse tal cual`);
    if (MACRO_INPUT.test(text)) found.push(`${name}: \\input seguido de una macro: en una sesión el nombre del archivo debe escribirse tal cual`);
    CMD_RE.lastIndex = 0;
    for (let m = CMD_RE.exec(text); m; m = CMD_RE.exec(text)) {
      const cmd = m[1];
      const groups = [...m[2].matchAll(/\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map((g) => g[1]);
      for (const g of groups) {
        // \graphicspath{{dir/}{dir2/}} nests braces: take each piece.
        const pieces = g.includes('{') ? [...g.matchAll(/\{([^{}]*)\}/g)].map((x) => x[1]) : g.split(',');
        for (const raw of pieces) {
          const piece = raw.trim();
          if (!piece) continue;
          if (/^\\py\{/.test(piece)) continue; // a value Pyx computes (host's Python)
          if (piece.includes('\\') || piece.includes('#') || piece.includes('^^')) {
            if (!NAME_ONLY.has(cmd) || /[\\/]|\.\./.test(piece.replace(/\\[A-Za-z@]+/g, ''))) {
              found.push(`${name}: \\${cmd}{${piece}} usa una macro como nombre de archivo (escríbelo tal cual durante la sesión)`);
            }
            continue;
          }
          if (NAME_ONLY.has(cmd) && !/[\\/]/.test(piece)) continue;
          if (!inside(piece)) found.push(`${name}: \\${cmd}{${piece}} lee fuera de la carpeta compartida`);
        }
      }
    }
    IMPORT_RE.lastIndex = 0;
    for (let m = IMPORT_RE.exec(text); m; m = IMPORT_RE.exec(text)) {
      const both = (m[1].trim().replace(/[\\/]?$/, '/') + m[2].trim());
      if (/\\/.test(m[1] + m[2]) || !inside(both)) found.push(`${name}: \\import{${m[1]}}{${m[2]}} lee fuera de la carpeta compartida`);
    }
    RAW_RE.lastIndex = 0;
    for (let m = RAW_RE.exec(text); m; m = RAW_RE.exec(text)) {
      const n = m[1] || m[2];
      if (n && !inside(n)) found.push(`${name}: abre ${n} fuera de la carpeta compartida`);
    }
    if (found.length >= 5) break;
  }
  if (!found.length) return { error: '', climbs };
  return {
    climbs,
    error: 'Compilación bloqueada durante la sesión compartida: el documento intenta leer archivos de '
      + 'fuera de la carpeta compartida, que acabarían en el PDF que reciben los demás.\n  • '
      + found.slice(0, 5).join('\n  • ')
      + (shareRoot ? `\nCarpeta compartida: ${shareRoot}. Si el proyecto está en una carpeta superior, compártela (Compartir → Carpeta).` : ''),
  };
}

/** The strictest reading (no shared folder known): any `..` or absolute path. */
export function latexEscapes(files) {
  return checkLatex(files).error;
}
