//! Pyx's own files: settings, theme, templates, macros and symbols.
//!
//! Everything a person may want to read, edit, back up or copy to another
//! computer lives in ONE folder, as plain files:
//!
//!   config.json                 every setting (written a second after each
//!                               change, and again when the window closes)
//!   theme.css                   the «Personalizado» theme: one stylesheet
//!   templates/tables/*.tex      table templates (the library of the table assistant)
//!   templates/figures/*.tex     figure templates
//!   templates/files/*.tex       how a dropped or inserted file is called
//!   macros.json                 the user's macros
//!   symbols.json                the user's own symbols for the symbol panel
//!
//! Where: a `config` folder NEXT TO THE EXECUTABLE when that folder can be
//! written — the per-user Windows install (%LOCALAPPDATA%\Pyx) can — so the
//! settings sit in the app's own folder. Otherwise (an install under Program
//! Files, /usr/bin on Linux) the user's settings folder:
//!
//!   Windows  %APPDATA%\Pyx
//!   macOS    ~/Library/Application Support/Pyx
//!   Linux    $XDG_CONFIG_HOME/Pyx (~/.config/Pyx)
//!
//! Every write goes to BOTH places when they differ: an update or a reinstall
//! that replaces the app's folder never takes the settings with it — the next
//! start reads them back from the user folder and fills the app folder again.

use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

/// The user's settings folder (always writable).
pub fn user_dir() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")));
    base.unwrap_or_else(std::env::temp_dir).join("Pyx")
}

/// `<folder of the executable>/config`, when it can be written.
fn app_dir() -> Option<PathBuf> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        if cfg!(debug_assertions) && std::env::var_os("PYX_CONFIG_IN_APP").is_none() {
            return None; // `tauri dev`: the exe sits in target/, not worth a folder
        }
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?.join("config");
        std::fs::create_dir_all(&dir).ok()?;
        let probe = dir.join(".pyx-write-test");
        std::fs::write(&probe, b"ok").ok()?;
        let _ = std::fs::remove_file(&probe);
        Some(dir)
    })
    .clone()
}

/// The folder shown to the user (and read first).
pub fn config_dir() -> PathBuf {
    app_dir().unwrap_or_else(user_dir)
}

pub fn config_file() -> PathBuf {
    config_dir().join("config.json")
}

/// A relative name inside the folder ("templates/tables/booktabs.tex"):
/// no absolute paths, no `..`.
fn safe(name: &str) -> Result<PathBuf, String> {
    let p = Path::new(name);
    if name.is_empty() || p.is_absolute() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("Nombre no válido: {name}"));
    }
    Ok(p.to_path_buf())
}

fn places() -> Vec<PathBuf> {
    let mut v = vec![config_dir()];
    let u = user_dir();
    if !v.contains(&u) {
        v.push(u);
    }
    v
}

/// A file's text; None when there is none. The app folder first; a file only
/// the user folder still has (after an update) is copied back.
pub fn read_file(name: &str) -> Option<String> {
    let rel = safe(name).ok()?;
    let all = places();
    for (i, dir) in all.iter().enumerate() {
        if let Ok(t) = std::fs::read_to_string(dir.join(&rel)) {
            if i > 0 {
                let dst = all[0].join(&rel);
                if let Some(parent) = dst.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = crate::write_atomic(&dst, t.as_bytes());
            }
            return Some(t);
        }
    }
    None
}

/// Write a file in every place (atomically: a crash never leaves half a file).
pub fn write_file(name: &str, text: &str) -> Result<(), String> {
    let rel = safe(name)?;
    let mut first_err = None;
    let mut ok = false;
    for dir in places() {
        let dst = dir.join(&rel);
        let res = dst
            .parent()
            .map(|p| std::fs::create_dir_all(p).map_err(|e| e.to_string()))
            .unwrap_or(Ok(()))
            .and_then(|_| crate::write_atomic(&dst, text.as_bytes()).map_err(|e| e.to_string()));
        match res {
            Ok(()) => ok = true,
            Err(e) => {
                first_err.get_or_insert(format!("No se pudo guardar {}: {e}", dst.display()));
            }
        }
    }
    if ok { Ok(()) } else { Err(first_err.unwrap_or_default()) }
}

/// Delete a file from every place.
pub fn delete_file(name: &str) -> Result<(), String> {
    let rel = safe(name)?;
    for dir in places() {
        let _ = std::fs::remove_file(dir.join(&rel));
    }
    Ok(())
}

/// The files directly inside a sub-folder ("templates/tables"), names only,
/// from every place (the union), sorted.
pub fn list_files(sub: &str) -> Vec<String> {
    let Ok(rel) = safe(sub) else { return vec![] };
    let mut names: Vec<String> = places()
        .iter()
        .filter_map(|d| std::fs::read_dir(d.join(&rel)).ok())
        .flat_map(|it| it.flatten())
        .filter(|e| e.path().is_file())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !n.starts_with('.'))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup();
    names
}

/// The settings file's text, or None when there is none yet.
pub fn read() -> Option<String> {
    read_file("config.json")
}

/// Replace the settings file. Only valid JSON is written.
pub fn write(text: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(text).map_err(|e| format!("Configuración no válida: {e}"))?;
    write_file("config.json", text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_names_that_leave_the_folder() {
        assert!(safe("config.json").is_ok());
        assert!(safe("templates/tables/a.tex").is_ok());
        assert!(safe("../x").is_err());
        assert!(safe("/etc/passwd").is_err());
        assert!(safe("templates/../../x").is_err());
        assert!(safe("").is_err());
    }
}
