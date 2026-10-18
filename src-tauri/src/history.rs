//! Version history of documents, and the little of Git a report needs.
//!
//! * **Local history** (VS Code's Timeline, TeXstudio's backups): every save
//!   keeps a copy of the source in Pyx's data folder — the last 60 versions
//!   per file, an identical save not counted twice. Nothing is written next
//!   to the document, so it works for every file, in a repository or not.
//! * **Git**, when the project is a repository and `git` is installed: the
//!   branch, what changed, "commit everything" and the recent log. Through
//!   the git command line, like any editor without its own Git.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const KEEP: usize = 60;

fn history_dir(path: &str) -> PathBuf {
    // One folder per file, named by a hash of its path (paths can be long and
    // contain anything).
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in path.to_lowercase().as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    crate::runtime::tools_dir().join("history").join(format!("{h:016x}"))
}

#[derive(serde::Serialize)]
pub struct Version {
    /// Milliseconds since the epoch (also its id).
    pub id: u64,
    pub size: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn versions_in(dir: &Path) -> Vec<(u64, PathBuf)> {
    let mut v: Vec<(u64, PathBuf)> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let p = e.path();
                    let id = p.file_stem()?.to_str()?.parse::<u64>().ok()?;
                    (p.extension()? == "txt").then_some((id, p))
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort_by_key(|(id, _)| *id);
    v
}

/// Keep a copy of `content` as the newest version of `path`.
pub fn save(path: &str, content: &str) -> Result<(), String> {
    let dir = history_dir(path);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut list = versions_in(&dir);
    if let Some((_, last)) = list.last() {
        if std::fs::read_to_string(last).map(|t| t == content).unwrap_or(false) {
            return Ok(());
        }
    }
    let _ = std::fs::write(dir.join("path"), path);
    std::fs::write(dir.join(format!("{}.txt", now_ms())), content).map_err(|e| e.to_string())?;
    list = versions_in(&dir);
    while list.len() > KEEP {
        let (_, old) = list.remove(0);
        let _ = std::fs::remove_file(old);
    }
    Ok(())
}

/// The saved versions of `path`, newest first.
pub fn list(path: &str) -> Vec<Version> {
    let mut out: Vec<Version> = versions_in(&history_dir(path))
        .into_iter()
        .map(|(id, p)| Version { id, size: std::fs::metadata(p).map(|m| m.len()).unwrap_or(0) })
        .collect();
    out.reverse();
    out
}

pub fn read(path: &str, id: u64) -> Result<String, String> {
    std::fs::read_to_string(history_dir(path).join(format!("{id}.txt"))).map_err(|e| e.to_string())
}

/* ---------------- Git ---------------- */

fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let mut c = Command::new("git");
    c.args(args).current_dir(dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::quiet(&mut c);
    let out = c.output().map_err(|_| "Git no está instalado.".to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[derive(serde::Serialize)]
pub struct GitStatus {
    pub installed: bool,
    pub repo: bool,
    pub branch: String,
    /// `git status --porcelain` lines: "XY path".
    pub changes: Vec<String>,
    /// "hash␟date␟author␟subject"
    pub log: Vec<String>,
}

pub fn status(dir: &str) -> GitStatus {
    let installed = git(dir, &["--version"]).is_ok();
    let repo = installed && git(dir, &["rev-parse", "--is-inside-work-tree"]).map(|s| s.trim() == "true").unwrap_or(false);
    if !repo {
        return GitStatus { installed, repo, branch: String::new(), changes: vec![], log: vec![] };
    }
    let branch = git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).map(|s| s.trim().to_string()).unwrap_or_default();
    let changes = git(dir, &["status", "--porcelain"])
        .map(|s| s.lines().map(str::to_string).collect())
        .unwrap_or_default();
    let log = git(dir, &["log", "-30", "--date=format:%Y-%m-%d %H:%M", "--pretty=format:%h\x1f%ad\x1f%an\x1f%s"])
        .map(|s| s.lines().map(str::to_string).collect())
        .unwrap_or_default();
    GitStatus { installed, repo, branch, changes, log }
}

pub fn init(dir: &str) -> Result<(), String> {
    git(dir, &["init"])?;
    // The build folder lives outside the project; keep editor clutter out too.
    let ignore = Path::new(dir).join(".gitignore");
    if !ignore.exists() {
        let _ = std::fs::write(ignore, "*.build.tex\n*.aux\n*.log\n*.synctex.gz\n__pycache__/\n.ipynb_checkpoints/\n");
    }
    Ok(())
}

/// Commit everything that changed in the project.
pub fn commit(dir: &str, message: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("Escribe un mensaje que describa los cambios.".into());
    }
    git(dir, &["add", "-A"])?;
    git(dir, &["commit", "-m", message]).or_else(|e| {
        if e.contains("user.email") || e.contains("user.name") || e.contains("Please tell me who you are") {
            // A first commit on a machine that never configured Git.
            git(dir, &["-c", "user.name=Pyx", "-c", "user.email=pyx@localhost", "commit", "-m", message])
        } else {
            Err(e)
        }
    })
}

/// A file as it was in a commit (for comparing).
pub fn show(dir: &str, rev: &str, file: &str) -> Result<String, String> {
    let rel = Path::new(file)
        .strip_prefix(dir)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| file.to_string());
    let top = git(dir, &["rev-parse", "--show-prefix"]).unwrap_or_default();
    git(dir, &["show", &format!("{rev}:{}{rel}", top.trim())])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_versions_newest_first_and_skips_identical_saves() {
        let home = std::env::temp_dir().join(format!("pyx-hist-{}", std::process::id()));
        std::env::set_var("XDG_DATA_HOME", &home);
        std::env::set_var("LOCALAPPDATA", &home);
        let p = "/proyecto/informe.tex";
        save(p, "uno").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        save(p, "uno").unwrap();
        save(p, "dos").unwrap();
        let v = list(p);
        assert_eq!(v.len(), 2);
        assert_eq!(read(p, v[0].id).unwrap(), "dos");
        assert_eq!(read(p, v[1].id).unwrap(), "uno");
        let _ = std::fs::remove_dir_all(&home);
    }
}
