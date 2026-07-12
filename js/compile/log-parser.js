// LaTeX log parser — a faithful JS port of TeXstudio's LatexOutputFilter
// (latexoutputfilter.cpp): the same state machine, the same regexes, the same
// message format. A problem reads exactly like TeXstudio's log panel, e.g.
//   349: Undefined control sequence. \LetLtxMacro
//   40:  Key 'siunitx/locale' accepts only a fixed set of choices.
//
// Produces: { severity: 'error'|'warning'|'badbox', file, line, message }.
//  - `line` is the SOURCE line (TeX's l.N / "on input line N"), null if unknown.
//  - `file` is resolved from the log's parenthesis file-stack (heuristic, like
//    TeXstudio), so multi-file projects attribute problems to the right file.
//    Pyx's build copies (X.build.tex) are mapped back to the real file name.
//
// The list powers the clickable "Problems" view of the compile-log panel.

/* ---------------- state machine cookies (TeXstudio's dwCookie) ------------ */
const Start = 0;
const Error = 1;
const LineNumber = 2;
const Warning = 3;
const BadBox = 4;
const ExpectingBadBoxTextQuote = 5;
// file-stack sub-states live inside the scanner (not line-level cookies here)

/* ---------------- regexes (1:1 with latexoutputfilter.cpp) ---------------- */
const reLaTeXError = /^! (?:Lua|La)TeX Error(?: <\\directlua >:\d*)?: (.*)$/i;
const rePDFLaTeXError = /^Error: (?:lua|pdf)latex (.*)$/i;
const reTeXError = /^! (.*)$/;
const reLineNumber = /^(\.{3} )?l\.(\d+)(.*)/;
const reLaTeXWarning = /^(((! )?(La|pdf|Lua)TeX3?)|Package|Class|Module) .*Warning[^:]*:(.*)/i;
const reNoFile = /^No file (.*)/;
const reNoAsyFile = /File .* does not exist\./;
const rePackageWarningContinued = /^\(.*\)[ ]{15}|^\(LaTeX3\)[ ]{7}/;
const reLaTeXLineNumber = /(.*) on(?: input)? line (\d+)\.?$/i;
const reIntlLineNumber = /(.*?)(\d+)\.$/;
const reBadBox = /^(Over|Under)(full \\[hv]box .*)/i;
const reBadBoxLines = /(.*) at lines (\d+)--(\d+)/i;
const reBadBoxLine = /(.*) at line (\d+)/i;
const reBadBoxOutput = /(.*)has occurred while \\output is active/i;
const reBadBoxTextQuote = /\\\S+\/\S+\/\S+\/\S+\//;
const reFileLineError = /^(?:\.\/)?(.+?\.(?:tex|pltx|sty|cls|ltx|def|cfg)):(\d+):\s*(.+)$/i;

const simplified = (s) => s.replace(/\s+/g, ' ').trim();

/* ------------------------------ file stack -------------------------------- */
// TeX prints '(filename' on open and ')' on close; TeXstudio tracks a stack
// heuristically (updateFileStackHeuristic2). States for the char scanner:
const FS_START = 0, FS_EXPECT = 1, FS_INNAME = 2, FS_INQUOTED = 3;

const hasExt = (s) => /\.\w{1,4}$/.test(s);

function likelyNoFileStart(s, nextChar) {
  if (s.length < 2) return nextChar === ')';
  const c0 = s[0], c1 = s[1];
  if (c0 === '/') return false;                        // abs. unix path
  if (/[a-zA-Z]/.test(c0) && c1 === ':') return false; // abs. windows path
  if (c0 === '.' && (c1 === '/' || c1 === '\\')) return false; // relative
  return true;
}

export function parseLatexLog(log, opts = {}) {
  if (!log) return [];
  const out = [];
  const seen = new Set();

  // Map a log file name (possibly a Pyx build copy) to a display name/path.
  const buildMap = opts.buildMap || null; // { 'main.build.tex': 'C:\\...\\Main.pltx', ... }
  const mapFile = (name) => {
    if (!name) return null;
    const clean = name.replace(/^"+|"+$/g, '').replace(/^\.[\\/]/, '');
    const base = clean.split(/[\\/]/).pop();
    if (buildMap) {
      const hit = buildMap[base.toLowerCase()];
      if (hit) return hit;
    }
    return clean.replace(/\.build\.tex$/i, '.tex');
  };

  // No dedup here: TeXstudio lists every occurrence (an error repeated six
  // times in the log appears six times in the panel). Only the Pyx-notice
  // block below dedups, because it may echo the same expression per file.
  const push = (p) => out.push(p);
  const pushOnce = (p) => {
    const key = `${p.severity}|${p.file || ''}|${p.line}|${p.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };

  /* -- Pyx cell / \py{} problems (the "Avisos de Pyx" block, kept as-is) -- */
  const pyxIdx = log.indexOf('===== Avisos de Pyx =====');
  if (pyxIdx >= 0) {
    const block = log.slice(pyxIdx).split('\n\n')[0];
    for (const l of block.split('\n')) {
      const m = l.match(/^\[(.+?)\]\s*(.+)$/);
      if (!m) continue;
      const lm = m[1].match(/\s*·\s*línea\s+(\d+)$/);
      pushOnce({
        severity: 'error',
        file: null,
        line: lm ? +lm[1] : null,
        message: `${lm ? m[1].slice(0, lm.index) : m[1]} — ${m[2]}`,
      });
    }
  }

  /* ------------------------- TeXstudio state machine ---------------------- */
  // Pyx concatenates every engine pass into one log; TeXstudio parses a single
  // run. Parse only the LAST pass so repeated errors aren't double-listed.
  let engineLog = log;
  const lastPass = log.lastIndexOf('===== Pasada ');
  if (lastPass > 0) engineLog = log.slice(lastPass);
  const lines = engineLog.split(/\r?\n/);

  // file stack; the root build file is pre-pushed as reliable (like run()).
  const stack = [];
  if (opts.rootFile) stack.push({ file: opts.rootFile, reliable: true });
  let fsState = FS_START;
  let fsPartial = '';

  // "does this stack entry look like a real file?" — TeXstudio checks the disk;
  // here: a known project file, or something with a 1-4 char extension.
  const known = opts.knownFiles || null; // Set of lowercase basenames
  const entryExists = (name) => {
    if (!name) return false;
    const base = name.split(/[\\/]/).pop().toLowerCase();
    if (known && (known.has(base) || known.has(base.replace(/\.build\.tex$/, '.tex')))) return true;
    return hasExt(name);
  };

  const item = { type: null, message: '', line: 0, logline: 0 };
  const resetItem = () => { item.type = null; item.message = ''; item.line = 0; item.logline = 0; };
  resetItem();

  const flushItem = () => {
    if (!item.type) { resetItem(); return; }
    while (stack.length > 1 && !entryExists(stack[stack.length - 1].file)) stack.pop();
    const top = stack.length ? stack[stack.length - 1].file : null;
    push({
      severity: item.type,
      file: mapFile(top),
      line: item.line > 0 ? item.line : null,
      message: simplified(item.message),
    });
    resetItem();
  };

  /* file-stack char scanner (updateFileStackHeuristic2) */
  const updateFileStack = (strLine) => {
    if (fsState === FS_START) fsPartial = '';
    let fnStart = 0;
    for (let i = 0; i < strLine.length; i++) {
      const c = strLine[i];
      if (fsState === FS_START) {
        if (c === '(') { fsState = FS_EXPECT; continue; }
        if (c === ')') {
          if (stack.length >= 1 && !stack[stack.length - 1].reliable) stack.pop();
        }
      } else if (fsState === FS_EXPECT) {
        if (c === ')') { fsState = FS_START; continue; }
        if (c === '"') { fsState = FS_INQUOTED; fnStart = i + 1; continue; }
        fsState = FS_INNAME; fnStart = i; continue;
      } else if (fsState === FS_INQUOTED) {
        if (c === '"') {
          fsPartial += strLine.slice(fnStart, i);
          stack.push({ file: fsPartial, reliable: false });
          fsPartial = '';
          fsState = FS_START;
          continue;
        }
      } else if (fsState === FS_INNAME) {
        if (c === ')') {
          fsPartial += strLine.slice(fnStart, i);
          fnStart = i;
          if (entryExists(fsPartial) || likelyNoFileStart(fsPartial, c)) {
            // opened and closed immediately — nothing to track
            fsPartial = '';
            fsState = FS_START;
            continue;
          }
        }
        if (c === ' ' || c === '\t' || c === '(') {
          fsPartial += strLine.slice(fnStart, i);
          fnStart = i;
          if (entryExists(fsPartial) || likelyNoFileStart(fsPartial, c)) {
            // push even when likelyNoFileStart: a matching ')' will pop it, so
            // the stack depth stays balanced (TeXstudio does the same).
            stack.push({ file: fsPartial, reliable: false });
            fsPartial = '';
            fsState = c === '(' ? FS_EXPECT : FS_START;
            continue;
          }
        }
      }
    }
    // end of line
    if (fsState === FS_INNAME) {
      fsPartial += strLine.slice(fnStart);
      if (strLine.length < 78 || entryExists(fsPartial)) {
        stack.push({ file: fsPartial, reliable: false });
        fsPartial = '';
        fsState = FS_START;
      } // else: the name continues on the next line
    } else if (fsState === FS_INQUOTED) {
      fsPartial += strLine.slice(fnStart);
    }
  };

  /* "(.*) on (input) line N." — TeXstudio's detectLaTeXLineNumber, shared by
     warnings. Returns true → flush now; false → continues on the next line. */
  const takeWarnLineNumber = (logline, len) => {
    let m = item.message.match(reLaTeXLineNumber);
    if (m) { item.line = +m[2]; item.message = m[1]; return true; }
    m = item.message.match(reIntlLineNumber);
    if (m && /line/i.test(item.message)) { item.line = +m[2]; item.message = m[1]; return true; }
    if (item.message.endsWith('.')) { item.line = 0; return true; }
    if (logline - item.logline > 4 || len === 0) { item.line = 0; return true; }
    return false;
  };

  let cookie = Start;

  for (let n = 0; n < lines.length; n++) {
    const ln = lines[n];

    if (cookie === ExpectingBadBoxTextQuote) {
      cookie = Start;
      if (reBadBoxTextQuote.test(ln)) continue; // the quoted-text line — skip it
      // else: treat this same line as a fresh Start line (fall through below)
    }

    switch (cookie) {
      case Start: {
        // MiKTeX/TeX Live -file-line-error style: file:line: message
        const fle = ln.match(reFileLineError);
        if (fle) {
          push({ severity: 'error', file: mapFile(fle[1]), line: +fle[2], message: simplified(fle[3]) });
          break;
        }
        // 1) badboxes
        let m = ln.match(reBadBox);
        if (m) {
          item.type = 'badbox';
          item.logline = n;
          item.message = ln;
          const bl = item.message.match(reBadBoxLines) || item.message.match(reBadBoxLine);
          if (bl) {
            item.message = bl[1];
            item.line = bl[3] ? Math.min(+bl[2], +bl[3]) : +bl[2];
            flushItem();
            cookie = ExpectingBadBoxTextQuote;
          } else if (reBadBoxOutput.test(item.message)) {
            // "…has occurred while \output is active": TeX reports no source
            // line for these — flush now instead of eating the next lines.
            item.line = 0;
            flushItem();
            cookie = ExpectingBadBoxTextQuote;
          } else {
            cookie = BadBox;
          }
          break;
        }
        // 2) warnings
        m = ln.match(reLaTeXWarning);
        if (m) {
          item.type = 'warning';
          item.logline = n;
          item.message = m[5];
          cookie = Start;
          if (takeWarnLineNumber(n, ln.length)) flushItem();
          else cookie = Warning;
          break;
        }
        m = ln.match(reNoFile) || ln.match(reNoAsyFile);
        if (m) {
          item.type = 'warning';
          item.logline = n;
          item.line = 0;
          item.message = m[0];
          flushItem();
          break;
        }
        // 3) errors (order matters: the generic "! ..." also catches package
        //    errors, exactly like TeXstudio — so the full text is preserved)
        m = ln.match(reLaTeXError) || ln.match(rePDFLaTeXError) || ln.match(reTeXError);
        if (m) {
          item.type = 'error';
          item.logline = n;
          item.message = m[1];
          cookie = ln.endsWith('.') ? LineNumber : Error;
          break;
        }
        // 4) nothing matched: keep tracking which file TeX is in
        updateFileStack(ln);
        break;
      }

      case Error:
        if (ln.endsWith('.')) {
          cookie = LineNumber;
          item.message += ln;
        } else if (n - item.logline > 3) {
          cookie = Start;
          flushItem();
        }
        break;

      case LineNumber: {
        const m = ln.match(reLineNumber);
        if (m) {
          cookie = Start;
          item.line = +m[2];
          item.message += m[3];
          flushItem();
        } else if (n - item.logline > 10) {
          cookie = Start;
          item.line = 0;
          flushItem();
        }
        break;
      }

      case Warning: {
        // package warning continuations: "(name)<15 spaces>rest"
        let rest = ln;
        const cm = rest.match(rePackageWarningContinued);
        if (cm) rest = rest.slice(cm[0].length);
        item.message += rest;
        cookie = Start;
        if (takeWarnLineNumber(n, rest.length)) flushItem();
        else cookie = Warning;
        break;
      }

      case BadBox: {
        item.message += ln;
        const bl = item.message.match(reBadBoxLines) || item.message.match(reBadBoxLine);
        if (bl) {
          item.message = bl[1];
          item.line = bl[3] ? Math.min(+bl[2], +bl[3]) : +bl[2];
          flushItem();
          cookie = ExpectingBadBoxTextQuote;
        } else if (reBadBoxOutput.test(item.message)
          || n - item.logline > 3 || ln.length === 0) {
          cookie = Start;
          item.line = 0;
          flushItem();
        }
        break;
      }

      default:
        cookie = Start;
        break;
    }
  }
  // flush a trailing unterminated item (log cut short)
  if (item.type) flushItem();

  return out;
}
