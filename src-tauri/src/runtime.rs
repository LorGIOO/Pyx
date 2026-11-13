//! Tools Pyx can set up by itself, so a new user installs Pyx and nothing else.
//!
//! * **Python** — through [uv](https://github.com/astral-sh/uv): uv downloads a
//!   standalone CPython (python-build-standalone) and creates an environment
//!   with the scientific stack, all inside Pyx's own data folder. Nothing is
//!   added to PATH and nothing outside that folder changes.
//! * **LaTeX** — [Tectonic](https://tectonic-typesetting.github.io/): one
//!   program that downloads the packages each document needs on first use.
//! * **Packages** — `uv pip install` into the interpreter the kernel runs, for
//!   the "Instalar" button on a `ModuleNotFoundError`.
//!
//! Downloads use the system's own `curl` and `tar` (both ship with Windows 10
//! and later, macOS and every Linux), so Pyx carries no HTTP or archive code.
//! Progress is streamed to the window as `setup:line` events.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Pyx's own data folder: `%LOCALAPPDATA%\com.pyx.studio`, `~/Library/Application
/// Support/Pyx`, `$XDG_DATA_HOME/pyx` (or `~/.local/share/pyx`).
pub fn tools_dir() -> PathBuf {
    #[cfg(windows)]
    {
        // NOT `%LOCALAPPDATA%\Pyx`: that is where the installer puts Pyx
        // itself, and the program folder holds the program and nothing else.
        // `com.pyx.studio` is the app's identifier, the folder Tauri's own
        // uninstaller offers to remove with the app.
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(local).join(DATA_ID);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join("Library/Application Support/Pyx");
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Ok(x) = std::env::var("XDG_DATA_HOME") {
            if !x.is_empty() {
                return PathBuf::from(x).join("pyx");
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(".local/share/pyx");
        }
    }
    std::env::temp_dir().join("pyx-tools")
}

/// The app's identifier (tauri.conf.json), the name of its data folder.
pub const DATA_ID: &str = "com.pyx.studio";

/// Move what earlier versions kept next to the program (`%LOCALAPPDATA%\Pyx`)
/// into the data folder: Python environments, Tectonic, the recognizer,
/// working directories, logs and notebook snapshots. Moved, not copied — the
/// same drive, so it is a rename and costs nothing — and only what is not
/// there yet. The program's own files (pyx.exe, the uninstaller, the icon)
/// are never touched. Best effort: anything that cannot move stays where it
/// is and is simply made again when needed.
#[cfg(windows)]
pub fn migrate_old_data() {
    let Ok(local) = std::env::var("LOCALAPPDATA") else { return };
    let old = PathBuf::from(&local).join("Pyx");
    let new = PathBuf::from(&local).join(DATA_ID);
    if !old.is_dir() {
        return;
    }
    let _ = std::fs::create_dir_all(&new);
    for name in ["env", "ocr", "uv", "tectonic", "python", "build", "logs", "jupyter", "history"] {
        let from = old.join(name);
        let to = new.join(name);
        if !from.is_dir() {
            continue;
        }
        if !to.exists() {
            let _ = std::fs::rename(&from, &to);
            continue;
        }
        // Both exist (this version already wrote some): merge one level down
        // — each project's working directory, each environment — keeping
        // what the data folder already has, and drop the old folder once
        // nothing is left in it.
        if let Ok(entries) = std::fs::read_dir(&from) {
            for e in entries.flatten() {
                let dest = to.join(e.file_name());
                if !dest.exists() {
                    let _ = std::fs::rename(e.path(), &dest);
                } else if name == "build" {
                    // A project's working directory in both places: the one
                    // in the data folder is the one in use; the old one is a
                    // stale cache that the next compile would rebuild anyway.
                    let _ = std::fs::remove_dir_all(e.path());
                }
            }
        }
        let _ = std::fs::remove_dir(&from); // only succeeds when empty
    }
}
#[cfg(not(windows))]
pub fn migrate_old_data() {}

const EXE: &str = if cfg!(windows) { ".exe" } else { "" };

/// Pyx's Tectonic, if it has been set up.
pub fn tectonic_dir() -> PathBuf {
    tools_dir().join("tectonic")
}
fn uv_path() -> PathBuf {
    tools_dir().join("uv").join(format!("uv{EXE}"))
}
fn env_dir() -> PathBuf {
    tools_dir().join("env")
}
/// The Python of Pyx's own environment, if it has been set up.
pub fn env_python() -> Option<PathBuf> {
    let p = if cfg!(windows) {
        env_dir().join("Scripts").join("python.exe")
    } else {
        env_dir().join("bin").join("python")
    };
    p.exists().then_some(p)
}

/// The packages Pyx's environment starts with: what a calculation report uses.
pub const DEFAULT_PACKAGES: &[&str] = &[
    "numpy", "scipy", "sympy", "pandas", "matplotlib", "openpyxl", "handcalcs", "pint", "jedi",
    // handcalcs' %%render and %%tex are IPython magics: without IPython they cannot exist.
    "ipython",
    // pandas' to_latex (pyx.tex / pyx.tabletex on a DataFrame) goes through jinja2.
    "jinja2",
];

const TECTONIC: &str = "0.15.0";

fn target() -> &'static str {
    if cfg!(all(windows, target_arch = "aarch64")) {
        "aarch64-pc-windows-msvc"
    } else if cfg!(windows) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(target_os = "macos") {
        "x86_64-apple-darwin"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64-unknown-linux-gnu"
    } else {
        "x86_64-unknown-linux-gnu"
    }
}

/// Where progress lines go (the window, in the app; stdout, in tests).
pub type Say<'a> = &'a (dyn Fn(String) + Sync);

fn say(app: Say, line: impl Into<String>) {
    app(line.into());
}

/// Run a command, streaming its output to the window; Err with its last lines.
fn run(app: Say, cmd: &mut Command) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::quiet(cmd);
    let mut child = cmd.spawn().map_err(|e| format!("No se pudo ejecutar {:?}: {e}", cmd.get_program()))?;
    let tail = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let mut readers = Vec::new();
    for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
                   child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>)].into_iter().flatten() {
        let t = tail.clone();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        readers.push((std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let line = line.trim_end().to_string();
                if line.is_empty() {
                    continue;
                }
                let _ = tx.send(line.clone());
                if let Ok(mut v) = t.lock() {
                    v.push(line);
                    if v.len() > 8 {
                        v.remove(0);
                    }
                }
            }
        }), rx));
    }
    // Relay the lines on THIS thread (the callback is not Send), until both
    // streams are closed.
    let mut open = readers.len();
    while open > 0 {
        open = 0;
        for (h, rx) in &readers {
            while let Ok(line) = rx.try_recv() {
                say(app, line);
            }
            if !h.is_finished() {
                open += 1;
            }
        }
        if open > 0 {
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
    }
    for (h, rx) in readers {
        let _ = h.join();
        while let Ok(line) = rx.try_recv() {
            say(app, line);
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(tail.lock().map(|v| v.join("\n")).unwrap_or_default())
    }
}

/// Download `url` and unpack it into `dest` (emptied first).
fn fetch(app: Say, url: &str, dest: &Path) -> Result<(), String> {
    let _ = std::fs::remove_dir_all(dest);
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let name = url.rsplit('/').next().unwrap_or("descarga");
    let archive = dest.join(name);
    say(app, format!("Descargando {name}…"));
    run(app, Command::new("curl").args(["-fL", "--retry", "3", "--silent", "--show-error", "-o"])
        .arg(&archive).arg(url))
        .map_err(|e| format!("No se pudo descargar {url}. ¿Hay conexión a Internet?\n{e}"))?;
    say(app, "Descomprimiendo…");
    run(app, Command::new("tar").arg("-xf").arg(&archive).arg("-C").arg(dest))?;
    let _ = std::fs::remove_file(&archive);
    Ok(())
}

/// Find `file` anywhere under `dir` (archives nest it in a folder).
fn find_file(dir: &Path, file: &str) -> Option<PathBuf> {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).ok()?.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.file_name().map(|n| n == file).unwrap_or(false) {
                return Some(p);
            }
        }
    }
    None
}

/// Move `found` to `dir/file` (the place the rest of Pyx looks for it).
fn settle(found: PathBuf, dir: &Path, file: &str) -> Result<PathBuf, String> {
    let target = dir.join(file);
    if found != target {
        std::fs::rename(&found, &target).map_err(|e| e.to_string())?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
    }
    Ok(target)
}

/// Download Tectonic into Pyx's data folder. Returns its path.
pub fn install_tectonic(app: Say) -> Result<String, String> {
    let t = target().replace("-unknown-linux-gnu", "-unknown-linux-musl");
    let ext = if cfg!(windows) { "zip" } else { "tar.gz" };
    let url = format!(
        "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40{TECTONIC}/tectonic-{TECTONIC}-{t}.{ext}"
    );
    let dir = tectonic_dir();
    fetch(app, &url, &dir)?;
    let file = format!("tectonic{EXE}");
    let found = find_file(&dir, &file).ok_or("El archivo descargado no contiene tectonic.")?;
    let exe = settle(found, &dir, &file)?;
    say(app, format!("Tectonic {TECTONIC} listo."));
    Ok(exe.to_string_lossy().to_string())
}

/// uv, downloading it the first time.
fn ensure_uv(app: Say) -> Result<PathBuf, String> {
    let uv = uv_path();
    if uv.exists() {
        return Ok(uv);
    }
    let ext = if cfg!(windows) { "zip" } else { "tar.gz" };
    let url = format!("https://github.com/astral-sh/uv/releases/latest/download/uv-{}.{ext}", target());
    let dir = uv.parent().unwrap().to_path_buf();
    fetch(app, &url, &dir)?;
    let file = format!("uv{EXE}");
    let found = find_file(&dir, &file).ok_or("El archivo descargado no contiene uv.")?;
    settle(found, &dir, &file)
}

fn uv_command(uv: &Path) -> Command {
    let mut c = Command::new(uv);
    // The standalone Python lives in Pyx's folder too, never in the user's.
    c.env("UV_PYTHON_INSTALL_DIR", tools_dir().join("python"));
    c
}

/// Create Pyx's Python environment (standalone CPython + `packages`).
/// Returns the environment's interpreter.
pub fn setup_python(app: Say, packages: &[String]) -> Result<String, String> {
    let uv = ensure_uv(app)?;
    let env = env_dir();
    if env_python().is_none() {
        say(app, "Preparando Python (se descarga una sola vez)…");
        run(app, uv_command(&uv).args(["venv", "--python", "3.12", "--managed-python", "--seed"]).arg(&env))?;
    }
    let py = env_python().ok_or("No se creó el entorno de Python.")?;
    let mut pkgs: Vec<String> = DEFAULT_PACKAGES.iter().map(|s| s.to_string()).collect();
    for p in packages {
        if !pkgs.contains(p) {
            pkgs.push(p.clone());
        }
    }
    say(app, format!("Instalando {}…", pkgs.join(", ")));
    run(app, uv_command(&uv).args(["pip", "install", "--python"]).arg(&py).args(&pkgs))?;
    say(app, "Python listo.");
    Ok(py.to_string_lossy().to_string())
}

/* ---- formula recognition (image -> LaTeX) --------------------------------
   Its own small environment, apart from the one the documents compute in:
   the recognizer (rapid_latex_ocr: an ONNX port of LaTeX-OCR, no PyTorch)
   does not install on every Python — it has no build for 3.13 — and nothing
   it needs belongs in the user's interpreter. */
fn ocr_dir() -> PathBuf {
    tools_dir().join("ocr")
}
/// The interpreter of the recognizer's environment, once it is set up.
pub fn ocr_python() -> Option<PathBuf> {
    let p = if cfg!(windows) {
        ocr_dir().join("Scripts").join("python.exe")
    } else {
        ocr_dir().join("bin").join("python")
    };
    // The marker is written only after the package installed: an environment
    // left half-made by an interrupted download does not count as ready.
    (p.exists() && ocr_dir().join("pyx-ocr-ready").exists()).then_some(p)
}

/// Create the recognizer's environment (standalone CPython 3.12 + the
/// package). Its models are fetched by the package itself on first use.
pub fn setup_ocr(app: Say) -> Result<String, String> {
    if let Some(py) = ocr_python() {
        return Ok(py.to_string_lossy().to_string());
    }
    let uv = ensure_uv(app)?;
    let env = ocr_dir();
    let py = if cfg!(windows) { env.join("Scripts").join("python.exe") } else { env.join("bin").join("python") };
    if !py.exists() {
        say(app, "Preparando el reconocedor de fórmulas (se descarga una sola vez)…");
        run(app, uv_command(&uv).args(["venv", "--python", "3.12", "--managed-python"]).arg(&env))?;
    }
    say(app, "Instalando el reconocedor…");
    // `requests` is used by the package to fetch its models and is not among
    // its declared dependencies: without it the first recognition fails.
    run(app, uv_command(&uv).args(["pip", "install", "--python"]).arg(&py).args(["rapid_latex_ocr", "requests"]))?;
    // Its models (about 170 MB) are fetched the first time it is created —
    // minutes on a slow line. Done HERE, where the user was told a download
    // is under way, and not inside the first recognition, which is bounded
    // in time and would be cut short.
    say(app, "Descargando los modelos del reconocedor (unos 170 MB, una sola vez)…");
    let mut warm = Command::new(&py);
    // No progress bars: they redraw with carriage returns, and a download of
    // minutes would arrive as one enormous "line".
    warm.env("TQDM_DISABLE", "1");
    warm.args(["-I", "-X", "utf8", "-c", "from rapid_latex_ocr import LaTeXOCR; LaTeXOCR(); print('modelos listos')"]);
    run(app, &mut warm)?;
    std::fs::write(env.join("pyx-ocr-ready"), b"ok").map_err(|e| e.to_string())?;
    say(app, "Reconocedor de fórmulas listo.");
    Ok(py.to_string_lossy().to_string())
}

/// Install `packages` into the interpreter `python` (the one the kernel runs).
/// uv first (fast, and it works on Pyx's environment and on most others);
/// `python -m pip install --user` when uv cannot (a distro-managed Python).
pub fn install_packages(app: Say, python: &str, packages: &[String]) -> Result<(), String> {
    let clean: Vec<&String> = packages
        .iter()
        .filter(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || "-_.[]=<>!~,".contains(c)))
        .collect();
    if clean.is_empty() {
        return Err("Nombre de paquete no válido.".into());
    }
    say(app, format!("Instalando {}…", clean.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")));
    if let Ok(uv) = ensure_uv(app) {
        if run(app, uv_command(&uv).args(["pip", "install", "--python", python]).args(&clean)).is_ok() {
            say(app, "Instalado.");
            return Ok(());
        }
        say(app, "uv no pudo instalar en este intérprete; se intenta con pip…");
    }
    run(app, Command::new(python).args(["-m", "pip", "install", "--user"]).args(&clean))?;
    say(app, "Instalado.");
    Ok(())
}

#[derive(serde::Serialize)]
pub struct RuntimeInfo {
    pub tools_dir: String,
    pub env_python: Option<String>,
    pub tectonic: Option<String>,
    pub uv: bool,
}

pub fn info() -> RuntimeInfo {
    let tec = tectonic_dir().join(format!("tectonic{EXE}"));
    RuntimeInfo {
        tools_dir: tools_dir().to_string_lossy().to_string(),
        env_python: env_python().map(|p| p.to_string_lossy().to_string()),
        tectonic: tec.exists().then(|| tec.to_string_lossy().to_string()),
        uv: uv_path().exists(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Downloads ~30 MB: `cargo test -- --ignored runtime_downloads`.
    #[test]
    #[ignore]
    fn runtime_downloads_tectonic_and_installs_a_package() {
        let home = std::env::temp_dir().join(format!("pyx-rt-{}", std::process::id()));
        std::env::set_var("XDG_DATA_HOME", &home);
        std::env::set_var("LOCALAPPDATA", &home);
        let lines = std::sync::Mutex::new(Vec::new());
        let say = |l: String| lines.lock().unwrap().push(l);
        let exe = install_tectonic(&say).expect("tectonic");
        let out = Command::new(&exe).arg("--version").output().expect("runs");
        assert!(String::from_utf8_lossy(&out.stdout).contains("Tectonic"));
        assert!(info().tectonic.is_some());
        // uv into a throwaway venv (fast): the package path the "Instalar" button uses.
        let uv = ensure_uv(&say).expect("uv");
        let venv = home.join("v");
        run(&say, uv_command(&uv).arg("venv").arg(&venv)).expect("venv");
        let py = if cfg!(windows) { venv.join("Scripts/python.exe") } else { venv.join("bin/python") };
        install_packages(&say, py.to_str().unwrap(), &["six".to_string()]).expect("install");
        let ok = Command::new(&py).args(["-c", "import six"]).status().unwrap();
        assert!(ok.success());
        assert!(lines.lock().unwrap().iter().any(|l| l.contains("Descargando")));
        let _ = std::fs::remove_dir_all(&home);
    }
}
