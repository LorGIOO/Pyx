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
    // Canonicalize so the same document reached by two different paths (a
    // mapped drive, a symlink) shares one working directory.
    //
    // The FOLDER, not the file: canonicalizing fails for a file that does not
    // exist yet, and the fallback is a different string (on Windows the
    // canonical form is `\\?\C:\…`). The same document then hashed to two
    // working directories depending on whether it had been saved at that
    // instant — a save packed one and an open restored into the other. For a
    // file that exists, folder + name is exactly what canonicalizing the file
    // gave, so existing working directories keep their identity.
    let key = p
        .parent()
        .and_then(|d| std::fs::canonicalize(d).ok())
        .zip(p.file_name())
        .map(|(d, f)| d.join(f).to_string_lossy().to_string())
        .unwrap_or_else(|| doc_path.to_string())
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

/// Working directories an engine is writing into right now.
///
/// Saving a `.pltx` packs its working directory. A save that lands while a
/// compile runs — Ctrl+S, then Ctrl+S again before the first compile ends —
/// packed files the engine had not finished: a user's document came back with
/// a `build/X.synctex(busy)` and a log cut off mid-line inside it. The engine
/// marks the directory for as long as it runs, and the save leaves it alone.
static BUSY: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// One spelling per directory: both separators, any case, no trailing slash.
fn busy_key(dir: &Path) -> String {
    dir.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

/// While this lives, `dir` counts as being written by an engine.
pub struct BusyGuard(String);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        if let Ok(mut v) = BUSY.lock() {
            if let Some(i) = v.iter().position(|k| *k == self.0) {
                v.remove(i);
            }
        }
    }
}

pub fn mark_busy(dir: &Path) -> BusyGuard {
    let k = busy_key(dir);
    if let Ok(mut v) = BUSY.lock() {
        v.push(k.clone());
    }
    BusyGuard(k)
}

pub fn is_busy(dir: &Path) -> bool {
    let k = busy_key(dir);
    BUSY.lock().map(|v| v.contains(&k)).unwrap_or(false)
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
