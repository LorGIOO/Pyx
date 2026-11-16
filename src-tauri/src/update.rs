//! Updates from the project's own GitHub releases.
//!
//! `check` lists the releases and picks the one to offer (see `choose`: a
//! stable install follows stable releases; an install of a PRE-RELEASE keeps
//! following the newest release, test versions included) and the package
//! this system can install by itself:
//!
//!   Windows  the NSIS setup (`_x64-setup.exe`), run in passive mode;
//!   macOS    the app bundle (`.app.tar.gz`), which replaces the running
//!            `Pyx.app` once Pyx has closed;
//!   Linux    the AppImage, which replaces the running one (`$APPIMAGE`).
//!            A .deb/.rpm install needs root: the release page is opened.
//!
//! `download` fetches it and checks its SHA-256 against the one GitHub
//! publishes (mandatory); `launch` installs what passed that check. They are
//! separate so the download happens in the background while the user keeps
//! working, and the install — which closes Pyx — happens when they close it
//! or ask for it. Downloads use the system's `curl` (Windows 10+, macOS,
//! Linux): no HTTP code here.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;

const REPO: &str = "LorGIOO/Pyx";

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Asset {
    pub name: String,
    pub url: String,
    pub size: u64,
    /// Hex SHA-256 when GitHub publishes it (`digest: "sha256:…"`).
    pub sha256: Option<String>,
    /// How it is installed: "nsis" | "mac-app" | "appimage".
    #[serde(default)]
    pub kind: String,
}

#[derive(serde::Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub newer: bool,
    /// The offered release is a test version (pre-release).
    pub prerelease: bool,
    /// Whether test versions were considered ("stable" | "beta").
    pub channel: String,
    pub notes: String,
    pub page: String,
    /// The package for this system, when Pyx can install it by itself.
    pub asset: Option<Asset>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Nsis,
    MacApp,
    AppImage,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Nsis => "nsis",
            Kind::MacApp => "mac-app",
            Kind::AppImage => "appimage",
        }
    }
    fn parse(s: &str) -> Option<Kind> {
        match s {
            "nsis" | "" => Some(Kind::Nsis), // "" = an asset from an older window
            "mac-app" => Some(Kind::MacApp),
            "appimage" => Some(Kind::AppImage),
            _ => None,
        }
    }
    /// The file name a package of this kind ends with.
    fn matches(self, name: &str) -> bool {
        match self {
            Kind::Nsis => name.ends_with("_x64-setup.exe"),
            Kind::MacApp => name.ends_with(".app.tar.gz"),
            Kind::AppImage => {
                if cfg!(target_arch = "aarch64") {
                    name.ends_with("_aarch64.AppImage")
                } else {
                    name.ends_with("_amd64.AppImage")
                }
            }
        }
    }
}

/// What this installation can update by itself.
///
/// Each system's way of installing is COMPILED ONLY INTO THAT SYSTEM'S
/// BUILD (`#[cfg]`, not `cfg!`). 2.0.2 carried the macOS and Linux code —
/// a shell script that waits for the process to end, `rm -rf`s and swaps the
/// application — inside the Windows executable too, where it never runs; that
/// is exactly the shape antivirus heuristics call a dropper, and the Windows
/// installer was blocked. The Windows build now holds only what 2.0.0 had.
#[cfg(windows)]
fn platform_kind() -> Option<Kind> {
    Some(Kind::Nsis)
}
#[cfg(target_os = "macos")]
fn platform_kind() -> Option<Kind> {
    app_bundle().map(|_| Kind::MacApp)
}
#[cfg(target_os = "linux")]
fn platform_kind() -> Option<Kind> {
    std::env::var_os("APPIMAGE")
        .filter(|p| Path::new(p).is_file())
        .map(|_| Kind::AppImage)
}
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn platform_kind() -> Option<Kind> {
    None
}

/// "1.6.10" > "1.6.9": numeric, part by part ("v" prefix and suffixes ignored).
fn version_parts(s: &str) -> Vec<u64> {
    s.trim_start_matches('v')
        .split(['.', '-', '+'])
        .take(3)
        .map(|p| p.parse().unwrap_or(0))
        .collect()
}

fn version_gt(a: &str, b: &str) -> bool {
    version_parts(a) > version_parts(b)
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

/// The package of `kind` among a release's assets — only one of THIS
/// repository's releases.
fn pick_asset_for(kind: Option<Kind>, assets: &[serde_json::Value]) -> Option<Asset> {
    let kind = kind?;
    let prefix = format!("https://github.com/{REPO}/releases/download/");
    assets.iter().find_map(|a| {
        let name = a["name"].as_str()?;
        let url = a["browser_download_url"].as_str()?;
        if !kind.matches(name) || !url.starts_with(&prefix) {
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
            kind: kind.as_str().to_string(),
        })
    })
}

/// Which release to offer, and whether test versions were considered.
///
/// `channel` "stable" never offers a pre-release, "beta" always considers
/// them, and "auto" (the default) considers them only when the version
/// running now was itself published as a pre-release: whoever installed a
/// test version keeps getting the newest one, everyone else stays on stable.
/// The highest version wins; drafts are never offered.
fn choose<'a>(releases: &'a [serde_json::Value], current: &str, channel: &str) -> (Option<&'a serde_json::Value>, bool) {
    let listed: Vec<&serde_json::Value> = releases
        .iter()
        .filter(|r| !r["draft"].as_bool().unwrap_or(false) && r["tag_name"].as_str().map(|t| !t.is_empty()).unwrap_or(false))
        .collect();
    let on_pre = listed.iter().any(|r| {
        r["prerelease"].as_bool().unwrap_or(false)
            && version_parts(r["tag_name"].as_str().unwrap_or("")) == version_parts(current)
    });
    let include_pre = match channel {
        "beta" => true,
        "stable" => false,
        _ => on_pre,
    };
    let best = listed
        .into_iter()
        .filter(|r| include_pre || !r["prerelease"].as_bool().unwrap_or(false))
        .max_by(|a, b| {
            version_parts(a["tag_name"].as_str().unwrap_or("")).cmp(&version_parts(b["tag_name"].as_str().unwrap_or("")))
        });
    (best, include_pre)
}

pub fn check(channel: &str) -> Result<UpdateInfo, String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases?per_page=30");
    let body = curl(&[
        "-fsSL", "--max-time", "20",
        "-H", "Accept: application/vnd.github+json",
        "-H", "User-Agent: Pyx-updater",
        &url,
    ])?;
    let v: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| "Respuesta de GitHub no válida.".to_string())?;
    let list = v.as_array().ok_or("Respuesta de GitHub no válida.")?;
    let current = env!("CARGO_PKG_VERSION").to_string();
    let (best, include_pre) = choose(list, &current, channel);
    let r = best.ok_or("GitHub no indica ninguna versión publicada.")?;
    let latest = r["tag_name"].as_str().unwrap_or("").trim_start_matches('v').to_string();
    let empty = Vec::new();
    Ok(UpdateInfo {
        newer: version_gt(&latest, &current),
        prerelease: r["prerelease"].as_bool().unwrap_or(false),
        channel: if include_pre { "beta" } else { "stable" }.to_string(),
        notes: r["body"].as_str().unwrap_or("").chars().take(4000).collect(),
        page: r["html_url"].as_str().unwrap_or("").to_string(),
        asset: pick_asset_for(platform_kind(), r["assets"].as_array().unwrap_or(&empty)),
        latest,
        current,
    })
}

/// SHA-256 of a file, streamed.
fn sha256_of(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut h = Sha256::new();
    std::io::copy(&mut f, &mut h).ok()?;
    Some(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Is this a package Pyx may install, and what must its SHA-256 be?
///
/// The digest is MANDATORY. GitHub computes the digest of every release
/// asset, so a missing one is an anomaly (an API change, a tampered answer),
/// not a normal state: the update is refused and the window offers the
/// release page instead.
fn verified_digest(asset: &Asset) -> Result<(Kind, String), String> {
    let kind = Kind::parse(&asset.kind).ok_or("Instalador no reconocido.")?;
    if !asset.url.starts_with(&format!("https://github.com/{REPO}/releases/download/"))
        || !kind.matches(&asset.name)
        || asset.name.contains(['/', '\\'])
        || asset.name.starts_with('.')
    {
        return Err("Instalador no reconocido.".into());
    }
    match asset.sha256.as_deref().map(|h| h.trim().to_lowercase()) {
        Some(h) if h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()) => Ok((kind, h)),
        _ => Err("GitHub no ha publicado la huella SHA-256 de este instalador, así que Pyx no \
                  puede comprobar que la descarga es la auténtica y no lo instalará por su \
                  cuenta. Descárgalo desde la página de la versión."
            .into()),
    }
}

/// The package `download` verified, waiting for `launch`. Kept on this side
/// so the window never names the file to run: it can only ask for the one
/// that passed the checks.
static READY: std::sync::Mutex<Option<(Kind, PathBuf)>> = std::sync::Mutex::new(None);

fn work_dir() -> PathBuf {
    std::env::temp_dir().join("pyx-update")
}

/// Download the package and verify it. Nothing is installed and Pyx stays
/// open: it is installed when Pyx closes, or when the user asks.
pub fn download(asset: Asset) -> Result<(), String> {
    let (kind, want) = verified_digest(&asset)?;
    if let Ok(mut g) = READY.lock() {
        *g = None;
    }
    let dir = work_dir();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(&asset.name);
    let target = file.to_string_lossy().to_string();
    // Bounded: `--speed-*` gives up on a transfer that has stopped moving
    // (under 1 KB/s for a minute) without punishing a slow but live one;
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
        return Err("El paquete descargado no coincide con el publicado (SHA-256): no se ha instalado.".into());
    }
    if let Ok(mut g) = READY.lock() {
        *g = Some((kind, file));
    }
    Ok(())
}

/// The running `Pyx.app` (macOS), from the executable's path.
#[cfg(target_os = "macos")]
fn app_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|p| p.extension().map(|e| e == "app").unwrap_or(false))
        .map(|p| p.to_path_buf())
}

/// Install what `download` left ready. The caller closes Pyx right after.
/// `reopen`: open the new version once installed (false when the user was
/// closing Pyx anyway).
pub fn launch(reopen: bool) -> Result<(), String> {
    let (kind, file) = READY
        .lock()
        .ok()
        .and_then(|mut g| g.take())
        .filter(|(_, f)| f.is_file())
        .ok_or("No hay ninguna actualización descargada y comprobada.")?;
    match kind {
        Kind::Nsis => install_nsis(&file, reopen),
        Kind::AppImage => install_appimage(&file, reopen),
        Kind::MacApp => install_mac_app(&file, reopen),
    }
}

const NOT_HERE: &str = "Esta actualización es para otro sistema.";

/// Run Tauri's NSIS installer (Windows) — what Pyx has always done.
#[cfg(windows)]
fn install_nsis(file: &Path, reopen: bool) -> Result<(), String> {
    // /P: passive (progress only, no questions) · /UPDATE: an update, not a
    // first install · /R: reopen Pyx when done.
    let mut args = vec!["/P", "/UPDATE"];
    if reopen {
        args.push("/R");
    }
    Command::new(file)
        .args(args)
        .spawn()
        .map_err(|e| format!("No se pudo iniciar el instalador: {e}"))?;
    Ok(())
}
#[cfg(not(windows))]
fn install_nsis(_file: &Path, _reopen: bool) -> Result<(), String> {
    Err(NOT_HERE.into())
}
#[cfg(not(target_os = "linux"))]
fn install_appimage(_file: &Path, _reopen: bool) -> Result<(), String> {
    Err(NOT_HERE.into())
}
#[cfg(not(target_os = "macos"))]
fn install_mac_app(_file: &Path, _reopen: bool) -> Result<(), String> {
    Err(NOT_HERE.into())
}

/// Replace the running AppImage with the new one (Linux build only). Renaming over it is
/// atomic, and safe while it runs (the old file stays mounted until Pyx
/// exits).
#[cfg(target_os = "linux")]
fn install_appimage(file: &Path, reopen: bool) -> Result<(), String> {
    let target = PathBuf::from(std::env::var_os("APPIMAGE").ok_or("Pyx no se está ejecutando como AppImage.")?);
    let staged = target.with_extension("AppImage.new");
    std::fs::copy(file, &staged).map_err(|e| format!("No se pudo escribir junto a {}: {e}", target.display()))?;
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755));
    }
    if let Err(e) = std::fs::rename(&staged, &target) {
        let _ = std::fs::remove_file(&staged);
        return Err(format!("No se pudo sustituir {}: {e}", target.display()));
    }
    if reopen {
        let mut c = Command::new(&target);
        // The old AppImage's runtime variables must not leak into the new one.
        for k in ["APPIMAGE", "APPDIR", "ARGV0", "OWD"] {
            c.env_remove(k);
        }
        c.spawn().map_err(|e| format!("Actualizado, pero no se pudo volver a abrir: {e}"))?;
    }
    Ok(())
}

/// Unpack the new `Pyx.app` and swap it for the running one once Pyx has
/// exited (a bundle in use cannot be replaced from inside). A small shell
/// script waits for this process, moves the old bundle aside, puts the new
/// one in its place (and puts the old one back if that fails), and reopens.
/// Paths go to the script as arguments, never into its text.
#[cfg(target_os = "macos")]
fn install_mac_app(file: &Path, reopen: bool) -> Result<(), String> {
    let bundle = app_bundle().ok_or("No se encontró la aplicación Pyx.app en uso.")?;
    let unpack = work_dir().join("unpacked");
    let _ = std::fs::remove_dir_all(&unpack);
    std::fs::create_dir_all(&unpack).map_err(|e| e.to_string())?;
    let st = Command::new("tar")
        .arg("-xzf")
        .arg(file)
        .arg("-C")
        .arg(&unpack)
        .status()
        .map_err(|e| format!("No se pudo descomprimir la actualización: {e}"))?;
    if !st.success() {
        return Err("No se pudo descomprimir la actualización.".into());
    }
    let new_app = std::fs::read_dir(&unpack)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().map(|e| e == "app").unwrap_or(false))
        .ok_or("La actualización no contiene ninguna aplicación.")?;
    let script = r#"pid="$1"; old="$2"; new="$3"; reopen="$4"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
bak="$old.pyx-anterior"; rm -rf "$bak"
if mv "$old" "$bak"; then
  if mv "$new" "$old"; then rm -rf "$bak"; else mv "$bak" "$old"; fi
fi
if [ "$reopen" = "1" ]; then open "$old"; fi"#;
    Command::new("/bin/sh")
        .arg("-c")
        .arg(script)
        .arg("pyx-update")
        .arg(std::process::id().to_string())
        .arg(&bundle)
        .arg(&new_app)
        .arg(if reopen { "1" } else { "0" })
        .spawn()
        .map_err(|e| format!("No se pudo preparar la instalación: {e}"))?;
    Ok(())
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

    fn rel(tag: &str, pre: bool, draft: bool) -> serde_json::Value {
        serde_json::json!({ "tag_name": tag, "prerelease": pre, "draft": draft })
    }

    /// A stable install never gets a test version; a test install keeps
    /// following the newest release (test or stable); drafts never count.
    #[test]
    fn the_channel_follows_what_is_installed() {
        let list = vec![
            rel("v2.0.3", true, true), // draft: never
            rel("v2.0.2", true, false),
            rel("v2.0.1", true, false),
            rel("v2.0.0", false, false),
        ];
        let tag = |r: Option<&serde_json::Value>| r.map(|r| r["tag_name"].as_str().unwrap().to_string());
        // Installed 2.0.0 (stable): stays on stable.
        let (r, pre) = choose(&list, "2.0.0", "auto");
        assert_eq!((tag(r).as_deref(), pre), (Some("v2.0.0"), false));
        // Installed 2.0.1 (a pre-release): gets 2.0.2. This is what failed.
        let (r, pre) = choose(&list, "2.0.1", "auto");
        assert_eq!((tag(r).as_deref(), pre), (Some("v2.0.2"), true));
        // Forced channels.
        assert_eq!(tag(choose(&list, "2.0.0", "beta").0).as_deref(), Some("v2.0.2"));
        assert_eq!(tag(choose(&list, "2.0.1", "stable").0).as_deref(), Some("v2.0.0"));
        // A stable release newer than the test versions wins for testers too.
        let mut l2 = list.clone();
        l2.insert(0, rel("v2.1.0", false, false));
        assert_eq!(tag(choose(&l2, "2.0.1", "auto").0).as_deref(), Some("v2.1.0"));
    }

    /// A package is only ever installed with a SHA-256 to check it against:
    /// no digest, a malformed one, a foreign URL or a wrong name all stop
    /// before any download.
    #[test]
    fn a_package_without_a_valid_digest_is_refused() {
        let good = Asset {
            name: "Pyx_1.7.0_x64-setup.exe".into(),
            url: "https://github.com/LorGIOO/Pyx/releases/download/v1.7.0/Pyx_1.7.0_x64-setup.exe".into(),
            size: 3,
            sha256: Some("AB".repeat(32)),
            kind: "nsis".into(),
        };
        assert_eq!(verified_digest(&good).unwrap(), (Kind::Nsis, "ab".repeat(32)));
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
        let wrong_kind = Asset { kind: "mac-app".into(), ..good.clone() };
        assert!(verified_digest(&wrong_kind).is_err());
        let unknown = Asset { kind: "script".into(), ..good.clone() };
        assert!(verified_digest(&unknown).is_err());
        // The refusal happens before the network is touched.
        assert!(download(none).is_err());
    }

    #[test]
    fn each_system_picks_its_own_package_of_this_repository() {
        let base = "https://github.com/LorGIOO/Pyx/releases/download/v2.0.2/";
        let assets = serde_json::json!([
            {"name": "Pyx_2.0.2_x64_en-US.msi", "browser_download_url": format!("{base}Pyx_2.0.2_x64_en-US.msi"), "size": 1},
            {"name": "Pyx_2.0.2_x64-setup.exe", "browser_download_url": "https://evil.example/Pyx_2.0.2_x64-setup.exe", "size": 2},
            {"name": "Pyx_2.0.2_x64-setup.exe", "browser_download_url": format!("{base}Pyx_2.0.2_x64-setup.exe"), "size": 3, "digest": "sha256:ABCD"},
            {"name": "Pyx_universal.app.tar.gz", "browser_download_url": format!("{base}Pyx_universal.app.tar.gz"), "size": 4, "digest": "sha256:01"},
            {"name": "Pyx_2.0.2_universal.dmg", "browser_download_url": format!("{base}Pyx_2.0.2_universal.dmg"), "size": 5},
            {"name": "Pyx_2.0.2_amd64.AppImage", "browser_download_url": format!("{base}Pyx_2.0.2_amd64.AppImage"), "size": 6, "digest": "sha256:02"},
            {"name": "Pyx_2.0.2_amd64.deb", "browser_download_url": format!("{base}Pyx_2.0.2_amd64.deb"), "size": 7}
        ]);
        let a = assets.as_array().unwrap();
        let w = pick_asset_for(Some(Kind::Nsis), a).unwrap();
        assert_eq!((w.size, w.sha256.as_deref(), w.kind.as_str()), (3, Some("abcd"), "nsis"));
        let m = pick_asset_for(Some(Kind::MacApp), a).unwrap();
        assert_eq!((m.size, m.kind.as_str()), (4, "mac-app"));
        if !cfg!(target_arch = "aarch64") {
            let l = pick_asset_for(Some(Kind::AppImage), a).unwrap();
            assert_eq!((l.size, l.kind.as_str()), (6, "appimage"));
        }
        // A .deb/.rpm install: nothing to install by itself (page instead).
        assert!(pick_asset_for(None, a).is_none());
    }

    #[test]
    fn sha256_of_a_file() {
        let p = std::env::temp_dir().join(format!("pyx-sha-{}", std::process::id()));
        std::fs::write(&p, b"abc").unwrap();
        assert_eq!(
            sha256_of(&p).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = std::fs::remove_file(&p);
    }
}
