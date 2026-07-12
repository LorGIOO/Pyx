//! LaTeX compilation and toolchain detection.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Serialize)]
pub struct CompileResult {
    pub ok: bool,
    pub pdf_path: Option<String>,
    pub log: String,
    pub engine: String,
}

#[derive(Serialize)]
pub struct EnvInfo {
    pub python: Option<String>,
    pub latex: Option<String>,
    pub engines: Vec<String>,
}

fn runs(cmd: &str) -> bool {
    let mut c = Command::new(cmd);
    c.arg("--version").stdout(Stdio::null()).stderr(Stdio::null());
    crate::quiet(&mut c);
    c.status().map(|s| s.success()).unwrap_or(false)
}

/// Directories where a TeX engine binary commonly lives on Windows. GUI
/// processes don't always inherit the user PATH (where a per-user MiKTeX adds
/// itself), so we scan these as a fallback.
fn tex_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        dirs.push(PathBuf::from(&local).join(r"Programs\MiKTeX\miktex\bin\x64"));
    }
    if let Ok(up) = std::env::var("USERPROFILE") {
        dirs.push(PathBuf::from(&up).join(r"AppData\Local\Programs\MiKTeX\miktex\bin\x64"));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        dirs.push(PathBuf::from(&pf).join(r"MiKTeX\miktex\bin\x64"));
    }
    dirs.push(PathBuf::from(r"C:\Program Files\MiKTeX\miktex\bin\x64"));
    dirs.push(PathBuf::from(r"C:\Program Files (x86)\MiKTeX\miktex\bin\x64"));
    for year in ["2026", "2025", "2024", "2023"] {
        dirs.push(PathBuf::from(format!(r"C:\texlive\{year}\bin\windows")));
        dirs.push(PathBuf::from(format!(r"C:\texlive\{year}\bin\win32")));
    }
    dirs
}

/// Resolve a TeX engine to a runnable command: the bare name if it's on PATH,
/// otherwise a full path from a known install location. Returns None if absent.
pub fn resolve_engine(name: &str) -> Option<String> {
    if runs(name) {
        return Some(name.to_string());
    }
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    for dir in tex_dirs() {
        let p = dir.join(&exe);
        if p.exists() {
            return Some(p.to_string_lossy().to_string());
        }
    }
    None
}

fn engine_works(name: &str) -> bool {
    resolve_engine(name).is_some()
}

/// Report which interpreters/engines are available so the UI can show status
/// and disable actions that cannot run.
pub fn detect_env() -> EnvInfo {
    let python = crate::kernel::find_python();

    let mut engines = Vec::new();
    for e in ["xelatex", "pdflatex", "lualatex"] {
        if engine_works(e) {
            engines.push(e.to_string());
        }
    }
    let latex = engines.first().cloned();

    EnvInfo {
        python,
        latex,
        engines,
    }
}

#[derive(Serialize)]
pub struct SyncTexHit {
    pub input: String,
    pub line: u32,
    pub column: i32,
}

/// Inverse search (PDF position → source line) via the `synctex` CLI that
/// ships with MiKTeX/TeX Live. `x`/`y` are PDF points from the page's
/// top-left corner — the same coordinate system synctex reports.
pub fn synctex_edit(pdf: &str, page: u32, x: f64, y: f64) -> Result<SyncTexHit, String> {
    let cmd = resolve_engine("synctex")
        .ok_or("No se encontró «synctex» (instala MiKTeX o TeX Live).")?;
    let mut c = Command::new(&cmd);
    c.arg("edit")
        .arg("-o")
        .arg(format!("{page}:{x:.2}:{y:.2}:{pdf}"));
    crate::quiet(&mut c);
    let out = c
        .output()
        .map_err(|e| format!("No se pudo ejecutar synctex: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);

    let mut input: Option<String> = None;
    let mut line: Option<u32> = None;
    let mut column: i32 = -1;
    for l in text.lines() {
        if let Some(v) = l.strip_prefix("Input:") {
            if input.is_none() {
                input = Some(v.trim().to_string());
            }
        } else if let Some(v) = l.strip_prefix("Line:") {
            if line.is_none() {
                line = v.trim().parse().ok();
            }
        } else if let Some(v) = l.strip_prefix("Column:") {
            if column < 0 {
                column = v.trim().parse().unwrap_or(-1);
            }
        }
        if input.is_some() && line.is_some() {
            break;
        }
    }
    match (input, line) {
        (Some(i), Some(l)) => Ok(SyncTexHit { input: i, line: l, column }),
        _ => Err("SyncTeX no encontró esa posición (recompila el documento).".into()),
    }
}

/// Compile a `.tex` file with the chosen engine. Runs `passes` times so table
/// of contents / cross references can settle (1 is fastest, 2 resolves refs).
///
/// `jobname` (optional) sets the TeX `-jobname`, so a build file like
/// `doc.build.tex` can produce `doc.pdf`. The output PDF is `<jobname>.pdf`
/// (or `<stem>.pdf` when no jobname is given).
pub fn compile(
    path: &str,
    engine: &str,
    passes: u32,
    jobname: Option<String>,
) -> Result<CompileResult, String> {
    let src = Path::new(path);
    if !src.exists() {
        return Err(format!("No existe el archivo: {path}"));
    }
    let dir = src
        .parent()
        .ok_or("El documento no tiene carpeta contenedora")?;
    let file = src
        .file_name()
        .ok_or("Nombre de archivo inválido")?
        .to_string_lossy()
        .to_string();

    let engine = match engine {
        "pdflatex" | "lualatex" | "xelatex" => engine,
        _ => "xelatex",
    };
    let engine_cmd = resolve_engine(engine).ok_or_else(|| {
        format!("No se encontró el motor «{engine}». Instala MiKTeX o TeX Live.")
    })?;

    let out_name = jobname
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| src.file_stem().unwrap_or_default().to_string_lossy().to_string());

    // Snapshot the PDF's mtime BEFORE compiling: success is "this run wrote a
    // PDF", never "a PDF from some earlier compile is still lying around".
    let pdf = dir.join(format!("{out_name}.pdf"));
    let mtime_of = |p: &Path| p.metadata().and_then(|m| m.modified()).ok();
    let pdf_mtime_before = mtime_of(&pdf);

    let passes = passes.clamp(1, 3);
    const MAX_PASSES: u32 = 3;
    let mut log = String::new();
    let mut clean = false;

    for i in 0..MAX_PASSES {
        let mut cmd = Command::new(&engine_cmd);
        // Like TeXstudio: NO -halt-on-error. In nonstopmode TeX recovers from
        // errors and still emits a PDF when it can; the problems stay visible
        // in the log panel. Halting on the first error made documents that
        // "work" in TeXstudio produce nothing here.
        cmd.current_dir(dir)
            .arg("-interaction=nonstopmode")
            .arg("-synctex=1");
        if let Some(j) = jobname.as_ref().filter(|s| !s.trim().is_empty()) {
            cmd.arg(format!("-jobname={j}"));
        }
        crate::quiet(&mut cmd);
        let output = cmd
            .arg(&file)
            .output()
            .map_err(|e| format!("No se pudo ejecutar {engine}: {e}"))?;

        log.push_str(&format!("===== Pasada {} ({}) =====\n", i + 1, engine));
        let pass_out = String::from_utf8_lossy(&output.stdout).to_string();
        log.push_str(&pass_out);
        let err = String::from_utf8_lossy(&output.stderr);
        if !err.trim().is_empty() {
            log.push_str(&err);
        }
        log.push('\n');
        // Exit status 0 = no TeX errors at all ("clean"). A nonzero status just
        // means errors were recovered — the pass still ran to completion, so
        // reference-settling reruns are still meaningful.
        clean = output.status.success();
        // Extra passes only when TeX actually asks for one: unsettled refs/TOC
        // ("Rerun to get…"), or a table-of-contents/list file that didn't exist
        // yet on this pass ("No file X.toc") — the next pass will pick it up.
        // Most compiles still finish in a single, fast pass.
        let missing_listing = pass_out.contains("No file ")
            && [".toc.", ".lof.", ".lot."]
                .iter()
                .any(|ext| pass_out.contains(ext));
        let needs_rerun = pass_out.contains("Rerun to get")
            || pass_out.contains("rerun LaTeX")
            || pass_out.contains("Rerun LaTeX")
            || missing_listing;
        if i + 1 >= passes && !needs_rerun {
            break;
        }
    }

    // Fresh = created now, or overwritten (mtime advanced) by this run.
    let pdf_fresh = match (pdf_mtime_before, mtime_of(&pdf)) {
        (None, Some(_)) => true,
        (Some(before), Some(after)) => after > before,
        _ => false,
    };

    Ok(CompileResult {
        ok: clean && pdf_fresh,
        pdf_path: if pdf_fresh {
            Some(pdf.to_string_lossy().to_string())
        } else {
            None
        },
        log,
        engine: engine.to_string(),
    })
}
