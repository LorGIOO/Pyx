//! Where a project's working files live.
//!
//! A LaTeX run produces a pile of files nobody asked for — `.aux`, `.log`,
//! `.toc`, `.out`, `.fls`, `.maf`, `.mtc0`, `.mtc1`, … one per chapter, plus
//! Pyx's own `.build.tex` copies. Writing them next to the document turns a
//! two-file project into thirty files, and the author cannot tell which ones
//! are theirs.
//!
//! None of it belongs in the user's folder. A `.docx` does not leave its
//! rendering scratch beside itself, and neither should a `.pltx`.
//!
//! So every project gets a working directory OUTSIDE the project, under the
//! OS cache folder, keyed by the root document's path. The engine writes
//! everything there; on save it is packed into the `.pltx` and on open it is
//! restored, so the working state survives without ever being visible.
//!
//! What stays in the user's folder is exactly what they put there: sources,
//! images, `.sty` packages — and the `.pltx` itself.

use std::path::{Path, PathBuf};

/// Root of every project's working directory.
///
/// `%LOCALAPPDATA%` on Windows, `$XDG_CACHE_HOME` (or `~/.cache`) on Linux,
/// `~/Library/Caches` on macOS, and the temp folder if none of them resolve.
fn cache_root() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Caches"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")));

    base.unwrap_or_else(std::env::temp_dir).join("Pyx").join("build")
}

/// 64-bit fingerprint of a string (FNV-1a). Same shape as the one the frontend
/// uses; it only has to be stable and collision-free enough to key a folder.
fn fingerprint(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    h
}

/// The working directory for the project whose ROOT document is `doc_path`.
///
/// The folder name carries the document's stem as well as the fingerprint, so
/// the cache is still readable by a human debugging a build.
pub fn build_dir(doc_path: &str) -> PathBuf {
    let p = Path::new(doc_path);
    // Canonicalize when possible so the same document reached by two different
    // paths (a mapped drive, a symlink) shares one working directory.
    let key = std::fs::canonicalize(p)
        .map(|c| c.to_string_lossy().to_string())
        .unwrap_or_else(|_| doc_path.to_string())
        .to_lowercase();
    let stem: String = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .take(24)
        .collect();
    cache_root().join(format!("{stem}-{:016x}", fingerprint(&key)))
}

/// Create (if needed) and return the project's working directory.
pub fn ensure_build_dir(doc_path: &str) -> Result<PathBuf, String> {
    let d = build_dir(doc_path);
    std::fs::create_dir_all(&d)
        .map_err(|e| format!("No se pudo preparar la carpeta de trabajo: {e}"))?;
    Ok(d)
}

/// Every file in the working directory, as (relative path, absolute path).
/// Relative paths use `/` so they round-trip through a zip unchanged.
pub fn walk(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    collect(dir, dir, &mut out, 0);
    out
}

fn collect(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>, depth: u32) {
    if depth > 6 {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect(root, &p, out, depth + 1);
        } else if let Ok(rel) = p.strip_prefix(root) {
            out.push((rel.to_string_lossy().replace('\\', "/"), p));
        }
    }
}
