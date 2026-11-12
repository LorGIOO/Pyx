// Shared path helpers (Windows- and POSIX-style separators). ONE definition —
// these used to be duplicated, with diverging fallbacks, across seven modules.

/** Directory part of a path, or null when there is no path / no separator. */
export function dirOf(path) {
  if (!path) return null;
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(0, i) : null;
}

/** File name (last path segment). */
export function baseName(path) {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** File name without its extension. */
export function stemOf(path) {
  const b = baseName(path);
  const dot = b.lastIndexOf('.');
  return dot > 0 ? b.slice(0, dot) : b;
}

/** Path of `p` relative to `base`, with `/` separators, or null when `p` is
 *  not under `base`. Comparison is case-insensitive and separator-agnostic,
 *  which is what Windows needs and what does no harm elsewhere. */
export function relativeTo(base, p) {
  if (!base || !p) return null;
  const norm = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const b = norm(base), f = norm(p);
  if (f.toLowerCase() === b.toLowerCase()) return '';
  const prefix = b.toLowerCase() + '/';
  return f.toLowerCase().startsWith(prefix) ? f.slice(prefix.length) : null;
}

/**
 * `target` as LaTeX should name it from the folder `baseDir`: relative, with
 * forward slashes, climbing with `..` when it is not underneath
 * (`../999. Recursos/2. Imagenes/plano.pdf`). A file on another drive — which
 * no relative path reaches — comes back absolute, with forward slashes.
 */
export function relativePath(baseDir, target) {
  if (!target) return '';
  const split = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  const t = split(target);
  if (!baseDir) return t.join('/');
  const b = split(baseDir);
  // Different roots (C: against E:, or a network share): no relative route.
  if ((b[0] || '').toLowerCase() !== (t[0] || '').toLowerCase()) return t.join('/');
  let i = 0;
  while (i < b.length && i < t.length - 1 && b[i].toLowerCase() === t[i].toLowerCase()) i++;
  return [...Array(b.length - i).fill('..'), ...t.slice(i)].join('/');
}

/** Join a directory and a name using the directory's own separator style. */
export function joinPath(dir, name) {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + sep + name;
}

/**
 * The canonical spelling of a path: `.` segments dropped, `..` resolved, one
 * separator style (the path's own: `\` when it has any backslash).
 *
 * `\input{./capitulo.pltx}` used to produce `C:\proyecto\./capitulo.pltx`,
 * which is not the same STRING as the `C:\proyecto\capitulo.pltx` the editor
 * has open — so the compile did not recognise the open chapter and typeset
 * the copy on disk instead of what was on screen.
 */
export function normalizePath(p) {
  if (!p) return p;
  const s = String(p);
  const back = s.includes('\\');
  const sep = back ? '\\' : '/';
  const parts = s.replace(/\\/g, '/').split('/');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === '.' || (seg === '' && i > 0 && i < parts.length - 1 && !(i === 1 && parts[0] === ''))) continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..' && !/^[a-zA-Z]:$/.test(out[out.length - 1]) && out[out.length - 1] !== '') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join(sep);
}

/** Do two paths name the same file? Case-insensitive and separator-agnostic
 *  (Windows), after normalizing `.` and `..`. */
export function samePath(a, b) {
  if (!a || !b) return false;
  return normalizePath(a).replace(/\\/g, '/').toLowerCase()
    === normalizePath(b).replace(/\\/g, '/').toLowerCase();
}
