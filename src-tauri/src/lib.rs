mod kernel;
mod latex;
mod pltx;
mod runtime;
mod synctex;
mod update;
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
#[allow(clippy::too_many_arguments)]
async fn compile_latex(
    path: String,
    project_dir: String,
    engine: String,
    passes: u32,
    jobname: Option<String>,
    search_dirs: Option<Vec<String>>,
    clean: Option<bool>,
    warm: Option<bool>,
    prewarm: Option<bool>,
    gen: Option<u64>,
    fast_pdf: Option<bool>,
) -> Result<latex::CompileResult, String> {
    // Absent = fast: what every caller that predates the option gets.
    latex::set_fast_pdf(fast_pdf.unwrap_or(true));
    let (res, next) = tauri::async_runtime::spawn_blocking(move || {
        let opts = latex::CompileOpts {
            jobname,
            search_dirs: search_dirs.unwrap_or_default(),
            clean_first: clean.unwrap_or(false),
            use_warm: warm.unwrap_or(false),
            // Absent = as before this argument existed: follows `warm`.
            prewarm: if prewarm.or(warm).unwrap_or(false) { latex::Prewarm::Later } else { latex::Prewarm::No },
            gen: gen.unwrap_or(0),
        };
        latex::compile_with(&path, &project_dir, &engine, passes, opts)
    })
    .await
    .map_err(|e| e.to_string())??;
    // The next compile's engine starts once this result is on its way to the
    // window, not before (latex.rs, PrewarmJob).
    if let Some(job) = next {
        job.start_later();
    }
    Ok(res)
}

/// ChkTeX style warnings for the text on screen (opt-in, latex-lint-ext.js).
#[tauri::command]
async fn chktex_lint(text: String) -> Result<Vec<latex::ChkHit>, String> {
    tauri::async_runtime::spawn_blocking(move || latex::chktex(&text))
        .await
        .map_err(|e| e.to_string())?
}

/// The latest release on GitHub, and the installer for this system.
#[tauri::command]
async fn update_check() -> Result<update::UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(update::check)
        .await
        .map_err(|e| e.to_string())?
}

/// Download the installer and verify it against the published SHA-256. Pyx
/// stays open: nothing is run until `update_install`.
#[tauri::command]
async fn update_download(asset: update::Asset) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || update::download(asset))
        .await
        .map_err(|e| e.to_string())?
}

/// Start the installer `update_download` verified, then close Pyx (the
/// installer replaces it and opens the new version). `app.exit` does not go
/// through the window's close request, so the window asks about unsaved
/// documents itself, right before calling this — after the download, not
/// before it, because the user keeps working while it runs.
#[tauri::command]
async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(update::launch)
        .await
        .map_err(|e| e.to_string())??;
    app.exit(0);
    Ok(())
}

/// Stop the LaTeX run in flight (and the PDF driver it started).
///
/// `async`: a synchronous command runs on the UI thread, and stopping a
/// compile can mean running `taskkill` and waiting for it — with the window
/// frozen meanwhile, on the one click whose whole point is to get it back.
#[tauri::command]
async fn compile_cancel() -> bool {
    tauri::async_runtime::spawn_blocking(latex::cancel).await.unwrap_or(false)
}

/// The bytes of a compiled PDF, for the viewers.
///
/// Read from the copy made when the compile ended (latex.rs, "A PDF nobody is
/// writing"), never from the file the engine may be rewriting at this very
/// moment — the next compile starts as soon as the last one ends, while the
/// viewer is still loading. For any other PDF this is `read_file_bytes`.
#[tauri::command]
async fn read_pdf(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let src = latex::pdf_source(&path);
        std::fs::read(&src).map_err(|e| format!("No se pudo leer {path}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Open a compiled PDF in the system's PDF application — a COPY of it, kept up
/// to date after every compile. Handing over the engine's own file let a
/// reader that locks what it shows (Acrobat) block every later compile.
#[tauri::command]
async fn open_pdf_external(path: String) -> Result<(), String> {
    let copy = tauri::async_runtime::spawn_blocking(move || latex::external_pdf(&path))
        .await
        .map_err(|e| e.to_string())??;
    open_external(copy)
}

/// Copy a file. Used to export the compiled PDF out of the project's working
/// directory, which is the only way it leaves: the build output no longer sits
/// next to the document, so "save a copy" has to be an explicit action.
#[tauri::command]
async fn copy_file(from: String, to: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // A compiled PDF is exported from the copy made when its compile ended
        // (latex.rs): the engine's own file may be half-written by the next.
        let src = if from.to_ascii_lowercase().ends_with(".pdf") {
            latex::pdf_source(&from)
        } else {
            std::path::PathBuf::from(&from)
        };
        std::fs::copy(&src, &to)
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
        write_atomic(std::path::Path::new(&path), content.as_bytes())
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
        write_atomic(std::path::Path::new(&path), &bytes)
            .map_err(|e| format!("No se pudo escribir {path}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Replace a file's contents so that it is never seen half-written.
///
/// `std::fs::write` truncates the file and then writes it. A crash, a power
/// cut or a full disk in between left the author's `.tex` empty or cut short —
/// and the compiler writes the source on compile, so that window opened often.
/// Here the bytes go to a temporary file beside the target, are flushed to
/// disk, and only then take its place with a rename, which the OS performs as
/// one step: the file is either the old version or the new one.
///
/// Falls back to a plain write when that cannot work: the target is a symlink
/// (a rename would replace the link with a file), or the rename is refused
/// (on Windows, while another program holds the file open without sharing
/// delete access — an antivirus scan, a sync client).
pub(crate) fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    // One writer per file at a time. Two at once on the same path (Ctrl+S
    // while the compiler saves that source) can make Windows refuse one of
    // the renames, and the plain-write fallback below is exactly the
    // non-atomic write this function exists to avoid — two of those
    // interleaving leave a mix of both versions.
    let _one_writer = write_stripe(path).lock().unwrap_or_else(|e| e.into_inner());
    let is_link = std::fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(false);
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return std::fs::write(path, bytes);
    };
    if is_link {
        return std::fs::write(path, bytes);
    }
    // A read-only file is not writable, and the plain write says so with the
    // system's own error. Going on would create a temporary that inherits the
    // read-only bit below — one that then cannot replace the target on
    // Windows and may not even be removable, left as litter beside the
    // document on every attempt — or, elsewhere, would quietly replace a
    // file the user had protected.
    if std::fs::metadata(path).map(|m| m.permissions().readonly()).unwrap_or(false) {
        return std::fs::write(path, bytes);
    }
    let tmp = atomic_tmp_path(dir, name);
    let written = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        // Keep the original's permissions (an executable script, a read-only
        // group bit): the new file would otherwise get the defaults.
        if let Ok(md) = std::fs::metadata(path) {
            let _ = std::fs::set_permissions(&tmp, md.permissions());
        }
        Ok::<(), std::io::Error>(())
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
        // No room for a second copy, a folder that refuses new files…: the
        // plain write still has a chance, and reports its own error.
        return std::fs::write(path, bytes);
    }
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(_) => {
            let _ = std::fs::remove_file(&tmp);
            std::fs::write(path, bytes)
        }
    }
}

/// The lock that serializes writes to `path`: one of a few, picked by the
/// path's hash (compared without case, as Windows names files), so the same
/// file always gets the same lock and unrelated files almost never wait for
/// each other.
fn write_stripe(path: &std::path::Path) -> &'static std::sync::Mutex<()> {
    use std::hash::{Hash, Hasher};
    #[allow(clippy::declare_interior_mutable_const)]
    const UNLOCKED: std::sync::Mutex<()> = std::sync::Mutex::new(());
    static STRIPES: [std::sync::Mutex<()>; 16] = [UNLOCKED; 16];
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.to_string_lossy().to_lowercase().replace('\\', "/").hash(&mut h);
    &STRIPES[(h.finish() % 16) as usize]
}

/// The temporary file `write_atomic` writes before the rename: beside the
/// target, hidden, and UNIQUE per call.
///
/// It was named after the target and the process only, so two writes of the
/// same file at once — a save landing on the compiler's own write of that
/// source — shared one temporary: both truncated and filled the same file,
/// and whichever renamed first could put a mix of the two in place of the
/// document (the other then failed on a temporary that was already gone).
fn atomic_tmp_path(dir: &std::path::Path, name: &std::ffi::OsStr) -> std::path::PathBuf {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    dir.join(format!(".{}.pyx-{}-{}.tmp", name.to_string_lossy(), std::process::id(), n))
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

/// The document source of several files at once (null where unreadable): a
/// `.pltx` gives only its `source.tex` (pltx::read_source), anything else its
/// text. One round trip for the whole batch — the root-document search reads
/// every candidate in a folder.
#[tauri::command]
async fn read_sources(paths: Vec<String>) -> Result<Vec<Option<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .map(|p| {
                let is_pltx = p.to_lowercase().ends_with(".pltx");
                let source = if is_pltx { pltx::read_source(p).ok()? } else { None };
                match source {
                    Some(s) => Some(s),
                    // UTF-8, or else the Windows code page the app's own
                    // reader falls back to (accents in a cp1252 file must
                    // survive: `\input{_Preámbulo}` has to match).
                    None => std::fs::read(p).ok().map(|b| match String::from_utf8(b) {
                        Ok(s) => s,
                        Err(e) => e.into_bytes().iter().map(|&c| c as char).collect(),
                    }),
                }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// One code cell of a Jupyter notebook: its id (nbformat ≥ 4.5) and source.
#[derive(serde::Serialize)]
struct NotebookCell {
    id: Option<String>,
    source: String,
}

#[derive(serde::Deserialize)]
struct NbFile {
    #[serde(default)]
    cells: Vec<NbCellIn>,
    #[serde(default)]
    nbformat: u32,
}

#[derive(serde::Deserialize)]
struct NbCellIn {
    #[serde(default)]
    cell_type: String,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    source: NbSource,
}

/// A cell's source: a list of lines (what Jupyter writes) or one string.
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum NbSource {
    Lines(Vec<String>),
    Text(String),
}

impl Default for NbSource {
    fn default() -> Self {
        NbSource::Text(String::new())
    }
}

/// The CODE cells of a Jupyter notebook (`\pynotebook{…}`), in order.
///
/// Parsed here so only the code crosses to the window: a notebook keeps its
/// outputs — figures as base64, long tables — and is often tens of MB of
/// which the code is a few KB. Outputs and metadata are skipped by the parser
/// without being built.
#[tauri::command]
async fn read_notebook(path: String) -> Result<Vec<NotebookCell>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&path).map_err(|e| format!("No se pudo leer {path}: {e}"))?;
        notebook_code_cells(&bytes, &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn notebook_code_cells(bytes: &[u8], path: &str) -> Result<Vec<NotebookCell>, String> {
    let nb: NbFile = serde_json::from_slice(bytes)
        .map_err(|e| format!("{path} no es un cuaderno de Jupyter válido: {e}"))?;
    if nb.nbformat > 0 && nb.nbformat < 4 {
        return Err(format!(
            "{path} usa el formato antiguo de Jupyter (v{}): ábrelo y guárdalo con Jupyter actual.",
            nb.nbformat
        ));
    }
    Ok(nb
        .cells
        .into_iter()
        .filter(|c| c.cell_type == "code")
        .map(|c| NotebookCell {
            id: c.id,
            source: match c.source {
                NbSource::Lines(l) => l.concat(),
                NbSource::Text(t) => t,
            },
        })
        .collect())
}

/// Decode a text file the way the editor opens one (js/core/encoding.js):
/// UTF-8 with its BOM dropped, and otherwise Windows-1252.
///
/// The project search read everything with `from_utf8_lossy`, which turns
/// each accent of a Latin-1 chapter into U+FFFD: the search could not find
/// "sección" in it, and the text it showed was not the text of the file.
fn decode_text(bytes: Vec<u8>) -> String {
    match String::from_utf8(bytes) {
        Ok(s) => match s.strip_prefix('\u{feff}') {
            Some(rest) => rest.to_string(),
            None => s,
        },
        Err(e) => e.into_bytes().iter().map(|&b| cp1252(b)).collect(),
    }
}

/// One Windows-1252 byte as the WHATWG decoder maps it (0x80–0x9F are not
/// Latin-1: 0x80 is the euro sign, 0x93/0x94 the curly quotes…).
fn cp1252(b: u8) -> char {
    const HIGH: [u16; 32] = [
        0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160,
        0x2039, 0x0152, 0x008D, 0x017D, 0x008F, 0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022,
        0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
    ];
    match b {
        0x80..=0x9F => char::from_u32(HIGH[(b - 0x80) as usize] as u32).unwrap_or('\u{fffd}'),
        _ => b as char,
    }
}

/// One searchable file of a project: its path and its text.
#[derive(serde::Serialize)]
struct ProjectText {
    path: String,
    text: String,
}

/// The text of every source file under `root`, for "Buscar en el proyecto".
///
/// LaTeX and Python sources, bibliographies, styles and notes; a .pltx gives
/// its document source. Hidden folders, build folders and anything larger
/// than 4 MB are skipped, and the walk stops at 3000 files and 12 levels, so a
/// project opened from the wrong folder (a whole home directory) cannot hang
/// the search.
#[tauri::command]
async fn project_texts(root: String) -> Result<Vec<ProjectText>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        const EXTS: &[&str] = &[
            "tex", "ltx", "sty", "cls", "bib", "bbx", "cbx", "dtx", "ins", "cfg", "py", "md", "txt",
        ];
        const SKIP: &[&str] = &["node_modules", "__pycache__", "target", "build", "dist"];
        let mut out = Vec::new();
        let mut stack = vec![(std::path::PathBuf::from(&root), 0usize)];
        let mut files = 0usize;
        while let Some((dir, depth)) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let Ok(meta) = entry.metadata() else { continue };
                let path = entry.path();
                if meta.is_dir() {
                    if depth < 12 && !SKIP.contains(&name.as_str()) && !name.ends_with("_calc_figs") {
                        stack.push((path, depth + 1));
                    }
                    continue;
                }
                if meta.len() > 4 * 1024 * 1024 {
                    continue;
                }
                let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
                let p = path.to_string_lossy().to_string();
                let text = if ext == "pltx" {
                    // Only the source: the container's results and build
                    // artifacts are never inflated for a search.
                    match pltx::read_source(&p) {
                        Ok(Some(s)) => Some(s),
                        Ok(None) => std::fs::read(&path).ok().map(decode_text),
                        Err(_) => None,
                    }
                } else if EXTS.contains(&ext.as_str()) && !name.contains(".build.") {
                    std::fs::read(&path).ok().map(decode_text)
                } else {
                    None
                };
                if let Some(text) = text {
                    out.push(ProjectText { path: p, text });
                    files += 1;
                    if files >= 3000 {
                        return Ok(out);
                    }
                }
            }
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Progress of a set-up, as `setup:line` events for the window.
fn setup_say(app: &tauri::AppHandle) -> impl Fn(String) + Sync {
    let app = app.clone();
    move |line: String| {
        let _ = app.emit("setup:line", line);
    }
}

/// What Pyx has set up by itself (runtime.rs): its Python environment, its
/// Tectonic, and where they live.
#[tauri::command]
fn runtime_info() -> runtime::RuntimeInfo {
    runtime::info()
}

/// Download Tectonic into Pyx's data folder (no LaTeX installed).
#[tauri::command]
async fn install_tectonic(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || runtime::install_tectonic(&setup_say(&app)))
        .await
        .map_err(|e| e.to_string())?
}

/// Create Pyx's own Python environment with the scientific stack (uv).
#[tauri::command]
async fn setup_python(app: tauri::AppHandle, packages: Option<Vec<String>>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || runtime::setup_python(&setup_say(&app), &packages.unwrap_or_default()))
        .await
        .map_err(|e| e.to_string())?
}

/// Is the formula recognizer (image -> LaTeX) installed?
#[tauri::command]
fn ocr_ready() -> bool {
    runtime::ocr_python().is_some()
}

/// Install the formula recognizer in its own environment (runtime.rs). Its
/// progress goes out as `setup:line` events, like the other installs.
#[tauri::command]
async fn setup_ocr(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || runtime::setup_ocr(&setup_say(&app)))
        .await
        .map_err(|e| e.to_string())?
}

/// The recognizer's script travels inside the binary, like the kernel.
const IMG2LATEX_PY: &str = include_str!("../python/img2latex.py");

/// The LaTeX of the formula in an image. The image arrives as the request
/// BODY (PNG/JPEG bytes: a screenshot pasted into the editor), is written to
/// a temporary file and read by the recognizer in its own process — so a
/// slow first run (it downloads its models once) or a crash never touches
/// the kernel the document computes in. Bounded in time: the process is
/// killed after four minutes.
#[tauri::command]
async fn image_to_latex(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("image_to_latex espera la imagen en el cuerpo de la petición".into());
    };
    if bytes.is_empty() || bytes.len() > 40 * 1024 * 1024 {
        return Err("La imagen está vacía o es demasiado grande.".into());
    }
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        use std::process::{Command, Stdio};
        let py = runtime::ocr_python().ok_or("El reconocedor de fórmulas no está instalado.")?;
        let dir = std::env::temp_dir().join(format!("pyx-ocr-{}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let img = dir.join(format!("{stamp}.png"));
        std::fs::write(&img, &bytes).map_err(|e| e.to_string())?;
        let mut cmd = Command::new(&py);
        // -I: isolated — no PYTHON* variables, no user site, nothing from the
        // folder it runs in. UTF-8 so the JSON line is read as written.
        // The script travels as `-c` text (sys.argv[1] is still the image): there
        // is no file on disk to be replaced between writing it and running it.
        cmd.args(["-I", "-X", "utf8", "-c", IMG2LATEX_PY]).arg(&img)
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        quiet(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| format!("No se pudo iniciar el reconocedor: {e}"))?;
        // Drain both pipes on their own threads: a child that fills one while
        // we wait on the other would never finish.
        let mut so = child.stdout.take();
        let mut se = child.stderr.take();
        let t_out = std::thread::spawn(move || { let mut s = String::new(); if let Some(o) = so.as_mut() { let _ = o.read_to_string(&mut s); } s });
        let t_err = std::thread::spawn(move || { let mut s = String::new(); if let Some(e) = se.as_mut() { let _ = e.read_to_string(&mut s); } s });
        let started = std::time::Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(st)) => break Some(st),
                Ok(None) if started.elapsed() > std::time::Duration::from_secs(240) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(40)),
                Err(e) => { let _ = std::fs::remove_file(&img); return Err(e.to_string()); }
            }
        };
        let out = t_out.join().unwrap_or_default();
        let err = t_err.join().unwrap_or_default();
        let _ = std::fs::remove_file(&img);
        if status.is_none() {
            return Err("El reconocedor tardó demasiado y se ha detenido (¿sin conexión para descargar sus modelos la primera vez?).".into());
        }
        let line = out.lines().rev().find(|l| l.trim_start().starts_with('{')).unwrap_or("");
        let v: serde_json::Value = serde_json::from_str(line).map_err(|_| {
            let tail: Vec<&str> = err.lines().rev().take(3).collect();
            format!("El reconocedor no respondió. {}", tail.into_iter().rev().collect::<Vec<_>>().join(" "))
        })?;
        if v["ok"].as_bool() == Some(true) {
            Ok(v["latex"].as_str().unwrap_or("").to_string())
        } else {
            Err(v["error"].as_str().unwrap_or("no se pudo reconocer la imagen").to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Install packages into the interpreter the kernel runs.
#[tauri::command]
async fn install_packages(app: tauri::AppHandle, python: String, packages: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || runtime::install_packages(&setup_say(&app), &python, &packages))
        .await
        .map_err(|e| e.to_string())?
}

/// Grammar check with a LanguageTool server (grammar.js): `server` is its base
/// URL. Through the system's curl, like the other downloads; the text goes on
/// stdin, never on a command line.
#[tauri::command]
async fn languagetool_check(server: String, language: String, text: String, disabled: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let base = server.trim().trim_end_matches('/');
        if !(base.starts_with("http://") || base.starts_with("https://")) {
            return Err("La dirección del servidor debe empezar por http:// o https://".into());
        }
        let url = if base.ends_with("/v2/check") { base.to_string() } else { format!("{base}/v2/check") };
        let mut cmd = Command::new("curl");
        cmd.args(["-s", "--max-time", "20", "-X", "POST", &url,
                  "--data-urlencode", &format!("language={language}"),
                  "--data-urlencode", &format!("disabledRules={disabled}"),
                  "--data-urlencode", "text@-"])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        quiet(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| format!("No se pudo ejecutar curl: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes());
        }
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err("LanguageTool no respondió.".into());
        }
        serde_json::from_slice(&out.stdout).map_err(|_| "Respuesta de LanguageTool no válida.".to_string())
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
) -> Result<tauri::ipc::Response, String> {
    let k = state.handle();
    // The kernel's response frame crosses to the window as RAW BYTES (an
    // ArrayBuffer there, parsed once by platform.js) — never re-parsed and
    // re-serialized on the way, which doubled the cost of every big result.
    let raw = tauri::async_runtime::spawn_blocking(move || kernel::exec_raw(&k, req))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(raw.into_bytes()))
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
        rename_guarded(std::path::Path::new(&from), std::path::Path::new(&to))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Rename a file or folder, refusing to land on something that exists.
///
/// `std::fs::rename` REPLACES the destination: renaming `borrador.tex` to the
/// name of the chapter next to it destroyed that chapter, with no question
/// and nothing in the recycle bin. The one destination that may exist is the
/// source itself under another spelling — `informe.tex` → `Informe.tex` on a
/// case-insensitive volume — which is a rename of the same file, not a clash.
fn rename_guarded(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    if std::fs::symlink_metadata(from).is_err() {
        return Err("No se pudo renombrar: el archivo ya no existe.".into());
    }
    if std::fs::symlink_metadata(to).is_ok() {
        // Same file on disk? Canonical paths carry the real spelling, so two
        // names that differ only in case resolve to one path there.
        let same = match (std::fs::canonicalize(from), std::fs::canonicalize(to)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        };
        if !same {
            let name = to.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            return Err(format!("Ya existe «{name}» en esta carpeta. Elige otro nombre."));
        }
    }
    std::fs::rename(from, to).map_err(|e| format!("No se pudo renombrar: {e}"))
}

/// Send a file or folder to the system's recycle bin (Windows).
///
/// Deleting from the side panel was permanent — `remove_dir_all` on a folder
/// picked by mistake, with no way back. The shell's own "delete to the
/// recycle bin" is reached through the .NET wrapper PowerShell ships with, so
/// no extra dependency is needed; the path travels in an environment
/// variable, never inside the script text. Where there is no recycle bin for
/// the volume (most network shares) the shell deletes for good.
///
/// Anything that goes wrong is an error and NOTHING is deleted: the window
/// then asks whether to delete permanently (`remove_path`).
#[tauri::command]
async fn trash_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || move_to_recycle_bin(std::path::Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(target_os = "windows")]
fn move_to_recycle_bin(path: &std::path::Path) -> Result<(), String> {
    if std::fs::symlink_metadata(path).is_err() {
        return Err("El archivo ya no existe.".into());
    }
    let script = "$ErrorActionPreference = 'Stop'; \
        Add-Type -AssemblyName Microsoft.VisualBasic; \
        $p = $env:PYX_TRASH_PATH; \
        $ui = [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs; \
        $bin = [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin; \
        if (Test-Path -LiteralPath $p -PathType Container) { \
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, $ui, $bin) \
        } else { \
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, $ui, $bin) \
        }";
    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("PYX_TRASH_PATH", path);
    quiet(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("No se pudo usar la papelera de reciclaje: {e}"))?;
    if !out.status.success() || std::fs::symlink_metadata(path).is_ok() {
        let why = String::from_utf8_lossy(&out.stderr);
        let why = why.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
        return Err(format!("No se pudo enviar a la papelera de reciclaje. {why}").trim().to_string());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn move_to_recycle_bin(_path: &std::path::Path) -> Result<(), String> {
    Err("En este sistema Pyx no usa la papelera.".into())
}

/// Delete a file or folder PERMANENTLY (see `trash_path` for the recycle bin).
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

/// Start Explorer with its argument written VERBATIM, the path in quotes.
///
/// Explorer splits its command line at COMMAS, and Rust only quotes an
/// argument that contains a space: `C:\Obras\Puente,v2\informe.pdf` reached
/// Explorer bare, was cut at the comma, and "Mostrar en el Explorador" opened
/// the Documents folder instead (and "abrir" did nothing useful). Quoted, a
/// comma is part of the path. (A Windows path cannot contain a quote.)
#[cfg(target_os = "windows")]
fn explorer(raw: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("explorer")
        .raw_arg(raw)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Open a file in its default application as a separate window (the PDF viewer's
/// "floating window" tool opens the compiled PDF this way).
#[tauri::command]
fn open_external(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // A link (https://…, mailto:…) goes as it is; a file path with the
        // backslashes Explorer expects.
        let is_url = path.contains("://") || path.to_ascii_lowercase().starts_with("mailto:");
        let target = if is_url { path.clone() } else { path.replace('/', "\\") };
        explorer(format!("\"{}\"", target.replace('"', "")))?;
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

/// Chromium switches of every window. Tauri's own defaults (the first one),
/// plus smooth scrolling off: the PDF viewer scrolls natively now — on the
/// compositor, never waiting for the main thread — and a wheel notch must
/// move the page at once, the way a native reader does, not glide to it.
/// Keep in sync with `additionalBrowserArgs` in tauri.conf.json.
const BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-smooth-scrolling";

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
        // The SAME browser arguments as the main window (tauri.conf.json):
        // WebView2 shares one environment per user-data folder and refuses a
        // second window that asks for different ones.
        .additional_browser_args(BROWSER_ARGS)
        .inner_size(920.0, 1000.0)
        .min_inner_size(420.0, 480.0)
        .decorations(true)
        // Serialized, not pasted: the path is a JS string literal here, and a
        // quote or backslash in it must not end the literal.
        .initialization_script(&format!(
            "window.__PYX_VIEWER__={{pdf:{}}};",
            serde_json::to_string(&path).map_err(|e| e.to_string())?
        ))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Reveal a file in the OS file manager (used to open the compiled PDF folder).
#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Explorer only selects a path written with backslashes.
        explorer(format!("/select,\"{}\"", path.replace('"', "").replace('/', "\\")))?;
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
///
/// `python` is the interpreter the kernel is running, as the window knows it
/// (the one chosen in Configuración, or the detected one). The terminal used
/// to detect its own, so with a chosen interpreter `pip install` put the
/// package into a DIFFERENT Python than the cells import from — the install
/// "worked" and the cell still said the module was missing.
fn build_invocation(input: &str, python: Option<&str>) -> (String, Vec<String>) {
    let parts: Vec<String> = input.split_whitespace().map(|s| s.to_string()).collect();
    let first = parts.first().map(|s| s.as_str()).unwrap_or("");
    let interpreter = || {
        python
            .filter(|p| !p.trim().is_empty() && std::path::Path::new(p).exists())
            .map(str::to_string)
            .or_else(kernel::find_python)
    };
    if matches!(first, "pip" | "pip3") {
        if let Some(py) = interpreter() {
            let mut args = vec!["-m".to_string(), "pip".to_string()];
            args.extend(parts.iter().skip(1).cloned());
            return (py, args);
        }
    } else if matches!(first, "python" | "python3" | "py") {
        if let Some(py) = interpreter() {
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

/// PID of the terminal command in flight, for `terminal_stop`. One at a time:
/// the panel does not take another command while one runs.
static TERMINAL_PID: std::sync::Mutex<Option<u32>> = std::sync::Mutex::new(None);

/// Run a command for the in-app terminal, streaming stdout/stderr to the UI as
/// `terminal:line` events and the exit code as `terminal:done`.
///
/// `async` + `spawn_blocking` like every other heavy command: this one was
/// synchronous, i.e. on the MAIN thread, and resolving `pip`/`python` probes
/// the interpreters on the machine by running them — the whole window froze
/// for as long as that took, before the command had even started.
#[tauri::command]
async fn run_command(
    app: tauri::AppHandle,
    command: String,
    cwd: Option<String>,
    python: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || start_terminal_command(app, command, cwd, python))
        .await
        .map_err(|e| e.to_string())?
}

/// Stop the terminal command in flight, and everything it started (`cmd /C`
/// is only the parent of what the user actually ran). The waiting thread
/// then reports its exit through `terminal:done` as usual.
#[tauri::command]
async fn terminal_stop() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let pid = TERMINAL_PID.lock().ok().and_then(|g| *g);
        let Some(pid) = pid else { return false };
        #[cfg(windows)]
        {
            let mut c = std::process::Command::new("taskkill");
            c.args(["/PID", &pid.to_string(), "/F", "/T"]);
            quiet(&mut c);
            let _ = c.status();
        }
        #[cfg(not(windows))]
        {
            let _ = std::process::Command::new("kill").arg("-9").arg(pid.to_string()).status();
        }
        true
    })
    .await
    .map_err(|e| e.to_string())
}

fn start_terminal_command(
    app: tauri::AppHandle,
    command: String,
    cwd: Option<String>,
    python: Option<String>,
) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    let input = command.trim().to_string();
    if input.is_empty() {
        let _ = app.emit("terminal:done", 0);
        return Ok(());
    }

    let (program, args) = build_invocation(&input, python.as_deref());
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
            // Bytes, not `lines()`: a line in the console's code page (not
            // UTF-8, as Windows tools print accents) was dropped; and an I/O
            // error ends the loop instead of spinning on it.
            for line in BufReader::new(out).split(b'\n').map_while(Result::ok) {
                let text = String::from_utf8_lossy(&line);
                let _ = a.emit("terminal:line", text.trim_end_matches('\r').to_string());
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let a = app.clone();
        std::thread::spawn(move || {
            // Bytes, not `lines()`: a line in the console's code page (not
            // UTF-8, as Windows tools print accents) was dropped; and an I/O
            // error ends the loop instead of spinning on it.
            for line in BufReader::new(err).split(b'\n').map_while(Result::ok) {
                let text = String::from_utf8_lossy(&line);
                let _ = a.emit("terminal:line", text.trim_end_matches('\r').to_string());
            }
        });
    }
    let pid = child.id();
    if let Ok(mut g) = TERMINAL_PID.lock() {
        *g = Some(pid);
    }
    let a = app.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
        // Only this command's own entry: a later one may already be running.
        if let Ok(mut g) = TERMINAL_PID.lock() {
            if *g == Some(pid) {
                *g = None;
            }
        }
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
    //
    // Only UNTIL it has asked: from then on it is listening, and the event
    // below is the delivery. The list kept growing with every document
    // opened from Explorer for the rest of the session, and nobody read it.
    if !OPEN_TAKEN.load(std::sync::atomic::Ordering::SeqCst) {
        if let Ok(mut g) = pending_open().lock() {
            g.extend(paths.clone());
        }
    }
    let _ = app.emit("app:open-files", paths);
}

/// Set once the frontend has collected the documents queued before it was up.
static OPEN_TAKEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

static PENDING_OPEN: std::sync::OnceLock<std::sync::Mutex<Vec<String>>> =
    std::sync::OnceLock::new();
fn pending_open() -> &'static std::sync::Mutex<Vec<String>> {
    PENDING_OPEN.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

/// Documents that arrived before the frontend was ready to hear about them.
#[tauri::command]
fn take_pending_open() -> Vec<String> {
    OPEN_TAKEN.store(true, std::sync::atomic::Ordering::SeqCst);
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
            compile_cancel,
            read_pdf,
            open_pdf_external,
            chktex_lint,
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
            project_texts,
            languagetool_check,
            runtime_info,
            install_tectonic,
            setup_python,
            install_packages,
            ocr_ready,
            setup_ocr,
            image_to_latex,
            file_stamps,
            read_sources,
            read_notebook,
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
            trash_path,
            create_file,
            create_dir,
            run_command,
            terminal_stop,
            take_pending_open,
            update_check,
            update_download,
            update_install,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                match window.label() {
                    // The kernel dies with the MAIN window only — closing the
                    // auxiliary PDF viewer must never kill the interpreter
                    // (it used to: this handler ran for EVERY window).
                    "main" => {
                        // The engine paused for the next compile goes too.
                        latex::drop_warm();
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

    /// A notebook gives its code cells, in order and joined as Jupyter splits
    /// them into lines — never its markdown, its outputs or its metadata.
    #[test]
    fn notebook_gives_only_its_code_cells() {
        let nb = r##"{
          "nbformat": 4, "nbformat_minor": 5, "metadata": {"kernelspec": {"name": "python3"}},
          "cells": [
            {"cell_type": "markdown", "id": "m1", "source": ["# Título"]},
            {"cell_type": "code", "id": "a1", "source": ["import numpy as np\n", "L = 6.0"],
             "outputs": [{"output_type": "display_data", "data": {"image/png": "iVBORw0KGgo="}}],
             "execution_count": 1, "metadata": {}},
            {"cell_type": "code", "source": "q = L * 2", "outputs": []}
          ]
        }"##;
        let cells = super::notebook_code_cells(nb.as_bytes(), "calculo.ipynb").unwrap();
        assert_eq!(cells.len(), 2);
        assert_eq!(cells[0].id.as_deref(), Some("a1"));
        assert_eq!(cells[0].source, "import numpy as np\nL = 6.0");
        assert_eq!(cells[1].id, None);
        assert_eq!(cells[1].source, "q = L * 2");
        assert!(super::notebook_code_cells(b"{\"nbformat\": 3, \"worksheets\": []}", "viejo.ipynb").is_err());
        assert!(super::notebook_code_cells(b"no es json", "roto.ipynb").is_err());
    }

    /// The new content replaces the old one, the permissions survive, and no
    /// temporary file is left beside the document.
    #[test]
    fn write_atomic_replaces_and_leaves_nothing_behind() {
        let dir = std::env::temp_dir().join(format!("pyx-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("doc.tex");
        std::fs::write(&f, "viejo contenido, más largo que el nuevo").unwrap();
        super::write_atomic(&f, "nuevo".as_bytes()).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "nuevo");
        super::write_atomic(&dir.join("nuevo.tex"), b"x").unwrap();
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["doc.tex".to_string(), "nuevo.tex".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Renaming never lands on another file: the destination survives and the
    /// source stays where it was. A change of case only is the same file
    /// under a new spelling, and goes through.
    #[test]
    fn rename_refuses_an_existing_destination_but_allows_a_case_change() {
        let dir = std::env::temp_dir().join(format!("pyx-rename-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("borrador.tex");
        let b = dir.join("capitulo.tex");
        std::fs::write(&a, "borrador").unwrap();
        std::fs::write(&b, "capitulo").unwrap();

        let err = super::rename_guarded(&a, &b).unwrap_err();
        assert!(err.contains("capitulo.tex"), "{err}");
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "borrador");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "capitulo");

        // A free name: an ordinary rename.
        let c = dir.join("nuevo.tex");
        super::rename_guarded(&a, &c).unwrap();
        assert!(!a.exists());
        assert_eq!(std::fs::read_to_string(&c).unwrap(), "borrador");

        // Case only. On a case-insensitive volume the destination "exists"
        // (it is the source); on a case-sensitive one it is simply free.
        let upper = dir.join("Nuevo.tex");
        super::rename_guarded(&c, &upper).unwrap();
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(names.contains(&"Nuevo.tex".to_string()), "{names:?}");
        assert!(!names.contains(&"nuevo.tex".to_string()), "{names:?}");
        assert_eq!(std::fs::read_to_string(&upper).unwrap(), "borrador");

        // A folder onto an existing folder is refused too, and a source that
        // is gone says so.
        let d1 = dir.join("figs");
        let d2 = dir.join("datos");
        std::fs::create_dir_all(&d1).unwrap();
        std::fs::create_dir_all(&d2).unwrap();
        std::fs::write(d2.join("x.csv"), "1").unwrap();
        assert!(super::rename_guarded(&d1, &d2).is_err());
        assert!(d2.join("x.csv").exists());
        assert!(super::rename_guarded(&dir.join("no-existe.tex"), &dir.join("z.tex")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The search reads a Latin-1 / Windows-1252 file as the editor does, not
    /// as U+FFFD; UTF-8 stays UTF-8 and loses its BOM.
    #[test]
    fn decode_text_reads_utf8_and_windows_1252() {
        assert_eq!(super::decode_text("sección €".as_bytes().to_vec()), "sección €");
        assert_eq!(super::decode_text(b"\xEF\xBB\xBFhola".to_vec()), "hola");
        // "sección" + euro + curly quotes, in Windows-1252.
        assert_eq!(super::decode_text(b"secci\xF3n \x80 \x93a\x94".to_vec()), "sección € “a”");
        // The bytes the code page leaves undefined still decode to something
        // (and never panic).
        assert_eq!(super::decode_text(vec![0x81, 0xFF]).chars().count(), 2);
    }

    /// Two writes of one file at the same time never share a temporary: each
    /// call gets its own name, concurrent writers all succeed, the file ends
    /// up as exactly ONE of the versions, and nothing is left behind.
    #[test]
    fn write_atomic_uses_a_unique_temporary_per_call() {
        let dir = std::env::temp_dir().join(format!("pyx-atomic-uniq-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let name = std::ffi::OsStr::new("doc.tex");
        let a = super::atomic_tmp_path(&dir, name);
        let b = super::atomic_tmp_path(&dir, name);
        assert_ne!(a, b);
        assert_eq!(a.parent(), Some(dir.as_path()));
        assert!(a.file_name().unwrap().to_string_lossy().starts_with(".doc.tex.pyx-"));

        let f = dir.join("doc.tex");
        std::fs::write(&f, "inicial").unwrap();
        // Long, distinct contents: an interleaved write would show.
        let versions: Vec<String> = (0..8).map(|i| format!("{i}").repeat(200_000)).collect();
        let handles: Vec<_> = versions
            .iter()
            .cloned()
            .map(|v| {
                let f = f.clone();
                std::thread::spawn(move || super::write_atomic(&f, v.as_bytes()))
            })
            .collect();
        for h in handles {
            h.join().unwrap().unwrap();
        }
        let got = std::fs::read_to_string(&f).unwrap();
        assert!(versions.contains(&got), "the file is a mix of two writes");
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["doc.tex".to_string()], "temporaries left behind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The recycle bin really takes a file and a folder. Ignored by default:
    /// it leaves two small items in the machine's recycle bin on every run
    /// (`cargo test -- --ignored recycle_bin`).
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn recycle_bin_takes_files_and_folders() {
        let dir = std::env::temp_dir().join(format!("pyx-papelera-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("carpeta, con coma")).unwrap();
        let f = dir.join("prueba de Pyx, con coma.txt");
        std::fs::write(&f, "se puede borrar").unwrap();
        std::fs::write(dir.join("carpeta, con coma").join("dentro.txt"), "x").unwrap();
        super::move_to_recycle_bin(&f).unwrap();
        assert!(!f.exists());
        super::move_to_recycle_bin(&dir.join("carpeta, con coma")).unwrap();
        assert!(!dir.join("carpeta, con coma").exists());
        // Gone already: an error, not a panic.
        assert!(super::move_to_recycle_bin(&f).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A read-only document is refused with the system's error, keeps its
    /// content, and no temporary is left beside it.
    #[test]
    fn write_atomic_refuses_a_read_only_file_and_leaves_no_litter() {
        let dir = std::env::temp_dir().join(format!("pyx-atomic-ro-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("protegido.tex");
        std::fs::write(&f, "original").unwrap();
        let mut perm = std::fs::metadata(&f).unwrap().permissions();
        perm.set_readonly(true);
        std::fs::set_permissions(&f, perm).unwrap();

        let res = super::write_atomic(&f, b"nuevo");
        // (A privileged user on Unix can write a read-only file: then the
        // write simply succeeds, which is also what a plain write does.)
        if res.is_err() {
            assert_eq!(std::fs::read_to_string(&f).unwrap(), "original");
        }
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["protegido.tex".to_string()], "temporaries left behind");

        let mut perm = std::fs::metadata(&f).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        std::fs::set_permissions(&f, perm).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

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
