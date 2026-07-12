mod kernel;
mod latex;
mod pltx;

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
    engine: String,
    passes: u32,
    jobname: Option<String>,
) -> Result<latex::CompileResult, String> {
    tauri::async_runtime::spawn_blocking(move || latex::compile(&path, &engine, passes, jobname))
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
    tauri::async_runtime::spawn_blocking(move || {
        // A clean-folder .pltx keeps its .synctex.gz inside the zip — extract it
        // next to the PDF on demand so inverse search still works.
        pltx::ensure_synctex_for_pdf(&pdf);
        latex::synctex_edit(&pdf, page, x, y)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open a `.pltx` container (ZIP). Returns `{is_zip, source}`; when it is a zip
/// the bundled build artifacts are extracted next to it. Legacy plain-text
/// `.pltx` reports `is_zip=false` (the JS side then decodes it as text).
#[tauri::command]
async fn pltx_read(path: String) -> Result<pltx::PltxRead, String> {
    tauri::async_runtime::spawn_blocking(move || pltx::read(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Save a `.pltx` container: pack source + loose build artifacts into the zip
/// (PDF excluded) and clean the loose files from the folder.
#[tauri::command]
async fn pltx_write(path: String, source: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pltx::write(&path, &source))
        .await
        .map_err(|e| e.to_string())?
}

/// Read a file's raw bytes. Used to load the compiled PDF into PDF.js without
/// the plugin-fs scope restrictions (the PDF can live in any folder).
#[tauri::command]
async fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&path).map_err(|e| format!("No se pudo leer {path}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
struct DirItem {
    name: String,
    path: String,
    is_dir: bool,
}

/// List a directory's entries (folders first, then files, alphabetical). Used
/// by the side panel's "Archivos" view to browse the document's folder.
#[tauri::command]
fn read_dir(path: String) -> Result<Vec<DirItem>, String> {
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

/// Interrupt a running cell (Jupyter-style): kill the kernel; the next request
/// respawns a fresh one.
#[tauri::command]
async fn kernel_interrupt() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(kernel::interrupt)
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

/// File-explorer operations (side panel): rename / delete / create.
#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    std::fs::rename(&from, &to).map_err(|e| format!("No se pudo renombrar: {e}"))
}

#[tauri::command]
fn remove_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| format!("No se pudo eliminar la carpeta: {e}"))
    } else {
        std::fs::remove_file(p).map_err(|e| format!("No se pudo eliminar el archivo: {e}"))
    }
}

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    if std::path::Path::new(&path).exists() {
        return Err("Ya existe un archivo con ese nombre.".into());
    }
    std::fs::write(&path, "").map_err(|e| format!("No se pudo crear el archivo: {e}"))
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("No se pudo crear la carpeta: {e}"))
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
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
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
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
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

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("No se pudo ejecutar «{program}»: {e}"))?;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(KernelState::default())
        .invoke_handler(tauri::generate_handler![
            detect_env,
            compile_latex,
            synctex_edit,
            pltx_read,
            pltx_write,
            list_fonts,
            read_file_bytes,
            read_dir,
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
        .expect("error while running Calc");
}
