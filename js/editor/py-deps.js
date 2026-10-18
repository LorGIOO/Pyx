// What a Python cell DEFINES and what it READS — the input to the dependency
// graph (dep-plan.js). The idea is marimo's: if we know which names each cell
// produces and consumes, editing one cell only has to re-run that cell and the
// cells downstream of it, instead of everything below it.
//
// The analysis is static, over the lezer-python tree CodeMirror already ships,
// so it runs in the editor while the kernel is busy and costs well under a
// millisecond per cell. It is deliberately CONSERVATIVE: every construct it
// cannot reason about precisely makes the cell `opaque`, and one opaque cell
// switches the planner back to the old, exact rule (re-run from the first
// changed cell). Getting this wrong can only cost speed, never a wrong number:
// a missed dependency is the one thing the planner cannot recover from, so
// whenever there is doubt, a name counts as read and as written.
//
// Python scoping, as far as it matters here:
//   * module level (the cell's top level): assignments, imports, def, class,
//     for targets, `with … as`, `except … as`, `del` and `:=` define names;
//   * a function's locals are decided statically (any assignment in its body),
//     so a function body's free names are globals read when it is called —
//     they count as reads of the cell that defines it;
//   * class bodies run at definition time, methods skip the class scope;
//   * comprehensions have their own scope, but `:=` inside binds outside.
//
// Besides plain names, mutations are recorded so the planner can tell
// `lst.append(1)` (which changes a list another cell built) from `lst[0]`:
//   strong  `x.a = …`, `x[i] = …`, `x.a += …`, `del x[i]`
//   method  `x.m(…)`  — resolved later (pure method? module? immutable value?)
//   arg     `f(x)`    — resolved later (builtin? library? user function?)

import { parser } from '@lezer/python';

const HANDCALCS_HEADER = /^\s*%%(render|tex)\b/;
// Builtins that reach into the namespace in ways no static reading can follow.
const OPAQUE_CALLS = new Set(['exec', 'eval', 'globals', 'locals', 'vars', '__import__', 'get_ipython']);

/**
 * @typedef {{kind:'strong', root:string}
 *   | {kind:'method', root:string, method:string, path:string[], temp:boolean, inplace:boolean}
 *   | {kind:'arg', root:string, callee:{kind:'name'|'member'|'complex', root:string|null, name:string|null, path:string[]}}
 *   | {kind:'out', root:string}} Mutation
 * @typedef {{defs:Set<string>, reads:Set<string>, imports:Map<string,string>,
 *   muts:Mutation[], fns:Map<string,{muts:Mutation[], refs:Set<string>}>,
 *   opaque:string|false}} CellInfo
 */

const cache = new Map();
const CACHE_MAX = 2000;

/** Analyze one cell body. Memoized by its text. @returns {CellInfo} */
export function analyzePython(code) {
  const hit = cache.get(code);
  if (hit) return hit;
  let info;
  try {
    info = analyze(code);
  } catch (_) {
    info = emptyInfo();
    info.opaque = 'análisis';
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(code, info);
  return info;
}

function emptyInfo() {
  return { defs: new Set(), reads: new Set(), imports: new Map(), muts: [], fns: new Map(), opaque: false };
}

function analyze(raw) {
  const info = emptyInfo();
  // IPython syntax: the handcalcs header is Pyx's own and only decides how the
  // body is shown; any other magic or shell escape can do anything at all.
  let headerSeen = false;
  const lines = raw.split('\n').map((ln) => {
    const t = ln.trim();
    if (!headerSeen && HANDCALCS_HEADER.test(ln)) { headerSeen = true; return ''; }
    if (t.startsWith('%') || t.startsWith('!')) info.opaque = 'magia de IPython';
    return ln;
  });
  if (info.opaque) return info;
  const code = lines.join('\n');
  const tree = parser.parse(code);
  let broken = false;
  tree.iterate({ enter: (n) => { if (n.type.isError) broken = true; } });
  if (broken) { info.opaque = 'error de sintaxis'; return info; }

  const text = (n) => code.slice(n.from, n.to);
  const kids = (n) => { const out = []; for (let c = n.firstChild; c; c = c.nextSibling) out.push(c); return out; };
  const isTok = (n, s) => n.name === s || (n.to - n.from === s.length && text(n) === s && !n.firstChild);

  // ---- scopes ----
  // module: {kind, bound:Set (unconditionally bound so far), cond:number}
  // function/class/comp: {kind, locals:Set, parent, fn (record of the
  //   module-level def/class this code belongs to, for its side effects)}
  const moduleScope = { kind: 'module', bound: new Set(), cond: 0 };

  /** Resolve a load. 'local' | 'module' (bound earlier in this cell) | 'free'. */
  function resolve(name, scope) {
    for (let s = scope; s; s = s.parent) {
      if (s.kind === 'module') return s.bound.has(name) ? 'module' : 'free';
      if (s.locals.has(name)) return 'local';
    }
    return 'free';
  }
  function fnOf(scope) {
    for (let s = scope; s; s = s.parent) if (s.fn) return s.fn;
    return null;
  }
  function load(name, scope, phase) {
    if (phase !== 'resolve') return;
    const r = resolve(name, scope);
    if (r === 'free') info.reads.add(name);
    const fn = fnOf(scope);
    if (fn && r !== 'local') fn.refs.add(name);
  }
  function store(name, scope, phase) {
    let s = scope;
    if (s.kind === 'module') {
      if (phase !== 'resolve') return;
      info.defs.add(name);
      if (s.cond === 0) s.bound.add(name);
      return;
    }
    if (phase === 'collect') s.locals.add(name);
  }
  /** Record a mutation of the object `root` names, if that object can belong
   *  to ANOTHER cell: a free name at module level, or any module-level name
   *  from inside a function (calling it later mutates the shared object). */
  function mutate(m, scope, phase) {
    if (phase !== 'resolve' || !m.root) return;
    const r = resolve(m.root, scope);
    if (r === 'local') return;
    const fn = fnOf(scope);
    if (fn) { fn.muts.push(m); return; }
    // A module imported by this very cell still has state of its own (the
    // random number generator): calls on it matter to other cells.
    if (r === 'free' || info.imports.has(m.root)) info.muts.push(m);
  }

  // ---- expressions ----
  /** The leftmost name of a member/subscript chain, its attribute path, and
   *  whether a call happens along the way (then the object is a temporary). */
  function chainOf(n) {
    const path = [];
    let temp = false;
    let cur = n;
    for (;;) {
      if (cur.name === 'VariableName') return { root: text(cur), path: path.reverse(), temp };
      if (cur.name === 'MemberExpression') {
        const k = kids(cur);
        const prop = k.find((c) => c.name === 'PropertyName');
        if (prop && k[k.length - 1] === prop) path.push(text(prop));
        cur = k[0];
        continue;
      }
      if (cur.name === 'CallExpression') { temp = true; cur = cur.firstChild; continue; }
      if (cur.name === 'ParenthesizedExpression') { const k = kids(cur).filter((c) => c.name !== '(' && c.name !== ')'); if (k.length !== 1) return null; cur = k[0]; continue; }
      return null;
    }
  }

  function walkArgs(argList, scope, phase, onArg) {
    const k = kids(argList);
    for (let i = 0; i < k.length; i++) {
      const c = k[i];
      if (c.name === '(' || c.name === ')' || c.name === ',' || c.name === '*' || c.name === '**' || isTok(c, '*') || isTok(c, '**')) continue;
      // keyword=value: the keyword is not a name being read.
      if (c.name === 'VariableName' && k[i + 1] && k[i + 1].name === 'AssignOp') {
        const kw = text(c);
        const val = k[i + 2];
        if (val) {
          walkExpr(val, scope, phase);
          if (onArg) onArg(val, kw);
        }
        i += 2;
        continue;
      }
      walkExpr(c, scope, phase);
      if (onArg) onArg(c, null);
    }
  }

  function walkCall(n, scope, phase) {
    const callee = n.firstChild;
    const args = kids(n).find((c) => c.name === 'ArgList');
    walkExpr(callee, scope, phase);
    let shape;
    if (callee.name === 'VariableName') {
      const name = text(callee);
      if (OPAQUE_CALLS.has(name) && resolve(name, scope) === 'free') info.opaque = `llamada a ${name}()`;
      shape = { kind: 'name', root: name, name, path: [] };
    } else if (callee.name === 'MemberExpression') {
      const ch = chainOf(callee);
      const k = kids(callee);
      const last = k[k.length - 1];
      if (ch && last && last.name === 'PropertyName') {
        shape = { kind: 'member', root: ch.root, name: text(last), path: ch.path.slice(0, -1), temp: ch.temp };
      } else shape = { kind: 'complex', root: ch ? ch.root : null, name: null, path: [] };
    } else shape = { kind: 'complex', root: null, name: null, path: [] };

    let inplace = false;
    const outs = [];
    const argRoots = [];
    if (args) {
      walkArgs(args, scope, phase, (val, kw) => {
        if (kw === 'inplace' && text(val) === 'True') inplace = true;
        const ch = chainOf(val);
        const root = ch && !ch.temp ? ch.root : (val.name === 'VariableName' ? text(val) : null);
        if (kw === 'out' && root) outs.push(root);
        else if (root && kw !== 'inplace') argRoots.push(root);
      });
    }
    for (const root of outs) mutate({ kind: 'out', root }, scope, phase);
    if (shape.kind === 'member') {
      mutate({ kind: 'method', root: shape.root, method: shape.name, path: shape.path, temp: !!shape.temp, inplace }, scope, phase);
    }
    // Arguments handed to a function may be modified by it; whether that can
    // happen is decided by the planner, which knows what the callee is.
    for (const root of argRoots) mutate({ kind: 'arg', root, callee: { kind: shape.kind, root: shape.root, name: shape.name, path: shape.path } }, scope, phase);
  }

  function walkComprehension(n, scope, phase) {
    const comp = { kind: 'comp', locals: new Set(), parent: scope };
    const k = kids(n);
    // Targets: between each `for` and its `in`.
    const targetIdx = new Set();
    let firstIter = -1;
    for (let i = 0; i < k.length; i++) {
      if (isTok(k[i], 'for')) {
        let j = i + 1;
        while (j < k.length && !isTok(k[j], 'in')) { targetIdx.add(j); j++; }
        if (firstIter < 0) firstIter = j + 1;
        i = j;
      }
    }
    for (const i of targetIdx) walkTarget(k[i], comp, 'collect');
    for (let i = 0; i < k.length; i++) {
      const c = k[i];
      if (targetIdx.has(i) || ['[', ']', '{', '}', '(', ')', ',', ':'].includes(c.name) || isTok(c, 'for') || isTok(c, 'in') || isTok(c, 'if') || isTok(c, 'async')) continue;
      // The first iterable is evaluated in the enclosing scope.
      walkExpr(c, i === firstIter ? scope : comp, phase);
    }
  }

  function walkLambda(n, scope, phase) {
    const fnScope = { kind: 'function', locals: new Set(), parent: scope };
    const params = kids(n).find((c) => c.name === 'ParamList');
    if (params) walkParams(params, scope, fnScope, phase);
    const body = n.lastChild;
    if (body && body !== params && body.name !== ':' && body.name !== 'lambda') walkExpr(body, fnScope, phase);
  }

  function walkExpr(n, scope, phase) {
    if (!n) return;
    switch (n.name) {
      case 'VariableName': load(text(n), scope, phase); return;
      case 'PropertyName': case 'String': case 'Number': case 'Boolean': case 'None': case 'Ellipsis': case 'Comment': return;
      case 'CallExpression': walkCall(n, scope, phase); return;
      case 'LambdaExpression': walkLambda(n, scope, phase); return;
      case 'ArrayComprehensionExpression': case 'DictionaryComprehensionExpression':
      case 'SetComprehensionExpression': case 'ComprehensionExpression':
        walkComprehension(n, scope, phase); return;
      case 'NamedExpression': {
        const k = kids(n);
        if (k[2]) walkExpr(k[2], scope, phase);
        let s = scope;
        while (s.kind === 'comp') s = s.parent;
        if (k[0] && k[0].name === 'VariableName') {
          if (s.kind === 'module') {
            // Inside an expression: may or may not run (short-circuit).
            s.cond++; store(text(k[0]), s, phase); s.cond--;
          } else store(text(k[0]), s, phase);
        }
        return;
      }
      default:
        for (let c = n.firstChild; c; c = c.nextSibling) walkExpr(c, scope, phase);
    }
  }

  // ---- targets ----
  function walkTarget(n, scope, phase) {
    switch (n.name) {
      case 'VariableName': store(text(n), scope, phase); return;
      case 'TupleExpression': case 'ArrayExpression': case 'ParenthesizedExpression':
        for (let c = n.firstChild; c; c = c.nextSibling) {
          if ([',', '(', ')', '[', ']', '*'].includes(c.name) || isTok(c, '*')) continue;
          walkTarget(c, scope, phase);
        }
        return;
      case 'MemberExpression': {
        // `x.a = …` / `x[i] = …`: reads x and the index, and changes x.
        walkExpr(n, scope, phase);
        const ch = chainOf(n);
        if (ch && !ch.temp) mutate({ kind: 'strong', root: ch.root }, scope, phase);
        return;
      }
      default:
        if (n.name === '*' || isTok(n, '*')) return;
        walkExpr(n, scope, phase);
    }
  }

  function walkParams(params, outer, fnScope, phase) {
    const k = kids(params);
    for (let i = 0; i < k.length; i++) {
      const c = k[i];
      if (c.name === 'VariableName') {
        fnScope.locals.add(text(c));
      } else if (c.name === 'AssignOp') {
        // default value: evaluated where the function is DEFINED.
        if (k[i + 1]) walkExpr(k[i + 1], outer, phase);
        i++;
      } else if (c.name === 'TypeDef') {
        walkExpr(c, outer, phase);
      }
    }
  }

  // ---- statements ----
  function walkBody(n, scope, phase) {
    for (let c = n.firstChild; c; c = c.nextSibling) walkStmt(c, scope, phase);
  }
  function conditional(scope, fn) {
    if (scope.kind === 'module') scope.cond++;
    try { fn(); } finally { if (scope.kind === 'module') scope.cond--; }
  }

  function walkFunction(n, scope, phase, decorators) {
    const k = kids(n);
    const nameNode = k.find((c) => c.name === 'VariableName');
    const params = k.find((c) => c.name === 'ParamList');
    const body = k.find((c) => c.name === 'Body');
    for (const d of decorators || []) walkExpr(d, scope, phase);
    // Return annotation.
    for (const c of k) if (c.name === 'TypeDef') walkExpr(c, scope, phase);
    if (nameNode) store(text(nameNode), scope, phase);
    if (phase !== 'resolve') return; // its body is not part of the enclosing collect
    let rec = fnOf(scope);
    if (!rec && scope.kind === 'module' && nameNode) {
      rec = { muts: [], refs: new Set() };
      info.fns.set(text(nameNode), rec);
    }
    const fnScope = { kind: 'function', locals: new Set(), parent: scope.kind === 'class' ? scope.parent : scope, fn: rec };
    if (params) walkParams(params, scope, fnScope, 'collect');
    if (body) { walkBody(body, fnScope, 'collect'); walkBody(body, fnScope, 'resolve'); }
    if (params) {
      // Default values and annotations run where the function is DEFINED.
      const pk = kids(params);
      for (let i = 0; i < pk.length; i++) {
        if (pk[i].name === 'AssignOp' && pk[i + 1]) { walkExpr(pk[i + 1], scope, 'resolve'); i++; }
        else if (pk[i].name === 'TypeDef') walkExpr(pk[i], scope, 'resolve');
      }
    }
  }

  function walkClass(n, scope, phase, decorators) {
    const k = kids(n);
    const nameNode = k.find((c) => c.name === 'VariableName');
    const args = k.find((c) => c.name === 'ArgList');
    const body = k.find((c) => c.name === 'Body');
    for (const d of decorators || []) walkExpr(d, scope, phase);
    if (args) walkArgs(args, scope, phase);
    if (nameNode) store(text(nameNode), scope, phase);
    if (phase !== 'resolve') return;
    let rec = fnOf(scope);
    if (!rec && scope.kind === 'module' && nameNode) {
      rec = { muts: [], refs: new Set() };
      info.fns.set(text(nameNode), rec);
    }
    const cls = { kind: 'class', locals: new Set(), parent: scope, fn: rec };
    if (body) { walkBody(body, cls, 'collect'); walkBody(body, cls, 'resolve'); }
  }

  function walkImport(n, scope, phase) {
    const k = kids(n);
    const isFrom = k[0] && isTok(k[0], 'from');
    let i = 0;
    if (isFrom) {
      i = 1;
      let mod = '';
      while (i < k.length && !isTok(k[i], 'import')) { mod += text(k[i]); i++; }
      i++;
      for (; i < k.length; i++) {
        const c = k[i];
        if (c.name === '*' || isTok(c, '*')) { info.opaque = 'from … import *'; return; }
        if (c.name !== 'VariableName') continue;
        let name = text(c);
        if (k[i + 1] && isTok(k[i + 1], 'as') && k[i + 2]) { name = text(k[i + 2]); i += 2; }
        store(name, scope, phase);
        if (phase === 'resolve' && scope.kind === 'module') info.imports.set(name, mod);
      }
      return;
    }
    // import a.b.c [as d], e
    i = 1;
    while (i < k.length) {
      if (k[i].name !== 'VariableName') { i++; continue; }
      const first = text(k[i]);
      let mod = first;
      let j = i + 1;
      while (j < k.length && (k[j].name === '.' || (k[j].name === 'VariableName' && k[j - 1].name === '.'))) { mod += text(k[j]); j++; }
      let name = first;
      // `import a.b` binds `a` (the package); `import a.b as c` binds the submodule.
      if (k[j] && isTok(k[j], 'as') && k[j + 1]) { name = text(k[j + 1]); j += 2; } else mod = first;
      store(name, scope, phase);
      if (phase === 'resolve' && scope.kind === 'module') info.imports.set(name, mod);
      i = j;
    }
  }

  function walkStmt(n, scope, phase) {
    switch (n.name) {
      case 'Comment': case ':': case ';': case 'PassStatement': case 'BreakStatement': case 'ContinueStatement': return;
      case 'StatementGroup': walkBody(n, scope, phase); return;
      case 'AssignStatement': {
        const k = kids(n);
        const segs = [[]];
        for (const c of k) {
          if (c.name === 'AssignOp') segs.push([]);
          else segs[segs.length - 1].push(c);
        }
        if (segs.length === 1) {
          // `x: int` — an annotation without a value.
          for (const c of segs[0]) (c.name === 'TypeDef' ? walkExpr(c, scope, phase) : walkTarget(c, scope, phase));
          return;
        }
        for (const c of segs[segs.length - 1]) walkExpr(c, scope, phase);
        for (const seg of segs.slice(0, -1)) {
          for (const c of seg) {
            if (c.name === ',' ) continue;
            if (c.name === 'TypeDef') { walkExpr(c, scope, phase); continue; }
            walkTarget(c, scope, phase);
          }
        }
        return;
      }
      case 'UpdateStatement': {
        const k = kids(n);
        const target = k[0];
        for (const c of k.slice(2)) walkExpr(c, scope, phase);
        if (target.name === 'VariableName') {
          load(text(target), scope, phase);
          store(text(target), scope, phase);
        } else walkTarget(target, scope, phase);
        return;
      }
      case 'ImportStatement': walkImport(n, scope, phase); return;
      case 'DecoratedStatement': {
        const k = kids(n);
        const decos = k.filter((c) => c.name === 'Decorator').flatMap((d) => kids(d).filter((c) => c.name !== 'At' && c.name !== '@'));
        const def = k.find((c) => c.name === 'FunctionDefinition' || c.name === 'ClassDefinition');
        if (def && def.name === 'FunctionDefinition') walkFunction(def, scope, phase, decos);
        else if (def) walkClass(def, scope, phase, decos);
        return;
      }
      case 'FunctionDefinition': walkFunction(n, scope, phase); return;
      case 'ClassDefinition': walkClass(n, scope, phase); return;
      case 'ForStatement': {
        const k = kids(n);
        const inAt = k.findIndex((c) => isTok(c, 'in'));
        const bodies = k.filter((c) => c.name === 'Body');
        for (let i = inAt + 1; i < k.length; i++) if (k[i].name !== 'Body') walkExpr(k[i], scope, phase);
        conditional(scope, () => {
          for (let i = 0; i < inAt; i++) {
            if (isTok(k[i], 'for') || isTok(k[i], 'async') || k[i].name === ',') continue;
            walkTarget(k[i], scope, phase);
          }
          for (const b of bodies) walkBody(b, scope, phase);
        });
        return;
      }
      case 'WhileStatement': case 'IfStatement': {
        for (const c of kids(n)) {
          if (c.name === 'Body') conditional(scope, () => walkBody(c, scope, phase));
          else if (!['if', 'elif', 'else', 'while'].includes(c.name)) walkExpr(c, scope, phase);
        }
        return;
      }
      case 'TryStatement': {
        const k = kids(n);
        conditional(scope, () => {
          for (let i = 0; i < k.length; i++) {
            const c = k[i];
            if (c.name === 'Body') walkBody(c, scope, phase);
            else if (isTok(c, 'as') && k[i + 1]) { walkTarget(k[i + 1], scope, phase); i++; }
            else if (!['try', 'except', 'finally', 'else', '*'].includes(c.name)) walkExpr(c, scope, phase);
          }
        });
        return;
      }
      case 'WithStatement': {
        const k = kids(n);
        for (let i = 0; i < k.length; i++) {
          const c = k[i];
          if (c.name === 'Body') walkBody(c, scope, phase);
          else if (isTok(c, 'as') && k[i + 1]) { walkTarget(k[i + 1], scope, phase); i++; }
          else if (!['with', 'async', ',', '(', ')'].includes(c.name)) walkExpr(c, scope, phase);
        }
        return;
      }
      case 'DeleteStatement': {
        for (const c of kids(n)) {
          if (c.name === 'VariableName') {
            store(text(c), scope, phase);
            if (scope.kind === 'module') scope.bound.delete(text(c));
          } else if (c.name !== 'del' && c.name !== ',') walkTarget(c, scope, phase);
        }
        return;
      }
      case 'ScopeStatement': {
        if (scope.kind !== 'module' && n.firstChild && isTok(n.firstChild, 'global')) info.opaque = 'global';
        return;
      }
      case 'MatchStatement': info.opaque = 'match'; return;
      case 'TypeDefinition': {
        const k = kids(n);
        const nameNode = k.find((c) => c.name === 'VariableName');
        for (const c of k) if (c !== nameNode && c.name !== 'type' && c.name !== 'AssignOp') walkExpr(c, scope, phase);
        if (nameNode) store(text(nameNode), scope, phase);
        return;
      }
      default:
        // Expression, return, raise, assert, yield, print…
        for (let c = n.firstChild; c; c = c.nextSibling) {
          if (['return', 'raise', 'assert', 'yield', 'from', 'print', ','].includes(c.name)) continue;
          walkExpr(c, scope, phase);
        }
    }
  }

  walkBody(tree.topNode, moduleScope, 'resolve');
  // IPython's history variables change with every run, whatever the cell.
  for (const r of info.reads) {
    if (/^(In|Out|_+|_i+|_ih|_oh|_\d+|_i\d+)$/.test(r)) { info.opaque = 'historial de IPython'; break; }
  }
  return info;
}
