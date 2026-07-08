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

/** Join a directory and a name using the directory's own separator style. */
export function joinPath(dir, name) {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + sep + name;
}
