//! Updates from the project's own GitHub releases.
//!
//! `check` asks GitHub which release is the latest and picks the installer for
//! this system; `install` (Windows) downloads it, checks its SHA-256 against
//! the one GitHub publishes, and runs Tauri's NSIS installer in passive mode
//! with `/R`, which reopens Pyx once it is done. Like runtime.rs, the download
//! uses the system's `curl` (Windows 10+, macOS, Linux): no HTTP code here.

use std::path::PathBuf;
use std::process::Command;

const REPO: &str = "LorGIOO/Pyx";

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Asset {
    pub name: String,
    pub url: String,
    pub size: u64,
    /// Hex SHA-256 when GitHub publishes it (`digest: "sha256:…"`).
    pub sha256: Option<String>,
}

#[derive(serde::Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub newer: bool,
    pub notes: String,
    pub page: String,
    /// The installer for this system, when Pyx can install it by itself.
    pub asset: Option<Asset>,
}

/// "1.6.10" > "1.6.9": numeric, part by part ("v" prefix and suffixes ignored).
fn version_gt(a: &str, b: &str) -> bool {
    let parts = |s: &str| -> Vec<u64> {
        s.trim_start_matches('v')
            .split(['.', '-', '+'])
            .take(3)
            .map(|p| p.parse().unwrap_or(0))
            .collect()
    };
    parts(a) > parts(b)
}

fn curl(args: &[&str]) -> Result<Vec<u8>, String> {
    let mut c = Command::new("curl");
    c.args(args);
    crate::quiet(&mut c);
    let out = c.output().map_err(|e| format!("No se pudo ejecutar curl: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "No se pudo contactar con GitHub. ¿Hay conexión a Internet?\n{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(out.stdout)
}

/// The installer this system can run: Windows' NSIS setup, else none (the
/// release page is opened instead).
fn pick_asset(assets: &[serde_json::Value]) -> Option<Asset> {
    if !cfg!(windows) {
        return None;
    }
    let prefix = format!("https://github.com/{REPO}/releases/download/");
    assets.iter().find_map(|a| {
        let name = a["name"].as_str()?;
        let url = a["browser_download_url"].as_str()?;
        // Only an installer of THIS repository's releases is ever run.
        if !name.ends_with("_x64-setup.exe") || !url.starts_with(&prefix) {
            return None;
        }
        Some(Asset {
            name: name.to_string(),
            url: url.to_string(),
            size: a["size"].as_u64().unwrap_or(0),
            sha256: a["digest"]
                .as_str()
                .and_then(|d| d.strip_prefix("sha256:"))
                .map(|h| h.to_lowercase()),
        })
    })
}

pub fn check() -> Result<UpdateInfo, String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let body = curl(&[
        "-fsSL", "--max-time", "20",
        "-H", "Accept: application/vnd.github+json",
        "-H", "User-Agent: Pyx-updater",
        &url,
    ])?;
    let v: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| "Respuesta de GitHub no válida.".to_string())?;
    let latest = v["tag_name"].as_str().unwrap_or("").trim_start_matches('v').to_string();
    if latest.is_empty() {
        return Err("GitHub no indica ninguna versión publicada.".into());
    }
    let current = env!("CARGO_PKG_VERSION").to_string();
    let empty = Vec::new();
    Ok(UpdateInfo {
        newer: version_gt(&latest, &current),
        notes: v["body"].as_str().unwrap_or("").chars().take(4000).collect(),
        page: v["html_url"].as_str().unwrap_or("").to_string(),
        asset: pick_asset(v["assets"].as_array().unwrap_or(&empty)),
        latest,
        current,
    })
}

/// SHA-256 of a file, by the system's own tool (no hashing code here).
#[cfg(windows)]
fn sha256_of(path: &std::path::Path) -> Option<String> {
    let mut c = Command::new("certutil");
    c.arg("-hashfile").arg(path).arg("SHA256");
    crate::quiet(&mut c);
    let out = c.output().ok()?;
    // Second line: the hash (older Windows prints it with spaces).
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .nth(1)
        .map(|l| l.replace(' ', "").trim().to_lowercase())
        .filter(|h| h.len() == 64)
}

/// Download the installer, verify it and start it. The caller closes Pyx right
/// after: the installer replaces the program and reopens it (`/R`).
#[cfg(windows)]
pub fn install(asset: Asset) -> Result<(), String> {
    if !asset.url.starts_with(&format!("https://github.com/{REPO}/releases/download/"))
        || !asset.name.ends_with("_x64-setup.exe")
        || asset.name.contains(['/', '\\'])
    {
        return Err("Instalador no reconocido.".into());
    }
    let dir: PathBuf = std::env::temp_dir().join("pyx-update");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(&asset.name);
    let target = file.to_string_lossy().to_string();
    curl(&["-fsSL", "--retry", "3", "-o", &target, &asset.url])?;
    let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
    if size == 0 || (asset.size > 0 && size != asset.size) {
        return Err("La descarga está incompleta: inténtalo de nuevo.".into());
    }
    if let Some(want) = asset.sha256.as_deref() {
        if sha256_of(&file).as_deref() != Some(want) {
            let _ = std::fs::remove_file(&file);
            return Err("El instalador descargado no coincide con el publicado (SHA-256): no se ha ejecutado.".into());
        }
    }
    // /P: passive (progress only, no questions) · /UPDATE: an update, not a
    // first install · /R: reopen Pyx when done.
    Command::new(&file)
        .args(["/P", "/UPDATE", "/R"])
        .spawn()
        .map_err(|e| format!("No se pudo iniciar el instalador: {e}"))?;
    Ok(())
}

#[cfg(not(windows))]
pub fn install(_asset: Asset) -> Result<(), String> {
    Err("En este sistema la actualización se descarga desde la página de la versión.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_numerically() {
        assert!(version_gt("1.6.10", "1.6.9"));
        assert!(version_gt("v2.0.0", "1.9.9"));
        assert!(!version_gt("1.6.5", "1.6.5"));
        assert!(!version_gt("1.6.4", "1.6.5"));
    }

    #[test]
    fn only_this_repositorys_setup_is_picked() {
        let assets = serde_json::json!([
            {"name": "Pyx_1.7.0_x64_en-US.msi", "browser_download_url": "https://github.com/LorGIOO/Pyx/releases/download/v1.7.0/Pyx_1.7.0_x64_en-US.msi", "size": 1},
            {"name": "Pyx_1.7.0_x64-setup.exe", "browser_download_url": "https://evil.example/Pyx_1.7.0_x64-setup.exe", "size": 2},
            {"name": "Pyx_1.7.0_x64-setup.exe", "browser_download_url": "https://github.com/LorGIOO/Pyx/releases/download/v1.7.0/Pyx_1.7.0_x64-setup.exe", "size": 3, "digest": "sha256:ABCD"}
        ]);
        let a = pick_asset(assets.as_array().unwrap());
        if cfg!(windows) {
            let a = a.unwrap();
            assert_eq!(a.size, 3);
            assert_eq!(a.sha256.as_deref(), Some("abcd"));
        } else {
            assert!(a.is_none());
        }
    }
}
