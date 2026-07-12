//! `.pltx` container format — a ZIP, Word-style.
//!
//! A `.pltx` bundles the document source plus the build artifacts (the LaTeX
//! log, .aux, .synctex.gz and the generated .build.tex) so the working folder
//! stays clean: just `doc.pltx` and its `doc.pdf`. The PDF is deliberately
//! LEFT OUT (it lives next to the container).
//!
//! Layout inside the zip:
//!   manifest.json          {"format":"pyx-pltx","version":1}
//!   source.tex             the editable LaTeX + %#python cells (UTF-8)
//!   build.tex              (optional) last generated <stem>.build.tex
//!   build.log              (optional) last engine log
//!   build.aux              (optional) last .aux
//!   build.synctex.gz       (optional) last SyncTeX data
//!
//! Backward compatible: a legacy plain-text `.pltx` (not a zip) still opens —
//! `read` reports `is_zip=false` and the JS side decodes it as text.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const SOURCE_ENTRY: &str = "source.tex";
const MANIFEST_ENTRY: &str = "manifest.json";
const MANIFEST_BODY: &str = "{\"format\":\"pyx-pltx\",\"version\":1}";

/// (zip entry name, on-disk suffix appended to the document stem)
const ARTIFACTS: &[(&str, &str)] = &[
    ("build.tex", ".build.tex"),
    ("build.log", ".log"),
    ("build.aux", ".aux"),
    ("build.synctex.gz", ".synctex.gz"),
];

#[derive(serde::Serialize)]
pub struct PltxRead {
    pub is_zip: bool,
    pub source: Option<String>,
}

fn is_zip(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && &bytes[0..2] == b"PK" && (bytes[2] == 3 || bytes[2] == 5 || bytes[2] == 7)
}

fn stem_of(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn artifact_path(dir: &Path, stem: &str, suffix: &str) -> PathBuf {
    dir.join(format!("{stem}{suffix}"))
}

/// Open a `.pltx`. If it is a zip, return the source and EXTRACT the bundled
/// artifacts as loose files next to it (so SyncTeX / a first compile work
/// before any recompile). If it is legacy plain text, report `is_zip=false`.
pub fn read(path: &str) -> Result<PltxRead, String> {
    let p = Path::new(path);
    let bytes = fs::read(p).map_err(|e| format!("No se pudo leer {path}: {e}"))?;
    if !is_zip(&bytes) {
        return Ok(PltxRead { is_zip: false, source: None });
    }
    let dir = p.parent().unwrap_or_else(|| Path::new("."));
    let stem = stem_of(p);

    let reader = std::io::Cursor::new(&bytes);
    let mut zip = zip::ZipArchive::new(reader)
        .map_err(|e| format!("El .pltx está dañado: {e}"))?;

    let mut source = String::new();
    // Read the source first.
    if let Ok(mut f) = zip.by_name(SOURCE_ENTRY) {
        f.read_to_string(&mut source)
            .map_err(|e| format!("No se pudo leer la fuente del .pltx: {e}"))?;
    } else {
        return Err("El .pltx no contiene source.tex".into());
    }
    // Extract artifacts (best-effort; a missing/failed one is not fatal).
    for (entry, suffix) in ARTIFACTS {
        if let Ok(mut f) = zip.by_name(entry) {
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).is_ok() {
                let _ = fs::write(artifact_path(dir, &stem, suffix), &buf);
            }
        }
    }
    Ok(PltxRead { is_zip: true, source: Some(source) })
}

/// Save a `.pltx`: pack `source` + manifest + whatever loose artifacts exist
/// next to it, then remove those loose artifacts (the PDF is kept). Written to
/// a temp file and renamed, so a crash mid-write can never corrupt the doc.
pub fn write(path: &str, source: &str) -> Result<(), String> {
    let p = Path::new(path);
    let dir = p.parent().unwrap_or_else(|| Path::new("."));
    let stem = stem_of(p);

    let tmp = p.with_extension("pltx.tmp");
    {
        let file = fs::File::create(&tmp)
            .map_err(|e| format!("No se pudo escribir el .pltx: {e}"))?;
        let mut zip = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        let mut put = |name: &str, data: &[u8]| -> Result<(), String> {
            zip.start_file(name, opts)
                .map_err(|e| format!("zip: {e}"))?;
            zip.write_all(data).map_err(|e| format!("zip: {e}"))?;
            Ok(())
        };
        put(MANIFEST_ENTRY, MANIFEST_BODY.as_bytes())?;
        put(SOURCE_ENTRY, source.as_bytes())?;
        for (entry, suffix) in ARTIFACTS {
            let ap = artifact_path(dir, &stem, suffix);
            if let Ok(data) = fs::read(&ap) {
                put(entry, &data)?;
            }
        }
        zip.finish().map_err(|e| format!("zip: {e}"))?;
    }
    fs::rename(&tmp, p).map_err(|e| format!("No se pudo guardar el .pltx: {e}"))?;

    // Clean the folder (Word-style): drop the loose artifacts we just bundled.
    // The PDF is intentionally kept.
    for (_, suffix) in ARTIFACTS {
        let _ = fs::remove_file(artifact_path(dir, &stem, suffix));
    }
    Ok(())
}

/// Ensure `<stem>.synctex.gz` exists next to a PDF: if it was cleaned into the
/// sibling `<stem>.pltx`, extract just that entry back out. Lets SyncTeX work
/// on a freshly-saved (clean-folder) `.pltx` without a recompile.
pub fn ensure_synctex_for_pdf(pdf: &str) {
    let pdfp = Path::new(pdf);
    let dir = match pdfp.parent() { Some(d) => d, None => return };
    let stem = stem_of(pdfp);
    let sync = artifact_path(dir, &stem, ".synctex.gz");
    if sync.exists() {
        return;
    }
    let pltx = dir.join(format!("{stem}.pltx"));
    let bytes = match fs::read(&pltx) { Ok(b) => b, Err(_) => return };
    if !is_zip(&bytes) {
        return;
    }
    if let Ok(mut zip) = zip::ZipArchive::new(std::io::Cursor::new(&bytes)) {
        if let Ok(mut f) = zip.by_name("build.synctex.gz") {
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).is_ok() {
                let _ = fs::write(&sync, &buf);
            }
        }
    }
}
