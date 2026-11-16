//! Updates from the project's own GitHub releases.
//!
//! `check` finds the release to offer (a stable install follows stable
//! releases; an install of a PRE-RELEASE keeps following the newest release,
//! test versions included) and the package this system can install by itself.
//!
//! WHERE IT ASKS. GitHub's API answers only 60 anonymous requests per hour
//! and PER PUBLIC ADDRESS: a classroom or an office behind one router shares
//! that allowance, and with Pyx open on a few dozen computers the check
//! started failing for everybody ("no connection"). So a stable install asks
//! first for a small file every release carries, `pyx-update.json` (written
//! by release.yml), through `releases/latest/download/` — an ordinary
//! download, with no such limit. The API is only used by test versions
//! (which need the list of pre-releases) and for releases older than the
//! manifest; when it does refuse, the message says so instead of blaming the
//! connection.
//!
//! The packages:
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

/// Where GitHub is. Only the tests point these somewhere else.
#[derive(Clone)]
struct Endpoints {
    /// `https://api.github.com`
    api: String,
    /// `https://github.com`
    web: String,
}

impl Endpoints {
    fn github() -> Self {
        Endpoints { api: "https://api.github.com".into(), web: "https://github.com".into() }
    }
    /// Every package Pyx installs is downloaded from under here.
    fn download_prefix(&self) -> String {
        format!("{}/{REPO}/releases/download/", self.web)
    }
}

/// Why GitHub could not be asked, in words the user can act on.
#[derive(Debug, PartialEq)]
enum Fetch {
    /// curl could not be run, or there is no network / no answer.
    Offline(String),
    /// GitHub answered with an HTTP error.
    Http(u16),
}

impl Fetch {
    fn message(&self) -> String {
        match self {
            Fetch::Offline(e) => format!("No se pudo contactar con GitHub. ¿Hay conexión a Internet?\n{e}").trim().to_string(),
            Fetch::Http(403) | Fetch::Http(429) => "GitHub ha limitado por un rato las consultas desde esta conexión \
                (pasa cuando muchos equipos comparten la misma salida a Internet). \
                Vuelve a intentarlo dentro de unos minutos."
                .to_string(),
            Fetch::Http(code) if *code >= 500 => format!("GitHub no responde ahora mismo (error {code}). Inténtalo más tarde."),
            Fetch::Http(code) => format!("GitHub respondió con el error {code}."),
        }
    }
}

/// GET `url` with curl, following redirects. The HTTP status is read from
/// curl's `-w`, not from `-f`: a refusal (403, 404) and a dead connection are
/// different things and get different words.
fn fetch(url: &str, max_time: &str, headers: &[&str]) -> Result<Vec<u8>, Fetch> {
    let mut c = Command::new("curl");
    c.args(["-sSL", "--connect-timeout", "15", "--max-time", max_time, "-w", "\n%{http_code}"]);
    for h in headers {
        c.args(["-H", h]);
    }
    c.arg(url);
    crate::quiet(&mut c);
    let out = c.output().map_err(|e| Fetch::Offline(format!("No se pudo ejecutar curl: {e}")))?;
    if !out.status.success() {
        return Err(Fetch::Offline(String::from_utf8_lossy(&out.stderr).trim().to_string()));
    }
    // The body, a newline, and the three digits of the status.
    let cut = out.stdout.iter().rposition(|&b| b == b'\n').unwrap_or(0);
    let code: u16 = String::from_utf8_lossy(&out.stdout[cut..]).trim().parse().unwrap_or(0);
    if !(200..300).contains(&code) {
        return Err(Fetch::Http(code));
    }
    Ok(out.stdout[..cut].to_vec())
}

/// The package of `kind` among a release's assets — only one of THIS
/// repository's releases.
fn pick_asset_for(ep: &Endpoints, kind: Option<Kind>, assets: &[serde_json::Value]) -> Option<Asset> {
    let kind = kind?;
    let prefix = ep.download_prefix();
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

/// The release `pyx-update.json` describes (see release.yml): the newest
/// STABLE one, since it is fetched through `releases/latest`.
///
/// Its package URLs are BUILT here from the tag and the file name, never
/// read from the file: whatever it says, a download can only come from this
/// repository's releases.
fn from_manifest(ep: &Endpoints, body: &[u8], current: &str, kind: Option<Kind>) -> Option<UpdateInfo> {
    let m: serde_json::Value = serde_json::from_slice(body).ok()?;
    let latest = m["version"].as_str()?.trim().trim_start_matches('v').to_string();
    if latest.is_empty() || !latest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'+') {
        return None;
    }
    let asset = kind.and_then(|kind| {
        m["assets"].as_array()?.iter().find_map(|a| {
            let name = a["name"].as_str()?;
            if !kind.matches(name) || name.contains(['/', '\\', '?', '#', '%']) || name.starts_with('.') {
                return None;
            }
            Some(Asset {
                name: name.to_string(),
                url: format!("{}v{latest}/{name}", ep.download_prefix()),
                size: a["size"].as_u64().unwrap_or(0),
                sha256: a["sha256"].as_str().map(|h| h.trim().to_lowercase()).filter(|h| !h.is_empty()),
                kind: kind.as_str().to_string(),
            })
        })
    });
    Some(UpdateInfo {
        newer: version_gt(&latest, current),
        prerelease: false,
        channel: "stable".to_string(),
        notes: m["notes"].as_str().unwrap_or("").chars().take(4000).collect(),
        page: format!("{}/{REPO}/releases/tag/v{latest}", ep.web),
        asset,
        latest,
        current: current.to_string(),
    })
}

/// The release the API's list offers.
fn from_api(ep: &Endpoints, current: &str, channel: &str, kind: Option<Kind>) -> Result<UpdateInfo, Fetch> {
    let url = format!("{}/repos/{REPO}/releases?per_page=30", ep.api);
    let body = fetch(&url, "20", &["Accept: application/vnd.github+json", "User-Agent: Pyx-updater"])?;
    let bad = || Fetch::Offline("Respuesta de GitHub no válida.".to_string());
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|_| bad())?;
    let list = v.as_array().ok_or_else(bad)?;
    let (best, include_pre) = choose(list, current, channel);
    let r = best.ok_or_else(|| Fetch::Offline("GitHub no indica ninguna versión publicada.".to_string()))?;
    let latest = r["tag_name"].as_str().unwrap_or("").trim_start_matches('v').to_string();
    let empty = Vec::new();
    Ok(UpdateInfo {
        newer: version_gt(&latest, current),
        prerelease: r["prerelease"].as_bool().unwrap_or(false),
        channel: if include_pre { "beta" } else { "stable" }.to_string(),
        notes: r["body"].as_str().unwrap_or("").chars().take(4000).collect(),
        page: r["html_url"].as_str().unwrap_or("").to_string(),
        asset: pick_asset_for(ep, kind, r["assets"].as_array().unwrap_or(&empty)),
        latest,
        current: current.to_string(),
    })
}

fn check_at(ep: &Endpoints, channel: &str, current: &str, kind: Option<Kind>) -> Result<UpdateInfo, String> {
    // The manifest first, unless test versions were asked for.
    let manifest = if channel == "beta" {
        None
    } else {
        let url = format!("{}/{REPO}/releases/latest/download/pyx-update.json", ep.web);
        fetch(&url, "20", &["User-Agent: Pyx-updater"])
            .ok()
            .and_then(|body| from_manifest(ep, &body, current, kind))
    };
    if let Some(m) = &manifest {
        // It settles the matter unless this install is NEWER than the newest
        // stable release — a test version, whose updates only the API lists —
        // or it names no package for this system although one is installable.
        let tester = channel != "stable" && version_gt(current, &m.latest);
        let incomplete = m.newer && kind.is_some() && m.asset.is_none();
        if !tester && !incomplete {
            return Ok(manifest.unwrap());
        }
    }
    match from_api(ep, current, channel, kind) {
        Ok(info) => Ok(info),
        // The API refused or is unreachable: what the manifest said still holds.
        Err(e) => manifest.ok_or_else(|| e.message()),
    }
}

pub fn check(channel: &str) -> Result<UpdateInfo, String> {
    check_at(&Endpoints::github(), channel, env!("CARGO_PKG_VERSION"), platform_kind())
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
fn verified_digest(ep: &Endpoints, asset: &Asset) -> Result<(Kind, String), String> {
    let kind = Kind::parse(&asset.kind).ok_or("Instalador no reconocido.")?;
    if !asset.url.starts_with(&ep.download_prefix())
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

/// Where a download waits to be installed: a folder of THIS user.
///
/// The system's temporary folder is per user on Windows and macOS, but on
/// Linux `/tmp` is shared: the second person to update on the same computer
/// found a `/tmp/pyx-update` that belonged to the first and could not write
/// in it. There it goes under the user's own cache folder.
fn work_dir() -> PathBuf {
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let cache = std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")));
        if let Some(c) = cache {
            return c.join("Pyx").join("update");
        }
    }
    std::env::temp_dir().join("pyx-update")
}

/// Download the package and verify it. Nothing is installed and Pyx stays
/// open: it is installed when Pyx closes, or when the user asks.
pub fn download(asset: Asset) -> Result<(), String> {
    download_at(&Endpoints::github(), &work_dir(), asset)
}

fn download_at(ep: &Endpoints, dir: &Path, asset: Asset) -> Result<(), String> {
    let (kind, want) = verified_digest(ep, &asset)?;
    if let Ok(mut g) = READY.lock() {
        *g = None;
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("No se pudo preparar la carpeta de la descarga ({}): {e}", dir.display()))?;
    let file = dir.join(&asset.name);
    // Already here from an earlier session, and intact: nothing to download
    // again (the check is the same SHA-256 a fresh download would pass).
    if !(file.is_file() && sha256_of(&file).as_deref() == Some(want.as_str())) {
        // Whatever else is in the folder is an older version or a download
        // that never finished.
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                let _ = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
            }
        }
        // Into a `.part` file, renamed only once verified: a file with the
        // package's name is always a complete, checked package.
        let part = dir.join(format!("{}.part", asset.name));
        let target = part.to_string_lossy().to_string();
        // Bounded: `--speed-*` gives up on a transfer that has stopped moving
        // (under 1 KB/s for a minute) without punishing a slow but live one;
        // `--max-time` caps one attempt and `--retry-max-time` all of them.
        let mut c = Command::new("curl");
        c.args([
            "-fsSL",
            "--connect-timeout", "20",
            "--speed-limit", "1024", "--speed-time", "60",
            "--max-time", "1800",
            "--retry", "3", "--retry-max-time", "2400",
            "-H", "User-Agent: Pyx-updater",
            "-o", &target, &asset.url,
        ]);
        crate::quiet(&mut c);
        let out = c.output().map_err(|e| format!("No se pudo ejecutar curl: {e}"))?;
        if !out.status.success() {
            let _ = std::fs::remove_file(&part);
            return Err(format!(
                "No se pudo descargar la actualización. ¿Hay conexión a Internet?\n{}",
                String::from_utf8_lossy(&out.stderr).trim()
            )
            .trim()
            .to_string());
        }
        let size = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if size == 0 || (asset.size > 0 && size != asset.size) {
            let _ = std::fs::remove_file(&part);
            return Err("La descarga está incompleta: inténtalo de nuevo.".into());
        }
        if sha256_of(&part).as_deref() != Some(want.as_str()) {
            let _ = std::fs::remove_file(&part);
            return Err("El paquete descargado no coincide con el publicado (SHA-256): no se ha instalado.".into());
        }
        std::fs::rename(&part, &file).map_err(|e| format!("No se pudo guardar la actualización: {e}"))?;
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
    let done = match kind {
        Kind::Nsis => install_nsis(&file, reopen),
        Kind::AppImage => install_appimage(&file, reopen),
        Kind::MacApp => install_mac_app(&file, reopen),
    };
    // It could not even start: the package is still good, keep it for the
    // next try instead of downloading it again.
    if done.is_err() && file.is_file() {
        if let Ok(mut g) = READY.lock() {
            *g = Some((kind, file));
        }
    }
    done
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

    fn gh() -> Endpoints {
        Endpoints::github()
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
        assert_eq!(verified_digest(&gh(), &good).unwrap(), (Kind::Nsis, "ab".repeat(32)));
        let none = Asset { sha256: None, ..good.clone() };
        assert!(verified_digest(&gh(), &none).unwrap_err().contains("SHA-256"));
        let short = Asset { sha256: Some("abcd".into()), ..good.clone() };
        assert!(verified_digest(&gh(), &short).is_err());
        let not_hex = Asset { sha256: Some("zz".repeat(32)), ..good.clone() };
        assert!(verified_digest(&gh(), &not_hex).is_err());
        let foreign = Asset { url: "https://evil.example/Pyx_1.7.0_x64-setup.exe".into(), ..good.clone() };
        assert_eq!(verified_digest(&gh(), &foreign).unwrap_err(), "Instalador no reconocido.");
        let traversal = Asset { name: "..\\Pyx_x64-setup.exe".into(), ..good.clone() };
        assert!(verified_digest(&gh(), &traversal).is_err());
        let wrong_kind = Asset { kind: "mac-app".into(), ..good.clone() };
        assert!(verified_digest(&gh(), &wrong_kind).is_err());
        let unknown = Asset { kind: "script".into(), ..good.clone() };
        assert!(verified_digest(&gh(), &unknown).is_err());
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
        let w = pick_asset_for(&gh(), Some(Kind::Nsis), a).unwrap();
        assert_eq!((w.size, w.sha256.as_deref(), w.kind.as_str()), (3, Some("abcd"), "nsis"));
        let m = pick_asset_for(&gh(), Some(Kind::MacApp), a).unwrap();
        assert_eq!((m.size, m.kind.as_str()), (4, "mac-app"));
        if !cfg!(target_arch = "aarch64") {
            let l = pick_asset_for(&gh(), Some(Kind::AppImage), a).unwrap();
            assert_eq!((l.size, l.kind.as_str()), (6, "appimage"));
        }
        // A .deb/.rpm install: nothing to install by itself (page instead).
        assert!(pick_asset_for(&gh(), None, a).is_none());
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

    // ---- against a local server standing in for GitHub ---------------------

    use std::io::{Read, Write};
    use std::sync::{Arc, Mutex};

    /// A tiny HTTP server: `routes(path)` gives `(status, body)`. Returns its
    /// address and the list of paths it was asked for.
    fn serve(routes: impl Fn(&str) -> (u16, Vec<u8>) + Send + 'static) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                log.lock().unwrap().push(path.clone());
                let (code, body) = routes(&path);
                let _ = write!(s, "HTTP/1.1 {code} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = s.write_all(&body);
            }
        });
        (addr, seen)
    }

    fn at(addr: &str) -> Endpoints {
        Endpoints { api: addr.to_string(), web: addr.to_string() }
    }

    const MANIFEST: &str = r#"{"version":"2.1.0","notes":"n","assets":[
        {"name":"Pyx_2.1.0_x64-setup.exe","size":3,"sha256":"BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"},
        {"name":"Pyx_2.1.0_amd64.AppImage","size":3,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}]}"#;

    fn api_list() -> String {
        serde_json::json!([
            {"tag_name": "v2.1.1", "prerelease": true, "draft": false, "html_url": "p", "body": "", "assets": []},
            {"tag_name": "v2.1.0", "prerelease": false, "draft": false, "html_url": "p", "body": "", "assets": []}
        ])
        .to_string()
    }

    /// A stable install is answered by the manifest alone: the API — and its
    /// 60 requests an hour per address — is never touched.
    #[test]
    fn a_stable_install_never_asks_the_api() {
        let (addr, seen) = serve(|p| {
            if p.ends_with("/releases/latest/download/pyx-update.json") { (200, MANIFEST.as_bytes().to_vec()) } else { (500, vec![]) }
        });
        let info = check_at(&at(&addr), "auto", "2.0.0", Some(Kind::Nsis)).unwrap();
        assert!(info.newer);
        assert_eq!((info.latest.as_str(), info.channel.as_str(), info.prerelease), ("2.1.0", "stable", false));
        let a = info.asset.unwrap();
        // The URL is built from the tag and the name, under this repository.
        assert_eq!(a.url, format!("{addr}/LorGIOO/Pyx/releases/download/v2.1.0/Pyx_2.1.0_x64-setup.exe"));
        assert_eq!(a.sha256.as_deref(), Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
        assert_eq!(info.page, format!("{addr}/LorGIOO/Pyx/releases/tag/v2.1.0"));
        assert!(seen.lock().unwrap().iter().all(|p| !p.starts_with("/repos/")), "the API was asked");
        // Up to date: also without the API.
        let same = check_at(&at(&addr), "auto", "2.1.0", Some(Kind::Nsis)).unwrap();
        assert!(!same.newer);
        // A .deb install (nothing installable by itself) still learns of it.
        let deb = check_at(&at(&addr), "stable", "2.0.0", None).unwrap();
        assert!(deb.newer && deb.asset.is_none());
    }

    /// The API refusing (rate limit) does not break a stable install, and
    /// when there is nothing else to go by the message says what happened.
    #[test]
    fn a_rate_limited_api_is_said_in_words_and_survived() {
        // Releases older than the manifest: 404 there, 403 from the API.
        let (addr, _) = serve(|p| (if p.ends_with("pyx-update.json") { 404 } else { 403 }, b"{\"message\":\"API rate limit exceeded\"}".to_vec()));
        let err = check_at(&at(&addr), "auto", "2.0.0", Some(Kind::Nsis)).err().unwrap();
        assert!(err.contains("limitado"), "{err}");
        assert!(!err.contains("conexión a Internet"), "{err}");
        // A tester (newer than the newest stable) with the API refusing: the
        // manifest's answer stands — no error, nothing newer.
        let (addr, _) = serve(|p| if p.ends_with("pyx-update.json") { (200, MANIFEST.as_bytes().to_vec()) } else { (429, vec![]) });
        let info = check_at(&at(&addr), "auto", "2.1.1", Some(Kind::Nsis)).unwrap();
        assert!(!info.newer);
        // Nothing listening at all: that IS a connection problem.
        let dead = Endpoints { api: "http://127.0.0.1:9".into(), web: "http://127.0.0.1:9".into() };
        assert!(check_at(&dead, "auto", "2.0.0", Some(Kind::Nsis)).err().unwrap().contains("conexión"));
    }

    /// Test versions come from the API: a tester, or the «beta» channel.
    #[test]
    fn test_versions_are_listed_by_the_api() {
        let (addr, seen) = serve(|p| {
            if p.ends_with("pyx-update.json") { (200, MANIFEST.as_bytes().to_vec()) }
            else if p.starts_with("/repos/LorGIOO/Pyx/releases") { (200, api_list().into_bytes()) }
            else { (404, vec![]) }
        });
        // «beta»: straight to the API.
        let b = check_at(&at(&addr), "beta", "2.1.0", Some(Kind::Nsis)).unwrap();
        assert_eq!((b.latest.as_str(), b.prerelease), ("2.1.1", true));
        assert!(seen.lock().unwrap().iter().all(|p| !p.ends_with("pyx-update.json")));
        // No manifest in the release (every release before this one): the API.
        let (addr, _) = serve(|p| if p.starts_with("/repos/") { (200, api_list().into_bytes()) } else { (404, b"Not Found".to_vec()) });
        let old = check_at(&at(&addr), "auto", "2.0.0", Some(Kind::Nsis)).unwrap();
        assert_eq!(old.latest, "2.1.0");
    }

    /// A manifest cannot send the download anywhere else, whatever it says.
    #[test]
    fn a_manifest_cannot_redirect_the_download() {
        let ep = gh();
        let evil = br#"{"version":"9.9.9","assets":[
            {"name":"../../evil_x64-setup.exe","sha256":"aa","url":"https://evil.example/x.exe"},
            {"name":"Pyx_9.9.9_x64-setup.exe","sha256":"bb","url":"https://evil.example/x.exe","browser_download_url":"https://evil.example/x.exe"}]}"#;
        let info = from_manifest(&ep, evil, "2.0.0", Some(Kind::Nsis)).unwrap();
        let a = info.asset.unwrap();
        assert_eq!(a.url, "https://github.com/LorGIOO/Pyx/releases/download/v9.9.9/Pyx_9.9.9_x64-setup.exe");
        // A version that is not a version, or not JSON: no manifest at all.
        assert!(from_manifest(&ep, br#"{"version":"1.0/../x"}"#, "2.0.0", Some(Kind::Nsis)).is_none());
        assert!(from_manifest(&ep, b"<html>Not Found</html>", "2.0.0", Some(Kind::Nsis)).is_none());
    }

    /// Download → verify → ready; a wrong hash or a cut download leaves
    /// nothing behind; a package already downloaded is not fetched again.
    #[test]
    fn a_download_is_verified_and_reused() {
        let (addr, seen) = serve(|p| {
            if p.ends_with("/Pyx_2.1.0_x64-setup.exe") { (200, b"abc".to_vec()) }
            else if p.ends_with("/Pyx_2.1.1_x64-setup.exe") { (200, b"abd".to_vec()) }
            else { (404, vec![]) }
        });
        let ep = at(&addr);
        let dir = std::env::temp_dir().join(format!("pyx-upd-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let asset = |v: &str, size: u64| Asset {
            name: format!("Pyx_{v}_x64-setup.exe"),
            url: format!("{addr}/LorGIOO/Pyx/releases/download/v{v}/Pyx_{v}_x64-setup.exe"),
            size,
            sha256: Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into()),
            kind: "nsis".into(),
        };
        // The right bytes.
        download_at(&ep, &dir, asset("2.1.0", 3)).unwrap();
        let file = dir.join("Pyx_2.1.0_x64-setup.exe");
        assert_eq!(std::fs::read(&file).unwrap(), b"abc");
        assert_eq!(READY.lock().unwrap().clone(), Some((Kind::Nsis, file.clone())));
        // Asked again (Pyx restarted): no second download.
        let before = seen.lock().unwrap().len();
        download_at(&ep, &dir, asset("2.1.0", 3)).unwrap();
        assert_eq!(seen.lock().unwrap().len(), before);
        // Other bytes under the published hash: refused, nothing kept, and
        // the older package is gone too (one version at a time).
        let err = download_at(&ep, &dir, asset("2.1.1", 3)).unwrap_err();
        assert!(err.contains("SHA-256"), "{err}");
        assert!(READY.lock().unwrap().is_none());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        // A size that does not match what was announced.
        assert!(download_at(&ep, &dir, asset("2.1.0", 99)).unwrap_err().contains("incompleta"));
        // A package that is not there.
        assert!(download_at(&ep, &dir, asset("2.0.9", 3)).unwrap_err().contains("descargar"));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
