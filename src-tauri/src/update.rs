//! Updates from the project's own GitHub releases.
//!
//! `check` asks GitHub which release is the latest and picks the installer for
//! this system; `download` (Windows) fetches it and checks its SHA-256 against
//! the one GitHub publishes, and `launch` runs Tauri's NSIS installer in
//! passive mode with `/R`, which reopens Pyx once it is done. They are two
//! steps so the window can ask about unsaved documents in between: the
//! download takes a while, and closing Pyx is the part that can lose work.
//! Like runtime.rs, the download
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

/// Is this an installer Pyx may run, and what must its SHA-256 be?
///
/// The digest is MANDATORY. It used to be checked only "when GitHub publishes
/// it", so a release answer without `digest` (an API change, a tampered
/// response) installed an executable nobody had verified — the one case the
/// check exists for. GitHub computes the digest of every release asset, so a
/// missing one is an anomaly, not a normal state: the update is refused and
/// the window offers the release page instead.
fn verified_digest(asset: &Asset) -> Result<String, String> {
    if !asset.url.starts_with(&format!("https://github.com/{REPO}/releases/download/"))
        || !asset.name.ends_with("_x64-setup.exe")
        || asset.name.contains(['/', '\\'])
    {
        return Err("Instalador no reconocido.".into());
    }
    match asset.sha256.as_deref().map(|h| h.trim().to_lowercase()) {
        Some(h) if h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()) => Ok(h),
        _ => Err("GitHub no ha publicado la huella SHA-256 de este instalador, así que Pyx no \
                  puede comprobar que la descarga es la auténtica y no lo instalará por su \
                  cuenta. Descárgalo desde la página de la versión."
            .into()),
    }
}

/// The installer `download` verified, waiting for `launch`. Kept on this side
/// so the window never names the executable to run: it can only ask for the
/// one that passed the checks.
#[cfg(windows)]
static READY: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

/// Download the installer and verify it. Nothing is run and Pyx stays open:
/// the window asks about unsaved documents again before calling `launch`
/// (the download can take minutes, and the user keeps typing meanwhile).
#[cfg(windows)]
pub fn download(asset: Asset) -> Result<(), String> {
    let want = verified_digest(&asset)?;
    if let Ok(mut g) = READY.lock() {
        *g = None;
    }
    let dir: PathBuf = std::env::temp_dir().join("pyx-update");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(&asset.name);
    let target = file.to_string_lossy().to_string();
    // Bounded: without limits a connection that stalls mid-download left the
    // status bar on «Descargando…» for ever, with no way out but closing Pyx.
    // `--speed-*` gives up on a transfer that has stopped moving (under
    // 1 KB/s for a minute) without punishing a slow but live connection;
    // `--max-time` caps one attempt and `--retry-max-time` all of them.
    curl(&[
        "-fsSL",
        "--connect-timeout", "20",
        "--speed-limit", "1024", "--speed-time", "60",
        "--max-time", "1800",
        "--retry", "3", "--retry-max-time", "2400",
        "-o", &target, &asset.url,
    ])?;
    let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
    if size == 0 || (asset.size > 0 && size != asset.size) {
        let _ = std::fs::remove_file(&file);
        return Err("La descarga está incompleta: inténtalo de nuevo.".into());
    }
    if sha256_of(&file).as_deref() != Some(want.as_str()) {
        let _ = std::fs::remove_file(&file);
        return Err("El instalador descargado no coincide con el publicado (SHA-256): no se ha ejecutado.".into());
    }
    if let Ok(mut g) = READY.lock() {
        *g = Some(file);
    }
    Ok(())
}

/// Start the installer `download` left ready. The caller closes Pyx right
/// after: the installer replaces the program and reopens it (`/R`).
#[cfg(windows)]
pub fn launch() -> Result<(), String> {
    let file = READY
        .lock()
        .ok()
        .and_then(|mut g| g.take())
        .filter(|f| f.is_file())
        .ok_or("No hay ningún instalador descargado y comprobado.")?;
    // /P: passive (progress only, no questions) · /UPDATE: an update, not a
    // first install · /R: reopen Pyx when done.
    Command::new(&file)
        .args(["/P", "/UPDATE", "/R"])
        .spawn()
        .map_err(|e| format!("No se pudo iniciar el instalador: {e}"))?;
    Ok(())
}

#[cfg(not(windows))]
pub fn download(_asset: Asset) -> Result<(), String> {
    Err("En este sistema la actualización se descarga desde la página de la versión.".into())
}

#[cfg(not(windows))]
pub fn launch() -> Result<(), String> {
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

    /// An installer is only ever run with a SHA-256 to check it against: no
    /// digest, a malformed one or a foreign URL all stop before any download.
    #[test]
    fn an_installer_without_a_valid_digest_is_refused() {
        let good = Asset {
            name: "Pyx_1.7.0_x64-setup.exe".into(),
            url: "https://github.com/LorGIOO/Pyx/releases/download/v1.7.0/Pyx_1.7.0_x64-setup.exe".into(),
            size: 3,
            sha256: Some("AB".repeat(32)),
        };
        assert_eq!(verified_digest(&good).unwrap(), "ab".repeat(32));
        let none = Asset { sha256: None, ..good.clone() };
        assert!(verified_digest(&none).unwrap_err().contains("SHA-256"));
        let short = Asset { sha256: Some("abcd".into()), ..good.clone() };
        assert!(verified_digest(&short).is_err());
        let not_hex = Asset { sha256: Some("zz".repeat(32)), ..good.clone() };
        assert!(verified_digest(&not_hex).is_err());
        let foreign = Asset { url: "https://evil.example/Pyx_1.7.0_x64-setup.exe".into(), ..good.clone() };
        assert_eq!(verified_digest(&foreign).unwrap_err(), "Instalador no reconocido.");
        let traversal = Asset { name: "..\\Pyx_x64-setup.exe".into(), ..good.clone() };
        assert!(verified_digest(&traversal).is_err());
        // The refusal happens before the network is touched.
        assert!(download(none).is_err());
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
