// Which TeX engine a document compiles with — and what it NEEDS.
//
// Order of priority:
//   1. the engine chosen for this document (Configuración → Compilación →
//      «Motor de este documento»);
//   2. a `% !TeX program = pdflatex` line in the root document (TeXstudio);
//   3. what the document REQUIRES, read from its source: pdfTeX primitives
//      (\pdfgentounicode, \input glyphtounicode, \pdfminorversion…) need
//      pdfLaTeX; fontspec / unicode-math / polyglossia need XeLaTeX or
//      LuaLaTeX; \directlua or luacode need LuaLaTeX;
//   4. the default engine (Configuración), or the first one installed.
// An engine that is not installed is replaced by one that is, and the reason
// travels with the answer so the log can say so.
//
// Whatever engine runs, `engineShim` keeps the pdfTeX-only primitives a
// pdfLaTeX template carries from stopping XeLaTeX / LuaLaTeX / Tectonic:
// they become harmless no-ops there (their only effect is on pdfTeX's PDF).

const ENGINES = ['pdflatex', 'xelatex', 'lualatex', 'tectonic'];

/** The text without its comments (a `%` not escaped as `\%`). */
function code(text) {
  return String(text || '').replace(/(^|[^\\])%.*$/gm, '$1');
}

const PDF_ONLY = /\\(?:pdfgentounicode|pdfglyphtounicode|pdfminorversion|pdfcompresslevel|pdfobjcompresslevel|pdfmapfile|pdfmapline|pdfinclusioncopyfonts|pdfsuppresswarningpagegroup|pdfpkresolution|pdfoutput\s*=)|\\input\s*\{?\s*glyphtounicode/;
const PKG = (names) => new RegExp(`\\\\(?:usepackage|RequirePackage)\\s*(?:\\[[^\\]]*\\])?\\s*\\{[^}]*\\b(?:${names})\\b[^}]*\\}`);
const UNICODE_ONLY = new RegExp(`${PKG('fontspec|unicode-math|polyglossia|xeCJK|xltxtra|xunicode|mathspec|realscripts|fontsetup').source}|\\\\(?:setmainfont|setsansfont|setmonofont|newfontfamily|setmathfont)\\b`);
const LUA_ONLY = new RegExp(`${PKG('luacode|luatextra|luaotfload|lua-visual-debug|luamplib|lua-ul|luatexja|lualatex-math').source}|\\\\directlua\\b`);

/** What the source itself needs: { engine, why } or null. */
export function requiredEngine(text) {
  const c = code(text);
  if (LUA_ONLY.test(c)) return { engine: 'lualatex', why: 'lua' };
  if (UNICODE_ONLY.test(c)) return { engine: 'xelatex', why: 'unicode' };
  if (PDF_ONLY.test(c)) return { engine: 'pdflatex', why: 'pdf' };
  return null;
}

/** Does the source use pdfTeX-only primitives (whatever engine runs it)? */
export const usesPdfPrimitives = (text) => PDF_ONLY.test(code(text));

const MAGIC = /^\s*%\s*!TeX\s+(?:TS-)?program\s*=\s*(pdflatex|xelatex|lualatex|tectonic)\s*$/im;

/**
 * The engine to run. `installed`: the engines found on the machine (empty =
 * unknown: trust the choice). Returns { engine, source, note }.
 */
export function chooseEngine({ docEngine, rootText, defaultEngine, installed = [] }) {
  const magic = (MAGIC.exec(String(rootText || '')) || [])[1];
  const need = requiredEngine(rootText);
  let engine;
  let source;
  if (docEngine) { engine = docEngine; source = 'document'; }
  else if (magic) { engine = magic.toLowerCase(); source = 'magic'; }
  else if (need) {
    // XeLaTeX or LuaLaTeX both serve a fontspec document: keep the default
    // when it is one of them.
    engine = need.why === 'unicode' && (defaultEngine === 'lualatex' || defaultEngine === 'tectonic') ? defaultEngine : need.engine;
    source = 'required';
  } else if (defaultEngine) { engine = defaultEngine; source = 'default'; }
  else { engine = installed[0] || 'xelatex'; source = 'auto'; }
  let note = '';
  if (installed.length && !installed.includes(engine)) {
    // Not on this machine: the closest one that is.
    const order = engine === 'pdflatex' ? ['pdflatex', 'lualatex', 'xelatex', 'tectonic']
      : engine === 'lualatex' ? ['lualatex', 'xelatex', 'tectonic', 'pdflatex']
        : ['xelatex', 'tectonic', 'lualatex', 'pdflatex'];
    const alt = order.find((e) => installed.includes(e)) || installed[0];
    note = `${engine} → ${alt}`;
    engine = alt;
  }
  return { engine: ENGINES.includes(engine) ? engine : 'xelatex', source, note, need };
}

/**
 * One line of TeX, put in front of the root document's first line (no new
 * line, so every line number stays the same) when an engine other than
 * pdfTeX runs a source with pdfTeX primitives: each one is defined, if the
 * engine lacks it, as something that does nothing.
 */
export function engineShim(engine, text) {
  if (engine === 'pdflatex' || !usesPdfPrimitives(text)) return '';
  const counts = ['pdfgentounicode', 'pdfminorversion', 'pdfcompresslevel', 'pdfobjcompresslevel', 'pdfinclusioncopyfonts', 'pdfsuppresswarningpagegroup', 'pdfpkresolution', 'pdfoutput'];
  const gobble1 = ['pdfmapfile', 'pdfmapline'];
  return [
    '\\ifdefined\\pdfglyphtounicode\\else\\def\\pdfglyphtounicode#1#2{}\\fi',
    ...counts.map((c) => `\\ifdefined\\${c}\\else\\newcount\\${c}\\fi`),
    ...gobble1.map((c) => `\\ifdefined\\${c}\\else\\def\\${c}#1{}\\fi`),
  ].join('');
}
