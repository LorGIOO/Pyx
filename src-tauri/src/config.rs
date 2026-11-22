//! Pyx's settings as a readable file.
//!
//! The window keeps its settings in the WebView's storage, which is fast but
//! opaque (a database inside `EBWebView`) and lost with the WebView's data. Every
//! change is also written here, as plain JSON a person can read, back up or
//! copy to another computer:
//!
//!   Windows  %APPDATA%\Pyx\config.json
//!   macOS    ~/Library/Application Support/Pyx/config.json
//!   Linux    $XDG_CONFIG_HOME/Pyx/config.json (~/.config/Pyx)
//!
//! When the WebView's storage comes back empty, the window restores itself
//! from this file.

use std::path::PathBuf;

pub fn config_dir() -> PathBuf {
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

pub fn config_file() -> PathBuf {
    config_dir().join("config.json")
}

/// The file's text, or None when there is none yet (or it cannot be read).
pub fn read() -> Option<String> {
    std::fs::read_to_string(config_file()).ok()
}

/// Replace the file, atomically (a crash mid-write never leaves half a file).
/// Only valid JSON is written.
pub fn write(text: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(text).map_err(|e| format!("Configuración no válida: {e}"))?;
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("No se pudo crear {}: {e}", dir.display()))?;
    crate::write_atomic(&config_file(), text.as_bytes()).map_err(|e| format!("No se pudo guardar la configuración: {e}"))
}
