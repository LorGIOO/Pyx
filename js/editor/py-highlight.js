// Python syntax classification, faithful to what VSCode shows in a .py file.
//
// VSCode paints Python with TWO layers: the MagicPython TextMate grammar and
// Pylance's semantic tokens. A stream tokenizer (what Pyx used before) cannot
// reproduce either, because almost every interesting distinction needs
// structure, not characters:
//
//   foo(x)        foo is a FUNCTION (#DCDCAA), x is a variable (#9CDCFE)
//   obj.attr      attr is a PROPERTY (#9CDCFE)
//   obj.meth()    meth is a METHOD  (#DCDCAA)
//   class Viga    Viga is a TYPE    (#4EC9B0)
//   MAX = 3       MAX is a CONSTANT (#4FC1FF)
//   "a\nb"        \n is an ESCAPE   (#D7BA7D) inside a string (#CE9178)
//   f"{x:.2f}"    the braces are blue, the expression inside is code
//
// So this module parses the cell with the real Lezer Python grammar and walks
// the tree. `classifyPython` is pure (offsets relative to the given text), so
// the whole palette is unit-testable without an editor.
//
// Class names map 1:1 to the --py-* CSS variables in themes.css; the comment
// on each case names the VSCode scope it reproduces.

import { pythonLanguage } from '@codemirror/lang-python';

/* ---------- vocabulary lifted from MagicPython (the grammar VSCode ships) ---------- */

// support.function.builtin.python
const BUILTIN_FUNCS = new Set(['__import__', 'abs', 'aiter', 'all', 'any', 'anext', 'ascii',
  'bin', 'breakpoint', 'callable', 'chr', 'compile', 'copyright', 'credits', 'delattr', 'dir',
  'divmod', 'enumerate', 'eval', 'exec', 'exit', 'filter', 'format', 'getattr', 'globals',
  'hasattr', 'hash', 'help', 'hex', 'id', 'input', 'isinstance', 'issubclass', 'iter', 'len',
  'license', 'locals', 'map', 'max', 'memoryview', 'min', 'next', 'oct', 'open', 'ord', 'pow',
  'print', 'quit', 'range', 'reload', 'repr', 'reversed', 'round', 'setattr', 'sorted', 'sum',
  'vars', 'zip']);

// support.type.python — builtin types (and `super`, which MagicPython groups here)
const BUILTIN_TYPES = new Set(['bool', 'bytearray', 'bytes', 'classmethod', 'complex', 'dict',
  'float', 'frozenset', 'int', 'list', 'object', 'property', 'set', 'slice', 'staticmethod',
  'str', 'tuple', 'type', 'super']);

// support.type.exception.python — matched by shape, the way MagicPython does.
const EXCEPTION_RE = /^(?:[A-Z]\w*(?:Error|Warning)|SystemExit|Stop(?:Async)?Iteration|KeyboardInterrupt|GeneratorExit|(?:Base)?Exception)$/;

// variable.language.special.self / .cls
const SELF_NAMES = new Set(['self', 'cls']);

// keyword.operator.logical.python — these are NOT control keywords in VSCode:
// they are blue (#569CD6), not purple (#C586C0). Pyx used to paint them purple.
const LOGICAL = new Set(['and', 'or', 'not', 'in', 'is']);

// storage.type.* / storage.modifier.*  (`async` is storage only in `async def`;
// on its own — `async for` — MagicPython files it under keyword.control.flow.)
const STORAGE = new Set(['def', 'class', 'lambda', 'global', 'nonlocal']);

// constant.language.python
const ATOMS = new Set(['True', 'False', 'None', 'NotImplemented', 'Ellipsis']);

// Lezer spells operators as dedicated node names.
const OPERATOR_NODES = new Set(['ArithOp', 'CompareOp', 'AssignOp', 'BitOp', 'UpdateOp']);

// PEP 8 CapWords — how Python spells a class name.
const CAPWORDS = /^_?[A-Z][a-z0-9]\w*$/;

// constant.other.caps.python: "enough" upper case, as the grammar puts it.
function isCaps(name) {
  return /^_*[A-Z][A-Z0-9_]*$/.test(name) && (name.match(/[A-Z]/g) || []).length >= 2;
}
// support.function.magic.python vs support.variable.magic.python
const isDunder = (n) => /^__\w+__$/.test(n);

/* ---------- Jupyter magics ----------
   `%%render`, `%matplotlib inline`, `!pip install …` are not Python and would
   derail the parser, so they are recognised per line and blanked out of the
   text handed to it (keeping the offsets identical). */
const MAGIC_RE = /^[ \t]*(?:%{1,2}[A-Za-z]\w*.*|![^\n]*)$/;

function maskMagics(code) {
  const marks = [];
  let masked = code;
  let at = 0;
  for (const raw of code.split('\n')) {
    if (MAGIC_RE.test(raw)) {
      const s = at + (raw.length - raw.trimStart().length);
      const e = at + raw.length;
      if (e > s) {
        marks.push({ from: s, to: e, cls: 'cm-py-magiccmd' });
        masked = masked.slice(0, s) + ' '.repeat(e - s) + masked.slice(e);
      }
    }
    at += raw.length + 1;
  }
  return { masked, marks };
}

/* ---------- name resolution ---------- */

// What a bare name means depends on how the cell binds it. VSCode gets this
// from Pylance; we collect the same three bindings from the tree itself.
function collectSymbols(tree, text) {
  const funcs = new Set();
  const classes = new Set();
  const modules = new Set();
  tree.iterate({
    enter(n) {
      // A name that is called anywhere is a function everywhere — that is how
      // `from math import sqrt` ends up yellow on the import line too.
      if (n.name === 'CallExpression') {
        const callee = n.node.firstChild;
        if (callee && callee.name === 'VariableName') {
          funcs.add(text.slice(callee.from, callee.to));
        }
      }
      if (n.name === 'FunctionDefinition' || n.name === 'ClassDefinition') {
        const id = n.node.getChild('VariableName');
        if (id) (n.name === 'ClassDefinition' ? classes : funcs).add(text.slice(id.from, id.to));
      } else if (n.name === 'ImportStatement') {
        // `import numpy as np` binds namespaces; `from math import sqrt` binds
        // whatever the module exports, which we cannot know — so only the
        // plain form contributes namespace names.
        const src = text.slice(n.from, n.to);
        if (!/^\s*from\b/.test(src)) {
          for (const id of n.node.getChildren('VariableName')) {
            modules.add(text.slice(id.from, id.to));
          }
        } else {
          const first = n.node.getChild('VariableName');
          if (first) modules.add(text.slice(first.from, first.to));
        }
      }
    },
  });
  return { funcs, classes, modules };
}

/** Is this node the callee of a call, i.e. does a `(` follow it directly? */
function isCallee(node) {
  const p = node.parent;
  if (!p) return false;
  if (p.name === 'CallExpression') return p.firstChild && p.firstChild.from === node.from;
  if (p.name === 'MemberExpression') {
    const g = p.parent;
    return !!(g && g.name === 'CallExpression' && g.firstChild && g.firstChild.from === p.from
      && p.lastChild && p.lastChild.from === node.from);
  }
  return false;
}

function inNode(node, names) {
  for (let p = node.parent; p; p = p.parent) {
    if (names.has(p.name)) return true;
    if (p.name === 'Script') return false;
  }
  return false;
}

const PARAM_PARENTS = new Set(['ParamList']);
const TYPE_PARENTS = new Set(['TypeDef']);
const DECORATOR_PARENTS = new Set(['Decorator']);

function classifyName(node, name, sym) {
  if (SELF_NAMES.has(name)) return 'cm-py-self';            // variable.language
  if (ATOMS.has(name)) return 'cm-py-atom';                 // constant.language
  if (BUILTIN_TYPES.has(name) || EXCEPTION_RE.test(name)) return 'cm-py-type'; // support.type
  if (BUILTIN_FUNCS.has(name)) return 'cm-py-builtin';      // support.function.builtin

  const p = node.parent;
  if (p) {
    // The name being DEFINED by `def` / `class`.
    if (p.name === 'FunctionDefinition' && p.firstChild) {
      const id = p.getChild('VariableName');
      if (id && id.from === node.from) return 'cm-py-func';  // entity.name.function
    }
    if (p.name === 'ClassDefinition') {
      const id = p.getChild('VariableName');
      if (id && id.from === node.from) return 'cm-py-type';  // entity.name.type.class
    }
    // `class X(Base)` — a base class is entity.other.inherited-class.
    if (p.name === 'ArgList' && p.parent && p.parent.name === 'ClassDefinition') {
      return 'cm-py-type';
    }
    if (p.name === 'Decorator') return 'cm-py-decorator';    // entity.name.function.decorator
  }
  // A class stays a class at its call site: `Viga(5)` constructs, it is not a
  // function call, and VSCode paints it with the type color there too.
  if (sym.classes.has(name)) return 'cm-py-type';
  if (isCallee(node)) {
    // `OrderedDict(...)`, `Path(...)`, `Decimal(...)`: PEP 8 reserves CapWords
    // for classes, and that is what Pylance reports for them, so a capitalised
    // callee gets the type color rather than the function one.
    return CAPWORDS.test(name) ? 'cm-py-type' : 'cm-py-func';
  }
  // `x: Viga` / `-> Viga`: an annotation names a type, never a parameter.
  if (inNode(node, TYPE_PARENTS)) return 'cm-py-type';
  if (inNode(node, PARAM_PARENTS)) return 'cm-py-param';     // variable.parameter
  if (isDunder(name)) return 'cm-py-magic';                  // support.variable.magic
  if (sym.funcs.has(name)) return 'cm-py-func';
  if (sym.modules.has(name)) return 'cm-py-namespace';       // entity.name.namespace
  if (isCaps(name)) return 'cm-py-constant';                 // variable.other.constant
  return 'cm-py-variable';                                   // variable
}

/** `obj.attr` — what the part after the dot means. */
function classifyProperty(node, name, sym) {
  if (isCallee(node)) return CAPWORDS.test(name) ? 'cm-py-type' : 'cm-py-func';
  if (isDunder(name)) return 'cm-py-magic';
  if (isCaps(name)) return 'cm-py-constant';
  // `os.path.join(...)`: the middle of a dotted module path is still a module,
  // and VSCode colors it as one.
  const owner = node.parent;                       // the MemberExpression
  const outer = owner && owner.parent;
  if (outer && outer.name === 'MemberExpression' && outer.firstChild
      && outer.firstChild.from === owner.from) {
    let root = owner;
    while (root && root.name === 'MemberExpression') root = root.firstChild;
    if (root && root.name === 'VariableName') {
      // The root identifier's text tells us whether this is a module chain.
      const doc = root;
      if (sym.modules.has(nodeText(doc))) return 'cm-py-namespace';
    }
  }
  return 'cm-py-property';
}

// Set once per classifyPython run so the helpers above can read node text.
let TEXT = '';
const nodeText = (n) => TEXT.slice(n.from, n.to);

/* ---------- literals ----------
   Three details VSCode shows that a single flat "string"/"number" color hides:
   the prefix letters (`r`, `b`, `f`) are storage-colored, a RAW string is a
   different red from an ordinary one, and `%s` / `{0}` placeholders are
   colored like constants. */
const STR_PREFIX = /^[rRbBuUfF]{1,3}(?=['"])/;
const DOUBLE_BRACE = /\{\{|\}\}/g;
const PLACEHOLDER = /%[-+ #0-9.*]*[bcdeEfFgGnorsxX%]|\{[A-Za-z0-9_.[\]!:<>^+ ,.]*\}/g;

function markString(text, from, to, out, placeholders) {
  const raw = text.slice(from, to);
  const pre = raw.match(STR_PREFIX);
  const isRaw = !!pre && /[rR]/.test(pre[0]);
  out.push({ from, to, cls: isRaw ? 'cm-py-rawstring' : 'cm-py-string' });
  if (pre) out.push({ from, to: from + pre[0].length, cls: 'cm-py-strprefix' });
  // `{{` / `}}` are escaped braces in BOTH plain and f-strings, and VSCode
  // colors them like any other escape sequence.
  DOUBLE_BRACE.lastIndex = 0;
  const escaped = [];
  let b;
  while ((b = DOUBLE_BRACE.exec(raw))) {
    escaped.push([b.index, DOUBLE_BRACE.lastIndex]);
    out.push({ from: from + b.index, to: from + DOUBLE_BRACE.lastIndex, cls: 'cm-py-escape' });
  }
  if (!placeholders) return;
  PLACEHOLDER.lastIndex = 0;
  let m;
  while ((m = PLACEHOLDER.exec(raw))) {
    // `{{literales}}` is an escaped brace pair, so what sits between them is
    // plain text, not a `.format()` placeholder.
    const s0 = m.index;
    const e0 = PLACEHOLDER.lastIndex;
    if (escaped.some(([a, z]) => s0 < z && e0 > a)) continue;
    out.push({ from: from + s0, to: from + e0, cls: 'cm-py-placeholder' });
  }
}

// `0x1F` and `4j` are each TWO colors in VSCode: the base prefix and the
// imaginary suffix are storage-colored, the digits are not.
function markNumber(text, from, to, out) {
  const raw = text.slice(from, to);
  let s = from;
  let e = to;
  if (/^0[xXoObB]/.test(raw)) { out.push({ from, to: from + 2, cls: 'cm-py-numprefix' }); s = from + 2; }
  if (/[jJlL]$/.test(raw)) { out.push({ from: to - 1, to, cls: 'cm-py-numprefix' }); e = to - 1; }
  if (e > s) out.push({ from: s, to: e, cls: 'cm-py-number' });
}

/* ---------- the walk ---------- */

/**
 * Classify one chunk of Python.
 * @param {string} code
 * @returns {{from:number,to:number,cls:string}[]} sorted, non-overlapping
 */
export function classifyPython(code) {
  if (!code) return [];
  const { masked, marks } = maskMagics(code);
  TEXT = masked;
  const out = marks.slice();
  let tree;
  try {
    tree = pythonLanguage.parser.parse(masked);
  } catch (_) {
    return out;
  }
  const sym = collectSymbols(tree, masked);

  tree.iterate({
    enter(n) {
      const { name, from, to } = n;
      if (to <= from) return;
      switch (name) {
        case 'Comment':
          out.push({ from, to, cls: 'cm-py-comment' });
          return false;
        case 'String':
          // Descend: escape sequences inside a string get their own color.
          markString(masked, from, to, out, true);
          return;
        case 'FormatString':
          // Only the literal shell is string-colored; the replacements below
          // are real code and are classified on their own.
          markString(masked, from, to, out, false);
          return;
        case 'Escape':
          out.push({ from, to, cls: 'cm-py-escape' });
          return false;
        case 'FormatReplacement': {
          out.push({ from, to: from + 1, cls: 'cm-py-fstring-brace' });
          if (to - 1 > from) out.push({ from: to - 1, to, cls: 'cm-py-fstring-brace' });
          // `{x!r}` and `{x=}`: the conversion and the debug `=` are part of
          // the format machinery, not of the expression.
          const body = masked.slice(from, to);
          const conv = body.match(/![rsa](?=[:}])/);
          if (conv) out.push({ from: from + conv.index, to: from + conv.index + 2, cls: 'cm-py-format' });
          const dbg = body.match(/=(?=[!:}])/);
          if (dbg) out.push({ from: from + dbg.index, to: from + dbg.index + 1, cls: 'cm-py-format' });
          return;
        }
        case 'FormatSpec':
          // VSCode scopes a format spec storage.type.format.python — it is not
          // string-colored. Descend, because a spec may itself hold a nested
          // replacement: f"{x:>{width}}".
          out.push({ from, to, cls: 'cm-py-format' });
          return;
        case 'Number':
          markNumber(masked, from, to, out);
          return false;
        case 'Boolean':
        case 'None':
          out.push({ from, to, cls: 'cm-py-atom' });
          return false;
        case 'VariableName':
        case 'PropertyName': {
          const text = masked.slice(from, to);
          const cls = name === 'PropertyName'
            ? classifyProperty(n.node, text, sym)
            : classifyName(n.node, text, sym);
          out.push({ from, to, cls });
          return false;
        }
        case 'At':
          out.push({ from, to, cls: 'cm-py-decorator' });
          return false;
        case '.':
          // `@mod.deco` — the separator is part of the decorator name in
          // VSCode, so it takes the same color.
          if (inNode(n.node, DECORATOR_PARENTS)) {
            out.push({ from, to, cls: 'cm-py-decorator' });
            return false;
          }
          return;
        default:
          break;
      }
      if (OPERATOR_NODES.has(name)) {
        out.push({ from, to, cls: 'cm-py-operator' });
        return false;
      }
      // Keyword tokens are spelled as their own literal in this grammar.
      if (/^[a-z]+$/.test(name) && masked.slice(from, to) === name) {
        const isAsyncDef = name === 'async' && n.node.parent
          && n.node.parent.name === 'FunctionDefinition';
        // `for x in y` — the `in` belongs to the loop, and VSCode paints it
        // purple like the `for`. The membership test `a in b` stays blue.
        const isLoopIn = name === 'in' && n.node.parent
          && /For|Comprehension/.test(n.node.parent.name);
        // `type Alias = int` (PEP 695): MagicPython has no rule for the soft
        // keyword, so `type` keeps its builtin-type color.
        if (name === 'type') out.push({ from, to, cls: 'cm-py-type' });
        else if (isLoopIn) out.push({ from, to, cls: 'cm-py-control' });
        else if (LOGICAL.has(name)) out.push({ from, to, cls: 'cm-py-logic' });
        else if (STORAGE.has(name) || isAsyncDef) out.push({ from, to, cls: 'cm-py-storage' });
        else out.push({ from, to, cls: 'cm-py-control' });
        return false;
      }
      return undefined;
    },
  });

  out.sort((a, b) => a.from - b.from || b.to - a.to);
  return out;
}

/* ---------- cache ----------
   Cells are re-tokenized on every keystroke and on every scroll. Parsing the
   same unchanged cell again is pure waste, so results are memoized by text. */
const CACHE = new Map();
const CACHE_MAX = 200;

export function classifyPythonCached(code) {
  const hit = CACHE.get(code);
  if (hit) return hit;
  const val = classifyPython(code);
  CACHE.set(code, val);
  if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  return val;
}
