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
    // macOS: GUI apps launched from Finder get a MINIMAL PATH that excludes
    // MacTeX and Homebrew — resolve them by their canonical locations.
    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/Library/TeX/texbin")); // MacTeX symlinks
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    // Linux: TeX Live from the distro or from tug.org's installer.
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        dirs.push(PathBuf::from("/usr/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        for year in ["2026", "2025", "2024", "2023"] {
            dirs.push(PathBuf::from(format!("/usr/local/texlive/{year}/bin/x86_64-linux")));
        }
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

#[derive(serde::Serialize)]
pub struct SyncTexLoc {
    pub page: u32,
    pub x: f64,
    pub y: f64,
}

/// Forward search (source line → PDF position) via `synctex view`.
/// Returns the first record: page + x/y in PDF points from the page's
/// top-left corner (the viewer scrolls there and flashes a marker).
pub fn synctex_view(tex: &str, line: u32, pdf: &str) -> Result<SyncTexLoc, String> {
    let cmd = resolve_engine("synctex")
        .ok_or("No se encontró «synctex» (instala MiKTeX o TeX Live).")?;
    let mut c = Command::new(&cmd);
    c.arg("view")
        .arg("-i")
        .arg(format!("{line}:1:{tex}"))
        .arg("-o")
        .arg(pdf);
    crate::quiet(&mut c);
    let out = c
        .output()
        .map_err(|e| format!("No se pudo ejecutar synctex: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);

    let mut page: Option<u32> = None;
    let mut x: Option<f64> = None;
    let mut y: Option<f64> = None;
    for l in text.lines() {
        if let Some(v) = l.strip_prefix("Page:") {
            if page.is_none() {
                page = v.trim().parse().ok();
            }
        } else if let Some(v) = l.strip_prefix("x:") {
            if x.is_none() {
                x = v.trim().parse().ok();
            }
        } else if let Some(v) = l.strip_prefix("y:") {
            if y.is_none() {
                y = v.trim().parse().ok();
            }
        }
        if page.is_some() && x.is_some() && y.is_some() {
            break;
        }
    }
    match page {
        Some(p) => Ok(SyncTexLoc { page: p, x: x.unwrap_or(0.0), y: y.unwrap_or(0.0) }),
        None => Err("SyncTeX no encontró esa línea (recompila el documento).".into()),
    }
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

/// The engine's `TEXINPUTS`, in precedence order:
///
///   1. `.` — the project folder the engine runs from. FIRST, so anything a
///      document already resolves (an image or `.sty` beside the main file)
///      keeps resolving to exactly that file.
///   2. the working directory, where the `.build.tex` copies live.
///   3. the folder of every file the document pulls in, so an image or package
///      sitting next to a chapter in a subfolder resolves too. Checked against
///      pdflatex and xelatex: with a chapter's folder AHEAD of `.`, an image in
///      that folder silently replaced a same-named one beside the main file.
///   4. the distribution's defaults. The separator is `;` on Windows and `:`
///      elsewhere, and the TRAILING one is what tells kpathsea "…and then the
///      usual places" — without it the engine stops finding LaTeX itself.
fn texinputs(out_dir: &Path, search_dirs: &[String]) -> String {
    let sep = if cfg!(windows) { ';' } else { ':' };
    let mut v = String::new();
    if let Ok(prev) = std::env::var("TEXINPUTS") {
        if !prev.is_empty() {
            v.push_str(&prev);
            if !prev.ends_with(sep) {
                v.push(sep);
            }
        }
    }
    v.push('.');
    v.push(sep);
    v.push_str(&out_dir.to_string_lossy());
    v.push(sep);
    for d in search_dirs.iter().filter(|d| !d.is_empty()) {
        v.push_str(d);
        v.push(sep);
    }
    v
}

/// Content fingerprint of the listings a pass reads at `\tableofcontents`,
/// `\listoffigures` and `\listoftables` and rewrites at `\end{document}`.
fn listings_stamp(out_dir: &Path, job: &str) -> Vec<Option<Vec<u8>>> {
    ["toc", "lof", "lot"]
        .iter()
        .map(|ext| std::fs::read(out_dir.join(format!("{job}.{ext}"))).ok())
        .collect()
}

/// Does the file end like a PDF does? A writer that dies mid-document leaves a
/// file with a FRESH mtime and no trailer: with xelatex that happens every time
/// an `\includegraphics` target is missing — TeX recovers from the error, but
/// xdvipdfmx, which receives the pages through a pipe, stops with "Image
/// inclusion failed" and xelatex then fails writing to the dead pipe. Treating
/// that file as the result made the viewer fail with "Invalid PDF structure",
/// which is all the user ever got to see.
fn pdf_complete(p: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(p) else { return false };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let tail = len.min(2048) as i64;
    if tail == 0 || f.seek(SeekFrom::End(-tail)).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).is_ok() && buf.windows(5).any(|w| w == b"%%EOF")
}

/// Images the engine reported as missing (`File `x.png' not found`), in order,
/// without repeats.
fn missing_images(log: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for l in log.lines() {
        if let Some(rest) = l.strip_prefix("LaTeX Warning: File `") {
            if let Some(end) = rest.find("' not found") {
                let name = rest[..end].to_string();
                if !out.contains(&name) {
                    out.push(name);
                }
            }
        }
    }
    out
}

/// Recreate the document's subdirectory layout inside the build folder.
///
/// `\include{cap/uno}` makes TeX write `cap/uno.aux` *relative to the output
/// directory*. MiKTeX creates the missing folder; TeX Live does not — it stops
/// with "I can't write on file `cap/uno.aux'", which would make every
/// chaptered document fail to build on Linux and macOS while working fine on
/// the Windows machine it was written on. Creating the folders up front costs
/// nothing and removes the difference.
fn mirror_subdirs(src: &Path, dst: &Path, depth: u32) {
    if depth == 0 {
        return;
    }
    let rd = match std::fs::read_dir(src) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name();
        // Skip dot-folders (including the build folder itself) and the places
        // where generated images and dependencies live.
        let n = name.to_string_lossy();
        if n.starts_with('.') || n == "node_modules" || n == "xref" {
            continue;
        }
        let target = dst.join(&name);
        if std::fs::create_dir_all(&target).is_ok() {
            mirror_subdirs(&entry.path(), &target, depth - 1);
        }
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
    project_dir: &str,
    engine: &str,
    passes: u32,
    jobname: Option<String>,
    search_dirs: &[String],
) -> Result<CompileResult, String> {
    let src = Path::new(path);
    if !src.exists() {
        return Err(format!("No existe el archivo: {path}"));
    }
    // The engine RUNS from the project folder — that is what makes relative
    // paths in the source (\includegraphics{xref/…}, a .sty next to the
    // document) resolve exactly as the author wrote them — but it WRITES to the
    // working directory, which lives outside the project entirely. See
    // workspace.rs for why.
    let dir = Path::new(project_dir);
    let out_dir = src
        .parent()
        .ok_or("El documento no tiene carpeta contenedora")?
        .to_path_buf();
    let file = src.to_string_lossy().to_string();

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

    // ---- one folder for every scratch file the engine produces ----
    //
    // A LaTeX run litters the document's folder with .aux, .log, .fls, .toc,
    // .out, .lof, .lot, .maf, .mtc*, .nav, .snm … On a document with chapters
    // that is dozens of files the author never asked for and cannot tell apart
    // from their own. `-output-directory` sends all of it into ONE place.
    //
    // The PDF and the SyncTeX index are then moved back next to the document,
    // because those two are not scratch: the viewer opens the PDF from there,
    // and `synctex` resolves its index relative to the PDF it is given.
    //
    // The engine still RUNS from the document's folder, so relative paths in
    // the source (\includegraphics{xref/…}, \input{cap/…}) resolve exactly as
    // they did before. And keeping the .aux files between runs is what lets
    // cross-references settle in two passes instead of three.
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("No se pudo crear la carpeta de compilación: {e}"))?;
    // Until this returns, a save must not pack this directory (workspace.rs).
    let _busy = crate::workspace::mark_busy(&out_dir);
    mirror_subdirs(dir, &out_dir, 3);

    // Snapshot the PDF's mtime BEFORE compiling: success is "this run wrote a
    // PDF", never "a PDF from some earlier compile is still lying around".
    let pdf = out_dir.join(format!("{out_name}.pdf"));
    // (modified, length): a PDF counts as written by this run if EITHER moved.
    // The mtime alone missed rewrites on filesystems with coarse timestamps
    // (FAT, some network shares), where a fast recompile can land in the same
    // tick — and then the viewer was never told there was a new PDF.
    let stamp_of = |p: &Path| p.metadata().ok().map(|m| (m.modified().ok(), m.len()));
    let pdf_before = stamp_of(&pdf);

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
            .arg("-synctex=1")
            .arg(format!("-output-directory={}", out_dir.display()))
            // The generated `.build.tex` copies live in the working directory,
            // so the engine has to look there for the children a parent pulls
            // in. The trailing separator keeps the default search paths.
            .env("TEXINPUTS", texinputs(&out_dir, search_dirs));
        // A pass we ALREADY know is not the last one exists only to settle
        // references and the table of contents — its PDF is thrown away. In
        // draft mode the engine skips font loading, image processing and the
        // whole shipout, which is where most of the time in a figure-heavy
        // engineering report goes, and still writes the .aux/.toc the next pass
        // reads. xelatex has no -draftmode (it shells out to xdvipdfmx), so it
        // keeps running normally.
        let final_pass = i + 1 >= passes;
        if !final_pass && matches!(engine, "pdflatex" | "lualatex") {
            cmd.arg("-draftmode");
        }
        if let Some(j) = jobname.as_ref().filter(|s| !s.trim().is_empty()) {
            cmd.arg(format!("-jobname={j}"));
        }
        crate::quiet(&mut cmd);
        let listings_before = listings_stamp(&out_dir, &out_name);
        let output = cmd
            .arg(&file)
            .output()
            .map_err(|e| crate::spawn_error(engine, Some(dir), &e))?;

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
        // …or a listing whose CONTENT this pass changed. LaTeX warns when labels
        // move but says nothing when the table of contents does: a new section
        // title is written to the .toc at \end{document}, after the stale one
        // was already typeset. Comparing the files is what lets the compiler
        // ask for ONE pass and still never show an out-of-date index.
        let needs_rerun = pass_out.contains("Rerun to get")
            || pass_out.contains("rerun LaTeX")
            || pass_out.contains("Rerun LaTeX")
            || missing_listing
            || listings_stamp(&out_dir, &out_name) != listings_before;
        if i + 1 >= passes && !needs_rerun {
            break;
        }
    }

    // Nothing is moved back: the PDF and its SyncTeX index stay in the working
    // directory, side by side, which is exactly where the `synctex` CLI expects
    // to find the index for a given PDF. The viewer opens it from there, and
    // the user's folder keeps only what the user put in it.

    // Fresh = created now, or overwritten (mtime advanced) by this run.
    let written = match (pdf_before, stamp_of(&pdf)) {
        (None, Some(_)) => true,
        (Some(before), Some(after)) => after != before,
        _ => false,
    };
    // …and COMPLETE. A truncated file is not this run's PDF: it is removed, so
    // it can neither be shown nor packed into the .pltx on the next save, and
    // the viewer keeps the last good one. The log says why, in words.
    let pdf_fresh = written && pdf_complete(&pdf);
    if written && !pdf_fresh {
        let _ = std::fs::remove_file(&pdf);
        log.push_str("===== Pyx: el PDF no se completó =====\n");
        log.push_str(&format!(
            "El motor ({engine}) se detuvo mientras escribía el PDF; se mantiene el anterior.\n"
        ));
        let missing = missing_images(&log);
        if !missing.is_empty() {
            log.push_str(&format!(
                "Imágenes que no se encuentran: {}.\n\
                 Con xelatex una imagen que falta impide generar el PDF: \
                 comprueba la ruta y la carpeta de \\graphicspath.\n",
                missing.join(", ")
            ));
        }
    }

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const MAIN: &str = r"\documentclass{book}
\begin{document}
\tableofcontents
\chapter{Uno}\label{c:1}
Ver \ref{c:1}.
\include{cap/dos.build}
\end{document}
";
    const CHILD: &str = r"\chapter{Dos}
Texto del capitulo dos.
";

    /// Compile a small multi-file project and check the CONTRACT the whole
    /// working-directory design exists for: the user's folder keeps only the
    /// user's own files, and everything the engine produces lands elsewhere.
    ///
    /// Skipped when no TeX engine is installed, so the suite still runs on a
    /// machine (or a CI runner) without a LaTeX distribution.
    #[test]
    fn build_leaves_the_project_folder_untouched() {
        let engine = match ["pdflatex", "xelatex"].iter().find(|e| engine_works(e)) {
            Some(e) => *e,
            None => return, // no LaTeX here; nothing to assert
        };

        let base = std::env::temp_dir().join(format!("pyx-latex-test-{}", std::process::id()));
        let proj = base.join("proj");
        let work = base.join("work");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(proj.join("cap")).unwrap();
        fs::create_dir_all(work.join("cap")).unwrap();

        fs::write(work.join("main.build.tex"), MAIN).unwrap();
        fs::write(work.join("cap/dos.build.tex"), CHILD).unwrap();
        // A source file the author owns: it must still be there afterwards.
        fs::write(proj.join("notas.sty"), "% paquete del usuario\n").unwrap();

        let res = compile(
            work.join("main.build.tex").to_str().unwrap(),
            proj.to_str().unwrap(),
            engine,
            2,
            Some("main".to_string()),
            &[],
        )
        .expect("la compilacion deberia ejecutarse");

        // The PDF exists and lives in the working directory, not the project.
        let pdf = res.pdf_path.expect("deberia haberse escrito un PDF");
        assert!(
            pdf.starts_with(work.to_str().unwrap()),
            "el PDF salio del area de trabajo: {pdf}"
        );
        assert!(work.join("main.aux").exists(), "el .aux deberia estar en el area de trabajo");
        assert!(work.join("main.toc").exists(), "el .toc deberia estar en el area de trabajo");
        // The child chapter's own .aux goes to the mirrored subfolder, which is
        // what TeX Live needs to exist up front.
        assert!(work.join("cap/dos.build.aux").exists());

        // THE POINT: the project folder still holds exactly what we put in it.
        let mut left: Vec<String> = fs::read_dir(&proj)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        left.sort();
        assert_eq!(
            left,
            vec!["cap".to_string(), "notas.sty".to_string()],
            "quedaron archivos sueltos en el proyecto: {left:?}"
        );
        assert_eq!(fs::read_dir(proj.join("cap")).unwrap().flatten().count(), 0);

        let _ = fs::remove_dir_all(&base);
    }

    /// A PDF cut off mid-write (xdvipdfmx died on a missing image) is not a
    /// result; a complete one is, trailing newline or not.
    #[test]
    fn a_truncated_pdf_is_not_a_result() {
        let dir = std::env::temp_dir().join(format!("pyx-pdfcut-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let (ok, cut, empty) = (dir.join("ok.pdf"), dir.join("cut.pdf"), dir.join("empty.pdf"));
        fs::write(&ok, b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n").unwrap();
        fs::write(&cut, b"%PDF-1.7\n1 0 obj\n<< /Length 900 >>\nstream\nG\xbf\xe6}").unwrap();
        fs::write(&empty, b"").unwrap();
        assert!(pdf_complete(&ok));
        assert!(!pdf_complete(&cut));
        assert!(!pdf_complete(&empty));
        assert!(!pdf_complete(&dir.join("missing.pdf")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_images_are_named_once_in_order() {
        let log = "LaTeX Warning: File `alt1.png' not found on input line 75.\n\
                   ! Unable to load picture or PDF file 'alt1.png'.\n\
                   LaTeX Warning: File `sub dir/alt2.png' not found on input line 85.\n\
                   LaTeX Warning: File `alt1.png' not found on input line 90.\n";
        assert_eq!(missing_images(log), vec!["alt1.png", "sub dir/alt2.png"]);
        assert!(missing_images("nada que ver\n").is_empty());
    }

    fn scratch(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("pyx-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let (proj, work) = (base.join("proj"), base.join("work"));
        fs::create_dir_all(&proj).unwrap();
        fs::create_dir_all(&work).unwrap();
        (base, proj, work)
    }

    fn some_engine() -> Option<&'static str> {
        ["pdflatex", "xelatex"].into_iter().find(|e| engine_works(e))
    }

    fn passes_run(log: &str) -> usize {
        log.matches("===== Pasada ").count()
    }

    /// The compiler asks for ONE pass. That must never leave a stale table of
    /// contents — LaTeX prints no warning when the .toc changes — and it must
    /// stay ONE pass when nothing moved, which is the entire point.
    #[test]
    fn one_pass_still_settles_a_changed_table_of_contents() {
        let Some(engine) = some_engine() else { return };
        let (base, proj, work) = scratch("toc");
        let main = work.join("main.build.tex");
        let doc = |sections: &str| {
            format!("\\documentclass{{article}}\n\\begin{{document}}\n\\tableofcontents\n{sections}\n\\end{{document}}\n")
        };
        let run = || {
            compile(main.to_str().unwrap(), proj.to_str().unwrap(), engine, 1, Some("main".into()), &[])
                .expect("la compilacion deberia ejecutarse")
        };

        fs::write(&main, doc(r"\section{Alfa}")).unwrap();
        run();
        let steady = run();
        assert_eq!(passes_run(&steady.log), 1, "sin cambios tiene que bastar una pasada");
        assert!(steady.pdf_path.is_some(), "una recompilacion identica tambien es un PDF nuevo");

        fs::write(&main, doc("\\section{Alfa}\n\\section{Beta}")).unwrap();
        let changed = run();
        assert!(passes_run(&changed.log) >= 2, "un indice que cambia exige otra pasada");
        let toc = fs::read_to_string(work.join("main.toc")).unwrap();
        assert!(toc.contains("Beta"), "el indice tiene que recoger la seccion nueva");

        let _ = fs::remove_dir_all(&base);
    }

    /// A file beside a chapter in a subfolder resolves, and a same-named file
    /// beside the main document still wins. Images go through the same lookup
    /// (verified with real PNGs under pdflatex and xelatex); `\input` pins the
    /// ORDER without binary fixtures.
    #[test]
    fn chapter_folders_resolve_without_shadowing_the_project() {
        let Some(engine) = some_engine() else { return };
        let (base, proj, work) = scratch("inputs");
        let cap = proj.join("cap");
        fs::create_dir_all(&cap).unwrap();
        fs::write(proj.join("datos.tex"), r"\def\origen{RAIZ}").unwrap();
        fs::write(cap.join("datos.tex"), r"\def\origen{CAPITULO}").unwrap();
        fs::write(cap.join("solo.tex"), r"\def\solo{SOLOCAPITULO}").unwrap();
        let main = work.join("main.build.tex");
        fs::write(
            &main,
            "\\documentclass{article}\n\\begin{document}\n\\input{datos}\\input{solo}\n\\typeout{ORIGEN=\\origen}\\typeout{SOLO=\\solo}\nx\n\\end{document}\n",
        )
        .unwrap();

        let res = compile(
            main.to_str().unwrap(),
            proj.to_str().unwrap(),
            engine,
            1,
            Some("main".into()),
            &[cap.to_string_lossy().to_string()],
        )
        .expect("la compilacion deberia ejecutarse");
        assert!(res.log.contains("ORIGEN=RAIZ"), "un archivo del capitulo tapo al del proyecto");
        assert!(res.log.contains("SOLO=SOLOCAPITULO"), "no se encontro el archivo junto al capitulo");

        let _ = fs::remove_dir_all(&base);
    }
}
