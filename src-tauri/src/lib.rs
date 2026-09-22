mod kernel;
mod latex;
mod pltx;
mod workspace;

use kernel::KernelState;
use tauri::{Emitter, Manager};

/// Configure a child process so it never flashes a console window on Windows
/// GUI builds (python probes, the kernel, TeX passes, cmd /C…).
pub(crate) fn quiet(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Why a child process could not be STARTED, in words the user can act on.
///
/// The case that matters is Windows error 267, which reached the log as
/// "os error 267" and told nobody anything. It means the working directory
/// handed to CreateProcess is longer than MAX_PATH (260 characters), and it is
/// not a limitation Pyx can work around: the `\\?\` prefix lifts the length
/// limit for FILE paths, not for the directory a process is started in, and
/// neither the long-path registry switch nor the application manifest changes
/// that. The engine simply cannot be run from a folder that deep, so the only
/// real answer is to say so and name the folder.
pub(crate) fn spawn_error(what: &str, dir: Option<&std::path::Path>, e: &std::io::Error) -> String {
    #[cfg(windows)]
    {
        if e.raw_os_error() == Some(267) {
            if let Some(dir) = dir {
                let n = dir.as_os_str().len();
                return format!(
                    "No se pudo ejecutar {what}: la carpeta de trabajo tiene {n} caracteres y \
                     Windows no permite arrancar un programa en una carpeta de más de 260, \
                     aunque las rutas largas estén activadas.\n\n\
                     Mueve el proyecto a una ruta más corta (por ejemplo C:\\Proyectos\\…) \
                     y vuelve a compilar.\n\n\
                     Carpeta: {}",
                    dir.display()
                );
            }
            return format!(
                "No se pudo ejecutar {what}: la carpeta de trabajo supera el límite de 260 \
                 caracteres de Windows. Mueve el proyecto a una ruta más corta."
            );
        }
    }
    let _ = dir;
    format!("No se pudo ejecutar {what}: {e}")
}

// HEAVY commands are `async` + `spawn_blocking`: synchronous Tauri commands
// run ON THE MAIN THREAD, so a 2-second xelatex pass or a long Python cell
// used to freeze the whole UI (typing blocked until the compile finished).
// Off the main thread, editing stays fluid while compiles run in background.

#[tauri::command]
async fn detect_env() -> Result<latex::EnvInfo, String> {
    tauri::async_runtime::spawn_blocking(latex::detect_env)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn compile_latex(
    path: String,
    project_dir: String,
    engine: String,
    passes: u32,
    jobname: Option<String>,
    search_dirs: Option<Vec<String>>,
) -> Result<latex::CompileResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dirs = search_dirs.unwrap_or_default();
        latex::compile(&path, &project_dir, &engine, passes, jobname, &dirs)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copy a file. Used to export the compiled PDF out of the project's working
/// directory, which is the only way it leaves: the build output no longer sits
/// next to the document, so "save a copy" has to be an explicit action.
#[tauri::command]
async fn copy_file(from: String, to: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::copy(&from, &to)
            .map(|_| ())
            .map_err(|e| format!("No se pudo copiar el archivo: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The working directory for a project, created if needed.
///
/// Everything the build produces lives here, outside the user's folder: the
/// `.build.tex` copies, the engine's scratch, the PDF and the SyncTeX index.
#[tauri::command]
async fn build_dir(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        workspace::ensure_build_dir(&path).map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// List the font FAMILIES installed on the system, for the editor's font
/// picker (so it shows every installed typeface, like Word — not a fixed few).
#[tauri::command]
async fn list_fonts() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(target_os = "windows")]
        {
            let mut cmd = std::process::Command::new("powershell");
            cmd.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Add-Type -AssemblyName System.Drawing; \
                 [System.Drawing.FontFamily]::Families | ForEach-Object { $_.Name }",
            ]);
            quiet(&mut cmd);
            let out = cmd.output().map_err(|e| e.to_string())?;
            let text = String::from_utf8_lossy(&out.stdout);
            let mut v: Vec<String> = text
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
            v.sort_by_key(|s| s.to_lowercase());
            v.dedup();
            Ok(v)
        }
        #[cfg(not(target_os = "windows"))]
        {
            Ok(Vec::new())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// SyncTeX inverse search: PDF point → source file + line (Ctrl+click).
#[tauri::command]
async fn synctex_edit(
    pdf: String,
    page: u32,
    x: f64,
    y: f64,
) -> Result<latex::SyncTexHit, String> {
    // The PDF and its SyncTeX index live side by side in the project's working
    // directory, which is where the CLI looks — nothing to stage first.
    tauri::async_runtime::spawn_blocking(move || latex::synctex_edit(&pdf, page, x, y))
    .await
    .map_err(|e| e.to_string())?
}

/// SyncTeX forward search: source file + line → PDF page/position.
#[tauri::command]
async fn synctex_view(
    tex: String,
    line: u32,
    pdf: String,
) -> Result<latex::SyncTexLoc, String> {
    tauri::async_runtime::spawn_blocking(move || latex::synctex_view(&tex, line, &pdf))
    .await
    .map_err(|e| e.to_string())?
}

/// Open a `.pltx` container (ZIP). Returns `{is_zip, source, outputs}`; when it
/// is a zip the bundled build artifacts are extracted next to it. Legacy
/// plain-text `.pltx` reports `is_zip=false` (the JS side decodes it as text).
#[tauri::command]
async fn pltx_read(path: String, restore: Option<bool>) -> Result<pltx::PltxRead, String> {
    // Absent = a plain read. Only opening a document restores its working
    // directory (see pltx::read for what went wrong when every read did).
    let restore = restore.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || pltx::read(&path, restore))
        .await
        .map_err(|e| e.to_string())?
}

/// Save a `.pltx` container: pack source + cell results + loose build artifacts
/// into the zip (PDF excluded) and clean the loose files from the folder.
#[tauri::command]
async fn pltx_write(
    path: String,
    source: String,
    outputs: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pltx::write(&path, &source, outputs.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// Read a file's raw bytes. Used to load the compiled PDF into PDF.js without
/// the plugin-fs scope restrictions (the PDF can live in any folder).
///
/// Answers with `tauri::ipc::Response`, which crosses the bridge as RAW BYTES
/// (an ArrayBuffer on the JS side). Returning a plain `Vec<u8>` makes Tauri
/// serialize the file as a JSON array of numbers: a 20 MB PDF turned into
/// roughly 70 MB of text to format, transfer and parse — and this runs on
/// every compile, including the background ones a typing pause triggers.
#[tauri::command]
async fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&path).map_err(|e| format!("No se pudo leer {path}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Write a text file, in any folder.
///
/// The frontend used plugin-fs for this, whose scope only reaches the user's
/// home folders. A project on another drive (`E:\…`), a USB stick or a network
/// share could not be written at all — and worse, `exists` answered "no" for
/// every file there, so the compiler never found the chapters a document
/// `\input`s and handed the engine a raw `.pltx` zip. Opening, packing and
/// compiling already went through Rust commands with no such limit; reading,
/// writing and probing a source file now do too.
#[tauri::command]
async fn write_text(path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&path, content.as_bytes())
            .map_err(|e| format!("No se pudo escribir {path}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write raw bytes (a document in a non-UTF-8 encoding, an exported image).
///
/// The bytes arrive as the request BODY, not as JSON — the same reason
/// `read_file_bytes` answers with raw bytes — and the path in a header,
/// percent-encoded because header values are ASCII.
#[tauri::command]
async fn write_bytes(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("write_bytes espera los bytes en el cuerpo de la petición".into());
    };
    let path = request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or("write_bytes necesita la cabecera «path»")?;
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&path, bytes).map_err(|e| format!("No se pudo escribir {path}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Undo `encodeURIComponent`: `%XX` escapes are UTF-8 bytes.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let hex = |c: u8| (c as char).to_digit(16);
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Does a file or folder exist? In any folder (see `write_text`).
#[tauri::command]
async fn path_exists(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || std::path::Path::new(&path).exists())
        .await
        .unwrap_or(false)
}

/// Modification stamp of a file: (mtime in ms, size in bytes). `-1` for a file
/// that does not exist or cannot be read.
#[derive(serde::Serialize)]
pub struct FileStamp {
    mtime: i64,
    size: i64,
}

/// Stamp several files in ONE call.
///
/// The compiler walks the `\input` tree on every compile (including the live,
/// type-triggered ones). Re-reading every chapter of a large project from disk
/// each time is what made big multi-file documents crawl. With a stamp it can
/// reuse the text it already has and only re-read what actually changed on
/// disk — and one batched command beats N round-trips across the IPC bridge.
#[tauri::command]
async fn file_stamps(paths: Vec<String>) -> Result<Vec<FileStamp>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .map(|p| match std::fs::metadata(p) {
                Ok(md) => {
                    let mtime = md
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(-1);
                    FileStamp { mtime, size: md.len() as i64 }
                }
                Err(_) => FileStamp { mtime: -1, size: -1 },
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct DirItem {
    name: String,
    path: String,
    is_dir: bool,
}

/// List a directory's entries (folders first, then files, alphabetical). Used
/// by the side panel's "Archivos" view to browse the document's folder.
///
/// Async like every other filesystem command: a synchronous Tauri command runs
/// ON THE MAIN THREAD, so listing a slow folder (a network share, a cold
/// external drive) froze the whole interface.
#[tauri::command]
async fn read_dir(path: String) -> Result<Vec<DirItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        let rd = std::fs::read_dir(&path).map_err(|e| format!("No se pudo leer {path}: {e}"))?;
        for entry in rd.flatten() {
            let is_dir = entry.metadata().map(|m| m.is_dir()).unwrap_or(false);
            out.push(DirItem {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry.path().to_string_lossy().to_string(),
                is_dir,
            });
        }
        out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn kernel_start(state: tauri::State<'_, KernelState>) -> Result<serde_json::Value, String> {
    let k = state.handle();
    tauri::async_runtime::spawn_blocking(move || kernel::start(&k))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn kernel_exec(
    state: tauri::State<'_, KernelState>,
    req: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let k = state.handle();
    tauri::async_runtime::spawn_blocking(move || kernel::exec(&k, req))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn kernel_reset(state: tauri::State<'_, KernelState>) -> Result<serde_json::Value, String> {
    let k = state.handle();
    tauri::async_runtime::spawn_blocking(move || kernel::reset(&k))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn kernel_shutdown(state: tauri::State<'_, KernelState>) -> Result<(), String> {
    let k = state.handle();
    tauri::async_runtime::spawn_blocking(move || kernel::shutdown(&k))
        .await
        .map_err(|e| e.to_string())?
}

/// Set the interpreter the kernel uses (None = automatic) and respawn it.
#[tauri::command]
async fn kernel_set_python(
    state: tauri::State<'_, KernelState>,
    path: Option<String>,
) -> Result<serde_json::Value, String> {
    kernel::set_python_override(path);
    let k = state.handle();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = kernel::shutdown(&k);
        kernel::start(&k)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Interrupt a running cell.
///
/// `hard = false` (the default path) is a Jupyter-style SOFT interrupt: the
/// kernel raises `KeyboardInterrupt` inside the running cell and the session's
/// variables survive. `hard = true` kills the process, for the rare cell that
/// never yields to Python (a C extension in a tight loop).
#[tauri::command]
async fn kernel_interrupt(hard: Option<bool>) -> Result<(), String> {
    let hard = hard.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        if hard {
            kernel::interrupt_hard();
        } else {
            kernel::interrupt_soft();
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// List usable Python interpreters for the picker.
#[tauri::command]
async fn list_pythons() -> Result<Vec<kernel::PyProbe>, String> {
    tauri::async_runtime::spawn_blocking(kernel::list_interpreters)
        .await
        .map_err(|e| e.to_string())
}

/// File-explorer operations (side panel): rename / delete / create. All async
/// so a slow volume can never block the UI thread.
#[tauri::command]
async fn rename_path(from: String, to: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::rename(&from, &to).map_err(|e| format!("No se pudo renombrar: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn remove_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        if p.is_dir() {
            std::fs::remove_dir_all(p).map_err(|e| format!("No se pudo eliminar la carpeta: {e}"))
        } else {
            std::fs::remove_file(p).map_err(|e| format!("No se pudo eliminar el archivo: {e}"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn create_file(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if std::path::Path::new(&path).exists() {
            return Err("Ya existe un archivo con ese nombre.".to_string());
        }
        std::fs::write(&path, "").map_err(|e| format!("No se pudo crear el archivo: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn create_dir(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&path).map_err(|e| format!("No se pudo crear la carpeta: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open a file in its default application as a separate window (the PDF viewer's
/// "floating window" tool opens the compiled PDF this way).
#[tauri::command]
fn open_external(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Detach the app's OWN PDF viewer into an auxiliary window: a second webview
/// running the same bundle, which renders only the viewer UI and loads the PDF.
///
/// MUST be `async`: creating a webview window from a synchronous command
/// deadlocks on Windows (known wry/WebView2 issue) — the window appeared but
/// its content never initialized (blank, no toolbar). Async commands run off
/// the main thread, avoiding the deadlock.
#[tauri::command]
async fn open_viewer_window(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    // Reuse a live viewer window: point it at the (possibly new) PDF and bring
    // it to front. Also avoids the close()/build() race on the same label.
    if let Some(w) = app.get_webview_window("pdf-viewer") {
        let _ = w.emit("viewer:load", &path);
        let _ = w.set_focus();
        return Ok(());
    }
    // NOTE: WebviewUrl::App treats its argument as a PATH, so a query string
    // gets percent-encoded and the page never loads (blank window). The PDF
    // path travels via an init script instead; it arrives percent-encoded
    // from the frontend, so it is safe inside a JS string literal.
    WebviewWindowBuilder::new(&app, "pdf-viewer", WebviewUrl::App("index.html".into()))
        .title("Pyx — Visor PDF")
        .inner_size(920.0, 1000.0)
        .min_inner_size(420.0, 480.0)
        .decorations(true)
        .initialization_script(&format!("window.__PYX_VIEWER__={{pdf:\"{path}\"}};"))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Reveal a file in the OS file manager (used to open the compiled PDF folder).
#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // No portable "select in file manager" on Linux — open the folder.
        let dir = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path.clone());
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Decide how to launch a terminal command. `pip`/`python` are run with the
/// same interpreter the kernel uses (so installs are visible to the cells),
/// launched directly to avoid shell-quoting pitfalls; anything else goes
/// through the OS shell so pipes, builtins, etc. work.
fn build_invocation(input: &str) -> (String, Vec<String>) {
    let parts: Vec<String> = input.split_whitespace().map(|s| s.to_string()).collect();
    let first = parts.first().map(|s| s.as_str()).unwrap_or("");
    if matches!(first, "pip" | "pip3") {
        if let Some(py) = kernel::find_python() {
            let mut args = vec!["-m".to_string(), "pip".to_string()];
            args.extend(parts.iter().skip(1).cloned());
            return (py, args);
        }
    } else if matches!(first, "python" | "python3" | "py") {
        if let Some(py) = kernel::find_python() {
            return (py, parts.iter().skip(1).cloned().collect());
        }
    }
    #[cfg(target_os = "windows")]
    {
        ("cmd".to_string(), vec!["/C".to_string(), input.to_string()])
    }
    #[cfg(not(target_os = "windows"))]
    {
        ("sh".to_string(), vec!["-c".to_string(), input.to_string()])
    }
}

/// Run a command for the in-app terminal, streaming stdout/stderr to the UI as
/// `terminal:line` events and the exit code as `terminal:done`.
#[tauri::command]
fn run_command(app: tauri::AppHandle, command: String, cwd: Option<String>) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    let input = command.trim().to_string();
    if input.is_empty() {
        let _ = app.emit("terminal:done", 0);
        return Ok(());
    }

    let (program, args) = build_invocation(&input);
    let mut cmd = Command::new(&program);
    cmd.args(&args);
    if let Some(dir) = cwd.as_ref() {
        if !dir.is_empty() {
            cmd.current_dir(dir);
        }
    }
    cmd.env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    quiet(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| {
        let d = cwd.as_ref().filter(|s| !s.is_empty()).map(std::path::Path::new);
        spawn_error(&format!("«{program}»"), d, &e)
    })?;

    if let Some(out) = child.stdout.take() {
        let a = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().flatten() {
                let _ = a.emit("terminal:line", line);
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let a = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().flatten() {
                let _ = a.emit("terminal:line", line);
            }
        });
    }
    let a = app.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
        let _ = a.emit("terminal:done", code);
    });

    Ok(())
}

/// Document paths handed to us on the command line.
///
/// The bundle registers `.pltx` as a file type, so double-clicking a document
/// launches the app with its path in argv. Nothing read it, which meant the
/// association opened Pyx on an empty, untitled document instead of the file
/// the user asked for.
fn documents_in(args: impl IntoIterator<Item = String>) -> Vec<String> {
    args.into_iter()
        .skip(1) // argv[0] is the executable
        .filter(|a| !a.starts_with('-'))
        .filter(|a| {
            let low = a.to_lowercase();
            low.ends_with(".pltx") || low.ends_with(".tex") || low.ends_with(".txt")
        })
        .filter(|a| std::path::Path::new(a).exists())
        .collect()
}

/// Hand a list of documents to the frontend, once it is listening.
fn emit_open(app: &tauri::AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let app = app.clone();
    // The webview may still be booting when a cold start delivers argv; the
    // frontend replays whatever arrived before it subscribed via `take_pending_open`.
    if let Ok(mut g) = pending_open().lock() {
        g.extend(paths.clone());
    }
    let _ = app.emit("app:open-files", paths);
}

static PENDING_OPEN: std::sync::OnceLock<std::sync::Mutex<Vec<String>>> =
    std::sync::OnceLock::new();
fn pending_open() -> &'static std::sync::Mutex<Vec<String>> {
    PENDING_OPEN.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

/// Documents that arrived before the frontend was ready to hear about them.
#[tauri::command]
fn take_pending_open() -> Vec<String> {
    pending_open()
        .lock()
        .map(|mut g| std::mem::take(&mut *g))
        .unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch (double-clicking another .pltx) must open that
        // document in the RUNNING window, not start a second copy of the app
        // with its own Python kernel.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            emit_open(app, documents_in(argv));
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(KernelState::default())
        .setup(|app| {
            // Cold start: the document the OS launched us with.
            emit_open(&app.handle(), documents_in(std::env::args()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect_env,
            compile_latex,
            build_dir,
            copy_file,
            synctex_edit,
            synctex_view,
            pltx_read,
            pltx_write,
            list_fonts,
            read_file_bytes,
            write_text,
            write_bytes,
            path_exists,
            read_dir,
            file_stamps,
            kernel_start,
            kernel_exec,
            kernel_reset,
            kernel_shutdown,
            kernel_set_python,
            kernel_interrupt,
            list_pythons,
            reveal_in_explorer,
            open_external,
            open_viewer_window,
            rename_path,
            remove_path,
            create_file,
            create_dir,
            run_command,
            take_pending_open,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                match window.label() {
                    // The kernel dies with the MAIN window only — closing the
                    // auxiliary PDF viewer must never kill the interpreter
                    // (it used to: this handler ran for EVERY window).
                    "main" => {
                        if let Some(state) = window.try_state::<KernelState>() {
                            let _ = kernel::shutdown(&state.handle());
                        }
                        if let Some(v) = window.app_handle().get_webview_window("pdf-viewer") {
                            let _ = v.close();
                        }
                    }
                    // Tell the main window so it can bring its own pane back.
                    "pdf-viewer" => {
                        let _ = window.app_handle().emit("viewer:closed", ());
                    }
                    _ => {}
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Pyx");
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    /// The frontend sends `encodeURIComponent(path)`: accents, spaces and a
    /// Windows drive must come back exactly, and a stray `%` must survive.
    #[test]
    fn percent_decode_round_trips_encode_uri_component() {
        assert_eq!(
            percent_decode("E%3A%5C1.%20ULL%5C_Pre%C3%A1mbulo.pltx"),
            r"E:\1. ULL\_Preámbulo.pltx"
        );
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%zzb"), "a%zzb");
        assert_eq!(percent_decode(""), "");
    }

    /// QAFUN-5 · a working directory past MAX_PATH used to reach the log as
    /// "os error 267" and explain nothing. The message has to name the cause,
    /// the limit and the folder, and it must not swallow ordinary failures.
    #[cfg(windows)]
    #[test]
    fn spawn_error_explains_a_too_long_working_directory() {
        use std::io::{Error, ErrorKind};
        use std::path::Path;

        let dir = Path::new(r"C:\a\very\deep\folder");
        let long = Error::from_raw_os_error(267);
        let msg = super::spawn_error("xelatex", Some(dir), &long);
        assert!(msg.contains("260"), "{msg}");
        assert!(msg.contains("xelatex"), "{msg}");
        assert!(msg.contains(r"C:\a\very\deep\folder"), "{msg}");
        assert!(!msg.contains("267"), "the raw code must not be the message: {msg}");

        // Anything else keeps the engine's own words.
        let other = Error::new(ErrorKind::NotFound, "no such file");
        let msg = super::spawn_error("xelatex", Some(dir), &other);
        assert!(msg.contains("no such file"), "{msg}");
        assert!(!msg.contains("260"), "{msg}");
    }
}
